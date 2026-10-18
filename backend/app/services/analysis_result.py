"""Итог анализа: прогнозы по 6 исходам каждого матча и по всем введенным новым рынкам
(Р28), экспресс, сумма ставки и вид результата для экрана (analyses.result).

Новые рынки (фора ±2.5, тоталы сетов, форы и тоталы геймов) — «для сравнения»: прогноз
пишется (калибровка, CLV, общий счетчик), строка видна в таблице, своей ставкой их
поставить можно, но в экспресс и варианты они идут, только если администратор перевел
семейство в экспресс (app_settings.express_markets). Рынки по сетам считаются из трех
чисел матча (app/ml/sets.py, market_prob): поправка Claude переносится кодом. У рынков по
геймам вероятности модели пока нет (волна 3): p_base, p_claude, p_final — пусто.

Числа считает код (app/ml/strategy.py): Р22 — поправка Claude ограничена ±10 п.п. от
p_base и согласована; исходы с кэфами участника; экспресс по правилам v3 с лимитом
просадки; сумма — от банка по учету, а если журнал пуст или банк из ввода другой — от
банка из ввода (с предупреждением). В predictions.p_claude — исходное число Claude.

Варианты ставки (Р29, app/ml/variants.py) — в result.variants: экспресс стратегии,
ординары «надежнее» и «лучший валуй», «Экспресс из лучших». У анализов до Р29 их нет в
сохраненном итоге: они пересчитываются при чтении (stored_variants) из строк таблицы
рынков (итоговая вероятность, кэф, id прогноза), флагов Claude и формы — это дешево, без
Claude и без записи; сумма — от банка сейчас.
"""

import math
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, replace
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.schemas import MatchAssessmentOut
from app.core.errors import AppError
from app.db.models import (
    AgentRun,
    Analysis,
    Dossier,
    MatchAssessment,
    PlayerNews,
    Prediction,
)
from app.ml.market import devig_pair
from app.ml.markets import is_market, opposite
from app.ml.model_versions import active_model_id
from app.ml.sets import MARKET_MINUS, MARKETS, Probs3, market_prob
from app.ml.strategy import (
    STATUS_COMPARE,
    BankSignals,
    DrawdownLevel,
    Final3,
    Leg,
    StakeCalc,
    StrategyParams,
    apply_claude,
    candidates,
    express_codes,
    leg_issues,
    legs_for_match,
    make_leg,
    market_meta,
    parlay_issues,
    parlay_total,
    pick_parlay,
    selection_blocks,
    stake,
    value,
    value_tier,
)
from app.ml.variants import Variant, pick_variants
from app.services.analysis_input import ConfirmedEvent, PlayerFacts, player_facts, short_odds
from app.services.app_settings import express_families, get_app_settings
from app.services.bank import BankState, bank_state, drawdown_level
from app.services.dossier import FEATURE_SET
from app.services.strategy_versions import lessons_of_prompt

ODDS_STEP = Decimal("0.001")
P_DIGITS = 6
# Проверки экспресса для экрана: ключ analysis.rules.<имя> (app/ml/strategy.py, issues)
RULE_KEYS = (
    "legs_count",
    "same_match",
    "odds_low",
    "odds_high",
    "p_low",
    "no_value",
    "cover_p_low",
    "triple_p",
    "triple_odds",
    "total_low",
    "total_high",
    "form",
    "injury",
    "fatigue",
    "drawdown_legs",
    "drawdown_odds",
)
# Уверенность анализа по матчу, при которой вариант получает предупреждение
LOW_CONFIDENCE = ("low", "medium")


@dataclass(frozen=True)
class ComposeInput:
    """Что нужно итогу: анализ, события, чекпойнты матчей, параметры стратегии, банк и
    букмекер из ввода, предупреждения шагов. is_eval — прогноз проверочного прогона
    (команда acceptance-runs): predictions.is_eval, в статистику участника не попадает."""

    analysis: Analysis
    events: Sequence[ConfirmedEvent]
    entries: dict[int, dict[str, Any]]
    params: StrategyParams
    bank_input: Decimal | None
    bookmaker: str | None
    warnings: Sequence[dict[str, Any]]
    is_eval: bool = False


