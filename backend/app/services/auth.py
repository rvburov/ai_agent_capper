"""Вход: пароль → код 2FA или резервный код → сеанс; настройка 2FA; выход.

Незавершенный вход между шагами живет в Redis под ключом login:pending:<sha256 токена>
login_pending_minutes (5 минут); сам токен — в cookie login. В состоянии: user_id, IP,
этап (totp — ждем код, setup — нужно настроить 2FA), отпечаток хеша пароля и на этапе
setup — новый секрет 2FA, зашифрованный AES-GCM. Отпечаток нужен, чтобы смена или сброс
пароля обрывали незавершенный вход, начатый со старым паролем.

Защита от подбора — app.core.ratelimit (порядок вызовов описан там). Каждая попытка
пишется в login_events. Сервис возвращает токены для cookie в LoginOutcome, ставит
cookie маршрут.
"""

import base64
import hashlib
import json
from dataclasses import asdict, dataclass, field
from typing import Any, Literal, NoReturn, cast

import structlog
from redis.asyncio import Redis
from redis.exceptions import WatchError
from sqlalchemy import delete, exists, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import ratelimit
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.i18n import t
from app.core.redis import redis_key
from app.core.security import crypto
from app.core.security.passwords import (
    hash_password_async,
    needs_rehash,
    verify_dummy_async,
    verify_password_async,
)
from app.core.security.tokens import gen_recovery_codes, hash_code, hash_token, new_token
from app.core.security.totp import new_totp_secret, qr_svg, totp_uri, verify_totp
from app.core.useragent import clip_user_agent, device_label
from app.db.models import LoginEvent, RecoveryCode, User
from app.services import devices, sessions
from app.services.notifications import notify
from app.services.two_factor import consume_recovery_code, consume_totp_step

log = structlog.get_logger(__name__)

LoginStatus = Literal["ok", "totp_required", "totp_setup_required"]
Stage = Literal["totp", "setup"]
CodeMethod = Literal["totp", "recovery"]
# Повод уведомления login_failures: пауза пары (email, IP), закрытый шаг 2FA аккаунта,
# неверные коды при перевыпуске резервных кодов в личном кабинете
FailureReason = Literal["pair", "two_factor", "recovery_codes"]
SECURITY_LINK = "/profile/security"


@dataclass(frozen=True)
class ClientInfo:
    """Откуда пришел запрос: IP (полный адрес) и User-Agent."""

    ip: str
    user_agent: str | None


@dataclass
class LoginOutcome:
    """Итог шага входа. Токены — значения cookie, которые маршрут ставит браузеру."""

    status: LoginStatus
    user: User
    session_token: str | None = None
    login_token: str | None = None
    device_token: str | None = None
    recovery_codes: list[str] = field(default_factory=list)


@dataclass(frozen=True)
class TotpSetup:
    secret: str
    otpauth_uri: str
    qr_svg: str


@dataclass
class PendingLogin:
    """Незавершенный вход в Redis (между паролем и кодом 2FA)."""

    user_id: int
    ip: str
    stage: Stage
    pw: str
    setup_secret_enc: str | None = None
    setup_key_version: int | None = None


# --- пользователи и журнал входов ---


async def find_user_by_email(db: AsyncSession, email: str) -> User | None:
    """Пользователь по email без учета регистра (уникальный индекс по lower(email))."""
    normalized = email.strip().lower()
    if not normalized:
        return None
    return (
        await db.execute(select(User).where(func.lower(User.email) == normalized))
    ).scalar_one_or_none()


async def record_login_event(
    db: AsyncSession,
    *,
    user_id: int | None,
    client: ClientInfo,
    result: str,
    method: str,
) -> None:
    db.add(
        LoginEvent(
            user_id=user_id,
            ip=client.ip,
            user_agent=clip_user_agent(client.user_agent),
            result=result,
            method=method,
        )
    )
    await db.flush()


