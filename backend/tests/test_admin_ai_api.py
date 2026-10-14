"""Кабинет администратора, «Ключ и бюджет»: ключ администратора с кодом 2FA, общий бюджет,
лимиты участников и по умолчанию, решение по просьбе вернуть ключ администратора (Р12).
Права (участник — 403) проверяет tests/test_admin_permissions.py по всем адресам
/api/admin/*. Ответы Anthropic подменены через транспорт httpx2, сети нет."""

import math
from collections.abc import Iterator
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_DOWN
from decimal import Decimal as D

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.core.security import crypto
from app.db.models import AdminAuditLog, AiLimit, AppSettings, Notification, User
from app.services import ai_keys
from app.services.ai_access import access_for, month_days, runs_out_on
from app.services.sessions import utcnow
from tests.claude_mock import KEY, OTHER_KEY, ClaudeMock, api_error, installed_mock, seed_prices
from tests.helpers_admin import admin_signed_in, audit_entries, error_code, signed_in
from tests.helpers_ai import analysis, key_api, no_key_in, set_admin_key, spend
from tests.helpers_auth import make_invite
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


async def settings_row(db: AsyncSession) -> AppSettings:
    return await db.get_one(AppSettings, 1, populate_existing=True)


async def limit_row(db: AsyncSession, user_id: int) -> AiLimit | None:
    row: AiLimit | None = await db.scalar(
        select(AiLimit).where(AiLimit.user_id == user_id).execution_options(populate_existing=True)
    )
    return row


# --- ключ администратора ---


async def test_admin_key_replace_with_2fa(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
    totp_code: TotpCodeFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await make_user()
    await make_user(ai_mode="own")
    await make_user(status="blocked")

    before = await admin.client.get("/api/admin/ai/key")
    assert before.status_code == 200
    assert before.json() == {
        "status": "missing",
        "last4": None,
        "verified_at": None,
        "users_on_key": 2,
    }

    # Без кода 2FA — ошибка проверки тела, ключ не проверяется
    no_code = await admin.client.put("/api/admin/ai/key", json={"key": KEY})
    assert no_code.status_code == 422
    assert claude.requests == []

    key_api(claude)
    response = await admin.client.put(
        "/api/admin/ai/key", json={"key": KEY, "totp_code": await totp_code(admin.user)}
    )
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "ok"
    assert body["last4"] == KEY[-4:]
    assert body["verified_at"] is not None
    assert body["users_on_key"] == 2
    no_key_in(response)
    assert claude.keys == [KEY] * 4

    row = await settings_row(db)
    assert row.anthropic_key_enc is not None and row.key_version is not None
    assert KEY.encode() not in row.anthropic_key_enc
    aad = crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    assert crypto.decrypt_str(row.anthropic_key_enc, row.key_version, aad) == KEY
    [entry] = await audit_entries(db, "key_change")
    assert entry.actor_id == admin.id
    assert entry.details == {"last4": KEY[-4:], "verified": True}
    assert KEY not in str(entry.details)

    after = (await admin.client.get("/api/admin/ai/key")).json()
    assert after["status"] == "ok"
    no_key_in(await admin.client.get("/api/admin/ai/key"))


async def test_admin_key_wrong_code_keeps_old_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await set_admin_key(db, KEY)
    response = await admin.client.put(
        "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": "000000"}
    )
    assert response.status_code == 403
    assert error_code(response) == "admin.totp_invalid"
    # Код 2FA проверяется до Anthropic: с угнанного сеанса чужой ключ не проверить
    assert claude.requests == []
    row = await settings_row(db)
    assert row.key_last4 == KEY[-4:]
    assert await audit_entries(db, "key_change") == []
    [failure] = await audit_entries(db, "confirm_failed")
    assert failure.details["action"] == "key_change"


