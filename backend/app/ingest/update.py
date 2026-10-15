"""Обновление данных одной командой: архив Сакманна → tennis-data → привязка матчей старого
бота → пересчет Эло → расчет по архиву (этап 5: привязка матчей из анализов, закрытие из
архива, авторасчет ставок, app/services/archive_settlement.py).

    python -m app.ingest.update [--full] [--years 2024-2026] [--sackmann-dir ПАПКА]
                                [--tennis-data-dir ПАПКА] [--skip-elo]

- Без --full и --years — только текущий год, а в январе и прошлый: так работает ночное
  обновление (задача воркера update_data). Неизменившиеся файлы (тот же sha256)
  пропускаются, поэтому ночной запуск занимает секунды.
- --full — все годы архивов (Сакманн с data_first_year, tennis-data с
  tennis_data_first_year), и файлы разбираются заново, даже если не изменились: первая
  загрузка и перезагрузка после исправлений загрузчиков. --years — свои годы; вместе с
  --full они тоже разбираются заново.
- Папки — файлы без сети: tennis-data.co.uk закрыт Cloudflare от программ (ответ 403),
  файлы скачиваются в браузере (http://www.tennis-data.co.uk/alldata.php).

Шаги идут строго по очереди: загрузка Сакманна повышает матчи tennis-data, а привязка
старого бота ищет матчи обоих архивов; расчет по архиву идет последним, по тому, что
загружено. Загрузка файла на сайте (app/services/data_uploads.py) запускает те же шаги без
Сакманна (only). Одновременно идет только одно обновление
(блокировка в PostgreSQL на все время команды, runs.update_lock); ту же блокировку
берут отдельные команды шагов (загрузчики, привязка и слияния игроков и матчей).
Ошибка шага не останавливает следующие: Эло пересчитается по тому, что есть, но код
возврата 1. Журнал каждого шага — ingestion_runs (sackmann, tennis_data, players_link,
elo). Ход работы шагов (строка на файл архива, на этап пересчета Эло) команда печатает
сразу, с отступом под строкой шага: полная загрузка идет минуты, и без него кажется, что
все зависло. Задача воркера ход работы не печатает.
"""

import argparse
import asyncio
import socket
import sys
import time
from collections.abc import Awaitable, Callable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from pathlib import Path
from typing import Any, Literal

import httpx
import structlog
from sqlalchemy import func, select
from sqlalchemy.exc import DBAPIError, InterfaceError, OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.i18n import t
from app.db.models import Bet, IngestionRun, Match, MlModel, Tournament
from app.db.session import create_engine, create_sessionmaker
from app.ingest import players_link, sackmann, tennis_data
from app.ingest.fetch import DataSource, public_url
from app.ingest.runs import UPDATE_LOCK_KEY, IngestError, IngestReport, UpdateBusy, update_lock
from app.ml import elo

log = structlog.get_logger(__name__)

Step = Literal["sackmann", "tennis_data", "players_link", "elo", "settle"]
STEPS: tuple[Step, ...] = ("sackmann", "tennis_data", "players_link", "elo", "settle")
StepStatus = Literal["ok", "failed", "skipped"]
# Ключ блокировки на все время обновления (см. runs.update_lock): ее берут и отдельные
# команды шагов, поэтому ночная задача не идет одновременно ни с одной из них
LOCK_KEY = UPDATE_LOCK_KEY
# Строк подробного отчета шага в терминале; все — в ingestion_runs.details
DETAILS_SHOWN = 20
# Ошибки базы: текст исключения не печатается (в нем бывает адрес базы с паролем).
# ProgrammingError — чаще всего не применены миграции. Неверный пароль или нет такой базы
# драйвер отдает общим DBAPIError (см. _db_error)
_DB_ERRORS = (OperationalError, InterfaceError, ProgrammingError)
# Нет связи с базой (asyncpg отдает отказ соединения и ошибку DNS как OSError): следующие
# шаги не запускаются, они упали бы так же
_DB_DOWN = (OperationalError, InterfaceError, ConnectionError, socket.gaierror)


