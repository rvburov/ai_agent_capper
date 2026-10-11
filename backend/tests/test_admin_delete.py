"""Удаление участника по Р15: личные данные удалены во всех таблицах, прогнозы
обезличены при согласии и удалены без него, agent_runs остались, строка users
обезличена."""

from dataclasses import dataclass
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import Table, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.security.tokens import hash_code, new_token
from app.db.base import Base
from app.db.models import (
    AccessCode,
    AgentRun,
    AiLimit,
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    EvalRun,
    Lesson,
    LoginEvent,
    Match,
    Notification,
    Player,
    Prediction,
    PushSubscription,
    RecoveryCode,
    StrategyVersion,
    TrustedDevice,
    User,
    UserSecret,
)
from app.services import admin_users
from app.services.sessions import utcnow
from tests.helpers_admin import admin_signed_in, audit_entries, error_code, signed_in
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

USERS = Base.metadata.tables["users"]


def _user_fk_columns(ondelete: str) -> list[tuple[Table, str]]:
    """Все колонки с внешним ключом на users.id и заданным ON DELETE."""
    found: list[tuple[Table, str]] = []
    for table in Base.metadata.sorted_tables:
        if table is USERS:
            continue
        for fk in table.foreign_keys:
            if fk.column.table is USERS and (fk.ondelete or "").upper() == ondelete:
                found.append((table, fk.parent.name))
    return found


# Слова в ключах details журнала, которых там быть не должно (Р14)
PRIVATE_WORDS = ("bet", "bank", "ledger", "strateg", "lesson")


def _private_keys(value: Any) -> list[str]:
    """Ключи на любой глубине, в которых есть слово про ставки, банк или стратегию."""
    if isinstance(value, dict):
        own = [str(k) for k in value if any(w in str(k).lower() for w in PRIVATE_WORDS)]
        return own + [key for item in value.values() for key in _private_keys(item)]
    if isinstance(value, list):
        return [key for item in value for key in _private_keys(item)]
    return []


@dataclass
class Personal:
    """id строк, созданных для участника."""

    match_id: int
    prediction_ids: list[int]
    eval_prediction_id: int
    agent_run_id: int
    bet_id: int


