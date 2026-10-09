"""Команды администратора в терминале сервера, как createsuperuser в Django (Р6).

    docker compose exec api python -m app.admin.cli create-admin --email admin@example.com
    python -m app.admin.cli reset-code --email user@example.com
    python -m app.admin.cli reset-2fa --email admin@example.com
    python -m app.admin.cli set-role --email user@example.com --role admin
    python -m app.admin.cli unblock --email admin@example.com
    python -m app.admin.cli set-admin-key [--key-stdin] [--skip-check]

Игроки (этап 2, app/services/players.py):

    python -m app.admin.cli players-find Синнер [--limit 10]
    python -m app.admin.cli players-merge --from 12 --into 5 [--yes]
    python -m app.admin.cli players-edit 5 [--name-ru ТЕКСТ] [--add-alias ТЕКСТ] \\
        [--remove-alias ТЕКСТ]
    python -m app.admin.cli players-link-legacy [--dry-run]
    python -m app.admin.cli players-unmatched [--limit 50]
    python -m app.admin.cli matches-merge --from 40 --into 41 [--yes]

Пароль и ключ вводятся без отображения (getpass) или одной строкой из stdin
(--password-stdin, --key-stdin) — так их не видно в истории команд и в списке процессов.
Каждая команда, которая меняет пользователей или игроков, пишет admin_audit_log
с actor_id = NULL и details.source = "terminal". players-link-legacy — загрузка
данных: ее итог пишется в ingestion_runs, а не в журнал администратора. matches-merge
(слить запись-копию матча) в журнал не пишет: такого действия в журнале нет.
players-merge, players-link-legacy и matches-merge меняют архив матчей и не идут
одновременно с обновлением данных (общая блокировка, app/ingest/runs.update_lock).
Код возврата: 0 — успех, 1 — ошибка (текст в stderr), 2 — неверные аргументы (argparse).
Работает и на чистой базе после alembic upgrade head.
"""

import argparse
import asyncio
import getpass
import re
import sys
from collections.abc import Callable, Sequence
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.i18n import t
from app.core.security.passwords import check_new_password, hash_password_async
from app.db.models import BetLeg, Match, OddsSnapshot, Player, Tournament, User
from app.db.session import get_session
from app.ingest import players_link
from app.ingest.runs import IngestError, update_lock
from app.services import access_codes, admin_key, admin_users, players

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
    # Занятый email — до ввода пароля и запроса в базу утечек (HIBP идет по сети):
    # ошибка видна сразу. Окончательная проверка — в create_admin под блокировкой
    async with get_session() as db:
        if await admin_users.find_user_by_email(db, email) is not None:
            raise CliError("email_taken", email=email)
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


# --- игроки (этап 2) ---

# Сколько примеров (слияний, несопоставленных строк) печатать после привязки
_PLAYERS_SHOWN = 20
_YES = frozenset({"y", "yes", "д", "да"})


def _dash(value: object) -> str:
    return "—" if value is None or value == "" else str(value)


def _table(header: Sequence[str], rows: Sequence[Sequence[str]]) -> str:
    """Таблица для терминала: ширина колонки — по самому длинному значению."""
    widths = [max(len(row[i]) for row in (header, *rows)) for i in range(len(header))]
    lines = [
        "  ".join(cell.ljust(width) for cell, width in zip(row, widths, strict=True)).rstrip()
        for row in (header, *rows)
    ]
    lines.insert(1, "  ".join("-" * width for width in widths))
    return "\n".join(lines)


def _items(values: dict[str, int]) -> str:
    return ", ".join(f"{name} — {count}" for name, count in values.items())


def _row_text(row: dict[str, Any]) -> str:
    """Строка отчета загрузки: «вид: поле=значение; …»."""
    fields = "; ".join(f"{key}={value}" for key, value in row.items() if key != "kind")
    return f"{row.get('kind', '')}: {fields}"


def _player_card(role: str, player: Player, matches: int) -> str:
    return t(
        "cli.players_card",
        role=role,
        id=player.id,
        name=player.name,
        name_ru=_dash(player.name_ru),
        country=_dash(player.country),
        born=_dash(player.birth_date.year if player.birth_date else None),
        sackmann_id=_dash(player.sackmann_id),
        matches=matches,
    )


async def _players_find(args: argparse.Namespace) -> None:
    async with get_session() as db:
        hits = await players.search_players(db, args.query, limit=args.limit)
    if not hits:
        _say(t("cli.players_find_none", query=args.query))
        return
    header = [
        t("cli.players_columns.id"),
        t("cli.players_columns.name"),
        t("cli.players_columns.name_ru"),
        t("cli.players_columns.country"),
        t("cli.players_columns.born"),
        t("cli.players_columns.sackmann_id"),
        t("cli.players_columns.matches"),
        t("cli.players_columns.score"),
        t("cli.players_columns.matched"),
    ]
    rows = [
        [
            str(hit.player.id),
            hit.player.name,
            _dash(hit.player.name_ru),
            _dash(hit.player.country),
            _dash(hit.player.birth_date.year if hit.player.birth_date else None),
            _dash(hit.player.sackmann_id),
            str(hit.matches),
            f"{hit.score:.2f}",
            hit.matched,
        ]
        for hit in hits
    ]
    _say(_table(header, rows))


