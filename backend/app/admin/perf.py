"""Замер скорости API на синтетических данных (этап 4; PLAN.md, «Целевые показатели»).

    python -m app.admin.perf run [--admin-url URL] [--slack 1.5] [--json ПУТЬ] [--markdown ПУТЬ]
    python -m app.admin.perf seed --yes-perf-db [--today 2026-10-14] [--scale 1.0]
    python -m app.admin.perf measure --yes-perf-db [--samples 30] [--slack 1.0]

run — все сразу, как в CI: временная база capper_perf_<pid> на сервере служебного адреса
(--admin-url, по умолчанию CAPPER_TEST_ADMIN_DATABASE_URL), миграции, сид
(app/admin/perf_seed.py), замер (app/admin/perf_measure.py), отчет; база и ключи Redis
замера удаляются и при ошибке (--keep — оставить базу).

seed и measure — по отдельности в базу из CAPPER_DATABASE_URL: только с именем
capper_perf или capper_perf_<буквы и цифры> и с флагом --yes-perf-db (замер тоже пишет:
расчет ставок, пополнения банка). Рабочую базу команды не трогают.

Код возврата: 0 — p95 всех маршрутов в пределах цели × slack; 1 — нет или замер не
выполнен (текст в stderr).
"""

import argparse
import asyncio
import os
import sys
import time
from collections.abc import Sequence
from datetime import UTC, date, datetime
from pathlib import Path

import asyncpg
from alembic import command
from alembic.config import Config
from sqlalchemy import Connection
from sqlalchemy.engine import make_url

from app.admin import perf_measure, perf_seed
from app.admin.terminal import CliError, say
from app.core.config import get_settings
from app.core.i18n import t
from app.core.redis import create_redis
from app.db.migrate import ALEMBIC_INI
from app.db.session import create_engine, create_sessionmaker

STEPS = ("reads", "cold", "loop", "exports", "writes")


def _alembic_upgrade(connection: Connection) -> None:
    config = Config(str(ALEMBIC_INI))
    config.set_main_option("script_location", str(ALEMBIC_INI.parent / "alembic"))
    config.attributes["connection"] = connection
    config.attributes["configure_logger"] = False
    command.upgrade(config, "head")


def _use_database(url: str, redis_prefix: str) -> None:
    """Настройки процесса — на базу замера: тестовый режим (cookie без Secure, без HIBP),
    свой префикс Redis, логи только предупреждений (время ответа замер берет сам)."""
    os.environ["CAPPER_DATABASE_URL"] = url
    os.environ["CAPPER_REDIS_PREFIX"] = redis_prefix
    os.environ["CAPPER_ENV"] = "test"
    os.environ["CAPPER_COOKIE_SECURE"] = "false"
    os.environ["CAPPER_HIBP_ENABLED"] = "false"
    os.environ.setdefault("CAPPER_LOG_LEVEL", "WARNING")
    get_settings.cache_clear()


async def _seed(today: date, sizes: perf_seed.Sizes) -> perf_seed.SeedResult:
    engine = create_engine()
    started = time.monotonic()

    def progress(step: str) -> None:
        say(t("cli.perf.seed_step", step=step, seconds=f"{time.monotonic() - started:.1f}"))

    try:
        result = await perf_seed.seed(
            create_sessionmaker(engine), today=today, sizes=sizes, progress=progress
        )
    finally:
        await engine.dispose()
    say(t("cli.perf.seed_done", seconds=f"{time.monotonic() - started:.1f}"))
    say(", ".join(f"{name} {count}" for name, count in result.counts.items()))
    return result


async def _measure(args: argparse.Namespace) -> list[perf_measure.RouteStat]:
    from app.main import create_app

    app = create_app()
    async with app.router.lifespan_context(app):
        samples = await perf_measure.measure(
            app,
            samples=args.samples,
            heavy_samples=args.heavy_samples,
            steps=args.steps,
            progress=say,
        )
    stats = perf_measure.summarize(samples, slack=args.slack)
    say(perf_measure.report_table(stats))
    if args.json:
        await asyncio.to_thread(_write, args.json, perf_measure.report_json(stats))
    if args.markdown:
        await asyncio.to_thread(_write, args.markdown, perf_measure.report_markdown(stats))
    return stats


def _write(path: str, content: str) -> None:
    Path(path).write_text(content + "\n", encoding="utf-8")


def _verdict(stats: Sequence[perf_measure.RouteStat]) -> int:
    over = [item.key for item in stats if not item.ok]
    if over:
        print(t("cli.perf.failed", routes=", ".join(over)), file=sys.stderr)
        return 1
    say(t("cli.perf.passed", routes=len(stats)))
    return 0


