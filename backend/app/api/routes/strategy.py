"""Стратегия участника: GET /api/strategy/active — параметры активной версии."""

from fastapi import APIRouter

from app.core.deps import CurrentUser, DbSession
from app.schemas.strategy import StrategyOut
from app.services.strategy_versions import active_version, strategy_out

router = APIRouter(prefix="/strategy", tags=["strategy"])


@router.get("/active")
async def active_strategy(user: CurrentUser, db: DbSession) -> StrategyOut:
    """Активная версия; ее еще нет (не было анализов) — значения v3 по умолчанию."""
    return strategy_out(await active_version(db, user.id))