@dataclass
class _Match:
    event: ConfirmedEvent
    out: MatchAssessmentOut
    content: dict[str, Any]
    final: Final3
    fair: dict[tuple[str, int], float]
    legs: list[Leg]
    form: tuple[list[str], list[str]]
    entry: dict[str, Any]


def clip01(value_: float) -> float:
    return min(1.0, max(0.0, float(value_)))


def fair_probs(odds: Mapping[str, Sequence[Decimal | None]]) -> dict[tuple[str, int], float]:
    """Рынок без маржи по парам обратных исходов (app/ml/markets.py, opposite): П1/П2,
    взаимные форы (П1(−1.5) с П2(+1.5), Ф1(−3.5) с Ф2(+3.5)), больше и меньше тотала."""
    fair: dict[tuple[str, int], float] = {}
    for market, pair in odds.items():
        if not is_market(market):
            continue
        for selection, price in enumerate(pair, start=1):
            other_market, other = opposite(market, selection)
            other_pair = odds.get(other_market) or [None, None]
            against = other_pair[other - 1] if len(other_pair) >= other else None
            if price is None or against is None or price <= 1 or against <= 1:
                continue
            fair[(market, selection)] = devig_pair(price, against)
    return fair


def entered_outcomes(odds: Mapping[str, Sequence[Decimal | None]]) -> list[tuple[str, int]]:
    """Исходы прогнозов матча: шесть прежних всегда, новые рынки — только исходы с кэфом
    из ввода (у форы строка формы дает два рынка: Ф1(−3.5) и Ф2(+3.5))."""
    found = [(market, selection) for market in MARKETS for selection in (1, 2)]
    for market, pair in odds.items():
        if market in MARKETS or not is_market(market):
            continue
        found.extend(
            (market, selection)
            for selection, price in enumerate(pair, start=1)
            if price is not None
        )
    return found


def with_express_markets(
    params: StrategyParams, events: Iterable[ConfirmedEvent], promoted: Iterable[str]
) -> StrategyParams:
    """Параметры отбора с рынками новых семейств, которые администратор перевел в экспресс
    (только для этого анализа, в версию стратегии не пишутся)."""
    codes = [market for event in events for market in event.odds]
    found = express_codes(codes, params, promoted)
    return params if found == params.markets else replace(params, markets=found)


def outcome_prob(probs: Probs3, best_of: int, market: str, selection: int) -> float | None:
    """Вероятность исхода по трем числам матча: прежние рынки — из Probs3, новые — из
    модели сетов; рынок по геймам — None."""
    if market in MARKETS:
        return probs.markets()[(market, selection)]
    return market_prob(probs, best_of, market, selection)


def form_of(content: dict[str, Any], key: str) -> list[str]:
    """Исходы последних матчей игрока из досье (W/L), от последнего."""
    block = (content.get(key) or {}).get("form") or {}
    return [str(item.get("r")) for item in block.get("m") or [] if item.get("r") in ("W", "L")]


def _better(left: Any, right: Any, *, high: bool = True) -> str | None:
    if not isinstance(left, int | float) or not isinstance(right, int | float) or left == right:
        return None
    return "left" if (left > right) == high else "right"


def _share(won: Any, lost: Any) -> float | None:
    if not isinstance(won, int) or not isinstance(lost, int) or won + lost == 0:
        return None
    return round(won / (won + lost), 2)


