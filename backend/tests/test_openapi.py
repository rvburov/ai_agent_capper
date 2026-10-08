import json
import subprocess
import sys
from pathlib import Path

import httpx2
import pytest

import app.main
from app.main import create_app
from tests.support import BASE_URL, SettingsOverride

BACKEND_DIR = Path(__file__).resolve().parent.parent


def test_openapi_export_prints_schema() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "app.openapi_export"],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        check=True,
        timeout=60,
    )
    schema = json.loads(result.stdout)
    assert schema["info"]["title"] == "AI Capper API"
    assert "/api/health" in schema["paths"]
    assert "ErrorOut" in schema["components"]["schemas"]
    health = schema["paths"]["/api/health"]["get"]["responses"]
    assert health["4XX"]["content"]["application/json"]["schema"]["$ref"].endswith("/ErrorOut")


async def test_docs_only_outside_prod(
    override_settings: SettingsOverride, monkeypatch: pytest.MonkeyPatch
) -> None:
    # В prod Swagger UI не открыть (CSP Caddy), поэтому страницы и схемы там нет.
    # Логирование не перенастраиваем: иначе следующие тесты писали бы логи как в prod
    monkeypatch.setattr(app.main, "setup_logging", lambda **_: None)
    for env, expected in (("test", 200), ("prod", 404)):
        override_settings(env=env)
        transport = httpx2.ASGITransport(app=create_app())
        async with httpx2.AsyncClient(transport=transport, base_url=BASE_URL) as plain:
            assert (await plain.get("/api/docs")).status_code == expected
            assert (await plain.get("/api/openapi.json")).status_code == expected
