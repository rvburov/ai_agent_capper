"""Команды администратора в терминале сервера, как createsuperuser в Django (Р6).

    docker compose exec api python -m app.admin.cli create-admin --email admin@example.com
    python -m app.admin.cli reset-code --email user@example.com
    python -m app.admin.cli reset-2fa --email admin@example.com
    python -m app.admin.cli set-role --email user@example.com --role admin
    python -m app.admin.cli unblock --email admin@example.com
    python -m app.admin.cli set-admin-key [--key-stdin] [--skip-check]

Пароль и ключ вводятся без отображения (getpass) или одной строкой из stdin
(--password-stdin, --key-stdin) — так их не видно в истории команд и в списке процессов.
Каждая команда пишет admin_audit_log с actor_id = NULL и details.source = "terminal".
Код возврата: 0 — успех, 1 — ошибка (текст в stderr), 2 — неверные аргументы (argparse).
Работает и на чистой базе после alembic upgrade head.
"""

import argparse
import asyncio
import getpass
import re
import sys
from collections.abc import Sequence
from typing import Any

from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.errors import AppError
from app.core.i18n import t
from app.core.security.passwords import check_new_password, hash_password_async
from app.db.models import User
from app.db.session import get_session
from app.services import access_codes, admin_key, admin_users

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_NAME_MAX_LENGTH = 100


class CliError(Exception):
    """Ошибка команды: текст из локали cli.*, код возврата 1."""

    def __init__(self, key: str, **params: Any) -> None:
        super().__init__(key)
        self.message = t(f"cli.{key}", **params)


def _say(text: str) -> None:
    print(text, flush=True)


def _normalize_email(raw: str) -> str:
    email = raw.strip().lower()
    if len(email) > 320 or not _EMAIL.match(email):
        raise CliError("email_invalid", email=raw)
    return email


def _read_stdin_line() -> str:
    """Одна строка из stdin без перевода строки (пробелы внутри сохраняются)."""
    value = sys.stdin.readline().rstrip("\r\n")
    if not value:
        raise CliError("input_empty")
    return value


def _ask_secret(prompt_key: str) -> str:
    try:
        value = getpass.getpass(t(f"cli.{prompt_key}"))
    except (EOFError, KeyboardInterrupt):
        raise CliError("cancelled") from None
    if not value:
        raise CliError("input_empty")
    return value


def _read_password(from_stdin: bool) -> str:
    if from_stdin:
        return _read_stdin_line()
    password = _ask_secret("password_prompt")
    if _ask_secret("password_repeat") != password:
        raise CliError("password_mismatch")
    return password


async def _user_by_email(email: str) -> User:
    async with get_session() as db:
        user = await admin_users.find_user_by_email(db, email)
    if user is None:
        raise CliError("user_not_found", email=email)
    return user


# --- команды ---


async def _create_admin(args: argparse.Namespace) -> None:
    email = _normalize_email(args.email)
    # Пустое имя в кабинете значит «команда терминала», поэтому имя не бывает пустым
    name = ((args.name or "").strip() or email.split("@", 1)[0])[:_NAME_MAX_LENGTH]
    password = _read_password(args.password_stdin)
    await check_new_password(password)
    password_hash = await hash_password_async(password)
    async with get_session() as db:
        try:
            await admin_users.create_admin(
                db, email=email, display_name=name, password_hash=password_hash
            )
        except AppError as exc:
            if exc.code == "admin.email_taken":
                raise CliError("email_taken", email=email) from None
            raise
        except IntegrityError:
            # Тот же email только что занят параллельно (например, регистрацией)
            raise CliError("email_taken", email=email) from None
    _say(t("cli.admin_created", email=email))


async def _reset_code(args: argparse.Namespace) -> None:
    email = _normalize_email(args.email)
    user = await _user_by_email(email)
    async with get_session() as db:
        created = await access_codes.create_reset_code(db, user.id, actor=None, ip=None)
    expires = created.reset_code.expires_at.strftime("%Y-%m-%d %H:%M")
    _say(t("cli.reset_code_done", email=email, code=created.code, expires=expires))


