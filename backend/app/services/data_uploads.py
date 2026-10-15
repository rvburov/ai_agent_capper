"""Загрузка файла tennis-data ГОД.xlsx на сайте (этап 5, В1, Р25).

Сайт tennis-data.co.uk не отдает файлы программе (403), поэтому раз в неделю
администратор скачивает файл года в браузере и загружает его в «Администрирование →
Данные». Маршрут (POST /api/admin/data/tennis-data) проверяет файл быстро и без разбора
таблицы: размер не больше MAX_BYTES (413), .xlsx, архив zip, распакованный размер и число
строк листа в пределах (app/ingest/tennis_data.py, inspect_xlsx), год из имени файла в
пределах архива; иначе 422. Принятый файл ложится в data_uploads (вместе с самим файлом:
API и воркер — разные контейнеры), в журнал администратора — data_upload, а обработку
ставит задача воркера process_data_upload.

Разбор таблицы — только в воркере: openpyxl на неудачном файле занимает гигабайты памяти и
минуты процессора, и процесс API от этого не должен падать. Воркер читает лист с пределами
(read_sheet: MAX_COLUMNS колонок, MAX_ROWS строк), берет год по датам строк, если его нет
в имени, и проходит шаги обновления данных без Сакманна (app/ingest/update.py, run_update
с only): tennis-data из этого файла, привязка старого бота, Эло, расчет по архиву
(привязка матчей из анализов, закрытие, авторасчет). Шаг в работе — в data_uploads.step:
экран опрашивает GET /api/admin/data/uploads/{id}. Неверный файл — failed с текстом
ошибки.

Если идет ночное обновление (общая блокировка), загрузка снова ждет в очереди, и задача
повторится позже; ждет дольше QUEUE_WAIT — failed («обновление не закончилось»). Ошибка
или снятие задачи посреди обработки — failed с текстом, файл стирается. Воркер упал и не
вернулся (загрузка в running дольше PROCESS_TIMEOUT_SECONDS) — повтор задачи берет ее
заново; задача потеряна совсем — уборщик (reap_stuck_uploads, раз в час) ставит failed.
Повторная загрузка того же файла ничего не ломает: загрузчик узнает его по sha256 и не
разбирает («новых матчей нет»), а расчет по архиву ничего не считает второй раз. После
обработки файл стирается, остается отчет (без сумм и имен участников, Р14).

Команда терминала с тем же кодом: python -m app.admin.cli data-upload ФАЙЛ
(bash deploy/local.sh upload ФАЙЛ).
"""

import asyncio
import hashlib
import re
import tempfile
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from typing import Any

import structlog
from pydantic import ValidationError
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import defer

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.formatting import format_int
from app.core.i18n import t
from app.db.models import DataUpload, IngestionRun, Match, User
from app.ingest import tennis_data
from app.ingest.runs import IngestError
from app.ingest.update import Step, UpdateResult, run_update
from app.schemas.data_uploads import (
    ArchiveFileStatusOut,
    DataUploadOut,
    DataUploadReportOut,
    DataUploadsOut,
    UnlinkedMatchOut,
    UploadStepOut,
)
from app.services.access_codes import person_name
from app.services.audit import write_audit
from app.services.data_status import last_ok_loads
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

MAX_MB = 10
MAX_BYTES = MAX_MB * 2**20
UPLOAD_JOB = "process_data_upload"
# Шаги обработки файла: Сакманн заморожен и грузится ночью
UPLOAD_STEPS: tuple[Step, ...] = ("tennis_data", "players_link", "elo", "settle")
# Файл не загружали дольше — напоминание администратору (В1: раз в неделю)
STALE_DAYS = 7
LIST_LIMIT = 20
# Через сколько секунд повторить загрузку, если идет ночное обновление
BUSY_RETRY_SECONDS = 120
# Предел задачи воркера (загрузка, привязка, Эло по всей истории и расчет) — час. Загрузка
# в running дольше — воркер упал посреди нее: повтор задачи берет ее заново
PROCESS_TIMEOUT_SECONDS = 3600
# Сколько загрузка может ждать конца ночного обновления (меньше, чем повторов у задачи:
# 30 раз по 2 минуты)
QUEUE_WAIT = timedelta(minutes=50)
# Уборщик: running дольше предела задачи с запасом, queued дольше QUEUE_LIMIT — задачу
# уже никто не выполнит
RUNNING_LIMIT = timedelta(seconds=PROCESS_TIMEOUT_SECONDS) + timedelta(minutes=30)
QUEUE_LIMIT = timedelta(hours=2)
_YEAR = re.compile(r"(?<!\d)(20\d{2})(?!\d)")


