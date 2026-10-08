import httpx2
import pytest
from fastapi import FastAPI
from pydantic import BaseModel

from app.core.errors import AppError
from app.core.i18n import has_key, t
from tests.support import BASE_URL


class Payload(BaseModel):
    email: str
    password: str


@pytest.fixture
def error_app(app: FastAPI) -> FastAPI:
    @app.post("/api/test/validate")
    async def validate(payload: Payload) -> dict[str, str]:
        return {"email": payload.email}

    @app.get("/api/test/app-error")
    async def app_error() -> None:
        raise AppError(429, "auth.rate_limited", retry_after=900)

    @app.get("/api/test/crash")
    async def crash() -> None:
        raise RuntimeError("boom with secret sk-ant-abc")

    return app


async def test_app_error_format(error_app: FastAPI, client: httpx2.AsyncClient) -> None:
    response = await client.get("/api/test/app-error")
    assert response.status_code == 429
    assert response.headers["retry-after"] == "900"
    assert response.json() == {
        "error": {
            "code": "auth.rate_limited",
            "message": t("errors.auth.rate_limited"),
            "retry_after": 900,
        }
    }


async def test_validation_error_format_hides_values(
    error_app: FastAPI, client: httpx2.AsyncClient
) -> None:
    response = await client.post("/api/test/validate", json={"password": "hunter2-secret"})
    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "validation"
    assert error["message"] == t("errors.common.validation")
    assert error["fields"] == [{"loc": ["body", "email"], "code": "missing"}]
    assert "hunter2-secret" not in response.text


async def test_not_found_and_method_not_allowed(client: httpx2.AsyncClient) -> None:
    missing = await client.get("/api/nowhere")
    assert missing.status_code == 404
    assert missing.json()["error"]["code"] == "common.not_found"
    assert missing.json()["error"]["message"] == t("errors.common.not_found")
    wrong = await client.delete("/api/health")
    assert wrong.status_code == 405
    assert wrong.json()["error"]["code"] == "common.method_not_allowed"


async def test_unhandled_error_is_500_without_details(error_app: FastAPI) -> None:
    transport = httpx2.ASGITransport(app=error_app, raise_app_exceptions=False)
    async with httpx2.AsyncClient(transport=transport, base_url=BASE_URL) as plain:
        response = await plain.get("/api/test/crash")
    assert response.status_code == 500
    assert response.json()["error"]["code"] == "common.internal"
    assert "boom" not in response.text
    # Ответ 500 идет мимо SecurityHeadersMiddleware, но заголовки те же
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["x-frame-options"] == "DENY"


def test_i18n_lookup_and_params() -> None:
    assert t("errors.auth.password_too_short", min_length=12).endswith("12 символов")
    assert t("errors.auth.password_too_short").count("{min_length}") == 1
    assert t("no.such.key") == "no.such.key"
    assert t("errors.common.forbidden", lang="en") == t("errors.common.forbidden")
    assert has_key("errors.common.forbidden")
    assert not has_key("errors.common")


@pytest.mark.parametrize(
    "key",
    [
        "errors.common.forbidden",
        "errors.common.not_found",
        "errors.common.ai_limit_reached",
        "errors.common.csrf",
        "errors.common.validation",
        "errors.auth.not_authenticated",
        "errors.auth.invalid_credentials",
        "errors.auth.rate_limited",
        "errors.auth.blocked",
        "errors.auth.invalid_code",
        "errors.auth.invite_invalid",
        "errors.auth.password_too_short",
        "errors.auth.password_too_long",
        "errors.auth.password_pwned",
        "errors.auth.reset_invalid",
        "errors.admin.totp_required",
        "errors.admin.cannot_block_self",
        "errors.admin.last_admin",
        "errors.admin.reset_2fa_terminal_only",
        "errors.admin.confirm_email_mismatch",
        "errors.admin.email_taken",
        "notifications.login_failures.title",
        "notifications.login_failures.body",
        "notifications.new_device.title",
        "notifications.new_device.body",
    ],
)
def test_locale_has_contract_keys(key: str) -> None:
    assert has_key(key), key


def test_locale_has_all_audit_actions() -> None:
    from app.db.models import AUDIT_ACTIONS

    for action in AUDIT_ACTIONS:
        assert has_key(f"audit.{action}"), action
