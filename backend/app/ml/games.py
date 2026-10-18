"""Модель геймов (Р28, этап 7, волна 3): форы и тоталы по геймам из цепи очко → гейм →
тай-брейк → сет → матч.

Как считается:
1. **Темп матча** — средняя вероятность выиграть очко на своей подаче m = (pA + pB)/2 по
   Барнетту–Кларку: pA = f_t + (f_A − f̄) − (g_B − ḡ), где f — доля очков, выигранных на
   подаче, g — на приеме, за 52 недели (суммы dossier.serve_sums), со сжатием к среднему
   тура (SHRINK_POINTS очков), f_t — среднее тура на покрытии. Без статистики — среднее
   тура.
2. **Привязка к Эло:** разница Δ = pA − pB подбирается бисекцией так, чтобы цепь давала ту же
   вероятность выиграть сет, что и модель сетов при итоговой p1_win (после поправки Claude).
   Победителя Эло предсказывает лучше статистики подачи, статистика дает только темп.
3. **Цепь:** гейм — формула удержания подачи, тай-брейк — по очкам с переходом подачи, сет —
   по геймам с чередованием подачи (первым подает каждый с вероятностью 1/2), решающий сет —
   по правилу турнира и года (decider_rule).
4. **Счет по сетам — из модели сетов** (app/ml/sets.py: set_score_probs по трем итоговым
   числам матча, с SETS_PLATT и SET30_PLATT). Наивная цепь завышает решающий сет на 10 п.п.,
   отсюда около 60% лишних геймов тотала (исследование рынков, 17.10.2026). Поэтому цепь
   дает только геймы внутри сета при известном победителе сета, а вероятности счета по сетам
   берутся из уже проверенной модели сетов: решающий сет согласован с SETS_PLATT, поправка
   Claude к p1_win и cover переносится на геймы кодом, P(победа) совпадает с p1_win точно.
5. **Калибровочный слой** (GamesCalibration): сдвиг темпа m по формату — цепь с независимыми
   очками дает больше геймов в сете, чем в жизни. Подбор — на 2016–2022, проверка — на
   2023–2025 (PLAN.md, Р28); параметры хранит версия базовой модели (params.games_cal), без
   них — GAMES_CAL.

На выходе — распределение (геймы игрока 1, геймы игрока 2) матча; из него — исходы фор и
тоталов по геймам, у целой линии отдельно вероятность «ровно» (возврат). Тай-брейк и
супер-тай-брейк — один гейм, как в расчете ставки (app/ml/markets.py).

Расчет одного матча — единицы миллисекунд: распределения сетов кэшируются по округленным
вероятностям очка.
"""

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from functools import lru_cache
from types import MappingProxyType
from typing import Any

from app.core.i18n import t
from app.ml.markets import FAMILY_GHCP, FAMILY_GTOT, GAME_FAMILIES, market_spec
from app.ml.sets import (
    MARKETS,
    Probs3,
    market_prob,
    set_prob_from_match,
    set_score_probs,
    wins_needed,
)

# Правила сета: тай-брейк до 7 при 6:6 (обычный сет); до 10 при 6:6 (решающий сет Шлемов
# с 2022 года, Australian Open 2019–2021); до 7 при 12:12 (Уимблдон 2019–2021); без
# тай-брейка, до разницы в 2 гейма (Ролан Гаррос до 2022, Уимблдон и Australian Open до 2019)
RULE_TB7 = "tb7"
RULE_TB10 = "tb10"
RULE_TB12 = "tb12"
RULE_ADV = "adv"
RULES: tuple[str, ...] = (RULE_TB7, RULE_TB10, RULE_TB12, RULE_ADV)

# Среднее тура: доля очков, выигранных на подаче (основной тур ATP 2016–2022, матчи со
# статистикой у обоих игроков). Покрытие неизвестно — общее среднее
TOUR_SERVE: Mapping[str, float] = MappingProxyType(
    {"hard": 0.6398, "clay": 0.6181, "grass": 0.6586, "carpet": 0.6357}
)
TOUR_SERVE_ALL = 0.6357
# Сжатие доли игрока к среднему тура: столько «средних» очков добавляется к его очкам
SHRINK_POINTS = 400
# Границы темпа и вероятности очка: за ними цепь теряет смысл (и бисекция — точность)
SERVE_MIN, SERVE_MAX = 0.45, 0.85
POINT_MIN, POINT_MAX = 0.02, 0.98
# Округление вероятностей очка для кэша распределений сета
_ROUND = 4
# Длинный сет без тай-брейка: после стольких геймов остаток вероятности отбрасывается, а
# распределение сета нормируется. Отброшено при одинаковом удержании подачи у обоих:
# 0.83 (очко на подаче 0.65) — 0.002%, 0.90 (0.70) — 0.13%, 0.95 (0.75) — 3%. Касается
# только решающего сета без тай-брейка (история Шлемов) при крайнем темпе
_LONG_SET_GAMES = 70
_BISECT_STEPS = 30

