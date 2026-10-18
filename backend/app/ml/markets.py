"""Коды рынков ставок (Р28): разборщик кода, пары исходов, исход ноги по счету по геймам.

Линия живет в строке рынка (`market` в predictions, bet_legs, odds_snapshots), отдельной
колонки нет: уникальные индексы и старые строки не меняются.

Коды и стороны (selection):
- `ML` — победа в матче, 1 — игрок 1, 2 — игрок 2;
- `HCP_±1.5`, `HCP_±2.5` — фора по сетам, `GHCP_±X` и `GHCP_±X.5` — фора по геймам. Линия —
  у выбранной стороны: (`HCP_-2.5`, 1) — П1(−2.5), (`HCP_-2.5`, 2) — П2(−2.5). Поэтому
  пара для снятия маржи — (`GHCP_-3.5`, 1) и (`GHCP_+3.5`, 2), а при перемене игроков
  местами меняется только сторона;
- `STOT_2.5|3.5|4.5` — тотал сетов, `GTOT_X` и `GTOT_X.5` — тотал геймов; 1 — больше,
  2 — меньше. От порядка игроков тотал не зависит: стороны не меняются.

Семейство рынка (family) — строка экрана и счетчика «для сравнения»: ml, h15 (фора по сетам
±1.5, прежние коды), shcp (фора по сетам ±2.5, только до 3 побед), stot, ghcp, gtot.

Линии — половинные (22.5) и целые (22); четвертных (22.25) нет. У целой линии исход
«ровно» — возврат: валуй = p·кэф + P(возврат) − 1 (app/ml/strategy.py, value).

Счет по геймам для расчета (games): список сетов (геймы игрока 1, геймы игрока 2).
Тай-брейк — один гейм (7:6 — 13 геймов), супер-тай-брейк [10-8] — тоже один гейм.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation

from app.core.i18n import t

FAMILY_ML = "ml"
FAMILY_H15 = "h15"
FAMILY_SHCP = "shcp"
FAMILY_STOT = "stot"
FAMILY_GHCP = "ghcp"
FAMILY_GTOT = "gtot"
FAMILIES: tuple[str, ...] = (
    FAMILY_ML,
    FAMILY_H15,
    FAMILY_SHCP,
    FAMILY_STOT,
    FAMILY_GHCP,
    FAMILY_GTOT,
)
# Новые рынки Р28: «для сравнения», пока администратор не переведет семейство в экспресс
NEW_FAMILIES: tuple[str, ...] = (FAMILY_SHCP, FAMILY_STOT, FAMILY_GHCP, FAMILY_GTOT)
# Семейства, у которых есть вероятность модели. Рынки по геймам (цепь app/ml/games.py)
# прошли проверку на 2023–2025 (этап 7, волна 3; PLAN.md, Р28): верхняя граница 95% ДИ
# разницы Brier с константой ниже нуля по всем стандартным линиям семейства
MODEL_FAMILIES: tuple[str, ...] = (
    FAMILY_ML,
    FAMILY_H15,
    FAMILY_SHCP,
    FAMILY_STOT,
    FAMILY_GHCP,
    FAMILY_GTOT,
)
# Семейства, модель которых не прошла проверку на истории: вероятность не показывается, в
# экспресс перевести нельзя (сейчас таких нет; семейство отсюда не входит в MODEL_FAMILIES)
FAILED_FAMILIES: tuple[str, ...] = ()
# Состояние модели семейства для экрана: ok — вероятность есть, failed — модель не прошла
# проверку, none — модели пока нет
MODEL_OK = "ok"
MODEL_FAILED = "failed"
MODEL_NONE = "none"
# Семейства, исход которых считается по счету по геймам
GAME_FAMILIES: tuple[str, ...] = (FAMILY_GHCP, FAMILY_GTOT)
# Семейства «другие рынки» формы ввода (extra): фора ±1.5 вводится прежними полями
EXTRA_FAMILIES: tuple[str, ...] = NEW_FAMILIES

UNIT_SETS = "sets"
UNIT_GAMES = "games"

# Линии рынков по сетам и их форматы: фора ±2.5 и тоталы 3.5, 4.5 — только до 3 побед
SET_HCP_LINES: Mapping[Decimal, tuple[int, ...]] = {
    Decimal("1.5"): (3, 5),
    Decimal("2.5"): (5,),
}
SET_TOTAL_LINES: Mapping[Decimal, tuple[int, ...]] = {
    Decimal("2.5"): (3,),
    Decimal("3.5"): (5,),
    Decimal("4.5"): (5,),
}
# Пределы линий по геймам: тотал до 5 — это сеты, от 15 — геймы (разбор текста)
GAME_HCP_MAX = Decimal("30")
GAME_TOTAL_MIN = Decimal("10")
GAME_TOTAL_MAX = Decimal("80")

_HALF = Decimal("0.5")
_CODE = re.compile(r"^(?P<prefix>HCP|GHCP|STOT|GTOT)_(?P<sign>[+-]?)(?P<number>\d{1,2}(?:\.5)?)$")


@dataclass(frozen=True)
class MarketSpec:
    """Разобранный код рынка: семейство и линия (у фор — линия выбранной стороны в коде,
    у тоталов — сама линия; у ML — None)."""

    code: str
    family: str
    line: Decimal | None

    @property
    def unit(self) -> str:
        return UNIT_GAMES if self.family in GAME_FAMILIES else UNIT_SETS

    @property
    def is_total(self) -> bool:
        return self.family in (FAMILY_STOT, FAMILY_GTOT)

    @property
    def is_handicap(self) -> bool:
        return self.family in (FAMILY_H15, FAMILY_SHCP, FAMILY_GHCP)

    @property
    def whole(self) -> bool:
        """Целая линия: исход «ровно» — возврат."""
        return self.line is not None and self.line == self.line.to_integral_value()

    @property
    def has_model(self) -> bool:
        return has_model(self.family)

    @property
    def is_new(self) -> bool:
        return self.family in NEW_FAMILIES


def has_model(family: str) -> bool:
    """У семейства есть вероятность модели (списки читаются при вызове: тесты их меняют)."""
    return family in MODEL_FAMILIES and family not in FAILED_FAMILIES


def model_state(family: str) -> str:
    """ok, failed или none (см. MODEL_OK)."""
    if family in FAILED_FAMILIES:
        return MODEL_FAILED
    return MODEL_OK if family in MODEL_FAMILIES else MODEL_NONE


def line_text(line: Decimal, *, signed: bool = False) -> str:
    """Линия для кода и экрана: 3 → «3», 3.5 → «3.5»; signed — со знаком («+3.5», «-3»)."""
    number = abs(line)
    text = (
        str(number.quantize(Decimal(1)))
        if number == number.to_integral_value()
        else str(number.quantize(Decimal("0.1")))
    )
    if not signed:
        return text
    return ("-" if line < 0 else "+") + text


def _is_line(value: Decimal) -> bool:
    """Половинная или целая линия (без 0.25 и 0.75)."""
    doubled = value * 2
    return doubled == doubled.to_integral_value()


def _bad(code: str) -> ValueError:
    return ValueError(t("ml.sets.bad_market", market=code))


def market_spec(code: str) -> MarketSpec:
    """Семейство и линия по коду рынка; неверный код — ValueError."""
    if code == "ML":
        return MarketSpec(code, FAMILY_ML, None)
    match = _CODE.match(code or "")
    if match is None:
        raise _bad(code)
    prefix, sign, number = match.group("prefix"), match.group("sign"), match.group("number")
    value = Decimal(number)
    if prefix in ("HCP", "GHCP"):
        if not sign:
            raise _bad(code)
        line = -value if sign == "-" else value
        if prefix == "HCP":
            if value not in SET_HCP_LINES:
                raise _bad(code)
            family = FAMILY_H15 if value == Decimal("1.5") else FAMILY_SHCP
            return MarketSpec(code, family, line)
        if not _HALF <= value <= GAME_HCP_MAX:
            raise _bad(code)
        return MarketSpec(code, FAMILY_GHCP, line)
    if sign:
        raise _bad(code)
    if prefix == "STOT":
        if value not in SET_TOTAL_LINES:
            raise _bad(code)
        return MarketSpec(code, FAMILY_STOT, value)
    if not GAME_TOTAL_MIN <= value <= GAME_TOTAL_MAX:
        raise _bad(code)
    return MarketSpec(code, FAMILY_GTOT, value)


def is_market(code: str) -> bool:
    try:
        market_spec(code)
    except ValueError:
        return False
    return True


def family_of(code: str) -> str:
    return market_spec(code).family


def market_code(family: str, line: Decimal | None = None) -> str:
    """Код рынка по семейству и линии (у фор — линия выбранной стороны). Неверная пара —
    ValueError."""
    if family == FAMILY_ML:
        return "ML"
    if line is None or not _is_line(line):
        raise _bad(f"{family}:{line}")
    prefixes = {
        FAMILY_H15: "HCP",
        FAMILY_SHCP: "HCP",
        FAMILY_GHCP: "GHCP",
        FAMILY_STOT: "STOT",
        FAMILY_GTOT: "GTOT",
    }
    prefix = prefixes.get(family)
    if prefix is None:
        raise _bad(family)
    signed = prefix in ("HCP", "GHCP")
    code = f"{prefix}_{line_text(line, signed=signed)}"
    spec = market_spec(code)
    if spec.family != family:
        raise _bad(code)
    return code


def fits_format(code: str, best_of: int | None) -> bool:
    """Рынок возможен в матче этого формата: фора ±2.5 и тоталы 3.5, 4.5 — только до 3
    побед, тотал сетов 2.5 — только до 2 побед. Формат неизвестен — любой."""
    spec = market_spec(code)
    if best_of is None or spec.line is None:
        return True
    if spec.family in (FAMILY_H15, FAMILY_SHCP):
        return best_of in SET_HCP_LINES[abs(spec.line)]
    if spec.family == FAMILY_STOT:
        return best_of in SET_TOTAL_LINES[spec.line]
    return True


def opposite(code: str, selection: int) -> tuple[str, int]:
    """Обратный исход того же рынка (пара для снятия маржи): П1 ↔ П2, (Ф −3.5, 1) ↔
    (Ф +3.5, 2), больше ↔ меньше той же линии."""
    spec = market_spec(code)
    other = 3 - selection
    if spec.is_handicap:
        assert spec.line is not None
        return market_code(spec.family, -spec.line), other
    return code, other


def swapped_side(code: str, selection: int) -> int:
    """Сторона исхода, когда игроки матча меняются местами: у тотала та же."""
    return selection if market_spec(code).is_total else 3 - selection


# --- кэфы «других рынков» формы: семейство, линия (у фор — игрока 1), две стороны ---


@dataclass(frozen=True)
class ExtraLine:
    """Строка «Другие рынки»: o1 — Ф1 с линией line (у фор) или больше (у тоталов),
    o2 — Ф2 с линией −line или меньше."""

    family: str
    line: Decimal
    o1: Decimal | None
    o2: Decimal | None

    def codes(self) -> tuple[str, str]:
        """Коды рынков сторон: (рынок стороны 1, рынок стороны 2)."""
        first = market_code(self.family, self.line)
        if self.family in (FAMILY_SHCP, FAMILY_GHCP, FAMILY_H15):
            return first, market_code(self.family, -self.line)
        return first, first


def to_line(value: object) -> Decimal | None:
    """Линия из ввода: число или строка («-3.5», «22»); не линия — None."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = Decimal(str(value).replace(",", ".").replace("−", "-").strip())
    except (InvalidOperation, ValueError):
        return None
    if not number.is_finite() or not _is_line(number):
        return None
    return number


