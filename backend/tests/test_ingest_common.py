"""Общие части загрузчиков этапа 2: раунды, имена игроков, получение файлов (без сети:
httpx.MockTransport и временная папка) и журнал загрузок ingestion_runs."""

import hashlib
import json
from base64 import b64encode
from collections.abc import AsyncIterator, Callable
from datetime import date
from decimal import Decimal
from pathlib import Path

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from structlog.testing import capture_logs

from app.core.i18n import t
from app.db.models import IngestionRun
from app.db.session import create_sessionmaker
from app.ingest.fetch import MAX_BYTES, DataSource, FetchError, public_url
from app.ingest.names import fold, name_keys, parse_tennis_data_name, translit_ru
from app.ingest.rounds import (
    ROUNDS,
    draw_bracket,
    round_order,
    tennis_data_draw_size,
    tennis_data_round,
)
from app.ingest.runs import (
    MAX_EXAMPLES,
    IngestError,
    IngestReport,
    ingestion_run,
    last_ok_file_hashes,
)

# --- раунды ---


def test_round_order() -> None:
    main_draw = ["R128", "R64", "R32", "R16", "QF", "SF", "BR", "F"]
    assert sorted(main_draw, key=round_order) == main_draw
    assert [round_order(code) for code in main_draw] == sorted(
        {round_order(code) for code in main_draw}
    )
    assert round_order("RR") == round_order("R16")
    assert round_order("RR") < round_order("SF")
    for early in ("Q1", "Q2", "Q3", "Q4", "ER"):
        assert round_order(early) < round_order("R128")
    assert round_order("Q1") < round_order("Q4")
    assert {code for code in ROUNDS if round_order(code)} == set(ROUNDS)
    with pytest.raises(ValueError, match="R256"):
        round_order("R256")


@pytest.mark.parametrize(
    ("draw", "first", "second"),
    [
        (32, "R32", "R16"),
        (28, "R32", "R16"),
        (48, "R64", "R32"),
        (56, "R64", "R32"),
        (64, "R64", "R32"),
        (96, "R128", "R64"),
        (128, "R128", "R64"),
    ],
)
def test_tennis_data_round_by_draw(draw: int, first: str, second: str) -> None:
    assert tennis_data_round("1st Round", draw) == first
    assert tennis_data_round("2nd Round", draw) == second


def test_tennis_data_round_labels() -> None:
    assert tennis_data_round("3rd Round", 128) == "R32"
    assert tennis_data_round("4th Round", 128) == "R16"
    assert tennis_data_round("3rd Round", 56) == "R16"
    assert tennis_data_round("Quarterfinals", 32) == "QF"
    assert tennis_data_round("Semifinals", 128) == "SF"
    assert tennis_data_round("The Final", 8) == "F"
    assert tennis_data_round("Round Robin", 8) == "RR"
    # Регистр, лишние пробелы и дефис не мешают
    assert tennis_data_round("  1st  round ", 32) == "R32"
    assert tennis_data_round("Quarter-finals", 32) == "QF"
    assert tennis_data_round("THE FINAL", 32) == "F"


@pytest.mark.parametrize(
    ("label", "draw"),
    [("0th Round", 32), ("Bronze", 32), ("", 32), ("3rd Round", 32), ("5th Round", 128)],
)
def test_tennis_data_round_unknown(label: str, draw: int) -> None:
    with pytest.raises(ValueError, match=r"[Рр]аунд"):
        tennis_data_round(label, draw)


def test_draw_size() -> None:
    assert [draw_bracket(n) for n in (2, 8, 28, 32, 48, 56, 96, 128)] == [
        8,
        8,
        32,
        32,
        64,
        64,
        128,
        128,
    ]
    with pytest.raises(ValueError):
        draw_bracket(129)
    # Два круга до четвертьфинала — 32, три — 64, четыре — 128
    atp250 = ["1st Round", "2nd Round", "Quarterfinals", "Semifinals", "The Final"]
    assert tennis_data_draw_size(atp250, first_round_matches=12) == 32
    masters96 = ["1st Round", "2nd Round", "3rd Round", "4th Round", "Quarterfinals"]
    # У сетки 96 в первом круге 32 матча: по ним вышло бы 64, по кругам — 128
    assert tennis_data_draw_size(masters96, first_round_matches=32) == 128
    # Сыгран только первый круг: размер — по числу его матчей
    assert tennis_data_draw_size(["1st Round"], first_round_matches=16) == 32
    assert tennis_data_draw_size(["Round Robin", "Semifinals", "The Final"]) == 8
    assert tennis_data_draw_size(["1st Round"], first_round_matches=500) == 128


