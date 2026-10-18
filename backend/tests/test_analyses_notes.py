"""Пометки исходов в итоге анализа: «в матче есть исход выгоднее» — только когда другой
исход этого матча вошел в экспресс; рынок на проверке (Ф(+1.5)) виден в таблице со своей
причиной, но в экспресс не идет.

Сквозной прогон на настоящих данных: экспресса нет (подходит одно событие), а у
подходящего исхода стояло «В матче есть исход выгоднее», хотя выгоднее в матче не было.
"""

from collections.abc import Iterator
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Analysis
from tests.analysis_helpers import install, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.support import UserFactory


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _result(db: AsyncSession, analysis_id: int) -> dict[str, Any]:
    analysis = await db.get_one(Analysis, analysis_id, populate_existing=True)
    assert analysis.status == "done" and analysis.result is not None
    return analysis.result


async def test_single_candidate_without_express_is_not_picked(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    assert await run(engine, redis, analysis_id) == "done"

    result = await _result(db, analysis_id)
    assert result["express"] is None
    assert result["no_express_key"] == "analysis.express.too_few"
    notes = {
        (row["market"], row["selection"]): row["note_key"]
        for row in result["matches"][0]["markets"]
    }
    # Победа Синнера по правилам подходит, но экспресса из одного события нет
    assert notes[("ML", 1)] == "analysis.leg.not_picked"
    assert "analysis.leg.not_best" not in notes.values()


async def test_leg_beside_chosen_one_is_not_best(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(
        db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"

    result = await _result(db, analysis_id)
    assert result["express"] is not None
    for match in result["matches"]:
        chosen = [row for row in match["markets"] if row["in_express"]]
        assert len(chosen) == 1
        for row in match["markets"]:
            # Исход матча, у которого в экспрессе другой исход, не бывает «не вошел»
            assert row["note_key"] != "analysis.leg.not_picked"


@pytest.mark.usefixtures("suspend_plus")
async def test_suspended_market_is_shown_but_not_picked(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    # Кэфы на Ф(+1.5) обеих сторон с большим валуем: исходы есть в таблице с вероятностью
    # и кэфом, но в экспресс не идут, а причина — «рынок на проверке»
    member = await make_user()
    analysis_id = await make_analysis(
        db,
        redis,
        member.user,
        world,
        ("sinner", "rune"),
        ("djokovic", "rublev"),
        plus=("1.40", "1.75"),
    )
    assert await run(engine, redis, analysis_id) == "done"

    result = await _result(db, analysis_id)
    express = result["express"]
    assert express is not None
    assert all(leg["market"] != "HCP_+1.5" for leg in express["legs"])
    for match in result["matches"]:
        rows = [row for row in match["markets"] if row["market"] == "HCP_+1.5"]
        assert len(rows) == 2
        for row in rows:
            assert row["odds"] is not None and row["p_final"] > 0
            assert not row["in_express"]
            assert row["note_key"] == "analysis.leg.market_suspended"
