"""Р29: фильтр вида ставки (kind = all | strategy | single | own) в итогах «Ставок» и
«Аналитике» против эталонных SQL (tests/reference_sql.py) на фикстуре этапа 4 со всеми
видами: экспрессы стратегии, ординары, свои ставки, ставка старого бота; кэш аналитики
различает фильтр; проверка кандидата правил суммы считает только экспрессы стратегии."""

from datetime import datetime
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet
from app.ml.strategy import StrategyParams
from app.services import rule_check
from app.services.bank import bank_from_entries
from app.services.rule_check import check_rules
from tests import reference_sql
from tests.helpers_admin import Signed, signed_in
from tests.stage4_world import TZ, base_world
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
APPROX = 1e-9


@pytest.fixture
async def world(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, dict[str, int]]:
    member = await signed_in(make_client, make_user, login, tz=TZ)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    ids = await base_world(db, member, other)
    # Все виды: проигранный экспресс и исправленная одиночная — свои ставки
    await db.execute(
        update(Bet).where(Bet.id.in_([ids["lost"], ids["corrected"]])).values(kind="own")
    )
    await db.commit()
    return member, ids


def _approx(value: float | None, expected: float | None) -> bool:
    if expected is None:
        return value is None
    return value is not None and abs(value - expected) <= APPROX


async def _get(member: Signed, path: str, **params: Any) -> dict[str, Any]:
    response = await member.client.get(path, params=params)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_kind_filter_matches_reference(
    world: tuple[Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, ids = world
    kinds = {item["id"]: item["kind"] for item in (await _get(member, "/api/bets"))["items"]}
    assert kinds[ids["single"]] == "single" and kinds[ids["parlay"]] == "strategy"
    assert kinds[ids["lost"]] == "own" and kinds[ids["legacy"]] == "legacy"
    totals: dict[str, int] = {}
    for kind in ("all", "strategy", "single", "own"):
        ref_kind = None if kind == "all" else kind
        summary = await _get(member, "/api/bets/summary", kind=kind)
        ref = await reference_sql.summary(db, member.id, kind=ref_kind)
        assert (summary["settled"], summary["won"], summary["lost"], summary["void"]) == (
            ref.settled,
            ref.won,
            ref.lost,
            ref.void,
        ), kind
        assert D(summary["turnover"]) == ref.turnover and D(summary["profit"]) == ref.profit
        assert (summary["open"], D(summary["open_stake"])) == (ref.open, ref.open_stake)
        assert _approx(summary["roi"], ref.roi)
        clv = await reference_sql.clv(db, member.id, kind=ref_kind)
        assert summary["clv_n"] == clv.n and _approx(summary["clv"], clv.mean), kind
        analytics = await _get(member, "/api/analytics", kind=kind)
        kpi = analytics["kpi"]
        assert kpi["settled"] == ref.settled and D(kpi["profit"]) == ref.profit, kind
        assert kpi["clv_n"] == clv.n
        events = await reference_sql.events_count(db, member.id, kind=ref_kind)
        assert analytics["sample"]["events"] == events, kind
        assert analytics["filtered"] is (kind != "all")
        totals[kind] = ref.settled
    # Виды делят ставки приложения без остатка; бот — только во «Все ставки»
    assert totals["all"] == totals["strategy"] + totals["single"] + totals["own"] + 1
    assert totals["own"] == 2 and totals["strategy"] == 2 and totals["single"] == 1
    # Фильтр рынка и вида вместе
    strategy_ml = await _get(member, "/api/analytics", kind="strategy", market="ML")
    assert strategy_ml["kpi"]["settled"] == 2
    bad = await member.client.get("/api/analytics", params={"kind": "legacy"})
    assert bad.status_code == 422


async def test_rule_check_counts_only_strategy(
    world: tuple[Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Сравнение версий правил суммы — только по экспрессам стратегии (Р29)."""
    member, _ = world
    old = StrategyParams()
    new = StrategyParams.from_params({"max_pct": "0.02"})
    found = await check_rules(db, member.id, old, new)
    # Экспрессы стратегии фикстуры: выигранный с возвратом ноги и возврат целиком
    assert found["bets"] == 2
    await db.execute(update(Bet).where(Bet.user_id == member.id).values(kind="single"))
    await db.commit()
    assert (await check_rules(db, member.id, old, new))["bets"] == 0


async def test_rule_check_winrate_counts_all_bets(
    world: tuple[Signed, dict[str, int]], db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Пересчитываются только экспрессы стратегии, но винрейт правила «Рост банка» — по всем
    рассчитанным до ставки ставкам участника (свои, ординары, бот), как в bank_state."""
    member, _ = world
    seen: list[tuple[datetime, int, int]] = []
    real = bank_from_entries

    def spy(entries: Any, *, currency: str, won: int, lost: int, now: datetime) -> Any:
        seen.append((now, won, lost))
        return real(entries, currency=currency, won=won, lost=lost, now=now)

    monkeypatch.setattr(rule_check, "bank_from_entries", spy)
    found = await check_rules(db, member.id, StrategyParams(), StrategyParams())
    assert found["bets"] == len(seen) == 2
    rows = (
        await db.execute(
            select(Bet.settled_at, Bet.status, Bet.kind).where(
                Bet.user_id == member.id, Bet.status.in_(("won", "lost"))
            )
        )
    ).all()
    for now, won, lost in seen:
        before = [(status, kind) for when, status, kind in rows if when and when < now]
        assert won == sum(1 for status, _ in before if status == "won")
        assert lost == sum(1 for status, _ in before if status == "lost")
    # Ставки других видов в винрейт действительно попали
    other = [
        status
        for when, status, kind in rows
        if kind != "strategy" and when and when < max(now for now, _, _ in seen)
    ]
    assert other
