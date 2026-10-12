"""Доступ к Claude: причины отказа и их порядок (как в макете), резерв бюджета при
параллельных запусках, проверка перед вызовом, предупреждения о расходе без повторов и
общий бюджет ключа администратора."""

import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent.config import AgentConfig, load_agent_config
from app.agent.errors import ClaudeStepError
from app.agent.runs import worst_case_usd
from app.core.errors import AppError
from app.core.i18n import has_key
from app.core.security import crypto
from app.db.models import AgentRun, AiLimit, Analysis, AppSettings, Notification, User, UserSecret
from app.db.session import create_sessionmaker
from app.services.ai_access import (
    ACCESS_REASONS,
    ACCESS_STATUS,
    Room,
    access_for,
    after_run_notifications,
    budget_overview,
    call_need_usd,
    check_before_call,
    estimate_cost,
    fit_call,
    release_reservation,
    reserve_for_run,
    restart_access,
)
from app.services.sessions import utcnow
from tests.claude_mock import KEY, price_row, seed_prices
from tests.support import UserFactory

D = Decimal


async def _settings(db: AsyncSession) -> AppSettings:
    return await db.get_one(AppSettings, 1, populate_existing=True)


async def _set_admin_key(db: AsyncSession) -> None:
    row = await _settings(db)
    row.anthropic_key_enc, row.key_version = crypto.encrypt_str(
        KEY, crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    )
    row.key_last4 = KEY[-4:]
    await db.commit()


async def _limit(
    db: AsyncSession,
    user_id: int,
    *,
    monthly: str = "10",
    daily: int = 3,
    per: str = "1",
    paused: bool = False,
    own: str = "1",
) -> AiLimit:
    row = AiLimit(
        user_id=user_id,
        monthly_usd=D(monthly),
        daily_analyses=daily,
        per_analysis_usd=D(per),
        paused=paused,
        own_per_analysis_usd=D(own),
    )
    db.add(row)
    await db.commit()
    return row


async def _spend(
    db: AsyncSession,
    user_id: int | None,
    cost: str,
    *,
    key_source: str = "admin",
    kind: str = "analysis",
    analysis_id: int | None = None,
    at: datetime | None = None,
) -> None:
    run = AgentRun(
        user_id=user_id,
        key_source=key_source,
        kind=kind,
        model="claude-opus-5-5",
        cost_usd=D(cost),
        analysis_id=analysis_id,
    )
    if at is not None:
        run.created_at = at
    db.add(run)
    await db.commit()


async def _analysis(
    db: AsyncSession,
    user_id: int,
    *,
    status: str = "needs_confirmation",
    key_source: str | None = None,
    started_at: datetime | None = None,
    reserved: str = "0",
    cost: str = "0",
    cap: str | None = None,
) -> Analysis:
    row = Analysis(
        user_id=user_id,
        input_text="Синнер — Алькарас 1.80",
        status=status,
        key_source=key_source,
        started_at=started_at,
        budget_reserved_usd=D(reserved),
        cost_usd=D(cost),
        cost_cap_usd=D(cap) if cap is not None else None,
    )
    db.add(row)
    await db.commit()
    return row


async def _own_key(db: AsyncSession, user_id: int, *, verified: bool = True) -> UserSecret:
    ciphertext, version = crypto.encrypt_str(KEY, crypto.aad_for(crypto.AAD_USER_SECRET, user_id))
    secret = UserSecret(
        user_id=user_id,
        kind="anthropic_key",
        ciphertext=ciphertext,
        key_version=version,
        last4=KEY[-4:],
        verified_at=utcnow() if verified else None,
    )
    db.add(secret)
    await db.commit()
    return secret


def test_reason_codes_have_texts() -> None:
    for code in ACCESS_REASONS:
        assert has_key(f"errors.{code}"), code


