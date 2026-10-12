"""Выполнение анализа (app/services/analysis_run.py) на поддельном Claude: статусы,
события прогресса, учет вызовов, прогнозы, экспресс и сумма, сбои шагов, перезапуск с
чекпойнта, отмена, переиспользование оценки, чей ключ платит, уборщик."""

import json
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import (
    AgentRun,
    Analysis,
    MatchAssessment,
    Notification,
    Player,
    PlayerNews,
    Prediction,
    UserSecret,
)
from app.db.session import create_sessionmaker
from app.services.analysis_run import reap_stuck
from app.services.progress import stream_key
from app.services.sessions import utcnow
from tests.analysis_helpers import (
    install,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
    set_own_key,
)
from tests.claude_mock import KEY, OTHER_KEY, seed_prices
from tests.fake_claude import FakeClaude, _user_text
from tests.support import UserFactory

ACTIVE_FLOW = ["building_dossier", "modelling", "llm_review", "composing"]


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _events(redis: Redis, analysis_id: int) -> list[dict[str, Any]]:
    rows = await redis.xrange(stream_key(analysis_id))
    return [json.loads(fields["data"]) for _, fields in rows]


async def _analysis(db: AsyncSession, analysis_id: int) -> Analysis:
    return await db.get_one(Analysis, analysis_id, populate_existing=True)


async def _runs(db: AsyncSession, analysis_id: int) -> list[AgentRun]:
    rows = await db.scalars(
        select(AgentRun).where(AgentRun.analysis_id == analysis_id).order_by(AgentRun.id)
    )
    return list(rows)


