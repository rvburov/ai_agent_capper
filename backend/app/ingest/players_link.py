"""Привязка матчей и игроков старого бота к матчам архивов (этап 2).

    python -m app.admin.cli players-link-legacy [--dry-run]

Импорт старого бота (app/ingest/legacy.py) создал заготовки: игроков по именам из
записей (чаще по-русски: «Синнер», «Медведев Д.»), турниры source = legacy и матчи
source = legacy с source_ref «ГГГГ-ММ-ДД:id1:id2» (день ставки и пара игроков). Здесь
каждый такой матч ищется среди матчей архивов (sackmann, tennis_data):
- день матча — не дальше DAY_WINDOW от дня ставки; у матча без дня (только Сакманн) —
  окно турнира: от TOURNAMENT_BEFORE до начала до TOURNAMENT_AFTER после;
- оба игрока похожи по фамилии (name_score), оценка каждого не ниже NAME_THRESHOLD;
  порядок игроков любой.

Сравниваются только фамилии: имя из старого бота и его хвосты («Дель Потро», «Потро»)
с фамилией игрока архива (у «Jannik Sinner» и «Sinner J.» это «sinner»). Совпадение
с именем («Тим» и Tim van Rijthoven) не засчитывается. Оценка — сходство строк целиком
по триграммам, как similarity в pg_trgm (не word_similarity: «Пол» не должен находить
Popyrin по общему началу), в транслитерации и упрощенном написании, как в поиске
игроков. Короткая фамилия (до SHORT_NAME букв) засчитывается только при полном
совпадении: у «Пол» и «Фис» слишком много общих триграмм с чужими фамилиями.

Соперник по ставке обычно играет в окне и соседние круги. Если игрок архива, найденный
для одного игрока ставки, играл в окне и с другими, то второй игрок ставки должен явно
выделяться среди этих соперников: оценка не ниже STRONG_SCORE и на LEADER_MARGIN выше
лучшей из них. Иначе — неоднозначно, в отчет.

Ровно один кандидат → матч старого бота сливается в матч архива (merge_matches):
ставки, прогнозы и кэфы переходят на него, сторона исхода переворачивается, если
игроки стоят в другом порядке. Потом игроки старого бота, если это заготовки (нет
sackmann_id, все матчи — legacy), сливаются в игроков архива (merge_players): их имена
остаются у игрока архива в name_ru и псевдонимах. Ни одного или несколько кандидатов,
конфликт слияния, игрок старого бота похож на разных игроков архива — строка в отчете
(IngestReport.unmatched), ничего не угадывается.

Профиль игрока один. Если он есть и у заготовки, и у игрока архива (или игрок архива
уже получает профиль другой заготовки в этом запуске), слияние удалило бы профиль
заготовки. Такие матчи не привязываются и остаются в отчете каждого запуска, пока
человек не решит сам (players-merge). Турниры legacy без матчей удаляются.

Все — одной транзакцией под той же блокировкой, что импорт старого бота. --dry-run
делает то же самое и откатывает: база не меняется, журнал загрузок не пишется. Иначе
итог — в ingestion_runs (source = players_link). Аудит администратора не пишется:
это загрузка данных, а не ручная правка (ее команды пишут player_merge).
"""

import re
from collections import defaultdict
from collections.abc import Callable, Collection, Iterable, Sequence
from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import and_, delete, exists, func, or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Match, Player, PlayerProfile, Tournament
from app.db.session import create_engine, create_sessionmaker
from app.ingest.legacy import LOCK_KEY
from app.ingest.names import fold, parse_tennis_data_name
from app.ingest.runs import IngestReport, ingestion_run
from app.services.players import (
    SKELETON_WEIGHT,
    PlayerError,
    merge_matches,
    merge_players,
    query_variants,
    skeletons,
)

