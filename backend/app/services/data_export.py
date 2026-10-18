"""Экспорт своих данных (GDPR, В10, PLAN.md, раздел 7): «Личный кабинет → Данные».

Файл собирается при запросе и сразу отдается частями: целиком в памяти он не лежит, ссылок
«на 24 часа» нет. JSON — один файл capper-export-<день>.json; CSV — архив ZIP, по файлу на
таблицу (как в макете: «Скачать JSON», «Скачать CSV (ZIP)»).

Только свое: каждая таблица выбирается по id вошедшего. Колонки перечислены явно, поэтому
в экспорт не попадают хэш пароля, секрет 2FA, резервные коды, токены сеансов и устройств и
ключи Claude в любом виде (даже последние 4 символа); тексты промптов в agent_runs не
хранятся. У подписок push (этап 6) — устройство и даты, без адреса и ключей подписки: по ним
можно слать push на устройство. Общая база игроков, матчей и новостей в архив не входит —
она общая для всех; у событий ставок есть имена игроков и день матча.
"""

import csv
import io
import json
import zipfile
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    ColumnElement,
    Date,
    DateTime,
    Integer,
    Numeric,
    Select,
    String,
    func,
    or_,
    select,
)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.core.csv_safe import safe_text
from app.db.models import (
    AgentRun,
    AiLimit,
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    Bookmaker,
    Lesson,
    LessonWatch,
    LoginEvent,
    Match,
    Notification,
    NotificationPref,
    Player,
    PlayLimit,
    Postmortem,
    Prediction,
    PushSubscription,
    StrategyVersion,
    TrustedDevice,
    User,
    UserSession,
    WeeklyReport,
)
from app.schemas.cabinet import ExportSummaryOut, LegacyPeriodOut
from app.services.app_settings import get_app_settings
from app.services.bank import local_today, user_zone
from app.services.sessions import utcnow

EXPORT_FORMAT = "ai-capper-export"
EXPORT_VERSION = 1
# Строк из базы за один проход курсора и размер части ответа
_FETCH_ROWS = 1000
_CHUNK_BYTES = 64 * 1024
# Запрос таблицы экспорта: колонки у каждой свои
_Query = Select[*tuple[Any, ...]]


@dataclass(frozen=True)
class _Table:
    """Таблица экспорта: имя файла (ключ в JSON) и запрос по id участника."""

    name: str
    query: Callable[[int], _Query]


def _profile(uid: int) -> _Query:
    return select(
        User.id,
        User.email,
        User.display_name,
        User.role,
        User.status,
        User.ai_mode,
        User.tz,
        User.totp_enabled,
        User.consent_training,
        User.terms_accepted_at,
        User.created_at,
        User.last_login_at,
        User.deletion_requested_at,
        User.quiet_enabled,
        User.quiet_start,
        User.quiet_end,
    ).where(User.id == uid)


def _bets(uid: int) -> _Query:
    return (
        select(
            Bet.id,
            Bet.analysis_id,
            Bet.placed_at,
            Bet.bookmaker,
            Bet.stake,
            Bet.currency,
            Bet.total_odds,
            Bet.status,
            Bet.profit,
            Bet.settled_at,
            Bet.settled_by,
            # Этап 5: «Исправить результат» после авторасчета
            Bet.reversed_at,
            Bet.source,
            # Р29: вид ставки — экспресс стратегии, ординар, своя, старый бот
            Bet.kind,
            Bet.source_ref,
            Bet.created_at,
        )
        .where(Bet.user_id == uid)
        .order_by(Bet.id)
    )


def _bet_legs(uid: int) -> _Query:
    p1, p2 = aliased(Player), aliased(Player)
    return (
        select(
            BetLeg.id,
            BetLeg.bet_id,
            BetLeg.match_id,
            Match.match_date,
            p1.name.label("player1"),
            p2.name.label("player2"),
            BetLeg.market,
            BetLeg.selection,
            BetLeg.odds_taken,
            BetLeg.prediction_id,
            Prediction.p_base,
            Prediction.p_claude,
            Prediction.p_final,
            Prediction.q_market_at_pred,
            BetLeg.result,
            BetLeg.score,
            BetLeg.settled_at,
            BetLeg.result_source,
            # Этап 5: что показал архив, если он разошелся с ручным расчетом
            BetLeg.archive_result,
            BetLeg.archive_score,
            BetLeg.closing_odds,
            BetLeg.closing_opp_odds,
            BetLeg.closing_bookmaker,
            BetLeg.closing_source,
            BetLeg.q_close,
            BetLeg.clv,
        )
        .join(Bet, Bet.id == BetLeg.bet_id)
        .join(Match, Match.id == BetLeg.match_id)
        .join(p1, p1.id == Match.player1_id)
        .join(p2, p2.id == Match.player2_id)
        .outerjoin(Prediction, Prediction.id == BetLeg.prediction_id)
        .where(Bet.user_id == uid)
        .order_by(BetLeg.id)
    )


