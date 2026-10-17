"""Главная участника одним ответом. Видит сам участник и администратор с as_user (Р27,
только просмотр); дела администратора (архив, просьбы о ключе, участники у лимита) — только
на своей главной администратора."""

from fastapi import APIRouter

from app.core.deps import AS_USER_DOC, DbSession, RedisClient, ViewDashboard
from app.schemas.bets import Period
from app.schemas.dashboard import DashboardOut
from app.services import dashboard as dashboard_service

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard", openapi_extra=AS_USER_DOC)
async def get_dashboard(
    viewed: ViewDashboard, db: DbSession, redis: RedisClient, period: Period = "30d"
) -> DashboardOut:
    """Банк, показатели периода с изменением к прошлому, ряд банка и последние ставки,
    открытые ставки, мои матчи сегодня, дела администратора."""
    return await dashboard_service.dashboard(db, redis, viewed.user, period)
