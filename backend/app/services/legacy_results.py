"""Исходы ног экспрессов старого бота из архива (этап 5, LLM_LEARNING.md, раздел 5).

Бот записывал итог ставки, а не событий: у проигранного экспресса неизвестно, какое
событие проиграло, и импорт оставляет исход таких ног пустым (app/ingest/legacy.py,
_leg_result). Когда матч ноги привязан к архиву (players_link) и у матча есть исход, нога
получает исход и счет по архиву (result_source = auto) — для калибровки и уроков. Деньги
ставки, ее итог и журнал банка не меняются: ставка рассчитана импортом. Снятие, неявка и
неполный счет у форы остаются без исхода. Сколько ног еще без исхода — legacy_no_result в
«Данных» кабинета (app/services/data_export.py), сколько заполнено отсюда —
legacy_from_archive.
"""

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg, Match
from app.services.auto_settlement import (
    ARCHIVE_SOURCES,
    SETTLED_AUTO,
    archive_matches,
    leg_verdict,
)
from app.services.bet_versions import touch
from app.services.bets import PLAYED_STATUSES
from app.services.sessions import utcnow


async def fill_legacy_legs(db: AsyncSession, *, now: datetime | None = None) -> int:
    """Исходы ног рассчитанных ставок бота без исхода — из архива (правила — в docstring
    модуля). Возвращает число заполненных ног. Делает commit."""
    moment = now or utcnow()
    legs = list(
        await db.scalars(
            select(BetLeg)
            .join(Bet, Bet.id == BetLeg.bet_id)
            .join(Match, Match.id == BetLeg.match_id)
            .where(
                Bet.source == "legacy",
                Bet.status != "open",
                BetLeg.result.is_(None),
                Match.source.in_(ARCHIVE_SOURCES),
                Match.status.in_(PLAYED_STATUSES),
            )
            .order_by(BetLeg.id)
            .with_for_update(of=BetLeg)
            .execution_options(populate_existing=True)
        )
    )
    matches = await archive_matches(db, sorted({leg.match_id for leg in legs}))
    filled = 0
    touched: set[int] = set()
    for leg in legs:
        settlement = leg_verdict(leg, matches.get(leg.match_id)).settlement
        if settlement is None:
            continue
        leg.result = settlement.result
        leg.score = settlement.score
        leg.result_source = SETTLED_AUTO
        leg.settled_at = moment
        touched.add(leg.bet_id)
        filled += 1
    if touched:
        for bet in await db.scalars(select(Bet).where(Bet.id.in_(sorted(touched)))):
            touch(bet)
    await db.commit()
    return filled
