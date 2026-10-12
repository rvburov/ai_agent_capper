"""Приемка этапа 3, разбор текста (команда parse-eval; TOKEN_ECONOMY.md, раздел 2.7):
Haiku 5.5 разбирает эталонные сообщения, код сверяет игроков, рынки и кэфы.

Файл эталона — JSON-список пар:

    [{"text": "Текущий банк: …\\nСиннер vs Руне, Шанхай, хард\\nКэфы: П1 = 1.17, П2 = 5.10",
      "expected": {"events": [{"player1": "Sinner", "player2": "Rune",
                               "odds": {"ML": ["1.17", "5.10"],
                                        "HCP_-1.5": ["1.62", null]}}]}}]

Игрок в эталоне — имя (ищется в базе так же, как игрок из разбора: resolve_player) или id.
Рынка нет в эталоне — у него нет кэфов. Сообщение верно, если события совпали по числу и
порядку, игроки после поиска в базе — те же, кэфы всех трех рынков (ML, HCP_-1.5,
HCP_+1.5) на обе стороны равны с точностью до 0,001. Остальные поля пары (source, check)
не читаются: их пишет черновик.

Черновик эталона (draft_pairs) — из экспорта чата Telegram Desktop (result.json,
messages[].text — строка или список кусков): сообщения владельца в формате бота (строка
с «vs» и строка «Кэфы: П1 = …»), разобранные текущим разбором. Сообщения собеседника
(в чате с ботом — самого бота: в его справке на /start есть образец ввода) не берутся:
отправитель — from_id «user<id чата>» или from с именем чата. Не берутся и сообщения со
строкой-командой («/статистика — …»): это справка бота, переслать ее мог и владелец.
Строка банка или букмекера не требуется: образец в справке бота их тоже содержит, а у
владельца бывают сообщения без них. Владелец правит ошибки разбора и получает эталон.

Каждый вызов — строка agent_runs с kind = eval: это проверка, она идет из бюджета
проверок (app/services/check_runs.py), а не из расхода участника или общего бюджета.
"""

import asyncio
import re
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_UP, Decimal
from typing import Any

import anthropic
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.agent.calls import CallInfo, estimate_tokens
from app.agent.config import AgentConfig
from app.agent.errors import ClaudeStepError
from app.agent.parse import parse_text
from app.agent.prompts import PARSE_PROMPT, load_prompt
from app.agent.runs import price_for, record_run, worst_case_usd
from app.agent.schemas import ParsedInput
from app.db.models import Player
from app.ml.sets import MARKETS
from app.services.analysis_input import OddsMap, parsed_odds, resolve_player, to_odds

# Сообщений, которые разбираются одновременно
CONCURRENCY = 4
TEXT_MAX = 4000
# Оценка выхода разбора с размышлениями (как в agent-smoke)
PARSE_OUTPUT_TOKENS = 1000
MTOK = Decimal(1_000_000)
USD_STEP = Decimal("0.0001")
# Сообщение в формате бота: строка «A vs B» и строка «Кэфы: П1 = 1.17 …»
_VS_LINE = re.compile(r"\S\s+vs\.?\s+\S", re.IGNORECASE)
_ODDS_LINE = re.compile(r"^\s*к[эе]ф\w*.*п1\s*=?\s*\d", re.IGNORECASE | re.MULTILINE)
# Строка-команда бота («/статистика — банк и винрейт»): так выглядит справка бота
_COMMAND_LINE = re.compile(r"^\s*/\w", re.MULTILINE)
# Экспорт одного чата с собеседником: его сообщения — не ввод владельца
_PEER_CHATS = frozenset({"bot_chat", "personal_chat"})


class PairsError(Exception):
    """Файл эталона не по формату: ключ cli.parse_eval.file.<key> и параметры."""

    def __init__(self, key: str, **params: Any) -> None:
        super().__init__(key)
        self.key = key
        self.params = params


# --- эталон ---

PlayerRef = str | int


@dataclass(frozen=True)
class ExpectedEvent:
    player1: PlayerRef
    player2: PlayerRef
    odds: OddsMap


@dataclass(frozen=True)
class Pair:
    number: int
    text: str
    events: tuple[ExpectedEvent, ...]


def _player_ref(value: Any, number: int, event: int, side: int) -> PlayerRef:
    if isinstance(value, bool):
        raise PairsError("player", pair=number, event=event, side=side)
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.strip():
        return value.strip()
    raise PairsError("player", pair=number, event=event, side=side)


