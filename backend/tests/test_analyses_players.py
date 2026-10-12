"""Игрок из текста (resolve_player): тезки различаются свежестью матчей, а не id.

Сквозной прогон на настоящем архиве нашел ошибку: при равном сходстве побеждал меньший
id, то есть старый тезка. «Medvedev» из линии букмекера предлагал Андрея Медведева
(последний матч в 2001 году), а кнопка «Да, это Medvedev» подтверждала его одним
нажатием.
"""

from datetime import UTC, date, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Match, Player, Tournament
from app.services.analysis_input import resolve_player


async def _played(db: AsyncSession, player: Player, rival: Player, day: date, ref: str) -> None:
    tournament = Tournament(
        name=f"Cup {ref}", surface="hard", start_date=day, source="sackmann", source_ref=ref
    )
    db.add(tournament)
    await db.flush()
    db.add(
        Match(
            tournament_id=tournament.id,
            round="R32",
            match_date=day,
            player1_id=player.id,
            player2_id=rival.id,
            winner_id=player.id,
            score="6-3 6-4",
            status="finished",
            source="sackmann",
            source_ref=f"{ref}-1",
        )
    )


async def test_active_namesake_goes_first(db: AsyncSession) -> None:
    today = datetime.now(UTC).date()
    andrei = Player(name="Andrei Medvedev", name_ru="Андрей Медведев", country="UKR")
    rival = Player(name="Some Rival", country="FRA")
    db.add_all([andrei, rival])
    await db.flush()
    daniil = Player(name="Daniil Medvedev", name_ru="Даниил Медведев", country="RUS")
    db.add(daniil)
    await db.flush()
    assert andrei.id < daniil.id
    await _played(db, andrei, rival, date(2001, 5, 1), "2001-1")
    await _played(db, daniil, rival, today - timedelta(days=20), "now-1")
    await db.commit()

    for raw, latin in (("Медведев", "Medvedev"), ("Д. Медведев", "Medvedev D.")):
        pick = await resolve_player(db, raw, latin)
        assert pick.best is not None and pick.best.player_id == daniil.id, raw
        # Тезки похожи одинаково: участник все равно подтверждает выбор
        assert pick.status == "check"
        assert {item.player_id for item in pick.candidates} >= {andrei.id, daniil.id}
    # Полное имя старого тезки — он и найден
    named = await resolve_player(db, "Андрей Медведев", "Andrei Medvedev")
    assert named.best is not None and named.best.player_id == andrei.id