def _ledger(uid: int) -> _Query:
    return (
        select(
            BankrollLedger.id,
            BankrollLedger.at,
            BankrollLedger.kind,
            BankrollLedger.amount,
            BankrollLedger.currency,
            BankrollLedger.bet_id,
            BankrollLedger.reversed_by,
            BankrollLedger.note,
        )
        .where(BankrollLedger.user_id == uid)
        .order_by(BankrollLedger.id)
    )


def _analyses(uid: int) -> _Query:
    return (
        select(
            Analysis.id,
            Analysis.created_at,
            Analysis.status,
            Analysis.input_kind,
            Analysis.input_text,
            Analysis.parsed,
            Analysis.confirmed,
            Analysis.bank_input,
            Analysis.bookmaker,
            Analysis.strategy_version_id,
            Analysis.prompt_version,
            Analysis.key_source,
            Analysis.started_at,
            Analysis.attempt,
            Analysis.result,
            Analysis.cost_usd,
            Analysis.decision,
            Analysis.error_code,
            Analysis.finished_at,
        )
        .where(Analysis.user_id == uid)
        .order_by(Analysis.id)
    )


def _own_predictions(uid: int) -> ColumnElement[bool]:
    own = select(Analysis.id).where(Analysis.user_id == uid)
    return or_(Prediction.user_id == uid, Prediction.analysis_id.in_(own))


def _predictions(uid: int) -> _Query:
    return (
        select(
            Prediction.id,
            Prediction.created_at,
            Prediction.analysis_id,
            Prediction.match_id,
            Prediction.market,
            Prediction.selection,
            Prediction.as_of,
            Prediction.p_base,
            Prediction.p_claude,
            Prediction.p_final,
            Prediction.q_market_at_pred,
            Prediction.odds_at_pred,
            Prediction.bookmaker_at_pred,
            Prediction.value_at_pred,
            Prediction.llm_model,
            Prediction.effort,
            Prediction.prompt_version,
            Prediction.rationale,
            Prediction.supersedes,
            Prediction.is_eval,
        )
        .where(_own_predictions(uid))
        .order_by(Prediction.id)
    )


def _agent_runs(uid: int) -> _Query:
    return (
        select(
            AgentRun.id,
            AgentRun.created_at,
            AgentRun.kind,
            AgentRun.step,
            AgentRun.analysis_id,
            AgentRun.key_source,
            AgentRun.model,
            AgentRun.effort,
            AgentRun.prompt_version,
            AgentRun.input_tokens,
            AgentRun.cache_write_tokens,
            AgentRun.cache_read_tokens,
            AgentRun.output_tokens,
            AgentRun.thinking_tokens,
            AgentRun.web_searches,
            AgentRun.batch,
            AgentRun.cost_usd,
            AgentRun.duration_ms,
            AgentRun.stop_reason,
            AgentRun.error,
        )
        .where(AgentRun.user_id == uid)
        .order_by(AgentRun.id)
    )


def _strategies(uid: int) -> _Query:
    return (
        select(
            StrategyVersion.id,
            StrategyVersion.created_at,
            StrategyVersion.code,
            StrategyVersion.name,
            StrategyVersion.status,
            StrategyVersion.params,
            StrategyVersion.prompt_version,
            StrategyVersion.lessons,
            StrategyVersion.metrics,
            StrategyVersion.approved_at,
        )
        .where(StrategyVersion.user_id == uid)
        .order_by(StrategyVersion.id)
    )


def _lessons(uid: int) -> _Query:
    """Свои уроки и уроки, которые участник предложил сам (этап 5: общие, origin manual)."""
    return (
        select(
            Lesson.id,
            Lesson.created_at,
            Lesson.code,
            Lesson.text,
            Lesson.kind,
            Lesson.status,
            Lesson.origin,
            Lesson.n_cases,
            Lesson.effect,
            Lesson.validated_at,
        )
        .where(or_(Lesson.user_id == uid, Lesson.created_by == uid))
        .order_by(Lesson.id)
    )


