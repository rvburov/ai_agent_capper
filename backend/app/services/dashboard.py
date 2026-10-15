"""Главная участника (GET /api/dashboard) одним ответом. Видит только сам участник (Р14);
дела администратора — только у администратора и без чужих ставок и банка.

Показатели периода, прошлый период, Brier против рынка и ряд банка — та же функция
расчета, что у «Аналитики» без фильтров (app/services/analytics.py), без доверительных
интервалов: главная = аналитика без фильтров = итоги «Ставок» за тот же период. Эта часть
(DashboardCoreOut) кэшируется вместе с аналитикой.

Каждый запрос заново: банк (как GET /me/bank — он считается по журналу одним запросом),
открытые ставки, «Мои матчи сегодня» и дела администратора.

«Мои матчи сегодня» (В6): расписания в программе нет (Р10), поэтому только свои матчи —
ноги открытых ставок и события анализов, начатых сегодня по поясу участника. День матча —
дата матча, иначе день по времени начала, иначе (матч из ввода) — день ставки; у события
анализа — день анализа, если у матча нет своей даты.
"""

import asyncio
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any
from zoneinfo import ZoneInfo

from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.core.config import get_settings
from app.db.models import (
    AiLimit,
    Analysis,
    Bet,
    BetLeg,
    Match,
    Player,
    PlayerEloCurrent,
    Tournament,
    User,
)
from app.schemas.analytics import AnalyticsFiltersIn
from app.schemas.bets import Period, PlayerRefOut
from app.schemas.dashboard import (
    AdminAttentionOut,
    ArchiveSourceOut,
    ArchiveStaleOut,
    ArchiveStatusOut,
    DashboardCoreOut,
    DashboardOut,
    Greeting,
    KeyReturnRequestOut,
    LimitAlertOut,
    MyMatchBetOut,
    MyMatchOut,
    OpenBetOut,
    RecentBetOut,
)
from app.services import analytics, analytics_cache
from app.services.admin_users import month_usage
from app.services.ai_access import call_need_usd, limits_of, runs_out_on, threshold_level
from app.services.app_settings import get_app_settings
from app.services.bank import day_start, equity_after_bets, local_today, user_zone
from app.services.bets import bank_out, bet_items
from app.services.data_status import (
    DATA_UPDATE_MINUTE,
    STALE_AFTER,
    is_stale,
    last_ok_loads,
)
from app.services.sessions import utcnow

DEFAULT_PERIOD: Period = "30d"
RECENT_LIMIT = 12
OPEN_LIMIT = 10
# Приветствие: с какого часа утро, день, вечер и ночь (по поясу участника)
_GREETINGS: tuple[tuple[int, Greeting], ...] = (
    (5, "morning"),
    (12, "day"),
    (17, "evening"),
    (23, "night"),
)


def greeting(moment: datetime, zone: ZoneInfo) -> Greeting:
    """Приветствие по времени суток: 5–12 утро, 12–17 день, 17–23 вечер, иначе ночь."""
    hour = moment.astimezone(zone).hour
    found: Greeting = "night"
    for start, value in _GREETINGS:
        if hour >= start:
            found = value
    return found


# --- показатели периода (кэш) ---


@dataclass(frozen=True)
class _CoreInputs:
    inputs: analytics.Inputs
    period: Period
    equity_after: dict[int, Decimal]


