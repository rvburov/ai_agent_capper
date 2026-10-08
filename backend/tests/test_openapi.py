import json
import subprocess
import sys
from pathlib import Path

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
