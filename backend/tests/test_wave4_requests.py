"""Заявки волны 3 к backend (этап 4, волна 4): день матча ноги по поясу участника, доли
расхода ИИ с сервера, тексты выводов «Аналитики» как на экране, индекс поиска игроков при
старте API."""

import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiLimit, AppSettings, Match
from app.services import players as players_service
from tests.helpers_admin import admin_signed_in, signed_in
from tests.helpers_ai import spend
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory

LOCALE = Path(__file__).resolve().parent.parent / "app" / "locales" / "ru.json"


async def test_leg_day_in_member_zone(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Матч из ввода без даты создан в 22:30 UTC 13 октября — у участника из Хельсинки это
    уже 14 октября (01:30), как в «Моих матчах сегодня»."""
    member = await signed_in(make_client, make_user, login, tz="Europe/Helsinki")
    maker = BetMaker(db)
    bet = await maker.bet(member.user, [LegSpec(tournament=None, match_day=None)])
    late = datetime(2026, 10, 13, 22, 30, tzinfo=UTC)
    await db.execute(update(Match).values(created_at=late, scheduled_at=None, match_date=None))
    await db.commit()
    card = (await member.client.get(f"/api/bets/{bet.id}")).json()
    assert card["legs"][0]["match"]["day"] == "2026-10-14"
    # У участника из Нью-Йорка тот же момент — еще 13 октября
    other = await signed_in(make_client, make_user, login, ip="10.0.0.2", tz="America/New_York")
    other_bet = await maker.bet(other.user, [LegSpec(tournament=None)])
    await db.execute(
        update(Match).where(Match.id != card["legs"][0]["match"]["id"]).values(created_at=late)
    )
    await db.commit()
    other_card = (await other.client.get(f"/api/bets/{other_bet.id}")).json()
    assert other_card["legs"][0]["match"]["day"] == "2026-10-13"


async def test_ai_shares_from_server(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    db.add(AiLimit(user_id=member.id, monthly_usd=10, daily_analyses=3, per_analysis_usd=1))
    await db.execute(update(AppSettings).values(monthly_budget_usd=20))
    await db.commit()
    await spend(db, member.id, "2.50", kind="analysis")
    await spend(db, member.id, "0.50", kind="news")
    await spend(db, admin.id, "1.00", kind="analysis")
    await spend(db, None, "1.00", kind="refresh")
    await spend(db, member.id, "4.00", kind="eval")
    mine = (await member.client.get("/api/ai/budget")).json()
    assert mine["limit_share"] == 0.3
    admin_view = (await admin.client.get("/api/ai/budget")).json()
    assert admin_view["limit_share"] is None
    budget = (await admin.client.get("/api/admin/ai/budget")).json()
    # Вызовы участников на ключе администратора без проверок и общих задач
    assert budget["members_usd"] == 3.0
    assert budget["spent_usd"] == 5.0 and budget["budget_share"] == 0.25
    assert admin_view["budget"]["members_usd"] == 3.0
    usage = (await member.client.get("/api/ai/usage")).json()
    shares = {item["kind"]: item["share"] for item in usage["kinds"]}
    assert shares == {"analysis": 2.5 / 3, "news": 0.5 / 3}
    assert abs(sum(shares.values()) - 1) < 1e-9


def test_insight_texts_match_screen() -> None:
    """Четыре текста выводов со склонениями и названием среза — как на экране (раньше
    отличия были записаны во фронтенде, DEVIATIONS)."""
    texts = json.loads(LOCALE.read_text(encoding="utf-8"))["analytics"]["insights"]
    assert texts["sample"]["text"].startswith("Под фильтром {bets} и {events}.")
    assert texts["total_negative"]["text"].startswith("ROI {roi} на {bets} ({profit}).")
    assert texts["small_slice"]["title"] == "{slice}: ROI {roi} — пока не закономерность"
    assert texts["small_slice"]["text"].startswith("Выборка мала: {n}.")


async def test_search_index_built_at_startup(app: FastAPI, db: AsyncSession) -> None:
    await app.state.search_warm
    database = (await db.execute(players_service._INDEX_VERSION_SQL)).one()[0]
    assert database in players_service._SEARCH_INDEX
