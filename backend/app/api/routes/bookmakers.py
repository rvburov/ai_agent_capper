"""«Мои букмекеры» (В9): /api/me/bookmakers*.

GET /api/me/bookmakers — как раньше, только названия для выбора в формах «Нового анализа»
и ставки (скрытые не предлагаются). Список кабинета с id, скрытыми и числом ставок —
GET /api/me/bookmakers/list. Чужой букмекер — 404, как несуществующий.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Response, status

from app.core.deps import CurrentUser, DbSession
from app.schemas.cabinet import (
    BookmakerCreateIn,
    BookmakerOut,
    BookmakerPatchIn,
    BookmakersOut,
)
from app.services import bookmakers as bookmakers_service

router = APIRouter(prefix="/me/bookmakers", tags=["me"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


@router.get("")
async def bookmaker_names(user: CurrentUser, db: DbSession) -> list[str]:
    """Названия для выбора в формах: не скрытые, частые первыми."""
    return await bookmakers_service.form_names(db, user)


@router.get("/list")
async def list_bookmakers(user: CurrentUser, db: DbSession) -> BookmakersOut:
    """Список кабинета: действующие и скрытые, у каждого — число ставок, в игре и сумма."""
    return await bookmakers_service.list_bookmakers(db, user)


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_bookmaker(
    body: BookmakerCreateIn, user: CurrentUser, db: DbSession
) -> BookmakerOut:
    """Добавить букмекера. Название занято (без учета регистра, и у скрытого) — 409
    bookmaker.name_taken; «Другой» — 422 bookmaker.reserved."""
    return await bookmakers_service.create_bookmaker(db, user, body.name)


@router.patch("/{bookmaker_id}")
async def update_bookmaker(
    bookmaker_id: RowId, body: BookmakerPatchIn, user: CurrentUser, db: DbSession
) -> BookmakerOut:
    """Переименовать (сохраненные ставки остаются с прежним названием) и скрыть или
    вернуть (archived). Скрыть со ставками в игре — 409 bookmaker.open_bets."""
    return await bookmakers_service.update_bookmaker(
        db, user, bookmaker_id, name=body.name, archived=body.archived
    )


@router.delete("/{bookmaker_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_bookmaker(bookmaker_id: RowId, user: CurrentUser, db: DbSession) -> Response:
    """Убрать из списка. Есть ставки в игре с этим названием — 409 bookmaker.open_bets."""
    await bookmakers_service.delete_bookmaker(db, user, bookmaker_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
