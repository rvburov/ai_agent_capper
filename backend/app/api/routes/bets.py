"""Ставки участника: «Сохранить ставку» по анализу, список «Ставок» с фильтрами и
курсором, итоги, карточка, ручной расчет, исправление результата (сторно), закрывающий
кэф ноги, выгрузка CSV, разбор ИИ (этап 5). Меняет только сам участник: чужая ставка —
404, как несуществующая. Читает сам участник и администратор с as_user (Р27, только
просмотр; выгрузка CSV чужих ставок — запись member_export). После изменения ставки —
прогрев кэша аналитики после ответа (app/services/analytics_cache.py)."""

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, Response, status
from fastapi.responses import StreamingResponse

from app.core.deps import AS_USER_DOC, CurrentUser, DbSession, ViewBets, ViewExport
from app.schemas.bets import (
    BetCountsOut,
    BetFiltersIn,
    BetIn,
    BetItemOut,
    BetOut,
    BetPageIn,
    BetPageOut,
    BetsSummaryOut,
    ClosingUpdateIn,
    ReverseIn,
    SettleIn,
)
from app.schemas.lessons import BetReviewOut
from app.services import analytics_cache, member_view, postmortems
from app.services import bets as bets_service
from app.services import closing as closing_service
from app.services import settlement as settlement_service

router = APIRouter(tags=["bets"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
CSV_FILENAME = "bets.csv"


@router.post("/bets", status_code=status.HTTP_201_CREATED)
async def place_bet(
    body: BetIn, user: CurrentUser, db: DbSession, background: BackgroundTasks
) -> BetOut:
    """Ставка по своему завершенному анализу (Р29), вид kind: strategy — экспресс
    стратегии, single — ординар из вариантов (ноги — ровно ноги варианта, иначе 422
    bet.bad_legs; кэфы — фактические), own — своя ставка: любые исходы анализа (чужой — 422
    bet.not_in_analysis), один рынок на матч (иначе 422 bet.same_match). Сумма — не больше
    банка. По анализу можно несколько ставок, та же ставка второй раз — 409 bet.duplicate;
    повтор с тем же client_ref возвращает ту же ставку. Анализ без итога (старый бот) — 409
    bet.no_result; матч ноги начался или сыгран — 422 bet.match_started. Пауза и лимиты дня
    ответственной игры — 409 play.paused, play.bets_limit, play.stake_limit (until — до
    какого момента)."""
    placed = await bets_service.place_bet(db, user, body)
    background.add_task(analytics_cache.request_warm, user.id)
    return bets_service.bet_out(placed)


@router.get("/bets", openapi_extra=AS_USER_DOC)
async def list_bets(
    page: Annotated[BetPageIn, Query()], viewed: ViewBets, db: DbSession
) -> BetPageOut:
    """Свои ставки по фильтрам, новые сверху, по 20 (limit до 100); before — номер
    последней ставки прошлой страницы."""
    return await bets_service.list_bets(db, viewed.user, page)


@router.get("/bets/summary", openapi_extra=AS_USER_DOC)
async def bets_summary(
    filters: Annotated[BetFiltersIn, Query()], viewed: ViewBets, db: DbSession
) -> BetsSummaryOut:
    """Итоги по тем же фильтрам: рассчитано, выигрыш · проигрыш · возврат, оборот,
    прибыль, ROI (возвраты — отдельно), средний CLV без ставок старого бота."""
    return await bets_service.bets_summary(db, viewed.user, filters)


@router.get("/bets/counts", openapi_extra=AS_USER_DOC)
async def bet_counts(viewed: ViewBets, db: DbSession) -> BetCountsOut:
    """Счетчики для меню: открытых ставок и из них ждущих результата (все матчи уже
    прошли по поясу участника)."""
    return await bets_service.bet_counts(db, viewed.user)


@router.get(
    "/bets/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV: строка на событие"}},
    openapi_extra=AS_USER_DOC,
)
async def export_bets(
    filters: Annotated[BetFiltersIn, Query()], viewed: ViewExport, db: DbSession
) -> Response:
    """Выгрузка своих ставок по фильтрам: строка на событие (ногу), файл отдается
    частями."""
    await member_view.log_export(db, viewed, "bets")
    chunks = await bets_service.export_csv(db, viewed.user, filters)
    return StreamingResponse(
        chunks,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{CSV_FILENAME}"'},
    )


@router.get("/bets/{bet_id}", openapi_extra=AS_USER_DOC)
async def get_bet(bet_id: RowId, viewed: ViewBets, db: DbSession) -> BetItemOut:
    """Карточка ставки: ноги, матчи, исходы, закрытие, CLV и вердикт."""
    return await bets_service.bet_detail(db, viewed.user, bet_id)


@router.get("/bets/{bet_id}/review", openapi_extra=AS_USER_DOC)
async def bet_review(bet_id: RowId, viewed: ViewBets, db: DbSession) -> BetReviewOut:
    """Разбор ИИ своей ставки (этап 5, В3): по разбору на матч (общий для всех, кто на
    него ставил) и вердикт по CLV кодом. Чужая или несуществующая — 404."""
    return await postmortems.bet_review(db, viewed.user, bet_id)


@router.put("/bets/{bet_id}/result")
async def settle_bet(
    bet_id: RowId,
    body: SettleIn,
    user: CurrentUser,
    db: DbSession,
    background: BackgroundTasks,
) -> BetItemOut:
    """Ручной расчет открытой ставки: исход каждой ноги, счет и закрывающий кэф по
    желанию. Ставка изменилась после того, как ее открыли (expected_updated_at), — 409,
    кроме повтора того же расчета."""
    item = await settlement_service.settle_bet(db, user, bet_id, body)
    background.add_task(analytics_cache.request_warm, user.id)
    return item


@router.post("/bets/{bet_id}/reverse")
async def reverse_bet(
    bet_id: RowId,
    body: ReverseIn,
    user: CurrentUser,
    db: DbSession,
    background: BackgroundTasks,
) -> BetItemOut:
    """Исправить результат: сторно выплаты или возврата, ставка снова открыта."""
    item = await settlement_service.reverse_settlement(db, user, bet_id, body)
    background.add_task(analytics_cache.request_warm, user.id)
    return item


@router.put("/bets/{bet_id}/legs/{leg_id}/closing")
async def set_leg_closing(
    bet_id: RowId,
    leg_id: RowId,
    body: ClosingUpdateIn,
    user: CurrentUser,
    db: DbSession,
    background: BackgroundTasks,
) -> BetItemOut:
    """Закрывающий кэф ноги (свой исход, обратный — по желанию, чей кэф); null — стереть."""
    item = await closing_service.set_leg_closing(db, user, bet_id, leg_id, body.closing)
    background.add_task(analytics_cache.request_warm, user.id)
    return item
