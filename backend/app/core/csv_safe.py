"""Ячейки CSV, которые таблица (Excel, LibreOffice) не примет за формулу.

Текст, начатый с =, +, -, @, табуляции или перевода строки, таблица выполняет как
формулу (HYPERLINK может отправить данные наружу). Такой текст пишется с апострофом в
начале. Числа не трогаем: отрицательная сумма остается числом.
"""

from typing import Any

FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


def safe_text(value: str) -> str:
    """Текст для ячейки: с апострофом, если таблица начала бы с него формулу."""
    return "'" + value if value.startswith(FORMULA_START) else value


def csv_cell(value: Any) -> str:
    """Ячейка выгрузки «Ставок» и «Аналитики»: пусто для NULL, текст — через safe_text,
    дробь — до 6 знаков."""
    if value is None:
        return ""
    if isinstance(value, str):
        return safe_text(value)
    if isinstance(value, float):
        return repr(round(value, 6))
    return str(value)
