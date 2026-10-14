"""Замер скорости API (app/admin/perf*.py): сид только в отдельную базу и детерминированный,
замер проходит по всем маршрутам на сиде, отчет и порог p95 считаются верно."""

import json
from datetime import UTC, date, datetime
from typing import Any

import pytest
from fastapi import FastAPI
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import perf, perf_measure, perf_seed
from app.admin.terminal import CliError
from app.core.i18n import t
from app.db.base import Base
from app.db.session import create_sessionmaker
from tests.support import SettingsOverride, UserFactory

TINY = perf_seed.Sizes().scaled(0.02)
DAY = date(2026, 10, 14)
_TRUNCATE = "TRUNCATE {} RESTART IDENTITY CASCADE".format(
    ", ".join(f'"{table.name}"' for table in Base.metadata.sorted_tables)
)


def _message(key: str, **params: Any) -> str:
    return t(f"cli.perf.{key}", **params)


# --- защита рабочей базы ---


@pytest.mark.parametrize(
    "name",
    ["capper_perf", "capper_perf_ci", "capper_perf_12345", "capper_perf_main_2"],
)
def test_perf_database_names_accepted(name: str) -> None:
    url = f"postgresql+asyncpg://u:p@localhost:5432/{name}"
    assert perf_seed.check_target(url, confirmed=True) == name


@pytest.mark.parametrize(
    "name", ["capper", "capper_test_1", "capper_performance", "capper_perf_Main", "postgres"]
)
def test_other_databases_refused(name: str) -> None:
    url = f"postgresql+asyncpg://u:p@localhost:5432/{name}"
    with pytest.raises(CliError) as error:
        perf_seed.check_target(url, confirmed=True)
    assert error.value.message == _message("db_name", name=name)


def test_flag_and_prod_required(override_settings: SettingsOverride) -> None:
    url = "postgresql+asyncpg://u:p@localhost:5432/capper_perf"
    with pytest.raises(CliError) as error:
        perf_seed.check_target(url, confirmed=False)
    assert error.value.message == _message("confirm_required")
    override_settings(env="prod")
    with pytest.raises(CliError) as error:
        perf_seed.check_target(url, confirmed=True)
    assert error.value.message == _message("prod")


def test_cli_refuses_working_database(capsys: pytest.CaptureFixture[str]) -> None:
    # Без флага — отказ; с флагом, но база тестов (не capper_perf*) — тоже отказ
    assert perf.main(["seed"]) == 1
    assert _message("confirm_required") in capsys.readouterr().err
    assert perf.main(["measure", "--yes-perf-db"]) == 1
    assert "capper_test_" in capsys.readouterr().err


async def test_seed_needs_empty_database(
    engine: AsyncEngine, db: AsyncSession, make_user: UserFactory
) -> None:
    await make_user()
    with pytest.raises(CliError) as error:
        await perf_seed.seed(create_sessionmaker(engine), today=DAY, sizes=TINY)
    assert error.value.message == _message("db_not_empty", users=1)


# --- сид ---


async def _reset(engine: AsyncEngine) -> None:
    async with engine.begin() as conn:
        await conn.execute(text(_TRUNCATE))
        await conn.execute(text("INSERT INTO app_settings (id) VALUES (1)"))


async def test_seed_is_deterministic(engine: AsyncEngine, db: AsyncSession) -> None:
    maker = create_sessionmaker(engine)
    first = await perf_seed.seed(maker, today=DAY, sizes=TINY)
    await _reset(engine)
    again = await perf_seed.seed(maker, today=DAY, sizes=TINY)
    await _reset(engine)
    other = await perf_seed.seed(maker, today=DAY, sizes=TINY, seed_value=7)
    assert first.digest == again.digest != other.digest
    assert first.counts == again.counts
    counts = first.counts
    assert counts["players"] == TINY.players == counts["player_elo_current"]
    assert counts["users"] == TINY.members + 1
    assert counts["matches"] > 0 and counts["match_stats"] > 0 and counts["player_ratings"] > 0
    # У участника load — все исходы ставок, открытые в игре, исправления и закрытия
    async with maker() as session:
        statuses: dict[str, int] = dict(
            (
                await session.execute(
                    text("SELECT status, count(*) FROM bets WHERE user_id = 2 GROUP BY 1")
                )
            ).all()
        )
        fixes = await session.scalar(
            text("SELECT count(*) FROM bankroll_ledger WHERE kind = 'reversal'")
        )
        closings = await session.scalar(
            text("SELECT count(*) FROM bet_legs WHERE closing_opp_odds IS NOT NULL")
        )
        dense = await session.scalar(
            text(
                "SELECT count(*) FROM agent_runs WHERE user_id = 3"
                " AND created_at >= date_trunc('month', CAST(:day AS timestamptz))"
            ),
            {"day": datetime(DAY.year, DAY.month, DAY.day, tzinfo=UTC)},
        )
    assert {"open", "won", "lost"} <= set(statuses)
    assert statuses["open"] >= 2
    # Ставка, у которой матч ноги совпал с уже занятым ключом матча, отбрасывается: единицы
    assert TINY.member_bets * 0.98 <= sum(statuses.values()) <= TINY.member_bets
    assert fixes and closings
    assert dense == TINY.dense_runs


