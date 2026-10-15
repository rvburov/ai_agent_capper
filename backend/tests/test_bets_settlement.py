"""Ручной расчет ставки, исправление результата (сторно) и закрывающий кэф (этап 4):
деньги до копейки, журнал банка, гонки и повторы, права."""

import asyncio
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BankrollLedger, Bet, BetLeg, Match
from app.ingest.sackmann import _flip_sides
from app.ml.market import devig_pair
from app.services.bank import bank_from_entries, bank_state, ledger_entries
from app.services.players import merge_matches
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import (
    BetMaker,
    LegSpec,
    get_bet,
    ledger_rows,
    reverse,
    settle,
    settle_body,
)
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


@pytest.fixture
def maker(db: AsyncSession) -> BetMaker:
    return BetMaker(db)


async def _kinds(db: AsyncSession, user_id: int) -> list[tuple[str, Decimal]]:
    return [(row.kind, row.amount) for row in await ledger_rows(db, user_id)]


async def _check_bank_matches_reference(db: AsyncSession, user_id: int) -> None:
    """Банк из SQL (bank_state) совпадает с эталоном по строкам журнала."""
    now = datetime.now(UTC)
    fast = await bank_state(db, user_id, now=now)
    entries = await ledger_entries(db, user_id)
    statuses = list(await db.scalars(select(Bet.status).where(Bet.user_id == user_id)))
    slow = bank_from_entries(
        entries,
        currency="RUB",
        won=statuses.count("won"),
        lost=statuses.count("lost"),
        now=now,
    )
    assert fast == slow


