"""Версии стратегии участника: активная v3 создается при первом анализе.

Параметры — strategy_versions.params (app/ml/strategy.py, StrategyParams), версия
промпта анализа — prompt_version (analysis.v1). Активная версия у участника одна
(частичный UNIQUE). Испорченные параметры не роняют анализ: берутся значения v3 по
умолчанию, в лог — предупреждение.
"""

import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.prompts import ANALYSIS_PROMPT, load_prompt, load_prompt_id
from app.db.models import StrategyVersion
from app.ml.strategy import StrategyParams
from app.schemas.strategy import (
    DrawdownOut,
    GrowthOut,
    StakeBandOut,
    StrategyOut,
    StrategyParamsOut,
    ValueAdjustOut,
    WeekOut,
)

log = structlog.get_logger(__name__)

V3_CODE = "v3"
V3_NAME = "v3"


def current_prompt_version() -> str:
    """Версия промпта анализа, с которой создается новая версия стратегии."""
    return load_prompt(*ANALYSIS_PROMPT).version_id


async def active_version(db: AsyncSession, user_id: int) -> StrategyVersion | None:
    found: StrategyVersion | None = await db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.user_id == user_id, StrategyVersion.status == "active"
        )
    )
    return found


async def _free_code(db: AsyncSession, user_id: int) -> str:
    taken = set(
        await db.scalars(select(StrategyVersion.code).where(StrategyVersion.user_id == user_id))
    )
    if V3_CODE not in taken:
        return V3_CODE
    number = 2
    while f"{V3_CODE}-{number}" in taken:
        number += 1
    return f"{V3_CODE}-{number}"


async def ensure_active(db: AsyncSession, user_id: int) -> StrategyVersion:
    """Активная версия участника; нет — создается v3 с параметрами по умолчанию. flush;
    commit — за вызывающим. Параллельное создание (UNIQUE активной) — берется чужая."""
    found = await active_version(db, user_id)
    if found is not None:
        return found
    version = StrategyVersion(
        user_id=user_id,
        code=await _free_code(db, user_id),
        name=V3_NAME,
        params=StrategyParams().to_params(),
        prompt_version=current_prompt_version(),
        status="active",
        approved_at=func.now(),
    )
    try:
        async with db.begin_nested():
            db.add(version)
            await db.flush()
    except IntegrityError:
        again = await active_version(db, user_id)
        if again is None:
            raise
        return again
    return version


def params_of(version: StrategyVersion | None) -> StrategyParams:
    """Параметры версии; нет версии или параметры испорчены — v3 по умолчанию."""
    if version is None:
        return StrategyParams()
    try:
        return StrategyParams.from_params(version.params or {})
    except ValueError:
        log.warning("strategy.bad_params", version_id=version.id)
        return StrategyParams()


def prompt_version_of(version: StrategyVersion | None) -> str:
    """Версия промпта анализа: из версии стратегии, иначе текущая."""
    if version is None or not version.prompt_version:
        return current_prompt_version()
    try:
        return load_prompt_id(version.prompt_version).version_id
    except (ValueError, OSError):
        log.warning("strategy.bad_prompt_version", version_id=version.id)
        return current_prompt_version()


def strategy_out(version: StrategyVersion | None) -> StrategyOut:
    """Активная версия для экрана; нет версии — значения v3 по умолчанию."""
    params = params_of(version).to_params()
    return StrategyOut(
        id=version.id if version is not None else None,
        code=version.code if version is not None else V3_CODE,
        name=version.name if version is not None else V3_NAME,
        prompt_version=version.prompt_version if version is not None else None,
        created_at=version.created_at if version is not None else None,
        params=StrategyParamsOut(
            **{
                **params,
                "stake_bands": [
                    StakeBandOut(low=low, high=high, pct=pct)
                    for low, high, pct in params["stake_bands"]
                ],
                "value_adjust": [
                    ValueAdjustOut(min_value=min_value, add=add)
                    for min_value, add in params["value_adjust"]
                ],
                "drawdown": [
                    DrawdownOut(
                        start=level["from"],
                        max_pct=level["max_pct"],
                        max_legs=level.get("max_legs"),
                        max_leg_odds=level.get("max_leg_odds"),
                    )
                    for level in params["drawdown"]
                ],
                "growth": GrowthOut(**params["growth"]),
                "week": WeekOut(**params["week"]),
            }
        ),
    )