async def _is_new_device(db: AsyncSession, user: User, user_agent: str | None) -> bool:
    """Не было ли у пользователя успешного входа с таким User-Agent. Самый первый вход
    (сразу после регистрации) новым устройством не считается: уведомление было бы шумом.
    Первый вход определяется по users.last_login_at (вызывать до его записи), а не по
    журналу: журнал старше 90 дней удаляет воркер, и вход после долгого перерыва
    выглядел бы первым."""
    if user.last_login_at is None:
        return False
    ua = clip_user_agent(user_agent)
    same_agent = select(LoginEvent.id).where(
        LoginEvent.user_id == user.id,
        LoginEvent.result == "ok",
        LoginEvent.user_agent == ua if ua is not None else LoginEvent.user_agent.is_(None),
    )
    return not (await db.execute(select(exists(same_agent)))).scalar()


# --- незавершенный вход в Redis ---


def _pending_key(token: str) -> str:
    return redis_key("login", "pending", hash_token(token))


def password_fingerprint(user: User) -> str:
    """Короткий отпечаток хеша пароля: меняется при каждой смене и сбросе пароля."""
    return hashlib.sha256((user.password_hash or "").encode()).hexdigest()[:16]


async def create_pending_login(
    redis: Redis, user: User, *, ip: str, stage: Stage, replace_token: str | None = None
) -> str:
    """Начинает незавершенный вход и возвращает токен для cookie login."""
    if replace_token:
        await redis.delete(_pending_key(replace_token))
    token = new_token()
    state = PendingLogin(user_id=user.id, ip=ip, stage=stage, pw=password_fingerprint(user))
    ttl = get_settings().login_pending_minutes * 60
    await redis.set(_pending_key(token), json.dumps(asdict(state)), ex=ttl)
    return token


def _parse_pending(raw: str | bytes | None) -> PendingLogin | None:
    if raw is None:
        return None
    try:
        data = json.loads(raw)
        return PendingLogin(**data)
    except (TypeError, ValueError):
        return None


async def _load_pending(redis: Redis, token: str | None) -> tuple[str, PendingLogin]:
    """Токен из cookie login и состояние незавершенного входа, иначе 401 login_expired."""
    if not token:
        raise AppError(401, "auth.login_expired")
    pending = _parse_pending(await redis.get(_pending_key(token)))
    if pending is None:
        raise AppError(401, "auth.login_expired")
    return token, pending


async def drop_pending_login(redis: Redis, token: str | None) -> None:
    if token:
        await redis.delete(_pending_key(token))


async def _pending_user(
    db: AsyncSession,
    redis: Redis,
    *,
    token: str,
    pending: PendingLogin,
    stage: Stage,
    client: ClientInfo,
    method: str,
) -> User:
    """Пользователь незавершенного входа, если вход еще годен для этого этапа."""
    if pending.stage != stage:
        raise AppError(401, "auth.login_expired")
    user = await db.get(User, pending.user_id)
    valid = (
        user is not None
        and user.status != "deleted"
        and pending.pw == password_fingerprint(user)
        # 2FA сбросили или, наоборот, уже настроили в другом окне
        and user.totp_enabled == (stage == "totp")
    )
    if not valid or user is None:
        await drop_pending_login(redis, token)
        raise AppError(401, "auth.login_expired")
    if user.status == "blocked":
        await drop_pending_login(redis, token)
        await record_login_event(
            db, user_id=user.id, client=client, result="blocked", method=method
        )
        await db.commit()
        raise AppError(403, "auth.blocked")
    return user


# --- лимиты попыток ---


async def _reject_rate_limited(
    db: AsyncSession,
    *,
    user_id: int | None,
    client: ClientInfo,
    method: str,
    retry_after: int,
    code: str = "auth.rate_limited",
) -> NoReturn:
    await record_login_event(
        db, user_id=user_id, client=client, result="rate_limited", method=method
    )
    await db.commit()
    raise AppError(429, code, retry_after=retry_after)


@dataclass(frozen=True)
class _CodeAttempts:
    pair: ratelimit.Attempt
    account: ratelimit.Attempt


