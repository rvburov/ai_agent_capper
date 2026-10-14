"""Удаление аккаунта самим участником (В10): POST/DELETE /api/me/deletion, вход на время
ожидания (только GET /api/me и отмена), удаление задачей воркера через 7 дней, единственный
администратор, лимит попыток пароля и кода."""

from datetime import timedelta

import httpx2
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.redis import redis_key
from app.db.models import (
    AdminAuditLog,
    Analysis,
    BankrollLedger,
    Bet,
    Bookmaker,
    PlayLimit,
    User,
    UserSession,
)
from app.services import account
from app.services.sessions import utcnow
from app.workers import main as worker_main
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import (
    DEFAULT_PASSWORD,
    ClientFactory,
    LoginFn,
    MadeUser,
    TotpCodeFn,
    UserFactory,
)


async def _request(signed: Signed, totp_code: TotpCodeFn) -> httpx2.Response:
    return await signed.client.post(
        "/api/me/deletion",
        json={"password": DEFAULT_PASSWORD, "code": await totp_code(signed.user)},
    )


async def test_request_logs_out_and_leaves_only_cancel(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await signed_in(make_client, make_user, login)
    draft = Analysis(
        user_id=member.id, input_text="", input_kind="form", status="needs_confirmation"
    )
    db.add(draft)
    await db.commit()
    response = await _request(member, totp_code)
    assert response.status_code == 200, response.text
    body = response.json()
    requested = body["requested_at"]
    assert body["delete_at"] > requested
    # Cookie сеанса стерта, все сеансы завершены
    assert "session" in response.headers.get("set-cookie", "")
    assert (await member.client.get("/api/me")).status_code == 401
    alive = await db.scalar(
        select(func.count())
        .select_from(UserSession)
        .where(UserSession.user_id == member.id, UserSession.revoked_at.is_(None))
    )
    assert alive == 0
    # Черновик отменен
    row = await db.get_one(Analysis, draft.id, populate_existing=True)
    assert row.status == "cancelled"
    # Вход снова: открыт только профиль и отмена
    client = await login(await make_client("10.0.0.3"), member.user)
    me = (await client.get("/api/me")).json()
    assert me["deletion_requested_at"] is not None
    delete_at = me["deletion_at"]
    assert delete_at is not None
    user = await db.get_one(User, member.id, populate_existing=True)
    assert user.deletion_requested_at is not None
    assert delete_at.startswith((user.deletion_requested_at + timedelta(days=7)).date().isoformat())
    for method, path, payload in (
        ("GET", "/api/me/bank", None),
        ("GET", "/api/me/notifications", None),
        ("POST", "/api/bets", {}),
        ("POST", "/api/analyses", {"input_kind": "form"}),
        ("POST", "/api/me/deletion", {"password": DEFAULT_PASSWORD, "code": "123456"}),
        ("GET", "/api/me/export", None),
    ):
        refused = await client.request(method, path, json=payload)
        assert refused.status_code == 403, (path, refused.text)
        assert error_code(refused) == "account.deletion_pending"
        assert refused.json()["error"]["delete_at"]
    # Отмена — и все снова работает
    cancelled = await client.delete("/api/me/deletion")
    assert cancelled.status_code == 204
    assert (await client.get("/api/me/bank")).status_code == 200
    assert (await client.get("/api/me")).json()["deletion_at"] is None
    again = await client.delete("/api/me/deletion")
    assert again.status_code == 409 and error_code(again) == "account.no_deletion"


async def test_wrong_password_or_code(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await signed_in(make_client, make_user, login)
    wrong_password = await member.client.post(
        "/api/me/deletion", json={"password": "not-my-password", "code": "123456"}
    )
    assert wrong_password.status_code == 400
    assert error_code(wrong_password) == "auth.current_password_invalid"
    wrong_code = await member.client.post(
        "/api/me/deletion", json={"password": DEFAULT_PASSWORD, "code": "000000"}
    )
    assert wrong_code.status_code == 400 and error_code(wrong_code) == "auth.invalid_code"
    row = await db.get_one(User, member.id, populate_existing=True)
    assert row.deletion_requested_at is None
    # Пароль: пять неверных подряд закрывают пару (email, IP), как при входе
    for _ in range(4):
        await member.client.post(
            "/api/me/deletion", json={"password": "not-my-password", "code": "123456"}
        )
    locked = await member.client.post(
        "/api/me/deletion",
        json={"password": DEFAULT_PASSWORD, "code": await totp_code(member.user)},
    )
    assert locked.status_code == 429 and error_code(locked) == "common.rate_limited"


async def test_only_admin_cannot_delete_self(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
) -> None:
    first = await signed_in(make_client, make_user, login, role="admin")
    refused = await _request(first, totp_code)
    assert refused.status_code == 409 and error_code(refused) == "account.last_admin"
    second = await signed_in(make_client, make_user, login, ip="10.0.0.2", role="admin")
    assert (await _request(first, totp_code)).status_code == 200
    # Первый уже ждет удаления — второй теперь единственный
    refused = await _request(second, totp_code)
    assert refused.status_code == 409 and error_code(refused) == "account.last_admin"


async def _member_with_data(db: AsyncSession, maker: BetMaker, made: MadeUser) -> None:
    await maker.bet(made, [LegSpec(), LegSpec()], bookmaker="Fonbet")
    db.add(Bookmaker(user_id=made.id, name="Fonbet", created_at=utcnow()))
    db.add(PlayLimit(user_id=made.id, bets_per_day=3))
    await db.commit()


async def test_due_accounts_are_erased_by_worker_job(
    make_user: UserFactory, db: AsyncSession, redis: Redis
) -> None:
    due = await make_user(display_name="Уходящий", email="leaving@example.com")
    waiting = await make_user()
    maker = BetMaker(db)
    await _member_with_data(db, maker, due)
    await _member_with_data(db, maker, waiting)
    now = utcnow()
    for made, ago in ((due, timedelta(days=7, minutes=1)), (waiting, timedelta(days=6))):
        row = await db.get_one(User, made.id)
        row.deletion_requested_at = now - ago
    await db.commit()
    cache_key = redis_key("analytics", due.id, "x")
    await redis.set(cache_key, "1")
    deleted = await account.delete_due_accounts(db, redis, now=now)
    assert deleted == [due.id]
    row = await db.get_one(User, due.id, populate_existing=True)
    assert row.status == "deleted" and row.email == f"deleted-{due.id}@deleted.invalid"
    assert row.display_name == "" and row.password_hash is None
    assert row.deletion_requested_at is None
    for model in (Bet, BankrollLedger, Bookmaker, PlayLimit):
        count = await db.scalar(
            select(func.count()).select_from(model).where(model.user_id == due.id)
        )
        assert count == 0, model
    # Ждущий 6 дней — нетронут
    other = await db.get_one(User, waiting.id, populate_existing=True)
    assert other.status == "active" and other.deletion_requested_at is not None
    assert await db.scalar(select(func.count()).select_from(Bet).where(Bet.user_id == waiting.id))
    # Журнал: без имени и email
    entry = await db.scalar(select(AdminAuditLog).where(AdminAuditLog.target_user_id == due.id))
    assert entry is not None and entry.action == "delete" and entry.details == {"self": True}
    assert "leaving" not in str(entry.details) and "Уходящий" not in str(entry.details)
    # Кэш аналитики удален
    assert await redis.exists(cache_key) == 0
    # Повтор ничего не делает
    assert await account.delete_due_accounts(db, redis, now=now) == []


async def test_due_last_admin_is_kept(
    make_user: UserFactory, db: AsyncSession, redis: Redis
) -> None:
    admin = await make_user(role="admin")
    admin_id = admin.id
    row = await db.get_one(User, admin_id)
    row.deletion_requested_at = utcnow() - timedelta(days=8)
    await db.commit()
    assert await account.delete_due_accounts(db, redis) == []
    kept = await db.get_one(User, admin_id, populate_existing=True)
    assert kept.status == "active" and kept.deletion_requested_at is not None


def test_worker_runs_deletion_and_alerts_on_schedule() -> None:
    names = {
        getattr(job, "__name__", getattr(job, "name", ""))
        for job in worker_main.WorkerSettings.functions
    }
    assert {"delete_requested_accounts", "check_ai_alerts"} <= names
    crons = worker_main.build_cron_jobs(get_settings())
    assert crons is not None
    cron_names = {job.name for job in crons}
    assert any("delete_requested_accounts" in name for name in cron_names)
    assert any("check_ai_alerts" in name for name in cron_names)


async def test_deleted_member_gone_from_admin_list(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    redis: Redis,
) -> None:
    member = await make_user()
    row = await db.get_one(User, member.id)
    row.deletion_requested_at = utcnow() - timedelta(days=7, seconds=1)
    await db.commit()
    assert await account.delete_due_accounts(db, redis) == [member.id]
    admin = await signed_in(make_client, make_user, login, role="admin")
    users = (await admin.client.get("/api/admin/users")).json()
    assert member.id not in [user["id"] for user in users]
