"""Команды игроков в терминале: players-find, players-merge, players-edit,
players-link-legacy, players-unmatched (app/admin/cli.py).

main(argv) запускает свой цикл событий, поэтому вызывается в отдельном потоке,
как в tests/test_cli.py.
"""

import asyncio
import io
import sys
from collections.abc import Callable
from datetime import UTC, date, datetime

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import cli
from app.core.i18n import t
from app.db.models import IngestionRun, Match, Player, Tournament
from app.ingest.runs import UPDATE_LOCK_KEY
from tests.helpers_admin import audit_entries


async def run(*argv: str) -> int:
    return await asyncio.to_thread(cli.main, list(argv))


@pytest.fixture
def stdin(monkeypatch: pytest.MonkeyPatch) -> Callable[[str], None]:
    def feed(text: str) -> None:
        monkeypatch.setattr(sys, "stdin", io.StringIO(text))

    return feed


async def _player(db: AsyncSession, name: str, **fields: object) -> int:
    player = Player(name=name, **fields)
    db.add(player)
    await db.flush()
    return player.id


@pytest.fixture
async def pair(db: AsyncSession) -> tuple[int, int]:
    """Заготовка старого бота и игрок архива с матчем."""
    stub = await _player(db, "Синнер", name_ru="Синнер", aliases=["Синнер"])
    sinner = await _player(
        db, "Jannik Sinner", sackmann_id=206173, country="ITA", birth_date=date(2001, 8, 16)
    )
    rival = await _player(db, "Daniil Medvedev")
    tournament = Tournament(name="AO", source="sackmann", source_ref="2025-580")
    db.add(tournament)
    await db.flush()
    db.add(
        Match(
            tournament_id=tournament.id,
            round="F",
            player1_id=sinner,
            player2_id=rival,
            winner_id=sinner,
            status="finished",
            source="sackmann",
            source_ref="2025-580-300",
        )
    )
    await db.commit()
    return stub, sinner


async def test_players_find_table(
    db: AsyncSession, pair: tuple[int, int], capsys: pytest.CaptureFixture[str]
) -> None:
    stub, sinner = pair
    assert await run("players-find", "Синнер") == 0
    out = capsys.readouterr().out
    lines = out.splitlines()
    assert lines[0].split() == [
        "id",
        "Имя",
        "По-русски",
        "Страна",
        "Г.",
        "р.",
        "sackmann_id",
        "Матчей",
        "Оценка",
        "Совпало",
    ]
    assert set(lines[1]) <= {"-", " "}
    rows = {line.split()[0]: line for line in lines[2:]}
    assert "Jannik Sinner" in rows[str(sinner)]
    assert "ITA" in rows[str(sinner)] and "2001" in rows[str(sinner)]
    assert "206173" in rows[str(sinner)] and "1.00" in rows[str(sinner)]
    assert str(stub) in rows

    assert await run("players-find", "Qwxzzz") == 0
    assert t("cli.players_find_none", query="Qwxzzz") in capsys.readouterr().out

    assert await run("players-find", "   ") == 1
    assert t("players.errors.query_empty") in capsys.readouterr().err


async def test_players_merge_asks_and_merges(
    db: AsyncSession,
    pair: tuple[int, int],
    stdin: Callable[[str], None],
    capsys: pytest.CaptureFixture[str],
) -> None:
    stub, sinner = pair
    # Отказ: ничего не слито, код 1
    stdin("нет\n")
    assert await run("players-merge", "--from", str(stub), "--into", str(sinner)) == 1
    captured = capsys.readouterr()
    assert t("cli.players_merge_title") in captured.out
    assert "Jannik Sinner" in captured.out and "name_ru" in captured.out
    assert t("cli.cancelled") in captured.err
    db.expire_all()
    assert await db.get(Player, stub) is not None
    assert await audit_entries(db, "player_merge") == []

    stdin("да\n")
    assert await run("players-merge", "--from", str(stub), "--into", str(sinner)) == 0
    assert t("cli.players_merge_done", source=stub, target=sinner, name="Jannik Sinner") in (
        capsys.readouterr().out
    )
    db.expire_all()
    assert await db.get(Player, stub) is None
    merged = await db.get(Player, sinner)
    assert merged is not None and merged.name_ru == "Синнер"
    [entry] = await audit_entries(db, "player_merge")
    assert entry.actor_id is None and entry.details["source"] == "terminal"
    assert entry.details["source_id"] == stub


