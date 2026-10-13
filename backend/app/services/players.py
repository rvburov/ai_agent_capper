"""Игроки: поиск по имени, слияние дублей, ручная правка и слияние матчей (этап 2).

Один игрок приходит из разных источников под разными именами: «Синнер» из старого
бота, «Sinner J.» из tennis-data, «Jannik Sinner» из архива Сакманна. Загрузчики
сливают только однозначные случаи, остальное человек находит командой players-find
и сливает командой players-merge (app/admin/cli.py).

Поиск — pg_trgm: similarity и word_similarity по name, name_ru и каждому псевдониму.
Запрос ищется сложенным (без диакритики), как введен и, если он по-русски, в двух
транслитерациях: практической (Medvedev, Khachanov) и «латинской» (Djokovic,
Aliassime), потому что имена игроков из разных стран пишутся по-разному. Латиница
сравнивается еще и в упрощенном написании (c и k, s и z, v и w — одна буква):
так «Алькарас» находит Alcaraz. «е с двумя точками» во вводе и в базе — это «е».

Транзакции: merge_players, edit_player и merge_matches работают в точке сохранения
(SAVEPOINT), поэтому ошибка или конфликт откатывают действие целиком. С commit=True
(по умолчанию) действие и запись журнала фиксируются одним commit. С commit=False
фиксирует вызывающий: привязка старого бота (app/ingest/players_link.py) делает много
слияний одной транзакцией, а ее пробный запуск откатывает все.

Ссылки на игрока и на матч находятся по Base.metadata, а не списком: новая таблица
со ссылкой на players.id переносится при слиянии сама (дубли по ее уникальным ключам
удаляются). Для ссылок на матч нужно правило в _MATCH_RULES (сторона исхода 1/2
зависит от смысла таблицы): без него слияние матчей останавливается с ошибкой.
"""

import asyncio
import re
import time
from collections import Counter, defaultdict
from collections.abc import Callable, Collection, Generator, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from functools import cache
from pathlib import PurePosixPath
from typing import Any, Literal, Self
from weakref import WeakKeyDictionary

