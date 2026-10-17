"""Банк участника: состояние по учету, капитал по дням, журнал и движение банка
(пополнение, вывод, корректировка). Меняет только сам участник; читает он и администратор
с as_user (Р27, только просмотр)."""

from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Query, Response, status

from app.core.deps import AS_USER_DOC, CurrentUser, DbSession, ViewBank
from app.schemas.bets import (
    BankEntriesOut,
    BankEntryIn,
    BankEntryOut,
    BankHistoryOut,
    BankOut,
    Period,
)
from app.services import analytics_cache
from app.services import bank as bank_service
from app.services import bets as bets_service

router = APIRouter(prefix="/me/bank", tags=["bank"])


@router.get("", openapi_extra=AS_USER_DOC)
async def my_bank(viewed: ViewBank, db: DbSession) -> BankOut:
    """Банк по учету: баланс, пик, просадка, стартовый банк, итог 7 дней, адаптации."""
    return await bets_service.bank_out(db, viewed.user)


@router.get("/history", openapi_extra=AS_USER_DOC)
async def bank_history(viewed: ViewBank, db: DbSession, period: Period = "30d") -> BankHistoryOut:
    """Капитал (баланс + ставки в игре) на конец каждого дня периода по поясу участника."""
    return await bank_service.bank_history(db, viewed.user, period)


@router.get("/entries", openapi_extra=AS_USER_DOC)
async def bank_entries(
    viewed: ViewBank,
    db: DbSession,
    before: Annotated[int | None, Query(ge=1, le=2**63 - 1)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = bank_service.ENTRIES_LIMIT,
    flows_only: bool = False,
) -> BankEntriesOut:
    """Журнал банка, новые сверху, с балансом после каждой строки; flows_only — только
    пополнения, выводы и корректировки."""
    return await bank_service.list_entries(
        db, viewed.user, before=before, limit=limit, flows_only=flows_only
    )


@router.post("/entries", status_code=status.HTTP_201_CREATED)
async def add_bank_entry(
    body: BankEntryIn,
    user: CurrentUser,
    db: DbSession,
    response: Response,
    background: BackgroundTasks,
) -> BankEntryOut:
    """Пополнение, вывод (не больше баланса) или корректировка. Повтор той же записи
    (двойная отправка) возвращает ее же с кодом 200."""
    added = await bank_service.add_entry(db, user, body)
    if not added.created:
        response.status_code = status.HTTP_200_OK
    else:
        background.add_task(analytics_cache.request_warm, user.id)
    return added.entry
