"""Журнал действий администратора: имена, терминал, страницы по before_id, фильтр."""

from typing import get_args

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AI_MODES, AUDIT_ACTIONS, ROLES, USER_STATUSES
from app.schemas.admin import AuditAction, CodeStatus
from app.schemas.me import AiMode, Role, UserStatus
from app.services.audit import write_audit
from tests.helpers_admin import ADMIN_IP, admin_signed_in
from tests.support import ClientFactory, LoginFn, UserFactory


async def test_audit_list_names_and_pagination(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login, display_name="Роман")
    member = await make_user(display_name="Ольга")
    await write_audit(db, action="create_admin", actor_id=None, details={"email": "a@b.c"})
    await db.commit()
    for _ in range(3):
        assert (await admin.client.post(f"/api/admin/users/{member.id}/block")).is_success
        assert (await admin.client.post(f"/api/admin/users/{member.id}/unblock")).is_success

    first_page = await admin.client.get("/api/admin/audit", params={"limit": 4})
    assert first_page.status_code == 200
    rows = first_page.json()
    assert [row["action"] for row in rows] == ["unblock", "block", "unblock", "block"]
    newest = rows[0]
    assert newest["actor_id"] == admin.id
    assert newest["actor_name"] == "Роман"
    assert newest["target_user_id"] == member.id
    assert newest["target_name"] == "Ольга"
    assert newest["ip"] == ADMIN_IP

    second_page = await admin.client.get(
        "/api/admin/audit", params={"limit": 4, "before_id": rows[-1]["id"]}
    )
    rest = second_page.json()
    assert [row["action"] for row in rest] == ["unblock", "block", "create_admin"]
    terminal = rest[-1]
    assert terminal["actor_id"] is None and terminal["actor_name"] == ""
    assert terminal["target_name"] == ""
    assert terminal["details"] == {"email": "a@b.c", "source": "terminal"}
    ids = [row["id"] for row in rows + rest]
    assert ids == sorted(ids, reverse=True) and len(set(ids)) == 7

    only_blocks = await admin.client.get(
        "/api/admin/audit", params=[("action", "block"), ("action", "create_admin")]
    )
    assert [row["action"] for row in only_blocks.json()] == [
        "block",
        "block",
        "block",
        "create_admin",
    ]
    assert (await admin.client.get("/api/admin/audit?action=hack")).status_code == 422
    assert (await admin.client.get("/api/admin/audit?limit=0")).status_code == 422
    assert (await admin.client.get("/api/admin/audit?limit=201")).status_code == 422


def test_schema_enums_match_database() -> None:
    """Перечисления в схемах ответа совпадают с CHECK в базе: новое действие журнала
    без правки схемы уронило бы ответ GET /api/admin/audit."""
    assert set(get_args(AuditAction)) == set(AUDIT_ACTIONS)
    assert set(get_args(Role)) == set(ROLES)
    assert set(get_args(AiMode)) == set(AI_MODES)
    assert set(get_args(UserStatus)) == set(USER_STATUSES)
    assert set(get_args(CodeStatus)) == {"active", "used", "expired", "revoked"}
