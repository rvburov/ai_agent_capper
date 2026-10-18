"""Вид анализа для API и прогресса: черновик разбора, шаги, итоги, ошибка, результат.

Черновик собирается заново из сырого ответа разбора (analyses.parsed) при каждом чтении:
поиск игроков и турниров дешевый, а база могла пополниться. Шаги хода анализа лежат в
analyses.checkpoint (их пишет воркер), результат — в analyses.result.
"""

from collections.abc import Sequence
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import AgentRun, Analysis, Bet, BetLeg, Player, StrategyVersion
from app.ml.markets import MODEL_FAILED, MODEL_NONE, MODEL_OK, NEW_FAMILIES, extra_into, extra_lines
from app.ml.strategy import STATUS_COMPARE, STATUS_EXPRESS, STATUS_SUSPENDED, market_meta
from app.schemas.analyses import (
    AccessOut,
    AnalysisOut,
    BetBrief,
    BetLegBrief,
    ConfirmedEventOut,
    ConfirmedPlayer,
    DisputedOut,
    DraftEventOut,
    DraftOut,
    ErrorInfoOut,
    ExtraOddsOut,
    OddsPairsOut,
    PlayerBrief,
    PlayerCandidate,
    PlayerPick,
    RestartOut,
    ResultOut,
    StepOut,
    TextKey,
    TotalsOut,
    TournamentOut,
    UnknownLineOut,
)
from app.services.ai_access import Access
from app.services.analysis_input import (
    DEFAULT_BEST_OF,
    MAX_EVENTS,
    Confirmed,
    Pick,
    PlayerFacts,
    money,
    odds_problems,
    parsed_input,
    parsed_lines,
    parsed_odds,
    player_facts,
    resolve_player,
    resolve_tournament,
    short_odds,
)
from app.services.analysis_result import stored_variants
from app.services.app_settings import express_families, get_app_settings
from app.services.bank import bank_state
from app.services.strategy_versions import params_of

ZERO = Decimal(0)


def odds_out(odds: dict[str, list[Decimal | None]]) -> OddsPairsOut:
    def pair(market: str) -> list[Decimal | None]:
        return [short_odds(value) if value is not None else None for value in odds[market]]

    return OddsPairsOut.model_validate(
        {"ML": pair("ML"), "HCP_-1.5": pair("HCP_-1.5"), "HCP_+1.5": pair("HCP_+1.5")}
    )


def extra_out(odds: dict[str, list[Decimal | None]]) -> list[ExtraOddsOut]:
    """Строки «Другие рынки» (новые рынки Р28) по карте кэфов, у фор — линия игрока 1."""
    return [
        ExtraOddsOut(
            market=row.family,  # type: ignore[arg-type]
            line=float(row.line),
            o1=short_odds(row.o1) if row.o1 is not None else None,
            o2=short_odds(row.o2) if row.o2 is not None else None,
        )
        for row in extra_lines(odds)
    ]


def _brief(facts: PlayerFacts | None, player_id: int, name: str) -> PlayerBrief:
    return PlayerBrief(
        id=player_id,
        name=facts.name if facts else name,
        name_ru=facts.name_ru if facts else None,
        country=facts.country if facts else None,
        elo_rank=facts.elo_rank if facts else None,
        last_match=facts.last_match if facts else None,
    )


def _pick_out(pick: Pick, facts: dict[int, PlayerFacts]) -> PlayerPick:
    best = pick.best
    return PlayerPick(
        status=pick.status,  # type: ignore[arg-type]
        raw=pick.raw,
        player=_brief(facts.get(best.player_id), best.player_id, best.name)
        if best is not None and pick.status != "missing"
        else None,
        score=round(best.score, 3) if best is not None else None,
        candidates=[
            PlayerCandidate(
                id=item.player_id, name=item.name, country=item.country, score=item.score
            )
            for item in pick.candidates
        ],
    )


def _pick_warnings(position: int, number: int, pick: Pick) -> list[TextKey]:
    params: dict[str, Any] = {"position": position, "player": number, "raw": pick.raw}
    if pick.status == "check" and pick.best is not None:
        params |= {"name": pick.best.name, "score": round(pick.best.score * 100)}
        return [TextKey(key="analysis.draft.player_check", params=params)]
    if pick.status == "missing":
        return [TextKey(key="analysis.draft.player_missing", params=params)]
    return []


async def parse_cost(db: AsyncSession, analysis_id: int) -> Decimal:
    value = await db.scalar(
        select(func.sum(AgentRun.cost_usd)).where(
            AgentRun.analysis_id == analysis_id, AgentRun.kind == "parse"
        )
    )
    return Decimal(value or 0)


