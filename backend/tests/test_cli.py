"""Команды терминала: python -m app.admin.cli <команда>.

main(argv) запускает свой цикл событий (asyncio.run), поэтому из асинхронного теста
она вызывается в отдельном потоке. stdin и getpass подменяются.
"""

import asyncio
import getpass
import io
import re
import subprocess
import sys
from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi import FastAPI
from sqlalchemy import delete, func, select
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import cli
from app.core.config import get_settings
from app.core.security import crypto
from app.core.security.passwords import verify_password
from app.core.security.tokens import gen_recovery_codes, hash_code
from app.db.models import AccessCode, AppSettings, RecoveryCode, User, UserSession
from app.services import admin_key, admin_users
from tests.helpers_admin import audit_entries
from tests.support import ClientFactory, LoginFn, SettingsOverride, UserFactory

BACKEND_DIR = Path(__file__).resolve().parent.parent
PASSWORD = "terminal-pass-1234"
KEY = "sk-ant-api03-" + "A1b2C3d4E5f6G7h8" * 3 + "-wxyz"
RESET_CODE = re.compile(r"RST-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}")


@pytest.fixture
def stdin(monkeypatch: pytest.MonkeyPatch) -> Callable[[str], None]:
    def feed(text: str) -> None:
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))

    return feed


@pytest.fixture
def prompts(monkeypatch: pytest.MonkeyPatch) -> Callable[[list[str]], None]:
    """Ответы на getpass по порядку."""

    def feed(answers: list[str]) -> None:
        it: Iterator[str] = iter(answers)
        monkeypatch.setattr(getpass, "getpass", lambda prompt="": next(it))

    return feed


async def run(*argv: str) -> int:
    return await asyncio.to_thread(cli.main, list(argv))


async def _user(db: AsyncSession, email: str) -> User | None:
    return await db.scalar(
        select(User).where(User.email == email).execution_options(populate_existing=True)
    )


async def _terminal_audit(db: AsyncSession, action: str) -> None:
    [entry] = await audit_entries(db, action)
    assert entry.actor_id is None and entry.ip is None
    assert entry.details["source"] == "terminal"


# --- create-admin ---


async def test_create_admin_from_stdin(
    db: AsyncSession, stdin: Callable[[str], None], capsys: pytest.CaptureFixture[str]
) -> None:
    stdin(PASSWORD + "\n")
    assert await run("create-admin", "--email", "Owner@Example.com", "--password-stdin") == 0
    assert "owner@example.com" in capsys.readouterr().out
    user = await _user(db, "owner@example.com")
    assert user is not None
    assert user.role == "admin" and user.status == "active"
    assert user.display_name == "owner"
    assert user.totp_enabled is False
    assert verify_password(user.password_hash, PASSWORD)
    await _terminal_audit(db, "create_admin")
    [entry] = await audit_entries(db, "create_admin")
    assert entry.target_user_id == user.id
    assert PASSWORD not in str(entry.details)

    # Повторный email (в другом регистре) — ошибка с кодом 1
    stdin(PASSWORD + "\n")
    assert await run("create-admin", "--email", "OWNER@example.com", "--password-stdin") == 1
    assert "owner@example.com" in capsys.readouterr().err
    count = await db.scalar(select(func.count()).select_from(User))
    assert count == 1


