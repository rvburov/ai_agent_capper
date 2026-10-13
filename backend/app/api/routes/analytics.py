"""Аналитика участника: все блоки экрана одним ответом (из кэша) и выгрузка CSV (В13).
Видит только сам участник (Р14): данные — только свои ставки и банк."""

from typing import Annotated

from fastapi import APIRouter, Query, Response

from app.core.deps import CurrentUser, DbSession, RedisClient
from app.schemas.analytics import (
    AnalyticsArchiveIn,
    AnalyticsExportIn,
    AnalyticsFiltersIn,
    AnalyticsOut,
)
from app.services import analytics as analytics_service
from app.services.bank import local_today, user_zone

router = APIRouter(prefix="/analytics", tags=["analytics"])

JSON = "application/json"
CSV_TYPE = "text/csv; charset=utf-8"


@router.get("", response_model=AnalyticsOut)
async def get_analytics(
    filters: Annotated[AnalyticsFiltersIn, Query()],
    user: CurrentUser,
    db: DbSession,
    redis: RedisClient,
) -> Response:
    """Все блоки «Аналитики» по фильтрам: показатели с прошлым периодом, выводы, ряд банка,
    срезы ROI с интервалами, экспрессы против ординаров, калибровка, Brier, CLV. Ответ
    кэшируется до изменения данных участника."""
    text = await analytics_service.analytics_json(db, redis, user, filters)
    return Response(content=text, media_type=JSON)


@router.get(
    "/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV одной части"}},
)
async def export_analytics_csv(
    params: Annotated[AnalyticsExportIn, Query()], user: CurrentUser, db: DbSession
) -> Response:
    """Выгрузка под фильтрами: ставки, события, калибровка или скользящий Brier."""
    files = await analytics_service.export_csv(db, user, params, [params.part])
    stamp = local_today(user_zone(user.tz))
    return Response(
        content=files[params.part],
        media_type=CSV_TYPE,
        headers={
            "Content-Disposition": (
                f'attachment; filename="analytics-{params.part}-{stamp.isoformat()}.csv"'
            )
        },
    )


@router.get(
    "/export.zip",
    response_class=Response,
    responses={200: {"content": {"application/zip": {}}, "description": "ZIP с CSV частей"}},
)
async def export_analytics_zip(
    params: Annotated[AnalyticsArchiveIn, Query()], user: CurrentUser, db: DbSession
) -> Response:
    """Выгрузка под фильтрами одним архивом: каждая выбранная часть — отдельный CSV."""
    parts = list(dict.fromkeys(params.part))
    files = await analytics_service.export_csv(db, user, params, parts)
    stamp = local_today(user_zone(user.tz))
    return Response(
        content=analytics_service.export_zip(files, stamp),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="analytics-{stamp.isoformat()}.zip"'
        },
    )
