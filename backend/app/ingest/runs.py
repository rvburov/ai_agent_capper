"""Журнал загрузок данных (ingestion_runs) и отчет загрузчика.

    async with ingestion_run(sessionmaker, "sackmann") as run:
        hashes = await last_ok_file_hashes(db, "sackmann")
        ...
        run.report.add_file(file)        # и неизменившийся файл тоже
        run.report.created += 1

Строка запуска (status = running) пишется сразу своей транзакцией: запуск виден, даже
если загрузчик упадет на полпути или будет убит. По выходу из блока — итог: время
окончания, число записанных строк (created + updated), ok или failed, короткий текст
ошибки и отчет в details. Свои данные загрузчик пишет и фиксирует сам, в своих сеансах.

Отчет хранит не больше MAX_EXAMPLES примеров на вид (несопоставленные строки, пропуски,
предупреждения), а полные счетчики — в counts: ночная загрузка не раздувает базу.
"""

import asyncio
from collections import Counter
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from datetime import date, datetime
from decimal import Decimal
from pathlib import PurePath
from typing import Any, Protocol

import structlog
from sqlalchemy import func, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import IngestionRun

log = structlog.get_logger(__name__)

INGEST_SOURCES = ("sackmann", "tennis_data", "players_link", "elo")
MAX_EXAMPLES = 200
# Длина текста ошибки в ingestion_runs.error
ERROR_LIMIT = 500


class IngestError(Exception):
    """Загрузка невозможна. Текст — из локали по ключу (ingest.*, ingest_sackmann.* …):
    он пишется в ingestion_runs.error и печатается командой терминала."""

    def __init__(self, key: str, /, **params: Any) -> None:
        self.key = key
        self.message = t(key, **params)
        super().__init__(self.message)


class _File(Protocol):
    @property
    def path(self) -> str: ...

    @property
    def sha256(self) -> str: ...


