"""Свой ключ Claude участника, режим ключа и лимиты на ключе администратора (Р7, Р9, Р12, Р13).

Режимы: shared — анализы идут на ключе администратора в пределах личного лимита и общего
бюджета; own — на своем ключе участника, расход с его счета. На свой ключ участник
переходит сам: ключ сохраняется, только если прошел проверку (ключ рабочий и модели из
настроек агента доступны), и режим сразу становится own. Обратно — просьба
администратору и его решение (request_return → decide_return). Администратор
переключает свой режим сам; возвращаясь на ключ администратора, он удаляет свой ключ
(как в макете).

Ключ шифруется AES-256-GCM (aad user_secrets.anthropic_key:<user_id>), наружу — только
последние 4 символа. Проверка ключа идет по сети: на это время транзакция закрывается
(commit без изменений, объекты в сеансе остаются читаемыми), соединение возвращается в
пул; строки, которые меняются, функции перечитывают под блокировкой.
Действия администратора пишутся в журнал (ai_mode_change, limit_change, budget_change).
"""

from dataclasses import dataclass
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import anthropic
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import default_per_analysis, load_agent_config
from app.core.errors import AppError
from app.core.security import crypto
from app.db.models import AiLimit, AppSettings, Notification, User, UserSecret
from app.db.models.admin import BUDGET_ALERT_PCTS
from app.services.ai_access import Limits, limits_of, usd_text
from app.services.app_settings import SETTINGS_ROW_ID
from app.services.audit import write_audit
from app.services.claude_key import SECRET_KIND, KeyCheck, check_anthropic_key, looks_like_key
from app.services.notifications import notify
from app.services.sessions import utcnow

# Адреса экранов для уведомлений (frontend/src/app/paths.ts)
KEY_LINK = "/profile/key"
ADMIN_USERS_LINK = "/admin/users"
ADMIN_KEY_LINK = "/admin/key"
OWN_CAP_MIN = Decimal("0.10")
OWN_CAP_MAX = Decimal("20")
# Одно и то же уведомление о сбое ключа — не чаще раза в 6 часов
KEY_FAILURE_REPEAT = timedelta(hours=6)
_LAST_ERROR_LENGTH = 64


@dataclass(frozen=True)
class OwnKeyStatus:
    """Свой ключ участника для экрана: есть ли, последние 4 символа, когда проверен,
    последняя ошибка (код вида rejected:401), режим участника и доступность моделей
    (после проверки)."""

    has_key: bool
    last4: str | None
    verified_at: datetime | None
    last_error: str | None
    mode: str
    models: tuple[tuple[str, bool], ...] = ()


