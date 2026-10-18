"""Команда parse-eval (приемка этапа 3) на поддельном Claude: формат эталона, сверка
игроков (поиском в базе), рынков и кэфов, доля верных сообщений и код возврата, учет как
проверки и бюджет проверок, черновик эталона из экспорта Telegram Desktop."""

import asyncio
import json
from collections.abc import Iterator
from decimal import Decimal
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.admin import acceptance, cli
from app.agent.schemas import ParsedInput
from app.db.models import AgentRun, AppSettings
from app.services import parse_eval
from app.services.parse_eval import PairsError
from tests.analysis_helpers import install, seed_world, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude, parse_text

SINNER_RUNE = """Текущий банк: 10 000 ₽
Букмекер: Fonbet

События:
Jannik Sinner vs Holger Rune, Shanghai, хард, 1/8
Кэфы: П1 = 1.17, П2 = 5.10
Фора по сетам: П1(-1.5) = 1.62, П2(+1.5) = 2.30"""

TWO_EVENTS = """Djokovic vs Rublev, Paris, хард
Кэфы: П1 = 1.45, П2 = 2.80
Alcaraz vs Medvedev, Paris, хард
Кэфы: П1 = 1.35, П2 = 3.20"""


def _pairs() -> list[dict[str, Any]]:
    return [
        {
            "text": SINNER_RUNE,
            "expected": {
                "events": [
                    {
                        "player1": "Sinner",
                        "player2": "Rune",
                        "odds": {
                            "ML": ["1.17", "5.10"],
                            "HCP_-1.5": ["1.62", None],
                            "HCP_+1.5": [None, "2.30"],
                        },
                    }
                ]
            },
        },
        {
            "text": TWO_EVENTS,
            "expected": {
                "events": [
                    {"player1": "Novak Djokovic", "player2": "Rublev", "odds": {"ML": [1.45, 2.8]}},
                    {"player1": "Alcaraz", "player2": "Medvedev", "odds": {"ML": ["1.35", "3.2"]}},
                ]
            },
        },
    ]


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> dict[str, int]:
    found = await seed_world(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


def _write(path: Path, data: Any) -> str:
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return str(path)


# --- формат эталона ---


@pytest.mark.parametrize(
    ("raw", "key"),
    [
        ({}, "not_list"),
        ([], "not_list"),
        (["x"], "pair"),
        ([{"text": "", "expected": {"events": []}}], "text"),
        ([{"text": "a", "expected": {}}], "expected"),
        ([{"text": "a", "expected": {"events": [{"player1": "", "player2": "B"}]}}], "player"),
        ([{"text": "a", "expected": {"events": [{"player1": True, "player2": "B"}]}}], "player"),
        (
            [
                {
                    "text": "a",
                    "expected": {
                        "events": [{"player1": "A", "player2": "B", "odds": {"ML": ["x", "1"]}}]
                    },
                }
            ],
            "odds",
        ),
        (
            [
                {
                    "text": "a",
                    "expected": {
                        "events": [{"player1": "A", "player2": "B", "odds": {"ML": ["1.5"]}}]
                    },
                }
            ],
            "odds",
        ),
        (
            [
                {
                    "text": "a",
                    "expected": {
                        "events": [
                            {"player1": "A", "player2": "B", "odds": {"HCP_-3.5": [None, None]}}
                        ]
                    },
                }
            ],
            "market",
        ),
    ],
)
def test_pairs_format(raw: Any, key: str) -> None:
    with pytest.raises(PairsError) as caught:
        parse_eval.load_pairs(raw)
    assert caught.value.key == key


def test_pairs_load() -> None:
    pairs = parse_eval.load_pairs(_pairs())
    assert [len(pair.events) for pair in pairs] == [1, 2]
    first = pairs[0].events[0]
    assert first.odds["ML"] == [Decimal("1.170"), Decimal("5.100")]
    assert first.odds["HCP_+1.5"] == [None, Decimal("2.300")]
    assert pairs[1].events[0].odds["HCP_-1.5"] == [None, None]
    assert (
        parse_eval.load_pairs(
            [{"text": "a", "expected": {"events": [{"player1": 5, "player2": "B"}]}}]
        )[0]
        .events[0]
        .player1
        == 5
    )


# --- сверка ---


async def test_compare_players_markets_odds(db: AsyncSession, world: dict[str, int]) -> None:
    pairs = parse_eval.load_pairs(_pairs())
    parsed = ParsedInput.model_validate(parse_text(SINNER_RUNE))
    assert await parse_eval.compare(db, parsed, pairs[0].events) == []
    # Игрок по id — тоже годится
    by_id = parse_eval.load_pairs(
        [
            {
                "text": "x",
                "expected": {
                    "events": [
                        {
                            "player1": world["sinner"],
                            "player2": "Rune",
                            "odds": {
                                "ML": ["1.17", "5.1"],
                                "HCP_-1.5": ["1.62", None],
                                "HCP_+1.5": [None, "2.3"],
                            },
                        }
                    ]
                },
            }
        ]
    )
    assert await parse_eval.compare(db, parsed, by_id[0].events) == []
    # Ошибки: другой игрок, другой кэф, нет форы, лишнее событие
    wrong = parse_eval.load_pairs(
        [
            {
                "text": "x",
                "expected": {
                    "events": [
                        {
                            "player1": "Sinner",
                            "player2": "Rublev",
                            "odds": {"ML": ["1.18", "5.10"]},
                        },
                        {"player1": "Alcaraz", "player2": "Medvedev"},
                    ]
                },
            }
        ]
    )
    diffs = await parse_eval.compare(db, parsed, wrong[0].events)
    kinds = [kind for kind, _ in diffs]
    assert kinds.count("events") == 1 and kinds.count("player") == 1
    odds = [params for kind, params in diffs if kind == "odds"]
    assert {(o["market"], o["side"], o["expected"], o["parsed"]) for o in odds} == {
        ("ML", 1, "1.18", "1.17"),
        ("HCP_-1.5", 1, "—", "1.62"),
        ("HCP_+1.5", 2, "—", "2.3"),
    }
    missing = parse_eval.load_pairs(
        [{"text": "x", "expected": {"events": [{"player1": "Zzzzzz Qqqqq", "player2": "Rune"}]}}]
    )
    diffs = await parse_eval.compare(db, parsed, missing[0].events)
    assert ("expected_missing", {"event": 1, "side": 1, "name": "Zzzzzz Qqqqq"}) in diffs


# --- команда ---


async def test_parse_eval_command(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pairs = _write(tmp_path / "pairs.json", _pairs())
    report = tmp_path / "parse.md"
    # 2 пары из 50: все верны — пробный прогон (код 3), а не приемка
    assert (
        await asyncio.to_thread(
            cli.main, ["parse-eval", "--file", pairs, "--yes", "--report", str(report)]
        )
        == 3
    )
    printed = capsys.readouterr()
    out = printed.out
    assert "Разобрано верно: 2 из 2 (100,0%)" in out
    assert "в худшем случае до $" in out and "Сообщений: 2," in out
    assert "пробный прогон" in out and "приемка — от 50" in printed.err
    runs = list(await db.scalars(select(AgentRun)))
    assert len(runs) == 2 and all(r.kind == "eval" and not r.batch for r in runs)
    assert {r.model for r in runs} == {"claude-haiku-5-5"}
    text = report.read_text(encoding="utf-8")
    assert "**Критерий выполнен, но сообщений 2, а приемка — от 50" in text
    assert f"Эталон {pairs}:" in text

    # На размере приемки — код 0; через bash deploy/local.sh в отчете и выводе — имя файла
    # владельца, а не временный путь в контейнере
    monkeypatch.setattr(acceptance, "ACCEPTANCE_PAIRS", 2)
    args = ["parse-eval", "--file", pairs, "--yes", "--report", str(report), "--local-sh"]
    assert await asyncio.to_thread(cli.main, [*args, "--file-label", "мои пары.json"]) == 0
    printed = capsys.readouterr()
    assert "Приемка разбора пройдена" in printed.out and "Отчет:" not in printed.out
    text = report.read_text(encoding="utf-8")
    assert "**Критерий выполнен: 100% сообщений разобраны верно.**" in text
    assert "Эталон мои пары.json:" in text and str(tmp_path) not in text

    broken = _pairs()
    broken[1]["expected"]["events"][1]["odds"]["ML"] = ["1.36", "3.20"]
    path = _write(tmp_path / "broken.json", broken)
    assert (
        await asyncio.to_thread(
            cli.main, ["parse-eval", "--file", path, "--yes", "--report", str(report)]
        )
        == 1
    )
    printed = capsys.readouterr()
    assert "Разобрано верно: 1 из 2 (50,0%)" in printed.out
    assert "Пара 2: событие 2, кэф П1: в эталоне 1.36, в разборе 1.35" in printed.out
    assert "нужно 100%" in printed.err
    assert "## Расхождения" in report.read_text(encoding="utf-8")


async def test_parse_eval_failure_and_budget(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    pairs = _write(tmp_path / "pairs.json", _pairs())
    answers = iter(["нет"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", pairs]) == 2
    assert fake.requests == []
    capsys.readouterr()
    # Сбой разбора одного сообщения — расхождение, а не обрыв команды
    fake.fail("parse", "bad_json")
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", pairs, "--yes"]) == 1
    assert "разбор не выполнен" in capsys.readouterr().out
    # Отказ ключа — команда останавливается
    fake.fail("parse", "key_rejected", times=5)
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", pairs, "--yes"]) == 1
    assert "Запрос к Claude не выполнен" in capsys.readouterr().err
    await db.execute(update(AppSettings).values(eval_budget_usd=Decimal("0.001")))
    await db.commit()
    before = len(fake.requests)
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", pairs, "--yes"]) == 1
    assert "больше остатка бюджета проверок" in capsys.readouterr().err
    assert len(fake.requests) == before


async def test_parse_eval_bad_args(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    assert await asyncio.to_thread(cli.main, ["parse-eval"]) == 1
    assert "Укажите --file" in capsys.readouterr().err
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--draft", "--out", "x.json"]) == 1
    assert "--from-telegram" in capsys.readouterr().err
    assert (
        await asyncio.to_thread(cli.main, ["parse-eval", "--file", str(tmp_path / "none.json")])
        == 1
    )
    assert "Не удалось прочитать" in capsys.readouterr().err
    bad = tmp_path / "bad.json"
    bad.write_text("{", encoding="utf-8")
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", str(bad)]) == 1
    assert "не JSON" in capsys.readouterr().err
    assert (
        await asyncio.to_thread(
            cli.main, ["parse-eval", "--file", _write(tmp_path / "x.json", {"a": 1})]
        )
        == 1
    )
    assert "непустой JSON-список" in capsys.readouterr().err


def test_telegram_messages() -> None:
    export = {
        "name": "Tennis Analytics Bot",
        "messages": [
            {"id": 1, "type": "service", "text": SINNER_RUNE},
            {"id": 2, "type": "message", "date": "2025-03-01T10:00:00", "text": SINNER_RUNE},
            {"id": 3, "type": "message", "text": "Привет! Анализ Синнер vs Руне готов"},
            {
                "id": 4,
                "type": "message",
                "date": "2025-03-02T10:00:00",
                "text": [
                    {"type": "bold", "text": "Djokovic vs Rublev"},
                    ", Paris\nКэфы: П1 = 1.45, П2 = 2.80",
                ],
            },
            {"id": 5, "type": "message", "text": SINNER_RUNE},
        ],
    }
    found = parse_eval.telegram_messages(export, limit=150)
    assert [m.message_id for m in found] == [2, 4]
    assert found[1].text.startswith("Djokovic vs Rublev, Paris")
    assert [m.message_id for m in parse_eval.telegram_messages(export, limit=1)] == [4]
    with pytest.raises(PairsError):
        parse_eval.telegram_messages([], limit=10)


# Ответ legacy-бота на /start (legacy/telegram-bot/bot.py, cmd_start): в нем образец ввода
BOT_HELP = (
    "Tennis Analytics Bot\n\nОтправьте матчи в формате:\n\nТекущий банк: 10 000₽\n"
    "Букмекер: Лига Ставок\n\nСобытия:\nСиннер vs Медведев, Рим, грунт\n"
    "Кэфы: П1 = 1.35, П2 = 3.10\nФора по сетам: П1(-1.5) = 1.80, П2(+1.5) = 1.95\n\n"
    "/статистика — банк и винрейт\n/игроки — список базы\n/результат — внести итог ставки"
)


def test_telegram_messages_only_from_owner() -> None:
    """Сообщения бота (по from_id собеседника или по имени чата) и справка с командами не
    попадают в черновик, даже пересланные владельцем."""
    owner = {"from": "Roman", "from_id": "user111"}
    bot = {"from": "Tennis Analytics Bot", "from_id": "user999"}
    messages: list[dict[str, Any]] = [
        {"id": 1, "type": "message", **owner, "text": "/start"},
        {"id": 2, "type": "message", **bot, "text": BOT_HELP},
        {"id": 3, "type": "message", **owner, "text": SINNER_RUNE},
        {"id": 4, "type": "message", **bot, "text": SINNER_RUNE + "\n"},
        {"id": 5, "type": "message", **owner, "forwarded_from": "Bot", "text": BOT_HELP},
    ]
    export: dict[str, Any] = {
        "name": "Tennis Analytics Bot",
        "type": "bot_chat",
        "id": 999,
        "messages": messages,
    }
    assert [m.message_id for m in parse_eval.telegram_messages(export, limit=150)] == [3]
    # Без id чата — по имени чата
    by_name = {key: value for key, value in export.items() if key != "id"}
    assert [m.message_id for m in parse_eval.telegram_messages(by_name, limit=150)] == [3]
    # Избранное (saved_messages): id чата — сам владелец, его сообщения берутся
    saved = {"type": "saved_messages", "id": 111, "messages": messages[2:3]}
    assert [m.message_id for m in parse_eval.telegram_messages(saved, limit=150)] == [3]


async def test_draft_from_telegram_then_eval(
    db: AsyncSession,
    world: dict[str, int],
    fake: FakeClaude,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    export = {
        "messages": [
            {"id": 7, "type": "message", "date": "2025-03-01T10:00:00", "text": SINNER_RUNE},
            {
                "id": 8,
                "type": "message",
                "text": (
                    "Хольгерр Рунеее vs Синнер\nКэфы: П1 = 5.1, П2 = 1.17\nТочный счет 2:0 = 3.1"
                ),
            },
            {"id": 9, "type": "message", "text": "просто текст"},
        ]
    }
    source = _write(tmp_path / "result.json", export)
    out = tmp_path / "pairs.json"
    assert (
        await asyncio.to_thread(
            cli.main,
            [
                "parse-eval",
                "--draft",
                "--from-telegram",
                source,
                "--out",
                str(out),
                "--yes",
                "--local-sh",
                "--out-label",
                "my pairs.json",
            ],
        )
        == 0
    )
    printed = capsys.readouterr().out
    assert "Черновик эталона: my pairs.json, пар: 2." in printed and "пробный" not in printed
    assert "bash deploy/local.sh parse-eval --file 'my pairs.json'" in printed
    assert str(tmp_path) not in printed
    drafts = json.loads(out.read_text(encoding="utf-8"))
    assert drafts[0]["expected"]["events"] == [
        {
            "player1": "Jannik Sinner",
            "player2": "Holger Rune",
            "odds": {"ML": ["1.17", "5.1"], "HCP_-1.5": ["1.62", None], "HCP_+1.5": [None, "2.3"]},
        }
    ]
    assert drafts[0]["source"] == {"message_id": 7, "date": "2025-03-01T10:00:00"}
    checks = " ".join(drafts[1]["check"])
    assert "не разобрана" in checks and "Точный счет" in checks
    assert (
        await db.scalar(select(func.count()).select_from(AgentRun).where(AgentRun.kind == "eval"))
        == 2
    )
    # Черновик — годный эталон: на том же разборе он совпадает (кроме игроков, которых
    # владелец правит руками)
    good = [pair for pair in drafts if "нет в базе" not in " ".join(pair["check"])]
    path = _write(tmp_path / "good.json", good)
    assert await asyncio.to_thread(cli.main, ["parse-eval", "--file", path, "--yes"]) == 3
    empty = _write(tmp_path / "empty.json", {"messages": [{"id": 1, "text": "привет"}]})
    assert (
        await asyncio.to_thread(
            cli.main,
            ["parse-eval", "--draft", "--from-telegram", empty, "--out", str(out), "--yes"],
        )
        == 1
    )
    assert "нет сообщений владельца в формате бота" in capsys.readouterr().err


# --- Р28: эталон новых рынков ---

MARKETS_PAIRS = Path(__file__).parent / "fixtures" / "parse_markets.json"


async def test_markets_pairs_on_fake_parse(db: AsyncSession, world: dict[str, int]) -> None:
    """Эталон новых рынков (33 сообщения): форы и тоталы сетов и геймов, целые линии,
    спорная фора без «сет» и «гейм», четвертная линия и тотал между 5 и 15 в «Не понял».
    Поддельный разбор следует правилам parse_input.v2; сверка — та же, что у parse-eval
    на настоящем Haiku (код сводит строки разбора к рынкам, как черновик анализа)."""
    pairs = parse_eval.load_pairs(json.loads(MARKETS_PAIRS.read_text(encoding="utf-8")))
    assert len(pairs) >= 30
    families: set[str] = set()
    for pair in pairs:
        parsed = ParsedInput.model_validate(parse_text(pair.text))
        assert await parse_eval.compare(db, parsed, pair.events) == [], pair.number
        families |= {market.split("_")[0] for event in pair.events for market in event.odds}
    assert families >= {"ML", "HCP", "STOT", "GHCP", "GTOT"}
    assert any(event.disputed for pair in pairs for event in pair.events)
    assert {"quarter", "total_unit"} <= {
        reason for pair in pairs for event in pair.events for reason in event.unknown
    }


async def test_markets_diff_texts(db: AsyncSession, world: dict[str, int]) -> None:
    """Расхождение по новому рынку и по спорной форе видно в сверке."""
    pairs = parse_eval.load_pairs(json.loads(MARKETS_PAIRS.read_text(encoding="utf-8")))
    first = pairs[0]
    parsed = ParsedInput.model_validate(parse_text(first.text.replace("М(22.5) = 1.90", "")))
    diffs = await parse_eval.compare(db, parsed, first.events)
    assert ("odds", {"event": 1, "market": "GTOT_22.5", "side": 2, "expected": "1.9",
                     "parsed": "—"}) in diffs  # fmt: skip
    disputed = next(pair for pair in pairs if pair.events[0].disputed)
    parsed = ParsedInput.model_validate(parse_text(disputed.text.replace("Ф1(-1.5)", "П1(-1)")))
    kinds = [kind for kind, _ in await parse_eval.compare(db, parsed, disputed.events)]
    assert "disputed" in kinds and "odds" in kinds
    assert acceptance._market("GTOT_22.5", 2) == "GTOT_22.5, сторона 2"
