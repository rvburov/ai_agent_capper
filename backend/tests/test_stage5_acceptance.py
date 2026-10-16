"""Приемка этапа 5 («Готово, когда», PLAN.md, этап 5) кодом.

1. Доля ног, рассчитанных из архива за 14 дней после матча, на синтетическом сезоне,
   похожем на настоящий: основной тур ATP ≈ 55 матчей в неделю, снятия 3,5% и неявки 1%,
   участники ставят экспрессы и одиночные на П1/П2 и форы ±1.5, часть ног — вне архива
   (челленджер, квалификация), матч из ввода без даты у 30% ног, игроки стоят в другом
   порядке у половины матчей, 1% ног — с игроком, который при вводе не нашелся; по Р21 —
   экспрессы из 2–3 событий (одиночных 5%), ног вне архива 2%. Файл
   tennis-data загружается по понедельникам; в файле матчи до дня загрузки минус
   задержка сайта (как часто сайт обновляет файл — не проверено, поэтому задержка —
   параметр). После каждой загрузки — тот же шаг settle_from_archive, что у кнопки
   «Администрирование → Данные». Цель — не меньше 90% ног П1/П2 и фор основного тура
   рассчитаны без ручного ввода: ставка рассчитана сама (у проигранного экспресса нога со
   снятием или без исхода тоже не требует ввода — деньги уже посчитаны).
   Большой прогон для отчета: S5_SEASON_WEEKS=36 S5_SEASON_LAG=1-7 pytest -s -k season.
2. Пути включения: код, который делает версию стратегии, версию модели или урок
   действующими, сверяется со списком решений человека (и двух правил владельца, Р25).
"""

import os
import random
import re
from collections import Counter
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import (
    BankrollLedger,
    Bet,
    BetLeg,
    Match,
    OddsSnapshot,
    Player,
    StrategyVersion,
    Tournament,
)
from app.db.session import create_sessionmaker
from app.ml.sets import MARKET_MINUS, MARKET_ML, MARKET_PLUS, match_leg_outcome
from app.services.archive_settlement import settle_from_archive
from tests.helpers_admin import error_code
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
SEASON_START = date(2026, 1, 5)  # понедельник
SETTLE_DAYS = 14


@dataclass(frozen=True)
class Scenario:
    weeks: int = 16
    matches_per_week: int = 55
    lag: tuple[int, int] = (1, 7)
    skip_share: float = 0.0
    # Р21: только основной тур и экспрессы; ноги вне архива (квалификация, челленджер по
    # ошибке) — редкость
    other_share: float = 0.02
    members: int = 3
    seed: int = 20261016


@dataclass
class ArchiveRow:
    """Матч сезона, как он придет в файле tennis-data."""

    tournament: int
    day: date
    p1: int
    p2: int
    winner: int
    score: str | None
    status: str
    best_of: int
    odds: tuple[str, str] | None


@dataclass
class LegRecord:
    leg_id: int
    match_day: date
    market: str
    main_tour: bool
    single: bool
    status: str  # статус матча в архиве (finished, retired, walkover), вне архива — none
    unresolved: bool
    # Ставка ноги рассчитана сама (без ручного ввода) — день загрузки
    settled_on: date | None = None
    # У самой ноги есть исход из архива (у проигранного экспресса нога со снятием или без
    # исхода остается пустой)
    outcome_on: date | None = None
    bet: int = 0
    # Исход ноги по архиву (win, loss, void), если он однозначен; иначе None
    outcome: str | None = None

    @property
    def known(self) -> bool:
        """Исход ноги код узнает из архива сам (Т3): основной тур, игроки нашлись, матч
        сыгран до конца."""
        return self.main_tour and not self.unresolved and self.status == "finished"