async def test_member_reasons_in_mockup_order(db: AsyncSession, make_user: UserFactory) -> None:
    """Участник на ключе администратора: пауза → анализы на сегодня → дороже потолка
    анализа → лимит месяца → общий бюджет → нет ключа администратора → нет цены."""
    member = await make_user()
    limit = await _limit(db, member.id, monthly="1", daily=1, per="0.10", paused=True)
    await _analysis(db, member.id, status="done", key_source="admin", started_at=utcnow())
    await _spend(db, member.id, "1.00")
    settings = await _settings(db)
    settings.monthly_budget_usd = D("1")
    await db.commit()

    async def reason() -> str | None:
        return (await access_for(db, member.user, estimate_usd=D("0.50"))).reason

    assert await reason() == "ai.paused"
    limit.paused = False
    await db.commit()
    assert await reason() == "ai.daily_limit"
    limit.daily_analyses = 5
    await db.commit()
    assert await reason() == "ai.analysis_cap"
    limit.per_analysis_usd = D("1")
    await db.commit()
    assert await reason() == "ai.monthly_limit"
    limit.monthly_usd = D("100")
    await db.commit()
    assert await reason() == "ai.budget_exhausted"
    settings.monthly_budget_usd = D("100")
    await db.commit()
    assert await reason() == "ai.no_admin_key"
    await _set_admin_key(db)
    assert await reason() == "ai.no_price"
    await seed_prices(db)
    access = await access_for(db, member.user, estimate_usd=D("0.50"))
    assert access.allowed and access.reason is None
    assert (access.mode, access.key_source, access.has_key) == ("shared", "admin", True)
    assert access.key_last4 == KEY[-4:]
    assert access.spent_month_usd == D("1.00") and access.analyses_today == 1
    assert access.monthly_limit_usd == D("100") and access.left_month_usd == D("99.00")
    assert access.cap_usd == D("1") and access.soft_cap_usd == D("0.50")
    assert access.budget_left_usd == D("99.00")