OddsPairs = Mapping[str, Sequence[Decimal | None]]


def extra_into(odds: dict[str, list[Decimal | None]], lines: Iterable[ExtraLine]) -> None:
    """Кэфы строк «Другие рынки» в карту рынок → [сторона 1, сторона 2] (как ±1.5:
    (HCP_-2.5, 1) и (HCP_+2.5, 2) — разные рынки одной строки)."""
    for row in lines:
        first, second = row.codes()
        for code, side, price in ((first, 1, row.o1), (second, 2, row.o2)):
            pair = odds.setdefault(code, [None, None])
            if price is not None:
                pair[side - 1] = price


def extra_lines(odds: OddsPairs) -> list[ExtraLine]:
    """Обратно: строки «Другие рынки» по карте кэфов (рынки новых семейств), в порядке
    рынков карты. У фор линия — игрока 1."""
    found: dict[tuple[str, Decimal], list[Decimal | None]] = {}
    for code, pair in odds.items():
        try:
            spec = market_spec(code)
        except ValueError:
            continue
        if spec.family not in EXTRA_FAMILIES or spec.line is None:
            continue
        for side, price in enumerate(pair, start=1):
            if price is None:
                continue
            line = spec.line if not spec.is_handicap or side == 1 else -spec.line
            row = found.setdefault((spec.family, line), [None, None])
            row[side - 1] = price
    return [ExtraLine(family, line, pair[0], pair[1]) for (family, line), pair in found.items()]


