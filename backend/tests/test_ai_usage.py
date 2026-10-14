"""Расход на Claude по вызовам (этап 4): GET /api/ai/usage, GET /api/ai/runs и
«Администрирование → Расход ИИ» (GET /api/admin/ai/usage). Числа сверяются с эталонными
SQL (tests/reference_sql.py); права — участник видит только свои вызовы, администратор —
свои и общие задачи без участника, Р14 — у администратора только деньги и число анализов."""

from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.agent.runs import Usage, cost_usd
from app.db.models import AgentRun, AiLimit, Analysis, EvalRun, StrategyVersion
from app.services.ai_access import call_need_usd
from app.services.ai_usage import month_of
from app.services.analysis_run import ACCEPTANCE_MARK
from tests import reference_sql as ref
from tests.claude_mock import price_row
from tests.helpers_admin import Signed, admin_signed_in, error_code, signed_in
from tests.support import ClientFactory, LoginFn, UserFactory

PRICES_SINCE = datetime(2026, 1, 1, tzinfo=UTC)


@pytest.fixture
async def prices(db: AsyncSession) -> None:
    for model in ("claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"):
        db.add(price_row(model, PRICES_SINCE))
    await db.commit()


@dataclass
class RunSpec:
    kind: str = "analysis"
    model: str = "claude-opus-5-5"
    input: int = 1000
    write5: int = 0
    write1: int = 0
    read: int = 0
    output: int = 500
    searches: int = 0
    batch: bool = False
    step: int = 6
    effort: str | None = "medium"
    prompt_version: str | None = "analysis_v1"
    error: str | None = None


async def add_run(
    db: AsyncSession,
    user_id: int | None,
    at: datetime,
    spec: RunSpec | None = None,
    *,
    key_source: str = "admin",
    analysis_id: int | None = None,
    eval_run_id: int | None = None,
) -> AgentRun:
    spec = spec or RunSpec()
    usage = Usage(
        input_tokens=spec.input,
        output_tokens=spec.output,
        cache_write_tokens=spec.write5 + spec.write1,
        cache_write_5m_tokens=spec.write5,
        cache_write_1h_tokens=spec.write1,
        cache_read_tokens=spec.read,
        web_searches=spec.searches,
        batch=spec.batch,
    )
    row = AgentRun(
        user_id=user_id,
        key_source=key_source,
        analysis_id=analysis_id,
        eval_run_id=eval_run_id,
        kind=spec.kind,
        step=spec.step,
        model=spec.model,
        effort=spec.effort,
        prompt_version=spec.prompt_version,
        input_tokens=spec.input,
        cache_write_tokens=spec.write5 + spec.write1,
        cache_write_5m_tokens=spec.write5,
        cache_write_1h_tokens=spec.write1,
        cache_read_tokens=spec.read,
        output_tokens=spec.output,
        web_searches=spec.searches,
        batch=spec.batch,
        cost_usd=cost_usd(price_row(spec.model, PRICES_SINCE), usage),
        error=spec.error,
        created_at=at,
    )
    db.add(row)
    await db.commit()
    return row


async def add_analysis(
    db: AsyncSession,
    user_id: int,
    at: datetime,
    *,
    cost: str,
    status: str = "done",
    key_source: str = "admin",
    acceptance: bool = False,
) -> int:
    row = Analysis(
        user_id=user_id,
        input_text="Синнер — Руне",
        status=status,
        key_source=key_source,
        started_at=at,
        cost_usd=Decimal(cost),
        checkpoint={ACCEPTANCE_MARK: 1} if acceptance else {},
    )
    db.add(row)
    await db.commit()
    return row.id


def month_start() -> datetime:
    now = datetime.now(UTC)
    return now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)


def moments() -> list[datetime]:
    """Моменты текущего месяца не позже сейчас: начало месяца и сейчас (в начале дня 1-го
    числа — один день)."""
    start, now = month_start(), datetime.now(UTC)
    return [start + timedelta(minutes=1), max(start + timedelta(minutes=2), now - timedelta(1))]


