"""Общие данные о теннисе: игроки, турниры, матчи, статистика, рейтинги, новости, кэфы,
досье и журнал загрузок (PLAN.md, разделы 5 и 6). Видны всем участникам."""

from datetime import date, datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    Integer,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import (
    Base,
    BigIntPK,
    CreatedAtMixin,
    Hash64,
    Odds,
    UpdatedAtMixin,
    check_in,
)

SURFACES = ("hard", "clay", "grass", "carpet")
RATING_SURFACES = (*SURFACES, "all")
HANDS = ("R", "L", "A", "U")
BACKHANDS = ("one", "two")
# result — свежий результат матча из веб-поиска: в matches не пишется, чтобы Эло не
# посчитало матч дважды, когда его загрузит tennis-data (подробности — в details)
NEWS_KINDS = ("injury", "withdrawal", "motivation", "other", "result")
MATCH_STATUSES = ("scheduled", "finished", "retired", "walkover")
# user — матч из ввода участника (этап 3), source_ref детерминированный
MATCH_SOURCES = ("sackmann", "tennis_data", "api", "web", "legacy", "user")
# archive — кэф из архива (tennis-data.co.uk): когда снят, неизвестно, поэтому не closing
ODDS_KINDS = ("user", "opening", "closing", "api", "archive")
# legacy — турниры из импорта старого бота (этап 1), source_ref у них пустой;
# user — турнир из ввода участника (этап 3)
TOURNAMENT_SOURCES = ("sackmann", "tennis_data", "legacy", "user")
INGESTION_STATUSES = ("running", "ok", "failed")


class Player(CreatedAtMixin, UpdatedAtMixin, Base):
    """Игрок. Поиск по имени — триграммы pg_trgm (GIN), в том числе по-русски (name_ru)."""

    __tablename__ = "players"
    __table_args__ = (
        Index(
            "ix_players_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
        Index(
            "ix_players_name_ru_trgm",
            "name_ru",
            postgresql_using="gin",
            postgresql_ops={"name_ru": "gin_trgm_ops"},
        ),
        Index("ix_players_aliases", "aliases", postgresql_using="gin"),
        check_in("hand", HANDS, "hand"),
        check_in("backhand", BACKHANDS, "backhand"),
    )

    id: Mapped[BigIntPK]
    name: Mapped[str] = mapped_column(String(200))
    name_ru: Mapped[str | None] = mapped_column(String(200))
    aliases: Mapped[list[str]] = mapped_column(ARRAY(Text), server_default=text("'{}'::text[]"))
    # Код страны IOC, например SRB
    country: Mapped[str | None] = mapped_column(String(3))
    hand: Mapped[str | None] = mapped_column(String(1))
    backhand: Mapped[str | None] = mapped_column(String(3))
    birth_date: Mapped[date | None]
    sackmann_id: Mapped[int | None] = mapped_column(unique=True)
    provider_id: Mapped[str | None] = mapped_column(String(64))
    # Когда новости игрока последний раз искали (с находками или без): по нему шаг
    # новостей не повторяет платный поиск раньше news_ttl_hours
    news_checked_at: Mapped[datetime | None]


class PlayerProfile(Base):
    """Качественный профиль игрока (структура шаблонов 01–04 старого бота) в JSONB."""

    __tablename__ = "player_profiles"

    player_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    profile: Mapped[dict[str, Any]]
    # legacy_llm — перенесен из старого бота, llm — собран Claude, manual — вручную
    source: Mapped[str] = mapped_column(String(32))
    updated_at: Mapped[datetime] = mapped_column(server_default=func.now(), onupdate=func.now())


class PlayerRating(Base):
    """Рейтинг Эло игрока по покрытию на дату (считает код, app/ml)."""

    __tablename__ = "player_ratings"
    __table_args__ = (check_in("surface", RATING_SURFACES, "surface"),)

    player_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    surface: Mapped[str] = mapped_column(String(8), primary_key=True)
    as_of: Mapped[date] = mapped_column(primary_key=True)
    elo: Mapped[float]
    matches: Mapped[int] = mapped_column(server_default="0")


class PlayerNews(Base):
    """Новость об игроке (травма, снятие, мотивация, свежий результат): общий кэш новостей
    для всех. agent_run_id — вызов Claude, который ее нашел; details — подробности
    результата (соперник, счет, турнир, дата)."""

    __tablename__ = "player_news"
    __table_args__ = (
        UniqueConstraint("player_id", "source_url"),
        check_in("kind", NEWS_KINDS, "kind"),
    )

    id: Mapped[BigIntPK]
    player_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("players.id", ondelete="CASCADE"))
    published_at: Mapped[datetime]
    kind: Mapped[str] = mapped_column(String(16))
    summary: Mapped[str]
    source_url: Mapped[str]
    source_name: Mapped[str | None] = mapped_column(String(200))
    fetched_at: Mapped[datetime] = mapped_column(server_default=func.now())
    agent_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("agent_runs.id", ondelete="SET NULL")
    )
    details: Mapped[dict[str, Any] | None]


