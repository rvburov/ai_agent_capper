"""Ставки участника: «Сохранить ставку» по анализу, список «Ставок» с фильтрами и
курсором, итоги, карточка, ручной расчет, исправление результата (сторно), закрывающий
кэф ноги, выгрузка CSV; букмекеры. Видит и меняет только сам участник (Р14): чужая ставка —
404, как несуществующая. После изменения ставки — прогрев кэша аналитики после ответа
(app/services/analytics_cache.py)."""

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Path, Query, Response, status
from fastapi.responses import StreamingResponse

from app.core.deps import CurrentUser, DbSession
from app.schemas.bets import (
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
from app.services import analytics_cache
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
    """Ставка по экспрессу своего завершенного анализа: ноги — его прогнозы (состав не
    меняется, кэфы — фактические), сумма — не больше банка. Повтор с тем же client_ref
    возвращает ту же ставку."""
    placed = await bets_service.place_bet(db, user, body)
    background.add_task(analytics_cache.request_warm, user.id)
    return bets_service.bet_out(placed)


@router.get("/bets")
async def list_bets(
    page: Annotated[BetPageIn, Query()], user: CurrentUser, db: DbSession
) -> BetPageOut:
    """Свои ставки по фильтрам, новые сверху, по 20 (limit до 100); before — номер
    последней ставки прошлой страницы."""
    return await bets_service.list_bets(db, user, page)


@router.get("/bets/summary")
async def bets_summary(
    filters: Annotated[BetFiltersIn, Query()], user: CurrentUser, db: DbSession
) -> BetsSummaryOut:
    """Итоги по тем же фильтрам: рассчитано, выигрыш · проигрыш · возврат, оборот,
    прибыль, ROI (возвраты — отдельно), средний CLV без ставок старого бота."""
    return await bets_service.bets_summary(db, user, filters)


@router.get(
    "/bets/export.csv",
    response_class=Response,
    responses={200: {"content": {"text/csv": {}}, "description": "CSV: строка на событие"}},
)
async def export_bets(
    filters: Annotated[BetFiltersIn, Query()], user: CurrentUser, db: DbSession
) -> Response:
    """Выгрузка своих ставок по фильтрам: строка на событие (ногу), файл отдается
    частями."""
    chunks = await bets_service.export_csv(db, user, filters)
    return StreamingResponse(
        chunks,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{CSV_FILENAME}"'},
    )


@router.get("/bets/{bet_id}")
async def get_bet(bet_id: RowId, user: CurrentUser, db: DbSession) -> BetItemOut:
    """Карточка ставки: ноги, матчи, исходы, закрытие, CLV и вердикт."""
    return await bets_service.bet_detail(db, user, bet_id)


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


@router.get("/me/bookmakers")
async def my_bookmakers(user: CurrentUser, db: DbSession) -> list[str]:
    """Букмекеры участника из ставок и анализов, частые первыми."""
    return await bets_service.bookmakers(db, user)
