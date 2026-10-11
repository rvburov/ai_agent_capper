"""Анализы участника: /api/analyses/* — ввод, «Перед запуском», запуск, ход (SSE),
результат, отмена, решение, список.

Каждый маршрут видит только свои анализы: чужой id отвечает 404 analysis.not_found,
как несуществующий. Поток прогресса до начала отдачи освобождает соединение БД: дальше
он читает только Redis.
"""

from typing import Annotated

from fastapi import APIRouter, Header, Path, Query, status
from fastapi.responses import StreamingResponse

from app.core.deps import CurrentUser, DbSession, RedisClient
from app.schemas.analyses import (
    AnalysisCreateIn,
    AnalysisListOut,
    AnalysisOut,
    ConfirmIn,
    DecisionIn,
    PreviewOut,
    ProgressEventOut,
)
from app.services import analyses as analyses_service
from app.services import progress
from app.services.analysis_view import analysis_out

router = APIRouter(prefix="/analyses", tags=["analyses"])

# id строки в пути: BIGINT. Число вне диапазона — 422, а не ошибка базы (500)
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


class EventStreamResponse(StreamingResponse):
    """Поток SSE: в схеме OpenAPI тип события описан под text/event-stream."""

    media_type = "text/event-stream"


async def enqueue_analysis(analysis_id: int, attempt: int, job_id: str) -> None:
    """Задача воркера run_analysis. Соединение с очередью — на одну постановку: запуск
    анализа редкий, держать пул в API незачем."""
    # Модуль воркера тянет за собой загрузчики данных (openpyxl): API грузит его только
    # при первом запуске анализа
    from app.workers.main import create_queue_pool

    pool = await create_queue_pool()
    try:
        await pool.enqueue_job("run_analysis", analysis_id, attempt, _job_id=job_id)
    finally:
        await pool.aclose()


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_analysis(
    body: AnalysisCreateIn, user: CurrentUser, db: DbSession, redis: RedisClient
) -> AnalysisOut:
    """Новый анализ: текст — разбор Claude (2–5 с, не больше 30 в час), форма — пустой
    черновик. Нет доступа к Claude — 409 с кодом причины (errors.ai.*)."""
    if body.input_kind == "form":
        analysis = await analyses_service.create_form(db, user)
    else:
        analysis = await analyses_service.create_from_text(db, redis, user, body.text or "")
    return await analysis_out(db, analysis)


@router.get("")
async def list_analyses(
    user: CurrentUser,
    db: DbSession,
    before: Annotated[int | None, Query(ge=1, le=2**63 - 1)] = None,
    limit: Annotated[int, Query(ge=1, le=50)] = analyses_service.LIST_LIMIT,
) -> AnalysisListOut:
    """Свои анализы, новые сверху. Следующая страница — before=next_cursor."""
    return await analyses_service.list_analyses(db, user, before=before, limit=limit)


@router.get("/{analysis_id}")
async def get_analysis(analysis_id: RowId, user: CurrentUser, db: DbSession) -> AnalysisOut:
    analysis = await analyses_service.get_owned(db, user, analysis_id)
    return await analysis_out(db, analysis)


@router.post("/{analysis_id}/preview")
async def preview_analysis(
    analysis_id: RowId,
    user: CurrentUser,
    db: DbSession,
    body: ConfirmIn | None = None,
) -> PreviewOut:
    """«Перед запуском» без Claude: игроки, маржа, коридор стратегии, цена, время и
    доступ. Без событий в теле — по уже подтвержденным."""
    return await analyses_service.preview(db, user, analysis_id, body)


@router.post("/{analysis_id}/run", status_code=status.HTTP_202_ACCEPTED)
async def run_analysis(
    analysis_id: RowId,
    user: CurrentUser,
    db: DbSession,
    redis: RedisClient,
    body: ConfirmIn | None = None,
) -> AnalysisOut:
    """Запуск: события (1–5), банк и букмекер. Повторный запуск после сбоя или отмены —
    без событий: продолжает с упавшего шага, оплаченные шаги не повторяются. Нет
    доступа — 409 с кодом причины, неверные события — 422 errors.analysis.*."""
    analysis = await analyses_service.start_run(
        db, redis, user, analysis_id, body, enqueue=enqueue_analysis
    )
    return await analysis_out(db, analysis)


@router.post("/{analysis_id}/cancel")
async def cancel_analysis(
    analysis_id: RowId, user: CurrentUser, db: DbSession, redis: RedisClient
) -> AnalysisOut:
    analysis = await analyses_service.cancel(db, redis, user, analysis_id)
    return await analysis_out(db, analysis)


@router.put("/{analysis_id}/decision")
async def set_decision(
    analysis_id: RowId, body: DecisionIn, user: CurrentUser, db: DbSession
) -> AnalysisOut:
    """«Не ставить» (skip) или снять решение (null)."""
    analysis = await analyses_service.set_decision(db, user, analysis_id, body.decision)
    return await analysis_out(db, analysis)


@router.get(
    "/{analysis_id}/events",
    response_class=EventStreamResponse,
    responses={
        200: {
            "model": ProgressEventOut,
            "description": "Поток SSE: в data — JSON ProgressEventOut, первым — снимок",
        },
        # Ошибки (вход, чужой анализ) — обычный JSON, а не поток
        "4XX": {
            "description": "Ошибка: {error: {code, message}}",
            "content": {"application/json": {"schema": {"$ref": "#/components/schemas/ErrorOut"}}},
        },
    },
)
async def analysis_events(
    analysis_id: RowId,
    user: CurrentUser,
    db: DbSession,
    redis: RedisClient,
    last_event_id: Annotated[str | None, Header(alias="Last-Event-ID", max_length=64)] = None,
) -> EventStreamResponse:
    """Ход анализа: снимок из базы, затем события шагов; конец — done, failed,
    cancelled. Анализ не в работе — только снимок. Heartbeat раз в 15 с, retry 3 с."""
    start = await analyses_service.stream_start(db, redis, user, analysis_id)
    return EventStreamResponse(
        progress.event_stream(
            redis,
            analysis_id,
            snapshot=start.snapshot,
            start_id=start.start_id,
            live=start.live,
            resume_id=last_event_id,
            recheck=start.recheck,
        ),
        headers=SSE_HEADERS,
    )