def _db_down(exc: BaseException) -> bool:
    """Базы нет для всех шагов: нет связи, неверный пароль, нет такой базы. Общий
    DBAPIError (не подкласс) — именно так драйвер отдает отказ входа и «нет базы»."""
    return isinstance(exc, _DB_DOWN) or type(exc) is DBAPIError


def _db_error(exc: BaseException) -> bool:
    """Ошибка подключения или схемы базы (текст — «нет подключения к базе»). Ошибки
    данных (IntegrityError и т. п.) сюда не входят: у них свой текст."""
    return isinstance(exc, _DB_ERRORS) or _db_down(exc)


Echo = Callable[[str], None]


@dataclass(frozen=True)
class UpdatePlan:
    """Что загружать: годы каждого архива и разбирать ли неизменившиеся файлы."""

    sackmann_years: tuple[int, ...]
    tennis_data_years: tuple[int, ...]
    force: bool


def plan_years(*, full: bool, years: Sequence[int] | None, today: date) -> UpdatePlan:
    """Годы загрузки (см. docstring модуля). Будущие годы отбрасываются, tennis-data
    раньше tennis_data_first_year не бывает."""
    settings = get_settings()
    this_year = today.year
    chosen: list[int]
    if years:
        chosen = sorted({year for year in years if year <= this_year})
        sackmann_years = chosen
    elif full:
        sackmann_years = list(range(settings.data_first_year, this_year + 1))
        chosen = list(range(settings.tennis_data_first_year, this_year + 1))
    else:
        # В январе архив прошлого года еще дописывается (итоговый турнир, поздние правки)
        chosen = [this_year - 1, this_year] if today.month == 1 else [this_year]
        sackmann_years = chosen
    first = settings.tennis_data_first_year
    return UpdatePlan(
        sackmann_years=tuple(sackmann_years),
        tennis_data_years=tuple(year for year in chosen if year >= first),
        force=full,
    )


@dataclass
class StepResult:
    """Итог шага для терминала и лога воркера."""

    step: Step
    status: StepStatus
    seconds: float = 0.0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    unmatched: int = 0
    # Эло: сколько матчей учтено; created — строк рейтинга в таблице, written — сколько из
    # них записано заново (неизменившиеся строки не переписываются)
    matches: int = 0
    written: int = 0
    # Текст свежести: последняя дата в архиве (из базы, после шага)
    freshness: str = ""
    error: str | None = None
    # Почему шаг не выполнялся (status = skipped)
    reason: str | None = None
    # Подробный отчет шага (строки загрузчика)
    details: list[str] = field(default_factory=list)
    # Строка шага в ingestion_runs (последняя, которую он записал)
    run_id: int | None = None

    @property
    def title(self) -> str:
        return t(f"ingest_update.step.{self.step}")

    def as_log(self) -> dict[str, Any]:
        """Кратко для лога воркера."""
        return {
            "status": self.status,
            "seconds": round(self.seconds, 1),
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "unmatched": self.unmatched,
            "error": self.error,
        }


@dataclass
class UpdateResult:
    steps: list[StepResult] = field(default_factory=list)
    # Не выполнялось совсем: другое обновление уже идет
    busy: bool = False

    @property
    def ok(self) -> bool:
        return not self.busy and all(step.status != "failed" for step in self.steps)

    @property
    def failed(self) -> list[StepResult]:
        return [step for step in self.steps if step.status == "failed"]


def _unmatched(counts: dict[str, Any]) -> int:
    return sum(int(n) for key, n in counts.items() if key.startswith("unmatched."))


def _from_report(result: StepResult, report: IngestReport) -> None:
    result.created = report.created
    result.updated = report.updated
    result.skipped = report.skipped
    result.unmatched = _unmatched(dict(report.counts))


def _error_text(exc: BaseException) -> str:
    if isinstance(exc, IngestError):
        return exc.message
    if _db_error(exc):
        return t("ingest_update.errors.db_unavailable")
    return t("ingest_update.errors.unexpected", error=type(exc).__name__)


def _years_text(years: Sequence[int]) -> str:
    if not years:
        return "—"
    ordered = sorted(years)
    if ordered == list(range(ordered[0], ordered[-1] + 1)) and len(ordered) > 2:
        return f"{ordered[0]}–{ordered[-1]}"
    return ", ".join(str(year) for year in ordered)


