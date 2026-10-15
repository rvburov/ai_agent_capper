"""Уроки (этап 5, волна 2): «Обучение модели → Уроки».

Уроки общие для всех участников (Р25): смотреть и предлагать может каждый, решения —
только администратор (быстрая проверка, включение и выключение; иначе 403). Свой урок
(user_id) видит только владелец, чужой — 404. Числа считает сервер (app/services/lessons.py,
lesson_check.py, lesson_quick.py). CSRF — как у всех изменяющих запросов.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Query, status

from app.core.deps import AdminUser, ClientIp, CurrentUser, DbSession
from app.schemas.lessons import (
    LessonDictionaryOut,
    LessonIn,
    LessonOut,
    LessonsOut,
    LessonStatus,
    QuickCheckOut,
)
from app.services import lesson_quick
from app.services import lessons as lessons_service

router = APIRouter(tags=["lessons"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


@router.get("/lessons")
async def list_lessons(
    user: CurrentUser,
    db: DbSession,
    lesson_status: Annotated[LessonStatus | None, Query(alias="status")] = None,
) -> LessonsOut:
    """Уроки (готовые к решению — первыми) и пороги из настроек: сколько в анализе и
    предел, своих случаев для проверки, усадка."""
    return await lessons_service.list_lessons(db, user, status=lesson_status)


@router.get("/lessons/dictionary")
async def lesson_dictionary(user: CurrentUser) -> LessonDictionaryOut:
    """Словарь признаков условия урока (форма «Предложить урок»)."""
    return lessons_service.dictionary_out()


@router.post("/lessons", status_code=status.HTTP_201_CREATED)
async def propose_lesson(body: LessonIn, user: CurrentUser, db: DbSession) -> LessonOut:
    """Предложить урок: гипотеза с условием из словаря, проверка — как у гипотез из
    разборов. Условие не из словаря — 422; такой урок уже есть — 409; участник — не больше
    5 в сутки (429)."""
    lesson = await lessons_service.propose(db, user, body)
    return await lessons_service.lesson_view(db, user, lesson)


@router.get("/lessons/{lesson_id}")
async def get_lesson(lesson_id: RowId, user: CurrentUser, db: DbSession) -> LessonOut:
    """Урок: условие, основание, проверка на архиве и быстрая проверка."""
    return await lessons_service.lesson_detail(db, user, lesson_id)


@router.get("/lessons/{lesson_id}/quick-check")
async def quick_check_preview(lesson_id: RowId, admin: AdminUser, db: DbSession) -> QuickCheckOut:
    """Быстрая проверка до запуска: матчей, запросов, цена по живым числам, худший случай
    и остаток бюджета проверок; можно ли запустить и почему нет. Только администратор."""
    return await lesson_quick.preview(db, lesson_id)


@router.post("/lessons/{lesson_id}/quick-check", status_code=status.HTTP_202_ACCEPTED)
async def quick_check_start(
    lesson_id: RowId, admin: AdminUser, db: DbSession, ip: ClientIp
) -> QuickCheckOut:
    """Запустить быструю проверку (Batch, из бюджета проверок): ход — в GET урока
    (quick). Нельзя — 409 с причиной; очередь недоступна — 503. Только администратор."""
    return await lesson_quick.start(db, admin, lesson_id, ip=ip)


@router.post("/lessons/{lesson_id}/enable")
async def enable_lesson(
    lesson_id: RowId, admin: AdminUser, db: DbSession, ip: ClientIp
) -> LessonOut:
    """«Использовать в анализе»: урок проверен на архиве и быстрой проверкой, в анализе
    меньше предела (409 иначе). Только администратор."""
    lesson = await lessons_service.enable(db, admin, lesson_id, ip=ip)
    return await lessons_service.lesson_view(db, admin, lesson)


@router.post("/lessons/{lesson_id}/disable")
async def disable_lesson(
    lesson_id: RowId, admin: AdminUser, db: DbSession, ip: ClientIp
) -> LessonOut:
    """Выключить урок из анализа; включить снова — после новой быстрой проверки. Только
    администратор."""
    lesson = await lessons_service.disable(db, admin, lesson_id, ip=ip)
    return await lessons_service.lesson_view(db, admin, lesson)


@router.post("/lessons/{lesson_id}/notify-when-ready")
async def notify_when_ready(lesson_id: RowId, user: CurrentUser, db: DbSession) -> LessonOut:
    """«Сообщить, когда наберется»: уведомление на сайте, когда гипотезу проверят. Урок
    уже проверен — 409."""
    lesson = await lessons_service.watch(db, user, lesson_id)
    return await lessons_service.lesson_view(db, user, lesson)
