"""Данные архива в кабинете администратора: /api/admin/data/* (этап 5, В1).

Только роль admin (зависимость на уровне роутера): без сеанса — 401, участнику — 403.
Загрузка файла tennis-data — тело запроса и есть файл (application/octet-stream или тип
xlsx), имя файла — в параметре filename: так не нужен разбор multipart. 2FA не нужен
(сводка этапа 5, 6.3): файл ничего не удаляет, повторная загрузка ничего не ломает.
Р14: в ответах нет сумм, исходов и имен участников.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.deps import AdminUser, ClientIp, DbSession, require_admin
from app.core.errors import AppError
from app.core.i18n import t
from app.schemas.data_uploads import DataUploadOut, DataUploadsOut
from app.services import data_uploads

router = APIRouter(prefix="/admin/data", tags=["admin"], dependencies=[Depends(require_admin)])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]
XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
_FILE_BODY = {
    "requestBody": {
        "required": True,
        "content": {
            media: {"schema": {"type": "string", "format": "binary"}}
            for media in (XLSX_TYPE, "application/octet-stream")
        },
    }
}


async def _read_body(request: Request) -> bytes:
    """Тело запроса не больше MAX_BYTES: заявленный размер больше — 413 сразу, без
    чтения; иначе читается по частям и обрывается на пределе."""
    declared = request.headers.get("content-length", "")
    if declared.isdigit() and int(declared) > data_uploads.MAX_BYTES:
        raise AppError(
            413, "upload.too_large", limit=data_uploads.MAX_MB, year=data_uploads.example_year()
        )
    chunks: list[bytes] = []
    size = 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > data_uploads.MAX_BYTES:
            raise AppError(
                413,
                "upload.too_large",
                limit=data_uploads.MAX_MB,
                year=data_uploads.example_year(),
            )
        chunks.append(chunk)
    return b"".join(chunks)


async def _enqueue(db: AsyncSession, upload_id: int) -> None:
    try:
        await data_uploads.enqueue_upload(upload_id)
    except Exception as exc:
        # Очередь недоступна (Redis): загрузка не обработается, файл нужно отправить снова
        await data_uploads.mark_failed(db, upload_id, t("errors.upload.queue_unavailable"))
        raise AppError(503, "upload.queue_unavailable") from exc


@router.post("/tennis-data", status_code=status.HTTP_202_ACCEPTED, openapi_extra=_FILE_BODY)
async def upload_tennis_data(
    request: Request,
    db: DbSession,
    admin: AdminUser,
    ip: ClientIp,
    filename: Annotated[str, Query(min_length=1, max_length=255)],
) -> DataUploadOut:
    """Загрузить файл tennis-data ГОД.xlsx (до 10 МБ): быстрая проверка сразу, разбор
    таблицы и обработка — задачей воркера. Ответ — загрузка в очереди; ход и отчет — GET
    …/uploads/{id}. Файл больше 10 МБ — 413; не xlsx, распакованный больше 100 МБ, больше
    20 000 строк или год вне архива — 422. Нет нужных колонок — загрузка failed с текстом."""
    content = await _read_body(request)
    upload = await data_uploads.create_upload(
        db, actor=admin, ip=ip, filename=filename, content=content
    )
    await _enqueue(db, upload.id)
    return await data_uploads.get_upload(db, upload.id)


@router.get("/uploads")
async def list_uploads(db: DbSession) -> DataUploadsOut:
    """Свежесть файла tennis-data и последние 20 загрузок, новые сверху."""
    return await data_uploads.list_uploads(db)


@router.get("/uploads/{upload_id}")
async def get_upload(db: DbSession, upload_id: RowId) -> DataUploadOut:
    """Загрузка: статус, шаг в работе и отчет (когда готов). Нет такой — 404."""
    return await data_uploads.get_upload(db, upload_id)
