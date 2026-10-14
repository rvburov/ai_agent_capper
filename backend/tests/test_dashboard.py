"""Главная (GET /api/dashboard): показатели = «Аналитика» без фильтров = итоги «Ставок» за
тот же период; банк как GET /me/bank; последние ставки с капиталом после расчета;
открытые ставки с 1/кэф; «Мои матчи сегодня» (В6); дела администратора (архив, просьбы о
ключе, участники у лимита) — только у администратора (Р14); приветствие по поясу."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiLimit, Analysis, IngestionRun, Match, User
from app.services.dashboard import greeting
from app.services.sessions import utcnow
from tests import reference_sql
from tests.helpers_admin import Signed, signed_in
from tests.helpers_ai import spend
from tests.helpers_bets import BetMaker, LegSpec
from tests.stage4_world import TZ, analytics_world, local_today
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
APPROX = 1e-9
KPI_KEYS = ("settled", "won", "lost", "void", "clv_n", "clv_positive", "legacy_settled")


@pytest.fixture
async def world(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, Signed, dict[str, int]]:
    member = await signed_in(make_client, make_user, login, tz=TZ)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    return member, other, await analytics_world(db, member, other)


async def _dashboard(member: Signed, **params: Any) -> dict[str, Any]:
    response = await member.client.get("/api/dashboard", params=params)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def _same(a: float | None, b: float | None) -> bool:
    return (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= APPROX)


async def test_dashboard_equals_analytics_and_summary(
    world: tuple[Signed, Signed, dict[str, int]],
) -> None:
    """Главная = аналитика без фильтров = итоги «Ставок» за каждый период."""
    member, _, _ = world
    for period in ("7d", "30d", "90d", "all"):
        home = await _dashboard(member, period=period)
        analytics = (await member.client.get("/api/analytics", params={"period": period})).json()
        summary = (await member.client.get("/api/bets/summary", params={"period": period})).json()
        for key in KPI_KEYS:
            assert home["kpi"][key] == analytics["kpi"][key] == summary[key], (period, key)
        for key in ("turnover", "profit"):
            assert D(home["kpi"][key]) == D(analytics["kpi"][key]) == D(summary[key])
        for key in ("roi", "winrate", "clv"):
            assert _same(home["kpi"][key], summary[key]) and _same(
                analytics["kpi"][key], summary[key]
            ), (period, key)
        # На главной интервалов нет
        assert home["kpi"]["roi_ci"] is None and home["brier"]["diff_ci"] is None
        for key in ("n", "model", "market", "closing_n"):
            assert _same(home["brier"][key], analytics["brier"][key]), (period, key)
        assert home["series"]["points"] == analytics["series"]["points"]
        assert home["prev"] == analytics["prev"] and home["change"] == analytics["change"]
        assert home["period"] == period


async def test_dashboard_bank_open_and_recent(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, _, ids = world
    data = await _dashboard(member)
    assert data["period"] == "30d" and data["tz"] == TZ and data["currency"] == "RUB"
    bank = (await member.client.get("/api/me/bank")).json()
    assert data["bank"] == bank
    assert D(data["series"]["last"]) == D(bank["equity"])
    # Открытая ставка: 1/кэф каждой ноги
    assert data["open_count"] == 1 and D(data["open_stake"]) == D("200.00")
    [opened] = data["open_bets"]
    assert opened["id"] == ids["open"]
    assert opened["implied"] == pytest.approx([1 / 1.70])
    # Последние рассчитанные ставки: новые сверху, капитал после расчета
    recent = data["recent"]
    assert len(recent) == min(12, data["kpi"]["settled"])
    moments = [item["settled_at"] for item in recent]
    assert moments == sorted(moments, reverse=True)
    single = next(item for item in recent if item["id"] == ids["single"])
    day = local_today() - timedelta(days=11)
    equity = await reference_sql.equity_by_day(db, member.id, TZ, day, day)
    assert D(single["equity_after"]) == equity[day]
    assert data["small_sample"] is True  # 13 ставок меньше 15
    assert data["thresholds"]["dashboard_small"] == 15
    assert data["admin"] is None


async def test_my_matches_today(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Мои матчи сегодня: нога открытой ставки на сегодняшний матч и события сегодняшнего
    анализа; вчерашняя ставка и матч с другой датой — нет."""
    member = await signed_in(make_client, make_user, login, tz=TZ)
    maker = BetMaker(db)
    today_bet = await maker.bet(
        member.user, [LegSpec(odds="1.40", names=("Jannik Sinner", "Holger Rune"))],
        placed_at=utcnow() - timedelta(minutes=5),
    )  # fmt: skip
    await maker.bet(member.user, [LegSpec(odds="1.60")], placed_at=utcnow() - timedelta(days=2))
    dated = await maker.bet(
        member.user,
        [LegSpec(odds="1.70", match_day=local_today(), tournament=None,
                 confirmed_tournament="Мой турнир")],
        placed_at=utcnow() - timedelta(days=3),
    )  # fmt: skip
    extra = await maker.bet(
        member.user, [LegSpec(odds="1.90")], placed_at=utcnow() - timedelta(days=5)
    )
    # Сегодняшний анализ — только у первой ставки; остальные анализы — в прошлые дни
    await db.execute(
        update(Analysis)
        .where(Analysis.user_id == member.id, Analysis.id != today_bet.analysis_id)
        .values(created_at=utcnow() - timedelta(days=5))
    )
    await db.commit()
    data = await _dashboard(member)
    matches = {item["player1"]["name"]: item for item in data["my_matches"]}
    assert "Jannik Sinner" in matches
    sinner = matches["Jannik Sinner"]
    assert [bet["bet_id"] for bet in sinner["bets"]] == [today_bet.id]
    assert sinner["analyses"] == [today_bet.analysis_id]
    assert sinner["bets"][0]["odds_taken"] == "1.400"
    assert sinner["tournament"] == "Shanghai"
    # Турнир матча из ввода — из своего ввода анализа ставки
    own = next(item for item in data["my_matches"] if item["bets"][0]["bet_id"] == dated.id)
    assert own["tournament"] == "Мой турнир" and own["analyses"] == []
    dated_ids = {bet["bet_id"] for item in data["my_matches"] for bet in item["bets"]}
    assert dated.id in dated_ids and extra.id not in dated_ids
    assert len(data["my_matches"]) == 2
    assert data["open_count"] == 4


