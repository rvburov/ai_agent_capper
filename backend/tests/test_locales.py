"""Тексты сервера в app/locales/ru.json: файл исправен, и у каждого ключа из кода есть текст.

Без перевода t() возвращает сам ключ, поэтому пропущенный текст не роняет запрос, а
показывается пользователю как "errors.auth.something". Тест находит ключи в коде app/
разбором AST:
- t("ключ") и строковые литералы с префиксом раздела локали ("cli.role_done");
- коды ошибок: AppError(статус, "код"), error_response(статус, "код"), code="код",
  ClaudeStepError("код"), значения _HTTP_CODES и код по умолчанию в _HTTP_CODES.get —
  это ключи errors.<код>;
- помощники с префиксом: CliError("ключ") и _ask_secret("ключ") → cli.<ключ>,
  command(имя, "ключ") → cli.help.<ключ>, _tr("ключ") → ingest.legacy.<ключ>,
  ImportFailure("ключ") → ingest.legacy.errors.<ключ>, note_key="ключ" → ingest.legacy.note.<ключ>;
- полный ключ первым аргументом: IngestError("ключ"), FetchError("ключ") и
  report.add_warning("ключ") загрузчиков данных (app/ingest/runs.py); вторым —
  PlayerError(статус, "ключ") команд игроков (app/services/players.py);
- notify(kind="вид", variant="вариант") → notifications.<вид>[.<вариант>].title и .body.
Ключи, собранные из переменной (f"status.{x}"), проверяются по перечислениям Literal.
"""

import ast
import json
import re
import string
from collections.abc import Iterator
from pathlib import Path
from typing import Any, get_args

import pytest

from app.core.i18n import has_key
from app.db.models.admin import AUDIT_ACTIONS
from app.ingest.legacy_bank import BetStatus, CauseKind
from app.services.auth import FailureReason

APP_DIR = Path(__file__).resolve().parent.parent / "app"
LOCALE = APP_DIR / "locales" / "ru.json"
FORBIDDEN_LETTERS = ("\u0451", "\u0401")

# Литерал с таким префиксом — ключ локали, где бы он ни стоял в коде
GLOBAL_PREFIXES = ("errors.", "cli.", "notifications.", "config.", "devices.", "audit.")
# Первый аргумент этих вызовов — имя события лога, а не ключ локали
LOG_METHODS = {"debug", "info", "warning", "error", "exception", "critical"}
# Функция → префикс ключа, который она добавляет к первому аргументу
PREFIXED_CALLS = {
    "t": "",
    "_tr": "ingest.legacy.",
    "CliError": "cli.",
    "_ask_secret": "cli.",
    "ImportFailure": "ingest.legacy.errors.",
    "IngestError": "",
    "FetchError": "",
    "add_warning": "",
    # Сбой шага Claude: код — ключ errors.<код> (app/agent/errors.py)
    "ClaudeStepError": "errors.",
}
ERROR_CODE_CALLS = {"AppError", "error_response"}
# Полный ключ вторым аргументом (первый — статус HTTP): PlayerError(409, "players.errors.x")
SECOND_ARG_CALLS = {"PlayerError": ""}
ERROR_CODE = re.compile(r"^[a-z_]+\.[a-z0-9_]+$")


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    keys = [key for key, _ in pairs]
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise ValueError(f"повторяются ключи: {duplicates}")
    return dict(pairs)


def _leaves(node: dict[str, Any], prefix: str = "") -> Iterator[tuple[str, Any]]:
    for key, value in node.items():
        path = f"{prefix}{key}"
        if isinstance(value, dict):
            yield from _leaves(value, f"{path}.")
        else:
            yield path, value


