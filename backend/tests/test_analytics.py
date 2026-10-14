"""«Аналитика» (GET /api/analytics) против эталонных SQL (tests/reference_sql.py) на фикстуре
этапа (tests/stage4_world.py): показатели = итоги «Ставок», срезы ROI по событиям, Brier
против рынка, калибровка, итоговый кэф, экспрессы против ординаров; фильтры; детерминизм
доверительных интервалов; права (только свои данные, Р14); выгрузка CSV и ZIP."""

import csv
import io
import zipfile
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet
from tests import reference_sql
from tests.helpers_admin import Signed, signed_in
from tests.stage4_world import TZ, ZONE, analytics_world, local_today
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
APPROX = 1e-9


@pytest.fixture
async def world(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, Signed, dict[str, int]]:
    member = await signed_in(make_client, make_user, login, tz=TZ)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    return member, other, await analytics_world(db, member, other)


async def _analytics(member: Signed, **params: Any) -> dict[str, Any]:
    response = await member.client.get("/api/analytics", params=params)
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


def _approx(value: float | None, expected: float | None) -> bool:
    if expected is None:
        return value is None
    return value is not None and abs(value - expected) <= APPROX


async def test_kpi_equals_bets_summary(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Показатели «Аналитики» — те же числа, что итоги «Ставок» и эталон, за любой период и
    с любым источником."""
    member, _, _ = world
    for params in ({}, {"period": "7d"}, {"period": "30d"}, {"source": "app"},
                   {"source": "legacy"}):  # fmt: skip
        data = await _analytics(member, **params)
        summary = (await member.client.get("/api/bets/summary", params=params)).json()
        kpi = data["kpi"]
        for key in ("settled", "won", "lost", "void", "clv_n", "clv_positive"):
            assert kpi[key] == summary[key], (params, key)
        assert kpi["legacy_settled"] == summary["legacy_settled"]
        assert D(kpi["turnover"]) == D(summary["turnover"])
        assert D(kpi["profit"]) == D(summary["profit"])
        for key in ("roi", "winrate", "clv"):
            assert _approx(kpi[key], summary[key]), (params, key)
        assert data["sample"]["open_bets"] == summary["open"]
    whole = await _analytics(member)
    ref = await reference_sql.summary(db, member.id)
    assert whole["kpi"]["settled"] == ref.settled == 14
    assert D(whole["kpi"]["profit"]) == ref.profit
    assert _approx(whole["kpi"]["roi"], ref.roi)
    clv = await reference_sql.clv(db, member.id)
    assert whole["kpi"]["clv_n"] == clv.n and _approx(whole["kpi"]["clv"], clv.mean)


async def test_slices_match_reference(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, _, _ = world
    data = await _analytics(member)
    assert data["sample"]["events"] == await reference_sql.events_count(db, member.id) == 16
    # Ноги экспресса бота не считаются по отдельности (Т10)
    assert data["sample"]["legacy_parlay_events"] == 2
    slices = data["slices"]
    surfaces = {item["surface"]: (item["n"], item["roi"]) for item in slices["surfaces"]}
    ref = await reference_sql.roi_by(db, member.id, "surface")
    assert surfaces.keys() == ref.keys() == {"hard", "clay", "grass"}
    for key, (n, roi) in ref.items():
        assert surfaces[key][0] == n and _approx(surfaces[key][1], roi)
    markets = {
        f"{item['market']}:{item['selection']}": (item["n"], item["roi"])
        for item in slices["markets"]
    }
    ref = await reference_sql.roi_by(db, member.id, "outcome")
    assert markets.keys() == ref.keys()
    for key, (n, roi) in ref.items():
        assert markets[key][0] == n and _approx(markets[key][1], roi)
    odds = {item["low"]: (item["n"], item["roi"]) for item in slices["odds"]}
    ref = await reference_sql.roi_by(db, member.id, "odds")
    assert odds.keys() == ref.keys()
    for key, (n, roi) in ref.items():
        assert odds[key][0] == n and _approx(odds[key][1], roi)
    total = slices["markets_total"]
    assert total["n"] == sum(n for n, _ in ref.values())
    # Метка «мало данных» и интервал у среза с 2+ событиями
    assert all(item["small"] for item in slices["surfaces"])
    assert all((item["roi_ci"] is None) == (item["n"] < 2) for item in slices["surfaces"])


async def test_totals_and_parlays_match_reference(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    member, _, _ = world
    data = await _analytics(member)
    totals = data["slices"]["totals"]
    assert [item["low"] for item in totals[:4]] == ["1.28", "1.71", "2.21", "3.25"]
    assert [item["stake_pct"] for item in totals[:4]] == ["0.0275", "0.0225", "0.0175", "0.0175"]
    assert [item["triple"] for item in totals[:4]] == [False, False, False, True]
    ref = await reference_sql.roi_by_total(db, member.id)
    for item in totals:
        key = item["low"] if item["low"] is not None else "outside"
        n, turnover, profit = ref.get(key, (0, D(0), D(0)))
        assert item["bets"] == n, key
        assert D(item["turnover"]) == turnover and D(item["profit"]) == profit, key
        if n:
            assert _approx(item["roi"], float(profit / turnover))
    # Возврат всей ставки — в voids, не в обороте
    assert sum(item["voids"] for item in totals) == 1
    # Экспресс 1.703 на стыке 1.70/1.71 — во второй строке, как его ставила стратегия:
    # эталон кладет его туда же (первая полоса, у которой high ≥ кэфа)
    gap = await db.get(Bet, world[2]["gap_parlay"])
    assert gap is not None and gap.total_odds == D("1.703") and gap.status == "won"
    first = next(item for item in totals if item["low"] == "1.28")
    assert D(first["high"]) < gap.total_odds < D("1.71")

    parlays = data["parlays"]
    ref_parlays = await reference_sql.parlays_vs_singles(db, member.id)
    assert parlays["parlays"] == ref_parlays.parlays == 4
    assert parlays["events"] == ref_parlays.events
    assert D(parlays["profit"]) == ref_parlays.profit
    assert _approx(parlays["parlays_roi"], ref_parlays.parlays_roi)
    assert _approx(parlays["singles_roi"], ref_parlays.singles_roi)
    assert _approx(parlays["diff"], ref_parlays.parlays_roi - ref_parlays.singles_roi)
    assert parlays["legacy_parlays"] == 1
    assert parlays["verdict"] in ("noise", "parlays", "singles")


async def test_brier_and_calibration_match_reference(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """События калибровки: без проверочного прогона, с заменой прогноза до начала матча и
    без замены после него; ставки бота — не входят."""
    member, _, _ = world
    data = await _analytics(member)
    brier, ref = data["brier"], await reference_sql.brier(db, member.id)
    assert brier["n"] == ref.n == 5
    assert _approx(brier["model"], ref.model) and _approx(brier["market"], ref.market)
    # Второй ряд — все события с двумя сторонами закрытия: 3 с рынком при прогнозе и 2 без
    # него (первые ноги экспресса base_world и экспресса на стыке полос)
    assert brier["closing_n"] == ref.closing_n == 5
    assert _approx(brier["closing_model"], ref.closing_model)
    assert _approx(brier["closing_market"], ref.closing_market)
    assert _approx(brier["diff"], (ref.model or 0) - (ref.market or 0))
    ci = brier["diff_ci"]
    assert ci["low"] <= brier["diff"] <= ci["high"]
    assert brier["noise"] == (ci["low"] <= 0 <= ci["high"])
    # Окна по 30 событий: событий меньше — точек нет
    assert brier["points"] == [] and brier["better"] == 0 and brier["windows"] == 0

    calibration = data["calibration"]
    events, bins = await reference_sql.calibration(db, member.id)
    assert calibration["kind"] == "final" and calibration["events"] == events
    got = {item["low"]: item for item in calibration["bins"]}
    assert sorted(got) == [item.low for item in bins]
    for item in bins:
        out = got[item.low]
        assert out["n"] == item.n
        assert _approx(out["p"], item.p) and _approx(out["actual"], item.actual)
        assert _approx(out["p_base"], item.p_base) and _approx(out["p_claude"], item.p_claude)
        assert out["ci_low"] <= out["actual"] <= out["ci_high"]
    assert calibration["outside"] == events - sum(item.n for item in bins)
    # Замена до начала матча взята (0,66), после — нет (0,74 остался); прогноз проверочного
    # прогона в калибровку не идет
    member_ids = world[2]
    response = await member.client.get("/api/analytics/export.csv", params={"part": "events"})
    rows = {int(row[0]): row for row in _read_csv(response.text)[1:]}
    p_final, in_calibration = 9, 17
    assert float(rows[member_ids["replaced"]][p_final]) == 0.66
    assert float(rows[member_ids["late_fix"]][p_final]) == 0.74
    assert rows[member_ids["evaluated"]][p_final] == ""
    assert rows[member_ids["evaluated"]][in_calibration] == "0"
    assert rows[member_ids["replaced"]][in_calibration] == "1"


async def test_legacy_source_calibrates_claude(
    world: tuple[Signed, Signed, dict[str, int]],
) -> None:
    """Под фильтром «старый бот» калибровка — по p_claude его ординаров, Brier и CLV пусты."""
    member, _, _ = world
    data = await _analytics(member, source="legacy")
    assert data["filtered"] is True
    assert data["calibration"]["kind"] == "claude"
    # Ординар бота (выигран) и ординар бота (проигран); экспресс бота не считается
    assert data["calibration"]["events"] == 2
    assert all(item["p_base"] is None for item in data["calibration"]["bins"])
    assert data["brier"]["n"] == 0 and data["kpi"]["clv_n"] == 0
    assert data["series"]["kind"] == "result"
    assert data["parlays"]["parlays"] == 0 and data["parlays"]["legacy_parlays"] == 1


async def test_dimension_filters(world: tuple[Signed, Signed, dict[str, int]]) -> None:
    """Срез по покрытию не сужается фильтром покрытия, по исходу — фильтром рынка; события
    выборки — под обоими."""
    member, _, ids = world
    whole = await _analytics(member)
    clay = await _analytics(member, surface="clay")
    assert clay["sample"]["events"] == 2
    assert clay["slices"]["surfaces"] == whole["slices"]["surfaces"]
    assert sum(item["n"] for item in clay["slices"]["markets"]) == 2
    assert clay["kpi"]["settled"] == 1 and clay["series"]["kind"] == "result"
    minus = await _analytics(member, market="HCP_-1.5", selection=1)
    assert minus["sample"]["events"] == 1 and minus["kpi"]["settled"] == 1
    assert minus["slices"]["markets"] == whole["slices"]["markets"]
    # Рынок без стороны — обе стороны форы −1.5 (здесь одна)
    assert (await _analytics(member, market="HCP_-1.5"))["kpi"]["settled"] == 1
    response = await member.client.get("/api/analytics", params={"selection": 1})
    assert response.status_code == 422
    assert ids["clay"]


async def test_series_bank_and_result(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Без фильтров — капитал по дням (как эталон), с фильтром — прибыль нарастающим
    итогом; строки таблицы складываются в прибыль."""
    member, _, _ = world
    today = local_today()
    data = await _analytics(member, period="30d")
    series = data["series"]
    assert series["kind"] == "bank" and series["group"] == "week"
    points = {item["day"]: D(item["value"]) for item in series["points"]}
    start = today - timedelta(days=30)
    reference = await reference_sql.equity_by_day(db, member.id, TZ, start, today)
    # Банк появился внутри периода: дни до первой записи журнала в ряд не входят
    assert reference[start] == 0
    first_day = min(day for day, value in reference.items() if value != 0)
    shown = {day.isoformat(): value for day, value in reference.items() if day >= first_day}
    assert shown == points
    assert D(series["base"]) == reference[start] and D(series["last"]) == reference[today]
    bank = (await member.client.get("/api/me/bank")).json()
    assert D(series["last"]) == D(bank["equity"])
    # Старт периода — первый день банка и вложенное, изменение — рост капитала к нему
    assert series["start_day"] == first_day.isoformat()
    assert D(series["start_amount"]) == D(bank["invested"])
    assert abs(series["change_share"] - float(D(bank["growth"]))) < 1e-4
    assert sum(D(row["profit"]) for row in series["rows"]) == D(data["kpi"]["profit"])
    assert -1 <= series["max_drawdown"] <= 0

    result = (await _analytics(member, period="30d", source="app"))["series"]
    assert result["kind"] == "result" and D(result["base"]) == 0
    app_profit = D((await member.client.get(
        "/api/bets/summary", params={"period": "30d", "source": "app"}
    )).json()["profit"])  # fmt: skip
    assert D(result["last"]) == app_profit
    assert D(result["worst"]) <= 0


async def test_prev_period_and_change(world: tuple[Signed, Signed, dict[str, int]]) -> None:
    member, _, _ = world
    data = await _analytics(member, period="7d")
    prev = data["prev"]
    today = local_today()
    assert prev["date_from"] == (today - timedelta(days=13)).isoformat()
    assert prev["date_to"] == (today - timedelta(days=7)).isoformat()
    summary = (await member.client.get(
        "/api/bets/summary", params={"from": prev["date_from"], "to": prev["date_to"]}
    )).json()  # fmt: skip
    assert prev["settled"] == summary["settled"] and D(prev["profit"]) == D(summary["profit"])
    change = data["change"]
    assert D(change["profit"]) == D(data["kpi"]["profit"]) - D(prev["profit"])
    assert _approx(change["roi"], data["kpi"]["roi"] - prev["roi"])
    # Все время и даты без начала — сравнивать не с чем
    assert (await _analytics(member))["prev"] is None
    assert (await _analytics(member, to=today.isoformat()))["prev"] is None
    custom = await _analytics(
        member, **{"from": (today - timedelta(days=9)).isoformat(), "to": today.isoformat()}
    )
    assert (
        custom["period"] is None and custom["date_from"] == (today - timedelta(days=9)).isoformat()
    )
    assert custom["prev"]["date_to"] == (today - timedelta(days=10)).isoformat()


async def test_prev_needs_full_history(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Прошлый период сравнивается, только если история участника покрывает его целиком
    (макет: начало прошлого периода не раньше первого дня истории). История — с 40 дней
    назад: у 30 дней прошлый период (59–30 дней назад) покрыт частично — сравнения нет, хотя
    ставка в нем есть; у своих 15 дней прошлый период (29–15 дней назад) покрыт — есть."""
    from tests.helpers_bets import BetMaker, LegSpec, settle
    from tests.stage4_world import days_ago, move_settlement

    member = await signed_in(make_client, make_user, login, tz=TZ)
    maker = BetMaker(db)
    for days, outcome in ((40, "win"), (25, "loss"), (10, "win")):
        bet = await maker.bet(
            member.user, [LegSpec(odds="2.00")], stake="100", placed_at=days_ago(days)
        )
        assert (await settle(member.client, bet.id, outcome)).status_code == 200
        await move_settlement(db, bet.id, days_ago(days, 18))
    today = local_today()
    for path in ("/api/analytics", "/api/dashboard"):
        response = await member.client.get(path, params={"period": "30d"})
        assert response.status_code == 200, response.text
        data = response.json()
        assert data["prev"] is None and data["change"] is None, path
    custom = await _analytics(
        member, **{"from": (today - timedelta(days=14)).isoformat(), "to": today.isoformat()}
    )
    assert custom["prev"]["date_from"] == (today - timedelta(days=29)).isoformat()
    assert custom["prev"]["settled"] == 1 and D(custom["prev"]["profit"]) == D("-100.00")
    assert D(custom["change"]["profit"]) == D("200.00")


async def test_bad_dates(world: tuple[Signed, Signed, dict[str, int]]) -> None:
    member, _, _ = world
    response = await member.client.get(
        "/api/analytics", params={"from": "2026-10-10", "to": "2026-10-01"}
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "bet.bad_dates"
    response = await member.client.get("/api/analytics", params={"foo": "1"})
    assert response.status_code == 422


async def test_ci_deterministic(
    world: tuple[Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Интервалы — один и тот же seed: повторный расчет без кэша дает то же самое, точка
    внутри интервала."""
    from app.schemas.analytics import AnalyticsFiltersIn
    from app.services.analytics import compute_analytics

    member, _, _ = world
    first = await compute_analytics(db, member.user.user, AnalyticsFiltersIn())
    second = await compute_analytics(db, member.user.user, AnalyticsFiltersIn())
    assert first.model_dump() == second.model_dump()
    kpi = first.kpi
    assert kpi.roi_ci is not None and kpi.roi is not None
    assert kpi.roi_ci.low <= kpi.roi <= kpi.roi_ci.high
    assert kpi.clv_ci is not None and kpi.clv is not None
    assert kpi.clv_ci.low <= kpi.clv <= kpi.clv_ci.high


async def test_only_own_data(
    world: tuple[Signed, Signed, dict[str, int]],
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Чужая выигранная ставка не попадает ни в показатели, ни в срезы; администратор видит
    только свою (пустую) аналитику, а не участника (Р14); без входа — 401."""
    member, other, _ = world
    theirs = await _analytics(other)
    assert theirs["kpi"]["settled"] == 1 and D(theirs["kpi"]["profit"]) == D("1998.00")
    mine = await _analytics(member)
    assert all(item["n"] < 14 for item in mine["slices"]["odds"])
    admin = await signed_in(make_client, make_user, login, role="admin", ip="10.0.0.5")
    data = await _analytics(admin)
    assert data["kpi"]["settled"] == 0 and data["sample"]["events"] == 0
    assert data["series"]["kind"] == "bank" and data["parlays"] is None
    anonymous = await make_client(ip="10.0.0.9")
    assert (await anonymous.get("/api/analytics")).status_code == 401
    assert (await anonymous.get("/api/analytics/export.csv")).status_code == 401
    assert (await anonymous.get("/api/analytics/export.zip")).status_code == 401


async def test_empty_member(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Новый участник без ставок: пустые блоки, без ошибок."""
    member = await signed_in(make_client, make_user, login)
    data = await _analytics(member)
    assert data["kpi"]["settled"] == 0 and data["kpi"]["roi"] is None
    assert data["calibration"]["status"] == "empty" and data["clv"]["n"] == 0
    assert data["insights"][0]["code"] == "sample"
    assert len(data["series"]["points"]) == 1 and D(data["series"]["last"]) == 0
    assert data["slices"]["totals"][0]["bets"] == 0


def _read_csv(text: str) -> list[list[str]]:
    assert text.startswith("﻿")
    return list(csv.reader(io.StringIO(text[1:])))


async def test_export_csv(world: tuple[Signed, Signed, dict[str, int]]) -> None:
    member, _, _ = world
    data = await _analytics(member)
    response = await member.client.get("/api/analytics/export.csv", params={"part": "bets"})
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/csv")
    assert "attachment" in response.headers["content-disposition"]
    rows = _read_csv(response.text)
    assert rows[0][0] == "Ставка №" and len(rows) - 1 == data["kpi"]["settled"]
    events = _read_csv(
        (await member.client.get("/api/analytics/export.csv", params={"part": "events"})).text
    )
    assert len(events) - 1 == data["sample"]["events"]
    calibrated = sum(int(row[-2]) for row in events[1:])
    assert calibrated == data["calibration"]["events"]
    assert sum(int(row[-1]) for row in events[1:]) == data["brier"]["n"]
    calibration = _read_csv(
        (await member.client.get(
            "/api/analytics/export.csv", params={"part": "calibration"}
        )).text
    )  # fmt: skip
    assert len(calibration) - 1 == len(data["calibration"]["bins"])
    brier = (await member.client.get("/api/analytics/export.csv", params={"part": "brier"})).text
    assert len(_read_csv(brier)) == 1
    filtered = _read_csv(
        (await member.client.get(
            "/api/analytics/export.csv", params={"part": "bets", "source": "legacy"}
        )).text
    )  # fmt: skip
    assert len(filtered) - 1 == 3
    bad = await member.client.get("/api/analytics/export.csv", params={"part": "nope"})
    assert bad.status_code == 422


async def test_export_zip(world: tuple[Signed, Signed, dict[str, int]]) -> None:
    member, _, _ = world
    response = await member.client.get(
        "/api/analytics/export.zip", params={"part": ["bets", "calibration", "bets"]}
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    names = zipfile.ZipFile(io.BytesIO(response.content)).namelist()
    stamp = local_today().isoformat()
    assert names == [f"analytics-bets-{stamp}.csv", f"analytics-calibration-{stamp}.csv"]


async def test_late_settlement_day_in_result_series(
    world: tuple[Signed, Signed, dict[str, int]],
) -> None:
    """Результат отобранных ставок — по дню расчета по поясу участника: ставка, рассчитанная
    в 23:30 по Нью-Йорку, — в тот же день, а не в следующий (UTC)."""
    member, _, _ = world
    data = await _analytics(member, source="app", period="30d")
    points = {item["day"]: D(item["value"]) for item in data["series"]["points"]}
    day = local_today() - timedelta(days=11)
    late = datetime.combine(day, time(23, 30), tzinfo=ZONE).astimezone(UTC)
    assert late.date() != day
    assert points[day.isoformat()] - points[(day - timedelta(days=1)).isoformat()] == D("100.00")
