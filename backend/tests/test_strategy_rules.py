"""Правила суммы ставки — свои у каждого участника (этап 5, В5 Р25; В7 этапа 4):
кандидат с проверкой на своих ставках (эталонный пересчет сумм), «Включить» владельцем,
откат, отклонение; чужие версии не видны и не меняются; общая линия инструкций —
только администратор."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg, StrategyVersion
from app.ml.strategy import StrategyParams
from app.services import strategy_versions
from app.services.rule_check import check_rules
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
T0 = datetime(2026, 9, 1, 9, 0, tzinfo=UTC)
LEGS = [LegSpec(odds="1.30", p_final=0.80), LegSpec(odds="1.45", p_final=0.80)]


async def _settle(db: AsyncSession, bet: Bet, status: str, when: datetime) -> None:
    """Ставка рассчитана (без журнала выплаты: для пересчета сумм он не нужен)."""
    bet.status = status
    bet.settled_at = when
    bet.settled_by = "manual"
    bet.profit = bet.stake * (bet.total_odds - 1) if status == "won" else -bet.stake
    for leg in await db.scalars(select(BetLeg).where(BetLeg.bet_id == bet.id)):
        leg.result = "win" if status == "won" else "loss"
        leg.settled_at = when
    await db.commit()


async def _history(
    db: AsyncSession, user: object, maker: BetMaker | None = None
) -> tuple[Bet, Bet]:
    """Пополнение 10 000; ставка А (−600, проиграна), через сутки — ставка Б (выиграна) на
    неделе −6%: у Б действует «Итог 7 дней −5% и хуже»."""
    maker = maker or BetMaker(db)
    first = await maker.bet(user, LEGS, stake="600", placed_at=T0 + timedelta(minutes=1))  # type: ignore[arg-type]
    await _settle(db, first, "lost", T0 + timedelta(days=1))
    second = await maker.bet(user, LEGS, stake="100", placed_at=T0 + timedelta(days=2))  # type: ignore[arg-type]
    await _settle(db, second, "won", T0 + timedelta(days=3))
    return first, second


async def test_rule_check_reference(db: AsyncSession, make_user: UserFactory) -> None:
    """Эталон: итоговый кэф 1.885 — 2,25% банка и +0,25% за средний валуй 10% = 2,5%.
    А: 10 000 × 2,5% = 250 по обеим версиям. Б: банк 9 400, итог недели −6% — по
    действующим правилам потолок 2%: 188 → 180; без правила недели: 235 → 230."""
    member = await make_user()
    other = await make_user()
    maker = BetMaker(db)
    await _history(db, member, maker)
    await maker.bet(other, LEGS, stake="500", placed_at=T0 + timedelta(days=2))
    old = StrategyParams()
    new = StrategyParams(adapt={**old.adapt, "week_loss": False})
    check = await check_rules(db, member.id, old, new)
    assert check["bets"] == 2 and check["changed"] == 1
    assert (check["stake_old"], check["stake_new"]) == ("430.00", "480.00")
    assert check["stake_change"] == float(D("480") / D("430") - 1)
    # Прибыль при тех же исходах: А −1 на рубль, Б +0,885
    # −250 + 180 × 0,885 = −90,70; −250 + 230 × 0,885 = −46,45
    assert (check["profit_old"], check["profit_new"]) == ("-90.70", "-46.45")
    assert check["triggered"]["week_loss"] == 0
    same = await check_rules(db, member.id, old, old)
    assert same["changed"] == 0 and same["triggered"]["week_loss"] == 1
    assert check["currency"] == "RUB"


async def test_rules_candidate_activate_rollback_reject(
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    owner = await signed_in(make_client, make_user, login)
    stranger = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    await _history(db, owner.user)

    nothing = await owner.client.post("/api/strategy/versions", json={"adapt": {"dd10": True}})
    assert nothing.status_code == 422 and error_code(nothing) == "strategy.no_changes"
    made = await owner.client.post(
        "/api/strategy/versions",
        json={"adapt": {"week_loss": False}, "note": "Неделя — шум на десятках ставок"},
    )
    assert made.status_code == 201, made.text
    body = made.json()
    assert (body["code"], body["status"], body["line"], body["goal"]) == (
        "r2",
        "candidate",
        "rules",
        "rules",
    )
    assert body["changes"] == [
        "Выключено правило «Итог 7 дней −5% и хуже»",
        "Неделя — шум на десятках ставок",
    ]
    assert body["check"]["bets"] == 2 and body["check"]["changed"] == 1
    assert body["params"]["adapt"]["week_loss"] is False
    assert body["can_activate"] is True and body["parent_code"] == "v3"

    # Чужой участник версию не видит и не меняет
    version_id = body["id"]
    for method, path in (
        ("GET", f"/api/strategy/versions/{version_id}"),
        ("POST", f"/api/strategy/versions/{version_id}/activate"),
        ("POST", f"/api/strategy/versions/{version_id}/rollback"),
        ("POST", f"/api/strategy/versions/{version_id}/reject"),
    ):
        response = await stranger.client.request(method, path)
        assert response.status_code == 404, (path, response.text)
    assert (await stranger.client.get("/api/strategy/versions")).json()["rules"] == []

    on = await owner.client.post(f"/api/strategy/versions/{version_id}/activate")
    assert on.status_code == 200 and on.json()["status"] == "active"
    active = (await owner.client.get("/api/strategy/active")).json()
    assert active["code"] == "r2" and active["params"]["adapt"]["week_loss"] is False
    again = await owner.client.post(f"/api/strategy/versions/{version_id}/activate")
    assert again.status_code == 409 and error_code(again) == "strategy.not_candidate"

    listing = (await owner.client.get("/api/strategy/versions")).json()
    v3 = next(item for item in listing["rules"] if item["code"] == "v3")
    assert v3["status"] == "archived" and v3["can_rollback"] is True
    back = await owner.client.post(f"/api/strategy/versions/{v3['id']}/rollback")
    assert back.status_code == 200 and back.json()["status"] == "active"
    assert (await owner.client.get("/api/strategy/active")).json()["code"] == "v3"

    # Новый кандидат вытесняет прежнего; отклонить — rejected
    band = await owner.client.post(
        "/api/strategy/versions", json={"stake_bands": [{"index": 1, "pct": 0.02}]}
    )
    assert band.status_code == 201, band.text
    assert band.json()["changes"] == ["Итоговый кэф 1.71–2.20: 2,25% → 2% банка"]
    other = await owner.client.post("/api/strategy/versions", json={"adapt": {"up15": True}})
    assert other.status_code == 201
    first_band = await db.get_one(StrategyVersion, band.json()["id"], populate_existing=True)
    assert first_band.status == "rejected"
    rejected = await owner.client.post(f"/api/strategy/versions/{other.json()['id']}/reject")
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"
    compare = (
        await owner.client.get(f"/api/strategy/versions/compare?a={v3['id']}&b={band.json()['id']}")
    ).json()
    assert compare["diff"] == [
        {"key": "stake_bands.1", "a": "1.71–2.20–0.0225", "b": "1.71–2.20–0.02"}
    ]
    assert compare["comparison"] is None


async def test_shared_line_is_admin_only(
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    seen = await member.client.get(f"/api/strategy/versions/{v3.id}")
    assert seen.status_code == 200 and seen.json()["line"] == "instructions"
    assert seen.json()["params"] is None and seen.json()["prompt_version"] == "analysis.v1"
    for action in ("activate", "rollback", "reject"):
        response = await member.client.post(f"/api/strategy/versions/{v3.id}/{action}")
        assert response.status_code == 403, response.text
    same = await admin.client.post("/api/admin/strategy/versions", json={"lessons": []})
    assert same.status_code == 409 and error_code(same) == "strategy.same_as_active"
    missing = await admin.client.post(
        "/api/admin/strategy/versions", json={"prompt_version": "analysis.v9"}
    )
    assert missing.status_code == 422 and error_code(missing) == "strategy.prompt_unknown"
    unknown = await admin.client.post("/api/admin/strategy/versions", json={"lessons": ["L-404"]})
    assert unknown.status_code == 422 and error_code(unknown) == "strategy.lesson_unknown"
    own = await strategy_versions.ensure_active(db, member.id)
    await db.commit()
    lines = await member.client.get(f"/api/strategy/versions/compare?a={v3.id}&b={own.id}")
    assert lines.status_code == 422 and error_code(lines) == "strategy.compare_lines"
