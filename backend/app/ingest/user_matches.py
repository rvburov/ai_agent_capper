"""Матч из ввода участника (matches.source = 'user') на месте архивной строки (Т14).

Анализ идет до матча, и матча архива еще нет: attach_matches создает свой матч с турниром
и кругом из ввода. Если они совпали с архивными, user-матч занимает ключ
UNIQUE(tournament_id, round, player1_id, player2_id), и загрузчик не смог бы записать
настоящую строку. Поэтому загрузчик:
1. освобождает ключ: у user-матча круг временно становится «#<id>» (hold);
2. пишет архивную строку;
3. сливает user-матч в нее (app/services/players.py, merge_matches): события ставок,
   прогнозы, кэфы и досье переходят к архивной строке (сторона исхода переворачивается,
   если порядок игроков другой), user-матч удаляется.
Строка архива так и не записалась — круг возвращается (restore). Слить не удалось
(например, прогнозы одного анализа на оба матча) — user-матч остается с кругом «#<id>»,
а в отчете загрузки — предупреждение и команда matches-merge. User-матч с обратным
порядком игроков (первым участник ввел будущего проигравшего) ключ строки не занимает:
шаг 1 ему не нужен, а слияние на шаге 3 то же, с переворотом стороны.

Сакманн находит такой матч сам: по турниру, кругу и паре игроков он «усыновляет» матч
базы любого источника на месте (тот же id, сторона переворачивается) — там нужен только
отчет (app/ingest/sackmann.py).
"""

from collections.abc import Mapping, Sequence
from typing import Any, cast

from sqlalchemy import Table, bindparam, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import Match

USER_SOURCE = "user"
HOLD_MARK = "#"


def is_user(row: Any) -> bool:
    return bool(getattr(row, "source", None) == USER_SOURCE)


def held_round(match_id: int) -> str:
    """Временный круг user-матча, освободившего ключ (уникален: в нем id)."""
    return f"{HOLD_MARK}{match_id}"


async def _set_rounds(db: AsyncSession, rounds: Mapping[int, str]) -> None:
    if not rounds:
        return
    table = cast(Table, Match.__table__)
    stmt = update(table).where(table.c.id == bindparam("match_id")).values(round=bindparam("value"))
    await db.execute(
        stmt, [{"match_id": match_id, "value": value} for match_id, value in rounds.items()]
    )


async def hold(db: AsyncSession, match_ids: Sequence[int]) -> None:
    """Освободить ключ турнира и круга: круг user-матчей — «#<id>»."""
    await _set_rounds(db, {match_id: held_round(match_id) for match_id in match_ids})


async def restore(db: AsyncSession, rounds: Mapping[int, str]) -> None:
    """Вернуть прежний круг user-матчам, архивная строка которых не записалась."""
    await _set_rounds(db, rounds)


async def merge_into_archive(db: AsyncSession, user_match_id: int, archive_match_id: int) -> bool:
    """Слить user-матч в архивную строку в точке сохранения (без commit). False — слить
    нельзя (конфликт прогнозов и т. п.): база не изменилась."""
    # Импорт здесь: app.services.players сам импортирует загрузчик Сакманна
    from app.services.players import merge_matches

    try:
        await merge_matches(
            db, source_match_id=user_match_id, target_match_id=archive_match_id, commit=False
        )
    except AppError:
        return False
    return True