def _odds(value: Any, number: int, event: int) -> OddsMap:
    if value is None:
        value = {}
    if not isinstance(value, dict):
        raise PairsError("odds", pair=number, event=event)
    unknown = sorted(set(value) - set(MARKETS))
    if unknown:
        raise PairsError("market", pair=number, event=event, market=unknown[0])
    found: OddsMap = {}
    for market in MARKETS:
        pair = value.get(market, [None, None])
        if not isinstance(pair, list) or len(pair) != 2:
            raise PairsError("odds", pair=number, event=event)
        sides: list[Decimal | None] = []
        for item in pair:
            odds = to_odds(item)
            if item is not None and odds is None:
                raise PairsError("odds", pair=number, event=event)
            sides.append(odds)
        found[market] = sides
    return found


def load_pairs(raw: Any) -> list[Pair]:
    """Пары из разобранного JSON файла эталона. Не по формату — PairsError."""
    if not isinstance(raw, list) or not raw:
        raise PairsError("not_list")
    pairs: list[Pair] = []
    for number, item in enumerate(raw, start=1):
        if not isinstance(item, dict):
            raise PairsError("pair", pair=number)
        text = item.get("text")
        if not isinstance(text, str) or not text.strip() or len(text) > TEXT_MAX:
            raise PairsError("text", pair=number, max=TEXT_MAX)
        expected = item.get("expected")
        events = expected.get("events") if isinstance(expected, dict) else None
        if not isinstance(events, list):
            raise PairsError("expected", pair=number)
        parsed_events: list[ExpectedEvent] = []
        for index, event in enumerate(events, start=1):
            if not isinstance(event, dict):
                raise PairsError("expected", pair=number)
            parsed_events.append(
                ExpectedEvent(
                    player1=_player_ref(event.get("player1"), number, index, 1),
                    player2=_player_ref(event.get("player2"), number, index, 2),
                    odds=_odds(event.get("odds"), number, index),
                )
            )
        pairs.append(Pair(number=number, text=text, events=tuple(parsed_events)))
    return pairs


@dataclass(frozen=True)
class Resolved:
    """Игрок эталона или разбора после поиска в базе (player_id None — не найден)."""

    player_id: int | None
    name: str


async def resolve_ref(db: AsyncSession, ref: PlayerRef) -> Resolved:
    if isinstance(ref, int):
        name = await db.scalar(select(Player.name).where(Player.id == ref))
        return Resolved(ref if name is not None else None, name or str(ref))
    pick = await resolve_player(db, ref, None)
    if pick.best is None:
        return Resolved(None, ref)
    return Resolved(pick.best.player_id, pick.best.name)


async def resolve_parsed(db: AsyncSession, raw: str, latin: str | None) -> Resolved:
    pick = await resolve_player(db, raw, latin)
    if pick.best is None:
        return Resolved(None, latin or raw)
    return Resolved(pick.best.player_id, pick.best.name)


# --- сверка ---

Diff = tuple[str, dict[str, Any]]


def _odds_text(value: Decimal | None) -> str:
    return "—" if value is None else f"{value.normalize():f}"


async def compare(
    db: AsyncSession, parsed: ParsedInput, expected: Sequence[ExpectedEvent]
) -> list[Diff]:
    """Расхождения разбора с эталоном (ключ cli.parse_eval.diff.<вид> и параметры);
    пустой список — сообщение разобрано верно."""
    diffs: list[Diff] = []
    if len(parsed.events) != len(expected):
        diffs.append(("events", {"expected": len(expected), "parsed": len(parsed.events)}))
    for index, (event, want) in enumerate(zip(parsed.events, expected, strict=False), start=1):
        for side, (got, ref) in enumerate(
            ((event.player1, want.player1), (event.player2, want.player2)), start=1
        ):
            target = await resolve_ref(db, ref)
            if target.player_id is None:
                diffs.append(("expected_missing", {"event": index, "side": side, "name": ref}))
                continue
            found = await resolve_parsed(db, got.raw, got.latin)
            if found.player_id != target.player_id:
                diffs.append(
                    (
                        "player",
                        {
                            "event": index,
                            "side": side,
                            "expected": target.name,
                            "parsed": found.name if found.player_id is not None else got.raw,
                        },
                    )
                )
        odds = parsed_odds(event.odds)
        for market in MARKETS:
            for side in (1, 2):
                have = odds[market][side - 1]
                need = want.odds.get(market, [None, None])[side - 1]
                if have != need:
                    diffs.append(
                        (
                            "odds",
                            {
                                "event": index,
                                "market": market,
                                "side": side,
                                "expected": _odds_text(need),
                                "parsed": _odds_text(have),
                            },
                        )
                    )
    return diffs


