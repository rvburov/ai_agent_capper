"""Команда acceptance-runs (приемка этапа 3) на поддельном Claude: подбор матчей с кэфами
tennis-data, оценка и подтверждение, анализы шагами воркера с пометкой прогона, прогнозы
вне статистики, критерии и коды возврата, отчет. Новости у всех матчей и вне дневного
лимита поисков, каждый прогон — как отдельный анализ (кэш первого вызова Opus),
букмекеры администратора не меняются."""

import asyncio
from collections.abc import Coroutine, Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.agent.config import AgentConfig, load_agent_config
from app.db.models import (
    AgentRun,
    Analysis,
    AppSettings,
    Match,
    OddsSnapshot,
    Player,
    Prediction,
    Tournament,
    User,
)
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings
from app.services import acceptance_runs
from app.services.acceptance_runs import RunMatch, RunResult
from tests.analysis_helpers import (
    install,
    install_gated,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
)
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude, parse_text
from tests.support import ClientFactory, LoginFn, UserFactory

# Игроки недавнего турнира сверх мира тестов: прогонам нужны матчи с игроками, которые еще
# не встречались в серии (их новости ищутся заново)
EXTRA = (
    ("Casper Ruud", "Taylor Fritz"),
    ("Alexander Zverev", "Stefanos Tsitsipas"),
)


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


async def _odds(db: AsyncSession, *, bookmaker: str = "avg") -> int:
    """Архивные кэфы tennis-data на победу у всех матчей мира тестов."""
    matches = list(await db.scalars(select(Match)))
    for match in matches:
        for selection, odds in ((1, Decimal("1.30")), (2, Decimal("3.60"))):
            db.add(
                OddsSnapshot(
                    match_id=match.id,
                    market="ML",
                    selection=selection,
                    bookmaker=bookmaker,
                    odds=odds,
                    kind="archive",
                    taken_at=datetime.now(UTC),
                )
            )
    await db.commit()
    return len(matches)