def _lesson_watches(uid: int) -> _Query:
    """«Сообщить, когда наберется» (этап 5): какие уроки участник ждет."""
    return (
        select(Lesson.code, LessonWatch.created_at, LessonWatch.notified_at)
        .join(Lesson, Lesson.id == LessonWatch.lesson_id)
        .where(LessonWatch.user_id == uid)
        .order_by(LessonWatch.created_at, Lesson.code)
    )


def _weekly_reports(uid: int) -> _Query:
    return (
        select(WeeklyReport.week_start, WeeklyReport.payload, WeeklyReport.created_at)
        .where(WeeklyReport.user_id == uid)
        .order_by(WeeklyReport.week_start)
    )


def _postmortems(uid: int) -> _Query:
    """Разборы прогнозов, которые вызвали ставки участника (этап 5, В3): разбор общий для
    матча, но связь со ставкой — личная (Т21). Служебные ссылки (пакет, вызов ИИ) — нет."""
    return (
        select(
            Postmortem.id,
            Postmortem.created_at,
            Postmortem.bet_id,
            Postmortem.match_id,
            Postmortem.status,
            Postmortem.verdict,
            Postmortem.summary,
            Postmortem.why,
            Postmortem.hypothesis,
            Postmortem.scope,
        )
        .where(Postmortem.user_id == uid)
        .order_by(Postmortem.id)
    )


def _ai_limit(uid: int) -> _Query:
    return select(
        AiLimit.monthly_usd,
        AiLimit.daily_analyses,
        AiLimit.per_analysis_usd,
        AiLimit.own_per_analysis_usd,
        AiLimit.paused,
        AiLimit.return_requested_at,
        AiLimit.updated_at,
    ).where(AiLimit.user_id == uid)


def _play_limits(uid: int) -> _Query:
    return select(
        PlayLimit.bets_per_day,
        PlayLimit.stake_per_day,
        PlayLimit.currency,
        PlayLimit.pending_bets_per_day,
        PlayLimit.pending_stake_per_day,
        PlayLimit.pending_from,
        PlayLimit.paused_until,
        PlayLimit.day_tz,
        PlayLimit.day_tz_until,
        PlayLimit.updated_at,
    ).where(PlayLimit.user_id == uid)


def _bookmakers(uid: int) -> _Query:
    return (
        select(Bookmaker.id, Bookmaker.name, Bookmaker.created_at, Bookmaker.archived_at)
        .where(Bookmaker.user_id == uid)
        .order_by(Bookmaker.id)
    )


def _notification_prefs(uid: int) -> _Query:
    return (
        select(NotificationPref.kind, NotificationPref.on_site, NotificationPref.push)
        .where(NotificationPref.user_id == uid)
        .order_by(NotificationPref.kind)
    )


def _push_subscriptions(uid: int) -> _Query:
    """Устройства с push (и отозванные): без endpoint и ключей подписки."""
    return (
        select(
            PushSubscription.id,
            PushSubscription.device,
            PushSubscription.created_at,
            PushSubscription.last_sent_at,
            PushSubscription.revoked_at,
        )
        .where(PushSubscription.user_id == uid)
        .order_by(PushSubscription.id)
    )


def _notifications(uid: int) -> _Query:
    return (
        select(
            Notification.id,
            Notification.created_at,
            Notification.kind,
            Notification.title,
            Notification.body,
            Notification.link,
            Notification.read_at,
        )
        .where(Notification.user_id == uid)
        .order_by(Notification.id)
    )


def _logins(uid: int) -> _Query:
    return (
        select(
            LoginEvent.at,
            LoginEvent.ip,
            LoginEvent.user_agent,
            LoginEvent.result,
            LoginEvent.method,
        )
        .where(LoginEvent.user_id == uid)
        .order_by(LoginEvent.id)
    )


def _sessions(uid: int) -> _Query:
    return (
        select(
            UserSession.created_at,
            UserSession.last_seen_at,
            UserSession.expires_at,
            UserSession.ip,
            UserSession.device_label,
            UserSession.revoked_at,
        )
        .where(UserSession.user_id == uid)
        .order_by(UserSession.id)
    )


def _devices(uid: int) -> _Query:
    return (
        select(
            TrustedDevice.created_at,
            TrustedDevice.expires_at,
            TrustedDevice.ip,
            TrustedDevice.device_label,
            TrustedDevice.last_used_at,
            TrustedDevice.revoked_at,
        )
        .where(TrustedDevice.user_id == uid)
        .order_by(TrustedDevice.id)
    )


