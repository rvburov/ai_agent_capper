"""Рынки и их статус (Р28): общий счетчик «для сравнения», перевод семейства в экспресс,
уведомление администраторам о пройденном пороге.

Событие рынка — исход с кэфом из ввода анализа (predictions.odds_at_pred) и известным
итогом матча (архив: доигран, исход по счету определен; снятие и отказ не считаются —
там исход выбирает участник, В16). Счетчик общий по всем участникам (решение владельца):
модель общая, и 150 событий набираются быстрее. Повтор анализа того же матча тем же
участником — одно событие (последний прогноз). Проверочные прогоны (is_eval) не считаются.

- ROI — как ординары на равную сумму по кэфам из ввода: выигрыш — кэф − 1, проигрыш — −1;
  возврат (ровно на целой линии) событием не считается, как в «Аналитике»; 95% ДИ —
  бутстрэп.
- CLV — по закрытию, которое участники внесли в ставки по этим прогнозам (кэф / закрытие −
  1; в архиве кэфов новых рынков нет); 95% ДИ — бутстрэп; clv_n — событий с закрытием.
- Порог: событий ≥ NEED, из них с закрытием ≥ CLV_NEED и нижняя граница ДИ среднего CLV
  выше нуля; только у семейств с вероятностью модели (has_model; семейство, модель
  которого не прошла проверку на истории, — FAILED_FAMILIES — перевести нельзя). Тогда
  администраторам уходит уведомление market_ready (одно на семейство,
  app_settings.markets_notified), а перевести семейство в экспресс можно кнопкой
  администратора (set_express): это общая настройка
  app_settings.express_markets, в журнале администратора — settings_change. Пороги отбора
  для новых рынков (p от 65%, кэф 1.13–1.80) пока общие (решение владельца — вернуться,
  когда первый рынок пройдет порог).
- Приватность: счетчик общий, поэтому ROI семейства отдается от PRIVATE_MIN событий, а CLV
  — от PRIVATE_MIN значений с закрытием; до того — только количество (по одному-двум
  значениям восстанавливается чужая ставка).
- Кэш: числа семейств (события, ROI, CLV) считаются по всем прогнозам с итогом матча и
  бутстрэпом, поэтому GET /markets берет их из Redis (CACHE_TTL, ключ с префиксом
  приложения). Статус, promoted, ready и can_promote считаются по настройкам при каждом
  чтении, так что перевод в экспресс виден сразу. Счетчик может отстать от расчета ставок
  не больше чем на CACHE_TTL — для статистики на сотни событий это неважно. Решения
  (перевод в экспресс, уведомление о пороге) всегда идут по свежему расчету.
"""

import json
from collections import defaultdict
from dataclasses import asdict, dataclass
from decimal import Decimal

import structlog
from redis.asyncio import Redis
from redis.exceptions import RedisError
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import distinct_on
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.redis import redis_key
from app.db.models import BetLeg, Match, Prediction, Tournament, User
from app.ml.markets import (
    FAMILIES,
    MODEL_FAILED,
    NEW_FAMILIES,
    family_of,
    has_model,
    is_market,
    market_spec,
    model_state,
)
from app.ml.metrics import bootstrap_mean_ci
from app.ml.sets import RESULT_LOSS, RESULT_WIN, match_leg_outcome
from app.ml.strategy import STATUS_COMPARE, STATUS_EXPRESS, STATUS_SUSPENDED, SUSPENDED_MARKETS
from app.schemas.markets import MarketFamilyOut, MarketsOut
from app.services import notifications
from app.services.app_settings import express_families, get_app_settings

log = structlog.get_logger(__name__)

