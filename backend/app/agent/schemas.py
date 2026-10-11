"""Схемы ответов Claude (structured outputs и вход инструмента record_news).

JSON-схема для API строится из этих моделей через anthropic.transform_schema: все поля
обязательные (без значений по умолчанию), необязательное — через null. Ограничения
диапазонов и длин схема API не поддерживает, поэтому их здесь нет: диапазоны, длины и
ссылки на факты проверяет код после разбора (app/agent/analysis.py и сервисы).
В именах полей нет слов reasoning, thinking и trace: такая схема дает отказ модели.
Версия схемы (*_SCHEMA_VERSION) пишется в agent_runs и match_assessments.
"""

from functools import cache
from typing import Any, Literal

import anthropic
from pydantic import BaseModel, ConfigDict

PARSE_SCHEMA_VERSION = "p1"
NEWS_SCHEMA_VERSION = "n1"
ASSESSMENT_SCHEMA_VERSION = "a1"

Currency = Literal["RUB", "USD", "EUR"]
ParsedSurface = Literal["hard", "clay", "grass"]
NewsKind = Literal["injury", "withdrawal", "motivation", "result", "other"]
Flag = Literal["injury", "fatigue", "form", "motivation"]
Confidence = Literal["low", "medium", "high"]


class _Model(BaseModel):
    # Лишние поля в ответе — ошибка схемы: значит, модель отвечала не по ней
    model_config = ConfigDict(extra="forbid")


# --- разбор ввода (p1) ---


class ParsedBank(_Model):
    amount: float | None
    currency: Currency | None


class ParsedName(_Model):
    raw: str
    latin: str | None


class ParsedOdds(_Model):
    ml1: float | None
    ml2: float | None
    h1_minus: float | None
    h1_plus: float | None
    h2_minus: float | None
    h2_plus: float | None


class ParsedEvent(_Model):
    line_no: int
    player1: ParsedName
    player2: ParsedName
    tournament: str | None
    surface: ParsedSurface | None
    round: str | None
    odds: ParsedOdds
    bookmaker: str | None


class UnknownLine(_Model):
    line_no: int
    text: str


class ParsedInput(_Model):
    """Ответ шага разбора: банк, букмекер, события и непонятые строки."""

    bank: ParsedBank
    bookmaker: str | None
    events: list[ParsedEvent]
    unknown_lines: list[UnknownLine]


# --- новости (n1, вход инструмента record_news) ---


class NewsResultDetails(_Model):
    opponent: str
    score: str
    tournament: str
    date: str
    won: bool


class NewsItem(_Model):
    kind: NewsKind
    summary: str
    published_at: str
    source_url: str
    source_name: str
    result: NewsResultDetails | None


class NewsPlayer(_Model):
    player: Literal[1, 2]
    items: list[NewsItem]


class NewsReport(_Model):
    """Вход record_news: факты по каждому игроку."""

    players: list[NewsPlayer]


# --- оценка матча (a1) ---


class Factor(_Model):
    player: Literal[1, 2]
    effect: Literal["plus", "minus"]
    text: str
    ref: str


class Flags(_Model):
    p1: list[Flag]
    p2: list[Flag]


class MatchAssessmentOut(_Model):
    """Ответ шага анализа по одному матчу."""

    p1_win: float
    p1_cover: float
    p2_cover: float
    confidence: Confidence
    factors: list[Factor]
    flags: Flags
    explanation: str
    divergence_note: str


@cache
def parse_schema() -> dict[str, Any]:
    return anthropic.transform_schema(ParsedInput)


@cache
def news_schema() -> dict[str, Any]:
    return anthropic.transform_schema(NewsReport)


@cache
def assessment_schema() -> dict[str, Any]:
    return anthropic.transform_schema(MatchAssessmentOut)
