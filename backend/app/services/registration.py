"""Прием одноразовых кодов от администратора: регистрация по приглашению (CAP-, 7 дней)
и сброс пароля (RST-, 24 часа). Создают и отзывают коды кабинет администратора и
команды терминала (app/services/access_codes.py).

Код ищется по HMAC-хешу. Проверка и пометка used_at — в одной транзакции с
SELECT ... FOR UPDATE: второй параллельный запрос с тем же кодом ждет первый и видит код
уже использованным. Любое несовпадение (нет кода, истек, использован, отозван, другой
email) — одна и та же ошибка, без подсказки, что именно не так.
"""

from datetime import datetime

import structlog
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import default_per_analysis
from app.core import ratelimit
from app.core.errors import AppError
from app.core.security.passwords import check_new_password, hash_password_async
from app.core.security.tokens import INVITE_PREFIX, RESET_PREFIX, hash_code
from app.db.models import AccessCode, AiLimit, User
from app.services import devices, sessions
from app.services.app_settings import get_app_settings
from app.services.auth import ClientInfo, LoginOutcome, create_pending_login, find_user_by_email

log = structlog.get_logger(__name__)


def _usable(code: AccessCode, now: datetime) -> bool:
    return code.used_at is None and code.revoked_at is None and code.expires_at > now


def _same_email(a: str | None, b: str) -> bool:
    return a is not None and a.strip().lower() == b.strip().lower()


async def _find_invite(
    db: AsyncSession, code_hash: str, email: str, *, lock: bool
) -> AccessCode | None:
    stmt = select(AccessCode).where(AccessCode.code_hash == code_hash, AccessCode.kind == "invite")
    if lock:
        # populate_existing: строка уже могла быть в сеансе после проверки без блокировки
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    invite = (await db.execute(stmt)).scalar_one_or_none()
    if invite is None or not _usable(invite, sessions.utcnow()):
        return None
    if not _same_email(invite.email, email):
        return None
    return invite


async def register(
    db: AsyncSession,
    redis: Redis,
    *,
    invite_code: str,
    email: str,
    display_name: str,
    password: str,
    accept_terms: bool,
    consent_training: bool,
    tz: str,
    client: ClientInfo,
) -> LoginOutcome:
    """Регистрация по приглашению. Роль, режим ключа и стартовый лимит — из приглашения,
    лимит по умолчанию — из app_settings. Дальше обязательна настройка 2FA."""
    wait = await ratelimit.hit_ip_limit(redis, client.ip, ratelimit.REGISTER_IP_RULE)
    if wait:
        raise AppError(429, "common.rate_limited", retry_after=wait)
    if not accept_terms:
        raise AppError(400, "auth.terms_required")
    email = email.strip()
    code_hash = hash_code(invite_code, INVITE_PREFIX)
    # Сначала код (быстро и без внешних запросов), потом пароль, потом код еще раз
    # под блокировкой: проверка пароля по базе утечек идет по сети, держать строку
    # заблокированной все это время незачем
    if await _find_invite(db, code_hash, email, lock=False) is None:
        raise AppError(400, "auth.invite_invalid")
    # Соединение с БД возвращается в пул на время HIBP и хеширования
    await db.rollback()
    await check_new_password(password)
    password_hash = await hash_password_async(password)

    invite = await _find_invite(db, code_hash, email, lock=True)
    if invite is None or await find_user_by_email(db, email) is not None:
        await db.rollback()
        raise AppError(400, "auth.invite_invalid")
    now = sessions.utcnow()
    user = User(
        # Email — из приглашения, как его ввел администратор, а не как набрал участник
        # (регистр, пробелы): в списке участников и в журнале тот же адрес, что в приглашении
        email=invite.email or email,
        display_name=display_name.strip(),
        password_hash=password_hash,
        role=invite.role or "member",
        ai_mode=invite.ai_mode or "shared",
        tz=tz,
        consent_training=consent_training,
        terms_accepted_at=now,
        created_by=invite.created_by,
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # Тот же email только что зарегистрировали по другому приглашению
        await db.rollback()
        raise AppError(400, "auth.invite_invalid") from None
    defaults = await get_app_settings(db)
    db.add(
        AiLimit(
            user_id=user.id,
            monthly_usd=(
                invite.limit_monthly_usd
                if invite.limit_monthly_usd is not None
                else defaults.default_member_limit_usd
            ),
            daily_analyses=(
                invite.limit_daily_analyses
                if invite.limit_daily_analyses is not None
                else defaults.default_daily_analyses
            ),
            per_analysis_usd=(
                invite.limit_per_analysis_usd
                if invite.limit_per_analysis_usd is not None
                else default_per_analysis(defaults)
            ),
            # Потолок своего ключа — по умолчанию программы, как в макете
            own_per_analysis_usd=default_per_analysis(defaults),
        )
    )
    invite.used_at = now
    invite.used_by = user.id
    await db.commit()
    log.info("auth.registered", user_id=user.id, invite_id=invite.id)
    token = await create_pending_login(redis, user, ip=client.ip, stage="setup")
    return LoginOutcome(status="totp_setup_required", user=user, login_token=token)


async def _find_reset(
    db: AsyncSession, code_hash: str, email: str, *, lock: bool
) -> tuple[AccessCode, User] | None:
    stmt = (
        select(AccessCode, User)
        .join(User, User.id == AccessCode.user_id)
        .where(
            AccessCode.code_hash == code_hash,
            AccessCode.kind == "password_reset",
            func.lower(User.email) == email.strip().lower(),
            User.status != "deleted",
        )
    )
    if lock:
        stmt = stmt.with_for_update(of=AccessCode).execution_options(populate_existing=True)
    row = (await db.execute(stmt)).first()
    if row is None:
        return None
    reset, user = row[0], row[1]
    if not _usable(reset, sessions.utcnow()):
        return None
    return reset, user


async def reset_password(
    db: AsyncSession,
    redis: Redis,
    *,
    email: str,
    code: str,
    new_password: str,
    client: ClientInfo,
) -> None:
    """Новый пароль по коду сброса. Все сеансы и доверенные устройства отзываются,
    2FA остается: при входе код все равно нужен."""
    wait = await ratelimit.hit_ip_limit(redis, client.ip, ratelimit.RESET_IP_RULE)
    if wait:
        raise AppError(429, "common.rate_limited", retry_after=wait)
    email = email.strip()
    code_hash = hash_code(code, RESET_PREFIX)
    if await _find_reset(db, code_hash, email, lock=False) is None:
        raise AppError(400, "auth.reset_invalid")
    # Соединение с БД возвращается в пул на время HIBP и хеширования
    await db.rollback()
    await check_new_password(new_password)
    password_hash = await hash_password_async(new_password)

    found = await _find_reset(db, code_hash, email, lock=True)
    if found is None:
        await db.rollback()
        raise AppError(400, "auth.reset_invalid")
    reset, user = found
    now = sessions.utcnow()
    user.password_hash = password_hash
    reset.used_at = now
    reset.used_by = user.id
    await sessions.revoke_user_sessions(db, user.id, now=now)
    await devices.revoke_user_devices(db, user.id, now=now)
    await db.commit()
    # Пауза после неудачных попыток с этого IP больше не нужна: пароль новый
    await ratelimit.reset_failures(redis, email, client.ip)
    log.info("auth.password_reset", user_id=user.id, code_id=reset.id)
