"""Анализ и деньги при настройках по умолчанию (Р13: потолок $1 на анализ): параллельные
вызовы Opus не останавливают анализ из-за своих же вызовов в полете, последний вызов
урезает max_tokens до остатка потолка, запуск оставляет место на новости и вызов Opus,
порог 100% наступает, когда остатка не хватает на вызов, перезапуск резервирует только
то, что воркер действительно сделает."""

import asyncio
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    AiLimit,
    Analysis,
    AppSettings,
    Dossier,
    MatchAssessment,
    Notification,
    Player,
    User,
)
from app.schemas.analyses import ConfirmIn
from app.services import analyses as analyses_service
from app.services.sessions import utcnow
from tests.analysis_helpers import (
    _no_queue,
    event_in,
    install,
    install_gated,
    run,
    seed_world,
    set_admin_key,
)
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.support import UserFactory

PAIRS = [
    ("sinner", "rune"),
    ("djokovic", "rublev"),
    ("alcaraz", "medvedev"),
    ("sinner", "djokovic"),
    ("rune", "rublev"),
]


class Realistic(FakeClaude):
    """Расход, как в оценке настроек (estimate_*): новости — 37 тыс. входа, 1,5 тыс.
    выхода, все разрешенные поиски (~$0,11); оценка матча — 7 тыс. входа и 4 тыс. выхода
    (~$0,11). Выход не больше max_tokens запроса, как у настоящего API (иначе stop
    max_tokens)."""

    def _news(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._news(body, model, error)
        uses = int(body["tools"][0]["max_uses"])
        msg["usage"]["input_tokens"] = 37000
        msg["usage"]["output_tokens"] = 1500
        msg["usage"]["server_tool_use"] = {"web_search_requests": uses, "web_fetch_requests": 0}
        return msg

    def _analysis(self, body: dict[str, Any], model: str, error: str | None) -> dict[str, Any]:
        msg = super()._analysis(body, model, error)
        limit = int(body["max_tokens"])
        msg["usage"]["input_tokens"] = 7000
        msg["usage"]["output_tokens"] = min(4000, limit)
        if limit < 4000:
            msg["stop_reason"] = "max_tokens"
        return msg


class FailSecondNews(Realistic):
    """Второй запрос новостей — 401 (ключ отклонен): анализ останавливается посреди
    новостей, первый запрос уже потратил свои поиски."""

    news_calls = 0

    def _take(self, step: str) -> str | None:
        if step == "news":
            with self.lock:
                self.news_calls += 1
                number = self.news_calls
            if number == 2:
                return "key_rejected"
        return super()._take(step)


class FailThirdAssessment(FakeClaude):
    """Третий вызов оценки матча — 529 (сбой на последнем матче)."""

    assessed = 0

    def _take(self, step: str) -> str | None:
        if step == "analysis":
            with self.lock:
                self.assessed += 1
                number = self.assessed
            if number == 3:
                return "overloaded"
        return super()._take(step)


def _slow_opus(seconds: float = 0.3) -> Any:
    """Ответ Opus идет не мгновенно: параллельные вызовы в полете одновременно."""

    async def gate(step: str, body: dict[str, Any], number: int) -> None:
        if step == "analysis":
            await asyncio.sleep(seconds)

    return gate


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


@contextmanager
def _claude(fake: FakeClaude, gate: Any = None) -> Iterator[FakeClaude]:
    """Все вызовы Claude теста — в fake (через ворота gate, если они есть)."""
    yield from (install(fake) if gate is None else install_gated(fake, gate))


async def _launch(
    db: AsyncSession, redis: Redis, user: User, world: dict[str, int], pairs: list[tuple[str, str]]
) -> tuple[int, Any]:
    analysis = await analyses_service.create_form(db, user)
    body = ConfirmIn(
        events=[event_in(world, a, b) for a, b in pairs], bank=Decimal("10000"), bookmaker="Fonbet"
    )
    preview = await analyses_service.preview(db, user, analysis.id, body)
    started = await analyses_service.start_run(
        db, redis, user, analysis.id, body, enqueue=_no_queue
    )
    return started.id, preview


async def _analysis(db: AsyncSession, analysis_id: int) -> Analysis:
    return await db.get_one(Analysis, analysis_id, populate_existing=True)


async def _agent_config(db: AsyncSession, **values: Any) -> None:
    await db.execute(update(AppSettings).values(agent_config=values))
    await db.commit()


async def _spend(db: AsyncSession, user_id: int, cost: str) -> None:
    db.add(
        AgentRun(
            user_id=user_id,
            key_source="admin",
            kind="analysis",
            model="claude-opus-5-5",
            cost_usd=Decimal(cost),
        )
    )
    await db.commit()


# --- потолок анализа и параллельные вызовы ---


async def test_five_matches_fit_default_cap(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Пять событий при потолке $1: худший случай вызова Opus — около $0,35, три таких в
    полете дороже потолка. Раньше третий параллельный вызов останавливал анализ с
    ai.analysis_cap, когда потрачено $0,19; теперь он ждет конца своих вызовов."""
    fake = FakeClaude()
    with _claude(fake, _slow_opus()):
        member = await make_user()
        analysis_id, preview = await _launch(db, redis, member.user, world, PAIRS)
        assert preview.access.allowed
        status = await run(engine, redis, analysis_id)
    analysis = await _analysis(db, analysis_id)
    assert status == "done", (analysis.error_code, analysis.cost_usd)
    assert analysis.cost_cap_usd == Decimal("1.00") and analysis.cost_usd <= Decimal("1.00")
    assert len(fake.calls("analysis")) == 5
    # Весь max_tokens у каждого вызова: места хватало, вызовы только ждали
    assert {body["max_tokens"] for body in fake.calls("analysis")} == {16000}


async def test_last_calls_cut_max_tokens_to_fit_cap(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Пять событий с расходом как в оценке ($0,96 из $1: новости — только у трех матчей,
    на остальные не хватает лимита 6 поисков на анализ): после трех оценок расход плюс
    худший случай следующего вызова ($0,35) больше потолка, хотя сам вызов стоит $0,11.
    Последние вызовы идут с max_tokens, урезанным до остатка (не меньше 6 тыс.), и анализ
    доходит до конца, не превышая потолок. Раньше он падал с ai.analysis_cap, а
    перезапуск упирался в то же."""
    fake = Realistic()
    with _claude(fake, _slow_opus()):
        member = await make_user()
        analysis_id, preview = await _launch(db, redis, member.user, world, PAIRS)
        # 5 × $0,115 за оценки и 3 × $0,1275 за новости: новости остальных двух матчей
        # не входят в оценку — им не хватит лимита поисков (иначе 5 × $0,2425 = $1,21 не
        # пускало бы анализ при потолке $1)
        assert preview.access.allowed and preview.estimate.cost_usd == Decimal("0.9575")
        status = await run(engine, redis, analysis_id)
    analysis = await _analysis(db, analysis_id)
    assert status == "done", (analysis.error_code, analysis.cost_usd)
    assert analysis.cost_usd <= Decimal("1.00")
    limits = [int(body["max_tokens"]) for body in fake.calls("analysis")]
    assert len(limits) == 5
    assert min(limits) >= 6000 and min(limits) < 16000


async def test_launch_leaves_room_for_news_and_opus(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Лимит $1, потрачено $0,62: «Перед запуском» разрешает анализ одного матча. Раньше
    он платил за новости ($0,0775) и останавливался на Opus (остаток $0,30 меньше худшего
    случая $0,34) — деньги без итога. Теперь вызов Opus идет с max_tokens по остатку."""
    fake = Realistic()
    with _claude(fake):
        member = await make_user()
        db.add(
            AiLimit(
                user_id=member.id,
                monthly_usd=Decimal("1.00"),
                daily_analyses=10,
                per_analysis_usd=Decimal("1.00"),
            )
        )
        await db.commit()
        await _spend(db, member.id, "0.62")
        analysis_id, preview = await _launch(db, redis, member.user, world, PAIRS[:1])
        # Оценка: анализ $0,115 и новости матча $0,1275 (37 тыс. входа, 2 поиска)
        assert preview.access.allowed and preview.estimate.cost_usd == Decimal("0.2425")
        status = await run(engine, redis, analysis_id)
    analysis = await _analysis(db, analysis_id)
    assert status == "done", (analysis.error_code, analysis.failed_step)
    spent = await db.scalar(
        select(func.sum(AgentRun.cost_usd)).where(AgentRun.user_id == member.id)
    )
    assert spent is not None and spent <= Decimal("1.00")


async def test_refused_launch_sends_limit_100(
    db: AsyncSession, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Остатка лимита ($0,10) не хватает на вызов Opus: запуск — 409 ai.monthly_limit, и
    участник с администратором получают «лимит исчерпан». Раньше уведомление
    приходило только при расходе 100%, которого проверки не допускают."""
    admin = await make_user(role="admin")
    member = await make_user()
    member_id = member.id
    db.add(
        AiLimit(
            user_id=member_id,
            monthly_usd=Decimal("1.00"),
            daily_analyses=10,
            per_analysis_usd=Decimal("1.00"),
        )
    )
    await db.commit()
    await _spend(db, member_id, "0.90")
    with pytest.raises(AppError) as refused:
        await _launch(db, redis, member.user, world, PAIRS[:1])
    assert refused.value.code == "ai.monthly_limit"
    notes = set(
        await db.execute(
            select(Notification.user_id, Notification.kind).execution_options(
                populate_existing=True
            )
        )
    )
    assert notes == {(member_id, "limit_100"), (admin.id, "limit_100")}


# --- новости в оценке: лимит поисков анализа ---


@pytest.mark.parametrize(
    ("per_analysis", "requests", "players"),
    [(6, 3, 6), (5, 3, 6), (2, 1, 2), (0, 0, 0)],
)
async def test_estimate_news_within_search_limit(
    db: AsyncSession,
    make_user: UserFactory,
    world: Any,
    per_analysis: int,
    requests: int,
    players: int,
) -> None:
    """Пять матчей с устаревшими новостями, max_uses 2: в оценку входит столько запросов
    новостей, сколько успеет воркер до лимита поисков анализа (каждый — 2 поиска,
    последний — остаток: при лимите 5 — запросы 2, 2, 1), по порядку матчей. Игроки
    новостей в оценке — только из этих матчей. Оценка матча — $0,115, новостей — $0,1275."""
    await _agent_config(db, news_max_searches_per_analysis=per_analysis)
    member = await make_user()
    analysis = await analyses_service.create_form(db, member.user)
    body = ConfirmIn(
        events=[event_in(world, a, b) for a, b in PAIRS], bank=Decimal("10000"), bookmaker="Fonbet"
    )
    preview = await analyses_service.preview(db, member.user, analysis.id, body)
    expected = 5 * Decimal("0.115") + requests * Decimal("0.1275")
    assert preview.estimate.cost_usd == expected
    assert preview.estimate.news_players == players


async def test_restart_estimate_counts_searches_already_used(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Лимит 4 поиска на анализ (по 2 на матч), ключ отклонен на новостях второго из трех
    матчей: 2 поиска уже потрачены. Перезапуск оценивает один запрос новостей — на
    оставшиеся 2 поиска, как и сделает воркер (у третьего матча — news_limit), а не два:
    лишние $0,1275 в резерве могли бы упереться в потолок анализа."""
    await _agent_config(db, news_max_searches_per_analysis=4)
    fake = FailSecondNews()
    with _claude(fake):
        member = await make_user()
        member_id = member.id
        analysis_id, preview = await _launch(db, redis, member.user, world, PAIRS[:3])
        # Первый запуск: три оценки и новости двух матчей (4 поиска)
        assert preview.estimate.cost_usd == Decimal("0.6")
        assert await run(engine, redis, analysis_id) == "failed"
        failed = await _analysis(db, analysis_id)
        assert failed.error_code == "ai.key_rejected"
        used = await db.scalar(
            select(func.sum(AgentRun.web_searches)).where(AgentRun.analysis_id == analysis_id)
        )
        assert used == 2
        again = await analyses_service.start_run(
            db, redis, await db.get_one(User, member_id), analysis_id, None, enqueue=_no_queue
        )
        # Три оценки ($0,345) и новости одного матча ($0,1275)
        assert again.estimate_usd == Decimal("0.4725")
        assert await run(engine, redis, analysis_id) == "done"
    # Запросы новостей: удачный, отклоненный и один после перезапуска
    assert len(fake.calls("news")) == 3
    done = await _analysis(db, analysis_id)
    news = {
        step["match_id"]: step["state"]
        for step in done.checkpoint["steps"]
        if step.get("kind") == "news"
    }
    assert sorted(news.values()) == ["done", "done", "skipped"]


# --- перезапуск ---


async def test_restart_next_day_reserves_only_remaining_call(
    db: AsyncSession, engine: AsyncEngine, redis: Redis, make_user: UserFactory, world: Any
) -> None:
    """Сбой на последнем матче вечером, «Продолжить» утром: досье, оценки и проверка
    новостей уже вчерашние, но воркер их не повторит (чекпойнт). Оценка перезапуска —
    один вызов Opus ($0,115), а не новости трех матчей и три оценки ($0,5925): иначе
    резерв занимал лимит зря, а перезапуск упирался в потолок навсегда."""
    fake = FailThirdAssessment()
    with _claude(fake):
        member = await make_user()
        member_id = member.id
        analysis_id, _ = await _launch(db, redis, member.user, world, PAIRS[:3])
        assert await run(engine, redis, analysis_id) == "failed"
        failed = await _analysis(db, analysis_id)
        assert failed.error_code == "ai.overloaded"
        assert len(failed.checkpoint["matches"]) == 3
        yesterday = timedelta(days=1)
        await db.execute(update(Dossier).values(as_of=Dossier.as_of - yesterday))
        await db.execute(
            update(MatchAssessment).values(created_at=MatchAssessment.created_at - yesterday)
        )
        await db.execute(update(Player).values(news_checked_at=utcnow() - yesterday))
        await db.commit()
        news_before = len(fake.calls("news"))
        again = await analyses_service.start_run(
            db, redis, await db.get_one(User, member_id), analysis_id, None, enqueue=_no_queue
        )
        assert again.estimate_usd == Decimal("0.1150")
        assert again.budget_reserved_usd == (failed.cost_usd + Decimal("0.115")).quantize(
            Decimal("0.01"), rounding="ROUND_UP"
        )
        assert await run(engine, redis, analysis_id) == "done"
    # Ни новостей, ни повторных оценок: один новый вызов Opus
    assert len(fake.calls("news")) == news_before
    assert len(fake.calls("analysis")) == 4
