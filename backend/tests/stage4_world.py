"""Фикстура этапа 4 для сверки с эталонными SQL (tests/reference_sql.py): ставки участника
в поясе America/New_York и чужие ставки второго участника.

base_world — итоги «Ставок» и капитал по дням: одиночная (расчет в 23:30 по поясу —
другой день по UTC), экспресс с возвратом ноги, проигранный экспресс, возврат всей
ставки, исправленная ставка (сторно), открытая ставка, ставка старого бота, вывод и
корректировка, чужая выигранная ставка.

analytics_world — base_world и еще то, что нужно аналитике: экспресс старого бота с
неизвестными исходами ног (Т10), ординар бота с p_claude, ставки на форы и на разных
покрытиях (в том числе покрытие только из ввода, Т29), рынок при прогнозе
(q_market_at_pred) и обе стороны закрытия, закрытие с двух сторон у события без рынка при
прогнозе (второй ряд Brier), экспресс с итоговым кэфом на стыке полос стратегии
(1.30 × 1.31 = 1.703 — полоса 1.71–2.20), прогноз проверочного прогона (is_eval) и
замененный прогноз (supersedes) — один до начала матча, другой после.
"""

from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankrollLedger, Bet, BetLeg, Match, Prediction
from tests.helpers_admin import Signed
from tests.helpers_bets import BetMaker, LegSpec, get_bet, reverse, settle, settle_body

D = Decimal
TZ = "America/New_York"
ZONE = ZoneInfo(TZ)


def local_today() -> date:
    return datetime.now(UTC).astimezone(ZONE).date()


def days_ago(days: int, hour: int = 12) -> datetime:
    """Момент hour:00 по поясу участника days дней назад."""
    return datetime.combine(
        local_today() - timedelta(days=days), time(hour), tzinfo=ZONE
    ).astimezone(UTC)


async def move_settlement(db: AsyncSession, bet_id: int, moment: datetime) -> None:
    """Расчет ставки и его записи журнала — в момент moment (для дней по поясу)."""
    await db.execute(update(Bet).where(Bet.id == bet_id).values(settled_at=moment))
    await db.execute(
        update(BankrollLedger)
        .where(BankrollLedger.bet_id == bet_id, BankrollLedger.kind != "stake")
        .values(at=moment)
    )
    await db.commit()


async def legacy_settled(
    db: AsyncSession, member: Signed, bet: Bet, status: str, profit: str, moment: datetime
) -> None:
    """Ставка старого бота, рассчитанная импортом: статус, прибыль, выплата в журнале."""
    await db.execute(
        update(Bet)
        .where(Bet.id == bet.id)
        .values(status=status, profit=D(profit), settled_at=moment, settled_by="legacy")
    )
    payout = bet.stake + D(profit)
    if payout > 0:
        db.add(
            BankrollLedger(
                user_id=member.id,
                at=moment,
                kind="payout" if status == "won" else "refund",
                amount=payout,
                currency="RUB",
                bet_id=bet.id,
            )
        )
    await db.commit()


