"""Профиль в личном кабинете: PATCH /api/me (имя и часовой пояс) и
GET /api/me/recovery-codes (сколько резервных кодов осталось)."""

import httpx2
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from tests.helpers_auth import code_step, password_step
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory


async def _stored(db: AsyncSession, user_id: int) -> tuple[str, str, str, str]:
    row = (
        await db.execute(
            select(User.display_name, User.tz, User.email, User.role).where(User.id == user_id)
        )
    ).one()
    return row[0], row[1], row[2], row[3]


async def test_patch_me_requires_session(client: httpx2.AsyncClient) -> None:
    response = await client.patch("/api/me", json={"display_name": "Иван"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.not_authenticated"


async def test_patch_me_requires_csrf(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user(display_name="Иван")
    browser = await login(await make_client(csrf=False), member)
    response = await browser.patch("/api/me", json={"display_name": "Петр"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "common.csrf"
    assert (await _stored(db, member.id))[0] == "Иван"


async def test_patch_me_updates_name_and_tz(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user(display_name="Иван", tz="Europe/Helsinki")
    await login(client, member)

    response = await client.patch(
        "/api/me", json={"display_name": "  Иван Петров  ", "tz": "America/New_York"}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["display_name"] == "Иван Петров"
    assert body["tz"] == "America/New_York"
    assert body["id"] == member.id and body["email"] == member.email
    assert (await client.get("/api/me")).json() == body
    assert (await _stored(db, member.id))[:2] == ("Иван Петров", "America/New_York")


async def test_patch_me_changes_only_given_fields(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user(display_name="Иван", tz="Europe/Berlin")
    await login(client, member)

    only_tz = await client.patch("/api/me", json={"tz": "America/Chicago"})
    assert only_tz.status_code == 200
    assert (await _stored(db, member.id))[:2] == ("Иван", "America/Chicago")

    only_name = await client.patch("/api/me", json={"display_name": "Ольга", "tz": None})
    assert only_name.status_code == 200
    assert (await _stored(db, member.id))[:2] == ("Ольга", "America/Chicago")

    # Пустое тело — ничего не меняется, ответ — текущий профиль
    nothing = await client.patch("/api/me", json={})
    assert nothing.status_code == 200
    assert nothing.json()["display_name"] == "Ольга"


@pytest.mark.parametrize(
    "body",
    [
        {"display_name": "И"},
        {"display_name": "   "},
        {"display_name": "Я" * 101},
        {"display_name": "Иван\x00"},
        {"display_name": 5},
        {"tz": "Mars/Olympus"},
        {"tz": "europe/helsinki"},
        {"tz": "../../etc/passwd"},
        {"tz": "localtime"},
        {"tz": "Factory"},
        {"tz": ""},
        {"tz": "Europe/Helsinki\x00"},
    ],
)
async def test_patch_me_rejects_invalid_values(
    client: httpx2.AsyncClient,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    body: dict[str, object],
) -> None:
    member = await make_user(display_name="Иван", tz="Europe/Helsinki")
    await login(client, member)
    response = await client.patch("/api/me", json=body)
    assert response.status_code == 422, response.text
    error = response.json()["error"]
    assert error["code"] == "validation"
    assert error["fields"][0]["loc"][-1] in {"display_name", "tz"}
    assert (await _stored(db, member.id))[:2] == ("Иван", "Europe/Helsinki")


@pytest.mark.parametrize(
    "extra",
    [
        {"email": "evil@example.com"},
        {"role": "admin"},
        {"status": "active"},
        {"ai_mode": "own"},
        {"totp_enabled": False},
        {"id": 1},
    ],
)
async def test_patch_me_cannot_change_protected_fields(
    client: httpx2.AsyncClient,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    extra: dict[str, object],
) -> None:
    member = await make_user(display_name="Иван")
    await login(client, member)
    response = await client.patch("/api/me", json={"display_name": "Петр", **extra})
    assert response.status_code == 422, response.text
    name, _, email, role = await _stored(db, member.id)
    assert (name, email, role) == ("Иван", member.email, "member")


async def test_patch_me_touches_only_own_profile(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    alice_user = await make_user(display_name="Алиса", tz="Europe/Helsinki")
    bob_user = await make_user(display_name="Борис", tz="Europe/Helsinki")
    alice = await login(await make_client("10.0.0.1"), alice_user)
    bob = await login(await make_client("10.0.0.2"), bob_user)

    assert (await alice.patch("/api/me", json={"tz": "America/Denver"})).status_code == 200
    assert (await _stored(db, alice_user.id))[1] == "America/Denver"
    assert (await _stored(db, bob_user.id))[1] == "Europe/Helsinki"
    assert (await bob.get("/api/me")).json()["tz"] == "Europe/Helsinki"


async def test_recovery_codes_status_requires_session(client: httpx2.AsyncClient) -> None:
    response = await client.get("/api/me/recovery-codes")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "auth.not_authenticated"


async def test_recovery_codes_status(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
) -> None:
    member = await make_user()
    other = await make_user()
    owner = await login(await make_client("10.0.0.1"), member)
    stranger = await login(await make_client("10.0.0.2"), other)

    empty = (await owner.get("/api/me/recovery-codes")).json()
    assert empty == {"left": 0, "total": 0, "created_at": None}

    issued = await owner.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    codes = issued.json()["recovery_codes"]
    fresh = (await owner.get("/api/me/recovery-codes")).json()
    assert (fresh["left"], fresh["total"]) == (8, 8)
    assert fresh["created_at"] is not None
    # Чужие коды не считаются
    assert (await stranger.get("/api/me/recovery-codes")).json()["total"] == 0

    # Вход резервным кодом тратит один код
    browser = await make_client("10.0.0.3")
    assert (await password_step(browser, member)).json()["status"] == "totp_required"
    assert (await code_step(browser, recovery_code=codes[0])).json()["status"] == "ok"
    used = (await owner.get("/api/me/recovery-codes")).json()
    assert (used["left"], used["total"]) == (7, 8)
    assert used["created_at"] == fresh["created_at"]