# --- замер ---


async def test_measure_runs_every_route(engine: AsyncEngine, app: FastAPI) -> None:
    """Сид и замер по одному запросу на маршрут: все отвечают 2xx, у каждого маршрута
    этапа 4 есть время ответа (замер в CI не сломается молча)."""
    await perf_seed.seed(create_sessionmaker(engine), today=datetime.now(UTC).date(), sizes=TINY)
    samples = await perf_measure.measure(app, samples=1, heavy_samples=1)
    keys = set(samples)
    for expected in (
        "GET /api/dashboard",
        "GET /api/dashboard [cold]",
        "GET /api/analytics",
        "GET /api/analytics [cold]",
        "GET /api/bets",
        "GET /api/bets/{bet_id}",
        "GET /api/bets/export.csv",
        "PUT /api/bets/{bet_id}/result",
        "POST /api/bets/{bet_id}/reverse",
        "PUT /api/bets/{bet_id}/legs/{leg_id}/closing",
        "GET /api/me/bank/history",
        "POST /api/me/bank/entries",
        "GET /api/players/ranking",
        "GET /api/players/{player_id}",
        "GET /api/players/{player_id}/h2h/{opponent_id}",
        "GET /api/ai/usage [dense]",
        "GET /api/admin/ai/usage",
        "GET /api/admin/activity",
        "GET /api/me/export [json]",
        "GET /api/me/export [csv]",
        "PUT /api/admin/settings/currency [preview]",
        "POST /api/admin/messages [preview]",
        "GET /api/me [loop]",
        "GET /api/admin/attention",
        "PUT /api/admin/settings/currency",
        "POST /api/admin/messages",
        "PATCH /api/me",
        "POST /api/me/pause",
        "POST /api/me/deletion",
        "DELETE /api/me/deletion",
    ):
        assert expected in keys, expected
    assert all(values and min(values) > 0 for values in samples.values())
    # Пары вернули данные назад: валюта снова рубли, удаление аккаунта отменено
    async with create_sessionmaker(engine)() as db:
        currency = await db.scalar(text("SELECT currency FROM app_settings"))
        pending = await db.scalar(
            text("SELECT count(*) FROM users WHERE deletion_requested_at IS NOT NULL")
        )
    assert (currency, pending) == ("RUB", 0)


def test_percentile_is_nearest_rank() -> None:
    values = [float(n) for n in range(1, 21)]
    assert perf_measure.percentile(values, 0.95) == 19.0
    assert perf_measure.percentile(values, 0.5) == 10.0
    assert perf_measure.percentile([7.0], 0.95) == 7.0
    assert perf_measure.percentile([3.0, 1.0, 2.0], 1.0) == 3.0
    with pytest.raises(ValueError):
        perf_measure.percentile([], 0.5)


def test_report_marks_routes_over_target() -> None:
    samples = {
        "GET /api/fast": [10.0] * 19 + [50.0],
        "GET /api/slow [cold]": [100.0, 400.0],
    }
    targets = {"GET /api/slow [cold]": 300}
    stats = perf_measure.summarize(samples, targets=targets, slack=1.0)
    assert [(item.key, item.p95, item.target, item.ok) for item in stats] == [
        ("GET /api/fast", 10.0, perf_measure.DEFAULT_TARGET, True),
        ("GET /api/slow [cold]", 400.0, 300, False),
    ]
    # Запас CI: цель × slack
    relaxed = perf_measure.summarize(samples, targets=targets, slack=1.5)
    assert all(item.ok for item in relaxed)
    table = perf_measure.report_table(stats).splitlines()
    assert table[0].split()[0] == t("cli.perf.column.route")
    assert set(table[1]) <= {"-", " "}
    assert "GET /api/slow [cold]" in table[3] and t("cli.perf.over") in table[3]
    assert "400.0" in table[3] and "300" in table[3]
    markdown = perf_measure.report_markdown(stats).splitlines()
    assert markdown[0].startswith("| ") and markdown[1].startswith("|---")
    assert markdown[2].startswith("| `GET /api/fast` | 20 | 10.0 | 10.0 | 50.0 | 200 |")
    report = json.loads(perf_measure.report_json(relaxed))
    assert report[1] == {
        "key": "GET /api/slow [cold]",
        "n": 2,
        "p50": 100.0,
        "p95": 400.0,
        "max": 400.0,
        "target": 300,
        "limit": 450,
        "ok": True,
    }