# --- имена ---


def test_fold() -> None:
    assert fold("  Auger-Aliassime   F. ") == "auger aliassime f"
    assert fold("Del Potro J.M.") == "del potro j m"
    assert fold("Ramos-Viñolas") == "ramos vinolas"
    assert fold("O’Connell") == "o connell"
    assert fold("Đoković") == "djokovic"
    assert fold("Hubert Hurkacz") == "hubert hurkacz"
    assert fold("Monfíls Gäl") == "monfils gal"
    # Кириллица остается кириллицей, «й» не превращается в «и»
    assert fold("Андрей  Рублев") == "андрей рублев"
    assert fold("\u0401лкин") == "елкин"
    assert fold("") == ""


@pytest.mark.parametrize(
    ("ru", "latin"),
    [
        ("Синнер", "sinner"),
        ("Медведев", "medvedev"),
        ("Хачанов", "khachanov"),
        ("Рублев", "rublev"),
        ("Рубл\u0451в", "rublev"),
        ("Шаповалов", "shapovalov"),
        ("Циципас", "tsitsipas"),
        ("Джокович", "dzhokovich"),
        ("Андрей Рублев", "andrey rublev"),
        ("Щукин", "shchukin"),
        ("Sinner", "sinner"),
    ],
)
def test_translit_ru(ru: str, latin: str) -> None:
    assert translit_ru(ru) == latin


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("Del Potro J.M.", ("del potro", "jm")),
        ("Sinner J.", ("sinner", "j")),
        ("  Zverev   A. ", ("zverev", "a")),
        ("Auger-Aliassime F.", ("auger aliassime", "f")),
        ("Ramos-Vinolas A.", ("ramos vinolas", "a")),
        ("Bautista Agut R.", ("bautista agut", "r")),
        ("Tsonga J.W.", ("tsonga", "jw")),
        ("Tsonga J.-W.", ("tsonga", "jw")),
        ("Del Potro J. M.", ("del potro", "jm")),
        ("Kuznetsov An.", ("kuznetsov", "an")),
        ("Li Z.", ("li", "z")),
        ("Синнер Я.", ("синнер", "я")),
        ("Sinner", ("sinner", "")),
        ("J.", ("j", "")),
    ],
)
def test_parse_tennis_data_name(raw: str, expected: tuple[str, str]) -> None:
    assert parse_tennis_data_name(raw) == expected


def test_name_keys_of_multi_word_surnames() -> None:
    sackmann = name_keys("Juan Martin Del Potro")
    td = name_keys("Del Potro J.M.")
    for key in ("del potro", "delpotro", "del potro j", "del potro jm"):
        assert key in sackmann and key in td, key
    assert "juan martin del potro" in sackmann
    # Частица сама по себе не ключ
    assert "del j" not in td
    for full, short in (
        ("Roberto Bautista Agut", "Bautista Agut R."),
        ("Felix Auger Aliassime", "Auger-Aliassime F."),
        ("Pablo Carreno Busta", "Carreno Busta P."),
    ):
        common = name_keys(full) & name_keys(short)
        surname = fold(short.rsplit(" ", 1)[0])
        assert {surname, surname.replace(" ", ""), f"{surname} {short[-2].lower()}"} <= common


def test_name_keys_tell_namesakes_apart() -> None:
    assert "zverev a" in name_keys("Alexander Zverev") & name_keys("Zverev A.")
    assert not name_keys("Mischa Zverev") & {"zverev a"}
    assert "zverev m" in name_keys("Mischa Zverev") & name_keys("Zverev M.")
    # tennis-data различает тезок двумя буквами имени
    andrey = name_keys("Andrey Kuznetsov")
    alex = name_keys("Alex Kuznetsov")
    assert "kuznetsov an" in andrey & name_keys("Kuznetsov An.")
    assert "kuznetsov an" not in alex
    # Короткая форма испанской фамилии
    assert "ramos a" in name_keys("Albert Ramos") & name_keys("Ramos-Vinolas A.")