async def _fill_personal_data(db: AsyncSession, user: User, *, suffix: str) -> Personal:
    """Все виды личных данных участника: ставки, банк, стратегия, уроки, анализы,
    прогнозы, ключ, лимит, уведомления, push, журнал входов, коды, устройства."""
    uid = user.id
    now = utcnow()
    p1, p2 = Player(name=f"Sinner {suffix}"), Player(name=f"Alcaraz {suffix}")
    db.add_all([p1, p2])
    await db.flush()
    match = Match(player1_id=p1.id, player2_id=p2.id, source="legacy", source_ref=f"m-{suffix}")
    strategy = StrategyVersion(user_id=uid, code="v1", status="active")
    db.add_all([match, strategy])
    await db.flush()
    eval_run = EvalRun(
        version_kind="strategy", strategy_version_id=strategy.id, eval_set="e1", split="test"
    )
    analysis = Analysis(
        user_id=uid, input_text="Синнер — Алькарас", status="done", strategy_version_id=strategy.id
    )
    db.add_all([eval_run, analysis])
    await db.flush()
    run = AgentRun(
        user_id=uid,
        key_source="admin",
        analysis_id=analysis.id,
        eval_run_id=eval_run.id,
        kind="analysis",
        model="claude-opus-5-5",
        cost_usd=Decimal("0.2"),
    )
    db.add(run)
    await db.flush()
    first = Prediction(
        user_id=uid,
        analysis_id=analysis.id,
        match_id=match.id,
        market="ML",
        selection=1,
        as_of=now,
        strategy_version_id=strategy.id,
        agent_run_id=run.id,
        p_final=0.6,
        rationale="форма лучше",
    )
    db.add(first)
    await db.flush()
    second = Prediction(
        user_id=uid,
        analysis_id=analysis.id,
        match_id=match.id,
        market="ML",
        selection=1,
        as_of=now,
        strategy_version_id=strategy.id,
        agent_run_id=run.id,
        p_final=0.62,
        supersedes=first.id,
    )
    eval_prediction = Prediction(
        user_id=uid,
        match_id=match.id,
        market="ML",
        selection=2,
        as_of=now,
        is_eval=True,
        eval_run_id=eval_run.id,
        strategy_version_id=strategy.id,
    )
    bet = Bet(
        user_id=uid,
        analysis_id=analysis.id,
        placed_at=now,
        bookmaker="Fonbet",
        stake=Decimal("100"),
        currency="RUB",
        total_odds=Decimal("1.9"),
    )
    db.add_all([second, eval_prediction, bet])
    await db.flush()
    db.add_all(
        [
            BetLeg(
                bet_id=bet.id,
                match_id=match.id,
                market="ML",
                selection=1,
                odds_taken=Decimal("1.9"),
                prediction_id=second.id,
            ),
            BankrollLedger(user_id=uid, kind="deposit", amount=Decimal("1000"), currency="RUB"),
            BankrollLedger(
                user_id=uid, kind="stake", amount=Decimal("-100"), currency="RUB", bet_id=bet.id
            ),
            Lesson(user_id=uid, code="L-001", text="Фавориты на грунте", kind="numeric"),
            UserSecret(
                user_id=uid, kind="anthropic_key", ciphertext=b"x", key_version=1, last4="abcd"
            ),
            AiLimit(
                user_id=uid,
                monthly_usd=Decimal("10"),
                daily_analyses=3,
                per_analysis_usd=Decimal("1"),
            ),
            Notification(user_id=uid, kind="new_device", title="Вход"),
            PushSubscription(
                user_id=uid, endpoint=f"https://push.example/{suffix}", p256dh="k", auth="a"
            ),
            LoginEvent(user_id=uid, ip="10.0.0.1", result="ok", method="password"),
            TrustedDevice(
                user_id=uid,
                token_hash=hash_code(new_token()),
                expires_at=now + timedelta(days=30),
            ),
            RecoveryCode(user_id=uid, code_hash=hash_code(new_token())),
            AccessCode(
                kind="password_reset",
                code_hash=hash_code(new_token()),
                user_id=uid,
                expires_at=now + timedelta(hours=24),
            ),
            AccessCode(
                kind="invite",
                code_hash=hash_code(new_token()),
                email=user.email.upper(),
                role="member",
                ai_mode="shared",
                expires_at=now + timedelta(days=7),
                used_at=now,
                used_by=uid,
            ),
        ]
    )
    await db.commit()
    return Personal(
        match_id=match.id,
        prediction_ids=[first.id, second.id],
        eval_prediction_id=eval_prediction.id,
        agent_run_id=run.id,
        bet_id=bet.id,
    )


async def _rows_of(db: AsyncSession, user_id: int) -> dict[str, int]:
    """Сколько строк в каждой таблице с ON DELETE CASCADE ссылается на пользователя."""
    counts: dict[str, int] = {}
    for table, column in _user_fk_columns("CASCADE"):
        n = await db.scalar(
            select(func.count()).select_from(table).where(table.c[column] == user_id)
        )
        counts[f"{table.name}.{column}"] = int(n or 0)
    return counts


async def _reaches_user(
    db: AsyncSession, table: Table, row_id: Any, user_id: int, depth: int = 0
) -> list[str]:
    """Пути по внешним ключам от строки до users.id = user_id (пусто — пути нет)."""
    if depth > 5:
        return []
    [pk] = list(table.primary_key.columns)
    row = (await db.execute(select(table).where(pk == row_id))).mappings().first()
    if row is None:
        return []
    paths: list[str] = []
    for fk in table.foreign_keys:
        value = row[fk.parent.name]
        if value is None:
            continue
        target = fk.column.table
        if target is USERS:
            if value == user_id:
                paths.append(f"{table.name}.{fk.parent.name}")
            continue
        for tail in await _reaches_user(db, target, value, user_id, depth + 1):
            paths.append(f"{table.name}.{fk.parent.name} → {tail}")
    return paths