# --- прием файла ---


def example_year(now: datetime | None = None) -> int:
    """Год для подсказок в текстах («скачайте 2026.xlsx»): текущий."""
    return (now or datetime.now(UTC)).year


def _year_from_name(filename: str) -> int | None:
    """Год из имени файла: «2026.xlsx», «2026 (1).xlsx»."""
    found = _YEAR.search(Path(filename).name)
    return int(found.group(1)) if found else None


def _year_from_rows(sheet: tennis_data.Sheet) -> int | None:
    index = sheet.columns.get("date")
    if index is None:
        return None
    for _, values in sheet.rows:
        day = tennis_data.to_date(values[index]) if index < len(values) else None
        if day is not None:
            return day.year
    return None


def _check_year(year: int) -> None:
    """Год вне архива — 422."""
    first, last = get_settings().tennis_data_first_year, datetime.now(UTC).year
    if not first <= year <= last:
        raise AppError(422, "upload.year_range", year=year, first=first, last=last)


def _file_error(exc: IngestError) -> AppError:
    """Ошибка разбора файла → ошибка загрузки (422) с текстом из локали."""
    if exc.key == "ingest_tennis_data.errors.too_many_rows":
        return AppError(422, "upload.too_many_rows", limit=format_int(tennis_data.MAX_ROWS))
    if exc.key == "ingest_tennis_data.errors.too_big_unpacked":
        return AppError(422, "upload.too_big_unpacked", limit=tennis_data.MAX_UNPACKED_MB)
    return AppError(422, "upload.bad_file", reason=exc.message)


def check_file(filename: str, content: bytes) -> int | None:
    """Быстрая проверка в процессе API, без разбора таблицы: размер, .xlsx, архив и его
    пределы (inspect_xlsx), год из имени. Возвращает год из имени (None — год возьмет
    воркер по датам строк). Ошибка — AppError (413 или 422)."""
    if len(content) > MAX_BYTES:
        raise AppError(413, "upload.too_large", limit=MAX_MB, year=example_year())
    if not content:
        raise AppError(422, "upload.empty", year=example_year())
    if not filename.lower().endswith(".xlsx"):
        raise AppError(422, "upload.not_xlsx", year=example_year())
    try:
        tennis_data.inspect_xlsx(content, filename)
    except IngestError as exc:
        raise _file_error(exc) from None
    year = _year_from_name(filename)
    if year is not None:
        _check_year(year)
    return year


def read_file(filename: str, content: bytes, year: int | None) -> tuple[int, int]:
    """Разбор таблицы (в воркере): лист с пределами, год — из имени, иначе по первой дате
    в строках. Возвращает год и число строк матчей. Ошибка — AppError (422)."""
    try:
        sheet = tennis_data.read_sheet(content, filename)
    except IngestError as exc:
        raise _file_error(exc) from None
    if year is None:
        year = _year_from_rows(sheet)
        if year is None:
            raise AppError(422, "upload.year_unknown", year=example_year())
        _check_year(year)
    return year, len(sheet.rows)


async def create_upload(
    db: AsyncSession, *, actor: User | None, ip: str | None, filename: str, content: bytes
) -> DataUpload:
    """Принять файл (check_file в потоке: распаковка листа для подсчета строк — до долей
    секунды), записать загрузку и журнал администратора. actor None — команда терминала.
    Делает commit; задачу ставит вызывающий (enqueue_upload)."""
    name = Path(filename.replace("\\", "/")).name[:255] or "tennis-data.xlsx"
    year = await asyncio.to_thread(check_file, name, content)
    upload = DataUpload(
        uploaded_by=actor.id if actor is not None else None,
        filename=name,
        size_bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        year=year,
        content=content,
        report={},
    )
    db.add(upload)
    await db.flush()
    await write_audit(
        db,
        action="data_upload",
        actor_id=actor.id if actor is not None else None,
        details={
            "upload_id": upload.id,
            "filename": name,
            "size_bytes": len(content),
            "year": year,
        },
        ip=ip,
    )
    await db.commit()
    return upload