def _jsonable(value: Any) -> Any:
    """Значение для JSONB: даты — ISO, Decimal и пути — строкой, множества — списком."""
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Decimal | PurePath):
        return str(value)
    if isinstance(value, dict):
        return {str(key): _jsonable(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        items = [_jsonable(item) for item in value]
        return sorted(items, key=str) if isinstance(value, set | frozenset) else items
    return str(value)


@dataclass
class IngestReport:
    """Итог загрузчика: сколько строк прочитано, создано, обновлено и пропущено, какие
    строки не сопоставлены, предупреждения, файлы с sha256 и свежесть данных.

    Счетчики rows_read, created, updated загрузчик меняет сам. Пропуски, несопоставленные
    строки и предупреждения — через skip, add_unmatched и add_warning: они считают все
    случаи (counts), а примеров хранят не больше MAX_EXAMPLES на вид.
    freshness — свободный словарь, например {"last_match_date": "2026-09-28",
    "missing_files": ["atp_matches_2026.csv"]}.
    """

    rows_read: int = 0
    created: int = 0
    updated: int = 0
    skipped: int = 0
    unmatched: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    files: dict[str, str] = field(default_factory=dict)
    freshness: dict[str, Any] = field(default_factory=dict)
    # Полные счетчики по видам: skipped.<причина>, unmatched.<вид>, warnings.<ключ>
    counts: Counter[str] = field(default_factory=Counter)

    @property
    def rows(self) -> int:
        """Записанные строки: ingestion_runs.rows."""
        return self.created + self.updated

    def add_file(self, file: _File) -> None:
        """Файл и его sha256. Неизменившийся файл тоже добавляется: по этому списку
        следующий запуск решает, что разбирать заново (last_ok_file_hashes)."""
        self.files[file.path] = file.sha256

    def skip(self, reason: str, count: int = 1) -> None:
        """Пропущенная строка источника (матч без счета, незнакомый раунд и т. п.)."""
        self.skipped += count
        self.counts[f"skipped.{reason}"] += count

    def add_unmatched(self, kind: str, /, **row: Any) -> None:
        """Строка, которую не удалось сопоставить (игрок, турнир, матч): пример с полями
        источника для ручного разбора."""
        self.counts[f"unmatched.{kind}"] += 1
        if self.counts[f"unmatched.{kind}"] <= MAX_EXAMPLES:
            self.unmatched.append({"kind": kind, **_jsonable(row)})

    def add_warning(self, key: str, /, **params: Any) -> None:
        """Предупреждение для отчета: текст из локали по ключу."""
        self.counts[f"warnings.{key}"] += 1
        if self.counts[f"warnings.{key}"] <= MAX_EXAMPLES:
            self.warnings.append(t(key, **params))

    def to_details(self) -> dict[str, Any]:
        """Отчет для ingestion_runs.details (JSONB)."""
        return {
            "rows_read": self.rows_read,
            "created": self.created,
            "updated": self.updated,
            "skipped": self.skipped,
            "unmatched": _jsonable(self.unmatched),
            "warnings": list(self.warnings),
            "files": dict(sorted(self.files.items())),
            "freshness": _jsonable(self.freshness),
            "counts": dict(sorted(self.counts.items())),
        }


@dataclass
class IngestRun:
    """Запуск загрузки: id строки ingestion_runs и отчет, который заполняет загрузчик
    (его можно и заменить: run.report = report)."""

    id: int
    source: str
    report: IngestReport = field(default_factory=IngestReport)


def _error_text(exc: BaseException) -> str:
    """Короткий текст ошибки без секретов: текст исключений базы и сети бывает с адресом
    и паролем, поэтому у них — только вид ошибки."""
    if isinstance(exc, IngestError):
        message = exc.message
    elif isinstance(exc, KeyboardInterrupt | asyncio.CancelledError):
        message = t("ingest.runs.interrupted")
    else:
        message = t("ingest.runs.unexpected", error=type(exc).__name__)
    return message[:ERROR_LIMIT]


async def _finish(
    db_factory: Callable[[], AsyncSession], run: IngestRun, *, error: str | None
) -> None:
    async with db_factory() as db:
        await db.execute(
            update(IngestionRun)
            .where(IngestionRun.id == run.id)
            .values(
                finished_at=func.now(),
                rows=run.report.rows,
                status="ok" if error is None else "failed",
                error=error,
                details=run.report.to_details(),
            )
        )
        await db.commit()


@asynccontextmanager
async def ingestion_run(
    db_factory: Callable[[], AsyncSession], source: str
) -> AsyncIterator[IngestRun]:
    """Строка ingestion_runs на время загрузки (см. docstring модуля). db_factory —
    фабрика сеансов БД (async_sessionmaker). Исключение из блока помечает запуск
    failed и летит дальше."""
    if source not in INGEST_SOURCES:
        raise ValueError(f"неизвестный источник загрузки: {source}")
    async with db_factory() as db:
        row = IngestionRun(source=source, status="running")
        db.add(row)
        await db.flush()
        run = IngestRun(id=row.id, source=source)
        await db.commit()
    try:
        yield run
    except GeneratorExit:
        raise
    except BaseException as exc:
        try:
            await _finish(db_factory, run, error=_error_text(exc))
        except Exception:
            # Итог не записан (например, нет связи с базой): исходная ошибка важнее
            log.exception("ingest.run_finish_failed", run_id=run.id, source=source)
        raise
    await _finish(db_factory, run, error=None)


async def last_ok_file_hashes(db: AsyncSession, source: str) -> dict[str, str]:
    """sha256 файлов из успешных запусков источника: путь → хеш из самого свежего
    успешного запуска, где этот файл был. Совпал хеш — файл не изменился, и разбирать
    его заново не нужно. Так файл старого года, загруженный один раз командой с --full,
    не разбирается каждую ночь, даже если ночной запуск его не трогал."""
    rows = await db.execute(
        text(
            "SELECT DISTINCT ON (f.key) f.key, f.value"
            " FROM ingestion_runs r, jsonb_each_text("
            "   CASE WHEN jsonb_typeof(r.details -> 'files') = 'object'"
            "   THEN r.details -> 'files' ELSE '{}'::jsonb END"
            " ) AS f"
            " WHERE r.source = :source AND r.status = 'ok'"
            " ORDER BY f.key, r.started_at DESC, r.id DESC"
        ),
        {"source": source},
    )
    return {str(key): str(value) for key, value in rows.all()}
