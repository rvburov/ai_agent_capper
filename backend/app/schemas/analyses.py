"""Схемы анализов: /api/analyses/* (ввод, черновик, «Перед запуском», ход и результат).

Деньги участника (банк, сумма ставки) и кэфы — Decimal, в JSON строкой: точность не
теряется. Доллары расхода на Claude — числом (UsdOut, как в кабинете администратора):
это только показ. Вероятности — число 0..1. Тексты — ключами локали фронтенда или
бэкенда (key, params): числа считает код, слова подставляет экран.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    PlainSerializer,
    StringConstraints,
)

from app.ml.markets import market_spec
from app.schemas.admin import UsdOut


def _market_code(value: str) -> str:
    """Код рынка проверяет разборщик (app/ml/markets.py): линия и ее пределы."""
    market_spec(value)
    return value


# Код рынка с линией (Р28, app/ml/markets.py): ML, HCP_±1.5, HCP_±2.5, STOT_2.5|3.5|4.5,
# GHCP_±X или ±X.5, GTOT_X или X.5. У фор линия — у выбранной стороны, у тоталов
# selection 1 — больше, 2 — меньше
MARKET_PATTERN = r"^(ML|HCP_[+-][12]\.5|STOT_[234]\.5|GHCP_[+-]\d{1,2}(\.5)?|GTOT_\d{1,2}(\.5)?)$"
Market = Annotated[
    str, StringConstraints(pattern=MARKET_PATTERN, max_length=16), AfterValidator(_market_code)
]
# Семейство рынка: ml — победа, h15 — фора по сетам ±1.5, shcp — фора по сетам ±2.5,
# stot — тотал сетов, ghcp — фора по геймам, gtot — тотал геймов
MarketFamily = Literal["ml", "h15", "shcp", "stot", "ghcp", "gtot"]
# «Другие рынки» формы ввода (фора ±1.5 — прежние поля HCP_-1.5 и HCP_+1.5)
ExtraFamily = Literal["shcp", "stot", "ghcp", "gtot"]
# Статус рынка: express — идет в экспресс, suspended — на проверке (SUSPENDED_MARKETS),
# compare — «для сравнения» (новые рынки до решения администратора)
MarketStatus = Literal["express", "suspended", "compare"]
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
# Одна строка без управляющих символов: PostgreSQL не хранит NUL в тексте (запрос падал бы
# с 500), а перевод строки в названии турнира попадал бы в запрос Claude отдельной строкой
# (подмена списка игроков, «инструкции»). Отказ — 422
ONE_LINE = r"^[^\x00-\x1f\x7f]*$"
ShortText = Annotated[
    str, StringConstraints(strip_whitespace=True, max_length=64, pattern=ONE_LINE)
]
NameText = Annotated[
    str, StringConstraints(strip_whitespace=True, max_length=200, pattern=ONE_LINE)
]
RoundText = Annotated[
    str, StringConstraints(strip_whitespace=True, max_length=16, pattern=ONE_LINE)
]
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


# Линия на входе: число или строка; половинная или целая (четвертную 22.25 отклоняет
# сервис с понятной ошибкой analysis.line_quarter)
LineIn = Annotated[Decimal, Field(ge=-99, le=99, max_digits=4, decimal_places=2)]


class ExtraOddsIn(BaseModel):
    """Строка «Другие рынки» (Р28): семейство, линия и кэфы двух исходов. У фор line —
    фора игрока 1, o1 — Ф1(line), o2 — Ф2(−line); у тоталов o1 — больше, o2 — меньше.
    Линии по сетам: фора ±2.5 (только до 3 побед), тотал 2.5 (до 2 побед), 3.5 и 4.5 (до 3
    побед); по геймам — половинная или целая (при «ровно» — возврат)."""

    market: ExtraFamily
    line: LineIn
    o1: OddsIn | None = None
    o2: OddsIn | None = None


class DisputedIn(BaseModel):
    """Спорная фора из разбора без ответа «по сетам или по геймам?»: пока она в событии,
    анализ не запускается (422 analysis.hcp_unit)."""

    line: LineIn
    o1: OddsIn | None = None
    o2: OddsIn | None = None


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
    extra: list[ExtraOddsIn] = Field(default=[], max_length=12)
    disputed: list[DisputedIn] = Field(default=[], max_length=12)
    bookmaker: ShortText | None = None
    line_no: int | None = Field(default=None, ge=0, le=100000)


# Валюта, в которой участник видел суммы формы. Не валюта программы (ее сменили, пока
# форма была открыта) — 409 common.currency_changed. Не прислана — не проверяется
FormCurrency = Literal["RUB", "USD", "EUR"]


class ConfirmIn(BaseModel):
    """Подтвержденный ввод для «Перед запуском» и запуска. events null — взять уже
    подтвержденные (повторный запуск после сбоя или отмены). currency — валюта банка
    в форме (FormCurrency)."""

    events: list[EventIn] | None = Field(default=None, max_length=20)
    bank: MoneyIn | None = None
    bookmaker: ShortText | None = None
    currency: FormCurrency | None = None


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


class ExtraOddsOut(BaseModel):
    """Строка «Другие рынки» (как ExtraOddsIn): line — число (у фор — игрока 1)."""

    market: ExtraFamily
    line: float
    o1: DecimalOut | None
    o2: DecimalOut | None


class DisputedOut(BaseModel):
    """Спорная фора из текста («Ф1(-1.5) = 2.05» без «сет» и «гейм»): вопрос «по сетам
    или по геймам?». line — фора игрока 1, o1 и o2 — кэфы Ф1 и Ф2. hint — подсказка по
    кэфу победы (analysis.draft.hcp_hint.sets или .games, params: odds, ml) или null.
    sets_ok — по сетам такая линия возможна в этом формате (±1.5; ±2.5 — до 3 побед)."""

    line: float
    o1: DecimalOut | None
    o2: DecimalOut | None
    hint: TextKey | None
    sets_ok: bool


class UnknownLineOut(BaseModel):
    """Строка, которую разбор не понял; reason_key — почему (четвертная линия —
    analysis.draft.unknown.quarter, тотал между 5 и 15 — analysis.draft.unknown.total_unit),
    null — просто не понял."""

    line_no: int
    text: str
    reason_key: str | None = None


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
    extra: list[ExtraOddsOut]
    disputed: list[DisputedOut]
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
    """Оценка до запуска: цена, время, у скольких игроков поищем новости (из тех, у кого
    они устарели, — сколько помещается в лимит поисков анализа), сколько матчей возьмут
    готовую оценку Claude (бесплатно)."""

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
    участника, валуй p_final·кэф + p_push − 1 и уровень, попал ли в экспресс, почему нет
    (note_key — ключ analysis.leg.*). suspended — рынок на проверке (SUSPENDED_MARKETS,
    Р28): в экспресс и варианты не идет, своей ставкой поставить можно; признак — по
    списку сейчас, и у старых анализов тоже.

    Р28: family и line — семейство и линия из кода рынка (у фор — линия выбранной
    стороны, у ML — null); status — express, suspended или compare («для сравнения»;
    suspended — по списку сейчас, у новых семейств — на момент анализа: так собирался его
    экспресс); p_push — вероятность
    возврата на целой линии (у половинной 0). У рынков по геймам вероятностей модели пока
    нет (волна 3): p_base, p_claude, p_final, value — null, has_model — false."""

    market: Market
    selection: int
    prediction_id: int | None
    p_base: float | None
    p_claude: float | None
    p_final: float | None
    q_market: float | None
    odds: DecimalOut | None
    value: float | None
    tier: str
    in_express: bool
    note_key: str | None
    suspended: bool
    family: MarketFamily
    line: float | None
    status: MarketStatus
    p_push: float
    has_model: bool


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