# --- вызовы ---


class EvalHooks:
    """Учет вызова разбора как проверки: строка agent_runs с kind = eval, свой сеанс на
    каждый вызов (вызовы идут параллельно)."""

    def __init__(self, maker: async_sessionmaker[AsyncSession]) -> None:
        self.maker = maker
        self.spent = Decimal(0)
        self.calls = 0

    async def before_call(
        self,
        *,
        kind: str,
        model: str,
        input_tokens: int,
        max_tokens: int,
        min_tokens: int,
        searches: int,
    ) -> int | None:
        async with self.maker() as db:
            await price_for(db, model)
        return None

    async def after_call(self, info: CallInfo) -> int | None:
        async with self.maker() as db:
            run = await record_run(
                db,
                user_id=None,
                key_source="admin",
                analysis_id=None,
                kind="eval",
                step=0,
                model=info.model,
                effort=info.effort,
                prompt_version=info.prompt_version,
                schema_version=info.schema_version,
                usage=info.usage,
                duration_ms=info.duration_ms,
                stop_reason=info.stop_reason,
                error=info.error,
                request_id=info.request_id,
            )
            run_id = run.id
            self.spent += run.cost_usd
            self.calls += 1
            await db.commit()
        return run_id


@dataclass
class ParseOutcome:
    """Разбор одного сообщения: ответ или код сбоя."""

    parsed: ParsedInput | None = None
    error: str | None = None


async def parse_all(
    client: anthropic.AsyncAnthropic,
    texts: Sequence[str],
    config: AgentConfig,
    hooks: EvalHooks,
    *,
    on_done: Callable[[int], None] | None = None,
) -> list[ParseOutcome]:
    """Разбор сообщений (не больше CONCURRENCY одновременно), в порядке texts. Сбой
    ключа или цены — ClaudeStepError сразу (остальные вызовы не начинаются)."""
    limit = asyncio.Semaphore(CONCURRENCY)
    outcomes = [ParseOutcome() for _ in texts]
    fatal: list[ClaudeStepError] = []

    async def one(index: int, text: str) -> None:
        async with limit:
            if fatal:
                return
            try:
                outcomes[index].parsed = await parse_text(client, text, config, hooks)
            except ClaudeStepError as exc:
                if exc.is_key_failure or exc.code in ("ai.no_price", "ai.no_key"):
                    fatal.append(exc)
                outcomes[index].error = exc.code
            if on_done is not None:
                on_done(index)

    await asyncio.gather(*(one(index, text) for index, text in enumerate(texts)))
    if fatal:
        raise fatal[0]
    return outcomes


@dataclass(frozen=True)
class CallsEstimate:
    estimate_usd: Decimal
    worst_usd: Decimal


async def estimate_calls(
    db: AsyncSession, config: AgentConfig, texts: Sequence[str]
) -> CallsEstimate:
    price = await price_for(db, config.parse_model)
    prompt = load_prompt(*PARSE_PROMPT)
    total = Decimal(0)
    worst = Decimal(0)
    for text in texts:
        tokens = estimate_tokens(prompt.text, text)
        total += (tokens * price.input + PARSE_OUTPUT_TOKENS * price.output) / MTOK
        worst += worst_case_usd(price, input_tokens=tokens, max_tokens=config.parse_max_tokens)
    return CallsEstimate(
        estimate_usd=total.quantize(USD_STEP, rounding=ROUND_UP),
        worst_usd=worst.quantize(USD_STEP, rounding=ROUND_UP),
    )


@dataclass
class PairResult:
    pair: Pair
    diffs: list[Diff] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.diffs


async def check_pairs(
    db: AsyncSession, pairs: Sequence[Pair], outcomes: Sequence[ParseOutcome]
) -> list[PairResult]:
    results: list[PairResult] = []
    for pair, outcome in zip(pairs, outcomes, strict=True):
        if outcome.parsed is None:
            diffs: list[Diff] = [("parse_failed", {"code": outcome.error or "ai.bad_output"})]
        else:
            diffs = await compare(db, outcome.parsed, pair.events)
        results.append(PairResult(pair=pair, diffs=diffs))
    return results


# --- черновик из Telegram ---


@dataclass(frozen=True)
class TelegramMessage:
    message_id: Any
    date: str | None
    text: str


