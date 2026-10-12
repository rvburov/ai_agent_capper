"""Схемы ставок и банка: POST /api/bets, GET /api/me/bank, GET /api/me/bookmakers.

Деньги и кэфы — Decimal строкой в JSON (точность не теряется), доли — строкой Decimal.
"""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, Field, StringConstraints

from app.schemas.analyses import DecimalOut, Market

OddsTakenIn = Annotated[Decimal, Field(gt=0, max_digits=6, decimal_places=3)]
StakeIn = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]
# Одна строка без управляющих символов (NUL дал бы 500 из PostgreSQL)
BookmakerIn = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[^\x00-\x1f\x7f]*$"
    ),
]
# Ключ идемпотентности от фронтенда: повтор с тем же ключом вернет ту же ставку
ClientRef = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9_-]{8,64}$")
]


class BetLegIn(BaseModel):
    """Нога ставки: прогноз анализа и кэф, по которому участник поставил."""

    prediction_id: int = Field(ge=1, le=2**63 - 1)
    odds_taken: OddsTakenIn


class BetIn(BaseModel):
    analysis_id: int = Field(ge=1, le=2**63 - 1)
    stake: StakeIn
    bookmaker: BookmakerIn
    legs: list[BetLegIn] = Field(min_length=1, max_length=3)
    client_ref: ClientRef


class BetLegOut(BaseModel):
    id: int
    prediction_id: int | None
    match_id: int
    market: Market
    selection: int
    odds_taken: DecimalOut


class BetOut(BaseModel):
    id: int
    analysis_id: int | None
    placed_at: datetime
    bookmaker: str
    stake: DecimalOut
    currency: str
    total_odds: DecimalOut
    status: Literal["open", "won", "lost", "void"]
    legs: list[BetLegOut]
    client_ref: str | None


class AdaptationOut(BaseModel):
    """Правило адаптации суммы (Р22): включено ли в стратегии и действует ли сейчас."""

    key: Literal["dd10", "dd20", "up15", "week_loss", "week_win"]
    enabled: bool
    active: bool
    params: dict[str, Any]


class BankOut(BaseModel):
    """Банк по учету: баланс, в игре, капитал, пик и просадка (0..1), стартовый банк
    (пополнения минус выводы), рост к нему, итог 7 дней, винрейт и адаптации."""

    currency: str
    empty: bool
    balance: DecimalOut
    in_play: DecimalOut
    equity: DecimalOut
    peak: DecimalOut
    drawdown: DecimalOut
    invested: DecimalOut
    growth: DecimalOut | None
    week_change: DecimalOut | None
    winrate: DecimalOut | None
    settled_bets: int
    drawdown_level: Literal["dd10", "dd20"] | None
    adaptations: list[AdaptationOut]
