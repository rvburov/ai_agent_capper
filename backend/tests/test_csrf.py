import httpx2
import pytest
from fastapi import FastAPI, Response

from app.core.cookies import CSRF_HEADER, cookie_name
from tests.support import ClientFactory


@pytest.fixture
def echo_app(app: FastAPI) -> FastAPI:
    @app.post("/api/test/echo")
    async def echo() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/test/echo")
    async def echo_get() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/api/test/rotate-csrf")
    async def rotate(response: Response) -> dict[str, bool]:
        response.set_cookie(cookie_name("csrf"), "rotated-token", path="/", samesite="lax")
        return {"ok": True}

    return app


async def test_post_with_token_passes(echo_app: FastAPI, client: httpx2.AsyncClient) -> None:
    response = await client.post("/api/test/echo")
    assert response.status_code == 200


async def test_post_without_token_is_403(echo_app: FastAPI, make_client: ClientFactory) -> None:
    plain = await make_client(csrf=False)
    response = await plain.post("/api/test/echo")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "common.csrf"
    assert response.json()["error"]["message"]


async def test_header_must_match_cookie(echo_app: FastAPI, client: httpx2.AsyncClient) -> None:
    response = await client.post("/api/test/echo", headers={CSRF_HEADER: "other-token"})
    assert response.status_code == 403
    without_header = await client.post("/api/test/echo", headers={CSRF_HEADER: ""})
    assert without_header.status_code == 403


async def test_foreign_origin_is_403(echo_app: FastAPI, client: httpx2.AsyncClient) -> None:
    response = await client.post("/api/test/echo", headers={"Origin": "https://evil.example"})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "common.csrf"


async def test_missing_origin_is_allowed_with_token(
    echo_app: FastAPI, client: httpx2.AsyncClient
) -> None:
    del client.headers["Origin"]
    response = await client.post("/api/test/echo")
    assert response.status_code == 200


@pytest.mark.parametrize("method", ["PUT", "PATCH", "DELETE"])
async def test_all_unsafe_methods_checked(
    echo_app: FastAPI, make_client: ClientFactory, method: str
) -> None:
    plain = await make_client(csrf=False)
    response = await plain.request(method, "/api/test/echo")
    assert response.status_code == 403


async def test_get_does_not_need_token(echo_app: FastAPI, make_client: ClientFactory) -> None:
    plain = await make_client(csrf=False)
    response = await plain.get("/api/test/echo", headers={"Origin": "https://evil.example"})
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"


async def test_test_client_follows_new_csrf_cookie(
    echo_app: FastAPI, client: httpx2.AsyncClient
) -> None:
    # Сервер выдал новую cookie csrf: клиент тестов, как фронтенд, шлет ее в заголовке
    assert (await client.get("/api/test/rotate-csrf")).status_code == 200
    response = await client.post("/api/test/echo")
    assert response.status_code == 200
    assert response.request.headers[CSRF_HEADER] == "rotated-token"
