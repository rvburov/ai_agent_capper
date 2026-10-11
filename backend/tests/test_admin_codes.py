"""Приглашения и коды сброса пароля в кабинете администратора."""

import json
import re
from datetime import timedelta
from decimal import Decimal

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security.tokens import hash_code
from app.db.models import AccessCode, AppSettings
from app.services import access_codes
from app.services.sessions import utcnow
from tests.helpers_admin import ADMIN_IP, admin_signed_in, audit_entries, error_code
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

DELETED_NAME = "Удаленный пользователь"

INVITE_CODE = re.compile(r"^CAP-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")
RESET_CODE = re.compile(r"^RST-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$")


async def _codes(db: AsyncSession) -> list[AccessCode]:
    stmt = select(AccessCode).order_by(AccessCode.id).execution_options(populate_existing=True)
    return list(await db.scalars(stmt))


# --- приглашения ---


async def test_create_invite_shows_code_once_and_stores_hash(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login, display_name="Роман")
    response = await admin.client.post(
        "/api/admin/invites",
        json={
            "email": "  Olga@Example.com ",
            "role": "member",
            "ai_mode": "shared",
            "limit": {"monthly_usd": "12.50", "daily_analyses": 5, "per_analysis_usd": 0.75},
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    code = body["code"]
    assert INVITE_CODE.match(code)
    invite = body["invite"]
    assert invite["email"] == "olga@example.com"
    assert invite["status"] == "active"
    assert invite["created_by_name"] == "Роман"
    assert invite["limit"] == {"monthly_usd": 12.5, "daily_analyses": 5, "per_analysis_usd": 0.75}
    assert "code" not in invite

    [row] = await _codes(db)
    assert row.kind == "invite"
    assert row.code_hash == hash_code(code)
    assert code not in row.code_hash
    assert row.limit_monthly_usd == Decimal("12.50")
    assert row.limit_daily_analyses == 5
    assert row.limit_per_analysis_usd == Decimal("0.75")
    assert row.ai_mode == "shared" and row.role == "member"
    days = (row.expires_at - row.created_at).total_seconds() / 86400
    assert round(days, 3) == 7

    # Код больше нигде не показывается: ни в списке, ни в журнале
    listing = await admin.client.get("/api/admin/invites")
    assert code not in listing.text
    [entry] = await audit_entries(db, "invite")
    assert code not in json.dumps(entry.details)
    assert entry.actor_id == admin.id and entry.ip == ADMIN_IP
    assert entry.details["email"] == "olga@example.com"
    assert entry.details["limit"] == {
        "monthly_usd": "12.50",
        "daily_analyses": 5,
        "per_analysis_usd": "0.75",
    }


async def test_invite_default_limit_and_own_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await db.execute(
        update(AppSettings).values(default_member_limit_usd=Decimal("8"), default_daily_analyses=4)
    )
    await db.commit()
    shared = await admin.client.post("/api/admin/invites", json={"email": "a@example.com"})
    assert shared.status_code == 201
    assert shared.json()["invite"]["limit"] == {
        "monthly_usd": 8.0,
        "daily_analyses": 4,
        "per_analysis_usd": 1.0,
    }
    own = await admin.client.post(
        "/api/admin/invites",
        json={
            "email": "b@example.com",
            "role": "admin",
            "ai_mode": "own",
            "limit": {"monthly_usd": 5, "daily_analyses": 1, "per_analysis_usd": 1},
            "totp_code": await totp_code(admin.user),
        },
    )
    assert own.status_code == 201, own.text
    assert own.json()["invite"]["limit"] is None
    assert own.json()["invite"]["role"] == "admin"
    rows = await _codes(db)
    assert rows[1].ai_mode == "own" and rows[1].limit_monthly_usd is None


async def test_admin_invite_requires_totp(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Приглашение администратора выдает те же права, что смена роли: с угнанным сеансом
    без телефона его не создать (PLAN.md, раздел 7)."""
    admin = await admin_signed_in(make_client, make_user, login)
    url = "/api/admin/invites"
    missing = await admin.client.post(url, json={"email": "boss@example.com", "role": "admin"})
    assert missing.status_code == 403
    assert error_code(missing) == "admin.totp_required"

    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    bad = await admin.client.post(
        url, json={"email": "boss@example.com", "role": "admin", "totp_code": wrong}
    )
    assert bad.status_code == 403
    assert error_code(bad) == "admin.totp_invalid"
    [failed] = await audit_entries(db, "confirm_failed")
    assert failed.actor_id == admin.id and failed.target_user_id is None
    assert failed.details == {"action": "invite", "attempt": 1, "session_ended": False}
    malformed = await admin.client.post(
        url, json={"email": "boss@example.com", "role": "admin", "totp_code": "12ab"}
    )
    assert malformed.status_code == 422
    assert await _codes(db) == []
    assert await audit_entries(db, "invite") == []

    ok = await admin.client.post(
        url, json={"email": "boss@example.com", "role": "admin", "totp_code": good}
    )
    assert ok.status_code == 201, ok.text
    assert ok.json()["invite"]["role"] == "admin"
    # Тот же код второй раз не принимается
    replay = await admin.client.post(
        url, json={"email": "boss2@example.com", "role": "admin", "totp_code": good}
    )
    assert replay.status_code == 403

    # Участнику код не нужен
    member = await admin.client.post(url, json={"email": "member@example.com"})
    assert member.status_code == 201
    [row_admin, row_member] = await _codes(db)
    assert row_admin.role == "admin" and row_member.role == "member"


async def test_invite_email_taken_and_duplicate(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await make_user(email="taken@example.com")
    response = await admin.client.post("/api/admin/invites", json={"email": "TAKEN@example.com"})
    assert response.status_code == 409
    assert error_code(response) == "admin.email_taken"

    assert (await admin.client.post("/api/admin/invites", json={"email": "new@x.io"})).is_success
    again = await admin.client.post("/api/admin/invites", json={"email": "New@X.io"})
    assert again.status_code == 409
    assert error_code(again) == "admin.invite_exists"

    for bad in ("not-an-email", "a@b", ""):
        response = await admin.client.post("/api/admin/invites", json={"email": bad})
        assert response.status_code == 422
    negative = await admin.client.post(
        "/api/admin/invites",
        json={
            "email": "neg@example.com",
            "limit": {"monthly_usd": -1, "daily_analyses": 1, "per_analysis_usd": 1},
        },
    )
    assert negative.status_code == 422


async def test_invite_limit_bounds_match_member_limits(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    # Границы стартового лимита — как у лимитов участника и в форме приглашения:
    # в месяц $1–500, анализов в день 1–30, на анализ от $0,10 и не выше месячного лимита
    admin = await admin_signed_in(make_client, make_user, login)
    bad_limits = [
        {"monthly_usd": 0, "daily_analyses": 3, "per_analysis_usd": "0.50"},
        {"monthly_usd": 501, "daily_analyses": 3, "per_analysis_usd": 1},
        {"monthly_usd": 10, "daily_analyses": 0, "per_analysis_usd": 1},
        {"monthly_usd": 10, "daily_analyses": 31, "per_analysis_usd": 1},
        {"monthly_usd": 10, "daily_analyses": 3, "per_analysis_usd": "0.05"},
    ]
    for number, limit in enumerate(bad_limits):
        response = await admin.client.post(
            "/api/admin/invites", json={"email": f"bound{number}@example.com", "limit": limit}
        )
        assert response.status_code == 422, limit
    above = await admin.client.post(
        "/api/admin/invites",
        json={
            "email": "above@example.com",
            "limit": {"monthly_usd": 5, "daily_analyses": 3, "per_analysis_usd": 6},
        },
    )
    assert above.status_code == 400
    assert error_code(above) == "ai.cap_above_month"
    assert await _codes(db) == []
    edge = await admin.client.post(
        "/api/admin/invites",
        json={
            "email": "edge@example.com",
            "limit": {"monthly_usd": 1, "daily_analyses": 30, "per_analysis_usd": 1},
        },
    )
    assert edge.status_code == 201


async def test_invite_email_with_nul_is_rejected(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    # PostgreSQL не хранит NUL в тексте: без проверки схемы запрос падал бы с 500
    admin = await admin_signed_in(make_client, make_user, login)
    for email in ("olga\x00@example.com", "olga@exa\x00mple.com", "olga@example.c\x00om"):
        response = await admin.client.post(
            "/api/admin/invites", json={"email": email, "role": "member", "ai_mode": "shared"}
        )
        assert response.status_code == 422, response.text
        assert error_code(response) == "validation"
    assert await _codes(db) == []


async def test_invites_by_status_and_revoke(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(display_name="Алексей")
    ids: dict[str, int] = {}
    for name in ("active", "used", "expired", "revoked"):
        created = await admin.client.post(
            "/api/admin/invites", json={"email": f"{name}@example.com"}
        )
        ids[name] = created.json()["invite"]["id"]
    now = utcnow()
    await db.execute(
        update(AccessCode)
        .where(AccessCode.id == ids["used"])
        .values(used_at=now, used_by=member.id)
    )
    await db.execute(
        update(AccessCode)
        .where(AccessCode.id == ids["expired"])
        .values(expires_at=now - timedelta(minutes=1))
    )
    await db.commit()
    revoke = await admin.client.delete(f"/api/admin/invites/{ids['revoked']}")
    assert revoke.status_code == 204

    everything = (await admin.client.get("/api/admin/invites")).json()
    assert {row["status"] for row in everything} == {"active", "used", "expired", "revoked"}
    for status, invite_id in ids.items():
        rows = (await admin.client.get("/api/admin/invites", params={"status": status})).json()
        assert [row["id"] for row in rows] == [invite_id], status
    used = next(row for row in everything if row["id"] == ids["used"])
    assert used["used_by_name"] == "Алексей"
    revoked = next(row for row in everything if row["id"] == ids["revoked"])
    assert revoked["revoked_at"] is not None

    for status in ("used", "expired", "revoked"):
        response = await admin.client.delete(f"/api/admin/invites/{ids[status]}")
        assert response.status_code == 409
        assert error_code(response) == "admin.code_inactive"
    assert (await admin.client.delete("/api/admin/invites/999999")).status_code == 404
    assert (await admin.client.get("/api/admin/invites?status=bad")).status_code == 422

    [entry] = await audit_entries(db, "invite_revoke")
    assert entry.actor_id == admin.id
    assert entry.details == {"invite_id": ids["revoked"], "email": "revoked@example.com"}


# --- коды сброса пароля ---


async def test_reset_code_replaces_previous_and_can_be_revoked(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login, display_name="Роман")
    member = await make_user(display_name="Ольга", email="olga@example.com")

    first = await admin.client.post("/api/admin/reset-codes", json={"user_id": member.id})
    assert first.status_code == 201, first.text
    first_body = first.json()
    assert RESET_CODE.match(first_body["code"])
    assert first_body["reset_code"]["user_name"] == "Ольга"
    assert first_body["reset_code"]["user_email"] == "olga@example.com"
    assert first_body["reset_code"]["created_by_name"] == "Роман"
    [row] = await _codes(db)
    assert round((row.expires_at - row.created_at).total_seconds() / 3600, 3) == 24

    second = await admin.client.post("/api/admin/reset-codes", json={"user_id": member.id})
    assert second.status_code == 201
    second_body = second.json()
    rows = await _codes(db)
    assert [row.code_hash for row in rows] == [
        hash_code(first_body["code"]),
        hash_code(second_body["code"]),
    ]
    assert rows[0].revoked_at is not None and rows[1].revoked_at is None

    listing = (await admin.client.get("/api/admin/reset-codes")).json()
    assert [(row["id"], row["status"]) for row in listing] == [
        (second_body["reset_code"]["id"], "active"),
        (first_body["reset_code"]["id"], "revoked"),
    ]
    active = (await admin.client.get("/api/admin/reset-codes?status=active")).json()
    assert [row["id"] for row in active] == [second_body["reset_code"]["id"]]

    revoke = await admin.client.delete(f"/api/admin/reset-codes/{second_body['reset_code']['id']}")
    assert revoke.status_code == 204
    again = await admin.client.delete(f"/api/admin/reset-codes/{second_body['reset_code']['id']}")
    assert again.status_code == 409

    entries = await audit_entries(db, "reset_code")
    assert [e.details["replaced"] for e in entries] == [0, 1]
    assert all(e.target_user_id == member.id and e.actor_id == admin.id for e in entries)
    assert all(first_body["code"] not in json.dumps(e.details) for e in entries)
    [revoked] = await audit_entries(db, "reset_code_revoke")
    assert revoked.target_user_id == member.id


async def test_reset_code_for_admin_or_missing_user(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    other_admin = await make_user(role="admin")
    gone = await make_user(status="deleted")
    for target in (admin.id, other_admin.id):
        response = await admin.client.post("/api/admin/reset-codes", json={"user_id": target})
        assert response.status_code == 403
        assert error_code(response) == "admin.reset_code_terminal_only"
    for target in (gone.id, 999999):
        response = await admin.client.post("/api/admin/reset-codes", json={"user_id": target})
        assert response.status_code == 404
    assert await _codes(db) == []


async def test_blocked_member_gets_reset_code(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    blocked = await make_user(status="blocked")
    response = await admin.client.post("/api/admin/reset-codes", json={"user_id": blocked.id})
    assert response.status_code == 201


async def test_deleted_author_does_not_look_like_terminal(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Пустое имя автора значит «команда терминала». Имя удаленного стерто, но его коды
    и записи журнала должны остаться его, а не терминала."""
    admin = await admin_signed_in(make_client, make_user, login, display_name="Роман")
    second = await admin_signed_in(
        make_client, make_user, login, display_name="Ирина", email="irina@example.com"
    )
    member = await make_user(display_name="Ольга")
    invite = await second.client.post("/api/admin/invites", json={"email": "new@example.com"})
    assert invite.status_code == 201
    reset = await second.client.post("/api/admin/reset-codes", json={"user_id": member.id})
    assert reset.status_code == 201
    terminal = await access_codes.create_reset_code(db, member.id, actor=None, ip=None)

    deleted = await admin.client.request(
        "DELETE",
        f"/api/admin/users/{second.id}",
        json={"confirm_email": "irina@example.com", "totp_code": await totp_code(admin.user)},
    )
    assert deleted.status_code == 204, deleted.text

    [listed_invite] = (await admin.client.get("/api/admin/invites")).json()
    assert listed_invite["id"] == invite.json()["invite"]["id"]
    assert listed_invite["created_by_name"] == DELETED_NAME
    names = {
        row["id"]: row["created_by_name"]
        for row in (await admin.client.get("/api/admin/reset-codes")).json()
    }
    assert names == {reset.json()["reset_code"]["id"]: DELETED_NAME, terminal.reset_code.id: ""}

    audit = (await admin.client.get("/api/admin/audit")).json()
    by_second = [row for row in audit if row["actor_id"] == second.id]
    assert {row["action"] for row in by_second} == {"invite", "reset_code"}
    assert all(row["actor_name"] == DELETED_NAME for row in by_second)
    [removal] = [row for row in audit if row["action"] == "delete"]
    assert removal["actor_name"] == "Роман"
    assert removal["target_name"] == DELETED_NAME
    [from_terminal] = [row for row in audit if row["actor_id"] is None]
    assert from_terminal["actor_name"] == "" and from_terminal["target_name"] == "Ольга"