async def _begin_code_attempt(
    db: AsyncSession,
    redis: Redis,
    *,
    user: User,
    client: ClientInfo,
    method: str,
    login_token: str,
) -> _CodeAttempts:
    """Резервирует попытку кода 2FA: общий лимит IP, пара (email, IP), счетчик 2FA аккаунта."""
    wait = await ratelimit.hit_ip_limit(redis, client.ip, ratelimit.LOGIN_IP_RULE)
    if wait:
        await _reject_rate_limited(
            db, user_id=user.id, client=client, method=method, retry_after=wait
        )
    pair = await ratelimit.begin_attempt(redis, user.email, client.ip)
    if pair.retry_after:
        await _reject_rate_limited(
            db, user_id=user.id, client=client, method=method, retry_after=pair.retry_after
        )
    account = await ratelimit.begin_2fa_attempt(redis, user.email)
    if account.retry_after:
        # Код не проверялся: попытка пары не считается неудачей
        await ratelimit.release_attempt(redis, user.email, client.ip)
        await drop_pending_login(redis, login_token)
        await _reject_rate_limited(
            db,
            user_id=user.id,
            client=client,
            method=method,
            retry_after=account.retry_after,
            code="auth.two_factor_locked",
        )
    return _CodeAttempts(pair=pair, account=account)


async def notify_failures(
    db: AsyncSession, user: User, *, reason: FailureReason, **params: str | int
) -> None:
    """Уведомление login_failures владельцу аккаунта. Пауза пары — основной текст вида
    (notifications.login_failures.title/body), у других поводов свой текст:
    notifications.login_failures.<reason>."""
    variant = None if reason == "pair" else reason
    await notify(
        db,
        user_id=user.id,
        kind="login_failures",
        variant=variant,
        link=SECURITY_LINK,
        reason=reason,
        **params,
    )


async def notify_pair_lock(db: AsyncSession, redis: Redis, user: User, ip: str) -> None:
    """Пара (email, IP) закрыта после 5 неудач подряд: неверные пароли при входе или
    при смене пароля, неверные коды 2FA. Не чаще раза в 15 минут."""
    if await ratelimit.allow_failure_notice(redis, user.id):
        await notify_failures(
            db,
            user,
            reason="pair",
            ip=ip,
            count=ratelimit.MAX_FAILURES,
            minutes=ratelimit.LOCK_SECONDS // 60,
        )


async def notify_two_factor_lock(db: AsyncSession, redis: Redis, user: User, ip: str) -> None:
    """Шаг 2FA аккаунта закрыт после 10 неверных кодов за час. Отправляется, даже если
    недавно было уведомление о паузе пары: без него владелец не поймет, почему не может
    войти. Чаще раза в час не бывает, потому что пауза длится час."""
    await ratelimit.allow_failure_notice(redis, user.id)  # следующая пауза пары — без уведомления
    rule = ratelimit.ACCOUNT_2FA_RULE
    await notify_failures(
        db, user, reason="two_factor", ip=ip, count=rule.limit, minutes=rule.lock // 60
    )


async def _code_failed(
    db: AsyncSession,
    redis: Redis,
    *,
    user: User,
    client: ClientInfo,
    attempts: _CodeAttempts,
    method: CodeMethod,
    login_token: str,
) -> NoReturn:
    pair = await ratelimit.register_failure(redis, user.email, client.ip, attempts.pair)
    account = await ratelimit.register_2fa_failure(redis, user.email, attempts.account)
    if account.just_locked:
        await notify_two_factor_lock(db, redis, user, client.ip)
        await drop_pending_login(redis, login_token)
    elif pair.just_locked:
        await notify_pair_lock(db, redis, user, client.ip)
    result = "bad_totp" if method == "totp" else "bad_recovery"
    await record_login_event(db, user_id=user.id, client=client, result=result, method=method)
    await db.commit()
    raise AppError(401, "auth.invalid_code")


async def _code_succeeded(redis: Redis, *, user: User, client: ClientInfo) -> None:
    await ratelimit.reset_failures(redis, user.email, client.ip)
    await ratelimit.release_2fa_attempt(redis, user.email)