@dataclass
class SeasonResult:
    legs: list[LegRecord] = field(default_factory=list)
    uploads: list[date] = field(default_factory=list)
    skipped: int = 0

    def eligible(self) -> list[LegRecord]:
        """Ноги основного тура, у которых после матча прошло 14 дней до последней загрузки."""
        last = self.uploads[-1]
        return [
            leg
            for leg in self.legs
            if leg.main_tour and leg.match_day + timedelta(days=SETTLE_DAYS) <= last
        ]

    def bets(self) -> dict[int, list[LegRecord]]:
        found: dict[int, list[LegRecord]] = {}
        for leg in self.legs:
            found.setdefault(leg.bet, []).append(leg)
        return found

    def settleable(self) -> list[LegRecord]:
        """Ноги ставок, которые по правилам Т3 рассчитываются сами: все ноги известны."""
        bets = self.bets()
        return [leg for leg in self.eligible() if all(other.known for other in bets[leg.bet])]

    @staticmethod
    def in_time(leg: LegRecord) -> bool:
        return leg.settled_on is not None and (leg.settled_on - leg.match_day).days <= SETTLE_DAYS

    def share(self, legs: list[LegRecord]) -> float:
        return sum(self.in_time(leg) for leg in legs) / len(legs) if legs else 0.0

    @staticmethod
    def outcome_share(legs: list[LegRecord]) -> float:
        """Доля ног с собственным исходом из архива за 14 дней."""
        timely = [
            leg
            for leg in legs
            if leg.outcome_on is not None and (leg.outcome_on - leg.match_day).days <= SETTLE_DAYS
        ]
        return len(timely) / len(legs) if legs else 0.0

    def misses(self) -> Counter[str]:
        """Почему нога основного тура не рассчиталась сама за 14 дней."""
        found: Counter[str] = Counter()
        bets = self.bets()
        for leg in self.eligible():
            if self.in_time(leg):
                continue
            if leg.settled_on is not None:
                found["late"] += 1
            elif leg.unresolved:
                found["unresolved_player"] += 1
            elif leg.status != "finished":
                found[leg.status] += 1
            elif any(not other.main_tour for other in bets[leg.bet]):
                found["other_leg_outside_archive"] += 1
            else:
                found["other_leg_retired_or_unresolved"] += 1
        return found

    def if_rules(self, *, lost_parlay: bool, walkover_void: bool) -> float:
        """Оценка доли, если бы правила расчета были мягче (вопрос владельцу, не код):
        экспресс с проигранной известной ногой проигран при любом исходе остальных;
        неявка — возврат у всех букмекеров."""
        bets = self.bets()

        def known(leg: LegRecord) -> bool:
            return leg.known or (
                walkover_void and leg.main_tour and not leg.unresolved and leg.status == "walkover"
            )

        def resolved(bet: list[LegRecord]) -> bool:
            if all(known(leg) for leg in bet):
                return True
            return lost_parlay and any(leg.known and leg.outcome == "loss" for leg in bet)

        eligible = self.eligible()
        return sum(resolved(bets[leg.bet]) for leg in eligible) / len(eligible)


def _score(rng: random.Random, best_of: int, status: str) -> str | None:
    """Счет со стороны победителя (как в архиве); у снятия — сыгранные геймы."""
    if status == "walkover":
        return None
    need = best_of // 2 + 1
    sets: list[str] = []
    won = lost = 0
    while won < need:
        if status == "retired" and sets and rng.random() < 0.5:
            sets.append(f"{rng.randint(0, 4)}-{rng.randint(0, 4)}")
            return " ".join(sets)
        if lost < need - 1 and rng.random() < 0.3:
            sets.append(f"{rng.choice((3, 4, 6))}-6")
            lost += 1
        else:
            sets.append(f"6-{rng.choice((1, 2, 3, 4))}")
            won += 1
    return " ".join(sets)