SOURCE = "players_link"
LEGACY = "legacy"
ARCHIVE_SOURCES = ("sackmann", "tennis_data")
# Ставку делали накануне или в день матча; запас — на часовые пояса и переносы
DAY_WINDOW = timedelta(days=2)
# Окно турнира для матча без дня — как у загрузчика Сакманна (квалификация до
# начала, две недели Большого шлема после)
TOURNAMENT_BEFORE = timedelta(days=3)
TOURNAMENT_AFTER = timedelta(days=16)
# Оценка сходства фамилий (0…1). «Синнер» и Jannik Sinner — 1, «Оже-Альяссим» и
# Auger-Aliassime — 0,73, «Хуркач» и Hurkacz — 0,67; чужие фамилии на списке из 300
# игроков ATP набирают не больше 0,5 («Чорич» и Coria)
NAME_THRESHOLD = 0.55
# Фамилия из стольких букв и короче совпадает только целиком
SHORT_NAME = 4
# Явный лидер среди соперников по окну: оценка не ниже и отрыв от следующей не меньше
STRONG_SCORE = 0.8
LEADER_MARGIN = 0.2
_REF_DAY = re.compile(r"^(\d{4}-\d{2}-\d{2}):")
# Слово для триграмм — буквы и цифры, как в pg_trgm
_WORD = re.compile(r"[^\W_]+")


# --- сходство фамилий ---


def trigrams(value: str) -> frozenset[str]:
    """Триграммы строки, как в pg_trgm: каждое слово в нижнем регистре дополняется двумя
    пробелами в начале и одним в конце."""
    found: set[str] = set()
    for word in _WORD.findall(value.lower()):
        padded = f"  {word} "
        found.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return frozenset(found)


def _similarity(first: frozenset[str], second: frozenset[str]) -> float:
    union = len(first | second)
    return len(first & second) / union if union else 0.0


def trigram_similarity(first: str, second: str) -> float:
    """Доля общих триграмм (0…1), как similarity в pg_trgm."""
    return _similarity(trigrams(first), trigrams(second))


def surname_forms(name: str, *, given_first: bool) -> set[str]:
    """Сложенные (fold) формы фамилии: слова имени с какого-то места до конца, раздельно
    и слитно. given_first — имя записано как «Имя Фамилия» (игроки архива): первое слово
    — имя, оно в формы не входит. Имя «Фамилия И.» дает только фамилию.

    «Juan Martin del Potro» (given_first) → «martin del potro», «del potro», «potro» и
    слитные «martindelpotro», «delpotro»; «Дель Потро» → «дель потро», «дельпотро»,
    «потро»; «Sinner J.» → «sinner»."""
    surname, initials = parse_tennis_data_name(name)
    words = surname.split() if initials else fold(name).split()
    start = 1 if given_first and not initials and len(words) > 1 else 0
    forms: set[str] = set()
    for index in range(start, len(words)):
        tail = words[index:]
        forms.update((" ".join(tail), "".join(tail)))
    return forms


@dataclass(frozen=True)
class _Form:
    text: str
    grams: frozenset[str]
    # Букв в исходной форме (до транслитерации): по ним видно короткую фамилию
    letters: int
    # Упрощенное написание (services.players.skeletons): сравнивается только с таким же
    skeleton: bool


def _forms(names: Iterable[str], *, archive: bool) -> list[_Form]:
    """Формы фамилий для сравнения. Имя старого бота — во всех вариантах запроса
    поиска (как есть и в двух транслитерациях); имя архива — как есть."""
    found: dict[tuple[str, bool], _Form] = {}
    for name in names:
        for form in surname_forms(name, given_first=archive):
            letters = len(form.replace(" ", ""))
            variants = [form] if archive else query_variants(form)
            for variant in variants:
                found.setdefault(
                    (variant, False), _Form(variant, trigrams(variant), letters, False)
                )
            for variant in skeletons(variants):
                found.setdefault((variant, True), _Form(variant, trigrams(variant), letters, True))
    return list(found.values())


def _score(legacy: Sequence[_Form], archive: Sequence[_Form]) -> float:
    best = 0.0
    for mine in legacy:
        for other in archive:
            if mine.skeleton != other.skeleton:
                continue
            weight = SKELETON_WEIGHT if mine.skeleton else 1.0
            if mine.text == other.text:
                best = max(best, weight)
            elif min(mine.letters, other.letters) > SHORT_NAME:
                best = max(best, weight * _similarity(mine.grams, other.grams))
            if best >= 1.0:
                return best
    return best