def build_core(core: _CoreInputs) -> DashboardCoreOut:
    """Показатели периода, Brier, ряд банка и последние ставки (чистая функция)."""
    inputs = core.inputs
    parts = analytics.parts_of(inputs)
    kpi = analytics.kpi_block(inputs, parts.chosen, parts.clvs)
    prev = analytics.prev_block(inputs)
    brier = analytics.brier_block(inputs, parts.events if parts.kind == "final" else [])
    recent = sorted(
        parts.chosen,
        key=lambda bet: (bet.settled_at or bet.placed_at, bet.id),
        reverse=True,
    )[:RECENT_LIMIT]
    return DashboardCoreOut(
        period=core.period,
        date_from=inputs.window.first,
        date_to=inputs.window.last,
        kpi=kpi,
        prev=prev,
        change=analytics.change_block(inputs.current, prev),
        brier=brier,
        series=analytics.series_block(inputs, parts.chosen),
        recent=[
            RecentBetOut(
                id=bet.id,
                placed_at=bet.placed_at,
                settled_at=bet.settled_at,
                legs=len(bet.legs),
                total_odds=bet.total_odds,
                status=bet.status,  # type: ignore[arg-type]
                stake=bet.stake,
                profit=bet.profit,
                source=bet.source,  # type: ignore[arg-type]
                equity_after=core.equity_after.get(bet.id),
            )
            for bet in recent
        ],
        small_sample=kpi.settled < analytics.THRESHOLDS.dashboard_small,
    )


async def dashboard_core(
    db: AsyncSession, user: User, period: Period, *, now: datetime | None = None
) -> DashboardCoreOut:
    """Показатели периода без кэша."""
    inputs = await analytics.gather_inputs(
        db, user, AnalyticsFiltersIn(period=period), now=now, with_ci=False
    )
    chosen = sorted(
        (bet for bet in inputs.rows if bet.id in inputs.selected),
        key=lambda bet: (bet.settled_at or bet.placed_at, bet.id),
        reverse=True,
    )
    after = await equity_after_bets(db, user.id, [bet.id for bet in chosen[:RECENT_LIMIT]])
    return await asyncio.to_thread(build_core, _CoreInputs(inputs, period, after))


async def cached_core_json(
    db: AsyncSession, redis: Redis | None, user: User, period: Period
) -> str:
    """Показатели периода из кэша (или посчитанные и сохраненные), JSON."""
    version = await analytics_cache.data_version(db, user)
    key = analytics_cache.cache_key(
        user.id, "dashboard", AnalyticsFiltersIn(period=period), version
    )

    async def compute() -> DashboardCoreOut:
        return await dashboard_core(db, user, period)

    return await analytics_cache.cached_json(redis, user.id, key, DashboardCoreOut, compute)


# --- открытые ставки и мои матчи ---


async def _open_bets(db: AsyncSession, user: User) -> tuple[list[OpenBetOut], int, Decimal]:
    count, stake = (
        await db.execute(
            select(func.count(), func.coalesce(func.sum(Bet.stake), 0)).where(
                Bet.user_id == user.id, Bet.status == "open"
            )
        )
    ).one()
    ids = list(
        await db.scalars(
            select(Bet.id)
            .where(Bet.user_id == user.id, Bet.status == "open")
            .order_by(Bet.placed_at.desc(), Bet.id.desc())
            .limit(OPEN_LIMIT)
        )
    )
    items = await bet_items(db, user, ids)
    out = [
        OpenBetOut(
            **item.model_dump(),
            implied=[float(1 / leg.odds_taken) for leg in item.legs],
        )
        for item in items
    ]
    return out, int(count), Decimal(stake)


def _local(moment: datetime | None, zone: ZoneInfo) -> date | None:
    return moment.astimezone(zone).date() if moment is not None else None


@dataclass
class _Today:
    bets: list[MyMatchBetOut]
    analyses: list[int]