# Порядок — как в карточке «Экспорт всех данных»: ставки, банк, букмекеры, стратегия и
# ответственная игра, вызовы ИИ, уведомления и входы
TABLES: tuple[_Table, ...] = (
    _Table("bets", _bets),
    _Table("bet_legs", _bet_legs),
    _Table("bank_ledger", _ledger),
    _Table("bookmakers", _bookmakers),
    _Table("strategy_versions", _strategies),
    _Table("play_limits", _play_limits),
    _Table("analyses", _analyses),
    _Table("predictions", _predictions),
    _Table("lessons", _lessons),
    _Table("lesson_watches", _lesson_watches),
    _Table("postmortems", _postmortems),
    _Table("weekly_reports", _weekly_reports),
    _Table("ai_runs", _agent_runs),
    _Table("ai_limit", _ai_limit),
    _Table("notification_prefs", _notification_prefs),
    _Table("push_subscriptions", _push_subscriptions),
    _Table("notifications", _notifications),
    _Table("login_events", _logins),
    _Table("sessions", _sessions),
    _Table("trusted_devices", _devices),
)
PROFILE = _Table("profile", _profile)


def _plain(value: Any) -> Any:
    """Значение для JSON: деньги и кэфы — строкой (точность не теряется), время — ISO."""
    if isinstance(value, Decimal):
        return str(value)
    if isinstance(value, datetime | date | time):
        return value.isoformat()
    return value


def _cell(value: Any) -> str:
    """Ячейка CSV: пусто для NULL, JSON для вложенных данных, текст — без формулы
    (safe_text)."""
    value = _plain(value)
    if value is None:
        return ""
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return safe_text(value)
    return str(value)


async def _batches(
    db: AsyncSession, table: _Table, uid: int
) -> AsyncIterator[tuple[list[str], Sequence[Sequence[Any]]]]:
    """Строки таблицы курсором базы пачками по _FETCH_ROWS: (имена колонок, строки). Пачка
    — одно ожидание: построчный обход (переключение на каждую строку) на 80 тыс. строк
    занимал секунды."""
    result = await db.stream(table.query(uid).execution_options(yield_per=_FETCH_ROWS))
    keys = list(result.keys())
    async for rows in result.partitions(_FETCH_ROWS):
        yield keys, rows


async def summary(db: AsyncSession, user: User) -> ExportSummaryOut:
    """Числа для кабинета «Данные»: сколько ставок, событий и вызовов Claude войдет в
    экспорт и статус импорта бота. Те же таблицы и условия, что у экспорта: свое — по id
    вошедшего."""
    uid = user.id
    is_open = Bet.status == "open"
    is_legacy = Bet.source == "legacy"
    bets = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(is_open),
                func.count().filter(is_legacy),
                func.min(Bet.placed_at).filter(is_legacy),
                func.max(Bet.placed_at).filter(is_legacy),
            ).where(Bet.user_id == uid)
        )
    ).one()
    legs = (
        await db.execute(
            select(
                func.count(),
                func.count().filter(is_legacy, ~is_open, BetLeg.result.is_(None)),
                func.count().filter(is_legacy, BetLeg.result_source == "auto"),
            )
            .select_from(BetLeg)
            .join(Bet, Bet.id == BetLeg.bet_id)
            .where(Bet.user_id == uid)
        )
    ).one()
    runs = await db.scalar(select(func.count()).where(AgentRun.user_id == uid))
    zone = user_zone(user.tz)
    first, last = bets[3], bets[4]
    period = (
        LegacyPeriodOut(first=first.astimezone(zone).date(), last=last.astimezone(zone).date())
        if first is not None and last is not None
        else None
    )
    return ExportSummaryOut(
        bets=int(bets[0]),
        open_bets=int(bets[1]),
        legacy_bets=int(bets[2]),
        events=int(legs[0]),
        ai_runs=int(runs or 0),
        legacy_period=period,
        legacy_no_result=int(legs[1]),
        legacy_from_archive=int(legs[2]),
    )


def filename(user: User, fmt: str, now: datetime | None = None) -> str:
    """capper-export-2026-10-13.json (или .zip) — день по поясу участника."""
    day = local_today(user_zone(user.tz), now or utcnow())
    return f"capper-export-{day.isoformat()}.{'json' if fmt == 'json' else 'zip'}"


async def _header(db: AsyncSession, user: User) -> dict[str, Any]:
    settings = await get_app_settings(db)
    return {
        "format": EXPORT_FORMAT,
        "version": EXPORT_VERSION,
        "exported_at": utcnow().isoformat(),
        "currency": settings.currency,
        "ai_currency": "USD",
    }


def _dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=_plain, separators=(",", ":"))


