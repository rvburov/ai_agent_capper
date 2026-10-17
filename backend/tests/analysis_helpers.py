"""Помощники тестов конвейера анализа: маленький теннисный мир с настоящими именами,
ключи Claude, поддельный Claude (tests/fake_claude.py) вместо транспорта SDK, запуск
анализа без воркера.

    world = await seed_world(db, engine)        # игроки, матчи, Эло
    await set_admin_key(db); await seed_prices(db)
    fake = FakeClaude(); install(fake)           # все вызовы Claude — в fake
    analysis = await make_analysis(db, user, world, ["sinner", "rune"], ["djokovic", "rublev"])
    status = await run(engine, redis, analysis.id)
"""

import json
from collections.abc import Awaitable, Callable, Iterator, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import anthropic
import httpx2
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent.client import set_http_client_for_tests
from app.core.security import crypto
from app.db.models import AppSettings, Match, Player, Tournament, User, UserSecret
from app.db.session import create_sessionmaker
from app.ml.elo import rebuild_ratings
from app.schemas.analyses import ConfirmIn, EventIn, OddsPairsIn
from app.services import analyses as analyses_service
from app.services.analysis_run import execute
from app.services.claude_key import SECRET_KIND
from tests.claude_mock import KEY, OTHER_KEY
from tests.fake_claude import FakeClaude, step_of

# Сила по убыванию: сильный всегда выигрывает (у сильных Эло заметно выше)
PLAYERS: dict[str, tuple[str, str, str]] = {
    "sinner": ("Jannik Sinner", "Янник Синнер", "ITA"),
    "alcaraz": ("Carlos Alcaraz", "Карлос Алькарас", "ESP"),
    "djokovic": ("Novak Djokovic", "Новак Джокович", "SRB"),
    "medvedev": ("Daniil Medvedev", "Даниил Медведев", "RUS"),
    "rublev": ("Andrey Rublev", "Андрей Рублев", "RUS"),
    "rune": ("Holger Rune", "Хольгер Руне", "DEN"),
}
# Кэфы матчей тестов: фаворит (игрок 1) с кэфом, при котором есть валуй
ODDS: dict[tuple[str, str], tuple[str, str]] = {
    ("sinner", "rune"): ("1.30", "3.60"),
    ("djokovic", "rublev"): ("1.45", "2.80"),
    ("alcaraz", "medvedev"): ("1.35", "3.20"),
}


def today() -> date:
    return datetime.now(UTC).date()


async def seed_world(db: AsyncSession, engine: AsyncEngine, *, rounds: int = 6) -> dict[str, int]:
    """Игроки, турниры прошлого года и круговые матчи (сильный выигрывает), Эло.
    Возвращает ключ игрока → id."""
    people = {
        key: Player(name=name, name_ru=name_ru, country=country)
        for key, (name, name_ru, country) in PLAYERS.items()
    }
    db.add_all(people.values())
    await db.flush()
    order = list(PLAYERS)
    start = today() - timedelta(days=200)
    for number in range(rounds):
        tournament = Tournament(
            name=f"Test Open {number}",
            category="500",
            surface="hard",
            best_of=3,
            start_date=start + timedelta(days=30 * number),
            source="sackmann",
            source_ref=f"test-{number}",
        )
        db.add(tournament)
        await db.flush()
        game = 0
        for i, strong in enumerate(order):
            for weak in order[i + 1 :]:
                game += 1
                assert tournament.start_date is not None
                db.add(
                    Match(
                        tournament_id=tournament.id,
                        round=f"R{game}"[:16],
                        match_date=tournament.start_date + timedelta(days=game % 6),
                        player1_id=people[strong].id,
                        player2_id=people[weak].id,
                        winner_id=people[strong].id,
                        score="6-3 6-4",
                        status="finished",
                        best_of=3,
                        source="sackmann",
                        source_ref=f"test-{number}-{game}",
                    )
                )
    await db.commit()
    await rebuild_ratings(db_factory=create_sessionmaker(engine))
    return {key: person.id for key, person in people.items()}


async def set_admin_key(db: AsyncSession, key: str = KEY) -> None:
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    row.anthropic_key_enc, row.key_version = crypto.encrypt_str(
        key, crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    )
    row.key_last4 = key[-4:]
    row.key_verified_at = datetime.now(UTC)
    await db.commit()


