"""Импорт истории старого бота: python -m app.ingest.legacy.

main(argv) запускает свой цикл событий (asyncio.run), поэтому из асинхронного теста
она вызывается в отдельном потоке, как в tests/test_cli.py. Фикстура истории —
tests/fixtures/legacy/История-ставок.json, ее сюжет (что ожидается в базе и в отчете):

- №1 экспресс, победа: начальный банк 10 000, в JSON банк был пуст — бот считал от нуля;
- №2 поражение; №3 возврат (бот в статистике посчитал его поражением);
- №4 экспресс с нераспознанным рынком «Тотал меньше 22.5», победа нажата дважды;
- №5 банк вырос на 2 000 без ставок — пополнение, корректировка журнала;
- №6 сделана до результата №5 — банк до ставки его не учитывает (журнал верен);
  итоговый кэф 1.95 не равен произведению кэфов 1.869;
- №7 без банка до ставки; №8 без результата (открытая).
Журнал: 10 000 − 200 + 280 − 200 − 150 + 150 − 200 + 482 + 2 000 − 250 − 200 + 390
− 200 − 200 = 11 702. Бот (без списания открытой №8) — 11 902, в JSON — 184:
−10 000 (счет с нуля) − 2 000 (о пополнении бот не знал) + 282 (двойное нажатие №4).
"""

import asyncio
import json
import re
import shutil
import subprocess
import sys
from collections import Counter
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import has_key
from app.db.base import Base
from app.db.models import (
    AdminAuditLog,
    Analysis,
    AppSettings,
    BankrollLedger,
    Bet,
    BetLeg,
    Match,
    OddsSnapshot,
    Player,
    PlayerProfile,
    Prediction,
    StrategyVersion,
    Tournament,
)
from app.ingest import legacy
from app.ingest.legacy_bank import BankBet, BetStatus, plan_bank
from app.ingest.legacy_markets import (
    HCP_MINUS_1_5,
    HCP_PLUS_1_5,
    ML,
    Pick,
    name_key,
    parse_market,
    parse_odds_key,
    parse_surface,
    short_forms,
    short_name,
)
from tests.support import MadeUser, UserFactory

BACKEND_DIR = Path(__file__).resolve().parent.parent
FIXTURES = Path(__file__).resolve().parent / "fixtures" / "legacy"
HISTORY = FIXTURES / "История-ставок.json"
PLAYERS = FIXTURES / "Игроки"
OWNER = "owner@example.com"
YO = chr(0x451)

# Таблицы, которые пишет импорт: после повторного запуска строк не больше
IMPORTED = (
    Analysis,
    Bet,
    BetLeg,
    Prediction,
    OddsSnapshot,
    BankrollLedger,
    Player,
    Tournament,
    Match,
    PlayerProfile,
    StrategyVersion,
)


async def run(*argv: str) -> int:
    return await asyncio.to_thread(legacy.main, list(argv))


async def run_fixture(*extra: str, history: Path = HISTORY) -> int:
    return await run("--email", OWNER, "--history", str(history), *extra)


async def count(db: AsyncSession, model: type[Base]) -> int:
    return int(await db.scalar(select(func.count()).select_from(model)) or 0)


async def counts(db: AsyncSession) -> dict[str, int]:
    return {model.__tablename__: await count(db, model) for model in IMPORTED}


async def ledger_sum(db: AsyncSession, user_id: int) -> Decimal:
    total = await db.scalar(
        select(func.coalesce(func.sum(BankrollLedger.amount), 0)).where(
            BankrollLedger.user_id == user_id
        )
    )
    return Decimal(total or 0)


async def bets_by_ref(db: AsyncSession) -> dict[str, Bet]:
    rows = await db.scalars(select(Bet).execution_options(populate_existing=True))
    return {bet.source_ref or "": bet for bet in rows}


PRIVATE_WORDS = ("bet", "bank", "ledger", "strateg", "lesson", "prediction", "record")


def _private_keys(value: Any) -> list[str]:
    """Ключи на любой глубине, в которых есть слово про ставки, банк или стратегию."""
    if isinstance(value, dict):
        own = [str(k) for k in value if any(w in str(k).lower() for w in PRIVATE_WORDS)]
        return own + [key for item in value.values() for key in _private_keys(item)]
    if isinstance(value, list):
        return [key for item in value for key in _private_keys(item)]
    return []


async def audit_imports(db: AsyncSession) -> list[AdminAuditLog]:
    rows = await db.scalars(
        select(AdminAuditLog).where(AdminAuditLog.action == "import").order_by(AdminAuditLog.id)
    )
    return list(rows)


def write_history(path: Path, records: list[dict[str, Any]], bank: float | None = None) -> Path:
    data = {"meta": {"текущий_банк": bank}, "статистика": {}, "ставки": records}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return path


