"""Игроки: GET /api/players?q= — подсказки формы ввода (кириллица и латиница); список
«Игроки» и карточка игрока с матчами, новостями и личными встречами (этап 4).

Игроки, матчи и новости — общие для всех участников. Личное только «сегодня» в карточке:
свои открытые ставки и сегодняшние анализы по пользователю сеанса.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query

from app.core.deps import CurrentUser, DbSession
from app.schemas.players import (
    EloSurface,
    H2HOut,
    PlayerCardOut,
    PlayerHitOut,
    PlayerMatchesOut,
    PlayerNewsOut,
    PlayerRankingOut,
    PlayersData,
    PlayersSort,
)
from app.services import player_card
from app.services.analysis_input import player_facts
from app.services.players import (
    QUERY_MAX_LENGTH,
    RANKING_LIMIT,
    RANKING_LIMIT_MAX,
    RankingQuery,
    ranking,
    search_players,
)

router = APIRouter(prefix="/players", tags=["players"])

SUGGEST_LIMIT = 10
# Номер строки в БД: BIGINT, больше не бывает
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
Cursor = Annotated[int | None, Query(ge=1, le=2**63 - 1)]
# Игроков в базе около 2 800: дальше страниц нет
OFFSET_MAX = 100_000


@router.get("")
async def find_players(
    user: CurrentUser,
    db: DbSession,
    # NUL PostgreSQL в тексте не принимает: без проверки запрос падал бы с 500
    q: Annotated[str, Query(max_length=200, pattern=r"^[^\x00]*$")],
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


@router.get("/ranking")
async def players_ranking(
    user: CurrentUser,
    db: DbSession,
    q: Annotated[str | None, Query(max_length=QUERY_MAX_LENGTH, pattern=r"^[^\x00]*$")] = None,
    surface: EloSurface = "hard",
    data: PlayersData = "active",
    sort: PlayersSort = "rank",
    offset: Annotated[int, Query(ge=0, le=OFFSET_MAX)] = 0,
    limit: Annotated[int, Query(ge=1, le=RANKING_LIMIT_MAX)] = RANKING_LIMIT,
) -> PlayerRankingOut:
    """Список «Игроки»: по умолчанию игроки с матчами за 52 недели по месту по Эло, по 50
    на странице. q — поиск по всей базе (по-русски и латиницей, с опечатками; fuzzy —
    точных совпадений нет); data — active, news (новости свежее кэша) или all; surface —
    покрытие колонки «Эло на покрытии»; sort — rank, elo (на покрытии) или last
    (последний матч в базе)."""
    return await ranking(
        db,
        user,
        RankingQuery(q=q, surface=surface, data=data, sort=sort, offset=offset, limit=limit),
    )


@router.get("/{player_id}")
async def get_player(user: CurrentUser, db: DbSession, player_id: RowId) -> PlayerCardOut:
    """Карточка игрока: шапка, «Обзор» (Эло по покрытиям, форма, подача и прием против
    тура, результаты по покрытиям, ключевые матчи), свежесть данных, профиль из старого
    бота и «сегодня» — только из своих ставок и анализов. Нет игрока — 404
    player.not_found."""
    return await player_card.card(db, user, player_id)


@router.get("/{player_id}/matches")
async def get_player_matches(
    user: CurrentUser,
    db: DbSession,
    player_id: RowId,
    before: Cursor = None,
    limit: Annotated[
        int, Query(ge=1, le=player_card.MATCHES_LIMIT_MAX)
    ] = player_card.MATCHES_LIMIT,
) -> PlayerMatchesOut:
    """Матчи игрока в базе страницами, сначала последние; before — id последнего матча
    прошлой страницы (матч другого игрока — 422 player.bad_cursor)."""
    return await player_card.matches(db, player_id, before=before, limit=limit)


@router.get("/{player_id}/news")
async def get_player_news(
    user: CurrentUser,
    db: DbSession,
    player_id: RowId,
    before: Cursor = None,
    limit: Annotated[int, Query(ge=1, le=player_card.NEWS_LIMIT_MAX)] = player_card.NEWS_LIMIT,
) -> PlayerNewsOut:
    """Факты из новостей игрока за окно новостей, новые сверху, страницами."""
    return await player_card.news(db, player_id, before=before, limit=limit)


@router.get("/{player_id}/h2h/{opponent_id}")
async def get_head_to_head(
    user: CurrentUser, db: DbSession, player_id: RowId, opponent_id: RowId
) -> H2HOut:
    """Личные встречи двух игроков в базе. Тот же игрок — 422 player.h2h_same."""
    return await player_card.head_to_head(db, player_id, opponent_id)
