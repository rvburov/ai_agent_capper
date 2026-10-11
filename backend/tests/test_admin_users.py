"""Кабинет администратора: список участников, карточка, блокировка, роль, сеансы,
сброс 2FA."""

import asyncio
from datetime import timedelta
from decimal import Decimal

import pytest
from fastapi import FastAPI
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security.tokens import gen_recovery_codes, hash_code, new_token
from app.db.models import (
    AccessCode,
    AgentRun,
    AiLimit,
    Analysis,
    LoginEvent,
    Notification,
    RecoveryCode,
    TrustedDevice,
    User,
    UserSession,
)
from app.services import admin_confirm, admin_users
from app.services.access_codes import create_reset_code
from app.services.sessions import utcnow
from tests.helpers_admin import ADMIN_IP, admin_signed_in, audit_entries, error_code, signed_in
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory


async def _sessions_open(db: AsyncSession, user_id: int) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    )
    return int(count or 0)


async def _user(db: AsyncSession, user_id: int) -> User:
    return await db.get_one(User, user_id, populate_existing=True)


# --- список и карточка ---


async def test_list_users_spend_analyses_and_limit(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(display_name="Ольга")
    own = await make_user(ai_mode="own")
    gone = await make_user(status="deleted")
    now = utcnow()
    # Анализ запущен в этом месяце на ключе администратора: он и есть «анализ за месяц»
    analysis = Analysis(
        user_id=member.id,
        input_text="Синнер — Алькарас",
        status="done",
        key_source="admin",
        started_at=now,
    )
    db.add(analysis)
    await db.flush()
    month_start = admin_users.month_start(now)
    runs = [
        # Два шага одного анализа и разбор текста — в расходе; анализ один
        ("analysis", "admin", "0.120000", analysis.id, now),
        ("analysis", "admin", "0.030000", analysis.id, now),
        ("parse", "admin", "0.010000", None, now),
        # Свой ключ и прошлый месяц не считаются
        ("analysis", "own", "1.000000", None, now),
        ("analysis", "admin", "2.000000", None, month_start - timedelta(seconds=1)),
    ]
    for kind, source, cost, analysis_id, at in runs:
        db.add(
            AgentRun(
                user_id=member.id,
                key_source=source,
                analysis_id=analysis_id,
                kind=kind,
                model="claude-opus-5-5",
                cost_usd=Decimal(cost),
                created_at=at,
            )
        )
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=Decimal("10"),
            daily_analyses=3,
            per_analysis_usd=Decimal("1"),
            paused=True,
        )
    )
    await db.commit()

    response = await admin.client.get("/api/admin/users")
    assert response.status_code == 200
    rows = {row["id"]: row for row in response.json()}
    assert set(rows) == {admin.id, member.id, own.id}
    row = rows[member.id]
    assert row["display_name"] == "Ольга"
    assert row["ai_spent_month_usd"] == pytest.approx(0.16)
    assert row["analyses_month"] == 1
    assert row["limit"] == {
        "monthly_usd": 10.0,
        "daily_analyses": 3,
        "per_analysis_usd": 1.0,
        "paused": True,
    }
    assert rows[own.id]["limit"] is None
    assert rows[own.id]["ai_spent_month_usd"] == 0
    assert rows[admin.id]["totp_enabled"] is True

    with_deleted = await admin.client.get("/api/admin/users", params={"include_deleted": True})
    assert gone.id in {row["id"] for row in with_deleted.json()}


