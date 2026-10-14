"""Время ответа в лог (app/core/timing.py): шаблон маршрута вместо адреса с id, статус,
время до последнего байта и до заголовков; запросы мимо маршрутов и отказы CSRF тоже."""

from typing import Any

import httpx2
import pytest

from app.core import timing
from tests.helpers_admin import signed_in
from tests.support import ClientFactory, LoginFn, UserFactory


class _Recorder:
    def __init__(self) -> None:
        self.records: list[tuple[str, dict[str, Any]]] = []

    def info(self, event: str, **fields: Any) -> None:
        self.records.append((event, fields))


@pytest.fixture
def recorder(monkeypatch: pytest.MonkeyPatch) -> _Recorder:
    found = _Recorder()
    monkeypatch.setattr(timing, "log", found)
    return found


async def test_request_timing_is_logged(
    recorder: _Recorder,
    client: httpx2.AsyncClient,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    assert (await member.client.get("/api/bets/12345")).status_code == 404
    assert (await client.get("/api/health")).status_code in (200, 503)
    assert (await client.get("/api/no-such-route")).status_code == 404
    no_csrf = await make_client("10.0.0.8", csrf=False)
    assert (await no_csrf.post("/api/bets", json={})).status_code == 403
    by_route = [
        (fields["method"], fields["route"], fields["status"]) for _, fields in recorder.records
    ]
    assert ("GET", "/api/bets/{bet_id}", 404) in by_route
    assert ("GET", "/api/health", 200) in by_route or ("GET", "/api/health", 503) in by_route
    assert ("GET", None, 404) in by_route
    assert ("POST", None, 403) in by_route
    for event, fields in recorder.records:
        assert event == "http.request"
        assert set(fields) == {"method", "route", "status", "ms", "ttfb_ms"}
        assert 0 <= fields["ttfb_ms"] <= fields["ms"]
    # В лог не попадает адрес с номером ставки
    assert all("12345" not in str(fields["route"]) for _, fields in recorder.records)


async def test_background_work_is_not_in_response_time() -> None:
    """ms — до последнего байта ответа: фоновая задача маршрута (прогрев аналитики после
    расчета) идет после него, участник ее не ждет. observe получает ту же запись."""
    import asyncio

    from fastapi import BackgroundTasks, FastAPI

    app = FastAPI()
    app.add_middleware(timing.TimingMiddleware)

    async def slow() -> None:
        await asyncio.sleep(0.3)

    @app.get("/api/quick")
    async def quick(background: BackgroundTasks) -> dict[str, bool]:
        background.add_task(slow)
        return {"ok": True}

    seen: list[dict[str, Any]] = []
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://capper.test") as client:
        with timing.observe(seen.append):
            assert (await client.get("/api/quick")).status_code == 200
        assert (await client.get("/api/quick")).status_code == 200
    assert len(seen) == 1
    record = seen[0]
    assert (record["method"], record["route"], record["status"]) == ("GET", "/api/quick", 200)
    assert record["ms"] < 250
