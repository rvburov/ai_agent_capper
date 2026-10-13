"""Модель сетов: рынки на форы ±1.5 из вероятности победы в матче (LLM_LEARNING.md, 1.4).

Сеты считаются независимыми, игрок 1 выигрывает сет с вероятностью s. Тогда
- до двух побед (best_of = 3): p = s²(3 − 2s), победа с разницей в 2 сета (2:0) — s²;
- до трех побед (best_of = 5): p = s³(10 − 15s + 6s²), с разницей ≥ 2 сета (3:0 или
  3:1) — s³ + 3s³(1 − s).
Обе функции p(s) строго возрастают на (0, 1), поэтому s по p находится бисекцией.

Анализ оперирует тремя числами матча (Probs3): p1_win — П1 выигрывает матч, p1_cover —
П1 выигрывает с разницей ≥ 2 сета (П1(−1.5)), p2_cover — то же для П2. Остальные исходы
выводятся: П2 = 1 − p1_win, П2(+1.5) = 1 − p1_cover, П1(+1.5) = 1 − p2_cover.

Вторая половина модуля — счет по сетам после матча: разбор счета архива по геймам (общий
для досье и расчета ставок) и исход ноги ставки (ML и форы ±1.5) по числу выигранных
сетов. Отказ (walkover), снятие (retired) и неполный счет исхода не дают: его выбирает
участник по правилам своего букмекера (решение В16, Р24).
"""

import re
from dataclasses import dataclass

from app.core.i18n import t

MARKET_ML = "ML"
MARKET_MINUS = "HCP_-1.5"
MARKET_PLUS = "HCP_+1.5"
MARKETS: tuple[str, ...] = (MARKET_ML, MARKET_MINUS, MARKET_PLUS)
BEST_OF: tuple[int, ...] = (3, 5)

# Точность s при бисекции
SET_TOLERANCE = 1e-12
_MAX_ITERATIONS = 200


def _check_best_of(best_of: int) -> None:
    if best_of not in BEST_OF:
        raise ValueError(t("ml.sets.best_of", best_of=best_of))


def _check_probability(value: float) -> None:
    if not 0.0 <= value <= 1.0:
        raise ValueError(t("ml.sets.bad_probability", p=value))


def match_prob_from_set(s: float, best_of: int) -> float:
    """Вероятность победы в матче при вероятности s выиграть сет."""
    _check_best_of(best_of)
    _check_probability(s)
    if best_of == 3:
        return s * s * (3.0 - 2.0 * s)
    return s**3 * (10.0 - 15.0 * s + 6.0 * s * s)


def set_prob_from_match(p: float, best_of: int) -> float:
    """Вероятность выиграть сет, при которой вероятность победы в матче равна p
    (обратная к match_prob_from_set, бисекция)."""
    _check_best_of(best_of)
    _check_probability(p)
    if p in (0.0, 1.0):
        return p
    low, high = 0.0, 1.0
    for _ in range(_MAX_ITERATIONS):
        middle = (low + high) / 2.0
        if match_prob_from_set(middle, best_of) < p:
            low = middle
        else:
            high = middle
        if high - low <= SET_TOLERANCE:
            break
    return (low + high) / 2.0


def cover_prob(s: float, best_of: int) -> float:
    """Вероятность выиграть матч с разницей не меньше 2 сетов (фора −1.5) при
    вероятности s выиграть сет: s² до двух побед; s³ + 3s³(1 − s) до трех."""
    _check_best_of(best_of)
    _check_probability(s)
    if best_of == 3:
        return s * s
    return s**3 + 3.0 * s**3 * (1.0 - s)


@dataclass(frozen=True)
class Probs3:
    """Три числа матча, из которых выводятся все шесть исходов (см. docstring модуля)."""

    p1_win: float
    p1_cover: float
    p2_cover: float

    def as_dict(self) -> dict[str, float]:
        return {"p1_win": self.p1_win, "p1_cover": self.p1_cover, "p2_cover": self.p2_cover}

    def markets(self) -> dict[tuple[str, int], float]:
        return market_probs(self.p1_win, self.p1_cover, self.p2_cover)

    def shown(self) -> "Probs3":
        """Числа, как их видит Claude в досье (SHOWN_DIGITS знаков): с ними сравнивается
        его ответ (расхождение больше 8 п.п.), иначе правило промпта и проверка кода
        расходятся на округлении."""
        return Probs3(
            round(self.p1_win, SHOWN_DIGITS),
            round(self.p1_cover, SHOWN_DIGITS),
            round(self.p2_cover, SHOWN_DIGITS),
        )