async def _extra_matches(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    """Недавний турнир с новыми игроками (EXTRA): их матчи — первые в отборе."""
    start = datetime.now(UTC).date() - timedelta(days=10)
    tournament = Tournament(
        name="Recent Open",
        category="500",
        surface="hard",
        best_of=3,
        start_date=start,
        source="sackmann",
        source_ref="test-recent",
    )
    db.add(tournament)
    found: dict[str, int] = {}
    for number, names in enumerate(EXTRA, start=1):
        first, second = (Player(name=name) for name in names)
        db.add_all([first, second])
        await db.flush()
        found.update({names[0]: first.id, names[1]: second.id})
        db.add(
            Match(
                tournament_id=tournament.id,
                round="QF",
                match_date=start + timedelta(days=number),
                player1_id=first.id,
                player2_id=second.id,
                winner_id=first.id,
                score="6-3 6-4",
                status="finished",
                best_of=3,
                source="sackmann",
                source_ref=f"test-recent-{number}",
            )
        )
    await db.commit()
    await rebuild_ratings(db_factory=create_sessionmaker(engine))
    return found


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine, make_user: UserFactory) -> dict[str, int]:
    found = await seed_world(db, engine)
    extra = await _extra_matches(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    await _odds(db)
    admin = await make_user(role="admin", email="owner@example.com")
    return {**found, **extra, "admin": admin.id}


# --- расчеты без базы ---


def _match(match_id: int, first: int, second: int) -> RunMatch:
    return RunMatch(
        match_id=match_id,
        player1_id=first,
        player2_id=second,
        player1=f"P{first}",
        player2=f"P{second}",
        tournament_id=None,
        tournament="Shanghai",
        surface="hard",
        best_of=3,
        round="R16",
        day=date(2026, 10, 1),
        odds=(Decimal("1.170"), Decimal("5.100")),
        bookmaker="avg",
    )


def test_nearest_rank_p90() -> None:
    values = [float(n) for n in range(20, 0, -1)]
    assert acceptance_runs.nearest_rank(values, 0.9) == 18.0
    assert acceptance_runs.nearest_rank([5.0], 0.9) == 5.0
    assert acceptance_runs.nearest_rank([], 0.9) is None
    assert (
        acceptance_runs.nearest_rank([1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0], 0.9)
        == 9.0
    )


def test_plan_runs_prefers_new_players_with_stale_news() -> None:
    """Сначала матчи, где оба игрока еще не встречались и их новости устарели; нечетный
    прогон — 3 матча, четный — 2; не хватает матчей — прогонов меньше."""
    candidates = [
        _match(1, 1, 2),  # новости игрока 1 свежие
        _match(2, 3, 4),
        _match(3, 3, 5),  # игрок 3 уже взят
        _match(4, 6, 7),
        _match(5, 8, 9),
        _match(6, 10, 11),
        _match(7, 12, 13),
    ]
    stale = set(range(2, 14))
    plans = acceptance_runs.plan_runs(candidates, stale, 2)
    assert [len(plan.matches) for plan in plans] == [3, 2]
    chosen = [match.match_id for plan in plans for match in plan.matches]
    assert chosen == [2, 4, 5, 6, 7]
    short = acceptance_runs.plan_runs(candidates[:4], stale, 2)
    assert [plan.number for plan in short] == [1]
    # Матч, где новых игроков с устаревшими новостями нет, не берется: его новости
    # пришли бы из кэша (оба игрока уже в серии или их новости свежие)
    repeats = [
        _match(1, 3, 4),
        _match(2, 5, 6),
        _match(3, 3, 5),  # оба уже взяты
        _match(4, 1, 7),  # новости 1 и 7 свежие
        _match(5, 4, 8),  # 8 — новый с устаревшими новостями
    ]
    picked = acceptance_runs.plan_runs(repeats, {3, 4, 5, 6, 8}, 1)
    assert [match.match_id for match in picked[0].matches] == [1, 2, 5]
    assert acceptance_runs.plan_runs(repeats[:4], {3, 4, 5, 6, 8}, 1) == []


def test_input_text_is_parsed_back() -> None:
    plan = acceptance_runs.RunPlan(number=3, matches=(_match(1, 1, 2), _match(2, 3, 4)))
    text = acceptance_runs.input_text(plan, title="Приемка этапа 3, прогон 3", currency="RUB")
    assert text.splitlines()[0] == "Приемка этапа 3, прогон 3"
    assert "Текущий банк: 10 000 ₽" in text and "Букмекер: avg" in text
    parsed = parse_text(text)
    assert parsed["bank"] == {"amount": 10000.0, "currency": "RUB"}
    assert [
        (e["player1"]["raw"], e["odds"]["ml1"], e["odds"]["ml2"]) for e in parsed["events"]
    ] == [
        ("P1", 1.17, 5.1),
        ("P3", 1.17, 5.1),
    ]
    assert parsed["events"][0]["round"] == "R16" and parsed["events"][0]["surface"] == "hard"


def _result(
    number: int,
    *,
    seconds: float | None = 100.0,
    cost: str = "0.20",
    read: int = 6000,
    status: str = "done",
    news: str = "done",
    first_read: int = 0,
    extra: str = "0",
) -> RunResult:
    return RunResult(
        number=number,
        match_ids=(number,),
        analysis_id=number,
        status=status,
        duration_s=seconds,
        cost_usd=Decimal(cost),
        costs={
            "parse": Decimal("0.001"),
            "news": Decimal("0.1"),
            "analysis": Decimal(cost) - Decimal("0.101"),
        },
        opus_input=2000,
        opus_write=2000,
        opus_read=read,
        opus_first_read=first_read,
        first_read_extra_usd=Decimal(extra),
        news={news: 1},
        parse_agrees=True,
    )


def test_summary_criteria_on_known_numbers() -> None:
    results = [_result(n, seconds=float(10 * n)) for n in range(1, 21)]
    summary = acceptance_runs.summarize(results)
    assert summary.p90_s == 180.0 and summary.p90_ok
    assert summary.mean_cost_usd == Decimal("0.2") and summary.cost_ok
    assert summary.cache_share == pytest.approx(0.6) and summary.cache_ok
    assert summary.step_costs["news"] == Decimal("0.1")
    assert summary.passed and summary.parse_agrees == 20

    slow = acceptance_runs.summarize(
        [*results[:19], _result(20, seconds=181.0), _result(21, seconds=500.0)]
    )
    assert slow.p90_s == 181.0 and not slow.p90_ok and not slow.passed

    costly = acceptance_runs.summarize([_result(1, cost="0.31"), _result(2, cost="0.30")])
    assert costly.mean_cost_usd == Decimal("0.305") and not costly.cost_ok

    cold = acceptance_runs.summarize([_result(1, read=5999)])
    assert not cold.cache_ok

    failed = acceptance_runs.summarize(
        [*results[:19], _result(20, status="failed", seconds=None, cost="0.05", read=0)]
    )
    # Сбой не входит в p90, среднюю и долю кэша, но приемку не пускает
    assert failed.p90_ok and failed.cost_ok and failed.cache_ok
    assert failed.errors == 1 and not failed.passed
    assert not summary.trial and summary.complete and summary.news_ok


def test_summary_news_and_series() -> None:
    """Матч без новостей, найденных в серии (лимит, кэш, сбой, выключены), делает приемку
    недействительной: цена и время такого анализа занижены. Прерванная серия и серия
    меньше 20 прогонов — не приемка."""
    results = [_result(n) for n in range(1, 21)]
    for state in ("limit", "cache", "failed", "off", "missing"):
        summary = acceptance_runs.summarize([*results[:19], _result(20, news=state)])
        assert summary.p90_ok and summary.cost_ok and summary.cache_ok
        assert summary.news_found == 19 and summary.news_matches == 20
        assert summary.news_states[state] == 1
        assert not summary.news_ok and not summary.passed

    interrupted = acceptance_runs.summarize(results[:5], planned=20)
    assert not interrupted.complete and not interrupted.passed and interrupted.runs == 5

    trial = acceptance_runs.summarize(results[:2])
    assert trial.passed and trial.trial
    assert not acceptance_runs.summarize(results).trial


def test_summary_counts_each_run_as_alone() -> None:
    """Первый вызов Opus прогона читает кэш прошлого прогона: в критериях эти токены
    считаются записью (живые числа 12 октября: вход 2 596, system 3 903)."""
    # Прогон из 3 матчей с теплым кэшем: все три вызова читают system
    warm = RunResult(
        number=2,
        match_ids=(1, 2, 3),
        status="done",
        duration_s=100.0,
        cost_usd=Decimal("0.20"),
        opus_input=3 * 2596,
        opus_write=0,
        opus_read=3 * 3903,
        opus_first_read=3903,
        # Opus 5.5 (model_prices): запись 5 мин $5, чтение $0,20 за 1 млн
        first_read_extra_usd=Decimal(3903) * (Decimal("5") - Decimal("0.20")) / 10**6,
        news={"done": 3},
    )
    assert warm.raw_cache_share == pytest.approx(3 * 3903 / (3 * 6499))
    # Как отдельный анализ: первый вызов пишет кэш, читают два других — около 40%
    assert warm.cache_share == pytest.approx(2 * 3903 / (3 * 6499))
    assert round(warm.cache_share or 0, 3) == 0.400
    assert warm.alone_cost_usd == Decimal("0.20") + Decimal("0.0187344")
    summary = acceptance_runs.summarize([warm])
    assert summary.cache_share == pytest.approx(0.4004, abs=1e-4)
    assert summary.cache_share_raw == pytest.approx(0.6006, abs=1e-4)
    assert summary.mean_cost_usd == Decimal("0.218734")
    assert summary.mean_cost_raw_usd == Decimal("0.2")
    assert not summary.cache_ok


def test_news_problem_and_searches() -> None:
    plans = [
        acceptance_runs.RunPlan(1, (_match(1, 1, 2), _match(2, 3, 4), _match(3, 5, 6))),
        acceptance_runs.RunPlan(2, (_match(4, 7, 8), _match(5, 9, 10))),
    ]
    config = AgentConfig()
    assert acceptance_runs.news_problem(config, plans) is None
    # До 2 поисков на матч, не больше 6 на анализ
    assert acceptance_runs.max_searches(config, plans) == 6 + 4
    off = config.model_copy(update={"news_enabled": False})
    assert acceptance_runs.news_problem(off, plans) == ("news_off", {})
    # 3 поиска на матч, 6 на анализ: третий матч может остаться без поиска
    greedy = config.model_copy(update={"news_max_uses": 3})
    assert acceptance_runs.news_problem(greedy, plans) == (
        "news_per_analysis",
        {"limit": 6, "matches": 3, "uses": 3, "need": 7},
    )


# --- команда ---


async def test_candidates_skip_matches_without_odds_or_fresh_assessment(
    db: AsyncSession, world: dict[str, int]
) -> None:
    config = AgentConfig()
    now = datetime.now(UTC)
    found, stale = await acceptance_runs.candidate_matches(db, config, now=now)
    total = await db.scalar(select(func.count()).select_from(Match))
    assert len(found) == total
    days = [match.day for match in found]
    assert days == sorted(days, reverse=True)
    assert all(match.odds == (Decimal("1.30"), Decimal("3.60")) for match in found)
    assert stale == {
        world[key]
        for key in (
            "sinner",
            "alcaraz",
            "djokovic",
            "medvedev",
            "rublev",
            "rune",
            *(name for pair in EXTRA for name in pair),
        )
    }
    # Кэф вне 1.01–50 — матч не годится
    await db.execute(
        update(OddsSnapshot)
        .where(OddsSnapshot.match_id == found[0].match_id)
        .values(odds=Decimal("60"))
    )
    await db.commit()
    again, _ = await acceptance_runs.candidate_matches(db, config, now=now)
    assert found[0].match_id not in {match.match_id for match in again}


async def test_acceptance_runs_command(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    answers = iter(["нет"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    # Отказ — свой код 2, а не «критерий не выполнен»
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "2"]) == 2
    printed = capsys.readouterr()
    assert "в худшем случае до $" in printed.out and "owner@example.com" in printed.out
    assert "Поисков — до 10: в дневной лимит" in printed.out
    assert "пробный прогон" in printed.out
    assert "Отменено" in printed.err
    assert fake.requests == []

    report = tmp_path / "acceptance.md"
    code = await asyncio.to_thread(
        cli.main, ["acceptance-runs", "--count", "2", "--yes", "--report", str(report)]
    )
    printed = capsys.readouterr()
    analyses = list(await db.scalars(select(Analysis).order_by(Analysis.id)))
    assert [a.input_text.splitlines()[0] for a in analyses] == [
        "Приемка этапа 3, прогон 1",
        "Приемка этапа 3, прогон 2",
    ]
    confirmed = [a.confirmed or {} for a in analyses]
    assert [len(item["events"]) for item in confirmed] == [3, 2]
    assert all(a.status == "done" and a.user_id == world["admin"] for a in analyses)
    assert all(a.checkpoint["acceptance"] in (1, 2) for a in analyses)
    # Новости всех матчей найдены в серии: игроки в прогонах не повторяются
    assert all(
        entry["news"] == "done" for a in analyses for entry in a.checkpoint["matches"].values()
    )
    # avg и pinnacle — источник кэфов, не букмекер: список букмекеров администратора пуст
    assert all(a.bookmaker is None for a in analyses)
    admin = await db.get_one(User, world["admin"])
    client = await login(await make_client(), admin)
    assert (await client.get("/api/me/bookmakers")).json() == []
    # Шаги — как у обычного анализа: разбор, новости, оценка Opus, все в agent_runs
    kinds = {
        kind
        for (kind,) in await db.execute(
            select(AgentRun.kind).where(AgentRun.analysis_id.in_([a.id for a in analyses]))
        )
    }
    assert kinds == {"parse", "news", "analysis"}
    predictions = list(await db.scalars(select(Prediction)))
    assert len(predictions) == 6 * 5 and all(
        p.is_eval and p.eval_run_id is None for p in predictions
    )
    # Матчи взяты из архива, новых нет
    assert {event["match_id"] for item in confirmed for event in item["events"]} <= set(
        await db.scalars(select(Match.id).where(Match.source == "sackmann"))
    )
    text = report.read_text(encoding="utf-8")
    assert "# Приемка этапа 3: анализы" in text and "p90 длительности" in text
    assert "Новости (Sonnet, веб-поиск)" in text
    assert "новости найдены у всех матчей | все | 5 из 5 | выполнен" in text
    assert "Как есть, с чтением кэша прошлого прогона" in text
    assert "| 3 из 3 |" in text and "| 2 из 2 |" in text
    summary_ok = "**Приемка пройдена.**" in text
    assert code == (0 if summary_ok else 1)
    # У поддельного Claude досье длиннее system: доля кэша меньше 60%, критерий не выполнен
    assert not summary_ok and "доля кэша" in printed.err
    assert "готово" in printed.out and "Итог приемки" in printed.out
    assert "Отчет: " + str(report) in printed.out
    assert "sk-ant-" not in printed.out + printed.err + text


async def test_acceptance_verdicts(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Критерии выполнены на 1 прогоне — пробный прогон (код 3), а не приемка; на размере
    приемки — код 0; сбой новостей матча — приемка не пройдена (код 1). Доля кэша
    поддельного Claude всегда меньше 60%: этот критерий здесь отключен."""
    monkeypatch.setattr(acceptance_runs, "CACHE_MIN_SHARE", 0.0)
    report = tmp_path / "r.md"
    args = ["acceptance-runs", "--count", "1", "--yes", "--report", str(report), "--local-sh"]
    assert await asyncio.to_thread(cli.main, args) == 3
    printed = capsys.readouterr()
    assert "Пробный прогон: критерии выполнены, но анализов 1, а приемка — на 20" in printed.err
    assert "**Пробный прогон" in report.read_text(encoding="utf-8")
    # Через bash deploy/local.sh путь отчета в контейнере не печатается
    assert "Отчет:" not in printed.out

    monkeypatch.setattr(acceptance_runs, "ACCEPTANCE_RUNS", 1)
    await _forget_series(db)
    assert await asyncio.to_thread(cli.main, args) == 0
    assert "Приемка пройдена" in capsys.readouterr().out
    assert "**Приемка пройдена.**" in report.read_text(encoding="utf-8")

    await _forget_series(db)
    fake.fail("news", "overloaded", times=1)
    assert await asyncio.to_thread(cli.main, args) == 1
    printed = capsys.readouterr()
    assert "новости найдены не у всех матчей: 2 из 3" in printed.err
    text = report.read_text(encoding="utf-8")
    assert "**Приемка не пройдена.**" in text and "сбой: 1" in text


async def _forget_series(db: AsyncSession) -> None:
    """Следующая серия снова может взять те же матчи: новости устарели, оценки не берутся
    повторно."""
    await db.execute(update(Player).values(news_checked_at=None))
    await db.execute(update(AppSettings).values(agent_config={"assessment_reuse_hours": 0}))
    await db.commit()


async def test_acceptance_runs_ignore_daily_search_limit(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
    make_user: UserFactory,
) -> None:
    """Дневной лимит поисков (30) почти выбран анализами участников: прогон приемки все
    равно ищет новости всех матчей, а участнику остаются те же 2 поиска."""
    member = await make_user()
    db.add(
        AgentRun(
            user_id=member.user.id,
            key_source="admin",
            kind="news",
            step=1,
            model="claude-sonnet-5-5",
            web_searches=28,
            cost_usd=Decimal("0.28"),
            created_at=datetime.now(UTC),
        )
    )
    await db.commit()
    found, stale = await acceptance_runs.candidate_matches(db, AgentConfig(), now=datetime.now(UTC))
    plan = acceptance_runs.plan_runs(found, stale, 1)[0]
    result = await acceptance_runs.run_one(
        create_sessionmaker(engine),
        redis,
        admin_id=world["admin"],
        plan=plan,
        title="Приемка этапа 3, прогон 1",
        currency="RUB",
    )
    assert result.done and result.news == {"done": 3} and result.searches >= 3
    used = {pid for match in plan.matches for pid in (match.player1_id, match.player2_id)}
    pair = next(
        (first, second)
        for first, second in (("sinner", "rune"), ("djokovic", "rublev"), ("alcaraz", "medvedev"))
        if world[first] not in used and world[second] not in used
    )
    analysis_id = await make_analysis(db, redis, member.user, world, pair)
    assert await run(engine, redis, analysis_id) == "done"
    analysis = await db.get_one(Analysis, analysis_id, populate_existing=True)
    news = next(step for step in analysis.checkpoint["steps"] if step["kind"] == "news")
    assert news["detail_key"] == "analysis.steps.news_found"
    member_searches = await db.scalar(
        select(func.sum(AgentRun.web_searches)).where(AgentRun.user_id == member.user.id)
    )
    assert member_searches is not None and 29 <= member_searches <= 30


async def test_acceptance_runs_refuse_without_news(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    await db.execute(update(AppSettings).values(agent_config={"news_enabled": False}))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "1", "--yes"]) == 1
    assert "Новости выключены" in capsys.readouterr().err
    await db.execute(update(AppSettings).values(agent_config={"news_max_uses": 3}))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "1", "--yes"]) == 1
    assert "Лимит поисков на анализ — 6" in capsys.readouterr().err
    assert fake.requests == []


@pytest.mark.parametrize(
    ("step", "call", "failed_step"), [("analysis", 4, "claude"), ("parse", 2, "parse")]
)
async def test_acceptance_runs_report_on_interrupt(
    db: AsyncSession,
    world: dict[str, int],
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
    step: str,
    call: int,
    failed_step: str,
) -> None:
    """Ctrl+C посреди второго анализа (в оценке Opus или еще в разборе текста): код 130 и
    текст вместо трассировки, отчет — по законченному анализу, прерванный анализ —
    failed (analysis.worker_lost), резерв снят."""
    main: list[asyncio.Task[None]] = []
    calls = 0

    def run_interrupted(coro: Coroutine[Any, Any, None]) -> None:
        # Как asyncio.run: после SIGINT главная задача отменяется, наружу — KeyboardInterrupt
        loop = asyncio.new_event_loop()
        try:
            main.append(loop.create_task(coro))
            loop.run_until_complete(main[0])
        except asyncio.CancelledError:
            raise KeyboardInterrupt from None
        finally:
            loop.close()

    async def gate(current: str, body: dict[str, Any], number: int) -> None:
        nonlocal calls
        if current != step:
            return
        calls += 1
        if calls == call:
            # Первый вызов этого шага во втором анализе (у первого — 3 матча): Ctrl+C
            main[0].cancel()
            await asyncio.sleep(5)

    monkeypatch.setattr(asyncio, "run", run_interrupted)
    report = tmp_path / "r.md"
    with contextmanager(install_gated)(FakeClaude(), gate):
        code = await asyncio.to_thread(
            cli.main, ["acceptance-runs", "--count", "2", "--yes", "--report", str(report)]
        )
    printed = capsys.readouterr()
    assert code == 130
    assert "Серия прервана: законченных анализов 1 из 2" in printed.out
    assert "Прервано (Ctrl+C)" in printed.err and "Traceback" not in printed.err
    text = report.read_text(encoding="utf-8")
    assert "**Серия прервана: законченных анализов 1 из 2." in text
    analyses = list(
        await db.scalars(
            select(Analysis).order_by(Analysis.id).execution_options(populate_existing=True)
        )
    )
    assert [a.status for a in analyses] == ["done", "failed"]
    assert analyses[1].error_code == "analysis.worker_lost"
    assert analyses[1].failed_step == failed_step
    assert analyses[1].budget_reserved_usd == 0


async def test_acceptance_runs_needs_matches_with_odds(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    await db.execute(update(OddsSnapshot).values(bookmaker="bet365"))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--yes"]) == 1
    assert "нашлось: 0" in capsys.readouterr().err
    assert fake.requests == []


async def test_acceptance_runs_checks_budget(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    """Оценка всей серии больше остатка общего бюджета — отказ до вызовов; остатка не
    хватает даже на один анализ — отказ с причиной доступа."""
    now = datetime.now(UTC)
    config = await load_agent_config(db)
    found, stale = await acceptance_runs.candidate_matches(db, config, now=now)
    plans = acceptance_runs.plan_runs(found, stale, 2)
    cost = await acceptance_runs.estimate_series(
        db, config, plans, currency="RUB", prompt_version="analysis.v1", now=now
    )
    budget = (cost.per_run_max_usd + Decimal("0.10")).quantize(Decimal("0.01"))
    assert cost.estimate_usd > budget
    await db.execute(update(AppSettings).values(monthly_budget_usd=budget))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "2", "--yes"]) == 1
    assert "больше остатка общего бюджета" in capsys.readouterr().err
    assert fake.requests == []
    await db.execute(update(AppSettings).values(monthly_budget_usd=Decimal("0.01")))
    await db.commit()
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "1", "--yes"]) == 1
    assert "сейчас не запустить" in capsys.readouterr().err
    assert fake.requests == []


async def test_acceptance_runs_stop_after_key_failure(
    db: AsyncSession, world: dict[str, int], fake: FakeClaude, capsys: pytest.CaptureFixture[str]
) -> None:
    fake.fail("parse", "key_rejected", times=5)
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "2", "--yes"]) == 1
    printed = capsys.readouterr()
    assert "Серия остановлена" in printed.out
    analyses = list(await db.scalars(select(Analysis)))
    assert len(analyses) == 1
    assert analyses[0].status == "failed" and analyses[0].error_code == "ai.key_rejected"
    assert analyses[0].failed_step == "parse"
    assert len(fake.calls("parse")) == 1


async def test_acceptance_runs_without_admin(
    db: AsyncSession, engine: AsyncEngine, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--yes"]) == 1
    assert "Нет действующего администратора" in capsys.readouterr().err
    assert await asyncio.to_thread(cli.main, ["acceptance-runs", "--count", "0"]) == 1
    assert "от 1 до 50" in capsys.readouterr().err


async def test_run_one_records_parse_mismatch(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Разбор, нашедший не те кэфы, не останавливает прогон: анализ идет с известными
    событиями, а расхождение видно в итоге."""
    found, stale = await acceptance_runs.candidate_matches(db, AgentConfig(), now=datetime.now(UTC))
    plan = acceptance_runs.plan_runs(found, stale, 1)[0]
    original = acceptance_runs.input_text

    def wrong_text(plan_: acceptance_runs.RunPlan, *, title: str, currency: str) -> str:
        return original(plan_, title=title, currency=currency).replace("П2 = 3.6", "П2 = 3.7")

    monkeypatch.setattr(acceptance_runs, "input_text", wrong_text)
    result = await acceptance_runs.run_one(
        create_sessionmaker(engine),
        redis,
        admin_id=world["admin"],
        plan=plan,
        title="Приемка этапа 3, прогон 1",
        currency="RUB",
    )
    assert result.done and result.parse_agrees is False
    assert result.duration_s is not None and result.duration_s >= 0
    assert set(result.costs) == {"parse", "news", "analysis"}
    assert result.searches > 0 and result.cache_share is not None
