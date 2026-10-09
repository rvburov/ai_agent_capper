"""Имена игроков для сопоставления источников: Сакманн пишет «Juan Martin Del Potro»,
tennis-data — «Del Potro J.M.», старый бот и пользователи — «Синнер» или «Синнер Я.».

Здесь только чистые функции без базы: сложение имени в ключ сравнения (fold),
транслитерация кириллицы (translit_ru), разбор имени tennis-data
(parse_tennis_data_name) и набор ключей для поиска кандидатов (name_keys). Совпадение
ключей — только кандидат: окончательно игрока выбирает app/services/players.py
(нечеткий поиск pg_trgm, страна, ручная правка).
"""

import re
import unicodedata

# Дефисы, тире, апострофы, точки, запятые и подчеркивание разделяют части имени
_SEPARATORS = re.compile(r"[\-\u2010-\u2015'`\u00b4\u02bc\u2018\u2019.,_]")
_CYRILLIC = re.compile(r"[\u0400-\u04ff]")
# Латинские буквы, которые NFKD не раскладывает на букву и знак
_LATIN_EXTRA = {
    "\u0111": "dj",  # d с чертой: Djokovic, как пишут ATP и Сакманн
    "\u00f0": "d",  # eth
    "\u0142": "l",  # l с чертой (польское)
    "\u00f8": "o",  # o перечеркнутое
    "\u00e6": "ae",
    "\u0153": "oe",
    "\u0131": "i",  # i без точки (турецкое)
    "\u00fe": "th",  # thorn
    "\u0127": "h",  # h с чертой
}
# Практическая транслитерация имен (как в ATP: Medvedev, Khachanov, Tsitsipas).
# «е с двумя точками» дает e, как в написании ATP: Rublev
_RU_LATIN = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "\u0451": "e",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
    # Украинские и белорусские буквы
    "і": "i",
    "ї": "yi",
    "є": "ye",
    "ґ": "g",
    "ў": "u",
}
# Частицы фамилии: «del» из «Del Potro» сама по себе не ключ
_PARTICLES = frozenset(
    {"da", "das", "de", "del", "della", "den", "der", "di", "do", "dos", "du", "el", "la", "le"}
    | {"ter", "van", "von"}
)
# Инициалы — не длиннее трех букв: «J.», «J.M.», «J.-W.», «An.» (Kuznetsov An.)
_MAX_INITIALS = 3


def fold(text: str) -> str:
    """Ключ сравнения: нижний регистр, без диакритики, дефисы, апострофы и точки —
    пробелы, лишние пробелы убраны. Кириллица остается кириллицей («е с двумя точками»
    → «е»). «Auger-Aliassime F.» → «auger aliassime f», «Đoković» → «djokovic»."""
    out: list[str] = []
    for char in text.casefold():
        if _CYRILLIC.match(char):
            # NFKD превратил бы «й» в «и» со знаком, поэтому кириллица не раскладывается
            out.append("е" if char == "\u0451" else char)
        elif char in _LATIN_EXTRA:
            out.append(_LATIN_EXTRA[char])
        else:
            decomposed = unicodedata.normalize("NFKD", char)
            out.extend(c for c in decomposed if not unicodedata.combining(c))
    return " ".join(_SEPARATORS.sub(" ", "".join(out)).split())


def translit_ru(text: str) -> str:
    """Кириллица → латиница в нижнем регистре: Синнер → sinner, Хачанов → khachanov,
    Циципас → tsitsipas, Джокович → dzhokovich. Прочие знаки не меняются."""
    return "".join(_RU_LATIN.get(char, char) for char in text.casefold())


def has_cyrillic(text: str) -> bool:
    return _CYRILLIC.search(text) is not None


def _initials_token(token: str) -> str | None:
    """Буквы инициалов, если слово — инициалы («J.», «J.M.», «JM», «An.»), иначе None."""
    letters = re.sub(r"[.\-‐-―]", "", token)
    if not letters.isalpha() or len(letters) > _MAX_INITIALS:
        return None
    if "." in token or len(letters) == 1 or (token.isupper() and len(letters) <= 2):
        return letters
    return None


def parse_tennis_data_name(name: str) -> tuple[str, str]:
    """«Del Potro J.M.» → ("del potro", "jm"), «Sinner J.» → ("sinner", "j").

    Фамилия — сложенная (fold), инициалы — буквы без точек в нижнем регистре. Инициалов
    нет — вторая часть пустая: «Sinner» → ("sinner", ""). Хотя бы одно слово всегда
    остается фамилией.
    """
    tokens = name.split()
    cut = len(tokens)
    initials: list[str] = []
    while cut > 1:
        letters = _initials_token(tokens[cut - 1])
        if letters is None:
            break
        initials.insert(0, letters)
        cut -= 1
    return fold(" ".join(tokens[:cut])), fold("".join(initials)).replace(" ", "")


def _surname_keys(
    family: list[str], initials: str, *, first_word: bool, alone: bool = True
) -> set[str]:
    """Ключи фамилии: раздельно и слитно, одна и с инициалами; для фамилии из
    нескольких слов (first_word) еще первое слово с инициалом: «Ramos-Vinolas A.» →
    «ramos a» (короткая форма испанской фамилии)."""
    keys: set[str] = set()
    for form in {" ".join(family), "".join(family)}:
        if alone:
            keys.add(form)
        if initials:
            keys.add(f"{form} {initials}")
            keys.add(f"{form} {initials[0]}")
    if first_word and initials and len(family) > 1 and family[0] not in _PARTICLES:
        keys.add(f"{family[0]} {initials[0]}")
    return keys


def _keys_of(full: str, surname: str, initials: str) -> set[str]:
    keys = {full}
    if initials:
        # Формат «Фамилия И.»: фамилия известна
        return keys | _surname_keys(surname.split(), initials, first_word=True)
    words = full.split()
    # Формат «Имя Фамилия»: где кончается имя, неизвестно, перебираются все разбиения
    for split in range(1, len(words)):
        given, family = words[:split], words[split:]
        abbr = "".join(word[0] for word in given)
        keys |= _surname_keys(family, abbr, first_word=split == 1)
        # Две первые буквы имени: tennis-data так различает тезок («Kuznetsov An.»)
        keys |= _surname_keys(family, given[0][:2], first_word=False, alone=False)
    return keys


def name_keys(name: str) -> set[str]:
    """Ключи для поиска игрока по имени из любого источника.

    - полное сложенное имя: «juan martin del potro», «del potro j m»;
    - фамилия с инициалами: «del potro jm», «del potro j» (и слитно: «delpotro j»);
    - только фамилия: «del potro», «delpotro»;
    - у имени «Имя Фамилия» перебираются все разбиения на имя и фамилию, плюс фамилия
      с двумя первыми буквами имени («kuznetsov an»).
    Кириллица дает те же ключи еще и в латинице (translit_ru): «Синнер Я.» → «sinner ya».
    Чем больше общих ключей и чем они длиннее, тем вероятнее, что это один игрок.
    """
    full = fold(name)
    if not full:
        return set()
    surname, initials = parse_tennis_data_name(name)
    keys = _keys_of(full, surname, initials)
    if has_cyrillic(full):
        keys |= _keys_of(translit_ru(full), translit_ru(surname), translit_ru(initials))
    return keys
