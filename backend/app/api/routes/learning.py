"""«Обучение модели»: сводка экрана (GET /api/learning), базовая модель
(GET /api/ml/model) — этап 5, волна 3; еженедельные отчеты (GET /api/learning/reports) —
волна 4. Свое (рассчитанные ставки, свои правила, отчеты) — только свое, остальное общее
(Р25). Числа считает сервер (Т15)."""

from typing import Annotated

from fastapi import APIRouter, Path

from app.core.deps import CurrentUser, DbSession
from app.schemas.learning import LearningOut, MlModelOut
from app.schemas.reports import WeeklyReportOut, WeeklyReportsOut
from app.services import learning, recalibration, weekly_report

router = APIRouter(tags=["learning"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


@router.get("/learning")
async def learning_summary(user: CurrentUser, db: DbSession) -> LearningOut:
    """Плитки, шапка и пороги «Обучения модели» (и блок «Модель учится» на главной)."""
    return await learning.learning_out(db, user)


@router.get("/ml/model")
async def ml_model(user: CurrentUser, db: DbSession) -> MlModelOut:
    """Базовая модель: активная версия калибровки, версии, проверка по месяцам против
    рынка архива, калибровка, события для поправки Claude числом."""
    return await recalibration.model_out(db)


@router.get("/learning/reports")
async def learning_reports(user: CurrentUser, db: DbSession) -> WeeklyReportsOut:
    """Свои еженедельные отчеты, новые сверху, и день следующего."""
    return await weekly_report.list_reports(db, user)


@router.get("/learning/reports/{report_id}")
async def learning_report(report_id: RowId, user: CurrentUser, db: DbSession) -> WeeklyReportOut:
    """Свой отчет недели; чужой — 404 report.not_found."""
    return await weekly_report.report_detail(db, user, report_id)
