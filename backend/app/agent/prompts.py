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
PARSE_PROMPT = ("parse_input", 2)
NEWS_PROMPT = ("news", 2)
NEWS_REQUEST = ("news_request", 2)
NEWS_RETRY = ("news_retry", 1)
ANALYSIS_PROMPT = ("analysis", 1)
ANALYSIS_REQUEST = ("analysis_request", 1)
ANALYSIS_RETRY = ("analysis_retry", 1)
# Этап 5: разбор ставки (Batch) и блок уроков в system анализа (быстрая проверка урока)
POSTMORTEM_PROMPT = ("postmortem", 1)
POSTMORTEM_REQUEST = ("postmortem_request", 1)
# Блок уроков v2 (m7 волны 3): строка числового урока — условие из словаря и направление,
# собранные кодом, без свободного текста; v1 (код и текст урока) — строка процессного
# урока (его пишет только администратор)
LESSONS_BLOCK = ("lessons_block", 2)
LESSON_LINE = ("lesson_line", 2)
LESSON_LINE_TEXT = ("lesson_line", 1)
LESSON_SHIFT = ("lesson_shift", 1)


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


# --- system анализа: промпт версии и блок уроков (этап 5, волна 3) ---

# Разделитель составной версии: analysis.v1+lessons_block.v2:<sha12 блока уроков>
LESSONS_JOINER = "+"
LESSONS_HASH_CHARS = 12


@dataclass(frozen=True)
class SystemPrompt:
    """System анализа: промпт версии инструкций (base) и блок уроков (lessons — текст
    блока, codes — коды уроков в нем). Блок — отдельный блок system со своей точкой кэша:
    промпт без уроков общий у всех версий, его кэш не сбрасывается при смене уроков.
    version_id — составная версия (Т6): у разных наборов уроков разные ключи повтора
    оценки и кэша. text — весь system одним текстом (оценка токенов)."""

    base: Prompt
    lessons: str | None = None
    codes: tuple[str, ...] = ()

    @property
    def version_id(self) -> str:
        return compose_version_id(self.base.version_id, self.lessons)

    @property
    def text(self) -> str:
        if not self.lessons:
            return self.base.text
        return f"{self.base.text}\n{self.lessons.strip()}\n"


def compose_version_id(base_version_id: str, lessons: str | None) -> str:
    """analysis.v1 без уроков; с уроками — analysis.v1+lessons_block.v2:<sha12 блока>
    (до 64 символов, как колонки prompt_version)."""
    if not lessons:
        return base_version_id
    block = load_prompt(*LESSONS_BLOCK).version_id
    digest = hashlib.sha256(lessons.strip().encode("utf-8")).hexdigest()[:LESSONS_HASH_CHARS]
    return f"{base_version_id}{LESSONS_JOINER}{block}:{digest}"[:64]


def base_version_id(version_id: str) -> str:
    """Версия промпта без блока уроков: analysis.v1+lessons_block.v2:… → analysis.v1."""
    return version_id.split(LESSONS_JOINER, 1)[0]


def system_blocks(prompt: Prompt | SystemPrompt, *, ttl: str | None = None) -> list[Any]:
    """Блоки system с точками кэша: промпт и (если есть) блок уроков — каждый своей
    точкой. ttl — «1h» для пакетов Batch (запросы идут параллельно и дольше 5 минут)."""
    cache: dict[str, str] = {"type": "ephemeral"}
    if ttl is not None:
        cache["ttl"] = ttl
    if isinstance(prompt, Prompt):
        return [{"type": "text", "text": prompt.text, "cache_control": dict(cache)}]
    blocks: list[Any] = [{"type": "text", "text": prompt.base.text, "cache_control": dict(cache)}]
    if prompt.lessons:
        blocks.append(
            {"type": "text", "text": prompt.lessons.strip() + "\n", "cache_control": dict(cache)}
        )
    return blocks
