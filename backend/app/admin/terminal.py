"""Общее для команд терминала (app/admin/cli.py и команды приемки app/admin/acceptance.py):
ошибка команды, вывод, таблица и подтверждение.

Отдельный модуль, а не cli.py: при запуске python -m app.admin.cli модуль cli.py — это
__main__, и импорт app.admin.cli из другого модуля создал бы второй класс CliError,
который main() уже не поймал бы.
"""

from collections.abc import Sequence
from typing import Any

from app.core.i18n import t

YES = frozenset({"y", "yes", "д", "да"})
# Коды возврата: 1 — команда не выполнена или критерий приемки не выполнен; 2 — запуск
# отменен ответом «нет»; 3 — пробный прогон приемки (критерии выполнены на выборке
# меньше, чем в PLAN.md); 130 — прервано Ctrl+C (как у оболочки: 128 + SIGINT)
EXIT_FAILED = 1
EXIT_CANCELLED = 2
EXIT_TRIAL = 3
EXIT_INTERRUPTED = 130


class CliError(Exception):
    """Ошибка команды: текст из локали cli.*, код возврата exit_code (по умолчанию 1)."""

    def __init__(self, key: str, *, exit_code: int = EXIT_FAILED, **params: Any) -> None:
        super().__init__(key)
        self.message = t(f"cli.{key}", **params)
        self.exit_code = exit_code


def say(text: str) -> None:
    print(text, flush=True)


def dash(value: object) -> str:
    return "—" if value is None or value == "" else str(value)


def table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    """Таблица для терминала: ширина колонки — по самому длинному значению."""
    widths = [max(len(row[i]) for row in (header, *rows)) for i in range(len(header))]
    lines = [
        "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
        for row in (header, *rows)
    ]
    lines.insert(1, "  ".join("-" * width for width in widths))
    return "\n".join(lines)


def confirmed(prompt_key: str = "cli.players_merge_confirm") -> bool:
    """Ответ «да» на вопрос prompt_key (ключ локали). Конец ввода и Ctrl+C — «нет»."""
    try:
        answer = input(t(prompt_key))
    except (EOFError, KeyboardInterrupt):
        return False
    return answer.strip().casefold() in YES