NEWS = RunSpec(
    kind="news",
    model="claude-sonnet-5-5",
    input=300,
    write5=30000,
    read=4000,
    output=1000,
    searches=2,
    step=3,
    effort="low",
    prompt_version="news_v2",
)
PARSE = RunSpec(
    kind="parse",
    model="claude-haiku-5-5",
    input=2000,
    output=300,
    step=1,
    effort="low",
    prompt_version="parse_input_v1",
)
OPUS = RunSpec(input=2600, write5=3900, read=7800, output=4000)


async def member_world(
    db: AsyncSession, member: Signed, other: Signed, admin: Signed
) -> dict[str, Any]:
    first, second = moments()
    analysis_id = await add_analysis(db, member.id, first, cost="0.21")
    await add_analysis(db, member.id, second, cost="0.05", status="failed")
    await add_run(db, member.id, first, PARSE, analysis_id=analysis_id)
    await add_run(db, member.id, first, NEWS, analysis_id=analysis_id)
    await add_run(db, member.id, second, OPUS, analysis_id=analysis_id)
    await add_run(db, member.id, second, RunSpec(error="ai.timeout", output=0))
    await add_run(db, member.id, second, PARSE, key_source="own")
    # Чужое, общие задачи и проверки участнику не видны
    await add_run(db, other.id, first, OPUS)
    await add_run(db, None, first, NEWS)
    await add_run(db, admin.id, first, RunSpec(kind="eval", batch=True))
    # Прошлый месяц
    await add_run(db, member.id, month_start() - timedelta(days=3), OPUS)
    return {"analysis_id": analysis_id}


