"""Еженедельный отчет (В8 Р25, этап 5, волна 4): понедельник 07:00 по поясу участника,
один отчет на неделю, ставки недели по времени расчета (сами и вручную), пустая неделя,
общее администратору без ставок участников (Р14), только свои отчеты на маршрутах.

Время в тестах — фиксированное (now), от текущей даты ничего не зависит."""

from datetime import UTC, date, datetime
from decimal import Decimal as D
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    AgentRun,
    Bet,
    BetLeg,
    Lesson,
    Notification,
    NotificationPref,
    Postmortem,
    User,
    WeeklyReport,
)
from app.services import weekly_report
from app.services.weekly_report import due_week, week_of
from app.workers import jobs
from tests.helpers_admin import error_code
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, MadeUser, UserFactory

# Понедельник 12 окт 2026, 07:01 по Хельсинки (UTC+3): отчет за 5–11 окт
NOW = datetime(2026, 10, 12, 4, 1, tzinfo=UTC)
WEEK = date(2026, 10, 5)
LONG_AGO = datetime(2026, 9, 1, tzinfo=UTC)


def at(day: int, hour: int = 12) -> datetime:
    return datetime(2026, 10, day, hour, tzinfo=UTC)


async def _old(db: AsyncSession, made: MadeUser, created: datetime = LONG_AGO) -> User:
    """Пользователь «был» до недели отчета."""
    made.user.created_at = created
    await db.commit()
    return made.user


async def _settle(
    db: AsyncSession,
    bet: Bet,
    *,
    when: datetime,
    status: str,
    by: str = "manual",
    closing: str | None = None,
    q_close: float | None = None,
) -> None:
    """Расчет ставки прямо в базе: отчет читает только строки."""
    bet.status = status
    bet.settled_at = when
    bet.settled_by = by
    bet.profit = {"won": bet.stake * (bet.total_odds - 1), "lost": -bet.stake}.get(status, D(0))
    legs = list(await db.scalars(select(BetLeg).where(BetLeg.bet_id == bet.id)))
    for leg in legs:
        leg.result = {"won": "win", "lost": "loss"}.get(status, "void")
        leg.settled_at = when
        if closing is not None:
            leg.closing_odds = D(closing)
            leg.q_close = q_close
    await db.commit()


async def _week_of_bets(db: AsyncSession, member: User) -> dict[str, Bet]:
    maker = BetMaker(db)
    spec = LegSpec(odds="1.80", p_final=0.62, q_market=0.5)
    won = await maker.bet(member, [spec], placed_at=at(6))
    lost = await maker.bet(member, [spec], placed_at=at(9))
    # Рассчитана в воскресенье 4 окт в 23:00 по Хельсинки — прошлая неделя
    before = await maker.bet(member, [spec], placed_at=at(3))
    legacy = await maker.bet(member, [spec], placed_at=at(6), source="legacy")
    still_open = await maker.bet(member, [spec], placed_at=at(10))
    await _settle(db, won, when=at(7), status="won", by="auto", closing="1.70", q_close=0.55)
    await _settle(db, lost, when=at(10), status="lost")
    await _settle(db, before, when=datetime(2026, 10, 4, 20, tzinfo=UTC), status="won")
    await _settle(db, legacy, when=at(8), status="won", by="legacy")
    return {"won": won, "lost": lost, "before": before, "legacy": legacy, "open": still_open}


async def _shared_extras(db: AsyncSession, bets: dict[str, Bet]) -> None:
    """Общий урок недели, чужой свой урок, разбор матча, проверка (eval)."""
    db.add_all(
        [
            Lesson(user_id=None, code="L-001", text="Общий", kind="numeric", created_at=at(6)),
            Lesson(user_id=None, code="L-000", text="Старый", kind="numeric", created_at=at(1)),
        ]
    )
    leg = await db.scalar(select(BetLeg).where(BetLeg.bet_id == bets["won"].id))
    assert leg is not None and leg.prediction_id is not None
    run = AgentRun(
        user_id=None,
        key_source="admin",
        kind="postmortem",
        model="claude-sonnet-5-5",
        batch=True,
        cost_usd=D("0.0100"),
        created_at=at(8),
    )
    check = AgentRun(
        user_id=None,
        key_source="admin",
        kind="eval",
        model="claude-opus-5-5",
        batch=True,
        cost_usd=D("0.5000"),
        created_at=at(8),
    )
    db.add_all([run, check])
    await db.flush()
    db.add(
        Postmortem(
            match_id=leg.match_id,
            prediction_id=leg.prediction_id,
            status="done",
            agent_run_id=run.id,
        )
    )
    await db.commit()


