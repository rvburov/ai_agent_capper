"""Смена валюты программы и суммы вне таблиц денег (Т30, ревью волны 4): банк
подтвержденного ввода, который берет воркер (confirmed.bank), рекомендация готового
анализа (result.express.stake) и предупреждение о банке, формы, открытые до смены
(currency формы), остаток округления строк журнала, отказ «не поместится» без суммы
участника (Р14)."""

import asyncio
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.errors import AppError
from app.db.models import Analysis, AppSettings, BankrollLedger, Bet, User
from app.db.session import create_sessionmaker
from app.ml.strategy import StrategyParams
from app.schemas.analyses import ConfirmIn
from app.services import analyses as analyses_service
from app.services import analysis_result, analysis_run
from app.services.app_settings import Rate, converted_stake
from app.services.bank import CURRENCY_LOCK, bank_state
from tests.analysis_helpers import (
    event_in,
    install,
    install_gated,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
)
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, admin_signed_in, audit_entries, error_code, signed_in
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

D = Decimal
URL = "/api/admin/settings/currency"
# Окно смены считает от рублей — валюты программы в начале каждого теста
FROM_RUB = {"from_currency": "RUB"}


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


class _StepGate:
    """Держит первый вызов шага analysis, пока тест не отпустит (смена валюты посреди
    анализа)."""

    def __init__(self) -> None:
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def __call__(self, step: str, body: dict[str, Any], number: int) -> None:
        if step == "analysis" and not self.entered.is_set():
            self.entered.set()
            await self.release.wait()


@pytest.fixture
def step_gate() -> Iterator[_StepGate]:
    gate = _StepGate()
    for _ in install_gated(FakeClaude(), gate):
        yield gate


async def _change(
    admin: Signed, totp_code: TotpCodeFn, currency: str = "EUR", base: str = "EUR"
) -> dict[str, Any]:
    current = (await admin.client.get("/api/admin/settings")).json()["currency"]
    body = {
        "from_currency": current,
        "currency": currency,
        "rate": "95",
        "rate_base": base,
        "totp_code": await totp_code(admin.user),
    }
    response = await admin.client.put(URL, json=body)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def _no_queue(analysis_id: int, attempt: int, job_id: str) -> None:
    return None


def _stake(row: Analysis) -> dict[str, Any]:
    assert row.result is not None and row.result["express"] is not None
    stake: dict[str, Any] = row.result["express"]["stake"]
    return stake


async def test_queued_and_restarted_analysis_count_from_converted_bank(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    fake: FakeClaude,
) -> None:
    """Воркер берет банк из confirmed: в очереди и после сбоя он уже в новой валюте."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    pairs = (("sinner", "rune"), ("djokovic", "rublev"))
    queued = await make_analysis(db, redis, member.user.user, world, *pairs, bank="10000")
    failed = await make_analysis(db, redis, member.user.user, world, *pairs, bank="10000")
    # Воркер упал до шагов: анализ остановлен и будет перезапущен после смены
    await db.execute(
        update(Analysis)
        .where(Analysis.id == failed)
        .values(status="failed", error_code="analysis.worker_lost")
    )
    await db.commit()
    await _change(admin, totp_code)
    for analysis_id in (queued, failed):
        row = await db.get_one(Analysis, analysis_id, populate_existing=True)
        # 10 000 ₽ ÷ 95 = 105,263… → 105,26 € и в колонке, и в подтвержденном вводе
        assert row.bank_input == D("105.26") and row.confirmed is not None
        assert row.confirmed["bank"] == "105.26"
    assert await run(engine, redis, queued) == "done"
    user = member.user.user
    restarted = await analyses_service.start_run(db, redis, user, failed, None, enqueue=_no_queue)
    assert restarted.status == "queued"
    assert await run(engine, redis, failed) == "done"
    for analysis_id in (queued, failed):
        row = await db.get_one(Analysis, analysis_id, populate_existing=True)
        stake = _stake(row)
        # Сумма — от банка в евро: 105,26 × 2,75% = 2,89 → 2 € (шаг евро — 1)
        assert stake["bank"] == "105.26" and stake["currency"] == "EUR"
        assert stake["bank_source"] == "input" and stake["amount"] == "2.00"


async def test_running_analysis_counts_from_converted_bank(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    step_gate: _StepGate,
) -> None:
    """Смена валюты, пока анализ идет: воркер берет банк для суммы из confirmed под
    блокировкой строки, а не из памяти с начала прогона."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    pairs = (("sinner", "rune"), ("djokovic", "rublev"))
    analysis_id = await make_analysis(db, redis, member.user.user, world, *pairs, bank="10000")
    task = asyncio.create_task(run(engine, redis, analysis_id))
    await asyncio.wait_for(step_gate.entered.wait(), 20)
    await _change(admin, totp_code)
    step_gate.release.set()
    assert await asyncio.wait_for(task, 60) == "done"
    stake = _stake(await db.get_one(Analysis, analysis_id, populate_existing=True))
    # 10 000 ₽ ÷ 95 = 105,26 €; без свежего confirmed было бы 10 000 и 275 €
    assert stake["bank"] == "105.26" and stake["currency"] == "EUR"
    assert stake["amount"] == "2.00"


