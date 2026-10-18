"""Еженедельная перекалибровка базовой модели (этап 5, В6 Р25, Т12, Т13): версия с датой,
включение по правилу «не хуже прежней на отложенной части» (лог-лосс +0,01, Brier
+0,005), иначе rejected; уведомления администратору, откат; досье и прогнозы берут
калибровку активной версии (и поправку модели сетов); проверка по месяцам и
GET /api/ml/model."""

import threading
from datetime import date
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import AdminAuditLog, MlModel, Notification
from app.db.session import create_sessionmaker
from app.ml.backtest import PlattScaling
from app.ml.elo import MODEL_ID, rebuild_ratings
from app.ml.model_versions import CALIBRATION_KIND, SETS_KEY, active_model_id, model_params
from app.ml.sets import SETS_PLATT
from app.services import recalibration
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.ml_world import make_world, store_world
from tests.support import ClientFactory, LoginFn, UserFactory

TODAY = date(2026, 1, 12)


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> None:
    data = make_world(
        players=60, years=range(2023, 2026), tournaments_per_year=12, draw=32, seed=17,
        dated_from=2023,
    )  # fmt: skip
    await store_world(db, data)
    await rebuild_ratings(db_factory=create_sessionmaker(engine))


async def test_no_model_is_skipped(db: AsyncSession) -> None:
    result = await recalibration.recalibrate(db, today=TODAY)
    assert (result.decision, result.reason, result.version) == ("skipped", "ml.no_model", None)


async def test_recalibration_activates_rejects_and_rolls_back(
    db: AsyncSession,
    world: None,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    assert await active_model_id(db) == MODEL_ID
    # Подбор моделей сетов и геймов — в потоке, не в цикле событий воркера (M3 волны 3)
    in_main: list[bool] = []
    layers = recalibration._choose_layers

    def spy(*args: Any) -> Any:
        in_main.append(threading.current_thread() is threading.main_thread())
        return layers(*args)

    monkeypatch.setattr(recalibration, "_choose_layers", spy)

    result = await recalibration.recalibrate(db, today=TODAY)
    assert result.decision == "activated" and result.reason is None
    assert in_main == [False]
    version = result.version
    assert version is not None and version.id == f"{MODEL_ID}@{TODAY.isoformat()}"
    assert version.status == "active" and version.auto is True
    assert version.n_train > version.n_holdout >= recalibration.MIN_HOLDOUT
    assert version.diff_log_loss is not None
    assert version.diff_log_loss.high <= recalibration.LOG_LOSS_MARGIN
    assert version.diff_brier is not None and version.platt_b is not None
    # Прежняя калибровка перенесена в версию с датой и ушла в архив
    rows = list(
        await db.scalars(
            select(MlModel).where(MlModel.kind == CALIBRATION_KIND).order_by(MlModel.id)
        )
    )
    assert [row.status for row in rows] == ["archived", "active"]
    baseline_id = rows[0].id
    assert rows[1].parent_id == baseline_id and rows[0].params["platt"] is None
    # Досье и прогнозы — по активной версии
    assert await active_model_id(db) == version.id
    params = await model_params(db)
    assert params["platt"] == {"a": version.platt_a, "b": version.platt_b}
    assert "surface_weight" in params
    # Поправка модели сетов подобрана вместе с калибровкой: до 2 побед — новая (в мире все
    # матчи 2:0, с ней Brier форы −1.5 ниже), до 3 побед матчей нет — прежние SETS_PLATT
    report = rows[1].metrics["sets"]
    assert report["3"]["taken"] is True and report["3"]["n_holdout"] >= recalibration.MIN_HOLDOUT
    assert report["3"]["brier"] <= report["3"]["prev_brier"]
    assert report["5"] == {
        "fitted": None,
        "n_holdout": 0,
        "brier": None,
        "prev_brier": None,
        "taken": False,
    }
    assert rows[1].params[SETS_KEY] == {"3": report["3"]["fitted"], "5": SETS_PLATT[5].to_json()}
    assert params[SETS_KEY] == rows[1].params[SETS_KEY]
    variants = list(
        await db.scalars(
            select(Notification.params["variant"].astext).where(Notification.user_id == admin.id)
        )
    )
    assert variants == ["model_recalibrated"]
    audit = await db.scalar(select(AdminAuditLog).where(AdminAuditLog.action == "model_on"))
    assert audit is not None and audit.details["activated"] is True

    # Хуже прежней — не включается
    monkeypatch.setattr(recalibration, "_fit", lambda items: PlattScaling(a=1.2, b=0.2))
    rejected = await recalibration.recalibrate(db, today=TODAY)
    assert rejected.decision == "rejected" and rejected.reason == "ml.worse_log_loss"
    assert rejected.version is not None and rejected.version.status == "rejected"
    assert rejected.version.id == f"{MODEL_ID}@{TODAY.isoformat()}-2"
    assert await active_model_id(db) == version.id

    model = (await member.client.get("/api/ml/model")).json()
    assert model["active"]["id"] == version.id
    assert [item["status"] for item in model["versions"]] == ["rejected", "active", "archived"]
    assert [item["can_rollback"] for item in model["versions"]] == [False, False, True]
    # Проверка по месяцам: 6 месяцев до сегодня (месяцы без матчей пропущены)
    months = [item["month"] for item in model["walk_forward"]]
    assert 3 <= len(months) <= 6 and months == sorted(months)
    assert months[0] >= "2025-07-01" and months[-1] <= "2025-12-01"
    assert all(item["n"] > 0 and item["market_brier"] is not None for item in model["walk_forward"])
    assert model["calibration"] and model["rule"]["brier_margin"] == 0.005
    assert model["claude_min_events"] == 300 and model["next_run"] >= TODAY.isoformat()

    # Откат — администратор; вернуть можно только бывшую активной
    bad = await admin.client.post(f"/api/admin/ml/models/{rejected.version.id}/rollback")
    assert bad.status_code == 409 and error_code(bad) == "ml.cannot_rollback"
    missing = await admin.client.post("/api/admin/ml/models/elo-v9/rollback")
    assert missing.status_code == 404
    back = await admin.client.post(f"/api/admin/ml/models/{baseline_id}/rollback")
    assert back.status_code == 200, back.text
    assert back.json()["active"]["id"] == baseline_id
    assert back.json()["active"]["auto"] is False
    assert await active_model_id(db) == baseline_id
    assert (await model_params(db)).get("platt") is None
    assert (await model_params(db)).get(SETS_KEY) is None