# --- коды 2FA ---


def _totp_secret(user: User) -> str | None:
    if user.totp_secret_enc is None or user.totp_key_version is None:
        return None
    aad = crypto.aad_for(crypto.AAD_TOTP_SECRET, user.id)
    return crypto.decrypt_str(user.totp_secret_enc, user.totp_key_version, aad)


async def check_totp(db: AsyncSession, user: User, code: str) -> bool:
    """Код из приложения верный и еще не использован. Шаг кода записывается сразу
    (consume_totp_step), commit — за вызывающим сервисом."""
    secret = _totp_secret(user)
    if secret is None or not user.totp_enabled:
        return False
    step = verify_totp(secret, code, last_step=user.totp_last_step)
    if step is None or not await consume_totp_step(db, user.id, step):
        return False
    if user.totp_key_version is not None and crypto.needs_reencrypt(user.totp_key_version):
        # Мастер-ключ сменили: перешифровываем секрет текущим ключом при входе
        enc, version = crypto.encrypt_str(secret, crypto.aad_for(crypto.AAD_TOTP_SECRET, user.id))
        user.totp_secret_enc = enc
        user.totp_key_version = version
    return True


async def _check_code(
    db: AsyncSession, user: User, code: str | None, recovery_code: str | None
) -> bool:
    if code is not None:
        return await check_totp(db, user, code)
    if recovery_code is not None:
        return await consume_recovery_code(db, user.id, hash_code(recovery_code))
    return False


async def issue_recovery_codes(db: AsyncSession, user_id: int) -> list[str]:
    """8 новых резервных кодов вместо прежних. В БД только HMAC-хеши, коды —
    в ответ один раз. Только flush."""
    await db.execute(delete(RecoveryCode).where(RecoveryCode.user_id == user_id))
    codes = gen_recovery_codes()
    db.add_all(RecoveryCode(user_id=user_id, code_hash=hash_code(code)) for code in codes)
    await db.flush()
    return codes


# --- завершение входа ---


async def _complete_login(
    db: AsyncSession,
    user: User,
    *,
    client: ClientInfo,
    method: str,
    remember_device: bool = False,
    old_session_token: str | None = None,
) -> LoginOutcome:
    """Новый сеанс (токен всегда новый), журнал, уведомление о новом устройстве, commit."""
    now = sessions.utcnow()
    # Прежний сеанс этого браузера больше не нужен
    await sessions.revoke_session_by_token(db, old_session_token, now=now)
    new = await sessions.create_session(
        db, user_id=user.id, ip=client.ip, user_agent=client.user_agent, now=now
    )
    device_token: str | None = None
    if remember_device:
        device = await devices.create_trusted_device(
            db, user_id=user.id, ip=client.ip, user_agent=client.user_agent, now=now
        )
        device_token = device.token
    if await _is_new_device(db, user, client.user_agent):
        await notify(
            db,
            user_id=user.id,
            kind="new_device",
            link=SECURITY_LINK,
            device=device_label(client.user_agent) or t("devices.unknown"),
            ip=client.ip,
        )
    await record_login_event(db, user_id=user.id, client=client, result="ok", method=method)
    user.last_login_at = now
    await db.commit()
    log.info("auth.login_ok", user_id=user.id, method=method)
    return LoginOutcome(status="ok", user=user, session_token=new.token, device_token=device_token)


# --- шаги входа ---