async def test_own_key_reasons_and_budget_does_not_apply(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Свой ключ: нет проверенного ключа → дороже своего потолка → нет цены. Общий
    бюджет, лимиты и ключ администратора на свой ключ не влияют."""
    member = await make_user(ai_mode="own")
    await _limit(db, member.id, monthly="0", daily=0, paused=True, own="0.30")
    settings = await _settings(db)
    settings.monthly_budget_usd = D("0")
    await db.commit()
    await _spend(db, member.id, "0.70", key_source="own")
    await _spend(db, member.id, "0.20", key_source="admin")

    async def reason() -> str | None:
        return (await access_for(db, member.user, estimate_usd=D("0.50"))).reason

    assert await reason() == "ai.no_own_key"
    secret = await _own_key(db, member.id, verified=False)
    assert await reason() == "ai.no_own_key"
    secret.verified_at = utcnow()
    await db.commit()
    assert await reason() == "ai.own_cap"
    error = await access_for(db, member.user, estimate_usd=D("0.50"))
    assert error.reason_params == {"cap": "0,30", "estimate": "0,50"}
    # Без оценки «дороже потолка» не срабатывает
    assert (await access_for(db, member.user, estimate_usd=None)).reason == "ai.no_price"
    limit = await db.get_one(AiLimit, member.id)
    limit.own_per_analysis_usd = D("1")
    await db.commit()
    assert await reason() == "ai.no_price"
    await seed_prices(db)
    access = await access_for(db, member.user, estimate_usd=D("0.50"))
    assert access.allowed
    assert (access.mode, access.key_source, access.cap_usd) == ("own", "own", D("1"))
    assert access.spent_month_usd == D("0.70") and access.budget_usd is None
    assert access.monthly_limit_usd is None and access.daily_limit is None


async def test_admin_has_no_personal_limits(db: AsyncSession, make_user: UserFactory) -> None:
    """Администратор на ключе администратора: без паузы, анализов на день и лимита месяца
    (как в макете), но потолок анализа и общий бюджет действуют."""
    admin = await make_user(role="admin")
    await seed_prices(db)
    await _set_admin_key(db)
    for _ in range(5):
        await _analysis(db, admin.id, status="done", key_source="admin", started_at=utcnow())
    await _spend(db, admin.id, "50")
    access = await access_for(db, admin.user, estimate_usd=D("0.90"))
    assert access.allowed and access.monthly_limit_usd is None and access.daily_limit is None
    assert (await access_for(db, admin.user, estimate_usd=D("1.20"))).reason == "ai.analysis_cap"
    await _spend(db, None, "9.50")
    assert (await access_for(db, admin.user, estimate_usd=D("0.90"))).reason == (
        "ai.budget_exhausted"
    )


async def test_member_without_limit_row_gets_defaults(
    db: AsyncSession, make_user: UserFactory
) -> None:
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    access = await access_for(db, member.user, estimate_usd=None)
    assert access.allowed
    assert (access.monthly_limit_usd, access.daily_limit, access.cap_usd) == (D("10"), 3, D("1"))


async def test_no_price_when_model_changed(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    await _set_admin_key(db)
    await seed_prices(db, "claude-opus-5-5", "claude-sonnet-5-5")
    access = await access_for(db, member.user, estimate_usd=None)
    assert access.reason == "ai.no_price"
    assert access.reason_params == {"model": "claude-haiku-5-5"}


async def test_daily_count_in_member_timezone_and_restart(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """«Анализов в день» — по календарному дню в поясе участника; повторный запуск
    анализа второй раз не считается."""
    tz = "America/Los_Angeles"
    member = await make_user(tz=tz)
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, daily=1)
    local_midnight = (
        utcnow().astimezone(ZoneInfo(tz)).replace(hour=0, minute=0, second=0, microsecond=0)
    )
    await _analysis(
        db,
        member.id,
        status="done",
        key_source="admin",
        started_at=local_midnight - timedelta(minutes=1),
    )
    # Анализ на своем ключе в счет не идет
    await _analysis(db, member.id, status="done", key_source="own", started_at=utcnow())
    assert (await access_for(db, member.user, estimate_usd=None)).analyses_today == 0
    failed = await _analysis(
        db,
        member.id,
        status="failed",
        key_source="admin",
        started_at=local_midnight + timedelta(seconds=1),
    )
    access = await access_for(db, member.user, estimate_usd=None)
    assert access.analyses_today == 1 and access.reason == "ai.daily_limit"
    assert access.reason_params == {"daily": 1}

    # Перезапуск упавшего анализа проходит, новый анализ — нет
    reservation = await reserve_for_run(db, member.user, failed, estimate_usd=D("0.30"))
    assert reservation.started_at == local_midnight + timedelta(seconds=1)
    await db.commit()
    fresh = await _analysis(db, member.id)
    with pytest.raises(AppError) as caught:
        await reserve_for_run(db, member.user, fresh, estimate_usd=D("0.30"))
    assert caught.value.status_code == ACCESS_STATUS
    assert caught.value.code == "ai.daily_limit"
    await db.rollback()


async def test_restart_after_own_key_counts_today(db: AsyncSession, make_user: UserFactory) -> None:
    """Анализ, начатый на своем ключе, при первом перезапуске на ключе администратора
    идет в «анализы за день» этого дня: старый started_at лимит не обходит."""
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, daily=1)
    yesterday = utcnow() - timedelta(days=1)
    olds = [
        await _analysis(db, member.id, status="failed", key_source="own", started_at=yesterday)
        for _ in range(2)
    ]
    member_id, first_id, second_id = member.id, olds[0].id, olds[1].id
    first = await reserve_for_run(db, member.user, olds[0], estimate_usd=D("0.10"))
    assert first.key_source == "admin" and first.started_at > yesterday + timedelta(hours=23)
    olds[0].status = "queued"
    await db.commit()
    assert (await access_for(db, member.user, estimate_usd=None)).analyses_today == 1
    with pytest.raises(AppError) as caught:
        await reserve_for_run(db, member.user, olds[1], estimate_usd=D("0.10"))
    assert caught.value.code == "ai.daily_limit"
    await db.rollback()
    # Повторный перезапуск на ключе администратора второй раз не считается
    user = await db.get_one(User, member_id)
    row = await db.get_one(Analysis, first_id)
    row.status = "failed"
    await db.commit()
    again = await reserve_for_run(db, user, row, estimate_usd=D("0.10"))
    assert again.started_at == first.started_at
    await db.rollback()
    second = await db.get_one(Analysis, second_id)
    assert (second.key_source, second.started_at) == ("own", yesterday)


async def test_restart_cap_counts_spent(db: AsyncSession, make_user: UserFactory) -> None:
    """Перезапуск сравнивает с потолком уже потраченное анализом плюс оценку, как
    check_before_call: отказ сразу, а не на первом вызове."""
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, per="1.00")
    own = await make_user(ai_mode="own")
    await _own_key(db, own.id)
    await _limit(db, own.id, own="0.50")
    analysis = await _analysis(
        db, member.id, status="failed", key_source="admin", started_at=utcnow(), cost="0.95"
    )
    own_analysis = await _analysis(db, own.id, status="failed", key_source="own", cost="0.45")
    ids = {"member": member.id, "own": own.id, "analysis": analysis.id, "own_a": own_analysis.id}
    with pytest.raises(AppError) as caught:
        await reserve_for_run(db, member.user, analysis, estimate_usd=D("0.20"))
    assert caught.value.code == "ai.analysis_cap"
    assert caught.value.params == {"cap": "1,00", "estimate": "1,15"}
    await db.rollback()
    reservation = await reserve_for_run(
        db,
        await db.get_one(User, ids["member"]),
        await db.get_one(Analysis, ids["analysis"]),
        estimate_usd=D(0),
    )
    assert reservation.reserved_usd == D("0.95")
    assert reservation.cap_usd == D("1.00")
    await db.rollback()

    # Свой ключ: то же со своим потолком
    with pytest.raises(AppError) as own_caught:
        await reserve_for_run(
            db,
            await db.get_one(User, ids["own"]),
            await db.get_one(Analysis, ids["own_a"]),
            estimate_usd=D("0.20"),
        )
    assert own_caught.value.code == "ai.own_cap"
    assert own_caught.value.params == {"cap": "0,50", "estimate": "0,65"}
    await db.rollback()


async def test_restart_cap_needs_room_for_one_call(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Перезапуск с остатком работы пускают, только если в потолок помещается худший
    случай самого маленького вызова оценки матча (call_need_usd, $0,155 по ценам теста):
    его же требует fit_call перед вызовом. Раньше хватало оценки ($0,05), и перезапуск
    тут же падал на первом вызове с той же ai.analysis_cap."""
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, per="1.00")
    analysis = await _analysis(
        db, member.id, status="failed", key_source="admin", started_at=utcnow(), cost="0.90"
    )
    ids = (member.id, analysis.id)
    assert await call_need_usd(db, await load_agent_config(db), utcnow()) == D("0.155")

    # 0,90 + 0,05 помещается в $1, но 0,90 + 0,155 — нет
    with pytest.raises(AppError) as caught:
        await reserve_for_run(db, member.user, analysis, estimate_usd=D("0.05"))
    assert caught.value.code == "ai.analysis_cap"
    await db.rollback()
    user, row = await db.get_one(User, ids[0]), await db.get_one(Analysis, ids[1])
    assert (await restart_access(db, user, row, estimate_usd=D("0.05"))).reason == (
        "ai.analysis_cap"
    )

    # Вызовов не осталось (оценка 0) — места на вызов не нужно
    assert (await restart_access(db, user, row, estimate_usd=D(0))).reason is None
    reservation = await reserve_for_run(db, user, row, estimate_usd=D(0))
    assert reservation.reserved_usd == D("0.90")
    await db.rollback()

    # 0,845 + 0,155 = $1 ровно: пускают, резерв — по оценке (0,845 + 0,05 вверх до цента)
    await db.execute(update(Analysis).where(Analysis.id == ids[1]).values(cost_usd=D("0.845")))
    await db.commit()
    user, row = await db.get_one(User, ids[0]), await db.get_one(Analysis, ids[1])
    assert (await restart_access(db, user, row, estimate_usd=D("0.05"))).reason is None
    reservation = await reserve_for_run(db, user, row, estimate_usd=D("0.05"))
    assert reservation.reserved_usd == D("0.90")


