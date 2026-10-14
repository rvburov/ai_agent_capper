"""Схемы игроков: поиск для формы ввода (GET /api/players?q=), список «Игроки»
(GET /api/players/ranking) и карточка игрока с матчами, новостями и личными встречами
(этап 4).

Эло — целым числом, как на экранах; место по Эло — среди игроков с матчами за 52 недели
(рейтинга ATP в базе нет). Все общее для участников, кроме «сегодня» в карточке: оно
только из своих ставок и анализов.
"""

from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, computed_field

from app.schemas.bets import PlayerRefOut
from app.schemas.dashboard import ArchiveSourceOut, MyMatchBetOut

# Знаков у долей (как _SHARE_DIGITS карточки игрока)
SHARE_DIGITS = 4


class PlayerHitOut(BaseModel):
    """Найденный игрок: сходство 0…1, по какому полю найден, матчей в базе, место по Эло
    и последний матч."""

    id: int
    name: str
    name_ru: str | None
    country: str | None
    score: float
    matched: str
    matches: int
    elo_rank: int | None
    last_match: date | None


# --- список «Игроки» ---

# Какие игроки: с матчами за 52 недели, с новостями свежее кэша новостей, вся база
PlayersData = Literal["active", "news", "all"]
# Покрытие для колонки «Эло на покрытии» (ковер считается хардом)
EloSurface = Literal["hard", "clay", "grass"]
# Сортировка: место по Эло, Эло на покрытии, последний матч в базе
PlayersSort = Literal["rank", "elo", "last"]
FormResult = Literal["W", "L"]


class LastMatchOut(BaseModel):
    """Последний сыгранный матч игрока в базе: день (у матча без даты — начало турнира),
    турнир архива, круг."""

    match_id: int
    day: date
    tournament: str | None
    category: str | None
    round: str


class PlayerRowOut(BaseModel):
    """Строка списка: место по Эло (null — нет матчей за 52 недели), Эло общий и на
    выбранном покрытии (delta — разница с общим), форма — последние 10 матчей, сначала
    последний; новости — когда проверялись и свежие ли (моложе кэша новостей); today —
    игрок есть в своих матчах сегодня (открытые ставки и сегодняшние анализы)."""

    id: int
    name: str
    name_ru: str | None
    country: str | None
    age: int | None
    rank: int | None
    elo_all: int | None
    elo_surface: int | None
    elo_delta: int | None
    matches_52w: int
    form: list[FormResult]
    wins: int
    losses: int
    last_match: LastMatchOut | None
    news_checked_at: datetime | None
    news_fresh: bool
    today: bool


class PlayerCountsOut(BaseModel):
    """Сколько игроков в базе, с матчами за 52 недели и со свежими новостями."""

    all: int
    active: int
    news: int


class ArchiveInfoOut(BaseModel):
    """Свежесть архива матчей: data_to — последний день матча с результатом в базе,
    last_load — последняя успешная загрузка, stale — архив устарел (правило уведомления
    data_stale), stale_days — дней с самой старой из последних загрузок (null — какой-то
    архив не загружался ни разу)."""

    data_to: date | None
    last_load: datetime | None
    stale: bool
    stale_days: int | None
    stale_after_days: int
    sources: list[ArchiveSourceOut]


class PlayerRankingOut(BaseModel):
    """Страница списка «Игроки». Без поиска — набор по data, с поиском — вся база (data =
    news сужает до игроков со свежими новостями); fuzzy — точных совпадений нет, найдено
    с учетом опечаток. total — сколько всего по условиям. as_of — день расчета текущего
    Эло, rank_days — окно места по Эло, news_ttl_hours — сколько новости считаются
    свежими. sackmann — в базе есть турниры архива Сакманна (на экране — строка авторства
    CC BY-NC-SA, как в карточке)."""

    items: list[PlayerRowOut]
    total: int
    offset: int
    limit: int
    query: str | None
    fuzzy: bool
    data: PlayersData
    surface: EloSurface
    sort: PlayersSort
    counts: PlayerCountsOut
    as_of: date | None
    rank_days: int
    news_ttl_hours: int
    archive: ArchiveInfoOut
    sackmann: bool


# --- карточка игрока ---


class SurfaceEloOut(BaseModel):
    """Эло на покрытии: значение (null — матчей на нем нет), матчей и разница с общим."""

    surface: EloSurface
    elo: int | None
    matches: int
    delta: int | None


class EloOut(BaseModel):
    """Эло игрока сейчас: общий, по покрытиям, лучшее покрытие (null — рейтинга нет)."""

    all: int | None
    matches: int
    surfaces: list[SurfaceEloOut]
    best_surface: EloSurface | None


