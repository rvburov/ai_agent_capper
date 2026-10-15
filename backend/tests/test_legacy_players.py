"""Импорт старого бота и игроки архива (этап 5, Т23): имя из истории и профиль игрока
находят игрока архива по фамилии, как привязка старого бота, а не создают двойника
(«Синнер Я.» рядом с Jannik Sinner мешал запустить анализ). Похожих в архиве несколько —
отчет, профиль не переносится."""

import json
import shutil
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import BetLeg, Match, Player, PlayerProfile
from app.ingest.players_link import ArchiveNames
from tests.support import MadeUser, UserFactory
from tests.test_ingest_legacy import OWNER, PLAYERS, event, record, run_fixture, write_history


@pytest.fixture
async def owner(make_user: UserFactory) -> MadeUser:
    return await make_user(role="admin", email=OWNER)


def _profile(players: Path, folder: str, full_name: str) -> None:
    shutil.copytree(PLAYERS / "Маттео-Навоне", players / folder)
    personal = players / folder / "01-личные-данные.json"
    data = json.loads(personal.read_text(encoding="utf-8"))
    data["личные_данные"]["фио"] = full_name
    personal.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def test_archive_names_leader_and_ambiguity() -> None:
    names = ArchiveNames(
        [
            (1, ["Jannik Sinner", "Sinner J."]),
            (2, ["Alexander Zverev"]),
            (3, ["Mischa Zverev"]),
            (4, ["Daniil Medvedev"]),
        ]
    )
    assert names.find(["Синнер Я."]) == (1, False)
    assert names.find(["Янник Синнер"]) == (1, False)
    assert names.find(["Медведев"]) == (4, False)
    assert names.find(["Зверев А."]) == (None, True)
    assert names.find(["Петров П."]) == (None, False)


async def test_import_uses_archive_players(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    sinner = Player(name="Jannik Sinner", sackmann_id=206173)
    zverev = Player(name="Alexander Zverev", sackmann_id=100644)
    mischa = Player(name="Mischa Zverev", sackmann_id=104269)
    db.add_all([sinner, zverev, mischa])
    await db.commit()
    players = tmp_path / "Игроки"
    _profile(players, "Янник-Синнер", "Янник Синнер")
    _profile(players, "Миша-Зверев", "Миша Зверев")
    history = write_history(
        tmp_path / "h.json",
        [record(1, "2026-06-01", [event("Синнер Я.", "Петров П.", "П1", 1.5)])],
    )
    assert await run_fixture("--players", str(players), history=history) == 0
    out = capsys.readouterr().out

    # Имя из истории и профиль — у игрока архива, двойника нет
    leg = await db.scalar(select(BetLeg))
    assert leg is not None
    match = await db.get_one(Match, leg.match_id)
    assert sinner.id in (match.player1_id, match.player2_id)
    await db.refresh(sinner)
    assert {"Синнер Я.", "Янник Синнер"} <= set(sinner.aliases)
    names = set(await db.scalars(select(Player.name)))
    assert "Синнер Я." not in names and "Янник Синнер" not in names
    profiles = list(await db.scalars(select(PlayerProfile)))
    assert [profile.player_id for profile in profiles] == [sinner.id]
    # Зверевых в архиве двое: профиль не перенесен, нового игрока нет, в отчете — причина
    assert "Миша Зверев" not in names
    assert "Миша-Зверев: «Миша Зверев» похож на нескольких игроков архива" in out