def comparison(
    content: dict[str, Any], ranks: tuple[int | None, int | None]
) -> list[dict[str, Any]]:
    """Строки «Сравнение игроков» из досье и места по Эло."""
    p1, p2 = content.get("p1") or {}, content.get("p2") or {}
    rows: list[dict[str, Any]] = []

    def row(
        key: str,
        left: Any,
        right: Any,
        sub: tuple[Any, Any] = (None, None),
        better: str | None = None,
    ) -> None:
        rows.append(
            {
                "key": key,
                "left": left,
                "right": right,
                "sub_left": sub[0],
                "sub_right": sub[1],
                "better": better,
            }
        )

    row("elo_rank", ranks[0], ranks[1], better=_better(ranks[0], ranks[1], high=False))
    e1, e2 = p1.get("elo") or {}, p2.get("elo") or {}
    row(
        "elo_surface",
        e1.get("surf"),
        e2.get("surf"),
        (e1.get("n_surf"), e2.get("n_surf")),
        _better(e1.get("surf"), e2.get("surf")),
    )
    f1, f2 = p1.get("form") or {}, p2.get("form") or {}
    row(
        "form10",
        f"{f1.get('w10', 0)}-{f1.get('l10', 0)}",
        f"{f2.get('w10', 0)}-{f2.get('l10', 0)}",
        (f"{f1.get('w5', 0)}-{f1.get('l5', 0)}", f"{f2.get('w5', 0)}-{f2.get('l5', 0)}"),
        _better(f1.get("w10"), f2.get("w10")),
    )
    l1, l2 = p1.get("load") or {}, p2.get("load") or {}
    row("load14", l1.get("m14"), l2.get("m14"), (l1.get("rest"), l2.get("rest")))
    s1, s2 = p1.get("serve") or {}, p2.get("serve") or {}
    for key, name in (
        ("serve_first", "first_won"),
        ("serve_second", "second_won"),
        ("return", "return_won"),
    ):
        row(key, s1.get(name), s2.get(name), better=_better(s1.get(name), s2.get(name)))
    share1 = _share(s1.get("tb_w"), s1.get("tb_l"))
    share2 = _share(s2.get("tb_w"), s2.get("tb_l"))
    row(
        "tiebreaks",
        f"{s1.get('tb_w') or 0}-{s1.get('tb_l') or 0}",
        f"{s2.get('tb_w') or 0}-{s2.get('tb_l') or 0}",
        (share1, share2),
        _better(share1, share2),
    )
    h2h = content.get("h2h") or {}
    surf = h2h.get("surf") or {}
    row(
        "h2h",
        h2h.get("p1", 0),
        h2h.get("p2", 0),
        (surf.get("p1", 0), surf.get("p2", 0)),
        _better(h2h.get("p1"), h2h.get("p2")),
    )
    return rows


def rule_checks(
    legs: Sequence[Leg], params: StrategyParams, level: DrawdownLevel | None
) -> list[dict[str, Any]]:
    """Проверка экспресса по правилам v3 для экрана (ok — правило выполнено)."""
    issues = set(parlay_issues(legs, params, level))
    shown = [
        key
        for key in RULE_KEYS
        if (key not in ("triple_p", "triple_odds") or len(legs) == 3)
        and (key not in ("drawdown_legs", "drawdown_odds") or level is not None)
        and (key != "cover_p_low" or any(leg.market == MARKET_MINUS for leg in legs))
    ]
    return [
        {"ok": key not in issues, "key": f"analysis.rules.{key}", "params": {}} for key in shown
    ]


async def run_costs(db: AsyncSession, analysis: Analysis) -> dict[str, Any]:
    """Строка расходов: токены, доля входа из кэша, поиски, стоимость, длительность."""
    row = (
        await db.execute(
            select(
                func.coalesce(func.sum(AgentRun.input_tokens), 0),
                func.coalesce(func.sum(AgentRun.cache_write_tokens), 0),
                func.coalesce(func.sum(AgentRun.cache_read_tokens), 0),
                func.coalesce(func.sum(AgentRun.output_tokens), 0),
                func.coalesce(func.sum(AgentRun.web_searches), 0),
                func.coalesce(func.sum(AgentRun.cost_usd), 0),
                func.coalesce(func.sum(AgentRun.duration_ms), 0),
            ).where(AgentRun.analysis_id == analysis.id)
        )
    ).one()
    values: list[Any] = list(row)
    fresh, written, read, output, searches = (int(values[n] or 0) for n in range(5))
    models = sorted(
        set(await db.scalars(select(AgentRun.model).where(AgentRun.analysis_id == analysis.id)))
    )
    prompt = fresh + written + read
    return {
        "tokens": prompt + output,
        "cache_share": round(read / prompt, 3) if prompt else 0.0,
        "searches": searches,
        "cost_usd": float(Decimal(values[5] or 0)),
        "estimate_usd": float(analysis.estimate_usd) if analysis.estimate_usd is not None else None,
        "duration_ms": int(values[6] or 0),
        "models": models,
    }