def test_due_week_by_member_zone() -> None:
    """Отчет за неделю — с понедельника 07:00 по поясу участника; до 07:00 — еще прошлая."""
    assert due_week(NOW, "Europe/Helsinki").start == WEEK
    early = datetime(2026, 10, 12, 3, 59, tzinfo=UTC)  # 06:59 по Хельсинки
    assert due_week(early, "Europe/Helsinki").start == date(2026, 9, 28)
    # Нью-Йорк (UTC−4): в это время там еще воскресенье ночь → понедельник 00:01
    assert due_week(NOW, "America/New_York").start == date(2026, 9, 28)
    assert due_week(datetime(2026, 10, 12, 11, 0, tzinfo=UTC), "America/New_York").start == WEEK
    # Пояс с получасом (UTC+5:30): 07:00 — это 01:30 UTC
    assert due_week(datetime(2026, 10, 12, 1, 29, tzinfo=UTC), "Asia/Kolkata").start == date(
        2026, 9, 28
    )
    assert due_week(datetime(2026, 10, 12, 1, 31, tzinfo=UTC), "Asia/Kolkata").start == WEEK
    # Границы недели — полночь по поясу; переход на зимнее время (25 окт) не сдвигает дни
    week = week_of(date(2026, 10, 19), "Europe/Helsinki")
    assert week.begin == datetime(2026, 10, 18, 21, tzinfo=UTC)
    assert week.finish == datetime(2026, 10, 25, 22, tzinfo=UTC)
    assert week.due == datetime(2026, 10, 26, 5, tzinfo=UTC)


async def test_report_counts_week_bets_once(db: AsyncSession, make_user: UserFactory) -> None:
    """Ставки недели по времени расчета (сами по архиву и вручную), CLV, Brier к рынку,
    калибровка, разборы, уроки, проверки; второй запуск — без нового отчета."""
    member = await _old(db, await make_user())
    bets = await _week_of_bets(db, member)
    await _shared_extras(db, bets)

    made = await weekly_report.send_due_reports(db, now=NOW)
    assert len(made) == 1
    assert await weekly_report.send_due_reports(db, now=NOW) == []
    assert await jobs_count(db) == 1

    report = await db.get_one(WeeklyReport, made[0])
    assert (report.user_id, report.week_start) == (member.id, WEEK)
    out = weekly_report.report_out(report)
    assert (out.week_start, out.week_end, out.tz, out.currency) == (
        WEEK,
        date(2026, 10, 11),
        "Europe/Helsinki",
        "RUB",
    )
    assert not out.empty and out.shared is None
    bets_out = out.bets
    assert (bets_out.settled, bets_out.auto, bets_out.manual) == (2, 1, 1)
    assert (bets_out.won, bets_out.lost, bets_out.void) == (1, 1, 0)
    assert (bets_out.turnover, bets_out.profit) == (D("200.00"), D("-20.00"))
    assert bets_out.roi == pytest.approx(-0.1)
    # Поставлены за неделю: выигранная, проигранная и открытая (бот не считается)
    assert (bets_out.placed, bets_out.open) == (3, 1)
    assert out.clv.n == 1 and out.clv.positive == 1
    assert out.clv.mean == pytest.approx(1.80 / 1.70 - 1, abs=1e-6)
    # Brier: рынок при прогнозе у обеих ног (у закрытия — одна): главный ряд — pred
    assert out.accuracy.source == "pred" and out.accuracy.n == 2
    assert out.accuracy.model == pytest.approx(((0.62 - 1) ** 2 + 0.62**2) / 2)
    assert out.accuracy.market == pytest.approx(0.25)
    assert out.accuracy.model is not None
    assert out.accuracy.diff == pytest.approx(out.accuracy.model - 0.25)
    assert out.calibration.n == 2
    assert out.calibration.mean_p == pytest.approx(0.62)
    assert out.calibration.hit_rate == pytest.approx(0.5)
    assert (out.reviews.done, out.reviews.pending, out.reviews.cost_usd) == (1, 0, D("0.01"))
    assert out.lessons.new == ["L-001"] and out.lessons.in_prompt == 0
    assert out.eval.spent_usd == D("0.5") and out.eval.runs == 0
    assert out.eval.budget_usd == D("25")

    [note] = await db.scalars(select(Notification).where(Notification.user_id == member.id))
    assert note.kind == "weekly_report" and note.link == f"/learning/reports?report={report.id}"
    assert note.title == "Отчет за неделю 5–11 окт"
    assert note.body.startswith("Рассчитано ставок: 2, из них по архиву — 1.")
    assert "Прибыль −20 ₽, ROI −10,0%, средний CLV +5,9%." in note.body


