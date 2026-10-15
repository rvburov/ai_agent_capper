"""Схемы ставок и банка: ставка по анализу, список, итоги и карточка ставки, расчет,
исправление и закрывающий кэф (этап 4), банк, его ряд по дням и журнал движения.

Деньги и кэфы — Decimal строкой в JSON (точность не теряется). Доли банка (BankOut) —
строкой Decimal; доли статистики этапа 4 (ROI, винрейт, CLV) — числом.
"""

from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, StringConstraints

from app.schemas.analyses import DecimalOut, FormCurrency, Market, Surface

OddsTakenIn = Annotated[Decimal, Field(gt=0, max_digits=6, decimal_places=3)]
StakeIn = Annotated[Decimal, Field(gt=0, max_digits=12, decimal_places=2)]
# Одна строка без управляющих символов (NUL дал бы 500 из PostgreSQL)
BookmakerIn = Annotated[
    str,
    StringConstraints(
        strip_whitespace=True, min_length=1, max_length=64, pattern=r"^[^\x00-\x1f\x7f]*$"
    ),
]
# Ключ идемпотентности от фронтенда: повтор с тем же ключом вернет ту же ставку
ClientRef = Annotated[
    str, StringConstraints(strip_whitespace=True, pattern=r"^[A-Za-z0-9_-]{8,64}$")
]


class BetLegIn(BaseModel):
    """Нога ставки: прогноз анализа и кэф, по которому участник поставил."""

    prediction_id: int = Field(ge=1, le=2**63 - 1)
    odds_taken: OddsTakenIn


class BetIn(BaseModel):
    """currency — валюта суммы в форме (FormCurrency): сменили валюту, пока форма была
    открыта, — 409 common.currency_changed, сумма в старой валюте не запишется."""

    analysis_id: int = Field(ge=1, le=2**63 - 1)
    stake: StakeIn
    bookmaker: BookmakerIn
    legs: list[BetLegIn] = Field(min_length=1, max_length=3)
    client_ref: ClientRef
    currency: FormCurrency | None = None


class BetLegOut(BaseModel):
    id: int
    prediction_id: int | None
    match_id: int
    market: Market
    selection: int
    odds_taken: DecimalOut


BetStatus = Literal["open", "won", "lost", "void"]


# Фильтр статуса: settled — все рассчитанные (выигрыш, проигрыш, возврат)
BetStatusFilter = Literal["open", "won", "lost", "void", "settled"]


class BetOut(BaseModel):
    id: int
    analysis_id: int | None
    placed_at: datetime
    bookmaker: str
    stake: DecimalOut
    currency: str
    total_odds: DecimalOut
    status: BetStatus
    legs: list[BetLegOut]
    client_ref: str | None


class AdaptationOut(BaseModel):
    """Правило адаптации суммы (Р22): включено ли в стратегии, действует ли сейчас и
    выполнено ли его условие (met — независимо от enabled; у просадки — порог достигнут,
    даже если действует более строгий лимит)."""

    key: Literal["dd10", "dd20", "up15", "week_loss", "week_win"]
    enabled: bool
    active: bool
    met: bool
    params: dict[str, Any]


class BankOut(BaseModel):
    """Банк по учету: баланс, в игре, капитал, пик и просадка (0..1), стартовый банк
    (пополнения минус выводы), рост к нему, итог 7 дней, винрейт и адаптации."""

    currency: str
    empty: bool
    balance: DecimalOut
    in_play: DecimalOut
    equity: DecimalOut
    peak: DecimalOut
    drawdown: DecimalOut
    invested: DecimalOut
    growth: DecimalOut | None
    week_change: DecimalOut | None
    winrate: DecimalOut | None
    settled_bets: int
    drawdown_level: Literal["dd10", "dd20"] | None
    adaptations: list[AdaptationOut]


# --- этап 4: список, итоги, карточка, расчет ---

