"""«Обучение модели»: сводка экрана (GET /api/learning) и базовая модель
(GET /api/ml/model) — этап 5, волна 3. Свое (рассчитанные ставки, свои правила) — только
свое, остальное общее (Р25). Числа считает сервер (Т15)."""

from fastapi import APIRouter

from app.core.deps import CurrentUser, DbSession
from app.schemas.learning import LearningOut, MlModelOut
from app.services import learning, recalibration

router = APIRouter(tags=["learning"])


@router.get("/learning")
async def learning_summary(user: CurrentUser, db: DbSession) -> LearningOut:
    """Плитки, шапка и пороги «Обучения модели» (и блок «Модель учится» на главной)."""
    return await learning.learning_out(db, user)


@router.get("/ml/model")
async def ml_model(user: CurrentUser, db: DbSession) -> MlModelOut:
    """Базовая модель: активная версия калибровки, версии, проверка по месяцам против
    рынка архива, калибровка, события для поправки Claude числом."""
    return await recalibration.model_out(db)