def _literals(node: ast.expr | None) -> list[str]:
    """Строки, которые может дать выражение: литерал или обе ветки `a if x else b`."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return [node.value]
    if isinstance(node, ast.IfExp):
        return _literals(node.body) + _literals(node.orelse)
    return []


def _call_name(call: ast.Call) -> str | None:
    if isinstance(call.func, ast.Name):
        return call.func.id
    if isinstance(call.func, ast.Attribute):
        return call.func.attr
    return None


def _keyword(call: ast.Call, name: str) -> ast.expr | None:
    return next((kw.value for kw in call.keywords if kw.arg == name), None)


class _KeyCollector(ast.NodeVisitor):
    def __init__(self, where: str) -> None:
        self.where = where
        self.keys: list[tuple[str, str]] = []  # (ключ, файл:строка)
        self._handled: set[int] = set()  # литералы, уже разобранные по правилу вызова

    def _add(self, node: ast.expr | None, prefix: str, suffixes: tuple[str, ...] = ("",)) -> None:
        if node is None:
            return
        for nested in ast.walk(node):
            self._handled.add(id(nested))
        for value in _literals(node):
            for suffix in suffixes:
                self.keys.append((f"{prefix}{value}{suffix}", f"{self.where}:{node.lineno}"))

    def visit_Call(self, call: ast.Call) -> None:
        name = _call_name(call)
        first = call.args[0] if call.args else None
        if name in LOG_METHODS and isinstance(call.func, ast.Attribute) and first is not None:
            self._handled.add(id(first))
        if name in PREFIXED_CALLS:
            self._add(first, PREFIXED_CALLS[name])
        if name in ERROR_CODE_CALLS and len(call.args) > 1:
            self._add(call.args[1], "errors.")
        if name in SECOND_ARG_CALLS and len(call.args) > 1:
            self._add(call.args[1], SECOND_ARG_CALLS[name])
        func = call.func
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "_HTTP_CODES"
            and len(call.args) > 1
        ):
            self._add(call.args[1], "errors.")  # код по умолчанию для прочих статусов
        if name == "command" and len(call.args) > 1:
            self._add(call.args[1], "cli.help.")
        if name == "notify":
            kind = _literals(_keyword(call, "kind"))
            variant = _literals(_keyword(call, "variant"))
            for value in kind:
                base = f"notifications.{value}" + (f".{variant[0]}" if variant else "")
                for part in ("title", "body"):
                    self.keys.append((f"{base}.{part}", f"{self.where}:{call.lineno}"))
        code = _keyword(call, "code")
        if all(ERROR_CODE.match(value) for value in _literals(code)):
            self._add(code, "errors.")
        self._add(_keyword(call, "note_key"), "ingest.legacy.note.")
        self.generic_visit(call)

    def visit_Assign(self, node: ast.Assign) -> None:
        # Таблица кодов ошибок по статусу HTTP: значения — коды errors.*
        named = any(isinstance(t, ast.Name) and t.id == "_HTTP_CODES" for t in node.targets)
        if named and isinstance(node.value, ast.Dict):
            for value in node.value.values:
                self._add(value, "errors.")
        self.generic_visit(node)

    def visit_JoinedStr(self, node: ast.JoinedStr) -> None:
        # Части f-строки ("notifications.{kind}") — не ключи целиком
        for part in node.values:
            self._handled.add(id(part))
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        if id(node) in self._handled or not isinstance(node.value, str):
            return
        if node.value.startswith(GLOBAL_PREFIXES) and " " not in node.value:
            self.keys.append((node.value, f"{self.where}:{node.lineno}"))


def _code_keys() -> list[tuple[str, str]]:
    keys: list[tuple[str, str]] = []
    for path in sorted(APP_DIR.rglob("*.py")):
        collector = _KeyCollector(str(path.relative_to(APP_DIR.parent)))
        collector.visit(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
        keys += collector.keys
    return keys


def _load() -> dict[str, Any]:
    data: dict[str, Any] = json.loads(
        LOCALE.read_text(encoding="utf-8"), object_pairs_hook=_no_duplicates
    )
    return data


def test_locale_is_valid_json_without_duplicate_keys() -> None:
    _load()


def test_locale_duplicate_check_works() -> None:
    with pytest.raises(ValueError, match="повторяются"):
        json.loads('{"a": {"b": "1", "b": "2"}}', object_pairs_hook=_no_duplicates)


def test_locale_texts_are_well_formed() -> None:
    formatter = string.Formatter()
    for key, value in _leaves(_load()):
        assert isinstance(value, str) and value.strip(), key
        assert not any(letter in value for letter in FORBIDDEN_LETTERS), key
        # Параметры {name}: лишняя или незакрытая скобка уронила бы t() при подстановке
        for _, field, _, _ in formatter.parse(value):
            assert field is None or field.isidentifier(), (key, field)


def test_collector_finds_keys_of_every_kind() -> None:
    """Сам разбор работает: в коде есть ключи каждого вида."""
    found = {key for key, _ in _code_keys()}
    for expected in (
        "errors.auth.invalid_credentials",
        "errors.auth.two_factor_locked",
        "errors.common.not_found",
        "errors.common.http_error",
        "cli.email_invalid",
        "cli.role_done",
        "cli.help.create_admin",
        "ingest.legacy.report.title",
        "ingest.legacy.errors.user_not_found",
        "ingest.legacy.note.deposit",
        "notifications.new_device.title",
        "config.secret_key_required",
        "devices.unknown",
        "users.deleted",
        "players.errors.merge_same",
    ):
        assert expected in found, expected


def test_every_key_from_code_has_text() -> None:
    missing = sorted({f"{key} ({where})" for key, where in _code_keys() if not has_key(key)})
    assert missing == []


@pytest.mark.parametrize(
    ("prefix", "values"),
    [
        ("ingest.legacy.status.", get_args(BetStatus)),
        ("ingest.legacy.report.cause.", get_args(CauseKind)),
        ("audit.", tuple(AUDIT_ACTIONS)),
    ],
    ids=["bet_status", "bank_cause", "audit_action"],
)
def test_keys_built_from_values(prefix: str, values: tuple[str, ...]) -> None:
    missing = [value for value in values if not has_key(f"{prefix}{value}")]
    assert missing == []


def test_login_failure_texts_for_every_reason() -> None:
    # Пауза пары — основной текст вида, у остальных поводов свой вариант
    for reason in get_args(FailureReason):
        base = "notifications.login_failures" + ("" if reason == "pair" else f".{reason}")
        assert has_key(f"{base}.title") and has_key(f"{base}.body"), reason
