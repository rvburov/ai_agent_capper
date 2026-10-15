"""Авторасчет ставок по исходам архива tennis-data (этап 5, В1 и Т3, Р25).

Ставка приложения рассчитывается сама, когда все ее ноги — на матчах архива (после
привязки, app/ingest/match_link.py) и у каждого матча есть исход: победитель и счет.
Исход ноги — app/ml/sets.py, match_leg_outcome: у П1/П2 хватает победителя, у фор нужен
полный счет. Запись расчета — та же функция, что у ручного (settlement.apply_settlement):
settled_by = auto, у ног result_source = auto, ставка помнит запуск расчета
(settle_run_id). Участнику — уведомление bet_settled со ссылкой /bets?bet=<id>.

Правила (Т3):
- рассчитываются только открытые ставки приложения; ставку, которую участник исправлял
  (reversed_at), авторасчет больше не трогает — ручной расчет главнее;
- снятие и неявка (retired, walkover) и неполный счет у форы сами не рассчитываются:
  правила букмекеров разные (В16). Участнику один раз — bet_needs_result с причиной;
- нога на матче архива, сыгранном раньше ставки больше чем на сутки (match_link,
  played_before), — это прошлая встреча той же пары (нога попала на нее при анализе):
  ставка сама не рассчитывается, участнику — bet_needs_result с причиной early, в отчете
  — bets.early; сверка с архивом такую ногу пропускает;
- рассчитанная ставка не пересчитывается. Если архив показывает другой исход ноги
  (ставки за SETTLED_CHECK_DAYS дней), у ноги запоминается исход и счет архива
  (archive_result, archive_score) и уходит уведомление settle_conflict; деньги не
  меняются. Архив снова совпал или ставка снова открыта — отметка стирается;
- напоминание «ставка ждет результата» (remind_unsettled): все матчи ставки прошли
  REMINDER_DAYS дней назад (по поясу участника), а исхода нет — одно на ставку.

Гонки: все — под lock_member_money (разделяемая блокировка смены валюты и блокировка
участника) и FOR UPDATE ставок и ног, статус ставки проверяется после блокировки. Ручной
расчет, пришедший после авторасчета, получает 409 (версия ставки сменилась). commit — по
участнику: блокировка денег держится недолго. Кэш аналитики сбрасывается сам: расчет
меняет версию данных (app/services/analytics_cache.py); прогрев ставит вызывающий.
"""

from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import Select, and_, exists, not_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import set_committed_value

from app.core.errors import AppError
from app.core.formatting import format_money
from app.core.i18n import t
from app.db.models import Bet, BetLeg, Match, Tournament, User
from app.ingest.match_link import archive_day, played_before
from app.ml.sets import (
    BEST_OF,
    OUTCOME_INCOMPLETE,
    OUTCOME_NO_RESULT,
    complete_for,
    infer_best_of,
    match_leg_outcome,
    set_count_from_score,
)
from app.services.bank import bank_state, local_today, lock_member_money, user_zone
from app.services.bets import leg_contexts, score_to_own
from app.services.notifications import notify
from app.services.sessions import utcnow
from app.services.settlement import LegSettlement, apply_settlement

ARCHIVE_SOURCES = ("sackmann", "tennis_data")
SETTLED_AUTO = "auto"
# Исход есть: сыгран, снятие, неявка
PLAYED_STATUSES = ("finished", "retired", "walkover")
# Через сколько дней после матча без исхода — напоминание «внесите результат» (В1)
REMINDER_DAYS = 3
# Ставки, рассчитанные за столько дней, сверяются с архивом (расхождение, Т3)
SETTLED_CHECK_DAYS = 90
# Причина «матч в архиве раньше ставки» (текст — settle.manual_reason.early)
REASON_EARLY = "early"


def bet_link(bet_id: int) -> str:
    return f"/bets?bet={bet_id}"


@dataclass(frozen=True)
class ArchiveMatch:
    """Исход матча архива для расчета ноги."""

    status: str
    winner_is_p1: bool | None
    score: str | None
    best_of: int | None
    day: date | None = None


@dataclass(frozen=True)
class LegVerdict:
    """Исход ноги по архиву: settlement — исход и счет со стороны выбранного игрока;
    None — сам не рассчитывается, reason — почему (walkover, retired, incomplete,
    no_result)."""

    settlement: LegSettlement | None
    reason: str | None = None