def test_name_keys_cyrillic() -> None:
    keys = name_keys("Синнер Я.")
    assert {"синнер", "синнер я", "sinner", "sinner ya"} <= keys
    assert "sinner" in name_keys("Янник Синнер") & name_keys("Jannik Sinner")
    assert "rublev" in name_keys("Андрей Рубл\u0451в") & name_keys("Andrey Rublev")
    assert "rublev a" in name_keys("Андрей Рублев") & name_keys("Rublev A.")
    assert name_keys("   ") == set()


# --- получение файлов ---

Handler = Callable[[httpx.Request], httpx.Response]


def _source(handler: Handler, base_url: str = "https://data.example.com/atp") -> DataSource:
    return DataSource(
        base_url=base_url, transport=httpx.MockTransport(handler), retry_pause=0, max_bytes=1024
    )


async def test_fetch_http_file() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"tourney_id,surface\n2024-339,Hard\n")

    async with _source(handler) as source:
        file = await source.fetch("atp_matches_2024.csv")
    assert file is not None
    assert file.path == "atp_matches_2024.csv"
    assert file.content.startswith(b"tourney_id")
    assert file.sha256 == hashlib.sha256(file.content).hexdigest()
    assert file.url == "https://data.example.com/atp/atp_matches_2024.csv"
    [request] = seen
    assert request.headers["User-Agent"] == "AI-Capper/0.1.0"


async def test_fetch_follows_redirects_and_nested_paths() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.tennis-data.co.uk":
            return httpx.Response(
                301, headers={"Location": f"https://cdn.example.com{request.url.path}"}
            )
        return httpx.Response(200, content=b"xlsx")

    async with _source(handler, "http://www.tennis-data.co.uk/") as source:
        file = await source.fetch("2024/2024.xlsx")
    assert file is not None
    assert file.url == "https://cdn.example.com/2024/2024.xlsx"
    assert file.path == "2024/2024.xlsx"


@pytest.mark.parametrize("status", [404, 410])
async def test_fetch_missing_file_is_none(status: int) -> None:
    async with _source(lambda _: httpx.Response(status)) as source:
        assert await source.fetch("atp_matches_2026.csv") is None


async def test_fetch_retries_server_and_network_errors() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("connection refused", request=request)
        if calls == 2:
            return httpx.Response(503)
        if calls == 3:
            return httpx.Response(429)
        return httpx.Response(200, content=b"ok")

    async with _source(handler) as source:
        file = await source.fetch("atp_players.csv")
    assert file is not None and file.content == b"ok"
    assert calls == 4


async def test_fetch_gives_up_after_retries() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("timed out", request=request)

    async with _source(handler) as source:
        with pytest.raises(FetchError) as info:
            await source.fetch("atp_players.csv")
    # Первая попытка и 3 повтора
    assert calls == 4
    assert "ReadTimeout" in info.value.message
    assert "https://data.example.com/atp/atp_players.csv" in info.value.message