def _bank(
    state: BankState, bank_input: Decimal | None
) -> tuple[Decimal, str, dict[str, Any] | None]:
    """Банк для суммы: учет; журнал пуст или банк из ввода другой — банк из ввода."""
    if bank_input is not None and (state.empty or bank_input != state.balance):
        warning = None
        if not state.empty:
            warning = {
                "key": "analysis.warnings.bank_differs",
                "params": {"input": str(bank_input), "ledger": str(state.balance)},
            }
        return bank_input, "input", warning
    if state.empty:
        return Decimal(0), "none", None
    return state.balance, "ledger", None


async def _load_match(
    db: AsyncSession, data: ComposeInput, event: ConfirmedEvent
) -> tuple[_Match, MatchAssessment, Dossier]:
    assert event.match_id is not None
    entry = data.entries[event.match_id]
    assessment = await db.get(MatchAssessment, entry["assessment_id"])
    dossier = await db.get(Dossier, entry["dossier_id"])
    if assessment is None or dossier is None:
        raise AppError(409, "analysis.match_missing", position=event.position)
    out = MatchAssessmentOut.model_validate(assessment.output)
    p_base = Probs3(**entry["p_base"])
    p_claude = Probs3(clip01(out.p1_win), clip01(out.p1_cover), clip01(out.p2_cover))
    final = apply_claude(p_base, p_claude, data.params)
    content = dossier.content
    form = (form_of(content, "p1"), form_of(content, "p2"))
    blocks = {
        1: selection_blocks([r == "W" for r in form[0][:5]], out.flags.p1, data.params),
        2: selection_blocks([r == "W" for r in form[1][:5]], out.flags.p2, data.params),
    }
    legs = legs_for_match(
        event.match_id, final.p_final, event.odds, data.params, blocks=blocks, best_of=event.best_of
    )
    item = _Match(event, out, content, final, fair_probs(event.odds), legs, form, entry)
    return item, assessment, dossier


def _predictions(
    data: ComposeInput,
    item: _Match,
    assessment: MatchAssessment,
    dossier: Dossier,
    ml_model: str | None,
    lessons: list[str],
) -> dict[tuple[str, int], Prediction]:
    """Прогнозы матча по 6 исходам и по введенным новым рынкам (только INSERT). У рынка по
    геймам вероятностей нет (пусто). lessons — коды уроков в system оценки (по ее версии
    промпта)."""
    event = item.event
    assert event.match_id is not None
    bookmaker = event.bookmaker or data.bookmaker
    rows: dict[tuple[str, int], Prediction] = {}
    for market, selection in entered_outcomes(event.odds):
        price = event.odds.get(market, [None, None])[selection - 1]
        p_base = outcome_prob(item.final.p_base, event.best_of, market, selection)
        p_claude = outcome_prob(item.final.p_claude, event.best_of, market, selection)
        p_final = outcome_prob(item.final.p_final, event.best_of, market, selection)
        rows[(market, selection)] = Prediction(
            user_id=data.analysis.user_id,
            analysis_id=data.analysis.id,
            match_id=event.match_id,
            market=market,
            selection=selection,
            as_of=dossier.as_of,
            dossier_id=dossier.id,
            features=item.entry.get("features") or {},
            feature_set=FEATURE_SET,
            strategy_version_id=data.analysis.strategy_version_id,
            ml_model_id=ml_model,
            llm_model=assessment.model,
            effort=assessment.effort,
            prompt_version=assessment.prompt_version,
            lessons_applied=list(lessons),
            p_base=clip01(p_base) if p_base is not None else None,
            p_claude=clip01(p_claude) if p_claude is not None else None,
            p_final=clip01(p_final) if p_final is not None else None,
            q_market_at_pred=item.fair.get((market, selection)),
            odds_at_pred=price,
            bookmaker_at_pred=(bookmaker or None) if price is not None else None,
            value_at_pred=value(p_final, price)
            if price is not None and p_final is not None
            else None,
            rationale=item.out.explanation,
            agent_run_id=assessment.agent_run_id,
            is_eval=data.is_eval,
        )
    return rows


