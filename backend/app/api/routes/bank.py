"""Банк участника: состояние по учету, капитал по дням, журнал и движение банка
(пополнение, вывод, корректировка). Видит только сам участник (Р14)."""

from typing import Annotated

from fastapi import APIRouter, Query, Response, status

from app.core.deps import CurrentUser, DbSession
from app.schemas.bets import (
    BankEntriesOut,
    BankEntryIn,
    BankEntryOut,
    BankHistoryOut,
    BankOut,
    Period,
)
from app.services import bank as bank_service
from app.services import bets as bets_service

router = APIRouter(prefix="/me/bank", tags=["bank"])


@router.get("")
async def my_bank(user: CurrentUser, db: DbSession) -> BankOut:
    """Банк по учету: баланс, пик, просадка, стартовый банк, итог 7 дней, адаптации."""
    return await bets_service.bank_out(db, user)


@router.get("/history")
async def bank_history(user: CurrentUser, db: DbSession, period: Period = "30d") -> BankHistoryOut:
    """Капитал (баланс + ставки в игре) на конец каждого дня периода по поясу участника."""
    return await bank_service.bank_history(db, user, period)


@router.get("/entries")
async def bank_entries(
    user: CurrentUser,
    db: DbSession,
    before: Annotated[int | None, Query(ge=1, le=2**63 - 1)] = None,
    limit: Annotated[int, Query(ge=1, le=200)] = bank_service.ENTRIES_LIMIT,
    flows_only: bool = False,
) -> BankEntriesOut:
    """Журнал банка, новые сверху, с балансом после каждой строки; flows_only — только
    пополнения, выводы и корректировки."""
    return await bank_service.list_entries(
        db, user, before=before, limit=limit, flows_only=flows_only
    )


@router.post("/entries", status_code=status.HTTP_201_CREATED)
async def add_bank_entry(
    body: BankEntryIn, user: CurrentUser, db: DbSession, response: Response
) -> BankEntryOut:
    """Пополнение, вывод (не больше баланса) или корректировка. Повтор той же записи
    (двойная отправка) возвращает ее же с кодом 200."""
    added = await bank_service.add_entry(db, user, body)
    if not added.created:
        response.status_code = status.HTTP_200_OK
    return added.entry
