"""«Банк по дням» с пополнением внутри периода (этап 5, В7): пунктир «вложено» ступенькой,
отметки пополнения и вывода, старт периода — капитал на начало периода, за «все время» —
первое пополнение; главное число — прибыль ставок и ROI (kpi). Главная и «Аналитика» —
одни и те же числа."""

from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankrollLedger
from tests.helpers_admin import Signed, signed_in
from tests.helpers_bets import BetMaker, LegSpec, settle
from tests.stage4_world import days_ago, local_today
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


async def _series(member: Signed, url: str, period: str) -> dict[str, Any]:
    response = await member.client.get(url, params={"period": period})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_deposit_inside_period_is_a_step_with_mark(member: Signed, db: AsyncSession) -> None:
    maker = BetMaker(db)
    db.add(
        BankrollLedger(
            user_id=member.id, at=days_ago(40), kind="deposit", amount=D("12000"), currency="RUB"
        )
    )
    await db.commit()
    bet = await maker.bet(member.user, [LegSpec(odds="2.00")], stake="1000", placed_at=days_ago(20))
    assert (await settle(member.client, bet.id, "win")).status_code == 200
    db.add_all(
        [
            BankrollLedger(
                user_id=member.id, at=days_ago(5), kind="deposit", amount=D("48000"), currency="RUB"
            ),
            BankrollLedger(
                user_id=member.id,
                at=days_ago(2),
                kind="withdrawal",
                amount=D("-3000"),
                currency="RUB",
            ),
        ]
    )
    await db.commit()
    five, two = (local_today().toordinal() - n for n in (5, 2))

    for url in ("/api/dashboard", "/api/analytics"):
        data = await _series(member, url, "30d")
        series = data["series"]
        # Старт периода — капитал на начало периода: 12 000 (ставка в игре — не убыток)
        assert D(series["start_amount"]) == D("12000")
        assert [(flow["kind"], D(flow["amount"])) for flow in series["flows"]] == [
            ("deposit", D("48000")),
            ("withdrawal", D("-3000")),
        ]
        assert [flow["day"] for flow in series["flows"]] == [
            local_today().fromordinal(five).isoformat(),
            local_today().fromordinal(two).isoformat(),
        ]
        assert D(series["flows_total"]) == D("45000")
        steps = {point["day"]: D(point["invested"]) for point in series["points"]}
        assert steps[series["points"][0]["day"]] == D("12000")
        assert steps[local_today().fromordinal(five).isoformat()] == D("60000")
        assert steps[local_today().isoformat()] == D("57000")
        # Банк выше пунктира на прибыль ставок: 58 000 против 57 000 вложенных
        assert D(series["last"]) == D("58000")
        # Главное число периода — прибыль ставок: пополнение в нее не входит
        assert D(data["kpi"]["profit"]) == D("1000")

        whole = (await _series(member, url, "all"))["series"]
        # За все время старт — первое пополнение 12 000, ступенька поднимается дважды
        assert D(whole["start_amount"]) == D("12000")
        assert D(whole["points"][0]["invested"]) == D("12000")
        assert [flow["kind"] for flow in whole["flows"]] == ["deposit", "withdrawal"]
        assert D(whole["points"][-1]["invested"]) == D("57000")
        assert whole["change_share"] == pytest.approx(1000 / 57000)


# Эталон: первое пополнение (deposit без сторно) и все движения банка по дням пояса
# участника и видам — так, как их показывает график
_REF_FLOWS = text(
    """
    WITH live AS (
      SELECT * FROM bankroll_ledger l WHERE user_id = :u AND reversed_by IS NULL
        AND id NOT IN (SELECT reversed_by FROM bankroll_ledger WHERE user_id = :u
                       AND reversed_by IS NOT NULL)
    )
    SELECT (SELECT amount FROM live WHERE kind = 'deposit' ORDER BY at, id LIMIT 1)
             AS first_deposit,
           (SELECT json_agg(json_build_array((at AT TIME ZONE :tz)::date, kind, amount)
                            ORDER BY at, id)
              FROM live WHERE bet_id IS NULL) AS flows
    """
)


async def test_all_time_starts_from_first_deposit_and_marks_same_day_withdrawal(
    member: Signed, db: AsyncSession
) -> None:
    """«Все время»: пополнение 10 000 и вывод 2 000 в один день, через 15 дней пополнение
    5 000. Старт — первое пополнение (10 000, не нетто дня 8 000), вывод в день старта —
    своя отметка; сверка с эталонным SQL."""
    first = days_ago(20).replace(hour=8)
    db.add_all(
        [
            BankrollLedger(
                user_id=member.id, at=first, kind="deposit", amount=D("10000"), currency="RUB"
            ),
            BankrollLedger(
                user_id=member.id,
                at=first.replace(hour=12),
                kind="withdrawal",
                amount=D("-2000"),
                currency="RUB",
            ),
            BankrollLedger(
                user_id=member.id, at=days_ago(5), kind="deposit", amount=D("5000"), currency="RUB"
            ),
        ]
    )
    await db.commit()
    zone = member.user.user.tz or "Europe/Moscow"
    ref = (await db.execute(_REF_FLOWS, {"u": member.id, "tz": zone})).one()
    expected = [(day, kind, D(str(amount))) for day, kind, amount in ref.flows[1:]]
    for url in ("/api/dashboard", "/api/analytics"):
        series = (await _series(member, url, "all"))["series"]
        assert D(series["start_amount"]) == ref.first_deposit == D("10000.00")
        assert series["start_day"] == ref.flows[0][0]
        marks = [(flow["day"], flow["kind"], D(flow["amount"])) for flow in series["flows"]]
        assert marks == expected
        assert D(series["flows_total"]) == D("3000")
        # Ступенька «вложено» в день старта — нетто дня, в конце — все вложенное
        assert D(series["points"][0]["invested"]) == D("8000")
        assert D(series["points"][-1]["invested"]) == D("13000")