async def test_user_detail_sessions_and_recent_logins(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    await login(await make_client("10.0.0.2"), member.user)
    # Отозванный и брошенный (бездействие больше 14 дней) сеансы не считаются
    await login(await make_client("10.0.0.3"), member.user)
    await login(await make_client("10.0.0.4"), member.user)
    sessions = list(
        await db.scalars(
            select(UserSession).where(UserSession.user_id == member.id).order_by(UserSession.id)
        )
    )
    sessions[2].revoked_at = utcnow()
    sessions[3].last_seen_at = utcnow() - timedelta(days=15)
    base = utcnow() - timedelta(hours=1)
    for i in range(25):
        db.add(
            LoginEvent(
                user_id=member.id,
                at=base + timedelta(minutes=i),
                ip="10.0.0.1",
                user_agent="Mozilla/5.0 (iPhone) Safari/604.1",
                result="ok" if i % 2 else "bad_password",
                method="password",
            )
        )
    await db.commit()

    response = await admin.client.get(f"/api/admin/users/{member.id}")
    assert response.status_code == 200
    body = response.json()
    assert body["active_sessions"] == 2
    assert len(body["recent_logins"]) == 20
    first = body["recent_logins"][0]
    assert first["device_label"] == "Safari · iOS"
    assert first["result"] == "bad_password"  # последняя запись, i = 24
    ats = [entry["at"] for entry in body["recent_logins"]]
    assert ats == sorted(ats, reverse=True)

    assert (await admin.client.get("/api/admin/users/999999")).status_code == 404


# --- блокировка ---


async def test_block_revokes_sessions_and_reset_codes(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    # До блокировки сеанс участника действует (403 — нет прав, а не нет сеанса)
    assert (await member.client.get("/api/admin/users")).status_code == 403
    await create_reset_code(db, member.id, actor=None, ip=None)

    response = await admin.client.post(f"/api/admin/users/{member.id}/block")
    assert response.status_code == 200
    assert response.json()["status"] == "blocked"
    assert (await member.client.get("/api/admin/users")).status_code == 401
    assert await _sessions_open(db, member.id) == 0
    user = await _user(db, member.id)
    assert user.status == "blocked" and user.blocked_at is not None
    active_codes = await db.scalar(
        select(func.count())
        .select_from(AccessCode)
        .where(AccessCode.user_id == member.id, AccessCode.revoked_at.is_(None))
    )
    assert active_codes == 0

    [entry] = await audit_entries(db, "block")
    assert entry.actor_id == admin.id
    assert entry.target_user_id == member.id
    assert entry.ip == ADMIN_IP
    assert entry.details == {"sessions_revoked": 1, "reset_codes_revoked": 1}

    # Повторная блокировка ничего не меняет и журнал не пишет
    again = await admin.client.post(f"/api/admin/users/{member.id}/block")
    assert again.status_code == 200
    assert len(await audit_entries(db, "block")) == 1

    response = await admin.client.post(f"/api/admin/users/{member.id}/unblock")
    assert response.status_code == 200
    assert response.json()["status"] == "active"
    assert (await _user(db, member.id)).blocked_at is None
    [entry] = await audit_entries(db, "unblock")
    assert entry.actor_id == admin.id and entry.target_user_id == member.id


async def test_cannot_block_self(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    response = await admin.client.post(f"/api/admin/users/{admin.id}/block")
    assert response.status_code == 400
    assert error_code(response) == "admin.cannot_block_self"


async def test_block_last_active_admin_is_refused(make_user: UserFactory, db: AsyncSession) -> None:
    """Блокирующий администратор сам только что заблокирован (гонка): цель — последний
    активный администратор, блокировать ее нельзя."""
    actor = await make_user(role="admin")
    target = await make_user(role="admin")
    target_id = target.id
    await db.execute(update(User).where(User.id == actor.id).values(status="blocked"))
    await db.commit()
    with pytest.raises(AppError) as exc:
        await admin_users.block_user(db, target_id, actor=actor.user, ip=None)
    assert exc.value.code == "admin.last_admin"
    await db.rollback()
    assert (await _user(db, target_id)).status == "active"


async def test_two_admins_blocking_each_other_leave_one_admin(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    first = await admin_signed_in(make_client, make_user, login)
    second = await admin_signed_in(make_client, make_user, login)
    first_code, second_code = await totp_code(first.user), await totp_code(second.user)
    responses = await asyncio.gather(
        first.client.post(f"/api/admin/users/{second.id}/block", json={"totp_code": first_code}),
        second.client.post(f"/api/admin/users/{first.id}/block", json={"totp_code": second_code}),
    )
    codes = sorted(r.status_code for r in responses)
    assert codes in ([200, 401], [200, 409])
    active_admins = await db.scalar(
        select(func.count()).select_from(User).where(User.role == "admin", User.status == "active")
    )
    assert active_admins == 1


# --- роль ---


async def test_role_change_requires_totp(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    url = f"/api/admin/users/{member.id}/role"

    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    response = await admin.client.post(url, json={"role": "admin", "totp_code": wrong})
    assert response.status_code == 403
    assert error_code(response) == "admin.totp_invalid"
    assert response.json()["error"]["attempts_left"] == admin_confirm.CONFIRM_MAX_FAILURES - 1
    missing = await admin.client.post(url, json={"role": "admin"})
    assert missing.status_code == 422
    assert (await _user(db, member.id)).role == "member"

    response = await admin.client.post(url, json={"role": "admin", "totp_code": good})
    assert response.status_code == 200
    assert response.json()["role"] == "admin"
    [entry] = await audit_entries(db, "role_change")
    assert entry.actor_id == admin.id and entry.ip == ADMIN_IP
    assert entry.details == {"from": "member", "to": "admin"}

    # Тот же код второй раз не принимается
    response = await admin.client.post(url, json={"role": "member", "totp_code": good})
    assert response.status_code == 403
    assert (await _user(db, member.id)).role == "admin"


async def test_cannot_demote_last_admin(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    url = f"/api/admin/users/{admin.id}/role"
    response = await admin.client.post(
        url, json={"role": "member", "totp_code": await totp_code(admin.user)}
    )
    assert response.status_code == 409
    assert error_code(response) == "admin.last_admin"
    assert (await _user(db, admin.id)).role == "admin"

    # Когда есть другой активный администратор, понизить себя можно
    await make_user(role="admin")
    response = await admin.client.post(
        url, json={"role": "member", "totp_code": await totp_code(admin.user)}
    )
    assert response.status_code == 200
    assert response.json()["role"] == "member"


async def test_wrong_totp_codes_end_admin_session(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Подбор кода с угнанного сеанса: пятый неверный код подряд завершает сеанс,
    владельцу — уведомление. Другой сеанс того же администратора работает."""
    admin = await admin_signed_in(make_client, make_user, login)
    other = await login(await make_client("10.0.0.8"), admin.user)
    member = await make_user()
    url = f"/api/admin/users/{member.id}/role"
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    limit = admin_confirm.CONFIRM_MAX_FAILURES
    for i in range(1, limit):
        response = await admin.client.post(url, json={"role": "admin", "totp_code": wrong})
        assert response.status_code == 403
        assert error_code(response) == "admin.totp_invalid"
        assert response.json()["error"]["attempts_left"] == limit - i
    response = await admin.client.post(url, json={"role": "admin", "totp_code": wrong})
    assert response.status_code == 401
    assert error_code(response) == "auth.too_many_codes"
    assert (await admin.client.get("/api/me")).status_code == 401
    assert (await _user(db, member.id)).role == "member"
    notes = list(
        await db.scalars(
            select(Notification).where(
                Notification.user_id == admin.id, Notification.kind == "login_failures"
            )
        )
    )
    assert [n.params.get("variant") for n in notes] == ["admin_confirm"]
    assert notes[0].params["ip"] == ADMIN_IP

    # Счетчик у сеанса свой: другой сеанс администратора подтверждает действие
    response = await other.post(
        url, json={"role": "admin", "totp_code": await totp_code(admin.user)}
    )
    assert response.status_code == 200, response.text


async def test_parallel_wrong_totp_codes_checked_at_most_limit(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Параллельные запросы не проверят больше CONFIRM_MAX_FAILURES кодов: лишние
    завершают сеанс без проверки кода."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    url = f"/api/admin/users/{member.id}/role"
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    responses = await asyncio.gather(
        *(
            admin.client.post(url, json={"role": "admin", "totp_code": wrong})
            for _ in range(admin_confirm.CONFIRM_MAX_FAILURES + 3)
        )
    )
    codes = [error_code(r) for r in responses]
    assert codes.count("admin.totp_invalid") <= admin_confirm.CONFIRM_MAX_FAILURES - 1
    assert "auth.too_many_codes" in codes
    assert (await admin.client.get("/api/me")).status_code == 401
    # Каждый запрос, дошедший до проверки кода, оставил запись в журнале
    failed = await audit_entries(db, "confirm_failed")
    assert len(failed) == codes.count("admin.totp_invalid") + codes.count("auth.too_many_codes")
    assert sorted(e.details["attempt"] for e in failed) == list(range(1, len(failed) + 1))
    for entry in failed:
        assert entry.details["session_ended"] is (
            entry.details["attempt"] >= admin_confirm.CONFIRM_MAX_FAILURES
        )


async def test_wrong_totp_code_is_written_to_audit(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Неверный код — запись confirm_failed в журнале. Запрос отвечает ошибкой, его
    транзакция откатывается, а запись остается: она зафиксирована отдельно. Кода в ней нет."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    url = f"/api/admin/users/{member.id}/role"
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    limit = admin_confirm.CONFIRM_MAX_FAILURES

    # Без кода — не попытка подтверждения, в журнал не пишется
    response = await admin.client.post(
        "/api/admin/invites", json={"email": "boss@example.com", "role": "admin"}
    )
    assert error_code(response) == "admin.totp_required"
    assert await audit_entries(db) == []
    for i in range(1, limit + 1):
        response = await admin.client.post(url, json={"role": "admin", "totp_code": wrong})
        assert response.status_code == (403 if i < limit else 401)
        entries = await audit_entries(db, "confirm_failed")
        assert len(entries) == i
        entry = entries[-1]
        assert entry.actor_id == admin.id
        assert entry.target_user_id == member.id
        assert entry.ip == ADMIN_IP
        assert entry.details == {"action": "role_change", "attempt": i, "session_ended": i == limit}
        assert wrong not in str(entry.details)
    # Само действие не выполнено, других записей в журнале нет
    assert (await _user(db, member.id)).role == "member"
    assert [e.action for e in await audit_entries(db)] == ["confirm_failed"] * limit


async def test_wrong_totp_code_on_own_row_is_written_without_deadlock(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """Действие над собой: строка администратора заблокирована FOR UPDATE транзакцией
    запроса, а запись журнала ссылается на нее (actor_id). Запись пишется после отката
    этой транзакции, поэтому запрос не ждет сам себя."""
    admin = await admin_signed_in(make_client, make_user, login)
    await make_user(role="admin")
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    response = await asyncio.wait_for(
        admin.client.post(
            f"/api/admin/users/{admin.id}/role", json={"role": "member", "totp_code": wrong}
        ),
        timeout=10,
    )
    assert response.status_code == 403
    [entry] = await audit_entries(db, "confirm_failed")
    assert entry.actor_id == admin.id == entry.target_user_id
    assert entry.details == {"action": "role_change", "attempt": 1, "session_ended": False}
    assert (await _user(db, admin.id)).role == "admin"


async def test_correct_totp_does_not_count_as_failure(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, totp_code: TotpCodeFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    url = f"/api/admin/users/{member.id}/role"
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    # Верный код обнуляет счетчик неверных: ошибки не копятся между действиями
    for _ in range(admin_confirm.CONFIRM_MAX_FAILURES - 1):
        response = await admin.client.post(url, json={"role": "admin", "totp_code": wrong})
        assert response.status_code == 403
    for i in range(admin_confirm.CONFIRM_MAX_FAILURES + 2):
        role = "admin" if i % 2 == 0 else "member"
        response = await admin.client.post(
            url, json={"role": role, "totp_code": await totp_code(admin.user)}
        )
        assert response.status_code == 200, response.text


# --- сеансы ---


async def test_revoke_sessions(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    await login(await make_client("10.0.0.2"), member.user)
    response = await admin.client.post(f"/api/admin/users/{member.id}/sessions/revoke")
    assert response.status_code == 204
    assert await _sessions_open(db, member.id) == 0
    assert (await member.client.get("/api/admin/users")).status_code == 401
    # Сеанс администратора не тронут
    assert await _sessions_open(db, admin.id) == 1
    [entry] = await audit_entries(db, "sessions_revoke")
    assert entry.details == {"sessions_revoked": 2}
    assert entry.target_user_id == member.id


async def test_block_and_end_sessions_of_admin_require_totp(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    """С угнанным сеансом без телефона нельзя по одному отключить других администраторов:
    блокировка администратора и завершение его сеансов — с кодом 2FA."""
    admin = await admin_signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, role="admin")
    sessions_url = f"/api/admin/users/{other.id}/sessions/revoke"
    block_url = f"/api/admin/users/{other.id}/block"

    for url in (sessions_url, block_url):
        response = await admin.client.post(url)
        assert response.status_code == 403
        assert error_code(response) == "admin.totp_required"
        response = await admin.client.post(url, json={"totp_code": None})
        assert error_code(response) == "admin.totp_required"
    assert await _sessions_open(db, other.id) == 1
    assert (await _user(db, other.id)).status == "active"

    response = await admin.client.post(
        sessions_url, json={"totp_code": await totp_code(admin.user)}
    )
    assert response.status_code == 204
    assert await _sessions_open(db, other.id) == 0
    response = await admin.client.post(block_url, json={"totp_code": await totp_code(admin.user)})
    assert response.status_code == 200
    assert response.json()["status"] == "blocked"


# --- сброс 2FA ---


async def _add_two_factor_extras(db: AsyncSession, user_id: int) -> None:
    for code in gen_recovery_codes():
        db.add(RecoveryCode(user_id=user_id, code_hash=hash_code(code)))
    db.add(
        TrustedDevice(
            user_id=user_id,
            token_hash=hash_code(new_token()),
            expires_at=utcnow() + timedelta(days=30),
        )
    )
    await db.commit()


async def test_reset_two_factor_for_member(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    await _add_two_factor_extras(db, member.id)
    url = f"/api/admin/users/{member.id}/2fa-reset"

    response = await admin.client.post(url, json={})
    assert response.status_code == 422
    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    response = await admin.client.post(url, json={"totp_code": wrong})
    assert response.status_code == 403
    assert error_code(response) == "admin.totp_invalid"
    assert (await _user(db, member.id)).totp_enabled is True

    response = await admin.client.post(url, json={"totp_code": good})
    assert response.status_code == 204
    user = await _user(db, member.id)
    assert user.totp_enabled is False
    assert user.totp_secret_enc is None and user.totp_key_version is None
    assert user.totp_last_step is None
    for model in (RecoveryCode, TrustedDevice):
        left = await db.scalar(
            select(func.count()).select_from(model).where(model.user_id == member.id)
        )
        assert left == 0
    assert await _sessions_open(db, member.id) == 0
    assert (await member.client.get("/api/admin/users")).status_code == 401
    [entry] = await audit_entries(db, "reset_2fa")
    assert entry.actor_id == admin.id and entry.target_user_id == member.id
    assert entry.details == {
        "sessions_revoked": 1,
        "recovery_codes_deleted": 8,
        "trusted_devices_deleted": 1,
    }


async def test_reset_two_factor_of_admin_is_terminal_only(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    other = await make_user(role="admin")
    for target in (admin.id, other.id):
        response = await admin.client.post(
            f"/api/admin/users/{target}/2fa-reset",
            json={"totp_code": await totp_code(admin.user)},
        )
        assert response.status_code == 403
        assert error_code(response) == "admin.reset_2fa_terminal_only"
        assert (await _user(db, target)).totp_enabled is True
    assert await audit_entries(db, "reset_2fa") == []


async def test_actions_on_missing_or_deleted_user_are_404(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, app: FastAPI
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    gone = await make_user(status="deleted")
    for user_id in (gone.id, 999999):
        for action in ("block", "unblock", "sessions/revoke"):
            response = await admin.client.post(f"/api/admin/users/{user_id}/{action}")
            assert response.status_code == 404, (user_id, action)
            assert error_code(response) == "common.not_found"