GameCell = tuple[int, int]
# Ключ вероятностей возврата (целая линия) в predictions.features: {"base", "claude", "final"}
PUSH_KEY = "p_push"
PUSH_NAMES: tuple[str, ...] = ("base", "claude", "final")


def push_values(raw: Any) -> dict[str, float]:
    """Вероятности возврата прогноза из features.p_push: имя → значение (нет — 0)."""
    found: dict[str, float] = dict.fromkeys(PUSH_NAMES, 0.0)
    if not isinstance(raw, Mapping):
        return found
    for name in PUSH_NAMES:
        try:
            value = float(raw.get(name) or 0.0)
        except (TypeError, ValueError):
            continue
        found[name] = value if 0.0 <= value < 1.0 else 0.0
    return found


def decided_prob(p: float, push: float) -> float:
    """Вероятность выигрыша при условии, что ставка решена (не возврат): p / (1 − push).
    С ней сравнивается исход целой линии там, где возвраты выброшены (калибровка, Brier,
    остаток урока): иначе p без условия занижена на долю возвратов."""
    if push <= 0.0 or push >= 1.0:
        return p
    return min(1.0, p / (1.0 - push))


def decider_rule(level: str | None, tour: str | None, year: int, best_of: int) -> str:
    """Правило решающего сета по турниру и году. Матчи до 2 побед и турниры вне Большого
    шлема — тай-брейк до 7 при 6:6."""
    if best_of != 5 or level != "grand_slam":
        return RULE_TB7
    name = (tour or "").lower()
    if year >= 2022:
        return RULE_TB10
    if "wimbledon" in name:
        return RULE_TB12 if year >= 2019 else RULE_ADV
    if "roland" in name or "french" in name:
        return RULE_ADV
    if "australian" in name:
        return RULE_TB10 if year >= 2019 else RULE_ADV
    return RULE_TB7


# --- темп: вероятность очка на подаче по статистике ---


@dataclass(frozen=True)
class ServeRecord:
    """Подача и прием игрока за окно: очки на своей подаче и выигранные, очки на подаче
    соперников и выигранные игроком на приеме."""

    serve_points: int
    serve_won: int
    return_points: int
    return_won: int


def tour_serve(surface: str | None) -> float:
    return TOUR_SERVE.get((surface or "").strip().lower(), TOUR_SERVE_ALL)


def _shrunk(won: int, points: int, mean: float) -> float:
    return (won + SHRINK_POINTS * mean) / (points + SHRINK_POINTS)


def serve_mean(first: ServeRecord | None, second: ServeRecord | None, surface: str | None) -> float:
    """Темп матча m = (pA + pB)/2 по Барнетту–Кларку: отклонения игроков от среднего тура
    (подача и прием за окно, со сжатием) поверх среднего тура на покрытии."""
    base = tour_serve(surface)
    serve_avg, return_avg = TOUR_SERVE_ALL, 1.0 - TOUR_SERVE_ALL
    shift = 0.0
    for record in (first, second):
        if record is None:
            continue
        shift += _shrunk(record.serve_won, record.serve_points, serve_avg) - serve_avg
        shift -= _shrunk(record.return_won, record.return_points, return_avg) - return_avg
    return min(SERVE_MAX, max(SERVE_MIN, base + shift / 2.0))


# --- калибровочный слой ---


@dataclass(frozen=True)
class GamesCalibration:
    """Сдвиг темпа m по формату (best_of → добавка к m): цепь с независимыми очками
    удерживает подачу чаще, чем в жизни, и дает лишние геймы в сете. Пусто — без поправки."""

    shift: Mapping[int, float]

    def input_for(self, tempo: float, decider: str, best_of: int) -> "GamesInput":
        """Вход цепи матча с поправкой его формата."""
        return GamesInput(tempo, decider, self.shift.get(best_of, 0.0))

    def to_json(self) -> dict[str, Any]:
        return {"shift": {str(key): value for key, value in sorted(self.shift.items())}}