PROBS3_FIELDS: tuple[str, ...] = ("p1_win", "p1_cover", "p2_cover")
# Знаков после запятой у вероятностей в досье (app/services/dossier.py)
SHOWN_DIGITS = 3


def base_probs(p1_win: float, best_of: int) -> Probs3:
    """Три числа матча по модели сетов из вероятности победы игрока 1."""
    s = set_prob_from_match(p1_win, best_of)
    return Probs3(
        p1_win=p1_win,
        p1_cover=cover_prob(s, best_of),
        p2_cover=cover_prob(1.0 - s, best_of),
    )


def market_probs(p1_win: float, p1_cover: float, p2_cover: float) -> dict[tuple[str, int], float]:
    """Вероятности всех исходов: (рынок, selection) → p. selection 1 — ставка на игрока 1,
    2 — на игрока 2."""
    return {
        (MARKET_ML, 1): p1_win,
        (MARKET_ML, 2): 1.0 - p1_win,
        (MARKET_MINUS, 1): p1_cover,
        (MARKET_MINUS, 2): p2_cover,
        (MARKET_PLUS, 1): 1.0 - p2_cover,
        (MARKET_PLUS, 2): 1.0 - p1_cover,
    }


# --- счет по сетам и исход ноги ---

# Сет в счете архива: «6-4», «7-6(5)», «[10-8]» (супер-тай-брейк)
SET_SCORE = re.compile(r"^\[?(\d+)-(\d+)(\(\d+\))?\]?$")
# Счет по сетам из ввода участника: «2:1», «2-1», «2 1», «21»; первым — игрок 1
_SET_COUNT = re.compile(r"^([0-3])\s*[:\-\u2013.\s]?\s*([0-3])$")
RESULT_WIN = "win"
RESULT_LOSS = "loss"
# Почему исход ноги не определить по матчу: выбор за участником (В16)
OUTCOME_WALKOVER = "walkover"
OUTCOME_RETIRED = "retired"
OUTCOME_INCOMPLETE = "incomplete"
OUTCOME_NO_RESULT = "no_result"


def parse_sets(score: str | None) -> list[tuple[int, int, str]]:
    """Сеты счета архива со стороны победителя: (геймы победителя, геймы проигравшего,
    очки тай-брейка). Слова вроде RET и W/O пропускаются."""
    found: list[tuple[int, int, str]] = []
    for token in (score or "").split():
        match = SET_SCORE.match(token)
        if match:
            found.append((int(match.group(1)), int(match.group(2)), match.group(3) or ""))
    return found


def score_for(score: str | None, won: bool) -> str | None:
    """Счет со стороны игрока: у проигравшего геймы в каждом сете меняются местами."""
    if not score or won:
        return score
    parts: list[str] = []
    for token in score.split():
        match = SET_SCORE.match(token)
        if match is None:
            parts.append(token)
            continue
        text = f"{match.group(2)}-{match.group(1)}{match.group(3) or ''}"
        parts.append(f"[{text}]" if token.startswith("[") else text)
    return " ".join(parts)


@dataclass(frozen=True)
class SetCount:
    """Выигранные сеты: first — первой стороны, second — второй."""

    first: int
    second: int

    def swapped(self) -> "SetCount":
        return SetCount(self.second, self.first)

    def text(self) -> str:
        return f"{self.first}:{self.second}"


def wins_needed(best_of: int) -> int:
    """Сколько сетов нужно выиграть: 2 до двух побед (best_of = 3), 3 — до трех."""
    _check_best_of(best_of)
    return best_of // 2 + 1


def complete_for(count: SetCount, best_of: int) -> bool:
    """Счет полный для формата: один набрал нужное число побед, у другого меньше."""
    need = wins_needed(best_of)
    return (count.first == need and count.second < need) or (
        count.second == need and count.first < need
    )


def infer_best_of(count: SetCount) -> int | None:
    """Формат по полному счету, если он однозначен: 3 победы — до трех; 2 победы при
    0 или 1 у соперника — до двух (2:1 до трех побед — неполный счет). Иначе None."""
    top, low = max(count.first, count.second), min(count.first, count.second)
    if top == 3 and low < 3:
        return 5
    if top == 2 and low < 2:
        return 3
    return None