async def enqueue_upload(upload_id: int) -> None:
    """Задача воркера process_data_upload (одна на загрузку). Очередь недоступна — 503,
    загрузка помечается failed: файл нужно отправить еще раз."""
    # Модуль воркера тянет загрузчики данных: API грузит его при первой загрузке
    from app.workers.main import create_queue_pool

    pool = await create_queue_pool(retries=1)
    try:
        await pool.enqueue_job(UPLOAD_JOB, upload_id, _job_id=f"{UPLOAD_JOB}:{upload_id}")
    finally:
        await pool.aclose()


async def mark_failed(db: AsyncSession, upload_id: int, error: str) -> None:
    await db.execute(
        update(DataUpload)
        .where(DataUpload.id == upload_id)
        .values(status="failed", step=None, content=None, error=error, finished_at=func.now())
    )
    await db.commit()


# --- обработка воркером ---


async def _claim(factory: Callable[[], AsyncSession], upload_id: int) -> DataUpload | None:
    """Взять загрузку в работу: ждущую в очереди или брошенную упавшим воркером (running
    дольше предела задачи). Иначе (уже идет, готова, повтор задачи) — ничего."""
    abandoned = utcnow() - timedelta(seconds=PROCESS_TIMEOUT_SECONDS)
    async with factory() as db:
        upload = await db.scalar(
            select(DataUpload)
            .where(
                DataUpload.id == upload_id,
                or_(
                    DataUpload.status == "queued",
                    and_(DataUpload.status == "running", DataUpload.started_at < abandoned),
                ),
            )
            .with_for_update(skip_locked=True)
        )
        if upload is None or upload.content is None:
            return None
        upload.status = "running"
        upload.started_at = utcnow()
        upload.step = None
        upload.error = None
        await db.commit()
        return upload


async def _set_step(factory: Callable[[], AsyncSession], upload_id: int, step: Step) -> None:
    async with factory() as db:
        await db.execute(update(DataUpload).where(DataUpload.id == upload_id).values(step=step))
        await db.commit()


async def _run_details(db: AsyncSession, run_id: int | None) -> dict[str, Any]:
    if run_id is None:
        return {}
    details = await db.scalar(select(IngestionRun.details).where(IngestionRun.id == run_id))
    return details if isinstance(details, dict) else {}


def _count(details: dict[str, Any], *keys: str) -> int:
    counts = details.get("counts")
    if not isinstance(counts, dict):
        return 0
    return sum(int(counts.get(key) or 0) for key in keys)


async def _report(db: AsyncSession, file_rows: int, result: UpdateResult) -> dict[str, Any]:
    """Отчет загрузки по журналам шагов (ingestion_runs) — без сумм и имен участников.
    Игроки и день — только у матчей, которые нужно разобрать руками; «нет в архиве» —
    числом (Р14: по ним видно, на что ставили участники)."""
    steps = {step.step: step for step in result.steps}
    loaded = await _run_details(db, steps["tennis_data"].run_id if "tennis_data" in steps else None)
    settled = await _run_details(db, steps["settle"].run_id if "settle" in steps else None)
    matches_to = await db.scalar(
        select(func.max(Match.match_date)).where(Match.source.in_(("sackmann", "tennis_data")))
    )
    unlinked = [
        {key: row.get(key) for key in ("match_id", "player1", "player2", "day")}
        | {"reason": row.get("kind")}
        for row in settled.get("unmatched") or []
        if isinstance(row, dict) and row.get("kind") in ("ambiguous", "conflict")
    ]
    return {
        "file_rows": file_rows,
        "unchanged": _count(loaded, "files.unchanged") > 0,
        "new_matches": _count(loaded, "matches.created"),
        "updated_matches": _count(loaded, "matches.updated", "matches.dated"),
        "matches_to": matches_to.isoformat() if isinstance(matches_to, date) else None,
        "settled_bets": _count(settled, "bets.settled"),
        "people": _count(settled, "bets.people"),
        "legs": _count(settled, "bets.legs"),
        "closing": _count(settled, "closing.legs"),
        "linked": _count(settled, "matches.linked"),
        "waiting": _count(settled, "matches.waiting"),
        "unlinked": _count(settled, "matches.unlinked"),
        "not_found": _count(settled, "matches.not_found"),
        "unlinked_matches": unlinked,
        "conflicts": _count(settled, "bets.conflicts"),
        "manual": _count(settled, "bets.manual"),
        "legacy_legs": _count(settled, "legacy.legs"),
        "steps": [
            {"step": step.step, "status": step.status, "error": step.error}
            for step in result.steps
            if step.step in UPLOAD_STEPS
        ],
    }