def _link_lines(report: IngestReport) -> list[str]:
    counts = report.counts
    lines = [
        t(
            "cli.players_link_summary",
            total=report.rows_read,
            linked=counts["linked.matches"],
            merged=counts["merged.players"],
            tournaments=counts["deleted.tournaments"],
            left=report.freshness.get("legacy_matches_left", 0),
        )
    ]
    lines += [f"  {warning}" for warning in report.warnings[:DETAILS_SHOWN]]
    unmatched = _unmatched(dict(counts))
    if unmatched:
        lines.append(t("ingest_update.details.link_unmatched", count=unmatched))
    return lines


class _Updater:
    def __init__(
        self,
        *,
        factory: Callable[[], AsyncSession],
        plan: UpdatePlan,
        sackmann_dir: Path | None,
        tennis_data_dir: Path | None,
        skip_elo: bool,
        transport: httpx.AsyncBaseTransport | None,
        echo: Echo | None,
        only: Sequence[Step] | None = None,
        on_step: Callable[[Step], Awaitable[None]] | None = None,
    ) -> None:
        self.only = set(only) if only is not None else None
        self.on_step = on_step
        self.factory = factory
        self.plan = plan
        self.sackmann_dir = sackmann_dir
        self.tennis_data_dir = tennis_data_dir
        self.skip_elo = skip_elo
        self.transport = transport
        self.echo = echo
        self.result = UpdateResult()
        self.db_down = False

    def _say(self, line: str) -> None:
        if self.echo is not None:
            self.echo(line)

    @property
    def _progress(self) -> Callable[[str], None] | None:
        """Ход работы шага (по файлу, по этапу) — с отступом под строкой шага. Без echo
        (задача воркера) шаги молчат."""
        echo = self.echo
        if echo is None:
            return None
        return lambda text_: echo("  " + text_)

    def _source(self, directory: Path | None, base_url: str) -> DataSource:
        if directory is not None:
            return DataSource.local(directory)
        return DataSource.http(base_url, transport=self.transport)

    async def run(self) -> UpdateResult:
        settings = get_settings()
        runners: dict[Step, Callable[[StepResult], Awaitable[None]]] = {
            "sackmann": self._sackmann,
            "tennis_data": self._tennis_data,
            "players_link": self._players_link,
            "elo": self._elo,
            "settle": self._settle,
        }
        for number, step in enumerate(STEPS, start=1):
            result = StepResult(step=step, status="ok")
            self.result.steps.append(result)
            reason = self._skip_reason(step, settings.tennis_data_first_year)
            if reason is not None:
                result.status, result.reason = "skipped", reason
                continue
            if self.on_step is not None:
                await self.on_step(step)
            self._say(
                t(
                    "ingest_update.progress.start",
                    number=number,
                    total=len(STEPS),
                    step=result.title,
                    what=self._what(step),
                )
            )
            await self._run_step(result, runners[step])
            self._say("")
        return self.result

    def _skip_reason(self, step: Step, first_tennis_year: int) -> str | None:
        if self.db_down:
            return t("ingest_update.skip.db")
        if self.only is not None and step not in self.only:
            return t("ingest_update.skip.not_requested")
        if step == "sackmann" and not self.plan.sackmann_years:
            return t("ingest_update.skip.no_years")
        if step == "tennis_data" and not self.plan.tennis_data_years:
            return t("ingest_update.skip.no_tennis_data_years", first=first_tennis_year)
        if step == "elo" and self.skip_elo:
            return t("ingest_update.skip.elo_flag")
        return None

    def _what(self, step: Step) -> str:
        settings = get_settings()
        if step in ("sackmann", "tennis_data"):
            if step == "sackmann":
                years, directory = self.plan.sackmann_years, self.sackmann_dir
                url = settings.sackmann_base_url
            else:
                years, directory = self.plan.tennis_data_years, self.tennis_data_dir
                url = settings.tennis_data_base_url
            key = "years_forced" if self.plan.force else "years"
            where = (
                t("ingest_update.progress.from_dir", path=directory)
                if directory is not None
                else t("ingest_update.progress.from_web", url=public_url(url))
            )
            return t(f"ingest_update.progress.{key}", years=_years_text(years), where=where)
        return t(f"ingest_update.progress.{step}")

    async def _run_step(
        self, result: StepResult, runner: Callable[[StepResult], Awaitable[None]]
    ) -> None:
        started = time.monotonic()
        last_run = await self._last_run_id(result.step)
        try:
            await runner(result)
        except Exception as exc:
            result.status = "failed"
            result.error = _error_text(exc)
            if _db_error(exc):
                self.db_down = _db_down(exc)
                log.warning("ingest.update_step_failed", step=result.step, error="db")
            elif isinstance(exc, IngestError):
                log.warning("ingest.update_step_failed", step=result.step, error=exc.key)
            else:
                log.exception("ingest.update_step_failed", step=result.step)
            await self._counts_from_journal(result, last_run)
        result.seconds = time.monotonic() - started
        result.run_id = await self._run_after(result.step, last_run)
        result.freshness = await self._freshness(result.step)
        for line in result.details:
            self._say(line)
        if result.error is not None:
            self._say(result.error)

    async def _last_run_id(self, step: Step) -> int:
        if self.db_down:
            return 0
        try:
            async with self.factory() as db:
                found = await db.scalar(
                    select(func.max(IngestionRun.id)).where(IngestionRun.source == step)
                )
        except (DBAPIError, *_DB_DOWN):
            return 0
        return int(found or 0)

    async def _run_after(self, step: Step, after: int) -> int | None:
        """Строка ingestion_runs, которую записал шаг (новее after)."""
        if self.db_down:
            return None
        try:
            async with self.factory() as db:
                found = await db.scalar(
                    select(func.max(IngestionRun.id)).where(
                        IngestionRun.source == step, IngestionRun.id > after
                    )
                )
        except (DBAPIError, *_DB_DOWN):
            return None
        return int(found) if found is not None else None

    async def _counts_from_journal(self, result: StepResult, after: int) -> None:
        """Упавший шаг: сколько успел записать — из его строки ingestion_runs."""
        if self.db_down:
            return
        try:
            async with self.factory() as db:
                details = await db.scalar(
                    select(IngestionRun.details)
                    .where(IngestionRun.source == result.step, IngestionRun.id > after)
                    .order_by(IngestionRun.id.desc())
                    .limit(1)
                )
        except (DBAPIError, *_DB_DOWN):
            return
        if not isinstance(details, dict):
            return
        result.created = int(details.get("created") or 0)
        result.updated = int(details.get("updated") or 0)
        result.skipped = int(details.get("skipped") or 0)
        counts = details.get("counts")
        result.unmatched = _unmatched(counts) if isinstance(counts, dict) else 0

    async def _freshness(self, step: Step) -> str:
        """Последняя дата в архиве по базе: видна, даже если файлы не менялись."""
        if self.db_down:
            return ""
        try:
            async with self.factory() as db:
                value = await db.scalar(_FRESHNESS[step])
        except (DBAPIError, *_DB_DOWN):
            return ""
        if step == "players_link":
            return t("ingest_update.freshness.players_link", count=int(value or 0))
        if step == "settle":
            return t("ingest_update.freshness.settle", count=int(value or 0))
        if value is None:
            return t("ingest_update.freshness.empty")
        return t(f"ingest_update.freshness.{step}", date=value)

    # --- шаги ---

    async def _sackmann(self, result: StepResult) -> None:
        settings = get_settings()
        async with self._source(self.sackmann_dir, settings.sackmann_base_url) as source:
            report = await sackmann.load_sackmann(
                years=self.plan.sackmann_years,
                source=source,
                force=self.plan.force,
                db_factory=self.factory,
                progress=self._progress,
            )
        _from_report(result, report)
        result.details = sackmann.summary_lines(report)

    async def _tennis_data(self, result: StepResult) -> None:
        settings = get_settings()
        async with self._source(self.tennis_data_dir, settings.tennis_data_base_url) as source:
            report = await tennis_data.load_tennis_data(
                years=self.plan.tennis_data_years,
                source=source,
                force=self.plan.force,
                db_factory=self.factory,
                progress=self._progress,
            )
            location = source.location
        _from_report(result, report)
        result.details = tennis_data.summary_lines(report, location)

    async def _players_link(self, result: StepResult) -> None:
        report = await players_link.link_legacy(db_factory=self.factory)
        _from_report(result, report)
        result.details = _link_lines(report)

    async def _elo(self, result: StepResult) -> None:
        summary = await elo.rebuild_ratings(db_factory=self.factory, progress=self._progress)
        result.created = summary.rows
        result.written = summary.written
        result.matches = summary.matches
        result.skipped = sum(summary.skipped.values())
        result.details = elo.summary_lines(summary)

    async def _settle(self, result: StepResult) -> None:
        # Сервисный модуль тянет аналитику и уведомления: грузится, только когда нужен
        from app.services.archive_settlement import settle_from_archive, summary_lines

        report, _ = await settle_from_archive(self.factory)
        _from_report(result, report)
        result.details = summary_lines(report)


