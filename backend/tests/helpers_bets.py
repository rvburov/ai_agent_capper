"""Помощники тестов ставок этапа 4: ставка прямо в БД (без анализа Claude) со своими
матчами, турнирами, прогнозами и подтвержденным вводом анализа, журнал банка.

BetMaker создает каждой ноге свой матч (игроки «Игрок <n>»), турнир архива или без турнира
(матч из ввода участника), прогноз с вероятностями и событие в analyses.confirmed с
покрытием, форматом и названием турнира из ввода. Ставка пишется как после POST /api/bets:
статус open и запись stake в журнале (и deposit, если журнал пуст и задан deposit).
"""

from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

import httpx2
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    Analysis,
    BankrollLedger,
    Bet,
    BetLeg,
    Match,
    Player,
    Prediction,
    Tournament,
    User,
)
from tests.support import MadeUser

D = Decimal


@dataclass
class LegSpec:
    """Нога ставки. tournament None — матч из ввода участника без турнира; surface и
    best_of — у турнира; confirmed_* — в подтвержденном вводе анализа (Т29); q_market —
    рынок при прогнозе без маржи, is_eval — прогноз проверочного прогона."""

    odds: str = "1.80"
    market: str = "ML"
    selection: int = 1
    best_of: int | None = 3
    surface: str | None = "hard"
    tournament: str | None = "Shanghai"
    tournament_source: str = "sackmann"
    confirmed_surface: str | None = "hard"
    confirmed_best_of: int = 3
    confirmed_tournament: str | None = None
    p_final: float | None = 0.62
    p_base: float | None = 0.60
    p_claude: float | None = 0.64
    q_market: float | None = None
    is_eval: bool = False
    names: tuple[str, str] | None = None
    names_ru: tuple[str | None, str | None] = (None, None)
    match_day: date | None = None


@dataclass
class BetMaker:
    db: AsyncSession
    counter: int = 0
    tournaments: dict[tuple[str, str], int] = field(default_factory=dict)

    def _next(self) -> int:
        self.counter += 1
        return self.counter

    async def player(self, name: str, name_ru: str | None = None) -> Player:
        player = Player(name=name, name_ru=name_ru)
        self.db.add(player)
        await self.db.flush()
        return player

    async def _tournament(self, spec: LegSpec) -> int | None:
        if spec.tournament is None:
            return None
        key = (spec.tournament, spec.tournament_source)
        if key not in self.tournaments:
            row = Tournament(
                name=spec.tournament,
                surface=spec.surface,
                best_of=spec.best_of,
                category="masters",
                start_date=date(2026, 10, 1),
                source=spec.tournament_source,
                source_ref=f"t-{self._next()}",
            )
            self.db.add(row)
            await self.db.flush()
            self.tournaments[key] = row.id
        return self.tournaments[key]

    async def _match(self, spec: LegSpec) -> Match:
        n = self._next()
        names = spec.names or (f"Player {n}A", f"Player {n}B")
        first = await self.player(names[0], spec.names_ru[0])
        second = await self.player(names[1], spec.names_ru[1])
        tournament_id = await self._tournament(spec)
        match = Match(
            tournament_id=tournament_id,
            round=f"R{n}",
            player1_id=first.id,
            player2_id=second.id,
            best_of=spec.best_of if tournament_id is not None else None,
            match_date=spec.match_day,
            source="user",
            source_ref=f"user:test:{n}",
        )
        self.db.add(match)
        await self.db.flush()
        return match

    async def bet(
        self,
        user: MadeUser | User,
        legs: list[LegSpec],
        *,
        stake: str = "100",
        placed_at: datetime | None = None,
        bookmaker: str = "Fonbet",
        source: str = "app",
        deposit: str | None = "10000",
        total_odds: str | None = None,
        kind: str | None = None,
    ) -> Bet:
        """Открытая ставка с журналом, как после «Сохранить ставку». commit. kind не задан
        — как в миграции 0012: у бота legacy, одно событие — single, иначе strategy."""
        row = user.user if isinstance(user, MadeUser) else user
        when = placed_at or datetime.now(UTC) - timedelta(hours=1)
        matches = [await self._match(spec) for spec in legs]
        events: list[dict[str, Any]] = [
            {
                "position": index,
                "player1_id": match.player1_id,
                "player2_id": match.player2_id,
                "match_id": match.id,
                "tournament_id": match.tournament_id,
                "tournament_name": spec.confirmed_tournament,
                "surface": spec.confirmed_surface,
                "best_of": spec.confirmed_best_of,
                "round": match.round,
                "odds": {},
                "bookmaker": bookmaker,
                "line_no": None,
            }
            for index, (spec, match) in enumerate(zip(legs, matches, strict=True), start=1)
        ]
        analysis = Analysis(
            user_id=row.id,
            input_text="",
            input_kind="form",
            status="done",
            confirmed={"bank": None, "bookmaker": bookmaker, "events": events},
            decision="bet",
        )
        self.db.add(analysis)
        await self.db.flush()
        product = D(1)
        for spec in legs:
            product *= D(spec.odds)
        total = D(total_odds) if total_odds else product.quantize(D("0.001"))
        bet = Bet(
            user_id=row.id,
            analysis_id=analysis.id,
            placed_at=when,
            bookmaker=bookmaker,
            stake=D(stake),
            currency="RUB",
            total_odds=total,
            status="open",
            source=source,
            source_ref=f"ref-{self._next():06d}",
            kind=kind
            or ("legacy" if source == "legacy" else "single" if len(legs) == 1 else "strategy"),
        )
        self.db.add(bet)
        await self.db.flush()
        for spec, match in zip(legs, matches, strict=True):
            prediction = Prediction(
                user_id=row.id,
                analysis_id=analysis.id,
                match_id=match.id,
                market=spec.market,
                selection=spec.selection,
                as_of=when,
                p_base=spec.p_base,
                p_claude=spec.p_claude,
                p_final=spec.p_final,
                q_market_at_pred=spec.q_market,
                is_eval=spec.is_eval,
            )
            self.db.add(prediction)
            await self.db.flush()
            self.db.add(
                BetLeg(
                    bet_id=bet.id,
                    match_id=match.id,
                    market=spec.market,
                    selection=spec.selection,
                    odds_taken=D(spec.odds),
                    prediction_id=prediction.id,
                )
            )
        empty = not await self.db.scalar(
            select(func.count()).where(BankrollLedger.user_id == row.id)
        )
        if empty and deposit is not None:
            self.db.add(
                BankrollLedger(
                    user_id=row.id,
                    at=when - timedelta(minutes=1),
                    kind="deposit",
                    amount=D(deposit),
                    currency="RUB",
                )
            )
        self.db.add(
            BankrollLedger(
                user_id=row.id,
                at=when,
                kind="stake",
                amount=-D(stake),
                currency="RUB",
                bet_id=bet.id,
            )
        )
        await self.db.commit()
        return bet


