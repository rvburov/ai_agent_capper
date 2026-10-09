"""Подтверждение опасных действий администратора текущим кодом 2FA (PLAN.md, раздел 7:
захват сеанса администратора без его телефона не дает выполнить опасное действие).

Опасные действия из кабинета: смена роли, сброс 2FA, удаление участника, приглашение
с ролью admin (оно выдает те же права, что и смена роли), блокировка администратора и
завершение его сеансов. Команды терминала код не спрашивают: доступ к серверу уже
подтверждает владельца.

Подбор кода с угнанного сеанса: пятый неверный код подряд в этом сеансе (окно — сутки)
завершает сеанс, владельцу приходит уведомление login_failures. Счетчик у каждого
сеанса свой, а не общий счетчик 2FA аккаунта: иначе тот, у кого есть только cookie
сеанса, закрывал бы владельцу шаг 2FA при входе (так же устроен перевыпуск резервных
кодов, app/services/account.py).

Каждая неудача пишется в admin_audit_log (confirm_failed): какое действие, номер
попытки, завершен ли сеанс, IP. Запрос при этом отвечает ошибкой, и все, что сервис
успел сделать до проверки кода, должно откатиться, а запись журнала — остаться. Поэтому
транзакция запроса откатывается, и запись фиксируется своей транзакцией в том же сеансе
БД. Отдельный сеанс БД не годится: транзакция запроса держит FOR UPDATE на строке
участника (admin_users._load_target), а вставка в журнал со ссылкой на эту строку
(внешний ключ actor_id или target_user_id) ждала бы ее конца — запрос завис бы сам на себе.

Отдельный модуль, потому что проверку зовут и admin_users, и access_codes, а admin_users
сам импортирует access_codes.
"""

from dataclasses import dataclass, replace
from typing import NoReturn

import structlog
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.i18n import t
from app.core.redis import redis_key
from app.core.security import crypto
from app.core.security.totp import verify_totp
from app.core.useragent import device_label
from app.db.models import User
from app.services import sessions
from app.services.audit import write_audit
from app.services.auth import ClientInfo, notify_failures
from app.services.two_factor import consume_totp_step

log = structlog.get_logger(__name__)

# Пятый неверный код подряд в сеансе за сутки завершает сеанс. Верный код счетчик
# обнуляет. Сутки, а не 15 минут: иначе с угнанного сеанса можно было бы перебирать
# по 4 кода в окно и не дойти ни до завершения сеанса, ни до уведомления владельцу
CONFIRM_MAX_FAILURES = 5
CONFIRM_WINDOW_SECONDS = 24 * 60 * 60


@dataclass(frozen=True)
class TotpConfirm:
    """Код 2FA администратора из тела запроса (None — кода нет), его сеанс, откуда
    пришел запрос и Redis для счетчика неудач."""

    redis: Redis
    session_id: int
    client: ClientInfo
    code: str | None = None

    def with_code(self, code: str | None) -> "TotpConfirm":
        return replace(self, code=code)


def _failures_key(session_id: int) -> str:
    return redis_key("rl", "admin_totp", "fail", session_id)


async def _begin_attempt(redis: Redis, session_id: int) -> int:
    """Номер попытки сеанса в окне. Резервируется до проверки кода: параллельные
    запросы не проверят больше CONFIRM_MAX_FAILURES кодов."""
    key = _failures_key(session_id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, CONFIRM_WINDOW_SECONDS, nx=True)
        return int((await pipe.execute())[0])


@dataclass(frozen=True)
class _Failure:
    """Неудачная попытка подтверждения: что подтверждалось и какая это попытка по счету."""

    action: str | None
    target_user_id: int | None
    attempt: int


async def _write_failure(
    db: AsyncSession, user_id: int, confirm: TotpConfirm, failure: _Failure, *, ended: bool
) -> None:
    """Запись confirm_failed в журнал (flush). Код 2FA в нее не попадает."""
    details: dict[str, object] = {"attempt": failure.attempt, "session_ended": ended}
    if failure.action is not None:
        details["action"] = failure.action
    await write_audit(
        db,
        action="confirm_failed",
        actor_id=user_id,
        target_user_id=failure.target_user_id,
        details=details,
        ip=confirm.client.ip,
    )


