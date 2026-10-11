"""Ставки и банк участника: POST /api/bets («Сохранить ставку»), GET /api/me/bank,
GET /api/me/bookmakers. Видит только сам участник (Р14)."""

from fastapi import APIRouter, status

from app.core.deps import CurrentUser, DbSession
from app.schemas.bets import BankOut, BetIn, BetOut
from app.services import bets as bets_service

router = APIRouter(tags=["bets"])


@router.post("/bets", status_code=status.HTTP_201_CREATED)
async def place_bet(body: BetIn, user: CurrentUser, db: DbSession) -> BetOut:
    """Ставка по экспрессу своего завершенного анализа: ноги — его прогнозы (состав не
    меняется, кэфы — фактические), сумма — не больше банка. Повтор с тем же client_ref
    возвращает ту же ставку."""
    placed = await bets_service.place_bet(db, user, body)
    return bets_service.bet_out(placed)


@router.get("/me/bank")
async def my_bank(user: CurrentUser, db: DbSession) -> BankOut:
    """Банк по учету: баланс, пик, просадка, стартовый банк, итог 7 дней, адаптации."""
    return await bets_service.bank_out(db, user)


@router.get("/me/bookmakers")
async def my_bookmakers(user: CurrentUser, db: DbSession) -> list[str]:
    """Букмекеры участника из ставок и анализов, частые первыми."""
    return await bets_service.bookmakers(db, user)
