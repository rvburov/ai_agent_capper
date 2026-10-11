"""Турнир события из ввода: выпуск текущего года — только того же турнира.

Сквозной прогон на настоящих данных нашел ошибку: «Shanghai Masters» без выпуска этого
года находил «Rome Masters» этого года (общее слово Masters дает сходство 0,47), и
матч получал чужой турнир, категорию и покрытие.
"""

from datetime import date

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Tournament
from app.services.analysis_input import resolve_tournament

TODAY = date(2026, 10, 11)


def _tournament(name: str, start: date, surface: str, ref: str) -> Tournament:
    return Tournament(
        name=name,
        category="masters",
        surface=surface,
        best_of=3,
        start_date=start,
        source="sackmann",
        source_ref=ref,
    )


async def test_masters_without_current_edition_is_not_another_masters(db: AsyncSession) -> None:
    rome = _tournament("Rome Masters", date(2026, 5, 6), "clay", "2026-0416")
    db.add_all(
        [
            rome,
            _tournament("Madrid Masters", date(2026, 4, 22), "clay", "2026-1536"),
            _tournament("Shanghai Masters", date(2025, 10, 1), "hard", "2025-5014"),
            _tournament("Shanghai Masters", date(2024, 10, 2), "hard", "2024-5014"),
        ]
    )
    await db.commit()

    for query in ("Shanghai Masters", "shanghai", "Rolex Shanghai Masters"):
        guess = await resolve_tournament(db, query, today=TODAY)
        assert guess is not None
        # Выпуска этого года нет: турнир будет создан, покрытие и категория — из 2025
        assert (guess.id, guess.name, guess.surface, guess.category) == (
            None,
            "Shanghai Masters",
            "hard",
            "masters",
        ), query

    same = await resolve_tournament(db, "Rome Masters", today=TODAY)
    assert same is not None and same.id == rome.id


async def test_current_edition_of_same_tournament_is_found(db: AsyncSession) -> None:
    current = _tournament("Shanghai Masters", date(2026, 10, 1), "hard", "2026-5014")
    db.add_all(
        [
            current,
            _tournament("Shanghai Masters", date(2025, 10, 1), "hard", "2025-5014"),
            _tournament("Rome Masters", date(2026, 5, 6), "clay", "2026-0416"),
        ]
    )
    await db.commit()

    guess = await resolve_tournament(db, "Shanghai Masters", today=TODAY)
    assert guess is not None and guess.id == current.id