async def test_players_merge_yes_and_errors(
    db: AsyncSession, pair: tuple[int, int], capsys: pytest.CaptureFixture[str]
) -> None:
    stub, sinner = pair
    assert await run("players-merge", "--from", str(stub), "--into", "999999", "--yes") == 1
    assert t("players.errors.not_found", id=999999) in capsys.readouterr().err
    assert await run("players-merge", "--from", str(stub), "--into", str(stub), "--yes") == 1
    capsys.readouterr()
    assert await run("players-merge", "--from", str(stub), "--into", str(sinner), "--yes") == 0
    db.expire_all()
    assert await db.get(Player, stub) is None
    assert len(await audit_entries(db, "player_merge")) == 1


async def test_players_edit(
    db: AsyncSession, pair: tuple[int, int], capsys: pytest.CaptureFixture[str]
) -> None:
    _, sinner = pair
    args = ["players-edit", str(sinner), "--name-ru", "Янник Синнер", "--add-alias", "Sinner J."]
    assert await run(*args) == 0
    out = capsys.readouterr().out
    assert "Янник Синнер" in out and "Sinner J." in out
    assert await run("players-edit", str(sinner), "--name-ru", "Янник Синнер") == 0
    assert t("cli.players_edit_unchanged") in capsys.readouterr().out
    assert await run("players-edit", str(sinner)) == 1
    assert t("players.errors.edit_nothing") in capsys.readouterr().err
    assert await run("players-edit", str(sinner), "--remove-alias", "nope") == 1
    assert len(await audit_entries(db, "player_edit")) == 1


