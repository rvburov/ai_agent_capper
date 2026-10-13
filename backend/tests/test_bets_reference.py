"""Сквозная сверка с эталонными SQL (tests/reference_sql.py): итоги «Ставок» и капитал по
дням на фикстуре со всеми случаями — одиночные и экспрессы, возврат ноги и всей ставки,
исправленная ставка (сторно), ставка старого бота, открытая ставка, пополнение, вывод и
корректировка, второй участник, расчет поздно вечером по поясу участника (другой день по
UTC). Деньги — точное равенство, доли — до 1e-9."""

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from tests import reference_sql
from tests.helpers_admin import Signed, signed_in
from tests.helpers_bets import BetMaker, LegSpec, get_bet, settle_body
from tests.stage4_world import TZ, ZONE, base_world
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal


@pytest.fixture
async def world(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, dict[str, int]]:
    member = await signed_in(make_client, make_user, login, tz=TZ)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    return member, await base_world(db, member, other)


def _check_summary(data: dict[str, Any], ref: reference_sql.Summary) -> None:
    assert (data["settled"], data["won"], data["lost"], data["void"]) == (
        ref.settled,
        ref.won,
        ref.lost,
        ref.void,
    )
    assert D(data["turnover"]) == ref.turnover and D(data["profit"]) == ref.profit
    assert (data["open"], D(data["open_stake"])) == (ref.open, ref.open_stake)
    assert data["legacy_settled"] == ref.legacy_settled
    for key, value in (("roi", ref.roi), ("winrate", ref.winrate)):
        if value is None:
            assert data[key] is None
        else:
            assert data[key] == pytest.approx(value, abs=1e-9)


async def test_summary_matches_reference(
    world: tuple[Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, _ = world
    data = (await member.client.get("/api/bets/summary")).json()
    ref = await reference_sql.summary(db, member.id)
    _check_summary(data, ref)
    # Возвраты не входят в оборот: 100 + 250 + 300 + 500 + 150 (бот)
    assert ref.turnover == D("1300.00") and ref.void == 1 and ref.open == 1
    clv = await reference_sql.clv(db, member.id)
    # Одиночная, экспресс с возвратом и исправленная (закрытие пережило сторно); у
    # проигранного экспресса закрытие не у всех ног, у возврата живых ног нет
    assert data["clv_n"] == clv.n == 3 and data["clv_positive"] == clv.positive
    assert data["clv"] == pytest.approx(clv.mean, abs=1e-9)

    for source in ("app", "legacy"):
        filtered = (await member.client.get("/api/bets/summary", params={"source": source})).json()
        _check_summary(filtered, await reference_sql.summary(db, member.id, source=source))

    today = datetime.now(UTC).astimezone(ZONE).date()
    since = datetime.combine(today - timedelta(days=6), time.min, tzinfo=ZONE)
    week = (await member.client.get("/api/bets/summary", params={"period": "7d"})).json()
    _check_summary(week, await reference_sql.summary(db, member.id, since=since))
    week_clv = await reference_sql.clv(db, member.id, since=since)
    assert week["clv_n"] == week_clv.n


async def test_bank_history_matches_reference(
    world: tuple[Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, _ = world
    today = datetime.now(UTC).astimezone(ZONE).date()
    for period, days in (("7d", 7), ("30d", 30), ("90d", 90)):
        data = (await member.client.get("/api/me/bank/history", params={"period": period})).json()
        assert data["tz"] == TZ and data["currency"] == "RUB"
        points = {date.fromisoformat(point["day"]): D(point["equity"]) for point in data["points"]}
        start = today - timedelta(days=days - 1)
        assert min(points) == start and max(points) == today and len(points) == days
        assert points == await reference_sql.equity_by_day(db, member.id, TZ, start, today)
    everything = (await member.client.get("/api/me/bank/history", params={"period": "all"})).json()
    first = date.fromisoformat(everything["points"][0]["day"])
    assert first == today - timedelta(days=20)
    bank = (await member.client.get("/api/me/bank")).json()
    assert everything["points"][-1]["equity"] == bank["equity"]


async def test_late_settlement_counts_on_local_day(
    world: tuple[Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Ставка рассчитана в 23:30 по Нью-Йорку: в ряду — этот день, а не следующий (UTC)."""
    member, _ = world
    today = datetime.now(UTC).astimezone(ZONE).date()
    data = (await member.client.get("/api/me/bank/history", params={"period": "30d"})).json()
    points = {point["day"]: D(point["equity"]) for point in data["points"]}
    day = today - timedelta(days=11)
    # Выигрыш 100 по кэфу 2.00 — +100 к капиталу в этот день
    assert points[day.isoformat()] - points[(day - timedelta(days=1)).isoformat()] == D("100.00")
    assert points[(day + timedelta(days=1)).isoformat()] == points[day.isoformat()]


async def test_clv_equal_products_is_zero(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Экспресс, у которого произведение кэфов равно произведению закрытий (1.010 × 2.508 =
    1.045 × 2.424 = 2.53308): CLV ровно 0, «лучше закрытия» — ни одной, как в карточке и
    эталоне (логарифмы без округления дали бы ±1e-16)."""
    member = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    for first, second, closings in (
        ("1.010", "2.508", ("1.045", "2.424")),
        ("1.045", "2.424", ("1.010", "2.508")),
        ("1.800", "1.900", ("1.900", "1.800")),
    ):
        bet = await maker.bet(member.user, [LegSpec(odds=first), LegSpec(odds=second)])
        body = settle_body(await get_bet(member.client, bet.id), "win", "win")
        for leg, closing in zip(body["legs"], closings, strict=True):
            leg["closing"] = {"odds": closing, "by": "pinnacle"}
        data = (await member.client.put(f"/api/bets/{bet.id}/result", json=body)).json()
        assert data["clv"] == 0.0
    summary = (await member.client.get("/api/bets/summary")).json()
    ref = await reference_sql.clv(db, member.id)
    assert (summary["clv_n"], summary["clv_positive"]) == (ref.n, ref.positive) == (3, 0)
    assert summary["clv"] == 0.0