async def base_world(db: AsyncSession, member: Signed, other: Signed) -> dict[str, int]:
    maker = BetMaker(db)
    client = member.client
    ids: dict[str, int] = {}

    single = await maker.bet(
        member.user, [LegSpec(odds="2.00")], stake="100", placed_at=days_ago(12)
    )
    await settle(client, single.id, "win", closing={"odds": "1.90", "by": "pinnacle"})
    # Расчет в 23:30 по Нью-Йорку — по UTC это уже следующий день
    late = datetime.combine(local_today() - timedelta(days=11), time(23, 30), tzinfo=ZONE)
    await move_settlement(db, single.id, late.astimezone(UTC))
    ids["single"] = single.id

    parlay = await maker.bet(
        member.user,
        [LegSpec(odds="1.45"), LegSpec(odds="1.333"), LegSpec(odds="1.60")],
        stake="250",
        placed_at=days_ago(9),
    )
    card = await get_bet(client, parlay.id)
    body = settle_body(card, "win", "void", "win")
    body["legs"][0]["closing"] = {"odds": "1.40", "opp_odds": "2.90", "by": "pinnacle"}
    body["legs"][2]["closing"] = {"odds": "1.70", "by": "bookmaker"}
    assert (await client.put(f"/api/bets/{parlay.id}/result", json=body)).status_code == 200
    await move_settlement(db, parlay.id, days_ago(8))
    ids["parlay"] = parlay.id

    lost = await maker.bet(
        member.user,
        [LegSpec(odds="1.50"), LegSpec(odds="1.70")],
        stake="300",
        placed_at=days_ago(6),
    )
    card = await get_bet(client, lost.id)
    body = settle_body(card, "loss", "win")
    body["legs"][0]["closing"] = {"odds": "1.55", "by": "avg"}
    assert (await client.put(f"/api/bets/{lost.id}/result", json=body)).status_code == 200
    await move_settlement(db, lost.id, days_ago(5))
    ids["lost"] = lost.id

    void = await maker.bet(member.user, [LegSpec(), LegSpec()], stake="120", placed_at=days_ago(4))
    await settle(client, void.id, "void", "void")
    await move_settlement(db, void.id, days_ago(3))

    corrected = await maker.bet(
        member.user, [LegSpec(odds="1.80")], stake="500", placed_at=days_ago(3)
    )
    await settle(client, corrected.id, "win", closing={"odds": "1.85", "by": "betfair_ex"})
    await move_settlement(db, corrected.id, days_ago(2))
    await reverse(client, corrected.id)
    await settle(client, corrected.id, "loss")
    await move_settlement(db, corrected.id, days_ago(1))
    ids["corrected"] = corrected.id

    opened = await maker.bet(
        member.user, [LegSpec(odds="1.70")], stake="200", placed_at=days_ago(1)
    )
    ids["open"] = opened.id

    # Ставка старого бота: рассчитана при импорте, в CLV не идет
    legacy = await maker.bet(
        member.user, [LegSpec(odds="1.90")], stake="150", source="legacy", placed_at=days_ago(20)
    )
    await legacy_settled(db, member, legacy, "won", "135.00", days_ago(20, 18))
    ids["legacy"] = legacy.id

    journal = (await client.get("/api/me/bank/entries")).json()
    response = await client.post(
        "/api/me/bank/entries",
        json={"kind": "withdrawal", "amount": "700", "expected_last_id": journal["last_id"]},
    )
    assert response.status_code == 201, response.text
    response = await client.post(
        "/api/me/bank/entries",
        json={"kind": "correction", "amount": "-12.50", "note": "сверка",
              "expected_last_id": response.json()["id"]},
    )  # fmt: skip
    assert response.status_code == 201, response.text

    # Чужие ставки и банк
    foreign = await maker.bet(
        other.user, [LegSpec(odds="3.00")], stake="999", placed_at=days_ago(2)
    )
    await settle(other.client, foreign.id, "win")
    ids["foreign"] = foreign.id
    return ids


async def _replace_prediction(
    db: AsyncSession, bet_id: int, p_final: float, as_of: datetime
) -> None:
    """Новая версия прогноза ноги (supersedes) с другой итоговой вероятностью."""
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bet_id))
    assert leg is not None and leg.prediction_id is not None
    old = await db.get(Prediction, leg.prediction_id)
    assert old is not None
    db.add(
        Prediction(
            user_id=old.user_id,
            analysis_id=None,
            match_id=old.match_id,
            market=old.market,
            selection=old.selection,
            as_of=as_of,
            p_base=old.p_base,
            p_claude=old.p_claude,
            p_final=p_final,
            q_market_at_pred=old.q_market_at_pred,
            supersedes=old.id,
        )
    )
    await db.commit()


