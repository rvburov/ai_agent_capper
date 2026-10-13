"""Банк участника этапа 4: журнал и движение банка (пополнение, вывод, корректировка),
капитал по дням, расчет банка в SQL против эталона по строкам журнала (bank_from_entries)
на случайных журналах."""

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import BankrollLedger, Bet
from app.db.session import create_sessionmaker
from app.services.bank import bank_from_entries, bank_state, ledger_entries
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec, get_bet, ledger_rows, settle_body
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


async def _post(
    member: Signed, kind: str, amount: str, last: int | None, **extra: str
) -> dict[str, object]:
    response = await member.client.post(
        "/api/me/bank/entries",
        json={"kind": kind, "amount": amount, "expected_last_id": last, **extra},
    )
    assert response.status_code == 201, response.text
    data: dict[str, object] = response.json()
    return data


async def test_moves_and_journal(member: Signed, db: AsyncSession) -> None:
    empty = (await member.client.get("/api/me/bank/entries")).json()
    assert empty == {"items": [], "next_before": None, "last_id": None}
    deposit = await _post(member, "deposit", "1000", None, note="Стартовый банк")
    assert deposit["kind"] == "deposit" and deposit["amount"] == "1000.00"
    assert deposit["balance_after"] == "1000.00" and deposit["currency"] == "RUB"
    withdrawal = await _post(member, "withdrawal", "250.50", int(str(deposit["id"])))
    assert withdrawal["amount"] == "-250.50" and withdrawal["balance_after"] == "749.50"
    correction = await _post(member, "correction", "-49.50", int(str(withdrawal["id"])))
    assert correction["balance_after"] == "700.00"
    bank = (await member.client.get("/api/me/bank")).json()
    # Пополнения, выводы и корректировки — вложено, не прибыль
    assert bank["balance"] == "700.00" and bank["invested"] == "700.00"
    assert bank["drawdown"] == "0.0000"
    journal = (await member.client.get("/api/me/bank/entries")).json()
    assert [item["kind"] for item in journal["items"]] == ["correction", "withdrawal", "deposit"]
    assert journal["last_id"] == correction["id"]
    page = (await member.client.get("/api/me/bank/entries", params={"limit": 2})).json()
    assert len(page["items"]) == 2 and page["next_before"] == withdrawal["id"]
    rest = (
        await member.client.get("/api/me/bank/entries", params={"before": page["next_before"]})
    ).json()
    assert [item["id"] for item in rest["items"]] == [deposit["id"]]
    bad = await member.client.get("/api/me/bank/entries", params={"before": 999999})
    assert bad.status_code == 422 and error_code(bad) == "bank.bad_cursor"


async def test_move_checks(member: Signed, db: AsyncSession) -> None:
    maker = BetMaker(db)
    await maker.bet(member.user, [LegSpec()], stake="300", deposit="1000")
    last = (await member.client.get("/api/me/bank/entries")).json()["last_id"]
    url = "/api/me/bank/entries"
    cases = [
        ({"kind": "withdrawal", "amount": "700.01"}, 422, "bank.withdrawal_range"),
        ({"kind": "correction", "amount": "-700.01"}, 422, "bank.correction_range"),
        ({"kind": "correction", "amount": "0"}, 422, "bank.amount_zero"),
        ({"kind": "deposit", "amount": "-5"}, 422, "bank.amount_positive"),
        ({"kind": "deposit", "amount": "9999999999.99"}, 422, "bank.amount_range"),
        ({"kind": "stake", "amount": "5"}, 422, "validation"),
        ({"kind": "deposit", "amount": "1.005"}, 422, "validation"),
        ({"kind": "deposit", "amount": "5", "note": "a\nb"}, 422, "validation"),
    ]
    for extra, status, code in cases:
        response = await member.client.post(url, json={"expected_last_id": last, **extra})
        assert (response.status_code, error_code(response)) == (status, code), extra
    # Вывод всего свободного (ставка в игре не выводится) — можно
    response = await member.client.post(
        url, json={"kind": "withdrawal", "amount": "700", "expected_last_id": last}
    )
    assert response.status_code == 201
    assert (await member.client.get("/api/me/bank")).json()["balance"] == "0.00"


async def test_double_submit_and_stale_journal(member: Signed, db: AsyncSession) -> None:
    first = await _post(member, "deposit", "500", None)
    body = {"kind": "deposit", "amount": "100", "note": "зарплата", "expected_last_id": first["id"]}
    created = await member.client.post("/api/me/bank/entries", json=body)
    assert created.status_code == 201
    # Повтор той же записи (двойной клик) — та же запись, 200, журнал не растет
    again = await member.client.post("/api/me/bank/entries", json=body)
    assert again.status_code == 200 and again.json()["id"] == created.json()["id"]
    assert len(await ledger_rows(db, member.id)) == 2
    # Другая запись по устаревшему журналу — 409
    other = await member.client.post("/api/me/bank/entries", json={**body, "amount": "200"})
    assert other.status_code == 409 and error_code(other) == "bank.changed"
    stale = await member.client.post(
        "/api/me/bank/entries", json={**body, "expected_last_id": None}
    )
    assert stale.status_code == 409


async def test_history_of_new_member(member: Signed) -> None:
    data = (await member.client.get("/api/me/bank/history", params={"period": "all"})).json()
    assert len(data["points"]) == 1 and data["points"][0]["equity"] == "0"
    week = (await member.client.get("/api/me/bank/history")).json()
    assert week["period"] == "30d" and len(week["points"]) == 30
    assert (
        await member.client.get("/api/me/bank/history", params={"period": "1y"})
    ).status_code == 422


