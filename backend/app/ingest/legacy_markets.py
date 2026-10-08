"""Разбор полей записи старого бота: рынки, кэфы, покрытия и имена игроков.

Формат записи \u2014 legacy/telegram-bot/Tennis-Analytics/Инструкция-Авто.md, раздел
«Структура записи». Записи писала LLM, поэтому написание плавает: «П1(-1.5)»,
«п1 (-1,5)», латинская P. Все, что разобрать нельзя, возвращается как None, а импорт
пишет это в отчет и не падает.
"""

import re
from typing import NamedTuple

ML = "ML"
HCP_MINUS_1_5 = "HCP_-1.5"
HCP_PLUS_1_5 = "HCP_+1.5"


class Pick(NamedTuple):
    """Исход: рынок и сторона (1 — игрок1 записи, 2 — игрок2)."""

    market: str
    selection: int

    def flipped(self) -> "Pick":
        """Тот же исход, если в матче базы игроки стоят в обратном порядке."""
        return Pick(self.market, 3 - self.selection)


# П1, П2, П1(-1.5), П2(+1.5) и т. п.: кириллическая П, латинские P и W; знак — плюс,
# дефис, минус U+2212 или тире; скобки можно не ставить. Фора по сетам у бота только 1.5
_MARKET = re.compile(r"^(?:П|P|W)([12])(?:\(?([+\-\u2212\u2013\u2014])1\.5\)?)?$")
_MINUS_SIGNS = frozenset("-\u2212\u2013\u2014")

# Ключи объекта «кэфы» в записи
ODDS_KEYS: dict[str, Pick] = {
    "п1": Pick(ML, 1),
    "п2": Pick(ML, 2),
    "п1_плюс_1_5": Pick(HCP_PLUS_1_5, 1),
    "п1_минус_1_5": Pick(HCP_MINUS_1_5, 1),
    "п2_плюс_1_5": Pick(HCP_PLUS_1_5, 2),
    "п2_минус_1_5": Pick(HCP_MINUS_1_5, 2),
}


def parse_market(raw: object) -> Pick | None:
    """«П2(-1.5)» → Pick('HCP_-1.5', 2). Незнакомый рынок (тотал, фора по геймам) — None."""
    if not isinstance(raw, str):
        return None
    text = re.sub(r"\s+", "", raw).upper().replace(",", ".")
    found = _MARKET.match(text)
    if found is None:
        return None
    selection = int(found.group(1))
    sign = found.group(2)
    if sign is None:
        return Pick(ML, selection)
    return Pick(HCP_MINUS_1_5 if sign in _MINUS_SIGNS else HCP_PLUS_1_5, selection)


def parse_odds_key(raw: str) -> Pick | None:
    """Ключ из «кэфы»: «п1_минус_1_5» → Pick('HCP_-1.5', 1). Понимает и вид «П1(-1.5)»."""
    key = re.sub(r"[\s\-]+", "_", raw.strip().lower()).replace("p", "п")
    return ODDS_KEYS.get(key) or parse_market(raw)


def parse_surface(raw: object) -> tuple[str | None, bool | None]:
    """Покрытие из записи → (surface, indoor). «грунт» → clay, «крытый» → hard в зале.
    Незнакомое — (None, None)."""
    if not isinstance(raw, str):
        return None, None
    text = name_key(raw)
    indoor = True if ("зал" in text or "крыт" in text or "indoor" in text) else None
    if text.startswith(("грун", "clay")):
        return "clay", indoor
    if text.startswith(("трав", "grass")):
        return "grass", indoor
    if text.startswith(("ковер", "carpet")):
        return "carpet", True
    if text.startswith(("хард", "hard")) or indoor:
        return "hard", indoor
    return None, None


def clean_name(raw: str) -> str:
    """Имя для показа: без лишних пробелов по краям и внутри."""
    return re.sub(r"\s+", " ", raw).strip()


def name_key(raw: str) -> str:
    """Ключ сравнения имен: регистр, «е с двумя точками», точки, дефисы и пробелы
    не важны. «Навоне М.» и «навоне  м» дают один ключ, «Оже-Альяссим» и «Оже Альяссим» тоже."""
    text = raw.replace("\u0451", "е").replace("\u0401", "Е")
    text = re.sub(r"[.\-_\u2010-\u2014]", " ", text)
    return re.sub(r"\s+", " ", text).strip().casefold()


def short_name(full_name: str) -> str | None:
    """«Маттео Навоне» → «Навоне М.»: так бот писал имена в истории. Одно слово — None."""
    words = clean_name(full_name).split()
    if len(words) < 2:
        return None
    return " ".join(words[1:]) + " " + words[0][0].upper() + "."


def short_forms(full_name: str) -> list[str]:
    """Как бот писал имена в истории: «Фамилия И.». Для «Маттео Навоне» — «Навоне М.»,
    затем «Маттео Н.» (если в полном имени фамилия стоит первой). Для имен из трех
    слов перебираются все разбиения на имя и фамилию."""
    words = name_key(full_name).split()
    forms: list[str] = []
    for split in range(1, len(words)):
        given, family = words[:split], words[split:]
        forms.append(" ".join(family) + " " + given[0][0])
    for split in range(1, len(words)):
        family, given = words[:split], words[split:]
        forms.append(" ".join(family) + " " + given[0][0])
    unique: list[str] = []
    for form in forms:
        if form not in unique:
            unique.append(form)
    return unique