async def my_matches(
    db: AsyncSession, user: User, zone: ZoneInfo, today: date, now: datetime
) -> list[MyMatchOut]:
    """Ноги открытых ставок и события сегодняшних анализов на сегодняшние матчи (В6)."""
    found: dict[int, _Today] = defaultdict(lambda: _Today([], []))
    legs = await db.execute(
        select(BetLeg, Match.match_date, Match.scheduled_at, Bet.placed_at, Bet.analysis_id)
        .join(Bet, Bet.id == BetLeg.bet_id)
        .join(Match, Match.id == BetLeg.match_id)
        .where(Bet.user_id == user.id, Bet.status == "open")
        .order_by(Bet.placed_at, BetLeg.id)
    )
    # Анализы, из ввода которых берется название турнира матча из ввода участника
    sources: set[int] = set()
    for leg, match_day, scheduled_at, placed_at, analysis_id in legs:
        day = match_day or _local(scheduled_at, zone) or _local(placed_at, zone)
        if day != today:
            continue
        if analysis_id is not None:
            sources.add(analysis_id)
        found[leg.match_id].bets.append(
            MyMatchBetOut(
                bet_id=leg.bet_id,
                leg_id=leg.id,
                market=leg.market,  # type: ignore[arg-type]
                selection=leg.selection,
                odds_taken=leg.odds_taken,
            )
        )
    analyses = await db.execute(
        select(Analysis.id, Analysis.confirmed)
        .where(
            Analysis.user_id == user.id,
            Analysis.created_at >= day_start(today, zone),
            Analysis.confirmed.is_not(None),
        )
        .order_by(Analysis.id)
    )
    analysis_matches: dict[int, list[int]] = defaultdict(list)
    for analysis_id, confirmed in analyses:
        for event in (confirmed or {}).get("events") or []:
            match_id = event.get("match_id")
            if match_id is not None and analysis_id not in analysis_matches[int(match_id)]:
                analysis_matches[int(match_id)].append(analysis_id)
    ids = set(found) | set(analysis_matches)
    if not ids:
        return []
    matches = {
        match.id: (match, tournament)
        for match, tournament in await db.execute(
            select(Match, Tournament)
            .outerjoin(Tournament, Tournament.id == Match.tournament_id)
            .where(Match.id.in_(ids))
        )
    }
    for match_id, analysis_ids in analysis_matches.items():
        pair = matches.get(match_id)
        if pair is None:
            continue
        own = pair[0].match_date or _local(pair[0].scheduled_at, zone)
        if own is None or own == today:
            found[match_id].analyses.extend(analysis_ids)
    player_ids = {pid for row, _ in matches.values() for pid in (row.player1_id, row.player2_id)}
    players = {
        player.id: player
        for player in await db.scalars(select(Player).where(Player.id.in_(player_ids)))
    }
    ranks = dict(
        (
            await db.execute(
                select(PlayerEloCurrent.player_id, PlayerEloCurrent.rank_all).where(
                    PlayerEloCurrent.player_id.in_(player_ids)
                )
            )
        ).all()
    )
    sources |= {aid for ids_ in analysis_matches.values() for aid in ids_}
    names = _input_tournaments(
        await db.execute(
            select(Analysis.confirmed).where(Analysis.user_id == user.id, Analysis.id.in_(sources))
        )
    )
    out: list[MyMatchOut] = []
    for match_id, today_items in found.items():
        if not today_items.bets and not today_items.analyses:
            continue
        match, tournament = matches[match_id]
        title = tournament.name if tournament is not None and tournament.source != "user" else None
        out.append(
            MyMatchOut(
                match_id=match_id,
                player1=_player_ref(players, match.player1_id),
                player2=_player_ref(players, match.player2_id),
                rank1=ranks.get(match.player1_id),
                rank2=ranks.get(match.player2_id),
                tournament=title or names.get(match_id),
                round=match.round or None,
                scheduled_at=match.scheduled_at,
                bets=today_items.bets,
                analyses=today_items.analyses,
            )
        )
    out.sort(key=lambda item: (item.scheduled_at or now.replace(year=9999), item.match_id))
    return out


def _input_tournaments(rows: Any) -> dict[int, str]:
    """Названия турниров из своего ввода (матч из ввода — общий, турнир — только свой)."""
    names: dict[int, str] = {}
    for (confirmed,) in rows:
        for event in (confirmed or {}).get("events") or []:
            match_id, name = event.get("match_id"), event.get("tournament_name")
            if match_id is not None and name:
                names[int(match_id)] = str(name)
    return names


def _player_ref(players: dict[int, Player], player_id: int) -> PlayerRefOut:
    found = players.get(player_id)
    if found is None:
        return PlayerRefOut(id=player_id, name="", name_ru=None)
    return PlayerRefOut(id=found.id, name=found.name, name_ru=found.name_ru)