async def set_own_key(db: AsyncSession, user: User, key: str = OTHER_KEY) -> None:
    ciphertext, version = crypto.encrypt_str(key, crypto.aad_for(crypto.AAD_USER_SECRET, user.id))
    db.add(
        UserSecret(
            user_id=user.id,
            kind=SECRET_KIND,
            ciphertext=ciphertext,
            key_version=version,
            last4=key[-4:],
            verified_at=datetime.now(UTC),
        )
    )
    row = await db.get_one(User, user.id, populate_existing=True)
    row.ai_mode = "own"
    await db.commit()


def install(fake: FakeClaude) -> Iterator[FakeClaude]:
    """Для фикстуры: все клиенты app.agent.client идут в fake (без повторов SDK)."""
    set_http_client_for_tests(fake.http_client())
    try:
        yield fake
    finally:
        set_http_client_for_tests(None)


# Ворота запроса: шаг (parse, news, analysis), тело и номер запроса с начала теста
Gate = Callable[[str, dict[str, Any], int], Awaitable[None]]


class _GatedTransport(httpx2.AsyncBaseTransport):
    """Транспорт SDK поверх FakeClaude: перед ответом ждет ворота (задержка, событие)."""

    def __init__(self, fake: FakeClaude, gate: Gate) -> None:
        self.fake = fake
        self.gate = gate
        self.count = 0

    async def handle_async_request(self, request: httpx2.Request) -> httpx2.Response:
        raw = await request.aread()
        if request.method == "POST":
            self.count += 1
            body = json.loads(raw or b"{}")
            await self.gate(step_of(body), body, self.count)
        return self.fake.handler(request)


def install_gated(fake: FakeClaude, gate: Gate) -> Iterator[FakeClaude]:
    """Для фикстуры: как install, но каждый запрос сначала проходит gate (параллельные
    вызовы, отмена посреди вызова)."""
    set_http_client_for_tests(
        anthropic.DefaultAsyncHttpxClient(transport=_GatedTransport(fake, gate))
    )
    try:
        yield fake
    finally:
        set_http_client_for_tests(None)


def event_in(
    world: dict[str, int],
    first: str,
    second: str,
    *,
    minus: tuple[str | None, str | None] = (None, None),
    plus: tuple[str | None, str | None] = (None, None),
    surface: str = "hard",
    tournament: str | None = "Test Open 9",
) -> EventIn:
    ml = ODDS.get((first, second), ("1.50", "2.60"))
    return EventIn.model_validate(
        {
            "player1_id": world[first],
            "player2_id": world[second],
            "tournament_name": tournament,
            "surface": surface,
            "best_of": 3,
            "round": "R16",
            "odds": {
                "ML": [ml[0], ml[1]],
                "HCP_-1.5": list(minus),
                "HCP_+1.5": list(plus),
            },
            "bookmaker": "Fonbet",
        }
    )


async def _no_queue(analysis_id: int, attempt: int, job_id: str) -> None:
    return None


async def make_analysis(
    db: AsyncSession,
    redis: Redis,
    user: User,
    world: dict[str, int],
    *pairs: Sequence[str],
    bank: str | None = "10000",
    tournament: str | None = "Test Open 9",
    plus: tuple[str | None, str | None] = (None, None),
) -> int:
    """Анализ из формы, запущенный (queued) без воркера. Возвращает id. plus — кэфы на
    Ф(+1.5) игроков 1 и 2 в каждом событии."""
    analysis = await analyses_service.create_form(db, user)
    body = ConfirmIn(
        events=[
            event_in(world, pair[0], pair[1], tournament=tournament, plus=plus) for pair in pairs
        ],
        bank=Decimal(bank) if bank is not None else None,
        bookmaker="Fonbet",
    )
    started = await analyses_service.start_run(
        db, redis, user, analysis.id, body, enqueue=_no_queue
    )
    return started.id


async def run(engine: AsyncEngine, redis: Redis, analysis_id: int) -> str:
    """Выполняет анализ как воркер (без arq)."""
    return await execute(analysis_id, create_sessionmaker(engine), redis)


async def reload(db: AsyncSession, model: Any, row_id: int) -> Any:
    return await db.get_one(model, row_id, populate_existing=True)


async def user_row(db: AsyncSession, user_id: int) -> User:
    found = await db.scalar(select(User).where(User.id == user_id))
    assert found is not None
    return found


__all__ = ["KEY", "OTHER_KEY", "OddsPairsIn"]
