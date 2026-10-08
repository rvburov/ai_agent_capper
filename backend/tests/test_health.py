import httpx2
import pytest

from app.services import health as health_service
from tests.support import ClientFactory


async def test_health_ok(client: httpx2.AsyncClient) -> None:
    response = await client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["db"] == "ok"
    assert body["redis"] == "ok"
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_health_degraded_without_details(
    client: httpx2.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def broken(*args: object) -> bool:
        return False

    monkeypatch.setattr(health_service, "check_redis", broken)
    response = await client.get("/api/health")
    assert response.status_code == 503
    assert response.json() == {
        "status": "degraded",
        "version": response.json()["version"],
        "db": "ok",
        "redis": "fail",
    }


async def test_health_without_csrf_for_any_method(make_client: ClientFactory) -> None:
    # Проверка здоровья не требует CSRF-токена даже для POST (метода нет — 405, но не 403)
    plain = await make_client(csrf=False)
    response = await plain.post("/api/health")
    assert response.status_code == 405
    assert response.json()["error"]["code"] == "common.method_not_allowed"
