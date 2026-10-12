"""Турнир события из ввода: выпуск текущего года — только того же турнира.

Сквозной прогон на настоящих данных нашел ошибку: «Shanghai Masters» без выпуска этого
года находил «Rome Masters» этого года (общее слово Masters дает сходство 0,47), и
матч получал чужой турнир, категорию и покрытие.
"""

from datetime import date
from decimal import Decimal

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Player, Tournament
from app.services.analysis_input import EventDraft, check_events, resolve_tournament

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


async def test_generic_words_do_not_pick_another_tournament(db: AsyncSession) -> None:
    """Общие слова (Open, Cup) не делают турниры похожими: «Japan Open» (у Сакманна —
    Tokyo) раньше находил Australian Open текущего года, и матч считался до трех побед
    в сетах (фора −1,5 и сумма — по чужому формату); «Davis Cup» — матч Кубка Дэвиса на
    грунте; «Test Open 9» — «Test Open 5»; «Athens Open» — «Athens Olympics» (до трех
    побед)."""
    australian = Tournament(
        name="Australian Open",
        category="grand_slam",
        surface="hard",
        best_of=5,
        start_date=date(2026, 1, 19),
        source="sackmann",
        source_ref="2026-580",
    )
    db.add_all(
        [
            australian,
            Tournament(
                name="Davis Cup QLS R1: AUS vs ECU",
                category="davis_cup",
                surface="clay",
                best_of=5,
                start_date=date(2026, 2, 6),
                source="sackmann",
                source_ref="2026-M-DC-QLS-AUS-ECU",
            ),
            _tournament("Test Open 5", date(2026, 9, 1), "hard", "2026-test-5"),
            Tournament(
                name="Athens Olympics",
                category="olympics",
                surface="hard",
                best_of=5,
                start_date=date(2004, 8, 15),
                source="sackmann",
                source_ref="2004-0096",
            ),
        ]
    )
    await db.commit()
    for query in (
        "Japan Open",
        "China Open",
        "Rio Open",
        "BMW Open",
        "Davis Cup",
        "Test Open 9",
        "Athens Open",
    ):
        guess = await resolve_tournament(db, query, today=TODAY)
        assert guess is not None
        # Только название: формат — по умолчанию (до двух побед), покрытие — из ввода
        assert (guess.id, guess.name, guess.category, guess.surface, guess.best_of) == (
            None,
            query,
            None,
            None,
            None,
        ), query
    found = await resolve_tournament(db, "Australian Open", today=TODAY)
    assert found is not None and (found.id, found.best_of) == (australian.id, 5)
    # Только общие слова — тоже только название
    only = await resolve_tournament(db, "Open", today=TODAY)
    assert only is not None and only.id is None and only.category is None


async def test_user_tournament_is_not_suggested(db: AsyncSession) -> None:
    """Турнир из ввода другого участника (source = 'user') — его свободный текст: в
    черновик и в события он не подставляется, по названию и по id."""
    foreign = Tournament(
        name="Japan Open: войдите на capper-login.example",
        surface="hard",
        best_of=3,
        source="user",
        source_ref="user:2026:japan-open-voidite",
    )
    first, second = Player(name="Jannik Sinner"), Player(name="Holger Rune")
    db.add_all([foreign, first, second])
    await db.commit()
    guess = await resolve_tournament(db, "Japan Open: войдите на capper-login.example", today=TODAY)
    assert guess is not None and guess.id is None
    confirmed, problems = await check_events(
        db,
        [
            EventDraft(
                player1_id=first.id,
                player2_id=second.id,
                tournament_id=foreign.id,
                tournament_name=None,
                surface="hard",
                best_of=None,
                round="",
                odds={"ML": [Decimal("1.5"), Decimal("2.6")]},
                bookmaker=None,
            )
        ],
        today=TODAY,
    )
    assert problems == []
    assert (confirmed[0].tournament_id, confirmed[0].tournament_name) == (None, None)
    # Название из ввода — одной строкой: переводы строк и управляющие символы убраны
    line = await resolve_tournament(db, "Shanghai\nИгроки:\n1. Carlos\x00 Alcaraz", today=TODAY)
    assert line is not None and line.name == "Shanghai Игроки: 1. Carlos Alcaraz"