async def test_reserve_writes_analysis(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, per="0.80")
    analysis = await _analysis(db, member.id, cost="0.10")
    before = utcnow()
    reservation = await reserve_for_run(db, member.user, analysis, estimate_usd=D("0.45671"))
    await db.commit()
    row = await db.get_one(Analysis, analysis.id, populate_existing=True)
    assert row.key_source == "admin" == reservation.key_source
    assert row.estimate_usd == D("0.4568") == reservation.estimate_usd
    # Уже потрачено 0,10 плюс оценка, вверх до цента
    assert row.budget_reserved_usd == D("0.56") == reservation.reserved_usd
    assert row.cost_cap_usd == D("0.80") == reservation.cap_usd
    assert row.started_at is not None and row.started_at >= before - timedelta(seconds=5)
    assert reservation.access.allowed

    # Свой ключ: потолок — свой, бюджет ключа администратора не проверяется
    own = await make_user(ai_mode="own")
    await _own_key(db, own.id)
    await _limit(db, own.id, own="2.50")
    settings = await _settings(db)
    settings.monthly_budget_usd = D("0")
    await db.commit()
    own_analysis = await _analysis(db, own.id)
    reserved = await reserve_for_run(db, own.user, own_analysis, estimate_usd=D("1.20"))
    await db.commit()
    assert (reserved.key_source, reserved.cap_usd) == ("own", D("2.50"))

    # Чужой анализ — 404
    with pytest.raises(AppError) as caught:
        await reserve_for_run(db, own.user, analysis, estimate_usd=D("0.10"))
    assert caught.value.status_code == 404
    await db.rollback()