async def _fail(factory: Callable[[], AsyncSession], upload_id: int, error: str) -> None:
    """failed с текстом ошибки; сбой самой записи — только в лог (исходная ошибка важнее)."""
    try:
        async with factory() as db:
            await mark_failed(db, upload_id, error)
    except Exception:
        log.exception("data_upload.mark_failed", upload_id=upload_id)


async def process_upload(factory: Callable[[], AsyncSession], upload_id: int) -> str:
    """Обработать загрузку (см. docstring модуля). Возвращает итог: done, failed, busy
    (идет другое обновление — загрузка снова в очереди) или skipped (уже не в очереди).
    Исключение или снятие задачи — failed с текстом, исключение идет дальше."""
    upload = await _claim(factory, upload_id)
    if upload is None:
        return "skipped"
    try:
        return await _process(factory, upload)
    except BaseException as exc:
        await _fail(factory, upload_id, t("errors.upload.crashed", error=type(exc).__name__))
        log.warning("data_upload.crashed", upload_id=upload_id, error=type(exc).__name__)
        raise


async def _process(factory: Callable[[], AsyncSession], upload: DataUpload) -> str:
    upload_id = upload.id
    assert upload.content is not None
    try:
        year, file_rows = await asyncio.to_thread(
            read_file, upload.filename, upload.content, upload.year
        )
    except AppError as exc:
        await _fail(factory, upload_id, exc.message)
        log.info("data_upload.done", upload_id=upload_id, status="failed")
        return "failed"
    async with factory() as db:
        await db.execute(
            update(DataUpload)
            .where(DataUpload.id == upload_id)
            .values(year=year, report={"file_rows": file_rows})
        )
        await db.commit()

    async def on_step(step: Step) -> None:
        await _set_step(factory, upload_id, step)

    with tempfile.TemporaryDirectory(prefix="tennis-data-") as folder:
        target = Path(folder) / str(year) / f"{year}.xlsx"
        target.parent.mkdir(parents=True)
        await asyncio.to_thread(target.write_bytes, upload.content)
        result = await run_update(
            years=[year],
            tennis_data_dir=folder,
            db_factory=factory,
            only=UPLOAD_STEPS,
            on_step=on_step,
        )
    async with factory() as db:
        if result.busy:
            if utcnow() - upload.created_at > QUEUE_WAIT:
                await mark_failed(db, upload_id, t("errors.upload.queue_timeout"))
                return "failed"
            await db.execute(
                update(DataUpload)
                .where(DataUpload.id == upload_id)
                .values(status="queued", step=None, started_at=None)
            )
            await db.commit()
            return "busy"
        report = await _report(db, file_rows, result)
        failed = [step for step in result.steps if step.status == "failed"]
        status = "failed" if failed else "done"
        await db.execute(
            update(DataUpload)
            .where(DataUpload.id == upload_id)
            .values(
                status=status,
                step=None,
                content=None,
                report=report,
                error=failed[0].error if failed else None,
                finished_at=func.now(),
            )
        )
        await db.commit()
    log.info("data_upload.done", upload_id=upload_id, status=status)
    return status