async def test_admin_key_code_checked_before_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
    totp_code: TotpCodeFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    await set_admin_key(db, KEY)

    # Подбор ключей с неверным кодом: ни одного запроса к Anthropic, каждая попытка в
    # журнале, на пятой сеанс завершается
    for attempt in range(1, 5):
        guess = await admin.client.put(
            "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": "000000"}
        )
        assert guess.status_code == 403, attempt
    last = await admin.client.put(
        "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": "000000"}
    )
    assert last.status_code == 401
    assert error_code(last) == "auth.too_many_codes"
    assert claude.requests == []
    assert len(await audit_entries(db, "confirm_failed")) == 5

    admin = await signed_in(make_client, make_user, login, ip="10.0.0.8", role="admin")
    code = await totp_code(admin.user)
    # Неверный формат — до кода 2FA: код не тратится
    bad_format = await admin.client.put(
        "/api/admin/ai/key", json={"key": "sk-ant-short", "totp_code": code}
    )
    assert bad_format.status_code == 400
    assert error_code(bad_format) == "ai.key_format"
    fresh = await db.get_one(User, admin.id, populate_existing=True)
    assert fresh.totp_last_step is None

    # Ключ не принят: код уже потрачен, второй раз он не сработает и Anthropic не спросим
    claude.add(api_error(401, "authentication_error"))
    rejected = await admin.client.put(
        "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": code}
    )
    assert rejected.status_code == 400
    assert error_code(rejected) == "ai.key_rejected"
    no_key_in(rejected)
    fresh = await db.get_one(User, admin.id, populate_existing=True)
    assert fresh.totp_last_step is not None
    again = await admin.client.put("/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": code})
    assert again.status_code == 403
    assert error_code(again) == "admin.totp_invalid"
    assert len(claude.requests) == 1

    key_api(claude, missing=("claude-sonnet-5-5",))
    no_model = await admin.client.put(
        "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": await totp_code(admin.user)}
    )
    assert no_model.status_code == 400
    assert error_code(no_model) == "ai.key_models"
    assert (await settings_row(db)).key_last4 == KEY[-4:]
    assert await audit_entries(db, "key_change") == []

    key_api(claude)
    ok = await admin.client.put(
        "/api/admin/ai/key", json={"key": OTHER_KEY, "totp_code": await totp_code(admin.user)}
    )
    assert ok.status_code == 200, ok.text
    assert (await settings_row(db)).key_last4 == OTHER_KEY[-4:]


# --- бюджет ---


