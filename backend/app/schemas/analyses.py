"""Схемы анализов: /api/analyses/* (ввод, черновик, «Перед запуском», ход и результат).

Деньги участника (банк, сумма ставки) и кэфы — Decimal, в JSON строкой: точность не
теряется. Доллары расхода на Claude — числом (UsdOut, как в кабинете администратора):
это только показ. Вероятности — число 0..1. Тексты — ключами локали фронтенда или
бэкенда (key, params): числа считает код, слова подставляет экран.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, PlainSerializer, StringConstraints

from app.schemas.admin import UsdOut

Market = Literal["ML", "HCP_-1.5", "HCP_+1.5"]
Surface = Literal["hard", "clay", "grass", "carpet"]
AnalysisStatus = Literal[
    "created",
    "queued",
    "running",
    "done",
    "failed",
    "cancelled",
    "parsing",
    "needs_confirmation",
    "building_dossier",
    "modelling",
    "llm_review",
    "composing",
]
InputKind = Literal["text", "form"]
StepKind = Literal["parse", "players", "news", "dossier", "model", "claude", "compose"]
StepState = Literal["pending", "running", "done", "failed", "skipped"]
PickStatus = Literal["matched", "check", "missing"]
Decision = Literal["bet", "skip"]
KeySource = Literal["admin", "own"]
Confidence = Literal["low", "medium", "high"]
Flag = Literal["injury", "fatigue", "form", "motivation"]

# Кэф и деньги наружу — строкой Decimal
DecimalOut = Annotated[Decimal, PlainSerializer(str, return_type=str, when_used="json")]
# Кэф на входе: число или строка, до 3 знаков после точки (NUMERIC(6, 3)); диапазон
# 1.01–50 проверяет сервис (errors.analysis.odds_range)
OddsIn = Annotated[Decimal, Field(ge=0, max_digits=6, decimal_places=3)]
MoneyIn = Annotated[Decimal, Field(ge=0, max_digits=12, decimal_places=2)]
ShortText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=64)]
NameText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
RoundText = Annotated[str, StringConstraints(strip_whitespace=True, max_length=16)]
InputText = Annotated[str, StringConstraints(max_length=20000)]


class TextKey(BaseModel):
    """Текст ключом локали: key — полный ключ (analysis.draft.player_check), params —
    значения для подстановки."""

    key: str
    params: dict[str, Any] = {}


# --- ввод ---


class AnalysisCreateIn(BaseModel):
    """Новый анализ: текст (разбор Claude) или пустая форма (без Claude)."""

    input_kind: InputKind = "text"
    text: InputText | None = None


class OddsPairsIn(BaseModel):
    """Кэфы события: пара [на игрока 1, на игрока 2] по рынку, null — кэфа нет."""

    model_config = ConfigDict(populate_by_name=True)

    ml: list[OddsIn | None] = Field(alias="ML", min_length=2, max_length=2)
    minus: list[OddsIn | None] = Field(
        default=[None, None], alias="HCP_-1.5", min_length=2, max_length=2
    )
    plus: list[OddsIn | None] = Field(
        default=[None, None], alias="HCP_+1.5", min_length=2, max_length=2
    )


class EventIn(BaseModel):
    """Событие, которое подтвердил участник. Игроки — id из базы (подсказки GET /players
    или черновик разбора). Турнир — id из черновика или название (новый турнир)."""

    player1_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    player2_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    tournament_id: int | None = Field(default=None, ge=1, le=2**63 - 1)
    tournament_name: NameText | None = None
    surface: Surface | None = None
    best_of: Literal[3, 5] | None = None
    round: RoundText = ""
    odds: OddsPairsIn
    bookmaker: ShortText | None = None
    line_no: int | None = Field(default=None, ge=0, le=100000)


class ConfirmIn(BaseModel):
    """Подтвержденный ввод для «Перед запуском» и запуска. events null — взять уже
    подтвержденные (повторный запуск после сбоя или отмены)."""

    events: list[EventIn] | None = Field(default=None, max_length=20)
    bank: MoneyIn | None = None
    bookmaker: ShortText | None = None


class DecisionIn(BaseModel):
    """Решение по итогу: skip — не ставить, null — снять решение («Все-таки поставить»).
    «Поставил» записывает сохранение ставки (POST /bets)."""

    decision: Literal["skip"] | None = None


# --- черновик ---


class PlayerBrief(BaseModel):
    id: int
    name: str
    name_ru: str | None
    country: str | None
    elo_rank: int | None
    last_match: date | None


class PlayerCandidate(BaseModel):
    id: int
    name: str
    country: str | None
    score: float


class PlayerPick(BaseModel):
    """Игрок из текста: matched — найден (сходство ≥ 0,9), check — проверьте
    (0,7–0,9), missing — нет в базе. candidates — до 3 похожих."""

    status: PickStatus
    raw: str
    player: PlayerBrief | None
    score: float | None
    candidates: list[PlayerCandidate]


class TournamentOut(BaseModel):
    """Турнир события: id — найденный в базе турнир этого года (null — будет создан при
    запуске), остальное — из него или из последнего выпуска турнира."""

    id: int | None
    name: str
    category: str | None
    surface: Surface | None
    best_of: int | None


class OddsPairsOut(BaseModel):
    model_config = ConfigDict(populate_by_name=True, serialize_by_alias=True)

    ml: list[DecimalOut | None] = Field(alias="ML")
    minus: list[DecimalOut | None] = Field(alias="HCP_-1.5")
    plus: list[DecimalOut | None] = Field(alias="HCP_+1.5")


class UnknownLineOut(BaseModel):
    line_no: int
    text: str


class DraftEventOut(BaseModel):
    position: int
    line_no: int | None
    raw1: str
    raw2: str
    player1: PlayerPick
    player2: PlayerPick
    tournament: TournamentOut | None
    surface: Surface | None
    best_of: int
    round: str
    odds: OddsPairsOut
    bookmaker: str | None
    warnings: list[TextKey]


class DraftOut(BaseModel):
    """Что понял разбор (или пустая форма). bank — банк из текста в валюте программы;
    bank_note_key — почему банк не взят или расходится с учетом."""

    bank: DecimalOut | None
    currency: str
    ledger_bank: DecimalOut | None
    bank_note_key: str | None
    bookmaker: str | None
    events: list[DraftEventOut]
    unknown_lines: list[UnknownLineOut]
    parse_cost_usd: UsdOut
    warnings: list[TextKey]


# --- «Перед запуском» ---


class FairOut(BaseModel):
    """Рынок без маржи: вероятность исхода по паре кэфов."""

    market: Market
    selection: int
    q: float


class CorridorOut(BaseModel):
    market: Market
    selection: int
    odds: DecimalOut


class PreviewPlayer(BaseModel):
    id: int
    name: str
    country: str | None
    elo_rank: int | None
    news_fresh: bool
    news_checked_at: datetime | None
    last_match: date | None


class PreviewEvent(BaseModel):
    position: int
    margin_ml: float | None
    margin_hcp: float | None
    market_p: list[FairOut]
    in_corridor: list[CorridorOut]
    players: list[PreviewPlayer]
    reused: bool
    problems: list[TextKey]


class EstimateOut(BaseModel):
    """Оценка до запуска: цена, время, у скольких игроков новости устарели, сколько
    матчей возьмут готовую оценку Claude (бесплатно)."""

    cost_usd: UsdOut
    seconds: int
    news_players: int
    reused_matches: int


class AccessOut(BaseModel):
    """Можно ли запустить: причина отказа — код ошибки errors.<reason_code>."""

    allowed: bool
    reason_code: str | None
    reason_params: dict[str, Any]
    mode: KeySource | Literal["shared"]
    monthly_usd: UsdOut | None
    spent_usd: UsdOut
    left_usd: UsdOut | None
    daily: int | None
    today: int
    per_analysis_usd: UsdOut
    own_key_last4: str | None


class PreviewOut(BaseModel):
    events: list[PreviewEvent]
    problems: list[TextKey]
    estimate: EstimateOut
    access: AccessOut
    data_to: date | None


# --- ход анализа ---


class StepOut(BaseModel):
    """Шаг хода анализа. match_id — у шагов новостей и Claude (по матчу)."""

    index: int
    kind: StepKind
    match_id: int | None
    state: StepState
    model: str | None
    elapsed_ms: int
    tokens: int
    cost_usd: UsdOut
    web_searches: int
    detail_key: str | None
    detail_params: dict[str, Any]


class TotalsOut(BaseModel):
    elapsed_ms: int
    tokens: int
    cost_usd: UsdOut
    step: int
    steps: int


class ErrorInfoOut(BaseModel):
    """Почему анализ остановился: code — ключ errors.<code>, step — шаг (kind)."""

    code: str
    params: dict[str, Any]
    step: str | None


class ProgressEventOut(BaseModel):
    """Событие потока SSE GET /analyses/{id}/events (поле data)."""

    type: Literal["snapshot", "step", "status", "done", "failed", "cancelled"]
    analysis_id: int
    status: AnalysisStatus
    step: StepOut | None
    steps: list[StepOut] | None
    totals: TotalsOut
    error: ErrorInfoOut | None


# --- результат ---


class PlayerSide(BaseModel):
    id: int
    name: str
    country: str | None
    elo_rank: int | None


class FactorOut(BaseModel):
    player: int
    effect: Literal["plus", "minus"]
    text: str
    ref: str
    source_url: str | None
    source_name: str | None
    date: str | None


class ComparisonRow(BaseModel):
    """Строка «Сравнение игроков»: key — что сравниваем (elo_rank, elo_surface, form10,
    load14, serve_first, serve_second, return, tiebreaks, h2h), better — у кого лучше."""

    key: str
    left: float | str | None
    right: float | str | None
    sub_left: float | str | None
    sub_right: float | str | None
    better: Literal["left", "right"] | None


class FormOut(BaseModel):
    p1: list[Literal["W", "L"]]
    p2: list[Literal["W", "L"]]


class FlagsOut(BaseModel):
    p1: list[Flag]
    p2: list[Flag]


class MarketRow(BaseModel):
    """Исход: вероятности модели, Claude и итоговая (Р22), рынок без маржи, кэф
    участника, валуй p_final·кэф − 1 и уровень, попал ли в экспресс, почему нет
    (note_key — ключ analysis.leg.*)."""

    market: Market
    selection: int
    prediction_id: int | None
    p_base: float
    p_claude: float
    p_final: float
    q_market: float | None
    odds: DecimalOut | None
    value: float | None
    tier: str
    in_express: bool
    note_key: str | None


class MatchResult(BaseModel):
    match_id: int
    player1: PlayerSide
    player2: PlayerSide
    tournament: str | None
    surface: str
    round: str
    best_of: int
    data_as_of: date | None
    confidence: Confidence
    explanation: str
    divergence_note: str
    highlight: bool
    flags: FlagsOut
    factors: list[FactorOut]
    comparison: list[ComparisonRow]
    form: FormOut
    markets: list[MarketRow]
    reused_from: datetime | None
    news_state: str | None


class ExpressLeg(BaseModel):
    prediction_id: int
    match_id: int
    market: Market
    selection: int
    p: float
    odds: DecimalOut


class StakeStepOut(BaseModel):
    kind: str
    pct: DecimalOut
    params: dict[str, str]


class StakeOut(BaseModel):
    """Сумма ставки и шаги расчета (app/ml/strategy.py, stake). amount null — суммы
    нет, reason — почему. bank_source: ledger — банк по учету, input — из ввода."""

    amount: DecimalOut | None
    currency: str
    bank: DecimalOut
    bank_source: Literal["ledger", "input", "none"]
    total_odds: DecimalOut
    pct: DecimalOut
    steps: list[StakeStepOut]
    reason: str | None
    drawdown_level: str | None


class RuleCheck(BaseModel):
    ok: bool
    key: str
    params: dict[str, Any]


class ExpressOut(BaseModel):
    legs: list[ExpressLeg]
    total_odds: DecimalOut
    p_express: float
    ev: float
    stake: StakeOut
    rules: list[RuleCheck]


class CostsOut(BaseModel):
    tokens: int
    cache_share: float
    searches: int
    cost_usd: UsdOut
    estimate_usd: UsdOut | None
    duration_ms: int
    models: list[str]


class ResultOut(BaseModel):
    matches: list[MatchResult]
    express: ExpressOut | None
    no_express_key: str | None
    warnings: list[TextKey]
    costs: CostsOut


# --- анализ целиком ---


class ConfirmedPlayer(BaseModel):
    id: int
    name: str
    name_ru: str | None
    country: str | None


class ConfirmedEventOut(BaseModel):
    """Событие, подтвержденное при запуске (analyses.confirmed): по нему экран называет
    матчи в шагах хода (match_id) и возвращает события в «Новый анализ» для правки."""

    position: int
    match_id: int | None
    player1: ConfirmedPlayer
    player2: ConfirmedPlayer
    tournament_id: int | None
    tournament_name: str | None
    surface: str
    best_of: int
    round: str
    odds: OddsPairsOut
    bookmaker: str | None


class BetLegBrief(BaseModel):
    prediction_id: int | None
    odds_taken: DecimalOut


class BetBrief(BaseModel):
    """Сохраненная ставка по анализу: после перезагрузки экран показывает ее сумму и кэфы,
    а не рекомендацию анализа."""

    id: int
    stake: DecimalOut
    currency: str
    total_odds: DecimalOut
    bookmaker: str
    legs: list[BetLegBrief]


class AnalysisOut(BaseModel):
    id: int
    status: AnalysisStatus
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    input_kind: InputKind
    input_text: str
    attempt: int
    draft: DraftOut | None
    events: list[ConfirmedEventOut]
    steps: list[StepOut]
    totals: TotalsOut
    error: ErrorInfoOut | None
    result: ResultOut | None
    decision: Decision | None
    bet_id: int | None
    bet: BetBrief | None
    key_source: KeySource | None
    estimate_usd: UsdOut | None
    cost_usd: UsdOut
    bank: DecimalOut | None
    bookmaker: str | None
    strategy_version: str | None


class PairName(BaseModel):
    name: str
    name_ru: str | None


class MatchPairOut(BaseModel):
    """Игроки матча для списка: экран пишет их так же, как на остальных карточках."""

    player1: PairName
    player2: PairName


class AnalysisListItem(BaseModel):
    id: int
    status: AnalysisStatus
    created_at: datetime
    finished_at: datetime | None
    input_kind: InputKind
    matches: list[str]
    pairs: list[MatchPairOut]
    decision: Decision | None
    cost_usd: UsdOut


class AnalysisListOut(BaseModel):
    items: list[AnalysisListItem]
    next_cursor: int | None