async def _reserve_in_own_session(
    engine: AsyncEngine, user_id: int, analysis_id: int, estimate: str
) -> str | None:
    """Запуск анализа в своем сеансе, как параллельные запросы: резерв, статус queued,
    commit. Возвращает код отказа или None."""
    async with create_sessionmaker(engine)() as session:
        user = await session.get_one(User, user_id)
        analysis = await session.get_one(Analysis, analysis_id)
        try:
            await reserve_for_run(session, user, analysis, estimate_usd=D(estimate))
        except AppError as exc:
            await session.rollback()
            return exc.code
        analysis.status = "queued"
        await session.commit()
        return None


async def test_parallel_reserves_respect_member_limit(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory
) -> None:
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, monthly="1.00", daily=10)
    ids = [(await _analysis(db, member.id)).id for _ in range(3)]
    results = await asyncio.gather(
        *(_reserve_in_own_session(engine, member.id, aid, "0.40") for aid in ids)
    )
    assert sorted(results, key=str) == [None, None, "ai.monthly_limit"]
    reserved = await db.scalars(
        select(Analysis.budget_reserved_usd).where(Analysis.status == "queued")
    )
    assert sum(reserved, D(0)) == D("0.80")


async def test_parallel_reserves_respect_shared_budget(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory
) -> None:
    await seed_prices(db)
    await _set_admin_key(db)
    settings = await _settings(db)
    settings.monthly_budget_usd = D("1.00")
    await db.commit()
    jobs = []
    for _ in range(3):
        member = await make_user()
        analysis = await _analysis(db, member.id)
        jobs.append(_reserve_in_own_session(engine, member.id, analysis.id, "0.45"))
    results = await asyncio.gather(*jobs)
    assert sorted(results, key=str) == [None, None, "ai.budget_exhausted"]