import numpy as np
from sqlalchemy import (
    ARRAY,
    BigInteger,
    Table,
    UniqueConstraint,
    and_,
    any_,
    bindparam,
    case,
    delete,
    exists,
    func,
    or_,
    select,
    text,
    update,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql.dml import Delete, Update

from app.agent.config import load_agent_config
from app.core.errors import AppError
from app.core.i18n import has_key, t
from app.db.base import Base
from app.db.models import IngestionRun, Match, Player, PlayerEloCurrent, Tournament, User
from app.ingest.names import fold, has_cyrillic, translit_ru
from app.ingest.sackmann import GENERIC_CATEGORY, PROMOTE_AFTER, PROMOTE_BEFORE
from app.ml.elo import CURRENT_DAYS
from app.schemas.players import PlayerCountsOut, PlayerRankingOut, PlayerRowOut
from app.services import player_card
from app.services.audit import write_audit
from app.services.bet_versions import touch_bets_on_matches
from app.services.sessions import utcnow

QUERY_MAX_LENGTH = 100
# players.name_ru — VARCHAR(200); псевдонимы того же предела
NAME_MAX_LENGTH = 200
SEARCH_LIMIT_MAX = 50
# Ниже этой оценки (0…1) совпадение в поиске не показывается
SEARCH_THRESHOLD = 0.3
UNMATCHED_SOURCES = ("sackmann", "tennis_data", "players_link")
UNMATCHED_LIMIT_MAX = 1000

# «е с двумя точками» (строчная и заглавная) → «е» в SQL: translate(value, :yo, :ye)
_YO = "\u0451\u0401"
_YE = "еЕ"
# «Латинская» транслитерация: так пишутся имена сербов, хорватов, португальцев,
# французов (Djokovic, Cilic, Joao, Aliassime). Сначала сочетания, потом буквы
_ALT_PAIRS = (("дж", "dj"), ("ья", "ia"), ("ье", "ie"), ("ью", "iu"), ("ьо", "io"))
_ALT_LETTERS = str.maketrans(
    {"ж": "j", "ч": "c", "ц": "c", "х": "h", "й": "i", "я": "ia", "ю": "iu", "ь": "", "ъ": ""}
)
# Упрощенное написание латиницы: буквы, которые путаются при переводе имени с русского
# и обратно, сводятся к одной (Алькарас → alkaras ↔ Alcaraz → alkaras; Вавринка ↔
# Wawrinka; Кобболи ↔ Cobolli). Та же замена — в SQL (translate) для имен из базы
_SKELETON_FROM = "cqzwyj"
_SKELETON_TO = "kksvii"
_SKELETON = str.maketrans(_SKELETON_FROM, _SKELETON_TO)
# Совпадение только упрощенного написания чуть ниже точного: точное имя — выше
SKELETON_WEIGHT = 0.99
# Поля игрока, которые при слиянии берутся у источника, если у цели пусто
_FILL_FIELDS = ("birth_date", "hand", "backhand", "country", "provider_id")
# Источники матчей и турниров архивов (копии матчей ищет _merge_copies)
_TENNIS_DATA = "tennis_data"
_SACKMANN = "sackmann"


class PlayerError(AppError):
    """Ошибка действий с игроками. Текст — из раздела players локали по полному ключу
    (players.errors.*). Это AppError: команды терминала печатают его текст, а маршрут
    API (этап 3) отдаст его в обычном формате ошибки."""

    def __init__(self, status_code: int, key: str, /, **params: Any) -> None:
        super().__init__(status_code, key, **params)

    @property
    def message(self) -> str:
        return t(self.code, **self.params)


# --- имена и поиск ---


def clean_text(value: str) -> str:
    """Имя для записи: без лишних пробелов, «е с двумя точками» → «е»."""
    return " ".join(value.replace("\u0451", "е").replace("\u0401", "Е").split())


def _alt_translit(folded: str) -> str:
    value = folded
    for pair, latin in _ALT_PAIRS:
        value = value.replace(pair, latin)
    return translit_ru(value.translate(_ALT_LETTERS))


def query_variants(query: str) -> list[str]:
    """Варианты строки для сравнения: сложенная (fold), как введена (с диакритикой) и,
    если в ней кириллица, две транслитерации. «Оже-Альяссим» → «оже альяссим»,
    «оже-альяссим», «ozhe alyassim», «oje aliassim»."""
    cleaned = clean_text(query).casefold()
    folded = fold(cleaned)
    variants = [folded, cleaned]
    if has_cyrillic(folded):
        variants += [translit_ru(folded), _alt_translit(folded)]
    return list(dict.fromkeys(variant for variant in variants if variant))


def skeletons(variants: Iterable[str]) -> list[str]:
    """Упрощенное написание вариантов с латиницей (см. _SKELETON_FROM)."""
    found = (variant.translate(_SKELETON) for variant in variants if not has_cyrillic(variant))
    return list(dict.fromkeys(found))


@dataclass
class PlayerHit:
    """Найденный игрок: оценка сходства 0…1, поле, по которому найден (name, name_ru или
    «alias: <псевдоним>»), и число его матчей в базе."""

    player: Player
    score: float
    matched: str
    matches: int = 0


@dataclass(frozen=True)
class _Score:
    player_id: int
    field: str
    value: str
    score: float
    matches: int

    @property
    def matched(self) -> str:
        return f"alias: {self.value}" if self.field == "alias" else self.field


# Лучшее совпадение каждого игрока по всем вариантам запроса и всем его именам: как
# есть и в упрощенном написании (skel). Сортировка: оценка, сходство строки целиком
# (точное имя выше вхождения), число матчей
_SCORES_SQL = text(
    """
WITH v AS (
    SELECT q, false AS skel FROM unnest(CAST(:variants AS text[])) AS q
    UNION
    SELECT q, true FROM unnest(CAST(:skeletons AS text[])) AS q
),
f AS (
    SELECT id, 'name' AS field, name AS value FROM players
    UNION ALL
    SELECT id, 'name_ru', name_ru FROM players WHERE name_ru IS NOT NULL
    UNION ALL
    SELECT p.id, 'alias', a.value FROM players AS p CROSS JOIN LATERAL unnest(p.aliases) AS a(value)
),
w AS (
    SELECT f.id, f.field, f.value, v.q, v.skel,
        CASE WHEN v.skel THEN translate(lower(f.value), :skel_from, :skel_to)
             ELSE translate(f.value, :yo, :ye) END AS form
    FROM f CROSS JOIN v
),
s AS (
    SELECT id, field, value,
        CASE WHEN skel THEN CAST(:skel_weight AS real) ELSE CAST(1 AS real) END
            * greatest(similarity(q, form), word_similarity(q, form)) AS score,
        similarity(q, form) AS full_score
    FROM w
),
best AS (
    SELECT DISTINCT ON (id) id, field, value, score, full_score
    FROM s
    WHERE score >= :threshold
    ORDER BY id, score DESC, full_score DESC,
        CASE field WHEN 'name' THEN 0 WHEN 'name_ru' THEN 1 ELSE 2 END, value
)
SELECT best.id, best.field, best.value, best.score,
    (SELECT count(*) FROM matches m
     WHERE m.player1_id = best.id OR m.player2_id = best.id) AS matches
FROM best
ORDER BY best.score DESC, best.full_score DESC, matches DESC, best.id
LIMIT :limit
"""
)


async def _scores(
    db: AsyncSession, variants: Sequence[str], *, threshold: float, limit: int
) -> list[_Score]:
    if not variants:
        return []
    rows = await db.execute(
        _SCORES_SQL,
        {
            "variants": list(variants),
            "skeletons": skeletons(variants),
            "skel_from": _SKELETON_FROM,
            "skel_to": _SKELETON_TO,
            "skel_weight": SKELETON_WEIGHT,
            "yo": _YO,
            "ye": _YE,
            "threshold": threshold,
            "limit": limit,
        },
    )
    return [
        _Score(int(pid), str(field_), str(value), float(score), int(matches))
        for pid, field_, value, score, matches in rows
    ]


def checked_query(query: str) -> str:
    """Запрос поиска без лишних пробелов. Пустой и длиннее QUERY_MAX_LENGTH — PlayerError."""
    cleaned = clean_text(query)
    if not fold(cleaned):
        raise PlayerError(422, "players.errors.query_empty")
    if len(cleaned) > QUERY_MAX_LENGTH:
        raise PlayerError(422, "players.errors.query_too_long", max=QUERY_MAX_LENGTH)
    return cleaned


async def search_players(db: AsyncSession, query: str, *, limit: int = 10) -> list[PlayerHit]:
    """Игроки, похожие на запрос, лучшие первыми (не больше limit, предел 50).
    Пустой запрос и запрос длиннее QUERY_MAX_LENGTH — PlayerError."""
    return await _hits(db, checked_query(query), max(1, min(limit, SEARCH_LIMIT_MAX)))


async def _hits(db: AsyncSession, cleaned: str, limit: int) -> list[PlayerHit]:
    scores = await _scores(db, query_variants(cleaned), threshold=SEARCH_THRESHOLD, limit=limit)
    found = await db.scalars(
        select(Player).where(Player.id.in_([score.player_id for score in scores]))
    )
    players = {player.id: player for player in found}
    return [
        PlayerHit(
            player=players[score.player_id],
            score=round(score.score, 3),
            matched=score.matched,
            matches=score.matches,
        )
        for score in scores
        if score.player_id in players
    ]


async def match_counts(db: AsyncSession, player_ids: Collection[int]) -> dict[int, int]:
    """Число матчей каждого игрока (в любой роли: игрок 1 или 2)."""
    counts = dict.fromkeys(player_ids, 0)
    for column in (Match.player1_id, Match.player2_id):
        rows = await db.execute(
            select(column, func.count()).where(column.in_(list(player_ids))).group_by(column)
        )
        for player_id, count in rows:
            counts[int(player_id)] += int(count)
    return counts


# --- ссылки по метаданным ---


def references_to(table_name: str) -> dict[str, tuple[str, ...]]:
    """Таблицы и их колонки со ссылкой на <table_name>.id — по Base.metadata."""
    found: dict[str, tuple[str, ...]] = {}
    for table in Base.metadata.sorted_tables:
        columns = tuple(
            column.name
            for column in table.columns
            if any(
                fk.column.table.name == table_name and fk.column.name == "id"
                for fk in column.foreign_keys
            )
        )
        if columns:
            found[table.name] = columns
    return found


def _unique_sets(table: Table) -> list[tuple[tuple[str, ...], bool]]:
    """Уникальные наборы колонок таблицы: (колонки, частичный ли индекс)."""
    sets: list[tuple[tuple[str, ...], bool]] = []
    if table.primary_key.columns:
        sets.append((tuple(column.name for column in table.primary_key.columns), False))
    for constraint in table.constraints:
        if isinstance(constraint, UniqueConstraint):
            sets.append((tuple(column.name for column in constraint.columns), False))
    for index in table.indexes:
        if index.unique:
            partial = index.dialect_options["postgresql"].get("where") is not None
            sets.append((tuple(column.name for column in index.columns), partial))
    return sets


def _rowcount(result: Any) -> int:
    return int(getattr(result, "rowcount", 0) or 0)


async def _execute(db: AsyncSession, stmt: Update | Delete) -> int:
    return _rowcount(await db.execute(stmt))


def _ids_text(ids: Iterable[int]) -> str:
    return ", ".join(str(item) for item in ids)


# --- слияние игроков ---

_PlayerRule = Literal["matches", "drop", "profile"]
# Таблицы с особым порядком слияния; остальные — общий: дубли по уникальным ключам
# удаляются у источника, ссылки переводятся на цель
_PLAYER_RULES: dict[str, _PlayerRule] = {
    # Матч игроков друг с другом и копия матча — ошибка (_check_player_matches),
    # а не удаление; иначе ссылки переводятся без поиска дублей
    "matches": "matches",
    # Рейтинги Эло источника не нужны: Эло пересчитывается по всей истории
    "player_ratings": "drop",
    # Текущее Эло и место (этап 4) — тоже: их заново пишет шаг elo
    "player_elo_current": "drop",
    # Профиль один на игрока: у цели остается свой, если он есть
    "player_profiles": "profile",
}


@dataclass
class MergeReport:
    """Итог слияния игроков: сколько строк перенесено и удалено по таблицам
    («таблица.колонка» → строки), какие поля и псевдонимы цель взяла у источника."""

    source_id: int
    target_id: int
    source_name: str
    target_name: str
    moved: dict[str, int] = field(default_factory=dict)
    removed: dict[str, int] = field(default_factory=dict)
    filled: list[str] = field(default_factory=list)
    aliases_added: list[str] = field(default_factory=list)
    # У обоих был профиль: остался профиль цели, профиль источника удален
    profile_kept_target: bool = False
    # Копии матчей tennis-data, слитые в матчи Сакманна (_merge_copies): id копии → id
    # матча Сакманна
    copies_merged: dict[int, int] = field(default_factory=dict)
    # Похоже на копию, но слить однозначно нельзя: id копии → id кандидатов. Сливает
    # человек командой matches-merge
    copies_left: dict[int, list[int]] = field(default_factory=dict)

    def details(self) -> dict[str, Any]:
        """Подробности для admin_audit_log (player_merge)."""
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "source_name": self.source_name,
            "target_name": self.target_name,
            "moved": dict(self.moved),
            "removed": dict(self.removed),
            "filled": list(self.filled),
            "aliases_added": list(self.aliases_added),
            "profile_kept_target": self.profile_kept_target,
            "copies_merged": {str(copy): match for copy, match in self.copies_merged.items()},
            "copies_left": {str(copy): ids for copy, ids in self.copies_left.items()},
        }