def record(
    ref: int,
    day: str,
    events: list[dict[str, Any]],
    *,
    status: str = "победа",
    stake: float = 100,
    bank: float | None = 1000,
    total: float | None = None,
) -> dict[str, Any]:
    return {
        "id": ref,
        "дата": day,
        "букмекер": "Тест",
        "банк_до_ставки": bank,
        "сумма_ставки": stake,
        "события": events,
        "экспресс": {"итоговый_кэф": total},
        "результат": {"статус": status},
    }


def event(
    player1: str,
    player2: str,
    market: str,
    odds_taken: float,
    *,
    tournament: str = "Турнир",
    odds: dict[str, float] | None = None,
    probability: float = 60,
) -> dict[str, Any]:
    return {
        "игрок1": player1,
        "игрок2": player2,
        "турнир": tournament,
        "покрытие": "хард",
        "кэфы": odds or {},
        "выбранный_рынок": market,
        "выбранный_кэф": odds_taken,
        "вероятность_процент": probability,
        "обоснование": "тест",
    }


@pytest.fixture
async def owner(make_user: UserFactory) -> MadeUser:
    return await make_user(role="admin", email=OWNER)


# --- импорт фикстуры ---


async def test_import_fixture(
    db: AsyncSession, owner: MadeUser, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await run_fixture("--players", str(PLAYERS)) == 0
    out = capsys.readouterr().out

    # Ставки: число и статусы совпадают с записями
    bets = await bets_by_ref(db)
    assert sorted(bets, key=int) == [str(n) for n in range(1, 9)]
    statuses = Counter(bet.status for bet in bets.values())
    assert statuses == {"won": 3, "lost": 3, "void": 1, "open": 1}
    assert all(bet.user_id == owner.id and bet.source == "legacy" for bet in bets.values())
    assert all(bet.currency == "RUB" for bet in bets.values())
    # Полдень по Москве — 9:00 UTC
    assert bets["1"].placed_at == datetime(2026, 5, 15, 9, 0, tzinfo=UTC)
    assert bets["1"].stake == Decimal("200.00") and bets["1"].total_odds == Decimal("1.400")
    assert bets["1"].profit == Decimal("80.00")
    assert bets["2"].profit == Decimal("-200.00")
    assert bets["3"].status == "void" and bets["3"].profit == Decimal("0.00")
    assert bets["4"].profit == Decimal("282.00")
    assert bets["8"].status == "open" and bets["8"].profit is None
    assert bets["8"].settled_at is None and bets["1"].settled_at is not None

    # Анализы: по одному на запись, исходная запись в parsed
    analyses = list(await db.scalars(select(Analysis).order_by(Analysis.id)))
    assert len(analyses) == 8
    assert all(a.status == "done" and a.user_id == owner.id for a in analyses)
    assert analyses[0].parsed is not None and analyses[0].parsed["id"] == 1
    assert bets["1"].analysis_id == analyses[0].id

    strategy = await db.scalar(select(StrategyVersion))
    assert strategy is not None
    assert (strategy.code, strategy.status, strategy.user_id) == ("legacy", "archived", owner.id)

    # 12 событий, у одного рынок не распознан: 11 прогнозов и 11 строк экспресса
    predictions = list(await db.scalars(select(Prediction)))
    assert len(predictions) == 11
    assert all(p.llm_model == "legacy" for p in predictions)
    assert all(p.strategy_version_id == strategy.id for p in predictions)
    first = await db.scalar(
        select(Prediction).where(Prediction.analysis_id == analyses[0].id, Prediction.market != ML)
    )
    assert first is not None
    assert (first.market, first.selection, first.p_claude) == (HCP_PLUS_1_5, 2, 0.84)
    assert first.as_of == bets["1"].placed_at
    legs = list(await db.scalars(select(BetLeg)))
    assert len(legs) == 11
    assert all(leg.prediction_id is not None for leg in legs)
    results = {
        ref: sorted(str(leg.result) for leg in legs if leg.bet_id == bet.id)
        for ref, bet in bets.items()
    }
    assert results == {
        "1": ["win", "win"],
        "2": ["loss"],
        "3": ["void"],
        "4": ["win"],
        "5": ["loss"],
        "6": ["win", "win", "win"],
        "7": ["loss"],
        "8": ["None"],
    }
    # «П1 (-1,5)» разобран как фора −1.5 первого игрока
    leg5 = next(leg for leg in legs if leg.bet_id == bets["5"].id)
    assert (leg5.market, leg5.selection, leg5.odds_taken) == (HCP_MINUS_1_5, 1, Decimal("2.100"))

    assert await count(db, OddsSnapshot) == 60
    snapshots = list(await db.scalars(select(OddsSnapshot)))
    assert all(s.kind == "user" for s in snapshots)
    # Игроки и турниры — заготовки: «Синнер Я» и «Синнер Я.» — один игрок,
    # «Ролан Гаррос» и «Ролан-Гаррос» — один турнир
    assert await count(db, Player) == 14
    assert await count(db, Tournament) == 2
    tournaments = list(await db.scalars(select(Tournament)))
    assert all(t.source == "legacy" and t.source_ref is None for t in tournaments)
    matches = list(await db.scalars(select(Match)))
    assert len(matches) == 12
    assert all(m.status == "scheduled" and m.source == "legacy" for m in matches)
    assert all(m.tournament_id is not None and m.source_ref for m in matches)

    # Журнал банка
    assert await ledger_sum(db, owner.id) == Decimal("11702.00")
    ledger = list(await db.scalars(select(BankrollLedger).order_by(BankrollLedger.at)))
    assert Counter(entry.kind for entry in ledger) == {
        "deposit": 1,
        "stake": 8,
        "payout": 3,
        "refund": 1,
        "correction": 1,
    }
    assert ledger[0].kind == "deposit" and ledger[0].amount == Decimal("10000.00")
    assert ledger[0].note is not None and "№1" in ledger[0].note
    [correction] = [entry for entry in ledger if entry.kind == "correction"]
    assert correction.amount == Decimal("2000.00") and correction.bet_id is None
    assert correction.note is not None and "№5" in correction.note
    assert "пополнение" in correction.note
    assert correction.at < bets["5"].placed_at
    payouts = {entry.bet_id: entry.amount for entry in ledger if entry.kind == "payout"}
    assert payouts == {
        bets["1"].id: Decimal("280.00"),
        bets["4"].id: Decimal("482.00"),
        bets["6"].id: Decimal("390.00"),
    }

    # Профили: 01–04 у игроков из истории, 05 и 06 пропущены
    profiles = list(await db.scalars(select(PlayerProfile)))
    assert len(profiles) == 2
    for profile in profiles:
        assert profile.source == "legacy_llm"
        assert sorted(profile.profile) == ["01", "02", "03", "04"]
        player = await db.get(Player, profile.player_id)
        assert player is not None
        assert player.name_ru in {"Навоне М.", "Меджедович Х."}
    navone = await db.scalar(select(Player).where(Player.name_ru == "Навоне М."))
    assert navone is not None and "Маттео Навоне" in navone.aliases

    # Журнал администратора: сводка без сумм, ставок и банка (Р14)
    [entry] = await audit_imports(db)
    assert entry.actor_id is None and entry.target_user_id == owner.id
    assert entry.details["source"] == "terminal"
    assert sorted(entry.details) == [
        "file",
        "matches_created",
        "players_created",
        "profiles",
        "source",
        "tournaments_created",
        "unknown_markets",
        "warnings",
    ]
    assert not _private_keys(entry.details)
    assert not re.search(r"11702|10000|2000\b|184", json.dumps(entry.details))

    # Отчет
    for expected in (
        "Импорт записан в базу",
        "Новых ставок: 8",
        "победа 3, поражение 3, возврат 1, без результата 1",
        "начальный банк: 10 000,00 ₽ (из записи №1)",
        "по журналу: 11 702,00 ₽",
        "не списывал: 1 на 200,00 ₽",
        "как считал бот: 11 902,00 ₽",
        "в JSON (meta.текущий_банк): 184,00 ₽",
        "разница с JSON: -11 718,00 ₽",
        "с нуля",
        "-10 000,00 ₽",
        "не знал о корректировках журнала",
        "-2 000,00 ₽",
        "результат ставки №4 (победа) внесен дважды",
        "+282,00 ₽",
        "ставка №5: банк до ставки 12 162,00 ₽, по журналу 10 162,00 ₽. "
        "Записана корректировка +2 000,00 ₽",
        "ставка №6: банк до ставки 12 162,00 ₽, по журналу 11 912,00 ₽. Журнал верен",
        "результат ставок №5 внесли уже после этой ставки: +250,00 ₽",
        "ставка №7: в записи нет банка до ставки",
        "бот считал возвраты поражениями",
        "ставка №4, событие 1: рынок «Тотал меньше 22.5»",
        "ставка №4, событие 1: кэф «тотал_меньше_22_5»",
        "итоговый кэф 1.95 не равен произведению кэфов событий 1.869",
        "Профили игроков: новых 2",
        "Пропущено файлов 05 и 06: 3 (у игроков: 2)",
    ):
        assert expected in out, expected


async def test_rerun_creates_no_duplicates(
    db: AsyncSession, owner: MadeUser, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await run_fixture("--players", str(PLAYERS)) == 0
    before = await counts(db)
    capsys.readouterr()

    assert await run_fixture("--players", str(PLAYERS)) == 0
    out = capsys.readouterr().out
    assert await counts(db) == before
    assert await ledger_sum(db, owner.id) == Decimal("11702.00")
    assert "Новых ставок: 0, уже были в базе: 8" in out
    assert "Профили игроков: новых 0, обновлено 0, без изменений 2" in out
    assert "Игроки: создано 0" in out
    assert len(await audit_imports(db)) == 2


async def test_dry_run_writes_nothing(
    db: AsyncSession, owner: MadeUser, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await run_fixture("--players", str(PLAYERS), "--dry-run") == 0
    out = capsys.readouterr().out
    assert "--dry-run" in out and "Импорт записан" not in out
    assert "Новых ставок: 8" in out and "по журналу: 11 702,00 ₽" in out
    assert all(value == 0 for value in (await counts(db)).values())
    assert await audit_imports(db) == []


async def test_appended_history_continues_ledger(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Сначала импорт начала файла, потом всего файла: начальный банк не дублируется,
    новые ставки продолжают тот же журнал."""
    full = json.loads(HISTORY.read_text(encoding="utf-8"))
    part = dict(full, ставки=full["ставки"][:4])
    early = tmp_path / "История-ставок.json"
    early.write_text(json.dumps(part, ensure_ascii=False), encoding="utf-8")
    assert await run_fixture(history=early) == 0
    assert await ledger_sum(db, owner.id) == Decimal("10162.00")

    assert await run_fixture() == 0
    assert "Новых ставок: 4, уже были в базе: 4" in capsys.readouterr().out
    assert await count(db, Bet) == 8
    assert await ledger_sum(db, owner.id) == Decimal("11702.00")
    deposits = await db.scalar(
        select(func.count()).where(BankrollLedger.kind == "deposit").select_from(BankrollLedger)
    )
    assert deposits == 1


async def test_changed_result_is_reported_not_rewritten(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    assert await run_fixture() == 0
    data = json.loads(HISTORY.read_text(encoding="utf-8"))
    data["ставки"][7]["результат"]["статус"] = "победа"
    changed = tmp_path / "История-ставок.json"
    changed.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    capsys.readouterr()

    assert await run_fixture(history=changed) == 0
    out = capsys.readouterr().out
    assert "ставка №8 уже в базе со статусом «без результата», а в JSON — «победа»" in out
    assert (await bets_by_ref(db))["8"].status == "open"
    # Выплаты по №8 в базе нет: журнал по файлу больше на 200 × 1.22
    assert "журнал в базе отличается от журнала по файлу на -244,00 ₽" in out
    assert "повторный импорт:" not in out


async def test_fixed_broken_record_rerun(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    """Битую запись исправили и запустили импорт еще раз: начальный банк второй раз не
    пишется, журнал в базе одной корректировкой приводится к пересчитанному по файлу."""
    pair = [event("Иванов И.", "Петров П.", "П1", 2)]
    second = record(2, "2026-06-02", pair, status="поражение", bank=9900)
    history = write_history(
        tmp_path / "h.json",
        [record(1, "не дата", pair, status="поражение", bank=10000), second],
    )
    assert await run_fixture(history=history) == 0
    assert await ledger_sum(db, owner.id) == Decimal("9800.00")
    capsys.readouterr()

    fixed = record(1, "2026-06-01", pair, status="поражение", bank=10000)
    write_history(history, [fixed, second])
    assert await run_fixture(history=history) == 0
    out = capsys.readouterr().out
    assert await ledger_sum(db, owner.id) == Decimal("9800.00")
    kinds = Counter(
        kind for kind in await db.scalars(select(BankrollLedger.kind).order_by(BankrollLedger.id))
    )
    assert kinds == {"deposit": 1, "stake": 2, "correction": 1}
    reconcile = await db.scalar(select(BankrollLedger).where(BankrollLedger.kind == "correction"))
    assert reconcile is not None and reconcile.amount == Decimal("100.00")
    assert reconcile.note is not None and "Повторный импорт" in reconcile.note
    assert "записи №1 стоят раньше уже перенесенных" in out
    assert "записана корректировка +100,00 ₽" in out
    assert "журнал в базе отличается" not in out

    # Третий запуск того же файла ничего не меняет
    assert await run_fixture(history=history) == 0
    assert "повторный импорт:" not in capsys.readouterr().out
    assert await ledger_sum(db, owner.id) == Decimal("9800.00")

    # В файле нет ставки, которая уже в базе: пересчет неполный, журнал не трогается
    write_history(history, [fixed])
    assert await run_fixture(history=history) == 0
    out = capsys.readouterr().out
    assert "в базе есть ставки, которых нет среди записей файла (№2)" in out
    assert "журнал в базе отличается от журнала по файлу на -100,00 ₽" in out
    assert await ledger_sum(db, owner.id) == Decimal("9800.00")


# --- отдельные случаи ---


async def test_unknown_market_does_not_fail(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    history = write_history(
        tmp_path / "h.json",
        [
            record(
                1,
                "2026-06-01",
                [
                    event("Иванов И.", "Петров П.", "Фора1 (-3.5)", 1.9),
                    event("Сидоров С.", "Смирнов А.", "Тотал больше 22.5", 1.8),
                ],
                status="поражение",
                total=3.42,
            )
        ],
        bank=900,
    )
    assert await run_fixture(history=history) == 0
    out = capsys.readouterr().out
    assert "ставка №1, событие 1: рынок «Фора1 (-3.5)»" in out
    assert "ставка №1, событие 2: рынок «Тотал больше 22.5»" in out
    [bet] = (await bets_by_ref(db)).values()
    assert bet.status == "lost" and bet.total_odds == Decimal("3.420")
    assert await count(db, BetLeg) == 0
    assert await count(db, Prediction) == 0
    assert await count(db, Match) == 2
    assert "сходится с JSON" in out


async def test_same_match_reversed_order_and_next_day(
    db: AsyncSession, owner: MadeUser, tmp_path: Path
) -> None:
    """Пара в обратном порядке в тот же день и ставка на следующий день на том же
    турнире — тот же матч; сторона исхода и кэфы переворачиваются."""
    odds = {"п1": 1.5, "п2": 2.6}
    history = write_history(
        tmp_path / "h.json",
        [
            record(1, "2026-06-01", [event("Иванов И.", "Петров П.", "П1", 1.5, odds=odds)]),
            record(
                2,
                "2026-06-01",
                [event("Петров П.", "Иванов И.", "П1", 2.6, odds={"п1": 2.6, "п2": 1.5})],
            ),
            record(3, "2026-06-02", [event("Петров П.", "Иванов И.", "П2(-1.5)", 2.4)]),
        ],
    )
    assert await run_fixture(history=history) == 0
    [match] = list(await db.scalars(select(Match)))
    ivanov = await db.scalar(select(Player.id).where(Player.name == "Иванов И."))
    assert match.player1_id == ivanov
    picks = [
        (leg.market, leg.selection, leg.odds_taken)
        for leg in await db.scalars(select(BetLeg).order_by(BetLeg.id))
    ]
    assert picks == [
        (ML, 1, Decimal("1.500")),
        (ML, 2, Decimal("2.600")),
        (HCP_MINUS_1_5, 1, Decimal("2.400")),
    ]
    # Кэфы одного снимка не дублируются: у записей 1 и 2 одинаковые кэфы на одну пару
    rows = await db.execute(select(OddsSnapshot.market, OddsSnapshot.selection, OddsSnapshot.odds))
    assert sorted((market, side, value) for market, side, value in rows) == [
        (HCP_MINUS_1_5, 1, Decimal("2.400")),
        (ML, 1, Decimal("1.500")),
        (ML, 2, Decimal("2.600")),
    ]


async def test_same_name_tournament_months_apart(
    db: AsyncSession, owner: MadeUser, tmp_path: Path
) -> None:
    """Одноименный турнир через несколько месяцев — другой турнир, и та же пара на нем —
    другой матч; ставка на следующий день — тот же матч."""
    pair = [event("Иванов И.", "Петров П.", "П1", 1.5, tournament="Челленджер")]
    history = write_history(
        tmp_path / "h.json",
        [
            record(1, "2026-03-01", pair),
            record(2, "2026-03-02", pair),
            record(3, "2026-06-01", pair),
        ],
    )
    assert await run_fixture(history=history) == 0
    tournaments = list(await db.scalars(select(Tournament).order_by(Tournament.start_date)))
    assert [t.start_date for t in tournaments] == [date(2026, 3, 1), date(2026, 6, 1)]
    match_of = {
        bet.source_ref: (await db.scalar(select(BetLeg.match_id).where(BetLeg.bet_id == bet.id)))
        for bet in (await bets_by_ref(db)).values()
    }
    assert match_of["1"] == match_of["2"] != match_of["3"]
    june = await db.get(Match, match_of["3"])
    assert june is not None and june.tournament_id == tournaments[1].id


async def test_other_currency_and_broken_records(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    await db.execute(update(AppSettings).values(currency="EUR"))
    await db.commit()
    good = record(5, "2026-06-03", [event("Иванов И.", "Петров П.", "П1", 1.5)], bank=None)
    history = write_history(
        tmp_path / "h.json",
        [
            {"дата": "2026-06-01"},
            record(2, "не дата", [event("Иванов И.", "Петров П.", "П1", 1.5)]),
            record(3, "2026-06-01", [event("Иванов И.", "Петров П.", "П1", 1.5)], stake=0),
            record(4, "2026-06-02", [event("Иванов И.", "Иванов И.", "П1", 1.5)]),
            good,
            good,
        ],
    )
    assert await run_fixture(history=history) == 0
    out = capsys.readouterr().out
    assert "валюта программы — EUR" in out
    for expected in (
        "запись 1 в файле: нет id",
        "ставка №2: нет даты или она неверная (не дата)",
        "ставка №3: нет суммы ставки",
        "ставка №4: нет итогового кэфа",
        "ставка №4, событие 1: оба игрока — Иванов И.",
        "ставка №5: такой id в файле уже был",
        "начального банка нет ни в одной записи",
    ):
        assert expected in out, expected
    [bet] = (await bets_by_ref(db)).values()
    assert bet.source_ref == "5" and bet.currency == "EUR"


async def test_profile_without_history_player(
    db: AsyncSession, owner: MadeUser, tmp_path: Path, capsys: pytest.CaptureFixture[str]
) -> None:
    players = tmp_path / "Игроки"
    shutil.copytree(PLAYERS / "Маттео-Навоне", players / "Феликс-Оже-Альяссим")
    personal = players / "Феликс-Оже-Альяссим" / "01-личные-данные.json"
    data = json.loads(personal.read_text(encoding="utf-8"))
    data["личные_данные"]["фио"] = "Феликс Оже-Альяссим"
    personal.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    (players / "Пустой").mkdir()
    (players / "Битый").mkdir()
    (players / "Битый" / "02-игровой-профиль.json").write_text("{", encoding="utf-8")
    history = write_history(
        tmp_path / "h.json",
        [record(1, "2026-06-01", [event("Оже-Альяссим Ф.", "Петров П.", "П1", 1.5)])],
    )
    assert await run_fixture("--players", str(players), history=history) == 0
    out = capsys.readouterr().out
    # Профиль привязан к игроку из истории по короткому имени «Фамилия И.»
    [profile] = list(await db.scalars(select(PlayerProfile)))
    player = await db.get(Player, profile.player_id)
    assert player is not None and player.name_ru == "Оже-Альяссим Ф."
    assert "Феликс Оже-Альяссим" in player.aliases
    assert "Пустой: нет файлов 01–04" in out
    assert "Битый/02-игровой-профиль.json: не читается как JSON" in out

    # Профиль из другого источника не перезаписывается; новый игрок создается заготовкой
    profile.source = "manual"
    await db.commit()
    shutil.copytree(PLAYERS / "Хамад-Меджедович", players / "Хамад-Меджедович")
    assert await run_fixture("--players", str(players), history=history) == 0
    out = capsys.readouterr().out
    assert "у игрока уже есть профиль из источника manual" in out
    new = await db.scalar(select(Player).where(Player.name == "Хамад Меджедович"))
    assert new is not None
    assert {"Хамад Меджедович", "Меджедович Х."} <= set(new.aliases)
    assert await db.get(PlayerProfile, new.id) is not None


# --- ошибки команды ---


async def test_errors_exit_code_1(
    db: AsyncSession,
    make_user: UserFactory,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert await run_fixture() == 1
    assert OWNER in capsys.readouterr().err

    await make_user(email="gone@example.com", status="deleted")
    assert await run("--email", "gone@example.com", "--history", str(HISTORY)) == 1
    assert "удален" in capsys.readouterr().err

    await make_user(email=OWNER)
    assert await run_fixture(history=tmp_path / "missing.json") == 1
    assert "не найден" in capsys.readouterr().err
    broken = tmp_path / "broken.json"
    broken.write_text('{"ставки": [', encoding="utf-8")
    assert await run_fixture(history=broken) == 1
    assert "не читается как JSON" in capsys.readouterr().err
    other = tmp_path / "other.json"
    other.write_text('{"игроки": []}', encoding="utf-8")
    assert await run_fixture(history=other) == 1
    assert "ставки" in capsys.readouterr().err
    assert await run_fixture("--players", str(tmp_path / "nope")) == 1
    assert "Папка игроков не найдена" in capsys.readouterr().err
    assert await count(db, Bet) == 0


def test_help_runs_as_module() -> None:
    done = subprocess.run(
        [sys.executable, "-m", "app.ingest.legacy", "--help"],
        cwd=BACKEND_DIR,
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert "--dry-run" in done.stdout and "История-ставок.json" in done.stdout


def test_locale_keys_exist() -> None:
    """Каждый ключ ingest.legacy.*, который упоминает код импорта, есть в ru.json."""
    source = (BACKEND_DIR / "app" / "ingest" / "legacy.py").read_text(encoding="utf-8")
    keys = set(re.findall(r'"((?:report|issue|note|errors|help|status)\.[a-z_.]+)"', source))
    keys |= {f"errors.{key}" for key in re.findall(r'ImportFailure\(\s*"([a-z_]+)"', source)}
    keys |= {f"note.{key}" for key in ("deposit", "deposit_inferred")}
    keys |= {f"note.{key}" for key in ("correction_up", "correction_down", "reconcile")}
    keys |= {f"status.{key}" for key in ("won", "lost", "void", "open")}
    keys |= {
        f"report.cause.{key}"
        for key in ("start_from_zero", "unknown_corrections", "late_result", "double_click")
    }
    keys |= {"description", "analysis_input", "strategy_name"}
    missing = sorted(key for key in keys if not has_key(f"ingest.legacy.{key}"))
    assert missing == []
    assert len(keys) > 60


# --- журнал банка без базы ---

DAY = datetime(2026, 5, 1, 9, tzinfo=UTC)


def bank_bet(
    ref: int, status: BetStatus, bank: str | None, *, stake: str = "100", odds: str = "2"
) -> BankBet:
    return BankBet(
        str(ref),
        DAY + timedelta(days=ref),
        Decimal(stake),
        Decimal(odds),
        status,
        Decimal(bank) if bank is not None else None,
    )


def test_bank_start_inferred_from_later_record() -> None:
    plan = plan_bank(
        [bank_bet(1, "won", None), bank_bet(2, "lost", "1100")], json_bank=Decimal("1000")
    )
    deposit = plan.entries[0]
    assert (deposit.kind, deposit.amount, deposit.ref) == ("deposit", Decimal("1000.00"), "2")
    assert deposit.at < DAY + timedelta(days=1)
    assert [c.outcome for c in plan.checks] == ["missing", "start"]
    assert plan.ledger_total == Decimal("1000.00")
    assert plan.final_causes == ()


def test_bank_bot_errors_in_record_are_corrected_with_hint() -> None:
    """Ошибки числа бота при сверке записи денег не двигают: расхождение записывается
    корректировкой, совпадение с ошибкой бота — подсказка в отчете. Итог с JSON
    объясняется ими же."""
    # Двойное нажатие «Победа» у №1: бот считал 1 200 вместо 1 100
    plan = plan_bank(
        [bank_bet(1, "won", "1000"), bank_bet(2, "lost", "1200")], json_bank=Decimal("1100")
    )
    [check] = plan.checks
    assert (check.outcome, check.diff) == ("corrected", Decimal("100.00"))
    assert [(c.kind, c.refs) for c in check.causes] == [("double_click", ("1",))]
    assert [c.amount for c in plan.corrections] == [Decimal("100.00")]
    assert plan.final_causes == ()

    # Бот взял банк из своего файла, где счет шел от нуля
    plan = plan_bank(
        [bank_bet(1, "won", "1000"), bank_bet(2, "lost", "100")], json_bank=Decimal("0")
    )
    [check] = plan.checks
    assert (check.outcome, check.diff) == ("corrected", Decimal("-1000.00"))
    assert [c.kind for c in check.causes] == ["start_from_zero"]
    assert plan.ledger_total == Decimal("0.00") and plan.final_causes == ()


def test_bank_real_money_moves_are_corrected() -> None:
    """Вывод на сумму прежнего пополнения, начального банка или последнего проигрыша —
    корректировка, а не «журнал верен»."""
    # Пополнение на 2 000 и вывод тех же 2 000
    plan = plan_bank(
        [bank_bet(1, "lost", "10000"), bank_bet(2, "lost", "11900"), bank_bet(3, "lost", "9800")],
        json_bank=None,
    )
    assert [c.amount for c in plan.corrections] == [Decimal("2000.00"), Decimal("-2000.00")]
    assert [c.kind for c in plan.checks[1].causes] == ["unknown_corrections"]
    assert plan.ledger_total == Decimal("9700.00")
    # Вывод ровно начального банка
    plan = plan_bank(
        [
            bank_bet(1, "won", "5000", stake="1000", odds="3"),
            bank_bet(2, "lost", "2000"),
        ],
        json_bank=None,
    )
    assert [c.amount for c in plan.corrections] == [Decimal("-5000.00")]
    assert plan.ledger_total == Decimal("1900.00")
    # Вывод 200 сразу после проигрыша 200
    plan = plan_bank(
        [bank_bet(1, "lost", "10000", stake="200"), bank_bet(2, "lost", "9600", stake="200")],
        json_bank=None,
    )
    assert [c.amount for c in plan.corrections] == [Decimal("-200.00")]
    assert plan.ledger_total == Decimal("9400.00")


def test_bank_persistent_offset_is_corrected_once() -> None:
    """Сдвиг, который держится во всех следующих записях (бот брал банк из своего файла
    после двойного нажатия), — одна корректировка в первой записи, дальше записи
    сходятся с журналом."""
    bets = [bank_bet(1, "won", "1000", odds="2.5")]
    bets += [bank_bet(n, "lost", str(1500 - 100 * n)) for n in range(2, 7)]
    plan = plan_bank(bets, json_bank=Decimal("800"))
    [check] = plan.checks
    assert (check.ref, check.outcome, check.diff) == ("2", "corrected", Decimal("150.00"))
    assert [(c.kind, c.refs) for c in check.causes] == [("double_click", ("1",))]
    assert len(plan.corrections) == 1
    assert plan.ledger_total == Decimal("800.00") and plan.final_causes == ()


def test_bank_late_result_and_open_bets() -> None:
    plan = plan_bank(
        [
            bank_bet(1, "lost", "1000"),
            # Сделана до того, как внесли проигрыш №1
            bank_bet(2, "won", "1000"),
            bank_bet(3, "open", "1000", stake="50"),
        ],
        json_bank=Decimal("1000"),
    )
    [check] = plan.checks
    assert check.ref == "2" and check.outcome == "explained"
    assert [(c.kind, c.refs) for c in check.causes] == [("late_result", ("1",))]
    assert plan.corrections == []
    assert plan.open_count == 1 and plan.open_stakes == Decimal("50")
    assert plan.ledger_total == Decimal("950.00")
    assert plan.bot_view_total == Decimal("1000.00")
    assert plan.final_causes == ()


def test_bank_result_seen_in_bank_is_not_late() -> None:
    """Проигрыш №1 уже вошел в банк записи №2, поэтому к записи №3 он «опоздать» не мог:
    рост на 100 — корректировка."""
    plan = plan_bank(
        [bank_bet(1, "lost", "1000"), bank_bet(2, "won", "900"), bank_bet(3, "lost", "1100")],
        json_bank=None,
    )
    [check] = plan.checks
    assert (check.ref, check.outcome, check.diff) == ("3", "corrected", Decimal("100.00"))
    assert plan.ledger_total == Decimal("1000.00")


def test_bank_start_without_deposit() -> None:
    """Первый банк не больше журнала по ставкам без банка: пополнения нет, но сверка
    начата, и позднее пополнение — корректировка в своей записи, а не начальный банк."""
    plan = plan_bank(
        [
            bank_bet(1, "won", None, odds="3"),
            bank_bet(2, "lost", "150"),
            bank_bet(3, "lost", "50"),
            bank_bet(4, "lost", "5000"),
        ],
        json_bank=None,
    )
    assert all(entry.kind != "deposit" for entry in plan.entries)
    assert plan.starting_bank is None and plan.start_ref == "2"
    assert [(c.ref, c.outcome, c.diff) for c in plan.checks] == [
        ("1", "missing", Decimal(0)),
        ("2", "corrected", Decimal("-50.00")),
        ("4", "corrected", Decimal("5050.00")),
    ]
    late = plan.corrections[-1]
    assert late.ref == "4" and late.at == DAY + timedelta(days=4, seconds=-1)
    assert plan.ledger_total == Decimal("4900.00")


def test_bank_deposit_equal_to_old_losses_is_corrected() -> None:
    """Пополнение на 1 000 после пяти проигрышей по 200 — корректировка, а не «поздний
    ввод результатов»: так далеко назад поздний ввод не ищется."""
    bets = [bank_bet(n, "lost", str(1200 - 200 * n), stake="200") for n in range(1, 6)]
    bets.append(bank_bet(6, "lost", "1000", stake="200"))
    plan = plan_bank(bets, json_bank=None)
    [check] = plan.checks
    assert (check.ref, check.outcome, check.diff) == ("6", "corrected", Decimal("1000.00"))
    assert plan.corrections[0].note_key == "correction_up"
    assert plan.final_diff is None


def test_bank_unexplained_and_nonpositive() -> None:
    plan = plan_bank(
        [
            bank_bet(1, "lost", "1000"),
            bank_bet(2, "lost", "-100"),
            bank_bet(3, "lost", "650"),
        ],
        json_bank=Decimal("12345"),
    )
    assert [c.outcome for c in plan.checks] == ["nonpositive", "corrected"]
    [correction] = plan.corrections
    assert correction.amount == Decimal("-150.00")
    assert correction.note_key == "correction_down"
    assert plan.ledger_total == Decimal("550.00")
    assert plan.final_causes is None


# --- разбор полей записи ---


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("П1", Pick(ML, 1)),
        ("п2", Pick(ML, 2)),
        ("P1", Pick(ML, 1)),
        ("П1(-1.5)", Pick(HCP_MINUS_1_5, 1)),
        ("П2(+1.5)", Pick(HCP_PLUS_1_5, 2)),
        ("П2 (+1,5)", Pick(HCP_PLUS_1_5, 2)),
        (f"П1({chr(0x2212)}1.5)", Pick(HCP_MINUS_1_5, 1)),
        ("П2 -1.5", Pick(HCP_MINUS_1_5, 2)),
        ("Тотал меньше 22.5", None),
        ("П1(-2.5)", None),
        ("П1(1.5)", None),
        ("П3", None),
        ("", None),
        (None, None),
    ],
)
def test_parse_market(raw: object, expected: Pick | None) -> None:
    assert parse_market(raw) == expected


def test_odds_keys_names_and_surfaces() -> None:
    assert parse_odds_key("п1_минус_1_5") == Pick(HCP_MINUS_1_5, 1)
    assert parse_odds_key("П2_ПЛЮС_1_5") == Pick(HCP_PLUS_1_5, 2)
    assert parse_odds_key("тотал_меньше_22_5") is None
    assert Pick(ML, 1).flipped() == Pick(ML, 2)

    assert name_key("Навоне М.") == name_key("навоне  м")
    assert name_key("Оже-Альяссим Ф.") == name_key("Оже Альяссим Ф")
    assert name_key(f"Пот{YO}мкин") == name_key("Потемкин")
    assert short_name("Маттео Навоне") == "Навоне М."
    assert short_name("Навоне") is None
    assert short_forms("Маттео Навоне")[0] == name_key("Навоне М.")
    assert name_key("Оже-Альяссим Ф.") in short_forms("Феликс Оже-Альяссим")

    assert parse_surface("грунт") == ("clay", None)
    assert parse_surface("Хард (зал)") == ("hard", True)
    assert parse_surface("крытый") == ("hard", True)
    assert parse_surface("трава") == ("grass", None)
    assert parse_surface("луна") == (None, None)
