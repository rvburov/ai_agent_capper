"""Ответственная игра (В8, Р24): лимиты числа и суммы ставок в день и пауза.

Сутки — по поясу участника, с полуночи до полуночи. В счет дня идут все ставки, сделанные
сегодня (source = app), — и в игре, и уже рассчитанные. Ставки старого бота не считаются.
Смена пояса (PATCH /api/me) счетчики не обнуляет: текущие сутки досчитываются по прежнему
поясу до своего конца (day_tz, day_tz_until), затем сутки идут по новому. Если новые
сутки начались раньше конца прежних, ставки из общего отрезка идут в счет обоих.

Лимит строже (ниже прежнего или новый) действует сразу. Мягче (выше или снять) — через
24 часа: новое состояние обоих лимитов ждет в pending_* до pending_from и вступает лениво —
при чтении и при проверке. Повтор того же запроса срок не сдвигает, другой — начинает 24
часа заново; запрос без смягчений отменяет ждущее повышение.

Пауза — 1, 7, 30 или 90 дней, до полуночи по поясу участника после последнего дня паузы
(«до 14 октября включительно»). Досрочно не снимается ни участником, ни администратором;
продлить можно, сократить — нет.

Проверка (check): пауза, затем число ставок за сегодня, затем сумма. Перед ставкой
(place_bet, под блокировкой денег участника — две ставки у границы лимита не пройдут обе),
перед разбором текста Claude (analyses.create_from_text) и при запуске и перезапуске
анализа на любом ключе (analyses.start_run). Анализ блокирует уже достигнутый лимит,
ставку — и лимит, который она превысила бы.
Администратор ограничен своими лимитами так же.
"""

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import Bet, PlayLimit, User
from app.schemas.cabinet import PlayLimitsOut, PlayPendingOut, PlayTodayOut
from app.services.app_settings import check_currency, get_app_settings
from app.services.bank import day_start, local_today, lock_member_money, user_zone
from app.services.sessions import utcnow

RAISE_DELAY = timedelta(hours=24)
PAUSE_DAYS = (1, 7, 30, 90)
BETS_PER_DAY_MAX = 20
_ZERO = Decimal(0)
_CENT = Decimal("0.01")


@dataclass(frozen=True)
class Limits:
    """Действующие лимиты (None — без лимита)."""

    bets_per_day: int | None
    stake_per_day: Decimal | None


@dataclass(frozen=True)
class Today:
    """Сутки лимитов: число и сумма ставок с их начала. then — следующие сутки уже по
    новому поясу, если они начались раньше конца этих (после смены пояса): ставки, уже
    сделанные в них, пойдут в счет и там."""

    bets: int
    stake: Decimal
    starts_at: datetime
    ends_at: datetime
    zone: ZoneInfo
    then: "Today | None" = None


def _stricter_or_same(new: int | Decimal | None, old: int | Decimal | None) -> bool:
    """Новый лимит не мягче прежнего: новый при отсутствии прежнего, ниже или тот же."""
    if new is None:
        return old is None
    return old is None or new <= old


def effective(row: PlayLimit | None, now: datetime) -> Limits:
    """Лимиты на момент now: ждущее повышение после pending_from уже действует."""
    if row is None:
        return Limits(None, None)
    if row.pending_from is not None and row.pending_from <= now:
        return Limits(row.pending_bets_per_day, row.pending_stake_per_day)
    return Limits(row.bets_per_day, row.stake_per_day)


def _apply_due(row: PlayLimit, now: datetime) -> bool:
    """Переносит наступившее повышение в действующие лимиты. True — строка изменилась."""
    if row.pending_from is None or row.pending_from > now:
        return False
    row.bets_per_day = row.pending_bets_per_day
    row.stake_per_day = row.pending_stake_per_day
    _clear_pending(row)
    return True


def _clear_pending(row: PlayLimit) -> None:
    row.pending_bets_per_day = None
    row.pending_stake_per_day = None
    row.pending_from = None


