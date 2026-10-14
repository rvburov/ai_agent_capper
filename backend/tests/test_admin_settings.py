"""«Администрирование → Настройки» и «Сообщение»: смена валюты программы с курсом и 2FA
(Т30: пересчет каждой суммы с округлением, эталонный SQL, гонка со ставкой и движением
банка), часовой пояс по умолчанию (и регистрация без пояса), сообщение участникам (В14)."""

import asyncio
from collections.abc import Iterator
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.redis import redis_key
from app.db.models import (
    Analysis,
    AppSettings,
    BankrollLedger,
    Bet,
    Notification,
    PlayLimit,
    User,
)
from app.services.app_settings import Rate
from app.services.bank import bank_state
from tests.analysis_helpers import install, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, admin_signed_in, audit_entries, error_code, signed_in
from tests.helpers_auth import make_invite
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

D = Decimal
CENT = D("0.01")


def _half_up(value: Decimal) -> Decimal:
    return value.quantize(CENT, rounding=ROUND_HALF_UP)


async def _world(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> tuple[Signed, Signed]:
    """Администратор и участник: ставки (в игре, выигрыш, проигрыш), журнал с мелкими
    суммами и отрицательной корректировкой, лимиты с ждущей суммой, банк из ввода."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    maker = BetMaker(db)
    await maker.bet(admin.user, [LegSpec()], stake="1500", deposit="48000")
    won = await maker.bet(member.user, [LegSpec(), LegSpec()], stake="1320.47", deposit="50000")
    lost = await maker.bet(member.user, [LegSpec()], stake="999.99")
    await maker.bet(member.user, [LegSpec()], stake="0.30")
    won.status, won.profit = "won", D("1168.20")
    lost.status, lost.profit = "lost", D("-999.99")
    db.add_all(
        [
            BankrollLedger(
                user_id=member.id, kind="payout", amount=D("2488.67"), currency="RUB", bet_id=won.id
            ),
            BankrollLedger(user_id=member.id, kind="deposit", amount=D("0.01"), currency="RUB"),
            BankrollLedger(user_id=member.id, kind="correction", amount=D("-0.20"), currency="RUB"),
            BankrollLedger(
                user_id=member.id, kind="withdrawal", amount=D("-47.50"), currency="RUB"
            ),
            PlayLimit(
                user_id=member.id,
                bets_per_day=3,
                stake_per_day=D("5000"),
                pending_stake_per_day=D("7777.77"),
                currency="RUB",
            ),
        ]
    )
    analysis = await db.get_one(Analysis, won.analysis_id)
    analysis.bank_input = D("48000.50")
    await db.commit()
    return admin, member


async def _snapshot(db: AsyncSession) -> dict[str, list[tuple[int, Decimal | None]]]:
    async def rows(sql: str) -> list[tuple[int, Decimal | None]]:
        return [(int(a), b) for a, b in (await db.execute(text(sql))).all()]

    return {
        "stake": await rows("SELECT id, stake FROM bets ORDER BY id"),
        "profit": await rows("SELECT id, profit FROM bets ORDER BY id"),
        "ledger": await rows("SELECT id, amount FROM bankroll_ledger ORDER BY id"),
        "limit": await rows("SELECT user_id, stake_per_day FROM play_limits ORDER BY user_id"),
        "pending": await rows(
            "SELECT user_id, pending_stake_per_day FROM play_limits ORDER BY user_id"
        ),
        "bank_input": await rows(
            "SELECT id, bank_input FROM analyses WHERE bank_input IS NOT NULL ORDER BY id"
        ),
    }


def _expected(value: Decimal | None, rate: Decimal, multiply: bool) -> Decimal | None:
    if value is None:
        return None
    raw = value * rate if multiply else value / rate
    out = _half_up(raw)
    if out == 0 and value != 0:
        return CENT if value > 0 else -CENT
    return out


async def _change(admin: Signed, totp_code: TotpCodeFn, **extra: Any) -> dict[str, Any]:
    body = {"currency": "EUR", "rate": "95", "rate_base": "EUR", **extra}
    if not body.get("preview"):
        body.setdefault("totp_code", await totp_code(admin.user))
    response = await admin.client.put("/api/admin/settings/currency", json=body)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_preview_changes_nothing(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin, _ = await _world(make_client, make_user, login, db)
    before = await _snapshot(db)
    preview = await admin.client.put(
        "/api/admin/settings/currency",
        json={"currency": "EUR", "rate": "95", "rate_base": "EUR", "preview": True},
    )
    assert preview.status_code == 200, preview.text
    data = preview.json()
    assert data["applied"] is False and data["from_currency"] == "RUB"
    assert data["to_currency"] == "EUR" and data["factor"] == "0.01052632"
    assert (data["bets"], data["play_limits"], data["analyses"], data["members"]) == (4, 1, 1, 2)
    assert data["ledger_entries"] == 10
    # Банк администратора с учетом ставки в игре: 48 000 ₽ → 505,26 €
    assert data["own_bank"] == {"before": "48000.00", "after": "505.26"}
    assert data["samples"][1] == {"before": "1000", "after": "10.53"}
    assert await _snapshot(db) == before
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.currency == "RUB"
    assert not await audit_entries(db, "currency_change")


async def test_change_recalculates_every_sum_like_reference_sql(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    redis: Redis,
    totp_code: TotpCodeFn,
) -> None:
    admin, member = await _world(make_client, make_user, login, db)
    before = await _snapshot(db)
    old_bank = await bank_state(db, member.id)
    # Эталон до смены: строки журнала — каждая ÷ курс с округлением (до нуля не
    # округляется — ±0,01); банк — round(прежний банк ÷ курс), остаток — корректировка
    reference = (
        await db.execute(
            text(
                "SELECT coalesce(sum(CASE WHEN round(amount / 95, 2) = 0"
                " THEN sign(amount) * 0.01 ELSE round(amount / 95, 2) END), 0),"
                " round(coalesce(sum(amount), 0) / 95, 2)"
                " FROM bankroll_ledger WHERE user_id = :uid"
            ),
            {"uid": member.id},
        )
    ).one()
    rows_sum, bank_after = D(reference[0]), D(reference[1])
    cache_key = redis_key("analytics", member.id, "analytics", "abc")
    await redis.set(cache_key, "{}")
    result = await _change(admin, totp_code)
    assert result["applied"] is True
    after = await _snapshot(db)
    rate = D(95)
    for name, rows in before.items():
        expected = [(row_id, _expected(value, rate, multiply=False)) for row_id, value in rows]
        assert after[name] == expected, name
    # Мелкие суммы не стали нулем: 0,01 ₽ → 0,01 €, −0,20 ₽ → −0,01 €, 0,30 ₽ → 0,01 €
    ledger = {
        (row.kind, row.amount)
        for row in await db.scalars(
            select(BankrollLedger).where(BankrollLedger.user_id == member.id)
        )
    }
    assert ("deposit", D("0.01")) in ledger and ("correction", D("-0.01")) in ledger
    # Валюта у каждой суммы — новая
    for model in (Bet, BankrollLedger, PlayLimit):
        currencies = set(await db.scalars(select(model.currency).distinct()))
        assert currencies == {"EUR"}, model
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.currency == "EUR"
    new_bank = await bank_state(db, member.id)
    assert new_bank.balance == bank_after == _half_up(old_bank.balance / rate)
    corrections = [
        row.amount
        for row in await db.scalars(
            select(BankrollLedger).where(
                BankrollLedger.user_id == member.id,
                BankrollLedger.note == "Округление при смене валюты",
            )
        )
    ]
    assert sum(corrections, D(0)) == bank_after - rows_sum
    assert len(corrections) == (1 if bank_after != rows_sum else 0)
    assert new_bank.currency == "EUR"
    # Журнал администратора: курс, автор и итоги
    entries = await audit_entries(db, "currency_change")
    assert len(entries) == 1 and entries[0].actor_id == admin.id
    details = entries[0].details
    assert details["from"] == "RUB" and details["to"] == "EUR" and details["rate"] == "95"
    assert details["bets"] == 4 and details["members"] == 2
    # Кэш аналитики сброшен, публичные настройки и лимиты — в новой валюте
    assert await redis.exists(cache_key) == 0
    assert (await member.client.get("/api/settings")).json() == {"currency": "EUR"}
    limits = (await member.client.get("/api/me/play-limits")).json()
    assert limits["currency"] == "EUR" and limits["stake_per_day"] == "52.63"
    settings_out = (await admin.client.get("/api/admin/settings")).json()
    changed = settings_out["currency_changed"]
    assert changed["from_currency"] == "RUB" and changed["to_currency"] == "EUR"
    assert changed["rate"] == "95" and changed["rate_base"] == "EUR"
    assert changed["actor_name"] == admin.user.user.display_name


async def test_change_by_multiplication(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    totp_code: TotpCodeFn,
) -> None:
    admin, _ = await _world(make_client, make_user, login, db)
    await db.execute(update(AppSettings).values(currency="EUR"))
    await db.commit()
    before = await _snapshot(db)
    # 1 € = 1,0887 $: из евро в доллары — умножение
    await _change(admin, totp_code, currency="USD", rate="1.0887", rate_base="EUR")
    after = await _snapshot(db)
    for name, rows in before.items():
        expected = [
            (row_id, _expected(value, D("1.0887"), multiply=True)) for row_id, value in rows
        ]
        assert after[name] == expected, name


def test_rate_convert_matches_rounding_rules() -> None:
    divide = Rate(old="RUB", new="EUR", rate=D(95), base="EUR")
    assert divide.convert(D("0.475")) == D("0.01")  # 0,005 → вверх
    assert divide.convert(D("-47.50")) == D("-0.50")
    assert divide.convert(D("0.01")) == D("0.01")  # не ноль
    assert divide.convert(D("-0.20")) == D("-0.01")
    multiply = Rate(old="EUR", new="RUB", rate=D("95.5"), base="EUR")
    assert multiply.convert(D("10.01")) == D("955.96")  # 955,955 → 955,96


async def test_change_needs_valid_2fa_and_values(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    totp_code: TotpCodeFn,
) -> None:
    admin, _ = await _world(make_client, make_user, login, db)
    before = await _snapshot(db)
    url = "/api/admin/settings/currency"
    body = {"currency": "EUR", "rate": "95", "rate_base": "EUR"}
    no_code = await admin.client.put(url, json=body)
    assert no_code.status_code == 403 and error_code(no_code) == "admin.totp_required"
    wrong = await admin.client.put(url, json={**body, "totp_code": "000000"})
    assert wrong.status_code == 403 and error_code(wrong) == "admin.totp_invalid"
    same = await admin.client.put(url, json={**body, "currency": "RUB", "rate_base": "RUB"})
    assert same.status_code == 409 and error_code(same) == "admin.currency_same"
    base = await admin.client.put(url, json={**body, "rate_base": "USD"})
    assert base.status_code == 422 and error_code(base) == "admin.currency_rate_base"
    for rate in ("0", "-1", "abc"):
        bad = await admin.client.put(url, json={**body, "rate": rate})
        assert bad.status_code == 422
    assert await _snapshot(db) == before
    # Неверный код записан в журнал, смены валюты нет
    assert [entry.details["action"] for entry in await audit_entries(db, "confirm_failed")] == [
        "currency_change"
    ]
    assert not await audit_entries(db, "currency_change")
    # Сумма не помещается в NUMERIC(12, 2) после пересчета — отказ
    await db.execute(update(Analysis).values(bank_input=D("9999999999.99")))
    await db.commit()
    overflow = await admin.client.put(
        url,
        json={
            "currency": "EUR",
            "rate": "2",
            "rate_base": "RUB",
            "totp_code": await totp_code(admin.user),
        },
    )
    assert overflow.status_code == 409 and error_code(overflow) == "admin.currency_overflow"


async def test_change_races_with_bank_entry(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    totp_code: TotpCodeFn,
) -> None:
    admin, member = await _world(make_client, make_user, login, db)
    last = await db.scalar(
        select(func.max(BankrollLedger.id)).where(BankrollLedger.user_id == member.id)
    )
    code = await totp_code(admin.user)
    change, entry = await asyncio.gather(
        admin.client.put(
            "/api/admin/settings/currency",
            json={"currency": "EUR", "rate": "95", "rate_base": "EUR", "totp_code": code},
        ),
        member.client.post(
            "/api/me/bank/entries",
            json={"kind": "deposit", "amount": "950", "expected_last_id": last},
        ),
    )
    assert change.status_code == 200, change.text
    assert entry.status_code == 201, entry.text
    deposit = await db.scalar(select(BankrollLedger).where(BankrollLedger.id == entry.json()["id"]))
    assert deposit is not None and deposit.currency == "EUR"
    # Либо пополнение было до смены (950 ₽ → 10 €), либо после (950 € как есть)
    assert deposit.amount in (D("10.00"), D("950.00"))
    currencies = set(await db.scalars(select(BankrollLedger.currency).distinct()))
    assert currencies == {"EUR"}


async def test_default_tz_and_registration_without_tz(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    assert (await admin.client.get("/api/admin/settings")).json()["default_tz"] == "Europe/Helsinki"
    bad = await admin.client.put("/api/admin/settings", json={"default_tz": "Mars/Base"})
    assert bad.status_code == 422
    saved = await admin.client.put("/api/admin/settings", json={"default_tz": "Europe/Berlin"})
    assert saved.status_code == 200 and saved.json()["default_tz"] == "Europe/Berlin"
    assert saved.json()["currency_changed"] is None
    code = await make_invite(db, email="newbie@example.com")
    client = await make_client("10.0.0.7")
    body = {
        "invite_code": code,
        "email": "newbie@example.com",
        "display_name": "Новичок",
        "password": "a-long-and-unique-password",
        "accept_terms": True,
    }
    registered = await client.post("/api/auth/register", json=body)
    assert registered.status_code == 200, registered.text
    user = await db.scalar(select(User).where(User.email == "newbie@example.com"))
    assert user is not None and user.tz == "Europe/Berlin"


# --- сообщение участникам ---


async def test_message_to_all_and_one(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    alice = await make_user(display_name="Алиса")
    bob = await make_user(display_name="Боб")
    await make_user(status="blocked")
    preview = await admin.client.post(
        "/api/admin/messages", json={"text": "  Работы на сервере  ", "preview": True}
    )
    assert preview.status_code == 201, preview.text
    assert preview.json()["sent"] is False and preview.json()["recipients"] == 2
    assert await db.scalar(select(func.count()).select_from(Notification)) == 0
    sent = await admin.client.post("/api/admin/messages", json={"text": "Работы на сервере"})
    assert sent.status_code == 201 and sent.json()["recipients"] == 2
    notes = list(await db.scalars(select(Notification).where(Notification.kind == "admin_message")))
    assert sorted(note.user_id for note in notes) == sorted([alice.id, bob.id])
    assert {note.body for note in notes} == {"Работы на сервере"}
    assert {note.title for note in notes} == {"Сообщение администратора"}
    one = await admin.client.post(
        "/api/admin/messages", json={"text": "Лично вам {name}", "user_id": bob.id}
    )
    assert one.status_code == 201 and one.json()["recipient_name"] == "Боб"
    history = (await admin.client.get("/api/admin/messages")).json()["items"]
    assert [(item["user_id"], item["recipients"]) for item in history] == [(bob.id, 1), (None, 2)]
    assert history[0]["text"] == "Лично вам {name}"
    entries = await audit_entries(db, "message")
    assert entries[-1].target_user_id == bob.id and entries[-1].details["recipients"] == 1
    # Себе и несуществующему — нельзя; текст — от 1 до 280 знаков
    for body in ({"text": "x", "user_id": admin.id}, {"text": "x", "user_id": 999999}):
        refused = await admin.client.post("/api/admin/messages", json=body)
        assert refused.status_code == 404 and error_code(refused) == "admin.message_recipient"
    for text_value in ("", "   ", "x" * 281):
        assert (
            await admin.client.post("/api/admin/messages", json={"text": text_value})
        ).status_code == 422
    # Выключить сообщения администратора участник не может
    bob_client = await login(await make_client("10.0.0.8"), bob)
    off = await bob_client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "admin_message", "on_site": False}]}
    )
    assert off.status_code == 422


@pytest.mark.parametrize("path", ["/api/admin/settings", "/api/admin/messages"])
async def test_admin_settings_hide_member_money(
    path: str, make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Р14: в настройках и сообщениях нет ставок и банка участников."""
    admin, member = await _world(make_client, make_user, login, db)
    body = (await admin.client.get(path)).text
    for value in ("1320.47", "50000", "999.99", "stake", "bankroll"):
        assert value not in body
    assert member.id


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


async def test_change_races_with_bet(
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
    analysis_id = await make_analysis(
        db, redis, member.user.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"
    analysis = (await member.client.get(f"/api/analyses/{analysis_id}")).json()
    # Форма видела суммы в рублях и присылает валюту
    bet_body = {
        "analysis_id": analysis_id,
        "stake": "50",
        "currency": "RUB",
        "bookmaker": "Fonbet",
        "legs": [
            {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds"]}
            for leg in analysis["result"]["express"]["legs"]
        ],
        "client_ref": "ref-currency-race",
    }
    code = await totp_code(admin.user)
    change, bet = await asyncio.gather(
        admin.client.put(
            "/api/admin/settings/currency",
            json={"currency": "EUR", "rate": "95", "rate_base": "EUR", "totp_code": code},
        ),
        member.client.post("/api/bets", json=bet_body),
    )
    assert change.status_code == 200, change.text
    ledger = list(
        await db.scalars(
            select(BankrollLedger)
            .where(BankrollLedger.user_id == member.id)
            .order_by(BankrollLedger.id)
            .execution_options(populate_existing=True)
        )
    )
    if bet.status_code == 409:
        # Смена прошла первой: 50 ₽ из старой формы не записаны как 50 €
        assert error_code(bet) == "common.currency_changed"
        assert bet.json()["error"]["currency"] == "EUR"
        assert ledger == [] and await db.scalar(select(func.count()).select_from(Bet)) == 0
        return
    assert bet.status_code == 201, bet.text
    row = await db.get_one(Bet, bet.json()["id"], populate_existing=True)
    # Ставка до смены — пересчитана: 50 ₽ → 0,53 €
    assert row.currency == "EUR" and row.stake == D("0.53")
    # Начальный банк из ввода (10 000 ₽ → 105,26 €), ставка и остаток округления: банк
    # 9 950 ₽ → round(104,736…) = 104,74 €, а строки дают 105,26 − 0,53 = 104,73
    assert [(entry.kind, entry.amount) for entry in ledger] == [
        ("deposit", D("105.26")),
        ("stake", D("-0.53")),
        ("correction", D("0.01")),
    ]
    assert ledger[2].note == "Округление при смене валюты"
    assert {entry.currency for entry in ledger} == {"EUR"}