async def test_usage_requires_login_and_valid_month(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    assert (await (await make_client()).get("/api/ai/usage")).status_code == 401
    assert (await (await make_client()).get("/api/ai/runs")).status_code == 401
    member = await signed_in(make_client, make_user, login)
    for bad in ("2026-13", "2026-1", "x"):
        response = await member.client.get(f"/api/ai/usage?month={bad}")
        assert response.status_code == 422
    future = datetime.now(UTC).replace(day=1) + timedelta(days=40)
    response = await member.client.get(f"/api/ai/usage?month={future:%Y-%m}")
    assert response.status_code == 422 and error_code(response) == "ai.usage_month"
    response = await member.client.get("/api/ai/usage?month=2025-12")
    assert response.status_code == 422 and error_code(response) == "ai.usage_month"
    # Год 0000 проходит шаблон месяца, но такой даты нет: 422, а не 500
    admin = await admin_signed_in(make_client, make_user, login)
    for client, url in (
        (member.client, "/api/ai/usage"),
        (member.client, "/api/ai/runs"),
        (admin.client, "/api/admin/ai/usage"),
    ):
        for month in ("0000-01", "0001-12", "9999-12"):
            response = await client.get(f"{url}?month={month}")
            assert response.status_code == 422, (url, month)
            assert error_code(response) == "ai.usage_month"


async def test_member_usage_matches_reference_sql(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    admin = await admin_signed_in(make_client, make_user, login)
    world = await member_world(db, member, other, admin)
    body = (await member.client.get("/api/ai/usage")).json()
    span = month_of(None, datetime.now(UTC))

    by_day = await ref.ai_by_day(db, member.id, span.start, span.end)
    by_kind = await ref.ai_by_kind(db, member.id, span.start, span.end)
    total = sum(by_day.values(), Decimal(0))
    assert Decimal(str(body["totals"]["cost_usd"])) == total
    assert body["totals"]["runs"] == 5 and body["totals"]["errors"] == 1
    assert len(body["days"]) == span.days_elapsed == body["days_elapsed"]
    assert {
        item["day"]: Decimal(str(item["cost_usd"])) for item in body["days"] if item["runs"]
    } == {day.isoformat(): cost for day, cost in by_day.items()}
    assert sum(Decimal(str(item["cost_usd"])) for item in body["days"]) == total
    assert {
        item["kind"]: (item["runs"], Decimal(str(item["cost_usd"]))) for item in body["kinds"]
    } == by_kind
    share = await ref.ai_cache_share(db, member.id, span.start, span.end)
    assert body["totals"]["cache_share"] == pytest.approx(share, abs=1e-9)
    news = next(item for item in body["kinds"] if item["kind"] == "news")
    assert news["cache_share"] == pytest.approx(4000 / 34300, abs=1e-9)
    assert (news["models"], news["efforts"], news["avg_prompt_tokens"]) == (
        ["claude-sonnet-5-5"],
        ["low"],
        34300,
    )
    analysis = next(item for item in body["kinds"] if item["kind"] == "analysis")
    # Средняя цена вызова — по вызовам без ошибки
    assert analysis["runs"] == 2 and analysis["errors"] == 1
    assert Decimal(str(analysis["avg_cost_usd"])) == cost_usd(
        price_row("claude-opus-5-5"),
        Usage(
            input_tokens=2600,
            cache_write_5m_tokens=3900,
            cache_write_tokens=3900,
            cache_read_tokens=7800,
            output_tokens=4000,
        ),
    )
    assert {(item["kind"], item["step"]) for item in body["steps"]} == {
        ("parse", 1),
        ("news", 3),
        ("analysis", 6),
    }
    assert {item["prompt_version"] for item in body["versions"]} == {
        "parse_input_v1",
        "news_v2",
        "analysis_v1",
    }
    assert Decimal(str(body["own_key_usd"])) > 0
    assert Decimal(str(body["admin_key_usd"])) + Decimal(str(body["own_key_usd"])) == total
    assert (body["shared_usd"], body["acceptance_usd"]) == (0, 0)
    # Поиски по $0,01 и экономия кэша: чтение по цене входа минус цена чтения
    assert body["search_usd"] == 0.02
    assert Decimal(str(body["cache_saved_usd"])) == Decimal(
        str(round(4000 * (2 - 0.1) / 1e6 + 7800 * (4 - 0.2) / 1e6, 6))
    )
    assert body["analyses"][0]["id"] == world["analysis_id"]
    assert body["avg_analysis_usd"] == 0.21
    assert body["current"] is True and body["month"] == span.key
    assert {price["model"] for price in body["prices"]} == {
        "claude-opus-5-5",
        "claude-sonnet-5-5",
        "claude-haiku-5-5",
    }
    settings = body["settings"]
    assert (settings["analysis_model"], settings["news_searches_per_match"]) == (
        "claude-opus-5-5",
        2,
    )
    assert "atptour.com" in settings["news_domains"]
    # Лимит по умолчанию $10, анализ $0,21: прогноз не выше лимита, остатка хватит на N
    assert 0 < body["forecast_usd"] <= 10
    assert isinstance(body["analyses_left"], int) and body["analyses_left"] > 0


async def test_left_analyses_by_admin_key_average_as_budget(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """В начале месяца участник был на своем ключе (анализы по $1,00), потом вернулся на
    ключ администратора (по $0,20). «Хватит на N» считается по средней на ключе
    администратора — той же, что в GET /ai/budget, а не по смешанной $0,60."""
    member = await signed_in(make_client, make_user, login)
    first, second = moments()
    for at, key, cost in (
        (first, "own", "1.00"),
        (first, "own", "1.00"),
        (second, "admin", "0.20"),
        (second, "admin", "0.20"),
    ):
        analysis_id = await add_analysis(db, member.id, at, cost=cost, key_source=key)
        await add_run(db, member.id, at, key_source=key, analysis_id=analysis_id)
    usage = (await member.client.get("/api/ai/usage")).json()
    budget = (await member.client.get("/api/ai/budget")).json()
    assert budget["key_source"] == "admin"
    assert usage["avg_analysis_usd"] == 0.6
    assert usage["admin_key_avg_usd"] == budget["avg_analysis_usd"] == 0.2
    assert [item["key_source"] for item in usage["analyses"]] == ["own", "own", "admin", "admin"]
    left = Decimal(str(budget["left_usd"]))
    assert left > 0
    assert usage["analyses_left"] == int(left // Decimal("0.2"))


async def test_admin_usage_has_shared_and_acceptance_apart(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    first, _ = moments()
    accepted = await add_analysis(db, admin.id, first, cost="0.20", acceptance=True)
    await add_run(db, admin.id, first, OPUS)
    await add_run(db, admin.id, first, OPUS, analysis_id=accepted)
    await add_run(db, None, first, NEWS)
    await add_run(db, None, first, RunSpec(kind="eval", batch=True))
    await add_run(db, member.id, first, OPUS)
    body = (await admin.client.get("/api/ai/usage")).json()
    span = month_of(None, datetime.now(UTC))
    by_day = await ref.ai_by_day(db, admin.id, span.start, span.end, admin=True)
    assert Decimal(str(body["totals"]["cost_usd"])) == sum(by_day.values(), Decimal(0))
    assert body["totals"]["runs"] == 3
    own, acceptance, shared = (
        Decimal(str(body[key])) for key in ("own_usd", "acceptance_usd", "shared_usd")
    )
    assert own == acceptance and shared > 0
    assert own + acceptance + shared == Decimal(str(body["totals"]["cost_usd"]))
    assert body["analyses"][0]["acceptance"] is True
    assert body["avg_analysis_usd"] is None
    assert body["analyses_left"] is None
    share = await ref.ai_cache_share(db, admin.id, span.start, span.end, admin=True)
    assert body["totals"]["cache_share"] == pytest.approx(share, abs=1e-9)

    runs = (await admin.client.get("/api/ai/runs?kind=shared")).json()
    assert runs["total_runs"] == 2
    assert {(item["shared"], item["acceptance"]) for item in runs["items"]} == {
        (True, False),
        (False, True),
    }
    member_runs = (await member.client.get("/api/ai/runs?kind=shared")).json()
    assert member_runs["items"] == [] and member_runs["total_runs"] == 0


async def test_runs_journal_pages_and_price_parts(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    admin = await admin_signed_in(make_client, make_user, login)
    await member_world(db, member, other, admin)
    long_haiku = RunSpec(kind="parse", model="claude-haiku-5-5", input=120000, output=10, step=1)
    await add_run(db, member.id, moments()[1], long_haiku)
    first = (await member.client.get("/api/ai/runs?limit=2")).json()
    assert first["total_runs"] == 6 and len(first["items"]) == 2
    seen = [item["id"] for item in first["items"]]
    cursor = first["next_before"]
    while cursor is not None:
        page = (await member.client.get(f"/api/ai/runs?limit=2&before={cursor}")).json()
        seen += [item["id"] for item in page["items"]]
        cursor = page["next_before"]
    assert len(seen) == len(set(seen)) == 6
    times = [
        item["created_at"]
        for item in (await member.client.get("/api/ai/runs?limit=100")).json()["items"]
    ]
    assert times == sorted(times, reverse=True)

    everything = (await member.client.get("/api/ai/runs?limit=100")).json()["items"]
    for item in everything:
        price = item["price"]
        assert price is not None
        parts = sum(
            Decimal(str(price[key]["cost_usd"]))
            for key in (
                "input",
                "cache_write_5m",
                "cache_write_1h",
                "cache_read",
                "output",
                "searches",
            )
        )
        assert abs(parts - Decimal(str(item["cost_usd"]))) <= Decimal("0.000006")
        assert item["shared"] is False and item["acceptance"] is False
    haiku = next(item for item in everything if item["input_tokens"] == 120000)
    assert haiku["price"]["long_factor"] == 5
    news = next(item for item in everything if item["kind"] == "news")
    assert news["price"]["searches"] == {"tokens": 2, "price": 0.01, "cost_usd": 0.02}
    assert news["cache_share"] == pytest.approx(4000 / 34300, abs=1e-9)

    only_news = (await member.client.get("/api/ai/runs?kind=news")).json()
    assert [item["kind"] for item in only_news["items"]] == ["news"]
    foreign = (await other.client.get("/api/ai/runs")).json()["items"][0]["id"]
    response = await member.client.get(f"/api/ai/runs?before={foreign}")
    assert response.status_code == 422 and error_code(response) == "ai.bad_cursor"
    for bad in ("limit=0", "limit=201", "kind=eval", "before=0"):
        assert (await member.client.get(f"/api/ai/runs?{bad}")).status_code == 422


async def test_past_month_has_whole_month(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    admin = await admin_signed_in(make_client, make_user, login)
    await member_world(db, member, other, admin)
    previous = month_start() - timedelta(days=3)
    body = (await member.client.get(f"/api/ai/usage?month={previous:%Y-%m}")).json()
    assert body["current"] is False and body["totals"]["runs"] == 1
    assert len(body["days"]) == body["days_in_month"] == body["days_elapsed"]
    assert body["forecast_usd"] == body["totals"]["cost_usd"]
    runs = (await member.client.get(f"/api/ai/runs?month={previous:%Y-%m}")).json()
    assert runs["total_runs"] == 1


async def test_admin_usage_by_people_tasks_and_eval(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    own = await signed_in(make_client, make_user, login, ip="10.0.0.4", ai_mode="own")
    first, _ = moments()
    await add_analysis(db, member.id, first, cost="0.30")
    await add_analysis(db, own.id, first, cost="0.10", key_source="own")
    await add_run(db, member.id, first, OPUS)
    await add_run(db, member.id, first, NEWS)
    await add_run(db, own.id, first, OPUS, key_source="own")
    await add_run(db, None, first, NEWS)
    version = StrategyVersion(user_id=admin.id, code="eval-test", params={})
    db.add(version)
    await db.flush()
    eval_run = EvalRun(
        version_kind="strategy",
        strategy_version_id=version.id,
        eval_set="smoke-40",
        split="test",
        n_events=40,
        metrics={"kind": "smoke"},
    )
    db.add(eval_run)
    await db.commit()
    await add_run(db, None, first, RunSpec(kind="eval", batch=True), eval_run_id=eval_run.id)
    await add_run(db, None, first, RunSpec(kind="eval", model="claude-haiku-5-5"))

    body = (await admin.client.get("/api/admin/ai/usage")).json()
    span = month_of(None, datetime.now(UTC))
    spent = await ref.ai_key_spend(db, span.start, span.end)
    key_total = sum((cost for (_, source), cost in spent.items() if source == "admin"), Decimal(0))
    assert Decimal(str(body["spent_usd"])) == key_total
    assert Decimal(str(body["own_key_usd"])) == spent[(own.id, "own")]
    people = {item["user_id"]: item for item in body["people"]}
    assert Decimal(str(people[member.id]["key_spent_usd"])) == spent[(member.id, "admin")]
    assert people[member.id]["analyses"] == 1 and people[member.id]["limit_usd"] == 10
    assert people[member.id]["limit_share"] == pytest.approx(
        float(spent[(member.id, "admin")] / 10)
    )
    assert Decimal(str(people[own.id]["own_spent_usd"])) == spent[(own.id, "own")]
    assert people[own.id]["own_analyses"] == 1 and people[own.id]["key_spent_usd"] == 0
    assert people[admin.id]["limit_usd"] is None
    assert body["people"][0]["user_id"] == member.id
    # Доля в расходе ключа считает сервер; «остальных» нет — тратил ключ один участник
    assert people[member.id]["spent_share"] == pytest.approx(
        float(spent[(member.id, "admin")] / key_total)
    )
    assert body["shared"]["spent_share"] == pytest.approx(float(spent[(None, "admin")] / key_total))
    assert (body["others_ids"], body["others_count"], body["others_usd"]) == ([], 0, 0)
    assert Decimal(str(body["shared"]["cost_usd"])) == spent[(None, "admin")]
    assert body["shared"]["kinds"] == ["news"]
    assert {item["kind"] for item in body["tasks"]} == {"analysis", "news"}
    assert (
        sum(Decimal(str(item["cost_usd"])) for item in body["tasks"])
        + Decimal(str(body["shared"]["cost_usd"]))
        == key_total
    )
    assert body["analyses"] == 1 and body["avg_analysis_usd"] == 0.3
    evals = body["eval"]
    assert evals["runs"] == 2 and evals["budget_usd"] == 25
    named = next(item for item in evals["items"] if item["eval_run_id"] == eval_run.id)
    assert (named["name"], named["eval_set"], named["n_events"]) == ("smoke", "smoke-40", 40)
    # Р14: только деньги и число анализов — без анализов, ввода и ставок
    forbidden = {"analysis_id", "input_text", "bet_id", "stake", "bank", "player"}

    def keys(node: Any) -> set[str]:
        if isinstance(node, dict):
            return set(node) | {key for value in node.values() for key in keys(value)}
        if isinstance(node, list):
            return {key for item in node for key in keys(item)}
        return set()

    assert not keys(body) & forbidden


async def test_admin_usage_others_after_top_three(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """«Кто тратит»: при больше чем 4 тративших людях первые 3 — строками, остальные —
    одной строкой: их id по убыванию расхода, число и сумма считает сервер."""
    admin = await admin_signed_in(make_client, make_user, login)
    first, _ = moments()
    ids: list[int] = []
    for cost in ("0.60", "0.50", "0.40", "0.30", "0.20", "0.10"):
        user = await make_user()
        ids.append(user.id)
        db.add(
            AgentRun(
                user_id=user.id,
                key_source="admin",
                kind="analysis",
                model="claude-opus-5-5",
                cost_usd=Decimal(cost),
                created_at=first,
            )
        )
    await db.commit()
    body = (await admin.client.get("/api/admin/ai/usage")).json()
    assert body["others_ids"] == ids[3:]
    assert body["others_count"] == 3
    assert body["others_usd"] == pytest.approx(0.6)
    shares = {item["user_id"]: item["spent_share"] for item in body["people"]}
    assert shares[ids[0]] == pytest.approx(0.6 / 2.1)
    assert shares[admin.id] == 0


async def test_pace_under_limit_and_budget(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Темп под лимит — лимит участника (у администратора — бюджет ключа) на дни месяца;
    на своем ключе лимита нет."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    own = await signed_in(make_client, make_user, login, ip="10.0.0.4", ai_mode="own")
    mine = (await member.client.get("/api/ai/usage")).json()
    days = mine["days_in_month"]
    assert mine["pace_usd"] == float((Decimal(10) / days).quantize(Decimal("0.01")))
    boss = (await admin.client.get("/api/ai/usage")).json()
    assert boss["pace_usd"] == float((Decimal(60) / days).quantize(Decimal("0.01")))
    assert (await own.client.get("/api/ai/usage")).json()["pace_usd"] is None


async def test_no_analyses_left_when_rest_below_call(
    prices: None,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Остатка лимита меньше самого маленького вызова оценки: по средней цене «хватило
    бы» на несколько анализов, но ни один не запустится — analyses_left = 0."""
    member = await signed_in(make_client, make_user, login)
    first, second = moments()
    for at in (first, second):
        analysis_id = await add_analysis(db, member.id, at, cost="0.01")
        await add_run(db, member.id, at, RunSpec(input=10, output=10), analysis_id=analysis_id)
    need = await call_need_usd(db, await load_agent_config(db), datetime.now(UTC))
    assert need > Decimal("0.03")
    spent = Decimal(str((await member.client.get("/api/ai/budget")).json()["spent_usd"]))
    db.add(
        AiLimit(
            user_id=member.id,
            monthly_usd=spent + Decimal("0.03"),
            daily_analyses=3,
            per_analysis_usd=Decimal("0.03"),
        )
    )
    await db.commit()
    usage = (await member.client.get("/api/ai/usage")).json()
    assert usage["admin_key_avg_usd"] == 0.01
    assert usage["analyses_left"] == 0
