"""Привязка матчей из ввода участника к матчам архива (этап 5, решение Т2).

Анализ создает матч source = user, если в базе еще нет матча этой пары игроков (app/
services/analysis_input.py, find_match): у матча нет турнира архива, и загрузчик tennis-data
сольет его со своим, только если совпали турнир, круг и пара. Здесь каждый такой матч, на
который есть ставка или прогноз, ищется среди матчей архивов (sackmann, tennis_data — в
них только основной тур ATP):
- та же пара игроков в любом порядке;
- день матча архива (match_date, иначе время начала, иначе начало турнира) — не дальше
  WINDOW_DAYS от дня матча из ввода (его дата, если известна, иначе день, когда его
  ввели), та же мера, что find_match.

Прошлая встреча той же пары не кандидат. Пара часто играет дважды за 2–3 дня (группа и
полуфинал Итогового турнира, финал одного турнира и первый круг следующего), поэтому
матч архива, сыгранный раньше первой ставки или прогноза на матч из ввода больше чем на
сутки (played_before; сутки — запас на пояс участника и ставку, внесенную наутро),
отбрасывается. Единственный кандидат сливается, только если он не раньше дня ставки или
архив уже покрыл все окно: иначе настоящий матч может еще не дойти до архива, и матч ждет.

Ровно один кандидат — матч из ввода сливается в матч архива (players.merge_matches): ноги
ставок, прогнозы, досье и кэфы переходят к нему, сторона исхода переворачивается, если
игроки стоят в другом порядке. Несколько кандидатов, конфликт слияния — матч остается,
в отчете причина, ничего не угадывается; разобрать — командой matches-merge. Кандидата
нет, а архив уже дошел до конца окна — «нет в архиве» (челленджер, другая пара, опечатка
в имени): в отчете только числом — по игрокам и дню видно, на что ставили участники, а
администратор видит только расход на ИИ и активность (Р14). Архив еще не дошел — матч
ждет следующего файла.

Блокировки — в том же порядке, что у расчета ставок: сначала деньги владельцев ставок
на матче из ввода (lock_member_money, по возрастанию id), потом ноги и ставки. commit —
после каждого матча: блокировки держатся недолго.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from typing import Any

from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg, Match, Player, Prediction, Tournament
from app.services.analysis_input import MATCH_WINDOW_DAYS
from app.services.bank import lock_member_money
from app.services.players import PlayerError, merge_matches

ARCHIVE_SOURCES = ("sackmann", "tennis_data")
USER_SOURCE = "user"
WINDOW_DAYS = MATCH_WINDOW_DAYS
# Сколько непривязанных матчей хранить в отчете с именами (остальные — числом)
REPORT_LIMIT = 50
# Матч архива раньше дня ставки больше чем на столько дней — прошлая встреча пары
EARLY_DAYS = 1

# Почему матч не привязан и нужен разбор руками (тексты — settle.unlinked.<причина>)
REASON_AMBIGUOUS = "ambiguous"
REASON_CONFLICT = "conflict"


@dataclass
class LinkResult:
    """Итог привязки: привязано, ждут файла, перевернутых; не привязано — всего, из них
    «нет в архиве» (not_found, только числом) и строки с причиной для разбора руками
    (ambiguous, conflict)."""

    linked: int = 0
    waiting: int = 0
    flipped: int = 0
    unlinked: list[dict[str, Any]] = field(default_factory=list)
    unlinked_total: int = 0
    not_found: int = 0

    def add_unlinked(self, row: dict[str, Any]) -> None:
        self.unlinked_total += 1
        if len(self.unlinked) < REPORT_LIMIT:
            self.unlinked.append(row)


def archive_day() -> Any:
    """День матча архива: дата из файла, иначе время начала, иначе начало турнира (нужно
    внешнее соединение с tournaments)."""
    return func.coalesce(Match.match_date, func.date(Match.scheduled_at), Tournament.start_date)


def played_before(match_day: date | None, moment: datetime | None) -> bool:
    """Матч архива сыгран раньше ставки или прогноза (moment) больше чем на EARLY_DAYS
    дней: это прошлая встреча той же пары, по ней ставку не считают."""
    if match_day is None or moment is None:
        return False
    return match_day < moment.astimezone(UTC).date() - timedelta(days=EARLY_DAYS)


async def archive_days(db: AsyncSession, match_ids: Sequence[int]) -> dict[int, date]:
    """День матча архива по id (archive_day)."""
    if not match_ids:
        return {}
    rows = await db.execute(
        select(Match.id, archive_day())
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.id.in_(list(match_ids)))
    )
    return {int(match_id): day for match_id, day in rows if isinstance(day, date)}


async def archive_last_day(db: AsyncSession) -> date | None:
    """Последний день матча в архивах: до него архив полон."""
    value = await db.scalar(
        select(func.max(Match.match_date)).where(Match.source.in_(ARCHIVE_SOURCES))
    )
    return value if isinstance(value, date) else None


@dataclass(frozen=True)
class _UserMatch:
    """Матч из ввода: игроки, день (дата матча, иначе день ввода) и первая ставка или
    прогноз на него (first_use)."""

    id: int
    player1: int
    player2: int
    day: date
    first_use: datetime | None


async def _user_matches(db: AsyncSession) -> list[_UserMatch]:
    """Матчи из ввода, на которые есть ставка или прогноз."""
    used = or_(
        exists().where(BetLeg.match_id == Match.id),
        exists().where(Prediction.match_id == Match.id),
    )
    first_bet = (
        select(func.min(Bet.placed_at))
        .join(BetLeg, BetLeg.bet_id == Bet.id)
        .where(BetLeg.match_id == Match.id)
        .scalar_subquery()
    )
    first_prediction = (
        select(func.min(Prediction.as_of)).where(Prediction.match_id == Match.id).scalar_subquery()
    )
    rows = await db.execute(
        select(
            Match.id,
            Match.player1_id,
            Match.player2_id,
            func.coalesce(Match.match_date, func.date(Match.created_at)),
            # least() пропускает NULL: нет ставок — день прогноза, и наоборот
            func.least(first_bet, first_prediction),
        )
        .where(Match.source == USER_SOURCE, used)
        .order_by(Match.id)
    )
    return [_UserMatch(int(a), int(b), int(c), d, first) for a, b, c, d, first in rows]


async def _candidates(db: AsyncSession, match: _UserMatch) -> list[tuple[int, date]]:
    """Матчи архива той же пары в окне дня матча, кроме прошлых встреч: id и день."""
    when = archive_day()
    day = match.day
    low, high = day - timedelta(days=WINDOW_DAYS), day + timedelta(days=WINDOW_DAYS)
    same_pair = or_(
        and_(Match.player1_id == match.player1, Match.player2_id == match.player2),
        and_(Match.player1_id == match.player2, Match.player2_id == match.player1),
    )
    rows = await db.execute(
        select(Match.id, when)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .where(Match.source.in_(ARCHIVE_SOURCES), same_pair, when >= low, when <= high)
        .order_by(Match.id)
    )
    return [
        (int(match_id), found)
        for match_id, found in rows
        if not played_before(found, match.first_use)
    ]


async def _lock_owners(db: AsyncSession, match_id: int) -> None:
    """Блокировки денег владельцев ставок на матче (по возрастанию id) — до блокировки
    ног: тот же порядок, что у ручного расчета и авторасчета (иначе взаимная блокировка)."""
    owners = await db.scalars(
        select(Bet.user_id)
        .join(BetLeg, BetLeg.bet_id == Bet.id)
        .where(BetLeg.match_id == match_id)
        .distinct()
        .order_by(Bet.user_id)
    )
    for user_id in owners.all():
        await lock_member_money(db, int(user_id))


async def _names(db: AsyncSession, ids: Sequence[int]) -> dict[int, str]:
    rows = await db.execute(
        select(Player.id, Player.name, Player.name_ru).where(Player.id.in_(ids))
    )
    return {int(pid): (name_ru or name) for pid, name, name_ru in rows}


async def link_user_matches(db: AsyncSession) -> LinkResult:
    """Привязать матчи из ввода к архиву (правила — в docstring модуля). Делает commit
    после каждого матча."""
    result = LinkResult()
    last = await archive_last_day(db)
    for match in await _user_matches(db):
        covered = last is not None and match.day + timedelta(days=WINDOW_DAYS) <= last
        found = await _candidates(db, match)
        if len(found) == 1:
            target, target_day = found[0]
            early = match.first_use is not None and target_day < match.first_use.date()
            if early and not covered:
                # Кандидат раньше дня ставки, а архив окно еще не покрыл: настоящий матч
                # может прийти следующим файлом
                result.waiting += 1
                continue
            await _lock_owners(db, match.id)
            try:
                report = await merge_matches(
                    db, source_match_id=match.id, target_match_id=target, commit=False
                )
            except PlayerError:
                await db.commit()
                await _unlinked(db, result, match, REASON_CONFLICT)
                continue
            await db.commit()
            result.linked += 1
            result.flipped += int(report.flipped)
            continue
        if len(found) > 1:
            ids = [match_id for match_id, _ in found]
            await _unlinked(db, result, match, REASON_AMBIGUOUS, candidates=ids)
            continue
        if covered:
            result.unlinked_total += 1
            result.not_found += 1
        else:
            result.waiting += 1
    await db.commit()
    return result


async def _unlinked(
    db: AsyncSession,
    result: LinkResult,
    match: _UserMatch,
    reason: str,
    *,
    candidates: Sequence[int] = (),
) -> None:
    if len(result.unlinked) >= REPORT_LIMIT:
        result.unlinked_total += 1
        return
    names = await _names(db, (match.player1, match.player2))
    row: dict[str, Any] = {
        "match_id": match.id,
        "player1": names.get(match.player1, ""),
        "player2": names.get(match.player2, ""),
        "day": match.day.isoformat(),
        "reason": reason,
    }
    if candidates:
        row["candidates"] = list(candidates)
    result.add_unlinked(row)