VariantCode = Literal["strategy", "safer", "value", "best_express"]
BetKind = Literal["strategy", "single", "own", "legacy"]
# Вид ставки, которой сохраняется вариант или своя ставка (legacy — только у бота)
BetKindIn = Literal["strategy", "single", "own"]
VariantWarning = Literal["no_value", "low_confidence"]


class VariantOut(BaseModel):
    """Вариант ставки (Р29, app/ml/variants.py): strategy — экспресс стратегии, safer —
    ординар «надежнее», value — ординар «лучший валуй», best_express — «Экспресс из
    лучших» (вне правил стратегии). kind — вид ставки при сохранении. also: ["value"] —
    safer совпал с лучшим валуем (одна карточка). p — произведение итоговых вероятностей
    ног, value — p·кэф − 1, value_tier — его уровень. stake — рекомендованная сумма (null —
    суммы нет, почему — stake_calc.reason: no_value, total_range, below_min…), stake_calc —
    расчет для «Как посчитана сумма». why_key — ключ локали причины выбора
    (analysis.variants.why.*) и why_params. issues — правила экспресса, которые не прошел
    best_express (ключи analysis.rules.*). warnings: no_value — валуй ниже нуля, модель не
    советует ставить; low_confidence — уверенность анализа по матчу ноги средняя или
    низкая."""

    code: VariantCode
    kind: BetKindIn
    also: list[Literal["value"]]
    legs: list[ExpressLeg]
    total_odds: DecimalOut
    p: float
    value: float
    value_tier: str
    stake: DecimalOut | None
    stake_calc: StakeOut
    why_key: str
    why_params: dict[str, str]
    outside_strategy: bool
    issues: list[str]
    warnings: list[VariantWarning]