async def _locked_user(db: AsyncSession, user_id: int) -> User:
    user = await db.scalar(
        select(User)
        .where(User.id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if user is None or user.status == "deleted":
        raise AppError(404, "common.not_found")
    return user


async def _secret(db: AsyncSession, user_id: int) -> UserSecret | None:
    row: UserSecret | None = await db.scalar(
        select(UserSecret)
        .where(UserSecret.user_id == user_id, UserSecret.kind == SECRET_KIND)
        .execution_options(populate_existing=True)
    )
    return row


async def _delete_secret(db: AsyncSession, user_id: int) -> None:
    """Свой ключ удаляется с сервера: на ключе администратора он не нужен (Р12)."""
    await db.execute(
        delete(UserSecret).where(UserSecret.user_id == user_id, UserSecret.kind == SECRET_KIND)
    )


async def _settings(db: AsyncSession, *, lock: bool = True) -> AppSettings:
    stmt = select(AppSettings).where(AppSettings.id == SETTINGS_ROW_ID)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    row = await db.scalar(stmt)
    if row is None:
        raise AppError(500, "admin.settings_missing")
    return row


async def _limit_row(db: AsyncSession, user_id: int) -> AiLimit:
    """Строка ai_limits участника под блокировкой; нет — создается с лимитами по
    умолчанию (участники, созданные не регистрацией, например администраторы)."""
    row = await db.scalar(
        select(AiLimit)
        .where(AiLimit.user_id == user_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if row is not None:
        return row
    settings = await _settings(db, lock=False)
    cap = default_per_analysis(settings)
    row = AiLimit(
        user_id=user_id,
        monthly_usd=settings.default_member_limit_usd,
        daily_analyses=settings.default_daily_analyses,
        per_analysis_usd=cap,
        own_per_analysis_usd=cap,
    )
    db.add(row)
    await db.flush()
    return row


def _status(user: User, secret: UserSecret | None, check: KeyCheck | None = None) -> OwnKeyStatus:
    return OwnKeyStatus(
        has_key=secret is not None,
        last4=secret.last4 if secret is not None else None,
        verified_at=secret.verified_at if secret is not None else None,
        last_error=secret.last_error if secret is not None else None,
        mode=user.ai_mode,
        models=check.models if check is not None else (),
    )


async def own_key_status(db: AsyncSession, user: User) -> OwnKeyStatus:
    return _status(user, await _secret(db, user.id))


def _raise_for_check(check: KeyCheck) -> None:
    """Ключ не прошел проверку — ошибка для участника (текст ответа Anthropic не
    показываем, только статус)."""
    if check.result == "rejected":
        raise AppError(400, "ai.key_rejected", status=check.status_code)
    if check.result == "unavailable":
        raise AppError(503, "ai.key_unavailable")
    if check.result == "error":
        raise AppError(502, "ai.key_check_failed", status=check.status_code)
    if check.missing_models:
        raise AppError(400, "ai.key_models", models=", ".join(check.missing_models))


async def _audit_mode(
    db: AsyncSession,
    *,
    actor_id: int | None,
    target: User,
    before: str,
    decision: str | None = None,
    ip: str | None = None,
) -> None:
    details: dict[str, Any] = {"from": before, "to": target.ai_mode}
    if decision is not None:
        details["decision"] = decision
    await write_audit(
        db,
        action="ai_mode_change",
        actor_id=actor_id,
        target_user_id=target.id,
        details=details,
        ip=ip,
    )


async def save_own_key(
    db: AsyncSession,
    user: User,
    key: str,
    *,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> OwnKeyStatus:
    """Проверяет и сохраняет свой ключ участника (новый или замена). Не прошел
    проверку — AppError, ничего не сохраняется. Прошел — режим участника становится own
    (Р7). Ключ не пишется ни в журнал, ни в лог. http_client — для тестов."""
    user_id = user.id
    key = key.strip()
    if not looks_like_key(key):
        raise AppError(400, "ai.key_format")
    models = (await load_agent_config(db)).models()
    # Соединение с базой не держим, пока идет проверка по сети
    await db.commit()
    check = await check_anthropic_key(key, models=models, http_client=http_client)
    _raise_for_check(check)

    target = await _locked_user(db, user_id)
    ciphertext, version = crypto.encrypt_str(key, crypto.aad_for(crypto.AAD_USER_SECRET, user_id))
    now = utcnow()
    secret = await _secret(db, user_id)
    if secret is None:
        secret = UserSecret(user_id=user_id, kind=SECRET_KIND, ciphertext=ciphertext)
        db.add(secret)
    secret.ciphertext = ciphertext
    secret.key_version = version
    secret.last4 = key[-4:]
    secret.verified_at = now
    secret.last_error = None
    before = target.ai_mode
    target.ai_mode = "own"
    if before != "own" and target.role == "admin":
        await _audit_mode(db, actor_id=target.id, target=target, before=before)
    await db.commit()
    return _status(target, secret, check)


async def check_own_key(
    db: AsyncSession,
    user: User,
    *,
    http_client: anthropic.DefaultAsyncHttpxClient | None = None,
) -> OwnKeyStatus:
    """Кнопка «Проверить»: проверяет сохраненный ключ и пишет итог (verified_at или
    last_error). Нет связи с Anthropic — AppError 503, итог не пишется."""
    user_id = user.id
    secret = await _secret(db, user_id)
    if secret is None:
        raise AppError(404, "ai.no_own_key")
    try:
        key = crypto.decrypt_str(
            secret.ciphertext,
            secret.key_version,
            crypto.aad_for(crypto.AAD_USER_SECRET, user_id),
        )
    except crypto.CryptoError:
        raise AppError(409, "ai.no_key") from None
    models = (await load_agent_config(db)).models()
    await db.commit()
    check = await check_anthropic_key(key, models=models, http_client=http_client)
    if check.result == "unavailable":
        raise AppError(503, "ai.key_unavailable")
    target = await _locked_user(db, user_id)
    secret = await _secret(db, user_id)
    if secret is None:
        raise AppError(404, "ai.no_own_key")
    if check.result == "ok" and not check.missing_models:
        secret.verified_at = utcnow()
        secret.last_error = None
    elif check.result == "ok":
        secret.last_error = ("models:" + ",".join(check.missing_models))[:_LAST_ERROR_LENGTH]
    else:
        secret.verified_at = None if check.result == "rejected" else secret.verified_at
        secret.last_error = f"{check.result}:{check.status_code}"
    await db.commit()
    return _status(target, secret, check)


async def delete_own_key(db: AsyncSession, user: User, *, ip: str | None = None) -> OwnKeyStatus:
    """Удаляет свой ключ с сервера (отозвать его в консоли Anthropic участник должен
    сам). Участник остается в режиме own: анализы не запустятся, пока он не сохранит
    новый ключ или администратор не вернет его на ключ администратора. Администратор
    сразу возвращается на ключ администратора."""
    target = await _locked_user(db, user.id)
    await db.execute(
        delete(UserSecret).where(UserSecret.user_id == target.id, UserSecret.kind == SECRET_KIND)
    )
    if target.role == "admin" and target.ai_mode == "own":
        target.ai_mode = "shared"
        await _audit_mode(db, actor_id=target.id, target=target, before="own", ip=ip)
    await db.commit()
    return _status(target, None)


async def set_ai_mode(
    db: AsyncSession, user: User, mode: str, *, ip: str | None = None
) -> OwnKeyStatus:
    """Участник меняет свой режим. На own — только с проверенным ключом; на shared —
    только администратор (сразу, свой ключ при этом удаляется), участник — через
    просьбу (request_return)."""
    target = await _locked_user(db, user.id)
    secret = await _secret(db, target.id)
    if mode == target.ai_mode:
        return _status(target, secret)
    if mode == "own":
        if secret is None or secret.verified_at is None:
            raise AppError(409, "ai.no_own_key")
        target.ai_mode = "own"
        if target.role == "admin":
            await _audit_mode(db, actor_id=target.id, target=target, before="shared", ip=ip)
        await db.commit()
        return _status(target, secret)
    if mode != "shared":
        raise AppError(400, "common.validation")
    if target.role != "admin":
        raise AppError(403, "ai.return_needs_admin")
    await _delete_secret(db, target.id)
    target.ai_mode = "shared"
    await _audit_mode(db, actor_id=target.id, target=target, before="own", ip=ip)
    await db.commit()
    return _status(target, None)


async def _active_admin_ids(db: AsyncSession) -> list[int]:
    return list(
        await db.scalars(
            select(User.id).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )


async def request_return(db: AsyncSession, user: User) -> datetime:
    """Участник на своем ключе просит вернуть ключ администратора (Р12): отметка в
    ai_limits и уведомление ai_mode_request администраторам. Повторная просьба — та же
    отметка, без новых уведомлений. Возвращает время просьбы."""
    target = await _locked_user(db, user.id)
    if target.ai_mode != "own":
        raise AppError(409, "ai.already_shared")
    if target.role == "admin":
        raise AppError(409, "ai.return_not_needed")
    limit = await _limit_row(db, target.id)
    requested = limit.return_requested_at
    if requested is not None:
        await db.commit()
        return requested
    now = utcnow()
    limit.return_requested_at = now
    for admin_id in await _active_admin_ids(db):
        await notify(
            db,
            user_id=admin_id,
            kind="ai_mode_request",
            link=ADMIN_USERS_LINK,
            subject=target.id,
            name=target.display_name or target.email,
        )
    await db.commit()
    return now


async def _close_requests(db: AsyncSession, user_id: int, *, remove: bool) -> None:
    """Уведомления ai_mode_request об этом участнике: при отмене просьбы удаляются
    непрочитанные, после решения — отмечаются прочитанными у всех администраторов."""
    match = (
        Notification.kind == "ai_mode_request",
        Notification.params["subject"].astext == str(user_id),
        Notification.read_at.is_(None),
    )
    if remove:
        await db.execute(delete(Notification).where(*match))
    else:
        await db.execute(update(Notification).where(*match).values(read_at=utcnow()))


async def cancel_return_request(db: AsyncSession, user: User) -> None:
    """Участник отменяет просьбу вернуть ключ администратора."""
    target = await _locked_user(db, user.id)
    limit = await _limit_row(db, target.id)
    if limit.return_requested_at is None:
        await db.commit()
        return
    limit.return_requested_at = None
    await _close_requests(db, target.id, remove=True)
    await db.commit()


async def decide_return(
    db: AsyncSession, user_id: int, *, approve: bool, actor: User | None, ip: str | None = None
) -> None:
    """Решение администратора по просьбе вернуть ключ администратора. Одобрено — режим
    shared (лимиты — из ai_limits участника), свой ключ удаляется с сервера (как в
    макете: «его ключ отключится»); отклонено — режим own остается. В обоих случаях:
    журнал ai_mode_change и уведомление участнику ai_mode_decision. Просьбы нет —
    AppError 409."""
    target = await _locked_user(db, user_id)
    limit = await _limit_row(db, target.id)
    if limit.return_requested_at is None or target.ai_mode != "own":
        raise AppError(409, "ai.no_return_request")
    limit.return_requested_at = None
    before = target.ai_mode
    actor_id = actor.id if actor is not None else None
    if approve:
        await _delete_secret(db, target.id)
        target.ai_mode = "shared"
        await _audit_mode(
            db, actor_id=actor_id, target=target, before=before, decision="approved", ip=ip
        )
        limits = limits_of(limit, await _settings(db, lock=False))
        await notify(
            db,
            user_id=target.id,
            kind="ai_mode_decision",
            link=KEY_LINK,
            subject=target.id,
            limit=usd_text(limits.monthly_usd),
            daily=limits.daily_analyses,
            cap=usd_text(limits.per_analysis_usd),
        )
    else:
        await _audit_mode(
            db, actor_id=actor_id, target=target, before=before, decision="rejected", ip=ip
        )
        await notify(
            db,
            user_id=target.id,
            kind="ai_mode_decision",
            variant="rejected",
            link=KEY_LINK,
            subject=target.id,
        )
    await _close_requests(db, target.id, remove=False)
    await db.commit()


async def admin_set_ai_mode(
    db: AsyncSession, user_id: int, mode: str, *, actor: User | None, ip: str | None = None
) -> None:
    """Администратор сам меняет режим участника (без просьбы). На own — только если у
    участника есть проверенный ключ. Журнал ai_mode_change и уведомление участнику."""
    if mode not in ("shared", "own"):
        raise AppError(400, "common.validation")
    target = await _locked_user(db, user_id)
    if target.ai_mode == mode:
        return
    if mode == "own":
        secret = await _secret(db, target.id)
        if secret is None or secret.verified_at is None:
            raise AppError(409, "ai.no_own_key")
    limit = await _limit_row(db, target.id)
    limit.return_requested_at = None
    before = target.ai_mode
    target.ai_mode = mode
    actor_id = actor.id if actor is not None else None
    await _audit_mode(db, actor_id=actor_id, target=target, before=before, ip=ip)
    if mode == "shared":
        limits = limits_of(limit, await _settings(db, lock=False))
        await notify(
            db,
            user_id=target.id,
            kind="ai_mode_decision",
            link=KEY_LINK,
            subject=target.id,
            limit=usd_text(limits.monthly_usd),
            daily=limits.daily_analyses,
            cap=usd_text(limits.per_analysis_usd),
        )
    else:
        await notify(
            db,
            user_id=target.id,
            kind="ai_mode_decision",
            variant="own",
            link=KEY_LINK,
            subject=target.id,
        )
    await _close_requests(db, target.id, remove=False)
    await db.commit()


async def set_own_cap(db: AsyncSession, user: User, cap_usd: Decimal) -> Decimal:
    """Свой потолок одного анализа на своем ключе: от $0,10 до $20 (как в макете)."""
    cap = cap_usd.quantize(Decimal("0.01"))
    if not OWN_CAP_MIN <= cap <= OWN_CAP_MAX:
        raise AppError(
            400, "ai.own_cap_range", min=usd_text(OWN_CAP_MIN), max=usd_text(OWN_CAP_MAX)
        )
    limit = await _limit_row(db, user.id)
    limit.own_per_analysis_usd = cap
    await db.commit()
    return cap


async def _recent_failure(
    db: AsyncSession, recipient: int, variant: str | None, since: datetime
) -> bool:
    found = await db.scalar(
        select(Notification.id)
        .where(
            Notification.user_id == recipient,
            Notification.kind == "ai_key_failed",
            Notification.created_at >= since,
            Notification.params["variant"].astext == variant
            if variant is not None
            else Notification.params["variant"].astext.is_(None),
        )
        .limit(1)
    )
    return found is not None


async def report_key_failure(
    db: AsyncSession, key_source: str, user_id: int | None, code: str
) -> list[Notification]:
    """Ключ не сработал на настоящем вызове (ai.key_rejected — ключ отозван или неверный,
    ai.billing — нет денег или лимит трат). Свой ключ: user_secrets.last_error и
    уведомление участнику; ключ администратора — уведомление администраторам. После
    ai.key_rejected ключ считается непроверенным. Одно уведомление — не чаще раза в
    6 часов. flush; commit — за вызывающим."""
    now = utcnow()
    rejected = code == "ai.key_rejected"
    created: list[Notification] = []
    if key_source == "own" and user_id is not None:
        secret = await _secret(db, user_id)
        if secret is not None:
            secret.last_error = code[:_LAST_ERROR_LENGTH]
            if rejected:
                secret.verified_at = None
        variant = None if rejected else "billing"
        if not await _recent_failure(db, user_id, variant, now - KEY_FAILURE_REPEAT):
            if variant is None:
                created.append(
                    await notify(db, user_id=user_id, kind="ai_key_failed", link=KEY_LINK)
                )
            else:
                created.append(
                    await notify(
                        db,
                        user_id=user_id,
                        kind="ai_key_failed",
                        variant="billing",
                        link=KEY_LINK,
                    )
                )
    elif key_source == "admin":
        settings = await _settings(db, lock=False)
        if rejected:
            settings.key_verified_at = None
        variant = "admin" if rejected else "admin_billing"
        for admin_id in await _active_admin_ids(db):
            if await _recent_failure(db, admin_id, variant, now - KEY_FAILURE_REPEAT):
                continue
            created.append(
                await notify(
                    db, user_id=admin_id, kind="ai_key_failed", variant=variant, link=ADMIN_KEY_LINK
                )
            )
    await db.flush()
    return created


# --- лимиты и бюджет (администратор) ---


def _money(value: Decimal | None) -> Decimal | None:
    return value.quantize(Decimal("0.01")) if value is not None else None


def _diff(changes: dict[str, tuple[Any, Any]]) -> dict[str, dict[str, Any]]:
    """Изменения для журнала: деньги — строкой (JSON), только то, что поменялось."""

    def plain(value: Any) -> Any:
        return str(value) if isinstance(value, Decimal) else value

    return {
        name: {"from": plain(old), "to": plain(new)}
        for name, (old, new) in changes.items()
        if old != new
    }


async def set_member_limit(
    db: AsyncSession,
    user_id: int,
    *,
    monthly_usd: Decimal | None = None,
    daily_analyses: int | None = None,
    per_analysis_usd: Decimal | None = None,
    paused: bool | None = None,
    actor: User | None,
    ip: str | None = None,
) -> Limits:
    """Лимиты участника на ключе администратора (None — не менять). Журнал limit_change
    с тем, что поменялось. Отрицательные значения — AppError 400."""
    for value in (monthly_usd, per_analysis_usd):
        if value is not None and value < 0:
            raise AppError(400, "ai.limit_invalid")
    if daily_analyses is not None and daily_analyses < 0:
        raise AppError(400, "ai.limit_invalid")
    target = await _locked_user(db, user_id)
    row = await _limit_row(db, target.id)
    new_monthly = _money(monthly_usd)
    new_cap = _money(per_analysis_usd)
    changes: dict[str, tuple[Any, Any]] = {}
    if new_monthly is not None:
        changes["monthly_usd"] = (row.monthly_usd, new_monthly)
        row.monthly_usd = new_monthly
    if daily_analyses is not None:
        changes["daily_analyses"] = (row.daily_analyses, daily_analyses)
        row.daily_analyses = daily_analyses
    if new_cap is not None:
        changes["per_analysis_usd"] = (row.per_analysis_usd, new_cap)
        row.per_analysis_usd = new_cap
    if paused is not None:
        changes["paused"] = (row.paused, paused)
        row.paused = paused
    diff = _diff(changes)
    if diff:
        row.updated_by = actor.id if actor is not None else None
        row.updated_at = utcnow()
        await write_audit(
            db,
            action="limit_change",
            actor_id=actor.id if actor is not None else None,
            target_user_id=target.id,
            details={"changes": diff},
            ip=ip,
        )
    await db.commit()
    return limits_of(row, await _settings(db, lock=False))


async def _update_settings(
    db: AsyncSession,
    values: dict[str, Any],
    *,
    actor: User | None,
    ip: str | None,
) -> AppSettings:
    row = await _settings(db)
    changes = {name: (getattr(row, name), value) for name, value in values.items()}
    soft = values.get("per_analysis_soft_usd", row.per_analysis_soft_usd)
    hard = values.get("per_analysis_hard_usd", row.per_analysis_hard_usd)
    if soft > hard:
        raise AppError(400, "ai.limit_invalid")
    for name, value in values.items():
        setattr(row, name, value)
    diff = _diff(changes)
    if diff:
        row.updated_by = actor.id if actor is not None else None
        row.updated_at = utcnow()
        await write_audit(
            db,
            action="budget_change",
            actor_id=actor.id if actor is not None else None,
            details={"changes": diff},
            ip=ip,
        )
    await db.commit()
    return row


async def set_default_limits(
    db: AsyncSession,
    *,
    default_member_limit_usd: Decimal | None = None,
    default_daily_analyses: int | None = None,
    per_analysis_soft_usd: Decimal | None = None,
    per_analysis_hard_usd: Decimal | None = None,
    actor: User | None,
    ip: str | None = None,
) -> AppSettings:
    """Лимиты по умолчанию для новых участников и мягкий и жесткий потолок анализа
    (None — не менять). Действующие лимиты участников не меняются. Журнал budget_change."""
    values: dict[str, Any] = {}
    for name, money in (
        ("default_member_limit_usd", default_member_limit_usd),
        ("per_analysis_soft_usd", per_analysis_soft_usd),
        ("per_analysis_hard_usd", per_analysis_hard_usd),
    ):
        if money is not None:
            if money < 0:
                raise AppError(400, "ai.limit_invalid")
            values[name] = _money(money)
    if default_daily_analyses is not None:
        if default_daily_analyses < 0:
            raise AppError(400, "ai.limit_invalid")
        values["default_daily_analyses"] = default_daily_analyses
    return await _update_settings(db, values, actor=actor, ip=ip)


async def set_budget(
    db: AsyncSession,
    *,
    monthly_budget_usd: Decimal | None = None,
    budget_alert_pct: int | None = None,
    eval_budget_usd: Decimal | None = None,
    actor: User | None,
    ip: str | None = None,
) -> AppSettings:
    """Общий бюджет ключа администратора на месяц, порог предупреждения (50, 70, 80 или
    90%) и бюджет проверок (None — не менять). Журнал budget_change."""
    values: dict[str, Any] = {}
    for name, money in (
        ("monthly_budget_usd", monthly_budget_usd),
        ("eval_budget_usd", eval_budget_usd),
    ):
        if money is not None:
            if money < 0:
                raise AppError(400, "ai.limit_invalid")
            values[name] = _money(money)
    if budget_alert_pct is not None:
        if budget_alert_pct not in BUDGET_ALERT_PCTS:
            raise AppError(400, "ai.alert_pct")
        values["budget_alert_pct"] = budget_alert_pct
    return await _update_settings(db, values, actor=actor, ip=ip)
