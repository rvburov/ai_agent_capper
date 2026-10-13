"""Импорт истории старого Telegram-бота (PLAN.md, раздел 5, «Перенос текущих данных»).

    python -m app.ingest.legacy --email owner@example.com \\
        --history Ставки/История-ставок.json --players Игроки [--dry-run]

Что переносится для участника с этим email:
- каждая запись История-ставок.json → анализ (parsed — исходная запись), ставка
  (source = legacy, source_ref = id записи), события экспресса, прогнозы
  (p_claude = вероятность_процент / 100, версия стратегии legacy) и кэфы (kind = user);
- игроки, турниры и матчи — заготовки по именам из записей (общие для всех участников);
- журнал банка заново по правилам приложения, со сверкой с числами бота (legacy_bank.py);
- профили игроков: файлы 01–04 из папки Игроки → player_profiles (source = legacy_llm).
  Файлы 05 и 06 не переносятся: цифры в них могли быть заполнены по памяти (PLAN.md,
  раздел 2, п. 4).

Все делается одной транзакцией. --dry-run печатает тот же отчет и откатывает ее.
Повторный запуск не создает дублей: ставка узнается по (user_id, source, source_ref),
игрок — по имени, турнир — по названию и дате, матч — по дате и паре игроков. Журнал
при повторном запуске не пишется заново: новые ставки дописываются, а если записи
добавлены перед уже перенесенными (например, исправлена битая), пополнение второй раз
не пишется, и журнал в базе одной корректировкой приводится к пересчитанному по файлу.
Неизвестный рынок или битая запись не роняют импорт, а попадают в отчет. Отчет —
в stdout, запись в admin_audit_log (action = import, source = terminal) — только сводка
без сумм: журнал видят администраторы, а банк участника им не показывается (Р14).
Код возврата: 0 — импорт прошел (возможно, с замечаниями в отчете), 1 — ошибка.
"""

import argparse
import asyncio
import json
import re
import sys
from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, text
from sqlalchemy.exc import InterfaceError, OperationalError, ProgrammingError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.db.models import (
    Analysis,
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
    User,
)
from app.db.session import get_session
from app.ingest.legacy_bank import (
    TOLERANCE,
    BankBet,
    BankCheck,
    BankPlan,
    BetStatus,
    Cause,
    PlannedEntry,
    money,
    plan_bank,
)
from app.ingest.legacy_markets import (
    Pick,
    clean_name,
    name_key,
    parse_market,
    parse_odds_key,
    parse_surface,
    short_forms,
    short_name,
)
from app.services.app_settings import get_app_settings
from app.services.audit import write_audit

SOURCE = "legacy"
STRATEGY_CODE = "legacy"
LLM_MODEL = "legacy"
PROFILE_SOURCE = "legacy_llm"
# Бот работал по Москве, время ставки не хранил: берется полдень дня записи
BOT_TZ = ZoneInfo("Europe/Moscow")
BOT_TIME = time(12, 0)
PROFILE_PARTS = ("01", "02", "03", "04")
DYNAMIC_PARTS = ("05", "06")
STATUSES: dict[str, BetStatus] = {
    "": "open",
    "победа": "won",
    "выигрыш": "won",
    "поражение": "lost",
    "проигрыш": "lost",
    "возврат": "void",
}
# Итоговый кэф экспресса может отличаться от произведения кэфов событий на округление
ODDS_MISMATCH = Decimal("0.01")
ODDS_STEP = Decimal("0.001")
ODDS_LIMIT = Decimal(1000)
# Ключ pg_advisory_xact_lock: два импорта одновременно не идут
LOCK_KEY = 0x6C65676163790001
# Одноименный турнир — тот же, если начат не дальше трех недель от дня ставки: турнир
# Большого шлема с квалификацией идет около трех недель, а одноименные челленджеры или
# матчи Кубка Дэвиса в разные месяцы — разные турниры
TOURNAMENT_DAYS = 21
_CURRENCY_SIGNS = {"RUB": "₽", "USD": "$", "EUR": "€"}


def _tr(key: str, /, **params: Any) -> str:
    return t(f"ingest.legacy.{key}", **params)


class ImportFailure(Exception):
    """Импорт невозможен: текст из локали ingest.legacy.errors.*, код возврата 1."""

    def __init__(self, key: str, /, **params: Any) -> None:
        super().__init__(key)
        self.message = _tr(f"errors.{key}", **params)


# --- разбор записей ---