class CostsOut(BaseModel):
    tokens: int
    cache_share: float
    searches: int
    cost_usd: UsdOut
    estimate_usd: UsdOut | None
    duration_ms: int
    models: list[str]


class ResultOut(BaseModel):
    """Итог анализа. variants — варианты ставки (Р29), первым — экспресс стратегии, если
    собран; у анализов до Р29 они пересчитываются при чтении из сохраненных прогнозов
    (сумма — от банка сейчас)."""

    matches: list[MatchResult]
    express: ExpressOut | None
    no_express_key: str | None
    warnings: list[TextKey]
    costs: CostsOut
    variants: list[VariantOut]


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
    extra: list[ExtraOddsOut]
    bookmaker: str | None


class BetLegBrief(BaseModel):
    prediction_id: int | None
    match_id: int
    market: Market
    selection: int
    odds_taken: DecimalOut


class BetBrief(BaseModel):
    """Сохраненная ставка по анализу: после перезагрузки экран показывает ее сумму и кэфы,
    а не рекомендацию анализа. kind — вид ставки (Р29)."""

    id: int
    kind: BetKind
    stake: DecimalOut
    currency: str
    total_odds: DecimalOut
    bookmaker: str
    legs: list[BetLegBrief]


class RestartOut(BaseModel):
    """Можно ли сейчас перезапустить остановленный анализ: та же проверка, что при запуске,
    без резерва. reason_code — почему нет (ключ errors.<код> и reason_params);
    analysis.step_running — шаг, начатый до отмены, еще идет: retry_at — не позже чего он
    закончится."""

    allowed: bool
    reason_code: str | None
    reason_params: dict[str, Any]
    retry_at: datetime | None


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
    bet: BetBrief | None = Field(
        description="Первая ставка по анализу (до Р29 — единственная); все ставки — bets"
    )
    bets: list[BetBrief] = Field(description="Все ставки по анализу, по порядку (Р29)")
    key_source: KeySource | None
    estimate_usd: UsdOut | None
    cost_usd: UsdOut
    bank: DecimalOut | None
    bookmaker: str | None
    strategy_version: str | None
    restart: RestartOut | None = Field(
        description="Только у остановленного анализа (failed, cancelled) с событиями"
    )


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
