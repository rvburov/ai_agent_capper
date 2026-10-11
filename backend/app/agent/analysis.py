"""Шаг анализа: Opus оценивает один матч по досье (три числа, факторы, флаги, пояснение).

Один вызов на матч: system — общий промпт со сжатой стратегией (точка кэша в конце,
одна на все матчи и всех участников), сообщение — досье матча и дата. Поток обязателен
(max_tokens больше 21 333), effort задается явно, инструментов и поиска нет. Ответ —
structured outputs, затем проверка кодом (check_assessment). Нашлись ошибки — тот же
разговор продолжается сообщением со списком ошибок (ответ ассистента возвращается как
есть), всего не больше analysis_max_iterations вызовов; вторая итерация читает кэш.
Ошибки после последней итерации — ai.bad_output. analysis_step_timeout_s — предел всего
шага (всех итераций), а не каждого вызова: иначе оценка одного матча шла бы до
3 × 300 с, дольше предела задачи воркера.
"""

import asyncio
import math
from collections.abc import Callable, Collection
from dataclasses import dataclass
from datetime import date
from functools import partial
from typing import Any

import anthropic
from anthropic.types import Message, MessageParam

from app.agent.calls import CallSpec, StepHooks, assistant_turn, call, estimate_tokens, stream
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError, parse_output
from app.agent.prompts import ANALYSIS_REQUEST, ANALYSIS_RETRY, Prompt, load_prompt
from app.agent.runs import Usage
from app.agent.schemas import (
    ASSESSMENT_SCHEMA_VERSION,
    MatchAssessmentOut,
    assessment_schema,
)
from app.ml.sets import PROBS3_FIELDS, Probs3

KIND = "analysis"
EXPLANATION_MAX = 300
NOTE_MAX = 300
FACTOR_TEXT_MAX = 120
FACTORS_MAX = 8
# Сравнение вероятностей без шума плавающей точки (как в strategy.apply_claude)
_DIGITS = 9


@dataclass(frozen=True)
class AssessmentOutcome:
    """Проверенная оценка, id строки agent_runs последнего вызова, usage всех вызовов и
    их число."""

    assessment: MatchAssessmentOut
    agent_run_id: int | None
    usage: Usage
    calls: int


def check_assessment(
    assessment: MatchAssessmentOut,
    *,
    p_base: Probs3,
    refs: Collection[str],
    highlight: float,
) -> list[str]:
    """Ошибки ответа, которые проверяет код (схема API их не выражает). Тексты — для
    модели: поле, число и правило."""
    problems: list[str] = []
    values = {name: float(getattr(assessment, name)) for name in PROBS3_FIELDS}
    for name, value in values.items():
        if not math.isfinite(value) or not 0.0 <= value <= 1.0:
            problems.append(f"{name} = {value} is outside 0..1")
    if problems:
        return problems
    win, cover1, cover2 = values["p1_win"], values["p1_cover"], values["p2_cover"]
    if round(cover1 - win, _DIGITS) > 0:
        problems.append(f"p1_cover ({cover1:.3f}) > p1_win ({win:.3f})")
    if round(cover2 - (1.0 - win), _DIGITS) > 0:
        problems.append(f"p2_cover ({cover2:.3f}) > 1 - p1_win ({1.0 - win:.3f})")
    divergent = [
        f"{name}: |{values[name]:.3f} - p_base {float(getattr(p_base, name)):.3f}| > {highlight}"
        for name in PROBS3_FIELDS
        if round(abs(values[name] - float(getattr(p_base, name))), _DIGITS) > highlight
    ]
    if divergent and not assessment.divergence_note.strip():
        problems.append("divergence_note is empty, but " + "; ".join(divergent))
    known = set(refs)
    for number, factor in enumerate(assessment.factors, start=1):
        if factor.ref not in known:
            problems.append(f"factors[{number}].ref '{factor.ref}' is not an id from refs")
        if len(factor.text) > FACTOR_TEXT_MAX:
            problems.append(f"factors[{number}].text: {len(factor.text)} chars > {FACTOR_TEXT_MAX}")
        if not factor.text.strip():
            problems.append(f"factors[{number}].text is empty")
    if len(assessment.factors) > FACTORS_MAX:
        problems.append(f"factors: {len(assessment.factors)} items > {FACTORS_MAX}")
    if not assessment.explanation.strip():
        problems.append("explanation is empty")
    if len(assessment.explanation) > EXPLANATION_MAX:
        problems.append(f"explanation: {len(assessment.explanation)} chars > {EXPLANATION_MAX}")
    if len(assessment.divergence_note) > NOTE_MAX:
        problems.append(f"divergence_note: {len(assessment.divergence_note)} chars > {NOTE_MAX}")
    return problems


