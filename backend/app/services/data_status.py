"""Свежесть архивов матчей: когда последний раз успешно загружались Сакманн и tennis-data.

Успешной считается загрузка, которая получила хотя бы один файл: запуск «ok» без единого
файла (источник отвечает 404 на файл текущего года, пустая папка) данные не обновил.
Архив устарел, если хотя бы один источник не загружался дольше STALE_AFTER (или не
загружался ни разу). Это правило — общее для уведомления data_stale администраторам
(app/workers/jobs.py) и пункта «Архив матчей не обновлялся» на главной.
"""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import IngestionRun, Match

# Загрузка архива старше — данные для анализа устарели
STALE_AFTER = timedelta(days=3)
STALE_SOURCES = ("sackmann", "tennis_data")
# Файл tennis-data администратор загружает раз в неделю, напоминание — в понедельник
# (app/workers/jobs.py, UPLOAD_REMINDER_WEEKDAY)
UPLOAD_WEEKDAY = 0
# Час напоминания «пора загрузить файл» по поясу администратора
UPLOAD_HOUR = 7
# Минута ночного обновления данных (час — CAPPER_DATA_UPDATE_HOUR_UTC): после очистки
# (:15) и не в начале часа, когда запускается больше всего чужих задач
DATA_UPDATE_MINUTE = 25


async def last_ok_loads(db: AsyncSession) -> dict[str, datetime | None]:
    """Время окончания последней успешной загрузки каждого архива (None — не было)."""
    files = IngestionRun.details["files"]
    rows = await db.execute(
        select(IngestionRun.source, func.max(IngestionRun.finished_at))
        .where(
            IngestionRun.source.in_(STALE_SOURCES),
            IngestionRun.status == "ok",
            func.jsonb_typeof(files) == "object",
            files != func.jsonb_build_object(),
        )
        .group_by(IngestionRun.source)
    )
    found: dict[str, datetime | None] = dict.fromkeys(STALE_SOURCES)
    for source, finished in rows.all():
        found[source] = finished
    return found


def is_stale(loads: dict[str, datetime | None], now: datetime) -> bool:
    """Хотя бы один архив не загружался дольше STALE_AFTER или ни разу."""
    return not all(when is not None and now - when <= STALE_AFTER for when in loads.values())


async def archive_matches_to(db: AsyncSession) -> date | None:
    """Последний день матча в архиве (Сакманн и tennis-data)."""
    found = await db.scalar(
        select(func.max(Match.match_date)).where(Match.source.in_(STALE_SOURCES))
    )
    return found if isinstance(found, date) else None


def next_upload_day(last_load: datetime | None, zone: ZoneInfo, today: date) -> date | None:
    """Когда ждать следующий файл tennis-data: понедельник после последней загрузки (по
    поясу zone). Он уже прошел — ближайший понедельник, начиная с сегодняшнего дня.
    Не загружали ни разу — None."""
    if last_load is None:
        return None
    loaded = last_load.astimezone(zone).date()
    ahead = (UPLOAD_WEEKDAY - loaded.weekday()) % 7 or 7
    day = loaded + timedelta(days=ahead)
    if day < today:
        day = today + timedelta(days=(UPLOAD_WEEKDAY - today.weekday()) % 7)
    return day