def _season(rng: random.Random, scenario: Scenario, players: list[int]) -> list[ArchiveRow]:
    rows: list[ArchiveRow] = []
    for week in range(scenario.weeks):
        monday = SEASON_START + timedelta(weeks=week)
        slam = week % 9 == 2
        for n in range(scenario.matches_per_week):
            first, second = rng.sample(players, 2)
            roll = rng.random()
            status = "walkover" if roll < 0.01 else "retired" if roll < 0.045 else "finished"
            best_of = 5 if slam and n % 2 == 0 else 3
            odds = None
            if rng.random() < 0.97:
                fav = round(rng.uniform(1.15, 2.0), 2)
                odds = (f"{fav:.2f}", f"{max(1.02, 1 / (1.05 - 1 / fav)):.2f}")
            rows.append(
                ArchiveRow(
                    tournament=week * 3 + n % 3,
                    day=monday + timedelta(days=rng.randint(0, 6)),
                    p1=first,
                    p2=second,
                    winner=rng.choice((1, 2)),
                    score=_score(rng, best_of, status),
                    status=status,
                    best_of=best_of,
                    odds=odds,
                )
            )
    return rows


async def run_season(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory, scenario: Scenario
) -> SeasonResult:
    rng = random.Random(scenario.seed)
    factory = create_sessionmaker(engine)
    archive_players = [Player(name=f"Archive Player {n:03d}") for n in range(220)]
    other_players = [Player(name=f"Challenger Player {n:03d}") for n in range(120)]
    db.add_all(archive_players + other_players)
    await db.flush()
    ids = [player.id for player in archive_players]
    others = [player.id for player in other_players]
    season = _season(rng, scenario, ids)
    tournaments: dict[int, int] = {}
    for row in season:
        if row.tournament in tournaments:
            continue
        tour = Tournament(
            name=f"Synthetic Open {row.tournament}",
            category="grand_slam" if row.best_of == 5 else rng.choice(("250", "500", "1000")),
            surface=rng.choice(("hard", "clay", "grass")),
            best_of=row.best_of,
            start_date=row.day - timedelta(days=row.day.weekday()),
            source="tennis_data",
            source_ref=f"2026-sim-{row.tournament}",
        )
        db.add(tour)
        await db.flush()
        tournaments[row.tournament] = tour.id
    members = [await make_user() for _ in range(scenario.members)]
    for member in members:
        db.add(
            BankrollLedger(
                user_id=member.id,
                at=datetime.combine(SEASON_START, time(), tzinfo=UTC) - timedelta(days=1),
                kind="deposit",
                amount=D("100000"),
                currency="RUB",
            )
        )
    await db.commit()

    by_day: dict[date, list[int]] = {}
    for index, row in enumerate(season):
        by_day.setdefault(row.day, []).append(index)
    user_matches: dict[int, tuple[int, bool]] = {}  # строка сезона → матч из ввода, переворот
    result = SeasonResult()
    leg_rows: dict[int, LegRecord] = {}
    loaded: set[int] = set()
    last_day = SEASON_START + timedelta(weeks=scenario.weeks) - timedelta(days=3)
    counter = 0

    async def user_match(
        p1: int, p2: int, day: date | None, placed: datetime, *, ref: str
    ) -> Match:
        match = Match(
            player1_id=p1,
            player2_id=p2,
            match_date=day,
            source="user",
            source_ref=ref,
            created_at=placed,
        )
        db.add(match)
        await db.flush()
        return match

    day = SEASON_START
    while day <= last_day:
        for member in members:
            for _ in range(rng.choices((0, 1, 2, 3), weights=(25, 40, 25, 10))[0]):
                placed = datetime.combine(day, time(rng.randint(7, 20)), tzinfo=UTC)
                size = rng.choices((1, 2, 3), weights=(5, 65, 30))[0]
                upcoming = [
                    i for ahead in range(3) for i in by_day.get(day + timedelta(days=ahead), [])
                ]
                legs: list[tuple[Match, str, int, LegRecord]] = []
                for _ in range(size):
                    market = rng.choices(
                        (MARKET_ML, MARKET_MINUS, MARKET_PLUS), weights=(70, 15, 15)
                    )[0]
                    selection = rng.choice((1, 2))
                    counter += 1
                    if rng.random() < scenario.other_share or not upcoming:
                        first, second = rng.sample(others, 2)
                        match = await user_match(
                            first, second, day, placed, ref=f"user:sim:{counter}"
                        )
                        record = LegRecord(0, day, market, False, size == 1, "none", False)
                        legs.append((match, market, selection, record))
                        continue
                    index = rng.choice(upcoming)
                    row = season[index]
                    unresolved = rng.random() < 0.01
                    record = LegRecord(0, row.day, market, True, size == 1, row.status, unresolved)
                    flip = False
                    if unresolved:
                        # Игрок не нашелся при вводе: у матча из ввода — новый игрок
                        stray = Player(name=f"Unresolved {counter}")
                        db.add(stray)
                        await db.flush()
                        match = await user_match(
                            stray.id, row.p2, row.day, placed, ref=f"user:sim:{counter}"
                        )
                    elif index in user_matches:
                        match_id, flip = user_matches[index]
                        found = await db.get(Match, match_id)
                        if found is None:  # уже слит с архивом другой ставкой
                            continue
                        match = found
                    else:
                        flip = rng.random() < 0.5
                        p1, p2 = (row.p2, row.p1) if flip else (row.p1, row.p2)
                        known = row.day if rng.random() < 0.7 else None
                        match = await user_match(p1, p2, known, placed, ref=f"user:sim:{counter}")
                        user_matches[index] = (match.id, flip)
                    # Исход ноги по архиву: сторона — в порядке игроков архива
                    side = 3 - selection if flip and not unresolved else selection
                    record.outcome = match_leg_outcome(
                        market,
                        side,
                        status=row.status,
                        winner_is_p1=row.winner == 1,
                        score=row.score,
                        best_of=row.best_of,
                    ).result
                    legs.append((match, market, selection, record))
                if not legs:
                    continue
                odds = [D(rng.choice(("1.45", "1.70", "1.85", "2.10"))) for _ in legs]
                total = D(1)
                for value in odds:
                    total *= value
                bet = Bet(
                    user_id=member.id,
                    placed_at=placed,
                    bookmaker="Fonbet",
                    stake=D("100"),
                    currency="RUB",
                    total_odds=total.quantize(D("0.001")),
                    status="open",
                    source="app",
                    source_ref=f"sim-{counter}",
                )
                db.add(bet)
                await db.flush()
                for (match, market, selection, record), value in zip(legs, odds, strict=True):
                    leg = BetLeg(
                        bet_id=bet.id,
                        match_id=match.id,
                        market=market,
                        selection=selection,
                        odds_taken=value,
                    )
                    db.add(leg)
                    await db.flush()
                    record.leg_id = leg.id
                    record.single = len(legs) == 1
                    record.bet = bet.id
                    leg_rows[leg.id] = record
                db.add(
                    BankrollLedger(
                        user_id=member.id,
                        at=placed,
                        kind="stake",
                        amount=-D("100"),
                        currency="RUB",
                        bet_id=bet.id,
                    )
                )
        await db.commit()
        if day.weekday() == 0 and day > SEASON_START:
            if rng.random() < scenario.skip_share:
                result.skipped += 1
            else:
                lag = rng.randint(*scenario.lag)
                await _upload(db, season, tournaments, day - timedelta(days=lag), loaded)
                await settle_from_archive(factory, warm=False)
                result.uploads.append(day)
                await _mark_settled(db, leg_rows, day)
        day += timedelta(days=1)
    # Три недели после сезона: файлы догоняют последние матчи
    for extra in range(1, 4):
        monday = last_day + timedelta(days=(7 - last_day.weekday()) % 7 + 7 * (extra - 1))
        until = monday - timedelta(days=rng.randint(*scenario.lag))
        await _upload(db, season, tournaments, until, loaded)
        await settle_from_archive(factory, warm=False)
        result.uploads.append(monday)
        await _mark_settled(db, leg_rows, monday)
    result.legs = list(leg_rows.values())
    return result


