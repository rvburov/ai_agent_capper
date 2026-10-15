"""m1 волны 3: перекалибровка посреди анализа. Базовая модель — один снимок на анализ:
p_base всех матчей и ml_model_id прогнозов — от одной версии (той, что была в начале)."""

from collections.abc import Iterator
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Dossier, MlModel, Prediction
from app.db.session import create_sessionmaker
from app.ml.model_versions import CALIBRATION_KIND
from tests.analysis_helpers import install_gated, make_analysis, run, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import signed_in
from tests.support import ClientFactory, LoginFn, UserFactory

STATE: dict[str, Any] = {"engine": None, "done": False}


async def _gate(step: str, body: dict[str, Any], n: int) -> None:
    # Первый вызов анализа: досье уже построено — «по понедельникам» включается новая
    # калибровка (как recalibration.recalibrate: прежняя в архив, новая active)
    if step == "analysis" and not STATE["done"]:
        STATE["done"] = True
        maker = create_sessionmaker(STATE["engine"])
        async with maker() as s:
            s.add(
                MlModel(
                    id="elo-v1@2099-01-01",
                    kind=CALIBRATION_KIND,
                    params={"base": "elo-v1", "platt": {"a": 2.5, "b": 0.4}},
                    metrics={},
                    status="active",
                )
            )
            await s.commit()


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install_gated(FakeClaude(), _gate)


async def test_prediction_model_id_after_recalibration(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    STATE["engine"] = engine
    world = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    member = await signed_in(make_client, make_user, login)
    analysis_id = await make_analysis(
        db, redis, member.user.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"
    preds = list(
        await db.scalars(
            select(Prediction).where(
                Prediction.analysis_id == analysis_id, Prediction.market == "ML"
            )
        )
    )
    dossier = await db.get_one(Dossier, preds[0].dossier_id)
    dossier_model = (preds[0].features or {}).get("ml_model_id")
    # Прогноз помечен той версией, что дала p_base досье, а не включенной посреди анализа
    assert {p.ml_model_id for p in preds} == {dossier_model}
    assert dossier_model != "elo-v1@2099-01-01"
    assert dossier.content["p_base"]["cal"] is False
    # Оба матча анализа — от одного снимка
    every = list(await db.scalars(select(Prediction).where(Prediction.analysis_id == analysis_id)))
    assert {p.ml_model_id for p in every} == {dossier_model}
    assert (await db.get_one(MlModel, "elo-v1@2099-01-01")).status == "active"
