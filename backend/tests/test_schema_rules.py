"""Ограничения схемы, которые защищают данные от ошибок загрузчиков и сервисов."""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from tests.support import UserFactory


async def _rejected(db: AsyncSession, sql: str) -> bool:
    """True, если база отклонила запрос (изменения откатываются до точки сохранения)."""
    try:
        async with db.begin_nested():
            await db.execute(text(sql))
    except DBAPIError:
        return True
    return False


async def test_match_without_tournament_is_deduplicated_by_source_ref(db: AsyncSession) -> None:
    await db.execute(text("INSERT INTO players (id, name) VALUES (1, 'A'), (2, 'B')"))
    insert = (
        "INSERT INTO matches (tournament_id, player1_id, player2_id, source, source_ref)"
        " VALUES (NULL, 1, 2, '{source}', {ref})"
    )
    # Без турнира и без id записи в источнике повторы было бы не поймать
    assert await _rejected(db, insert.format(source="legacy", ref="NULL"))
    # Без турнира — только история старого бота и матчи из поиска
    assert await _rejected(db, insert.format(source="sackmann", ref="'2024-0339-300'"))
    assert not await _rejected(db, insert.format(source="legacy", ref="'ev-17'"))
    assert await _rejected(db, insert.format(source="legacy", ref="'ev-17'"))
    count = await db.execute(text("SELECT count(*) FROM matches"))
    assert count.scalar_one() == 1


@pytest.mark.parametrize("closing_odds", ["0", "0.99"])
async def test_closing_odds_at_least_one(db: AsyncSession, closing_odds: str) -> None:
    await db.execute(text("INSERT INTO players (id, name) VALUES (1, 'A'), (2, 'B')"))
    await db.execute(
        text(
            "INSERT INTO matches (id, tournament_id, player1_id, player2_id, source, source_ref)"
            " VALUES (1, NULL, 1, 2, 'legacy', 'ev-1')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO users (id, email, display_name, role, status, ai_mode)"
            " VALUES (10, 'x@example.com', 'X', 'member', 'active', 'shared')"
        )
    )
    await db.execute(
        text(
            "INSERT INTO bets (id, user_id, placed_at, bookmaker, stake, currency, total_odds)"
            " VALUES (100, 10, now(), 'bk', 100, 'RUB', 1.5)"
        )
    )
    leg = (
        "INSERT INTO bet_legs (bet_id, match_id, market, selection, odds_taken, closing_odds)"
        " VALUES (100, 1, 'ML', 1, 1.5, {})"
    )
    assert await _rejected(db, leg.format(closing_odds))
    assert not await _rejected(db, leg.format("1.000"))


async def test_ledger_rows_keep_their_bet(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    await db.execute(
        text(
            "INSERT INTO bets (id, user_id, placed_at, bookmaker, stake, currency, total_odds)"
            " VALUES (100, :uid, now(), 'bk', 1000, 'RUB', 1.5)"
        ),
        {"uid": member.id},
    )
    await db.execute(
        text(
            "INSERT INTO bankroll_ledger (user_id, kind, amount, currency, bet_id) VALUES"
            " (:uid, 'deposit', 10000, 'RUB', NULL), (:uid, 'stake', -1000, 'RUB', 100),"
            " (:uid, 'payout', 1500, 'RUB', 100)"
        ),
        {"uid": member.id},
    )
    # Удаление ставки не стирает ее списание и выплату молча
    assert await _rejected(db, "DELETE FROM bets WHERE id = 100")
    total = await db.execute(text("SELECT sum(amount), count(*) FROM bankroll_ledger"))
    assert tuple(total.one()) == (10500, 3)
    # Удаление журнала раньше ставок (порядок сервиса удаления участника) работает
    assert not await _rejected(db, "DELETE FROM bankroll_ledger WHERE bet_id = 100")
    assert not await _rejected(db, "DELETE FROM bets WHERE id = 100")


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO access_codes (kind, code_hash, email, role, ai_mode, limit_monthly_usd,"
        " expires_at) VALUES ('invite', repeat('a', 64), 'x@example.com', 'member', 'shared',"
        " -10, now())",
        "INSERT INTO access_codes (kind, code_hash, email, role, ai_mode, limit_daily_analyses,"
        " expires_at) VALUES ('invite', repeat('b', 64), 'x@example.com', 'member', 'shared',"
        " -3, now())",
        "UPDATE app_settings SET monthly_budget_usd = -5",
        "UPDATE app_settings SET default_daily_analyses = -1",
        "UPDATE app_settings SET per_analysis_soft_usd = 5, per_analysis_hard_usd = 1",
    ],
)
async def test_limits_cannot_be_negative(db: AsyncSession, sql: str) -> None:
    assert await _rejected(db, sql)


async def test_invite_without_limits_is_allowed(db: AsyncSession) -> None:
    sql = (
        "INSERT INTO access_codes (kind, code_hash, email, role, ai_mode, expires_at)"
        " VALUES ('invite', repeat('c', 64), 'x@example.com', 'member', 'shared', now())"
    )
    assert not await _rejected(db, sql)
