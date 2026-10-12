"""Прогресс анализа (app/services/progress.py): Redis Streams и генератор SSE отдельно
от HTTP (ASGITransport собирает ответ целиком): снимок первым, события по порядку, конец
на done, heartbeat, продолжение с Last-Event-ID, предел длины потока."""

import asyncio
import json
from typing import Any

from redis.asyncio import Redis

from app.services import progress
from app.services.progress import (
    EMPTY_ID,
    event_stream,
    has_event,
    last_event_id,
    publish,
    read_events,
    sse_message,
    stream_key,
)

SNAPSHOT = {"type": "snapshot", "analysis_id": 7, "status": "queued"}


def _data(chunk: str) -> dict[str, Any]:
    line = next(part for part in chunk.split("\n") if part.startswith("data: "))
    data: dict[str, Any] = json.loads(line.removeprefix("data: "))
    return data


async def _collect(stream: Any, limit: int = 50) -> list[str]:
    chunks: list[str] = []
    async for chunk in stream:
        chunks.append(chunk)
        if len(chunks) >= limit:
            break
    return chunks


async def test_publish_read_and_trim(redis: Redis) -> None:
    assert await last_event_id(redis, 7) == EMPTY_ID
    first = await publish(redis, 7, {"type": "status", "status": "modelling"})
    second = await publish(redis, 7, {"type": "step", "n": 2})
    assert await last_event_id(redis, 7) == second
    events = await read_events(redis, 7, EMPTY_ID, block_ms=10)
    assert [entry_id for entry_id, _ in events] == [first, second]
    assert events[1][1] == {"type": "step", "n": 2}
    assert await read_events(redis, 7, second, block_ms=10) == []
    ttl = await redis.ttl(stream_key(7))
    assert 0 < ttl <= progress.STREAM_TTL_SECONDS
    assert await has_event(redis, 7, first) and not await has_event(redis, 7, "1-1")
    assert not await has_event(redis, 7, "garbage")


def test_sse_message_format() -> None:
    text = sse_message({"type": "done", "x": "в"}, event_id="5-1")
    assert text == 'id: 5-1\ndata: {"type": "done", "x": "в"}\n\n'
    assert sse_message({"type": "x"}, event_id=EMPTY_ID) == 'data: {"type": "x"}\n\n'


async def test_stream_starts_with_snapshot_and_ends_on_done(redis: Redis) -> None:
    start = await publish(redis, 7, {"type": "status", "status": "queued"})

    async def worker() -> None:
        await asyncio.sleep(0.05)
        await publish(redis, 7, {"type": "step", "n": 1})
        await publish(redis, 7, {"type": "done", "status": "done"})

    task = asyncio.create_task(worker())
    chunks = await _collect(
        event_stream(redis, 7, snapshot=SNAPSHOT, start_id=start, live=True, block_ms=200)
    )
    await task
    assert chunks[0] == "retry: 3000\n\n"
    assert chunks[1].startswith(f"id: {start}\n") and _data(chunks[1]) == SNAPSHOT
    assert [_data(chunk)["type"] for chunk in chunks[2:]] == ["step", "done"]


async def test_stream_of_idle_analysis_closes_after_snapshot(redis: Redis) -> None:
    chunks = await _collect(
        event_stream(redis, 7, snapshot=SNAPSHOT, start_id=EMPTY_ID, live=False)
    )
    assert len(chunks) == 2 and _data(chunks[1])["type"] == "snapshot"
    assert not chunks[1].startswith("id:")


async def test_heartbeat_and_time_limit(redis: Redis) -> None:
    ticks = iter(float(n) for n in range(1000))

    def clock() -> float:
        return next(ticks)

    chunks = await _collect(
        event_stream(
            redis,
            7,
            snapshot=SNAPSHOT,
            start_id=EMPTY_ID,
            live=True,
            heartbeat_s=2.0,
            block_ms=1,
            max_seconds=8.0,
            clock=clock,
        )
    )
    assert chunks[:2] == ["retry: 3000\n\n", sse_message(SNAPSHOT)]
    assert ": ping\n\n" in chunks[2:]
    assert len(chunks) < 10


async def test_resume_from_last_event_id(redis: Redis) -> None:
    first = await publish(redis, 7, {"type": "step", "n": 1})
    await publish(redis, 7, {"type": "step", "n": 2})
    await publish(redis, 7, {"type": "failed", "status": "failed"})
    chunks = await _collect(
        event_stream(
            redis, 7, snapshot=SNAPSHOT, start_id=first, live=True, resume_id=first, block_ms=50
        )
    )
    # Событие из Last-Event-ID есть в потоке: без снимка, со следующего события
    assert [_data(chunk)["type"] for chunk in chunks[1:]] == ["step", "failed"]
    assert _data(chunks[1])["n"] == 2
    # Неизвестный id — обычное начало со снимка
    chunks = await _collect(
        event_stream(
            redis, 7, snapshot=SNAPSHOT, start_id=first, live=True, resume_id="9-9", block_ms=50
        )
    )
    assert _data(chunks[1])["type"] == "snapshot"


async def test_reconnect_to_finished_analysis_closes(redis: Redis) -> None:
    done = await publish(redis, 8, {"type": "done", "status": "done"})
    finished = {**SNAPSHOT, "analysis_id": 8, "status": "done"}
    # Last-Event-ID еще в потоке, но анализ не в работе: новых событий не будет — снимок и
    # конец, а не heartbeat до предела потока
    chunks = await asyncio.wait_for(
        _collect(
            event_stream(redis, 8, snapshot=finished, start_id=done, live=False, resume_id=done)
        ),
        timeout=5,
    )
    assert len(chunks) == 2 and _data(chunks[1]) == finished


async def test_lost_terminal_event_closes_by_recheck(redis: Redis) -> None:
    ticks = iter(float(n) for n in range(1000))
    final = {**SNAPSHOT, "analysis_id": 9, "status": "failed"}
    checks: list[int] = []

    async def recheck() -> dict[str, Any] | None:
        checks.append(1)
        return final if len(checks) == 2 else None

    chunks = await _collect(
        event_stream(
            redis,
            9,
            snapshot=SNAPSHOT,
            start_id=EMPTY_ID,
            live=True,
            recheck=recheck,
            heartbeat_s=100.0,
            recheck_s=3.0,
            block_ms=1,
            max_seconds=100.0,
            clock=lambda: next(ticks),
        )
    )
    # Событие конца не записалось в Redis: итог берется из базы, поток закрывается
    assert len(checks) == 2
    assert _data(chunks[-1]) == final and len(chunks) == 3


async def test_stream_calls_on_close_at_end_and_on_disconnect(redis: Redis) -> None:
    """Место потока участника освобождается по концу потока и при обрыве соединения."""
    closed: list[str] = []

    async def on_close() -> None:
        closed.append("x")

    await _collect(
        event_stream(redis, 7, snapshot=SNAPSHOT, start_id=EMPTY_ID, live=False, on_close=on_close)
    )
    assert closed == ["x"]
    stream = event_stream(
        redis, 7, snapshot=SNAPSHOT, start_id=EMPTY_ID, live=True, block_ms=10, on_close=on_close
    )
    assert "retry" in await stream.__anext__()
    await stream.__anext__()  # снимок
    await stream.aclose()  # браузер закрыл страницу
    assert closed == ["x", "x"]
