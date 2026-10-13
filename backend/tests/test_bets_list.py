"""Список «Ставок» (GET /api/bets): фильтры, поиск, курсор; карточка ставки; выгрузка CSV.
Только свои ставки (Р14)."""

import csv
import io
from datetime import UTC, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet
from tests.helpers_admin import Signed, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec, settle
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
async def member(make_client: ClientFactory, make_user: UserFactory, login: LoginFn) -> Signed:
    return await signed_in(make_client, make_user, login)


@pytest.fixture
def maker(db: AsyncSession) -> BetMaker:
    return BetMaker(db)


async def _ids(client: Any, **params: Any) -> list[int]:
    response = await client.get("/api/bets", params=params)
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


async def test_filters(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    now = datetime.now(UTC)
    hard = await maker.bet(
        member.user, [LegSpec(surface="hard")], placed_at=now - timedelta(days=1)
    )
    clay = await maker.bet(
        member.user,
        [LegSpec(market="HCP_-1.5", tournament="Roma", surface="clay")],
        placed_at=now - timedelta(days=10),
    )
    # Матч без турнира: покрытие — из ввода анализа (Т29)
    no_tour = await maker.bet(
        member.user,
        [LegSpec(tournament=None, confirmed_surface="grass")],
        placed_at=now - timedelta(days=40),
        bookmaker="Pari",
    )
    unknown = await maker.bet(
        member.user,
        [LegSpec(tournament=None, confirmed_surface=None)],
        placed_at=now - timedelta(days=100),
    )
    legacy = await maker.bet(
        member.user,
        [LegSpec(market="HCP_+1.5")],
        source="legacy",
        placed_at=now - timedelta(days=200),
    )
    await settle(member.client, hard.id, "win")
    client = member.client
    newest_first = [hard.id, clay.id, no_tour.id, unknown.id, legacy.id]
    assert await _ids(client) == newest_first
    assert await _ids(client, period="7d") == [hard.id]
    assert await _ids(client, period="30d") == [hard.id, clay.id]
    assert await _ids(client, period="90d") == [hard.id, clay.id, no_tour.id]
    assert await _ids(client, status="won") == [hard.id]
    assert await _ids(client, status="open") == [clay.id, no_tour.id, unknown.id, legacy.id]
    assert await _ids(client, market="HCP_-1.5") == [clay.id]
    assert await _ids(client, source="legacy") == [legacy.id]
    assert await _ids(client, source="app", period="30d") == [hard.id, clay.id]
    assert await _ids(client, surface="grass") == [no_tour.id]
    assert await _ids(client, surface=["hard", "clay"]) == [hard.id, clay.id, legacy.id]
    assert await _ids(client, surface="unknown") == [unknown.id]
    day = (now - timedelta(days=10)).astimezone(ZoneInfo(member.user.user.tz)).date()
    assert await _ids(client, **{"from": day.isoformat(), "to": day.isoformat()}) == [clay.id]
    assert await _ids(client, **{"from": day.isoformat()}) == [hard.id, clay.id]
    bad = await client.get("/api/bets", params={"from": "2026-10-10", "to": "2026-10-01"})
    assert bad.status_code == 422 and error_code(bad) == "bet.bad_dates"
    wrong = await client.get("/api/bets", params={"status": "maybe"})
    assert wrong.status_code == 422
    # Итоги — по тем же фильтрам
    summary = (await client.get("/api/bets/summary", params={"period": "30d"})).json()
    assert (summary["settled"], summary["won"], summary["open"]) == (1, 1, 1)


async def test_search(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    sinner = await maker.bet(
        member.user,
        [LegSpec(names=("Sinner J.", "Rune H."), names_ru=("Синнер", "Руне"))],
        bookmaker="Winline",
    )
    # Турнир из ввода участника: показывается и ищется по его собственному вводу, а
    # строка турнира (ее мог создать другой участник) — нет
    own = await maker.bet(
        member.user,
        [
            LegSpec(
                tournament="Кубок чужого участника",
                tournament_source="user",
                confirmed_tournament="Кубок Кремля",
                names=("Medvedev D.", "Khachanov K."),
                names_ru=("Медведев", "Хачанов"),
            )
        ],
    )
    archive = await maker.bet(member.user, [LegSpec(tournament="Shanghai Masters")])
    client = member.client
    assert await _ids(client, q="sinner") == [sinner.id]
    assert await _ids(client, q="синнер") == [sinner.id]
    # «е с двумя точками» в запросе — как «е»
    assert await _ids(client, q="Медв\u0451дев") == [own.id]
    assert await _ids(client, q="кремля") == [own.id]
    assert await _ids(client, q="чужого") == []
    assert await _ids(client, q="shanghai masters") == [archive.id]
    assert await _ids(client, q="winline") == [sinner.id]
    assert await _ids(client, q=f"№{archive.id}") == [archive.id]
    assert await _ids(client, q="100%") == []
    card = (await client.get(f"/api/bets/{own.id}")).json()
    assert card["legs"][0]["match"]["tournament"] == "Кубок Кремля"
    assert card["legs"][0]["match"]["player1"] == {
        "id": card["legs"][0]["match"]["player1"]["id"],
        "name": "Medvedev D.",
        "name_ru": "Медведев",
    }
    long = await client.get("/api/bets", params={"q": "x" * 101})
    assert long.status_code == 422


async def test_cursor_pages(member: Signed, maker: BetMaker, make_user: UserFactory) -> None:
    now = datetime.now(UTC)
    created = [
        (await maker.bet(member.user, [LegSpec()], placed_at=now - timedelta(minutes=n))).id
        for n in range(25)
    ]
    client = member.client
    first = (await client.get("/api/bets")).json()
    assert [item["id"] for item in first["items"]] == created[:20]
    assert first["next_before"] == created[19]
    second = (await client.get("/api/bets", params={"before": first["next_before"]})).json()
    assert [item["id"] for item in second["items"]] == created[20:]
    assert second["next_before"] is None
    small = (await client.get("/api/bets", params={"limit": 5})).json()
    assert len(small["items"]) == 5 and small["next_before"] == created[4]
    assert (await client.get("/api/bets", params={"limit": 101})).status_code == 422
    # Курсор — чужая или несуществующая ставка
    foreign = await maker.bet(await make_user(), [LegSpec()])
    for before in (foreign.id, 999999):
        response = await client.get("/api/bets", params={"before": before})
        assert response.status_code == 422 and error_code(response) == "bet.bad_cursor"


async def test_card_fields_and_privacy(
    member: Signed,
    maker: BetMaker,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    bet = await maker.bet(
        member.user,
        [LegSpec(odds="1.50", p_final=0.7, p_base=0.66, p_claude=0.72), LegSpec(odds="1.40")],
        stake="200",
    )
    card = (await member.client.get(f"/api/bets/{bet.id}")).json()
    assert card["status"] == "open" and card["source"] == "app"
    assert card["total_odds"] == "2.10" and card["payout"] == "420.00"
    assert card["effective_odds"] is None and card["profit"] is None and card["verdict"] is None
    leg = card["legs"][0]
    assert (leg["p_final"], leg["p_base"], leg["p_claude"]) == (0.7, 0.66, 0.72)
    assert leg["match"]["surface"] == "hard" and leg["match"]["best_of"] == 3
    assert leg["match"]["tournament"] == "Shanghai" and leg["match"]["category"] == "masters"
    assert leg["result"] is None and leg["closing"] is None and leg["clv"] is None
    other = await signed_in(make_client, make_user, login, ip="10.0.0.4")
    assert await _ids(other.client) == []
    response = await other.client.get(f"/api/bets/{bet.id}")
    assert response.status_code == 404 and error_code(response) == "bet.not_found"
    summary = (await other.client.get("/api/bets/summary")).json()
    assert summary["settled"] == 0 and summary["open"] == 0 and summary["roi"] is None
    assert (await other.client.get("/api/bets/export.csv")).text.count("\r\n") == 1


async def test_export_csv(member: Signed, maker: BetMaker, db: AsyncSession) -> None:
    zone = ZoneInfo(member.user.user.tz)
    today = datetime.now(UTC).astimezone(zone).date()
    placed = datetime.combine(today, time(9, 5), tzinfo=zone).astimezone(UTC)
    parlay = await maker.bet(
        member.user,
        [LegSpec(odds="1.50", names=("=cmd()", "Rune H.")), LegSpec(odds="1.40", selection=2)],
        stake="100",
        placed_at=placed,
        bookmaker="+Bet",
    )
    await settle(
        member.client,
        parlay.id,
        "win",
        "win",
        score="2:0",
        closing={"odds": "1.45", "opp_odds": "2.70", "by": "pinnacle"},
    )
    await maker.bet(member.user, [LegSpec()], placed_at=placed - timedelta(days=60))
    response = await member.client.get("/api/bets/export.csv", params={"period": "30d"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert 'filename="bets.csv"' in response.headers["content-disposition"]
    body = response.content.decode("utf-8")
    assert body.startswith("﻿")
    rows = list(csv.reader(io.StringIO(body.lstrip("﻿"))))
    header, legs = rows[0], rows[1:]
    assert header[0] == "Ставка №" and "CLV события" in header
    assert len(legs) == 2
    first = dict(zip(header, legs[0], strict=True))
    second = dict(zip(header, legs[1], strict=True))
    assert first["Ставка №"] == str(parlay.id) and first["Событие №"] == "1"
    assert first["Время ставки"] == f"{today.isoformat()} 09:05"
    assert first["Итог ставки"] == "won" and first["Выплата"] == "210.00"
    # Текст, с которого таблица начала бы формулу, экранируется
    assert first["Игрок 1"] == "'=cmd()" and first["Букмекер"] == "'+Bet"
    assert first["Счет (первым — игрок 1)"] == "2:0"
    assert first["Чей закрывающий кэф"] == "pinnacle"
    assert float(first["CLV события"]) == pytest.approx(1.50 / 1.45 - 1, abs=1e-6)
    assert second["Ставка на"] == second["Игрок 2"] and second["Закрывающий кэф"] == ""
    everything = (await member.client.get("/api/bets/export.csv")).content.decode("utf-8")
    assert len(list(csv.reader(io.StringIO(everything.lstrip("﻿"))))) == 4


async def test_settled_bet_moves_between_status_filters(
    member: Signed, maker: BetMaker, db: AsyncSession
) -> None:
    bet = await maker.bet(member.user, [LegSpec()])
    await db.execute(update(Bet).where(Bet.id == bet.id).values(placed_at=datetime.now(UTC)))
    await db.commit()
    assert await _ids(member.client, status="open") == [bet.id]
    await settle(member.client, bet.id, "loss")
    assert await _ids(member.client, status="open") == []
    assert await _ids(member.client, status="lost") == [bet.id]


async def _all_ids(client: Any, **params: Any) -> list[int]:
    """Все страницы списка по фильтрам."""
    ids: list[int] = []
    before: int | None = None
    while True:
        page = {**params, "limit": 2, **({"before": before} if before else {})}
        response = await client.get("/api/bets", params=page)
        assert response.status_code == 200, response.text
        data = response.json()
        ids += [item["id"] for item in data["items"]]
        before = data["next_before"]
        if before is None:
            return ids


async def test_list_summary_and_export_pick_same_bets(
    member: Signed,
    maker: BetMaker,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Список (EXISTS по ногам ставки, страница с LIMIT), итоги и выгрузка (множество id
    своих ставок) выбирают одни и те же ставки; чужие ставки с теми же игроками и
    турнирами не попадают."""
    other = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    names = ("Sinner J.", "Rune H.")
    for user in (member.user, other.user):
        await maker.bet(user, [LegSpec(names=names, surface="clay", tournament="Roma")])
        await maker.bet(
            user,
            [LegSpec(market="HCP_-1.5"), LegSpec(tournament=None, confirmed_surface="grass")],
        )
        await maker.bet(user, [LegSpec(tournament=None, confirmed_surface=None)], bookmaker="Pari")
        await maker.bet(user, [LegSpec(names=("Alcaraz C.", "Sinner J."), market="HCP_+1.5")])
    first = (await _all_ids(member.client))[-1]
    await settle(member.client, first, "win")
    combos: list[dict[str, Any]] = [
        {},
        {"surface": "clay"},
        {"surface": ["grass", "unknown"]},
        {"market": "HCP_-1.5"},
        {"market": "HCP_+1.5", "q": "sinner"},
        {"q": "sinner"},
        {"q": "roma"},
        {"q": "pari"},
        {"q": "sinner", "surface": "clay", "status": "won"},
    ]
    for params in combos:
        ids = await _all_ids(member.client, **params)
        summary = (await member.client.get("/api/bets/summary", params=params)).json()
        assert summary["settled"] + summary["open"] == len(ids), params
        export = await member.client.get("/api/bets/export.csv", params=params)
        rows = list(csv.reader(io.StringIO(export.text.lstrip("﻿"))))[1:]
        assert sorted({int(row[0]) for row in rows}) == sorted(ids), params
        own = set(await _all_ids(member.client))
        assert set(ids) <= own, params
    assert len(await _all_ids(member.client, q="sinner")) == 2
    assert await _all_ids(member.client, q="sinner", surface="clay", status="won") == [first]


async def test_user_tournament_surface_is_own(
    member: Signed,
    maker: BetMaker,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Турнир из ввода (source user) общий у всех: покрытие и формат строки — из ввода
    того, кто создал ее первым. Карточка и фильтр берут свои из своего ввода (Т29, Р14)."""
    other = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    shared = {"tournament": "Foo", "tournament_source": "user", "surface": "clay", "best_of": 5}
    mine = await maker.bet(
        member.user,
        [LegSpec(**shared, confirmed_surface="hard", confirmed_best_of=3)],  # type: ignore[arg-type]
    )
    theirs = await maker.bet(
        other.user,
        [LegSpec(**shared, confirmed_surface="grass", confirmed_best_of=5)],  # type: ignore[arg-type]
    )
    card = (await member.client.get(f"/api/bets/{mine.id}")).json()
    match = card["legs"][0]["match"]
    assert (match["surface"], match["best_of"]) == ("hard", 3)
    assert await _ids(member.client, surface="hard") == [mine.id]
    assert await _ids(member.client, surface="clay") == []
    summary = (await member.client.get("/api/bets/summary", params={"surface": "clay"})).json()
    assert summary["open"] == 0
    other_card = (await other.client.get(f"/api/bets/{theirs.id}")).json()
    assert other_card["legs"][0]["match"]["surface"] == "grass"
    assert other_card["legs"][0]["match"]["best_of"] == 5


@pytest.mark.parametrize(
    "params", [{"to": "9999-12-31"}, {"from": "0001-01-01"}, {"from": "1999-12-31"}]
)
async def test_extreme_dates_are_rejected(member: Signed, params: dict[str, str]) -> None:
    for path in ("/api/bets", "/api/bets/summary", "/api/bets/export.csv"):
        response = await member.client.get(path, params=params)
        assert response.status_code == 422 and error_code(response) == "validation", path
    edge = await member.client.get(
        "/api/bets/summary", params={"from": "2000-01-01", "to": "2100-12-31"}
    )
    assert edge.status_code == 200
