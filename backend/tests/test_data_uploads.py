"""Загрузка файла tennis-data на сайте (этап 5, В1): права, проверка файла (413, 422),
обработка воркером (новые матчи, привязка, авторасчет), повторная загрузка того же файла
ничего не меняет, ожидание ночного обновления, команда терминала с тем же кодом. Отчет
загрузки — без сумм и имен участников (Р14)."""

import asyncio
import json
import re
import zipfile
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from io import BytesIO
from pathlib import Path
from typing import Any

import pytest
from arq import Retry
from sqlalchemy import select, text, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import cli
from app.db.models import (
    Bet,
    BetLeg,
    DataUpload,
    IngestionRun,
    Match,
    Notification,
    Player,
    User,
)
from app.db.session import create_sessionmaker
from app.ingest import tennis_data
from app.ingest.runs import UPDATE_LOCK_KEY, IngestError
from app.services import data_uploads
from app.workers import jobs
from tests.helpers_admin import Signed, admin_signed_in, audit_entries, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec, ledger_rows
from tests.support import ClientFactory, LoginFn, UserFactory
from tests.tennis_data_files import make_row, xlsx

D = Decimal
DAY = date(2026, 10, 4)
URL = "/api/admin/data/tennis-data"
XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
Factory = Callable[[], AsyncSession]


@pytest.fixture
async def admin(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await admin_signed_in(make_client, make_user, login, display_name="Роман")


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login, email="olga@example.com")


@pytest.fixture
def factory(engine: AsyncEngine) -> Factory:
    return create_sessionmaker(engine)


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Задачи воркера, которые поставил бы маршрут (без очереди)."""
    found: list[int] = []

    async def enqueue(upload_id: int) -> None:
        found.append(upload_id)

    monkeypatch.setattr(data_uploads, "enqueue_upload", enqueue)
    return found


def _file() -> bytes:
    """2026.xlsx: один сыгранный матч основного тура (Синнер — Алькарас 6:4 6:3) с кэфами
    Pinnacle."""
    row = make_row(
        50,
        "Archive Cup",
        datetime(2026, 10, 4),
        "Sinner J.",
        "Alcaraz C.",
        round_label="Quarterfinals",
        odds={"PSW": 1.62, "PSL": 2.45, "AvgW": 1.58, "AvgL": 2.38},
    )
    return xlsx([row])


async def _upload(
    signed: Signed, content: bytes, filename: str = "2026.xlsx", media: str = XLSX
) -> Any:
    return await signed.client.post(
        URL, params={"filename": filename}, content=content, headers={"Content-Type": media}
    )


async def _bet_on_file_match(db: AsyncSession, member: Signed) -> Bet:
    """Ставка участника на матч из ввода тех же игроков (их имена в файле — псевдонимы)."""
    maker = BetMaker(db)
    bet = await maker.bet(
        member.user,
        [
            LegSpec(
                tournament=None,
                match_day=DAY,
                odds="1.70",
                names=("Jannik Sinner", "Carlos Alcaraz"),
            )
        ],
        stake="250",
        placed_at=datetime(2026, 10, 4, 8, tzinfo=UTC),
    )
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bet.id))
    assert leg is not None
    match = await db.get_one(Match, leg.match_id)
    for player_id, alias in ((match.player1_id, "Sinner J."), (match.player2_id, "Alcaraz C.")):
        await db.execute(update(Player).where(Player.id == player_id).values(aliases=[alias]))
    await db.commit()
    return bet


async def test_upload_permissions_and_bad_files(
    admin: Signed,
    member: Signed,
    db: AsyncSession,
    factory: Factory,
    queued: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Участнику — 403; неверный файл — 422 с причиной, большой — 413; загрузка не
    создается и задача не ставится. Таблицу API не разбирает: файл без нужных колонок или
    без года принимается, а воркер ставит failed с текстом."""
    denied = await _upload(member, _file())
    assert denied.status_code == 403 and error_code(denied) == "common.forbidden"

    cases = [
        (b"<html>Just a moment...</html>", "2026.xlsx", "upload.not_xlsx"),
        (b"PK\x03\x04 broken zip", "2026.xlsx", "upload.unreadable"),
        (b"plain text, not a zip", "2026.xlsx", "upload.unreadable"),
        (_file(), "2026.csv", "upload.not_xlsx"),
        (b"", "2026.xlsx", "upload.empty"),
        (_file(), "2010.xlsx", "upload.year_range"),
    ]
    for content, name, code in cases:
        response = await _upload(admin, content, name)
        assert response.status_code == 422, (name, response.text)
        assert error_code(response) == code, name
        # Текст — только по-русски из локали, без причины на английском (№5)
        message = response.json()["error"]["message"]
        plain = re.sub(r"tennis-data(\.co\.uk)?|xlsx", "", message)
        assert not re.search(r"[A-Za-z]{3,}", plain), message
    no_name = await admin.client.post(URL, content=_file(), headers={"Content-Type": XLSX})
    assert no_name.status_code == 422
    # Имя файла в подсказке — от текущего года, а не зашито в текст
    hint = await _upload(admin, _file(), "2026.csv")
    assert f"{datetime.now(UTC).year}.xlsx" in hint.json()["error"]["message"]

    monkeypatch.setattr(data_uploads, "MAX_BYTES", 1000)
    too_big = await _upload(admin, _file())
    assert too_big.status_code == 413 and error_code(too_big) == "upload.too_large"
    monkeypatch.undo()

    assert await db.scalar(select(DataUpload.id)) is None
    assert queued == []
    # Год — из дат строк, если в имени его нет: его берет воркер
    by_rows = await _upload(admin, _file(), "tennis-data (1).xlsx")
    assert by_rows.status_code == 202 and by_rows.json()["year"] is None
    assert await data_uploads.process_upload(factory, by_rows.json()["id"]) == "done"
    shown = (await admin.client.get(f"/api/admin/data/uploads/{by_rows.json()['id']}")).json()
    assert shown["year"] == 2026 and shown["report"]["file_rows"] == 1

    # Нет нужных колонок, нет ни года в имени, ни дат: принято, воркер — failed с текстом
    for content, name, words in (
        (xlsx([], ["Name", "Value"]), "2026.xlsx", "нет строки заголовков"),
        (xlsx([]), "results.xlsx", "Не удалось понять год файла"),
    ):
        response = await _upload(admin, content, name)
        assert response.status_code == 202, response.text
        upload_id = response.json()["id"]
        assert await data_uploads.process_upload(factory, upload_id) == "failed"
        failed = (await admin.client.get(f"/api/admin/data/uploads/{upload_id}")).json()
        assert failed["status"] == "failed" and words in failed["error"], failed
        content_left = await db.scalar(select(DataUpload.content).where(DataUpload.id == upload_id))
        assert content_left is None