# Порог перевода в экспресс: событий не меньше NEED (Р28: 150–200) и CLV выше нуля
NEED = 150
NEED_MAX = 200
# ...и CLV хотя бы по CLV_NEED событиям с закрытием: ДИ по 2–4 значениям ничего не доказывает
CLV_NEED = 50
# Меньше стольких значений ROI и CLV семейства не показываются (счетчик общий, Р28)
PRIVATE_MIN = 10
# Кэш чисел семейств в Redis (docstring модуля); версия — в ключе, при смене формата
CACHE_TTL = 600
CACHE_KEY = ("markets", "stats", 1)
# Бутстрэп ДИ (как в аналитике; меньше повторов — счетчик пересчитывается часто)
BOOTSTRAP = 2000
SEED = 20261018
# Куда ведет уведомление о пороге: блок «Рынки» в «Аналитике»
READY_LINK = "/analytics#markets"


@dataclass
class _Family:
    returns: list[float]
    clvs: list[float]


@dataclass
class _Numbers:
    """Числа семейства для счетчика: события, ROI и CLV с 95% ДИ, событий с закрытием."""

    events: int = 0
    roi: float | None = None
    roi_low: float | None = None
    roi_high: float | None = None
    clv: float | None = None
    clv_low: float | None = None
    clv_high: float | None = None
    clv_n: int = 0


async def _events(db: AsyncSession) -> dict[str, _Family]:
    """События рынков по семействам: доход ординара на равную сумму и CLV (если внесено
    закрытие)."""
    clv = (
        select(BetLeg.prediction_id, func.avg(BetLeg.clv).label("clv"))
        .where(BetLeg.prediction_id.is_not(None), BetLeg.clv.is_not(None))
        .group_by(BetLeg.prediction_id)
        .subquery()
    )
    person = func.coalesce(Prediction.user_id, -Prediction.id)
    rows = await db.execute(
        select(
            Prediction.market,
            Prediction.selection,
            Prediction.odds_at_pred,
            Match.status,
            Match.winner_id,
            Match.player1_id,
            Match.score,
            func.coalesce(Match.best_of, Tournament.best_of),
            clv.c.clv,
        )
        .ext(distinct_on(person, Prediction.match_id, Prediction.market, Prediction.selection))
        .join(Match, Match.id == Prediction.match_id)
        .outerjoin(Tournament, Tournament.id == Match.tournament_id)
        .outerjoin(clv, clv.c.prediction_id == Prediction.id)
        .where(
            Prediction.is_eval.is_(False),
            Prediction.analysis_id.is_not(None),
            Prediction.odds_at_pred.is_not(None),
            Match.status == "finished",
            Match.winner_id.is_not(None),
        )
        .order_by(
            person,
            Prediction.match_id,
            Prediction.market,
            Prediction.selection,
            Prediction.created_at.desc(),
            Prediction.id.desc(),
        )
    )
    found: dict[str, _Family] = defaultdict(lambda: _Family([], []))
    for market, selection, odds, status, winner, player1, score, best_of, leg_clv in rows:
        if not is_market(market):
            continue
        outcome = match_leg_outcome(
            market,
            int(selection),
            status=status,
            winner_is_p1=winner == player1,
            score=score,
            best_of=best_of,
        )
        # Возврат (ровно на целой линии) событием не считается — как в «Аналитике»
        # (analytics._decided): ни в ROI, ни в счетчике
        if outcome.result not in (RESULT_WIN, RESULT_LOSS):
            continue
        price = Decimal(odds)
        gain = float(price - 1) if outcome.result == RESULT_WIN else -1.0
        item = found[family_of(market)]
        item.returns.append(gain)
        if leg_clv is not None:
            item.clvs.append(float(leg_clv))
    return found


def _status(family: str, promoted: tuple[str, ...]) -> tuple[str, list[str]]:
    """Статус семейства и его рынки на проверке."""
    suspended = sorted(code for code in SUSPENDED_MARKETS if family_of(code) == family)
    if suspended:
        return STATUS_SUSPENDED, suspended
    if family in NEW_FAMILIES and (family not in promoted or not has_model(family)):
        return STATUS_COMPARE, []
    return STATUS_EXPRESS, []