async def jobs_count(db: AsyncSession) -> int:
    return int(await db.scalar(select(func.count()).select_from(WeeklyReport)) or 0)


async def test_empty_week_new_user_and_zones(db: AsyncSession, make_user: UserFactory) -> None:
    """Пустая неделя — короткий отчет; кого не было к концу недели — без отчета; у
    Нью-Йорка отчет приходит в его 07:00; выключенный вид — отчет без уведомления."""
    quiet = await _old(db, await make_user())
    newcomer = await _old(db, await make_user(), created=datetime(2026, 10, 12, 1, tzinfo=UTC))
    ny = await _old(db, await make_user(tz="America/New_York"), created=at(6))
    off = await _old(db, await make_user())
    blocked = await _old(db, await make_user(status="blocked"))
    db.add(NotificationPref(user_id=off.id, kind="weekly_report", on_site=False))
    await db.commit()

    made = await weekly_report.send_due_reports(db, now=NOW)
    owners = set(await db.scalars(select(WeeklyReport.user_id)))
    assert len(made) == 2 and owners == {quiet.id, off.id}
    assert newcomer.id not in owners and blocked.id not in owners
    report = await db.scalar(select(WeeklyReport).where(WeeklyReport.user_id == quiet.id))
    assert report is not None
    out = weekly_report.report_out(report)
    assert out.empty and out.bets.settled == 0 and out.bets.profit == D("0")
    assert out.clv.mean is None and out.accuracy.n == 0 and out.calibration.mean_p is None
    [note] = await db.scalars(select(Notification).where(Notification.user_id == quiet.id))
    assert note.title == "Отчет за неделю 5–11 окт: ставок не было"
    assert note.params["variant"] == "empty"
    assert not list(await db.scalars(select(Notification).where(Notification.user_id == off.id)))

    # В Нью-Йорке понедельник 07:01 — отчет за ту же неделю по его поясу
    later = datetime(2026, 10, 12, 11, 1, tzinfo=UTC)
    made = await weekly_report.send_due_reports(db, now=later)
    assert len(made) == 1
    row = await db.get_one(WeeklyReport, made[0])
    assert (row.user_id, row.week_start) == (ny.id, WEEK)
    assert row.payload["tz"] == "America/New_York"


async def test_two_jobs_make_one_report(db: AsyncSession, make_user: UserFactory) -> None:
    """Отчет за неделю уже записан другой задачей — второй не пишется, уведомление одно."""
    member = await _old(db, await make_user())
    week = due_week(NOW, member.tz)
    first = await weekly_report.make_report(db, member, week, now=NOW)
    second = await weekly_report.make_report(db, member, week, now=NOW)
    assert first is not None and second is None
    count = await db.scalar(
        select(func.count()).select_from(Notification).where(Notification.user_id == member.id)
    )
    assert count == 1