LegResult = Literal["win", "loss", "void"]
BetSource = Literal["app", "legacy"]
SettledBy = Literal["manual", "auto", "legacy"]
ClosingSource = Literal["user", "archive"]
# Чей закрывающий кэф: эталон рынка по Р17 (pinnacle → betfair_ex → avg) или свой букмекер
ClosingBy = Literal["pinnacle", "betfair_ex", "avg", "bookmaker"]
# Период: последние 7, 30, 90 дней по поясу участника или все время
Period = Literal["7d", "30d", "90d", "all"]
# Покрытие ноги: из турнира, иначе из подтвержденного ввода анализа; unknown — не указано
SurfaceFilter = Literal["hard", "clay", "grass", "carpet", "unknown"]
# Вердикт по CLV считает код (без Claude): legacy — ставка старого бота, no_closing —
# закрытие не внесено, edge_confirmed — выигрыш и CLV ≥ 0, won_against_market — выигрыш
# при CLV < 0, variance — проигрыш при согласном рынке, model_error — у проигравшей ноги
# CLV < 0
Verdict = Literal[
    "legacy", "void", "no_closing", "edge_confirmed", "won_against_market", "variance",
    "model_error",
]  # fmt: skip
# Счет по сетам из ввода: «2:1», первым — игрок 1 матча; формат проверяет сервис
ScoreIn = Annotated[str, StringConstraints(strip_whitespace=True, min_length=2, max_length=7)]
SearchText = Annotated[
    str, StringConstraints(strip_whitespace=True, max_length=100, pattern=r"^[^\x00-\x1f\x7f]*$")
]
NoteIn = Annotated[
    str, StringConstraints(strip_whitespace=True, max_length=200, pattern=r"^[^\x00-\x1f\x7f]*$")
]
SignedMoneyIn = Annotated[Decimal, Field(max_digits=12, decimal_places=2)]
# Даты фильтров: ставок раньше 2000 года нет, а крайние даты не переводятся в UTC
DATE_MIN = date(2000, 1, 1)
DATE_MAX = date(2100, 12, 31)