def _round(value: float | None) -> float | None:
    return round(value, 6) if value is not None else None


async def _numbers(db: AsyncSession) -> dict[str, _Numbers]:
    """Числа всех семейств по свежему расчету (события и бутстрэп ДИ)."""
    events = await _events(db)
    found: dict[str, _Numbers] = {}
    for family in FAMILIES:
        data = events.get(family) or _Family([], [])
        roi = (
            bootstrap_mean_ci(data.returns, n=BOOTSTRAP, seed=SEED, grouped=True)
            if data.returns
            else None
        )
        clv = bootstrap_mean_ci(data.clvs, n=BOOTSTRAP, seed=SEED) if len(data.clvs) >= 2 else None
        found[family] = _Numbers(
            events=len(data.returns),
            roi=_round(roi.value if roi else None),
            roi_low=_round(roi.low if roi else None),
            roi_high=_round(roi.high if roi else None),
            clv=_round(clv.value if clv else None),
            clv_low=_round(clv.low if clv else None),
            clv_high=_round(clv.high if clv else None),
            clv_n=len(data.clvs),
        )
    return found


async def _store(redis: Redis, numbers: dict[str, _Numbers]) -> None:
    payload = json.dumps({family: asdict(item) for family, item in numbers.items()})
    try:
        await redis.set(redis_key(*CACHE_KEY), payload, ex=CACHE_TTL)
    except RedisError as exc:
        log.warning("markets.cache_write_failed", error=str(exc))


async def _cached(db: AsyncSession, redis: Redis) -> dict[str, _Numbers]:
    """Числа семейств из кэша; нет в кэше (или Redis недоступен) — расчет и запись."""
    try:
        raw = await redis.get(redis_key(*CACHE_KEY))
    except RedisError as exc:
        log.warning("markets.cache_read_failed", error=str(exc))
        return await _numbers(db)
    if raw:
        try:
            data = json.loads(raw)
            return {family: _Numbers(**data[family]) for family in FAMILIES}
        except (ValueError, KeyError, TypeError):
            log.warning("markets.cache_bad")
    numbers = await _numbers(db)
    await _store(redis, numbers)
    return numbers


def _passed(item: _Numbers) -> bool:
    """Порог пройден: событий ≥ NEED, с закрытием ≥ CLV_NEED, нижняя граница ДИ CLV > 0."""
    return (
        item.events >= NEED
        and item.clv_n >= CLV_NEED
        and item.clv_low is not None
        and item.clv_low > 0
    )


async def market_stats(
    db: AsyncSession, redis: Redis | None = None, *, fresh: bool = False
) -> MarketsOut:
    """Статус и общий счетчик каждого семейства рынков (docstring модуля). redis — брать
    числа из кэша (GET /markets); fresh — посчитать заново и обновить кэш; без redis —
    всегда свежий расчет."""
    settings = await get_app_settings(db)
    promoted = express_families(settings)
    if redis is None:
        numbers = await _numbers(db)
    elif fresh:
        numbers = await _numbers(db)
        await _store(redis, numbers)
    else:
        numbers = await _cached(db, redis)
    items: list[MarketFamilyOut] = []
    for family in FAMILIES:
        data = numbers.get(family) or _Numbers()
        status, suspended = _status(family, promoted)
        ready = _passed(data) and status == STATUS_COMPARE and has_model(family)
        roi_shown = data.events >= PRIVATE_MIN
        clv_shown = data.clv_n >= PRIVATE_MIN
        items.append(
            MarketFamilyOut(
                family=family,  # type: ignore[arg-type]
                status=status,  # type: ignore[arg-type]
                suspended_markets=suspended,
                has_model=has_model(family),
                model_state=model_state(family),  # type: ignore[arg-type]
                promoted=family in promoted,
                events=data.events,
                roi=data.roi if roi_shown else None,
                roi_low=data.roi_low if roi_shown else None,
                roi_high=data.roi_high if roi_shown else None,
                clv=data.clv if clv_shown else None,
                clv_low=data.clv_low if clv_shown else None,
                clv_high=data.clv_high if clv_shown else None,
                clv_n=data.clv_n,
                ready=ready,
                can_promote=ready and family in NEW_FAMILIES,
            )
        )
    return MarketsOut(
        need=NEED, need_max=NEED_MAX, clv_need=CLV_NEED, private_min=PRIVATE_MIN, families=items
    )


