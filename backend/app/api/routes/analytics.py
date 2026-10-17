"""Аналитика участника: все блоки экрана одним ответом (из кэша) и выгрузка CSV (В13).
Видит сам участник и администратор с as_user (Р27, только просмотр); выгрузка чужих данных
— запись member_export в журнале администратора."""

from typing import Annotated

from fastapi import APIRouter, Query, Response

from app.core.deps import AS_USER_DOC, DbSession, RedisClient, ViewAnalytics, ViewExport
from app.schemas.analytics import (
    AnalyticsArchiveIn,
    AnalyticsExportIn,
    AnalyticsFiltersIn,
    AnalyticsOut,
)
from app.services import analytics as analytics_service
from app.services import member_view
from app.services.bank import local_today, user_zone

router = APIRouter(prefix="/analytics", tags=["analytics"])

JSON = "application/json"
CSV_TYPE = "text/csv; charset=utf-8"


@router.get("", response_model=AnalyticsOut, openapi_extra=AS_USER_DOC)
async def get_analytics(
    filters: Annotated[AnalyticsFiltersIn, Query()],
    viewed: ViewAnalytics,
    db: DbSession,
    redis: RedisClient,
) -> Response:
    """Все блоки «Аналитики» по фильтрам: показатели с прошлым периодом, выводы, ряд банка,
    срезы ROI с интервалами, экспрессы против ординаров, калибровка, Brier, CLV. Ответ
    кэшируется до изменения данных участника."""
    text = await analytics_service.analytics_json(db, redis, viewed.user, filters)
    return Response(content=text, media_type=JSON)


@router.get(
    "/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV одной части"}},
    openapi_extra=AS_USER_DOC,
)
async def export_analytics_csv(
    params: Annotated[AnalyticsExportIn, Query()], viewed: ViewExport, db: DbSession
) -> Response:
    """Выгрузка под фильтрами: ставки, события, калибровка или скользящий Brier."""
    user = viewed.user
    await member_view.log_export(db, viewed, "analytics", {"parts": [params.part]})
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
    openapi_extra=AS_USER_DOC,
)
async def export_analytics_zip(
    params: Annotated[AnalyticsArchiveIn, Query()], viewed: ViewExport, db: DbSession
) -> Response:
    """Выгрузка под фильтрами одним архивом: каждая выбранная часть — отдельный CSV."""
    user = viewed.user
    parts = list(dict.fromkeys(params.part))
    await member_view.log_export(db, viewed, "analytics", {"parts": parts})
    files = await analytics_service.export_csv(db, user, params, parts)
    stamp = local_today(user_zone(user.tz))
    return Response(
        content=analytics_service.export_zip(files, stamp),
        media_type="application/zip",
        headers={
            "Content-Disposition": f'attachment; filename="analytics-{stamp.isoformat()}.zip"'
        },
    )