def _market_rows(
    item: _Match,
    predictions: dict[tuple[str, int], Prediction],
    in_express: set[tuple[int, str, int]],
    params: StrategyParams,
    level: DrawdownLevel | None,
    promoted: Iterable[str] = (),
) -> list[dict[str, Any]]:
    event = item.event
    legs = {(leg.market, leg.selection): leg for leg in item.legs}
    rows: list[dict[str, Any]] = []
    match_key = int(event.match_id or 0)
    families = tuple(promoted)
    # «В матче есть исход выгоднее» — только если другой исход этого матча в экспрессе;
    # иначе исход по правилам подходит, но в экспресс не вошел (экспресса нет или он
    # собран из других матчей)
    match_in_express = any(key[0] == match_key for key in in_express)
    for market, selection in predictions:
        prediction = predictions[(market, selection)]
        price = event.odds.get(market, [None, None])[selection - 1]
        p_final = prediction.p_final
        gain = value(p_final, price) if price is not None and p_final is not None else None
        key = (match_key, market, selection)
        leg = legs.get((market, selection))
        meta = market_meta(market, families)
        note: str | None = None
        if price is None:
            note = "analysis.leg.no_odds"
        elif not meta["has_model"]:
            note = "analysis.leg.no_model"
        elif meta["status"] == STATUS_COMPARE:
            note = "analysis.leg.market_compare"
        elif leg is not None and key not in in_express:
            issues = leg_issues(leg, params, level)
            if issues:
                note = f"analysis.leg.{issues[0]}"
            elif match_in_express:
                note = "analysis.leg.not_best"
            else:
                note = "analysis.leg.not_picked"
        fair = item.fair.get((market, selection))
        rows.append(
            {
                "market": market,
                "selection": selection,
                "prediction_id": prediction.id,
                "p_base": _rounded(prediction.p_base),
                "p_claude": _rounded(prediction.p_claude),
                "p_final": _rounded(p_final),
                "q_market": round(fair, P_DIGITS) if fair is not None else None,
                "odds": str(short_odds(price)) if price is not None else None,
                "value": round(gain, P_DIGITS) if gain is not None else None,
                "tier": value_tier(gain) if gain is not None else "none",
                "in_express": key in in_express,
                "note_key": note,
                "p_push": 0.0,
                **meta,
            }
        )
    return rows


def _rounded(p: float | None) -> float | None:
    return round(p, P_DIGITS) if p is not None else None


def _side(player_id: int, facts: dict[int, PlayerFacts]) -> dict[str, Any]:
    found = facts.get(player_id)
    return {
        "id": player_id,
        "name": found.name if found else "",
        "country": found.country if found else None,
        "elo_rank": found.elo_rank if found else None,
    }


def _match_view(
    item: _Match,
    markets: list[dict[str, Any]],
    facts: dict[int, PlayerFacts],
    sources: dict[str, PlayerNews],
) -> dict[str, Any]:
    event = item.event
    out = item.out
    factors = []
    for factor in out.factors:
        news = sources.get(factor.ref)
        factors.append(
            {
                "player": factor.player,
                "effect": factor.effect,
                "text": factor.text,
                "ref": factor.ref,
                "source_url": news.source_url if news else None,
                "source_name": news.source_name if news else None,
                "date": news.published_at.date().isoformat() if news else None,
            }
        )
    rank1 = facts[event.player1_id].elo_rank if event.player1_id in facts else None
    rank2 = facts[event.player2_id].elo_rank if event.player2_id in facts else None
    return {
        "match_id": event.match_id,
        "player1": _side(event.player1_id, facts),
        "player2": _side(event.player2_id, facts),
        "tournament": (item.content.get("match") or {}).get("tour") or event.tournament_name,
        "surface": event.surface,
        "round": event.round,
        "best_of": event.best_of,
        "data_as_of": item.content.get("data_to"),
        "confidence": out.confidence,
        "explanation": out.explanation,
        "divergence_note": out.divergence_note,
        "highlight": item.final.needs_note,
        "flags": {"p1": list(out.flags.p1), "p2": list(out.flags.p2)},
        "factors": factors,
        "comparison": comparison(item.content, (rank1, rank2)),
        "form": {"p1": item.form[0][:10], "p2": item.form[1][:10]},
        "markets": markets,
        "reused_from": item.entry.get("reused_from"),
        "news_state": item.entry.get("news"),
    }