async def _delete(signed: Any, user_id: int, email: str, totp_code: TotpCodeFn) -> Any:
    return await signed.client.request(
        "DELETE",
        f"/api/admin/users/{user_id}",
        json={"confirm_email": email, "totp_code": await totp_code(signed.user)},
    )


@pytest.mark.parametrize("consent", [True, False], ids=["consent", "no_consent"])
async def test_delete_member_erases_personal_data(
    consent: bool,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(
        make_client,
        make_user,
        login,
        email="olga@example.com",
        display_name="Ольга",
        consent_training=consent,
    )
    other = await signed_in(make_client, make_user, login, email="ivan@example.com")
    member_id, other_id = member.id, other.id
    data = await _fill_personal_data(db, member.user.user, suffix="m")
    await _fill_personal_data(db, other.user.user, suffix="o")
    other_before = await _rows_of(db, other_id)
    assert all(other_before.values()), other_before
    before = await _rows_of(db, member_id)
    # Каждая таблица с личными данными участника действительно заполнена
    assert all(before.values()), before

    response = await _delete(admin, member_id, " OLGA@example.com ", totp_code)
    assert response.status_code == 204, response.text

    after = await _rows_of(db, member_id)
    assert not any(after.values()), after
    assert await _rows_of(db, other_id) == other_before

    user = await db.get_one(User, member_id, populate_existing=True)
    assert user.status == "deleted"
    assert user.email == f"deleted-{member_id}@deleted.invalid"
    assert user.display_name == ""
    assert user.password_hash is None
    assert user.totp_enabled is False and user.totp_secret_enc is None
    assert user.totp_key_version is None and user.totp_last_step is None
    assert user.deleted_at is not None and user.last_login_at is None

    # Расход на ИИ остается в бюджете месяца
    run = await db.get_one(AgentRun, data.agent_run_id, populate_existing=True)
    assert run.user_id == member_id
    assert run.analysis_id is None and run.eval_run_id is None

    predictions = list(
        await db.scalars(
            select(Prediction)
            .where(Prediction.id.in_([*data.prediction_ids, data.eval_prediction_id]))
            .execution_options(populate_existing=True)
        )
    )
    if consent:
        # Прогнозы анализа остались без пути к человеку, прогон eval удален со стратегией
        assert sorted(p.id for p in predictions) == data.prediction_ids
        prediction_table = Base.metadata.tables["predictions"]
        for p in predictions:
            assert p.user_id is None and p.agent_run_id is None
            assert p.analysis_id is None and p.strategy_version_id is None
            assert await _reaches_user(db, prediction_table, p.id, member_id) == []
    else:
        assert predictions == []
    # Ставка и ее событие удалены, матч (общие данные) остался
    assert await db.get(Bet, data.bet_id, populate_existing=True) is None
    assert await db.get(Match, data.match_id) is not None

    [entry] = await audit_entries(db, "delete")
    assert entry.actor_id == admin.id and entry.target_user_id == member_id
    # Р14: журнал видят администраторы, поэтому в нем нет даже числа ставок и записей банка
    assert entry.details == {
        "display_name": "Ольга",
        "email": "olga@example.com",
        "consent_training": consent,
    }
    [listed] = [
        row
        for row in (await admin.client.get("/api/admin/audit")).json()
        if row["action"] == "delete"
    ]
    assert not _private_keys(listed["details"])

    listing = (await admin.client.get("/api/admin/users")).json()
    assert member_id not in {row["id"] for row in listing}
    assert (await member.client.get("/api/admin/users")).status_code == 401
    again = await _delete(admin, member_id, user.email, totp_code)
    assert again.status_code == 404


async def test_set_null_references_are_only_expected_tables() -> None:
    """Ссылки на users с SET NULL не удаляются при удалении участника. Здесь список
    таких мест: новая таблица с личными данными должна ссылаться на users с CASCADE
    и попасть в _erase_personal_data, а не тихо остаться."""
    expected = {
        "access_codes.created_by",
        "access_codes.used_by",
        "admin_audit_log.actor_id",
        "admin_audit_log.target_user_id",
        "agent_runs.user_id",
        "ai_limits.updated_by",
        "app_settings.updated_by",
        "predictions.user_id",
        "strategy_versions.approved_by",
    }
    found = {f"{table.name}.{column}" for table, column in _user_fk_columns("SET NULL")}
    assert found == expected


async def test_delete_refusals(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user(email="olga@example.com")
    member_id = member.id

    mismatch = await _delete(admin, member_id, "other@example.com", totp_code)
    assert mismatch.status_code == 400
    assert error_code(mismatch) == "admin.confirm_email_mismatch"

    nul = await _delete(admin, member_id, "olga@example.com\x00", totp_code)
    assert nul.status_code == 422
    assert error_code(nul) == "validation"

    good = await totp_code(admin.user)
    wrong = "000000" if good != "000000" else "111111"
    bad_code = await admin.client.request(
        "DELETE",
        f"/api/admin/users/{member_id}",
        json={"confirm_email": "olga@example.com", "totp_code": wrong},
    )
    assert bad_code.status_code == 403
    assert error_code(bad_code) == "admin.totp_invalid"

    self_delete = await _delete(admin, admin.id, admin.user.email, totp_code)
    assert self_delete.status_code == 400
    assert error_code(self_delete) == "admin.cannot_delete_self"

    user = await db.get_one(User, member_id, populate_existing=True)
    assert user.status == "active" and user.email == "olga@example.com"
    assert await audit_entries(db, "delete") == []


async def test_delete_last_admin_is_refused(make_user: UserFactory, db: AsyncSession) -> None:
    """Удаляющий администратор сам только что понижен (гонка): цель — последний
    активный администратор."""
    actor = await make_user(role="admin")
    target = await make_user(role="admin")
    target_id, target_email = target.id, target.email
    await db.execute(update(User).where(User.id == actor.id).values(role="member"))
    await db.commit()
    with pytest.raises(AppError) as exc:
        await admin_users.delete_user(
            db, target_id, confirm_email=target_email, actor=None, ip=None
        )
    assert exc.value.code == "admin.last_admin"
    await db.rollback()
    user = await db.get_one(User, target_id, populate_existing=True)
    assert user.status == "active"


async def test_delete_member_drops_admin_notifications_about_them(
    make_user: UserFactory, db: AsyncSession
) -> None:
    """Р15: уведомления администраторов об участнике (просьба вернуть ключ, его лимит)
    несут его имя в params и удаляются вместе с его данными; о других — остаются."""
    admin = await make_user(role="admin")
    member = await make_user(email="olga@example.com")
    other = await make_user(email="ivan@example.com")
    admin_id, member_id, other_id = admin.id, member.id, other.id

    def note(kind: str, subject: str) -> Notification:
        return Notification(
            user_id=admin_id,
            kind=kind,
            title="t",
            body="b",
            params={"subject": subject, "name": "Ольга"},
        )

    db.add_all(
        [
            note("ai_mode_request", str(member_id)),
            note("limit_80", str(member_id)),
            note("limit_100", str(member_id)),
            note("limit_80", str(other_id)),
            note("ai_mode_request", str(other_id)),
            note("budget_80", "budget"),
        ]
    )
    await db.commit()

    await admin_users.delete_user(
        db, member_id, confirm_email="olga@example.com", actor=None, ip=None
    )
    left = sorted(
        (row.kind, row.params["subject"])
        for row in await db.scalars(
            select(Notification)
            .where(Notification.user_id == admin_id)
            .execution_options(populate_existing=True)
        )
    )
    assert left == sorted(
        [("ai_mode_request", str(other_id)), ("budget_80", "budget"), ("limit_80", str(other_id))]
    )