async def test_budget_view_and_update(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    await spend(db, member.id, "2")
    await spend(db, admin.id, "1")
    await spend(db, None, "0.25", kind="refresh")
    await spend(db, member.id, "7", key_source="own")
    await spend(db, None, "3", kind="eval")
    await spend(db, None, "1.5", kind="shadow")

    body = (await admin.client.get("/api/admin/ai/budget")).json()
    assert body["budget_usd"] == 60.0
    assert body["spent_usd"] == 3.25
    assert body["background_usd"] == 0.25
    assert body["left_usd"] == 56.75
    assert body["members_limits_usd"] == 10.0
    assert body["alert_pct"] == 80
    assert body["eval_budget_usd"] == 25.0
    assert body["eval_spent_usd"] == 4.5
    assert body["days_left"] >= 0
    # Темп месяца считает сервер: в среднем в день, можно в день до конца месяца (включая
    # сегодня), сумма уведомления, прогноз к бюджету
    day, days = month_days(utcnow())
    assert body["per_day_usd"] == float((D("3.25") / day).quantize(D("0.01")))
    assert body["can_per_day_usd"] == float(
        (D("56.75") / (days - day + 1)).quantize(D("0.01"), rounding=ROUND_DOWN)
    )
    assert body["alert_usd"] == 48.0
    assert body["forecast_share"] == pytest.approx(body["forecast_usd"] / 60)

    bad = await admin.client.put("/api/admin/ai/budget", json={"monthly_usd": 80, "alert_pct": 75})
    assert bad.status_code == 422
    negative = await admin.client.put(
        "/api/admin/ai/budget", json={"monthly_usd": -1, "alert_pct": 80}
    )
    assert negative.status_code == 422

    updated = await admin.client.put(
        "/api/admin/ai/budget", json={"monthly_usd": "80", "alert_pct": 90}
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["budget_usd"] == 80.0
    assert updated.json()["alert_pct"] == 90
    row = await settings_row(db)
    assert (row.monthly_budget_usd, row.budget_alert_pct) == (D("80.00"), 90)
    [entry] = await audit_entries(db, "budget_change")
    assert entry.actor_id == admin.id
    assert entry.details["changes"] == {
        "monthly_budget_usd": {"from": "60.00", "to": "80.00"},
        "budget_alert_pct": {"from": 80, "to": 90},
    }
    # То же еще раз — журнал не растет
    await admin.client.put("/api/admin/ai/budget", json={"monthly_usd": "80", "alert_pct": 90})
    assert len(await audit_entries(db, "budget_change")) == 1


# --- лимиты ---


async def test_limits_view(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(display_name="Ольга")
    own = await make_user(ai_mode="own")
    gone = await make_user(status="deleted")
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=D("8"),
            daily_analyses=2,
            per_analysis_usd=D("0.80"),
            paused=True,
        )
    )
    await db.commit()
    first = await analysis(db, member.id, cost="0.2")
    await analysis(db, member.id, cost="0.2")
    await analysis(db, own.id, key_source="own")
    await spend(db, member.id, "0.30", analysis_id=first.id)
    await spend(db, member.id, "0.05", kind="parse")
    await spend(db, member.id, "9", kind="eval")
    await spend(db, own.id, "1.20", key_source="own")
    await spend(db, own.id, "0.40")

    response = await admin.client.get("/api/admin/ai/limits")
    assert response.status_code == 200
    body = response.json()
    assert body["defaults"] == {
        "monthly_usd": 10.0,
        "daily_analyses": 3,
        "per_analysis_usd": 1.0,
        "soft_cap_usd": 0.5,
    }
    rows = {row["id"]: row for row in body["members"]}
    assert set(rows) == {admin.id, member.id, own.id}
    assert gone.id not in rows
    assert rows[admin.id]["limit"] is None
    m = rows[member.id]
    assert m["display_name"] == "Ольга"
    assert m["limit"] == {
        "monthly_usd": 8.0,
        "daily_analyses": 2,
        "per_analysis_usd": 0.8,
        "paused": True,
    }
    assert m["spent_month_usd"] == pytest.approx(0.35)
    assert m["analyses_today"] == 2
    # Анализы за месяц — по analyses.started_at, как анализы сегодня: второй анализ без
    # вызовов Claude тоже в счете
    assert m["analyses_month"] == 2
    assert m["own_spent_month_usd"] == 0
    o = rows[own.id]
    assert o["ai_mode"] == "own"
    assert o["limit"]["monthly_usd"] == 10.0
    assert o["own_spent_month_usd"] == 1.2
    assert o["spent_month_usd"] == 0.4
    assert o["analyses_today"] == 0
    assert o["return_requested_at"] is None

    # Расход в списке участников считается так же: без проверочных прогонов
    users = {row["id"]: row for row in (await admin.client.get("/api/admin/users")).json()}
    assert users[member.id]["ai_spent_month_usd"] == pytest.approx(0.35)


async def test_update_member_limit(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    missing = await admin.client.put("/api/admin/ai/limits/999999", json={"paused": True})
    assert missing.status_code == 404

    paused = await admin.client.put(f"/api/admin/ai/limits/{member.id}", json={"paused": True})
    assert paused.status_code == 200, paused.text
    assert paused.json()["limit"]["paused"] is True
    assert paused.json()["limit"]["monthly_usd"] == 10.0

    changed = await admin.client.put(
        f"/api/admin/ai/limits/{member.id}",
        json={"monthly_usd": "15", "daily_analyses": 5, "per_analysis_usd": "1.50"},
    )
    assert changed.status_code == 200
    assert changed.json()["limit"] == {
        "monthly_usd": 15.0,
        "daily_analyses": 5,
        "per_analysis_usd": 1.5,
        "paused": True,
    }
    extra = await admin.client.put(f"/api/admin/ai/limits/{member.id}", json={"bank": 1})
    assert extra.status_code == 422
    entries = await audit_entries(db, "limit_change")
    assert [e.target_user_id for e in entries] == [member.id, member.id]
    assert entries[1].details["changes"]["monthly_usd"] == {"from": "10.00", "to": "15.00"}

    # Пауза видна участнику: анализ не запустится
    member_client = await login(await make_client("10.0.0.5"), member)
    budget = (await member_client.get("/api/ai/budget")).json()
    assert budget["paused"] is True
    assert budget["monthly_usd"] == 15.0


async def test_update_defaults_only_for_new_members(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    admin = await admin_signed_in(make_client, make_user, login)
    old = await signed_in(make_client, make_user, login, ip="10.0.0.5")
    db.add(AiLimit(user_id=old.id, monthly_usd=D("10"), daily_analyses=3, per_analysis_usd=D("1")))
    await db.commit()
    response = await admin.client.put(
        "/api/admin/ai/defaults",
        json={"monthly_usd": "12", "daily_analyses": 4, "per_analysis_usd": "0.30"},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {
        "monthly_usd": 12.0,
        "daily_analyses": 4,
        "per_analysis_usd": 0.3,
        "soft_cap_usd": 0.5,
    }
    row = await settings_row(db)
    assert (row.default_member_limit_usd, row.default_daily_analyses) == (D("12.00"), 4)
    assert row.agent_config["default_per_analysis_usd"] == "0.30"
    # Жесткий и мягкий потолки программы не меняются
    assert (row.per_analysis_hard_usd, row.per_analysis_soft_usd) == (D("1.00"), D("0.50"))
    [entry] = await audit_entries(db, "budget_change")
    assert entry.details["changes"] == {
        "default_member_limit_usd": {"from": "10.00", "to": "12.00"},
        "default_daily_analyses": {"from": 3, "to": 4},
        "default_per_analysis_usd": {"from": "1.00", "to": "0.30"},
    }

    # Анализ администратора за $0,60 по-прежнему проходит: его потолок — $1
    mine = (await admin.client.get("/api/ai/budget")).json()
    assert (mine["per_analysis_usd"], mine["soft_cap_usd"]) == (1.0, 0.5)
    admin_user = await db.get_one(User, admin.id, populate_existing=True)
    assert (await access_for(db, admin_user, estimate_usd=D("0.60"))).reason is None
    # У зарегистрированного участника лимит прежний
    kept = (await old.client.get("/api/ai/budget")).json()
    assert (kept["monthly_usd"], kept["daily_analyses"], kept["per_analysis_usd"]) == (10.0, 3, 1.0)

    # Новые участники: без строки ai_limits, по приглашению и при регистрации
    fresh = await signed_in(make_client, make_user, login, ip="10.0.0.6")
    budget = (await fresh.client.get("/api/ai/budget")).json()
    assert (budget["monthly_usd"], budget["daily_analyses"], budget["per_analysis_usd"]) == (
        12.0,
        4,
        0.3,
    )
    assert budget["own_cap_usd"] == 0.3
    invite = await admin.client.post("/api/admin/invites", json={"email": "new@example.com"})
    assert invite.status_code == 201, invite.text
    assert invite.json()["invite"]["limit"]["per_analysis_usd"] == 0.3
    code = await make_invite(db, email="maria@example.com")
    registered = await (await make_client("10.0.0.9")).post(
        "/api/auth/register",
        json={
            "invite_code": code,
            "email": "maria@example.com",
            "display_name": "Мария",
            "password": "a-long-and-unique-password",
            "accept_terms": True,
            "consent_training": True,
            "tz": "Europe/Berlin",
        },
    )
    assert registered.status_code == 200, registered.text
    maria = await db.scalar(select(User).where(User.email == "maria@example.com"))
    assert maria is not None
    limit = await limit_row(db, maria.id)
    assert limit is not None
    assert (limit.monthly_usd, limit.per_analysis_usd, limit.own_per_analysis_usd) == (
        D("12.00"),
        D("0.30"),
        D("0.30"),
    )
    # Настройку видит и команда agent-config
    assert (await load_agent_config(db)).default_per_analysis_usd == D("0.30")

    # Обратно на $1: мягкий потолок так и остался $0,50
    back = await admin.client.put(
        "/api/admin/ai/defaults",
        json={"monthly_usd": "12", "daily_analyses": 4, "per_analysis_usd": "1"},
    )
    assert back.json()["per_analysis_usd"] == 1.0
    assert back.json()["soft_cap_usd"] == 0.5
    # То же еще раз — журнал не растет
    await admin.client.put(
        "/api/admin/ai/defaults",
        json={"monthly_usd": "12", "daily_analyses": 4, "per_analysis_usd": "1"},
    )
    assert len(await audit_entries(db, "budget_change")) == 2


LIMIT_OK = {"monthly_usd": "10", "daily_analyses": 3, "per_analysis_usd": "1"}
# Границы из формы макета (mockup/js/screens/admin.js, limitFields): месяц $1–500, в день
# 1–30, на анализ от $0,10
LIMIT_OUT_OF_RANGE = [
    {"monthly_usd": "0"},
    {"monthly_usd": "0.99"},
    {"monthly_usd": "500.01"},
    {"monthly_usd": "99999999.99"},
    {"daily_analyses": 0},
    {"daily_analyses": 31},
    {"daily_analyses": 1000},
    {"per_analysis_usd": "0"},
    {"per_analysis_usd": "0.09"},
    {"per_analysis_usd": "500.01"},
    {"monthly_usd": "-1"},
]


@pytest.mark.parametrize("bad", LIMIT_OUT_OF_RANGE, ids=lambda v: str(v))
async def test_limit_bounds(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    bad: dict[str, object],
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(ai_mode="own")
    db.add(
        AiLimit(user_id=member.id, monthly_usd=D("10"), daily_analyses=3, per_analysis_usd=D("1"))
    )
    await db.commit()
    await ai_keys.request_return(db, member.user)
    full = {**LIMIT_OK, **bad}
    for method, url, body in (
        ("PUT", f"/api/admin/ai/limits/{member.id}", bad),
        ("PUT", "/api/admin/ai/defaults", full),
        ("POST", f"/api/admin/users/{member.id}/ai-mode", {"decision": "approve", "limit": full}),
    ):
        response = await admin.client.request(method, url, json=body)
        assert response.status_code == 422, (url, response.text)
    row = await limit_row(db, member.id)
    assert row is not None and row.monthly_usd == D("10.00") and row.return_requested_at
    assert (await settings_row(db)).default_member_limit_usd == D("10.00")
    assert await audit_entries(db) == []


async def test_limit_cap_not_above_month(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(ai_mode="own")
    db.add(
        AiLimit(user_id=member.id, monthly_usd=D("10"), daily_analyses=3, per_analysis_usd=D("1"))
    )
    await db.commit()
    await ai_keys.request_return(db, member.user)
    above = {"monthly_usd": "5", "daily_analyses": 3, "per_analysis_usd": "50"}
    for method, url, body in (
        ("PUT", f"/api/admin/ai/limits/{member.id}", above),
        # Месяц не передан: сравнивается с действующим ($10)
        ("PUT", f"/api/admin/ai/limits/{member.id}", {"per_analysis_usd": "10.01"}),
        ("PUT", "/api/admin/ai/defaults", above),
        ("POST", f"/api/admin/users/{member.id}/ai-mode", {"decision": "approve", "limit": above}),
    ):
        response = await admin.client.request(method, url, json=body)
        assert response.status_code == 400, (url, body, response.text)
        assert error_code(response) == "ai.cap_above_month"
    assert await audit_entries(db) == []

    # Ровно месячный лимит — можно
    equal = await admin.client.put(
        f"/api/admin/ai/limits/{member.id}", json={"monthly_usd": "5", "per_analysis_usd": "5"}
    )
    assert equal.status_code == 200, equal.text
    # Месяц ниже действующего потолка — тоже проверяется
    lower = await admin.client.put(f"/api/admin/ai/limits/{member.id}", json={"monthly_usd": "4"})
    assert lower.status_code == 400
    assert error_code(lower) == "ai.cap_above_month"
    # Только пауза — без проверки потолка
    paused = await admin.client.put(f"/api/admin/ai/limits/{member.id}", json={"paused": True})
    assert paused.status_code == 200


async def test_budget_bounds_and_spent(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    for bad in (
        {"monthly_usd": "0", "alert_pct": 80},
        {"monthly_usd": "0.99", "alert_pct": 80},
        {"monthly_usd": "5000.01", "alert_pct": 80},
        {"monthly_usd": "99999999.99", "alert_pct": 80},
        {"monthly_usd": "60", "alert_pct": 80, "eval_budget_usd": "-1"},
        {"monthly_usd": "60", "alert_pct": 80, "eval_budget_usd": "500.01"},
    ):
        response = await admin.client.put("/api/admin/ai/budget", json=bad)
        assert response.status_code == 422, bad

    await spend(db, admin.id, "30")
    await spend(db, None, "50", kind="eval")
    below = await admin.client.put(
        "/api/admin/ai/budget", json={"monthly_usd": "5", "alert_pct": 80}
    )
    assert below.status_code == 400
    assert error_code(below) == "ai.budget_below_spent"
    assert "30,00" in below.json()["error"]["message"]
    assert (await settings_row(db)).monthly_budget_usd == D("60.00")
    # Проверочные прогоны не в счет: $30 можно
    ok = await admin.client.put("/api/admin/ai/budget", json={"monthly_usd": "30", "alert_pct": 80})
    assert ok.status_code == 200, ok.text
    # Потрачено больше бюджета: порог уведомления менять можно, тот же бюджет — тоже
    await spend(db, admin.id, "5")
    alert = await admin.client.put(
        "/api/admin/ai/budget",
        json={"monthly_usd": "30", "alert_pct": 90, "eval_budget_usd": "0"},
    )
    assert alert.status_code == 200, alert.text
    assert (alert.json()["alert_pct"], alert.json()["eval_budget_usd"]) == (90, 0.0)


async def test_admin_has_no_member_limit(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    other = await make_user(role="admin")
    # Отмена просьбы у администратора ничего не создает
    gone = await admin.client.delete("/api/me/ai-mode/return-request")
    assert gone.status_code == 204
    assert await limit_row(db, admin.id) is None

    for target in (admin.id, other.id):
        limit = await admin.client.put(f"/api/admin/ai/limits/{target}", json={"paused": True})
        assert limit.status_code == 409
        assert error_code(limit) == "ai.admin_no_limit"
        mode = await admin.client.post(
            f"/api/admin/users/{target}/ai-mode", json={"decision": "approve"}
        )
        assert mode.status_code == 409
        assert error_code(mode) == "ai.return_not_needed"
        assert await limit_row(db, target) is None
    assert await audit_entries(db) == []

    # Администратор по приглашению: строка ai_limits есть, но лимита в списках нет
    db.add(
        AiLimit(user_id=other.id, monthly_usd=D("10"), daily_analyses=3, per_analysis_usd=D("1"))
    )
    await db.commit()
    users = {r["id"]: r for r in (await admin.client.get("/api/admin/users")).json()}
    limits = {
        r["id"]: r for r in (await admin.client.get("/api/admin/ai/limits")).json()["members"]
    }
    assert users[other.id]["limit"] is None
    assert limits[other.id]["limit"] is None


async def test_analyses_month_same_everywhere(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    await seed_prices(db)
    await set_admin_key(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    # Анализ упал после новостей (вызова Opus не было) и анализ с повторной оценкой без
    # вызова Claude: оба запущены сегодня на ключе администратора
    failed = await analysis(db, member.id, status="failed", cost="0.004")
    await spend(db, member.id, "0.004", kind="news", analysis_id=failed.id)
    await analysis(db, member.id, cost="0")
    # Анализ на своем ключе и анализ прошлого месяца не в счете
    await analysis(db, member.id, key_source="own")
    await analysis(db, member.id, started_ago=timedelta(days=40))

    mine = (await member.client.get("/api/ai/budget")).json()
    rows = (await admin.client.get("/api/admin/ai/limits")).json()["members"]
    row = next(r for r in rows if r["id"] == member.id)
    users = (await admin.client.get("/api/admin/users")).json()
    listed = next(r for r in users if r["id"] == member.id)
    detail = (await admin.client.get(f"/api/admin/users/{member.id}")).json()
    assert mine["analyses_month"] == row["analyses_month"] == listed["analyses_month"] == 2
    assert detail["analyses_month"] == 2
    assert row["analyses_today"] == mine["analyses_today"] == 2
    assert row["spent_month_usd"] == listed["ai_spent_month_usd"] == mine["spent_usd"] == 0.004


# --- Р12: просьба вернуть ключ администратора и решение ---


async def test_return_to_admin_key_full_flow(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    claude: ClaudeMock,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, display_name="Дмитрий")

    # Участник сам переходит на свой ключ
    key_api(claude)
    assert (await member.client.put("/api/me/ai-key", json={"key": KEY})).json()["mode"] == "own"
    no_request = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode", json={"decision": "approve"}
    )
    assert no_request.status_code == 409
    assert error_code(no_request) == "ai.no_return_request"

    # Просьба → уведомление администратору
    requested = await member.client.post("/api/me/ai-mode/return-request")
    assert requested.status_code == 200
    [note] = list(
        await db.scalars(
            select(Notification).where(
                Notification.user_id == admin.id, Notification.kind == "ai_mode_request"
            )
        )
    )
    assert "Дмитрий" in note.title
    rows = {r["id"]: r for r in (await admin.client.get("/api/admin/ai/limits")).json()["members"]}
    assert rows[member.id]["return_requested_at"] is not None
    assert rows[member.id]["own_key_last4"] == KEY[-4:]

    # Решение: вернуть с новым лимитом
    approved = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode",
        json={
            "decision": "approve",
            "limit": {"monthly_usd": "12", "daily_analyses": 4, "per_analysis_usd": "1.20"},
        },
    )
    assert approved.status_code == 200, approved.text
    out = approved.json()
    assert out["ai_mode"] == "shared"
    assert out["return_requested_at"] is None
    assert out["limit"]["monthly_usd"] == 12.0
    no_key_in(approved)

    decision = await db.scalar(
        select(Notification).where(
            Notification.user_id == member.id, Notification.kind == "ai_mode_decision"
        )
    )
    assert decision is not None
    assert "$12,00" in decision.body
    assert "4 в день" in decision.body
    note_after = await db.get_one(Notification, note.id, populate_existing=True)
    assert note_after.read_at is not None
    modes = await audit_entries(db, "ai_mode_change")
    assert [(e.target_user_id, e.details) for e in modes] == [
        (member.id, {"from": "own", "to": "shared", "decision": "approved"})
    ]
    assert [e.target_user_id for e in await audit_entries(db, "limit_change")] == [member.id]

    budget = (await member.client.get("/api/ai/budget")).json()
    assert (budget["mode"], budget["monthly_usd"], budget["daily_analyses"]) == ("shared", 12.0, 4)
    # Свой ключ удален с сервера (макет: «его ключ отключится»): на свой ключ участник
    # вернется, только сохранив ключ заново
    assert budget["own_key"] is None
    assert out["own_key_last4"] is None
    assert "ключ удален" in decision.body
    back = await member.client.put("/api/me/ai-mode", json={"mode": "own"})
    assert back.status_code == 409
    assert error_code(back) == "ai.no_own_key"


async def test_return_request_rejected(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ai_mode="own")
    assert (await member.client.post("/api/me/ai-mode/return-request")).status_code == 200

    # Лимит при отказе не меняется, даже если его прислали
    rejected = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode",
        json={
            "decision": "reject",
            "limit": {"monthly_usd": "50", "daily_analyses": 9, "per_analysis_usd": "5"},
        },
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["ai_mode"] == "own"
    row = await limit_row(db, member.id)
    assert row is not None and row.monthly_usd == D("10.00")
    assert row.return_requested_at is None
    note = await db.scalar(
        select(Notification).where(
            Notification.user_id == member.id, Notification.kind == "ai_mode_decision"
        )
    )
    assert note is not None and note.params.get("variant") == "rejected"
    entries = await db.scalars(
        select(AdminAuditLog).where(AdminAuditLog.action.in_(("ai_mode_change", "limit_change")))
    )
    assert [(e.action, e.details.get("decision")) for e in entries] == [
        ("ai_mode_change", "rejected")
    ]

    again = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode", json={"decision": "reject"}
    )
    assert again.status_code == 409
    missing = await admin.client.post(
        "/api/admin/users/999999/ai-mode", json={"decision": "reject"}
    )
    assert missing.status_code == 404
    bad = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode", json={"decision": "maybe"}
    )
    assert bad.status_code == 422


async def test_approve_return_lifts_pause(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Участник на паузе ушел на свой ключ и просит вернуть ключ администратора: «Разрешить»
    возвращает его с новым лимитом и без паузы (как в макете), иначе «снова на ключе
    администратора» на деле значило бы «анализы не запускаются»."""
    await seed_prices(db)
    await set_admin_key(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ai_mode="own")
    paused = await admin.client.put(f"/api/admin/ai/limits/{member.id}", json={"paused": True})
    assert paused.status_code == 200, paused.text
    assert (await member.client.post("/api/me/ai-mode/return-request")).status_code == 200

    approved = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode",
        json={
            "decision": "approve",
            "limit": {"monthly_usd": "12", "daily_analyses": 4, "per_analysis_usd": "1"},
        },
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["limit"]["paused"] is False
    row = await limit_row(db, member.id)
    assert row is not None and row.paused is False
    budget = (await member.client.get("/api/ai/budget")).json()
    assert (budget["mode"], budget["paused"], budget["reason_code"]) == ("shared", False, None)
    changes = [e.details["changes"] for e in await audit_entries(db, "limit_change")]
    assert changes[-1]["paused"] == {"from": True, "to": False}


async def test_approve_with_limit_without_request_changes_nothing(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(ai_mode="own")
    response = await admin.client.post(
        f"/api/admin/users/{member.id}/ai-mode",
        json={
            "decision": "approve",
            "limit": {"monthly_usd": "50", "daily_analyses": 9, "per_analysis_usd": "5"},
        },
    )
    assert response.status_code == 409
    assert error_code(response) == "ai.no_return_request"
    assert await limit_row(db, member.id) is None
    assert await audit_entries(db, "limit_change") == []


async def test_admin_routes_need_csrf(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await make_user(role="admin")
    plain = await login(await make_client("10.0.0.7", csrf=False), admin)
    for method, url, body in (
        ("PUT", "/api/admin/ai/budget", {"monthly_usd": "80", "alert_pct": 90}),
        (
            "PUT",
            "/api/admin/ai/defaults",
            {"monthly_usd": 1, "daily_analyses": 1, "per_analysis_usd": 1},
        ),
        ("PUT", f"/api/admin/ai/limits/{admin.id}", {"paused": True}),
        ("PUT", "/api/admin/ai/key", {"key": KEY, "totp_code": "123456"}),
        ("POST", f"/api/admin/users/{admin.id}/ai-mode", {"decision": "reject"}),
    ):
        response = await plain.request(method, url, json=body)
        assert response.status_code == 403, url
        assert error_code(response) == "common.csrf"
    assert (await settings_row(db)).monthly_budget_usd == D("60.00")
    assert await audit_entries(db) == []


async def test_limits_level_same_as_admin_attention(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Уровень лимита в таблице лимитов — по правилу дел администратора; легкий маршрут
    дел (GET /admin/attention) отдает те же уровни и день, когда кончится лимит."""
    admin = await admin_signed_in(make_client, make_user, login)
    calm = await make_user()
    warm = await make_user()
    full = await make_user()
    own = await make_user(ai_mode="own")
    await spend(db, calm.id, "1")
    await spend(db, warm.id, "8.5")
    await spend(db, full.id, "10")
    await spend(db, own.id, "9.9")
    await spend(db, admin.id, "30")

    rows = {
        row["id"]: row["level"]
        for row in (await admin.client.get("/api/admin/ai/limits")).json()["members"]
    }
    assert rows == {calm.id: None, warm.id: "80", full.id: "100", own.id: None, admin.id: None}

    response = await admin.client.get("/api/admin/attention")
    assert response.status_code == 200, response.text
    body = response.json()
    alerts = {item["user_id"]: item for item in body["limits"]}
    assert {uid: item["level"] for uid, item in alerts.items()} == {warm.id: "80", full.id: "100"}
    # Тот же ответ, что admin на главной
    dashboard = (await admin.client.get("/api/dashboard")).json()["admin"]
    assert body == dashboard
    # Лимит 10 потрачен на 8,5 за day дней: остаток 1,5 кончится через ceil(1,5 / темп) дней
    now = utcnow()
    day, days = month_days(now)
    ahead = math.ceil(D("1.5") / (D("8.5") / day))
    expected = (now.date() + timedelta(days=ahead)).isoformat() if day + ahead <= days else None
    assert alerts[warm.id]["runs_out_on"] == expected
    assert alerts[full.id]["runs_out_on"] is None


async def test_attention_only_for_admin(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.get("/api/admin/attention")
    assert response.status_code == 403


def test_runs_out_on_by_month_pace() -> None:
    now = datetime(2026, 10, 10, 12, 0, tzinfo=UTC)
    # 5 за 10 дней — 0,5 в день: остаток 5 кончится через 10 дней
    assert runs_out_on(D("5"), D("10"), now) == date(2026, 10, 20)
    # Через 50 дней — уже в следующем месяце: с 1-го числа расход заново
    assert runs_out_on(D("5"), D("30"), now) is None
    assert runs_out_on(D("0"), D("10"), now) is None
    assert runs_out_on(D("10"), D("10"), now) is None
    # Последний день месяца: остаток на сегодня
    assert runs_out_on(D("30"), D("31"), datetime(2026, 10, 31, 9, tzinfo=UTC)) is None
    # 15 за 15 дней — 1 в день: остаток 16 кончится ровно в последний день
    assert runs_out_on(D("15"), D("31"), datetime(2026, 10, 15, 9, tzinfo=UTC)) == date(
        2026, 10, 31
    )
