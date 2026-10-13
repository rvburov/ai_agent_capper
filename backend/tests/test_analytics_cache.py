"""Кэш аналитики в Redis (решение Т15): ответ из кэша до изменения данных, новый ключ после
расчета, сторно, закрытия и движения банка; прогрев задачей воркера; очистка при удалении
участника; сбой Redis не мешает ответу."""

import asyncio
import json
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import redis_key
from app.schemas.analytics import AnalyticsFiltersIn, AnalyticsOut
from app.services import analytics, analytics_cache, dashboard
from app.workers import jobs
from tests.helpers_admin import Signed, admin_signed_in, signed_in
from tests.helpers_bets import BetMaker, LegSpec, get_bet, reverse, settle
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory

Compute = Callable[..., Awaitable[Any]]


@pytest.fixture
async def member(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> Signed:
    signed = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    for odds in ("1.80", "2.10"):
        bet = await maker.bet(signed.user, [LegSpec(odds=odds)])
        await settle(signed.client, bet.id, "win")
    await maker.bet(signed.user, [LegSpec(odds="1.50")])
    return signed


def _counting(monkeypatch: pytest.MonkeyPatch, module: Any, name: str) -> list[int]:
    """Считать вызовы расчета без кэша."""
    calls: list[int] = []
    original: Compute = getattr(module, name)

    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        return await original(*args, **kwargs)

    monkeypatch.setattr(module, name, wrapper)
    return calls


async def _keys(redis: Redis, user_id: int) -> list[str]:
    return [str(key) async for key in redis.scan_iter(match=redis_key("analytics", user_id, "*"))]


async def test_cached_until_data_changes(
    member: Signed, monkeypatch: pytest.MonkeyPatch, redis: Redis, db: AsyncSession
) -> None:
    calls = _counting(monkeypatch, analytics, "compute_analytics")
    first = (await member.client.get("/api/analytics")).json()
    second = (await member.client.get("/api/analytics")).json()
    assert first == second and len(calls) == 1
    # Другие фильтры — свой ключ
    await member.client.get("/api/analytics", params={"period": "7d"})
    assert len(calls) == 2
    # Расчет открытой ставки меняет версию данных
    open_bet = (await member.client.get("/api/bets", params={"status": "open"})).json()
    await settle(member.client, open_bet["items"][0]["id"], "loss")
    third = (await member.client.get("/api/analytics")).json()
    assert len(calls) == 3 and third["kpi"]["settled"] == first["kpi"]["settled"] + 1
    # Сторно, закрывающий кэф и движение банка — тоже
    await reverse(member.client, open_bet["items"][0]["id"])
    await member.client.get("/api/analytics")
    assert len(calls) == 4
    card = await get_bet(member.client, open_bet["items"][0]["id"])
    leg = card["legs"][0]["id"]
    response = await member.client.put(
        f"/api/bets/{card['id']}/legs/{leg}/closing",
        json={"closing": {"odds": "1.45", "by": "pinnacle"}},
    )
    assert response.status_code == 200
    await member.client.get("/api/analytics")
    assert len(calls) == 5
    journal = (await member.client.get("/api/me/bank/entries")).json()
    response = await member.client.post(
        "/api/me/bank/entries",
        json={"kind": "deposit", "amount": "100", "expected_last_id": journal["last_id"]},
    )
    assert response.status_code == 201
    await member.client.get("/api/analytics")
    assert len(calls) == 6
    assert len(await _keys(redis, member.id)) >= 5


async def test_dashboard_core_cached(member: Signed, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _counting(monkeypatch, dashboard, "dashboard_core")
    first = (await member.client.get("/api/dashboard")).json()
    second = (await member.client.get("/api/dashboard")).json()
    assert len(calls) == 1
    # Банк и открытые ставки — каждый раз заново, а показатели — из кэша
    assert first["kpi"] == second["kpi"] and first["bank"] == second["bank"]
    await member.client.get("/api/dashboard", params={"period": "7d"})
    assert len(calls) == 2


async def test_cache_key_includes_tz_and_strategy(member: Signed, db: AsyncSession) -> None:
    user = member.user.user
    before = await analytics_cache.data_version(db, user)
    user.tz = "Asia/Tokyo"
    await db.commit()
    assert await analytics_cache.data_version(db, user) != before
    filters = AnalyticsFiltersIn()
    assert analytics_cache.cache_key(1, "analytics", filters, "v") != analytics_cache.cache_key(
        2, "analytics", filters, "v"
    )
    assert analytics_cache.cache_key(
        1, "analytics", AnalyticsFiltersIn(surface=["clay"]), "v"
    ) != analytics_cache.cache_key(1, "analytics", filters, "v")


class _BrokenRedis:
    async def get(self, key: str) -> None:
        raise RedisError("down")

    async def set(self, key: str, value: str, **kwargs: Any) -> None:
        raise RedisError("down")

    async def eval(self, *args: Any) -> None:
        raise RedisError("down")


async def test_redis_failure_does_not_break_response(member: Signed, db: AsyncSession) -> None:
    broken: Any = _BrokenRedis()
    text = await analytics.analytics_json(db, broken, member.user.user, AnalyticsFiltersIn())
    assert AnalyticsOut.model_validate_json(text).kpi.settled == 2
    core = await dashboard.cached_core_json(db, broken, member.user.user, "30d")
    assert '"settled":2' in core


async def test_warm_job_fills_cache(
    member: Signed, db: AsyncSession, redis: Redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert await _keys(redis, member.id) == []
    warmed = await jobs.warm_user_analytics(db, redis, member.id)
    assert warmed == ["analytics", "dashboard"]
    assert len(await _keys(redis, member.id)) == 2
    analytics_calls = _counting(monkeypatch, analytics, "compute_analytics")
    core_calls = _counting(monkeypatch, dashboard, "dashboard_core")
    await member.client.get("/api/analytics")
    await member.client.get("/api/dashboard")
    assert analytics_calls == [] and core_calls == []
    # Неизвестный участник — ничего
    assert await jobs.warm_user_analytics(db, redis, 10**9) == []


async def test_warm_job_recomputes_when_data_change_during_it(
    member: Signed, db: AsyncSession, redis: Redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Пока прогрев считает, участник рассчитывает следующую ставку: новая задача не
    ставится (тот же id задачи), поэтому прогрев сам видит новую версию данных и считает
    еще раз — последняя версия прогрета."""
    open_bet = (await member.client.get("/api/bets", params={"status": "open"})).json()
    original = analytics.compute_analytics
    calls: list[int] = []

    async def changing(*args: Any, **kwargs: Any) -> Any:
        calls.append(1)
        if len(calls) == 1:
            response = await settle(member.client, open_bet["items"][0]["id"], "loss")
            assert response.status_code == 200
        return await original(*args, **kwargs)

    monkeypatch.setattr(analytics, "compute_analytics", changing)
    warmed = await jobs.warm_user_analytics(db, redis, member.id)
    assert warmed == ["analytics", "dashboard"] * 2 and len(calls) == 2
    user = member.user.user
    await db.refresh(user)
    version = await analytics_cache.data_version(db, user)
    key = analytics_cache.cache_key(member.id, "analytics", AnalyticsFiltersIn(), version)
    cached = await redis.get(key)
    assert cached is not None and AnalyticsOut.model_validate_json(cached).kpi.settled == 3


async def test_single_flight(member: Signed, db: AsyncSession, redis: Redis) -> None:
    """Один ключ считается один раз: второй запрос ждет ответ первого."""
    user = member.user.user
    key = analytics_cache.cache_key(member.id, "analytics", AnalyticsFiltersIn(), "v")
    gate = asyncio.Event()
    calls: list[int] = []

    async def compute() -> AnalyticsOut:
        calls.append(1)
        await gate.wait()
        return await analytics.compute_analytics(db, user, AnalyticsFiltersIn())

    first = asyncio.create_task(
        analytics_cache.cached_json(redis, member.id, key, AnalyticsOut, compute)
    )
    second = asyncio.create_task(
        analytics_cache.cached_json(redis, member.id, key, AnalyticsOut, compute)
    )
    await asyncio.sleep(0.3)
    gate.set()
    assert await first == await second and len(calls) == 1
    assert await redis.get(f"{key}:lock") is None


async def test_compute_after_delete_not_cached(
    member: Signed, db: AsyncSession, redis: Redis
) -> None:
    """Расчет шел, когда участника удалили: ответ запросу отдан, но в Redis не записан —
    метка удаления (clear_user) не дает вернуть личные данные в кэш."""
    user = member.user.user
    key = analytics_cache.cache_key(member.id, "analytics", AnalyticsFiltersIn(), "v")
    gate = asyncio.Event()

    async def compute() -> AnalyticsOut:
        await gate.wait()
        return await analytics.compute_analytics(db, user, AnalyticsFiltersIn())

    task = asyncio.create_task(
        analytics_cache.cached_json(redis, member.id, key, AnalyticsOut, compute)
    )
    await asyncio.sleep(0.1)
    await analytics_cache.clear_user(redis, member.id)
    gate.set()
    assert AnalyticsOut.model_validate_json(await task).kpi.settled == 2
    assert await _keys(redis, member.id) == []
    # Другой участник пишет как обычно
    other = analytics_cache.cache_key(member.id + 1, "analytics", AnalyticsFiltersIn(), "v")
    await analytics_cache.cached_json(redis, member.id + 1, other, AnalyticsOut, compute)
    assert await redis.get(other) is not None


async def test_old_shape_entry_recomputed(
    member: Signed, db: AsyncSession, redis: Redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Запись прежней формы (схема ответа поменялась, Redis пережил выкладку) — промах: она
    удаляется и считается заново, а не роняет главную и не уходит на экран."""
    user = member.user.user
    version = await analytics_cache.data_version(db, user)
    core_key = analytics_cache.cache_key(
        member.id, "dashboard", AnalyticsFiltersIn(period="30d"), version
    )
    text = await dashboard.cached_core_json(db, redis, user, "30d")
    old = json.loads(text)
    old.pop("small_sample")
    await redis.set(core_key, json.dumps(old))
    page_key = analytics_cache.cache_key(member.id, "analytics", AnalyticsFiltersIn(), version)
    await redis.set(page_key, '{"kpi": {}}')
    core_calls = _counting(monkeypatch, dashboard, "dashboard_core")
    page_calls = _counting(monkeypatch, analytics, "compute_analytics")
    response = await member.client.get("/api/dashboard")
    assert response.status_code == 200 and response.json()["small_sample"] is True
    response = await member.client.get("/api/analytics")
    assert response.status_code == 200 and response.json()["kpi"]["settled"] == 2
    assert core_calls == [1] and page_calls == [1]
    assert "small_sample" in (await redis.get(core_key) or "")


async def test_version_includes_code(
    member: Signed, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Новая выкладка (другой код расчета или схема ответа) — новые ключи: ответы прежнего
    кода не читаются."""
    user = member.user.user
    before = await analytics_cache.data_version(db, user)
    assert analytics_cache.code_version() in before
    monkeypatch.setattr(analytics_cache, "code_version", lambda: "other-build")
    assert await analytics_cache.data_version(db, user) != before


async def test_match_merge_changes_version(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Слияние матча из ввода с архивной строкой без переворота сторон: нога переходит на
    матч архива (другой турнир и покрытие) — новая версия данных и новое покрытие."""
    from datetime import date

    from sqlalchemy import select

    from app.db.models import BetLeg, Match, Tournament
    from app.services import players

    signed = await signed_in(make_client, make_user, login)
    bet = await BetMaker(db).bet(signed.user, [LegSpec(tournament=None, confirmed_surface="clay")])
    assert (await settle(signed.client, bet.id, "win")).status_code == 200
    before = (await signed.client.get("/api/analytics")).json()
    assert [item["surface"] for item in before["slices"]["surfaces"]] == ["clay"]
    user = signed.user.user
    version = await analytics_cache.data_version(db, user)
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bet.id))
    assert leg is not None
    own = await db.get(Match, leg.match_id)
    assert own is not None
    tour = Tournament(
        name="Wimbledon", surface="grass", best_of=3, category="grand_slam",
        start_date=date(2026, 6, 29), source="sackmann", source_ref="t-wim",
    )  # fmt: skip
    db.add(tour)
    await db.flush()
    archive = Match(
        tournament_id=tour.id, round="R64", player1_id=own.player1_id,
        player2_id=own.player2_id, best_of=3, source="sackmann", source_ref="m-wim",
    )  # fmt: skip
    db.add(archive)
    await db.commit()
    report = await players.merge_matches(db, source_match_id=own.id, target_match_id=archive.id)
    assert report.flipped is False
    await db.refresh(user)
    assert await analytics_cache.data_version(db, user) != version
    after = (await signed.client.get("/api/analytics")).json()
    assert [item["surface"] for item in after["slices"]["surfaces"]] == ["grass"]


async def test_request_warm_enqueues_once(member: Signed, redis: Redis) -> None:
    from app.workers.main import create_queue_pool

    await analytics_cache.request_warm(member.id)
    await analytics_cache.request_warm(member.id)
    pool = await create_queue_pool()
    try:
        jobs_queued = await pool.queued_jobs()
    finally:
        await pool.aclose()
    ids = [job.job_id for job in jobs_queued if job.function == analytics_cache.WARM_JOB]
    assert ids.count(f"{analytics_cache.WARM_JOB}:{member.id}") == 1
    queued = next(job for job in jobs_queued if job.function == analytics_cache.WARM_JOB)
    assert queued.args == (member.id,)


async def test_request_warm_survives_queue_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    import app.workers.main as worker_main

    async def broken(*args: Any, **kwargs: Any) -> Any:
        raise OSError("connection refused")

    monkeypatch.setattr(worker_main, "create_queue_pool", broken)
    await analytics_cache.request_warm(1)


async def test_routes_request_warm(
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Расчет, сторно, закрытие и движение банка ставят прогрев; повтор того же
    движения банка — нет."""
    requested: list[int] = []

    async def fake(user_id: int) -> None:
        requested.append(user_id)

    monkeypatch.setattr(analytics_cache, "request_warm", fake)
    signed = await signed_in(make_client, make_user, login)
    bet = await BetMaker(db).bet(signed.user, [LegSpec()])
    assert (await settle(signed.client, bet.id, "win")).status_code == 200
    assert (await reverse(signed.client, bet.id)).status_code == 200
    card = await get_bet(signed.client, bet.id)
    response = await signed.client.put(
        f"/api/bets/{bet.id}/legs/{card['legs'][0]['id']}/closing", json={"closing": None}
    )
    assert response.status_code == 200
    journal = (await signed.client.get("/api/me/bank/entries")).json()
    body = {"kind": "deposit", "amount": "50", "expected_last_id": journal["last_id"]}
    assert (await signed.client.post("/api/me/bank/entries", json=body)).status_code == 201
    assert (await signed.client.post("/api/me/bank/entries", json=body)).status_code == 200
    assert requested == [signed.id] * 4


async def test_cache_cleared_when_member_deleted(
    member: Signed,
    redis: Redis,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
) -> None:
    await member.client.get("/api/analytics")
    await member.client.get("/api/dashboard")
    assert len(await _keys(redis, member.id)) == 2
    admin = await admin_signed_in(make_client, make_user, login)
    response = await admin.client.request(
        "DELETE",
        f"/api/admin/users/{member.id}",
        json={"confirm_email": member.user.user.email, "totp_code": await totp_code(admin.user)},
    )
    assert response.status_code == 204, response.text
    assert await _keys(redis, member.id) == []


async def test_clear_user_only_own_keys(redis: Redis) -> None:
    for user_id in (1, 2):
        for n in range(3):
            await redis.set(redis_key("analytics", user_id, "analytics", n), "{}")
    assert await analytics_cache.clear_user(redis, 1) == 3
    assert len(await _keys(redis, 2)) == 3


async def test_version_ignores_new_analyses_but_not_replacements(
    member: Signed, db: AsyncSession
) -> None:
    """Новый прогноз анализа без ставки аналитику не меняет — кэш остается; замена прогноза
    (supersedes) меняет калибровку — новая версия."""
    from sqlalchemy import select

    from app.db.models import Prediction
    from app.services.sessions import utcnow

    user = member.user.user
    before = await analytics_cache.data_version(db, user)
    old = await db.scalar(select(Prediction).where(Prediction.user_id == member.id).limit(1))
    assert old is not None
    fields = {"user_id": member.id, "match_id": old.match_id, "market": "ML", "as_of": utcnow()}
    db.add(Prediction(**fields, selection=2, p_final=0.4))
    await db.commit()
    assert await analytics_cache.data_version(db, user) == before
    db.add(Prediction(**fields, selection=old.selection, p_final=0.7, supersedes=old.id))
    await db.commit()
    assert await analytics_cache.data_version(db, user) != before