def _total_text(total: Decimal) -> str:
    return str(total.quantize(ODDS_STEP, rounding=ROUND_HALF_UP))


def _stake_view(calc: StakeCalc, bank_source: str, total_text: str) -> dict[str, Any]:
    """Сумма и шаги расчета для экрана (StakeOut)."""
    return {
        "amount": str(calc.amount) if calc.amount is not None else None,
        "currency": calc.currency,
        "bank": str(calc.bank),
        "bank_source": bank_source,
        "total_odds": total_text,
        "pct": str(calc.pct),
        "steps": [
            {"kind": step.kind, "pct": str(step.pct), "params": step.params} for step in calc.steps
        ],
        "reason": calc.reason,
        "drawdown_level": calc.drawdown_level.key if calc.drawdown_level else None,
    }


def _legs_view(
    legs: Sequence[Leg], prediction_ids: Mapping[tuple[int, str, int], int]
) -> list[dict[str, Any]]:
    return [
        {
            "prediction_id": prediction_ids[(leg.match_id, leg.market, leg.selection)],
            "match_id": leg.match_id,
            "market": leg.market,
            "selection": leg.selection,
            "p": round(leg.p, P_DIGITS),
            "odds": str(short_odds(leg.odds)),
        }
        for leg in legs
    ]


def _express_view(
    express: Sequence[Leg],
    prediction_ids: Mapping[tuple[int, str, int], int],
    *,
    bank: Decimal,
    bank_source: str,
    state: BankState,
    params: StrategyParams,
    level: DrawdownLevel | None,
    currency: str,
) -> dict[str, Any]:
    total = parlay_total(express)
    calc = stake(bank, total, list(express), params, state.signals(), currency)
    p_express = math.prod(leg.p for leg in express)
    total_text = _total_text(total)
    return {
        "legs": _legs_view(express, prediction_ids),
        "total_odds": total_text,
        "p_express": round(p_express, P_DIGITS),
        "ev": round(p_express * float(total) - 1.0, P_DIGITS),
        "stake": _stake_view(calc, bank_source, total_text),
        "rules": rule_checks(express, params, level),
    }


@dataclass(frozen=True)
class VariantContext:
    """Что нужно сумме и предупреждениям вариантов: банк и откуда он, сигналы
    адаптаций, параметры стратегии, валюта, id прогнозов исходов и уверенность анализа
    по матчам."""

    bank: Decimal
    bank_source: str
    signals: BankSignals
    params: StrategyParams
    currency: str
    prediction_ids: Mapping[tuple[int, str, int], int]
    confidence: Mapping[int, str]


def variant_view(variant: Variant, ctx: VariantContext) -> dict[str, Any]:
    """Вариант ставки для экрана (VariantOut): ноги, кэф, вероятность, валуй, сумма по
    своей таблице (валуй ниже нуля — суммы нет), почему выбран и предупреждения."""
    total = variant.total_odds
    total_text = _total_text(total)
    gain = variant.value
    calc = stake(
        ctx.bank,
        total,
        list(variant.legs),
        ctx.params,
        ctx.signals,
        ctx.currency,
        mode=variant.stake_mode,
        ev=None if variant.code == "strategy" else gain,
    )
    warnings: list[str] = []
    if variant.no_value:
        warnings.append("no_value")
    if any(ctx.confidence.get(leg.match_id) in LOW_CONFIDENCE for leg in variant.legs):
        warnings.append("low_confidence")
    return {
        "code": variant.code,
        "kind": variant.kind,
        "also": list(variant.also),
        "legs": _legs_view(variant.legs, ctx.prediction_ids),
        "total_odds": total_text,
        "p": round(variant.p, P_DIGITS),
        "value": round(gain, P_DIGITS),
        "value_tier": value_tier(gain),
        "stake": str(calc.amount) if calc.amount is not None else None,
        "stake_calc": _stake_view(calc, ctx.bank_source, total_text),
        "why_key": f"analysis.variants.why.{variant.why}",
        "why_params": dict(variant.why_params),
        "outside_strategy": variant.outside_strategy,
        "issues": list(variant.issues),
        "warnings": warnings,
    }