async def test_bank_is_private(
    member: Signed, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    await _post(member, "deposit", "500", None)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.6")
    assert (await other.client.get("/api/me/bank/entries")).json()["items"] == []
    assert (await other.client.get("/api/me/bank")).json()["empty"] is True
    history = (await other.client.get("/api/me/bank/history", params={"period": "7d"})).json()
    assert all(point["equity"] == "0" for point in history["points"])


@pytest.mark.parametrize("seed", range(6))
async def test_sql_bank_matches_reference(
    seed: int, db: AsyncSession, make_user: UserFactory, member: Signed
) -> None:
    """Случайный журнал: пополнения и выводы, рассчитанные, открытые и исправленные ставки
    (выплата и ее сторно). bank_state (SQL) == bank_from_entries (эталон по строкам)."""
    rng = random.Random(seed)
    user = await make_user()
    now = datetime(2026, 10, 13, 12, tzinfo=UTC)
    moment = now - timedelta(days=40)

    def tick() -> datetime:
        nonlocal moment
        moment += timedelta(hours=rng.randint(1, 30))
        return moment

    async def entry(
        kind: str, amount: Decimal, at: datetime, bet_id: int | None = None
    ) -> BankrollLedger:
        row = BankrollLedger(
            user_id=user.id, at=at, kind=kind, amount=amount, currency="RUB", bet_id=bet_id
        )
        db.add(row)
        await db.flush()
        return row

    await entry("deposit", D("10000"), tick())
    for _ in range(rng.randint(10, 30)):
        roll = rng.random()
        if roll < 0.1:
            await entry("deposit", D(rng.randint(100, 3000)), tick())
            continue
        if roll < 0.2:
            await entry("withdrawal", -D(rng.randint(1, 500)), tick())
            continue
        stake = D(rng.randint(50, 500))
        odds = D(rng.choice(["1.50", "1.80", "2.10", "3.05"]))
        placed = tick()
        status = rng.choice(["open", "won", "lost", "void", "won"])
        settled = tick() if status != "open" else None
        payout = {"won": (stake * odds).quantize(D("0.01")), "void": stake}.get(status)
        bet = Bet(
            user_id=user.id,
            placed_at=placed,
            bookmaker="Fonbet",
            stake=stake,
            currency="RUB",
            total_odds=odds,
            status=status,
            settled_at=settled,
            profit=(payout or D(0)) - stake if status != "open" else None,
        )
        db.add(bet)
        await db.flush()
        await entry("stake", -stake, placed, bet.id)
        if payout is None or settled is None:
            continue
        kind = "payout" if status == "won" else "refund"
        if rng.random() < 0.3:
            # Ошибочная выплата раньше и ее сторно
            wrong = await entry(kind, payout + 100, settled - timedelta(hours=1), bet.id)
            reversal = await entry("reversal", -(payout + 100), settled, bet.id)
            wrong.reversed_by = reversal.id
        await entry(kind, payout, settled, bet.id)
    await db.commit()
    entries = await ledger_entries(db, user.id)
    statuses = [row.bet_status for row in entries if row.kind == "stake"]
    expected = bank_from_entries(
        entries, currency="RUB", won=statuses.count("won"), lost=statuses.count("lost"), now=now
    )
    assert await bank_state(db, user.id, now=now) == expected


async def test_bank_above_money_limit_can_shrink(member: Signed, db: AsyncSession) -> None:
    """Баланс выше предела суммы (выплаты сверх пополнений): рост — 422, а вывод и
    минус-корректировку банк принимает."""
    for amount in ("9000000000", "9000000000"):
        db.add(
            BankrollLedger(
                user_id=member.id,
                at=datetime.now(UTC),
                kind="deposit",
                amount=D(amount),
                currency="RUB",
            )
        )
    await db.commit()
    last = (await member.client.get("/api/me/bank/entries")).json()["last_id"]
    url = "/api/me/bank/entries"
    grow = await member.client.post(
        url, json={"kind": "deposit", "amount": "1", "expected_last_id": last}
    )
    assert grow.status_code == 422 and error_code(grow) == "bank.amount_range"
    shrink = await _post(member, "withdrawal", "1000", last)
    await _post(member, "correction", "-5", int(str(shrink["id"])))
    bank = (await member.client.get("/api/me/bank")).json()
    assert bank["balance"] == "17999998995.00"


async def test_bank_state_is_one_snapshot(
    member: Signed, db: AsyncSession, engine: AsyncEngine
) -> None:
    """Расчет ставки, сохраненный во время чтения банка, не смешивает два снимка: капитал
    «до» и пик «после» дали бы ложную просадку (bank_state зовут и без блокировки)."""
    bet = await BetMaker(db).bet(member.user, [LegSpec(odds="2.00")], stake="2000", deposit="10000")
    card = await get_bet(member.client, bet.id)
    async with create_sessionmaker(engine)() as reader:
        before = await bank_state(reader, member.id)
        await reader.rollback()
        original = reader.execute
        fired = False

        async def execute(statement: Any, *args: Any, **kwargs: Any) -> Any:
            nonlocal fired
            result = await original(statement, *args, **kwargs)
            if not fired and "bankroll_ledger" in str(statement):
                fired = True
                # Другая вкладка или воркер рассчитывает ставку между запросами чтения
                response = await member.client.put(
                    f"/api/bets/{bet.id}/result", json=settle_body(card, "win")
                )
                assert response.status_code == 200
            return result

        reader.execute = execute  # type: ignore[method-assign]
        state = await bank_state(reader, member.id)
    async with create_sessionmaker(engine)() as fresh:
        after = await bank_state(fresh, member.id)
    assert fired and before != after
    assert state in (before, after)
    assert state.drawdown == 0