async def login_with_password(
    db: AsyncSession,
    redis: Redis,
    *,
    email: str,
    password: str,
    client: ClientInfo,
    device_token: str | None = None,
    old_login_token: str | None = None,
    old_session_token: str | None = None,
) -> LoginOutcome:
    """Шаг 1: email и пароль. Ответ одинаковый для неверного пароля и чужого email."""
    email = email.strip()
    user = await find_user_by_email(db, email)
    if user is not None and user.status == "deleted":
        user = None
    user_id = user.id if user is not None else None

    wait = await ratelimit.hit_ip_limit(redis, client.ip, ratelimit.LOGIN_IP_RULE)
    if wait:
        await _reject_rate_limited(
            db, user_id=user_id, client=client, method="password", retry_after=wait
        )
    attempt = await ratelimit.begin_attempt(redis, email, client.ip)
    if attempt.retry_after:
        await _reject_rate_limited(
            db, user_id=user_id, client=client, method="password", retry_after=attempt.retry_after
        )

    if user is None or not user.password_hash:
        await verify_dummy_async(password)
        password_ok = False
    else:
        password_ok = await verify_password_async(user.password_hash, password)
    if not password_ok or user is None or user.password_hash is None:
        result = await ratelimit.register_failure(redis, email, client.ip, attempt)
        if result.just_locked and user is not None:
            await notify_pair_lock(db, redis, user, client.ip)
        await record_login_event(
            db, user_id=user_id, client=client, result="bad_password", method="password"
        )
        await db.commit()
        raise AppError(401, "auth.invalid_credentials")

    if needs_rehash(user.password_hash):
        user.password_hash = await hash_password_async(password)

    if user.status == "blocked":
        await ratelimit.release_attempt(redis, email, client.ip)
        await record_login_event(
            db, user_id=user.id, client=client, result="blocked", method="password"
        )
        await db.commit()
        raise AppError(403, "auth.blocked")

    if user.totp_enabled and await devices.find_trusted_device(db, user.id, device_token):
        await ratelimit.reset_failures(redis, email, client.ip)
        await drop_pending_login(redis, old_login_token)
        return await _complete_login(
            db,
            user,
            client=client,
            method="trusted_device",
            old_session_token=old_session_token,
        )

    # Верный пароль неудачей не считается; дальше нужен код 2FA или его настройка
    await ratelimit.release_attempt(redis, email, client.ip)
    await db.commit()
    stage: Stage = "totp" if user.totp_enabled else "setup"
    token = await create_pending_login(
        redis, user, ip=client.ip, stage=stage, replace_token=old_login_token
    )
    return LoginOutcome(
        status="totp_required" if stage == "totp" else "totp_setup_required",
        user=user,
        login_token=token,
    )


async def verify_second_factor(
    db: AsyncSession,
    redis: Redis,
    *,
    login_token: str | None,
    code: str | None,
    recovery_code: str | None,
    remember_device: bool,
    client: ClientInfo,
    old_session_token: str | None = None,
) -> LoginOutcome:
    """Шаг 2: код из приложения или резервный код. Код срабатывает один раз."""
    method: CodeMethod = "totp" if code is not None else "recovery"
    login_token, pending = await _load_pending(redis, login_token)
    user = await _pending_user(
        db, redis, token=login_token, pending=pending, stage="totp", client=client, method=method
    )
    attempts = await _begin_code_attempt(
        db, redis, user=user, client=client, method=method, login_token=login_token
    )
    if not await _check_code(db, user, code, recovery_code):
        await _code_failed(
            db,
            redis,
            user=user,
            client=client,
            attempts=attempts,
            method=method,
            login_token=login_token,
        )
    await _code_succeeded(redis, user=user, client=client)
    await drop_pending_login(redis, login_token)
    return await _complete_login(
        db,
        user,
        client=client,
        method=method,
        remember_device=remember_device,
        old_session_token=old_session_token,
    )


async def _ensure_setup_secret(redis: Redis, token: str, user: User) -> PendingLogin:
    """Секрет 2FA незавершенного входа: создается один раз, повторный вызов (в том числе
    параллельный) получает тот же. WATCH/MULTI: два запроса не запишут два разных секрета."""
    key = _pending_key(token)
    aad = crypto.aad_for(crypto.AAD_LOGIN_SETUP, user.id)
    async with redis.pipeline(transaction=True) as pipe:
        for _ in range(5):
            try:
                await pipe.watch(key)
                current = _parse_pending(await pipe.get(key))
                if current is None:
                    raise AppError(401, "auth.login_expired")
                if current.setup_secret_enc is not None:
                    return current
                enc, version = crypto.encrypt_str(new_totp_secret(), aad)
                current.setup_secret_enc = base64.b64encode(enc).decode()
                current.setup_key_version = version
                # у multi() в redis-py нет аннотаций типов
                cast(Any, pipe).multi()
                pipe.set(key, json.dumps(asdict(current)), keepttl=True)
                await pipe.execute()
                return current
            except WatchError:
                continue
    raise AppError(401, "auth.login_expired")


