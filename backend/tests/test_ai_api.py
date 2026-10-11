"""Маршруты ИИ участника: лимит и расход (/api/ai/budget), свой ключ Claude, режим ключа,
просьба вернуть ключ администратора и свой потолок (/api/me/ai-*). Ответы Anthropic
подменены через транспорт httpx2 (tests/claude_mock.py), сети нет."""

import logging
from collections.abc import Iterator
from decimal import Decimal as D
from typing import Any

import httpx2
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import crypto
from app.db.models import AiLimit, Notification, User, UserSecret
from app.services.admin_users import month_start
from app.services.claude_key import SECRET_KIND
from app.services.sessions import utcnow
from tests.claude_mock import KEY, ClaudeMock, api_error, installed_mock, seed_prices
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.helpers_ai import MODELS, analysis, key_api, no_key_in, set_admin_key, spend
from tests.support import ClientFactory, LoginFn, MadeUser, UserFactory


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


async def fresh_user(db: AsyncSession, user: MadeUser) -> User:
    return await db.get_one(User, user.id, populate_existing=True)


async def secret_of(db: AsyncSession, user_id: int) -> UserSecret | None:
    row: UserSecret | None = await db.scalar(
        select(UserSecret)
        .where(UserSecret.user_id == user_id, UserSecret.kind == SECRET_KIND)
        .execution_options(populate_existing=True)
    )
    return row


# --- /api/ai/budget ---


async def test_budget_needs_login(make_client: ClientFactory) -> None:
    anonymous = await make_client()
    response = await anonymous.get("/api/ai/budget")
    assert response.status_code == 401


async def test_member_budget_on_admin_key(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    member = await signed_in(make_client, make_user, login)
    other = await make_user()
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=D("10"),
            daily_analyses=5,
            per_analysis_usd=D("1"),
            own_per_analysis_usd=D("2.5"),
        )
    )
    await db.commit()
    done = await analysis(db, member.id, cost="0.30")
    await analysis(db, member.id, cost="0.10")
    await analysis(db, member.id, status="failed", cost="0.05")
    await spend(db, member.id, "0.30", analysis_id=done.id)
    await spend(db, member.id, "0.15")
    # Проверочные прогоны, свой ключ и чужой расход в лимит не входят
    await spend(db, member.id, "4", kind="eval")
    await spend(db, member.id, "3", kind="shadow")
    await spend(db, member.id, "2", key_source="own")
    await spend(db, other.id, "1")

    response = await member.client.get("/api/ai/budget")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "shared"
    assert body["key_source"] == "admin"
    assert body["has_key"] is True
    assert body["monthly_usd"] == 10.0
    assert body["spent_usd"] == pytest.approx(0.45)
    assert body["left_usd"] == pytest.approx(9.55)
    assert body["daily_analyses"] == 5
    assert body["analyses_today"] == 3
    assert body["analyses_month"] == 3
    assert body["per_analysis_usd"] == 1.0
    assert body["own_cap_usd"] == 2.5
    assert body["avg_analysis_usd"] == pytest.approx(0.20)
    assert body["alert_pct"] == 80
    assert body["paused"] is False
    assert body["own_key"] is None
    assert body["reason_code"] is None
    assert body["budget"] is None
    assert body["month_start"].startswith(month_start(utcnow()).date().isoformat())


async def test_member_budget_reason_without_admin_key(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/ai/budget")).json()
    assert body["has_key"] is False
    assert body["reason_code"] == "ai.no_admin_key"
    # Лимитов по умолчанию хватает и без строки ai_limits
    assert body["monthly_usd"] == 10.0
    assert body["avg_analysis_usd"] is None


async def test_member_budget_paused(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    member = await signed_in(make_client, make_user, login)
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=D("10"),
            daily_analyses=3,
            per_analysis_usd=D("1"),
            paused=True,
        )
    )
    await db.commit()
    body = (await member.client.get("/api/ai/budget")).json()
    assert body["paused"] is True
    assert body["reason_code"] == "ai.paused"