def to_decimal(value: object) -> Decimal | None:
    """Число из JSON: 10000, 2.5, «10 000», «2,50», «10000₽». Иначе None."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        number = Decimal(repr(value))
    elif isinstance(value, str):
        cleaned = re.sub(r"[\s₽$€]|руб\.?", "", value).replace(",", ".")
        try:
            number = Decimal(cleaned)
        except InvalidOperation:
            return None
    else:
        return None
    return number if number.is_finite() else None


def parse_day(value: object) -> date | None:
    if not isinstance(value, str):
        return None
    raw = value.strip()[:10]
    for fmt in ("%Y-%m-%d", "%d.%m.%Y"):
        try:
            return datetime.strptime(raw, fmt).date()
        except ValueError:
            continue
    return None


def bot_time(day: date) -> datetime:
    """Полдень дня записи по Москве, в UTC."""
    return datetime.combine(day, BOT_TIME, tzinfo=BOT_TZ).astimezone(UTC)


def _ref(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, str) and value.strip():
        return value.strip()[:64]
    return None


def _text(value: object, limit: int | None = None) -> str:
    result = clean_name(value) if isinstance(value, str) else ""
    return result[:limit] if limit else result


@dataclass
class LegacyEvent:
    """Событие записи: пара игроков, кэфы и выбранный исход."""

    no: int
    player1: str
    player2: str
    tournament: str
    surface: object
    odds: dict[Pick, Decimal]
    market_raw: str
    pick: Pick | None
    odds_taken: Decimal | None
    probability: float | None
    rationale: str | None


@dataclass
class LegacyRecord:
    """Запись История-ставок.json после разбора."""

    ref: str
    day: date
    placed_at: datetime
    bookmaker: str
    stake: Decimal
    total_odds: Decimal
    status: BetStatus
    bank_before: Decimal | None
    events: list[LegacyEvent]
    raw: dict[str, Any]

    def bank_bet(self) -> BankBet:
        return BankBet(
            self.ref, self.placed_at, self.stake, self.total_odds, self.status, self.bank_before
        )


@dataclass
class ImportReport:
    """Итог импорта: счетчики, сверка банка и замечания (уже готовые строки отчета)."""

    email: str
    dry_run: bool
    currency: str
    history_name: str
    records_total: int = 0
    records_skipped: int = 0
    bets_new: int = 0
    bets_existing: int = 0
    statuses: Counter[str] = field(default_factory=Counter)
    ref_status: dict[str, BetStatus] = field(default_factory=dict)
    events: int = 0
    predictions: int = 0
    legs: int = 0
    odds: int = 0
    players_created: int = 0
    players_found: int = 0
    tournaments_created: int = 0
    matches_created: int = 0
    matches_found: int = 0
    bank: BankPlan = field(default_factory=BankPlan)
    db_bank: Decimal | None = None
    # Повторный импорт: новые записи перед уже перенесенными, корректировка, которой
    # журнал в базе приведен к пересчитанному, и ставки базы, которых нет в файле
    inserted_refs: list[str] = field(default_factory=list)
    reconciled: Decimal | None = None
    absent_refs: list[str] = field(default_factory=list)
    json_stats: dict[str, Any] = field(default_factory=dict)
    unknown_markets: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)
    profiles_dir: bool = False
    profiles_created: int = 0
    profiles_updated: int = 0
    profiles_unchanged: int = 0
    dynamic_files: int = 0
    dynamic_players: int = 0
    profile_issues: list[str] = field(default_factory=list)

    def fmt(self, value: Decimal, *, signed: bool = False) -> str:
        return format_money(value, self.currency, signed=signed)

    def audit_details(self) -> dict[str, Any]:
        """Сводка для журнала администратора. Р14: администратор видит об участнике только
        расход на ИИ и активность, поэтому здесь нет ни сумм, ни числа ставок, их исходов,
        прогнозов и записей журнала банка. Полный отчет печатается в терминал."""
        return {
            "file": self.history_name,
            "players_created": self.players_created,
            "tournaments_created": self.tournaments_created,
            "matches_created": self.matches_created,
            "unknown_markets": len(self.unknown_markets),
            "warnings": len(self.warnings),
            "profiles": {
                "created": self.profiles_created,
                "updated": self.profiles_updated,
                "unchanged": self.profiles_unchanged,
            },
        }

    def lines(self) -> list[str]:
        out = [
            _tr("report.title", email=self.email),
            _tr("report.mode_dry_run" if self.dry_run else "report.mode_write"),
            _tr("report.currency", currency=self.currency),
        ]
        if self.currency != "RUB":
            out.append(_tr("report.currency_warning", currency=self.currency))
        out += [
            _tr(
                "report.records",
                total=self.records_total,
                new=self.bets_new,
                existing=self.bets_existing,
                skipped=self.records_skipped,
            ),
            _tr(
                "report.statuses",
                won=self.statuses["won"],
                lost=self.statuses["lost"],
                void=self.statuses["void"],
                open=self.statuses["open"],
            ),
            _tr(
                "report.events",
                events=self.events,
                predictions=self.predictions,
                legs=self.legs,
                odds=self.odds,
            ),
            _tr(
                "report.players",
                created=self.players_created,
                found=self.players_found,
                tournaments=self.tournaments_created,
                matches_created=self.matches_created,
                matches_found=self.matches_found,
            ),
        ]
        out += self._bank_lines()
        out += self._stats_lines()
        out += _section("report.unknown_markets_title", self.unknown_markets)
        out += _section("report.warnings_title", self.warnings)
        out += _section("report.skipped_title", self.skipped)
        if self.profiles_dir:
            out.append(
                _tr(
                    "report.profiles",
                    created=self.profiles_created,
                    updated=self.profiles_updated,
                    unchanged=self.profiles_unchanged,
                )
            )
            if self.dynamic_files:
                out.append(
                    _tr(
                        "report.profiles_dynamic_skipped",
                        files=self.dynamic_files,
                        players=self.dynamic_players,
                    )
                )
            out += _section("report.profile_issues_title", self.profile_issues)
        return out

    def _bank_lines(self) -> list[str]:
        plan = self.bank
        out = [_tr("report.bank_title")]
        if plan.starting_bank is not None:
            out.append(
                _tr("report.bank_start", amount=self.fmt(plan.starting_bank), ref=plan.starting_ref)
            )
        elif plan.start_ref is not None:
            out.append(_tr("report.bank_start_none", ref=plan.start_ref))
        else:
            out.append(_tr("report.bank_start_missing"))
        out.append(_tr("report.bank_ledger", amount=self.fmt(plan.ledger_total)))
        if plan.open_count:
            out.append(
                _tr(
                    "report.bank_open",
                    count=plan.open_count,
                    amount=self.fmt(plan.open_stakes),
                )
            )
            out.append(_tr("report.bank_bot_view", amount=self.fmt(plan.bot_view_total)))
        if plan.json_bank is None or plan.final_diff is None:
            out.append(_tr("report.bank_json_missing"))
        else:
            out.append(_tr("report.bank_json", amount=self.fmt(plan.json_bank)))
            diff = self.fmt(plan.final_diff, signed=True)
            if plan.final_causes is None:
                out.append(_tr("report.bank_diff_unexplained", amount=diff))
            elif not plan.final_causes:
                out.append(_tr("report.bank_match"))
            else:
                out.append(_tr("report.bank_diff", amount=diff))
                out += [self._cause_line(cause) for cause in plan.final_causes]
        out += self._rerun_lines()
        if plan.checks:
            out.append(_tr("report.checks_title"))
            for check in plan.checks:
                out += self._check_lines(check)
        return out

    def _rerun_lines(self) -> list[str]:
        out: list[str] = []
        if self.inserted_refs:
            out.append(_tr("report.rerun_inserted", refs=_refs(self.inserted_refs)))
        if self.reconciled is not None:
            out.append(
                _tr("report.rerun_reconciled", amount=self.fmt(self.reconciled, signed=True))
            )
        if self.absent_refs:
            out.append(_tr("report.rerun_absent", refs=_refs(self.absent_refs)))
        if self.db_bank is None:
            return out
        out.append(_tr("report.bank_db", amount=self.fmt(self.db_bank)))
        diff = money(self.db_bank - self.bank.ledger_total)
        if abs(diff) > TOLERANCE:
            out.append(_tr("report.bank_db_mismatch", amount=self.fmt(diff, signed=True)))
        return out

    def _check_lines(self, check: BankCheck) -> list[str]:
        reported = self.fmt(check.reported) if check.reported is not None else ""
        expected = self.fmt(check.expected) if check.expected is not None else ""
        if check.outcome == "start":
            return [_tr("report.check_start", ref=check.ref, amount=self.fmt(check.diff))]
        if check.outcome == "missing":
            return [_tr("report.check_missing", ref=check.ref)]
        if check.outcome == "nonpositive":
            return [_tr("report.check_nonpositive", ref=check.ref, reported=reported)]
        if check.outcome == "corrected":
            lines = [
                _tr(
                    "report.check_corrected",
                    ref=check.ref,
                    reported=reported,
                    expected=expected,
                    diff=self.fmt(check.diff, signed=True),
                    reason=_tr("report.reason_up" if check.diff > 0 else "report.reason_down"),
                )
            ]
            if check.causes:
                lines.append(_tr("report.check_hint"))
                lines += [self._cause_line(cause) for cause in check.causes]
            return lines
        lines = [_tr("report.check_explained", ref=check.ref, reported=reported, expected=expected)]
        return lines + [self._cause_line(cause) for cause in check.causes]

    def _cause_line(self, cause: Cause) -> str:
        amount = self.fmt(cause.amount, signed=True)
        if cause.kind == "late_result":
            body = _tr("report.cause.late_result", refs=_refs(cause.refs), amount=amount)
        elif cause.kind == "double_click":
            ref = cause.refs[0]
            result = _tr(f"status.{self.ref_status.get(ref, 'won')}")
            body = _tr("report.cause.double_click", ref=ref, result=result, amount=amount)
        else:
            body = _tr(f"report.cause.{cause.kind}", amount=amount)
        return _tr("report.cause_line", text=body)

    def _stats_lines(self) -> list[str]:
        json_wins = _to_int(self.json_stats.get("победы"))
        json_losses = _to_int(self.json_stats.get("поражения"))
        won, lost, void = self.statuses["won"], self.statuses["lost"], self.statuses["void"]
        if json_losses is None:
            return []
        wins_ok = json_wins is None or json_wins == won
        if void and wins_ok and json_losses == lost + void:
            return [_tr("report.stats_refunds", json_losses=json_losses, lost=lost, void=void)]
        if not wins_ok or json_losses != lost:
            return [
                _tr(
                    "report.stats_mismatch",
                    json_wins=json_wins if json_wins is not None else "—",
                    json_losses=json_losses,
                    won=won,
                    lost=lost,
                    void=void,
                )
            ]
        return []


def _section(title_key: str, lines: list[str]) -> list[str]:
    return [_tr(title_key), *lines] if lines else []


def _refs(refs: Sequence[str]) -> str:
    return ", ".join(f"№{ref}" for ref in refs)


def _to_int(value: object) -> int | None:
    number = to_decimal(value)
    return int(number) if number is not None else None


def format_money(value: Decimal, currency: str, *, signed: bool = False) -> str:
    """10000 → «10 000,00 ₽»; signed — со знаком плюс у положительных."""
    amount = money(value)
    body = f"{abs(amount):,.2f}".replace(",", " ").replace(".", ",")
    sign = "-" if amount < 0 else ("+" if signed and amount > 0 else "")
    return f"{sign}{body} {_CURRENCY_SIGNS.get(currency, currency)}"


def format_odds(value: Decimal) -> str:
    """1.950 → «1.95», 1.869 → «1.869»."""
    shown = f"{value.quantize(ODDS_STEP):f}"
    return shown[:-1] if shown.endswith("0") else shown


def _odds(value: object) -> Decimal | None:
    """Кэф от 1 до 999.999 (больше не помещается в NUMERIC(6, 3)), иначе None."""
    number = to_decimal(value)
    if number is None or number < 1 or number >= ODDS_LIMIT:
        return None
    return number.quantize(ODDS_STEP)


def parse_history(
    data: Any, report: ImportReport
) -> tuple[list[LegacyRecord], Decimal | None, dict[str, Any]]:
    """Разбирает файл истории: записи по порядку ставок, банк бота и его статистику.
    Битые записи и события пропускаются с отметкой в отчете."""
    if isinstance(data, list):
        raw_records: list[Any] = data
        meta: dict[str, Any] = {}
        stats: dict[str, Any] = {}
    else:
        raw_records = data["ставки"]
        meta = data.get("meta") if isinstance(data.get("meta"), dict) else {}
        stats = data.get("статистика") if isinstance(data.get("статистика"), dict) else {}
    report.records_total = len(raw_records)
    records: list[LegacyRecord] = []
    seen: set[str] = set()
    for index, raw in enumerate(raw_records, 1):
        record = _parse_record(index, raw, seen, report)
        if record is None:
            report.records_skipped += 1
        else:
            records.append(record)
    if records and all(record.ref.isdigit() for record in records):
        records.sort(key=lambda record: int(record.ref))
    json_bank = to_decimal(meta.get("текущий_банк"))
    return records, money(json_bank) if json_bank is not None else None, stats


def _parse_record(
    index: int, raw: object, seen: set[str], report: ImportReport
) -> LegacyRecord | None:
    ref = _ref(raw.get("id")) if isinstance(raw, dict) else None
    if ref is None or not isinstance(raw, dict):
        report.skipped.append(_tr("issue.record_no_id", index=index))
        return None
    if ref in seen:
        report.skipped.append(_tr("issue.record_duplicate", ref=ref))
        return None
    seen.add(ref)
    day = parse_day(raw.get("дата"))
    if day is None:
        report.skipped.append(_tr("issue.record_bad_date", ref=ref, value=raw.get("дата")))
        return None
    stake = to_decimal(raw.get("сумма_ставки"))
    if stake is None or money(stake) <= 0:
        report.skipped.append(_tr("issue.record_bad_stake", ref=ref))
        return None
    raw_events = _events_of(raw)
    events = [
        event
        for no, item in enumerate(raw_events, 1)
        if (event := _parse_event(ref, no, item, report)) is not None
    ]
    express = raw.get("экспресс")
    express_odds = express.get("итоговый_кэф") if isinstance(express, dict) else None
    taken = [event.odds_taken for event in events if event.odds_taken is not None]
    product: Decimal | None = None
    # Произведение кэфов — только если все события записи разобраны и у всех есть кэф
    if events and len(taken) == len(events) == len(raw_events):
        product = Decimal(1)
        for odds in taken:
            product *= odds
        product = product.quantize(ODDS_STEP)
    total = _odds(express_odds) or product
    if total is None:
        report.skipped.append(_tr("issue.record_bad_odds", ref=ref))
        return None
    if product is not None and abs(product - total) > total * ODDS_MISMATCH:
        report.warnings.append(
            _tr(
                "issue.odds_mismatch",
                ref=ref,
                total=format_odds(total),
                product=format_odds(product),
            )
        )
    result = raw.get("результат")
    status_raw = result.get("статус") if isinstance(result, dict) else result
    status_text = status_raw.strip().lower() if isinstance(status_raw, str) else ""
    status = STATUSES.get(status_text)
    if status is None:
        report.warnings.append(_tr("issue.status_unknown", ref=ref, status=status_raw))
        status = "open"
    bank_before = to_decimal(raw.get("банк_до_ставки"))
    return LegacyRecord(
        ref=ref,
        day=day,
        placed_at=bot_time(day),
        bookmaker=_text(raw.get("букмекер"), 64),
        stake=money(stake),
        total_odds=total,
        status=status,
        bank_before=money(bank_before) if bank_before is not None else None,
        events=events,
        raw=raw,
    )


def _events_of(raw: dict[str, Any]) -> list[Any]:
    events = raw.get("события")
    return events if isinstance(events, list) else []


def _parse_event(ref: str, no: int, raw: object, report: ImportReport) -> LegacyEvent | None:
    item = raw if isinstance(raw, dict) else {}
    player1, player2 = _text(item.get("игрок1"), 200), _text(item.get("игрок2"), 200)
    if not player1 or not player2:
        report.skipped.append(_tr("issue.event_no_players", ref=ref, no=no))
        return None
    if name_key(player1) == name_key(player2):
        report.skipped.append(_tr("issue.event_same_player", ref=ref, no=no, player=player1))
        return None
    odds: dict[Pick, Decimal] = {}
    raw_odds = item.get("кэфы")
    for key, value in raw_odds.items() if isinstance(raw_odds, dict) else []:
        pick = parse_odds_key(str(key))
        number = _odds(value)
        if pick is None:
            if value is not None:
                report.unknown_markets.append(
                    _tr("report.unknown_odds_key", ref=ref, no=no, key=key)
                )
        elif number is not None:
            odds[pick] = number
    market_raw = _text(item.get("выбранный_рынок"), 100)
    pick = parse_market(market_raw)
    odds_taken = _odds(item.get("выбранный_кэф"))
    if pick is None:
        report.unknown_markets.append(
            _tr("report.unknown_market", ref=ref, no=no, market=market_raw or "—")
        )
    else:
        if odds_taken is None:
            odds_taken = odds.get(pick)
        if odds_taken is not None:
            odds.setdefault(pick, odds_taken)
    probability: float | None = None
    percent = to_decimal(item.get("вероятность_процент"))
    if percent is not None:
        if 0 <= percent <= 100:
            probability = float(percent / 100)
        else:
            report.warnings.append(_tr("issue.probability_range", ref=ref, no=no, value=percent))
    rationale = item.get("обоснование")
    return LegacyEvent(
        no=no,
        player1=player1,
        player2=player2,
        tournament=_text(item.get("турнир"), 200),
        surface=item.get("покрытие"),
        odds=odds,
        market_raw=market_raw,
        pick=pick,
        odds_taken=odds_taken,
        probability=probability,
        rationale=(rationale.strip() or None) if isinstance(rationale, str) else None,
    )


# --- запись в базу ---


def _leg_result(status: BetStatus, single: bool) -> str | None:
    """Итог события по итогу ставки: у одиночной он тот же; выигранный экспресс —
    все события выиграли; возврат — все в возврат. Проигранный экспресс не говорит,
    какое событие проиграло."""
    if status == "won":
        return "win"
    if status == "void":
        return "void"
    if status == "lost" and single:
        return "loss"
    return None


class _Importer:
    """Пишет записи и профили в базу. Игроки, турниры и матчи ищутся до создания,
    поэтому повторный импорт и импорт истории второго участника их не дублируют."""

    def __init__(self, db: AsyncSession, user: User, currency: str, report: ImportReport):
        self.db = db
        self.user = user
        self.currency = currency
        self.report = report
        # Ключ имени (name_key) → id игроков с таким name, name_ru или псевдонимом
        self.players: dict[str, list[int]] = {}
        # Ключ названия → турниры с этим названием и датой начала
        self.tournaments: dict[str, list[Tournament]] = {}
        self.matches: dict[str, Match] = {}
        self.players_created: set[int] = set()
        self.players_used: set[int] = set()
        self.matches_created: set[int] = set()
        self.matches_found: set[int] = set()
        self.ambiguous_warned: set[str] = set()

    async def load_indexes(self, days: set[date]) -> None:
        rows = await self.db.execute(
            select(Player.id, Player.name, Player.name_ru, Player.aliases).order_by(Player.id)
        )
        for player_id, name, name_ru, aliases in rows:
            for variant in (name, name_ru, *(aliases or [])):
                if variant:
                    self._index_player(variant, player_id)
        if days:
            window = timedelta(days=TOURNAMENT_DAYS)
            found = await self.db.scalars(
                select(Tournament)
                .where(Tournament.start_date.between(min(days) - window, max(days) + window))
                .order_by(Tournament.id)
            )
            for tournament in found:
                self.tournaments.setdefault(name_key(tournament.name), []).append(tournament)

    def _index_player(self, variant: str, player_id: int) -> None:
        ids = self.players.setdefault(name_key(variant), [])
        if player_id not in ids:
            ids.append(player_id)

    def _known_player(self, key: str) -> int | None:
        ids = self.players.get(key)
        if not ids:
            return None
        if len(ids) > 1 and key not in self.ambiguous_warned:
            self.ambiguous_warned.add(key)
            self.report.warnings.append(_tr("issue.player_ambiguous", name=key, id=ids[0]))
        return ids[0]

    async def player(self, raw: str) -> int:
        found = self._known_player(name_key(raw))
        if found is not None:
            self.players_used.add(found)
            return found
        name = clean_name(raw)[:200]
        player = Player(name=name, name_ru=name, aliases=[name])
        self.db.add(player)
        await self.db.flush()
        self._index_player(name, player.id)
        self.players_created.add(player.id)
        self.players_used.add(player.id)
        return player.id

    async def tournament(self, raw: str, surface_raw: object, day: date) -> int | None:
        """Турнир с этим названием, начатый не дальше TOURNAMENT_DAYS от дня ставки (из
        нескольких — ближайший). Иначе заготовка: имя из записи, покрытие, дата начала —
        день первой ставки на нем (настоящую дату подставит загрузка архивов на этапе 2)."""
        if not raw:
            return None
        same_name = self.tournaments.setdefault(name_key(raw), [])
        near = [
            (abs((day - tournament.start_date).days), tournament.id)
            for tournament in same_name
            if tournament.start_date is not None
            and abs((day - tournament.start_date).days) <= TOURNAMENT_DAYS
        ]
        if near:
            return min(near)[1]
        surface, indoor = parse_surface(surface_raw)
        created = Tournament(
            name=raw, surface=surface, indoor=indoor, start_date=day, source=SOURCE
        )
        self.db.add(created)
        await self.db.flush()
        same_name.append(created)
        self.report.tournaments_created += 1
        return created.id

    async def match(
        self, day: date, player1: int, player2: int, tournament_id: int | None
    ) -> tuple[Match, bool]:
        """Матч по дате и паре игроков; второй результат — True, если в базе игроки
        стоят в обратном порядке (тогда сторона исхода меняется)."""
        source_ref = f"{day.isoformat()}:{min(player1, player2)}:{max(player1, player2)}"
        found = self.matches.get(source_ref)
        if found is None:
            found = await self.db.scalar(
                select(Match).where(Match.source == SOURCE, Match.source_ref == source_ref)
            )
        if found is None and tournament_id is not None:
            # Та же пара на том же турнире: ставка сделана накануне матча. Дата здесь уже
            # ограничена: турнир берется только начатый не дальше TOURNAMENT_DAYS от дня
            # ставки. Сузить поиск сильнее нельзя: пара (турнир, игроки) в matches
            # уникальна, второй матч с ними не создать
            found = await self.db.scalar(
                select(Match)
                .where(
                    Match.tournament_id == tournament_id,
                    Match.round == "",
                    Match.player1_id.in_((player1, player2)),
                    Match.player2_id.in_((player1, player2)),
                )
                .limit(1)
            )
        if found is None:
            found = Match(
                tournament_id=tournament_id,
                round="",
                player1_id=player1,
                player2_id=player2,
                status="scheduled",
                source=SOURCE,
                source_ref=source_ref,
            )
            self.db.add(found)
            await self.db.flush()
            self.matches_created.add(found.id)
        elif found.id not in self.matches_created:
            self.matches_found.add(found.id)
        self.matches[source_ref] = found
        return found, found.player1_id != player1

    async def odds(
        self,
        match_id: int,
        flip: bool,
        odds: dict[Pick, Decimal],
        bookmaker: str,
        taken_at: datetime,
    ) -> None:
        rows = await self.db.execute(
            select(OddsSnapshot.market, OddsSnapshot.selection, OddsSnapshot.odds).where(
                OddsSnapshot.match_id == match_id,
                OddsSnapshot.kind == "user",
                OddsSnapshot.bookmaker == bookmaker,
                OddsSnapshot.taken_at == taken_at,
            )
        )
        existing = {(market, selection, value) for market, selection, value in rows}
        for pick, value in odds.items():
            side = pick.flipped() if flip else pick
            key = (side.market, side.selection, value)
            if key in existing:
                continue
            existing.add(key)
            self.db.add(
                OddsSnapshot(
                    match_id=match_id,
                    market=side.market,
                    selection=side.selection,
                    bookmaker=bookmaker,
                    odds=value,
                    kind="user",
                    taken_at=taken_at,
                )
            )
            self.report.odds += 1

    async def record(
        self, record: LegacyRecord, strategy_id: int, entries: Sequence[PlannedEntry]
    ) -> None:
        db, report = self.db, self.report
        analysis = Analysis(
            user_id=self.user.id,
            input_text=_tr("analysis_input", ref=record.ref, date=record.day.isoformat()),
            parsed=record.raw,
            status="done",
            strategy_version_id=strategy_id,
            created_at=record.placed_at,
            finished_at=record.placed_at,
        )
        db.add(analysis)
        await db.flush()
        profit = record.bank_bet().profit
        bet = Bet(
            user_id=self.user.id,
            analysis_id=analysis.id,
            placed_at=record.placed_at,
            bookmaker=record.bookmaker,
            stake=record.stake,
            currency=self.currency,
            total_odds=record.total_odds,
            status=record.status,
            profit=profit,
            settled_at=record.placed_at if profit is not None else None,
            settled_by=SOURCE if profit is not None else None,
            source=SOURCE,
            source_ref=record.ref,
        )
        db.add(bet)
        await db.flush()
        report.bets_new += 1
        leg_result = _leg_result(record.status, single=len(_events_of(record.raw)) == 1)
        picked: set[tuple[int, Pick]] = set()
        for event in record.events:
            report.events += 1
            player1 = await self.player(event.player1)
            player2 = await self.player(event.player2)
            tournament_id = await self.tournament(event.tournament, event.surface, record.day)
            match, flip = await self.match(record.day, player1, player2, tournament_id)
            await self.odds(match.id, flip, event.odds, record.bookmaker, record.placed_at)
            if event.pick is None:
                continue
            pick = event.pick.flipped() if flip else event.pick
            if (match.id, pick) in picked:
                report.warnings.append(_tr("issue.event_duplicate", ref=record.ref, no=event.no))
                continue
            picked.add((match.id, pick))
            prediction = Prediction(
                user_id=self.user.id,
                analysis_id=analysis.id,
                match_id=match.id,
                market=pick.market,
                selection=pick.selection,
                as_of=record.placed_at,
                strategy_version_id=strategy_id,
                llm_model=LLM_MODEL,
                p_claude=event.probability,
                rationale=event.rationale,
                created_at=record.placed_at,
            )
            db.add(prediction)
            await db.flush()
            report.predictions += 1
            if event.odds_taken is None:
                report.warnings.append(_tr("issue.event_no_odds", ref=record.ref, no=event.no))
                continue
            db.add(
                BetLeg(
                    bet_id=bet.id,
                    match_id=match.id,
                    market=pick.market,
                    selection=pick.selection,
                    odds_taken=event.odds_taken,
                    prediction_id=prediction.id,
                    result=leg_result,
                    result_source=SOURCE if leg_result is not None else None,
                    settled_at=record.placed_at if leg_result is not None else None,
                )
            )
            report.legs += 1
        for entry in entries:
            self.ledger(entry, bet.id if entry.with_bet else None)
        await db.flush()

    def ledger(self, entry: PlannedEntry, bet_id: int | None) -> None:
        self.db.add(
            BankrollLedger(
                user_id=self.user.id,
                at=entry.at,
                kind=entry.kind,
                amount=entry.amount,
                currency=self.currency,
                bet_id=bet_id,
                note=self._note(entry),
            )
        )

    def _note(self, entry: PlannedEntry) -> str | None:
        if entry.note_key is None:
            return None
        return _tr(
            f"note.{entry.note_key}",
            ref=entry.note_ref,
            amount=format_money(abs(entry.amount), self.currency),
        )

    async def profiles(self, folders: Sequence["ProfileFolder"]) -> None:
        report = self.report
        done: dict[int, str] = {}
        for folder in folders:
            report.profile_issues += folder.issues
            if folder.dynamic:
                report.dynamic_files += folder.dynamic
                report.dynamic_players += 1
            if not folder.parts:
                report.profile_issues.append(_tr("issue.profile_empty", folder=folder.name))
                continue
            names = _profile_names(folder.name, folder.parts.get("01"))
            player_id = await self._profile_player(names)
            if player_id in done:
                report.profile_issues.append(
                    _tr("issue.profile_duplicate", folder=folder.name, other=done[player_id])
                )
                continue
            done[player_id] = folder.name
            profile = {key: folder.parts[key] for key in sorted(folder.parts)}
            existing = await self.db.get(PlayerProfile, player_id)
            if existing is None:
                self.db.add(
                    PlayerProfile(player_id=player_id, profile=profile, source=PROFILE_SOURCE)
                )
                report.profiles_created += 1
            elif existing.source != PROFILE_SOURCE:
                report.profile_issues.append(
                    _tr("issue.profile_foreign", folder=folder.name, source=existing.source)
                )
            elif existing.profile == profile:
                report.profiles_unchanged += 1
            else:
                existing.profile = profile
                report.profiles_updated += 1
        await self.db.flush()

    async def _profile_player(self, names: list[str]) -> int:
        """Игрок профиля: сначала по полному имени, потом по короткому «Фамилия И.»,
        как его писал бот в истории. Найденному добавляются псевдонимы, иначе создается
        заготовка с полным и коротким именем."""
        found = next(
            (pid for full in names if (pid := self._known_player(name_key(full))) is not None),
            None,
        )
        if found is None:
            found = next(
                (
                    pid
                    for full in names
                    for form in short_forms(full)
                    if (pid := self._known_player(form)) is not None
                ),
                None,
            )
        aliases = list(dict.fromkeys([*names, *filter(None, map(short_name, names))]))
        if found is None:
            player = Player(name=names[0], name_ru=names[0], aliases=aliases)
            self.db.add(player)
            await self.db.flush()
            self.players_created.add(player.id)
            found = player.id
        else:
            existing = await self.db.get(Player, found)
            if existing is not None:
                missing = [alias for alias in aliases if alias not in existing.aliases]
                if missing:
                    existing.aliases = [*existing.aliases, *missing]
            if found not in self.players_created:
                self.players_used.add(found)
        for alias in aliases:
            self._index_player(alias, found)
        return found


@dataclass
class ProfileFolder:
    """Папка игрока из Игроки/: файлы 01–04 по номеру, число пропущенных 05 и 06."""

    name: str
    parts: dict[str, Any]
    dynamic: int
    issues: list[str]


def load_profiles(root: Path) -> list[ProfileFolder]:
    """Читает папки игроков с диска (до открытия транзакции). Битый файл не роняет
    импорт, а попадает в отчет."""
    folders: list[ProfileFolder] = []
    for folder in sorted(path for path in root.iterdir() if path.is_dir()):
        item = ProfileFolder(name=folder.name, parts={}, dynamic=0, issues=[])
        for path in sorted(folder.iterdir()):
            if not path.is_file() or path.suffix.lower() != ".json":
                continue
            prefix = path.name[:2]
            if prefix in DYNAMIC_PARTS:
                item.dynamic += 1
                continue
            if prefix not in PROFILE_PARTS:
                item.issues.append(
                    _tr("issue.profile_unknown_file", folder=folder.name, file=path.name)
                )
                continue
            try:
                item.parts[prefix] = json.loads(path.read_text(encoding="utf-8-sig"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                item.issues.append(
                    _tr("issue.profile_bad_json", folder=folder.name, file=path.name)
                )
        folders.append(item)
    return folders


def _profile_names(folder: str, personal: Any) -> list[str]:
    """Полные имена игрока: ФИО из 01-личные-данные.json и имя папки («Имя-Фамилия»)."""
    names: list[str] = []
    data = personal.get("личные_данные") if isinstance(personal, dict) else None
    fio = data.get("фио") if isinstance(data, dict) else None
    if isinstance(fio, str) and clean_name(fio):
        names.append(clean_name(fio)[:200])
    names.append(clean_name(folder.replace("-", " ").replace("_", " "))[:200])
    unique: dict[str, str] = {}
    for name in names:
        unique.setdefault(name_key(name), name)
    return list(unique.values())


async def _find_user(db: AsyncSession, email: str) -> User:
    user = await db.scalar(select(User).where(func.lower(User.email) == email.strip().lower()))
    if user is None:
        raise ImportFailure("user_not_found", email=email)
    if user.status == "deleted":
        raise ImportFailure("user_deleted", email=email)
    return user


async def _legacy_strategy(db: AsyncSession, user_id: int) -> StrategyVersion:
    strategy = await db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.user_id == user_id, StrategyVersion.code == STRATEGY_CODE
        )
    )
    if strategy is None:
        strategy = StrategyVersion(
            user_id=user_id,
            code=STRATEGY_CODE,
            name=_tr("strategy_name"),
            status="archived",
        )
        db.add(strategy)
        await db.flush()
    return strategy


@dataclass
class _Adjustments:
    """Записи журнала без ставки, которые написали прошлые импорты: пополнения и
    корректировки не позже последней перенесенной ставки."""

    total: Decimal = Decimal(0)
    has_deposit: bool = False


async def _imported_adjustments(
    db: AsyncSession, user_id: int, imported_until: datetime | None
) -> _Adjustments:
    """Пополнение и корректировки, записанные прошлыми импортами. Своей отметки у строк
    журнала нет, поэтому узнаем их по виду и дате: импорт ставит их не позже последней
    перенесенной ставки, а запись в приложении датируется моментом ввода."""
    if imported_until is None:
        return _Adjustments()
    rows = await db.execute(
        select(BankrollLedger.kind, func.sum(BankrollLedger.amount))
        .where(
            BankrollLedger.user_id == user_id,
            BankrollLedger.bet_id.is_(None),
            BankrollLedger.kind.in_(("deposit", "correction")),
            BankrollLedger.at <= imported_until,
        )
        .group_by(BankrollLedger.kind)
    )
    result = _Adjustments()
    for kind, total in rows:
        result.total += Decimal(total)
        result.has_deposit = result.has_deposit or kind == "deposit"
    return result


class _LedgerWriter:
    """Какие записи плана журнала писать в базу.

    Первый импорт пишет план целиком. Повторный — для новых ставок: stake, payout и
    refund всегда; пополнение — только если прошлый импорт его не записал; корректировки
    сверки — только у записей после уже перенесенных (у вставленных раньше них сверка шла
    по другой цепочке). Остаток расхождения с планом закрывает одна корректировка, если
    все ставки базы есть в файле, иначе пересчет по файлу не полный и в отчете замечание.
    """

    def __init__(
        self,
        plan: BankPlan,
        records: Sequence[LegacyRecord],
        existing: dict[str, str],
        adjustments: _Adjustments,
    ):
        self.plan = plan
        self.first_run = not existing
        self.adjustments = adjustments
        self.written = Decimal(0)
        position = {record.ref: index for index, record in enumerate(records)}
        last_old = max((position[ref] for ref in existing if ref in position), default=-1)
        self.appended = {record.ref for record in records[last_old + 1 :]}
        self.inserted = [
            record.ref for record in records[: last_old + 1] if record.ref not in existing
        ]
        self.absent = sorted(
            (ref for ref in existing if ref not in position),
            key=lambda ref: (not ref.isdigit(), int(ref) if ref.isdigit() else 0, ref),
        )
        self.by_ref: dict[str, list[PlannedEntry]] = {}
        for entry in plan.entries:
            self.by_ref.setdefault(entry.ref, []).append(entry)

    def entries_for(self, ref: str) -> list[PlannedEntry]:
        chosen = [entry for entry in self.by_ref.get(ref, []) if self._keep(entry, ref)]
        self.written += sum((entry.amount for entry in chosen if not entry.with_bet), Decimal(0))
        return chosen

    def _keep(self, entry: PlannedEntry, ref: str) -> bool:
        if self.first_run or entry.with_bet:
            return True
        if entry.kind == "deposit":
            return not self.adjustments.has_deposit and ref in self.appended
        return ref in self.appended

    def reconcile(self, at: datetime) -> PlannedEntry | None:
        """Корректировка, после которой пополнения и корректировки в базе равны плану."""
        if self.first_run or self.absent:
            return None
        diff = money(self.plan.adjustments_total - self.adjustments.total - self.written)
        if abs(diff) <= TOLERANCE:
            return None
        return PlannedEntry("", "correction", diff, at, with_bet=False, note_key="reconcile")


async def import_history(
    db: AsyncSession,
    *,
    email: str,
    history: Any,
    history_name: str,
    profiles: Sequence[ProfileFolder] | None = None,
    dry_run: bool = False,
) -> ImportReport:
    """Переносит историю в базу (flush без commit: фиксирует или откатывает вызывающий)."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": LOCK_KEY})
    user = await _find_user(db, email)
    settings = await get_app_settings(db)
    report = ImportReport(
        email=user.email,
        dry_run=dry_run,
        currency=settings.currency,
        history_name=history_name,
    )
    records, json_bank, stats = parse_history(history, report)
    report.json_stats = stats
    report.bank = plan_bank([record.bank_bet() for record in records], json_bank)
    importer = _Importer(db, user, settings.currency, report)
    await importer.load_indexes({record.day for record in records})
    strategy = await _legacy_strategy(db, user.id)
    rows = await db.execute(
        select(Bet.source_ref, Bet.status, Bet.placed_at).where(
            Bet.user_id == user.id, Bet.source == SOURCE
        )
    )
    existing: dict[str, str] = {}
    imported_until: datetime | None = None
    for ref, status, placed_at in rows:
        existing[ref or ""] = status
        imported_until = max(imported_until or placed_at, placed_at)
    adjustments = await _imported_adjustments(db, user.id, imported_until)
    ledger = _LedgerWriter(report.bank, records, existing, adjustments)
    for record in records:
        report.statuses[record.status] += 1
        report.ref_status[record.ref] = record.status
        if record.ref in existing:
            report.bets_existing += 1
            if existing[record.ref] != record.status:
                report.warnings.append(
                    _tr(
                        "issue.status_changed",
                        ref=record.ref,
                        db=_tr(f"status.{existing[record.ref]}"),
                        json=_tr(f"status.{record.status}"),
                    )
                )
            continue
        await importer.record(record, strategy.id, ledger.entries_for(record.ref))
    if records:
        # В конце истории: строка относится ко всему пересчету, а не к одной записи
        reconcile = ledger.reconcile(max(record.placed_at for record in records))
        if reconcile is not None:
            importer.ledger(reconcile, None)
            report.reconciled = reconcile.amount
            await db.flush()
    report.inserted_refs = ledger.inserted
    report.absent_refs = ledger.absent
    if profiles is not None:
        report.profiles_dir = True
        await importer.profiles(profiles)
    report.players_created = len(importer.players_created)
    report.players_found = len(importer.players_used - importer.players_created)
    report.matches_created = len(importer.matches_created)
    report.matches_found = len(importer.matches_found)
    db_bank = await db.scalar(
        select(func.coalesce(func.sum(BankrollLedger.amount), 0)).where(
            BankrollLedger.user_id == user.id
        )
    )
    report.db_bank = Decimal(db_bank or 0)
    await write_audit(
        db,
        action="import",
        actor_id=None,
        target_user_id=user.id,
        details=report.audit_details(),
    )
    return report