async def test_done_analysis_recommendation_in_new_currency(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    fake: FakeClaude,
) -> None:
    """EUR → RUB: рекомендация готового анализа — в рублях, и «Поставил» с ней
    записывает ту же сумму, а не в 95 раз меньшую."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    await db.execute(update(AppSettings).values(currency="EUR"))
    await db.commit()
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    pairs = (("sinner", "rune"), ("djokovic", "rublev"))
    big = await make_analysis(db, redis, member.user.user, world, *pairs, bank="10000")
    small = await make_analysis(db, redis, member.user.user, world, *pairs, bank="30")
    assert await run(engine, redis, big) == "done"
    assert await run(engine, redis, small) == "done"
    before = _stake(await db.get_one(Analysis, small, populate_existing=True))
    # 30 € × 2,75% = 0,83 → 0 € (шаг 1 €) — меньше минимальной ставки 0,50 €
    assert before["amount"] is None and before["reason"] == "below_min"
    await _change(admin, totp_code, currency="RUB")
    view = (await member.client.get(f"/api/analyses/{big}")).json()["result"]["express"]
    stake = view["stake"]
    # 10 000 € × 95 = 950 000 ₽; 950 000 × 2,75% = 26 125 → 26 120 ₽ (шаг 10 ₽)
    assert (stake["currency"], stake["bank"], stake["amount"]) == ("RUB", "950000.00", "26120.00")
    assert stake["steps"][-1]["kind"] == "round"
    assert stake["steps"][-1]["params"] == {
        "bank": "950000.00",
        "raw": "26125.00",
        "step": "10",
        "amount": "26120.00",
    }
    # Маленький банк: 2 850 ₽ × 2,75% = 78,38 → 70 ₽ — сумма появилась, «меньше
    # минимума» больше нет
    small_stake = _stake(await db.get_one(Analysis, small, populate_existing=True))
    assert (small_stake["bank"], small_stake["amount"], small_stake["reason"]) == (
        "2850.00",
        "70.00",
        None,
    )
    assert [step["kind"] for step in small_stake["steps"]][-1] == "round"
    assert "below_min" not in [step["kind"] for step in small_stake["steps"]]
    body = {
        "analysis_id": big,
        "stake": stake["amount"],
        "bookmaker": "Fonbet",
        "legs": [
            {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds"]}
            for leg in view["legs"]
        ],
        "client_ref": "ref-after-change",
    }
    # Форма, открытая до смены (видела евро), — 409, ставки нет
    stale = await member.client.post("/api/bets", json={**body, "currency": "EUR"})
    assert stale.status_code == 409 and error_code(stale) == "common.currency_changed"
    assert stale.json()["error"]["currency"] == "RUB"
    placed = await member.client.post("/api/bets", json={**body, "currency": "RUB"})
    assert placed.status_code == 201, placed.text
    saved = await db.get_one(Bet, placed.json()["id"], populate_existing=True)
    assert (saved.stake, saved.currency) == (D("26120.00"), "RUB")
    ledger = [
        (row.kind, row.amount)
        for row in await db.scalars(
            select(BankrollLedger)
            .where(BankrollLedger.user_id == member.id)
            .order_by(BankrollLedger.id)
        )
    ]
    assert ledger == [("deposit", D("950000.00")), ("stake", D("-26120.00"))]


async def test_bank_warning_amounts_converted(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    fake: FakeClaude,
) -> None:
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    db.add(BankrollLedger(user_id=member.id, kind="deposit", amount=D("5000"), currency="RUB"))
    await db.commit()
    analysis_id = await make_analysis(
        db, redis, member.user.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"
    preview = await admin.client.put(
        URL, json={**FROM_RUB, "currency": "EUR", "rate": "95", "rate_base": "EUR", "preview": True}
    )
    # Анализ с суммами один: банк из ввода, рекомендация и предупреждение — в нем
    assert preview.json()["analyses"] == 1
    await _change(admin, totp_code)
    row = await db.get_one(Analysis, analysis_id, populate_existing=True)
    assert row.result is not None
    warnings = [w for w in row.result["warnings"] if w["key"].endswith("bank_differs")]
    # 10 000 ₽ → 105,26 €, 5 000 ₽ → 52,63 €
    assert [w["params"] for w in warnings] == [{"input": "105.26", "ledger": "52.63"}]
    assert _stake(row)["bank"] == "105.26"


async def test_rounding_correction_keeps_bank(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    totp_code: TotpCodeFn,
) -> None:
    """Банк после смены — round(прежний × курс): выведенный в ноль остается нулем,
    малый — не удваивается; остаток — одна корректировка с подписью."""
    admin = await admin_signed_in(make_client, make_user, login)
    zero = await make_user()
    small = await make_user()
    exact = await make_user()

    def entry(user_id: int, kind: str, amount: str) -> BankrollLedger:
        return BankrollLedger(user_id=user_id, kind=kind, amount=D(amount), currency="RUB")

    db.add_all(
        [
            entry(zero.id, "deposit", "10000"),
            *(entry(zero.id, "withdrawal", "-3333.33") for _ in range(3)),
            entry(zero.id, "withdrawal", "-0.01"),
            entry(small.id, "deposit", "0.30"),
            entry(small.id, "deposit", "0.30"),
            entry(exact.id, "deposit", "9500"),
        ]
    )
    await db.commit()
    preview = await admin.client.put(
        URL, json={**FROM_RUB, "currency": "EUR", "rate": "95", "rate_base": "EUR", "preview": True}
    )
    assert preview.status_code == 200 and preview.json()["corrections"] == 2
    result = await _change(admin, totp_code)
    assert result["corrections"] == 2
    # Строки: 105,26 − 3 × 35,09 − 0,01 = −0,02 → корректировка +0,02, банк 0
    # 0,30 ₽ → 0,01 € дважды = 0,02, а 0,60 ₽ ÷ 95 = 0,0063 → 0,01: корректировка −0,01
    # 9 500 ₽ → 100 € ровно: корректировки нет
    for user_id, balance, correction in (
        (zero.id, D("0.00"), D("0.02")),
        (small.id, D("0.01"), D("-0.01")),
        (exact.id, D("100.00"), None),
    ):
        state = await bank_state(db, user_id)
        assert state.balance == balance and state.equity == balance
        rows = list(
            await db.scalars(
                select(BankrollLedger).where(
                    BankrollLedger.user_id == user_id,
                    BankrollLedger.note == "Округление при смене валюты",
                )
            )
        )
        assert [(row.kind, row.amount, row.currency) for row in rows] == (
            [("correction", correction, "EUR")] if correction is not None else []
        )
    zero_client = await login(await make_client("10.0.0.3"), zero)
    bank = (await zero_client.get("/api/me/bank")).json()
    assert (bank["balance"], bank["equity"], bank["invested"]) == ("0.00", "0.00", "0.00")
    entries = await audit_entries(db, "currency_change")
    assert entries[0].details["corrections"] == 2


async def test_overflow_refusal_hides_member_amount(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    totp_code: TotpCodeFn,
) -> None:
    """Р14: сумма участника не видна ни в предпросмотре без 2FA (только признак overflow),
    ни в отказе смены; курс выше 1 000 не принимается: подбором курса сумму не узнать."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await make_user()
    hidden = D("12345678.37")
    db.add(BankrollLedger(user_id=member.id, kind="deposit", amount=hidden, currency="RUB"))
    await db.commit()
    body = {**FROM_RUB, "currency": "USD", "rate": "1000", "rate_base": "RUB"}
    huge = await admin.client.put(URL, json={**body, "rate": "1000000", "preview": True})
    assert huge.status_code == 422
    preview = await admin.client.put(URL, json={**body, "preview": True})
    assert preview.status_code == 200 and preview.json()["overflow"] is True
    response = await admin.client.put(URL, json={**body, "totp_code": await totp_code(admin.user)})
    assert response.status_code == 409 and error_code(response) == "admin.currency_overflow"
    assert set(response.json()["error"]) == {"code", "message"}
    for text in (preview.text, response.text):
        assert "12345678" not in text and "1234567837" not in text