class FormMatchOut(BaseModel):
    """Матч формы: соперник, его место по Эло сейчас, счет со стороны игрока."""

    match_id: int
    day: date
    won: bool
    opponent: PlayerRefOut
    opponent_rank: int | None
    score: str | None
    surface: str | None
    tournament: str | None
    round: str


class PlayerFormOut(BaseModel):
    """Форма: последние 10 матчей в базе (сначала последний), победы и поражения;
    matches_14d — сыгранных матчей за 14 дней по сегодня (UTC) включительно, rest_days —
    дней с последнего матча."""

    matches: list[FormMatchOut]
    wins: int
    losses: int
    matches_14d: int
    rest_days: int | None


class ServeMetricsOut(BaseModel):
    """Подача и прием (доли 0…1, null — нет данных): попадание первой, очки на первой и
    второй, эйсы и двойные за матч, очки на приеме первой и второй соперника, реализация
    и спасение брейкпоинтов. matches — матчей со статистикой."""

    matches: int
    first_in: float | None
    first_won: float | None
    second_won: float | None
    aces_per_match: float | None
    double_faults_per_match: float | None
    first_return_won: float | None
    second_return_won: float | None
    bp_converted: float | None
    bp_saved: float | None


class ServeDiffOut(BaseModel):
    """Игрок минус тур по каждой метрике ServeMetricsOut (доли — в долях, 4 знака; эйсы и
    двойные — за матч); null — у игрока или тура этой метрики нет."""

    first_in: float | None
    first_won: float | None
    second_won: float | None
    aces_per_match: float | None
    double_faults_per_match: float | None
    first_return_won: float | None
    second_return_won: float | None
    bp_converted: float | None
    bp_saved: float | None


class ServeOut(BaseModel):
    """Подача и прием за 52 недели до последнего дня со статистикой в архиве (period_to;
    статистика есть только в архиве Сакманна) против среднего по туру — игроков из первых
    tour_players по месту по Эло, суммами за то же окно. diff — разница с туром по каждой
    метрике (null — нет игрока или тура)."""

    period_from: date
    period_to: date
    player: ServeMetricsOut | None
    tour: ServeMetricsOut | None
    tour_players: int
    diff: ServeDiffOut | None


class WinLossOut(BaseModel):
    """Победы и поражения; win_share — доля побед (0…1, 4 знака; null — матчей нет)."""

    wins: int
    losses: int

    @computed_field  # type: ignore[prop-decorator]
    @property
    def win_share(self) -> float | None:
        # Доля всегда из wins и losses: в ответе есть всегда
        played = self.wins + self.losses
        return round(self.wins / played, SHARE_DIGITS) if played > 0 else None


class SurfaceResultOut(WinLossOut):
    surface: str


class ResultsOut(BaseModel):
    """Результаты по покрытиям с since (2 сезона: с 1 января прошлого года) и итог."""

    since: date
    surfaces: list[SurfaceResultOut]
    total: WinLossOut


class KeyMatchesOut(BaseModel):
    """Ключевые матчи за 52 недели (364 дня с since по сегодня включительно, как
    matches_52w): против нынешней десятки по месту по Эло, решающие сеты (матч дошел до
    последнего сета), тай-брейки (по сетам)."""

    since: date
    top10: WinLossOut
    deciders: WinLossOut
    tiebreaks: WinLossOut


class NewsStatusOut(BaseModel):
    """Новости игрока: когда последний раз искали, свежие ли (моложе ttl_hours), сколько
    фактов за lookback_days."""

    checked_at: datetime | None
    fresh: bool
    ttl_hours: int
    lookback_days: int
    count: int


class TodayH2HOut(BaseModel):
    """Личные встречи с соперником сегодняшнего матча: всего и на его покрытии,
    последняя встреча."""

    wins: int
    losses: int
    surface_wins: int
    surface_losses: int
    last_day: date | None
    last_won: bool | None


class TodayOut(BaseModel):
    """Мой матч сегодня с этим игроком (только из своих ставок и анализов): соперник и
    его место по Эло, ноги своих открытых ставок, свои анализы; surface — покрытие
    турнира (null — неизвестно); elo_prob — вероятность победы игрока по текущему Эло
    (вес покрытия как у модели, без калибровки) — входная точка, не прогноз; h2h — личные
    встречи. side — сторона игрока в матче (1 — первый, 2 — второй, как selection ноги
    ставки: нога на победу игрока — market ML и selection = side). elo и opponent_elo —
    текущее Эло игрока и соперника на покрытии матча (покрытие неизвестно — общее;
    null — нет в таблице текущего Эло)."""

    match_id: int
    side: Literal[1, 2] | None
    elo: int | None
    opponent_elo: int | None
    opponent: PlayerRefOut
    opponent_rank: int | None
    tournament: str | None
    round: str | None
    scheduled_at: datetime | None
    surface: str | None
    bets: list[MyMatchBetOut]
    analyses: list[int]
    elo_prob: float | None
    h2h: TodayH2HOut