def _confirmed() -> bool:
    try:
        answer = input(t("cli.players_merge_confirm"))
    except (EOFError, KeyboardInterrupt):
        return False
    return answer.strip().casefold() in _YES


async def _players_merge(args: argparse.Namespace) -> None:
    # Сначала то же слияние без фиксации: человек видит точные числа и конфликты
    async with get_session() as db:
        counts = await players.match_counts(db, (args.source, args.target))
        cards = [
            _player_card(t(role), player, counts[player.id])
            for role, player_id in (
                ("cli.players_merge_source", args.source),
                ("cli.players_merge_target", args.target),
            )
            if (player := await db.get(Player, player_id)) is not None
        ]
        preview = await players.merge_players(
            db, source_id=args.source, target_id=args.target, actor_id=None, commit=False
        )
        await db.rollback()
    _say(t("cli.players_merge_title"))
    for card in cards:
        _say(card)
    if preview.moved:
        _say(t("cli.players_merge_moved", items=_items(preview.moved)))
    else:
        _say(t("cli.players_merge_nothing_moved"))
    if preview.removed:
        _say(t("cli.players_merge_removed", items=_items(preview.removed)))
    if preview.filled:
        _say(t("cli.players_merge_filled", items=", ".join(preview.filled)))
    if preview.aliases_added:
        _say(t("cli.players_merge_aliases", items=", ".join(preview.aliases_added)))
    if preview.profile_kept_target:
        _say(t("cli.players_merge_profile"))
    if preview.copies_merged:
        items = ", ".join(f"{copy} → {match}" for copy, match in preview.copies_merged.items())
        _say(t("cli.players_merge_copies", items=items))
    if preview.copies_left:
        items = ", ".join(
            f"{copy} → {', '.join(map(str, ids))}" for copy, ids in preview.copies_left.items()
        )
        _say(t("cli.players_merge_copies_left", items=items))
    if not args.yes and not _confirmed():
        raise CliError("cancelled")
    # Не одновременно с обновлением данных: загрузка ищет игроков и матчи, которые
    # слияние меняет
    async with update_lock(get_session), get_session() as db:
        await players.merge_players(db, source_id=args.source, target_id=args.target, actor_id=None)
    _say(
        t(
            "cli.players_merge_done",
            source=args.source,
            target=args.target,
            name=preview.target_name,
        )
    )


async def _players_edit(args: argparse.Namespace) -> None:
    async with get_session() as db:
        before = await db.get(Player, args.player_id)
        state = (before.name_ru, list(before.aliases)) if before is not None else None
        player = await players.edit_player(
            db,
            args.player_id,
            name_ru=args.name_ru,
            add_alias=args.add_alias,
            remove_alias=args.remove_alias,
            actor_id=None,
        )
    if state == (player.name_ru, list(player.aliases)):
        _say(t("cli.players_edit_unchanged"))
    _say(
        t(
            "cli.players_edit_state",
            id=player.id,
            name=player.name,
            name_ru=_dash(player.name_ru),
            aliases=_dash(", ".join(player.aliases)),
        )
    )


def _say_unmatched(
    counts: dict[str, int], rows: Sequence[dict[str, Any]], shown: int, *, exact: bool = True
) -> None:
    key = "cli.players_unmatched_kind" if exact else "cli.players_unmatched_kind_min"
    for kind, count in sorted(counts.items()):
        _say(t(key, kind=kind, count=count))
    for row in rows[:shown]:
        _say(f"    {_row_text(row)}")


async def _players_link_legacy(args: argparse.Namespace) -> None:
    # Не одновременно с обновлением данных: загрузка Сакманна меняет порядок игроков в
    # матчах, а привязка переворачивает сторону ставки по порядку, прочитанному раньше
    async with update_lock(get_session):
        report = await players_link.link_legacy(dry_run=args.dry_run)
    counts = report.counts
    if args.dry_run:
        _say(t("cli.players_link_dry_run"))
    _say(
        t(
            "cli.players_link_summary",
            total=report.rows_read,
            linked=counts["linked.matches"],
            merged=counts["merged.players"],
            tournaments=counts["deleted.tournaments"],
            left=report.freshness.get("legacy_matches_left", 0),
        )
    )
    for warning in report.warnings[:_PLAYERS_SHOWN]:
        _say(f"  {warning}")
    unmatched = {
        key.removeprefix("unmatched."): count
        for key, count in counts.items()
        if key.startswith("unmatched.")
    }
    if unmatched:
        _say(t("cli.players_link_unmatched"))
        _say_unmatched(unmatched, report.unmatched, _PLAYERS_SHOWN)