@dataclass
class SettleResult:
    """Итог прохода: рассчитано ставок и ног, у кого (участники — только числом в отчете,
    Р14), расхождений, ставок со снятием или неявкой (manual; из них early — нога на
    прошлой встрече пары), переполнений выплаты."""

    settled: int = 0
    legs: int = 0
    users: set[int] = field(default_factory=set)
    conflicts: int = 0
    manual: int = 0
    early: int = 0
    overflow: int = 0
    reminded: int = 0


async def archive_matches(db: AsyncSession, match_ids: Sequence[int]) -> dict[int, ArchiveMatch]:
    """Матчи архива с исходом (сыгран, снятие, неявка) по id."""
    if not match_ids:
        return {}
    rows = await db.execute(
        select(
            Match.id,
            Match.status,
            Match.winner_id,
            Match.player1_id,
            Match.score,
            Match.best_of,
            Tournament.best_of,
            archive_day(),
        )
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(
            Match.id.in_(list(match_ids)),
            Match.source.in_(ARCHIVE_SOURCES),
            Match.status.in_(PLAYED_STATUSES),
        )
    )
    found: dict[int, ArchiveMatch] = {}
    for match_id, status, winner_id, player1_id, score, best_of, tour_best_of, day in rows:
        found[int(match_id)] = ArchiveMatch(
            status=status,
            winner_is_p1=None if winner_id is None else winner_id == player1_id,
            score=score,
            best_of=best_of if best_of in BEST_OF else tour_best_of,
            day=day if isinstance(day, date) else None,
        )
    return found


def leg_verdict(
    leg: BetLeg, match: ArchiveMatch | None, placed_at: datetime | None = None
) -> LegVerdict:
    """Исход ноги по матчу архива и счет со стороны выбранного игрока («2:1» — его 2
    сета); счета нет, если он неполный (у П1/П2 исход тогда — по победителю). Матч
    сыгран раньше ставки (placed_at) — прошлая встреча пары: исхода нет, причина early."""
    if match is None:
        return LegVerdict(None, OUTCOME_NO_RESULT)
    if played_before(match.day, placed_at):
        return LegVerdict(None, REASON_EARLY)
    outcome = match_leg_outcome(
        leg.market,
        leg.selection,
        status=match.status,
        winner_is_p1=match.winner_is_p1,
        score=match.score,
        best_of=match.best_of,
    )
    if outcome.result is None:
        return LegVerdict(None, outcome.reason)
    score: str | None = None
    if match.winner_is_p1 is not None:
        count = set_count_from_score(match.score, winner_is_first=match.winner_is_p1)
        fmt = match.best_of if match.best_of in BEST_OF else infer_best_of(count)
        if fmt is not None and complete_for(count, fmt):
            score = score_to_own(count, leg.selection)
    return LegVerdict(LegSettlement(outcome.result, score))


def _open_on_archive() -> Select[int, int]:
    """Открытые ставки приложения, у которых все ноги — на матчах архива с исходом и
    участник их не исправлял."""
    not_ready = (
        select(BetLeg.id)
        .join(Match, Match.id == BetLeg.match_id)
        .where(
            BetLeg.bet_id == Bet.id,
            ~and_(Match.source.in_(ARCHIVE_SOURCES), Match.status.in_(PLAYED_STATUSES)),
        )
    )
    return (
        select(Bet.user_id, Bet.id)
        .where(
            Bet.status == "open",
            Bet.source == "app",
            Bet.reversed_at.is_(None),
            exists().where(BetLeg.bet_id == Bet.id),
            not_(exists(not_ready)),
        )
        .order_by(Bet.user_id, Bet.id)
    )


async def mark_reminded(db: AsyncSession, bet: Bet, moment: datetime) -> None:
    """Отметить напоминание, не меняя версию ставки (updated_at): окно расчета, открытое
    участником, остается действительным."""
    await db.execute(
        update(Bet)
        .where(Bet.id == bet.id)
        .values(result_reminded_at=moment, updated_at=Bet.updated_at)
        .execution_options(synchronize_session=False)
    )
    set_committed_value(bet, "result_reminded_at", moment)


def _result_text(status: str) -> str:
    return t(f"settle.result.{status}")


def _outcome_text(bet: Bet) -> str:
    """Исход для уведомления: «выигрыш, прибыль +840 ₽», «проигрыш, убыток 700 ₽»,
    «возврат: сумма вернулась в банк»."""
    profit = bet.profit or Decimal(0)
    if bet.status == "won":
        return t("settle.outcome.won", profit=format_money(profit, bet.currency, signed=True))
    if bet.status == "lost":
        return t("settle.outcome.lost", loss=format_money(-profit, bet.currency))
    return t("settle.outcome.void")