async def reap_stuck_uploads(db: AsyncSession, *, now: datetime | None = None) -> list[int]:
    """Загрузки, которые уже никто не доделает (см. docstring модуля): running дольше
    RUNNING_LIMIT и queued дольше QUEUE_LIMIT — failed с текстом, файл стирается.
    Возвращает их id. Делает commit."""
    moment = now or utcnow()
    stuck = list(
        await db.execute(
            select(DataUpload.id, DataUpload.status)
            .where(
                or_(
                    and_(
                        DataUpload.status == "running",
                        DataUpload.started_at < moment - RUNNING_LIMIT,
                    ),
                    and_(
                        DataUpload.status == "queued",
                        DataUpload.created_at < moment - QUEUE_LIMIT,
                    ),
                )
            )
            .order_by(DataUpload.id)
            .with_for_update(skip_locked=True)
        )
    )
    for upload_id, status in stuck:
        key = "worker_lost" if status == "running" else "queue_timeout"
        await db.execute(
            update(DataUpload)
            .where(DataUpload.id == upload_id)
            .values(
                status="failed",
                step=None,
                content=None,
                error=t(f"errors.upload.{key}"),
                finished_at=func.now(),
            )
        )
    await db.commit()
    return [int(upload_id) for upload_id, _ in stuck]


# --- чтение ---


def _report_out(upload: DataUpload) -> DataUploadReportOut | None:
    if upload.status != "done" and upload.status != "failed":
        return None
    data = upload.report or {}
    if "steps" not in data:
        return None
    try:
        unlinked = [UnlinkedMatchOut.model_validate(row) for row in data["unlinked_matches"]]
        steps = [UploadStepOut.model_validate(row) for row in data["steps"]]
        return DataUploadReportOut.model_validate(
            {**data, "unlinked_matches": unlinked, "steps": steps}
        )
    except (KeyError, ValidationError):
        return None


def upload_out(upload: DataUpload, names: dict[int, str]) -> DataUploadOut:
    return DataUploadOut(
        id=upload.id,
        created_at=upload.created_at,
        filename=upload.filename,
        size_bytes=upload.size_bytes,
        year=upload.year,
        status=upload.status,  # type: ignore[arg-type]
        step=upload.step,  # type: ignore[arg-type]
        uploaded_by=names.get(upload.uploaded_by) if upload.uploaded_by is not None else None,
        started_at=upload.started_at,
        finished_at=upload.finished_at,
        error=upload.error,
        report=_report_out(upload),
    )


async def _names(db: AsyncSession, uploads: list[DataUpload]) -> dict[int, str]:
    ids = {upload.uploaded_by for upload in uploads if upload.uploaded_by is not None}
    if not ids:
        return {}
    rows = await db.execute(select(User.id, User.display_name, User.status).where(User.id.in_(ids)))
    return {int(uid): person_name(uid, name, status) for uid, name, status in rows}


async def get_upload(db: AsyncSession, upload_id: int) -> DataUploadOut:
    upload = await db.scalar(
        select(DataUpload)
        .where(DataUpload.id == upload_id)
        .options(defer(DataUpload.content))
        .execution_options(populate_existing=True)
    )
    if upload is None:
        raise AppError(404, "upload.not_found")
    return upload_out(upload, await _names(db, [upload]))


async def archive_status(db: AsyncSession, now: datetime | None = None) -> ArchiveFileStatusOut:
    """Свежесть файла tennis-data: последняя успешная загрузка и последний день матча."""
    moment = now or utcnow()
    last = (await last_ok_loads(db)).get("tennis_data")
    matches_to = await db.scalar(
        select(func.max(Match.match_date)).where(Match.source.in_(("sackmann", "tennis_data")))
    )
    return ArchiveFileStatusOut(
        last_load=last,
        matches_to=matches_to if isinstance(matches_to, date) else None,
        stale_days=STALE_DAYS,
        stale=last is None or moment - last > timedelta(days=STALE_DAYS),
        max_mb=MAX_MB,
    )


async def list_uploads(db: AsyncSession) -> DataUploadsOut:
    uploads = list(
        await db.scalars(
            select(DataUpload)
            .options(defer(DataUpload.content))
            .order_by(DataUpload.created_at.desc(), DataUpload.id.desc())
            .limit(LIST_LIMIT)
        )
    )
    names = await _names(db, uploads)
    return DataUploadsOut(
        archive=await archive_status(db),
        uploads=[upload_out(upload, names) for upload in uploads],
    )
