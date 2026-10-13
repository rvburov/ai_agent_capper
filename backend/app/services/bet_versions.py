"""Версия ставки (bets.updated_at): защита расчета, сторно и закрытия от гонки.

Карточка отдает updated_at, расчет и сторно присылают его обратно (expected_updated_at).
Браузер хранит время в Date с точностью до миллисекунды: new Date(s).toISOString()
теряет микросекунды. Поэтому версии сравниваются с допуском меньше 1 мс, а новая версия
всегда хотя бы на 2 мс позже прежней: время, усеченное или округленное до миллисекунды,
совпадает со своей версией и никогда — с соседней.

Версию меняет все, после чего карточку нужно открыть заново: расчет, сторно, закрытие и
переворот стороны матча (загрузчики архива и слияние матчей): «первым — игрок 1» в счете
из окна расчета относится уже к другому игроку.
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg

VERSION_TOLERANCE = timedelta(milliseconds=1)
VERSION_STEP = timedelta(milliseconds=2)


def same_version(current: datetime, expected: datetime) -> bool:
    """Версия, которую прислал участник, — эта (с точностью браузера, до 1 мс)."""
    return abs(current - expected) < VERSION_TOLERANCE


def next_version() -> Any:
    """Новая версия в SQL: фактическое время (а не начало транзакции), но не ближе 2 мс
    к прежней."""
    return func.greatest(func.clock_timestamp(), Bet.updated_at + VERSION_STEP)


def touch(bet: Bet) -> None:
    """Новая версия ставки (пишется при flush)."""
    bet.updated_at = next_version()


async def touch_bets_on_matches(db: AsyncSession, match_ids: Sequence[int]) -> None:
    """Новая версия у ставок с ногами на этих матчах (сторона матча перевернута)."""
    if not match_ids:
        return
    await db.execute(
        update(Bet)
        .where(Bet.id.in_(select(BetLeg.bet_id).where(BetLeg.match_id.in_(list(match_ids)))))
        .values(updated_at=next_version())
        .execution_options(synchronize_session=False)
    )