def name_score(legacy_names: Iterable[str], archive_names: Iterable[str]) -> float:
    """Сходство фамилий (0…1) игрока старого бота (любое из его имен) и игрока архива.
    Совпадение целиком — 1 (в упрощенном написании — SKELETON_WEIGHT); короткая фамилия
    (до SHORT_NAME букв) без полного совпадения — 0."""
    return _score(_forms(legacy_names, archive=False), _forms(archive_names, archive=True))


# --- привязка ---


@dataclass(frozen=True)
class _LegacyMatch:
    id: int
    day: date
    player1_id: int
    player2_id: int


@dataclass(frozen=True)
class _ArchiveMatch:
    id: int
    player1_id: int
    player2_id: int
    day: date | None
    start: date | None

    def opponent(self, player_id: int) -> int:
        return self.player2_id if self.player1_id == player_id else self.player1_id


@dataclass(frozen=True)
class _Link:
    legacy: _LegacyMatch
    archive: _ArchiveMatch
    # Игрок 1 старого бота — игрок 2 архива
    flip: bool

    def targets(self) -> tuple[tuple[int, int], tuple[int, int]]:
        """Пары (игрок старого бота, игрок архива)."""
        a1, a2 = self.archive.player1_id, self.archive.player2_id
        if self.flip:
            a1, a2 = a2, a1
        return (self.legacy.player1_id, a1), (self.legacy.player2_id, a2)


def ref_day(source_ref: str | None) -> date | None:
    """День ставки из source_ref матча старого бота: «2025-01-20:12:34» → 2025-01-20."""
    found = _REF_DAY.match(source_ref or "")
    if found is None:
        return None
    try:
        return date.fromisoformat(found.group(1))
    except ValueError:
        return None


def _mapping(links: Iterable[_Link]) -> dict[int, set[int]]:
    """Игрок старого бота → игроки архива, в которых он переходит по привязкам."""
    found: dict[int, set[int]] = defaultdict(set)
    for link in links:
        for legacy_player, archive_player in link.targets():
            found[legacy_player].add(archive_player)
    return found


def _single_target(player_id: int, targets: set[int]) -> int | None:
    """Игрок архива, в которого сливается игрок старого бота; None — сливать некуда
    (это он сам) или неоднозначно (разные игроки архива)."""
    others = targets - {player_id}
    if len(others) != 1 or player_id in targets:
        return None
    return next(iter(others))


