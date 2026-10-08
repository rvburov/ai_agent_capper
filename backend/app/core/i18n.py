"""Тексты сервера для людей: ошибки, уведомления, журнал, команды терминала.

Тексты лежат в app/locales/<язык>.json, в коде — только ключ: t("errors.auth.blocked").
Английский добавляется файлом en.json без правки кода (решение Р18).
Параметры подставляются по именам: "Осталось {n}" → t(key, n=3).
"""

import json
from functools import cache
from pathlib import Path
from typing import Any

DEFAULT_LANG = "ru"
_LOCALES_DIR = Path(__file__).resolve().parent.parent / "locales"


class _KeepMissing(dict[str, Any]):
    """Неизвестный параметр остается в тексте как есть, а не роняет запрос."""

    def __missing__(self, key: str) -> str:
        return "{" + key + "}"


@cache
def _load(lang: str) -> dict[str, Any]:
    path = _LOCALES_DIR / f"{lang}.json"
    if not path.is_file():
        return {}
    data: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    return data


def _lookup(tree: dict[str, Any], key: str) -> str | None:
    node: Any = tree
    for part in key.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node if isinstance(node, str) else None


def has_key(key: str, lang: str = DEFAULT_LANG) -> bool:
    return _lookup(_load(lang), key) is not None


def t(key: str, /, lang: str = DEFAULT_LANG, **params: Any) -> str:
    """Текст по ключу. Нет перевода на язык — берется русский, нет и его — сам ключ."""
    text = _lookup(_load(lang), key)
    if text is None and lang != DEFAULT_LANG:
        text = _lookup(_load(DEFAULT_LANG), key)
    if text is None:
        return key
    if not params:
        return text
    return text.format_map(_KeepMissing(params))
