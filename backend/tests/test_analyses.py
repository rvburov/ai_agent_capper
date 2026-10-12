"""Маршруты анализов /api/analyses/*: разбор текста, форма, «Перед запуском», запуск и
перезапуск, отказ по лимитам, отмена, решение, список, поток прогресса, права и CSRF."""

import asyncio
from collections.abc import Iterator
from decimal import Decimal
from typing import Any

import anthropic
import httpx2
import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent.client import set_http_client_for_tests
from app.api.routes import analyses as analyses_routes
from app.db.models import AgentRun, AiLimit, Analysis, Match, OddsSnapshot
from app.schemas.analyses import AnalysisOut
from app.services import analyses as analyses_service
from tests.analysis_helpers import (
    install,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
    set_own_key,
)
from tests.claude_mock import KEY, OTHER_KEY, seed_prices
from tests.fake_claude import FakeClaude, step_of
from tests.helpers_admin import Signed, error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory

TEXT = """Текущий банк: 48 000 ₽
Букмекер: Fonbet

События:
Синнер vs Руне, Шанхай, хард
Кэфы: П1 = 1.30, П2 = 3.60
Фора по сетам: П1(-1.5) = 1.62, П2(+1.5) = 2.30

Джокович vs Рублев, Шанхай, хард, 1/8
Кэфы: П1 = 1.45, П2 = 2.80
Тотал больше 22.5 = 1.80"""


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[tuple[int, int, str]]:
    """Постановки задачи воркера вместо очереди arq."""
    calls: list[tuple[int, int, str]] = []

    async def fake_enqueue(analysis_id: int, attempt: int, job_id: str) -> None:
        calls.append((analysis_id, attempt, job_id))

    monkeypatch.setattr(analyses_routes, "enqueue_analysis", fake_enqueue)
    return calls


async def _member(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, **fields: Any
) -> Signed:
    return await signed_in(make_client, make_user, login, **fields)


def _event(world: dict[str, int], first: str, second: str, **odds: Any) -> dict[str, Any]:
    return {
        "player1_id": world[first],
        "player2_id": world[second],
        "tournament_name": "Test Open 9",
        "surface": "hard",
        "round": "R16",
        "odds": {"ML": odds.get("ml", ["1.30", "3.60"]), "HCP_-1.5": [None, None]},
        "bookmaker": "Fonbet",
    }