class _Linker:
    def __init__(self, db: AsyncSession, report: IngestReport) -> None:
        self.db = db
        self.report = report
        self.names: dict[int, list[str]] = {}
        self._legacy_forms: dict[int, list[_Form]] = {}
        self._archive_forms: dict[int, list[_Form]] = {}
        self._scores: dict[tuple[int, int], float] = {}

    async def run(self) -> None:
        # Импорт старого бота в это время создавал бы матчи, которые здесь удаляются
        await self.db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
        legacy = await self._legacy_matches()
        if legacy:
            links = await self._find_links(legacy, await self._archive_matches(legacy))
            links = await self._keep_profiles(links)
            await self._merge_players(await self._merge_matches(links))
        removed = await self.db.execute(
            delete(Tournament)
            .where(
                Tournament.source == LEGACY,
                ~exists().where(Match.tournament_id == Tournament.id),
            )
            .execution_options(synchronize_session=False)
        )
        self.report.counts["deleted.tournaments"] += int(getattr(removed, "rowcount", 0) or 0)
        left = await self.db.scalar(
            select(func.count()).select_from(Match).where(Match.source == LEGACY)
        )
        self.report.freshness["legacy_matches_left"] = int(left or 0)

    async def _legacy_matches(self) -> list[_LegacyMatch]:
        rows = await self.db.execute(
            select(Match.id, Match.source_ref, Match.player1_id, Match.player2_id)
            .where(Match.source == LEGACY)
            .order_by(Match.id)
        )
        found: list[_LegacyMatch] = []
        for match_id, source_ref, player1_id, player2_id in rows:
            self.report.rows_read += 1
            day = ref_day(source_ref)
            if day is None:
                self.report.add_unmatched(
                    "legacy_bad_ref", match_id=match_id, source_ref=source_ref
                )
                continue
            found.append(_LegacyMatch(match_id, day, player1_id, player2_id))
        await self._load_names({p for m in found for p in (m.player1_id, m.player2_id)})
        return found

    async def _load_names(self, ids: Collection[int]) -> None:
        missing = sorted(set(ids) - set(self.names))
        if not missing:
            return
        rows = await self.db.execute(
            select(Player.id, Player.name, Player.name_ru, Player.aliases).where(
                Player.id.in_(missing)
            )
        )
        for player_id, name, name_ru, aliases in rows:
            names = [name, name_ru, *(aliases or [])]
            self.names[player_id] = list(dict.fromkeys(item for item in names if item))

    def _name(self, player_id: int) -> str:
        names = self.names.get(player_id)
        return names[0] if names else str(player_id)

    def _score(self, legacy_player: int, archive_player: int) -> float:
        """Сходство игрока старого бота с игроком архива; тот же id — 1 (импорт старого
        бота уже нашел игрока архива по имени)."""
        if legacy_player == archive_player:
            return 1.0
        key = (legacy_player, archive_player)
        if key not in self._scores:
            if legacy_player not in self._legacy_forms:
                names = self.names.get(legacy_player, [])
                self._legacy_forms[legacy_player] = _forms(names, archive=False)
            if archive_player not in self._archive_forms:
                names = self.names.get(archive_player, [])
                self._archive_forms[archive_player] = _forms(names, archive=True)
            self._scores[key] = _score(
                self._legacy_forms[legacy_player], self._archive_forms[archive_player]
            )
        return self._scores[key]

    async def _archive_matches(self, legacy: Sequence[_LegacyMatch]) -> list[_ArchiveMatch]:
        low = min(match.day for match in legacy) - DAY_WINDOW
        high = max(match.day for match in legacy) + DAY_WINDOW
        rows = await self.db.execute(
            select(
                Match.id,
                Match.player1_id,
                Match.player2_id,
                Match.match_date,
                Tournament.start_date,
            )
            .outerjoin(Tournament, Match.tournament_id == Tournament.id)
            .where(
                Match.source.in_(ARCHIVE_SOURCES),
                or_(
                    Match.match_date.between(low, high),
                    and_(
                        Match.match_date.is_(None),
                        Tournament.start_date.between(
                            low - TOURNAMENT_AFTER, high + TOURNAMENT_BEFORE
                        ),
                    ),
                ),
            )
            .order_by(Match.id)
        )
        return [_ArchiveMatch(*row) for row in rows]

    def _candidates(
        self,
        match: _LegacyMatch,
        by_day: dict[date, list[_ArchiveMatch]],
        by_start: dict[date, list[_ArchiveMatch]],
    ) -> list[_ArchiveMatch]:
        found: list[_ArchiveMatch] = []
        for offset in range(-DAY_WINDOW.days, DAY_WINDOW.days + 1):
            found += by_day.get(match.day + timedelta(days=offset), [])
        # Матч без дня: день ставки ±DAY_WINDOW попадает в окно турнира
        first = match.day - TOURNAMENT_AFTER - DAY_WINDOW
        last = match.day + TOURNAMENT_BEFORE + DAY_WINDOW
        for offset in range((last - first).days + 1):
            found += by_start.get(first + timedelta(days=offset), [])
        return found

    async def _find_links(
        self, legacy: Sequence[_LegacyMatch], archive: Sequence[_ArchiveMatch]
    ) -> list[_Link]:
        by_day: dict[date, list[_ArchiveMatch]] = defaultdict(list)
        by_start: dict[date, list[_ArchiveMatch]] = defaultdict(list)
        for item in archive:
            if item.day is not None:
                by_day[item.day].append(item)
            elif item.start is not None:
                by_start[item.start].append(item)
        candidates = {match.id: self._candidates(match, by_day, by_start) for match in legacy}
        await self._load_names(
            {
                p
                for found in candidates.values()
                for c in found
                for p in (c.player1_id, c.player2_id)
            }
        )
        links: list[_Link] = []
        for match in legacy:
            link = self._choose(match, candidates[match.id])
            if link is not None:
                links.append(link)
        return links

    def _choose(self, match: _LegacyMatch, found: Sequence[_ArchiveMatch]) -> _Link | None:
        """Матч архива для матча старого бота или None (тогда — строка в отчете)."""
        options: list[tuple[_Link, float, float]] = []
        for item in found:
            for flip in (False, True):
                link = _Link(match, item, flip)
                (_, first), (_, second) = link.targets()
                scores = self._score(match.player1_id, first), self._score(match.player2_id, second)
                if min(scores) >= NAME_THRESHOLD:
                    options.append((link, *scores))
        row = {
            "match_id": match.id,
            "date": match.day,
            "player1": self._name(match.player1_id),
            "player2": self._name(match.player2_id),
        }
        if not options:
            self.report.add_unmatched("legacy_match_not_found", **row, candidates=len(found))
            return None
        contested: set[int] = set()
        if len(options) == 1:
            [(link, first_score, second_score)] = options
            (_, first), (_, second) = link.targets()
            # Игрок 1 выбирается среди соперников найденного игрока 2 и наоборот
            contested |= self._contested(match.player1_id, first, first_score, second, link, found)
            contested |= self._contested(match.player2_id, second, second_score, first, link, found)
            if not contested:
                return link
        ids = sorted({option.archive.id for option, _, _ in options} | contested)
        self.report.add_unmatched("legacy_match_ambiguous", **row, archive_matches=ids)
        return None

    def _contested(
        self,
        legacy_player: int,
        chosen: int,
        score: float,
        partner: int,
        link: _Link,
        found: Sequence[_ArchiveMatch],
    ) -> set[int]:
        """Другие матчи окна, где partner играл еще с кем-то, если chosen не выделяется
        среди этих соперников явно (оценка ниже STRONG_SCORE или отрыв от лучшего из
        них меньше LEADER_MARGIN); пусто — выбор однозначен. Тот же id игрока не
        оспаривается: его нашел по имени еще импорт старого бота."""
        if legacy_player == chosen:
            return set()
        others = [
            item
            for item in found
            if item.id != link.archive.id and partner in (item.player1_id, item.player2_id)
        ]
        if not others:
            return set()
        rival = max(self._score(legacy_player, item.opponent(partner)) for item in others)
        if score >= STRONG_SCORE and score - rival >= LEADER_MARGIN:
            return set()
        return {item.id for item in others}

    async def _with_profile(self, ids: Collection[int]) -> set[int]:
        found = await self.db.scalars(
            select(PlayerProfile.player_id).where(PlayerProfile.player_id.in_(sorted(ids)))
        )
        return set(found)

    async def _keep_profiles(self, links: Sequence[_Link]) -> list[_Link]:
        """Убрать привязки игроков, чье слияние удалило бы профиль (см. docstring
        модуля). Убранная привязка меняет, кто в кого сливается, поэтому проверка
        повторяется, пока что-то убирается."""
        kept = list(links)
        blocked: dict[int, int] = {}
        while True:
            found = await self._profile_conflicts(_mapping(kept))
            if not found:
                break
            blocked.update(found)
            kept = [
                link
                for link in kept
                if not {link.legacy.player1_id, link.legacy.player2_id} & found.keys()
            ]
        for player_id, target in sorted(blocked.items()):
            matches = sorted(
                link.legacy.id
                for link in links
                if player_id in (link.legacy.player1_id, link.legacy.player2_id)
            )
            self.report.add_unmatched(
                "legacy_player_profile_conflict",
                player_id=player_id,
                name=self._name(player_id),
                archive_player_id=target,
                archive_name=self._name(target),
                match_ids=matches,
            )
        return kept

    async def _profile_conflicts(self, mapping: dict[int, set[int]]) -> dict[int, int]:
        """Заготовки с профилем, которые слились бы в игрока архива с профилем (своим
        или полученным от заготовки раньше в этом запуске): id → игрок архива."""
        plan = {
            player_id: target
            for player_id in sorted(mapping)
            if (target := _single_target(player_id, mapping[player_id])) is not None
        }
        if not plan:
            return {}
        profiles = await self._with_profile({*plan, *plan.values()})
        conflicts: dict[int, int] = {}
        for player_id, target in plan.items():
            if player_id not in profiles or not await self._is_stub(player_id):
                continue
            if target in profiles:
                conflicts[player_id] = target
            else:
                profiles.add(target)
        return conflicts

    async def _merge_matches(self, links: Sequence[_Link]) -> dict[int, set[int]]:
        """Слить матчи; вернуть, в каких игроков архива перешел каждый игрок старого бота."""
        merged: list[_Link] = []
        for link in links:
            try:
                await merge_matches(
                    self.db,
                    source_match_id=link.legacy.id,
                    target_match_id=link.archive.id,
                    flip=link.flip,
                    commit=False,
                )
            except PlayerError as exc:
                self.report.add_unmatched(
                    "legacy_match_conflict",
                    match_id=link.legacy.id,
                    archive_match_id=link.archive.id,
                    error=exc.message,
                )
                continue
            self.report.updated += 1
            self.report.counts["linked.matches"] += 1
            merged.append(link)
        return _mapping(merged)

    async def _merge_players(self, mapping: dict[int, set[int]]) -> None:
        for player_id in sorted(mapping):
            if not mapping[player_id] - {player_id}:
                continue
            row = {"player_id": player_id, "name": self._name(player_id)}
            target = _single_target(player_id, mapping[player_id])
            if target is None:
                # Одно имя старого бота досталось разным игрокам (однофамильцы)
                self.report.add_unmatched(
                    "legacy_player_conflict", **row, archive_players=sorted(mapping[player_id])
                )
                continue
            if not await self._is_stub(player_id):
                self.report.add_unmatched("legacy_player_kept", **row, archive_player_id=target)
                continue
            if len(await self._with_profile((player_id, target))) == 2:
                # Не должно случаться после _keep_profiles; профиль не удаляем молча
                self.report.add_unmatched(
                    "legacy_player_profile_conflict", **row, archive_player_id=target
                )
                continue
            try:
                merged = await merge_players(
                    self.db,
                    source_id=player_id,
                    target_id=target,
                    actor_id=None,
                    commit=False,
                    audit=False,
                )
            except PlayerError as exc:
                self.report.add_unmatched(
                    "legacy_player_merge_failed",
                    **row,
                    archive_player_id=target,
                    error=exc.message,
                )
                continue
            self.report.updated += 1
            self.report.counts["merged.players"] += 1
            self.report.add_warning(
                "players.link.player_merged",
                source=merged.source_name,
                source_id=merged.source_id,
                target=merged.target_name,
                target_id=merged.target_id,
            )

    async def _is_stub(self, player_id: int) -> bool:
        """Заготовка старого бота: нет sackmann_id и все матчи — legacy."""
        player = await self.db.get(Player, player_id, populate_existing=True)
        if player is None or player.sackmann_id is not None:
            return False
        other = await self.db.scalar(
            select(
                exists().where(
                    or_(Match.player1_id == player_id, Match.player2_id == player_id),
                    Match.source != LEGACY,
                )
            )
        )
        return not other


async def _link(db: AsyncSession, report: IngestReport) -> None:
    await _Linker(db, report).run()


async def link_legacy(
    *,
    dry_run: bool = False,
    db_factory: Callable[[], AsyncSession] | None = None,
) -> IngestReport:
    """Привязать матчи и игроков старого бота к архивам (см. docstring модуля).
    db_factory — фабрика сеансов БД; без нее открывается свое подключение."""
    if db_factory is None:
        engine = create_engine()
        try:
            return await link_legacy(dry_run=dry_run, db_factory=create_sessionmaker(engine))
        finally:
            await engine.dispose()
    if dry_run:
        report = IngestReport()
        async with db_factory() as db:
            try:
                await _link(db, report)
            finally:
                await db.rollback()
        return report
    async with ingestion_run(db_factory, SOURCE) as run, db_factory() as db:
        await _link(db, run.report)
        await db.commit()
    return run.report