class Tournament(CreatedAtMixin, Base):
    """Турнир: категория, покрытие, зал, формат матчей.

    Повторная загрузка архива находит турнир по UNIQUE(source, source_ref):
    sackmann — tourney_id («2024-339»), tennis_data — «{год}-{номер ATP}» (только турниры
    без пары у Сакманна). У турниров старого бота source = legacy и source_ref пустой.
    """

    __tablename__ = "tournaments"
    __table_args__ = (
        UniqueConstraint("source", "source_ref"),
        Index("ix_tournaments_start_date", "start_date"),
        check_in("surface", SURFACES, "surface"),
        check_in("best_of", (3, 5), "best_of"),
        check_in("source", TOURNAMENT_SOURCES, "source"),
    )

    id: Mapped[BigIntPK]
    name: Mapped[str] = mapped_column(String(200))
    # grand_slam, masters, 500, 250, challenger, itf и т. п.
    category: Mapped[str | None] = mapped_column(String(32))
    surface: Mapped[str | None] = mapped_column(String(8))
    indoor: Mapped[bool | None]
    best_of: Mapped[int | None] = mapped_column(SmallInteger)
    start_date: Mapped[date | None]
    city: Mapped[str | None] = mapped_column(String(100))
    source: Mapped[str | None] = mapped_column(String(16))
    source_ref: Mapped[str | None] = mapped_column(String(64))


class Match(CreatedAtMixin, UpdatedAtMixin, Base):
    """Матч. Турнир и время могут быть неизвестны у матчей из истории старого бота.

    Повторная загрузка не должна плодить копии матча. Матч с турниром узнается по
    UNIQUE(tournament_id, round, player1_id, player2_id). У матча без турнира (только
    legacy, web и user) этот ключ не работает: NULL в PostgreSQL не равны друг другу. Поэтому
    у него обязателен source_ref — id записи в источнике, по нему действует
    UNIQUE(source, source_ref) и ON CONFLICT загрузчика. Примеры source_ref: legacy —
    id события старого бота, sackmann — tourney_id-match_num.
    """

    __tablename__ = "matches"
    __table_args__ = (
        UniqueConstraint("tournament_id", "round", "player1_id", "player2_id"),
        UniqueConstraint("source", "source_ref"),
        Index("ix_matches_scheduled_at", "scheduled_at"),
        Index("ix_matches_match_date", "match_date"),
        Index("ix_matches_player1_id", "player1_id"),
        Index("ix_matches_player2_id", "player2_id"),
        CheckConstraint("player1_id <> player2_id", name="distinct_players"),
        CheckConstraint(
            "winner_id IS NULL OR winner_id = player1_id OR winner_id = player2_id",
            name="winner_is_player",
        ),
        check_in("status", MATCH_STATUSES, "status"),
        check_in("best_of", (3, 5), "best_of"),
        check_in("source", MATCH_SOURCES, "source"),
        CheckConstraint(
            "tournament_id IS NOT NULL"
            " OR (source IN ('legacy', 'web', 'user') AND source_ref IS NOT NULL)",
            name="tournament_or_source_ref",
        ),
    )

    id: Mapped[BigIntPK]
    tournament_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("tournaments.id"))
    round: Mapped[str] = mapped_column(String(16), server_default="")
    scheduled_at: Mapped[datetime | None]
    # День матча из источника с датами (tennis-data). У матчей только из архива
    # Сакманна пустой: там есть лишь дата начала турнира
    match_date: Mapped[date | None]
    player1_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("players.id"))
    player2_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("players.id"))
    winner_id: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("players.id"))
    score: Mapped[str | None] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(16), server_default="scheduled")
    best_of: Mapped[int | None] = mapped_column(SmallInteger)
    source: Mapped[str] = mapped_column(String(16))
    # Id записи в источнике (см. docstring); NULL — у источника нет своего id
    source_ref: Mapped[str | None] = mapped_column(String(64))


