"""Заявки волны 2 к «Ставкам» и банку (этап 4, волна 3): фильтр status=settled в списке,
итогах и выгрузке; «Банк после» у рассчитанной ставки (BetItemOut.bank_after — капитал
после расчета); AdaptationOut.met — условие правила выполнено независимо от того,
включено ли оно."""

import csv
import io
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.ml.strategy import StrategyParams
from app.services.bank import BankState
from app.services.bets import _adaptations
from tests import reference_sql as ref
from tests.helpers_admin import Signed, signed_in
from tests.helpers_bets import BetMaker, LegSpec, get_bet, reverse, settle
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


@pytest.fixture
def maker(db: AsyncSession) -> BetMaker:
    return BetMaker(db)


async def settled_world(member: Signed, maker: BetMaker) -> dict[str, int]:
    now = datetime.now(UTC)
    won = await maker.bet(member.user, [LegSpec(odds="2.00")], placed_at=now - timedelta(days=4))
    lost = await maker.bet(member.user, [LegSpec()], placed_at=now - timedelta(days=3))
    void = await maker.bet(member.user, [LegSpec()], placed_at=now - timedelta(days=2))
    still = await maker.bet(member.user, [LegSpec()], placed_at=now - timedelta(days=1))
    assert (await settle(member.client, won.id, "win")).status_code == 200
    assert (await settle(member.client, lost.id, "loss")).status_code == 200
    assert (await settle(member.client, void.id, "void")).status_code == 200
    return {"won": won.id, "lost": lost.id, "void": void.id, "open": still.id}


async def test_settled_status_filter(member: Signed, maker: BetMaker) -> None:
    ids = await settled_world(member, maker)
    listed = (await member.client.get("/api/bets?status=settled")).json()["items"]
    assert [item["id"] for item in listed] == [ids["void"], ids["lost"], ids["won"]]
    summary = (await member.client.get("/api/bets/summary?status=settled")).json()
    assert (summary["settled"], summary["won"], summary["lost"], summary["void"]) == (3, 1, 1, 1)
    assert summary["open"] == 0
    everything = (await member.client.get("/api/bets/summary")).json()
    assert everything["open"] == 1 and everything["settled"] == 3
    response = await member.client.get("/api/bets/export.csv?status=settled")
    rows = list(csv.reader(io.StringIO(response.text.lstrip("﻿"))))
    assert sorted({int(row[0]) for row in rows[1:]}) == sorted(
        [ids["won"], ids["lost"], ids["void"]]
    )
    assert (await member.client.get("/api/bets?status=done")).status_code == 422


async def test_bank_after_is_equity_after_settlement(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """«Банк после» — капитал сразу после расчета (как в макете: банк + прибыль) у каждой
    рассчитанной ставки, и выигранной, и проигранной, и возврата; у открытой — null. То же
    число, что «Банк после» той же ставки на главной (equity_after)."""
    ids = await settled_world(member, maker)
    expected = await ref.bank_after(db, member.id)

    async def bank_after(bet_id: int) -> Any:
        return (await get_bet(member.client, bet_id))["bank_after"]

    for key in ("won", "lost", "void"):
        assert Decimal(await bank_after(ids[key])) == expected[ids[key]]
    assert await bank_after(ids["open"]) is None
    # Депозит 10 000, ставки по 100, открытая ставка капитал не меняет: выигрыш 2.00 →
    # 10 100, затем проигрыш → 10 000, затем возврат → 10 000 (баланс журнала после
    # выплаты был бы 9 800: ставки в игре в нем уже вычтены)
    assert [expected[ids[key]] for key in ("won", "lost", "void")] == [
        Decimal("10100.00"),
        Decimal("10000.00"),
        Decimal("10000.00"),
    ]
    listed = {
        item["id"]: item["bank_after"]
        for item in (await member.client.get("/api/bets")).json()["items"]
    }
    assert {key: listed[ids[key]] for key in ids} == {
        key: (str(expected[ids[key]]) if key != "open" else None) for key in ids
    }
    recent = (await member.client.get("/api/dashboard?period=30d")).json()["recent"]
    assert {item["id"]: item["equity_after"] for item in recent} == {
        ids[key]: listed[ids[key]] for key in ("won", "lost", "void")
    }

    # Исправление: сторно и новый расчет — «Банк после» по новому расчету
    assert (await reverse(member.client, ids["won"])).status_code == 200
    assert await bank_after(ids["won"]) is None
    assert (await settle(member.client, ids["won"], "void")).status_code == 200
    again = await ref.bank_after(db, member.id)
    assert Decimal(await bank_after(ids["won"])) == again[ids["won"]]
    # Капитал без прибыли сторнированного выигрыша: 10 000 − 100 (проигрыш) + 0 + 0
    assert again[ids["won"]] == Decimal("9900.00")
    assert again[ids["lost"]] == Decimal("9900.00")


def _state(**values: Any) -> BankState:
    base: dict[str, Any] = {
        "currency": "RUB",
        "balance": Decimal(1000),
        "in_play": Decimal(0),
        "equity": Decimal(1000),
        "peak": Decimal(1000),
        "drawdown": Decimal(0),
        "invested": Decimal(1000),
        "growth": None,
        "week_change": None,
        "winrate": None,
        "settled_bets": 0,
        "empty": False,
    }
    base.update(values)
    return BankState(**base)


def test_adaptation_met_ignores_enabled() -> None:
    params = StrategyParams.from_params({})
    # Просадка 25%: оба порога достигнуты, действует только более строгий (dd20)
    deep = {item.key: item for item in _adaptations(_state(drawdown=Decimal("0.25")), params)}
    assert (deep["dd10"].met, deep["dd10"].active) == (True, False)
    assert (deep["dd20"].met, deep["dd20"].active) == (True, True)
    # Рост и прибыльная неделя выключены по умолчанию (В7): условие выполнено, не действуют
    grown = {
        item.key: item
        for item in _adaptations(
            _state(growth=Decimal("0.20"), winrate=Decimal("0.65"), week_change=Decimal("0.12")),
            params,
        )
    }
    assert grown["up15"].enabled is False
    assert (grown["up15"].met, grown["up15"].active) == (True, False)
    assert (grown["week_win"].met, grown["week_win"].active) == (True, False)
    assert (grown["week_loss"].met, grown["week_loss"].active) == (False, False)
    calm = {item.key: item for item in _adaptations(_state(), params)}
    assert not any(item.met for item in calm.values())


async def test_bank_adaptations_have_met(member: Signed, maker: BetMaker) -> None:
    await maker.bet(member.user, [LegSpec()])
    bank = (await member.client.get("/api/me/bank")).json()
    assert {item["key"]: item["met"] for item in bank["adaptations"]} == {
        "dd10": False,
        "dd20": False,
        "up15": False,
        "week_loss": False,
        "week_win": False,
    }
