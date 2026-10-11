"""Схемы поиска игроков: GET /api/players?q= (подсказки формы ввода)."""

from datetime import date

from pydantic import BaseModel


class PlayerHitOut(BaseModel):
    """Найденный игрок: сходство 0…1, по какому полю найден, матчей в базе, место по Эло
    и последний матч."""

    id: int
    name: str
    name_ru: str | None
    country: str | None
    score: float
    matched: str
    matches: int
    elo_rank: int | None
    last_match: date | None
