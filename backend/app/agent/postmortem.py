"""Разбор рассчитанной ставки (этап 5, В3 Р25): запрос пакета Batch, схема ответа и
проверка ответа кодом.

Модель — Sonnet 5.5 (agent_config.postmortem_model), effort low, structured outputs; без
веб-поиска: матч уже сыгран, поиск нашел бы только пересказ результата. Факты собирает
код (app/services/postmortems.py): досье до матча, вероятности, исход, признаки словаря.
Ответ проверяет код: вывод согласован с исходом (сыгравший исход — fine или lucky), тексты
не длиннее предела, условие гипотезы — только из словаря признаков
(app/ml/lesson_scope.py). Ответ не по схеме или с выводом против исхода — разбор не
принят (failed); условие не из словаря — разбор принят, гипотеза остается текстом без
урока.
"""

import json
from dataclasses import dataclass
from functools import cache
from typing import Any, Literal, cast

import anthropic
from anthropic.types import Message
from anthropic.types.messages.batch_create_params import Request
from pydantic import BaseModel, ConfigDict

from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError, parse_output, stop_error
from app.agent.prompts import POSTMORTEM_PROMPT, POSTMORTEM_REQUEST, Prompt, load_prompt
from app.ml.lesson_scope import Scope, ScopeError, validate_scope

KIND = "postmortem"
SCHEMA_VERSION = "pm1"
WHAT_MAX = 300
WHY_MAX = 300
HYPOTHESIS_MAX = 200
# Вывод разбора и с каким исходом он согласуется
WON_VERDICTS = ("fine", "lucky")
LOST_VERDICTS = ("luck", "model_error", "data_gap")
# Итог одного ответа
OK = "ok"
CHECKS = "checks"
FORMAT = "format"
REFUSAL = "refusal"
MAX_TOKENS = "max_tokens"

FeatureName = Literal[
    "market",
    "surface",
    "round",
    "best_of",
    "role",
    "elo_gap",
    "odds",
    "sets_48h",
    "opp_sets_48h",
    "rest_days",
    "h2h_matches",
    "h2h_wins",
]
OpName = Literal["in", "eq", "lt", "le", "gt", "ge"]


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PmCondition(_Model):
    feature: FeatureName
    op: OpName
    values: list[str]
    value: float | None


class PmHypothesis(_Model):
    text: str
    direction: Literal["lower", "raise"]
    conditions: list[PmCondition]


class PostmortemOut(_Model):
    """Ответ разбора: вывод, что произошло, почему, гипотеза (или null)."""

    verdict: Literal["fine", "lucky", "luck", "model_error", "data_gap"]
    what: str
    why: str
    hypothesis: PmHypothesis | None


@cache
def postmortem_schema() -> dict[str, Any]:
    return anthropic.transform_schema(PostmortemOut)


def prompt() -> Prompt:
    return load_prompt(*POSTMORTEM_PROMPT)


def custom_id(postmortem_id: int) -> str:
    """id запроса в пакете: ^[a-zA-Z0-9_-]{1,64}$."""
    return f"pm{postmortem_id}"


def postmortem_id_of(custom: str) -> int | None:
    if not custom.startswith("pm") or not custom[2:].isdigit():
        return None
    return int(custom[2:])


def facts_text(facts: dict[str, Any]) -> str:
    """Факты матча — канонический JSON (как досье в анализе)."""
    return json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def request_text(today: str) -> str:
    return load_prompt(*POSTMORTEM_REQUEST).format(today=today)


def batch_request(
    postmortem_id: int, facts: dict[str, Any], *, today: str, config: AgentConfig
) -> Request:
    """Запрос пакета: system — промпт разбора, сообщение — факты и просьба, схема ответа,
    effort из настроек. Без кэша: system короткий, запись кэша без чтений — надбавка."""
    return cast(
        Request,
        {
            "custom_id": custom_id(postmortem_id),
            "params": {
                "model": config.postmortem_model,
                "max_tokens": config.postmortem_max_tokens,
                "system": [{"type": "text", "text": prompt().text}],
                "messages": [
                    {
                        "role": "user",
                        "content": [
                            {"type": "text", "text": facts_text(facts)},
                            {"type": "text", "text": request_text(today)},
                        ],
                    }
                ],
                "output_config": {
                    "effort": config.postmortem_effort,
                    "format": {"type": "json_schema", "schema": postmortem_schema()},
                },
            },
        },
    )


@dataclass(frozen=True)
class Judged:
    """Итог ответа: outcome (OK, CHECKS, FORMAT, REFUSAL, MAX_TOKENS), метка для
    agent_runs.error, ответ с обрезанными текстами, проверенное условие гипотезы или код
    ошибки условия."""

    outcome: str
    detail: str | None
    answer: PostmortemOut | None = None
    scope: Scope | None = None
    scope_error: str | None = None


def _clean(text: str, limit: int) -> str:
    return " ".join(text.split())[:limit]


def judge(message: Message, *, won: bool) -> Judged:
    """Ответ пакета: сначала остановка, потом схема, затем проверки кода."""
    failure = stop_error(message)
    if failure is not None:
        if failure.code == "ai.refusal":
            return Judged(REFUSAL, failure.detail)
        if failure.code == "ai.max_tokens":
            return Judged(MAX_TOKENS, failure.detail)
        return Judged(FORMAT, failure.detail)
    try:
        answer = parse_output(message, PostmortemOut)
    except ClaudeStepError as exc:
        return Judged(FORMAT, exc.detail)
    allowed = WON_VERDICTS if won else LOST_VERDICTS
    if answer.verdict not in allowed:
        return Judged(CHECKS, "checks:verdict")
    what, why = _clean(answer.what, WHAT_MAX), _clean(answer.why, WHY_MAX)
    if not what or not why:
        return Judged(CHECKS, "checks:empty")
    hypothesis = answer.hypothesis
    scope: Scope | None = None
    scope_error: str | None = None
    if hypothesis is not None:
        text = _clean(hypothesis.text, HYPOTHESIS_MAX)
        if not text:
            hypothesis = None
        else:
            hypothesis = hypothesis.model_copy(update={"text": text})
            try:
                scope = validate_scope(
                    {
                        "direction": hypothesis.direction,
                        "conditions": [item.model_dump() for item in hypothesis.conditions],
                    }
                )
            except ScopeError as exc:
                scope_error = exc.code
    cleaned = answer.model_copy(update={"what": what, "why": why, "hypothesis": hypothesis})
    return Judged(OK, None, cleaned, scope, scope_error)