async def test_fetch_hides_login_and_password() -> None:
    """Адрес закрытого зеркала с логином и паролем: они уходят серверу как basic auth,
    но не попадают в лог повторов, текст ошибки (ingestion_runs.error) и отчет."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("bad.csv"):
            return httpx.Response(500)
        return httpx.Response(200, content=b"ok")

    base = "https://reader:s3cret@mirror.example.com/atp"
    async with _source(handler, base) as source:
        assert source.location == "https://mirror.example.com/atp"
        file = await source.fetch("good.csv")
        with capture_logs() as logs, pytest.raises(FetchError) as info:
            await source.fetch("bad.csv")
    assert seen[0].headers["Authorization"] == "Basic " + b64encode(b"reader:s3cret").decode()
    assert file is not None and file.url == "https://mirror.example.com/atp/good.csv"
    assert "https://mirror.example.com/atp/bad.csv" in info.value.message
    assert info.value.status == 500
    retries = [entry for entry in logs if entry["event"] == "ingest.fetch_retry"]
    assert len(retries) == 3
    assert "s3cret" not in info.value.message + repr(logs)
    assert "reader" not in info.value.message + repr(logs)
    assert public_url("http://www.tennis-data.co.uk/2024/2024.xlsx") == (
        "http://www.tennis-data.co.uk/2024/2024.xlsx"
    )


async def test_fetch_client_error_is_not_retried() -> None:
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(403)

    async with _source(handler) as source:
        with pytest.raises(FetchError, match="403") as info:
            await source.fetch("atp_players.csv")
    assert calls == 1
    # Код ответа — отдельным полем: по нему tennis-data узнает закрытие Cloudflare
    assert info.value.status == 403


async def _chunks() -> AsyncIterator[bytes]:
    for _ in range(4):
        yield b"x" * 400


async def test_fetch_size_limit() -> None:
    # Размер известен из заголовка
    async with _source(lambda _: httpx.Response(200, content=b"x" * 2048)) as source:
        with pytest.raises(FetchError, match="1 МБ"):
            await source.fetch("big.csv")
    # Размер неизвестен: чтение останавливается на лимите
    async with _source(lambda _: httpx.Response(200, content=_chunks())) as source:
        with pytest.raises(FetchError):
            await source.fetch("big.csv")
    assert MAX_BYTES == 50 * 1024 * 1024


@pytest.mark.parametrize("path", ["", "../secret.csv", "/etc/passwd", "a/../../b.csv", "a\\b.csv"])
async def test_fetch_rejects_bad_paths(path: str, tmp_path: Path) -> None:
    async with DataSource.local(tmp_path) as source:
        with pytest.raises(ValueError):
            await source.fetch(path)


async def test_fetch_from_local_directory(tmp_path: Path) -> None:
    (tmp_path / "2024").mkdir()
    (tmp_path / "2024" / "2024.xlsx").write_bytes(b"nested")
    (tmp_path / "2025.xlsx").write_bytes(b"flat")
    (tmp_path / "atp_matches_2024.csv").write_bytes(b"csv")
    async with DataSource.local(tmp_path) as source:
        assert source.location == str(tmp_path)
        nested = await source.fetch("2024/2024.xlsx")
        flat = await source.fetch("2025/2025.xlsx")
        csv = await source.fetch("atp_matches_2024.csv")
        missing = await source.fetch("atp_matches_2026.csv")
    assert nested is not None and nested.content == b"nested"
    assert nested.path == "2024/2024.xlsx"
    assert nested.url == (tmp_path / "2024" / "2024.xlsx").resolve().as_uri()
    # Нет вложенной папки — берется файл с тем же именем прямо в папке
    assert flat is not None and flat.content == b"flat" and flat.path == "2025/2025.xlsx"
    assert csv is not None and csv.sha256 == hashlib.sha256(b"csv").hexdigest()
    assert missing is None


async def test_local_size_limit(tmp_path: Path) -> None:
    (tmp_path / "big.csv").write_bytes(b"x" * 2048)
    async with DataSource(directory=tmp_path, max_bytes=1024) as source:
        with pytest.raises(FetchError):
            await source.fetch("big.csv")


def test_data_source_needs_exactly_one_place(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        DataSource()
    with pytest.raises(ValueError):
        DataSource(base_url="https://example.com", directory=tmp_path)


# --- отчет загрузчика ---


def test_report_counts_and_example_limit() -> None:
    report = IngestReport()
    for i in range(MAX_EXAMPLES + 5):
        report.add_unmatched("player", name=f"Player {i}", day=date(2024, 1, 1))
        report.skip("abandoned")
    report.add_unmatched("tournament", name="Doha", odds=Decimal("1.85"))
    report.add_warning("ingest.rounds.unknown_label", label="Bronze")
    report.add_warning("ingest.rounds.unknown_label", label="0th Round")
    report.skip("unknown_round", 3)
    report.created, report.updated, report.rows_read = 10, 2, 300
    report.freshness = {"last_match_date": date(2026, 9, 28), "missing": {"b", "a"}}

    assert report.rows == 12
    assert report.skipped == MAX_EXAMPLES + 8
    assert len(report.unmatched) == MAX_EXAMPLES + 1
    assert report.unmatched[0] == {"kind": "player", "name": "Player 0", "day": "2024-01-01"}
    assert report.unmatched[-1] == {"kind": "tournament", "name": "Doha", "odds": "1.85"}
    assert report.warnings == [
        t("ingest.rounds.unknown_label", label="Bronze"),
        t("ingest.rounds.unknown_label", label="0th Round"),
    ]
    details = report.to_details()
    json.dumps(details)
    assert details["counts"] == {
        "skipped.abandoned": MAX_EXAMPLES + 5,
        "skipped.unknown_round": 3,
        "unmatched.player": MAX_EXAMPLES + 5,
        "unmatched.tournament": 1,
        "warnings.ingest.rounds.unknown_label": 2,
    }
    assert details["freshness"] == {"last_match_date": "2026-09-28", "missing": ["a", "b"]}
    assert {k: details[k] for k in ("rows_read", "created", "updated", "skipped")} == {
        "rows_read": 300,
        "created": 10,
        "updated": 2,
        "skipped": MAX_EXAMPLES + 8,
    }


def test_report_files() -> None:
    report = IngestReport()

    class File:
        path = "atp_matches_2024.csv"
        sha256 = "ab" * 32

    report.add_file(File())
    assert report.to_details()["files"] == {"atp_matches_2024.csv": "ab" * 32}


# --- журнал загрузок ---


async def _runs(db: AsyncSession) -> list[IngestionRun]:
    stmt = select(IngestionRun).order_by(IngestionRun.id).execution_options(populate_existing=True)
    return list(await db.scalars(stmt))


async def test_ingestion_run_ok(engine: AsyncEngine, db: AsyncSession) -> None:
    factory = create_sessionmaker(engine)
    async with ingestion_run(factory, "sackmann") as run:
        # Строка запуска видна сразу, до конца загрузки
        [row] = await _runs(db)
        assert row.id == run.id and row.status == "running" and row.finished_at is None
        run.report.rows_read = 100
        run.report.created = 7
        run.report.updated = 3
        run.report.files["atp_matches_2024.csv"] = "a" * 64
        run.report.add_unmatched("player", name="Nobody X.")
    [row] = await _runs(db)
    assert row.source == "sackmann"
    assert row.status == "ok" and row.error is None
    assert row.finished_at is not None and row.finished_at >= row.started_at
    assert row.rows == 10
    assert row.details == run.report.to_details()
    assert row.details["files"] == {"atp_matches_2024.csv": "a" * 64}


async def test_ingestion_run_failed(engine: AsyncEngine, db: AsyncSession) -> None:
    factory = create_sessionmaker(engine)
    with pytest.raises(IngestError):
        async with ingestion_run(factory, "tennis_data") as run:
            run.report.created = 2
            raise FetchError("ingest.fetch.failed", url="http://x/2024.xlsx", reason="503")
    secret = "postgresql://capper:hunter2@db/capper"
    with pytest.raises(RuntimeError):
        async with ingestion_run(factory, "elo"):
            raise RuntimeError(f"cannot connect to {secret}")
    first, second = await _runs(db)
    assert first.status == "failed" and first.rows == 2
    assert first.error == t("ingest.fetch.failed", url="http://x/2024.xlsx", reason="503")
    assert first.details["created"] == 2
    assert second.status == "failed"
    # Текст чужого исключения не пишется: в нем бывает адрес базы с паролем
    assert second.error == t("ingest.runs.unexpected", error="RuntimeError")
    assert "hunter2" not in (second.error or "")


async def test_ingestion_run_unknown_source(engine: AsyncEngine, db: AsyncSession) -> None:
    with pytest.raises(ValueError):
        async with ingestion_run(create_sessionmaker(engine), "atp_site"):
            pass
    assert await _runs(db) == []


async def _finished_run(
    engine: AsyncEngine, source: str, files: dict[str, str], *, fail: bool = False
) -> None:
    try:
        async with ingestion_run(create_sessionmaker(engine), source) as run:
            run.report.files.update(files)
            if fail:
                raise IngestError("ingest.runs.interrupted")
    except IngestError:
        pass


async def test_last_ok_file_hashes(engine: AsyncEngine, db: AsyncSession) -> None:
    assert await last_ok_file_hashes(db, "sackmann") == {}
    await _finished_run(engine, "sackmann", {"atp_matches_2023.csv": "old23", "players": "p1"})
    await _finished_run(engine, "sackmann", {"atp_matches_2024.csv": "x24", "players": "p2"})
    # Неудачный запуск и другой источник не в счет
    await _finished_run(engine, "sackmann", {"atp_matches_2024.csv": "broken"}, fail=True)
    await _finished_run(engine, "tennis_data", {"2024/2024.xlsx": "td"})
    # Самый свежий успешный запуск, где был файл, побеждает; старый файл не потерян
    assert await last_ok_file_hashes(db, "sackmann") == {
        "atp_matches_2023.csv": "old23",
        "atp_matches_2024.csv": "x24",
        "players": "p2",
    }
    assert await last_ok_file_hashes(db, "tennis_data") == {"2024/2024.xlsx": "td"}