def _setup_secret(pending: PendingLogin) -> str | None:
    if pending.setup_secret_enc is None or pending.setup_key_version is None:
        return None
    aad = crypto.aad_for(crypto.AAD_LOGIN_SETUP, pending.user_id)
    return crypto.decrypt_str(
        base64.b64decode(pending.setup_secret_enc), pending.setup_key_version, aad
    )


async def start_totp_setup(
    db: AsyncSession, redis: Redis, *, login_token: str | None, client: ClientInfo
) -> TotpSetup:
    """Секрет 2FA для настройки (этап setup). Повторный вызов дает тот же секрет."""
    login_token, pending = await _load_pending(redis, login_token)
    user = await _pending_user(
        db, redis, token=login_token, pending=pending, stage="setup", client=client, method="totp"
    )
    secret = _setup_secret(await _ensure_setup_secret(redis, login_token, user))
    if secret is None:
        raise AppError(401, "auth.login_expired")
    uri = totp_uri(secret, user.email)
    return TotpSetup(secret=secret, otpauth_uri=uri, qr_svg=qr_svg(uri))


async def confirm_totp_setup(
    db: AsyncSession,
    redis: Redis,
    *,
    login_token: str | None,
    code: str,
    client: ClientInfo,
    old_session_token: str | None = None,
) -> LoginOutcome:
    """Код из приложения подтверждает настройку: 2FA включается, создаются 8 резервных
    кодов, вход завершается."""
    login_token, pending = await _load_pending(redis, login_token)
    user = await _pending_user(
        db, redis, token=login_token, pending=pending, stage="setup", client=client, method="totp"
    )
    secret = _setup_secret(pending)
    if secret is None:
        # Секрет не выдавался: сначала POST /api/auth/2fa/setup
        raise AppError(401, "auth.login_expired")
    attempts = await _begin_code_attempt(
        db, redis, user=user, client=client, method="totp", login_token=login_token
    )
    step = verify_totp(secret, code, last_step=user.totp_last_step)
    if step is None:
        await _code_failed(
            db,
            redis,
            user=user,
            client=client,
            attempts=attempts,
            method="totp",
            login_token=login_token,
        )
    user_id = user.id
    enc, version = crypto.encrypt_str(secret, crypto.aad_for(crypto.AAD_TOTP_SECRET, user_id))
    enabled = await db.execute(
        update(User)
        .where(User.id == user_id, User.totp_enabled.is_(False))
        .values(
            totp_secret_enc=enc, totp_key_version=version, totp_enabled=True, totp_last_step=step
        )
        .returning(User.id)
    )
    if enabled.scalar_one_or_none() is None:
        # 2FA уже включили в другом окне: этот вход начинать заново
        await db.rollback()
        await drop_pending_login(redis, login_token)
        raise AppError(401, "auth.login_expired")
    codes = await issue_recovery_codes(db, user_id)
    await db.refresh(user)
    await _code_succeeded(redis, user=user, client=client)
    await drop_pending_login(redis, login_token)
    outcome = await _complete_login(
        db, user, client=client, method="totp", old_session_token=old_session_token
    )
    outcome.recovery_codes = codes
    return outcome


async def logout(
    db: AsyncSession, redis: Redis, *, session_token: str | None, login_token: str | None
) -> None:
    """Выход: сеанс этого браузера отзывается, незавершенный вход удаляется.
    Доверенное устройство остается (его отзывают в личном кабинете)."""
    await sessions.revoke_session_by_token(db, session_token)
    await drop_pending_login(redis, login_token)
    await db.commit()
