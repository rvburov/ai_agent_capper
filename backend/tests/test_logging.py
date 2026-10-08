import io
import json
import logging
from dataclasses import dataclass

import structlog
from pydantic import BaseModel

from app.core.logging import (
    REDACTED,
    build_formatter,
    drop_color_message,
    is_sensitive_field,
    redact_secrets,
    setup_logging,
)


def test_sensitive_fields_are_redacted() -> None:
    event = {
        "event": "login",
        "password": "hunter2",
        "new_password": "hunter3",
        "totp_code": "123456",
        "recovery_code": "abcd-efgh",
        "session_token": "tok",
        "api_key": "sk-ant-api03-xyz",
        "Authorization": "Bearer abc.def",
        "cookie": "capper_session=abc",
        "status_code": 401,
        "key_version": 2,
        "user_id": 7,
        "nested": {"secret": "s", "ok": "fine", "list": [{"token": "t"}]},
        "note": "ключ sk-ant-api03-SECRET в тексте и Bearer abc.def",
        "url": "postgresql+asyncpg://capper:pa55@localhost/capper",
    }
    out = redact_secrets(None, "info", event)
    for key in ("password", "new_password", "totp_code", "recovery_code", "session_token"):
        assert out[key] == REDACTED
    assert out["api_key"] == REDACTED
    assert out["Authorization"] == REDACTED
    assert out["cookie"] == REDACTED
    assert out["status_code"] == 401
    assert out["key_version"] == 2
    assert out["user_id"] == 7
    assert out["nested"]["secret"] == REDACTED
    assert out["nested"]["ok"] == "fine"
    assert out["nested"]["list"][0]["token"] == REDACTED
    assert "SECRET" not in out["note"]
    assert "abc.def" not in out["note"]
    assert "pa55" not in out["url"]


def test_log_output_has_no_secrets() -> None:
    setup_logging(json_logs=False)
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.setFormatter(build_formatter(json_logs=True))
    root = logging.getLogger()
    root.addHandler(handler)
    previous_level = root.level
    root.setLevel(logging.INFO)
    try:
        log = structlog.get_logger("tests.logging")
        log.info("user.login", email_hash="abc", password="hunter2-plain", code="654321")
        try:
            raise ValueError("bad key sk-ant-api03-LEAK")
        except ValueError:
            log.exception("crash")
        logging.getLogger("tests.stdlib").warning("stdlib token=%s", "sk-ant-api03-STD")
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)
    output = buffer.getvalue()
    assert "hunter2-plain" not in output
    assert "654321" not in output
    assert "LEAK" not in output
    assert "STD" not in output
    first = json.loads(output.splitlines()[0])
    assert first["event"] == "user.login"
    assert first["password"] == REDACTED


class _LoginBody(BaseModel):
    email: str
    password: str


@dataclass
class _Issued:
    token: str
    session: int


class _Opaque:
    def __repr__(self) -> str:
        return "Opaque(key=sk-ant-api03-OPAQUE)"

    __str__ = __repr__


def test_camel_case_fields_are_redacted() -> None:
    for name in ("newPassword", "sessionToken", "totpSecret", "accessToken", "apiKey", "APIKey"):
        assert is_sensitive_field(name), name
    for name in ("statusCode", "keyVersion", "totpEnabled", "userId"):
        assert not is_sensitive_field(name), name


def test_models_dataclasses_and_objects_are_scrubbed() -> None:
    event = {
        "event": "auth.login_attempt",
        "body": _LoginBody(email="a@b.c", password="PLAIN-PASSWORD-1"),
        "new": _Issued(token="SESSION-TOKEN-XYZ", session=1),
        "items": [{"newPassword": "CAMEL-PASS-2"}, _Opaque()],
        "tags": {"x"},
    }
    out = redact_secrets(None, "info", event)
    rendered = json.dumps(out, ensure_ascii=False, default=repr)
    for leaked in ("PLAIN-PASSWORD-1", "SESSION-TOKEN-XYZ", "CAMEL-PASS-2", "OPAQUE"):
        assert leaked not in rendered, leaked
    assert out["body"]["email"] == "a@b.c"
    assert out["new"]["session"] == 1
    assert out["tags"] == ["x"]


def test_uvicorn_color_message_is_dropped() -> None:
    event = {"event": "Started server process [1]", "color_message": "\x1b[36m%d\x1b[0m"}
    assert "color_message" not in drop_color_message(None, "info", event)


def test_sql_parameters_in_db_errors_are_hidden() -> None:
    """Текст ошибки SQLAlchemy: параметры запроса (хеш пароля, email) в лог не попадают.
    Движок прячет их сам (hide_parameters), фильтр логов — вторая линия защиты."""
    from sqlalchemy.exc import DBAPIError

    from app.db.session import create_engine

    argon = "$argon2id$v=19$m=65536,t=3,p=4$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo"
    error = DBAPIError(
        "UPDATE users SET password_hash=$1 WHERE users.id = $2",
        (argon, 7),
        Exception("timeout"),
    )
    event = {"event": "request.failed", "exception": str(error), "note": f"hash {argon} x"}
    rendered = json.dumps(redact_secrets(None, "error", event), ensure_ascii=False)
    assert "argon2id$v=19" not in rendered
    assert "UPDATE users SET password_hash" in rendered
    assert f"[parameters: {REDACTED}]" in rendered
    assert create_engine("postgresql+asyncpg://u:p@localhost/db").sync_engine.hide_parameters