_FRESHNESS: dict[Step, Any] = {
    "sackmann": select(func.max(Tournament.start_date)).where(Tournament.source == "sackmann"),
    "tennis_data": select(func.max(Match.match_date)).where(
        Match.source.in_(("sackmann", "tennis_data"))
    ),
    "players_link": select(func.count()).select_from(Match).where(Match.source == "legacy"),
    # Последний день расчета, а не max(as_of): строки матчей без даты стоят на последнем
    # возможном дне матча (elo.reveal_days), он бывает и позже сегодняшнего
    "elo": select(MlModel.train_to).where(MlModel.id == elo.MODEL_ID),
    # Открытых ставок приложения: их рассчитает следующий файл архива или участник
    "settle": select(func.count())
    .select_from(Bet)
    .where(Bet.status == "open", Bet.source == "app"),
}


async def run_update(
    *,
    full: bool = False,
    years: Sequence[int] | None = None,
    sackmann_dir: Path | str | None = None,
    tennis_data_dir: Path | str | None = None,
    skip_elo: bool = False,
    db_factory: Callable[[], AsyncSession] | None = None,
    today: date | None = None,
    transport: httpx.AsyncBaseTransport | None = None,
    echo: Echo | None = None,
    only: Sequence[Step] | None = None,
    on_step: Callable[[Step], Awaitable[None]] | None = None,
) -> UpdateResult:
    """Все шаги обновления по очереди (см. docstring модуля).

    db_factory — фабрика сеансов БД (воркер передает свою); без нее открывается свой
    движок по настройкам. transport — для тестов: ответы HTTP без сети. echo — куда
    печатать ход работы (команда терминала); без него — только лог. only — только эти
    шаги (остальные skipped), on_step — вызывается перед каждым шагом (ход загрузки файла
    на сайте).
    """
    if db_factory is None:
        engine = create_engine()
        try:
            return await run_update(
                full=full,
                years=years,
                sackmann_dir=sackmann_dir,
                tennis_data_dir=tennis_data_dir,
                skip_elo=skip_elo,
                db_factory=create_sessionmaker(engine),
                today=today,
                transport=transport,
                echo=echo,
                only=only,
                on_step=on_step,
            )
        finally:
            await engine.dispose()
    plan = plan_years(full=full, years=years, today=today or datetime.now(UTC).date())
    updater = _Updater(
        factory=db_factory,
        plan=plan,
        sackmann_dir=Path(sackmann_dir) if sackmann_dir is not None else None,
        tennis_data_dir=Path(tennis_data_dir) if tennis_data_dir is not None else None,
        skip_elo=skip_elo,
        transport=transport,
        echo=echo,
        only=only,
        on_step=on_step,
    )
    try:
        async with update_lock(db_factory):
            return await updater.run()
    except UpdateBusy:
        log.warning("ingest.update_busy")
        return UpdateResult(busy=True)