async def leg_ids(db: AsyncSession, bet_id: int) -> list[int]:
    rows = await db.scalars(select(BetLeg.id).where(BetLeg.bet_id == bet_id).order_by(BetLeg.id))
    return list(rows)


async def ledger_rows(db: AsyncSession, user_id: int) -> list[BankrollLedger]:
    rows = await db.scalars(
        select(BankrollLedger)
        .where(BankrollLedger.user_id == user_id)
        .order_by(BankrollLedger.id)
        .execution_options(populate_existing=True)
    )
    return list(rows)


async def get_bet(client: httpx2.AsyncClient, bet_id: int) -> dict[str, Any]:
    response = await client.get(f"/api/bets/{bet_id}")
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def settle_body(bet: dict[str, Any], *results: str, **extra: Any) -> dict[str, Any]:
    """Тело PUT …/result: исходы ног по порядку и версия ставки из карточки."""
    legs = [
        {"leg_id": leg["id"], "result": result}
        for leg, result in zip(bet["legs"], results, strict=True)
    ]
    return {"expected_updated_at": bet["updated_at"], "legs": legs, **extra}


async def settle(
    client: httpx2.AsyncClient, bet_id: int, *results: str, **leg_extra: Any
) -> httpx2.Response:
    """Расчет ставки по свежей карточке; leg_extra — поля первой ноги (score, closing)."""
    bet = await get_bet(client, bet_id)
    body = settle_body(bet, *results)
    body["legs"][0].update(leg_extra)
    return await client.put(f"/api/bets/{bet_id}/result", json=body)


async def reverse(client: httpx2.AsyncClient, bet_id: int) -> httpx2.Response:
    bet = await get_bet(client, bet_id)
    return await client.post(
        f"/api/bets/{bet_id}/reverse", json={"expected_updated_at": bet["updated_at"]}
    )