def parse_set_count(text: str | None, best_of: int | None = None) -> SetCount | None:
    """Счет по сетам из ввода участника («2:1», первым — игрок 1). None — не счет или
    неполный для формата; best_of None — подходит полный счет любого формата."""
    match = _SET_COUNT.match((text or "").strip())
    if match is None:
        return None
    count = SetCount(int(match.group(1)), int(match.group(2)))
    if best_of is None:
        return count if infer_best_of(count) is not None else None
    return count if best_of in BEST_OF and complete_for(count, best_of) else None


def set_count_from_score(score: str | None, *, winner_is_first: bool) -> SetCount:
    """Выигранные сеты по счету архива (он со стороны победителя): сет за тем, у кого
    больше геймов. winner_is_first — победитель матча — первая сторона."""
    won = lost = 0
    for winner_games, loser_games, _ in parse_sets(score):
        if winner_games > loser_games:
            won += 1
        elif loser_games > winner_games:
            lost += 1
    return SetCount(won, lost) if winner_is_first else SetCount(lost, won)


def leg_result(market: str, selection: int, count: SetCount, best_of: int) -> str | None:
    """Исход ноги по полному счету (count — сеты игрока 1 и игрока 2): win или loss.
    Неполный счет — None. Фора −1.5 — победа с разницей не меньше 2 сетов, +1.5 —
    поражение не больше чем с разницей в 1 сет или победа."""
    if market not in MARKETS:
        raise ValueError(t("ml.sets.bad_market", market=market))
    if selection not in (1, 2):
        raise ValueError(t("ml.sets.bad_selection", selection=selection))
    if not complete_for(count, best_of):
        return None
    own, other = (count.first, count.second) if selection == 1 else (count.second, count.first)
    if market == MARKET_ML:
        won = own > other
    elif market == MARKET_MINUS:
        won = own - other >= 2
    else:
        won = other - own < 2
    return RESULT_WIN if won else RESULT_LOSS


def complete_scores(best_of: int | None) -> list[SetCount]:
    """Все полные счета формата (первым — игрок 1): 2:0, 2:1, 1:2, 0:2 до двух побед;
    best_of None — обоих форматов."""
    found: list[SetCount] = []
    formats = (best_of,) if best_of is not None and best_of in BEST_OF else BEST_OF
    for fmt in formats:
        need = wins_needed(fmt)
        found.extend(SetCount(need, low) for low in range(need))
        found.extend(SetCount(low, need) for low in reversed(range(need)))
    return found


def score_outcomes(market: str, selection: int, best_of: int | None) -> dict[str, str]:
    """Исход ноги по каждому полному счету («2:1» → win или loss; первым — игрок 1):
    по этой таблице окно расчета отмечает исход по счету, не повторяя правило фор."""
    outcomes: dict[str, str] = {}
    for count in complete_scores(best_of):
        fmt = best_of if best_of in BEST_OF else infer_best_of(count)
        result = leg_result(market, selection, count, fmt) if fmt is not None else None
        if result is not None:
            outcomes[count.text()] = result
    return outcomes


@dataclass(frozen=True)
class LegOutcome:
    """Исход ноги по матчу: result — win или loss; None — исход выбирает участник по
    правилам букмекера, reason — почему (walkover, retired, incomplete, no_result)."""

    result: str | None
    reason: str | None = None


def match_leg_outcome(
    market: str,
    selection: int,
    *,
    status: str,
    winner_is_p1: bool | None,
    score: str | None,
    best_of: int | None,
) -> LegOutcome:
    """Исход ноги по сыгранному матчу архива (status, победитель, счет со стороны
    победителя). Отказ и снятие — выбор участника (В16); у ML при обычном окончании
    хватает победителя, у фор нужен полный счет по сетам."""
    if status == "walkover":
        return LegOutcome(None, OUTCOME_WALKOVER)
    if status == "retired":
        return LegOutcome(None, OUTCOME_RETIRED)
    if status != "finished" or winner_is_p1 is None:
        return LegOutcome(None, OUTCOME_NO_RESULT)
    count = set_count_from_score(score, winner_is_first=winner_is_p1)
    fmt = best_of if best_of in BEST_OF else infer_best_of(count)
    result = leg_result(market, selection, count, fmt) if fmt is not None else None
    if result is not None:
        return LegOutcome(result)
    if market == MARKET_ML:
        won = winner_is_p1 == (selection == 1)
        return LegOutcome(RESULT_WIN if won else RESULT_LOSS)
    return LegOutcome(None, OUTCOME_INCOMPLETE)
