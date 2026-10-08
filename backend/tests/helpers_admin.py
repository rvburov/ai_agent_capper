"""Помощники тестов кабинета администратора: вошедший администратор, участник
со своим клиентом, записи журнала."""

from dataclasses import dataclass
from typing import Any

import httpx2
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AdminAuditLog
from tests.support import ClientFactory, LoginFn, MadeUser, UserFactory

ADMIN_IP = "10.0.0.7"


@dataclass
class Signed:
    """Пользователь и его клиент (как отдельный браузер) с действующим сеансом."""

    user: MadeUser
    client: httpx2.AsyncClient

    @property
    def id(self) -> int:
        return self.user.id


async def signed_in(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    *,
    ip: str = "10.0.0.1",
    **user_fields: Any,
) -> Signed:
    user = await make_user(**user_fields)
    client = await login(await make_client(ip), user)
    return Signed(user=user, client=client)


async def admin_signed_in(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, **user_fields: Any
) -> Signed:
    return await signed_in(make_client, make_user, login, ip=ADMIN_IP, role="admin", **user_fields)


async def audit_entries(db: AsyncSession, action: str | None = None) -> list[AdminAuditLog]:
    """Записи журнала по порядку (свежие данные, мимо кэша сеанса)."""
    stmt = (
        select(AdminAuditLog).order_by(AdminAuditLog.id).execution_options(populate_existing=True)
    )
    if action is not None:
        stmt = stmt.where(AdminAuditLog.action == action)
    return list(await db.scalars(stmt))


def error_code(response: httpx2.Response) -> str:
    return str(response.json()["error"]["code"])