async def test_forms_opened_before_change_refused(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    fake: FakeClaude,
) -> None:
    """Сумма из формы в старой валюте не записывается как новая: лимиты, движение банка
    и банк запуска."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    await _change(admin, totp_code)
    url = "/api/me/play-limits"
    stale = await member.client.put(
        url, json={"bets_per_day": None, "stake_per_day": "5000", "currency": "RUB"}
    )
    assert stale.status_code == 409 and error_code(stale) == "common.currency_changed"
    fresh = await member.client.put(
        url, json={"bets_per_day": None, "stake_per_day": "50", "currency": "EUR"}
    )
    assert fresh.status_code == 200 and fresh.json()["stake_per_day"] == "50.00"
    # Без валюты — как раньше (старые клиенты)
    plain = await member.client.put(url, json={"bets_per_day": 3, "stake_per_day": "50"})
    assert plain.status_code == 200, plain.text
    entries = "/api/me/bank/entries"
    last = (await member.client.get(entries)).json()["last_id"]
    move = {"kind": "deposit", "amount": "9500", "expected_last_id": last}
    stale = await member.client.post(entries, json={**move, "currency": "RUB"})
    assert stale.status_code == 409 and error_code(stale) == "common.currency_changed"
    assert (await member.client.get(entries)).json()["last_id"] == last
    fresh = await member.client.post(entries, json={**move, "amount": "100", "currency": "EUR"})
    assert fresh.status_code == 201, fresh.text
    draft = await analyses_service.create_form(db, member.user.user)
    draft_id = draft.id
    body = ConfirmIn(
        events=[event_in(world, "sinner", "rune", tournament="Test Open 9")],
        bank=D("10000"),
        currency="RUB",
    )
    with pytest.raises(AppError) as refused:
        await analyses_service.start_run(
            db, redis, member.user.user, draft_id, body, enqueue=_no_queue
        )
    assert refused.value.code == "common.currency_changed"
    await db.rollback()
    row = await db.get_one(Analysis, draft_id, populate_existing=True)
    assert row.bank_input is None and row.status == "needs_confirmation"


def test_converted_stake_keeps_other_fields() -> None:
    """Рекомендация без суммы по другой причине (кэф вне таблицы) — только банк и
    валюта; доля и шаги до округления не меняются."""
    stake: dict[str, Any] = {
        "amount": None,
        "currency": "RUB",
        "bank": "9500",
        "bank_source": "ledger",
        "total_odds": "5.100",
        "pct": "0",
        "steps": [],
        "reason": "total_range",
        "drawdown_level": None,
    }
    rate = Rate(old="RUB", new="EUR", rate=D(95), base="EUR")
    out = converted_stake(stake, rate, StrategyParams())
    assert out == {**stake, "currency": "EUR", "bank": "100.00"}


async def test_start_run_waits_for_currency_change(
    make_user: UserFactory,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    fake: FakeClaude,
) -> None:
    """Запуск берет разделяемую CURRENCY_LOCK: пока идет смена валюты, он ждет, а банк
    из формы в прежней валюте после смены не записывается."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    member = await make_user()
    draft = await analyses_service.create_form(db, member.user)
    draft_id, user_id = draft.id, member.id
    body = ConfirmIn(
        events=[event_in(world, "sinner", "rune", tournament="Test Open 9")],
        bank=D("10000"),
        currency="RUB",
    )

    async def start() -> None:
        async with create_sessionmaker(engine)() as session:
            user = await session.get_one(User, user_id)
            await analyses_service.start_run(
                session, redis, user, draft_id, body, enqueue=_no_queue
            )

    async with engine.connect() as change:
        # Смена валюты: исключительная блокировка и новая валюта в той же транзакции
        await change.execute(select(func.pg_advisory_xact_lock(CURRENCY_LOCK)))
        task = asyncio.create_task(start())
        await asyncio.sleep(0.5)
        assert not task.done()
        await change.execute(update(AppSettings).values(currency="EUR"))
        await change.commit()
    with pytest.raises(AppError) as refused:
        await asyncio.wait_for(task, 10)
    assert refused.value.code == "common.currency_changed"
    row = await db.get_one(Analysis, draft_id, populate_existing=True)
    assert row.bank_input is None and row.status == "needs_confirmation"