# Поправка по умолчанию: подобрана на 2016–2022 (Эло проекта с Платтом бэктеста, SETS_PLATT,
# минимум суммы Brier тоталов и фор фаворита по стандартным линиям формата, сетка с шагом
# 0.002–0.006); проверка на 2023–2025 — PLAN.md, Р28. Действует, пока у версии базовой
# модели нет своих чисел (params.games_cal, подбор при перекалибровке)
GAMES_CAL = GamesCalibration(MappingProxyType({3: -0.033, 5: -0.06}))
# Предел поправки: сдвиг темпа больше 0.1 — уже не поправка, а другая модель
SHIFT_MAX = 0.1


def games_calibration_of(raw: Any) -> GamesCalibration:
    """Поправка из params.games_cal версии модели: {"shift": {"3": x, "5": y}}. Формата нет
    или запись неверна — его число из GAMES_CAL."""
    found = dict(GAMES_CAL.shift)
    shift = raw.get("shift") if isinstance(raw, Mapping) else None
    if isinstance(shift, Mapping):
        for best_of in (3, 5):
            value = shift.get(str(best_of))
            try:
                number = float(value) if value is not None else None
            except (TypeError, ValueError):
                number = None
            if number is not None and math.isfinite(number) and abs(number) <= SHIFT_MAX:
                found[best_of] = number
    return GamesCalibration(MappingProxyType(found))


# --- цепь: гейм, тай-брейк, сет ---


def hold(p: float) -> float:
    """Вероятность удержать подачу при вероятности p выиграть очко на своей подаче."""
    q = 1.0 - p
    deuce = p * p / (1.0 - 2.0 * p * q)
    return p**4 * (1.0 + 4.0 * q + 10.0 * q * q) + 20.0 * p**3 * q**3 * deuce