async def test_create_admin_checks_email_before_password_and_hibp(
    make_user: UserFactory,
    override_settings: SettingsOverride,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Занятый email — ошибка сразу: пароль не спрашивается, HIBP (запрос по сети)
    не вызывается."""
    await make_user(role="admin", email="owner@example.com")
    override_settings(hibp_enabled=True)
    calls: list[str] = []

    def ask(prompt: str = "") -> str:
        calls.append("getpass")
        return PASSWORD

    async def hibp(password: str) -> None:
        calls.append("check_new_password")

    monkeypatch.setattr(getpass, "getpass", ask)
    monkeypatch.setattr(cli, "check_new_password", hibp)
    assert await run("create-admin", "--email", "Owner@Example.com") == 1
    err = capsys.readouterr().err
    assert "owner@example.com" in err and "уже есть" in err
    assert calls == []

    # Свободный email: пароль дважды, затем проверка пароля
    assert await run("create-admin", "--email", "second@example.com") == 0
    assert calls == ["getpass", "getpass", "check_new_password"]


async def test_create_admin_interactive_and_bad_input(
    db: AsyncSession,
    stdin: Callable[[str], None],
    prompts: Callable[[list[str]], None],
    capsys: pytest.CaptureFixture[str],
) -> None:
    prompts([PASSWORD, PASSWORD + "x"])
    assert await run("create-admin", "--email", "a@example.com") == 1
    assert "не совпадают" in capsys.readouterr().err

    stdin("short\n")
    assert await run("create-admin", "--email", "a@example.com", "--password-stdin") == 1
    assert "12" in capsys.readouterr().err

    stdin("\n")
    assert await run("create-admin", "--email", "a@example.com", "--password-stdin") == 1
    assert await run("create-admin", "--email", "not-an-email", "--password-stdin") == 1

    prompts([PASSWORD, PASSWORD])
    assert await run("create-admin", "--email", "a@example.com", "--name", "Роман") == 0
    user = await _user(db, "a@example.com")
    assert user is not None and user.display_name == "Роман"

    # Пустое имя в кабинете значит «терминал»: из пробелов берется часть email
    stdin(PASSWORD + "\n")
    args = ("--email", "b@example.com", "--name", "   ", "--password-stdin")
    assert await run("create-admin", *args) == 0
    user = await _user(db, "b@example.com")
    assert user is not None and user.display_name == "b"


# --- reset-code ---


async def test_reset_code_prints_working_code(
    db: AsyncSession,
    make_user: UserFactory,
    login: LoginFn,
    make_client: ClientFactory,
    app: FastAPI,
    capsys: pytest.CaptureFixture[str],
) -> None:
    owner = await make_user(role="admin", email="owner@example.com")
    owner_id = owner.id
    await login(await make_client(), owner)
    assert await run("reset-code", "--email", "OWNER@example.com") == 0
    match = RESET_CODE.search(capsys.readouterr().out)
    assert match is not None
    code = match.group(0)
    row = await db.scalar(select(AccessCode).execution_options(populate_existing=True))
    assert row is not None
    assert row.kind == "password_reset" and row.user_id == owner_id
    assert row.code_hash == hash_code(code) and row.created_by is None
    await _terminal_audit(db, "reset_code")

    # Вторая команда отзывает первый код
    assert await run("reset-code", "--email", "owner@example.com") == 0
    capsys.readouterr()
    rows = list(
        await db.scalars(
            select(AccessCode).order_by(AccessCode.id).execution_options(populate_existing=True)
        )
    )
    assert rows[0].revoked_at is not None and rows[1].revoked_at is None

    # Код из вывода сбрасывает пароль через маршрут входа (если он уже подключен)
    if "/api/auth/reset" in app.openapi()["paths"]:
        assert await run("reset-code", "--email", "owner@example.com") == 0
        fresh = RESET_CODE.search(capsys.readouterr().out)
        assert fresh is not None
        client = await make_client("10.0.0.9")
        response = await client.post(
            "/api/auth/reset",
            json={
                "email": "owner@example.com",
                "code": fresh.group(0),
                "new_password": "brand-new-password-42",
            },
        )
        assert response.status_code == 200, response.text
        user = await _user(db, "owner@example.com")
        assert user is not None
        assert verify_password(user.password_hash, "brand-new-password-42")

    assert await run("reset-code", "--email", "nobody@example.com") == 1
    assert "nobody@example.com" in capsys.readouterr().err


# --- reset-2fa, set-role, unblock ---


async def test_reset_2fa_for_admin(
    db: AsyncSession, make_user: UserFactory, login: LoginFn, make_client: ClientFactory
) -> None:
    owner = await make_user(role="admin", email="owner@example.com")
    owner_id = owner.id
    await login(await make_client(), owner)
    for code in gen_recovery_codes():
        db.add(RecoveryCode(user_id=owner_id, code_hash=hash_code(code)))
    await db.commit()
    assert await run("reset-2fa", "--email", "owner@example.com") == 0
    user = await _user(db, "owner@example.com")
    assert user is not None
    assert user.totp_enabled is False and user.totp_secret_enc is None
    codes = await db.scalar(select(func.count()).select_from(RecoveryCode))
    assert codes == 0
    open_sessions = await db.scalar(
        select(func.count()).select_from(UserSession).where(UserSession.revoked_at.is_(None))
    )
    assert open_sessions == 0
    await _terminal_audit(db, "reset_2fa")


async def test_set_role_and_last_admin(
    db: AsyncSession, make_user: UserFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    await make_user(email="olga@example.com")
    assert await run("set-role", "--email", "olga@example.com", "--role", "admin") == 0
    user = await _user(db, "olga@example.com")
    assert user is not None and user.role == "admin"
    await _terminal_audit(db, "role_change")

    assert await run("set-role", "--email", "olga@example.com", "--role", "admin") == 0
    assert "уже" in capsys.readouterr().out
    # Ольга — единственный администратор: понизить нельзя
    assert await run("set-role", "--email", "olga@example.com", "--role", "member") == 1
    assert "последний" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        cli.main(["set-role", "--email", "olga@example.com", "--role", "root"])


async def test_unblock(
    db: AsyncSession, make_user: UserFactory, capsys: pytest.CaptureFixture[str]
) -> None:
    await make_user(role="admin", email="owner@example.com", status="blocked")
    assert await run("unblock", "--email", "owner@example.com") == 0
    user = await _user(db, "owner@example.com")
    assert user is not None and user.status == "active" and user.blocked_at is None
    await _terminal_audit(db, "unblock")
    capsys.readouterr()
    assert await run("unblock", "--email", "owner@example.com") == 0
    assert "не заблокирован" in capsys.readouterr().out
    assert len(await audit_entries(db, "unblock")) == 1


# --- set-admin-key ---


async def test_set_admin_key_stored_encrypted(
    db: AsyncSession, stdin: Callable[[str], None], capsys: pytest.CaptureFixture[str]
) -> None:
    stdin(KEY + "\n")
    assert await run("set-admin-key", "--key-stdin", "--skip-check") == 0
    assert "wxyz" in capsys.readouterr().out
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    assert row.anthropic_key_enc is not None and row.key_version is not None
    assert KEY.encode() not in row.anthropic_key_enc
    assert row.key_last4 == "wxyz"
    assert row.key_verified_at is None
    aad = crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    assert crypto.decrypt_str(row.anthropic_key_enc, row.key_version, aad) == KEY
    await _terminal_audit(db, "key_change")
    [entry] = await audit_entries(db, "key_change")
    assert entry.details == {"last4": "wxyz", "verified": False, "source": "terminal"}
    assert KEY not in str(entry.details)


async def test_set_admin_key_check(
    db: AsyncSession,
    prompts: Callable[[list[str]], None],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    results = iter(
        [
            admin_key.KeyCheck("rejected", 401),
            admin_key.KeyCheck("unavailable"),
            admin_key.KeyCheck("ok"),
        ]
    )

    async def fake_check(key: str) -> admin_key.KeyCheck:
        assert key == KEY
        return next(results)

    monkeypatch.setattr(admin_key, "check_anthropic_key", fake_check)
    for expected in (1, 1):
        prompts([KEY])
        assert await run("set-admin-key") == expected
    err = capsys.readouterr().err
    assert "не принял" in err and "--skip-check" in err
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    assert row.anthropic_key_enc is None

    prompts([KEY])
    assert await run("set-admin-key") == 0
    row = await db.get_one(AppSettings, 1, populate_existing=True)
    assert row.key_last4 == "wxyz" and row.key_verified_at is not None

    prompts(["not-a-key"])
    assert await run("set-admin-key") == 1
    assert KEY not in capsys.readouterr().err


# --- общее ---


async def test_database_unavailable_message_has_no_secrets(
    db: AsyncSession,
    override_settings: SettingsOverride,
    capsys: pytest.CaptureFixture[str],
) -> None:
    override_settings(database_url="postgresql+asyncpg://capper:s3cr3t-pw@127.0.0.1:1/nowhere")
    assert await run("unblock", "--email", "owner@example.com") == 1
    err = capsys.readouterr().err
    assert "CAPPER_DATABASE_URL" in err
    assert "s3cr3t-pw" not in err


@pytest.mark.parametrize("broken", ["password", "database"])
async def test_database_rejects_connection(
    broken: str,
    db: AsyncSession,
    override_settings: SettingsOverride,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Неверный пароль базы и несуществующая база: понятный текст без трассировки."""
    url = make_url(get_settings().database_url)
    if broken == "password":
        url = url.set(password="wr0ng-s3cr3t-pw")
    else:
        url = url.set(database="capper_no_such_db_for_cli_test")
    override_settings(database_url=url.render_as_string(hide_password=False))
    assert await run("unblock", "--email", "owner@example.com") == 1
    err = capsys.readouterr().err
    assert "CAPPER_DATABASE_URL" in err
    assert "Traceback" not in err and "wr0ng-s3cr3t-pw" not in err


async def test_integrity_error_is_reported_without_details(
    make_user: UserFactory,
    stdin: Callable[[str], None],
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Параллельная запись тех же строк: короткий текст без значений из запроса."""
    secret = "$argon2id$v=19$secret-hash"

    async def conflict(*args: object, **kwargs: object) -> None:
        raise IntegrityError("INSERT INTO users ...", {"password_hash": secret}, Exception())

    monkeypatch.setattr(admin_users, "create_admin", conflict)
    stdin(PASSWORD + "\n")
    assert await run("create-admin", "--email", "a@example.com", "--password-stdin") == 1
    err = capsys.readouterr().err
    assert "a@example.com" in err and "уже есть" in err
    assert secret not in err and "Traceback" not in err

    monkeypatch.setattr(admin_users, "unblock_user", conflict)
    await make_user(role="admin", email="owner@example.com", status="blocked")
    assert await run("unblock", "--email", "owner@example.com") == 1
    err = capsys.readouterr().err
    assert "одновременно" in err
    assert secret not in err and "Traceback" not in err


async def test_set_admin_key_without_settings_row(
    db: AsyncSession, stdin: Callable[[str], None], capsys: pytest.CaptureFixture[str]
) -> None:
    await db.execute(delete(AppSettings))
    await db.commit()
    stdin(KEY + "\n")
    assert await run("set-admin-key", "--key-stdin", "--skip-check") == 1
    err = capsys.readouterr().err
    assert "alembic upgrade head" in err
    assert "Traceback" not in err and KEY not in err


def test_help_runs_as_module() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "app.admin.cli", "--help"],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    for command in ("create-admin", "reset-code", "reset-2fa", "set-role", "unblock"):
        assert command in result.stdout
    assert "set-admin-key" in result.stdout
