"""Игроки: GET /api/players?q= — подсказки формы ввода (кириллица и латиница)."""

from typing import Annotated

from fastapi import APIRouter, Query

from app.core.deps import CurrentUser, DbSession
from app.schemas.players import PlayerHitOut
from app.services.analysis_input import player_facts
from app.services.players import search_players

router = APIRouter(prefix="/players", tags=["players"])

SUGGEST_LIMIT = 10


@router.get("")
async def find_players(
    user: CurrentUser,
    db: DbSession,
    q: Annotated[str, Query(max_length=200)],
    limit: Annotated[int, Query(ge=1, le=SUGGEST_LIMIT)] = SUGGEST_LIMIT,
) -> list[PlayerHitOut]:
    """До 10 игроков, похожих на запрос. Пустой или длинный запрос — 422
    players.errors.*."""
    hits = await search_players(db, q, limit=limit)
    facts = await player_facts(db, [hit.player.id for hit in hits])
    return [
        PlayerHitOut(
            id=hit.player.id,
            name=hit.player.name,
            name_ru=hit.player.name_ru,
            country=hit.player.country,
            score=hit.score,
            matched=hit.matched,
            matches=hit.matches,
            elo_rank=facts[hit.player.id].elo_rank if hit.player.id in facts else None,
            last_match=facts[hit.player.id].last_match if hit.player.id in facts else None,
        )
        for hit in hits
    ]
