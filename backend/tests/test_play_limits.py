"""Ответственная игра (В8): лимиты ставок в день и пауза — GET/PUT /api/me/play-limits,
POST /api/me/pause; проверка в POST /api/bets (под блокировкой денег участника) и при
запуске и перезапуске анализа на любом ключе. Время подменяется (play_limits.utcnow)."""

import asyncio
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.errors import AppError
from app.db.models import AgentRun, Analysis, Bet, PlayLimit, User
from app.services import analyses as analyses_service
from app.services import play_limits
from tests.analysis_helpers import (
    _no_queue,
    install,
    make_analysis,
    run,
    seed_world,
    set_admin_key,
)
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
HELSINKI = "Europe/Helsinki"
# Экспресс анализа — из двух событий
PAIRS = (
    (("sinner", "rune"), ("djokovic", "rublev")),
    (("djokovic", "rublev"), ("alcaraz", "medvedev")),
)


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[datetime]]:
    """Подменяемое «сейчас» сервиса лимитов: clock[0] = момент."""
    moment = [datetime.now(UTC)]
    monkeypatch.setattr(play_limits, "utcnow", lambda: moment[0])
    yield moment


async def _put(signed: Signed, bets: int | None, stake: str | None) -> dict[str, Any]:
    response = await signed.client.put(
        "/api/me/play-limits", json={"bets_per_day": bets, "stake_per_day": stake}
    )
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_defaults(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> None:
    member = await signed_in(make_client, make_user, login, tz=HELSINKI)
    body = (await member.client.get("/api/me/play-limits")).json()
    assert body["bets_per_day"] is None and body["stake_per_day"] is None
    assert body["pending"] is None and body["paused_until"] is None
    assert body["blocked"] is None and body["blocked_until"] is None
    assert body["today"]["bets"] == 0 and body["today"]["stake"] == "0"
    assert body["pause_days"] == [1, 7, 30, 90] and body["bets_per_day_max"] == 20
    assert body["currency"] == "RUB" and body["tz"] == HELSINKI


async def test_stricter_now_looser_after_24h(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    clock: list[datetime],
) -> None:
    member = await signed_in(make_client, make_user, login)
    start = clock[0]
    # Новый лимит строже «без лимита» — сразу
    body = await _put(member, 5, "3000")
    assert (body["bets_per_day"], body["stake_per_day"], body["pending"]) == (5, "3000.00", None)
    # Ниже — сразу, выше — через 24 часа; оба лимита ждут вместе
    body = await _put(member, 3, "5000")
    assert body["bets_per_day"] == 3 and body["stake_per_day"] == "3000.00"
    pending = body["pending"]
    assert pending["bets_per_day"] == 3 and pending["stake_per_day"] == "5000.00"
    assert datetime.fromisoformat(pending["starts_at"]) == start + timedelta(hours=24)
    # Тот же запрос через час срок не сдвигает, другой — начинает 24 часа заново
    clock[0] = start + timedelta(hours=1)
    assert (await _put(member, 3, "5000"))["pending"]["starts_at"] == pending["starts_at"]
    clock[0] = start + timedelta(hours=2)
    moved = (await _put(member, 3, "6000"))["pending"]
    assert datetime.fromisoformat(moved["starts_at"]) == start + timedelta(hours=26)
    # За минуту до срока — еще прежний лимит
    clock[0] = start + timedelta(hours=26) - timedelta(minutes=1)
    body = (await member.client.get("/api/me/play-limits")).json()
    assert body["stake_per_day"] == "3000.00" and body["pending"] is not None
    # Срок прошел — повышение действует и записано в строку
    clock[0] = start + timedelta(hours=26)
    body = (await member.client.get("/api/me/play-limits")).json()
    assert body["stake_per_day"] == "6000.00" and body["pending"] is None
    row = await db.get_one(PlayLimit, member.id, populate_existing=True)
    assert row.stake_per_day == D("6000.00") and row.pending_from is None
    assert row.currency == "RUB"


async def test_remove_limit_waits_and_cancel_request(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    clock: list[datetime],
) -> None:
    member = await signed_in(make_client, make_user, login)
    await _put(member, 4, None)
    # Снять лимит — тоже мягче: через 24 часа
    body = await _put(member, None, None)
    assert body["bets_per_day"] == 4
    assert body["pending"]["bets_per_day"] is None
    # Запрос без смягчений отменяет ждущее повышение
    body = await _put(member, 4, None)
    assert body["pending"] is None and body["bets_per_day"] == 4
    clock[0] += timedelta(days=2)
    assert (await member.client.get("/api/me/play-limits")).json()["bets_per_day"] == 4


@pytest.mark.parametrize(
    "body",
    [
        {"bets_per_day": 0, "stake_per_day": None},
        {"bets_per_day": 21, "stake_per_day": None},
        {"bets_per_day": None, "stake_per_day": "0"},
        {"bets_per_day": None, "stake_per_day": "-5"},
        {"bets_per_day": None, "stake_per_day": "10.001"},
        {"bets_per_day": 3},
    ],
)
async def test_limits_validation(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, body: dict[str, Any]
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.put("/api/me/play-limits", json=body)
    assert response.status_code == 422


async def test_pause_until_local_midnight_and_only_longer(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    clock: list[datetime],
) -> None:
    member = await signed_in(make_client, make_user, login, tz=HELSINKI)
    # 00:30 по Хельсинки 14 октября (21:30 UTC 13-го): «сегодня» — 14-е
    clock[0] = datetime(2026, 10, 13, 21, 30, tzinfo=UTC)
    response = await member.client.post("/api/me/pause", json={"days": 1})
    assert response.status_code == 200, response.text
    body = response.json()
    # Пауза до 15 октября включительно: до полуночи 16-го по Хельсинки (UTC+3)
    assert datetime.fromisoformat(body["paused_until"]) == datetime(2026, 10, 15, 21, 0, tzinfo=UTC)
    assert body["blocked"] == "paused"
    longer = (await member.client.post("/api/me/pause", json={"days": 7})).json()
    assert datetime.fromisoformat(longer["paused_until"]) == datetime(
        2026, 10, 21, 21, 0, tzinfo=UTC
    )
    shorter = await member.client.post("/api/me/pause", json={"days": 1})
    assert shorter.status_code == 409 and error_code(shorter) == "play.pause_shorter"
    wrong = await member.client.post("/api/me/pause", json={"days": 3})
    assert wrong.status_code == 422
    # После конца паузы — ничего не блокирует
    clock[0] = datetime(2026, 10, 21, 21, 0, tzinfo=UTC)
    after = (await member.client.get("/api/me/play-limits")).json()
    assert after["paused_until"] is None and after["blocked"] is None


async def _limits(db: AsyncSession, user_id: int, **values: Any) -> None:
    row = PlayLimit(user_id=user_id, **values)
    if values.get("stake_per_day") is not None:
        row.currency = "RUB"
    db.add(row)
    await db.commit()


async def _check(db: AsyncSession, user: User, stake: str | None, now: datetime) -> str | None:
    try:
        await play_limits.check(db, user, stake=D(stake) if stake else None, now=now)
    except AppError as exc:
        assert exc.status_code == 409
        return exc.code
    return None


async def test_day_limits_boundaries_in_member_zone(
    make_user: UserFactory, db: AsyncSession
) -> None:
    made = await make_user(tz=HELSINKI)
    user = await db.get_one(User, made.id)
    now = datetime(2026, 10, 14, 9, 0, tzinfo=UTC)  # 12:00 по Хельсинки
    maker = BetMaker(db)
    # Вчера по Хельсинки (23:30 13-го местного = 20:30 UTC) — не считается
    await maker.bet(
        made, [LegSpec()], stake="900", placed_at=datetime(2026, 10, 13, 20, 30, tzinfo=UTC)
    )
    # Сегодня (00:30 местного = 21:30 UTC 13-го) — считается, и рассчитанная тоже
    today = await maker.bet(
        made, [LegSpec()], stake="400", placed_at=datetime(2026, 10, 13, 21, 30, tzinfo=UTC)
    )
    today.status = "lost"
    # Ставка старого бота не считается
    await maker.bet(
        made, [LegSpec()], stake="500", placed_at=now - timedelta(hours=1), source="legacy"
    )
    await _limits(db, made.id, bets_per_day=3, stake_per_day=D("1000"))
    usage = await play_limits.today_usage(db, user, now)
    assert (usage.bets, usage.stake) == (1, D("400.00"))
    # Сумма: ровно до лимита — можно, на копейку больше — нет
    assert await _check(db, user, "600", now) is None
    assert await _check(db, user, "600.01", now) == "play.stake_limit"
    assert await _check(db, user, None, now) is None
    await maker.bet(made, [LegSpec()], stake="600", placed_at=now)
    # Сумма дня исчерпана: анализ тоже нельзя, хотя число ставок еще позволяет
    assert await _check(db, user, None, now) == "play.stake_limit"
    row = await db.get_one(PlayLimit, user.id, populate_existing=True)
    row.stake_per_day = None
    row.bets_per_day = 2
    await db.commit()
    # Число ставок: 2 из 2 — новая ставка и анализ недоступны до полуночи по Хельсинки
    try:
        await play_limits.check(db, user, stake=D(1), now=now)
    except AppError as exc:
        assert exc.code == "play.bets_limit"
        assert exc.params["until"] == "2026-10-14T21:00:00+00:00"
        assert exc.params["until_text"] == "15.10.2026 00:00"
        assert exc.params["limit"] == "2"
    else:
        raise AssertionError("ожидался play.bets_limit")
    # Следующий день по Хельсинки — снова можно
    assert await _check(db, user, "1", datetime(2026, 10, 14, 21, 0, tzinfo=UTC)) is None


# --- ставка и анализ на настоящих маршрутах ---


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _done(
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    member: Signed,
    world: dict[str, int],
    *pairs: tuple[str, str],
) -> dict[str, Any]:
    analysis_id = await make_analysis(db, redis, member.user.user, world, *pairs)
    assert await run(engine, redis, analysis_id) == "done"
    data: dict[str, Any] = (await member.client.get(f"/api/analyses/{analysis_id}")).json()
    return data


def _bet(analysis: dict[str, Any], ref: str, stake: str = "250") -> dict[str, Any]:
    return {
        "analysis_id": analysis["id"],
        "stake": stake,
        "bookmaker": "Pari",
        "legs": [
            {"prediction_id": leg["prediction_id"], "odds_taken": leg["odds"]}
            for leg in analysis["result"]["express"]["legs"]
        ],
        "client_ref": ref,
    }


async def test_bet_and_analysis_blocked_by_pause(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login, role="admin")
    analysis = await _done(db, engine, redis, member, world, *PAIRS[0])
    assert (await member.client.post("/api/me/pause", json={"days": 1})).status_code == 200
    # Администратор тоже ограничен своей паузой
    refused = await member.client.post("/api/bets", json=_bet(analysis, "ref-pause-1"))
    assert refused.status_code == 409 and error_code(refused) == "play.paused"
    assert refused.json()["error"]["until"]
    assert await db.scalar(select(Bet.id).limit(1)) is None
    draft = (await member.client.post("/api/analyses", json={"input_kind": "form"})).json()
    user = await db.get_one(User, member.id)
    with pytest.raises(AppError) as caught:
        await analyses_service.start_run(db, redis, user, draft["id"], None, enqueue=_no_queue)
    assert caught.value.code == "play.paused"
    # Остановленный анализ: «Перезапустить» недоступно по той же причине
    row = await db.get_one(Analysis, analysis["id"])
    row.status = "failed"
    await db.commit()
    view = (await member.client.get(f"/api/analyses/{analysis['id']}")).json()
    assert view["restart"]["allowed"] is False
    assert view["restart"]["reason_code"] == "play.paused"


async def test_bets_limit_race_lets_only_one_bet(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login)
    first = await _done(db, engine, redis, member, world, *PAIRS[0])
    second = await _done(db, engine, redis, member, world, *PAIRS[1])
    await _put(member, 1, None)
    responses = await asyncio.gather(
        member.client.post("/api/bets", json=_bet(first, "ref-race-1")),
        member.client.post("/api/bets", json=_bet(second, "ref-race-2")),
    )
    codes = sorted(response.status_code for response in responses)
    assert codes == [201, 409]
    refused = next(response for response in responses if response.status_code == 409)
    assert error_code(refused) == "play.bets_limit"
    assert len(list(await db.scalars(select(Bet.id)))) == 1
    # Повтор той же ставки (client_ref) — не новая ставка: ответ тот же, без отказа
    placed = next(response for response in responses if response.status_code == 201).json()
    body = _bet(first if placed["analysis_id"] == first["id"] else second, placed["client_ref"])
    again = await member.client.post("/api/bets", json=body)
    assert again.status_code == 201 and again.json()["id"] == placed["id"]
    # Лимит дня достигнут: и новый анализ не запускается
    user = await db.get_one(User, member.id)
    with pytest.raises(AppError) as caught:
        await make_analysis(db, redis, user, world, *PAIRS[0])
    assert caught.value.code == "play.bets_limit"
    # Букмекер новой ставки попал в «Мои букмекеры»
    assert "Pari" in (await member.client.get("/api/me/bookmakers")).json()


async def test_stake_limit_on_bet(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    engine: AsyncEngine,
    redis: Redis,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    member = await signed_in(make_client, make_user, login)
    analysis = await _done(db, engine, redis, member, world, *PAIRS[0])
    await _put(member, None, "200")
    over = await member.client.post("/api/bets", json=_bet(analysis, "ref-stake-1", "200.01"))
    assert over.status_code == 409 and error_code(over) == "play.stake_limit"
    assert over.json()["error"]["left"] == "200.00"
    exact = await member.client.post("/api/bets", json=_bet(analysis, "ref-stake-2", "200"))
    assert exact.status_code == 201, exact.text


TEXT = """Текущий банк: 48 000 ₽
Букмекер: Fonbet

Синнер vs Руне, Шанхай, хард
Кэфы: П1 = 1.30, П2 = 3.60"""


async def test_text_parse_blocked_by_pause(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
) -> None:
    """Разбор текста — тоже вызов Claude: на паузе он не идет ни на каком ключе."""
    member = await signed_in(make_client, make_user, login)
    assert (await member.client.post("/api/me/pause", json={"days": 7})).status_code == 200
    refused = await member.client.post("/api/analyses", json={"text": TEXT})
    assert refused.status_code == 409 and error_code(refused) == "play.paused"
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 0
    assert await db.scalar(select(func.count()).select_from(Analysis)) == 0
    # Пустой черновик формы Claude не зовет: его можно создать и на паузе
    draft = await member.client.post("/api/analyses", json={"input_kind": "form"})
    assert draft.status_code == 201, draft.text


NOON = datetime(2026, 10, 14, 12, 0, tzinfo=UTC)


async def _state(signed: Signed) -> dict[str, Any]:
    data: dict[str, Any] = (await signed.client.get("/api/me/play-limits")).json()
    return data


async def test_tz_change_does_not_reset_day(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    clock: list[datetime],
) -> None:
    """Смена пояса не обнуляет счетчики: сутки досчитываются по прежнему поясу до конца,
    повторная смена их не сдвигает, после конца сутки идут по новому поясу."""
    clock[0] = NOON
    member = await signed_in(make_client, make_user, login, tz="UTC")
    member_id = member.id
    await _put(member, 1, "500")
    await BetMaker(db).bet(
        member.user, [LegSpec()], stake="500", placed_at=NOON - timedelta(hours=2)
    )
    assert (await _state(member))["blocked"] == "bets_limit"
    # На Камчатке (UTC+12) сейчас 00:00 следующего дня
    changed = await member.client.patch("/api/me", json={"tz": "Asia/Kamchatka"})
    assert changed.status_code == 200 and changed.json()["tz"] == "Asia/Kamchatka"
    body = await _state(member)
    assert body["tz"] == "UTC" and body["blocked"] == "bets_limit"
    assert (body["today"]["bets"], body["today"]["stake"]) == (1, "500.00")
    assert body["today"]["starts_at"] == "2026-10-14T00:00:00Z"
    # Сутки Камчатки с 12:00 UTC ставок не содержат: блок — до конца суток по UTC
    assert body["blocked_until"] == "2026-10-15T00:00:00Z"
    user = await db.get_one(User, member_id, populate_existing=True)
    with pytest.raises(AppError) as caught:
        await play_limits.check(db, user, stake=D("500"))
    assert caught.value.code == "play.bets_limit"
    await db.rollback()
    # Туда и обратно: прежние сутки остаются прежними
    for tz in ("America/Los_Angeles", "Pacific/Kiritimati"):
        assert (await member.client.patch("/api/me", json={"tz": tz})).status_code == 200
    row = await db.get_one(PlayLimit, member_id, populate_existing=True)
    assert (row.day_tz, row.day_tz_until) == ("UTC", datetime(2026, 10, 15, tzinfo=UTC))
    # Сутки по UTC кончились: дальше — по новому поясу (Киритимати, UTC+14), ставок в
    # его сутках (с 10:00 UTC 14 октября) — одна, в 10:00: лимит держит до их конца
    clock[0] = datetime(2026, 10, 15, 0, 30, tzinfo=UTC)
    body = await _state(member)
    assert body["tz"] == "Pacific/Kiritimati" and body["today"]["bets"] == 1
    assert body["blocked_until"] == "2026-10-15T10:00:00Z"
    clock[0] = datetime(2026, 10, 15, 10, 0, tzinfo=UTC)
    body = await _state(member)
    assert body["blocked"] is None and body["today"]["bets"] == 0


async def test_tz_change_west_keeps_overlap(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    clock: list[datetime],
) -> None:
    """На запад: новые сутки (Нью-Йорк, с 04:00 UTC) начались раньше конца прежних и
    содержат ставку — «до какого времени» — конец суток Нью-Йорка, а не полночь UTC."""
    clock[0] = NOON
    member = await signed_in(make_client, make_user, login, tz="UTC")
    await _put(member, 1, None)
    await BetMaker(db).bet(
        member.user, [LegSpec()], stake="100", placed_at=NOON - timedelta(hours=1)
    )
    assert (
        await member.client.patch("/api/me", json={"tz": "America/New_York"})
    ).status_code == 200
    body = await _state(member)
    assert body["tz"] == "UTC" and body["blocked"] == "bets_limit"
    assert body["blocked_until"] == "2026-10-15T04:00:00Z"
    clock[0] = datetime(2026, 10, 15, 1, 0, tzinfo=UTC)
    body = await _state(member)
    assert body["tz"] == "America/New_York" and body["blocked"] == "bets_limit"
    assert body["blocked_until"] == "2026-10-15T04:00:00Z"


async def test_tz_change_without_limits_creates_nothing(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login, tz="UTC")
    assert (await member.client.patch("/api/me", json={"tz": "Asia/Tokyo"})).status_code == 200
    assert await db.scalar(select(func.count()).select_from(PlayLimit)) == 0
    assert (await _state(member))["tz"] == "Asia/Tokyo"