async def test_currency_change_waits_for_compose_with_ledger_bank(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    totp_code: TotpCodeFn,
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Смена валюты, пока воркер записывает итог (банк из учета, в анализе банка нет):
    смена ждет commit итога и пересчитывает рекомендацию. Без разделяемой блокировки в
    compose итог оставался в рублях: незакоммиченная строка не попадала в пересчет."""
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    user = member.user.user
    db.add(BankrollLedger(user_id=user.id, kind="deposit", amount=D(10000), currency="RUB"))
    await db.commit()
    pairs = (("sinner", "rune"), ("djokovic", "rublev"))
    analysis_id = await make_analysis(db, redis, user, world, *pairs, bank=None)
    entered, release = asyncio.Event(), asyncio.Event()
    original = analysis_result.compose

    async def gated(session: AsyncSession, data: Any) -> dict[str, Any]:
        result = await original(session, data)
        # Итог посчитан в рублях, commit еще не сделан
        entered.set()
        await release.wait()
        return result

    monkeypatch.setattr(analysis_run, "compose", gated)
    task = asyncio.create_task(run(engine, redis, analysis_id))
    await asyncio.wait_for(entered.wait(), 60)
    change = asyncio.create_task(_change(admin, totp_code))
    await asyncio.sleep(0.5)
    waited = not change.done()
    release.set()
    assert await asyncio.wait_for(task, 60) == "done"
    await asyncio.wait_for(change, 30)
    # Смена ждет воркера, а не проходит мимо незаписанного итога
    assert waited
    stake = _stake(await db.get_one(Analysis, analysis_id, populate_existing=True))
    # 10 000 ₽ ÷ 95 = 105,26 €
    assert (stake["currency"], stake["bank"], stake["amount"]) == ("EUR", "105.26", "2.00")