# --- исход ноги по счету ---

RESULT_WIN = "win"
RESULT_LOSS = "loss"
RESULT_VOID = "void"

GameSets = Sequence[tuple[int, int]]

# Сет счета по геймам из ввода: «6:4», «6-4», «7:6(5)», «7:6(10-8)», «7:6(10:8)», «13:12»,
# «[10-8]»; разделители — как у окна расчета на frontend (settle.ts): «:», «-», «–»
_GAME_SET = re.compile(
    r"^(\[)?(\d{1,2})\s*[:\-–]\s*(\d{1,2})(?:\((\d{1,2})(?:[:\-–]\d{1,2})?\))?(\])?$"
)
GAMES_MAX_SETS = 5


def parse_games(text: str | None) -> list[tuple[int, int]] | None:
    """Счет по геймам из ввода («6:4 7:6(5)», первым — игрок 1): список сетов (геймы
    игрока 1, геймы игрока 2); супер-тай-брейк [10-8] — один гейм. Не счет — None."""
    tokens = (text or "").replace(",", " ").split()
    if not tokens or len(tokens) > GAMES_MAX_SETS:
        return None
    found: list[tuple[int, int]] = []
    for token in tokens:
        match = _GAME_SET.match(token)
        if match is None or bool(match.group(1)) != bool(match.group(5)):
            return None
        first, second = int(match.group(2)), int(match.group(3))
        if match.group(1):
            if first == second:
                return None
            found.append((1, 0) if first > second else (0, 1))
            continue
        found.append((first, second))
    return found