def _paused_until(row: PlayLimit | None, now: datetime) -> datetime | None:
    if row is None or row.paused_until is None or row.paused_until <= now:
        return None
    return row.paused_until


def _today_bounds(zone: ZoneInfo, now: datetime) -> tuple[date, datetime, datetime]:
    today = local_today(zone, now)
    return today, day_start(today, zone), day_start(today + timedelta(days=1), zone)


def _kept_zone(row: PlayLimit | None, now: datetime) -> ZoneInfo | None:
    """Прежний пояс, если его сутки после смены пояса еще идут."""
    if row is None or row.day_tz is None or row.day_tz_until is None:
        return None
    if row.day_tz_until <= now:
        return None
    return user_zone(row.day_tz)


async def _usage(
    db: AsyncSession, user_id: int, start: datetime, end: datetime
) -> tuple[int, Decimal]:
    row = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Bet.stake), 0)).where(
                Bet.user_id == user_id,
                Bet.source == "app",
                Bet.placed_at >= start,
                Bet.placed_at < end,
            )
        )
    ).one()
    return int(row[0]), Decimal(row[1])


async def today_usage(
    db: AsyncSession, user: User, now: datetime, row: PlayLimit | None = None
) -> Today:
    """Ставки, сделанные за текущие сутки лимитов: число и сумма. Сутки — по поясу
    участника, после смены пояса — по прежнему до конца его суток (row.day_tz)."""
    zone = user_zone(user.tz)
    kept = _kept_zone(row, now)
    _, start, end = _today_bounds(kept or zone, now)
    bets, stake = await _usage(db, user.id, start, end)
    then: Today | None = None
    if kept is not None:
        # Сутки нового пояса, в которые попадет конец прежних: начались раньше — ставки
        # с их начала тоже в счет (иначе «до какого времени» было бы раньше настоящего)
        _, next_start, next_end = _today_bounds(zone, end)
        if next_start < end and next_start <= now:
            next_bets, next_stake = await _usage(db, user.id, next_start, next_end)
            then = Today(next_bets, next_stake, next_start, next_end, zone)
    return Today(bets, stake, start, end, kept or zone, then)


async def _row(db: AsyncSession, user_id: int, *, lock: bool = False) -> PlayLimit | None:
    stmt = select(PlayLimit).where(PlayLimit.user_id == user_id)
    if lock:
        stmt = stmt.with_for_update()
    return await db.scalar(stmt.execution_options(populate_existing=True))


@dataclass(frozen=True)
class Block:
    """Что не дает поставить или запустить анализ: код ошибки play.* и до какого момента."""

    code: str
    until: datetime
    params: dict[str, str]


def _over(limits: Limits, today: Today, stake: Decimal | None) -> str | None:
    """Какой лимит дня сработал: число ставок, затем сумма. stake — сумма новой ставки;
    None — запуск анализа (блокирует только уже достигнутый лимит)."""
    if limits.bets_per_day is not None and today.bets >= limits.bets_per_day:
        return "play.bets_limit"
    if limits.stake_per_day is not None:
        left = limits.stake_per_day - today.stake
        if (today.stake + stake > limits.stake_per_day) if stake is not None else left <= 0:
            return "play.stake_limit"
    return None


def _block(
    limits: Limits, paused: datetime | None, today: Today, stake: Decimal | None
) -> Block | None:
    """Первое ограничение, которое сработало: пауза, число ставок, сумма. До какого
    момента — конец суток; после смены пояса — конец следующих суток, если ставки
    из общего отрезка держат лимит и там."""
    if paused is not None:
        return Block(code="play.paused", until=paused, params={})
    code = _over(limits, today, stake)
    if code is None:
        return None
    until = today.ends_at
    if today.then is not None and _over(limits, today.then, stake) is not None:
        until = today.then.ends_at
    if code == "play.bets_limit":
        return Block(code=code, until=until, params={"limit": str(limits.bets_per_day)})
    assert limits.stake_per_day is not None
    left = max(limits.stake_per_day - today.stake, _ZERO)
    return Block(
        code=code, until=until, params={"limit": str(limits.stake_per_day), "left": str(left)}
    )