def variants_view(
    legs: Sequence[Leg],
    matches: Sequence[int],
    express: Sequence[Leg] | None,
    level: DrawdownLevel | None,
    ctx: VariantContext,
) -> list[dict[str, Any]]:
    """Варианты ставки по исходам анализа (app/ml/variants.py) в виде для экрана."""
    found = pick_variants(legs, matches, express, ctx.params, level)
    return [variant_view(item, ctx) for item in found]


def stored_variants(
    result: Mapping[str, Any],
    *,
    params: StrategyParams,
    state: BankState,
    bank_input: Decimal | None,
    currency: str,
    promoted: Iterable[str] = (),
) -> list[dict[str, Any]]:
    """Варианты анализа до Р29 по сохраненному итогу: исходы — строки таблицы рынков с
    кэфом (итоговая вероятность, кэф, id прогноза), причины blocks — по флагам Claude и
    форме из итога, экспресс — сохраненный. Сумма — от банка сейчас. promoted — семейства
    новых рынков в экспрессе (app_settings.express_markets)."""
    codes = [
        str(row["market"])
        for match in result.get("matches") or []
        for row in match.get("markets") or []
    ]
    found = express_codes(codes, params, promoted)
    if found != params.markets:
        params = replace(params, markets=found)
    legs: list[Leg] = []
    matches: list[int] = []
    prediction_ids: dict[tuple[int, str, int], int] = {}
    confidence: dict[int, str] = {}
    for match in result.get("matches") or []:
        match_id = int(match["match_id"])
        matches.append(match_id)
        confidence[match_id] = str(match.get("confidence") or "")
        flags = match.get("flags") or {}
        form = match.get("form") or {}
        blocks = {
            side: selection_blocks(
                [item == "W" for item in (form.get(f"p{side}") or [])[:5]],
                flags.get(f"p{side}") or [],
                params,
            )
            for side in (1, 2)
        }
        for row in match.get("markets") or []:
            market, selection = str(row["market"]), int(row["selection"])
            if row.get("prediction_id") is not None:
                prediction_ids[(match_id, market, selection)] = int(row["prediction_id"])
            odds = row.get("odds")
            if (
                odds is None
                or market not in params.markets
                or row.get("prediction_id") is None
                or row.get("p_final") is None
            ):
                continue
            price = Decimal(str(odds))
            if price <= 1:
                continue
            legs.append(
                make_leg(
                    match_id,
                    market,
                    selection,
                    float(row["p_final"]),
                    price,
                    blocks=blocks[selection],
                )
            )
    by_key = {(leg.match_id, leg.market, leg.selection): leg for leg in legs}
    express_legs = ((result.get("express") or {}).get("legs")) or []
    # Экспресс был — значит, он есть, даже если ногу не найти в таблице (рынок убрали из
    # params.markets, у строки нет кэфа): нога берется из сохраненного экспресса, иначе
    # рядом с карточкой настоящего экспресса появился бы «Экспресс из лучших»
    express: list[Leg] = []
    for item in express_legs:
        key = (int(item["match_id"]), str(item["market"]), int(item["selection"]))
        leg = by_key.get(key)
        if leg is None and item.get("odds") is not None and item.get("p") is not None:
            price = Decimal(str(item["odds"]))
            if price > 1:
                leg = make_leg(*key, float(item["p"]), price)
        if leg is None:
            express = []
            break
        if item.get("prediction_id") is not None:
            prediction_ids.setdefault(key, int(item["prediction_id"]))
        express.append(leg)
    bank, bank_source, _ = _bank(state, bank_input)
    ctx = VariantContext(
        bank=bank,
        bank_source=bank_source,
        signals=state.signals(),
        params=params,
        currency=currency,
        prediction_ids=prediction_ids,
        confidence=confidence,
    )
    variants = variants_view(legs, matches, express or None, drawdown_level(state, params), ctx)
    if express_legs and not express:
        # Ногу экспресса не восстановить совсем: варианта strategy нет, но и «Экспресса из
        # лучших» рядом с настоящим экспрессом быть не должно
        variants = [item for item in variants if item["code"] != "best_express"]
    return variants