async def test_players_link_legacy_command(
    db: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    db.add(Tournament(name="Пустой", source="legacy"))
    await db.commit()
    assert await run("players-link-legacy", "--dry-run") == 0
    out = capsys.readouterr().out
    assert t("cli.players_link_dry_run") in out
    assert "0" in out
    db.expire_all()
    assert await db.scalar(select(Tournament.id).where(Tournament.name == "Пустой")) is not None
    assert await db.scalar(select(IngestionRun.id)) is None

    assert await run("players-link-legacy") == 0
    db.expire_all()
    assert await db.scalar(select(Tournament.id).where(Tournament.name == "Пустой")) is None
    run_row = await db.scalar(select(IngestionRun))
    assert run_row is not None and run_row.source == "players_link"


async def test_data_commands_wait_for_update_lock(
    db: AsyncSession, pair: tuple[int, int], capsys: pytest.CaptureFixture[str]
) -> None:
    """Пока идет обновление данных (блокировка update_lock), команды, которые меняют
    архив матчей, не выполняются: иначе шаги шли бы вперемешку с загрузкой."""
    stub, sinner = pair
    await db.execute(text("SELECT pg_advisory_lock(:key)"), {"key": UPDATE_LOCK_KEY})
    try:
        commands = [
            ("players-merge", "--from", str(stub), "--into", str(sinner), "--yes"),
            ("players-link-legacy",),
        ]
        for argv in commands:
            assert await run(*argv) == 1
            assert t("ingest_update.errors.busy") in capsys.readouterr().err
    finally:
        await db.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": UPDATE_LOCK_KEY})
        await db.commit()
    db.expire_all()
    assert await db.get(Player, stub) is not None
    assert await db.scalar(select(IngestionRun.id)) is None


async def test_matches_merge_command(
    db: AsyncSession,
    stdin: Callable[[str], None],
    capsys: pytest.CaptureFixture[str],
) -> None:
    sinner = await _player(db, "Jannik Sinner", sackmann_id=1)
    kwon = await _player(db, "Soonwoo Kwon", sackmann_id=5)
    doha = Tournament(name="Doha", source="sackmann", source_ref="2026-451")
    td_doha = Tournament(name="Doha", source="tennis_data", source_ref="2026-7", city="Doha")
    db.add_all([doha, td_doha])
    await db.flush()
    common = {"status": "finished", "round": "R32"}
    archive = Match(
        tournament_id=doha.id,
        player1_id=sinner,
        player2_id=kwon,
        winner_id=sinner,
        source="sackmann",
        source_ref="2026-451-1",
        **common,
    )
    copy = Match(
        tournament_id=td_doha.id,
        player1_id=kwon,
        player2_id=sinner,
        winner_id=kwon,
        source="tennis_data",
        source_ref="x" * 32,
        match_date=date(2026, 2, 17),
        **common,
    )
    db.add_all([archive, copy])
    await db.commit()
    archive_id, copy_id, td_id, doha_id = archive.id, copy.id, td_doha.id, doha.id

    stdin("нет\n")
    assert await run("matches-merge", "--from", str(copy_id), "--into", str(archive_id)) == 1
    captured = capsys.readouterr()
    assert t("cli.matches_merge_title") in captured.out
    assert t("cli.matches_merge_flipped") in captured.out
    assert "2026-02-17" in captured.out and "match_date" in captured.out
    assert t("cli.cancelled") in captured.err
    db.expire_all()
    assert await db.get(Match, copy_id) is not None

    args = ("matches-merge", "--from", str(copy_id), "--into", str(archive_id), "--yes")
    assert await run(*args) == 0
    assert t("cli.matches_merge_done", source=copy_id, target=archive_id) in (
        capsys.readouterr().out
    )
    db.expire_all()
    assert await db.get(Match, copy_id) is None
    merged = await db.get(Match, archive_id)
    assert merged is not None and merged.match_date == date(2026, 2, 17)
    # Пустой турнир tennis-data удален, его город перешел к турниру Сакманна
    assert await db.get(Tournament, td_id) is None
    kept = await db.get(Tournament, doha_id)
    assert kept is not None and kept.city == "Doha"
    assert await run("matches-merge", "--from", str(copy_id), "--into", str(archive_id)) == 1
    assert t("players.errors.match_not_found", id=copy_id) in capsys.readouterr().err


async def test_players_unmatched(db: AsyncSession, capsys: pytest.CaptureFixture[str]) -> None:
    assert await run("players-unmatched") == 0
    assert t("cli.players_unmatched_none") in capsys.readouterr().out

    at = datetime(2026, 10, 1, 5, tzinfo=UTC)
    db.add_all(
        [
            # Старый успешный запуск не показывается: только последний
            IngestionRun(
                source="tennis_data",
                status="ok",
                started_at=at.replace(day=1),
                finished_at=at,
                details={
                    "unmatched": [{"kind": "player", "name": "Old R."}],
                    "counts": {"unmatched.player": 1},
                },
            ),
            IngestionRun(
                source="tennis_data",
                status="ok",
                started_at=at.replace(day=2),
                finished_at=at.replace(day=2),
                details={
                    "unmatched": [
                        {"kind": "player", "name": "Zverev A.", "file": "2026.xlsx", "line": 7},
                        {"kind": "player", "name": "Kim S."},
                    ],
                    "counts": {"unmatched.player": 5, "skipped.status": 2},
                },
            ),
            IngestionRun(source="tennis_data", status="failed", details={"unmatched": []}),
            IngestionRun(source="sackmann", status="ok", details={}),
        ]
    )
    await db.commit()
    assert await run("players-unmatched", "--limit", "1") == 0
    out = capsys.readouterr().out
    assert "tennis_data" in out and "2026-10-02 05:00" in out
    assert "player: 5" in out
    # Порядок полей задает JSONB, вид — в начале строки
    assert "    player: file=2026.xlsx; line=7; name=Zverev A." in out
    assert "Kim S." not in out and "Old R." not in out
    assert t("cli.players_unmatched_clean") in out


async def test_players_unmatched_older_runs(
    db: AsyncSession, capsys: pytest.CaptureFixture[str]
) -> None:
    at = datetime(2026, 10, 1, 5, tzinfo=UTC)
    full = IngestionRun(
        source="tennis_data",
        status="ok",
        started_at=at,
        finished_at=at,
        details={
            "files": {"2024/2024.xlsx": "a", "2026/2026.xlsx": "c"},
            "unmatched": [{"kind": "player", "name": "Zverev A.", "file": "2024/2024.xlsx"}],
            "counts": {"unmatched.player": 300},
        },
    )
    nightly = IngestionRun(
        source="tennis_data",
        status="ok",
        started_at=at.replace(day=2),
        finished_at=at.replace(day=2),
        details={
            "files": {"2024/2024.xlsx": "a", "2026/2026.xlsx": "d"},
            "unmatched": [],
            "counts": {"files.unchanged": 1},
        },
    )
    db.add_all([full, nightly])
    await db.commit()
    assert await run("players-unmatched") == 0
    out = capsys.readouterr().out
    header = t(
        "cli.players_unmatched_run", source="tennis_data", run=nightly.id, at="2026-10-02 05:00"
    )
    assert header in out
    assert t("cli.players_unmatched_older", runs=str(full.id)) in out
    assert t("cli.players_unmatched_kind_min", kind="player", count=1) in out
    assert "Zverev A." in out and t("cli.players_unmatched_clean") not in out