# --- команда терминала ---


def load_history(path: Path) -> Any:
    if not path.is_file():
        raise ImportFailure("file_not_found", path=path)
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ImportFailure("file_invalid", path=path, line=exc.lineno) from None
    except (OSError, UnicodeDecodeError):
        raise ImportFailure("file_read", path=path) from None
    if isinstance(data, list) or (isinstance(data, dict) and isinstance(data.get("ставки"), list)):
        return data
    raise ImportFailure("history_format", path=path)


async def _run(
    args: argparse.Namespace, history: Any, profiles: list[ProfileFolder] | None
) -> ImportReport:
    async with get_session() as db:
        report = await import_history(
            db,
            email=args.email,
            history=history,
            history_name=Path(args.history).name,
            profiles=profiles,
            dry_run=args.dry_run,
        )
        if args.dry_run:
            await db.rollback()
        else:
            await db.commit()
    return report


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m app.ingest.legacy", description=_tr("description")
    )
    parser.add_argument("--email", required=True, help=_tr("help.email"))
    parser.add_argument("--history", required=True, help=_tr("help.history"))
    parser.add_argument("--players", help=_tr("help.players"))
    parser.add_argument("--dry-run", action="store_true", help=_tr("help.dry_run"))
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        history = load_history(Path(args.history))
        profiles: list[ProfileFolder] | None = None
        if args.players:
            if not Path(args.players).is_dir():
                raise ImportFailure("players_not_dir", path=args.players)
            try:
                profiles = load_profiles(Path(args.players))
            except OSError:
                raise ImportFailure("players_read", path=args.players) from None
        report = asyncio.run(_run(args, history, profiles))
    except ImportFailure as exc:
        print(exc.message, file=sys.stderr)
        return 1
    except (OperationalError, InterfaceError, ProgrammingError, OSError):
        # Нет связи с базой или нет таблиц. Текст исключения не печатаем: в нем бывает
        # адрес базы с паролем
        print(_tr("errors.db_unavailable"), file=sys.stderr)
        return 1
    print("\n".join(report.lines()), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