async def _lock_players(db: AsyncSession, ids: Sequence[int]) -> dict[int, Player]:
    found = await db.scalars(
        select(Player)
        .where(Player.id.in_(list(ids)))
        .order_by(Player.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    return {player.id: player for player in found}


async def _check_player_matches(db: AsyncSession, source: Player, target: Player) -> None:
    """Матчи, которые слияние сломало бы: игроки играли друг с другом, или у обоих есть
    матч с тем же соперником в том же турнире и раунде (копия одного матча)."""
    s, tg = source.id, target.id
    both = list(
        await db.scalars(
            select(Match.id)
            .where(
                or_(
                    and_(Match.player1_id == s, Match.player2_id == tg),
                    and_(Match.player1_id == tg, Match.player2_id == s),
                )
            )
            .order_by(Match.id)
        )
    )
    if both:
        raise PlayerError(409, "players.errors.merge_played_each_other", ids=_ids_text(both))
    a, b = aliased(Match), aliased(Match)
    clash = await db.execute(
        select(a.id, b.id)
        .where(
            a.tournament_id == b.tournament_id,
            a.round == b.round,
            or_(
                and_(a.player1_id == s, b.player1_id == tg, a.player2_id == b.player2_id),
                and_(a.player2_id == s, b.player2_id == tg, a.player1_id == b.player1_id),
            ),
        )
        .order_by(a.id)
    )
    pairs = clash.all()
    if pairs:
        raise PlayerError(
            409,
            "players.errors.merge_duplicate_match",
            pairs=", ".join(f"{x}/{y}" for x, y in pairs[:10]),
        )


async def _drop_duplicates(
    db: AsyncSession, table: Table, columns: Sequence[str], source_id: int, target_id: int
) -> int:
    """Удалить строки источника, которые после переноса совпали бы со строкой цели по
    уникальному ключу (новость с тем же адресом, статистика того же матча)."""
    removed = 0
    for unique, partial in _unique_sets(table):
        player_columns = [name for name in unique if name in columns]
        if not player_columns:
            continue
        if len(player_columns) > 1 or partial:
            # Без своего правила такую таблицу слить нельзя: нужен разбор человеком
            raise RuntimeError(f"нет правила слияния игроков для таблицы {table.name}")
        [column] = player_columns
        twin = table.alias("twin")
        same = [twin.c[name] == table.c[name] for name in unique if name != column]
        removed += await _execute(
            db,
            delete(table).where(
                table.c[column] == source_id,
                exists().where(twin.c[column] == target_id, *same),
            ),
        )
    return removed


async def _repoint(
    db: AsyncSession, table: Table, columns: Sequence[str], old: int, new: int
) -> int:
    """Все ссылки строки на old → new одним UPDATE: CHECK «победитель — один из игроков»
    проверяется по строке целиком, по колонке за раз он бы упал."""
    values = {name: case((table.c[name] == old, new), else_=table.c[name]) for name in columns}
    return await _execute(
        db,
        update(table).where(or_(*(table.c[name] == old for name in columns))).values(values),
    )


def _russian_name(player: Player) -> str | None:
    """Имя источника для name_ru цели: только по-русски (у заготовок старого бота
    name_ru = name, и оно бывает латиницей)."""
    for value in (player.name_ru, player.name, *player.aliases):
        if value and has_cyrillic(value):
            return clean_text(value)[:NAME_MAX_LENGTH]
    return None


async def _merge_players(db: AsyncSession, source_id: int, target_id: int) -> MergeReport:
    if source_id == target_id:
        raise PlayerError(422, "players.errors.merge_same", id=source_id)
    players = await _lock_players(db, (source_id, target_id))
    for player_id in (source_id, target_id):
        if player_id not in players:
            raise PlayerError(404, "players.errors.not_found", id=player_id)
    source, target = players[source_id], players[target_id]
    if source.sackmann_id is not None and target.sackmann_id is not None:
        # Загрузка архива снова создала бы игрока по sackmann_id источника
        raise PlayerError(
            409,
            "players.errors.merge_both_sackmann",
            source=source.sackmann_id,
            target=target.sackmann_id,
        )
    # Конфликты матчей — до любых изменений
    await _check_player_matches(db, source, target)
    source_matches = set(
        await db.scalars(
            select(Match.id).where(
                or_(Match.player1_id == source.id, Match.player2_id == source.id)
            )
        )
    )
    report = MergeReport(
        source_id=source.id,
        target_id=target.id,
        source_name=source.name,
        target_name=target.name,
    )
    for table_name, columns in references_to("players").items():
        table = Base.metadata.tables[table_name]
        rule = _PLAYER_RULES.get(table_name)
        if rule == "drop":
            count = await _execute(
                db, delete(table).where(or_(*(table.c[name] == source.id for name in columns)))
            )
            if count:
                report.removed[table_name] = count
            continue
        if rule == "profile":
            target_has = await db.scalar(
                select(exists().where(or_(*(table.c[name] == target.id for name in columns))))
            )
            if target_has:
                count = await _execute(
                    db, delete(table).where(or_(*(table.c[name] == source.id for name in columns)))
                )
                if count:
                    report.removed[table_name] = count
                    report.profile_kept_target = True
                continue
        elif rule is None:
            count = await _drop_duplicates(db, table, columns, source.id, target.id)
            if count:
                report.removed[table_name] = count
        moved = await _count_and_repoint(db, table, columns, source.id, target.id)
        report.moved.update({f"{table_name}.{name}": n for name, n in moved.items() if n})

    # Поля и имена источника переходят к цели; сам источник удаляется. sackmann_id
    # уникален, поэтому цель получает его только после удаления источника
    sackmann_id = source.sackmann_id
    for name in _FILL_FIELDS:
        if getattr(target, name) is None and getattr(source, name) is not None:
            setattr(target, name, getattr(source, name))
            report.filled.append(name)
    if not target.name_ru:
        russian = _russian_name(source)
        if russian:
            target.name_ru = russian
            report.filled.append("name_ru")
    known = {fold(value) for value in (target.name, target.name_ru, *target.aliases) if value}
    for value in (source.name, source.name_ru, *source.aliases):
        if value and fold(value) and fold(value) not in known:
            known.add(fold(value))
            report.aliases_added.append(value)
    if report.aliases_added:
        target.aliases = [*target.aliases, *report.aliases_added]
    await db.delete(source)
    await db.flush()
    if sackmann_id is not None and target.sackmann_id is None:
        target.sackmann_id = sackmann_id
        report.filled.insert(0, "sackmann_id")
    await db.flush()
    await _merge_copies(db, target.id, source_matches, report)
    return report


@dataclass(frozen=True)
class _ArchiveMatch:
    id: int
    source: str
    pair: frozenset[int]
    round: str
    match_date: date | None
    tournament_source: str | None
    start_date: date | None


async def _merge_copies(
    db: AsyncSession, player_id: int, source_matches: Collection[int], report: MergeReport
) -> None:
    """После слияния у игрока бывают две записи одного матча: матч tennis-data (свой
    турнир, день, кэфы, ставки старого бота) и матч Сакманна. Так выходит, когда загрузка
    Сакманна не усыновила игрока tennis-data («возможный дубль»): матчи с ним не
    повысились, и Сакманн создал свои. Копия сливается в матч Сакманна по правилам
    повышения (sackmann._promote): та же пара, день копии в окне турнира Сакманна, при
    нескольких кандидатах — тот же раунд, кандидат не нужен другой копии. Сравниваются
    только пары, где один матч был у источника слияния, другой — у цели. Неоднозначное —
    в report.copies_left (слить вручную командой matches-merge)."""
    if not source_matches:
        return
    rows = await db.execute(
        select(
            Match.id,
            Match.source,
            Match.player1_id,
            Match.player2_id,
            Match.round,
            Match.match_date,
            Tournament.source,
            Tournament.start_date,
        )
        .join(Tournament, Tournament.id == Match.tournament_id)
        .where(
            or_(Match.player1_id == player_id, Match.player2_id == player_id),
            Match.source.in_((_TENNIS_DATA, _SACKMANN)),
        )
        .order_by(Match.id)
    )
    found = [
        _ArchiveMatch(
            id=row[0],
            source=row[1],
            pair=frozenset((row[2], row[3])),
            round=row[4],
            match_date=row[5],
            tournament_source=row[6],
            start_date=row[7],
        )
        for row in rows
    ]
    copies = [
        item
        for item in found
        if item.source == _TENNIS_DATA
        and item.tournament_source == _TENNIS_DATA
        and item.match_date is not None
    ]
    archive = [item for item in found if item.source == _SACKMANN and item.start_date]
    options: dict[int, list[_ArchiveMatch]] = {}
    for copy in copies:
        assert copy.match_date is not None
        day = copy.match_date
        near = [
            item
            for item in archive
            if item.pair == copy.pair
            and (item.id in source_matches) != (copy.id in source_matches)
            and item.start_date is not None
            and item.start_date - PROMOTE_BEFORE <= day <= item.start_date + PROMOTE_AFTER
            and item.match_date in (None, day)
        ]
        if len(near) > 1:
            same_round = [item for item in near if item.round == copy.round]
            if not same_round:
                report.copies_left[copy.id] = sorted(item.id for item in near)
                continue
            near = same_round
        if near:
            options[copy.id] = near
    wanted = Counter(item.id for near in options.values() for item in near)
    for copy_id, near in options.items():
        if len(near) == 1 and wanted[near[0].id] == 1:
            try:
                async with db.begin_nested():
                    await _merge_matches(db, copy_id, near[0].id, None)
            except PlayerError:
                # Конфликт прогнозов и т. п.: решает человек (matches-merge покажет причину)
                report.copies_left[copy_id] = [near[0].id]
                continue
            report.copies_merged[copy_id] = near[0].id
        else:
            report.copies_left[copy_id] = sorted(item.id for item in near)


async def _count_and_repoint(
    db: AsyncSession, table: Table, columns: Sequence[str], old: int, new: int
) -> dict[str, int]:
    """Сколько ссылок по каждой колонке переведено со старого игрока на нового."""
    counts: dict[str, int] = {}
    for name in columns:
        counts[name] = int(
            await db.scalar(select(func.count()).select_from(table).where(table.c[name] == old))
            or 0
        )
    if any(counts.values()):
        await _repoint(db, table, columns, old, new)
    return counts


async def merge_players(
    db: AsyncSession,
    *,
    source_id: int,
    target_id: int,
    actor_id: int | None,
    commit: bool = True,
    audit: bool = True,
) -> MergeReport:
    """Слить игрока source_id в target_id: все ссылки на источник переходят к цели,
    пустые поля цели заполняются у источника, его имена уходят в псевдонимы цели,
    источник удаляется. Конфликты (матч игроков друг с другом, копия матча, оба из
    архива Сакманна) — PlayerError, база не меняется. Запись журнала player_merge
    (audit=False — без нее: привязка старого бота пишет итог в ingestion_runs)."""
    try:
        async with db.begin_nested():
            report = await _merge_players(db, source_id, target_id)
            if audit:
                await write_audit(
                    db, action="player_merge", actor_id=actor_id, details=report.details()
                )
    except Exception:
        if commit:
            await db.rollback()
        raise
    if commit:
        await db.commit()
    return report


# --- правка игрока ---


def _checked_name(value: str, *, empty_key: str | None) -> str | None:
    cleaned = clean_text(value)
    if not cleaned:
        if empty_key is not None:
            raise PlayerError(422, empty_key)
        return None
    if len(cleaned) > NAME_MAX_LENGTH:
        raise PlayerError(422, "players.errors.name_too_long", max=NAME_MAX_LENGTH)
    return cleaned


async def edit_player(
    db: AsyncSession,
    player_id: int,
    *,
    name_ru: str | None = None,
    add_alias: str | None = None,
    remove_alias: str | None = None,
    actor_id: int | None,
    commit: bool = True,
) -> Player:
    """Поменять имя по-русски и псевдонимы. None — поле не трогать; name_ru="" —
    стереть имя по-русски. Сначала удаляется remove_alias, потом добавляется
    add_alias (так псевдоним можно переписать одной командой). Если что-то
    изменилось — запись журнала player_edit со старым и новым значением."""
    if name_ru is None and add_alias is None and remove_alias is None:
        raise PlayerError(422, "players.errors.edit_nothing")
    try:
        async with db.begin_nested():
            player = (await _lock_players(db, (player_id,))).get(player_id)
            if player is None:
                raise PlayerError(404, "players.errors.not_found", id=player_id)
            changes: dict[str, Any] = {}
            if name_ru is not None:
                value = _checked_name(name_ru, empty_key=None)
                if value != player.name_ru:
                    changes["name_ru"] = {"old": player.name_ru, "new": value}
                    player.name_ru = value
            aliases = list(player.aliases)
            if remove_alias is not None:
                removed = _checked_name(remove_alias, empty_key="players.errors.alias_empty")
                assert removed is not None
                gone = [alias for alias in aliases if fold(alias) == fold(removed)]
                if not gone:
                    raise PlayerError(404, "players.errors.alias_not_found", alias=removed)
                aliases = [alias for alias in aliases if alias not in gone]
                changes["aliases_removed"] = gone
            if add_alias is not None:
                added = _checked_name(add_alias, empty_key="players.errors.alias_empty")
                assert added is not None
                if added not in aliases:
                    aliases.append(added)
                    changes["aliases_added"] = [added]
            if aliases != player.aliases:
                player.aliases = aliases
            if changes:
                await db.flush()
                await write_audit(
                    db,
                    action="player_edit",
                    actor_id=actor_id,
                    details={"player_id": player.id, "name": player.name, **changes},
                )
    except Exception:
        if commit:
            await db.rollback()
        raise
    if commit:
        await db.commit()
    return player


# --- слияние матчей ---

_MatchRule = Literal["odds", "selection", "plain", "stats"]
# Как переносить строки, которые ссылаются на матч. selection — колонка стороны
# исхода (1 — игрок 1 матча, 2 — игрок 2): при другом порядке игроков она меняется
_MATCH_RULES: dict[str, _MatchRule] = {
    # Кэф архива у исхода и букмекера один: копия источника удаляется
    "odds_snapshots": "odds",
    # Два прогноза одного анализа на один исход — конфликт, а не удаление
    "predictions": "selection",
    "bet_legs": "selection",
    "dossiers": "plain",
    # Статистика привязана к игроку: переносится только для игроков матча-цели
    "match_stats": "stats",
}


@dataclass
class MatchMergeReport:
    """Итог слияния матчей: перенесенные и удаленные строки по таблицам, поля цели,
    заполненные у источника, и перевернута ли сторона исхода."""

    source_id: int
    target_id: int
    flipped: bool
    moved: dict[str, int] = field(default_factory=dict)
    removed: dict[str, int] = field(default_factory=dict)
    filled: list[str] = field(default_factory=list)


def _match_rules() -> dict[str, tuple[_MatchRule, tuple[str, ...]]]:
    refs = references_to("matches")
    unknown = sorted(set(refs) - set(_MATCH_RULES))
    if unknown:
        raise RuntimeError(f"нет правила слияния матчей для таблиц: {', '.join(unknown)}")
    return {name: (_MATCH_RULES[name], columns) for name, columns in refs.items()}


def _flipped(table: Table, flip: bool) -> Any:
    selection = table.c["selection"]
    return 3 - selection if flip else selection


async def _merge_matches(
    db: AsyncSession, source_id: int, target_id: int, flip: bool | None
) -> MatchMergeReport:
    if source_id == target_id:
        raise PlayerError(422, "players.errors.match_merge_same", id=source_id)
    rules = _match_rules()
    found = await db.scalars(
        select(Match)
        .where(Match.id.in_((source_id, target_id)))
        .order_by(Match.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    matches = {match.id: match for match in found}
    for match_id in (source_id, target_id):
        if match_id not in matches:
            raise PlayerError(404, "players.errors.match_not_found", id=match_id)
    source, target = matches[source_id], matches[target_id]
    if flip is None:
        pair = (source.player1_id, source.player2_id)
        if pair == (target.player1_id, target.player2_id):
            flip = False
        elif pair == (target.player2_id, target.player1_id):
            flip = True
        else:
            raise PlayerError(
                409, "players.errors.match_players_differ", source=source_id, target=target_id
            )
    report = MatchMergeReport(source_id=source_id, target_id=target_id, flipped=flip)
    if flip:
        # Сторона ног перевернется: открытые до слияния окна расчета — устаревшие
        await touch_bets_on_matches(db, [source_id])
    for table_name, (rule, columns) in rules.items():
        table = Base.metadata.tables[table_name]
        twin = table.alias("twin")
        for column in columns:
            ref = table.c[column]
            if rule == "odds":
                count = await _execute(
                    db,
                    delete(table).where(
                        ref == source_id,
                        table.c.kind == "archive",
                        exists().where(
                            twin.c[column] == target_id,
                            twin.c.kind == "archive",
                            twin.c.market == table.c.market,
                            twin.c.bookmaker == table.c.bookmaker,
                            twin.c.selection == _flipped(table, flip),
                        ),
                    ),
                )
                if count:
                    report.removed[table_name] = count
            if rule == "stats":
                count = await _execute(
                    db,
                    delete(table).where(
                        ref == source_id,
                        or_(
                            table.c.player_id.not_in((target.player1_id, target.player2_id)),
                            exists().where(
                                twin.c[column] == target_id,
                                twin.c.player_id == table.c.player_id,
                            ),
                        ),
                    ),
                )
                if count:
                    report.removed[table_name] = count
            values: dict[str, Any] = {column: target_id}
            if rule in ("odds", "selection"):
                values["selection"] = _flipped(table, flip)
            try:
                count = await _execute(db, update(table).where(ref == source_id).values(values))
            except IntegrityError:
                raise PlayerError(
                    409,
                    "players.errors.match_merge_conflict",
                    table=table_name,
                    source=source_id,
                    target=target_id,
                ) from None
            if count:
                report.moved[table_name] = count
    for name in ("scheduled_at", "match_date"):
        if getattr(target, name) is None and getattr(source, name) is not None:
            setattr(target, name, getattr(source, name))
            report.filled.append(name)
    source_tournament = source.tournament_id
    await db.delete(source)
    await db.flush()
    if (
        source_tournament is not None
        and source_tournament != target.tournament_id
        and await _absorb_tournament(db, source_tournament, target.tournament_id)
    ):
        report.removed["tournaments"] = 1
    return report


async def _absorb_tournament(db: AsyncSession, source_id: int, target_id: int | None) -> bool:
    """Турнир tennis-data, оставшийся без матчей после слияния: зал, город и уточненная
    категория (250/500) переходят в турнир цели, если там пусто (как при повышении
    матчей загрузкой Сакманна), пустой турнир удаляется. Турниры других источников не
    трогаются: пустые турниры старого бота удаляет привязка (players_link)."""
    tour = await db.get(Tournament, source_id)
    if tour is None or tour.source != _TENNIS_DATA:
        return False
    if await db.scalar(select(exists().where(Match.tournament_id == source_id))):
        return False
    target = await db.get(Tournament, target_id) if target_id is not None else None
    if target is not None:
        if target.indoor is None and tour.indoor is not None:
            target.indoor = tour.indoor
        if not target.city and tour.city:
            target.city = tour.city
        if tour.category and target.category in (None, GENERIC_CATEGORY):
            target.category = tour.category
    await db.delete(tour)
    await db.flush()
    return True


async def merge_matches(
    db: AsyncSession,
    *,
    source_match_id: int,
    target_match_id: int,
    flip: bool | None = None,
    commit: bool = True,
) -> MatchMergeReport:
    """Слить матч-копию source_match_id в target_match_id: кэфы, досье, прогнозы,
    события ставок и статистика переходят к цели, пустые scheduled_at и match_date
    цели заполняются у источника, источник удаляется.

    flip — у матчей обратный порядок игроков (сторона исхода 1 ↔ 2 у кэфов, прогнозов
    и ставок). None — определить по игрокам: у матчей должна быть одна пара, иначе
    PlayerError. Явный flip нужен, когда игроки источника еще не слиты с игроками цели
    (привязка старого бота). Конфликт прогнозов — PlayerError, база не меняется."""
    try:
        async with db.begin_nested():
            report = await _merge_matches(db, source_match_id, target_match_id, flip)
    except Exception:
        if commit:
            await db.rollback()
        raise
    if commit:
        await db.commit()
    return report


# --- несопоставленные строки загрузок ---


@dataclass
class UnmatchedRun:
    """Несопоставленные строки источника: числа по видам (counts) и примеры (rows, не
    больше limit). run_id и finished_at — последний успешный запуск.

    Неизменившийся файл (тот же sha256) загрузчик не разбирает, и в ночном запуске его
    строк нет. Поэтому строки каждого файла берутся из последнего успешного запуска,
    который этот файл разбирал; run_ids — запуски, из которых взяты строки и числа,
    новые первыми. exact = False — counts не меньше показанных: часть чисел посчитана
    по примерам, а журнал хранит не больше 200 примеров на вид."""

    source: str
    run_id: int
    finished_at: datetime | None
    counts: dict[str, int]
    rows: list[dict[str, Any]]
    run_ids: list[int] = field(default_factory=list)
    exact: bool = True

    @property
    def total(self) -> int:
        return sum(self.counts.values())


@dataclass
class _OkRun:
    id: int
    finished_at: datetime | None
    files: dict[str, str]
    counts: dict[str, int]

    @property
    def unmatched(self) -> dict[str, int]:
        return {
            key.removeprefix("unmatched."): value
            for key, value in self.counts.items()
            if key.startswith("unmatched.")
        }


def _int_dict(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    return {str(key): item for key, item in value.items() if isinstance(item, int)}


def _str_dict(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    return {str(key): str(item) for key, item in value.items()}


def _parsed_files(runs: Sequence[_OkRun]) -> dict[int, set[str]]:
    """Файлы, которые разбирал каждый запуск (runs — от старых к новым): файл новый или
    его sha256 другой, чем в прошлом успешном запуске, или запуск ничего не пропускал по
    sha256 (files.unchanged нет — например, --force). Как last_ok_file_hashes."""
    last: dict[str, str] = {}
    parsed: dict[int, set[str]] = {}
    for run in runs:
        skips = run.counts.get("files.unchanged", 0) > 0
        parsed[run.id] = {
            path for path, sha in run.files.items() if not skips or last.get(path) != sha
        }
        last.update(run.files)
    return parsed


def _row_paths(paths: Collection[str]) -> Callable[[dict[str, Any]], str | None]:
    """Файл строки → путь файла в отчете (строка хранит путь, а в старых отчетах бывает
    только имя файла); None — строка без известного файла."""
    by_name: dict[str, str | None] = {}
    for path in paths:
        name = PurePosixPath(path).name
        by_name[name] = None if name in by_name else path

    def path_of(row: dict[str, Any]) -> str | None:
        file = row.get("file")
        if not isinstance(file, str):
            return None
        if file in paths:
            return file
        return by_name.get(PurePosixPath(file).name)

    return path_of


async def _source_unmatched(db: AsyncSession, source: str, limit: int) -> UnmatchedRun | None:
    found = await db.execute(
        select(
            IngestionRun.id,
            IngestionRun.finished_at,
            IngestionRun.started_at,
            IngestionRun.details["files"],
            IngestionRun.details["counts"],
        )
        .where(IngestionRun.source == source, IngestionRun.status == "ok")
        .order_by(IngestionRun.started_at, IngestionRun.id)
    )
    runs = [
        _OkRun(run_id, finished or started, _str_dict(files), _int_dict(counts))
        for run_id, finished, started, files, counts in found
    ]
    if not runs:
        return None
    newest = runs[-1]
    parsed = _parsed_files(runs)
    owner = {path: run.id for run in runs for path in parsed[run.id]}
    path_of = _row_paths(set(owner))
    wanted = [newest.id, *sorted(set(owner.values()) - {newest.id}, reverse=True)]
    raw = {
        run_id: [row for row in rows if isinstance(row, dict)] if isinstance(rows, list) else []
        for run_id, rows in await db.execute(
            select(IngestionRun.id, IngestionRun.details["unmatched"]).where(
                IngestionRun.id.in_(wanted)
            )
        )
    }
    # Строки последнего запуска — все: раз в нем есть строка файла, он этот файл разбирал
    for row in raw.get(newest.id, []):
        path = path_of(row)
        if path is not None:
            owner[path] = newest.id
    by_id = {run.id: run for run in runs}
    result = UnmatchedRun(
        source=source, run_id=newest.id, finished_at=newest.finished_at, counts={}, rows=[]
    )
    counts: Counter[str] = Counter()
    for run_id in wanted:
        run, rows = by_id[run_id], raw.get(run_id, [])
        shown = [
            row for row in rows if run_id == newest.id or owner.get(path_of(row) or "") == run_id
        ]
        owned = {path for path, item in owner.items() if item == run_id}
        whole = len(shown) == len(rows) and parsed[run_id] <= owned
        if whole and run.unmatched:
            counts.update(run.unmatched)
        else:
            counts.update(str(row.get("kind", "")) for row in shown)
            stored = Counter(str(row.get("kind", "")) for row in rows)
            if any(count > stored[kind] for kind, count in run.unmatched.items()):
                # Примеров меньше, чем строк: у части строк файл неизвестен
                result.exact = False
        if shown or (whole and run.unmatched):
            result.run_ids.append(run_id)
            result.rows += shown
    result.counts = dict(counts)
    result.rows = result.rows[:limit]
    return result


async def recent_unmatched(
    db: AsyncSession, *, limit: int = 50, sources: Sequence[str] = UNMATCHED_SOURCES
) -> list[UnmatchedRun]:
    """Несопоставленные строки по источникам: по каждому файлу — из последнего успешного
    запуска, который его разбирал, без файла (привязка старого бота) — из последнего
    успешного запуска (см. UnmatchedRun). Источник без успешных запусков пропускается."""
    limit = max(1, min(limit, UNMATCHED_LIMIT_MAX))
    runs: list[UnmatchedRun] = []
    for source in sources:
        found = await _source_unmatched(db, source, limit)
        if found is not None:
            runs.append(found)
    return runs


# --- список «Игроки» (этап 4) ---

RANKING_LIMIT = 50
RANKING_LIMIT_MAX = 100
_WORD_SPLIT = re.compile(r"[\s\-]+")
# Поиск в списке — как в согласованном макете (mockup/js/screens/players.js, searchMatch).
# Точное совпадение: каждое слово запроса — часть слова имени (по-русски, латиницей, в
# упрощенном написании) или страны (код IOC или название по-русски, players.countries в
# локали). Если точных нет — похожие: слово запроса от NEAR_MIN букв — часть слова или
# отличается от слова, его начала той же длины или на букву длиннее не больше чем на
# NEAR_EDITS правок (NEAR_EDITS_LONG у слов запроса от NEAR_LONG букв, расстояние
# Левенштейна): «синер» — Синнер, «рублв» — Рублев, а не все имена с похожими слогами
NEAR_MIN = 4
NEAR_LONG = 7
NEAR_EDITS = 1
NEAR_EDITS_LONG = 2
# Больше слов в имени и стране не бывает: остальные слова запроса не учитываются
SEARCH_WORDS_MAX = 8


@dataclass(frozen=True)
class RankingQuery:
    """Параметры списка «Игроки» (см. app/schemas/players.PlayerRankingOut)."""

    q: str | None = None
    surface: str = "hard"
    data: str = "active"
    sort: str = "rank"
    offset: int = 0
    limit: int = RANKING_LIMIT


def _text_words(text: str) -> set[str]:
    """Слова текста, сложенные, и упрощенное написание слов латиницей."""
    words = {word for word in _WORD_SPLIT.split(fold(text)) if word}
    return words | {word.translate(_SKELETON) for word in words if not has_cyrillic(word)}


@cache
def _country_words(country: str) -> frozenset[str]:
    """Слова страны: код и название по-русски (players.countries в локали). Стран около
    150 на 2 800 игроков — при сборке индекса каждая разбирается один раз."""
    words = _text_words(country)
    key = f"players.countries.{country.upper()}"
    if has_key(key):
        words |= _text_words(t(key))
    return frozenset(words)


def _words_of(names: Iterable[str | None], country: str | None) -> set[str]:
    """Слова имен игрока (имя, по-русски, псевдонимы) и страны (код и название по-русски),
    сложенные, и упрощенное написание слов латиницей."""
    words = {word for name in names if name for word in _text_words(name)}
    return words | _country_words(country) if country else words


def _query_tokens(cleaned: str) -> list[list[str]]:
    """Слова запроса в каждом варианте (как введен, транслитерации, упрощенное написание),
    без повторов и не больше SEARCH_WORDS_MAX."""
    variants = query_variants(cleaned)
    found: list[list[str]] = []
    for variant in [*variants, *skeletons(variants)]:
        tokens = list(dict.fromkeys(token for token in _WORD_SPLIT.split(variant) if token))
        if tokens and tokens[:SEARCH_WORDS_MAX] not in found:
            found.append(tokens[:SEARCH_WORDS_MAX])
    return found


def exact_match(player: Player, cleaned: str) -> bool:
    """Каждое слово запроса — часть какого-то слова имени или страны (в любом из вариантов
    запроса). Как «точное» совпадение макета: «синнер», «sinn», «Джок», «ITA», «Италия» —
    точные, «синер» — только с учетом опечатки."""
    words = _words_of((player.name, player.name_ru, *player.aliases), player.country)
    return any(
        all(any(token in word for word in words) for token in tokens)
        for tokens in _query_tokens(cleaned)
    )


def _codes(text: str) -> list[int]:
    return [ord(char) for char in text]


def _code_rows(texts: list[str], size: int) -> Any:
    """Коды букв строк одной длины size — матрица N × size (одним вызовом numpy)."""
    return np.frombuffer("".join(texts).encode("utf-32-le"), dtype="<u4").reshape(-1, size)


def _near_rows(token: str, block: Any, edits: int) -> Any:
    """Строки блока (N × m, коды букв) на расстоянии Левенштейна от token не больше edits:
    таблица расстояний считается строкой за строкой для всех строк блока сразу, вставки —
    накопленным минимумом по строке."""
    rows, width = block.shape
    cols = np.arange(width + 1)
    prev = np.broadcast_to(cols, (rows, width + 1)).copy()
    for position, code in enumerate(_codes(token), start=1):
        cur = np.empty_like(prev)
        cur[:, 0] = position
        cur[:, 1:] = np.minimum(prev[:, 1:] + 1, prev[:, :-1] + (block != code))
        prev = np.minimum.accumulate(cur - cols, axis=1) + cols
    return prev[:, width] <= edits


# Строка таблицы players для индекса: id, имя, по-русски, псевдонимы, страна
_IndexRow = tuple[int, str, str | None, list[str], str | None]
# Сколько секунд сборка индекса работает подряд, не отдавая цикл событий
BUILD_SLICE = 0.004


@dataclass(frozen=True)
class _Block:
    """Строки одной длины (коды букв, N × длина) и слова каждой строки."""

    codes: Any
    words: list[list[int]]


@dataclass
class SearchIndex:
    """Слова всех игроков для поиска в списке: слово → игроки; начала слов по длине (для
    похожих). Строится по таблице players и живет, пока она не изменилась."""

    words: list[str]
    owners: list[frozenset[int]]
    prefixes: dict[int, _Block]
    whole: dict[int, _Block]

    @classmethod
    def build(cls, rows: Iterable[_IndexRow]) -> Self:
        steps = cls._steps(rows)
        while True:
            try:
                next(steps)
            except StopIteration as done:
                index: Self = done.value
                return index

    @classmethod
    async def build_async(cls, rows: Iterable[_IndexRow]) -> Self:
        """Как build, но отдает цикл событий каждые BUILD_SLICE секунд работы: сборка —
        чистый Python на десятки миллисекунд, и в отдельном потоке она держала бы GIL, а
        параллельные запросы ждали бы так же."""
        steps = cls._steps(rows)
        while True:
            try:
                next(steps)
            except StopIteration as done:
                index: Self = done.value
                return index
            await asyncio.sleep(0)

    @classmethod
    def _steps(cls, rows: Iterable[_IndexRow]) -> Generator[None, None, Self]:
        """Сборка по шагам: yield — место, где можно отдать цикл событий."""
        mark = time.perf_counter()

        def due() -> bool:
            nonlocal mark
            now = time.perf_counter()
            if now - mark < BUILD_SLICE:
                return False
            mark = now
            return True

        owners: dict[str, set[int]] = defaultdict(set)
        for player_id, name, name_ru, aliases, country in rows:
            for word in _words_of((name, name_ru, *aliases), country):
                owners[word].add(player_id)
            if due():
                yield
        words = sorted(owners)
        prefixes: dict[int, dict[str, list[int]]] = defaultdict(dict)
        whole: dict[int, list[int]] = defaultdict(list)
        for number, word in enumerate(words):
            whole[len(word)].append(number)
            for size in range(NEAR_MIN, len(word) + 1):
                prefixes[size].setdefault(word[:size], []).append(number)
            if due():
                yield
        prefix_blocks: dict[int, _Block] = {}
        for size, found in prefixes.items():
            prefix_blocks[size] = _Block(_code_rows(list(found), size), list(found.values()))
            if due():
                yield
        whole_blocks = {
            size: _Block(_code_rows([words[n] for n in numbers], size), [[n] for n in numbers])
            for size, numbers in whole.items()
        }
        return cls(
            words=words,
            owners=[frozenset(owners[word]) for word in words],
            prefixes=prefix_blocks,
            whole=whole_blocks,
        )

    def _owners(self, numbers: Iterable[int]) -> set[int]:
        found: set[int] = set()
        for number in numbers:
            found |= self.owners[number]
        return found

    def _containing(self, token: str) -> set[int]:
        return {number for number, word in enumerate(self.words) if token in word}

    def _near(self, token: str) -> set[int]:
        """Слова, похожие на token (как near в макете): само слово, его начало длины token
        или на букву длиннее."""
        size = len(token)
        if size < NEAR_MIN:
            return set()
        edits = NEAR_EDITS_LONG if size >= NEAR_LONG else NEAR_EDITS
        found: set[int] = set()
        blocks = [self.prefixes.get(size), self.prefixes.get(size + 1)]
        blocks += [
            self.whole.get(length)
            for length in range(size - edits, size + edits + 1)
            if length not in (size, size + 1)
        ]
        for block in blocks:
            if block is None:
                continue
            for row in np.flatnonzero(_near_rows(token, block.codes, edits)):
                found.update(block.words[int(row)])
        return found

    def find(self, cleaned: str, pool: Collection[int] | None = None) -> tuple[set[int], bool]:
        """Игроки по запросу и признак «только похожие»: сначала точные совпадения по всей
        базе (pool — только среди этих игроков), если их нет — похожие."""
        variants = _query_tokens(cleaned)
        # Варианты запроса часто дают те же слова: каждое слово ищется один раз
        containing: dict[str, set[int]] = {}

        def owners(token: str, near: bool) -> set[int]:
            if token not in containing:
                containing[token] = self._owners(self._containing(token))
            found = containing[token]
            return found | self._owners(self._near(token)) if near else found

        def matched(near: bool) -> set[int]:
            found: set[int] = set()
            cache: dict[str, set[int]] = {}
            for tokens in variants:
                players: set[int] | None = None
                for token in tokens:
                    if token not in cache:
                        cache[token] = owners(token, near)
                    players = cache[token] if players is None else players & cache[token]
                    if not players:
                        break
                found |= players or set()
            return found if pool is None else found & set(pool)

        exact = matched(near=False)
        if exact:
            return exact, False
        return matched(near=True), True


# Отпечаток таблицы players для SearchIndex: число строк и сумма хешей полей поиска
_INDEX_VERSION_SQL = text(
    """
SELECT current_database(), count(*), coalesce(sum(hashtext(
    id::text || '|' || name || '|' || coalesce(name_ru, '') || '|'
    || array_to_string(aliases, '|') || '|' || coalesce(country, '')
)), 0)
FROM players
"""
)
_SEARCH_INDEX: dict[str, tuple[tuple[int, int], SearchIndex]] = {}
# Одна сборка за раз на цикл событий: параллельные запросы ждут ее, а не строят индекс
# второй раз (asyncio.Lock привязан к циклу, у тестов циклы разные)
_SEARCH_LOCKS: WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock] = WeakKeyDictionary()


async def search_index(db: AsyncSession) -> SearchIndex:
    """Индекс поиска в списке «Игроки»: пересобирается, только если таблица players
    изменилась (загрузка, слияние, правка имени), иначе берется из памяти процесса.
    Ключ — база (у тестов своя). Сборка — работа процессора на десятки миллисекунд: она
    идет кусками и между ними отдает цикл событий (SearchIndex.build_async)."""
    database, count, digest = (await db.execute(_INDEX_VERSION_SQL)).one()
    version = (int(count), int(digest))
    cached = _SEARCH_INDEX.get(database)
    if cached is not None and cached[0] == version:
        return cached[1]
    lock = _SEARCH_LOCKS.setdefault(asyncio.get_running_loop(), asyncio.Lock())
    async with lock:
        cached = _SEARCH_INDEX.get(database)
        if cached is not None and cached[0] == version:
            return cached[1]
        rows = await db.execute(
            select(Player.id, Player.name, Player.name_ru, Player.aliases, Player.country)
        )
        players = [
            (int(pid), name, name_ru, list(aliases or []), country)
            for pid, name, name_ru, aliases, country in rows
        ]
        index = await SearchIndex.build_async(players)
        _SEARCH_INDEX[database] = (version, index)
        return index


def _elo_column(surface: str) -> Any:
    return {
        "hard": PlayerEloCurrent.elo_hard,
        "clay": PlayerEloCurrent.elo_clay,
        "grass": PlayerEloCurrent.elo_grass,
    }[surface]


def _ranking_order(sort: str, surface: str) -> list[Any]:
    current = PlayerEloCurrent
    by_rank = [current.rank_all.asc().nulls_last(), current.elo_all.desc().nulls_last()]
    if sort == "elo":
        return [_elo_column(surface).desc().nulls_last(), *by_rank, Player.id]
    if sort == "last":
        return [current.last_match.desc().nulls_last(), *by_rank, Player.id]
    return [*by_rank, Player.id]


async def ranking(
    db: AsyncSession, user: User, params: RankingQuery, *, now: datetime | None = None
) -> PlayerRankingOut:
    """Страница списка «Игроки» по player_elo_current: без поиска — набор по data
    (active — с матчами за 52 недели, news — новости свежее кэша новостей, all — вся
    база), с поиском — вся база (data = news сужает; см. SearchIndex.find). Сортировка —
    sort, страницы — offset и limit. «Сегодня» — только из своих ставок и анализов (user)."""
    now = now or utcnow()
    config = await load_agent_config(db)
    fresh_since = now - timedelta(hours=config.news_ttl_hours)
    news_fresh = Player.news_checked_at >= fresh_since
    conds: list[Any] = []
    fuzzy = False
    query: str | None = None
    if params.q is not None and params.q.strip():
        query = checked_query(params.q)
        # data = news сужает поиск, как в макете: точные и похожие — среди свежих новостей
        pool = (
            set(await db.scalars(select(Player.id).where(news_fresh)))
            if params.data == "news"
            else None
        )
        found, fuzzy = (await search_index(db)).find(query, pool)
        conds.append(Player.id == any_(bindparam("found", sorted(found), ARRAY(BigInteger))))
    elif params.data == "active":
        conds.append(PlayerEloCurrent.matches_52w > 0)
    elif params.data == "news":
        conds.append(news_fresh)
    base = (
        select(Player.id)
        .select_from(Player)
        .outerjoin(PlayerEloCurrent, PlayerEloCurrent.player_id == Player.id)
        .where(*conds)
    )
    total = await db.scalar(select(func.count()).select_from(base.subquery()))
    ids = list(
        await db.scalars(
            base.order_by(*_ranking_order(params.sort, params.surface))
            .offset(params.offset)
            .limit(params.limit)
        )
    )
    players = {
        player.id: player for player in await db.scalars(select(Player).where(Player.id.in_(ids)))
    }
    current = await player_card.current_rows(db, ids)
    forms = await player_card.recent_forms(db, ids)
    today = player_card.today_players(await player_card.today_matches(db, user, now))
    counts = (
        await db.execute(
            select(
                select(func.count()).select_from(Player).scalar_subquery(),
                select(func.count())
                .select_from(PlayerEloCurrent)
                .where(PlayerEloCurrent.matches_52w > 0)
                .scalar_subquery(),
                select(func.count()).select_from(Player).where(news_fresh).scalar_subquery(),
            )
        )
    ).one()
    as_of = await db.scalar(select(func.max(PlayerEloCurrent.as_of)))
    day = now.date()
    items: list[PlayerRowOut] = []
    for pid in ids:
        player = players[pid]
        row = current.get(pid)
        overall = row.elo_all if row is not None else None
        on_surface = getattr(row, f"elo_{params.surface}") if row is not None else None
        form = forms.get(pid)
        results = form.results if form is not None else []
        items.append(
            PlayerRowOut(
                id=pid,
                name=player.name,
                name_ru=player.name_ru,
                country=player.country,
                age=player_card.age_on(player.birth_date, day),
                rank=row.rank_all if row is not None else None,
                elo_all=player_card.elo_int(overall),
                elo_surface=player_card.elo_int(on_surface),
                elo_delta=player_card.elo_delta(on_surface, overall),
                matches_52w=row.matches_52w if row is not None else 0,
                form=["W" if won else "L" for won in results],
                wins=sum(results),
                losses=len(results) - sum(results),
                last_match=form.last if form is not None else None,
                news_checked_at=player.news_checked_at,
                news_fresh=(
                    player.news_checked_at is not None and player.news_checked_at >= fresh_since
                ),
                today=pid in today,
            )
        )
    return PlayerRankingOut(
        items=items,
        total=int(total or 0),
        offset=params.offset,
        limit=params.limit,
        query=query,
        fuzzy=fuzzy,
        data=params.data,  # type: ignore[arg-type]
        surface=params.surface,  # type: ignore[arg-type]
        sort=params.sort,  # type: ignore[arg-type]
        counts=PlayerCountsOut(all=counts[0], active=counts[1], news=counts[2]),
        as_of=as_of,
        rank_days=CURRENT_DAYS,
        news_ttl_hours=config.news_ttl_hours,
        archive=await player_card.archive_info(db, now),
    )