async def test_own_mode_budget(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    member = await signed_in(make_client, make_user, login, ai_mode="own")
    ciphertext, version = crypto.encrypt_str(KEY, crypto.aad_for(crypto.AAD_USER_SECRET, member.id))
    db.add(
        UserSecret(
            user_id=member.id,
            kind=SECRET_KIND,
            ciphertext=ciphertext,
            key_version=version,
            last4=KEY[-4:],
            verified_at=utcnow(),
        )
    )
    await db.commit()
    await spend(db, member.id, "1.25", key_source="own")
    await spend(db, member.id, "0.50")
    response = await member.client.get("/api/ai/budget")
    body = response.json()
    assert body["mode"] == "own"
    assert body["key_source"] == "own"
    assert body["has_key"] is True
    assert body["monthly_usd"] is None
    assert body["left_usd"] is None
    assert body["daily_analyses"] is None
    assert body["spent_usd"] == 1.25
    assert body["per_analysis_usd"] == 1.0
    assert body["own_key"]["last4"] == KEY[-4:]
    assert body["own_key"]["verified_at"] is not None
    assert body["reason_code"] is None
    no_key_in(response)


async def test_admin_budget_includes_overall_budget(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    await spend(db, admin.id, "1")
    await spend(db, member.id, "2")
    await spend(db, None, "0.50", kind="refresh")
    await spend(db, None, "5", kind="eval")
    body = (await admin.client.get("/api/ai/budget")).json()
    assert body["mode"] == "shared"
    assert body["monthly_usd"] is None
    assert body["daily_analyses"] is None
    assert body["spent_usd"] == 1.0
    budget = body["budget"]
    assert budget["budget_usd"] == 60.0
    assert budget["spent_usd"] == 3.5
    assert budget["background_usd"] == 0.5
    assert budget["eval_spent_usd"] == 5.0
    assert budget["eval_budget_usd"] == 25.0


# --- свой ключ ---


async def test_save_own_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await signed_in(make_client, make_user, login)
    key_api(claude)
    response = await member.client.put("/api/me/ai-key", json={"key": f"  {KEY}  "})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["mode"] == "own"
    assert body["has_key"] is True
    assert body["last4"] == KEY[-4:]
    assert body["check"] == "ok"
    assert body["verified_at"] is not None
    assert body["models"] == [{"model": m, "available": True} for m in MODELS]
    no_key_in(response)
    assert claude.keys == [KEY] * 4
    assert (await fresh_user(db, member.user)).ai_mode == "own"
    secret = await secret_of(db, member.id)
    assert secret is not None and secret.last4 == KEY[-4:]
    assert KEY.encode() not in secret.ciphertext
    aad = crypto.aad_for(crypto.AAD_USER_SECRET, member.id)
    assert crypto.decrypt_str(secret.ciphertext, secret.key_version, aad) == KEY


@pytest.mark.parametrize(
    ("replies", "status", "code"),
    [
        ([api_error(401, "authentication_error")], 400, "ai.key_rejected"),
        ([api_error(400, "invalid_request_error")], 502, "ai.key_check_failed"),
        # Проверка ключа повторяет запрос один раз
        ([httpx2.ConnectError("no route")] * 2, 503, "ai.key_unavailable"),
    ],
)
async def test_own_key_not_saved_when_check_fails(
    replies: list[Any],
    status: int,
    code: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await signed_in(make_client, make_user, login)
    claude.add(*replies)
    response = await member.client.put("/api/me/ai-key", json={"key": KEY})
    assert response.status_code == status, response.text
    assert error_code(response) == code
    no_key_in(response)
    assert await secret_of(db, member.id) is None
    assert (await fresh_user(db, member.user)).ai_mode == "shared"


async def test_own_key_missing_model(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await signed_in(make_client, make_user, login)
    key_api(claude, missing=("claude-opus-5-5",))
    response = await member.client.put("/api/me/ai-key", json={"key": KEY})
    assert response.status_code == 400
    assert error_code(response) == "ai.key_models"
    assert response.json()["error"]["models"] == "claude-opus-5-5"
    assert await secret_of(db, member.id) is None


async def test_own_key_format_checked_before_network(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, claude: ClaudeMock
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.put("/api/me/ai-key", json={"key": "sk-proj-123"})
    assert response.status_code == 400
    assert error_code(response) == "ai.key_format"
    assert claude.requests == []
    empty = await member.client.put("/api/me/ai-key", json={"key": ""})
    assert empty.status_code == 422


async def test_check_and_delete_own_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await signed_in(make_client, make_user, login)
    missing = await member.client.post("/api/me/ai-key/check")
    assert missing.status_code == 404
    assert error_code(missing) == "ai.no_own_key"

    key_api(claude)
    assert (await member.client.put("/api/me/ai-key", json={"key": KEY})).status_code == 200
    key_api(claude)
    ok = await member.client.post("/api/me/ai-key/check")
    assert ok.status_code == 200
    assert ok.json()["check"] == "ok"
    assert len(ok.json()["models"]) == 3

    claude.add(api_error(401, "authentication_error"))
    rejected = await member.client.post("/api/me/ai-key/check")
    assert rejected.status_code == 200
    body = rejected.json()
    assert body["check"] == "rejected"
    assert body["verified_at"] is None
    assert body["last_error"] == "rejected:401"
    no_key_in(rejected)

    deleted = await member.client.delete("/api/me/ai-key")
    assert deleted.status_code == 200
    assert deleted.json()["has_key"] is False
    # Участник остается на своем ключе: обратно — только с разрешения администратора
    assert deleted.json()["mode"] == "own"
    assert await secret_of(db, member.id) is None


async def test_admin_has_no_own_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    for method, url, body in (
        ("PUT", "/api/me/ai-key", {"key": KEY}),
        ("PUT", "/api/me/ai-mode", {"mode": "own"}),
        ("PUT", "/api/me/ai-cap", {"per_analysis_usd": "2"}),
    ):
        response = await admin.client.request(method, url, json=body)
        assert response.status_code == 409, (url, response.text)
        assert error_code(response) == "ai.admin_key_only"
    assert claude.requests == []
    request = await admin.client.post("/api/me/ai-mode/return-request")
    assert request.status_code == 409
    assert (await fresh_user(db, admin.user)).ai_mode == "shared"


# --- режим и просьба вернуть ключ администратора ---


async def test_mode_switch_rules(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await signed_in(make_client, make_user, login)
    no_key = await member.client.put("/api/me/ai-mode", json={"mode": "own"})
    assert no_key.status_code == 409
    assert error_code(no_key) == "ai.no_own_key"

    key_api(claude)
    assert (await member.client.put("/api/me/ai-key", json={"key": KEY})).status_code == 200
    back = await member.client.put("/api/me/ai-mode", json={"mode": "shared"})
    assert back.status_code == 403
    assert error_code(back) == "ai.return_needs_admin"
    same = await member.client.put("/api/me/ai-mode", json={"mode": "own"})
    assert same.status_code == 200
    assert same.json()["mode"] == "own"
    bad = await member.client.put("/api/me/ai-mode", json={"mode": "free"})
    assert bad.status_code == 422


async def test_return_request_and_cancel(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    admin = await make_user(role="admin")
    member = await signed_in(make_client, make_user, login, ai_mode="own")
    shared = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    not_own = await shared.client.post("/api/me/ai-mode/return-request")
    assert not_own.status_code == 409
    assert error_code(not_own) == "ai.already_shared"

    first = await member.client.post("/api/me/ai-mode/return-request")
    assert first.status_code == 200
    again = await member.client.post("/api/me/ai-mode/return-request")
    assert again.json()["requested_at"] == first.json()["requested_at"]
    notes = list(
        await db.scalars(
            select(Notification).where(
                Notification.user_id == admin.id, Notification.kind == "ai_mode_request"
            )
        )
    )
    assert len(notes) == 1
    assert notes[0].link == "/admin/users"

    cancel = await member.client.delete("/api/me/ai-mode/return-request")
    assert cancel.status_code == 204
    left = await db.scalar(select(Notification.id).where(Notification.kind == "ai_mode_request"))
    assert left is None
    row = await db.scalar(
        select(AiLimit)
        .where(AiLimit.user_id == member.id)
        .execution_options(populate_existing=True)
    )
    assert row is not None and row.return_requested_at is None


async def test_own_cap(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login, ai_mode="own")
    low = await member.client.put("/api/me/ai-cap", json={"per_analysis_usd": "0.05"})
    assert low.status_code == 400
    assert error_code(low) == "ai.own_cap_range"
    high = await member.client.put("/api/me/ai-cap", json={"per_analysis_usd": 25})
    assert error_code(high) == "ai.own_cap_range"
    many = await member.client.put("/api/me/ai-cap", json={"per_analysis_usd": "1.234"})
    assert many.status_code == 422
    ok = await member.client.put("/api/me/ai-cap", json={"per_analysis_usd": "2.50"})
    assert ok.status_code == 200
    assert ok.json() == {"per_analysis_usd": 2.5}
    body = (await member.client.get("/api/ai/budget")).json()
    assert body["own_cap_usd"] == 2.5
    assert body["per_analysis_usd"] == 2.5


# --- CSRF ---


@pytest.mark.parametrize(
    ("method", "url", "body"),
    [
        ("PUT", "/api/me/ai-key", {"key": KEY}),
        ("DELETE", "/api/me/ai-key", None),
        ("POST", "/api/me/ai-key/check", None),
        ("PUT", "/api/me/ai-mode", {"mode": "own"}),
        ("POST", "/api/me/ai-mode/return-request", None),
        ("DELETE", "/api/me/ai-mode/return-request", None),
        ("PUT", "/api/me/ai-cap", {"per_analysis_usd": "2"}),
    ],
)
async def test_unsafe_routes_need_csrf(
    method: str,
    url: str,
    body: dict[str, Any] | None,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    member = await make_user(ai_mode="own")
    plain = await login(await make_client(csrf=False), member)
    response = await plain.request(method, url, json=body)
    assert response.status_code == 403
    assert error_code(response) == "common.csrf"
    assert claude.requests == []
    assert await secret_of(db, member.id) is None


async def test_key_not_in_logs(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    claude: ClaudeMock,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    caplog.set_level(logging.DEBUG)
    member = await signed_in(make_client, make_user, login)
    claude.add(api_error(401, "authentication_error"))
    await member.client.put("/api/me/ai-key", json={"key": KEY})
    key_api(claude)
    await member.client.put("/api/me/ai-key", json={"key": KEY})
    await member.client.put("/api/me/ai-key", json={"key": KEY + "\x00" * 600})
    admin = await admin_signed_in(make_client, make_user, login)
    await admin.client.put("/api/admin/ai/key", json={"key": KEY, "totp_code": "12"})
    printed = capsys.readouterr()
    for text in (caplog.text, printed.out, printed.err):
        assert KEY not in text
        assert KEY[:-4] not in text
