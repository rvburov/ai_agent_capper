"""Проверка кандидата своих правил суммы ставки на своих ставках (этап 5, В5 Р25; макет
profile.js «Предложить изменение»): код, без ИИ и бесплатно.

Для каждого рассчитанного экспресса стратегии участника (выигрыш, проигрыш, возврат; Р29:
ординары и свои ставки в сравнение версий не входят) сумма считается заново по старым и
по новым правилам (app/ml/strategy.stake) на банке и сигналах адаптаций в момент ставки:
журнал банка до этого момента, ставки, которые тогда еще не были рассчитаны, — «в игре»;
винрейт — по всем ставкам участника, рассчитанным до этого момента, как в рабочем расчете.
Ноги — кэфы участника и итоговая вероятность прогноза. Прибыль — при тех же исходах:
прибыль ставки на единицу суммы × сумма. Итог: сколько ставок, у скольких сумма
изменилась бы, суммы и прибыль до и после, сколько раз сработало бы каждое правило
адаптации новой версии.
"""

from collections.abc import Sequence
from dataclasses import replace
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, BetLeg, Prediction, User
from app.ml.games import PUSH_KEY
from app.ml.strategy import StrategyParams, make_leg, stake
from app.services.app_settings import get_app_settings
from app.services.bank import LedgerEntry, bank_from_entries, ledger_entries, user_zone
from app.services.sessions import utcnow

ZERO = Decimal(0)
CENT = Decimal("0.01")
# Шаги расчета суммы, которые делают правила адаптации (StakeStep.kind)
ADAPT_STEPS = {
    "week_win": "week_win",
    "growth": "up15",
    "week_loss": "week_loss",
}


def _entries_at(entries: Sequence[LedgerEntry], moment: datetime) -> list[LedgerEntry]:
    """Журнал на момент: записи до него; ставка, рассчитанная позже, — еще открыта.
    Пополнение в тот же момент, что и ставка, входит: у нового участника начальный банк
    записывается одной транзакцией с первой ставкой (без этого она выпала бы из проверки),
    а записи ставок того же момента (и ее собственное списание) — нет."""
    found: list[LedgerEntry] = []
    for entry in entries:
        if entry.at > moment or (entry.at == moment and entry.bet_id is not None):
            continue
        if entry.bet_id is not None and (
            entry.bet_settled_at is None or entry.bet_settled_at >= moment
        ):
            entry = replace(entry, bet_status="open", bet_settled_at=None)
        found.append(entry)
    return found


async def check_rules(
    db: AsyncSession,
    user_id: int,
    old: StrategyParams,
    new: StrategyParams,
    *,
    since: date | None = None,
) -> dict[str, Any]:
    """Пересчет сумм своих рассчитанных ставок по старым и новым правилам."""
    settings = await get_app_settings(db)
    currency = settings.currency
    query = (
        select(Bet)
        .where(
            Bet.user_id == user_id,
            Bet.source == "app",
            # Сравнение правил — только по экспрессам стратегии (Р29): ординары и свои
            # ставки считаются по другой таблице или без рекомендации
            Bet.kind == "strategy",
            Bet.status.in_(("won", "lost", "void")),
        )
        .order_by(Bet.placed_at, Bet.id)
    )
    bets = list(await db.scalars(query))
    zone = user_zone(await db.scalar(select(User.tz).where(User.id == user_id)))
    if since is not None:
        bets = [bet for bet in bets if bet.placed_at.astimezone(zone).date() >= since]
    legs_by_bet: dict[int, list[tuple[BetLeg, float | None, float]]] = {}
    if bets:
        rows = await db.execute(
            select(BetLeg, Prediction.p_final, Prediction.features[PUSH_KEY]["final"].astext)
            .outerjoin(Prediction, Prediction.id == BetLeg.prediction_id)
            .where(BetLeg.bet_id.in_([bet.id for bet in bets]))
            .order_by(BetLeg.id)
        )
        for leg, p_final, push in rows:
            # Вероятность возврата целой линии по геймам (Р28): валуй ноги с возвратом
            legs_by_bet.setdefault(leg.bet_id, []).append((leg, p_final, float(push or 0.0)))
    entries = await ledger_entries(db, user_id)
    # Винрейт правила «Рост банка» — как в рабочем расчете суммы (bank_state): по всем
    # рассчитанным ставкам участника любого вида и источника, а не только по проверяемым
    # экспрессам стратегии и не только с дня since
    rows_settled = await db.execute(
        select(Bet.settled_at, Bet.status).where(
            Bet.user_id == user_id, Bet.status.in_(("won", "lost"))
        )
    )
    settled = [(when, status) for when, status in rows_settled if when is not None]
    stake_old = stake_new = profit_old = profit_new = ZERO
    checked = changed = 0
    first: datetime | None = None
    triggered = {key: 0 for key in ("dd10", "dd20", "up15", "week_loss", "week_win")}
    for bet in bets:
        legs = [
            make_leg(
                leg.match_id,
                leg.market,
                leg.selection,
                float(p_final) if p_final is not None else float(1 / leg.odds_taken),
                leg.odds_taken,
                push=push if p_final is not None else 0.0,
            )
            for leg, p_final, push in legs_by_bet.get(bet.id, [])
        ]
        if not legs:
            continue
        won = sum(1 for when, status in settled if when < bet.placed_at and status == "won")
        lost = sum(1 for when, status in settled if when < bet.placed_at and status == "lost")
        state = bank_from_entries(
            _entries_at(entries, bet.placed_at),
            currency=currency,
            won=won,
            lost=lost,
            now=bet.placed_at,
        )
        if state.balance <= 0:
            continue
        signals = state.signals()
        before = stake(state.balance, bet.total_odds, legs, old, signals, currency)
        after = stake(state.balance, bet.total_odds, legs, new, signals, currency)
        amount_old = before.amount or ZERO
        amount_new = after.amount or ZERO
        checked += 1
        first = first or bet.placed_at
        if amount_old != amount_new:
            changed += 1
        per_unit = (bet.profit or ZERO) / bet.stake if bet.stake > 0 else ZERO
        stake_old += amount_old
        stake_new += amount_new
        profit_old += (amount_old * per_unit).quantize(CENT)
        profit_new += (amount_new * per_unit).quantize(CENT)
        for step in after.steps:
            key = ADAPT_STEPS.get(step.kind)
            if key is not None:
                triggered[key] += 1
        if after.drawdown_level is not None:
            triggered[after.drawdown_level.key] += 1
    change = float(stake_new / stake_old - 1) if stake_old > 0 else None
    # С какого дня проверка: заданный день, иначе день первой проверенной ставки (по поясу
    # участника); ставок нет — сегодня (проверять было не на чем)
    start = since or (first or utcnow()).astimezone(zone).date()
    return {
        "since": start.isoformat(),
        "bets": checked,
        "changed": changed,
        "stake_old": str(stake_old.quantize(CENT)),
        "stake_new": str(stake_new.quantize(CENT)),
        "stake_change": change,
        "profit_old": str(profit_old.quantize(CENT)),
        "profit_new": str(profit_new.quantize(CENT)),
        "currency": currency,
        "triggered": triggered,
    }
