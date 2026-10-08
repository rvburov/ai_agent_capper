"""Подтверждение опасных действий администратора текущим кодом 2FA (PLAN.md, раздел 7:
захват сеанса администратора без его телефона не дает выполнить опасное действие).

Опасные действия из кабинета: смена роли, сброс 2FA, удаление участника и приглашение
с ролью admin (оно выдает те же права, что и смена роли). Команды терминала код не
спрашивают: доступ к серверу уже подтверждает владельца.

Отдельный модуль, потому что проверку зовут и admin_users, и access_codes, а admin_users
сам импортирует access_codes.
"""

from dataclasses import dataclass
from typing import Any, cast

from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.redis import redis_key
from app.core.security import crypto
from app.core.security.totp import verify_totp
from app.db.models import User
from app.services.two_factor import consume_totp_step

# Неверные коды 2FA при подтверждении действий: не больше 5 за 15 минут на
# администратора, затем пауза до конца окна. Верный код неудачей не считается
TOTP_CONFIRM_LIMIT = 5
TOTP_CONFIRM_WINDOW_SECONDS = 15 * 60

# KEYS: счетчик. Отменяет одну зарезервированную попытку, ниже нуля не опускается
_RELEASE_LUA = """
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then redis.call('DECR', KEYS[1]) end
return 0
"""


@dataclass(frozen=True)
class TotpConfirm:
    """Код 2FA администратора из тела запроса и Redis для счетчика неудач."""

    redis: Redis
    code: str


async def check_totp(db: AsyncSession, actor: User, confirm: TotpConfirm | None) -> None:
    """Текущий код 2FA администратора. Нет кода, неверный или уже использованный — 403
    totp_required; после 5 неудач за 15 минут — 429 totp_rate_limited.

    Попытка резервируется в Redis до проверки кода (INCR), поэтому параллельные запросы
    не проверят больше 5 кодов. Принятый код записывается в totp_last_step одним
    условным UPDATE (consume_totp_step) и второй раз не сработает. Commit делает
    вызывающий сервис вместе с самим действием; если действие не выполнено, откат
    возвращает код в строй.
    """
    if (
        confirm is None
        or not actor.totp_enabled
        or actor.totp_secret_enc is None
        or actor.totp_key_version is None
    ):
        raise AppError(403, "admin.totp_required")
    redis = confirm.redis
    key = redis_key("rl", "admin_totp", actor.id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, TOTP_CONFIRM_WINDOW_SECONDS, nx=True)
        attempts = int((await pipe.execute())[0])
    if attempts > TOTP_CONFIRM_LIMIT:
        wait = max(int(await redis.ttl(key)), 1)
        raise AppError(429, "admin.totp_rate_limited", retry_after=wait)
    secret = crypto.decrypt_str(
        actor.totp_secret_enc,
        actor.totp_key_version,
        crypto.aad_for(crypto.AAD_TOTP_SECRET, actor.id),
    )
    step = verify_totp(secret, confirm.code, last_step=actor.totp_last_step)
    if step is None or not await consume_totp_step(db, actor.id, step):
        raise AppError(403, "admin.totp_required")
    await cast(Any, redis.eval(_RELEASE_LUA, 1, key))