async def test_upload_settles_bets_and_repeat_is_idempotent(
    admin: Signed, member: Signed, db: AsyncSession, factory: Factory, queued: list[int]
) -> None:
    bet = await _bet_on_file_match(db, member)
    # Один и тот же файл: openpyxl пишет в файл время создания, поэтому байты — один раз
    content = _file()
    response = await _upload(admin, content)
    assert response.status_code == 202, response.text
    created = response.json()
    assert created["status"] == "queued" and created["year"] == 2026
    assert created["filename"] == "2026.xlsx" and created["report"] is None
    assert created["uploaded_by"] == "Роман"
    assert queued == [created["id"]]
    [entry] = await audit_entries(db, "data_upload")
    assert entry.actor_id == admin.id
    assert entry.details == {
        "upload_id": created["id"],
        "filename": "2026.xlsx",
        "size_bytes": len(content),
        "year": 2026,
    }

    assert await data_uploads.process_upload(factory, created["id"]) == "done"
    done = (await admin.client.get(f"/api/admin/data/uploads/{created['id']}")).json()
    assert done["status"] == "done" and done["error"] is None and done["step"] is None
    report = done["report"]
    assert report["file_rows"] == 1 and report["unchanged"] is False
    assert report["new_matches"] == 1 and report["matches_to"] == "2026-10-04"
    assert (report["settled_bets"], report["people"], report["legs"]) == (1, 1, 1)
    assert (report["closing"], report["linked"], report["unlinked"]) == (1, 1, 0)
    assert [(step["step"], step["status"]) for step in report["steps"]] == [
        ("tennis_data", "ok"),
        ("players_link", "ok"),
        ("elo", "ok"),
        ("settle", "ok"),
    ]
    # Р14: ни сумм, ни исходов, ни имен участников
    flat = json.dumps(done, ensure_ascii=False)
    for word in ("stake", "profit", "payout", "bank", "olga", "Ольга"):
        assert word not in flat
    saved = await db.get_one(Bet, bet.id, populate_existing=True)
    assert (saved.status, saved.settled_by, saved.profit) == ("won", "auto", D("175.00"))
    kept = await db.scalar(select(DataUpload.content).where(DataUpload.id == created["id"]))
    assert kept is None

    listing = (await admin.client.get("/api/admin/data/uploads")).json()
    assert [item["id"] for item in listing["uploads"]] == [created["id"]]
    archive = listing["archive"]
    assert archive["last_load"] is not None and archive["stale"] is False
    assert archive["matches_to"] == "2026-10-04" and archive["max_mb"] == 10
    assert archive["stale_days"] == 7
    assert archive["next_upload"] is not None

    # Тот же файл еще раз: новых матчей нет, ставки и банк не меняются
    ledger = [(row.kind, row.amount) for row in await ledger_rows(db, member.id)]
    again = await _upload(admin, content)
    assert again.status_code == 202
    assert await data_uploads.process_upload(factory, again.json()["id"]) == "done"
    # Повтор задачи той же загрузки ничего не делает
    assert await data_uploads.process_upload(factory, again.json()["id"]) == "skipped"
    repeat = (await admin.client.get(f"/api/admin/data/uploads/{again.json()['id']}")).json()
    assert repeat["report"]["unchanged"] is True and repeat["report"]["new_matches"] == 0
    assert repeat["report"]["settled_bets"] == 0
    assert [(row.kind, row.amount) for row in await ledger_rows(db, member.id)] == ledger
    notes = await db.scalars(select(Notification.kind).where(Notification.user_id == member.id))
    assert list(notes) == ["bet_settled"]
    assert await db.scalar(select(Match.id).where(Match.source == "user")) is None