class LegacyProfileOut(BaseModel):
    """Профиль из старого бота (шаблоны 01–04 как есть): заполнен моделью бота, часто по
    памяти; в анализ не идет, новых профилей программа не собирает (Р24)."""

    updated_at: datetime
    profile: dict[str, Any]


class PlayerCardOut(BaseModel):
    """Карточка игрока: шапка, «Обзор», свежесть данных, профиль из бота и «сегодня».
    sackmann — в карточке данные архива Сакманна (строка авторства CC BY-NC-SA)."""

    id: int
    name: str
    name_ru: str | None
    country: str | None
    birth_date: date | None
    age: int | None
    hand: str | None
    backhand: str | None
    rank: int | None
    matches_52w: int
    rank_days: int
    elo: EloOut
    form: PlayerFormOut
    last_match: LastMatchOut | None
    serve: ServeOut | None
    results: ResultsOut
    key_matches: KeyMatchesOut
    news: NewsStatusOut
    archive: ArchiveInfoOut
    sackmann: bool
    legacy_profile: LegacyProfileOut | None
    today: list[TodayOut]


class PlayerMatchOut(BaseModel):
    """Матч игрока в базе: турнир и категория, покрытие, круг, соперник и его место по
    Эло сейчас, счет со стороны игрока, исход (W, L или walkover — неявка соперника или
    самого игрока, won говорит, кто прошел дальше), формат."""

    match_id: int
    day: date
    tournament: str | None
    category: str | None
    surface: str | None
    round: str
    opponent: PlayerRefOut
    opponent_rank: int | None
    score: str | None
    won: bool
    walkover: bool
    best_of: int | None


class PlayerMatchesSummaryOut(BaseModel):
    """Итоги матчей за 2 сезона (since): победы из сыгранных, тай-брейки, решающие
    сеты, матчи до трех побед."""

    since: date
    played: int
    wins: int
    tiebreaks: WinLossOut
    deciders: WinLossOut
    best_of_5: int


class PlayerMatchesOut(BaseModel):
    """Страница матчей игрока, сначала последние. next_before — курсор (id матча) следующей
    страницы; summary — только на первой странице."""

    items: list[PlayerMatchOut]
    next_before: int | None
    total: int
    summary: PlayerMatchesSummaryOut | None


NewsKind = Literal["injury", "withdrawal", "motivation", "other", "result"]


class PlayerNewsItemOut(BaseModel):
    """Факт из новостей (шаг новостей анализа, общий кэш для всех): вид, дата, текст,
    сайт и ссылка; у результата — подробности (соперник, счет, турнир, дата, победа)."""

    id: int
    kind: NewsKind
    published_at: datetime
    summary: str
    source_url: str
    source_name: str | None
    details: dict[str, Any] | None


class PlayerNewsOut(BaseModel):
    """Новости игрока за lookback_days, новые сверху, страницами. next_before — курсор.
    checked_model — модель шага новостей, который проверил новости последним (null —
    не проверялись или запись о вызове не найдена); checked_analysis_id — номер вашего
    анализа, в котором это было (анализ другого участника не называется: null)."""

    items: list[PlayerNewsItemOut]
    next_before: int | None
    checked_at: datetime | None
    checked_model: str | None
    checked_analysis_id: int | None
    fresh: bool
    ttl_hours: int
    lookback_days: int


class H2HMatchOut(BaseModel):
    """Личная встреча: победитель (id), счет со стороны победителя, турнир, покрытие."""

    match_id: int
    day: date
    winner_id: int
    score: str | None
    surface: str | None
    tournament: str | None
    category: str | None
    round: str
    best_of: int | None


class H2HOut(BaseModel):
    """Личные встречи игрока (player) и соперника (opponent) в базе: победы каждого,
    по покрытиям (ковер — как хард), все встречи, сначала последняя."""

    player: PlayerRefOut
    opponent: PlayerRefOut
    player_rank: int | None
    opponent_rank: int | None
    player_wins: int
    opponent_wins: int
    surfaces: list[SurfaceResultOut]
    matches: list[H2HMatchOut]