async def analytics_world(db: AsyncSession, member: Signed, other: Signed) -> dict[str, int]:
    ids = await base_world(db, member, other)
    # Свои номера матчей и турниров: base_world уже занял первые
    maker = BetMaker(db, counter=1000)
    client = member.client

    # Экспресс старого бота: проигран, исходы ног неизвестны (Т10)
    bot_parlay = await maker.bet(
        member.user,
        [LegSpec(odds="1.40", p_final=None, p_base=None, p_claude=0.71),
         LegSpec(odds="1.50", p_final=None, p_base=None, p_claude=0.66)],
        stake="200", source="legacy", placed_at=days_ago(15),
    )  # fmt: skip
    await legacy_settled(db, member, bot_parlay, "lost", "-200.00", days_ago(15, 20))
    ids["bot_parlay"] = bot_parlay.id
    # Ординар бота: проигран, исход ноги записан
    bot_single = await maker.bet(
        member.user,
        [LegSpec(odds="1.60", p_final=None, p_base=None, p_claude=0.68)],
        stake="100", source="legacy", placed_at=days_ago(14),
    )  # fmt: skip
    await legacy_settled(db, member, bot_single, "lost", "-100.00", days_ago(14, 20))
    await db.execute(update(BetLeg).where(BetLeg.bet_id == bot_single.id).values(result="loss"))
    await db.execute(update(BetLeg).where(BetLeg.bet_id == ids["legacy"]).values(result="win"))
    await db.commit()
    ids["bot_single"] = bot_single.id

    # Форы на грунте с рынком при прогнозе и закрытием с двух сторон
    clay = await maker.bet(
        member.user,
        [LegSpec(odds="1.55", market="HCP_-1.5", selection=1, surface="clay",
                 tournament="Roland", confirmed_surface="clay", p_final=0.71, p_base=0.69,
                 p_claude=0.73, q_market=0.61),
         LegSpec(odds="1.35", market="HCP_+1.5", selection=2, surface="clay",
                 tournament="Roland", confirmed_surface="clay", p_final=0.83, p_base=0.81,
                 p_claude=0.84, q_market=0.72)],
        stake="300", placed_at=days_ago(10),
    )  # fmt: skip
    card = await get_bet(client, clay.id)
    body = settle_body(card, "win", "loss")
    body["legs"][0]["closing"] = {"odds": "1.50", "opp_odds": "2.60", "by": "pinnacle"}
    body["legs"][1]["closing"] = {"odds": "1.30", "opp_odds": "3.50", "by": "pinnacle"}
    assert (await client.put(f"/api/bets/{clay.id}/result", json=body)).status_code == 200
    await move_settlement(db, clay.id, days_ago(10, 22))
    ids["clay"] = clay.id

    # Покрытие только из ввода (матч без турнира, Т29): трава; П2 с рынком при прогнозе
    grass = await maker.bet(
        member.user,
        [LegSpec(odds="2.10", market="ML", selection=2, tournament=None,
                 confirmed_surface="grass", p_final=0.52, p_base=0.50, p_claude=0.54,
                 q_market=0.46)],
        stake="150", placed_at=days_ago(7),
    )  # fmt: skip
    await settle(client, grass.id, "win", closing={"odds": "2.00", "opp_odds": "1.85", "by": "avg"})
    await move_settlement(db, grass.id, days_ago(7, 21))
    ids["grass"] = grass.id

    # Экспресс на стыке полос стратегии (1.703: стратегия ставила по 1.71–2.20); у первой
    # ноги нет рынка при прогнозе, но внесены обе стороны закрытия — второй ряд Brier
    gap = await maker.bet(
        member.user,
        [LegSpec(odds="1.30", p_final=0.80, p_base=0.78, p_claude=0.81),
         LegSpec(odds="1.31", p_final=0.79, p_base=0.77, p_claude=0.80)],
        stake="200", placed_at=days_ago(17),
    )  # fmt: skip
    assert gap.total_odds == D("1.703")
    card = await get_bet(client, gap.id)
    body = settle_body(card, "win", "win")
    body["legs"][0]["closing"] = {"odds": "1.28", "opp_odds": "3.70", "by": "pinnacle"}
    assert (await client.put(f"/api/bets/{gap.id}/result", json=body)).status_code == 200
    await move_settlement(db, gap.id, days_ago(17, 20))
    ids["gap_parlay"] = gap.id

    # Прогноз проверочного прогона: в калибровку и Brier не идет, в ROI — идет
    evaluated = await maker.bet(
        member.user, [LegSpec(odds="1.75", p_final=0.77, q_market=0.55, is_eval=True)],
        stake="100", placed_at=days_ago(5),
    )  # fmt: skip
    await settle(client, evaluated.id, "loss")
    await move_settlement(db, evaluated.id, days_ago(5, 15))
    ids["evaluated"] = evaluated.id

    # Замененный прогноз до начала матча (берется замена) и после (не берется)
    replaced = await maker.bet(
        member.user, [LegSpec(odds="1.65", p_final=0.58, q_market=0.57)],
        stake="100", placed_at=days_ago(4),
    )  # fmt: skip
    await settle(client, replaced.id, "win")
    await move_settlement(db, replaced.id, days_ago(4, 22))
    await _replace_prediction(db, replaced.id, 0.66, days_ago(4, 9))
    ids["replaced"] = replaced.id

    late_fix = await maker.bet(
        member.user, [LegSpec(odds="1.45", p_final=0.74, q_market=0.66)],
        stake="100", placed_at=days_ago(2),
    )  # fmt: skip
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == late_fix.id))
    assert leg is not None
    await db.execute(
        update(Match).where(Match.id == leg.match_id).values(scheduled_at=days_ago(2, 14))
    )
    await db.commit()
    await settle(client, late_fix.id, "loss")
    await move_settlement(db, late_fix.id, days_ago(2, 20))
    await _replace_prediction(db, late_fix.id, 0.51, days_ago(2, 15))
    ids["late_fix"] = late_fix.id
    return ids