async def _locked(
    db: AsyncSession, user_id: int, bet_ids: Sequence[int]
) -> tuple[dict[int, Bet], dict[int, list[BetLeg]]]:
    """Ставки участника и их ноги под блокировкой денег и FOR UPDATE."""
    await lock_member_money(db, user_id)
    bets = {
        bet.id: bet
        for bet in await db.scalars(
            select(Bet)
            .where(Bet.id.in_(list(bet_ids)), Bet.user_id == user_id)
            .order_by(Bet.id)
            .with_for_update()
            .execution_options(populate_existing=True)
        )
    }
    legs: dict[int, list[BetLeg]] = defaultdict(list)
    for leg in await db.scalars(
        select(BetLeg)
        .where(BetLeg.bet_id.in_(list(bets)))
        .order_by(BetLeg.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    ):
        legs[leg.bet_id].append(leg)
    return bets, legs


async def settle_open_bets(
    db: AsyncSession, *, run_id: int | None, now: datetime | None = None
) -> SettleResult:
    """Рассчитать открытые ставки по архиву (правила — в docstring модуля). commit — по
    участнику."""
    moment = now or utcnow()
    result = SettleResult()
    rows = (await db.execute(_open_on_archive())).all()
    by_user: dict[int, list[int]] = defaultdict(list)
    for user_id, bet_id in rows:
        by_user[int(user_id)].append(int(bet_id))
    for user_id, bet_ids in by_user.items():
        bets, legs = await _locked(db, user_id, bet_ids)
        matches = await archive_matches(
            db, sorted({leg.match_id for items in legs.values() for leg in items})
        )
        settled: list[Bet] = []
        for bet in bets.values():
            items = legs.get(bet.id, [])
            if bet.status != "open" or bet.reversed_at is not None or not items:
                continue
            verdicts = {
                leg.id: leg_verdict(leg, matches.get(leg.match_id), bet.placed_at) for leg in items
            }
            if any(verdict.settlement is None for verdict in verdicts.values()):
                reasons = [v.reason for v in verdicts.values() if v.settlement is None]
                if OUTCOME_NO_RESULT in reasons:
                    continue
                result.manual += 1
                result.early += int(REASON_EARLY in reasons)
                await _ask_manual(db, bet, reasons, moment, result)
                continue
            outcome = {
                leg_id: verdict.settlement
                for leg_id, verdict in verdicts.items()
                if verdict.settlement is not None
            }
            try:
                apply_settlement(
                    db,
                    bet,
                    items,
                    outcome,
                    settled_by=SETTLED_AUTO,
                    now=moment,
                    settle_run_id=run_id,
                )
            except AppError:
                result.overflow += 1
                continue
            settled.append(bet)
            result.legs += len(items)
        if settled:
            await db.flush()
            bank = await bank_state(db, user_id, now=moment)
            for bet in settled:
                await notify(
                    db,
                    user_id=user_id,
                    kind="bet_settled",
                    variant="auto",
                    link=bet_link(bet.id),
                    bet=bet.id,
                    status=bet.status,
                    result=_result_text(bet.status),
                    outcome=_outcome_text(bet),
                    profit=bet.profit,
                    bank=format_money(bank.equity, bank.currency),
                    currency=bet.currency,
                )
            result.settled += len(settled)
            result.users.add(user_id)
        await db.commit()
    return result


async def _ask_manual(
    db: AsyncSession, bet: Bet, reasons: Sequence[str | None], now: datetime, result: SettleResult
) -> None:
    """Снятие, неявка или неполный счет у форы: исход вносит участник (В16). Напоминание
    — одно на ставку."""
    if bet.result_reminded_at is not None:
        return
    if REASON_EARLY in reasons:
        reason = REASON_EARLY
    else:
        reason = next(
            (r for r in reasons if r is not None and r != OUTCOME_INCOMPLETE), OUTCOME_INCOMPLETE
        )
    await notify(
        db,
        user_id=bet.user_id,
        kind="bet_needs_result",
        variant="manual",
        link=bet_link(bet.id),
        bet=bet.id,
        reason=t(f"settle.manual_reason.{reason}"),
    )
    await mark_reminded(db, bet, now)
    result.reminded += 1


def _settled_on_archive(since: datetime) -> Select[int, int]:
    """Рассчитанные участником или авторасчетом ставки приложения за SETTLED_CHECK_DAYS
    дней с ногами на матчах архива с исходом."""
    return (
        select(Bet.user_id, Bet.id)
        .where(
            Bet.status != "open",
            Bet.source == "app",
            Bet.settled_by.in_(("manual", SETTLED_AUTO)),
            Bet.settled_at >= since,
            exists(
                select(BetLeg.id)
                .join(Match, Match.id == BetLeg.match_id)
                .where(
                    BetLeg.bet_id == Bet.id,
                    Match.source.in_(ARCHIVE_SOURCES),
                    Match.status.in_(PLAYED_STATUSES),
                )
            ),
        )
        .order_by(Bet.user_id, Bet.id)
    )


async def check_settled_bets(db: AsyncSession, *, now: datetime | None = None) -> SettleResult:
    """Сверка рассчитанных ставок с архивом: расхождение — отметка у ноги и уведомление
    settle_conflict, деньги не меняются (Т3). commit — по участнику."""
    moment = now or utcnow()
    result = SettleResult()
    query = _settled_on_archive(moment - timedelta(days=SETTLED_CHECK_DAYS))
    rows = (await db.execute(query)).all()
    by_user: dict[int, list[int]] = defaultdict(list)
    for user_id, bet_id in rows:
        by_user[int(user_id)].append(int(bet_id))
    for user_id, bet_ids in by_user.items():
        bets, legs = await _locked(db, user_id, bet_ids)
        matches = await archive_matches(
            db, sorted({leg.match_id for items in legs.values() for leg in items})
        )
        for bet in bets.values():
            if bet.status == "open":
                continue
            differs: list[BetLeg] = []
            for leg in legs.get(bet.id, []):
                verdict = leg_verdict(leg, matches.get(leg.match_id), bet.placed_at)
                found = verdict.settlement
                if found is None or found.result == leg.result:
                    leg.archive_result = None
                    leg.archive_score = None
                    continue
                if leg.archive_result != found.result:
                    differs.append(leg)
                leg.archive_result = found.result
                leg.archive_score = found.score
            if differs:
                result.conflicts += 1
                result.users.add(user_id)
                await notify(
                    db,
                    user_id=user_id,
                    kind="settle_conflict",
                    link=bet_link(bet.id),
                    bet=bet.id,
                    archive=_leg_result_text(differs[0].archive_result),
                    yours=_leg_result_text(differs[0].result),
                )
        await db.commit()
    return result


def _leg_result_text(result: str | None) -> str:
    return t(f"settle.leg_result.{result or 'none'}")


async def remind_unsettled(
    db: AsyncSession, *, now: datetime | None = None, days: int = REMINDER_DAYS
) -> int:
    """Напоминание bet_needs_result: открытая ставка приложения, все матчи которой прошли
    days дней назад и раньше (по поясу участника), а исхода нет. Одно на ставку
    (result_reminded_at). Возвращает, сколько ушло. Делает commit."""
    moment = now or utcnow()
    candidates = (
        await db.execute(
            select(Bet.user_id, Bet.id)
            .where(
                Bet.status == "open",
                Bet.source == "app",
                Bet.result_reminded_at.is_(None),
                # Матч не раньше дня ставки: раньше days дней назад ставки быть не может
                Bet.placed_at <= moment - timedelta(days=days),
            )
            .order_by(Bet.user_id, Bet.id)
        )
    ).all()
    by_user: dict[int, list[int]] = defaultdict(list)
    for user_id, bet_id in candidates:
        by_user[int(user_id)].append(int(bet_id))
    sent = 0
    for user_id, bet_ids in by_user.items():
        user = await db.get(User, user_id)
        if user is None or user.status != "active":
            continue
        today = local_today(user_zone(user.tz), moment)
        bets = list(
            await db.scalars(
                select(Bet)
                .where(Bet.id.in_(bet_ids), Bet.user_id == user_id)
                .order_by(Bet.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        contexts = await leg_contexts(db, user, bets)
        for bet in bets:
            days_of = [context.day for context in contexts.get(bet.id, [])]
            if bet.status != "open" or bet.result_reminded_at is not None or not days_of:
                continue
            if any(day is None or day + timedelta(days=days) > today for day in days_of):
                continue
            await notify(
                db,
                user_id=user_id,
                kind="bet_needs_result",
                link=bet_link(bet.id),
                bet=bet.id,
                days=days,
            )
            await mark_reminded(db, bet, moment)
            sent += 1
        await db.commit()
    return sent