async def _clear_redis(prefix: str) -> None:
    client = create_redis()
    try:
        batch: list[str] = []
        async for key in client.scan_iter(match=prefix + "*", count=500):
            batch.append(str(key))
            if len(batch) >= 500:
                await client.delete(*batch)
                batch = []
        if batch:
            await client.delete(*batch)
    finally:
        await client.aclose()


async def _run(args: argparse.Namespace) -> int:
    admin_url = args.admin_url or get_settings().test_admin_database_url
    name = f"capper_perf_{os.getpid()}"
    url = make_url(admin_url).set(drivername="postgresql+asyncpg", database=name)
    prefix = f"capper-perf:{os.getpid()}:"
    _use_database(url.render_as_string(hide_password=False), prefix)
    perf_seed.check_target(get_settings().database_url, confirmed=True)
    conn = await asyncpg.connect(admin_url)
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        await conn.execute(f'CREATE DATABASE "{name}"')
        # Фиксация без ожидания записи на диск: замер — о коде, а не о диске раннера (на
        # общем диске fsync дает сотни миллисекунд случайной задержки изменяющим запросам)
        await conn.execute(f'ALTER DATABASE "{name}" SET synchronous_commit = off')
    finally:
        await conn.close()
    try:
        engine = create_engine()
        try:
            async with engine.begin() as connection:
                await connection.run_sync(_alembic_upgrade)
        finally:
            await engine.dispose()
        await _seed(args.today, _sizes(args))
        return _verdict(await _measure(args))
    finally:
        await _clear_redis(prefix)
        if not args.keep:
            conn = await asyncpg.connect(admin_url)
            try:
                await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            finally:
                await conn.close()


def _sizes(args: argparse.Namespace) -> perf_seed.Sizes:
    sizes = perf_seed.Sizes()
    return sizes if args.scale == 1.0 else sizes.scaled(args.scale)


def _check_own_database(args: argparse.Namespace) -> None:
    perf_seed.check_target(get_settings().database_url, confirmed=args.yes_perf_db)


async def _seed_command(args: argparse.Namespace) -> int:
    _check_own_database(args)
    _use_database(get_settings().database_url, get_settings().redis_prefix)
    await _seed(args.today, _sizes(args))
    return 0


async def _measure_command(args: argparse.Namespace) -> int:
    _check_own_database(args)
    _use_database(get_settings().database_url, get_settings().redis_prefix)
    return _verdict(await _measure(args))


def _day(value: str) -> date:
    return date.fromisoformat(value)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.admin.perf", description=t("cli.perf.description")
    )
    commands = parser.add_subparsers(dest="command", required=True)
    today = datetime.now(UTC).date()

    def measure_options(sub: argparse.ArgumentParser) -> None:
        sub.add_argument("--samples", type=int, default=perf_measure.SAMPLES)
        sub.add_argument("--heavy-samples", type=int, default=perf_measure.HEAVY_SAMPLES)
        sub.add_argument("--slack", type=float, default=1.0, help=t("cli.perf.help.slack"))
        sub.add_argument("--steps", nargs="+", choices=STEPS, default=list(STEPS))
        sub.add_argument("--json", help=t("cli.perf.help.json"))
        sub.add_argument("--markdown", help=t("cli.perf.help.markdown"))

    run = commands.add_parser("run", help=t("cli.perf.help.run"))
    run.add_argument("--admin-url", help=t("cli.perf.help.admin_url"))
    run.add_argument("--keep", action="store_true", help=t("cli.perf.help.keep"))
    run.add_argument("--today", type=_day, default=today, help=t("cli.perf.help.today"))
    run.add_argument("--scale", type=float, default=1.0, help=t("cli.perf.help.scale"))
    measure_options(run)
    run.set_defaults(handler=_run)

    seed = commands.add_parser("seed", help=t("cli.perf.help.seed"))
    seed.add_argument("--yes-perf-db", action="store_true", help=t("cli.perf.help.yes"))
    seed.add_argument("--today", type=_day, default=today, help=t("cli.perf.help.today"))
    seed.add_argument("--scale", type=float, default=1.0, help=t("cli.perf.help.scale"))
    seed.set_defaults(handler=_seed_command)

    measure = commands.add_parser("measure", help=t("cli.perf.help.measure"))
    measure.add_argument("--yes-perf-db", action="store_true", help=t("cli.perf.help.yes"))
    measure_options(measure)
    measure.set_defaults(handler=_measure_command)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(asyncio.run(args.handler(args)))
    except CliError as exc:
        print(exc.message, file=sys.stderr)
        return exc.exit_code
    except perf_measure.PerfError as exc:
        print(t("cli.perf.error", error=str(exc)), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
