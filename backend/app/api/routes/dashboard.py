"""Главная участника одним ответом. Видит только сам участник (Р14); дела администратора
(архив, просьбы о ключе, участники у лимита) — только у администратора."""

from fastapi import APIRouter

from app.core.deps import CurrentUser, DbSession, RedisClient
from app.schemas.bets import Period
from app.schemas.dashboard import DashboardOut
from app.services import dashboard as dashboard_service

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard")
async def get_dashboard(
    user: CurrentUser, db: DbSession, redis: RedisClient, period: Period = "30d"
) -> DashboardOut:
    """Банк, показатели периода с изменением к прошлому, ряд банка и последние ставки,
    открытые ставки, мои матчи сегодня, дела администратора."""
    return await dashboard_service.dashboard(db, redis, user, period)
