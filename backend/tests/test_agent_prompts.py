"""Промпты и схемы ответов Claude (app/prompts, app/agent/prompts.py, schemas.py):
опубликованные версии не меняются, в промптах и схемах нет слов, на которые модель
отвечает отказом, у каждого ключа текста анализа есть строка в ru.json."""

import ast
import json
import re
from pathlib import Path
from typing import Any

import pytest

from app.agent.postmortem import postmortem_schema
from app.agent.prompts import (
    ANALYSIS_PROMPT,
    ANALYSIS_REQUEST,
    ANALYSIS_RETRY,
    LESSON_LINE,
    LESSON_LINE_TEXT,
    LESSON_SHIFT,
    LESSONS_BLOCK,
    NEWS_PROMPT,
    NEWS_REQUEST,
    NEWS_RETRY,
    PARSE_PROMPT,
    POSTMORTEM_PROMPT,
    POSTMORTEM_REQUEST,
    PROMPTS_DIR,
    load_prompt,
    load_prompt_id,
    parse_version_id,
    published_prompts,
)
from app.agent.schemas import assessment_schema, news_schema, parse_schema
from app.core.i18n import has_key
from app.services.analysis_result import RULE_KEYS

# Опубликованные версии: правка файла — новая версия, а не новый хеш здесь
PUBLISHED = {
    "analysis.v1": "dd9fa05229a5070d989e231790a72a7e725c048687a2c7f13e0501c311e5c37b",
    "analysis_request.v1": "aea6172f99724b88238e87b82074382b2cf65cbbb5d829d29a647c9109a82621",
    "analysis_retry.v1": "8504ae95151ae604a206e2b765cfcbf2ee968b6df795f4c8ab01b3290e6eee9c",
    "lesson_line.v1": "e2731e441533367e46f5240c5fba040978a53585008f2cf96569b356d5ed14ce",
    "lesson_line.v2": "4a3e712791a6d03eb1677d2e70b923611d42423e8e929a582400fb448a0ba5e6",
    "lesson_shift.v1": "51397f058c92e91f6c0833d775a4c45ac3b78549cc5ac28a2398a1295b2a5811",
    "lessons_block.v1": "ed8d75ae5ac8d547a1fcab7d4496b4fb72e2de7e822872b4d36c6df34ec7d66b",
    "lessons_block.v2": "a42f9c38ef0a24c55d782d825aaa87c264287399c4ea2fd8fe306d2d4aab2f03",
    "news.v1": "2993309576d631053ddce2a95cda6e162923f268ad1eb97177e8238a03268915",
    "news.v2": "0d7766c72ee82a1c2fa71e396ffcf005c5fb3c23b36a5077da847a426eb10b21",
    "news_request.v1": "c086524b071306191ca0e7503e6ce73553169d7d82b6b8fcba9469a71e9e97af",
    "news_request.v2": "4ec0f4d796e31bb8faf017e83edc173509a786c92ab182f3691fb5d70dceb026",
    "news_retry.v1": "a3f33a19f390523250626ff698135b6f1ec015123678052f7ae4d5b447917f4f",
    "parse_input.v1": "7bbb18f5a817f99878923cde98a05014850f9f6597f919ce2aa71a66f710c5bb",
    "parse_input.v2": "062d36ea1f6cc3a93d343a1a8c552f45a7017f9280b1aae9d67b1bc042bf07d7",
    "postmortem.v1": "5c693bfaac5850f257dbf97c3d11030553396c2a3dc3abfb4ce28ddb084d1fcf",
    "postmortem_request.v1": "f1b04fcf1b18bbfd8f643a00b6a48f960a072b6c4038b73c878f476df844c184",
}
# Слова, на которые модель отвечает отказом reasoning_extraction (он оплачивается)
FORBIDDEN_WORDS = re.compile(r"reasoning|thinking|trace|по шагам|пошагов", re.IGNORECASE)
FORBIDDEN_LETTERS = ("\u0451", "\u0401")
APP_DIR = Path(__file__).resolve().parent.parent / "app"
TEXT_MODULES = (
    "services/analysis_view.py",
    "services/analysis_run.py",
    "services/analysis_result.py",
    "services/analyses.py",
    "services/bets.py",
)


def test_published_prompts_did_not_change() -> None:
    assert published_prompts() == PUBLISHED


