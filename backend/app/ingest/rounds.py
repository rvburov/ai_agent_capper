"""Раунды турнира: коды Сакманна как единый формат базы (matches.round).

Сакманн пишет раунд кодом (R32, QF, F), tennis-data.co.uk — словами («1st Round»,
«Quarterfinals»), и номер круга там зависит от размера сетки: «1st Round» турнира на
32 игрока — это R32, а на 128 — R128. Сетки с «дырами» под посев (28, 48, 56, 96)
считаются по ближайшей большей степени двойки: 28 → 32, 56 → 64, 96 → 128.
"""

import re
from collections.abc import Iterable

from app.core.i18n import t

# Коды Сакманна. ER — ранние круги командных турниров, BR — матч за третье место,
# RR — круговой этап итогового турнира, Q1–Q4 — круги квалификации
ROUNDS = ("Q1", "Q2", "Q3", "Q4", "ER", "R128", "R64", "R32", "R16", "RR", "QF", "SF", "BR", "F")

# Порядок раундов внутри турнира: квалификация и ER раньше R128, круговой этап на уровне
# R16 (после него сразу полуфинал), матч за третье место перед финалом
_ORDER = {
    "Q1": 1,
    "Q2": 2,
    "Q3": 3,
    "Q4": 4,
    "ER": 5,
    "R128": 10,
    "R64": 20,
    "R32": 30,
    "R16": 40,
    "RR": 40,
    "QF": 50,
    "SF": 60,
    "BR": 65,
    "F": 70,
}

# Сетка меньше 8 у турниров ATP не бывает, больше 128 — тоже
MIN_DRAW = 8
MAX_DRAW = 128

# Метки tennis-data без номера круга
_NAMED = {
    "quarterfinals": "QF",
    "quarterfinal": "QF",
    "semifinals": "SF",
    "semifinal": "SF",
    "the final": "F",
    "final": "F",
    "round robin": "RR",
}
# «1st Round», «2nd Round», «3rd Round», «4th Round»
_NUMBERED = re.compile(r"^([1-7])(?:st|nd|rd|th) round$")


def round_order(code: str) -> int:
    """Номер раунда для сортировки матчей турнира: R128 < R64 < … < QF < SF < BR < F.
    Неизвестный код — ValueError."""
    try:
        return _ORDER[code]
    except KeyError:
        raise ValueError(t("ingest.rounds.unknown_code", code=code)) from None


def _label_key(label: str) -> str:
    """«Quarter-finals », «QUARTERFINALS» → «quarterfinals»: регистр, пробелы и дефис
    между частями слова не важны."""
    text = " ".join(label.split()).casefold()
    return re.sub(r"\b(quarter|semi)[\s-]+final", r"\1final", text)


def draw_bracket(draw_size: int) -> int:
    """Размер сетки, округленный вверх до степени двойки: 28 → 32, 56 → 64, 96 → 128."""
    if draw_size < 2 or draw_size > MAX_DRAW:
        raise ValueError(t("ingest.rounds.bad_draw", draw=draw_size))
    bracket = MIN_DRAW
    while bracket < draw_size:
        bracket *= 2
    return bracket


def round_number(label: str) -> int | None:
    """Номер круга из метки tennis-data: «2nd Round» → 2. Для остальных меток — None."""
    found = _NUMBERED.match(_label_key(label))
    return int(found.group(1)) if found else None


def tennis_data_round(label: str, draw_size: int) -> str:
    """Метка раунда tennis-data → код Сакманна.

    «1st Round» при сетке 32 (или 28) → R32, при 64 (56) → R64, при 128 (96) → R128;
    «2nd Round» — следующий круг и т. д.; Quarterfinals → QF, Semifinals → SF,
    The Final → F, Round Robin → RR. Неизвестная метка или круг, которого при такой
    сетке нет (например, «4th Round» при сетке 32), — ValueError: загрузчик пишет
    строку в отчет и пропускает ее.
    """
    key = _label_key(label)
    if key in _NAMED:
        return _NAMED[key]
    number = round_number(label)
    if number is None:
        raise ValueError(t("ingest.rounds.unknown_label", label=label.strip()))
    players = draw_bracket(draw_size) >> (number - 1)
    # Круг до четвертьфинала: в нем не меньше 16 игроков (R16)
    if players < 16:
        raise ValueError(t("ingest.rounds.label_beyond_draw", label=label.strip(), draw=draw_size))
    return f"R{players}"


def tennis_data_draw_size(labels: Iterable[str], first_round_matches: int = 0) -> int:
    """Размер сетки турнира tennis-data, если пары у Сакманна нет.

    Берется большее из двух оценок: по числу кругов до четвертьфинала (2 круга — 32,
    3 — 64, 4 — 128) и по числу матчей первого круга (×2, вверх до степени двойки).
    Нужны обе: у сетки 96 в первом круге 32 матча (посеянные его пропускают), а у
    турнира, где сыграна только часть кругов, кругов меньше, чем в сетке.
    """
    rounds = max((n for n in map(round_number, labels) if n is not None), default=0)
    by_rounds = MIN_DRAW << rounds if rounds else MIN_DRAW
    by_matches = (
        draw_bracket(min(first_round_matches * 2, MAX_DRAW))
        if first_round_matches > 0
        else MIN_DRAW
    )
    return min(max(by_rounds, by_matches), MAX_DRAW)
