"""Прогресс анализа: события в Redis Streams и поток SSE для экрана «Анализ».

Воркер пишет событие (publish) после каждого шага: XADD capper:analysis:<id>:events с
MAXLEN ~200 и сроком жизни 1 час. Источник правды — analyses в базе, поэтому новое
подключение получает первым событием снимок из базы, а затем события после него.
Переподключение к анализу в работе с Last-Event-ID, который еще есть в потоке,
продолжает с этого места без снимка. Анализ не в работе — снимок и конец потока, даже с
Last-Event-ID: новых событий не будет. Поток заканчивается событием done, failed или
cancelled, а без событий раз в 15 с уходит комментарий-heartbeat: прокси и мобильные
сети не рвут тихое соединение. Раз в 30 с поток сверяется с базой (recheck): если
событие конца не записалось (сбой Redis), итог из базы приходит снимком и поток
закрывается. Чтение блокируется не дольше 2 с за раз: у общего клиента Redis тайм-аут
сокета 3 с.
"""

import json
import re
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from typing import Any, cast

from redis.asyncio import Redis

from app.core.redis import redis_key

STREAM_MAXLEN = 200
STREAM_TTL_SECONDS = 3600
READ_BLOCK_MS = 2000
READ_COUNT = 50
HEARTBEAT_SECONDS = 15.0
RECHECK_SECONDS = 30.0
RETRY_MS = 3000
# Поток живет не дольше получаса: потом браузер переподключится сам (retry)
MAX_STREAM_SECONDS = 30 * 60
TERMINAL_EVENTS = frozenset({"done", "failed", "cancelled"})
EMPTY_ID = "0-0"
_STREAM_ID = re.compile(r"^[0-9]{1,20}-[0-9]{1,20}$")


def stream_key(analysis_id: int) -> str:
    return redis_key("analysis", analysis_id, "events")


async def publish(redis: Redis, analysis_id: int, event: Mapping[str, Any]) -> str:
    """Добавляет событие в поток анализа; возвращает его id."""
    key = stream_key(analysis_id)
    data = json.dumps(event, ensure_ascii=False, default=str)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.xadd(key, {"data": data}, maxlen=STREAM_MAXLEN, approximate=True)
        pipe.expire(key, STREAM_TTL_SECONDS)
        entry_id, _ = await pipe.execute()
    return str(entry_id)


async def last_event_id(redis: Redis, analysis_id: int) -> str:
    """id последнего события потока или 0-0, если событий нет."""
    rows = await redis.xrevrange(stream_key(analysis_id), count=1)
    if not rows:
        return EMPTY_ID
    return str(rows[0][0])


def _decode(fields: Mapping[str, Any]) -> dict[str, Any]:
    try:
        data = json.loads(str(fields.get("data", "")))
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


async def read_events(
    redis: Redis, analysis_id: int, after_id: str, *, block_ms: int = READ_BLOCK_MS
) -> list[tuple[str, dict[str, Any]]]:
    """События после after_id; ждет не дольше block_ms (и не дольше 2 с)."""
    block = max(1, min(block_ms, READ_BLOCK_MS))
    found = await redis.xread({stream_key(analysis_id): after_id}, count=READ_COUNT, block=block)
    events: list[tuple[str, dict[str, Any]]] = []
    for _, entries in cast(list[tuple[str, list[tuple[str, dict[str, Any]]]]], found or []):
        for entry_id, fields in entries:
            events.append((str(entry_id), _decode(fields)))
    return events


async def has_event(redis: Redis, analysis_id: int, event_id: str) -> bool:
    """Событие с этим id еще в потоке (не вытеснено MAXLEN и не истекло)."""
    if not _STREAM_ID.match(event_id) or event_id == EMPTY_ID:
        return False
    rows = await redis.xrange(stream_key(analysis_id), min=event_id, max=event_id, count=1)
    return bool(rows)


def sse_message(event: Mapping[str, Any], *, event_id: str | None = None) -> str:
    """Одно событие SSE: id (для Last-Event-ID) и JSON в data, тип — внутри JSON."""
    lines = [f"id: {event_id}"] if event_id and event_id != EMPTY_ID else []
    lines.append("data: " + json.dumps(event, ensure_ascii=False, default=str))
    return "\n".join(lines) + "\n\n"


async def event_stream(
    redis: Redis,
    analysis_id: int,
    *,
    snapshot: Mapping[str, Any],
    start_id: str,
    live: bool,
    resume_id: str | None = None,
    recheck: Callable[[], Awaitable[Mapping[str, Any] | None]] | None = None,
    heartbeat_s: float = HEARTBEAT_SECONDS,
    recheck_s: float = RECHECK_SECONDS,
    block_ms: int = READ_BLOCK_MS,
    max_seconds: float = MAX_STREAM_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> AsyncIterator[str]:
    """Поток SSE анализа. start_id — последнее событие потока, прочитанное до снимка
    (события после него снимок не видел). live — анализ в работе: иначе снимок и конец
    потока. resume_id — Last-Event-ID переподключения. recheck — итог из базы (снимок),
    если анализ уже не в работе, иначе None."""
    yield f"retry: {RETRY_MS}\n\n"
    if not live:
        yield sse_message(snapshot, event_id=start_id)
        return
    position = start_id
    if resume_id is not None and await has_event(redis, analysis_id, resume_id):
        position = resume_id
    else:
        yield sse_message(snapshot, event_id=start_id)
    started = last_sent = last_check = clock()
    while clock() - started < max_seconds:
        events = await read_events(redis, analysis_id, position, block_ms=block_ms)
        for entry_id, event in events:
            position = entry_id
            yield sse_message(event, event_id=entry_id)
            if event.get("type") in TERMINAL_EVENTS:
                return
        now = clock()
        if events:
            last_sent = now
        elif now - last_sent >= heartbeat_s:
            yield ": ping\n\n"
            last_sent = now
        if recheck is not None and now - last_check >= recheck_s:
            last_check = now
            final = await recheck()
            if final is not None:
                yield sse_message(final)
                return
