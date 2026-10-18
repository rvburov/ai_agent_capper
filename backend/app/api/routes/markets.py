"""Рынки ставок (Р28): GET /api/markets — статус семейств рынков и общий счетчик «для
сравнения» (события, ROI и CLV с 95% ДИ). Данные общие для всех участников (не личные),
поэтому маршрут доступен любому вошедшему и параметра as_user не принимает. Перевод
семейства в экспресс — PUT /api/admin/markets/{family} (app/api/routes/admin_settings.py)."""

from fastapi import APIRouter

from app.core.deps import CurrentUser, DbSession, RedisClient
from app.schemas.markets import MarketsOut
from app.services import market_stats

router = APIRouter(prefix="/markets", tags=["markets"])


@router.get("")
async def get_markets(user: CurrentUser, db: DbSession, redis: RedisClient) -> MarketsOut:
    """Семейства рынков: ml, h15 (фора ±1.5), shcp (фора ±2.5), stot, ghcp, gtot — статус,
    события, ROI и CLV с интервалами, сколько событий с закрытием, пройден ли порог. Числа
    семейств — из кэша Redis до 10 минут (app/services/market_stats.py)."""
    return await market_stats.market_stats(db, redis)
