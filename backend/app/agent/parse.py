"""Шаг разбора ввода: Haiku превращает текст участника в события по схеме ParsedInput.

Без инструментов и без кэша (вызовы редкие: запись кэша без чтений — только надбавка).
Ответ — structured outputs (output_config.format) с проверкой Pydantic; диапазоны кэфов,
поиск игроков и турниров — дело кода (app/services/analysis_input.py).
"""

from functools import partial

import anthropic

from app.agent.calls import CallSpec, StepHooks, call, create, estimate_tokens
from app.agent.config import AgentConfig
from app.agent.errors import parse_output
from app.agent.prompts import PARSE_PROMPT, load_prompt
from app.agent.schemas import PARSE_SCHEMA_VERSION, ParsedInput, parse_schema

KIND = "parse"


async def parse_text(
    client: anthropic.AsyncAnthropic, text: str, config: AgentConfig, hooks: StepHooks
) -> ParsedInput:
    """Разбор текста участника. Сбой — ClaudeStepError (учет записан)."""
    prompt = load_prompt(*PARSE_PROMPT)
    spec = CallSpec(
        kind=KIND,
        model=config.parse_model,
        effort=config.parse_effort,
        prompt_version=prompt.version_id,
        schema_version=PARSE_SCHEMA_VERSION,
        input_tokens=estimate_tokens(prompt.text, text),
        max_tokens=config.parse_max_tokens,
    )
    result = await call(
        hooks,
        spec,
        partial(
            create,
            client,
            model=config.parse_model,
            max_tokens=config.parse_max_tokens,
            system=[{"type": "text", "text": prompt.text}],
            messages=[{"role": "user", "content": text}],
            output_config={
                "effort": config.parse_effort,
                "format": {"type": "json_schema", "schema": parse_schema()},
            },
        ),
        timeout_s=config.parse_timeout_s,
        read=lambda message: (parse_output(message, ParsedInput), None),
    )
    return result.value