async def test_admin_gets_program_totals_without_member_money(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """У администратора — общее по программе: счетчики и расход ИИ, без сумм ставок и
    без того, кто на что ставил (Р14)."""
    admin = await _old(db, await make_user(role="admin"))
    member = await _old(db, await make_user())
    bets = await _week_of_bets(db, member)
    await _shared_extras(db, bets)
    await weekly_report.send_due_reports(db, now=NOW)
    report = await db.scalar(select(WeeklyReport).where(WeeklyReport.user_id == admin.id))
    assert report is not None
    out = weekly_report.report_out(report)
    # Своих ставок у администратора нет — его отчет пустой, а общее — есть
    assert out.empty and out.shared is not None
    shared = out.shared
    assert (shared.members, shared.settled, shared.auto) == (1, 2, 1)
    assert (shared.reviews, shared.reviews_usd) == (1, D("0.01"))
    assert shared.ai_usd == D("0.01") and shared.analyses == 0
    assert set(report.payload["shared"]) == {
        "members",
        "settled",
        "auto",
        "reviews",
        "reviews_usd",
        "analyses",
        "ai_usd",
    }


async def test_report_routes_show_only_own(
    db: AsyncSession,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """GET /learning/reports — свои отчеты, новые сверху; чужой отчет — 404 (и
    администратору: ставки участника он не видит, Р14). Сводка «Обучения» знает последний."""
    member = await _old(db, await make_user())
    admin = await _old(db, await make_user(role="admin"))
    await _week_of_bets(db, member)
    await weekly_report.send_due_reports(db, now=datetime(2026, 10, 5, 4, 1, tzinfo=UTC))
    await weekly_report.send_due_reports(db, now=NOW)
    mine = list(
        await db.scalars(
            select(WeeklyReport)
            .where(WeeklyReport.user_id == member.id)
            .order_by(WeeklyReport.week_start)
        )
    )
    assert [row.week_start for row in mine] == [date(2026, 9, 28), WEEK]

    client = await login(await make_client(), member)
    listed = await client.get("/api/learning/reports")
    assert listed.status_code == 200, listed.text
    body: dict[str, Any] = listed.json()
    assert [item["week_start"] for item in body["items"]] == ["2026-10-05", "2026-09-28"]
    first = body["items"][0]
    assert first["week_end"] == "2026-10-11" and first["settled"] == 2
    assert first["profit"] == "-20.00" and first["currency"] == "RUB" and not first["empty"]
    # Ставка, рассчитанная в воскресенье 4 окт в 23:00 по Хельсинки, — в прошлой неделе
    assert body["items"][1]["settled"] == 1 and body["items"][1]["empty"] is False
    assert body["report_hour"] == 7
    assert date.fromisoformat(body["next_report"]).weekday() == 0
    detail = await client.get(f"/api/learning/reports/{mine[1].id}")
    assert detail.status_code == 200, detail.text
    assert detail.json()["bets"]["auto"] == 1 and detail.json()["shared"] is None
    summary = (await client.get("/api/learning")).json()
    assert (summary["last_report"], summary["last_report_end"], summary["last_report_id"]) == (
        "2026-10-05",
        "2026-10-11",
        mine[1].id,
    )

    boss = await login(await make_client("10.0.0.9"), admin)
    foreign = await boss.get(f"/api/learning/reports/{mine[1].id}")
    assert foreign.status_code == 404 and error_code(foreign) == "report.not_found"
    own = (await boss.get("/api/learning/reports")).json()["items"]
    assert [item["week_start"] for item in own] == ["2026-10-05", "2026-09-28"]
    missing = await client.get("/api/learning/reports/999999")
    assert missing.status_code == 404


async def test_worker_job_sends_due_reports(
    db: AsyncSession, make_user: UserFactory, monkeypatch: pytest.MonkeyPatch, engine: Any
) -> None:
    """Задача воркера — тот же код (время — подмена utcnow сервиса)."""
    from app.db.session import create_sessionmaker

    member = await _old(db, await make_user())
    monkeypatch.setattr(weekly_report, "utcnow", lambda: NOW)
    made = await jobs.weekly_reports({"sessionmaker": create_sessionmaker(engine)})
    assert len(made) == 1
    row = await db.get_one(WeeklyReport, made[0])
    assert (row.user_id, row.week_start) == (member.id, WEEK)
    assert await jobs.weekly_reports({"sessionmaker": create_sessionmaker(engine)}) == []