async def test_single_win_payout_and_bank(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    bet = await maker.bet(member.user, [LegSpec(odds="1.855")], stake="333.33")
    response = await settle(member.client, bet.id, "win", score="2:1")
    assert response.status_code == 200, response.text
    data = response.json()
    # 333,33 × 1.855 = 618,32715 → 618,33 (половина — вверх)
    assert data["status"] == "won" and data["payout"] == "618.33"
    assert data["profit"] == "285.00" and data["effective_odds"] == "1.855"
    assert data["settled_by"] == "manual" and data["settled_at"] is not None
    [leg] = data["legs"]
    assert leg["result"] == "win" and leg["score"] == "2:1"
    assert leg["result_source"] == "manual" and leg["settled_at"] is not None
    assert await _kinds(db, member.id) == [
        ("deposit", D("10000.00")),
        ("stake", D("-333.33")),
        ("payout", D("618.33")),
    ]
    bank = (await member.client.get("/api/me/bank")).json()
    assert bank["balance"] == "10285.00" and bank["in_play"] == "0"
    assert bank["equity"] == "10285.00"
    await _check_bank_matches_reference(db, member.id)


@pytest.mark.parametrize(
    ("stake", "odds", "payout"),
    [
        # 10,03 × 1.5 = 15,045: половина — вверх (банковское округление дало бы 15,04)
        ("10.03", "1.50", "15.05"),
        ("100", "1.333", "133.30"),
        ("0.01", "1.01", "0.01"),
    ],
)
async def test_payout_rounding_half_up(
    stake: str, odds: str, payout: str, member: Signed, maker: BetMaker
) -> None:
    bet = await maker.bet(member.user, [LegSpec(odds=odds)], stake=stake)
    data = (await settle(member.client, bet.id, "win")).json()
    assert data["payout"] == payout
    assert D(data["profit"]) == D(payout) - D(stake)


async def test_parlay_with_void_leg_recalculates_odds(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    bet = await maker.bet(
        member.user,
        [LegSpec(odds="1.45"), LegSpec(odds="1.333"), LegSpec(odds="1.60")],
        stake="250",
    )
    response = await settle(member.client, bet.id, "win", "void", "win")
    data = response.json()
    # Возврат — кэф 1.00: 1.45 × 1.60 = 2.32; итоговый кэф ставки не меняется
    assert data["status"] == "won" and data["effective_odds"] == "2.32"
    assert data["total_odds"] == "3.093"
    assert data["payout"] == "580.00" and data["profit"] == "330.00"
    assert (await _kinds(db, member.id))[-1] == ("payout", D("580.00"))
    await _check_bank_matches_reference(db, member.id)


async def test_all_void_refund_and_loss(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    void_bet = await maker.bet(member.user, [LegSpec(), LegSpec()], stake="100")
    lost_bet = await maker.bet(member.user, [LegSpec(), LegSpec()], stake="200")
    void = (await settle(member.client, void_bet.id, "void", "void")).json()
    assert void["status"] == "void" and void["profit"] == "0.00" and void["payout"] == "100.00"
    assert void["effective_odds"] is None
    # Проигрыш: одна нога проиграла — ставка проиграна, выплаты нет, исходы остальных
    # ног нужны для калибровки
    lost = (await settle(member.client, lost_bet.id, "win", "loss")).json()
    assert lost["status"] == "lost" and lost["profit"] == "-200.00" and lost["payout"] == "0.00"
    assert [leg["result"] for leg in lost["legs"]] == ["win", "loss"]
    assert await _kinds(db, member.id) == [
        ("deposit", D("10000.00")),
        ("stake", D("-100.00")),
        ("stake", D("-200.00")),
        ("refund", D("100.00")),
    ]
    await _check_bank_matches_reference(db, member.id)


async def test_reverse_and_resettle(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    bet = await maker.bet(member.user, [LegSpec(odds="2.00")], stake="1000")
    assert (await settle(member.client, bet.id, "win")).status_code == 200
    bank_won = (await member.client.get("/api/me/bank")).json()
    assert bank_won["equity"] == "11000.00" and bank_won["peak"] == "11000.00"

    # Исправление: сторно выплаты, ставка снова открыта, закрытие и CLV не теряются
    reversed_bet = (await reverse(member.client, bet.id)).json()
    assert reversed_bet["status"] == "open" and reversed_bet["profit"] is None
    assert reversed_bet["settled_at"] is None and reversed_bet["settled_by"] is None
    assert reversed_bet["legs"][0]["result"] is None and reversed_bet["legs"][0]["score"] is None
    rows = await ledger_rows(db, member.id)
    payout, reversal = rows[-2], rows[-1]
    assert (payout.kind, reversal.kind) == ("payout", "reversal")
    assert reversal.amount == -payout.amount and payout.reversed_by == reversal.id
    assert reversal.bet_id == bet.id and reversal.note == f"Исправление результата ставки №{bet.id}"
    bank_open = (await member.client.get("/api/me/bank")).json()
    # Ошибочная выплата не оставляет завышенный пик (Р22)
    assert bank_open["balance"] == "9000.00" and bank_open["in_play"] == "1000.00"
    assert bank_open["equity"] == "10000.00" and bank_open["peak"] == "10000.00"
    await _check_bank_matches_reference(db, member.id)

    # Новый расчет — проигрыш: выплаты нет, просадка 10% от пика 10 000
    lost = (await settle(member.client, bet.id, "loss")).json()
    assert lost["status"] == "lost"
    bank_lost = (await member.client.get("/api/me/bank")).json()
    assert bank_lost["equity"] == "9000.00" and bank_lost["drawdown"] == "0.1000"
    assert bank_lost["drawdown_level"] == "dd10"
    # Исправление проигрыша: в журнале ничего не меняется
    count = len(await ledger_rows(db, member.id))
    assert (await reverse(member.client, bet.id)).json()["status"] == "open"
    assert len(await ledger_rows(db, member.id)) == count
    # И снова выигрыш: новая выплата рядом со старой отмененной
    again = (await settle(member.client, bet.id, "win")).json()
    assert again["status"] == "won" and again["payout"] == "2000.00"
    kinds = [row.kind for row in await ledger_rows(db, member.id)]
    assert kinds.count("payout") == 2 and kinds.count("reversal") == 1
    assert (await member.client.get("/api/me/bank")).json()["equity"] == "11000.00"
    await _check_bank_matches_reference(db, member.id)


async def test_double_click_and_race(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    bet = await maker.bet(member.user, [LegSpec(odds="1.90")], stake="100")
    card = await get_bet(member.client, bet.id)
    body = settle_body(card, "win")
    url = f"/api/bets/{bet.id}/result"
    # Двойной клик: два одинаковых запроса одновременно — одна выплата, оба ответа 200
    first, second = await asyncio.gather(
        member.client.put(url, json=body), member.client.put(url, json=body)
    )
    assert (first.status_code, second.status_code) == (200, 200)
    assert first.json()["updated_at"] == second.json()["updated_at"]
    kinds = [row.kind for row in await ledger_rows(db, member.id)]
    assert kinds.count("payout") == 1
    # Другой исход по устаревшей версии — 409, ничего не меняется
    other = await member.client.put(url, json=settle_body(card, "loss"))
    assert other.status_code == 409 and error_code(other) == "bet.changed"
    # Ставка рассчитана, а участник шлет расчет по свежей версии — 409 bet.settled
    fresh = await get_bet(member.client, bet.id)
    repeat = await member.client.put(url, json=settle_body(fresh, "loss"))
    assert repeat.status_code == 409 and error_code(repeat) == "bet.settled"
    # Двойной клик «Исправить»: второй — по устаревшей версии, ставка уже открыта — 200
    reverse_body = {"expected_updated_at": fresh["updated_at"]}
    reverse_url = f"/api/bets/{bet.id}/reverse"
    one, two = await asyncio.gather(
        member.client.post(reverse_url, json=reverse_body),
        member.client.post(reverse_url, json=reverse_body),
    )
    assert (one.status_code, two.status_code) == (200, 200)
    kinds = [row.kind for row in await ledger_rows(db, member.id)]
    assert kinds.count("reversal") == 1
    # Сторно открытой ставки по свежей версии — 409
    opened = await get_bet(member.client, bet.id)
    again = await member.client.post(
        reverse_url, json={"expected_updated_at": opened["updated_at"]}
    )
    assert again.status_code == 409 and error_code(again) == "bet.not_settled"
    await _check_bank_matches_reference(db, member.id)


async def test_parallel_settlements_and_withdrawal_keep_bank(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Расчеты разных ставок и движение банка идут под одной блокировкой участника:
    журнал сходится, ни одна запись не потеряна."""
    bets = [await maker.bet(member.user, [LegSpec(odds="2.00")], stake="100") for _ in range(4)]
    cards = [await get_bet(member.client, bet.id) for bet in bets]
    journal = (await member.client.get("/api/me/bank/entries")).json()
    last_id = journal["last_id"]
    responses = await asyncio.gather(
        *(
            member.client.put(f"/api/bets/{card['id']}/result", json=settle_body(card, "win"))
            for card in cards
        ),
        member.client.post(
            "/api/me/bank/entries",
            json={"kind": "withdrawal", "amount": "50", "expected_last_id": last_id},
        ),
    )
    assert [response.status_code for response in responses[:4]] == [200] * 4
    # Вывод мог пройти первым или получить 409: журнал менялся параллельно
    assert responses[4].status_code in (201, 409)
    withdrawn = D("50") if responses[4].status_code == 201 else D(0)
    bank = (await member.client.get("/api/me/bank")).json()
    assert D(bank["balance"]) == D("10000") - D("400") + D("800") - withdrawn
    await _check_bank_matches_reference(db, member.id)


async def test_settle_checks(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    bet = await maker.bet(member.user, [LegSpec(), LegSpec()], stake="100")
    card = await get_bet(member.client, bet.id)
    url = f"/api/bets/{bet.id}/result"
    # Не все ноги
    partial = await member.client.put(
        url, json=settle_body({**card, "legs": card["legs"][:1]}, "win")
    )
    assert partial.status_code == 422 and error_code(partial) == "bet.legs_mismatch"
    # Чужая нога
    body = settle_body(card, "win", "win")
    body["legs"][1]["leg_id"] = 999999
    assert error_code(await member.client.put(url, json=body)) == "bet.legs_mismatch"
    # Счет не того формата: матч до двух побед
    body = settle_body(card, "win", "win")
    body["legs"][0]["score"] = "3:1"
    response = await member.client.put(url, json=body)
    assert response.status_code == 422 and error_code(response) == "bet.bad_score"
    assert response.json()["error"]["examples"] == "2:0, 2:1, 1:2, 0:2"
    body["legs"][0]["score"] = "6-4"
    assert error_code(await member.client.put(url, json=body)) == "bet.bad_score"
    # Закрывающий кэф вне 1.01–50
    body = settle_body(card, "win", "win")
    body["legs"][0]["closing"] = {"odds": "1.00", "by": "pinnacle"}
    response = await member.client.put(url, json=body)
    assert response.status_code == 422 and error_code(response) == "bet.closing_range"
    # Наивное время версии — 422 проверки формы
    body = settle_body(card, "win", "win")
    body["expected_updated_at"] = "2026-10-13T10:00:00"
    assert (await member.client.put(url, json=body)).status_code == 422
    # Ничего не записано
    assert (await get_bet(member.client, bet.id))["status"] == "open"
    assert [row.kind for row in await ledger_rows(db, member.id)] == ["deposit", "stake"]
    # Несуществующая ставка — 404
    missing = await member.client.put(
        "/api/bets/999999/result", json=settle_body(card, "win", "win")
    )
    assert missing.status_code == 404 and error_code(missing) == "bet.not_found"


async def test_score_by_format_and_side(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    """Счет: первым — игрок 1; хранится со стороны выбранного игрока. Формат — из матча,
    турнира или ввода анализа (матч без турнира, Большой шлем)."""
    bet = await maker.bet(
        member.user,
        [
            LegSpec(selection=2, market="HCP_+1.5"),
            LegSpec(tournament=None, confirmed_best_of=5, confirmed_surface="clay"),
        ],
    )
    card = await get_bet(member.client, bet.id)
    assert card["legs"][1]["match"]["best_of"] == 5
    assert card["legs"][1]["match"]["surface"] == "clay"
    body = settle_body(card, "win", "win")
    body["legs"][0]["score"] = "2:1"
    body["legs"][1]["score"] = "3:2"
    data = (await member.client.put(f"/api/bets/{bet.id}/result", json=body)).json()
    assert [leg["score"] for leg in data["legs"]] == ["2:1", "3:2"]
    stored = list(
        await db.scalars(
            select(BetLeg.score)
            .where(BetLeg.bet_id == bet.id)
            .order_by(BetLeg.id)
            .execution_options(populate_existing=True)
        )
    )
    # Нога на игрока 2: его сеты первыми
    assert stored == ["1:2", "3:2"]


async def test_closing_and_clv(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    bet = await maker.bet(
        member.user, [LegSpec(odds="1.85"), LegSpec(odds="1.50"), LegSpec(odds="1.40")]
    )
    card = await get_bet(member.client, bet.id)
    first, second, third = (leg["id"] for leg in card["legs"])
    url = f"/api/bets/{bet.id}/legs/{first}/closing"
    # Своя сторона и обратная у эталона: CLV и CLV без маржи (степенной метод)
    data = (
        await member.client.put(
            url, json={"closing": {"odds": "1.75", "opp_odds": "2.10", "by": "pinnacle"}}
        )
    ).json()
    leg = data["legs"][0]
    q = devig_pair(D("1.75"), D("2.10"))
    assert leg["closing"] == {
        "odds": "1.75",
        "opp_odds": "2.10",
        "by": "pinnacle",
        "bookmaker": None,
        "source": "user",
        "q_close": pytest.approx(q),
        "unverified": False,
    }
    assert leg["clv"] == pytest.approx(1.85 / 1.75 - 1)
    assert leg["clv_fair"] == pytest.approx(1.85 * q - 1)
    # CLV экспресса — только когда закрытие есть у всех ног
    assert data["clv"] is None and data["updated_at"] != card["updated_at"]
    # Свой букмекер: название не указано — букмекер ставки
    own = (
        await member.client.put(
            f"/api/bets/{bet.id}/legs/{second}/closing",
            json={"closing": {"odds": "1.45", "by": "bookmaker"}},
        )
    ).json()
    assert own["legs"][1]["closing"]["by"] == "bookmaker"
    assert own["legs"][1]["closing"]["bookmaker"] == "Fonbet"
    assert own["legs"][1]["clv_fair"] is None
    # Третья нога — возврат при расчете: CLV экспресса — по двум остальным
    body = settle_body(own, "win", "loss", "void")
    data = (await member.client.put(f"/api/bets/{bet.id}/result", json=body)).json()
    assert data["status"] == "lost"
    assert data["clv"] == pytest.approx((1.85 * 1.50) / (1.75 * 1.45) - 1)
    # Проигравшая нога с CLV > 0 — дисперсия
    assert data["verdict"] == "variance"
    # Закрытие можно внести и после расчета; null — стереть
    cleared = (
        await member.client.put(f"/api/bets/{bet.id}/legs/{second}/closing", json={"closing": None})
    ).json()
    assert cleared["legs"][1]["closing"] is None and cleared["legs"][1]["clv"] is None
    assert cleared["clv"] is None and cleared["verdict"] == "no_closing"
    stored = await db.get_one(BetLeg, second, populate_existing=True)
    assert stored.closing_odds is None and stored.q_close is None and stored.clv is None
    # Нога другой ставки — 404
    other = await maker.bet(member.user, [LegSpec()])
    response = await member.client.put(
        f"/api/bets/{other.id}/legs/{third}/closing",
        json={"closing": {"odds": "1.5", "by": "avg"}},
    )
    assert response.status_code == 404 and error_code(response) == "bet.leg_not_found"
    del first


@pytest.mark.parametrize(
    ("results", "closings", "verdict"),
    [
        (("win",), ("1.70",), "edge_confirmed"),
        (("win",), ("1.90",), "won_against_market"),
        (("win",), (None,), "no_closing"),
        (("loss",), ("1.90",), "model_error"),
        (("loss",), ("1.70",), "variance"),
        (("void",), ("1.70",), "void"),
    ],
)
async def test_verdict_by_clv(
    results: tuple[str, ...],
    closings: tuple[str | None, ...],
    verdict: str,
    member: Signed,
    maker: BetMaker,
) -> None:
    bet = await maker.bet(member.user, [LegSpec(odds="1.80")])
    closing: dict[str, Any] = {}
    if closings[0] is not None:
        closing = {"closing": {"odds": closings[0], "by": "pinnacle"}}
    data = (await settle(member.client, bet.id, *results, **closing)).json()
    assert data["verdict"] == verdict


async def _imported_legacy_bet(maker: BetMaker, member: Signed, db: AsyncSession) -> Bet:
    """Ставка бота, рассчитанная импортом (как пишет app/ingest/legacy.py)."""
    bet = await maker.bet(member.user, [LegSpec(odds="1.80")], stake="100", source="legacy")
    row = await db.get_one(Bet, bet.id)
    row.status, row.profit, row.settled_by = "won", D("80"), "legacy"
    row.settled_at = row.placed_at
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bet.id))
    assert leg is not None
    leg.result, leg.result_source, leg.settled_at = "win", "legacy", row.placed_at
    db.add(
        BankrollLedger(
            user_id=member.id,
            at=row.placed_at,
            kind="payout",
            amount=D("180"),
            currency="RUB",
            bet_id=bet.id,
        )
    )
    await db.commit()
    return bet


async def test_imported_legacy_result_is_not_recalculated(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    bet = await _imported_legacy_bet(maker, member, db)
    card = await get_bet(member.client, bet.id)
    assert card["source"] == "legacy" and card["settled_by"] == "legacy"
    assert card["verdict"] == "legacy"
    leg_id = card["legs"][0]["id"]
    for method, url, body in (
        ("PUT", f"/api/bets/{bet.id}/result", settle_body(card, "loss")),
        ("POST", f"/api/bets/{bet.id}/reverse", {"expected_updated_at": card["updated_at"]}),
        (
            "PUT",
            f"/api/bets/{bet.id}/legs/{leg_id}/closing",
            {"closing": {"odds": "1.5", "by": "pinnacle"}},
        ),
    ):
        response = await member.client.request(method, url, json=body)
        assert response.status_code == 409 and error_code(response) == "bet.legacy", url
    row = await db.get_one(Bet, bet.id, populate_existing=True)
    assert (row.status, row.settled_by) == ("won", "legacy")
    assert [kind for kind, _ in await _kinds(db, member.id)] == ["deposit", "stake", "payout"]


async def test_open_legacy_bet_is_settled_by_member(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Открытую ставку бота (импорт пишет ее со списанием) участник рассчитывает сам:
    иначе сумма навсегда «в игре», а счетчик открытых не обнуляется."""
    bet = await maker.bet(member.user, [LegSpec(odds="1.90")], stake="500", source="legacy")
    bank = (await member.client.get("/api/me/bank")).json()
    assert (bank["balance"], bank["in_play"]) == ("9500.00", "500.00")
    response = await settle(member.client, bet.id, "win", score="2:0")
    assert response.status_code == 200, response.text
    data = response.json()
    assert (data["status"], data["settled_by"], data["payout"]) == ("won", "manual", "950.00")
    assert data["verdict"] == "legacy"
    assert await _kinds(db, member.id) == [
        ("deposit", D("10000.00")),
        ("stake", D("-500.00")),
        ("payout", D("950.00")),
    ]
    bank = (await member.client.get("/api/me/bank")).json()
    assert (bank["balance"], bank["in_play"], bank["equity"]) == ("10450.00", "0", "10450.00")
    summary = (await member.client.get("/api/bets/summary")).json()
    assert (summary["open"], summary["won"], summary["legacy_settled"]) == (0, 1, 1)
    # Закрытие и исправление — как у своей ставки; CLV ставок бота в итоги не входит
    leg_id = data["legs"][0]["id"]
    closing = await member.client.put(
        f"/api/bets/{bet.id}/legs/{leg_id}/closing",
        json={"closing": {"odds": "1.70", "by": "pinnacle"}},
    )
    assert closing.status_code == 200 and closing.json()["clv"] is not None
    assert (await member.client.get("/api/bets/summary")).json()["clv_n"] == 0
    assert (await reverse(member.client, bet.id)).status_code == 200
    again = await settle(member.client, bet.id, "loss")
    assert again.status_code == 200 and again.json()["status"] == "lost"
    bank = (await member.client.get("/api/me/bank")).json()
    assert (bank["balance"], bank["in_play"]) == ("9500.00", "0")
    await _check_bank_matches_reference(db, member.id)


async def test_reverse_refuses_broken_ledger(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Выигранная ставка без действующей выплаты (журнал испорчен) — исправлять нельзя."""
    bet = await maker.bet(member.user, [LegSpec()])
    row = await db.get_one(Bet, bet.id)
    row.status, row.profit, row.settled_at = "won", D("80"), datetime.now(UTC)
    await db.commit()
    response = await reverse(member.client, bet.id)
    assert response.status_code == 409 and error_code(response) == "bet.ledger_conflict"


async def test_mutations_need_csrf(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, maker: BetMaker
) -> None:
    user = await make_user()
    bet = await maker.bet(user, [LegSpec()])
    client = await login(await make_client("10.0.0.9", csrf=False), user)
    stamp = (datetime.now(UTC) - timedelta(days=1)).isoformat()
    for method, url, body in (
        ("PUT", f"/api/bets/{bet.id}/result", {"expected_updated_at": stamp, "legs": []}),
        ("POST", f"/api/bets/{bet.id}/reverse", {"expected_updated_at": stamp}),
        ("PUT", f"/api/bets/{bet.id}/legs/1/closing", {"closing": None}),
        ("POST", "/api/me/bank/entries", {"kind": "deposit", "amount": "1"}),
    ):
        response = await client.request(method, url, json=body)
        assert response.status_code == 403 and error_code(response) == "common.csrf", url


async def test_score_outcomes_and_score_against_result(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Окно расчета берет исход по счету из карточки (score_outcomes), а не считает сам.
    Счет против выбранного исхода принимается: исход — по расчету букмекера (В16), окно
    только предупреждает (согласованный макет)."""
    bet = await maker.bet(
        member.user,
        [
            LegSpec(odds="2.40", market="HCP_-1.5"),
            LegSpec(odds="1.50", selection=2, tournament=None, confirmed_best_of=5),
        ],
    )
    card = await get_bet(member.client, bet.id)
    minus, second = (leg["score_outcomes"] for leg in card["legs"])
    assert minus == {"2:0": "win", "2:1": "loss", "1:2": "loss", "0:2": "loss"}
    assert second == {
        "3:0": "loss",
        "3:1": "loss",
        "3:2": "loss",
        "2:3": "win",
        "1:3": "win",
        "0:3": "win",
    }
    body = settle_body(card, "win", "win")
    body["legs"][0]["score"] = "2:1"
    response = await member.client.put(f"/api/bets/{bet.id}/result", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    assert data["status"] == "won" and data["legs"][0]["score"] == "2:1"
    assert all(leg["score_outcomes"] is None for leg in data["legs"])


async def test_payout_over_money_limit_is_refused(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Выплата больше NUMERIC(12, 2) — 422, а не 500; проигрыш такой ставки рассчитывается."""
    bet = await maker.bet(
        member.user, [LegSpec(odds="3.00")], stake="5000000000", deposit="9000000000"
    )
    response = await settle(member.client, bet.id, "win")
    assert response.status_code == 422 and error_code(response) == "bet.payout_overflow"
    assert response.json()["error"]["payout"] == "15000000000.00"
    assert (await get_bet(member.client, bet.id))["status"] == "open"
    assert [kind for kind, _ in await _kinds(db, member.id)] == ["deposit", "stake"]
    lost = await settle(member.client, bet.id, "loss")
    assert lost.status_code == 200 and lost.json()["status"] == "lost"


async def test_version_with_browser_precision(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Браузер хранит время с точностью до миллисекунды (new Date(s).toISOString()):
    такая версия совпадает со своей, а следующая версия позже хотя бы на 2 мс."""
    bet = await maker.bet(member.user, [LegSpec(odds="2.00")])
    card = await get_bet(member.client, bet.id)

    def browser(stamp: str) -> datetime:
        moment = datetime.fromisoformat(stamp.replace("Z", "+00:00"))
        return moment.replace(microsecond=moment.microsecond // 1000 * 1000)

    old = browser(card["updated_at"])
    body = settle_body(card, "win")
    body["expected_updated_at"] = old.isoformat()
    response = await member.client.put(f"/api/bets/{bet.id}/result", json=body)
    assert response.status_code == 200, response.text
    new = datetime.fromisoformat(response.json()["updated_at"].replace("Z", "+00:00"))
    assert new - datetime.fromisoformat(card["updated_at"].replace("Z", "+00:00")) >= timedelta(
        milliseconds=2
    )
    stale = await member.client.post(
        f"/api/bets/{bet.id}/reverse", json={"expected_updated_at": old.isoformat()}
    )
    assert stale.status_code == 409 and error_code(stale) == "bet.changed"
    fresh = await member.client.post(
        f"/api/bets/{bet.id}/reverse",
        json={"expected_updated_at": browser(response.json()["updated_at"]).isoformat()},
    )
    assert fresh.status_code == 200 and fresh.json()["status"] == "open"


@pytest.mark.parametrize("how", ["sackmann", "merge"])
async def test_side_flip_makes_open_card_stale(
    how: str, member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    """Загрузчик перевернул стороны матча после того, как участник открыл карточку:
    счет «первым — игрок 1» из окна относился бы к другому игроку — 409, по свежей
    карточке счет пишется верно."""
    bet = await maker.bet(member.user, [LegSpec(odds="1.80")])
    card = await get_bet(member.client, bet.id)
    match = await db.get_one(Match, card["legs"][0]["match"]["id"])
    first, second = match.player1_id, match.player2_id
    if how == "sackmann":
        match.player1_id, match.player2_id = second, first
        await db.flush()
        await _flip_sides(db, [match.id])
        await db.commit()
    else:
        target = Match(
            tournament_id=match.tournament_id,
            round="F",
            player1_id=second,
            player2_id=first,
            source="sackmann",
            source_ref="flip-target",
        )
        db.add(target)
        await db.commit()
        report = await merge_matches(db, source_match_id=match.id, target_match_id=target.id)
        assert report.flipped
    # Участник видел «игрок 1 выиграл 2:0» и ставил на игрока 1
    body = settle_body(card, "win")
    body["legs"][0]["score"] = "2:0"
    stale = await member.client.put(f"/api/bets/{bet.id}/result", json=body)
    assert stale.status_code == 409 and error_code(stale) == "bet.changed"
    fresh = await get_bet(member.client, bet.id)
    leg = fresh["legs"][0]
    assert leg["selection"] == 2 and leg["match"]["player2"]["id"] == first
    body = settle_body(fresh, "win")
    body["legs"][0]["score"] = "0:2"
    assert (await member.client.put(f"/api/bets/{bet.id}/result", json=body)).status_code == 200
    stored = await db.scalar(
        select(BetLeg.score)
        .where(BetLeg.bet_id == bet.id)
        .execution_options(populate_existing=True)
    )
    assert stored == "2:0"
