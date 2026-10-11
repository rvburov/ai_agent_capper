"""Промпты шагов Claude: файлы app/prompts/<имя>.v<номер>.md.

Опубликованную версию не правят: изменение — новый файл со следующим номером (README
папки). Версия промпта (version_id, например analysis.v1) пишется в agent_runs,
predictions и match_assessments; sha256 текста защищает от тихой правки опубликованного
файла (тест сверяет хеши).

Шаблоны сообщений пользователя (*_request, *_retry) подставляют значения через
str.format: фигурные скобки в них — только поля подстановки.
"""

import hashlib
import re
from dataclasses import dataclass
from functools import cache
from pathlib import Path
from typing import Any

PROMPTS_DIR = Path(__file__).resolve().parent.parent / "prompts"
_VERSION_ID = re.compile(r"^([a-z_]+)\.v([1-9][0-9]*)$")

# Версии промптов, с которыми работает код сейчас
PARSE_PROMPT = ("parse_input", 1)
NEWS_PROMPT = ("news", 1)
NEWS_REQUEST = ("news_request", 1)
NEWS_RETRY = ("news_retry", 1)
ANALYSIS_PROMPT = ("analysis", 1)
ANALYSIS_REQUEST = ("analysis_request", 1)
ANALYSIS_RETRY = ("analysis_retry", 1)


@dataclass(frozen=True)
class Prompt:
    """Текст промпта, его версия (analysis.v1) и sha256 текста."""

    name: str
    version: int
    text: str
    sha256: str

    @property
    def version_id(self) -> str:
        return f"{self.name}.v{self.version}"

    def format(self, **values: Any) -> str:
        """Шаблон с подставленными значениями (сообщения пользователя)."""
        return self.text.format(**values)


@cache
def load_prompt(name: str, version: int) -> Prompt:
    """Промпт из файла <имя>.v<номер>.md. Нет файла — FileNotFoundError."""
    path = PROMPTS_DIR / f"{name}.v{version}.md"
    text = path.read_text(encoding="utf-8").strip() + "\n"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return Prompt(name=name, version=version, text=text, sha256=digest)


def parse_version_id(version_id: str) -> tuple[str, int]:
    """analysis.v1 → ("analysis", 1). Неверная строка — ValueError."""
    match = _VERSION_ID.match(version_id)
    if match is None:
        raise ValueError(version_id)
    return match.group(1), int(match.group(2))


def load_prompt_id(version_id: str) -> Prompt:
    """Промпт по версии вида analysis.v1 (так она хранится в strategy_versions)."""
    name, version = parse_version_id(version_id)
    return load_prompt(name, version)


def published_prompts() -> dict[str, str]:
    """Все файлы промптов: версия → sha256 (для теста неизменности)."""
    found: dict[str, str] = {}
    for path in sorted(PROMPTS_DIR.glob("*.v*.md")):
        name, version = parse_version_id(path.name.removesuffix(".md"))
        found[f"{name}.v{version}"] = load_prompt(name, version).sha256
    return found