async def _upload(
    db: AsyncSession,
    season: list[ArchiveRow],
    tournaments: dict[int, int],
    until: date,
    loaded: set[int],
) -> None:
    """Файл ГОД.xlsx на день загрузки: матчи сезона до until, которых еще нет (loaded)."""
    for index, row in enumerate(season):
        if index in loaded or row.day > until:
            continue
        loaded.add(index)
        match = Match(
            tournament_id=tournaments[row.tournament],
            round="R32",
            match_date=row.day,
            player1_id=row.p1,
            player2_id=row.p2,
            winner_id=row.p1 if row.winner == 1 else row.p2,
            score=row.score,
            status=row.status,
            best_of=row.best_of,
            source="tennis_data",
            source_ref=f"sim-{index}",
        )
        db.add(match)
        await db.flush()
        if row.odds is not None:
            for bookmaker in ("pinnacle", "avg"):
                for selection, value in enumerate(row.odds, start=1):
                    db.add(
                        OddsSnapshot(
                            match_id=match.id,
                            market="ML",
                            selection=selection,
                            bookmaker=bookmaker,
                            odds=D(value),
                            kind="archive",
                            taken_at=datetime.combine(row.day, time(), tzinfo=UTC),
                        )
                    )
    await db.commit()


async def _mark_settled(db: AsyncSession, legs: dict[int, LegRecord], day: date) -> None:
    rows = await db.execute(
        select(BetLeg.id, BetLeg.result_source)
        .join(Bet, Bet.id == BetLeg.bet_id)
        .where(Bet.settled_by == "auto", BetLeg.id.in_(list(legs)))
    )
    for leg_id, source in rows:
        record = legs[leg_id]
        if record.settled_on is None:
            record.settled_on = day
        if source == "auto" and record.outcome_on is None:
            record.outcome_on = day


