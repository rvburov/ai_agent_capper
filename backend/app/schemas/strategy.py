"""Схемы стратегии: GET /api/strategy/active (параметры активной версии участника).

Параметры — как в strategy_versions.params (app/ml/strategy.py, StrategyParams.to_params):
доли и кэфы строкой Decimal, вероятности числом.
"""

from datetime import datetime

from pydantic import BaseModel


class StakeBandOut(BaseModel):
    low: str
    high: str
    pct: str


class ValueAdjustOut(BaseModel):
    min_value: str | None
    add: str


class DrawdownOut(BaseModel):
    start: str
    max_pct: str
    max_legs: int | None
    max_leg_odds: str | None


class GrowthOut(BaseModel):
    bank_up: str
    min_winrate: str
    max_pct: str


class WeekOut(BaseModel):
    loss: str
    loss_max_pct: str
    win: str
    win_add: str


class StrategyParamsOut(BaseModel):
    markets: list[str]
    min_p: float
    triple_min_p: float
    leg_odds: list[str]
    triple_max_leg_odds: str
    double_total: list[str]
    triple_total: list[str]
    require_value: bool
    cover_min_p: float
    form_min_wins_last5: int
    stake_bands: list[StakeBandOut]
    value_adjust: list[ValueAdjustOut]
    drawdown: list[DrawdownOut]
    claude_max_shift: float
    claude_highlight: float
    rounding: dict[str, str]
    min_stake: dict[str, str]
    max_pct: str
    growth: GrowthOut
    week: WeekOut
    adapt: dict[str, bool]
    # Р29: таблица суммы ординара, его потолок в защитном режиме, потолок «Экспресса из
    # лучших», порог кэфа «надежнее» и вероятности «лучшего валуя»
    single_bands: list[StakeBandOut]
    single_protect_pct: str
    best_express_max_pct: str
    safer_min_odds: str
    value_min_p: float


class StrategyOut(BaseModel):
    """Активная версия стратегии; id null — версии еще нет, показаны значения v3."""

    id: int | None
    code: str
    name: str
    prompt_version: str | None
    created_at: datetime | None
    params: StrategyParamsOut