async def compose(db: AsyncSession, data: ComposeInput) -> dict[str, Any]:
    """Пишет прогнозы (flush) и возвращает итог для analyses.result. Статус и commit —
    за вызывающим (одна транзакция с прогнозами)."""
    settings = await get_app_settings(db)
    promoted = express_families(settings)
    # Рынки новых семейств, переведенные администратором в экспресс, — в отбор этого анализа
    data = replace(data, params=with_express_markets(data.params, data.events, promoted))
    params = data.params
    state = await bank_state(db, data.analysis.user_id)
    level = drawdown_level(state, params)
    ml_model = await active_model_id(db)
    lessons_by_prompt: dict[str, list[str]] = {}
    facts = await player_facts(
        db, {pid for event in data.events for pid in (event.player1_id, event.player2_id)}
    )
    items: list[_Match] = []
    predictions: dict[tuple[int, str, int], Prediction] = {}
    by_match: dict[int, dict[tuple[str, int], Prediction]] = {}
    for event in data.events:
        item, assessment, dossier = await _load_match(db, data, event)
        prompt_id = assessment.prompt_version
        if prompt_id not in lessons_by_prompt:
            lessons_by_prompt[prompt_id] = await lessons_of_prompt(db, prompt_id)
        # Версия базовой модели — та, что дала p_base досье (снимок начала анализа, m1)
        features = item.entry.get("features") or {}
        match_model = str(features.get("ml_model_id") or "") or ml_model
        rows = _predictions(
            data, item, assessment, dossier, match_model, lessons_by_prompt[prompt_id]
        )
        db.add_all(rows.values())
        assert event.match_id is not None
        by_match[event.match_id] = rows
        predictions |= {(event.match_id, *key): row for key, row in rows.items()}
        items.append(item)
    await db.flush()
    all_legs = [leg for item in items for leg in item.legs]
    express = pick_parlay(all_legs, params, drawdown=level)
    in_express = {(leg.match_id, leg.market, leg.selection) for leg in express or ()}
    warnings = [dict(item) for item in data.warnings]
    bank, bank_source, bank_warning = _bank(state, data.bank_input)
    if bank_warning is not None:
        warnings.append(bank_warning)
    express_out: dict[str, Any] | None = None
    no_express: str | None = None
    prediction_ids = {key: row.id for key, row in predictions.items()}
    if express is not None:
        express_out = _express_view(
            express,
            prediction_ids,
            bank=bank,
            bank_source=bank_source,
            state=state,
            params=params,
            level=level,
            currency=settings.currency,
        )
    else:
        pool = candidates(all_legs, params, drawdown=level)
        no_express = "analysis.express.too_few" if len(pool) < 2 else "analysis.express.total_range"
    refs = [factor.ref for item in items for factor in item.out.factors]
    news_ids = [int(ref.split(":", 1)[1]) for ref in refs if ref.startswith("news:")]
    sources = (
        {
            f"news:{row.id}": row
            for row in await db.scalars(select(PlayerNews).where(PlayerNews.id.in_(news_ids)))
        }
        if news_ids
        else {}
    )
    matches = [
        _match_view(
            item,
            _market_rows(
                item, by_match[int(item.event.match_id or 0)], in_express, params, level, promoted
            ),
            facts,
            sources,
        )
        for item in items
    ]
    ctx = VariantContext(
        bank=bank,
        bank_source=bank_source,
        signals=state.signals(),
        params=params,
        currency=settings.currency,
        prediction_ids=prediction_ids,
        confidence={int(item.event.match_id or 0): item.out.confidence for item in items},
    )
    variants = variants_view(
        all_legs, [int(item.event.match_id or 0) for item in items], express, level, ctx
    )
    return {
        "matches": matches,
        "express": express_out,
        "no_express_key": no_express,
        "warnings": warnings,
        "costs": await run_costs(db, data.analysis),
        "variants": variants,
    }