async def test_full_analysis_of_two_matches(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(
        db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"

    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "done" and analysis.finished_at is not None
    assert analysis.budget_reserved_usd == 0
    # Шаги: новости и Claude по матчу, все выполнены
    steps = analysis.checkpoint["steps"]
    assert [step["kind"] for step in steps] == [
        "parse",
        "players",
        "news",
        "news",
        "dossier",
        "model",
        "claude",
        "claude",
        "compose",
    ]
    assert steps[0]["state"] == "skipped"
    assert all(step["state"] == "done" for step in steps[1:])
    # Вызовы: новости (Sonnet) и анализ (Opus) по матчу, с токенами и стоимостью
    runs = await _runs(db, analysis_id)
    assert sorted(run.kind for run in runs) == ["analysis", "analysis", "news", "news"]
    assert all(run.cost_usd > 0 and run.input_tokens > 0 for run in runs)
    assert analysis.cost_usd == sum((run.cost_usd for run in runs), Decimal(0))
    assert {run.key_source for run in runs} == {"admin"}
    # Кэш: первый вызов анализа пишет, второй читает
    opus = [run for run in runs if run.kind == "analysis"]
    assert opus[0].cache_write_tokens > 0 and opus[1].cache_read_tokens > 0
    # Прогнозы: 6 исходов на матч; p_claude — исходное, p_final в окне ±0,10
    predictions = list(
        await db.scalars(select(Prediction).where(Prediction.analysis_id == analysis_id))
    )
    assert len(predictions) == 12
    for row in predictions:
        assert row.p_base is not None and row.p_claude is not None and row.p_final is not None
        assert abs(row.p_final - row.p_base) <= 0.10 + 1e-9
        assert row.llm_model == "claude-opus-5-5" and row.dossier_id is not None
    # Итог: экспресс из 2 и сумма от банка из ввода (журнал пуст)
    result = analysis.result
    assert result is not None and result["express"] is not None
    express = result["express"]
    assert len(express["legs"]) == 2
    assert Decimal(express["total_odds"]) == Decimal("1.885")
    assert express["stake"]["bank_source"] == "input"
    assert express["stake"]["amount"] is not None
    assert len(result["matches"]) == 2
    assert all(len(match["markets"]) == 6 for match in result["matches"])
    # События прогресса: статусы по порядку, конец — done
    events = await _events(redis, analysis_id)
    statuses = [event["status"] for event in events if event["type"] == "status"]
    assert statuses == ["queued", *ACTIVE_FLOW]
    assert events[-1]["type"] == "done"
    # Новости легли в общий кэш, время проверки новостей обновлено
    news = list(await db.scalars(select(PlayerNews)))
    assert len(news) == 4 and all(item.source_url.startswith("https://") for item in news)
    checked = await db.scalars(
        select(Player.news_checked_at).where(
            Player.id.in_([world["sinner"], world["rune"], world["djokovic"], world["rublev"]])
        )
    )
    assert all(value is not None for value in checked)


async def test_three_matches_with_handicaps(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(
        db,
        redis,
        member.user,
        world,
        ("sinner", "rune"),
        ("djokovic", "rublev"),
        ("alcaraz", "medvedev"),
    )
    assert await run(engine, redis, analysis_id) == "done"
    analysis = await _analysis(db, analysis_id)
    assert analysis.result is not None
    assert len(analysis.result["matches"]) == 3
    assert len(fake.calls("analysis")) == 3
    count = await db.scalar(
        select(func.count()).select_from(Prediction).where(Prediction.analysis_id == analysis_id)
    )
    assert count == 18


def _bodies(fake: FakeClaude, step: str) -> list[dict[str, Any]]:
    return fake.calls(step)


async def test_requests_follow_the_rules_and_tool_whitelist(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    assert await run(engine, redis, analysis_id) == "done"
    news = _bodies(fake, "news")[0]
    analysis = _bodies(fake, "analysis")[0]
    for body in (news, analysis):
        assert "temperature" not in body and "top_p" not in body and "thinking" not in body
        assert "tool_choice" not in body
        assert body["system"][-1]["cache_control"] == {"type": "ephemeral"}
    # Новости: только веб-поиск и свой strict-инструмент; дата — в сообщении, не в system
    assert [tool["name"] for tool in news["tools"]] == ["web_search", "record_news"]
    assert news["tools"][0]["type"] == "web_search_20260209"
    assert news["tools"][0]["max_uses"] == 2
    assert news["tools"][1]["strict"] is True
    assert news["model"] == "claude-sonnet-5-5" and news["output_config"] == {"effort": "low"}
    assert utcnow().date().isoformat() not in json.dumps(news["system"])
    # Анализ: Opus, effort явно, поток, схема ответа, без инструментов
    assert analysis["model"] == "claude-opus-5-5"
    assert analysis["output_config"]["effort"] == "medium"
    assert analysis["output_config"]["format"]["type"] == "json_schema"
    assert analysis["stream"] is True and "tools" not in analysis
    assert analysis["max_tokens"] == 16000


@pytest.mark.parametrize(
    ("error", "code", "detail"),
    [
        ("key_rejected", "ai.key_rejected", "401:authentication_error"),
        ("rate_limited", "ai.rate_limited", "429:rate_limit_error"),
        ("overloaded", "ai.overloaded", "529:overloaded_error"),
        ("refusal", "ai.refusal", "refusal:cyber"),
        ("max_tokens", "ai.max_tokens", "max_tokens"),
        ("bad_json", "ai.bad_output", "schema"),
    ],
)
async def test_failed_analysis_call_stops_with_code(
    error: str,
    code: str,
    detail: str,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("analysis", error)
    assert await run(engine, redis, analysis_id) == "failed"
    analysis = await _analysis(db, analysis_id)
    assert analysis.error_code == code
    assert analysis.failed_step == "claude"
    assert analysis.budget_reserved_usd == 0
    steps = {step["kind"]: step for step in analysis.checkpoint["steps"]}
    assert steps["claude"]["state"] == "failed"
    assert steps["claude"]["detail_key"] == f"errors.{code}"
    # Строка учета пишется и на неудачный вызов: с кодом и request_id
    failed = [run for run in await _runs(db, analysis_id) if run.kind == "analysis"]
    assert len(failed) == 1 and failed[0].error == detail
    assert failed[0].request_id == "req_fake"
    events = await _events(redis, analysis_id)
    assert events[-1]["type"] == "failed"
    assert events[-1]["error"]["code"] == code and events[-1]["error"]["step"] == "claude"


async def test_rejected_admin_key_notifies_admins(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    admin = await make_user(role="admin")
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("news", "key_rejected")
    assert await run(engine, redis, analysis_id) == "failed"
    analysis = await _analysis(db, analysis_id)
    assert analysis.error_code == "ai.key_rejected" and analysis.failed_step == "news"
    notes = list(await db.scalars(select(Notification).where(Notification.kind == "ai_key_failed")))
    assert [note.user_id for note in notes] == [admin.id]


async def test_rejected_own_key_marks_secret(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    await set_own_key(db, member.user)
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("analysis", "key_rejected")
    assert await run(engine, redis, analysis_id) == "failed"
    secret = await db.scalar(
        select(UserSecret)
        .where(UserSecret.user_id == member.id)
        .execution_options(populate_existing=True)
    )
    assert secret is not None and secret.last_error == "ai.key_rejected"
    assert secret.verified_at is None


@pytest.mark.parametrize("error", ["search_error", "no_record", "overloaded"])
async def test_news_failure_is_a_warning(
    error: str,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("news", error, times=2)
    assert await run(engine, redis, analysis_id) == "done"
    analysis = await _analysis(db, analysis_id)
    assert analysis.result is not None
    keys = {warning["key"] for warning in analysis.result["warnings"]}
    news_step = next(step for step in analysis.checkpoint["steps"] if step["kind"] == "news")
    assert "analysis.warnings.news_failed" in keys
    assert news_step["state"] == "skipped"
    assert news_step["detail_key"] == "analysis.steps.news_failed"
    if error == "search_error":
        # Ошибка поиска приходит ответом 200: ни один поиск не удался — новости не
        # получены, анализ идет дальше, а игроки не отмечены проверенными
        assert news_step["detail_params"] == {"code": "unavailable"}
        checked = await db.scalars(
            select(Player.news_checked_at)
            .where(Player.id.in_((world["sinner"], world["rune"])))
            .execution_options(populate_existing=True)
        )
        assert list(checked) == [None, None]
    if error == "no_record":
        # Модель не вызвала record_news: одна просьба, затем отказ от новостей
        assert len(fake.calls("news")) == 2
        assert fake.calls("news")[1]["messages"][-1]["role"] == "user"


async def test_bad_checks_continue_the_same_conversation(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("analysis", "bad_checks")
    assert await run(engine, redis, analysis_id) == "done"
    calls = fake.calls("analysis")
    assert len(calls) == 2
    second = calls[1]["messages"]
    assert [message["role"] for message in second] == ["user", "assistant", "user"]
    assert "news:999999" in second[2]["content"]
    runs = [run for run in await _runs(db, analysis_id) if run.kind == "analysis"]
    assert [run.error for run in runs] == ["checks", None]
    # Вторая итерация читает кэш промпта
    assert runs[1].cache_read_tokens > 0


async def test_bad_checks_after_last_iteration_fail(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("analysis", "bad_checks", times=3)
    assert await run(engine, redis, analysis_id) == "failed"
    analysis = await _analysis(db, analysis_id)
    assert analysis.error_code == "ai.bad_output"
    assert len(fake.calls("analysis")) == 3


async def test_retry_continues_from_failed_step(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    from app.services import analyses as analyses_service
    from tests.analysis_helpers import _no_queue

    member = await make_user()
    analysis_id = await make_analysis(
        db, redis, member.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    fake.fail("analysis", "overloaded")
    assert await run(engine, redis, analysis_id) == "failed"
    first = await _runs(db, analysis_id)
    assert sorted(run.kind for run in first) == ["analysis", "news", "news"]
    analysis = await _analysis(db, analysis_id)
    started = analysis.started_at

    again = await analyses_service.start_run(
        db, redis, member.user, analysis_id, None, enqueue=_no_queue
    )
    assert again.attempt == 2 and again.status == "queued"
    assert await run(engine, redis, analysis_id) == "done"
    runs = await _runs(db, analysis_id)
    # Новости и досье не повторялись: добавились только два вызова анализа
    assert sorted(run.kind for run in runs) == ["analysis", "analysis", "analysis", "news", "news"]
    analysis = await _analysis(db, analysis_id)
    assert analysis.started_at == started
    assert analysis.error_code is None and analysis.status == "done"


async def test_cancel_between_steps(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import analysis_run

    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    original = analysis_run._Runner.model

    async def cancel_then_model(self: Any) -> None:
        async with create_sessionmaker(engine)() as session:
            await session.execute(
                update(Analysis).where(Analysis.id == analysis_id).values(status="cancelled")
            )
            await session.commit()
        await original(self)

    monkeypatch.setattr(analysis_run._Runner, "model", cancel_then_model)
    assert await run(engine, redis, analysis_id) == "cancelled"
    assert fake.calls("analysis") == []
    count = await db.scalar(
        select(func.count()).select_from(Prediction).where(Prediction.analysis_id == analysis_id)
    )
    assert count == 0


async def test_fresh_assessment_is_reused(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    first_user = await make_user()
    second_user = await make_user()
    first = await make_analysis(db, redis, first_user.user, world, ("sinner", "rune"))
    assert await run(engine, redis, first) == "done"
    assert len(fake.calls("analysis")) == 1
    second = await make_analysis(db, redis, second_user.user, world, ("sinner", "rune"))
    assert await run(engine, redis, second) == "done"
    # Оценка взята готовой: ни одного нового вызова Opus и новостей
    assert len(fake.calls("analysis")) == 1
    assert len(fake.calls("news")) == 1
    analysis = await _analysis(db, second)
    claude_step = next(step for step in analysis.checkpoint["steps"] if step["kind"] == "claude")
    assert claude_step["detail_key"] == "analysis.steps.claude_reused"
    assert analysis.result is not None
    assert analysis.result["matches"][0]["reused_from"] is not None
    assert analysis.cost_usd == 0
    assert await db.scalar(select(func.count()).select_from(MatchAssessment)) == 1


async def test_key_of_the_mode_pays(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    shared = await make_user()
    own = await make_user()
    await set_own_key(db, own.user)
    first = await make_analysis(db, redis, shared.user, world, ("sinner", "rune"))
    assert await run(engine, redis, first) == "done"
    assert set(fake.keys) == {KEY}
    fake.keys.clear()
    second = await make_analysis(db, redis, own.user, world, ("djokovic", "rublev"))
    assert await run(engine, redis, second) == "done"
    assert set(fake.keys) == {OTHER_KEY}
    runs = await _runs(db, second)
    assert {run.key_source for run in runs} == {"own"}


async def test_key_never_reaches_logs_or_agent_runs(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fake.fail("analysis", "key_rejected")
    assert await run(engine, redis, analysis_id) == "failed"
    captured = capsys.readouterr()
    assert "sk-ant-" not in caplog.text
    assert "sk-ant-" not in captured.out + captured.err
    for row in await _runs(db, analysis_id):
        assert "sk-ant-" not in (row.error or "")
    analysis = await _analysis(db, analysis_id)
    assert "sk-ant-" not in json.dumps(analysis.checkpoint, ensure_ascii=False)
    for event in await _events(redis, analysis_id):
        assert "sk-ant-" not in json.dumps(event)


async def test_reaper_fails_stuck_analysis(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    fresh_id = await make_analysis(db, redis, member.user, world, ("djokovic", "rublev"))
    await db.execute(
        update(Analysis)
        .where(Analysis.id == analysis_id)
        .values(status="llm_review", updated_at=utcnow() - timedelta(minutes=20))
    )
    await db.commit()
    reaped = await reap_stuck(create_sessionmaker(engine), redis)
    assert reaped == [analysis_id]
    analysis = await _analysis(db, analysis_id)
    assert analysis.status == "failed" and analysis.error_code == "analysis.worker_lost"
    assert analysis.budget_reserved_usd == 0
    assert (await _analysis(db, fresh_id)).status == "queued"
    events = await _events(redis, analysis_id)
    assert events[-1]["type"] == "failed"
    assert events[-1]["error"]["code"] == "analysis.worker_lost"


async def test_worker_job_runs_only_its_attempt(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    from app.workers.jobs import reap_stuck_analyses, run_analysis

    member = await make_user()
    analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
    ctx = {"sessionmaker": create_sessionmaker(engine)}
    # Задача старого запуска ничего не делает
    assert await run_analysis(ctx, analysis_id, 7) == "queued"
    assert fake.requests == []
    assert await run_analysis(ctx, analysis_id, 1) == "done"
    assert await reap_stuck_analyses(ctx) == 0


@contextmanager
def _installed(fake: FakeClaude) -> Iterator[FakeClaude]:
    yield from install(fake)


class NumbersByMatchLine(FakeClaude):
    """Модель нумерует игроков по строке «Матч: A vs B», а не по списку запроса."""

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._news(body, model, error)
        line = next(row for row in _user_text(body).splitlines() if row.startswith("Матч: "))
        first = line.removeprefix("Матч: ").split(" vs ")[0]
        for block in msg["content"]:
            if block.get("type") == "tool_use":
                for group in block["input"]["players"]:
                    name = group["items"][0]["summary"].split(":")[0]
                    group["player"] = 1 if name == first else 2
        return msg


async def test_news_of_second_player_only_keeps_his_number(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    """Новости устарели только у второго игрока: в запросе он остается номером 2, как в
    строке «Матч». Раньше он шел под номером 1, модель записывала его факты как player 2,
    код их отбрасывал, а игрока отмечал проверенным: найденная травма терялась на 12 ч."""
    with _installed(NumbersByMatchLine()) as fake:
        await db.execute(
            update(Player).where(Player.id == world["sinner"]).values(news_checked_at=utcnow())
        )
        await db.commit()
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        assert await run(engine, redis, analysis_id) == "done"
    text = _user_text(fake.calls("news")[0])
    assert "\n2. Holger Rune\n" in text and "1. " not in text.split("Игроки")[1]
    facts = list(
        await db.scalars(select(PlayerNews.player_id).where(PlayerNews.player_id == world["rune"]))
    )
    assert facts == [world["rune"]]


class WrongNumber(FakeClaude):
    """Модель записала факты под номером игрока, которого нет в запросе."""

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._news(body, model, error)
        for block in msg["content"]:
            if block.get("type") == "tool_use":
                for group in block["input"]["players"]:
                    group["player"] = 3 - group["player"]
        return msg


async def test_misplaced_news_do_not_mark_player_checked(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
) -> None:
    """Все факты ответа — под номером не из запроса: чьи они, неизвестно. Игрок не
    отмечается проверенным (следующий анализ поищет снова), шаг — «новости не получены»."""
    with _installed(WrongNumber()):
        await db.execute(
            update(Player).where(Player.id == world["sinner"]).values(news_checked_at=utcnow())
        )
        await db.commit()
        member = await make_user()
        analysis_id = await make_analysis(db, redis, member.user, world, ("sinner", "rune"))
        assert await run(engine, redis, analysis_id) == "done"
    rune = await db.get_one(Player, world["rune"], populate_existing=True)
    assert rune.news_checked_at is None
    analysis = await _analysis(db, analysis_id)
    news = [step for step in analysis.checkpoint["steps"] if step["kind"] == "news"]
    assert news[0]["detail_key"] == "analysis.steps.news_failed"
    assert news[0]["detail_params"] == {"code": "bad_player"}
