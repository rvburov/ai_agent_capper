"""Стратегия участника и версии (этап 5, волна 3; Р25 уточняет Р1).

- GET /api/strategy/active — параметры своей активной версии правил;
- GET /api/strategy/versions — общая линия инструкций анализа (видна всем) и свои правила
  суммы ставки; GET …/{id} — версия (чужие правила — 404); GET …/compare?a=&b= — две
  версии одной линии и сравнение прогонов на наборе;
- POST /api/strategy/versions — кандидат своих правил суммы с проверкой на своих ставках;
- POST …/{id}/activate, …/rollback, …/reject — включить, вернуть, отклонить: свои правила —
  владелец, общая линия — только администратор (403), включение инструкций — только после
  прогона на замороженном наборе (409 strategy.eval_needed).

Ни одна версия не включается сама: кандидат после проверки остается кандидатом.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, status

from app.core.deps import ClientIp, CurrentUser, DbSession, RedisClient
from app.schemas.learning import (
    RulesCandidateIn,
    StrategyVersionOut,
    StrategyVersionsOut,
    VersionCompareOut,
)
from app.schemas.strategy import StrategyOut
from app.services import strategy_versions, strategy_view
from app.services.strategy_versions import active_version, strategy_out

router = APIRouter(prefix="/strategy", tags=["strategy"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
QueryId = Annotated[int, Query(ge=1, le=2**63 - 1)]


@router.get("/active")
async def active_strategy(user: CurrentUser, db: DbSession) -> StrategyOut:
    """Активная версия; ее еще нет (не было анализов) — значения v3 по умолчанию."""
    return strategy_out(await active_version(db, user.id))


@router.get("/versions")
async def list_versions(user: CurrentUser, db: DbSession) -> StrategyVersionsOut:
    """Версии: общая линия инструкций (метрики на наборе, сравнение кандидата) и свои
    правила суммы (проверка на своих ставках)."""
    return await strategy_view.list_versions(db, user)


@router.get("/versions/compare")
async def compare_versions(
    a: QueryId, b: QueryId, user: CurrentUser, db: DbSession, redis: RedisClient
) -> VersionCompareOut:
    """Сравнение двух версий одной линии: a — база, b — кандидат. Разные линии — 422;
    участнику — не больше 20 сравнений в минуту (429 common.rate_limited)."""
    await strategy_view.hit_compare_limit(redis, user)
    return await strategy_view.compare(db, user, a, b)


@router.get("/versions/{version_id}")
async def get_version(version_id: RowId, user: CurrentUser, db: DbSession) -> StrategyVersionOut:
    return await strategy_view.version_detail(db, user, version_id)


@router.post("/versions", status_code=status.HTTP_201_CREATED)
async def create_rules_candidate(
    body: RulesCandidateIn, user: CurrentUser, db: DbSession
) -> StrategyVersionOut:
    """Кандидат своих правил суммы (адаптации, доли банка по итоговому кэфу) с проверкой
    на своих ставках. Ничего не изменилось — 422 strategy.no_changes."""
    version = await strategy_versions.create_rules_candidate(db, user, body)
    return await strategy_view.version_detail(db, user, version.id)


@router.post("/versions/{version_id}/activate")
async def activate_version(
    version_id: RowId, user: CurrentUser, db: DbSession, ip: ClientIp
) -> StrategyVersionOut:
    """Включить кандидата (прежняя активная — в архив)."""
    await strategy_versions.activate(db, user, version_id, ip=ip)
    return await strategy_view.version_detail(db, user, version_id)


@router.post("/versions/{version_id}/rollback")
async def rollback_version(
    version_id: RowId, user: CurrentUser, db: DbSession, ip: ClientIp
) -> StrategyVersionOut:
    """Вернуть версию, которая уже была активной."""
    await strategy_versions.rollback(db, user, version_id, ip=ip)
    return await strategy_view.version_detail(db, user, version_id)


@router.post("/versions/{version_id}/reject")
async def reject_version(version_id: RowId, user: CurrentUser, db: DbSession) -> StrategyVersionOut:
    """Отклонить кандидата."""
    await strategy_versions.reject(db, user, version_id)
    return await strategy_view.version_detail(db, user, version_id)