async def _reset_2fa(args: argparse.Namespace) -> None:
    email = _normalize_email(args.email)
    user = await _user_by_email(email)
    async with get_session() as db:
        result = await admin_users.reset_two_factor(db, user.id, actor=None, ip=None)
    _say(t("cli.reset_2fa_done", email=email, sessions=result.sessions_revoked))


async def _set_role(args: argparse.Namespace) -> None:
    email = _normalize_email(args.email)
    user = await _user_by_email(email)
    async with get_session() as db:
        after = await admin_users.change_role(db, user.id, args.role, actor=None, ip=None)
    key = "cli.role_unchanged" if user.role == after.role else "cli.role_done"
    _say(t(key, email=email, role=after.role))


async def _unblock(args: argparse.Namespace) -> None:
    email = _normalize_email(args.email)
    user = await _user_by_email(email)
    async with get_session() as db:
        await admin_users.unblock_user(db, user.id, actor=None, ip=None)
    done = "cli.unblock_done" if user.status == "blocked" else "cli.unblock_not_blocked"
    _say(t(done, email=email))


async def _set_admin_key(args: argparse.Namespace) -> None:
    key = (_read_stdin_line() if args.key_stdin else _ask_secret("key_prompt")).strip()
    if not admin_key.looks_like_key(key):
        raise CliError("key_format")
    verified = False
    if not args.skip_check:
        _say(t("cli.key_checking"))
        check = await admin_key.check_anthropic_key(key)
        if check.result == "rejected":
            raise CliError("key_rejected")
        if check.result == "unavailable":
            raise CliError("key_unavailable")
        if check.result == "error":
            raise CliError("key_check_failed", status=check.status_code)
        verified = True
    async with get_session() as db:
        last4 = await admin_key.save_admin_key(db, key, verified=verified, actor=None, ip=None)
    _say(t("cli.key_saved" if verified else "cli.key_saved_unchecked", last4=last4))


# --- разбор аргументов ---


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin.cli", description=t("cli.description")
    )
    commands = parser.add_subparsers(dest="command", required=True, metavar="<команда>")

    def command(name: str, help_key: str) -> argparse.ArgumentParser:
        help_text = t(f"cli.help.{help_key}")
        return commands.add_parser(name, help=help_text, description=help_text)

    def email_arg(cmd: argparse.ArgumentParser) -> None:
        cmd.add_argument("--email", required=True, help=t("cli.help.email"))

    create = command("create-admin", "create_admin")
    email_arg(create)
    create.add_argument("--name", help=t("cli.help.name"))
    create.add_argument("--password-stdin", action="store_true", help=t("cli.help.password_stdin"))
    create.set_defaults(handler=_create_admin)

    reset = command("reset-code", "reset_code")
    email_arg(reset)
    reset.set_defaults(handler=_reset_code)

    reset_2fa = command("reset-2fa", "reset_2fa")
    email_arg(reset_2fa)
    reset_2fa.set_defaults(handler=_reset_2fa)

    role = command("set-role", "set_role")
    email_arg(role)
    role.add_argument("--role", required=True, choices=["admin", "member"], help=t("cli.help.role"))
    role.set_defaults(handler=_set_role)

    unblock = command("unblock", "unblock")
    email_arg(unblock)
    unblock.set_defaults(handler=_unblock)

    key = command("set-admin-key", "set_admin_key")
    key.add_argument("--key-stdin", action="store_true", help=t("cli.help.key_stdin"))
    key.add_argument("--skip-check", action="store_true", help=t("cli.help.skip_check"))
    key.set_defaults(handler=_set_admin_key)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(args.handler(args))
    except CliError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    except AppError as exc:
        print(exc.message, file=sys.stderr)
        return 1
    except IntegrityError:
        # Параллельное изменение тех же строк. Текст исключения не печатаем: в нем
        # значения из запроса (например, хеш пароля)
        print(t("cli.db_conflict"), file=sys.stderr)
        return 1
    except (DBAPIError, OSError):
        # DBAPIError — общий класс ошибок драйвера: нет связи, неверный пароль базы, нет
        # такой базы, нет таблиц. Текст исключения не печатаем: в нем бывает адрес базы
        print(t("cli.db_unavailable"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
