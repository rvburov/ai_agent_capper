"""Расчет по архиву (этап 5, волна 1): привязка матчей из анализов к архиву, закрытие из
архива, авторасчет ставок (деньги — точное равенство Decimal с эталонным SQL), расхождение
с ручным расчетом, напоминания, исходы ног экспрессов бота, гонки с ручным расчетом и
сменой валюты, повторный запуск."""

import asyncio
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.formatting import format_money
from app.db.models import (
    BankrollLedger,
    Bet,
    BetLeg,
    IngestionRun,
    Match,
    Notification,
    OddsSnapshot,
    Player,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ingest import match_link
from app.ml.market import devig_pair
from app.services import auto_settlement, players
from app.services.archive_settlement import settle_from_archive, summary_lines
from app.services.bank import CURRENCY_LOCK, bank_from_entries, bank_state, ledger_entries
from tests.helpers_admin import Signed, signed_in
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
DAY = date(2026, 10, 4)
PLACED = datetime(2026, 10, 4, 9, 0, tzinfo=UTC)
Factory = Callable[[], AsyncSession]


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


@pytest.fixture
def maker(db: AsyncSession) -> BetMaker:
    return BetMaker(db)


@pytest.fixture
def factory(engine: AsyncEngine) -> Factory:
    return create_sessionmaker(engine)


@dataclass
class Archive:
    """Матчи архива tennis-data для тестов."""

    db: AsyncSession
    counter: int = 0

    async def match(
        self,
        player1: int,
        player2: int,
        *,
        day: date = DAY,
        winner: int | None = 1,
        score: str | None = "6-4 6-3",
        status: str = "finished",
        best_of: int = 3,
        odds: dict[str, tuple[str, str]] | None = None,
    ) -> Match:
        """Матч архива (счет — со стороны победителя) и кэфы ML: букмекер → (П1, П2)."""
        self.counter += 1
        tour = Tournament(
            name=f"Archive Open {self.counter}",
            surface="hard",
            best_of=best_of,
            start_date=day - timedelta(days=2),
            source="tennis_data",
            source_ref=f"2026-{900 + self.counter}",
        )
        self.db.add(tour)
        await self.db.flush()
        winner_id = None if winner is None else (player1 if winner == 1 else player2)
        match = Match(
            tournament_id=tour.id,
            round="R32",
            player1_id=player1,
            player2_id=player2,
            match_date=day,
            winner_id=winner_id,
            score=score,
            status=status,
            best_of=best_of,
            source="tennis_data",
            source_ref=f"td-test-{self.counter}",
        )
        self.db.add(match)
        await self.db.flush()
        for bookmaker, pair in (odds or {}).items():
            for selection, value in enumerate(pair, start=1):
                self.db.add(
                    OddsSnapshot(
                        match_id=match.id,
                        market="ML",
                        selection=selection,
                        bookmaker=bookmaker,
                        odds=D(value),
                        kind="archive",
                        taken_at=datetime.combine(day, datetime.min.time(), tzinfo=UTC),
                    )
                )
        await self.db.commit()
        return match


@pytest.fixture
def archive(db: AsyncSession) -> Archive:
    return Archive(db)


async def _legs(db: AsyncSession, bet_id: int) -> list[BetLeg]:
    return list(
        await db.scalars(
            select(BetLeg)
            .where(BetLeg.bet_id == bet_id)
            .order_by(BetLeg.id)
            .execution_options(populate_existing=True)
        )
    )


async def _pair(db: AsyncSession, leg: BetLeg) -> tuple[int, int]:
    match = await db.get_one(Match, leg.match_id, populate_existing=True)
    return match.player1_id, match.player2_id


async def _bet(db: AsyncSession, bet_id: int) -> Bet:
    return await db.get_one(Bet, bet_id, populate_existing=True)


async def _notes(db: AsyncSession, user_id: int, kind: str) -> list[Notification]:
    return list(
        await db.scalars(
            select(Notification)
            .where(Notification.user_id == user_id, Notification.kind == kind)
            .order_by(Notification.id)
        )
    )


def _spec(**fields: Any) -> LegSpec:
    """Нога на матче из ввода участника без турнира, день матча — DAY."""
    return LegSpec(tournament=None, match_day=DAY, **fields)


async def _check_bank(db: AsyncSession, user_id: int) -> None:
    """Банк из SQL совпадает с эталоном по строкам журнала (Р22)."""
    now = datetime.now(UTC)
    entries = await ledger_entries(db, user_id)
    statuses = list(await db.scalars(select(Bet.status).where(Bet.user_id == user_id)))
    slow = bank_from_entries(
        entries, currency="RUB", won=statuses.count("won"), lost=statuses.count("lost"), now=now
    )
    assert await bank_state(db, user_id, now=now) == slow


# Эталон авторасчета: выплата по ставке — сумма × кэф расчета до копеек (половина — вверх)
# у выигрыша, сумма у возврата; кэф расчета — произведение кэфов выигравших ног
_PAYOUT_SQL = text(
    """
    SELECT b.id, b.status, b.stake,
           CASE b.status
             WHEN 'won' THEN round(b.stake * (
               SELECT CASE WHEN bool_or(l.result = 'void')
                           THEN round(exp(sum(ln(l.odds_taken)) FILTER (WHERE l.result = 'win')), 3)
                           ELSE b.total_odds END
               FROM bet_legs l WHERE l.bet_id = b.id), 2)
             WHEN 'void' THEN b.stake
             ELSE 0 END AS payout,
           (SELECT coalesce(sum(amount), 0) FROM bankroll_ledger g
             WHERE g.bet_id = b.id AND g.kind IN ('payout', 'refund')
               AND g.reversed_by IS NULL) AS ledger
    FROM bets b WHERE b.user_id = :user_id AND b.settled_by = 'auto' ORDER BY b.id
    """
)

# Эталон закрытия из архива: кэф эталона по порядку pinnacle → betfair_ex → avg (у кого
# есть обе стороны), свой и обратный; CLV = кэф / закрытие − 1
_CLOSING_SQL = text(
    """
    WITH pairs AS (
      SELECT match_id, bookmaker,
             max(odds) FILTER (WHERE selection = 1) AS o1,
             max(odds) FILTER (WHERE selection = 2) AS o2
      FROM odds_snapshots WHERE kind = 'archive' AND market = 'ML'
      GROUP BY match_id, bookmaker
    ), ref AS (
      SELECT DISTINCT ON (match_id) match_id, bookmaker, o1, o2 FROM pairs
      WHERE o1 IS NOT NULL AND o2 IS NOT NULL
        AND bookmaker IN ('pinnacle', 'betfair_ex', 'avg')
      ORDER BY match_id,
               array_position(ARRAY['pinnacle', 'betfair_ex', 'avg']::text[], bookmaker::text)
    )
    SELECT l.id, r.bookmaker,
           CASE l.selection WHEN 1 THEN r.o1 ELSE r.o2 END AS own,
           CASE l.selection WHEN 1 THEN r.o2 ELSE r.o1 END AS opp,
           l.odds_taken / CASE l.selection WHEN 1 THEN r.o1 ELSE r.o2 END - 1 AS clv
    FROM bet_legs l JOIN bets b ON b.id = l.bet_id JOIN ref r ON r.match_id = l.match_id
    WHERE b.user_id = :user_id AND l.market = 'ML' ORDER BY l.id
    """
)


async def test_link_close_and_settle_express(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Экспресс из двух ног: матчи из ввода привязываются к архиву (один — с обратным
    порядком игроков), закрытие П1/П2 — по эталону, ставка рассчитана сама; деньги — как
    эталонный SQL, уведомление со ссылкой на ставку."""
    bet = await maker.bet(
        member.user,
        [_spec(odds="1.85"), _spec(odds="2.10", selection=2)],
        stake="333.33",
        placed_at=PLACED,
    )
    first, second = await _legs(db, bet.id)
    a1, b1 = await _pair(db, first)
    a2, b2 = await _pair(db, second)
    # Первый матч: в архиве тот же порядок, выиграл игрок 1, Pinnacle есть
    match1 = await archive.match(
        a1, b1, odds={"pinnacle": ("1.80", "2.10"), "avg": ("1.75", "2.05")}
    )
    # Второй: в архиве игроки наоборот, выиграл первый игрок архива = игрок 2 ставки;
    # Pinnacle только с одной стороны — эталон Betfair
    match2 = await archive.match(
        b2,
        a2,
        day=DAY + timedelta(days=1),
        score="7-6(5) 6-7(3) 6-4",
        odds={"betfair_ex": ("1.90", "2.00")},
    )
    db.add(
        OddsSnapshot(
            match_id=match2.id,
            market="ML",
            selection=1,
            bookmaker="pinnacle",
            odds=D("1.92"),
            kind="archive",
        )
    )
    await db.commit()

    report, run_id = await settle_from_archive(factory, warm=False)
    counts = report.counts
    assert counts["matches.linked"] == 2 and counts["matches.flipped"] == 1
    assert counts["bets.settled"] == 1 and counts["bets.people"] == 1
    assert counts["bets.legs"] == 2 and counts["closing.legs"] == 2
    assert report.freshness["archive_to"] == DAY + timedelta(days=1)
    assert any("Рассчитано ставок: 1" in line for line in summary_lines(report))

    first, second = await _legs(db, bet.id)
    assert (first.match_id, second.match_id) == (match1.id, match2.id)
    # Нога на игрока 2 ставки после переворота — на игрока 1 матча архива
    assert second.selection == 1
    assert (first.result, first.score, first.result_source) == ("win", "2:0", "auto")
    assert (second.result, second.score) == ("win", "2:1")
    # Закрытие из архива: эталон и CLV как в эталонном SQL
    rows = (await db.execute(_CLOSING_SQL, {"user_id": member.id})).all()
    assert [(row.id, row.bookmaker) for row in rows] == [
        (first.id, "pinnacle"),
        (second.id, "betfair_ex"),
    ]
    for leg, row in zip((first, second), rows, strict=True):
        assert (leg.closing_odds, leg.closing_opp_odds) == (row.own, row.opp)
        assert leg.closing_bookmaker == row.bookmaker and leg.closing_source == "archive"
        assert leg.clv == pytest.approx(float(row.clv))
        assert leg.q_close == pytest.approx(devig_pair(row.own, row.opp))

    saved = await _bet(db, bet.id)
    assert (saved.status, saved.settled_by, saved.settle_run_id) == ("won", "auto", run_id)
    [reference] = (await db.execute(_PAYOUT_SQL, {"user_id": member.id})).all()
    # 333,33 × 3.885 = 1 294,98705 → 1 294,99
    assert reference.payout == reference.ledger == D("1294.99")
    assert saved.profit == D("1294.99") - D("333.33")
    await _check_bank(db, member.id)

    [note] = await _notes(db, member.id, "bet_settled")
    assert note.link == f"/bets?bet={bet.id}"
    assert note.params["variant"] == "auto" and note.params["bet"] == str(bet.id)
    assert "автоматически" in note.title and "tennis-data" in note.body
    # Суммы — по-русски, с символом валюты, как на экранах: 961,66 → «+962 ₽»
    bank = await bank_state(db, member.id)
    assert "выигрыш, прибыль +962\u00a0₽. Банк — " in note.body
    assert f"Банк — {format_money(bank.equity, 'RUB')}." in note.body
    assert "RUB" not in note.body and "." not in note.body.split("Банк — ")[1].split(".")[0]
    assert note.params["status"] == "won"

    card = await get_bet(member.client, bet.id)
    assert card["settled_by"] == "auto" and card["archive_to"] == "2026-10-05"
    assert card["legs"][0]["closing"]["unverified"] is True
    assert card["legs"][0]["closing"]["by"] == "pinnacle"
    assert card["awaiting_result"] is False

    # Повторный запуск ничего не меняет: ни денег, ни уведомлений
    entries = len(await ledger_rows(db, member.id))
    again, _ = await settle_from_archive(factory, warm=False)
    assert again.counts["bets.settled"] == 0 and again.counts["closing.legs"] == 0
    assert again.counts["matches.linked"] == 0
    assert len(await ledger_rows(db, member.id)) == entries
    assert len(await _notes(db, member.id, "bet_settled")) == 1


async def test_lost_handicap_and_waiting_legs(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Фора −1.5 по полному счету, проигрыш без выплаты; ставка с матчем, которого в
    архиве еще нет, ждет; закрытие участника не меняется."""
    lost = await maker.bet(
        member.user, [_spec(odds="2.40", market="HCP_-1.5")], stake="100", placed_at=PLACED
    )
    [leg] = await _legs(db, lost.id)
    p1, p2 = await _pair(db, leg)
    # Игрок 1 выиграл 2:1 — фора −1.5 не сыграла; у форы закрытия из архива нет
    await archive.match(p1, p2, score="6-4 3-6 6-2", odds={"pinnacle": ("1.50", "2.70")})
    waiting = await maker.bet(
        member.user, [_spec(odds="1.70"), _spec(odds="1.60")], stake="50", placed_at=PLACED
    )
    w1, _ = await _legs(db, waiting.id)
    q1, q2 = await _pair(db, w1)
    await archive.match(q1, q2, winner=2, score="6-3 6-3", odds={"avg": ("1.70", "2.20")})
    # Закрытие, которое внес участник, архив не трогает
    closing = {"odds": "1.66", "by": "bookmaker"}
    response = await member.client.put(
        f"/api/bets/{waiting.id}/legs/{w1.id}/closing", json={"closing": closing}
    )
    assert response.status_code == 200, response.text

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["bets.settled"] == 1
    # Второй матч ставки waiting не в архиве: архив по DAY, он ждет следующего файла
    assert report.counts["matches.linked"] == 2 and report.counts["matches.waiting"] == 1
    saved = await _bet(db, lost.id)
    assert (saved.status, saved.profit) == ("lost", D("-100.00"))
    [note] = await _notes(db, member.id, "bet_settled")
    assert "проигрыш, убыток 100\u00a0₽" in note.body and "прибыль" not in note.body
    [leg] = await _legs(db, lost.id)
    assert (leg.result, leg.score, leg.closing_odds) == ("loss", "2:1", None)
    assert [row.kind for row in await ledger_rows(db, member.id)].count("payout") == 0
    open_bet = await _bet(db, waiting.id)
    assert open_bet.status == "open"
    w1, w2 = await _legs(db, waiting.id)
    assert (w1.result, w1.closing_source, w1.closing_odds) == (None, "user", D("1.660"))
    assert w2.result is None
    await _check_bank(db, member.id)


async def test_retired_needs_manual_and_reversed_is_left_alone(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Снятие — исход вносит участник: одно напоминание, ставка открыта. Ставку, которую
    участник исправил («Исправить результат»), авторасчет больше не трогает (Т3)."""
    retired = await maker.bet(member.user, [_spec()], placed_at=PLACED)
    [leg] = await _legs(db, retired.id)
    await archive.match(*await _pair(db, leg), score="6-4 2-1 RET", status="retired")
    fixed = await maker.bet(member.user, [_spec(odds="1.50")], placed_at=PLACED)
    [fixed_leg] = await _legs(db, fixed.id)
    await archive.match(*await _pair(db, fixed_leg), winner=1)
    assert (await settle(member.client, fixed.id, "loss")).status_code == 200
    assert (await reverse(member.client, fixed.id)).status_code == 200
    before = (await _bet(db, retired.id)).updated_at

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["bets.settled"] == 0 and report.counts["bets.manual"] == 1
    assert (await _bet(db, retired.id)).status == "open"
    assert (await _bet(db, fixed.id)).status == "open"
    [note] = await _notes(db, member.id, "bet_needs_result")
    assert note.params["variant"] == "manual" and note.link == f"/bets?bet={retired.id}"
    assert "снятием" in note.body
    # Напоминание не меняет версию ставки: открытое окно расчета остается действительным
    saved = await _bet(db, retired.id)
    assert saved.updated_at == before and saved.result_reminded_at is not None
    await settle_from_archive(factory, warm=False)
    assert len(await _notes(db, member.id, "bet_needs_result")) == 1


async def test_conflict_with_manual_result(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Архив показывает другой исход ручного расчета: отметка у ноги и одно уведомление,
    банк не меняется; исправленный под архив расчет снимает отметку."""
    bet = await maker.bet(member.user, [_spec(odds="1.90")], stake="200", placed_at=PLACED)
    [leg] = await _legs(db, bet.id)
    await archive.match(*await _pair(db, leg), winner=2, score="6-2 6-2")
    assert (await settle(member.client, bet.id, "win")).status_code == 200
    ledger_before = [(row.kind, row.amount) for row in await ledger_rows(db, member.id)]

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["bets.conflicts"] == 1 and report.counts["bets.settled"] == 0
    [leg] = await _legs(db, bet.id)
    assert (leg.result, leg.archive_result, leg.archive_score) == ("win", "loss", "0:2")
    assert [(row.kind, row.amount) for row in await ledger_rows(db, member.id)] == ledger_before
    [note] = await _notes(db, member.id, "settle_conflict")
    assert note.link == f"/bets?bet={bet.id}" and "Банк не меняли" in note.body
    card = await get_bet(member.client, bet.id)
    assert card["legs"][0]["archive_result"] == "loss"
    assert card["legs"][0]["archive_score"] == "0:2"
    # Повтор: отметка та же, второго уведомления нет
    again, _ = await settle_from_archive(factory, warm=False)
    assert again.counts["bets.conflicts"] == 0
    assert len(await _notes(db, member.id, "settle_conflict")) == 1
    # Участник исправил результат под архив: отметка снята
    assert (await reverse(member.client, bet.id)).status_code == 200
    assert (await settle(member.client, bet.id, "loss")).status_code == 200
    await settle_from_archive(factory, warm=False)
    [leg] = await _legs(db, bet.id)
    assert leg.archive_result is None and leg.archive_score is None


async def test_ambiguous_and_missing_matches_are_reported(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Два матча пары в окне — не угадываем; матча нет, а архив уже дальше окна — «нет в
    архиве». Ставки открыты; в отчете игроки и день — только у матча для разбора руками,
    «нет в архиве» — числом (Р14)."""
    twice = await maker.bet(member.user, [_spec()], placed_at=PLACED)
    [leg] = await _legs(db, twice.id)
    pair = await _pair(db, leg)
    await archive.match(*pair, day=DAY - timedelta(days=1))
    await archive.match(*pair, day=DAY + timedelta(days=2))
    missing = await maker.bet(member.user, [_spec()], placed_at=PLACED)
    [lone] = await _legs(db, missing.id)
    # Архив дошел до DAY + 5: окно матча missing (± 3 дня) покрыто
    other = [Player(name="Late One"), Player(name="Late Two")]
    db.add_all(other)
    await db.flush()
    await archive.match(other[0].id, other[1].id, day=DAY + timedelta(days=5))

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["matches.unlinked"] == 2 and report.counts["matches.linked"] == 0
    assert report.counts["matches.not_found"] == 1
    reasons = {row["match_id"]: row["kind"] for row in report.unmatched}
    assert reasons == {leg.match_id: "ambiguous"} and lone.match_id not in reasons
    assert {row["day"] for row in report.unmatched} == {DAY.isoformat()}
    assert any("нет в архиве: 1" in line for line in summary_lines(report))
    assert (await _bet(db, twice.id)).status == "open"
    assert (await _bet(db, missing.id)).status == "open"
    run = await db.scalar(
        select(IngestionRun).where(IngestionRun.source == "settle").order_by(IngestionRun.id)
    )
    assert run is not None and run.status == "ok"


async def test_legacy_legs_from_archive(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Проигранный экспресс бота: исход ног — из архива, деньги и итог ставки не меняются;
    в «Данных» кабинета — сколько ног заполнено из архива и сколько осталось."""
    bet = await maker.bet(
        member.user, [_spec(), _spec(), _spec()], placed_at=PLACED, source="legacy"
    )
    await db.execute(
        update(Bet)
        .where(Bet.id == bet.id)
        .values(status="lost", profit=D("-100"), settled_at=PLACED, settled_by="legacy")
    )
    await db.commit()
    first, second, third = await _legs(db, bet.id)
    await archive.match(*await _pair(db, first), winner=1)
    await archive.match(*await _pair(db, second), winner=2)
    ledger_before = [(row.kind, row.amount) for row in await ledger_rows(db, member.id)]

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["legacy.legs"] == 2 and report.counts["bets.settled"] == 0
    first, second, third = await _legs(db, bet.id)
    assert [(leg.result, leg.result_source) for leg in (first, second, third)] == [
        ("win", "auto"),
        ("loss", "auto"),
        (None, None),
    ]
    saved = await _bet(db, bet.id)
    assert (saved.status, saved.profit, saved.settled_by) == ("lost", D("-100.00"), "legacy")
    assert [(row.kind, row.amount) for row in await ledger_rows(db, member.id)] == ledger_before
    summary = (await member.client.get("/api/me/export/summary")).json()
    assert summary["legacy_from_archive"] == 2 and summary["legacy_no_result"] == 1


async def test_reminder_once_per_bet(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    """Матчи ставки прошли 3 дня назад, исхода нет — одно напоминание со ссылкой; ставка с
    матчем позже — нет; версия ставки не меняется."""
    old = await maker.bet(member.user, [_spec(), _spec()], placed_at=PLACED)
    fresh = await maker.bet(
        member.user,
        [_spec(), LegSpec(tournament=None, match_day=DAY + timedelta(days=2))],
        placed_at=PLACED,
    )
    before = (await _bet(db, old.id)).updated_at
    now = datetime(2026, 10, 7, 12, 0, tzinfo=UTC)
    # 7 окт по поясу участника: DAY + 3 — уже пора; у второй ставки матч 6 окт — еще нет
    assert await auto_settlement.remind_unsettled(db, now=now) == 1
    assert await auto_settlement.remind_unsettled(db, now=now) == 0
    [note] = await _notes(db, member.id, "bet_needs_result")
    assert note.link == f"/bets?bet={old.id}" and note.params["days"] == "3"
    assert (await _bet(db, old.id)).updated_at == before
    assert (await _bet(db, fresh.id)).result_reminded_at is None
    # «Ждет результата»: открытые ставки, все матчи которых прошли
    counts = (await member.client.get("/api/bets/counts")).json()
    assert counts == {"open": 2, "awaiting_result": 2}


async def test_manual_settle_waits_for_auto_and_loses_the_race(
    member: Signed,
    maker: BetMaker,
    archive: Archive,
    db: AsyncSession,
    engine: AsyncEngine,
    factory: Factory,
) -> None:
    """Гонка: авторасчет держит блокировку денег участника — ручной расчет ждет и после
    него получает 409 (версия ставки сменилась); выплата одна. Смена валюты
    (исключительная блокировка) задерживает авторасчет до своего конца."""
    bet = await maker.bet(member.user, [_spec(odds="1.50")], stake="100", placed_at=PLACED)
    [leg] = await _legs(db, bet.id)
    await archive.match(*await _pair(db, leg), winner=1)
    card = await get_bet(member.client, bet.id)

    # Смена валюты держит свою блокировку: авторасчет ждет
    async with engine.connect() as lock_conn:
        await lock_conn.execute(text("SELECT pg_advisory_lock(:key)"), {"key": CURRENCY_LOCK})
        task = asyncio.create_task(settle_from_archive(factory, warm=False))
        await asyncio.sleep(0.5)
        assert not task.done()
        assert (await _bet(db, bet.id)).status == "open"
        # Ручной расчет в это время тоже ждет блокировку валюты
        manual = asyncio.create_task(
            member.client.put(
                f"/api/bets/{bet.id}/result",
                json={
                    "expected_updated_at": card["updated_at"],
                    "legs": [{"leg_id": leg.id, "result": "loss"}],
                },
            )
        )
        await asyncio.sleep(0.3)
        await lock_conn.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": CURRENCY_LOCK})
        await lock_conn.commit()
        report, _ = await task
        response = await manual
    # Кто первым взял блокировку участника, тот и рассчитал; второй ничего не записал
    saved = await _bet(db, bet.id)
    payouts = [row for row in await ledger_rows(db, member.id) if row.kind == "payout"]
    if report.counts["bets.settled"] == 1:
        assert saved.settled_by == "auto" and response.status_code == 409
        assert [row.amount for row in payouts] == [D("150.00")]
    else:
        assert response.status_code == 200 and saved.settled_by == "manual"
        assert saved.status == "lost" and payouts == []
    await _check_bank(db, member.id)


async def test_auto_waits_for_member_lock(
    member: Signed,
    maker: BetMaker,
    archive: Archive,
    db: AsyncSession,
    engine: AsyncEngine,
    factory: Factory,
) -> None:
    """Ручной расчет держит блокировку участника и рассчитывает ставку: авторасчет ждет,
    потом видит рассчитанную ставку и ничего не пишет."""
    bet = await maker.bet(member.user, [_spec(odds="1.50")], stake="100", placed_at=PLACED)
    [leg] = await _legs(db, bet.id)
    await archive.match(*await _pair(db, leg), winner=1)
    async with factory() as other:
        await other.execute(select(func.pg_advisory_xact_lock_shared(CURRENCY_LOCK)))
        await other.execute(select(func.pg_advisory_xact_lock(0x6265747300000000 + member.id)))
        task = asyncio.create_task(settle_from_archive(factory, warm=False))
        await asyncio.sleep(0.5)
        assert not task.done()
        await other.execute(
            update(Bet)
            .where(Bet.id == bet.id)
            .values(status="lost", profit=D("-100"), settled_at=PLACED, settled_by="manual")
        )
        await other.execute(update(BetLeg).where(BetLeg.bet_id == bet.id).values(result="win"))
        await other.commit()
    report, _ = await task
    assert report.counts["bets.settled"] == 0
    assert (await _bet(db, bet.id)).settled_by == "manual"
    assert not [row for row in await ledger_rows(db, member.id) if row.kind == "payout"]
    assert await db.scalar(select(func.count()).where(BankrollLedger.user_id == member.id)) == 2


async def test_bet_counts_are_own(
    member: Signed,
    maker: BetMaker,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Счетчик открытых ставок в меню — только свои ставки (Р14)."""
    other = await signed_in(make_client, make_user, login, email="ivan@example.com")
    await maker.bet(other.user, [_spec()], placed_at=PLACED)
    await maker.bet(other.user, [LegSpec(tournament=None, match_day=date(2099, 1, 1))])
    await maker.bet(member.user, [LegSpec(tournament=None, match_day=date(2099, 1, 1))])
    assert (await member.client.get("/api/bets/counts")).json() == {
        "open": 1,
        "awaiting_result": 0,
    }
    assert (await other.client.get("/api/bets/counts")).json() == {
        "open": 2,
        "awaiting_result": 1,
    }


# --- прошлая встреча пары и порядок блокировок ---

SATURDAY = date(2026, 10, 10)  # полуфинал
SATURDAY_BET = datetime(2026, 10, 10, 9, 0, tzinfo=UTC)


async def _other_pair_until(db: AsyncSession, archive: Archive, day: date) -> None:
    """Матч другой пары: архив дошел до day."""
    others = [Player(name=f"Other One {day}"), Player(name=f"Other Two {day}")]
    db.add_all(others)
    await db.flush()
    await archive.match(others[0].id, others[1].id, day=day)


async def test_previous_meeting_is_not_linked(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Пара сыграла в группе в четверг (выиграл игрок 1), участник в субботу ставит на
    игрока 2 в полуфинале. Архив дошел до пятницы: четверговая встреча — не кандидат,
    матч ждет файла. Пришла суббота — привязка и расчет по ней."""
    bet = await maker.bet(
        member.user,
        [LegSpec(tournament=None, match_day=SATURDAY, selection=2, odds="2.40")],
        stake="1000",
        placed_at=SATURDAY_BET,
    )
    [leg] = await _legs(db, bet.id)
    p1, p2 = await _pair(db, leg)
    group = await archive.match(p1, p2, day=SATURDAY - timedelta(days=2), winner=1)
    await _other_pair_until(db, archive, SATURDAY - timedelta(days=1))

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["matches.linked"] == 0 and report.counts["matches.waiting"] == 1
    [leg] = await _legs(db, bet.id)
    assert leg.match_id != group.id
    assert (await _bet(db, bet.id)).status == "open"

    semifinal = await archive.match(p2, p1, day=SATURDAY, winner=1)
    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["matches.linked"] == 1 and report.counts["bets.settled"] == 1
    [leg] = await _legs(db, bet.id)
    assert leg.match_id == semifinal.id
    saved = await _bet(db, bet.id)
    assert (saved.status, saved.profit) == ("won", D("1400.00"))


async def test_day_before_candidate_waits_until_window_is_covered(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Единственный кандидат накануне дня ставки (в пределах суток допуска) сливается,
    только когда архив покрыл все окно ±3 дня: до того настоящий матч может прийти
    следующим файлом."""
    bet = await maker.bet(
        member.user,
        [LegSpec(tournament=None, match_day=SATURDAY, odds="1.80")],
        placed_at=SATURDAY_BET,
    )
    [leg] = await _legs(db, bet.id)
    friday = await archive.match(*await _pair(db, leg), day=SATURDAY - timedelta(days=1))
    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["matches.linked"] == 0 and report.counts["matches.waiting"] == 1

    await _other_pair_until(db, archive, SATURDAY + timedelta(days=3))
    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["matches.linked"] == 1
    [leg] = await _legs(db, bet.id)
    assert leg.match_id == friday.id


async def test_leg_on_previous_meeting_is_not_settled(
    member: Signed, maker: BetMaker, archive: Archive, db: AsyncSession, factory: Factory
) -> None:
    """Анализ в субботу поставил ногу на четверговую встречу пары из архива (find_match,
    ±3 дня). Авторасчет ее не считает и не берет закрытие: участнику — «внесите исход» с
    причиной, в отчете — bets.early."""
    bet = await maker.bet(
        member.user,
        [LegSpec(tournament=None, match_day=SATURDAY, selection=2, odds="2.40")],
        stake="1000",
        placed_at=SATURDAY_BET,
    )
    [leg] = await _legs(db, bet.id)
    p1, p2 = await _pair(db, leg)
    group = await archive.match(
        p1, p2, day=SATURDAY - timedelta(days=2), winner=1, odds={"pinnacle": ("1.50", "2.60")}
    )
    leg.match_id = group.id
    await db.commit()

    report, _ = await settle_from_archive(factory, warm=False)
    assert report.counts["bets.settled"] == 0 and report.counts["closing.legs"] == 0
    assert report.counts["bets.manual"] == 1 and report.counts["bets.early"] == 1
    assert any("матч раньше ставки: 1" in line for line in summary_lines(report))
    saved = await _bet(db, bet.id)
    assert saved.status == "open" and saved.result_reminded_at is not None
    [leg] = await _legs(db, bet.id)
    assert leg.result is None and leg.closing_odds is None
    assert [row.kind for row in await ledger_rows(db, member.id)].count("payout") == 0
    [note] = await _notes(db, member.id, "bet_needs_result")
    assert note.params["variant"] == "manual" and "прошлая встреча" in note.body
    # Повтор: второго напоминания нет
    await settle_from_archive(factory, warm=False)
    assert len(await _notes(db, member.id, "bet_needs_result")) == 1


async def test_link_and_manual_settle_take_locks_in_one_order(
    member: Signed,
    maker: BetMaker,
    archive: Archive,
    db: AsyncSession,
    factory: Factory,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Экспресс из двух ног: первый матч в архиве в том же порядке, второй перевернут.
    Привязка останавливается после первого слияния, в этот момент приходит ручной расчет.
    Обе стороны берут блокировку денег участника до ног и ставки — взаимной блокировки
    нет, оба заканчиваются без ошибки."""
    bet = await maker.bet(member.user, [_spec(odds="1.50"), _spec(odds="1.60")], placed_at=PLACED)
    first, second = await _legs(db, bet.id)
    a1, b1 = await _pair(db, first)
    a2, b2 = await _pair(db, second)
    await archive.match(a1, b1)
    await archive.match(b2, a2)
    card = await get_bet(member.client, bet.id)

    first_done = asyncio.Event()
    go_on = asyncio.Event()
    original = players.merge_matches
    calls = 0

    async def paused(db: AsyncSession, **kw: Any) -> Any:
        nonlocal calls
        report = await original(db, **kw)
        calls += 1
        if calls == 1:
            first_done.set()
            await go_on.wait()
        return report

    monkeypatch.setattr(match_link, "merge_matches", paused)

    async def link() -> str:
        async with factory() as session:
            result = await match_link.link_user_matches(session)
            return f"linked {result.linked}"

    async def manual() -> int:
        await first_done.wait()
        task = asyncio.create_task(
            member.client.put(f"/api/bets/{bet.id}/result", json=settle_body(card, "win", "win"))
        )
        await asyncio.sleep(0.5)  # расчет ждет блокировку денег участника
        go_on.set()
        return (await task).status_code

    linked, status = await asyncio.wait_for(asyncio.gather(link(), manual()), timeout=30)
    assert linked == "linked 2"
    assert status in (200, 409)
    await _check_bank(db, member.id)