def _seconds(value: float) -> str:
    return f"{value:.1f}".replace(".", ",")


def summary_lines(result: UpdateResult) -> list[str]:
    """Итог обновления для терминала: строка на шаг и общий вывод."""
    if result.busy:
        return [t("ingest_update.errors.busy")]
    lines = [t("ingest_update.summary.title")]
    for step in result.steps:
        if step.status == "skipped":
            lines.append(t("ingest_update.summary.skipped", step=step.title, reason=step.reason))
            continue
        counts: dict[str, Any] = {
            "created": step.created,
            "updated": step.updated,
            "skipped": step.skipped,
            "unmatched": step.unmatched,
            "freshness": step.freshness,
        }
        if step.status == "ok" and step.step == "elo":
            lines.append(
                t(
                    "ingest_update.summary.elo",
                    step=step.title,
                    seconds=_seconds(step.seconds),
                    matches=step.matches,
                    rows=step.created,
                    written=step.written,
                    skipped=step.skipped,
                    freshness=step.freshness,
                )
            )
        elif step.status == "ok":
            lines.append(
                t(
                    "ingest_update.summary.ok",
                    step=step.title,
                    seconds=_seconds(step.seconds),
                    **counts,
                )
            )
        else:
            lines.append(
                t(
                    "ingest_update.summary.failed",
                    step=step.title,
                    seconds=_seconds(step.seconds),
                    error=step.error,
                )
            )
            if step.created or step.updated or step.skipped or step.unmatched:
                lines.append(t("ingest_update.summary.failed_counts", **counts))
    failed = result.failed
    if failed:
        names = ", ".join(step.title for step in failed)
        done = ", ".join(step.title for step in result.steps if step.status == "ok")
        if done:
            lines.append(t("ingest_update.summary.has_errors", steps=names, done=done))
        else:
            lines.append(t("ingest_update.summary.has_errors_none", steps=names))
    else:
        lines.append(t("ingest_update.summary.all_ok"))
    return lines