async def test_text_is_parsed_into_draft(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    response = await member.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 201, response.text
    data = AnalysisOut.model_validate(response.json())
    assert data.status == "needs_confirmation" and data.input_kind == "text"
    draft = data.draft
    assert draft is not None
    assert draft.bank == Decimal("48000.00") and draft.currency == "RUB"
    assert draft.bookmaker == "Fonbet" and draft.bank_note_key is None
    assert [event.player1.status for event in draft.events] == ["matched", "matched"]
    first = draft.events[0]
    assert first.player1.player is not None and first.player1.player.id == world["sinner"]
    assert first.player2.player is not None and first.player2.player.id == world["rune"]
    assert first.player1.player.elo_rank == 1
    assert first.surface == "hard"
    raw = response.json()["draft"]["events"][0]["odds"]
    assert raw == {"ML": ["1.30", "3.60"], "HCP_-1.5": ["1.62", None], "HCP_+1.5": [None, "2.30"]}
    assert [line.text for line in draft.unknown_lines] == ["Тотал больше 22.5 = 1.80"]
    assert draft.parse_cost_usd > 0
    runs = list(await db.scalars(select(AgentRun).where(AgentRun.analysis_id == data.id)))
    assert [(run.kind, run.model, run.key_source) for run in runs] == [
        ("parse", "claude-haiku-5-5", "admin")
    ]
    assert fake.keys == [KEY]


async def test_parse_goes_with_own_key(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    await set_own_key(db, member.user.user)
    response = await member.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 201
    assert fake.keys == [OTHER_KEY]


async def test_form_creates_empty_draft(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, world: dict[str, int]
) -> None:
    member = await _member(make_client, make_user, login)
    response = await member.client.post("/api/analyses", json={"input_kind": "form"})
    assert response.status_code == 201
    data = response.json()
    assert data["input_kind"] == "form" and data["status"] == "needs_confirmation"
    assert data["draft"]["events"] == [] and data["draft"]["parse_cost_usd"] == 0


@pytest.mark.parametrize(
    ("text", "code"),
    [("   ", "analysis.text_empty"), ("x" * 4001, "analysis.text_too_long")],
)
async def test_text_limits(
    text: str,
    code: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    response = await member.client.post("/api/analyses", json={"text": text})
    assert response.status_code == 422 and error_code(response) == code
    assert fake.requests == []


async def test_parse_refused_without_access(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=Decimal("10"),
            daily_analyses=3,
            per_analysis_usd=Decimal("1"),
            paused=True,
        )
    )
    await db.commit()
    response = await member.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 409 and error_code(response) == "ai.paused"
    own = await _member(make_client, make_user, login, ai_mode="own")
    response = await own.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 409 and error_code(response) == "ai.no_own_key"
    assert fake.requests == []


async def test_parse_rate_limit(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    fake: FakeClaude,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(analyses_service, "CREATE_LIMIT", 1)
    member = await _member(make_client, make_user, login)
    assert (await member.client.post("/api/analyses", json={"text": TEXT})).status_code == 201
    response = await member.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 429 and error_code(response) == "common.rate_limited"
    assert int(response.headers["Retry-After"]) > 0


async def test_parse_failure_is_recorded(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    fake.fail("parse", "overloaded")
    response = await member.client.post("/api/analyses", json={"text": TEXT})
    assert response.status_code == 503 and error_code(response) == "ai.overloaded"
    analysis_id = response.json()["error"]["analysis_id"]
    analysis = await db.get_one(Analysis, analysis_id)
    assert analysis.status == "failed" and analysis.failed_step == "parse"
    run_row = await db.scalar(select(AgentRun).where(AgentRun.analysis_id == analysis_id))
    assert run_row is not None and run_row.error == "529:overloaded_error"


async def test_parse_releases_db_connection_during_claude_call(
    db: AsyncSession, redis: Redis, make_user: UserFactory, world: dict[str, int]
) -> None:
    fake = FakeClaude()
    seen: list[bool] = []

    def handler(request: httpx2.Request) -> httpx2.Response:
        # Пока ждем Claude, транзакция запроса закрыта: соединение вернулось в пул API
        seen.append(db.in_transaction())
        return fake.handler(request)

    set_http_client_for_tests(
        anthropic.DefaultAsyncHttpxClient(transport=httpx2.MockTransport(handler))
    )
    try:
        member = await make_user()
        analysis = await analyses_service.create_from_text(db, redis, member.user, TEXT)
    finally:
        set_http_client_for_tests(None)
    assert analysis.status == "needs_confirmation"
    assert seen == [False]


async def test_interrupted_parse_does_not_stay_in_parsing(
    db: AsyncSession,
    redis: Redis,
    make_user: UserFactory,
    world: dict[str, int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def broken(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("worker stopped")

    monkeypatch.setattr(analyses_service, "parse_text", broken)
    member = await make_user()
    with pytest.raises(RuntimeError):
        await analyses_service.create_from_text(db, redis, member.user, TEXT)
    analysis = await db.scalar(
        select(Analysis)
        .where(Analysis.user_id == member.user.id)
        .execution_options(populate_existing=True)
    )
    # Иначе анализ навсегда в parsing: его нельзя ни запустить, ни отменить
    assert analysis is not None and analysis.status == "failed"
    assert analysis.failed_step == "parse" and analysis.error_code == "common.internal"


async def test_preview_shows_estimate_and_problems(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    body = {
        "events": [
            _event(world, "sinner", "rune"),
            _event(world, "djokovic", "djokovic", ml=["1.45", "60"]),
        ],
        "bank": "10000",
    }
    response = await member.client.post(f"/api/analyses/{created['id']}/preview", json=body)
    assert response.status_code == 200, response.text
    data = response.json()
    first, second = data["events"]
    assert first["problems"] == [] and first["margin_ml"] == pytest.approx(0.0470, abs=1e-3)
    assert [item["market"] for item in first["market_p"]] == ["ML", "ML"]
    assert {player["id"] for player in first["players"]} == {world["sinner"], world["rune"]}
    assert all(not player["news_fresh"] for player in first["players"])
    assert first["in_corridor"] == [{"market": "ML", "selection": 1, "odds": "1.30"}]
    keys = {problem["key"] for problem in second["problems"]}
    assert keys == {"errors.analysis.same_players", "errors.analysis.odds_range"}
    estimate = data["estimate"]
    assert estimate["cost_usd"] > 0 and estimate["news_players"] == 2
    assert estimate["reused_matches"] == 0 and estimate["seconds"] > 0
    assert data["access"]["allowed"] is True and data["access"]["mode"] == "shared"
    assert data["data_to"] is not None


async def test_run_queues_once_and_creates_matches(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    # Черновик еще без подтвержденных событий
    assert created["events"] == []
    url = f"/api/analyses/{created['id']}/run"
    body = {"events": [_event(world, "sinner", "rune")], "bank": "10000"}
    response = await member.client.post(url, json=body)
    assert response.status_code == 202, response.text
    data = response.json()
    assert data["status"] == "queued" and data["attempt"] == 1
    assert data["key_source"] == "admin" and data["estimate_usd"] > 0
    assert [step["kind"] for step in data["steps"]][:3] == ["parse", "players", "news"]
    assert queued == [(created["id"], 1, f"analysis:{created['id']}:1")]
    # Двойное нажатие: второй запуск того же анализа отклонен
    again = await member.client.post(url, json=body)
    assert again.status_code == 409 and error_code(again) == "analysis.bad_state"
    assert len(queued) == 1
    match = await db.scalar(select(Match).where(Match.source == "user"))
    assert match is not None and match.source_ref is not None
    assert match.source_ref.startswith("user:") and match.player1_id == world["sinner"]
    odds = await db.scalar(
        select(func.count()).select_from(OddsSnapshot).where(OddsSnapshot.kind == "user")
    )
    assert odds == 2
    analysis = await db.get_one(Analysis, created["id"], populate_existing=True)
    assert analysis.confirmed is not None
    assert analysis.confirmed["events"][0]["match_id"] == match.id
    assert analysis.confirmed["bank"] == "10000.00"
    assert analysis.budget_reserved_usd > 0
    # Подтвержденные события с именами: экран называет по ним матчи в шагах хода и
    # возвращает события в «Новый анализ» после перезагрузки страницы
    shown = (await member.client.get(f"/api/analyses/{created['id']}")).json()["events"]
    assert len(shown) == 1 and shown[0]["position"] == 1 and shown[0]["match_id"] == match.id
    assert shown[0]["player1"] == {
        "id": world["sinner"],
        "name": "Jannik Sinner",
        "name_ru": "Янник Синнер",
        "country": "ITA",
    }
    assert shown[0]["player2"]["name"] == "Holger Rune"
    assert shown[0]["surface"] == "hard" and shown[0]["round"] == "R16"
    assert shown[0]["odds"] == {
        "ML": ["1.30", "3.60"],
        "HCP_-1.5": [None, None],
        "HCP_+1.5": [None, None],
    }
    assert shown[0]["bookmaker"] == "Fonbet" and shown[0]["best_of"] == 3


@pytest.mark.parametrize(
    ("event", "code"),
    [
        ({"player2_id": None}, "analysis.player_missing"),
        ({"odds": {"ML": ["1.30", None]}}, "analysis.odds_ml"),
        ({"odds": {"ML": ["1.00", "3.60"]}}, "analysis.odds_range"),
        ({"surface": None, "tournament_name": None}, "analysis.surface_missing"),
    ],
)
async def test_run_rejects_bad_events(
    event: dict[str, Any],
    code: str,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    body = {"events": [{**_event(world, "sinner", "rune"), **event}]}
    response = await member.client.post(f"/api/analyses/{created['id']}/run", json=body)
    assert response.status_code == 422 and error_code(response) == code
    assert queued == []


async def test_run_refused_over_monthly_limit_but_own_key_runs(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=Decimal("1"),
            daily_analyses=3,
            per_analysis_usd=Decimal("1"),
        )
    )
    db.add(
        AgentRun(
            user_id=member.id,
            key_source="admin",
            kind="analysis",
            model="claude-opus-5-5",
            cost_usd=Decimal("1"),
        )
    )
    await db.commit()
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    body = {"events": [_event(world, "sinner", "rune")]}
    response = await member.client.post(f"/api/analyses/{created['id']}/run", json=body)
    assert response.status_code == 409 and error_code(response) == "ai.monthly_limit"
    # Свой ключ — вне лимита на ключе администратора
    await set_own_key(db, member.user.user)
    response = await member.client.post(f"/api/analyses/{created['id']}/run", json=body)
    assert response.status_code == 202 and response.json()["key_source"] == "own"


async def test_cancel_and_restart(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    base = f"/api/analyses/{created['id']}"
    body = {"events": [_event(world, "sinner", "rune")]}
    assert (await member.client.post(f"{base}/run", json=body)).status_code == 202
    response = await member.client.post(f"{base}/cancel")
    assert response.status_code == 200 and response.json()["status"] == "cancelled"
    analysis = await db.get_one(Analysis, created["id"], populate_existing=True)
    assert analysis.budget_reserved_usd == 0
    again = await member.client.post(f"{base}/cancel")
    assert again.status_code == 409 and error_code(again) == "analysis.bad_state"
    # Перезапуск без тела — по уже подтвержденным событиям, новые события нельзя
    changed = await member.client.post(f"{base}/run", json=body)
    assert changed.status_code == 409
    restart = await member.client.post(f"{base}/run")
    assert restart.status_code == 202 and restart.json()["attempt"] == 2
    assert [call[2] for call in queued] == [
        f"analysis:{created['id']}:1",
        f"analysis:{created['id']}:2",
    ]


async def test_double_run_is_conflict_not_error(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    url = f"/api/analyses/{created['id']}/run"
    body = {"events": [_event(world, "sinner", "rune")]}
    # Двойное нажатие: второй запрос ждет блокировку строки и видит queued — 409, а не 500
    responses = await asyncio.gather(
        member.client.post(url, json=body), member.client.post(url, json=body)
    )
    assert sorted(response.status_code for response in responses) == [202, 409]
    conflict = next(response for response in responses if response.status_code == 409)
    assert error_code(conflict) == "analysis.bad_state"
    assert len(queued) == 1


async def test_done_analysis_view_decision_and_list(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    analysis_id = await make_analysis(
        db, redis, member.user.user, world, ("sinner", "rune"), ("djokovic", "rublev")
    )
    assert await run(engine, redis, analysis_id) == "done"
    response = await member.client.get(f"/api/analyses/{analysis_id}")
    assert response.status_code == 200
    data = AnalysisOut.model_validate(response.json())
    assert data.status == "done" and data.result is not None and data.result.express is not None
    assert data.totals.steps == len(data.steps) and data.totals.step == len(data.steps)
    assert data.cost_usd > 0 and data.bet_id is None and data.strategy_version == "v3"
    assert data.bet is None
    comparison = {row.key for row in data.result.matches[0].comparison}
    assert {"elo_rank", "elo_surface", "form10", "h2h"} <= comparison
    url = f"/api/analyses/{analysis_id}/decision"
    skip = await member.client.put(url, json={"decision": "skip"})
    assert skip.status_code == 200 and skip.json()["decision"] == "skip"
    undo = await member.client.put(url, json={"decision": None})
    assert undo.status_code == 200 and undo.json()["decision"] is None
    bet = await member.client.put(url, json={"decision": "bet"})
    assert bet.status_code == 422
    listing = await member.client.get("/api/analyses")
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert [item["id"] for item in items] == [analysis_id]
    assert items[0]["matches"] == [
        "Jannik Sinner vs Holger Rune",
        "Novak Djokovic vs Andrey Rublev",
    ]
    # Пары игроков с русскими именами: экран пишет «Синнер — Руне», как на карточках
    assert items[0]["pairs"][0] == {
        "player1": {"name": "Jannik Sinner", "name_ru": "Янник Синнер"},
        "player2": {"name": "Holger Rune", "name_ru": "Хольгер Руне"},
    }


async def test_list_cursor(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    ids = [
        (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()["id"]
        for _ in range(3)
    ]
    first = (await member.client.get("/api/analyses", params={"limit": 2})).json()
    assert [item["id"] for item in first["items"]] == ids[:0:-1]
    second = (
        await member.client.get(
            "/api/analyses", params={"limit": 2, "before": first["next_cursor"]}
        )
    ).json()
    assert [item["id"] for item in second["items"]] == [ids[0]] and second["next_cursor"] is None
    # Только запущенные: черновики (каждая форма и каждый разбор) в короткий список не идут
    url = f"/api/analyses/{ids[1]}/run"
    started = await member.client.post(url, json={"events": [_event(world, "sinner", "rune")]})
    assert started.status_code == 202, started.text
    launched = (await member.client.get("/api/analyses", params={"launched": "true"})).json()
    assert [item["id"] for item in launched["items"]] == [ids[1]]
    assert launched["next_cursor"] is None


async def test_decision_needs_done_analysis(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, world: dict[str, int]
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    response = await member.client.put(
        f"/api/analyses/{created['id']}/decision", json={"decision": "skip"}
    )
    assert response.status_code == 409 and error_code(response) == "analysis.bad_state"


async def test_events_stream_of_finished_analysis(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await _member(make_client, make_user, login)
    analysis_id = await make_analysis(db, redis, member.user.user, world, ("sinner", "rune"))
    assert await run(engine, redis, analysis_id) == "done"
    response = await member.client.get(f"/api/analyses/{analysis_id}/events")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert response.headers["cache-control"] == "no-cache"
    assert response.headers["x-accel-buffering"] == "no"
    chunks = response.text.split("\n\n")
    assert chunks[0] == "retry: 3000"
    assert chunks[1].startswith("id: ") and '"type": "snapshot"' in chunks[1]
    assert '"status": "done"' in chunks[1]


async def test_csrf_and_auth_on_analyses(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, world: dict[str, int]
) -> None:
    anonymous = await make_client()
    response = await anonymous.get("/api/analyses")
    assert response.status_code == 401
    member = await make_user()
    no_csrf = await login(await make_client("10.0.0.9", csrf=False), member)
    response = await no_csrf.post("/api/analyses", json={"input_kind": "form"})
    assert response.status_code == 403 and error_code(response) == "common.csrf"


async def test_foreign_analysis_is_not_found(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    world: dict[str, int],
    queued: list[tuple[int, int, str]],
) -> None:
    owner = await _member(make_client, make_user, login)
    created = (await owner.client.post("/api/analyses", json={"input_kind": "form"})).json()
    other = await _member(make_client, make_user, login, ip="10.0.0.5")
    base = f"/api/analyses/{created['id']}"
    requests: list[tuple[str, str, Any]] = [
        ("GET", base, None),
        ("GET", f"{base}/events", None),
        ("POST", f"{base}/preview", {}),
        ("POST", f"{base}/run", {"events": [_event(world, "sinner", "rune")]}),
        ("POST", f"{base}/cancel", None),
        ("PUT", f"{base}/decision", {"decision": "skip"}),
    ]
    for method, url, body in requests:
        response = await other.client.request(method, url, json=body)
        assert response.status_code == 404, (method, url)
        assert error_code(response) == "analysis.not_found"
    assert queued == []


async def test_progress_event_schema_in_openapi(client: httpx2.AsyncClient) -> None:
    schema = (await client.get("/api/openapi.json")).json()
    events = schema["paths"]["/api/analyses/{analysis_id}/events"]["get"]["responses"]["200"]
    assert "text/event-stream" in events["content"]
    assert "ProgressEventOut" in schema["components"]["schemas"]


# Инструменты каждого шага (белый список): разбор и анализ — без инструментов
TOOL_WHITELIST = {
    "parse": [],
    "news": [("web_search_20260209", "web_search"), (None, "record_news")],
    "analysis": [],
}


async def test_every_step_uses_only_whitelisted_tools(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
    queued: list[tuple[int, int, str]],
) -> None:
    member = await _member(make_client, make_user, login)
    created = (await member.client.post("/api/analyses", json={"text": TEXT})).json()
    draft = created["draft"]["events"]
    events = [
        {
            "player1_id": event["player1"]["player"]["id"],
            "player2_id": event["player2"]["player"]["id"],
            "surface": event["surface"],
            "round": event["round"] or "",
            "odds": event["odds"],
            "bookmaker": event["bookmaker"],
        }
        for event in draft
    ]
    response = await member.client.post(
        f"/api/analyses/{created['id']}/run", json={"events": events}
    )
    assert response.status_code == 202, response.text
    assert await run(engine, redis, created["id"]) == "done"
    steps = {step_of(body) for body in fake.requests}
    assert steps == {"parse", "news", "analysis"}
    for body in fake.requests:
        tools = [(tool.get("type"), tool["name"]) for tool in body.get("tools") or []]
        assert tools == TOOL_WHITELIST[step_of(body)]
        assert "tool_choice" not in body