@lru_cache(maxsize=65536)
def tiebreak(pa: float, pb: float, target: int = 7) -> float:
    """Вероятность A выиграть тай-брейк до target (разница 2), если A подает первое очко:
    дальше подача переходит через очко парами. При равенстве после target − 1 очков у
    каждого — замкнутая формула (два очка подряд с разной подачей)."""
    edge = target - 1
    states: dict[tuple[int, int], float] = {(0, 0): 1.0}
    won = 0.0
    tied = 0.0
    for _ in range(2 * edge):
        nxt: dict[tuple[int, int], float] = {}
        for (a, b), prob in states.items():
            point = a + b
            serving_a = ((point + 1) // 2) % 2 == 0
            p = pa if serving_a else 1.0 - pb
            for key, share in (((a + 1, b), p), ((a, b + 1), 1.0 - p)):
                x, y = key
                if x == target and y < edge:
                    won += prob * share
                elif y == target and x < edge:
                    continue
                else:
                    nxt[key] = nxt.get(key, 0.0) + prob * share
        states = nxt
    tied = states.get((edge, edge), 0.0)
    both_a = pa * (1.0 - pb)
    both_b = (1.0 - pa) * pb
    from_tie = both_a / (both_a + both_b) if both_a + both_b > 0 else 0.5
    return won + tied * from_tie


def _set_finished(a: int, b: int, rule: str) -> bool:
    high, low = max(a, b), min(a, b)
    if rule in (RULE_TB7, RULE_TB10) and high == 7 and low == 6:
        return True
    if rule == RULE_TB12 and high == 13 and low == 12:
        return True
    return high >= 6 and high - low >= 2


@lru_cache(maxsize=65536)
def set_cells(pa: float, pb: float, rule: str, a_first: bool) -> tuple[tuple[GameCell, float], ...]:
    """Распределение счета сета (геймы A, геймы B), если первым подает A (a_first) или B."""
    ha, hb = hold(pa), hold(pb)
    tb_at = {RULE_TB7: 6, RULE_TB10: 6, RULE_TB12: 12}.get(rule)
    target = 10 if rule == RULE_TB10 else 7
    out: dict[GameCell, float] = {}
    states: dict[GameCell, float] = {(0, 0): 1.0}
    while states:
        nxt: dict[GameCell, float] = {}
        for (a, b), prob in states.items():
            if tb_at is not None and a == tb_at and b == tb_at:
                # Первое очко тай-брейка подает тот, чья очередь подавать гейм
                a_serves = ((a + b) % 2 == 0) == a_first
                win = tiebreak(pa, pb, target) if a_serves else 1.0 - tiebreak(pb, pa, target)
                out[(a + 1, b)] = out.get((a + 1, b), 0.0) + prob * win
                out[(a, b + 1)] = out.get((a, b + 1), 0.0) + prob * (1.0 - win)
                continue
            if a + b >= _LONG_SET_GAMES:
                continue
            a_serves = ((a + b) % 2 == 0) == a_first
            w = ha if a_serves else 1.0 - hb
            for key, share in (((a + 1, b), w), ((a, b + 1), 1.0 - w)):
                if _set_finished(*key, rule):
                    out[key] = out.get(key, 0.0) + prob * share
                else:
                    nxt[key] = nxt.get(key, 0.0) + prob * share
        states = nxt
    total = sum(out.values())
    return tuple((cell, prob / total) for cell, prob in sorted(out.items()))


@lru_cache(maxsize=65536)
def set_split(pa: float, pb: float, rule: str) -> tuple[float, tuple[tuple[GameCell, float], ...]]:
    """P(A выигрывает сет) и счет сета (первым подает каждый с вероятностью 1/2)."""
    mixed: dict[GameCell, float] = {}
    for a_first in (True, False):
        for cell, prob in set_cells(pa, pb, rule, a_first):
            mixed[cell] = mixed.get(cell, 0.0) + prob / 2.0
    win = sum(prob for (a, b), prob in mixed.items() if a > b)
    return win, tuple(sorted(mixed.items()))


def _point_pair(m: float, delta: float) -> tuple[float, float]:
    pa = min(POINT_MAX, max(POINT_MIN, m + delta / 2.0))
    pb = min(POINT_MAX, max(POINT_MIN, m - delta / 2.0))
    return round(pa, _ROUND), round(pb, _ROUND)


@lru_cache(maxsize=65536)
def _delta_for(m: float, s: float) -> float:
    """Разница вероятностей очка Δ, при которой A выигрывает обычный сет с вероятностью s."""
    low, high = -2.0 * (1.0 - POINT_MIN), 2.0 * (1.0 - POINT_MIN)
    for _ in range(_BISECT_STEPS):
        middle = (low + high) / 2.0
        if set_split(*_point_pair(m, middle), RULE_TB7)[0] < s:
            low = middle
        else:
            high = middle
    return (low + high) / 2.0


Cells = dict[GameCell, float]


def _given_winner(cells: Iterable[tuple[GameCell, float]], a_wins: bool) -> Cells:
    found = {cell: prob for cell, prob in cells if (cell[0] > cell[1]) == a_wins}
    total = sum(found.values())
    if total <= 0:
        # Сет такой стороной недостижим (край вероятностей): самый короткий счет
        return {(6, 0) if a_wins else (0, 6): 1.0}
    return {cell: prob / total for cell, prob in found.items()}


def _convolve(left: Cells, right: Cells) -> Cells:
    out: Cells = {}
    for (a1, b1), p1 in left.items():
        for (a2, b2), p2 in right.items():
            key = (a1 + a2, b1 + b2)
            out[key] = out.get(key, 0.0) + p1 * p2
    return out


@dataclass(frozen=True)
class GamesDist:
    """Распределение геймов матча: (геймы игрока 1, геймы игрока 2) → вероятность."""

    cells: Mapping[GameCell, float]

    def mean_total(self) -> float:
        return sum((a + b) * p for (a, b), p in self.cells.items())

    def total_probs(self) -> dict[int, float]:
        found: dict[int, float] = {}
        for (a, b), p in self.cells.items():
            found[a + b] = found.get(a + b, 0.0) + p
        return found

    def diff_probs(self) -> dict[int, float]:
        """Разница геймов игрока 1 и игрока 2 → вероятность."""
        found: dict[int, float] = {}
        for (a, b), p in self.cells.items():
            found[a - b] = found.get(a - b, 0.0) + p
        return found

    def outcome(self, market: str, selection: int) -> tuple[float, float]:
        """(P(выигрыш), P(возврат)) исхода форы или тотала по геймам: фора — разница геймов
        стороны плюс линия, тотал — сумма геймов против линии (1 — больше, 2 — меньше)."""
        spec = market_spec(market)
        if spec.family not in (FAMILY_GHCP, FAMILY_GTOT) or spec.line is None:
            raise ValueError(market)
        line = spec.line
        win = push = 0.0
        if spec.family == FAMILY_GTOT:
            for total, p in self.total_probs().items():
                margin = Decimal(total) - line
                if selection == 2:
                    margin = -margin
                if margin > 0:
                    win += p
                elif margin == 0:
                    push += p
        else:
            for diff, p in self.diff_probs().items():
                own = diff if selection == 1 else -diff
                margin = Decimal(own) + line
                if margin > 0:
                    win += p
                elif margin == 0:
                    push += p
        return min(1.0, max(0.0, win)), min(1.0, max(0.0, push))


@dataclass(frozen=True)
class GamesInput:
    """Что нужно цепи кроме трех чисел матча: темп m (serve_mean, без поправки), правило
    решающего сета и сдвиг темпа калибровочного слоя для формата матча (GamesCalibration).
    Пишется в predictions.features.games: прогноз можно пересчитать теми же числами."""

    tempo: float
    decider: str = RULE_TB7
    shift: float = 0.0

    @property
    def calibrated_tempo(self) -> float:
        return min(SERVE_MAX, max(SERVE_MIN, self.tempo + self.shift))

    def to_json(self) -> dict[str, Any]:
        return {"m": round(self.tempo, 5), "decider": self.decider, "shift": self.shift}

    @classmethod
    def from_json(cls, raw: Any, *, surface: str | None, best_of: int) -> "GamesInput":
        """Из features.games; нет записи или она неверна — среднее тура на покрытии, правило
        тай-брейка до 7 и поправка GAMES_CAL."""
        default = GAMES_CAL.input_for(tour_serve(surface), RULE_TB7, best_of)
        if not isinstance(raw, Mapping):
            return default
        try:
            tempo = float(raw["m"])
            shift = float(raw.get("shift", default.shift))
        except (KeyError, TypeError, ValueError):
            return default
        if not (math.isfinite(tempo) and math.isfinite(shift)) or abs(shift) > SHIFT_MAX:
            return default
        decider = raw.get("decider")
        return cls(
            min(SERVE_MAX, max(SERVE_MIN, tempo)),
            decider if isinstance(decider, str) and decider in RULES else RULE_TB7,
            shift,
        )


@lru_cache(maxsize=4096)
def _conditional(
    m: float, s: float, decider: str
) -> tuple[tuple[tuple[GameCell, float], ...], ...]:
    """Геймы сета при известном победителе: (A взял обычный сет, B взял обычный сет, A взял
    решающий, B взял решающий)."""
    pa, pb = _point_pair(m, _delta_for(m, s))
    _, normal = set_split(pa, pb, RULE_TB7)
    _, last = set_split(pa, pb, decider)
    return tuple(
        tuple(sorted(item.items()))
        for item in (
            _given_winner(normal, True),
            _given_winner(normal, False),
            _given_winner(last, True),
            _given_winner(last, False),
        )
    )


def games_dist(probs: Probs3, best_of: int, games: GamesInput) -> GamesDist:
    """Распределение геймов матча по трем числам матча (после поправки Claude), темпу и
    правилу решающего сета (см. docstring модуля)."""
    p1 = min(1.0, max(0.0, probs.p1_win))
    s = set_prob_from_match(p1, best_of)
    tempo = round(games.calibrated_tempo, _ROUND)
    a_set, b_set, a_last, b_last = (
        dict(item) for item in _conditional(tempo, round(s, _ROUND), games.decider)
    )
    need = wins_needed(best_of)
    out: Cells = {}
    for (first, second), q in set_score_probs(probs, best_of).items():
        if q <= 0:
            continue
        a_wins = first > second
        decisive = first + second == best_of
        last = (a_last if decisive else a_set) if a_wins else (b_last if decisive else b_set)
        cells: Cells = dict(last)
        for _ in range(first - (1 if a_wins else 0)):
            cells = _convolve(cells, a_set)
        for _ in range(second - (0 if a_wins else 1)):
            cells = _convolve(cells, b_set)
        for cell, p in cells.items():
            out[cell] = out.get(cell, 0.0) + q * p
        assert max(first, second) == need
    total = sum(out.values())
    if total > 0:
        out = {cell: p / total for cell, p in out.items()}
    return GamesDist(MappingProxyType(out))


def games_outcome(
    probs: Probs3, best_of: int, games: GamesInput, market: str, selection: int
) -> tuple[float, float]:
    """(P(выигрыш), P(возврат)) исхода рынка по геймам."""
    return games_dist(probs, best_of, games).outcome(market, selection)


def market_outcome(
    probs: Probs3,
    best_of: int | None,
    market: str,
    selection: int,
    games: GamesInput | None = None,
) -> tuple[float, float] | None:
    """(P(выигрыш), P(возврат)) исхода любого рынка по трем числам матча: рынки по сетам —
    модель сетов (возврата нет, линии половинные), по геймам — цепь (нужен games). Нет
    вероятности (рынок по геймам без входа цепи, семейство без принятой модели, формат
    неизвестен или рынок невозможен в формате) — None."""
    if selection not in (1, 2):
        raise ValueError(t("ml.sets.bad_selection", selection=selection))
    spec = market_spec(market)
    if not spec.has_model:
        return None
    if market in MARKETS:
        return probs.markets()[(market, selection)], 0.0
    if best_of is None:
        return None
    if spec.family in GAME_FAMILIES:
        if games is None:
            return None
        return games_outcome(probs, best_of, games, market, selection)
    found = market_prob(probs, best_of, market, selection)
    return (found, 0.0) if found is not None else None


# --- подбор и проверка слоя на истории ---

# Стандартные линии: тотал «больше» и фора фаворита (по p1_win) по формату. На них слой
# подбирается (перекалибровка) и проверяется против константы (PLAN.md, Р28)
TOTAL_LINES: Mapping[int, tuple[float, ...]] = MappingProxyType(
    {3: (20.5, 21.5, 22.5, 23.5), 5: (36.5, 38.5, 40.5)}
)
HCP_LINES: Mapping[int, tuple[float, ...]] = MappingProxyType(
    {3: (2.5, 3.5, 4.5, 5.5), 5: (3.5, 5.5, 7.5)}
)
# Шаг сетки подбора сдвига темпа и число шагов в каждую сторону от прежнего числа
SHIFT_STEP = 0.003
SHIFT_STEPS = 4


@dataclass(frozen=True)
class GamesSample:
    """Сыгранный матч для слоя: три числа матча до матча (после калибровки и SETS_PLATT),
    формат, темп и правило решающего сета, счет по геймам (первым — игрок 1)."""

    probs: Probs3
    best_of: int
    tempo: float
    decider: str
    games: tuple[GameCell, ...]


def games_losses(samples: Iterable[GamesSample], best_of: int, shift: float) -> list[float]:
    """Brier каждого (матч, стандартная линия) формата: тоталы «больше» и фора фаворита."""
    losses: list[float] = []
    for item in samples:
        if item.best_of != best_of:
            continue
        dist = games_dist(item.probs, best_of, GamesInput(item.tempo, item.decider, shift))
        total = sum(a + b for a, b in item.games)
        margin = sum(a - b for a, b in item.games)
        totals = dist.total_probs()
        diffs = dist.diff_probs()
        favorite = item.probs.p1_win >= 0.5
        for line in TOTAL_LINES[best_of]:
            p = sum(value for key, value in totals.items() if key > line)
            losses.append((p - float(total > line)) ** 2)
        for line in HCP_LINES[best_of]:
            if favorite:
                p = sum(value for key, value in diffs.items() if key > line)
                won = margin > line
            else:
                p = sum(value for key, value in diffs.items() if key < -line)
                won = margin < -line
            losses.append((p - float(won)) ** 2)
    return losses


def games_brier(samples: Sequence[GamesSample], best_of: int, shift: float) -> float | None:
    losses = games_losses(samples, best_of, shift)
    return sum(losses) / len(losses) if losses else None


def fit_games_shift(samples: Sequence[GamesSample], best_of: int, center: float) -> float | None:
    """Сдвиг темпа формата с наименьшим Brier стандартных линий: сетка SHIFT_STEP вокруг
    прежнего числа center (±SHIFT_STEPS шагов, не дальше SHIFT_MAX). Матчей нет — None."""
    best: tuple[float, float] | None = None
    for step in range(-SHIFT_STEPS, SHIFT_STEPS + 1):
        shift = round(center + step * SHIFT_STEP, 6)
        if abs(shift) > SHIFT_MAX:
            continue
        found = games_brier(samples, best_of, shift)
        if found is None:
            return None
        if best is None or found < best[0]:
            best = (found, shift)
    return best[1] if best is not None else None
