"""Загрузка файла tennis-data на сайте (этап 5, В1): «Администрирование → Данные».

Отчет загрузки — без сумм, исходов и имен участников (Р14): только сколько ставок
рассчитано и у скольких участников. Игроки и день есть только у матчей, которые нужно
разобрать руками (несколько кандидатов, конфликт слияния); матчи «нет в архиве» — только
числом: по ним видно, на что ставили участники.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel

UploadStatus = Literal["queued", "running", "done", "failed"]
UploadStep = Literal["tennis_data", "players_link", "elo", "settle"]
StepStatus = Literal["ok", "failed", "skipped"]
UnlinkedReason = Literal["ambiguous", "conflict"]


class UploadStepOut(BaseModel):
    """Шаг обработки файла и его итог; error — текст ошибки шага."""

    step: UploadStep
    status: StepStatus
    error: str | None


class UnlinkedMatchOut(BaseModel):
    """Матч из анализов, который не привязан к архиву и ждет разбора командой
    matches-merge: id матча, игроки, день ввода и причина (несколько кандидатов, конфликт
    слияния)."""

    match_id: int
    player1: str
    player2: str
    day: date
    reason: UnlinkedReason


class DataUploadReportOut(BaseModel):
    """Отчет загрузки. file_rows — строк матчей в файле; unchanged — файл тот же, что в
    прошлый раз (новых матчей нет); new_matches, updated_matches — матчи архива;
    matches_to — последний день матча в архиве после загрузки. settled_bets у people
    участников (legs событий); closing — событий П1/П2 с закрытием из архива; linked,
    waiting, unlinked — матчи из анализов: привязаны, ждут следующего файла, не
    привязаны; из непривязанных not_found — нет в архиве (только числом), остальные (до
    50) — в unlinked_matches; conflicts — расхождения архива с ручным расчетом (деньги не
    меняли); manual — снятие, неявка, неполный счет или нога на прошлой встрече пары
    (исход вносит участник); legacy_legs — исходы событий экспрессов старого бота."""

    file_rows: int | None
    unchanged: bool
    new_matches: int
    updated_matches: int
    matches_to: date | None
    settled_bets: int
    people: int
    legs: int
    closing: int
    linked: int
    waiting: int
    unlinked: int
    not_found: int
    unlinked_matches: list[UnlinkedMatchOut]
    conflicts: int
    manual: int
    legacy_legs: int
    steps: list[UploadStepOut]


class DataUploadOut(BaseModel):
    """Загрузка файла: кто и когда загрузил, размер, год (None — в имени файла его нет, и
    воркер еще не взял его по датам строк), статус и шаг в работе, отчет (когда готов) и
    ошибка."""

    id: int
    created_at: datetime
    filename: str
    size_bytes: int
    year: int | None
    status: UploadStatus
    step: UploadStep | None
    uploaded_by: str | None
    started_at: datetime | None
    finished_at: datetime | None
    error: str | None
    report: DataUploadReportOut | None


class ArchiveFileStatusOut(BaseModel):
    """Свежесть файла tennis-data: последняя успешная загрузка архива (любым путем) и
    последний день матча в нем; next_upload — когда ждать следующий файл (понедельник
    после последней загрузки, прошел — ближайший с сегодняшнего дня, в поясе того, кто
    смотрит; то же правило, что у «ждет результата» в «Ставках»; не загружали — null);
    stale — не загружали дольше stale_days дней (тогда приходит напоминание); max_mb —
    предел размера файла."""

    last_load: datetime | None
    matches_to: date | None
    next_upload: date | None
    stale_days: int
    stale: bool
    max_mb: int


class DataUploadsOut(BaseModel):
    """«Администрирование → Данные»: свежесть архива и последние загрузки, новые сверху."""

    archive: ArchiveFileStatusOut
    uploads: list[DataUploadOut]