async def set_express(
    db: AsyncSession,
    *,
    family: str,
    express: bool,
    actor: User,
    ip: str | None = None,
    redis: Redis | None = None,
) -> MarketsOut:
    """Перевод семейства нового рынка в экспресс (express=true) или обратно «для
    сравнения» (false). В экспресс — только новое семейство с вероятностью модели и
    пройденным порогом (422 admin.markets.not_new, admin.markets.no_model, 409
    admin.markets.not_ready). Смена — в журнале администратора (settings_change,
    field express_markets). Порог проверяется по свежему расчету, ответ обновляет кэш
    счетчика (redis). Делает commit."""
    from app.services.app_settings import locked_settings
    from app.services.audit import write_audit

    if family not in NEW_FAMILIES:
        raise AppError(422, "admin.markets.not_new", family=family)
    if express and model_state(family) == MODEL_FAILED:
        raise AppError(422, "admin.markets.model_failed", family=family)
    if express and not has_model(family):
        raise AppError(422, "admin.markets.no_model", family=family)
    if express:
        current = next(item for item in (await market_stats(db)).families if item.family == family)
        if not current.ready and not current.promoted:
            raise AppError(
                409, "admin.markets.not_ready", family=family, need=NEED, clv_need=CLV_NEED
            )
    row = await locked_settings(db)
    before = list(express_families(row))
    after = [item for item in NEW_FAMILIES if (item in before or item == family)]
    if not express:
        after = [item for item in after if item != family]
    if after != before:
        row.express_markets = after
        row.updated_by = actor.id
        await write_audit(
            db,
            action="settings_change",
            actor_id=actor.id,
            details={"field": "express_markets", "from": before, "to": after},
            ip=ip,
        )
        log.info("markets.express", actor_id=actor.id, family=family, express=express)
    await db.commit()
    return await market_stats(db, redis, fresh=True)


async def notify_ready(db: AsyncSession) -> list[str]:
    """Семейства «для сравнения», которые прошли порог: уведомление market_ready всем
    активным администраторам, одно на семейство (app_settings.markets_notified). Делает
    commit. Возвращает семейства, о которых ушло уведомление. Порог — по свежему
    расчету, без кэша."""
    from app.services.app_settings import locked_settings

    stats = await market_stats(db)
    row = await locked_settings(db)
    notified = set(row.markets_notified or ())
    fresh = [item for item in stats.families if item.ready and item.family not in notified]
    if not fresh:
        await db.commit()
        return []
    admins = list(
        await db.scalars(
            select(User.id).where(User.role == "admin", User.status == "active").order_by(User.id)
        )
    )
    for item in fresh:
        for admin_id in admins:
            await notifications.notify(
                db,
                user_id=admin_id,
                kind="market_ready",
                link=READY_LINK,
                family=item.family,
                market=market_name(item.family),
                events=item.events,
                clv_n=item.clv_n,
                clv=f"{(item.clv or 0) * 100:.1f}",
            )
    row.markets_notified = sorted(notified | {item.family for item in fresh})
    await db.commit()
    log.info("markets.ready", families=[item.family for item in fresh], admins=len(admins))
    return [item.family for item in fresh]


def market_name(family: str) -> str:
    """Название семейства рынка для текста уведомления (ключ markets.family.<семейство>)."""
    from app.core.i18n import t

    return t(f"markets.family.{family}")


def leg_family(market: str) -> str:
    """Семейство рынка ноги или прогноза (для фильтров и аналитики)."""
    return market_spec(market).family