async def json_chunks(db: AsyncSession, user: User) -> AsyncIterator[bytes]:
    """Один JSON-файл частями: {"format", ..., "profile": {...}, "tables": {"bets": [...]}}."""
    header = await _header(db, user)
    profile: dict[str, Any] = {}
    async for keys, rows in _batches(db, PROFILE, user.id):
        for row in rows:
            profile = dict(zip(keys, row, strict=True))
    head = _dumps(header)[:-1] + ',"profile":' + _dumps(profile) + ',"tables":{'
    buffer = [head]
    size = len(head)
    for index, table in enumerate(TABLES):
        part = ("," if index else "") + _dumps(table.name) + ":["
        buffer.append(part)
        size += len(part)
        first = True
        async for keys, rows in _batches(db, table, user.id):
            # Пачка — один вызов json: деньги и время переводит _plain (default)
            text = _dumps([dict(zip(keys, row, strict=True)) for row in rows])[1:-1]
            if not text:
                continue
            text = ("" if first else ",") + text
            first = False
            buffer.append(text)
            size += len(text)
            if size >= _CHUNK_BYTES:
                yield "".join(buffer).encode()
                buffer, size = [], 0
        buffer.append("]")
    buffer.append("}}")
    yield "".join(buffer).encode()


class _Sink(io.RawIOBase):
    """Поток для zipfile без перемотки: записанное забирается частями (drain). zipfile
    сам переходит на запись без seek (дескрипторы данных после файла)."""

    def __init__(self) -> None:
        self._chunks: list[bytes] = []
        self.size = 0

    def writable(self) -> bool:
        return True

    def write(self, data: Any) -> int:
        chunk = bytes(data)
        self._chunks.append(chunk)
        self.size += len(chunk)
        return len(chunk)

    def drain(self) -> bytes:
        out = b"".join(self._chunks)
        self._chunks.clear()
        self.size = 0
        return out


def _iso(value: Any) -> str:
    return "" if value is None else str(value.isoformat())


def _flag(value: Any) -> str:
    return "" if value is None else "true" if value else "false"


def _text(value: Any) -> str:
    """Строка: чужой текст (имя участника в заголовке уведомления, сообщение
    администратора) не должен стать формулой в таблице получателя."""
    if value is None:
        return ""
    return safe_text(value) if isinstance(value, str) else str(value)


def _converter(column_type: Any) -> Callable[[Any], str] | None:
    """Как писать колонку в CSV. None — значения csv пишет сам как нужно: целые, деньги
    (Decimal — str), числа с плавающей точкой, пустое — пусто. Строки — _text (без
    формулы), время — ISO, да/нет — true/false, остальное (JSON, выражения без типа) —
    _cell."""
    if isinstance(column_type, Boolean):
        return _flag
    if isinstance(column_type, String):
        return _text
    if isinstance(column_type, Integer | Numeric):
        return None
    if isinstance(column_type, DateTime | Date):
        return _iso
    return _cell


def _csv_lines(
    rows: Sequence[Sequence[Any]], convert: Sequence[tuple[int, Callable[[Any], str]]] = ()
) -> bytes:
    """Строки CSV; convert — (номер колонки, перевод) для колонок, которые csv сам не
    напишет как нужно: остальные ячейки не проходят по одной через Python (в выгрузке их
    миллионы)."""
    if convert:
        changed = []
        for row in rows:
            values = list(row)
            for index, to_text in convert:
                values[index] = to_text(values[index])
            changed.append(values)
        rows = changed
    out = io.StringIO()
    csv.writer(out, lineterminator="\r\n").writerows(rows)
    return out.getvalue().encode()


async def zip_chunks(db: AsyncSession, user: User) -> AsyncIterator[bytes]:
    """Архив ZIP частями: export.json с описанием, profile.csv и по CSV на таблицу (BOM —
    чтобы Excel узнал UTF-8). Таблица без строк — файл с заголовком, если колонки известны."""
    sink = _Sink()
    header = await _header(db, user)
    with zipfile.ZipFile(sink, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("export.json", _dumps(header))
        for table in (PROFILE, *TABLES):
            with archive.open(f"{table.name}.csv", "w") as entry:
                entry.write("﻿".encode())
                selected = table.query(user.id).selected_columns
                entry.write(_csv_lines([[column.key for column in selected]]))
                convert = [
                    (index, to_text)
                    for index, column in enumerate(selected)
                    if (to_text := _converter(column.type)) is not None
                ]
                async for _, rows in _batches(db, table, user.id):
                    entry.write(_csv_lines(rows, convert))
                    if sink.size >= _CHUNK_BYTES:
                        yield sink.drain()
            if sink.size:
                yield sink.drain()
    yield sink.drain()