def set_finished(first: int, second: int, *, last: bool = True) -> bool:
    """Сет доигран: 6 геймов с разницей 2 и больше, 7:5, 7:6, длинный сет с разницей 2
    (13:11) или 13:12 — только решающий (last: тай-брейк при 12:12, Уимблдон 2019–2021);
    супер-тай-брейк — 1:0."""
    high, low = max(first, second), min(first, second)
    if (high, low) == (1, 0):
        return True
    if (high, low) == (13, 12):
        return last
    if high == 7 and low in (5, 6):
        return True
    return high >= 6 and high - low == 2 if high > 6 else high == 6 and low <= 4


def games_complete(sets: GameSets, best_of: int | None) -> bool:
    """Матч доигран по счету: все сеты доиграны и у одного нужное число сетов (формат
    неизвестен — 2 или 3 победы при меньшем числе у соперника)."""
    final = len(sets) - 1
    if not sets or not all(
        set_finished(first, second, last=index == final)
        for index, (first, second) in enumerate(sets)
    ):
        return False
    won = sum(1 for first, second in sets if first > second)
    lost = len(sets) - won
    top, low = max(won, lost), min(won, lost)
    needs = (best_of // 2 + 1,) if best_of in (3, 5) else (2, 3)
    return any(top == need and low < need for need in needs)


# Регулярное выражение SQL: счет «a:b» каждого сета → «b:a» (обмен игроков у ноги на тотал:
# ее счет хранится со стороны игрока 1)
SCORE_SIDES = r"(\d+):(\d+)"
SCORE_SWAPPED = r"\2:\1"


def games_text(sets: GameSets) -> str:
    """Счет по геймам для хранения и показа: «6:4 7:6»."""
    return " ".join(f"{first}:{second}" for first, second in sets)


def swapped_games(sets: GameSets) -> list[tuple[int, int]]:
    return [(second, first) for first, second in sets]


def games_leg_result(code: str, selection: int, sets: GameSets) -> str:
    """Исход ноги рынка по геймам (sets — первым игрок 1): фора — разница геймов
    стороны плюс линия, тотал — сумма геймов минус линия; ровно — возврат."""
    spec = market_spec(code)
    if spec.family not in GAME_FAMILIES or spec.line is None:
        raise _bad(code)
    if selection not in (1, 2):
        raise ValueError(t("ml.sets.bad_selection", selection=selection))
    first = sum(item[0] for item in sets)
    second = sum(item[1] for item in sets)
    if spec.family == FAMILY_GHCP:
        own, other = (first, second) if selection == 1 else (second, first)
        margin = Decimal(own - other) + spec.line
    else:
        margin = Decimal(first + second) - spec.line
        if selection == 2:
            margin = -margin
    if margin > 0:
        return RESULT_WIN
    if margin < 0:
        return RESULT_LOSS
    return RESULT_VOID