async def build_draft(db: AsyncSession, analysis: Analysis, *, today: date) -> DraftOut:
    """Черновик для экрана «Проверка»: что понял разбор, найденные игроки и турниры,
    кэфы и предупреждения. У формы — пустой черновик с банком по учету."""
    settings = await get_app_settings(db)
    state = await bank_state(db, analysis.user_id)
    ledger_bank = None if state.empty else state.balance
    parsed = parsed_input(analysis.parsed)
    warnings: list[TextKey] = []
    bank: Decimal | None = None
    note: str | None = None
    if parsed is not None:
        amount = money(parsed.bank.amount)
        currency = parsed.bank.currency
        if amount is not None and currency is not None and currency != settings.currency:
            note = "analysis.draft.bank_currency"
        elif amount is not None:
            bank = amount
            if ledger_bank is not None and amount != ledger_bank:
                note = "analysis.draft.bank_differs"
    picks: list[tuple[Pick, Pick]] = []
    for event in parsed.events if parsed else []:
        picks.append(
            (
                await resolve_player(db, event.player1.raw, event.player1.latin),
                await resolve_player(db, event.player2.raw, event.player2.latin),
            )
        )
    ids = {pick.best.player_id for pair in picks for pick in pair if pick.best is not None}
    facts = await player_facts(db, ids, today=today)
    events: list[DraftEventOut] = []
    unknown = [
        UnknownLineOut(line_no=line.line_no, text=line.text)
        for line in (parsed.unknown_lines if parsed else [])
    ]
    for position, (event, (pick1, pick2)) in enumerate(
        zip(parsed.events if parsed else [], picks, strict=True), start=1
    ):
        tournament = await resolve_tournament(db, event.tournament, today=today)
        best_of = (tournament.best_of if tournament and tournament.best_of else None) or (
            DEFAULT_BEST_OF
        )
        odds = parsed_odds(event.odds)
        lines = parsed_lines(event.odds)
        for market, pair in lines.base.items():
            current = odds.setdefault(market, [None, None])
            odds[market] = [
                old if old is not None else new for old, new in zip(current, pair, strict=True)
            ]
        extra_into(odds, lines.extra)
        unknown.extend(
            UnknownLineOut(line_no=line_no, text=text, reason_key=reason)
            for line_no, text, reason in lines.unknown
        )
        disputed = []
        for item in lines.disputed:
            hint = item.hint(odds["ML"])
            disputed.append(
                DisputedOut(
                    line=float(item.line),
                    o1=short_odds(item.o1) if item.o1 is not None else None,
                    o2=short_odds(item.o2) if item.o2 is not None else None,
                    hint=TextKey(
                        key=f"analysis.draft.hcp_hint.{hint[0]}",
                        params={"odds": str(short_odds(hint[1])), "ml": str(short_odds(hint[2]))},
                    )
                    if hint is not None
                    else None,
                    sets_ok=item.sets_ok(best_of),
                )
            )
        event_warnings = _pick_warnings(position, 1, pick1) + _pick_warnings(position, 2, pick2)
        if (
            pick1.best is not None
            and pick2.best is not None
            and pick1.best.player_id == pick2.best.player_id
        ):
            event_warnings.append(
                TextKey(key="analysis.draft.same_players", params={"position": position})
            )
        if any(value is None for value in odds["ML"]):
            event_warnings.append(
                TextKey(key="analysis.draft.ml_missing", params={"position": position})
            )
        for market, value in odds_problems(odds):
            event_warnings.append(
                TextKey(
                    key="analysis.draft.odds_range",
                    params={"position": position, "market": market, "odds": str(value)},
                )
            )
        surface = event.surface or (tournament.surface if tournament else None)
        if surface is None:
            event_warnings.append(
                TextKey(key="analysis.draft.surface_missing", params={"position": position})
            )
        events.append(
            DraftEventOut(
                position=position,
                line_no=event.line_no,
                raw1=event.player1.raw,
                raw2=event.player2.raw,
                player1=_pick_out(pick1, facts),
                player2=_pick_out(pick2, facts),
                tournament=TournamentOut(
                    id=tournament.id,
                    name=tournament.name,
                    category=tournament.category,
                    surface=tournament.surface,  # type: ignore[arg-type]
                    best_of=tournament.best_of,
                )
                if tournament is not None
                else None,
                surface=surface,  # type: ignore[arg-type]
                best_of=best_of,
                round=(event.round or "").strip()[:16],
                odds=odds_out(odds),
                extra=extra_out(odds),
                disputed=disputed,
                bookmaker=event.bookmaker or (parsed.bookmaker if parsed else None),
                warnings=event_warnings,
            )
        )
    if parsed is not None and not parsed.events:
        warnings.append(TextKey(key="analysis.draft.no_events"))
    if len(events) > MAX_EVENTS:
        warnings.append(TextKey(key="analysis.draft.too_many", params={"max": MAX_EVENTS}))
    return DraftOut(
        bank=bank,
        currency=settings.currency,
        ledger_bank=ledger_bank,
        bank_note_key=note,
        bookmaker=parsed.bookmaker if parsed else analysis.bookmaker,
        events=events,
        unknown_lines=sorted(unknown, key=lambda line: line.line_no),
        parse_cost_usd=await parse_cost(db, analysis.id),
        warnings=warnings,
    )