def _message_text(value: Any) -> str:
    """Текст сообщения экспорта: строка или список кусков (строки и {"text": …})."""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for piece in value:
            if isinstance(piece, str):
                parts.append(piece)
            elif isinstance(piece, dict) and isinstance(piece.get("text"), str):
                parts.append(piece["text"])
        return "".join(parts)
    return ""


def looks_like_input(text: str) -> bool:
    """Сообщение в формате бота: строка с «vs» и строка «Кэфы: П1 = …», без строк-команд
    (справка бота)."""
    return bool(
        _VS_LINE.search(text) and _ODDS_LINE.search(text) and not _COMMAND_LINE.search(text)
    )


def _peer(raw: dict[str, Any]) -> tuple[str | None, str | None]:
    """Собеседник в экспорте чата с ботом или человеком: from_id и имя. В экспорте одного
    чата id чата — id собеседника, name — его имя."""
    chat_type = raw.get("type")
    if chat_type is not None and chat_type not in _PEER_CHATS:
        return None, None
    chat_id = raw.get("id")
    peer_id = (
        f"user{chat_id}" if isinstance(chat_id, int) and not isinstance(chat_id, bool) else None
    )
    name = raw.get("name")
    return peer_id, name if isinstance(name, str) and name else None


def _from_peer(item: dict[str, Any], peer_id: str | None, peer_name: str | None) -> bool:
    sender_id = item.get("from_id")
    if peer_id is not None and sender_id == peer_id:
        return True
    return peer_name is not None and item.get("from") == peer_name


def telegram_messages(raw: Any, *, limit: int) -> list[TelegramMessage]:
    """Сообщения владельца в формате бота из result.json экспорта Telegram Desktop: без
    сообщений собеседника и повторов текста, последние limit по порядку чата."""
    messages = raw.get("messages") if isinstance(raw, dict) else None
    if not isinstance(messages, list):
        raise PairsError("telegram")
    peer_id, peer_name = _peer(raw)
    found: list[TelegramMessage] = []
    seen: set[str] = set()
    for item in messages:
        if not isinstance(item, dict) or item.get("type", "message") != "message":
            continue
        if _from_peer(item, peer_id, peer_name):
            continue
        text = _message_text(item.get("text")).strip()
        if not text or len(text) > TEXT_MAX or text in seen or not looks_like_input(text):
            continue
        seen.add(text)
        date = item.get("date")
        found.append(
            TelegramMessage(
                message_id=item.get("id"),
                date=date if isinstance(date, str) else None,
                text=text,
            )
        )
    return found[-limit:] if limit > 0 else found


def _odds_json(odds: OddsMap) -> dict[str, list[str | None]]:
    return {
        market: [_odds_json_value(value) for value in pair]
        for market, pair in odds.items()
        if any(value is not None for value in pair)
    }


def _odds_json_value(value: Decimal | None) -> str | None:
    return None if value is None else f"{value.normalize():f}"


async def draft_pair(
    db: AsyncSession, message: TelegramMessage, outcome: ParseOutcome
) -> dict[str, Any]:
    """Пара черновика: текст, ответ текущего разбора как эталон (игроки — имена из базы)
    и что проверить руками (check: ключ cli.parse_eval.check.<вид> и параметры)."""
    checks: list[dict[str, Any]] = []
    events: list[dict[str, Any]] = []
    if outcome.parsed is None:
        checks.append({"key": "parse_failed", "params": {"code": outcome.error or ""}})
    else:
        for index, event in enumerate(outcome.parsed.events, start=1):
            names: list[str] = []
            for side, who in enumerate((event.player1, event.player2), start=1):
                pick = await resolve_player(db, who.raw, who.latin)
                if pick.best is None:
                    names.append(who.latin or who.raw)
                    checks.append(
                        {"key": "missing", "params": {"event": index, "side": side, "raw": who.raw}}
                    )
                    continue
                names.append(pick.best.name)
                if pick.status != "matched":
                    checks.append(
                        {
                            "key": "player",
                            "params": {
                                "event": index,
                                "side": side,
                                "raw": who.raw,
                                "name": pick.best.name,
                            },
                        }
                    )
            events.append(
                {
                    "player1": names[0],
                    "player2": names[1],
                    "odds": _odds_json(parsed_odds(event.odds)),
                }
            )
        for line in outcome.parsed.unknown_lines:
            checks.append(
                {"key": "unknown_line", "params": {"line": line.line_no, "text": line.text}}
            )
    return {
        "text": message.text,
        "expected": {"events": events},
        "source": {"message_id": message.message_id, "date": message.date},
        "check": checks,
    }
