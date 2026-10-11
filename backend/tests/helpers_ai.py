"""Помощники тестов ключей Claude, лимитов и бюджета (tests/test_ai_api.py,
tests/test_admin_ai_api.py): ответы проверки ключа, ключ администратора, расход и анализы."""

from datetime import timedelta
from decimal import Decimal as D

import httpx2
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import crypto
from app.db.models import AgentRun, Analysis, AppSettings
from app.services.sessions import utcnow
from tests.claude_mock import KEY, OTHER_KEY, ClaudeMock, api_error, model_info, models_list

MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5")


def key_api(claude: ClaudeMock, *, missing: tuple[str, ...] = ()) -> None:
    """Ответы проверки ключа: список моделей и каждая модель из настроек агента."""
    claude.add(httpx2.Response(200, json=models_list()))
    for model in MODELS:
        if model in missing:
            claude.add(api_error(404, "not_found_error"))
        else:
            claude.add(httpx2.Response(200, json=model_info(model)))


async def set_admin_key(db: AsyncSession, key: str = KEY) -> None:
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    row.anthropic_key_enc, row.key_version = crypto.encrypt_str(
        key, crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    )
    row.key_last4 = key[-4:]
    row.key_verified_at = utcnow()
    await db.commit()


async def spend(
    db: AsyncSession,
    user_id: int | None,
    cost: str,
    *,
    key_source: str = "admin",
    kind: str = "analysis",
    analysis_id: int | None = None,
) -> None:
    db.add(
        AgentRun(
            user_id=user_id,
            key_source=key_source,
            kind=kind,
            model="claude-opus-5-5",
            cost_usd=D(cost),
            analysis_id=analysis_id,
        )
    )
    await db.commit()


async def analysis(
    db: AsyncSession,
    user_id: int,
    *,
    status: str = "done",
    key_source: str = "admin",
    cost: str = "0",
    started_ago: timedelta = timedelta(0),
) -> Analysis:
    row = Analysis(
        user_id=user_id,
        input_text="Синнер — Руне, 1.17 / 5.10",
        status=status,
        key_source=key_source,
        started_at=utcnow() - started_ago,
        cost_usd=D(cost),
    )
    db.add(row)
    await db.commit()
    return row


def no_key_in(response: httpx2.Response) -> None:
    """Ключ целиком не уходит в ответ ни при каком исходе: только последние 4 символа."""
    for key in (KEY, OTHER_KEY):
        assert key not in response.text
        assert key[:-4] not in response.text