# --- шаги и итоги ---


def steps_of(analysis: Analysis) -> list[StepOut]:
    raw = (analysis.checkpoint or {}).get("steps") or []
    return [StepOut.model_validate(item) for item in raw]


def totals_of(steps: Sequence[StepOut]) -> TotalsOut:
    finished = sum(1 for step in steps if step.state in ("done", "skipped"))
    return TotalsOut(
        elapsed_ms=sum(step.elapsed_ms for step in steps),
        tokens=sum(step.tokens for step in steps),
        cost_usd=sum((step.cost_usd for step in steps), ZERO),
        step=finished,
        steps=len(steps),
    )


def error_of(analysis: Analysis) -> ErrorInfoOut | None:
    if analysis.status != "failed" or not analysis.error_code:
        return None
    return ErrorInfoOut(
        code=analysis.error_code,
        params=dict(analysis.error_params or {}),
        step=analysis.failed_step,
    )


def make_event(
    analysis_id: int,
    status: str,
    steps: Sequence[StepOut],
    kind: str,
    *,
    step: StepOut | None = None,
    with_steps: bool = False,
    error: ErrorInfoOut | None = None,
) -> dict[str, Any]:
    """Событие прогресса (раздел 5.2 брифа, ProgressEventOut) в виде JSON."""
    return {
        "type": kind,
        "analysis_id": analysis_id,
        "status": status,
        "step": step.model_dump(mode="json") if step is not None else None,
        "steps": [item.model_dump(mode="json") for item in steps] if with_steps else None,
        "totals": totals_of(steps).model_dump(mode="json"),
        "error": error.model_dump(mode="json") if error is not None else None,
    }


def progress_event(analysis: Analysis, kind: str, *, with_steps: bool = False) -> dict[str, Any]:
    """Событие по состоянию анализа в базе (снимок для SSE, отмена)."""
    return make_event(
        analysis.id,
        analysis.status,
        steps_of(analysis),
        kind,
        with_steps=with_steps,
        error=error_of(analysis),
    )


def access_out(access: Access) -> AccessOut:
    return AccessOut(
        allowed=access.allowed,
        reason_code=access.reason,
        reason_params=dict(access.reason_params),
        mode=access.mode,  # type: ignore[arg-type]
        monthly_usd=access.monthly_limit_usd,
        spent_usd=access.spent_month_usd,
        left_usd=access.left_month_usd,
        daily=access.daily_limit,
        today=access.analyses_today,
        per_analysis_usd=access.cap_usd,
        own_key_last4=access.key_last4 if access.key_source == "own" else None,
    )


async def confirmed_events(db: AsyncSession, analysis: Analysis) -> list[ConfirmedEventOut]:
    """Подтвержденные события запуска с именами игроков (одним запросом, без Эло)."""
    if not analysis.confirmed:
        return []
    events = Confirmed.from_json(analysis.confirmed).events
    ids = {pid for event in events for pid in (event.player1_id, event.player2_id)}
    players = {
        row.id: ConfirmedPlayer(id=row.id, name=row.name, name_ru=row.name_ru, country=row.country)
        for row in await db.scalars(select(Player).where(Player.id.in_(ids)))
    }

    def player(pid: int) -> ConfirmedPlayer:
        return players.get(pid) or ConfirmedPlayer(id=pid, name="", name_ru=None, country=None)

    return [
        ConfirmedEventOut(
            position=event.position,
            match_id=event.match_id,
            player1=player(event.player1_id),
            player2=player(event.player2_id),
            tournament_id=event.tournament_id,
            tournament_name=event.tournament_name,
            surface=event.surface,
            best_of=event.best_of,
            round=event.round,
            odds=odds_out(event.odds),
            extra=extra_out(event.odds),
            bookmaker=event.bookmaker,
        )
        for event in events
    ]