# --- дела администратора ---


async def admin_attention(db: AsyncSession, now: datetime) -> AdminAttentionOut:
    """Архив матчей, просьбы вернуть ключ и участники у лимита (Р14: только расход на ИИ)."""
    loads = await last_ok_loads(db)
    known = [when for when in loads.values() if when is not None]
    oldest = min(known) if len(known) == len(loads) else None
    status = ArchiveStatusOut(
        stale=is_stale(loads, now),
        days=(now - oldest).days if oldest is not None else None,
        last_load=oldest,
        stale_after_days=STALE_AFTER.days,
        update_hour_utc=get_settings().data_update_hour_utc,
        update_minute=DATA_UPDATE_MINUTE,
        sources=[
            ArchiveSourceOut(source=source, last_load=when)  # type: ignore[arg-type]
            for source, when in loads.items()
        ],
    )
    archive = (
        ArchiveStaleOut.model_validate(status.model_dump(exclude={"stale"}))
        if status.stale
        else None
    )
    settings = await get_app_settings(db)
    members = list(
        await db.scalars(
            select(User).where(User.role == "member", User.status == "active").order_by(User.id)
        )
    )
    limits = {
        row.user_id: row
        for row in await db.scalars(
            select(AiLimit).where(AiLimit.user_id.in_([member.id for member in members]))
        )
    }
    requests: list[KeyReturnRequestOut] = []
    shared: list[User] = []
    for member in members:
        member_limits = limits_of(limits.get(member.id), settings)
        if member.ai_mode == "own" and member_limits.return_requested_at is not None:
            requests.append(
                KeyReturnRequestOut(
                    user_id=member.id,
                    name=member.display_name or member.email,
                    at=member_limits.return_requested_at,
                )
            )
        if member.ai_mode == "shared":
            shared.append(member)
    usage = await month_usage(db, [member.id for member in shared], now)
    need = await call_need_usd(db, await load_agent_config(db), now) if shared else Decimal(0)
    alerts: list[LimitAlertOut] = []
    for member in shared:
        monthly = limits_of(limits.get(member.id), settings).monthly_usd
        spent = usage.get(member.id, (Decimal(0), 0))[0]
        level = threshold_level(spent, monthly, settings.budget_alert_pct, need)
        if level is None:
            continue
        alerts.append(
            LimitAlertOut(
                user_id=member.id,
                name=member.display_name or member.email,
                spent_usd=spent,
                limit_usd=monthly,
                share=float(spent / monthly) if monthly > 0 else 1.0,
                level=level,  # type: ignore[arg-type]
                runs_out_on=runs_out_on(spent, monthly, now),
            )
        )
    return AdminAttentionOut(
        archive=archive,
        archive_status=status,
        return_requests=requests,
        limits=alerts,
        alert_pct=settings.budget_alert_pct,
    )


# --- главная ---


async def dashboard(
    db: AsyncSession,
    redis: Redis | None,
    user: User,
    period: Period = DEFAULT_PERIOD,
    *,
    now: datetime | None = None,
) -> DashboardOut:
    """Главная одним ответом (правила — в docstring модуля)."""
    moment = now or utcnow()
    zone = user_zone(user.tz)
    today = local_today(zone, moment)
    core = DashboardCoreOut.model_validate_json(await cached_core_json(db, redis, user, period))
    settings = await get_app_settings(db)
    open_bets, open_count, open_stake = await _open_bets(db, user)
    return DashboardOut(
        **core.model_dump(),
        currency=settings.currency,
        tz=zone.key,
        today=today,
        greeting=greeting(moment, zone),
        thresholds=analytics.THRESHOLDS,
        bank=await bank_out(db, user),
        open_bets=open_bets,
        open_count=open_count,
        open_stake=open_stake,
        my_matches=await my_matches(db, user, zone, today, moment),
        admin=await admin_attention(db, moment) if user.role == "admin" else None,
    )