_Read = Callable[[Message], tuple[tuple[MatchAssessmentOut, list[str]], str | None]]


def _reader(*, p_base: Probs3, refs: Collection[str], highlight: float) -> _Read:
    def read(message: Message) -> tuple[tuple[MatchAssessmentOut, list[str]], str | None]:
        assessment = parse_output(message, MatchAssessmentOut)
        problems = check_assessment(assessment, p_base=p_base, refs=refs, highlight=highlight)
        return (assessment, problems), ("checks" if problems else None)

    return read


async def assess_match(
    client: anthropic.AsyncAnthropic,
    *,
    prompt: Prompt,
    dossier_text: str,
    today: date,
    p_base: Probs3,
    refs: Collection[str],
    highlight: float,
    config: AgentConfig,
    hooks: StepHooks,
) -> AssessmentOutcome:
    """Оценка одного матча по досье. Сбой — ClaudeStepError (учет каждого вызова
    записан)."""
    request = load_prompt(*ANALYSIS_REQUEST).format(today=today.isoformat())
    system: list[Any] = [
        {"type": "text", "text": prompt.text, "cache_control": {"type": "ephemeral"}}
    ]
    output_config: Any = {
        "effort": config.analysis_effort,
        "format": {"type": "json_schema", "schema": assessment_schema()},
    }
    messages: list[MessageParam] = [
        {
            "role": "user",
            "content": [{"type": "text", "text": dossier_text}, {"type": "text", "text": request}],
        }
    ]
    read = _reader(p_base=p_base, refs=refs, highlight=highlight)
    total = Usage()
    input_tokens = estimate_tokens(prompt.text, dossier_text, request)
    loop = asyncio.get_running_loop()
    deadline = loop.time() + config.analysis_step_timeout_s
    for iteration in range(1, config.analysis_max_iterations + 1):
        left = deadline - loop.time()
        if left <= 0:
            raise ClaudeStepError("ai.timeout", detail="step_timeout")
        spec = CallSpec(
            kind=KIND,
            model=config.analysis_model,
            effort=config.analysis_effort,
            prompt_version=prompt.version_id,
            schema_version=ASSESSMENT_SCHEMA_VERSION,
            input_tokens=input_tokens,
            max_tokens=config.analysis_max_tokens,
        )
        result = await call(
            hooks,
            spec,
            partial(
                stream,
                client,
                model=config.analysis_model,
                max_tokens=config.analysis_max_tokens,
                system=system,
                messages=list(messages),
                output_config=output_config,
            ),
            timeout_s=left,
            read=read,
        )
        total = total + result.usage
        assessment, problems = result.value
        if not problems:
            return AssessmentOutcome(
                assessment=assessment,
                agent_run_id=result.agent_run_id,
                usage=total,
                calls=iteration,
            )
        if iteration == config.analysis_max_iterations:
            break
        retry = load_prompt(*ANALYSIS_RETRY).format(
            problems="\n".join(f"- {problem}" for problem in problems)
        )
        messages.append(assistant_turn(result.message))
        messages.append({"role": "user", "content": retry})
        input_tokens = (
            result.usage.prompt_tokens + result.usage.output_tokens + estimate_tokens(retry)
        )
    raise ClaudeStepError("ai.bad_output", detail="checks")
