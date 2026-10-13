"""Свежесть архивов матчей: когда последний раз успешно загружались Сакманн и tennis-data.

Успешной считается загрузка, которая получила хотя бы один файл: запуск «ok» без единого
файла (источник отвечает 404 на файл текущего года, пустая папка) данные не обновил.
Архив устарел, если хотя бы один источник не загружался дольше STALE_AFTER (или не
загружался ни разу). Это правило — общее для уведомления data_stale администраторам
(app/workers/jobs.py) и пункта «Архив матчей не обновлялся» на главной.
"""

from datetime import datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import IngestionRun

# Загрузка архива старше — данные для анализа устарели
STALE_AFTER = timedelta(days=3)
STALE_SOURCES = ("sackmann", "tennis_data")
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