class BetFiltersIn(BaseModel):
    """Фильтры «Ставок»: период (или даты from–to по поясу участника, включительно, в
    пределах 2000–2100 годов), статус (settled — все рассчитанные: выигрыш, проигрыш,
    возврат), рынок (есть нога этого рынка), покрытия (есть нога на одном из них),
    источник и поиск по игрокам, турниру, букмекеру и номеру ставки (№12)."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    period: Period = "all"
    date_from: date | None = Field(default=None, alias="from", ge=DATE_MIN, le=DATE_MAX)
    date_to: date | None = Field(default=None, alias="to", ge=DATE_MIN, le=DATE_MAX)
    status: BetStatusFilter | None = None
    market: Market | None = None
    surface: list[SurfaceFilter] = Field(default_factory=list, max_length=5)
    source: BetSource | None = None
    q: SearchText | None = None


class BetPageIn(BetFiltersIn):
    """Фильтры плюс курсор: before — id последней ставки прошлой страницы."""

    before: int | None = Field(default=None, ge=1, le=2**63 - 1)
    limit: int = Field(default=20, ge=1, le=100)


class PlayerRefOut(BaseModel):
    id: int
    name: str
    name_ru: str | None


class LegMatchOut(BaseModel):
    """Матч ноги. Турнир из ввода участника показывается по его же вводу; покрытие и
    формат — из турнира, иначе из ввода анализа (null — не указано)."""

    id: int
    player1: PlayerRefOut
    player2: PlayerRefOut
    day: date | None
    tournament: str | None
    category: str | None
    surface: Surface | None
    round: str
    best_of: int | None


class ClosingOut(BaseModel):
    """Закрывающий кэф ноги: на свой исход и обратный, чей он (by; bookmaker — название
    своего букмекера), откуда, вероятность своего исхода без маржи при двух сторонах."""

    odds: DecimalOut
    opp_odds: DecimalOut | None
    by: ClosingBy
    bookmaker: str | None
    source: ClosingSource
    q_close: float | None


class BetLegItemOut(BaseModel):
    """Нога ставки: исход (null — не рассчитана), счет (первым — игрок 1), кто и когда
    рассчитал, закрытие и CLV (кэф / закрытие − 1; без маржи — кэф · q_close − 1),
    вероятности прогноза (p_final; у ставок бота — только p_claude) и перевес над рынком
    edge — вероятность прогноза минус 1/кэф (пусто — прогноза нет). score_outcomes — у
    открытой ставки: исход ноги по каждому полному счету («2:1», первым — игрок 1) для
    окна расчета (отметить исход по счету, предупредить о расхождении); выбор исхода все
    равно за участником (В16)."""

    id: int
    match: LegMatchOut
    market: Market
    selection: int
    odds_taken: DecimalOut
    prediction_id: int | None
    p_final: float | None
    p_base: float | None
    p_claude: float | None
    edge: float | None
    result: LegResult | None
    score: str | None
    settled_at: datetime | None
    result_source: SettledBy | None
    closing: ClosingOut | None
    clv: float | None
    clv_fair: float | None
    score_outcomes: dict[str, LegResult] | None


class BetItemOut(BaseModel):
    """Ставка для «Ставок»: деньги, исход, CLV экспресса (по ногам без возвратов, если
    закрытие внесено у всех), вердикт по CLV. effective_odds — кэф расчета (возврат ноги
    считается с кэфом 1.00), payout — выплата (у открытой — возможная). bank_after —
    капитал сразу после расчета ставки (у выигранной, проигранной и возврата; null у
    открытой), то же число, что equity_after в последних ставках главной. updated_at —
    версия ставки: ее присылают расчет и сторно (хватает точности до миллисекунды,
    app/services/bet_versions.py)."""

    id: int
    analysis_id: int | None
    placed_at: datetime
    bookmaker: str
    stake: DecimalOut
    currency: str
    total_odds: DecimalOut
    effective_odds: DecimalOut | None
    status: BetStatus
    profit: DecimalOut | None
    payout: DecimalOut | None
    bank_after: DecimalOut | None
    settled_at: datetime | None
    settled_by: SettledBy | None
    source: BetSource
    updated_at: datetime
    clv: float | None
    clv_fair: float | None
    verdict: Verdict | None
    legs: list[BetLegItemOut]


class BetPageOut(BaseModel):
    """Страница ставок, новые сверху. next_before — курсор следующей страницы."""

    items: list[BetItemOut]
    next_before: int | None


class BetsSummaryOut(BaseModel):
    """Итоги по фильтрам (решения Т8 и В5): рассчитано — выигрыш, проигрыш и возврат;
    оборот и прибыль — без возвратов; ROI = прибыль / оборот; винрейт — выигрыш / (выигрыш +
    проигрыш); CLV — средний по рассчитанным ставкам приложения (без ставок бота);
    clv_positive из clv_n — лучше закрытия; legacy_settled — рассчитанных ставок бота."""

    currency: str
    settled: int
    won: int
    lost: int
    void: int
    winrate: float | None
    turnover: DecimalOut
    profit: DecimalOut
    roi: float | None
    avg_stake: DecimalOut | None
    open: int
    open_stake: DecimalOut
    clv: float | None
    clv_positive: int
    clv_n: int
    legacy_settled: int


class ClosingIn(BaseModel):
    """Закрывающий кэф ноги (В1): на свой исход обязательно, на обратный — по желанию
    (тогда есть вероятность без маржи и CLV без маржи). by — эталон рынка или свой
    букмекер (bookmaker; не указан — букмекер ставки). Кэфы 1.01–50 проверяет сервис."""

    odds: OddsTakenIn
    opp_odds: OddsTakenIn | None = None
    by: ClosingBy
    bookmaker: BookmakerIn | None = None


class LegSettleIn(BaseModel):
    """Исход ноги, счет (необязательно; первым — игрок 1) и закрывающий кэф: поля нет —
    закрытие не меняется, null — стирается."""

    leg_id: int = Field(ge=1, le=2**63 - 1)
    result: LegResult
    score: ScoreIn | None = None
    closing: ClosingIn | None = None


class SettleIn(BaseModel):
    """Ручной расчет: исходы всех ног и версия ставки, которую видел участник."""

    expected_updated_at: AwareDatetime
    legs: list[LegSettleIn] = Field(min_length=1, max_length=10)


class ReverseIn(BaseModel):
    """Исправление результата: версия ставки, которую видел участник."""

    expected_updated_at: AwareDatetime


class ClosingUpdateIn(BaseModel):
    """Закрывающий кэф ноги; null — стереть."""

    closing: ClosingIn | None


# --- банк: ряд по дням и журнал ---

BankEntryKind = Literal[
    "deposit", "withdrawal", "stake", "payout", "refund", "reversal", "correction"
]  # fmt: skip
BankMoveKind = Literal["deposit", "withdrawal", "correction"]


class BankPointOut(BaseModel):
    """Капитал (баланс + ставки в игре) на конец дня по поясу участника."""

    day: date
    equity: DecimalOut


class BankHistoryOut(BaseModel):
    currency: str
    tz: str
    period: Period
    points: list[BankPointOut]


class BankEntryOut(BaseModel):
    """Строка журнала банка. amount — со знаком; balance_after — баланс по учету после
    этой строки (по времени записи); reversed_by — сторно, которое ее отменило."""

    id: int
    at: datetime
    kind: BankEntryKind
    amount: DecimalOut
    currency: str
    bet_id: int | None
    note: str | None
    reversed_by: int | None
    balance_after: DecimalOut


class BankEntriesOut(BaseModel):
    """Страница журнала. last_id — самая новая запись журнала (по id): ее присылает
    POST /me/bank/entries в expected_last_id."""

    items: list[BankEntryOut]
    next_before: int | None
    last_id: int | None


class BankEntryIn(BaseModel):
    """Пополнение, вывод или корректировка. amount у пополнения и вывода — больше нуля,
    у корректировки — со знаком, не ноль. expected_last_id — последняя строка журнала,
    которую видел участник (null — журнал пуст): защита от двойной отправки и гонки.
    currency — валюта суммы в форме, как у BetIn (409 common.currency_changed)."""

    kind: BankMoveKind
    amount: SignedMoneyIn
    note: NoteIn | None = None
    expected_last_id: int | None = Field(ge=1, le=2**63 - 1)
    currency: FormCurrency | None = None
