"""Команды администратора в терминале сервера, как createsuperuser в Django (Р6).

    docker compose exec api python -m app.admin.cli create-admin --email admin@example.com
    python -m app.admin.cli reset-code --email user@example.com
    python -m app.admin.cli reset-2fa --email admin@example.com
    python -m app.admin.cli set-role --email user@example.com --role admin
    python -m app.admin.cli unblock --email admin@example.com
    python -m app.admin.cli set-admin-key [--key-stdin] [--skip-check]

Claude (этап 3):

    python -m app.admin.cli agent-config [--set ИМЯ=ЗНАЧЕНИЕ ...] [--reset ИМЯ ...]
    python -m app.admin.cli prices
    python -m app.admin.cli agent-smoke [--match ID] [--yes]
    python -m app.admin.cli agent-smoke --only news [--news-model M] [--news-dynamic] \\
        [--news-max-uses N] [--news-no-cache] [--player ID] [--yes]

Приемка этапа 3 (app/admin/acceptance.py; отчет — --report ПУТЬ.md):

    python -m app.admin.cli acceptance-runs [--count 20] [--yes]
    python -m app.admin.cli smoke-eval [--events 40] [--since 2026-08-01] [--yes] [--no-wait]
    python -m app.admin.cli smoke-eval --resume ID
    python -m app.admin.cli parse-eval --file ПАРЫ.json [--yes]
    python -m app.admin.cli parse-eval --draft --from-telegram result.json --out ПАРЫ.json

Игроки (этап 2, app/services/players.py):

    python -m app.admin.cli players-find Синнер [--limit 10]
    python -m app.admin.cli players-merge --from 12 --into 5 [--yes]
    python -m app.admin.cli players-edit 5 [--name-ru ТЕКСТ] [--add-alias ТЕКСТ] \\
        [--remove-alias ТЕКСТ]
    python -m app.admin.cli players-link-legacy [--dry-run]
    python -m app.admin.cli players-unmatched [--limit 50]
    python -m app.admin.cli matches-merge --from 40 --into 41 [--yes]
    python -m app.admin.cli elo-current

Данные (этап 5, app/services/data_uploads.py):

    python -m app.admin.cli data-upload ФАЙЛ.xlsx

Push-уведомления (этап 6): новые ключи VAPID — строки для .env (на сервере — deploy/.env,
--subject mailto:<ваш email>); база не нужна:

    python -m app.admin.cli generate-vapid [--subject mailto:admin@example.com]

Пароль и ключ вводятся без отображения (getpass) или одной строкой из stdin
(--password-stdin, --key-stdin) — так их не видно в истории команд и в списке процессов.
Каждая команда, которая меняет пользователей, игроков или настройки агента, пишет
admin_audit_log
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
from decimal import Decimal
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import acceptance
from app.admin.terminal import EXIT_INTERRUPTED, CliError
from app.admin.terminal import confirmed as _confirmed
from app.admin.terminal import dash as _dash
from app.admin.terminal import say as _say
from app.admin.terminal import table as _table
from app.agent import config as agent_config
from app.agent.client import close_client
from app.agent.errors import ClaudeStepError
from app.agent.runs import list_prices
from app.core.config import VAPID_SUBJECT
from app.core.errors import AppError
from app.core.i18n import t
from app.core.security.passwords import check_new_password, hash_password_async
from app.core.vapid import generate_keys as generate_vapid_keys
from app.db.models import BetLeg, Match, OddsSnapshot, Player, Tournament, User
from app.db.session import create_engine, create_sessionmaker, get_session
from app.ingest import players_link
from app.ingest.runs import IngestError, update_lock
from app.ml import elo
from app.services import (
    access_codes,
    admin_key,
    admin_users,
    agent_smoke,
    check_runs,
    data_uploads,
    eval_runs,
    eval_sets,
    lessons,
    players,
    postmortems,
    recalibration,
    strategy_versions,
)
from app.services.app_settings import get_app_settings
from app.services.push import drain as push_drain

_EMAIL = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_NAME_MAX_LENGTH = 100
# Контакт VAPID по умолчанию — для своего компьютера; на сервере — свой email
DEFAULT_VAPID_SUBJECT = "mailto:admin@localhost"


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


# --- Claude (этап 3) ---


def _setting_text(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, tuple | list):
        return ", ".join(str(item) for item in value) or "—"
    return str(value)


async def _agent_config(args: argparse.Namespace) -> None:
    changes: dict[str, Any] = {}
    for item in args.set or []:
        name, sep, value = item.partition("=")
        name = name.strip()
        if not sep or not name:
            raise CliError("agent_config.set_format", item=item)
        changes[name] = agent_config.parse_setting(name, value.strip())
    reset = [name.strip() for name in args.reset or []]
    async with get_session() as db:
        if changes or reset:
            config = await agent_config.save_agent_config(
                db, changes=changes, reset=reset, actor_id=None
            )
            _say(t("cli.agent_config.saved"))
        else:
            config = await agent_config.load_agent_config(db)
        overrides = set((await get_app_settings(db)).agent_config or {})
    _say(t("cli.agent_config.title"))
    for name in agent_config.SETTING_NAMES:
        value = _setting_text(getattr(config, name))
        if name in overrides:
            default = _setting_text(getattr(agent_config.DEFAULT_CONFIG, name))
            _say(t("cli.agent_config.row_changed", name=name, value=value, default=default))
        else:
            _say(t("cli.agent_config.row", name=name, value=value))


async def _prices(args: argparse.Namespace) -> None:
    async with get_session() as db:
        rows = await list_prices(db)
    if not rows:
        _say(t("cli.prices.none"))
        return
    header = [
        t(f"cli.prices.columns.{name}")
        for name in (
            "model",
            "valid_from",
            "input",
            "output",
            "cache_read",
            "cache_write_5m",
            "cache_write_1h",
            "search",
            "long",
        )
    ]
    table = [
        [
            row.model,
            row.valid_from.strftime("%Y-%m-%d %H:%M"),
            *(
                f"{value.normalize():f}"
                for value in (
                    row.input,
                    row.output,
                    row.cache_read,
                    row.cache_write_5m,
                    row.cache_write_1h,
                    row.search_price,
                )
            ),
            (
                f"> {row.long_input_threshold} × {row.long_multiplier.normalize():f}"
                if row.long_input_threshold is not None and row.long_multiplier is not None
                else "—"
            ),
        ]
        for row in rows
    ]
    _say(t("cli.prices.title"))
    _say(_table(header, table))


# --- проверка конвейера на живом ключе (этап 3) ---


def _usd(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.0001'))}"


def _smoke_calls(calls: Sequence[agent_smoke.SmokeCall]) -> None:
    """Таблица вызовов проверки и итог в долларах."""
    header = [
        t(f"cli.agent_smoke.columns.{name}")
        for name in (
            "step",
            "model",
            "input",
            "cache_write",
            "cache_read",
            "output",
            "searches",
            "cost",
            "error",
        )
    ]
    rows = [
        [
            call.step,
            call.model,
            str(call.input_tokens),
            str(call.cache_write_tokens),
            str(call.cache_read_tokens),
            str(call.output_tokens),
            str(call.web_searches),
            _usd(call.cost_usd),
            _dash(call.error),
        ]
        for call in calls
    ]
    _say(t("cli.agent_smoke.title"))
    _say(_table(header, rows))
    _say(t("cli.agent_smoke.total", usd=_usd(sum((c.cost_usd for c in calls), Decimal(0)))))


def _smoke_problems(problems: Sequence[tuple[str, dict[str, Any]]]) -> None:
    """Что проверка не подтвердила — код 1 с перечнем."""
    if problems:
        raise CliError(
            "agent_smoke.checks_failed",
            problems="; ".join(
                t(f"cli.agent_smoke.problems.{key}", **params) for key, params in problems
            ),
        )


async def _agent_smoke(args: argparse.Namespace) -> None:
    if args.only == "news":
        await _agent_smoke_news(args)
        return
    news_flags = (
        args.news_model,
        args.news_dynamic or None,
        args.news_max_uses,
        args.news_no_cache or None,
        args.player,
    )
    if any(flag is not None for flag in news_flags):
        raise CliError("agent_smoke.news_flags")
    async with get_session() as db:
        config = await agent_config.load_agent_config(db)
        match = await agent_smoke.smoke_match(db, args.match)
        estimate = await agent_smoke.estimate_smoke(db, config)
        worst = await agent_smoke.max_smoke(db, config)
        _say(t("cli.agent_smoke.estimate", usd=estimate, max=worst, match=match.id))
        if not args.yes and not _confirmed("cli.agent_smoke.confirm"):
            raise CliError("cancelled")
        report = agent_smoke.SmokeReport()
        failure: str | None = None
        try:
            await agent_smoke.run_smoke(
                db,
                match_id=match.id,
                progress=lambda step: _say(t("cli.agent_smoke.step", step=step)),
                report=report,
            )
        except ClaudeStepError as exc:
            failure = agent_smoke.failure_text(exc)
    _smoke_calls(report.calls)
    if failure is not None:
        raise CliError("agent_smoke.failed", message=failure)
    _say(
        t(
            "cli.agent_smoke.summary",
            events=report.parsed_events,
            facts=report.news_facts,
            errors=", ".join(report.news_errors) or "—",
            match=report.match_id,
            p_base=f"{report.p_base:.3f}" if report.p_base is not None else "—",
            p_claude=f"{report.p_claude:.3f}" if report.p_claude is not None else "—",
        )
    )
    if report.second_cache_read > 0:
        _say(t("cli.agent_smoke.cache", tokens=report.second_cache_read))
    else:
        _say(t("cli.agent_smoke.no_cache"))
    # Команда — единственная живая проверка до запуска: то, что она должна подтвердить
    # (одно событие разбора, поиск перед record_news, чтение кэша), без этого — код 1
    _smoke_problems(report.problems())


def _yes_no(value: bool | None) -> str:
    if value is None:
        return t("cli.agent_smoke.news.unknown")
    return t("cli.agent_smoke.news.yes" if value else "cli.agent_smoke.news.no")


def _news_iterations(report: agent_smoke.NewsSmokeReport, *, prompt_cache: bool) -> None:
    """Итерации серверного цикла каждого вызова (usage.iterations): шли поиски сразу или
    подряд. С точкой кэша — и цена того же разговора без нее (весь вход каждой итерации
    по цене обычного входа), чтобы не сравнивать два живых запуска с разными поисками."""
    rows = [
        [
            str(number),
            str(position),
            item.type,
            str(item.input_tokens),
            str(item.cache_write_tokens),
            str(item.cache_read_tokens),
            str(item.output_tokens),
        ]
        for number, call in enumerate(report.calls, start=1)
        for position, item in enumerate(call.iterations, start=1)
    ]
    if not rows:
        _say(t("cli.agent_smoke.news.no_iterations"))
        return
    header = [
        t(f"cli.agent_smoke.columns.{name}")
        for name in (
            "call",
            "iteration",
            "type",
            "input",
            "cache_write",
            "cache_read",
            "output",
        )
    ]
    _say(t("cli.agent_smoke.news.iterations_title"))
    _say(_table(header, rows))
    no_cache = report.no_cache_usd
    if prompt_cache and no_cache is not None:
        # Знак — по округленной разнице: иначе при разнице меньше $0,00005 вышло бы «−$0.0000»
        diff = (no_cache - report.total_usd).quantize(Decimal("0.0001"))
        _say(
            t(
                "cli.agent_smoke.news.no_cache_cost",
                usd=_usd(no_cache),
                actual=_usd(report.total_usd),
                diff=f"{'+' if diff >= 0 else '−'}${_usd(abs(diff))}",
            )
        )


async def _agent_smoke_news(args: argparse.Namespace) -> None:
    """Только шаг новостей одного игрока: варианты модели, фильтрации поиска кодом, числа
    поисков и точки кэша для сравнения на живом ключе."""
    if args.match is not None:
        # Новости ищутся по игроку, а не по матчу: молча взять другого игрока нельзя
        raise CliError("agent_smoke.news_match")
    options = agent_smoke.NewsOptions(
        model=args.news_model,
        dynamic_filtering=True if args.news_dynamic else None,
        max_uses=args.news_max_uses,
        prompt_cache=False if args.news_no_cache else None,
    )
    try:
        async with get_session() as db:
            config = agent_smoke.news_config(await agent_config.load_agent_config(db), options)
            player = await agent_smoke.smoke_player(db, args.player)
            estimate, worst = await agent_smoke.estimate_news_smoke(db, config)
            support = await agent_smoke.check_news_model(db, config)
            _say(
                t(
                    "cli.agent_smoke.news.model",
                    model=config.news_model,
                    web_search=_yes_no(support.web_search),
                    code_execution=_yes_no(support.code_execution),
                )
            )
            _say(
                t(
                    "cli.agent_smoke.news.estimate",
                    player=player.name,
                    id=player.id,
                    model=config.news_model,
                    max_uses=config.news_max_uses,
                    dynamic=_yes_no(config.news_dynamic_filtering),
                    cache=_yes_no(config.news_prompt_cache),
                    usd=estimate,
                    max=worst,
                )
            )
            if not args.yes and not _confirmed("cli.agent_smoke.confirm"):
                raise CliError("cancelled")
            report = await agent_smoke.run_news_smoke(db, config=config, player=player)
    except ClaudeStepError as exc:
        # Нет цены модели, нет ключа или ключ отклонен: причина и код 1
        raise CliError("agent_smoke.failed", message=agent_smoke.failure_text(exc)) from None
    _smoke_calls(report.calls)
    if report.failure is not None:
        raise CliError("agent_smoke.failed", message=report.failure)
    _news_iterations(report, prompt_cache=config.news_prompt_cache)
    _say(
        t(
            "cli.agent_smoke.news.summary",
            searches=report.searches,
            errors=", ".join(report.search_errors) or "—",
            limited=report.limited,
            code_errors=", ".join(report.code_errors) or "—",
            facts=len(report.facts),
            dropped=report.dropped,
        )
    )
    if report.facts:
        _say(t("cli.agent_smoke.news.facts_title"))
        for number, fact in enumerate(report.facts, start=1):
            _say(
                t(
                    "cli.agent_smoke.news.fact",
                    number=number,
                    kind=fact.kind,
                    date=fact.published_at.isoformat(),
                    summary=fact.summary,
                    url=fact.source_url,
                    source=_dash(fact.source_name),
                )
            )
    else:
        _say(t("cli.agent_smoke.news.no_facts"))
    _smoke_problems(report.problems())


# --- игроки (этап 2) ---

# Сколько примеров (слияний, несопоставленных строк) печатать после привязки
_PLAYERS_SHOWN = 20


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


async def _elo_current(args: argparse.Namespace) -> None:
    # Не одновременно с обновлением данных: оно само перепишет таблицу шагом elo
    async with update_lock(get_session):
        players_count, ranked = await elo.refresh_current()
    _say(t("cli.elo_current_done", players=players_count, ranked=ranked))


async def _generate_vapid(args: argparse.Namespace) -> None:
    """Новая пара ключей VAPID: три строки для .env. Смена ключей отключает все подписки
    push (браузеры подпишутся заново, когда человек включит push)."""
    subject = str(args.subject).strip()
    if not VAPID_SUBJECT.match(subject):
        raise CliError("vapid_subject")
    public, private = generate_vapid_keys()
    _say(f"CAPPER_VAPID_PUBLIC_KEY={public}")
    _say(f"CAPPER_VAPID_PRIVATE_KEY={private}")
    _say(f"CAPPER_VAPID_SUBJECT={subject}")


async def _data_upload(args: argparse.Namespace) -> None:
    """Файл tennis-data тем же кодом, что кнопка на сайте: загрузка в data_uploads, журнал
    (data_upload, source = terminal) и обработка сразу, без очереди воркера."""
    path = Path(args.file)
    if not await asyncio.to_thread(path.is_file):
        raise CliError("data_upload.not_found", path=str(path))
    content = await asyncio.to_thread(path.read_bytes)
    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        async with factory() as db:
            upload = await data_uploads.create_upload(
                db, actor=None, ip=None, filename=path.name, content=content
            )
        _say(t("cli.data_upload.accepted", filename=upload.filename, id=upload.id))
        status = await data_uploads.process_upload(factory, upload.id)
        async with factory() as db:
            if status == "busy":
                await data_uploads.mark_failed(db, upload.id, t("cli.data_upload.busy"))
                raise CliError("data_upload.busy")
            out = await data_uploads.get_upload(db, upload.id)
    finally:
        await engine.dispose()
    report = out.report
    if report is not None and report.unchanged:
        _say(t("cli.data_upload.unchanged"))
    if report is not None:
        _say(
            t(
                "cli.data_upload.result",
                year=out.year,
                rows=report.file_rows,
                new=report.new_matches,
                updated=report.updated_matches,
                matches_to=report.matches_to or "—",
                settled=report.settled_bets,
                people=report.people,
                closing=report.closing,
                linked=report.linked,
                unlinked=report.unlinked,
                waiting=report.waiting,
            )
        )
    if out.status == "failed":
        raise CliError("data_upload.failed", error=out.error or "")


async def _postmortems(args: argparse.Namespace) -> None:
    """Очередь и пакет разборов ставок сейчас (без расписания воркера) и сбор готовых
    пакетов разборов и быстрых проверок — тем же кодом, что задачи воркера."""
    # Задачи воркера тянут сервисы анализа: команда грузит их только здесь
    from app.workers.jobs import collect_all

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        async with factory() as db:
            sent = await postmortems.submit(db, force=True)
        async with factory() as db:
            collected = await collect_all(db)
    finally:
        await engine.dispose()
    _say(
        t(
            "cli.postmortems.result",
            queued=sent.get("queued", 0),
            sent=sent.get("sent", 0),
            waiting=sent.get("waiting", 0),
            collected=collected.get("collected", 0),
            lost=collected.get("lost", 0),
        )
    )
    skipped = sent.get("skipped") or collected.get("skipped")
    if skipped:
        _say(t("cli.postmortems.skipped", reason=skipped))


async def _lessons_check(args: argparse.Namespace) -> None:
    """Проверка гипотез на пороге своих случаев (--recheck — ежемесячная перепроверка
    готовых и действующих уроков) тем же кодом, что задачи воркера."""
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            if args.recheck:
                counts = await lessons.recheck_lessons(db)
            else:
                counts = await lessons.check_lessons(db)
    finally:
        await engine.dispose()
    key = "cli.lessons_check.recheck" if args.recheck else "cli.lessons_check.result"
    _say(t(key, **{name: str(value) for name, value in counts.items()}))


async def _eval_freeze(args: argparse.Namespace) -> None:
    """Заморозка eval-набора (без денег): сыгранные матчи после среза знаний модели, доля
    трудных, список и sha256 — тем же кодом, что POST /api/admin/eval/sets."""
    from datetime import date as date_type

    from app.schemas.learning import EvalSetIn

    body = EvalSetIn(
        code=args.code,
        since=date_type.fromisoformat(args.since) if args.since else None,
        size=args.size,
    )
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            found = await eval_sets.freeze(db, body, actor_id=None)
            out = eval_sets.set_out(found)
    finally:
        await engine.dispose()
    _say(
        t(
            "cli.eval.frozen",
            code=out.code,
            events=out.n_events,
            hard=out.hard,
            since=out.since.isoformat() if out.since else "—",
            until=out.until.isoformat() if out.until else "—",
            sha=out.sha256 or "—",
        )
    )


async def _eval_run(args: argparse.Namespace) -> None:
    """Прогон версии инструкций на последнем наборе: план (цена, худший случай, бюджет),
    подтверждение, запуск и отправка первого пакета. Код 2FA не спрашивается: доступ к
    серверу подтверждает владельца."""
    from app.db.models import StrategyVersion
    from app.schemas.learning import EvalRunIn

    engine = create_engine()
    try:
        factory = create_sessionmaker(engine)
        async with factory() as db:
            # Действующая v3 общей линии появляется с первым анализом или экраном; прогон
            # из терминала до них видит ее так же
            await strategy_versions.ensure_shared_ready(db)
            version = await db.scalar(
                select(StrategyVersion).where(
                    StrategyVersion.user_id.is_(None), StrategyVersion.code == args.version
                )
            )
            if version is None:
                raise CliError("eval.no_version", version=args.version)
            admin = await check_runs.pick_admin(db, args.email)
            if admin is None:
                raise CliError("eval.no_admin")
            plan = await eval_runs.plan(db, version.id)
            _say(
                t(
                    "cli.eval.plan",
                    version=plan.version_code,
                    events=plan.events,
                    chunks=plan.chunks,
                    estimate=str(plan.estimate_usd),
                    worst=str(plan.worst_usd),
                    chunk=str(plan.worst_chunk_usd),
                    left=str(plan.budget.left_usd),
                )
            )
            if not plan.can_run:
                reason = t(
                    f"errors.{plan.reason}",
                    since=plan.set_seen_since.isoformat(),
                    lesson=plan.overlap_lesson or "",
                )
                raise CliError("eval.refused", reason=reason)
            if not args.yes and not _confirmed(t("cli.eval.confirm")):
                _say(t("cli.cancelled"))
                return
            run = await eval_runs.start(
                db,
                admin,
                EvalRunIn(version_id=version.id),
                confirm=None,
                ip=None,
                enqueue=_no_queue,
                terminal=True,
            )
            run_id = run.id
        async with factory() as db:
            status = await eval_runs.advance(db, run_id)
    finally:
        await engine.dispose()
    _say(t("cli.eval.started", run=run_id, status=status))


async def _eval_cancel(args: argparse.Namespace) -> None:
    """Остановить прогон версии на наборе (как кнопка администратора): ждущий отправки,
    бюджета или ключа — сразу, пакет у Anthropic — отменяется, начатые запросы
    дособираются."""
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            run = await eval_runs.cancel(db, None, args.run_id, ip=None)
            status = str(run.status)
    finally:
        await engine.dispose()
    _say(t(f"cli.eval.canceled_{'now' if status == 'abandoned' else 'later'}", run=args.run_id))


async def _no_queue(run_id: int) -> None:
    """Команда терминала отправляет первый пакет сама."""
    return None


async def _ml_recalibrate(args: argparse.Namespace) -> None:
    """Перекалибровка базовой модели сейчас (как задача по понедельникам)."""
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            result = await recalibration.recalibrate(db)
    finally:
        await engine.dispose()
    version = result.version
    _say(
        t(
            f"cli.ml_recalibrate.{result.decision}",
            model=version.id if version else "—",
            brier=f"{version.brier:.4f}" if version and version.brier is not None else "—",
            prev=f"{version.prev_brier:.4f}" if version and version.prev_brier is not None else "—",
            reason=t(f"errors.{result.reason}") if result.reason else "",
        )
    )


def _add_learning_commands(command: Callable[[str, str], argparse.ArgumentParser]) -> None:
    freeze = command("eval-freeze", "eval_freeze")
    freeze.add_argument("--code", help=t("cli.help.eval_code"))
    freeze.add_argument("--since", help=t("cli.help.eval_since"))
    freeze.add_argument("--size", type=int, help=t("cli.help.eval_size"))
    freeze.set_defaults(handler=_eval_freeze)

    run = command("eval-run", "eval_run")
    run.add_argument("--version", required=True, help=t("cli.help.eval_version"))
    run.add_argument("--email", help=t("cli.help.email"))
    run.add_argument("--yes", action="store_true", help=t("cli.help.eval_yes"))
    run.set_defaults(handler=_eval_run)

    cancel = command("eval-cancel", "eval_cancel")
    cancel.add_argument("run_id", type=int, help=t("cli.help.eval_run_id"))
    cancel.set_defaults(handler=_eval_cancel)

    recal = command("ml-recalibrate", "ml_recalibrate")
    recal.set_defaults(handler=_ml_recalibrate)


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

    current = command("elo-current", "elo_current")
    current.set_defaults(handler=_elo_current)

    vapid = command("generate-vapid", "generate_vapid")
    vapid.add_argument("--subject", default=DEFAULT_VAPID_SUBJECT, help=t("cli.help.vapid_subject"))
    vapid.set_defaults(handler=_generate_vapid)

    upload = command("data-upload", "data_upload")
    upload.add_argument("file", help=t("cli.help.data_upload_file"))
    upload.set_defaults(handler=_data_upload)

    reviews = command("postmortems", "postmortems")
    reviews.set_defaults(handler=_postmortems)

    check = command("lessons-check", "lessons_check")
    check.add_argument("--recheck", action="store_true", help=t("cli.help.lessons_recheck"))
    check.set_defaults(handler=_lessons_check)


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

    config = command("agent-config", "agent_config")
    config.add_argument(
        "--set",
        action="append",
        metavar=t("cli.agent_config.set_metavar"),
        help=t("cli.help.agent_config_set"),
    )
    config.add_argument(
        "--reset",
        action="append",
        metavar=t("cli.agent_config.reset_metavar"),
        help=t("cli.help.agent_config_reset"),
    )
    config.set_defaults(handler=_agent_config)

    prices = command("prices", "prices")
    prices.set_defaults(handler=_prices)

    smoke = command("agent-smoke", "agent_smoke")
    smoke.add_argument("--match", type=int, help=t("cli.help.agent_smoke_match"))
    smoke.add_argument("--yes", action="store_true", help=t("cli.help.agent_smoke_yes"))
    smoke.add_argument("--only", choices=["news"], help=t("cli.help.agent_smoke_only"))
    smoke.add_argument(
        "--news-model",
        metavar=t("cli.agent_smoke.metavar.model"),
        help=t("cli.help.agent_smoke_news_model"),
    )
    smoke.add_argument(
        "--news-dynamic", action="store_true", help=t("cli.help.agent_smoke_news_dynamic")
    )
    smoke.add_argument(
        "--news-max-uses",
        type=int,
        metavar=t("cli.agent_smoke.metavar.count"),
        help=t("cli.help.agent_smoke_news_max_uses"),
    )
    smoke.add_argument(
        "--news-no-cache", action="store_true", help=t("cli.help.agent_smoke_news_no_cache")
    )
    smoke.add_argument(
        "--player",
        type=int,
        metavar=t("cli.agent_smoke.metavar.id"),
        help=t("cli.help.agent_smoke_player"),
    )
    smoke.set_defaults(handler=_agent_smoke)

    acceptance.add_commands(commands)
    _add_player_commands(command)
    _add_learning_commands(command)
    return parser


async def _run(args: argparse.Namespace) -> None:
    """Команда и закрытие пула соединений Claude в одном цикле событий: после asyncio.run
    закрыть его уже нельзя (проверка ключа в set-admin-key)."""
    try:
        await args.handler(args)
    finally:
        # Push уведомлений, которые команда создала (расчет ставок и т. п.), — в очередь
        # до выхода: после asyncio.run задачи постановки уже не выполнятся
        await push_drain()
        await close_client()


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        asyncio.run(_run(args))
    except CliError as exc:
        print(exc.message, file=sys.stderr)
        return exc.exit_code
    except KeyboardInterrupt:
        # Ctrl+C: текст вместо трассировки; прерванный анализ уже помечен failed
        print(t("cli.interrupted"), file=sys.stderr)
        return EXIT_INTERRUPTED
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