def _scenario_from_env() -> Scenario:
    weeks = int(os.environ.get("S5_SEASON_WEEKS", "16"))
    low, _, high = os.environ.get("S5_SEASON_LAG", "1-7").partition("-")
    skip = float(os.environ.get("S5_SEASON_SKIP", "0"))
    other = float(os.environ.get("S5_SEASON_OTHER", "0.02"))
    seed = int(os.environ.get("S5_SEASON_SEED", "20261016"))
    return Scenario(
        weeks=weeks,
        lag=(int(low), int(high or low)),
        skip_share=skip,
        other_share=other,
        seed=seed,
    )


def describe(result: SeasonResult) -> str:
    eligible = result.eligible()
    by_market = {
        market: round(result.share([leg for leg in eligible if leg.market == market]), 4)
        for market in (MARKET_ML, MARKET_MINUS, MARKET_PLUS)
    }
    singles = [leg for leg in eligible if leg.single]
    delays = sorted(
        (leg.settled_on - leg.match_day).days for leg in eligible if leg.settled_on is not None
    )
    median = delays[len(delays) // 2] if delays else None
    return (
        f"legs={len(result.legs)} bets={len(result.bets())} main_tour_eligible={len(eligible)} "
        f"share={result.share(eligible):.4f} singles={result.share(singles):.4f} "
        f"with_outcome={result.outcome_share(eligible):.4f} "
        f"known={sum(leg.known for leg in eligible) / len(eligible):.4f} "
        f"settleable={len(result.settleable())} "
        f"settleable_share={result.share(result.settleable()):.4f} by_market={by_market} "
        f"median_days={median} max_days={delays[-1] if delays else None} "
        f"uploads={len(result.uploads)} skipped={result.skipped} misses={dict(result.misses())} "
        f"if_lost_parlay={result.if_rules(lost_parlay=True, walkover_void=False):.4f} "
        f"if_lost_parlay_and_walkover_void="
        f"{result.if_rules(lost_parlay=True, walkover_void=True):.4f}"
    )


async def test_season_share_settled_from_archive_within_14_days(
    db: AsyncSession, engine: AsyncEngine, make_user: UserFactory
) -> None:
    """Критерий «≥ 90% событий рассчитываются без ручного ввода» в формулировке Р25 (В1 = А,
    API результатов нет): доля ног П1/П2 и фор основного тура, рассчитанных из архива за
    14 дней после матча при еженедельной загрузке файла.

    Тест проверяет, что код рассчитывает сам все, что разрешают правила Т3: ставки, у
    которых все ноги — сыгранные до конца матчи основного тура, рассчитаны из архива (не
    меньше 98% — за 14 дней: нога экспресса ждет файла с последней ногой, и при задержке
    сайта 7 дней это изредка 15 дней), и экспрессы с проигранной ногой при любом исходе
    остальных. Доля — не меньше 90% при еженедельной загрузке без пропусков и задержке
    сайта до 7 дней; все доли печатаются для отчета приемки."""
    scenario = _scenario_from_env()
    result = await run_season(db, engine, make_user, scenario)
    print("\nseason:", scenario, "\n", describe(result))
    eligible = result.eligible()
    assert len(eligible) >= 300
    settleable = result.settleable()
    assert len(settleable) >= 0.75 * len(eligible)
    assert all(leg.settled_on is not None for leg in settleable), describe(result)
    if scenario.skip_share == 0 and scenario.lag[1] <= 7:
        assert result.share(settleable) >= 0.98, describe(result)
        assert result.share(eligible) >= 0.90, describe(result)
    # Нога вне архива или со снятием своего исхода не получает; ее ставка рассчитывается
    # сама, только если другая нога проиграна: проигрыш, −сумма ставки, выплаты нет
    others = [leg for leg in result.legs if not leg.main_tour]
    assert all(leg.outcome_on is None for leg in others)
    assert others or not scenario.other_share
    bets = result.bets()
    for leg in result.legs:
        if leg.settled_on is not None and leg.outcome_on is None:
            assert any(other.outcome == "loss" for other in bets[leg.bet] if other.known)
    partial = list(
        await db.scalars(
            select(Bet).where(
                Bet.settled_by == "auto",
                Bet.id.in_(select(BetLeg.bet_id).where(BetLeg.result.is_(None))),
            )
        )
    )
    assert partial
    assert {(bet.status, bet.profit) for bet in partial} == {("lost", -D("100"))}
    payouts = await db.scalar(
        select(func.count()).where(
            BankrollLedger.bet_id.in_([bet.id for bet in partial]),
            BankrollLedger.kind != "stake",
        )
    )
    assert payouts == 0


# --- пути включения версий и уроков ---

APP = Path(__file__).resolve().parents[1] / "app"
# Что делает версию или урок действующими: статус active у версии стратегии или модели,
# in_prompt у урока
_ACTIVATE = re.compile(
    r"(\.status\s*=\s*(ACTIVE|\"active\")|status\s*=\s*(ACTIVE|\"active\"),|in_prompt\s*=\s*True)"
)
_SKIP = {"services/admin_users.py"}  # статус пользователя, а не версии

# Функция → почему это не включение без подтверждения
EXPECTED_ACTIVATIONS = {
    # Первая версия: стратегия v3 участника и общей линии инструкций по умолчанию, когда
    # версий еще нет (ничего не меняется, это действующие правила и промпт)
    "services/strategy_versions.py:ensure_active",
    "services/strategy_versions.py:ensure_shared_active",
    # Новая версия общей линии при смене набора уроков: включение и выключение урока
    # администратором, списание урока при ежемесячной перепроверке (только убирает урок)
    "services/strategy_versions.py:sync_lessons",
    # Кнопки «Включить» и «Вернуть» владельца версии (общая линия — администратор)
    "services/strategy_versions.py:activate",
    "services/strategy_versions.py:rollback",
    "services/strategy_versions.py:_apply_lesson_flags",
    # «Использовать в анализе» — администратор после быстрой проверки (В4)
    "services/lessons.py:enable",
    # Базовая модель: перенос калибровки elo-v1 в версию с датой (числа те же), еженедельная
    # перекалибровка по правилу владельца В6 (не хуже прежней, с уведомлением и откатом) и
    # откат администратором
    "services/recalibration.py:ensure_baseline",
    "services/recalibration.py:recalibrate",
    "services/recalibration.py:rollback",
}

# Кто вызывает включение: функция → места вызова (файл:функция)
_CALLERS = {
    "strategy_versions.activate(": {"api/routes/strategy.py:activate_version"},
    "strategy_versions.rollback(": {"api/routes/strategy.py:rollback_version"},
    "strategy_versions.sync_lessons(": {
        "services/lessons.py:recheck_lessons",
        "services/lessons.py:enable",
        "services/lessons.py:disable",
    },
    "recalibration.recalibrate(": {
        "api/routes/admin_learning.py:recalibrate_model",
        "admin/cli.py:_ml_recalibrate",
        "workers/jobs.py:recalibrate_model",
    },
    "recalibration.rollback(": {"api/routes/admin_learning.py:rollback_model"},
    "lessons_service.enable(": {"api/routes/lessons.py:enable_lesson"},
}


def _functions_with(pattern: re.Pattern[str] | str) -> set[str]:
    found: set[str] = set()
    for path in sorted(APP.rglob("*.py")):
        rel = path.relative_to(APP).as_posix()
        if rel in _SKIP:
            continue
        current = ""
        for line in path.read_text(encoding="utf-8").splitlines():
            head = re.match(r"(async )?def (\w+)", line)
            if head:
                current = head.group(2)
            hit = (
                pattern.search(line)
                if isinstance(pattern, re.Pattern)
                else pattern in line and not line.lstrip().startswith(("async def", "def"))
            )
            if hit and "==" not in line:
                found.add(f"{rel}:{current}")
    return found


def test_every_activation_path_is_a_decision() -> None:
    assert _functions_with(_ACTIVATE) == EXPECTED_ACTIVATIONS


@pytest.mark.parametrize("call", sorted(_CALLERS))
def test_activation_callers_are_known(call: str) -> None:
    found = _functions_with(call)
    # Вызов внутри своего модуля пишется без префикса — его тоже нет
    assert found == _CALLERS[call], found


# --- права: маршрут этапа 5 с id в параметрах запроса ---


async def test_compare_with_foreign_rules_is_404(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """GET /strategy/versions/compare?a=&b= берет id из параметров запроса, поэтому не
    попадает в список адресов с id в пути (test_foreign_objects): чужие правила по любому
    из двух параметров — 404, как у GET /strategy/versions/{id}."""
    owner = await make_user()
    alice = await make_user()
    rows = [
        StrategyVersion(user_id=owner.id, code="r2", name="r2", status="candidate", params={}),
        StrategyVersion(user_id=alice.id, code="r2", name="r2", status="candidate", params={}),
    ]
    db.add_all(rows)
    await db.commit()
    foreign, own = rows
    client = await login(await make_client(), alice)
    for a, b in ((foreign.id, own.id), (own.id, foreign.id)):
        response = await client.get(f"/api/strategy/versions/compare?a={a}&b={b}")
        assert response.status_code == 404, response.text
        assert error_code(response) == "strategy.not_found"
    mine = await client.get(f"/api/strategy/versions/compare?a={own.id}&b={own.id}")
    assert mine.status_code == 200, mine.text
