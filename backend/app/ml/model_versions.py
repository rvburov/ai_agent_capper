"""Версии базовой модели (этап 5, Т12, Т13): строки ml_models вида calibration с id
«elo-v1@ГГГГ-ММ-ДД» — калибровка Платта поверх Эло elo-v1 (params.platt), со статусом
(одна активная), parent_id и тем, кто включил.

Строка elo-v1 остается моделью Эло (вес покрытия, параметры рейтинга; ее пишут пересчет
рейтингов и бэктест). Досье и проверка уроков берут ее params, а калибровку — из активной
версии, если она есть (model_params). Прогноз помнит, какой версией сделан
(predictions.ml_model_id — active_model_id): прогнозы до и после перекалибровки
различимы. Пока версий нет (до первой перекалибровки), действует калибровка elo-v1.

Снимок модели (ModelSnapshot) берется один раз в начале анализа и идет в каждое досье:
p_base и ml_model_id прогноза — от одной версии, даже если посреди анализа включилась
новая калибровка (m1 волны 3). Замороженный набор закрепляет свою версию при заморозке
(pinned_for_set): досье набора и p_base прогонов не зависят от поздних перекалибровок.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import MlModel
from app.ml.elo import MODEL_ID

# Вид строки версии калибровки (одна активная на вид — частичный UNIQUE)
CALIBRATION_KIND = "calibration"


def version_id(day: str, number: int = 1) -> str:
    """elo-v1@2026-10-19; вторая за день — elo-v1@2026-10-19-2."""
    base = f"{MODEL_ID}@{day}"
    return base if number <= 1 else f"{base}-{number}"


@dataclass(frozen=True)
class ModelSnapshot:
    """Базовая модель для досье: id версии (predictions.ml_model_id) и параметры (elo-v1 и
    калибровка этой версии)."""

    model_id: str | None
    params: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        platt = self.params.get("platt")
        return {
            "model_id": self.model_id,
            "platt": dict(platt) if isinstance(platt, dict) else None,
        }


async def active_calibration(db: AsyncSession) -> MlModel | None:
    found: MlModel | None = await db.scalar(
        select(MlModel)
        .where(MlModel.kind == CALIBRATION_KIND, MlModel.status == "active")
        .execution_options(populate_existing=True)
    )
    return found


async def active_model_id(db: AsyncSession) -> str | None:
    """Чем сделан прогноз: активная версия калибровки, иначе elo-v1 (если она есть)."""
    found = await db.scalar(
        select(MlModel.id).where(MlModel.kind == CALIBRATION_KIND, MlModel.status == "active")
    )
    if found is not None:
        return str(found)
    base = await db.scalar(select(MlModel.id).where(MlModel.id == MODEL_ID))
    return str(base) if base is not None else None


async def _base_params(db: AsyncSession) -> dict[str, Any]:
    params = await db.scalar(select(MlModel.params).where(MlModel.id == MODEL_ID))
    return dict(params or {})


def _with_platt(base: dict[str, Any], version: Any) -> dict[str, Any]:
    merged = dict(base)
    if isinstance(version, dict) and isinstance(version.get("platt"), dict):
        merged["platt"] = dict(version["platt"])
    return merged


async def snapshot(db: AsyncSession, model_id: str | None = None) -> ModelSnapshot:
    """Снимок базовой модели: model_id None — активная версия (иначе elo-v1); заданный id —
    эта версия (в том числе в архиве: анализ, начатый до перекалибровки, досчитывается
    ею). Версии с таким id нет — активная."""
    base = await _base_params(db)
    if model_id is not None and model_id != MODEL_ID:
        row = await db.scalar(
            select(MlModel.params).where(MlModel.id == model_id, MlModel.kind == CALIBRATION_KIND)
        )
        if row is not None:
            return ModelSnapshot(model_id, _with_platt(base, row))
    if model_id == MODEL_ID:
        return ModelSnapshot(MODEL_ID if base else None, base)
    active = (
        await db.execute(
            select(MlModel.id, MlModel.params).where(
                MlModel.kind == CALIBRATION_KIND, MlModel.status == "active"
            )
        )
    ).first()
    if active is not None:
        return ModelSnapshot(str(active[0]), _with_platt(base, active[1]))
    base_id = await db.scalar(select(MlModel.id).where(MlModel.id == MODEL_ID))
    return ModelSnapshot(str(base_id) if base_id is not None else None, base)


async def model_params(db: AsyncSession) -> dict[str, Any]:
    """Параметры базовой модели для досье и проверки уроков: elo-v1 и калибровка
    активной версии поверх нее."""
    return (await snapshot(db)).params


async def pinned_for_set(db: AsyncSession, since: date) -> ModelSnapshot:
    """Калибровка для замороженного набора с первым днем since (m4 волны 3): активная
    версия, если ее обучающая часть кончилась до since; иначе самая поздняя такая версия
    (кроме отклоненных); иначе — калибровка elo-v1, если она обучена до since; иначе Эло
    без калибровки. Так p_base набора не подобран на исходах его матчей."""
    base = await _base_params(db)
    rows = (
        await db.execute(
            select(MlModel.id, MlModel.params, MlModel.status, MlModel.train_to)
            .where(
                MlModel.kind == CALIBRATION_KIND,
                MlModel.status != "rejected",
                MlModel.train_to.is_not(None),
                MlModel.train_to < since,
            )
            .order_by(MlModel.train_to.desc(), MlModel.created_at.desc())
        )
    ).all()
    picked = next((row for row in rows if row[2] == "active"), rows[0] if rows else None)
    if picked is not None:
        return ModelSnapshot(str(picked[0]), _with_platt(base, picked[1]))
    base_row = (
        await db.execute(select(MlModel.id, MlModel.train_to).where(MlModel.id == MODEL_ID))
    ).first()
    if base_row is None:
        return ModelSnapshot(None, {})
    fit_to = _base_fit_to(base, base_row[1])
    if fit_to is not None and fit_to < since:
        return ModelSnapshot(MODEL_ID, base)
    return ModelSnapshot(MODEL_ID, {key: value for key, value in base.items() if key != "platt"})


def _base_fit_to(params: dict[str, Any], train_to: date | None) -> date | None:
    """Последний день, на котором подобрана калибровка elo-v1: бэктест подбирает Платта на
    calib_years (конец последнего года), иначе — train_to строки."""
    years = params.get("calib_years")
    if isinstance(years, list) and years:
        try:
            return date(max(int(year) for year in years), 12, 31)
        except (TypeError, ValueError):
            return train_to
    return train_to


def stored_snapshot(raw: Any, base: dict[str, Any]) -> ModelSnapshot | None:
    """Снимок, закрепленный в eval_sets.rules.calibration (model_id и Платт) поверх
    параметров Эло elo-v1. Нет записи — None."""
    if not isinstance(raw, dict):
        return None
    params = {key: value for key, value in base.items() if key != "platt"}
    platt = raw.get("platt")
    if isinstance(platt, dict):
        params["platt"] = dict(platt)
    model_id = raw.get("model_id")
    return ModelSnapshot(str(model_id) if model_id else None, params)