async def bet_briefs(db: AsyncSession, analysis_id: int) -> list[BetBrief]:
    """Ставки по анализу по порядку (Р29: их может быть несколько — экспресс, ординар,
    своя): сумма, вид и кэфы, которые участник сохранил."""
    bets = list(
        await db.scalars(select(Bet).where(Bet.analysis_id == analysis_id).order_by(Bet.id))
    )
    if not bets:
        return []
    legs: dict[int, list[BetLeg]] = {}
    for leg in await db.scalars(
        select(BetLeg).where(BetLeg.bet_id.in_([bet.id for bet in bets])).order_by(BetLeg.id)
    ):
        legs.setdefault(leg.bet_id, []).append(leg)
    return [
        BetBrief(
            id=bet.id,
            kind=bet.kind,  # type: ignore[arg-type]
            stake=bet.stake,
            currency=bet.currency,
            total_odds=short_odds(bet.total_odds),
            bookmaker=bet.bookmaker,
            legs=[
                BetLegBrief(
                    prediction_id=leg.prediction_id,
                    match_id=leg.match_id,
                    market=leg.market,
                    selection=leg.selection,
                    odds_taken=short_odds(leg.odds_taken),
                )
                for leg in legs.get(bet.id, [])
            ],
        )
        for bet in bets
    ]


def _row_meta(row: dict[str, Any], promoted: Sequence[str]) -> dict[str, Any]:
    """Поля строки рынка из кода (market_meta). Статус «на проверке» — по списку сейчас.
    У новых семейств (Р28) — статус на момент анализа, если он сохранен: экспресс и
    варианты анализа собраны по нему, и строка не должна писать «идет в экспресс», если
    рынок в экспресс этого анализа не мог попасть (или наоборот)."""
    meta = market_meta(str(row.get("market")), promoted)
    stored = row.get("status")
    if (
        meta["family"] in NEW_FAMILIES
        and meta["status"] != STATUS_SUSPENDED
        and stored in (STATUS_COMPARE, STATUS_EXPRESS)
    ):
        meta["status"] = stored
    # Вероятность модели — как при анализе: у строк рынков по геймам до волны 3 ее нет,
    # хотя модель принята позже (пересчета старых анализов нет)
    if "has_model" in row:
        meta["has_model"] = bool(row["has_model"])
        state = row.get("model_state")
        if state in (MODEL_OK, MODEL_FAILED, MODEL_NONE):
            meta["model_state"] = state
        elif not meta["has_model"]:
            meta["model_state"] = MODEL_NONE
    return meta


async def result_of(
    db: AsyncSession, analysis: Analysis, version: StrategyVersion | None
) -> ResultOut | None:
    """Итог анализа; у анализа до Р29 варианты ставки пересчитываются из сохраненного
    итога (analysis_result.stored_variants), в базу ничего не пишется."""
    if not analysis.result:
        return None
    data = dict(analysis.result)
    settings = await get_app_settings(db)
    promoted = express_families(settings)
    # Семейство и линия — из кода рынка (и у старых анализов); статус — _row_meta
    data["matches"] = [
        {
            **match,
            "markets": [
                {"p_push": 0.0, **row, **_row_meta(row, promoted)}
                for row in match.get("markets") or []
            ],
        }
        for match in data.get("matches") or []
    ]
    if "variants" not in data:
        data["variants"] = stored_variants(
            data,
            params=params_of(version),
            state=await bank_state(db, analysis.user_id),
            bank_input=analysis.bank_input,
            currency=settings.currency,
            promoted=promoted,
        )
    return ResultOut.model_validate(data)


async def analysis_out(
    db: AsyncSession,
    analysis: Analysis,
    *,
    today: date | None = None,
    restart: RestartOut | None = None,
) -> AnalysisOut:
    """Анализ целиком для экрана. restart — можно ли перезапустить остановленный анализ
    (analyses.restart_state)."""
    day = today or datetime.now(UTC).date()
    draft = None
    if analysis.status == "needs_confirmation" or (
        analysis.status == "failed" and analysis.failed_step == "parse"
    ):
        draft = await build_draft(db, analysis, today=day)
    steps = steps_of(analysis)
    bets = await bet_briefs(db, analysis.id)
    bet = bets[0] if bets else None
    version = (
        await db.get(StrategyVersion, analysis.strategy_version_id)
        if analysis.strategy_version_id is not None
        else None
    )
    version_code = version.code if version is not None else None
    result = await result_of(db, analysis, version)
    return AnalysisOut(
        id=analysis.id,
        status=analysis.status,  # type: ignore[arg-type]
        created_at=analysis.created_at,
        started_at=analysis.started_at,
        finished_at=analysis.finished_at,
        input_kind=analysis.input_kind,  # type: ignore[arg-type]
        input_text=analysis.input_text,
        attempt=analysis.attempt,
        draft=draft,
        events=await confirmed_events(db, analysis),
        steps=steps,
        totals=totals_of(steps),
        error=error_of(analysis),
        result=result,
        decision=analysis.decision,  # type: ignore[arg-type]
        bet_id=bet.id if bet is not None else None,
        bet=bet,
        bets=bets,
        key_source=analysis.key_source,  # type: ignore[arg-type]
        estimate_usd=analysis.estimate_usd,
        cost_usd=analysis.cost_usd,
        bank=analysis.bank_input,
        bookmaker=analysis.bookmaker,
        strategy_version=version_code,
        restart=restart,
    )