def _local_text(moment: datetime, zone: ZoneInfo) -> str:
    """Момент по поясу участника для текста ошибки: «15.10.2026 00:00»."""
    return moment.astimezone(zone).strftime("%d.%m.%Y %H:%M")


def _last_day_text(until: datetime, zone: ZoneInfo) -> str:
    """Последний день паузы по поясу участника: «21.10.2026». Пауза длится до полуночи после
    него, поэтому день — момент конца минус микросекунда (как в кабинете)."""
    return (until.astimezone(zone) - timedelta(microseconds=1)).strftime("%d.%m.%Y")


async def check(
    db: AsyncSession, user: User, *, stake: Decimal | None = None, now: datetime | None = None
) -> None:
    """Пауза и лимиты дня перед ставкой (stake — ее сумма) или запуском анализа (None).
    Нарушено — 409 play.paused / play.bets_limit / play.stake_limit с until (UTC, ISO) и
    until_text (по поясу участника). Ставку проверять под блокировкой денег участника."""
    now = now or utcnow()
    row = await _row(db, user.id)
    today = await today_usage(db, user, now, row)
    found = _block(effective(row, now), _paused_until(row, now), today, stake)
    if found is None:
        return
    settings = await get_app_settings(db)
    zone = user_zone(user.tz)
    params: dict[str, Any] = {
        "until": found.until.isoformat(),
        # у паузы — последний день включительно, у лимитов дня — момент начала новых суток
        "until_text": (
            _last_day_text(found.until, zone)
            if found.code == "play.paused"
            else _local_text(found.until, zone)
        ),
        "currency": settings.currency,
        **found.params,
    }
    raise AppError(409, found.code, **params)


async def blocked_reason(
    db: AsyncSession, user: User, *, now: datetime | None = None
) -> AppError | None:
    """Та же проверка, что check перед анализом, но ошибка возвращается, а не бросается:
    для «Перезапустить» (analyses.restart_state)."""
    try:
        await check(db, user, now=now)
    except AppError as exc:
        return exc
    return None


async def _out(db: AsyncSession, user: User, row: PlayLimit | None, now: datetime) -> PlayLimitsOut:
    settings = await get_app_settings(db)
    limits = effective(row, now)
    today = await today_usage(db, user, now, row)
    paused = _paused_until(row, now)
    pending = None
    if row is not None and row.pending_from is not None and row.pending_from > now:
        pending = PlayPendingOut(
            bets_per_day=row.pending_bets_per_day,
            stake_per_day=row.pending_stake_per_day,
            starts_at=row.pending_from,
        )
    found = _block(limits, paused, today, None)
    return PlayLimitsOut(
        currency=settings.currency,  # type: ignore[arg-type]
        tz=today.zone.key,
        bets_per_day=limits.bets_per_day,
        stake_per_day=limits.stake_per_day,
        pending=pending,
        paused_until=paused,
        today=PlayTodayOut(
            bets=today.bets, stake=today.stake, starts_at=today.starts_at, ends_at=today.ends_at
        ),
        blocked=found.code.removeprefix("play.") if found is not None else None,  # type: ignore[arg-type]
        blocked_until=found.until if found is not None else None,
        pause_days=list(PAUSE_DAYS),
        bets_per_day_max=BETS_PER_DAY_MAX,
    )


async def get_limits(db: AsyncSession, user: User, *, now: datetime | None = None) -> PlayLimitsOut:
    """Лимиты для кабинета. Наступившее повышение записывается в действующие лимиты."""
    now = now or utcnow()
    row = await _row(db, user.id)
    if row is not None and row.pending_from is not None and row.pending_from <= now:
        await lock_member_money(db, user.id)
        row = await _row(db, user.id, lock=True)
        if row is not None and _apply_due(row, now):
            await db.commit()
    return await _out(db, user, row, now)


