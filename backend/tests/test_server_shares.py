"""Доли и разницы, которые фронтенд раньше считал сам (заявки B6 волны 6 этапа 4):
доля месячного лимита у строк администратора, «факт − прогноз» у корзин калибровки,
перевес ноги над рынком в «Ставках»."""

import math
from decimal import Decimal as D

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AiLimit
from app.schemas.analytics import CalibrationBinOut
from tests.helpers_admin import admin_signed_in, signed_in
from tests.helpers_ai import spend
from tests.helpers_bets import BetMaker, LegSpec, get_bet
from tests.support import ClientFactory, LoginFn, UserFactory


async def test_limit_share_in_admin_rows(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """limit_share — расход за месяц на ключе администратора к месячному лимиту, одинаково
    в списке пользователей и в таблице лимитов; у администратора и при нулевом лимите — null."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    zero = await make_user(email="zero@example.com")
    db.add(
        AiLimit(user_id=member.id, monthly_usd=D("10"), daily_analyses=3, per_analysis_usd=D("1"))
    )
    db.add(AiLimit(user_id=zero.id, monthly_usd=D("0"), daily_analyses=3, per_analysis_usd=D("1")))
    await db.commit()
    await spend(db, member.id, "2.5")
    await spend(db, member.id, "1", key_source="own")
    await spend(db, admin.id, "3")

    users = {r["id"]: r for r in (await admin.client.get("/api/admin/users")).json()}
    limits = {
        r["id"]: r for r in (await admin.client.get("/api/admin/ai/limits")).json()["members"]
    }
    assert users[member.id]["limit_share"] == limits[member.id]["limit_share"] == 0.25
    assert users[admin.id]["limit_share"] is None
    assert limits[admin.id]["limit_share"] is None
    assert users[zero.id]["limit_share"] is None
    assert limits[zero.id]["limit_share"] is None


def test_calibration_bin_diff_is_actual_minus_forecast() -> None:
    item = CalibrationBinOut(
        low=0.6, high=0.65, n=20, p=0.62, p_base=None, p_claude=None, actual=0.5,
        ci_low=0.3, ci_high=0.7,
    )  # fmt: skip
    assert item.diff == pytest.approx(-0.12)
    assert item.model_dump()["diff"] == pytest.approx(-0.12)


async def test_leg_edge_over_market(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """edge = прогноз ноги − 1/кэф: итоговая вероятность, у ставки бота — оценка Claude,
    без прогноза — null."""
    member = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    app_bet = await maker.bet(member.user, [LegSpec(odds="1.80", p_final=0.62)])
    bot_bet = await maker.bet(
        member.user,
        [LegSpec(odds="2.00", p_final=None, p_base=None, p_claude=0.55)],
        source="legacy",
        deposit=None,
    )
    bare = await maker.bet(
        member.user, [LegSpec(p_final=None, p_base=None, p_claude=None)], deposit=None
    )

    leg = (await get_bet(member.client, app_bet.id))["legs"][0]
    assert math.isclose(leg["edge"], 0.62 - 1 / 1.8, abs_tol=1e-9)
    leg = (await get_bet(member.client, bot_bet.id))["legs"][0]
    assert math.isclose(leg["edge"], 0.05, abs_tol=1e-9)
    leg = (await get_bet(member.client, bare.id))["legs"][0]
    assert leg["edge"] is None
