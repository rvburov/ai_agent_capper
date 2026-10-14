"""«Мои букмекеры» (В9, Р24): список для выбора при анализе и сохранении ставки.

Добавить, переименовать, скрыть и вернуть; удалить — только букмекера без ставок в игре.
Балансов и сверки с банком нет (позже). Название уникально у участника без учета регистра.

bets.bookmaker и analyses.bookmaker — строки: переименование не меняет сохраненные ставки
(в истории остается прежнее название), число ставок у букмекера считается по совпадению
названия без учета регистра. Регистр приводит только PostgreSQL (lower, как в уникальном
индексе): у lower в Python для «İ» и конечной «ς» другой результат, и ставки «İddaa» не
нашлись бы. Скрытый не предлагается в формах (GET /api/me/bookmakers), но
виден в кабинете и в истории ставок. Скрыть или удалить букмекера со ставками в игре нельзя
(409): после расчета — можно (макет: «Пока нельзя скрыть»).

Новое название, с которым участник сохранил ставку или запустил анализ, попадает в список
само (remember): иначе букмекер из поля «Другой» пропал бы из выбора. Скрытого это не
возвращает.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, func, literal, select, union_all
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import Analysis, Bet, Bookmaker, User
from app.schemas.cabinet import BookmakerOut, BookmakersOut
from app.services.app_settings import get_app_settings
from app.services.sessions import utcnow

# Букмекеров у участника — не больше: список для выбора, а не справочник
MAX_BOOKMAKERS = 50
# Добавления одного участника — по очереди, иначе параллельные пройдут проверку числа вместе
BOOKMAKERS_LOCK = 0x626F6F6B00000000
_ZERO = Decimal(0)


def _key(name: str) -> str:
    """Ключ в Python — только для «Другой» и повторов внутри одного списка: сравнение с
    базой — через _sql_key."""
    return name.strip().lower()


def _sql_key(value: Any) -> ColumnElement[str]:
    """Название без учета регистра — в PostgreSQL, как у индекса и счетчиков ставок."""
    return func.lower(func.btrim(value))


def _check_reserved(name: str) -> None:
    """«Другой» уже есть в выборе при анализе: так назвать букмекера нельзя."""
    if _key(name) == _key(t("bookmakers.other")):
        raise AppError(422, "bookmaker.reserved", name=name)


@dataclass(frozen=True)
class _Usage:
    bets: int
    open_bets: int
    in_play: Decimal


async def _usage(db: AsyncSession, user_id: int) -> dict[str, _Usage]:
    """Ставки по названию без учета регистра: всего, в игре и сумма в игре."""
    rows = await db.execute(
        select(
            _sql_key(Bet.bookmaker),
            func.count(),
            func.count().filter(Bet.status == "open"),
            func.coalesce(func.sum(Bet.stake).filter(Bet.status == "open"), 0),
        )
        .where(Bet.user_id == user_id)
        .group_by(_sql_key(Bet.bookmaker))
    )
    return {
        str(name): _Usage(int(total), int(open_count), Decimal(in_play))
        for name, total, open_count, in_play in rows
    }


async def _uses(db: AsyncSession, user_id: int) -> dict[str, int]:
    """Сколько раз название встречается в ставках и анализах (порядок в формах)."""
    names = union_all(
        select(_sql_key(Bet.bookmaker).label("name")).where(Bet.user_id == user_id),
        select(_sql_key(Analysis.bookmaker).label("name")).where(
            Analysis.user_id == user_id, Analysis.bookmaker.is_not(None)
        ),
    ).subquery()
    rows = await db.execute(select(names.c.name, func.count()).group_by(names.c.name))
    return {str(name): int(count) for name, count in rows}


async def _rows(db: AsyncSession, user_id: int) -> list[tuple[Bookmaker, str]]:
    """Букмекеры участника с ключом названия из базы (_sql_key)."""
    found = await db.execute(
        select(Bookmaker, _sql_key(Bookmaker.name))
        .where(Bookmaker.user_id == user_id)
        .order_by(Bookmaker.id)
    )
    return [(row, str(key)) for row, key in found.all()]


async def _row_key(db: AsyncSession, row: Bookmaker) -> str:
    return str(await db.scalar(select(_sql_key(literal(row.name)))))


async def form_names(db: AsyncSession, user: User) -> list[str]:
    """Названия для выбора в формах: не скрытые, частые первыми, затем по алфавиту."""
    rows = [(row, key) for row, key in await _rows(db, user.id) if row.archived_at is None]
    uses = await _uses(db, user.id)
    rows.sort(key=lambda item: (-uses.get(item[1], 0), item[0].name.lower()))
    return [row.name for row, _ in rows]


def _out(row: Bookmaker, key: str, usage: dict[str, _Usage]) -> BookmakerOut:
    used = usage.get(key, _Usage(0, 0, _ZERO))
    return BookmakerOut(
        id=row.id,
        name=row.name,
        created_at=row.created_at,
        archived_at=row.archived_at,
        bets=used.bets,
        open_bets=used.open_bets,
        in_play=used.in_play,
    )


async def list_bookmakers(db: AsyncSession, user: User) -> BookmakersOut:
    """Список кабинета: сначала действующие, затем скрытые; внутри — по алфавиту."""
    settings = await get_app_settings(db)
    rows = await _rows(db, user.id)
    usage = await _usage(db, user.id)
    rows.sort(key=lambda item: (item[0].archived_at is not None, item[0].name.lower()))
    return BookmakersOut(
        currency=settings.currency,  # type: ignore[arg-type]
        items=[_out(row, key, usage) for row, key in rows],
    )


async def _owned(db: AsyncSession, user: User, bookmaker_id: int) -> Bookmaker:
    """Свой букмекер под блокировкой строки. Чужой или несуществующий — 404."""
    row = await db.scalar(
        select(Bookmaker)
        .where(Bookmaker.id == bookmaker_id, Bookmaker.user_id == user.id)
        .with_for_update()
    )
    if row is None:
        raise AppError(404, "bookmaker.not_found")
    return row


async def _name_taken(
    db: AsyncSession, user_id: int, name: str, *, except_id: int | None = None
) -> bool:
    stmt = select(Bookmaker.id).where(
        Bookmaker.user_id == user_id, func.lower(Bookmaker.name) == func.lower(literal(name))
    )
    if except_id is not None:
        stmt = stmt.where(Bookmaker.id != except_id)
    return await db.scalar(stmt.limit(1)) is not None


async def _commit_unique(db: AsyncSession, name: str) -> None:
    """Commit; параллельное добавление того же названия — 409, а не 500."""
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise AppError(409, "bookmaker.name_taken", name=name) from None


async def create_bookmaker(db: AsyncSession, user: User, name: str) -> BookmakerOut:
    """Новый букмекер. Название занято (и у скрытого) — 409, больше 50 — 409."""
    _check_reserved(name)
    await db.execute(select(func.pg_advisory_xact_lock(BOOKMAKERS_LOCK + user.id)))
    if await _name_taken(db, user.id, name):
        raise AppError(409, "bookmaker.name_taken", name=name)
    count = await db.scalar(
        select(func.count()).select_from(Bookmaker).where(Bookmaker.user_id == user.id)
    )
    if int(count or 0) >= MAX_BOOKMAKERS:
        raise AppError(409, "bookmaker.too_many", max=MAX_BOOKMAKERS)
    row = Bookmaker(user_id=user.id, name=name, created_at=utcnow())
    db.add(row)
    await _commit_unique(db, name)
    return _out(row, await _row_key(db, row), await _usage(db, user.id))


async def _open_bets(db: AsyncSession, user_id: int, name: str) -> tuple[int, Decimal]:
    row = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Bet.stake), 0)).where(
                Bet.user_id == user_id,
                Bet.status == "open",
                _sql_key(Bet.bookmaker) == _sql_key(literal(name)),
            )
        )
    ).one()
    return int(row[0]), Decimal(row[1])


async def _ensure_no_open(db: AsyncSession, user: User, row: Bookmaker, code: str) -> None:
    count, in_play = await _open_bets(db, user.id, row.name)
    if count:
        settings = await get_app_settings(db)
        raise AppError(
            409,
            code,
            name=row.name,
            open_bets=count,
            in_play=str(in_play),
            currency=settings.currency,
        )


async def update_bookmaker(
    db: AsyncSession,
    user: User,
    bookmaker_id: int,
    *,
    name: str | None,
    archived: bool | None,
) -> BookmakerOut:
    """Переименовать и/или скрыть (вернуть). Переименование не трогает сохраненные
    ставки. Скрыть букмекера со ставками в игре нельзя — 409 bookmaker.open_bets."""
    row = await _owned(db, user, bookmaker_id)
    if name is not None and name != row.name:
        _check_reserved(name)
        if await _name_taken(db, user.id, name, except_id=row.id):
            raise AppError(409, "bookmaker.name_taken", name=name)
        row.name = name
    if archived is True and row.archived_at is None:
        await _ensure_no_open(db, user, row, "bookmaker.open_bets")
        row.archived_at = utcnow()
    elif archived is False:
        row.archived_at = None
    await _commit_unique(db, row.name)
    return _out(row, await _row_key(db, row), await _usage(db, user.id))


async def delete_bookmaker(db: AsyncSession, user: User, bookmaker_id: int) -> None:
    """Удаляет букмекера из списка. Ставки с ним остаются (название — строка в ставке).
    Есть ставки в игре — 409 bookmaker.open_bets."""
    row = await _owned(db, user, bookmaker_id)
    await _ensure_no_open(db, user, row, "bookmaker.open_bets")
    await db.delete(row)
    await db.commit()


async def remember(
    db: AsyncSession, user_id: int, names: Sequence[str | None], *, restore: bool = False
) -> None:
    """Названия, с которыми участник сохранил ставку или запустил анализ, — в список,
    если такого еще нет (и скрытого тоже). restore — скрытого вернуть в список: у
    букмекера появилась ставка в игре, а скрытым может быть только букмекер без них.
    «Другой» и пустое не добавляются. flush; commit — за вызывающим."""
    reserved = _key(t("bookmakers.other"))
    seen: set[str] = set()
    for raw in names:
        name = (raw or "").strip()[:64]
        key = name.lower()
        if not name or key == reserved or key in seen:
            continue
        seen.add(key)
        stmt = insert(Bookmaker).values(user_id=user_id, name=name, created_at=utcnow())
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=[Bookmaker.user_id, func.lower(Bookmaker.name)],
                set_={"archived_at": None},
                where=Bookmaker.archived_at.is_not(None),
            )
            if restore
            else stmt.on_conflict_do_nothing(
                index_elements=[Bookmaker.user_id, func.lower(Bookmaker.name)]
            )
        )