async def _players_unmatched(args: argparse.Namespace) -> None:
    async with get_session() as db:
        runs = await players.recent_unmatched(db, limit=args.limit)
    if not runs:
        _say(t("cli.players_unmatched_none"))
        return
    for run in runs:
        at = run.finished_at.strftime("%Y-%m-%d %H:%M") if run.finished_at else "—"
        _say(t("cli.players_unmatched_run", source=run.source, run=run.run_id, at=at))
        older = [str(run_id) for run_id in run.run_ids if run_id != run.run_id]
        if older:
            _say(t("cli.players_unmatched_older", runs=", ".join(older)))
        if not run.counts and not run.rows:
            _say(t("cli.players_unmatched_clean"))
            continue
        _say_unmatched(run.counts, run.rows, args.limit, exact=run.exact)


async def _match_card(db: AsyncSession, role: str, match_id: int) -> str | None:
    match = await db.get(Match, match_id)
    if match is None:
        return None
    tour = await db.get(Tournament, match.tournament_id) if match.tournament_id else None
    first = await db.get(Player, match.player1_id)
    second = await db.get(Player, match.player2_id)
    odds = await db.scalar(
        select(func.count()).select_from(OddsSnapshot).where(OddsSnapshot.match_id == match_id)
    )
    legs = await db.scalar(
        select(func.count()).select_from(BetLeg).where(BetLeg.match_id == match_id)
    )
    return t(
        "cli.matches_card",
        role=role,
        id=match.id,
        source=_dash(match.source),
        tournament=_dash(tour.name if tour else None),
        start=_dash(tour.start_date if tour else None),
        round=_dash(match.round),
        player1=first.name if first else match.player1_id,
        player2=second.name if second else match.player2_id,
        date=_dash(match.match_date),
        odds=odds or 0,
        legs=legs or 0,
    )


async def _matches_merge(args: argparse.Namespace) -> None:
    # Сначала то же слияние без фиксации: человек видит, что перейдет к матчу-цели
    async with get_session() as db:
        cards = [
            card
            for role, match_id in (
                ("cli.matches_merge_source", args.source),
                ("cli.matches_merge_target", args.target),
            )
            if (card := await _match_card(db, t(role), match_id)) is not None
        ]
        preview = await players.merge_matches(
            db, source_match_id=args.source, target_match_id=args.target, commit=False
        )
        await db.rollback()
    _say(t("cli.matches_merge_title"))
    for card in cards:
        _say(card)
    if preview.flipped:
        _say(t("cli.matches_merge_flipped"))
    if preview.moved:
        _say(t("cli.players_merge_moved", items=_items(preview.moved)))
    if preview.removed:
        _say(t("cli.players_merge_removed", items=_items(preview.removed)))
    if preview.filled:
        _say(t("cli.matches_merge_filled", items=", ".join(preview.filled)))
    if not args.yes and not _confirmed():
        raise CliError("cancelled")
    async with update_lock(get_session), get_session() as db:
        await players.merge_matches(db, source_match_id=args.source, target_match_id=args.target)
    _say(t("cli.matches_merge_done", source=args.source, target=args.target))


def _add_player_commands(command: Callable[[str, str], argparse.ArgumentParser]) -> None:
    find = command("players-find", "players_find")
    find.add_argument("query", help=t("cli.help.players_query"))
    find.add_argument("--limit", type=int, default=10, help=t("cli.help.players_limit"))
    find.set_defaults(handler=_players_find)

    merge = command("players-merge", "players_merge")
    merge.add_argument(
        "--from", dest="source", type=int, required=True, help=t("cli.help.players_from")
    )
    merge.add_argument(
        "--into", dest="target", type=int, required=True, help=t("cli.help.players_into")
    )
    merge.add_argument("--yes", action="store_true", help=t("cli.help.players_yes"))
    merge.set_defaults(handler=_players_merge)

    edit = command("players-edit", "players_edit")
    edit.add_argument("player_id", type=int, help=t("cli.help.players_id"))
    edit.add_argument("--name-ru", help=t("cli.help.players_name_ru"))
    edit.add_argument("--add-alias", help=t("cli.help.players_add_alias"))
    edit.add_argument("--remove-alias", help=t("cli.help.players_remove_alias"))
    edit.set_defaults(handler=_players_edit)

    link = command("players-link-legacy", "players_link_legacy")
    link.add_argument("--dry-run", action="store_true", help=t("cli.help.players_dry_run"))
    link.set_defaults(handler=_players_link_legacy)

    unmatched = command("players-unmatched", "players_unmatched")
    unmatched.add_argument(
        "--limit", type=int, default=50, help=t("cli.help.players_unmatched_limit")
    )
    unmatched.set_defaults(handler=_players_unmatched)

    matches = command("matches-merge", "matches_merge")
    matches.add_argument(
        "--from", dest="source", type=int, required=True, help=t("cli.help.matches_from")
    )
    matches.add_argument(
        "--into", dest="target", type=int, required=True, help=t("cli.help.matches_into")
    )
    matches.add_argument("--yes", action="store_true", help=t("cli.help.players_yes"))
    matches.set_defaults(handler=_matches_merge)


# --- разбор аргументов ---


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin.cli", description=t("cli.description")
    )
    commands = parser.add_subparsers(
        dest="command", required=True, metavar=t("cli.command_metavar")
    )

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

    _add_player_commands(command)
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
    except IngestError as exc:
        # Обновление данных уже идет (update_lock)
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