class MatchStat(Base):
    """Статистика подачи игрока в матче (из архивов Сакманна и других источников)."""

    __tablename__ = "match_stats"

    match_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("matches.id", ondelete="CASCADE"), primary_key=True
    )
    player_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    aces: Mapped[int | None] = mapped_column(Integer)
    double_faults: Mapped[int | None]
    # Очки на своей подаче (svpt у Сакманна): база для процентов первой подачи
    serve_points: Mapped[int | None]
    first_in: Mapped[int | None]
    first_won: Mapped[int | None]
    second_won: Mapped[int | None]
    bp_saved: Mapped[int | None]
    bp_faced: Mapped[int | None]
    serve_games: Mapped[int | None]
    source: Mapped[str] = mapped_column(String(16))


class OddsSnapshot(Base):
    """Кэф на исход в момент времени: введенный пользователем, открытие, закрытие, API,
    архив. Закрывающий кэф нужен для CLV.

    Кэф из архива у исхода и букмекера один: повторная загрузка обновляет его
    (ON CONFLICT по частичному индексу uq_odds_snapshots_archive), а не добавляет строку.
    """

    __tablename__ = "odds_snapshots"
    __table_args__ = (
        Index("ix_odds_snapshots_match_id_market_taken_at", "match_id", "market", "taken_at"),
        Index(
            "uq_odds_snapshots_archive",
            "match_id",
            "market",
            "selection",
            "bookmaker",
            unique=True,
            postgresql_where=text("kind = 'archive'"),
        ),
        check_in("selection", (1, 2), "selection"),
        check_in("kind", ODDS_KINDS, "kind"),
        CheckConstraint("odds >= 1", name="odds_min"),
    )

    id: Mapped[BigIntPK]
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id", ondelete="CASCADE"))
    # ML, HCP_-1.5, HCP_+1.5 …
    market: Mapped[str] = mapped_column(String(32))
    selection: Mapped[int] = mapped_column(SmallInteger)
    bookmaker: Mapped[str] = mapped_column(String(64))
    odds: Mapped[Odds]
    kind: Mapped[str] = mapped_column(String(16))
    taken_at: Mapped[datetime] = mapped_column(server_default=func.now())


class Dossier(CreatedAtMixin, Base):
    """Досье матча на момент анализа: что именно видел Claude. Кэфов и банка
    пользователя в нем нет, поэтому одно досье общее для всех."""

    __tablename__ = "dossiers"
    __table_args__ = (Index("ix_dossiers_match_id_as_of", "match_id", "as_of"),)

    id: Mapped[BigIntPK]
    match_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("matches.id", ondelete="CASCADE"))
    as_of: Mapped[datetime]
    content: Mapped[dict[str, Any]]
    sha256: Mapped[Hash64] = mapped_column(unique=True)
    feature_set: Mapped[str] = mapped_column(String(32))
    news_version: Mapped[str | None] = mapped_column(String(64))


class MatchAssessment(CreatedAtMixin, Base):
    """Проверенная кодом оценка матча от Claude по одному досье. Общая для всех: в досье нет
    кэфов, банка и других личных данных. Свежая оценка с тем же ключом (досье, модель,
    effort, версия промпта и схемы) используется повторно без вызова Claude."""

    __tablename__ = "match_assessments"
    __table_args__ = (
        UniqueConstraint(
            "dossier_id",
            "model",
            "effort",
            "prompt_version",
            "schema_version",
            name="uq_match_assessments_key",
        ),
    )

    id: Mapped[BigIntPK]
    dossier_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("dossiers.id", ondelete="CASCADE")
    )
    model: Mapped[str] = mapped_column(String(64))
    effort: Mapped[str] = mapped_column(String(16))
    prompt_version: Mapped[str] = mapped_column(String(64))
    schema_version: Mapped[str] = mapped_column(String(32))
    output: Mapped[dict[str, Any]]
    agent_run_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("agent_runs.id", ondelete="SET NULL")
    )


class IngestionRun(Base):
    """Запуск загрузки данных (архивы, tennis-data, импорт старого бота) и его итог.
    В details — отчет загрузчика, например расхождения банка при импорте."""

    __tablename__ = "ingestion_runs"
    __table_args__ = (check_in("status", INGESTION_STATUSES, "status"),)

    id: Mapped[BigIntPK]
    source: Mapped[str] = mapped_column(String(32))
    started_at: Mapped[datetime] = mapped_column(server_default=func.now())
    finished_at: Mapped[datetime | None]
    rows: Mapped[int] = mapped_column(server_default="0")
    status: Mapped[str] = mapped_column(String(16), server_default="running")
    error: Mapped[str | None]
    details: Mapped[dict[str, Any]] = mapped_column(server_default=text("'{}'::jsonb"))


Index("ix_ingestion_runs_source_started_at", IngestionRun.source, IngestionRun.started_at.desc())
Index(
    "ix_player_news_player_id_published_at",
    PlayerNews.player_id,
    PlayerNews.published_at.desc(),
)