async def _refuse(
    db: AsyncSession, user_id: int, confirm: TotpConfirm, failure: _Failure
) -> NoReturn:
    """Неверный код, сеанс продолжается: откат действия, запись в журнал, 403."""
    await db.rollback()
    await _write_failure(db, user_id, confirm, failure, ended=False)
    await db.commit()
    raise AppError(403, "admin.totp_invalid", attempts_left=CONFIRM_MAX_FAILURES - failure.attempt)


async def _end_session(
    db: AsyncSession, user_id: int, confirm: TotpConfirm, failure: _Failure, *, notice: bool
) -> NoReturn:
    """Сеанс, с которого подбирали код, завершается. Все, что вызывающий сервис успел
    сделать до проверки кода, откатывается: действие не выполняется. После rollback
    объекты сеанса БД устаревают, поэтому здесь только id."""
    await db.rollback()
    await _write_failure(db, user_id, confirm, failure, ended=True)
    if notice:
        await notify_failures(
            db,
            user_id=user_id,
            reason="admin_confirm",
            ip=confirm.client.ip,
            device=device_label(confirm.client.user_agent) or t("devices.unknown"),
            count=CONFIRM_MAX_FAILURES,
        )
    await sessions.revoke_session(db, confirm.session_id, user_id=user_id)
    await db.commit()
    log.warning("admin.confirm_session_ended", user_id=user_id, session_id=confirm.session_id)
    raise AppError(401, "auth.too_many_codes")


async def check_totp(
    db: AsyncSession,
    actor: User,
    confirm: TotpConfirm | None,
    *,
    action: str | None = None,
    target_user_id: int | None = None,
) -> None:
    """Текущий код 2FA администратора перед действием action (действие журнала,
    например role_change) над пользователем target_user_id.

    Нет кода — 403 totp_required. Неверный или уже использованный — 403 totp_invalid
    (attempts_left — сколько неверных кодов еще можно ввести). Пятый неверный код подряд
    в этом сеансе — сеанс завершается (401 auth.too_many_codes), владельцу —
    уведомление login_failures. Каждая неудача — запись confirm_failed в журнале, она
    фиксируется сразу, а транзакция вызывающего сервиса откатывается.

    Принятый код записывается в totp_last_step одним условным UPDATE (consume_totp_step)
    и второй раз не сработает. Commit делает вызывающий сервис вместе с самим действием;
    если действие не выполнено, откат возвращает код в строй.
    """
    if (
        confirm is None
        or confirm.code is None
        or not actor.totp_enabled
        or actor.totp_secret_enc is None
        or actor.totp_key_version is None
    ):
        raise AppError(403, "admin.totp_required")
    # Данные пользователя читаем до возможного отката в _end_session
    actor_id = actor.id
    secret_enc, key_version, last_step = (
        actor.totp_secret_enc,
        actor.totp_key_version,
        actor.totp_last_step,
    )
    attempt = await _begin_attempt(confirm.redis, confirm.session_id)
    failure = _Failure(action=action, target_user_id=target_user_id, attempt=attempt)
    if attempt > CONFIRM_MAX_FAILURES:
        # Лимит исчерпан параллельными запросами: код не проверяется
        await _end_session(db, actor_id, confirm, failure, notice=False)
    secret = crypto.decrypt_str(
        secret_enc, key_version, crypto.aad_for(crypto.AAD_TOTP_SECRET, actor_id)
    )
    step = verify_totp(secret, confirm.code, last_step=last_step)
    if step is None or not await consume_totp_step(db, actor_id, step):
        log.warning(
            "admin.confirm_code_invalid",
            user_id=actor_id,
            session_id=confirm.session_id,
            attempt=attempt,
        )
        if attempt < CONFIRM_MAX_FAILURES:
            await _refuse(db, actor_id, confirm, failure)
        await _end_session(db, actor_id, confirm, failure, notice=True)
    await confirm.redis.delete(_failures_key(confirm.session_id))