# --- команда терминала ---


def _years_arg(value: str) -> list[int]:
    this_year = datetime.now(UTC).year
    try:
        years = sackmann.parse_years(value)
    except ValueError:
        years = []
    if not years or max(years) > this_year:
        message = t("ingest_update.errors.years", value=value, last=this_year)
        raise argparse.ArgumentTypeError(message)
    return years


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ingest.update", description=t("ingest_update.description")
    )
    parser.add_argument("--full", action="store_true", help=t("ingest_update.help.full"))
    parser.add_argument(
        "--years",
        type=_years_arg,
        metavar=t("ingest_update.metavar.years"),
        help=t("ingest_update.help.years"),
    )
    parser.add_argument(
        "--sackmann-dir",
        metavar=t("ingest_update.metavar.dir"),
        help=t("ingest_update.help.sackmann_dir"),
    )
    parser.add_argument(
        "--tennis-data-dir",
        metavar=t("ingest_update.metavar.dir"),
        help=t("ingest_update.help.tennis_data_dir"),
    )
    parser.add_argument("--skip-elo", action="store_true", help=t("ingest_update.help.skip_elo"))
    return parser


def _print(line: str) -> None:
    print(line, flush=True)


def main(argv: Sequence[str] | None = None) -> int:
    """Код возврата: 0 — все шаги прошли, 1 — хотя бы один шаг с ошибкой."""
    args = build_parser().parse_args(argv)
    for directory in (args.sackmann_dir, args.tennis_data_dir):
        if directory is not None and not Path(directory).is_dir():
            print(t("ingest_update.errors.dir_not_found", path=directory), file=sys.stderr)
            return 1
    try:
        result = asyncio.run(
            run_update(
                full=args.full,
                years=args.years,
                sackmann_dir=args.sackmann_dir,
                tennis_data_dir=args.tennis_data_dir,
                skip_elo=args.skip_elo,
                echo=_print,
            )
        )
    except (DBAPIError, OSError):
        # DBAPIError — общий класс ошибок драйвера: нет связи, неверный пароль, нет базы
        # или таблиц. Текст исключения не печатаем: в нем бывает адрес базы с паролем
        print(t("ingest_update.errors.db_unavailable"), file=sys.stderr)
        return 1
    print("\n".join(summary_lines(result)), flush=True)
    return 0 if result.ok else 1


if __name__ == "__main__":
    sys.exit(main())