async def test_upload_waits_for_running_update(
    admin: Signed, engine: AsyncEngine, factory: Factory, queued: list[int]
) -> None:
    """Идет ночное обновление (общая блокировка): загрузка снова в очереди, задача воркера
    повторится позже; блокировка свободна — обработка проходит."""
    upload_id = (await _upload(admin, _file())).json()["id"]
    async with engine.connect() as other:
        assert await other.scalar(
            text("SELECT pg_try_advisory_lock(:key)"), {"key": UPDATE_LOCK_KEY}
        )
        with pytest.raises(Retry):
            await jobs.process_data_upload({"sessionmaker": factory}, upload_id)
        await other.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": UPDATE_LOCK_KEY})
        await other.commit()
    async with factory() as db:
        upload = await db.get_one(DataUpload, upload_id)
        assert upload.status == "queued" and upload.content is not None
    assert await jobs.process_data_upload({"sessionmaker": factory}, upload_id) == "done"


async def test_upload_unknown_id_is_404(admin: Signed) -> None:
    response = await admin.client.get("/api/admin/data/uploads/999999")
    assert response.status_code == 404 and error_code(response) == "upload.not_found"


async def test_cli_data_upload(
    db: AsyncSession, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Команда терминала: тот же код, журнал — от терминала, обработка сразу."""
    path = tmp_path / "2026.xlsx"
    path.write_bytes(_file())
    assert await asyncio.to_thread(cli.main, ["data-upload", str(path)]) == 0
    out = capsys.readouterr().out
    assert "Файл 2026.xlsx принят" in out and "2026 год, строк матчей 1" in out
    assert "новых матчей 1" in out
    [entry] = await audit_entries(db, "data_upload")
    assert entry.actor_id is None and entry.details["source"] == "terminal"
    upload = await db.scalar(select(DataUpload).execution_options(populate_existing=True))
    assert upload is not None and upload.status == "done" and upload.uploaded_by is None
    missing = await asyncio.to_thread(cli.main, ["data-upload", str(tmp_path / "nope.xlsx")])
    assert missing == 1


async def test_upload_reminder_on_monday_morning(db: AsyncSession, admin: Signed) -> None:
    """Файл не загружали больше 7 дней: администратору в понедельник в 07:00 по его поясу —
    «пора загрузить файл», не чаще раза в сутки; в другой день и час — нет."""
    monday = datetime(2026, 10, 12, 4, 4, tzinfo=UTC)  # 07:04 по Хельсинки
    assert await jobs.notify_upload_due(db, now=monday.replace(hour=8)) == []
    assert await jobs.notify_upload_due(db, now=monday) == [admin.id]
    assert await jobs.notify_upload_due(db, now=monday) == []
    [note] = await db.scalars(select(Notification).where(Notification.user_id == admin.id))
    # Загрузок еще не было: свой текст, без «— —»; имя файла — от текущего года
    assert note.kind == "data_stale" and note.params["variant"] == "upload_first"
    assert note.title == "Пора загрузить файл tennis-data" and note.link == "/admin/data"
    assert note.body.startswith("Файл tennis-data еще не загружали.")
    assert "Скачайте 2026.xlsx" in note.body and "—" not in note.body
    tuesday = datetime(2026, 10, 20, 4, 4, tzinfo=UTC)
    assert await jobs.notify_upload_due(db, now=tuesday) == []


async def test_upload_reminder_shows_last_load_in_admin_zone(
    db: AsyncSession, admin: Signed
) -> None:
    """Файл загружали 12 дней назад: время последней загрузки — по поясу администратора
    («5 окт, 09:00» в Москве при 06:00 UTC); в январе — файл нового года."""
    await db.execute(update(User).where(User.id == admin.id).values(tz="Europe/Moscow"))
    db.add(
        IngestionRun(
            source="tennis_data",
            status="ok",
            started_at=datetime(2026, 10, 5, 6, 0, tzinfo=UTC),
            finished_at=datetime(2026, 10, 5, 6, 0, tzinfo=UTC),
            details={"files": {"2026.xlsx": "0" * 64}},
        )
    )
    await db.commit()
    monday = datetime(2026, 10, 19, 4, 4, tzinfo=UTC)  # 07:04 по Москве
    assert await jobs.notify_upload_due(db, now=monday) == [admin.id]
    [note] = await db.scalars(select(Notification).where(Notification.user_id == admin.id))
    assert note.params["variant"] == "upload"
    assert note.body.startswith("Последняя загрузка файла — 5 окт, 09:00.")
    assert "Скачайте 2026.xlsx" in note.body
    january = datetime(2027, 1, 4, 4, 4, tzinfo=UTC)
    assert await jobs.notify_upload_due(db, now=january) == [admin.id]
    latest = await db.scalar(
        select(Notification)
        .where(Notification.user_id == admin.id)
        .order_by(Notification.id.desc())
    )
    assert latest is not None
    assert "5 окт 2026, 09:00" in latest.body and "Скачайте 2027.xlsx" in latest.body


# --- пределы файла и зависшие загрузки ---

_XLSX_PARTS = {
    "[Content_Types].xml": (
        '<?xml version="1.0" encoding="UTF-8"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" '
        'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/'
        'vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'
    ),
    "_rels/.rels": (
        '<?xml version="1.0" encoding="UTF-8"?><Relationships '
        'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
        '2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'
    ),
    "xl/workbook.xml": (
        '<?xml version="1.0" encoding="UTF-8"?><workbook '
        'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="2026" sheetId="1" r:id="rId1"/></sheets></workbook>'
    ),
    "xl/_rels/workbook.xml.rels": (
        '<?xml version="1.0" encoding="UTF-8"?><Relationships '
        'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
        '2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'
    ),
}
_HEADER = ["ATP", "Location", "Tournament", "Date", "Series", "Court", "Surface", "Round"]
_HEADER += ["Best of", "Winner", "Loser", "Comment"]


def _raw_xlsx(rows: int, row_xml: Callable[[int], str]) -> bytes:
    """xlsx, собранный руками (как его мог бы сохранить Excel): заголовок tennis-data и rows
    строк row_xml(номер). Сжимается в килобайты, сколько бы ни было строк."""
    cells = "".join(
        f'<c r="{chr(65 + i)}1" t="inlineStr"><is><t>{name}</t></is></c>'
        for i, name in enumerate(_HEADER)
    )
    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, body in _XLSX_PARTS.items():
            archive.writestr(name, body)
        with archive.open("xl/worksheets/sheet1.xml", "w") as sheet:
            sheet.write(
                b'<?xml version="1.0" encoding="UTF-8"?><worksheet '
                b'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
            )
            sheet.write(f'<row r="1">{cells}</row>'.encode())
            for number in range(2, rows + 2):
                sheet.write(row_xml(number).encode())
            sheet.write(b"</sheetData></worksheet>")
    return buffer.getvalue()


def _wide_row(number: int) -> str:
    """Строка с данными в колонках A–L и ячейкой в последней колонке листа (XFD)."""
    return (
        f'<row r="{number}"><c r="A{number}"><v>{number}</v></c>'
        f'<c r="J{number}" t="inlineStr"><is><t>Winner {number}</t></is></c>'
        f'<c r="K{number}" t="inlineStr"><is><t>Loser {number}</t></is></c>'
        f'<c r="XFD{number}"><v>1</v></c></row>'
    )


def _tall_row(number: int) -> str:
    return "<row>" + "".join(f"<c><v>{k}</v></c>" for k in range(12)) + "</row>"


async def test_upload_limits_rows_columns_and_unpacked_size(
    admin: Signed, db: AsyncSession, queued: list[int], monkeypatch: pytest.MonkeyPatch
) -> None:
    """Файл на сотни килобайт не должен занять гигабайты памяти процесса API: API таблицу
    не разбирает и считает только строки листа (больше MAX_ROWS — 422), распакованный
    размер больше предела — 422. Воркер читает не больше MAX_COLUMNS колонок: ячейка в
    колонке XFD не раздувает строку до 16 384 значений."""
    tall = _raw_xlsx(tennis_data.MAX_ROWS + tennis_data.HEADER_ROWS + 1, _tall_row)
    assert len(tall) < 200_000
    response = await _upload(admin, tall)
    assert response.status_code == 422 and error_code(response) == "upload.too_many_rows"
    assert "больше 20\u00a0000 строк" in response.json()["error"]["message"]

    wide = _raw_xlsx(500, _wide_row)
    sheet = tennis_data.read_sheet(wide, "2026.xlsx")
    assert len(sheet.rows) == 500
    assert {len(values) for _, values in sheet.rows} == {tennis_data.MAX_COLUMNS}
    with pytest.raises(IngestError) as caught:
        tennis_data.read_sheet(tall, "2026.xlsx")
    assert caught.value.key == "ingest_tennis_data.errors.too_many_rows"

    monkeypatch.setattr(tennis_data, "MAX_UNPACKED_BYTES", 50_000)
    unpacked = await _upload(admin, wide)
    assert unpacked.status_code == 422 and error_code(unpacked) == "upload.too_big_unpacked"
    monkeypatch.undo()
    assert await db.scalar(select(DataUpload.id)) is None and queued == []
    accepted = await _upload(admin, wide)
    assert accepted.status_code == 202, accepted.text


async def test_crash_marks_upload_failed_and_retry_skips(
    admin: Signed,
    db: AsyncSession,
    factory: Factory,
    queued: list[int],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Сбой посреди обработки: загрузка — failed с текстом, файл стерт, исключение идет
    дальше (воркер пишет его в лог); повтор задачи ничего не делает."""
    upload_id = (await _upload(admin, _file())).json()["id"]

    async def boom(**_: object) -> None:
        raise RuntimeError("worker killed / db error")

    monkeypatch.setattr(data_uploads, "run_update", boom)
    with pytest.raises(RuntimeError):
        await data_uploads.process_upload(factory, upload_id)
    monkeypatch.undo()
    assert await data_uploads.process_upload(factory, upload_id) == "skipped"
    row = await db.get_one(DataUpload, upload_id, populate_existing=True)
    assert row.status == "failed" and row.content is None and row.finished_at is not None
    # Текст — по-русски из локали, тип исключения — только в логе воркера (№5)
    assert row.error is not None and "RuntimeError" not in row.error and "прервалась" in row.error
    shown = (await admin.client.get(f"/api/admin/data/uploads/{upload_id}")).json()
    assert shown["status"] == "failed" and "Отправьте файл еще раз" in shown["error"]


async def test_stuck_uploads_are_taken_again_or_failed(
    admin: Signed, db: AsyncSession, factory: Factory, queued: list[int]
) -> None:
    """Воркер упал без исключения (running дольше предела задачи): повтор задачи берет
    загрузку заново. Задачу потеряли совсем: уборщик ставит failed — running дольше
    RUNNING_LIMIT, queued дольше QUEUE_LIMIT; свежие не трогает."""
    now = datetime.now(UTC)
    abandoned = (await _upload(admin, _file())).json()["id"]
    await db.execute(
        update(DataUpload)
        .where(DataUpload.id == abandoned)
        .values(status="running", started_at=now - timedelta(seconds=3700))
    )
    await db.commit()
    assert await data_uploads.process_upload(factory, abandoned) == "done"

    running = (await _upload(admin, _file())).json()["id"]
    waiting = (await _upload(admin, _file())).json()["id"]
    fresh = (await _upload(admin, _file())).json()["id"]
    await db.execute(
        update(DataUpload)
        .where(DataUpload.id == running)
        .values(status="running", started_at=now - data_uploads.RUNNING_LIMIT - timedelta(1))
    )
    await db.execute(
        update(DataUpload)
        .where(DataUpload.id == waiting)
        .values(created_at=now - data_uploads.QUEUE_LIMIT - timedelta(minutes=1))
    )
    await db.commit()
    assert await data_uploads.reap_stuck_uploads(db, now=now) == [running, waiting]
    summary = await jobs.remind_unsettled({"sessionmaker": factory})
    assert summary["stuck_uploads"] == 0
    rows = {
        row.id: row
        for row in await db.scalars(select(DataUpload).execution_options(populate_existing=True))
    }
    assert rows[running].status == "failed" and "прервалась" in (rows[running].error or "")
    assert rows[waiting].status == "failed" and "не закончилось" in (rows[waiting].error or "")
    assert rows[running].content is None and rows[waiting].content is None
    assert rows[fresh].status == "queued" and rows[fresh].content is not None
    assert await data_uploads.process_upload(factory, running) == "skipped"


async def test_upload_gives_up_waiting_for_update(
    admin: Signed, engine: AsyncEngine, db: AsyncSession, factory: Factory, queued: list[int]
) -> None:
    """Ночное обновление идет дольше QUEUE_WAIT: загрузка не ждет вечно — failed с текстом,
    а не очередной повтор задачи."""
    upload_id = (await _upload(admin, _file())).json()["id"]
    await db.execute(
        update(DataUpload)
        .where(DataUpload.id == upload_id)
        .values(created_at=datetime.now(UTC) - data_uploads.QUEUE_WAIT - timedelta(minutes=1))
    )
    await db.commit()
    async with engine.connect() as other:
        assert await other.scalar(
            text("SELECT pg_try_advisory_lock(:key)"), {"key": UPDATE_LOCK_KEY}
        )
        assert await jobs.process_data_upload({"sessionmaker": factory}, upload_id) == "failed"
        await other.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": UPDATE_LOCK_KEY})
        await other.commit()
    row = await db.get_one(DataUpload, upload_id, populate_existing=True)
    assert row.status == "failed" and row.content is None
    assert row.error is not None and "не закончилось" in row.error


async def test_next_upload_day_same_rule_as_bets(db: AsyncSession, make_user: UserFactory) -> None:
    """№4 проверки экранов: день следующей загрузки на «Данных» считает сервер тем же
    правилом, что «ждет результата» у участника: понедельник после загрузки, прошел —
    ближайший понедельник с сегодняшнего дня (в поясе того, кто смотрит)."""
    db.add(
        IngestionRun(
            source="tennis_data",
            status="ok",
            started_at=datetime(2026, 10, 6, 9, 0, tzinfo=UTC),
            finished_at=datetime(2026, 10, 6, 9, 5, tzinfo=UTC),
            details={"files": {"2026.xlsx": "sha"}},
        )
    )
    await db.commit()
    admin = (await make_user(role="admin")).user
    # Загрузка во вторник 6 окт, сегодня вторник 13 окт: понедельник 12 окт прошел
    late = await data_uploads.archive_status(
        db, datetime(2026, 10, 13, 12, 0, tzinfo=UTC), viewer=admin
    )
    assert late.next_upload == date(2026, 10, 19)
    soon = await data_uploads.archive_status(
        db, datetime(2026, 10, 8, 12, 0, tzinfo=UTC), viewer=admin
    )
    assert soon.next_upload == date(2026, 10, 12)