async def _locked_row(db: AsyncSession, user: User) -> PlayLimit:
    """Строка лимитов под блокировкой денег участника (как ставка и смена валюты);
    нет — создается пустая."""
    await lock_member_money(db, user.id)
    row = await _row(db, user.id, lock=True)
    if row is None:
        row = PlayLimit(user_id=user.id)
        db.add(row)
        await db.flush()
    return row


async def set_limits(
    db: AsyncSession,
    user: User,
    *,
    bets_per_day: int | None,
    stake_per_day: Decimal | None,
    currency: str | None = None,
    now: datetime | None = None,
) -> PlayLimitsOut:
    """Новые лимиты целиком (None — без лимита). Строже — сразу, мягче — через 24 часа.
    currency — валюта суммы в форме: не валюта программы — 409 common.currency_changed
    (проверка под той же блокировкой, что и смена валюты). Делает commit."""
    now = now or utcnow()
    if stake_per_day is not None:
        stake_per_day = stake_per_day.quantize(_CENT)
    row = await _locked_row(db, user)
    settings = await get_app_settings(db)
    check_currency(settings, currency)
    _apply_due(row, now)
    loosen = not (
        _stricter_or_same(bets_per_day, row.bets_per_day)
        and _stricter_or_same(stake_per_day, row.stake_per_day)
    )
    # Строже — сразу: по каждому лимиту отдельно
    if _stricter_or_same(bets_per_day, row.bets_per_day):
        row.bets_per_day = bets_per_day
    if _stricter_or_same(stake_per_day, row.stake_per_day):
        row.stake_per_day = stake_per_day
    if loosen:
        same_request = (
            row.pending_from is not None
            and row.pending_bets_per_day == bets_per_day
            and row.pending_stake_per_day == stake_per_day
        )
        row.pending_bets_per_day = bets_per_day
        row.pending_stake_per_day = stake_per_day
        if not same_request:
            row.pending_from = now + RAISE_DELAY
    else:
        _clear_pending(row)
    has_money = row.stake_per_day is not None or row.pending_stake_per_day is not None
    row.currency = settings.currency if has_money else None
    await db.commit()
    return await _out(db, user, row, now)


async def keep_day(db: AsyncSession, user: User, *, now: datetime | None = None) -> None:
    """Перед сменой пояса участника (profile.update_profile): текущие сутки лимитов
    досчитываются по прежнему поясу до их конца, иначе смена пояса обнуляла бы ставки и
    сумму за день. Прежние сутки после прошлой смены еще идут — остаются они (иначе сменой
    туда и обратно можно было бы сдвигать начало суток). Нет строки лимитов — нечего
    обходить. flush; commit — за вызывающим, вместе со сменой пояса."""
    now = now or utcnow()
    if await _row(db, user.id) is None:
        return
    row = await _locked_row(db, user)
    if _kept_zone(row, now) is not None:
        return
    zone = user_zone(user.tz)
    _, _, end = _today_bounds(zone, now)
    row.day_tz = zone.key
    row.day_tz_until = end
    await db.flush()


async def pause(
    db: AsyncSession, user: User, days: int, *, now: datetime | None = None
) -> PlayLimitsOut:
    """Пауза на days дней: до полуночи по поясу участника после последнего дня. Короче
    действующей — 409 play.pause_shorter. Делает commit."""
    if days not in PAUSE_DAYS:
        raise AppError(422, "play.pause_days")
    now = now or utcnow()
    zone = user_zone(user.tz)
    today, _, _ = _today_bounds(zone, now)
    until = day_start(today + timedelta(days=days + 1), zone)
    row = await _locked_row(db, user)
    current = _paused_until(row, now)
    if current is not None and until < current:
        raise AppError(
            409,
            "play.pause_shorter",
            until=current.isoformat(),
            until_text=_last_day_text(current, zone),
        )
    row.paused_until = until
    await db.commit()
    return await _out(db, user, row, now)