def test_prompts_used_by_code_exist() -> None:
    for name, version in (
        PARSE_PROMPT,
        NEWS_PROMPT,
        NEWS_REQUEST,
        NEWS_RETRY,
        ANALYSIS_PROMPT,
        ANALYSIS_REQUEST,
        ANALYSIS_RETRY,
        POSTMORTEM_PROMPT,
        POSTMORTEM_REQUEST,
        LESSONS_BLOCK,
        LESSON_LINE,
        LESSON_SHIFT,
    ):
        prompt = load_prompt(name, version)
        assert prompt.text.strip() and prompt.version_id == f"{name}.v{version}"
    assert load_prompt_id("analysis.v1").version_id == "analysis.v1"
    with pytest.raises(ValueError):
        parse_version_id("analysis")


@pytest.mark.parametrize("path", sorted(PROMPTS_DIR.glob("*.v*.md")), ids=lambda p: p.name)
def test_prompt_texts_are_clean(path: Path) -> None:
    text = path.read_text(encoding="utf-8")
    assert not FORBIDDEN_WORDS.search(text)
    assert not any(letter in text for letter in FORBIDDEN_LETTERS)


def test_templates_take_their_fields() -> None:
    news = load_prompt(*NEWS_REQUEST).format(
        today="2026-10-11", since="2026-09-27", days=14, match="A vs B", players="2. B", max_uses=2
    )
    assert "2026-10-11" in news and "2. B" in news and "не больше 2 " in news
    assert "2026-10-11" in load_prompt(*ANALYSIS_REQUEST).format(today="2026-10-11")
    assert "- x" in load_prompt(*ANALYSIS_RETRY).format(problems="- x")
    assert "2026-10-11" in load_prompt(*POSTMORTEM_REQUEST).format(today="2026-10-11")
    block = load_prompt(*LESSONS_BLOCK).format(lessons="- L-001: x")
    assert block.rstrip().endswith("- L-001: x")
    line = load_prompt(*LESSON_LINE).format(
        code="L-001", condition="role = favorite", direction="lower"
    )
    assert line.strip() == "- L-001: role = favorite; направление lower."
    assert load_prompt(*LESSON_LINE_TEXT).format(code="L-001", text="x").strip() == "- L-001: x"
    assert "+1,5" in load_prompt(*LESSON_SHIFT).format(shift="+1,5")


def _properties(node: Any) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    if isinstance(node, dict):
        if node.get("type") == "object":
            found.append(node)
        for value in node.values():
            found += _properties(value)
    elif isinstance(node, list):
        for item in node:
            found += _properties(item)
    return found


@pytest.mark.parametrize(
    "schema", [parse_schema, news_schema, assessment_schema, postmortem_schema]
)
def test_schemas_are_strict_and_clean(schema: Any) -> None:
    data = schema()
    assert not FORBIDDEN_WORDS.search(json.dumps(data))
    for node in _properties(data):
        assert node["additionalProperties"] is False
        assert sorted(node.get("required", [])) == sorted(node["properties"])


def _keys_in(module: str) -> set[str]:
    tree = ast.parse((APP_DIR / module).read_text(encoding="utf-8"))
    pattern = re.compile(r"(analysis|bets)\.[a-z_]+\.[a-z_0-9]+|bets\.[a-z_]+")
    return {
        node.value
        for node in ast.walk(tree)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, str)
        and pattern.fullmatch(node.value)
    }


def test_every_text_key_of_analysis_has_text() -> None:
    keys: set[str] = set()
    for module in TEXT_MODULES:
        keys |= _keys_in(module)
    keys |= {f"analysis.rules.{key}" for key in RULE_KEYS}
    issues = ("form", "injury", "fatigue", "market", "market_suspended", "p_low", "cover_p_low")
    keys |= {
        f"analysis.leg.{key}"
        for key in (*issues, "odds_low", "odds_high", "no_value", "drawdown_odds")
    }
    reasons = ("no_legs", "no_bank", "currency", "total_range", "below_min")
    keys |= {f"analysis.stake.{key}" for key in reasons}
    compare = ("elo_rank", "elo_surface", "form10", "load14", "serve_first", "serve_second")
    keys |= {f"analysis.compare.{key}" for key in (*compare, "return", "tiebreaks", "h2h")}
    assert len(keys) > 60
    missing = sorted(key for key in keys if not has_key(key))
    assert missing == []


def test_every_error_code_of_analysis_has_text() -> None:
    codes: set[str] = set()
    for module in (*TEXT_MODULES, "services/analysis_input.py"):
        tree = ast.parse((APP_DIR / module).read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "Problem":
                first = node.args[0]
                if isinstance(first, ast.Constant) and isinstance(first.value, str):
                    codes.add(first.value)
    assert {"analysis.no_events", "analysis.odds_range", "analysis.same_players"} <= codes
    missing = sorted(code for code in codes if not has_key(f"errors.{code}"))
    assert missing == []
