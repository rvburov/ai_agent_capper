"""Ключи Claude API: формат, проверка бесплатными запросами и расшифровка перед вызовом.

Проверка — models.list(limit=1) (ключ рабочий) и models.retrieve для моделей из настроек
агента (модель доступна организации ключа; 404 — нет). Токенов эти запросы не тратят.
Нулевой баланс и лимит трат так не видны: они выяснятся на первом настоящем вызове.

Ключ администратора — app_settings.anthropic_key_enc (aad app_settings.anthropic_key:1),
свой ключ участника — user_secrets (aad user_secrets.anthropic_key:<user_id>). Ключ
расшифровывается прямо перед вызовом Claude, в аргументы задач, логи и ответы API не
попадает. Записи, зашифрованные старым мастер-ключом, перешифровываются при чтении.
"""

import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.client import BASE_URL, client_for
from app.agent.errors import NO_KEY, ClaudeStepError
from app.core.security import crypto
from app.db.models import Analysis, AppSettings, UserSecret
from app.db.models.ai import KEY_SOURCES
from app.services.app_settings import SETTINGS_ROW_ID

_KEY_FORMAT = re.compile(r"^sk-ant-[A-Za-z0-9_-]{16,}$")
CHECK_TIMEOUT_SECONDS = 15.0
SECRET_KIND = "anthropic_key"


def looks_like_key(key: str) -> bool:
    """Ключ Claude API начинается с sk-ant- и длиннее 20 символов."""
    return bool(_KEY_FORMAT.match(key))


@dataclass(frozen=True)
class KeyCheck:
    """Итог проверки: ok, rejected (401/403), unavailable (сеть) или error (иной ответ).
    models — доступность моделей (имя, доступна ли), если их проверяли."""

    result: Literal["ok", "rejected", "unavailable", "error"]
    status_code: int | None = None
    models: tuple[tuple[str, bool], ...] = ()

    @property
    def missing_models(self) -> tuple[str, ...]:
        return tuple(name for name, ok in self.models if not ok)


def _check_client(
    key: str, http_client: anthropic.DefaultAsyncHttpxClient | None
) -> anthropic.AsyncAnthropic:
    if http_client is None:
        return client_for(key, timeout=CHECK_TIMEOUT_SECONDS).with_options(max_retries=1)
    return anthropic.AsyncAnthropic(
        api_key=key,
        base_url=BASE_URL,
        max_retries=1,
        timeout=CHECK_TIMEOUT_SECONDS,
        http_client=http_client,
    )


async def check_anthropic_key(
    key: str,
    *,
    models: Sequence[str] = (),
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> KeyCheck:
    """Проверяет ключ запросом models.list(limit=1), затем доступ к каждой модели из
    models (models.retrieve). http_client — для тестов; без него — общий клиент."""
    client = _check_client(key, http_client)
    try:
        await client.models.list(limit=1)
        available: list[tuple[str, bool]] = []
        for model in models:
            try:
                await client.models.retrieve(model)
            except anthropic.NotFoundError:
                available.append((model, False))
            else:
                available.append((model, True))
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as exc:
        return KeyCheck("rejected", exc.status_code)
    except anthropic.APIStatusError as exc:
        return KeyCheck("error", exc.status_code)
    except anthropic.APIConnectionError:
        return KeyCheck("unavailable")
    finally:
        if http_client is not None:
            await client.close()
    return KeyCheck("ok", models=tuple(available))


# --- расшифровка перед вызовом ---


async def _admin_key(db: AsyncSession) -> str:
    row = await db.scalar(select(AppSettings).where(AppSettings.id == SETTINGS_ROW_ID))
    if row is None or row.anthropic_key_enc is None or row.key_version is None:
        raise ClaudeStepError(NO_KEY, detail="no_admin_key")
    aad = crypto.aad_for(crypto.AAD_ADMIN_KEY, SETTINGS_ROW_ID)
    try:
        key = crypto.decrypt_str(row.anthropic_key_enc, row.key_version, aad)
    except crypto.CryptoError:
        raise ClaudeStepError(NO_KEY, detail="admin_key_decrypt") from None
    if crypto.needs_reencrypt(row.key_version):
        row.anthropic_key_enc, row.key_version = crypto.encrypt_str(key, aad)
        await db.flush()
    return key


async def _own_key(db: AsyncSession, user_id: int) -> str:
    secret = await db.scalar(
        select(UserSecret).where(UserSecret.user_id == user_id, UserSecret.kind == SECRET_KIND)
    )
    if secret is None:
        raise ClaudeStepError(NO_KEY, detail="no_own_key")
    aad = crypto.aad_for(crypto.AAD_USER_SECRET, user_id)
    try:
        key = crypto.decrypt_str(secret.ciphertext, secret.key_version, aad)
    except crypto.CryptoError:
        raise ClaudeStepError(NO_KEY, detail="own_key_decrypt") from None
    if crypto.needs_reencrypt(secret.key_version):
        secret.ciphertext, secret.key_version = crypto.encrypt_str(key, aad)
        await db.flush()
    return key


async def key_for(db: AsyncSession, *, key_source: str | None, user_id: int) -> str:
    """Ключ для вызова: admin — ключ администратора, own — свой ключ участника user_id.
    Нет ключа или он не расшифровывается — ClaudeStepError ai.no_key. Если ключ
    перешифрован новым мастер-ключом, нужен commit вызывающего (до вызова Claude)."""
    if key_source not in KEY_SOURCES:
        raise ClaudeStepError(NO_KEY, detail="no_key_source")
    if key_source == "admin":
        return await _admin_key(db)
    return await _own_key(db, user_id)


async def key_for_run(db: AsyncSession, analysis: Analysis) -> str:
    """Ключ для вызова в анализе: по analysis.key_source, зафиксированному при запуске."""
    return await key_for(db, key_source=analysis.key_source, user_id=analysis.user_id)