async def test_check_before_call(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    await seed_prices(db)
    limit = await _limit(db, member.id, monthly="1.00")
    analysis = await _analysis(
        db, member.id, status="modelling", key_source="admin", reserved="0.50", cap="0.50"
    )
    await _spend(db, member.id, "0.30", analysis_id=analysis.id)

    # Потолок анализа: 0,30 + 0,20 = 0,50 — можно, + 0,25 — нельзя
    await check_before_call(db, analysis, D("0.20"))
    with pytest.raises(ClaudeStepError) as cap:
        await check_before_call(db, analysis, D("0.25"))
    assert cap.value.code == "ai.analysis_cap" and cap.value.params == {"cap": "0,50"}

    # Лимит месяца с резервом другого активного анализа (0,30 занято из 0,40)
    await _analysis(
        db, member.id, status="llm_review", key_source="admin", reserved="0.40", cost="0.10"
    )
    await _spend(db, member.id, "0.10")
    await check_before_call(db, analysis, D("0.10"))  # 0,40 + 0,30 + 0,10 = 0,80
    limit.monthly_usd = D("0.75")
    await db.commit()
    with pytest.raises(ClaudeStepError) as monthly:
        await check_before_call(db, analysis, D("0.10"))
    assert monthly.value.code == "ai.monthly_limit"

    # Пауза посреди анализа
    limit.monthly_usd = D("10")
    limit.paused = True
    await db.commit()
    with pytest.raises(ClaudeStepError) as paused:
        await check_before_call(db, analysis, D("0.01"))
    assert paused.value.code == "ai.paused"
    limit.paused = False
    await db.commit()

    # Общий бюджет с чужими расходами
    await _spend(db, None, "59.50")
    with pytest.raises(ClaudeStepError) as budget:
        await check_before_call(db, analysis, D("0.10"))
    assert budget.value.code == "ai.budget_exhausted"

    # Свой ключ: только потолок анализа
    analysis.key_source = "own"
    await db.commit()
    await check_before_call(db, analysis, D("0.10"))


OPUS = price_row("claude-opus-5-5")
SONNET = price_row("claude-sonnet-5-5")


def _fit(rooms: list[Room], *, in_flight: str = "0", min_tokens: int = 6000) -> Any:
    return fit_call(
        rooms,
        OPUS,
        input_tokens=7000,
        max_tokens=16_000,
        min_tokens=min_tokens,
        searches=0,
        in_flight_usd=D(in_flight),
    )


def _room(left: str, code: str = "ai.analysis_cap") -> Room:
    return Room(D(left), code, {})


def test_fit_call_waits_for_own_calls_and_cuts_max_tokens() -> None:
    """Перед вызовом: худший случай одного вызова Opus — $0,355 (7 тыс. × $5 + 16 тыс. ×
    $20), три таких в полете дороже потолка $1 (Р13). Не помещается только из-за своих
    вызовов в полете — ждать, а не останавливать анализ; не помещается и без них —
    урезать max_tokens до остатка, но не ниже min_tokens; меньше — ждать или отказ."""
    full = worst_case_usd(OPUS, input_tokens=7000, max_tokens=16_000)
    assert full == D("0.355")
    # Помещается целиком
    fit = _fit([_room("1.00")])
    assert (fit.max_tokens, fit.worst_usd, fit.wait, fit.refuse) == (16_000, full, False, None)
    # Два вызова в полете: третий ждет (раньше — отказ ai.analysis_cap при пустом расходе)
    assert _fit([_room("1.00")], in_flight="0.71").wait
    # Без вызовов в полете остатка $0,30 не хватает на весь max_tokens: урезаем
    cut = _fit([_room("0.30")])
    assert cut.max_tokens == 13_249 and cut.worst_usd <= D("0.30") and not cut.wait
    # Остаток минус вызовы в полете меньше 6 тыс. токенов, без них хватит — ждать
    assert _fit([_room("0.30")], in_flight="0.20").wait
    # Меньше min_tokens и ждать некого — отказ по первому ограничению, куда не влезает
    # самый маленький вызов ($0,155)
    refused = _fit(
        [_room("0.50"), _room("0.10", "ai.monthly_limit"), _room("5", "ai.budget_exhausted")]
    )
    assert refused.refuse is not None and refused.refuse.code == "ai.monthly_limit"
    # Остаток — меньшее из ограничений
    tight = _fit([_room("0.40"), _room("0.20", "ai.monthly_limit")])
    assert tight.max_tokens == 8249 and tight.worst_usd <= D("0.20")
    # Шаг без урезания (новости: min_tokens = max_tokens) — отказ, как раньше
    news = fit_call(
        [_room("0.10")],
        SONNET,
        input_tokens=15_000,
        max_tokens=8000,
        min_tokens=8000,
        searches=3,
        in_flight_usd=D(0),
    )
    assert news.refuse is not None and news.max_tokens is None


async def test_launch_needs_room_for_one_call(db: AsyncSession, make_user: UserFactory) -> None:
    """До запуска — та же мера, что перед вызовом (fit_call): свободным должен быть худший
    случай самого маленького допустимого вызова оценки матча (max_tokens урезается не ниже
    analysis_min_tokens), а не только оценка анализа. Иначе анализ запускался и
    останавливался на первом вызове Opus, а перезапуск упирался в то же (тупик)."""
    member = await make_user()
    admin = await make_user(role="admin")
    await seed_prices(db)
    await _set_admin_key(db)
    limit = await _limit(db, member.id, monthly="1.00", daily=30)
    await _spend(db, member.id, "0.86")
    need = await call_need_usd(db, AgentConfig(), utcnow())
    # 7 тыс. входа по цене записи кэша $5 и 6 тыс. выхода (analysis_min_tokens) по $20
    assert need == D("0.155")
    for estimate in (None, D("0.115")):
        access = await access_for(db, member.user, estimate_usd=estimate)
        assert (access.reason, access.left_month_usd) == ("ai.monthly_limit", D("0.14"))
    # Все оценки матчей уже есть (перезапуск после шага оценки): вызовов Claude не будет
    assert (await access_for(db, member.user, estimate_usd=D("0"))).allowed

    # Остатка хватает на худший случай вызова: запуск можно, и вызов пройдет проверку
    limit.monthly_usd = D("1.015")
    await db.commit()
    assert (await access_for(db, member.user, estimate_usd=None)).allowed
    analysis = await _analysis(db, member.id)
    await reserve_for_run(db, member.user, analysis, estimate_usd=D("0.115"))
    analysis.status = "llm_review"
    await db.commit()
    await check_before_call(db, analysis, need)

    # Общий бюджет — так же (администратор без личного лимита)
    settings = await _settings(db)
    budget_spent = await _sum_spent(db)
    settings.monthly_budget_usd = budget_spent + D("0.12") + D("0.14")
    await db.commit()
    assert (await access_for(db, admin.user, estimate_usd=D("0.115"))).reason == (
        "ai.budget_exhausted"
    )
    settings.monthly_budget_usd = budget_spent + D("0.12") + need
    await db.commit()
    assert (await access_for(db, admin.user, estimate_usd=D("0.115"))).allowed


async def test_launch_needs_news_plus_opus_call(db: AsyncSession, make_user: UserFactory) -> None:
    """Новости оплачиваются раньше Opus: до запуска свободной должна быть оценка шагов до
    последнего вызова Opus плюс худший случай этого вызова, а не максимум из оценки и
    худшего случая. Иначе при остатке $0,22 анализ по оценке $0,1975 (новости $0,0825 и
    Opus $0,115) запускался, платил за новости и останавливался на Opus (остаток $0,14
    меньше $0,155)."""
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    limit = await _limit(db, member.id, monthly="1.00", daily=30)
    await _spend(db, member.id, "0.78")
    estimate = D("0.1975")
    # 0,1975 + (0,155 − 0,115) = 0,2375 > 0,22
    access = await access_for(db, member.user, estimate_usd=estimate)
    assert (access.reason, access.left_month_usd) == ("ai.monthly_limit", D("0.22"))
    limit.monthly_usd = D("1.0175")
    await db.commit()
    assert (await access_for(db, member.user, estimate_usd=estimate)).allowed


async def _sum_spent(db: AsyncSession) -> Decimal:
    total = await db.scalar(select(func.sum(AgentRun.cost_usd)))
    return Decimal(total or 0)


async def test_release_and_finished_analyses_hold_nothing(
    db: AsyncSession, make_user: UserFactory
) -> None:
    member = await make_user()
    await seed_prices(db)
    await _set_admin_key(db)
    await _limit(db, member.id, monthly="1.00")
    active = await _analysis(db, member.id, status="composing", key_source="admin", reserved="0.60")
    # Анализ упал, а резерв не сняли: он не в работе и ничего не держит
    await _analysis(db, member.id, status="failed", key_source="admin", reserved="0.90")
    access = await access_for(db, member.user, estimate_usd=D("0.20"))
    assert access.reserved_usd == D("0.60") and access.allowed
    assert (await access_for(db, member.user, estimate_usd=D("0.45"))).reason == (
        "ai.monthly_limit"
    )
    await release_reservation(db, active)
    await db.commit()
    assert (await access_for(db, member.user, estimate_usd=D("0.45"))).allowed


async def _notes(db: AsyncSession, user_id: int) -> list[Notification]:
    return list(
        await db.scalars(
            select(Notification)
            .where(Notification.user_id == user_id)
            .order_by(Notification.id)
            .execution_options(populate_existing=True)
        )
    )


async def test_spending_alerts_once_per_month(db: AsyncSession, make_user: UserFactory) -> None:
    admin = await make_user(role="admin", display_name="Роман")
    await make_user(role="admin", status="blocked")
    member = await make_user(display_name="Ольга")
    own = await make_user(ai_mode="own")
    await _limit(db, member.id, monthly="10")
    await _limit(db, own.id, monthly="1")
    settings = await _settings(db)
    settings.monthly_budget_usd = D("12")
    await db.commit()

    await _spend(db, member.id, "8.50")
    first = await after_run_notifications(db, member.id)
    await db.commit()
    assert sorted((n.user_id, n.kind) for n in first) == [
        (admin.id, "limit_80"),
        (member.id, "limit_80"),
    ]
    [mine] = await _notes(db, member.id)
    assert mine.title == "Израсходовано 80% лимита на ИИ"
    assert "8,50" in mine.body and "10,00" in mine.body
    [for_admin] = await _notes(db, admin.id)
    assert for_admin.title == "Ольга: израсходовано 80% лимита на ИИ"
    assert for_admin.params["variant"] == "admin"
    assert (mine.link, for_admin.link) == ("/profile/key", "/admin/key#adm-limits")
    assert await after_run_notifications(db, member.id) == []

    await _spend(db, member.id, "1.50")
    second = await after_run_notifications(db, member.id)
    await db.commit()
    assert sorted(n.kind for n in second) == ["budget_80", "limit_100", "limit_100"]
    assert {n.link for n in second if n.kind == "budget_80"} == {"/admin/key"}
    assert await after_run_notifications(db, member.id) == []

    await _spend(db, None, "2.00")
    third = await after_run_notifications(db, None)
    await db.commit()
    assert [(n.user_id, n.kind) for n in third] == [(admin.id, "budget_100")]
    assert await after_run_notifications(db, None) == []

    # Свой ключ — без предупреждений о лимите (расход не с ключа администратора)
    await _spend(db, own.id, "5", key_source="own")
    assert await after_run_notifications(db, own.id) == []
    await db.commit()
    assert {n.kind for n in await _notes(db, member.id)} == {"limit_80", "limit_100"}


async def test_limit_100_when_left_is_less_than_one_call(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Порог 100% — когда остатка не хватает на самый маленький вызов оценки матча ($0,155):
    анализы уже не запускаются, хотя потрачено меньше лимита. Раньше limit_100 и
    budget_100 приходили только при расходе ≥ 100%, которого проверки перед вызовом не
    допускают, и участник останавливался без уведомления."""
    await seed_prices(db)
    admin = await make_user(role="admin")
    member = await make_user()
    await _limit(db, member.id, monthly="1.00")
    settings = await _settings(db)
    settings.monthly_budget_usd = D("60")
    await db.commit()
    await _spend(db, member.id, "0.84")  # остаток 0,16 ≥ 0,155 — пока 80%
    assert {(n.user_id, n.kind) for n in await after_run_notifications(db, member.id)} == {
        (member.id, "limit_80"),
        (admin.id, "limit_80"),
    }
    await _spend(db, member.id, "0.05")  # остаток 0,11 — анализ не запустится
    access = await access_for(db, member.user, estimate_usd=None)
    assert access.reason == "ai.monthly_limit"
    assert {(n.user_id, n.kind) for n in await after_run_notifications(db, member.id)} == {
        (member.id, "limit_100"),
        (admin.id, "limit_100"),
    }
    [*_, note] = await _notes(db, member.id)
    assert note.title == "Лимит на ИИ исчерпан" and "0,89" in note.body
    # Общий бюджет: остаток 0,10 — budget_100 администраторам
    await _spend(db, None, "59.01")
    assert [(n.user_id, n.kind) for n in await after_run_notifications(db, None)] == [
        (admin.id, "budget_100")
    ]
    await db.commit()


async def test_alert_of_previous_month_does_not_block(
    db: AsyncSession, make_user: UserFactory
) -> None:
    member = await make_user()
    await _limit(db, member.id, monthly="10")
    settings = await _settings(db)
    settings.budget_alert_pct = 50
    await db.commit()
    old = Notification(
        user_id=member.id,
        kind="limit_80",
        title="x",
        params={"subject": str(member.id)},
        created_at=utcnow() - timedelta(days=40),
    )
    db.add(old)
    await db.commit()
    await _spend(db, member.id, "5.00")
    [note] = await after_run_notifications(db, member.id)
    assert note.kind == "limit_80" and note.title == "Израсходовано 50% лимита на ИИ"


async def test_budget_overview(db: AsyncSession, make_user: UserFactory) -> None:
    now = datetime(2026, 10, 10, 12, tzinfo=UTC)
    at = datetime(2026, 10, 5, tzinfo=UTC)
    admin = await make_user(role="admin")
    first = await make_user()
    paused = await make_user()
    own = await make_user(ai_mode="own")
    gone = await make_user(status="deleted")
    await _limit(db, first.id, monthly="10")
    await _limit(db, paused.id, monthly="5", paused=True)
    for user_id, cost in (
        (first.id, "2"),
        (paused.id, "1"),
        (admin.id, "3"),
        (gone.id, "1"),
        (None, "0.5"),
        (own.id, "0.7"),
    ):
        await _spend(db, user_id, cost, at=at)
    await _spend(db, own.id, "9", key_source="own", at=at)
    await _spend(db, admin.id, "4", kind="eval", at=at)
    await _spend(db, first.id, "7", at=datetime(2026, 9, 30, 23, 59, tzinfo=UTC))
    await _analysis(
        db, first.id, status="modelling", key_source="admin", reserved="0.30", cost="0.10"
    )
    overview = await budget_overview(db, now)
    assert overview.month_start == datetime(2026, 10, 1, tzinfo=UTC)
    assert (overview.days_in_month, overview.days_left) == (31, 21)
    assert overview.budget_usd == D("60") and overview.spent_usd == D("8.2")
    assert overview.left_usd == D("51.8") and overview.reserved_usd == D("0.20")
    # 2 → min(10, 6,2); пауза — 1; администратор 3 → 9,3; удаленный — 1;
    # без участника 0,5 → 1,55; на своем ключе — 0,7
    assert overview.forecast_usd == D("19.75")
    assert overview.members_limits_usd == D("15")
    assert (overview.eval_budget_usd, overview.eval_spent_usd) == (D("25"), D("4"))
    assert overview.alert_pct == 80


def test_estimate_cost() -> None:
    prices = {m: price_row(m) for m in ("claude-opus-5-5", "claude-sonnet-5-5")}
    config = AgentConfig()
    # анализ 7000 × 5 + 4000 × 20 = 0,115; новости 37000 × 2,5 + 1500 × 10 + 2 × 0,01 = 0,1275
    assert estimate_cost(config, prices, matches=2) == D("0.4850")
    assert estimate_cost(AgentConfig(news_enabled=False), prices, matches=2) == D("0.2300")