async def test_dashboard_admin_attention(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Администратор видит устаревший архив, просьбу вернуть ключ и участника у лимита
    (только расход на ИИ, Р14); участник этих дел не видит."""
    admin = await signed_in(make_client, make_user, login, role="admin")
    asking = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    spender = await signed_in(make_client, make_user, login, ip="10.0.0.4")
    await db.execute(update(User).where(User.id == asking.id).values(ai_mode="own"))
    db.add(
        AiLimit(
            user_id=asking.id, monthly_usd=D("10"), daily_analyses=3,
            per_analysis_usd=D("0.5"), return_requested_at=utcnow() - timedelta(hours=1),
        )
    )  # fmt: skip
    db.add(
        IngestionRun(
            source="sackmann", status="ok", finished_at=utcnow() - timedelta(days=5),
            details={"files": {"2026.csv": "new"}},
        )
    )  # fmt: skip
    await db.commit()
    await spend(db, spender.id, "8.50")
    data = await _dashboard(admin)
    attention = data["admin"]
    assert attention is not None and attention["alert_pct"] == 80
    archive = attention["archive"]
    # tennis-data не загружался ни разу: дней не посчитать, но архив устарел
    assert archive["days"] is None and archive["stale_after_days"] == 3
    assert (archive["update_hour_utc"], archive["update_minute"]) == (5, 25)
    sources = {item["source"]: item["last_load"] for item in archive["sources"]}
    assert sources["tennis_data"] is None and sources["sackmann"] is not None
    assert [item["user_id"] for item in attention["return_requests"]] == [asking.id]
    [limit] = attention["limits"]
    assert limit["user_id"] == spender.id and limit["level"] == "80"
    assert limit["spent_usd"] == 8.5 and limit["limit_usd"] == 10.0
    assert set(limit) == {
        "user_id",
        "name",
        "spent_usd",
        "limit_usd",
        "share",
        "level",
        "runs_out_on",
    }
    # Ставок и банка участников у администратора нет
    assert data["kpi"]["settled"] == 0 and data["open_count"] == 0
    member_view = await _dashboard(spender)
    assert member_view["admin"] is None


async def test_archive_fresh_not_shown(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await signed_in(make_client, make_user, login, role="admin")
    for source in ("sackmann", "tennis_data"):
        db.add(
            IngestionRun(
                source=source, status="ok", finished_at=utcnow() - timedelta(hours=5),
                details={"files": {"x": "new"}},
            )
        )  # fmt: skip
    await db.commit()
    data = await _dashboard(admin)
    assert data["admin"]["archive"] is None


def test_greeting_by_local_hour() -> None:
    zone = ZoneInfo("Europe/Helsinki")
    cases = {4: "night", 5: "morning", 11: "morning", 12: "day", 16: "day", 17: "evening",
             22: "evening", 23: "night", 0: "night"}  # fmt: skip
    for hour, expected in cases.items():
        moment = datetime(2026, 10, 13, hour, 30, tzinfo=zone).astimezone(UTC)
        assert greeting(moment, zone) == expected, hour


async def test_dashboard_rights_and_validation(
    world: tuple[Signed, Signed, dict[str, int]], make_client: ClientFactory
) -> None:
    member, other, _ = world
    anonymous = await make_client(ip="10.0.0.9")
    assert (await anonymous.get("/api/dashboard")).status_code == 401
    assert (await member.client.get("/api/dashboard", params={"period": "1y"})).status_code == 422
    theirs = await _dashboard(other)
    assert theirs["kpi"]["settled"] == 1 and theirs["open_count"] == 0
    assert all(item["id"] != member.id for item in theirs["recent"])
    mine = await _dashboard(member)
    assert {item["id"] for item in mine["recent"]}.isdisjoint(
        {item["id"] for item in theirs["recent"]}
    )


async def test_dashboard_user_match_day_by_scheduled_time(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """День матча по времени начала — в поясе участника."""
    member = await signed_in(make_client, make_user, login, tz=TZ)
    maker = BetMaker(db)
    bet = await maker.bet(member.user, [LegSpec()], placed_at=utcnow() - timedelta(days=4))
    await db.execute(
        update(Analysis)
        .where(Analysis.id == bet.analysis_id)
        .values(created_at=utcnow() - timedelta(days=4))
    )
    await db.commit()
    data = await _dashboard(member)
    assert data["my_matches"] == []
    leg_match = (await db.execute(
        update(Match).where(Match.source_ref.like("user:test:%")).values(
            scheduled_at=utcnow()
        ).returning(Match.id)
    )).scalars().all()  # fmt: skip
    await db.commit()
    assert leg_match
    data = await _dashboard(member)
    assert [item["bets"][0]["bet_id"] for item in data["my_matches"]] == [bet.id]
    assert data["my_matches"][0]["scheduled_at"] is not None
