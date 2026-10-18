"""Исправления волны 4 этапа 5 по проверкам backend и экранов:
- отчет недели: id вне int64 — 422; смена пояса не теряет и не удваивает ставку на стыке
  недель; «ставки ждут результата» вместо «ставок не было»; сбой на одном участнике не
  останавливает остальных;
- прогон на наборе: «Потрачено» растет с каждым собранным пакетом, у остановленного —
  фактически потраченное; план говорит, откуда цена;
- «ИИ и расходы»: качество версии — у той, где есть прогон, имя версии в «Где экономим»,
  «До и после» — цены на одной основе и сравнение на том же наборе;
- проверка правил суммы: первая ставка нового участника не выпадает, дата начала есть;
  исходные правила участника можно вернуть;
- перекалибровка по кнопке — не «сама»;
- выгрузка JSONL базовой модели — только администратору, без прогнозов участников.

Время в тестах — фиксированное, от текущей даты ничего не зависит."""

import json
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal as D
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import (
    BankrollLedger,
    Bet,
    EvalRun,
    EvalSet,
    Match,
    Notification,
    Prediction,
    StrategyVersion,
    User,
    WeeklyReport,
)
from app.ml.strategy import StrategyParams
from app.schemas.learning import EvalSetIn, VersionEvalOut
from app.services import ai_savings, ai_usage, eval_runs, eval_sets, strategy_versions
from app.services import weekly_report as weekly
from app.services.rule_check import check_rules
from app.services.weekly_report import week_of
from app.workers.jobs import collect_all
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory
from tests.test_ai_usage_stage5 import CANDIDATE_PROMPT, NOW, _calls, _run, _versions, prices
from tests.test_eval_fixes import _start
from tests.test_eval_runs import _ready, fake, world
from tests.test_recalibration import TODAY
from tests.test_recalibration import world as ml_world
from tests.test_weekly_reports import _old, _settle

__all__ = ["fake", "ml_world", "prices", "world"]

AUCKLAND = "Pacific/Auckland"
LOS_ANGELES = "America/Los_Angeles"


# --- отчет недели ---


async def test_report_id_out_of_range_is_422(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    huge = await member.client.get("/api/learning/reports/99999999999999999999")
    assert huge.status_code == 422
    zero = await member.client.get("/api/learning/reports/0")
    assert zero.status_code == 422


async def _bet_settled_at(db: AsyncSession, user: User, when: datetime) -> Bet:
    maker = BetMaker(db)
    bet = await maker.bet(user, [LegSpec()], placed_at=when - timedelta(days=2))
    await _settle(db, bet, when=when, status="won")
    return bet


@pytest.mark.parametrize(("first", "second"), [(AUCKLAND, LOS_ANGELES), (LOS_ANGELES, AUCKLAND)])
async def test_zone_change_keeps_bet_in_one_report(
    db: AsyncSession, make_user: UserFactory, first: str, second: str
) -> None:
    """Ставка рассчитана 11 окт 20:00 UTC, пояс меняется 12 окт: она ровно в одном отчете
    (без продолжения недели — в 0 или в 2)."""
    user = await _old(db, await make_user(tz=first))
    await _bet_settled_at(db, user, datetime(2026, 10, 11, 20, tzinfo=UTC))
    one = await weekly.make_report(
        db, user, week_of(date(2026, 10, 5), first), now=datetime(2026, 10, 12, 15, tzinfo=UTC)
    )
    assert one is not None
    user.tz = second
    await db.commit()
    two = await weekly.make_report(
        db, user, week_of(date(2026, 10, 12), second), now=datetime(2026, 10, 19, 20, tzinfo=UTC)
    )
    assert two is not None
    counted = one.payload["bets"]["settled"] + two.payload["bets"]["settled"]
    assert counted == 1
    # Следующая неделя начинается там, где кончилась прошлая
    assert two.payload["begin"] == one.payload["finish"]


async def test_far_previous_report_does_not_stretch_week(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Прошлый отчет давний (воркер стоял) — неделя по своим границам, а не с того отчета."""
    user = await _old(db, await make_user())
    await weekly.make_report(
        db, user, week_of(date(2026, 9, 7), user.tz), now=datetime(2026, 9, 14, 5, tzinfo=UTC)
    )
    week = week_of(date(2026, 10, 5), user.tz)
    report = await weekly.make_report(db, user, week, now=datetime(2026, 10, 12, 5, tzinfo=UTC))
    assert report is not None and report.payload["begin"] == week.begin.isoformat()


async def test_waiting_bets_title(db: AsyncSession, make_user: UserFactory) -> None:
    """Ставки поставлены, но не рассчитаны — не «ставок не было», а «ждут результата»."""
    user = await _old(db, await make_user())
    await BetMaker(db).bet(user, [LegSpec()], placed_at=datetime(2026, 10, 8, 12, tzinfo=UTC))
    report = await weekly.make_report(
        db, user, week_of(date(2026, 10, 5), user.tz), now=datetime(2026, 10, 12, 5, tzinfo=UTC)
    )
    assert report is not None and report.payload["empty"] is True
    [note] = await db.scalars(select(Notification).where(Notification.user_id == user.id))
    assert note.params["variant"] == "waiting"
    assert note.title == "Отчет за неделю 5–11 окт: ставки ждут результата"
    assert "поставлено за неделю — 1, ждут результата — 1" in note.body


async def test_one_failing_user_does_not_stop_others(
    db: AsyncSession, make_user: UserFactory, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = await _old(db, await make_user())
    broken = await _old(db, await make_user())
    last = await _old(db, await make_user())
    first_id, broken_id, last_id = first.id, broken.id, last.id
    original = weekly.build_payload

    async def payload(db: AsyncSession, user: User, week: Any, **kwargs: Any) -> dict[str, Any]:
        if user.id == broken_id:
            raise RuntimeError("сбой на одном участнике")
        return await original(db, user, week, **kwargs)

    monkeypatch.setattr(weekly, "build_payload", payload)
    made = await weekly.send_due_reports(db, now=datetime(2026, 10, 12, 5, tzinfo=UTC))
    owners = set(await db.scalars(select(WeeklyReport.user_id)))
    assert len(made) == 2 and owners == {first_id, last_id}
    # Следующий запуск доделывает отчет того, у кого был сбой
    monkeypatch.setattr(weekly, "build_payload", original)
    again = await weekly.send_due_reports(db, now=datetime(2026, 10, 12, 6, tzinfo=UTC))
    assert len(again) == 1
    assert set(await db.scalars(select(WeeklyReport.user_id))) == {first_id, broken_id, last_id}


# --- прогон на наборе ---


async def test_run_cost_grows_with_chunks_and_stays_after_cancel(
    db: AsyncSession,
    world: dict[int, int],
    fake: FakeClaude,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    await _ready(db)
    admin = await admin_signed_in(make_client, make_user, login)
    await eval_sets.freeze(db, EvalSetIn(code="eval-test"), actor_id=admin.id)
    v3 = await strategy_versions.ensure_shared_active(db)
    await db.commit()
    v3_id = v3.id
    plan = (await admin.client.get(f"/api/admin/eval/runs/preview?version_id={v3_id}")).json()
    # Прошлых ответов проверок нет — цена по настройкам
    assert plan["estimate_source"] == "settings"

    run_id = await _start(db, admin.id, v3_id)
    assert await eval_runs.advance(db, run_id) == "running"
    await collect_all(db)
    run = await db.get_one(EvalRun, run_id, populate_existing=True)
    assert run.status == "pending"
    spent = (await eval_runs._run_costs(db, run_id))[0]
    assert spent > 0 and run.cost_usd == spent
    shown = (await admin.client.get(f"/api/admin/eval/runs/{run_id}")).json()
    assert shown["status"] == "pending" and D(str(shown["cost_usd"])) == spent

    stop = await admin.client.post(f"/api/admin/eval/runs/{run_id}/cancel")
    assert stop.status_code == 200 and stop.json()["status"] == "abandoned"
    assert D(str(stop.json()["cost_usd"])) == spent
    listed = (await admin.client.get("/api/admin/eval/runs")).json()["items"]
    assert D(str(next(item for item in listed if item["id"] == run_id)["cost_usd"])) == spent
    plan = (await admin.client.get(f"/api/admin/eval/runs/preview?version_id={v3_id}")).json()
    assert plan["estimate_source"] == "live"


# --- «ИИ и расходы» ---


async def test_before_after_prices_on_one_basis_and_version_name(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    admin = (await make_user(role="admin")).user
    member = (await make_user()).user
    _, v4 = await _versions(db, admin)
    await db.execute(
        update(StrategyVersion).where(StrategyVersion.id == v4.id).values(name="v4 · сжатое досье")
    )
    await db.commit()
    await _calls(db, member)

    out = await ai_usage.usage(db, member, now=NOW)
    pair = out.before_after
    assert pair is not None and pair.price_source == "eval"
    # Обе цены — из прогонов на одном наборе, а не живая против прогонной
    assert (pair.before.price_usd, pair.after.price_usd) == (D("0.012"), D("0.0084"))
    assert pair.after.name == "v4 · сжатое досье"
    saving = next(item for item in out.savings if item.kind == "version")
    assert saving.version_name == "v4 · сжатое досье"


def _evaluated(code: str, cost: str | None) -> VersionEvalOut:
    return VersionEvalOut(
        eval_set_code=code,
        runs=1,
        run_ids=[1],
        n=100,
        log_loss=0.6,
        brier=0.2,
        ece=0.03,
        format_errors=0,
        max_tokens=0,
        refusals=0,
        to_market=None,
        noise=None,
        tokens_per_event=None,
        cost_per_event_usd=D(cost) if cost is not None else None,
    )


def test_price_source_never_mixes_bases() -> None:
    a, b = _evaluated("s", "0.01"), _evaluated("s", "0.02")
    assert ai_savings._price_source(a, b, D("0.03"), None) == "eval"
    no_cost = _evaluated("s", None)
    assert ai_savings._price_source(no_cost, b, D("0.03"), D("0.04")) == "live"
    assert ai_savings._price_source(no_cost, b, D("0.03"), None) is None
    assert ai_savings._price_source(a, _evaluated("other", "0.02"), None, None) is None


async def test_new_set_hides_old_comparison(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    """После новой заморозки сравнение со старого набора не смешивается с метриками
    нового: пары нет, мера «экономия» — еще не проверена."""
    admin = (await make_user(role="admin")).user
    member = (await make_user()).user
    await _versions(db, admin)
    db.add(
        EvalSet(
            code="eval-nov",
            frozen_at=datetime(2026, 10, 10, tzinfo=UTC),
            sha256="1" * 64,
            n_events=250,
            since=date(2026, 9, 1),
            rules={},
        )
    )
    await db.commit()
    out = await ai_usage.usage(db, member, now=NOW)
    assert out.before_after is None
    saving = next(item for item in out.savings if item.kind == "version")
    assert saving.status == "unchecked" and saving.log_loss is None


async def test_quality_from_version_with_run(
    db: AsyncSession, make_user: UserFactory, prices: None
) -> None:
    """Тот же промпт у кандидата с прогоном и у нового отклоненного без прогона: качество —
    у версии с прогоном."""
    admin = (await make_user(role="admin")).user
    member = (await make_user()).user
    await _versions(db, admin)
    db.add(
        StrategyVersion(
            user_id=None,
            code="v5",
            name="v5",
            params={},
            prompt_version=CANDIDATE_PROMPT,
            status="rejected",
        )
    )
    db.add(
        _run(
            member.id,
            "analysis",
            "0.0500",
            datetime(2026, 10, 9, tzinfo=UTC),
            prompt_version=CANDIDATE_PROMPT,
        )
    )
    await db.commit()
    out = await ai_usage.usage(db, member, now=NOW)
    row = next(item for item in out.versions if item.prompt_version == CANDIDATE_PROMPT)
    assert row.version_code == "v4"
    assert row.quality is not None and row.quality.log_loss == 0.602


# --- правила суммы ставки ---


async def test_rule_check_keeps_first_bet_of_new_member(
    db: AsyncSession, make_user: UserFactory
) -> None:
    """Начальный банк записан тем же моментом, что первая ставка: она в проверке; дата
    начала проверки — день первой ставки по поясу участника."""
    member = (await make_user(tz="Europe/Helsinki")).user
    maker = BetMaker(db)
    first_at = datetime(2026, 10, 4, 22, 30, tzinfo=UTC)
    # Проверка правил — по экспрессам стратегии (Р29): одиночные ставки помечены strategy
    first = await maker.bet(member, [LegSpec()], placed_at=first_at, deposit=None, kind="strategy")
    db.add(
        BankrollLedger(
            user_id=member.id, at=first_at, kind="deposit", amount=D("10000"), currency="RUB"
        )
    )
    await db.commit()
    second = await maker.bet(
        member, [LegSpec()], placed_at=datetime(2026, 10, 6, 12, tzinfo=UTC), kind="strategy"
    )
    await _settle(db, first, when=datetime(2026, 10, 5, 20, tzinfo=UTC), status="won")
    await _settle(db, second, when=datetime(2026, 10, 7, 20, tzinfo=UTC), status="lost")

    params = StrategyParams()
    check = await check_rules(db, member.id, params, params)
    assert check["bets"] == 2
    # 22:30 UTC 4 окт — уже 5 окт в Хельсинки
    assert check["since"] == "2026-10-05"
    empty = await check_rules(db, (await make_user()).user.id, params, params)
    assert empty["bets"] == 0 and empty["since"] is not None


async def test_initial_rules_can_be_returned(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Исходные правила участника без approved_at (строки до волны 4) возвращаются; история
    старого бота — нет."""
    owner = await signed_in(make_client, make_user, login)
    made = await owner.client.post("/api/strategy/versions", json={"adapt": {"week_loss": False}})
    assert made.status_code == 201, made.text
    on = await owner.client.post(f"/api/strategy/versions/{made.json()['id']}/activate")
    assert on.status_code == 200
    initial = await db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.user_id == owner.user.id, StrategyVersion.code == "v3"
        )
    )
    assert initial is not None and initial.status == "archived"
    initial.approved_at = None
    legacy = StrategyVersion(user_id=owner.user.id, code="legacy", name="бот", status="archived")
    db.add(legacy)
    await db.commit()

    listing = (await owner.client.get("/api/strategy/versions")).json()["rules"]
    by_code = {item["code"]: item for item in listing}
    assert by_code["v3"]["can_rollback"] is True
    assert "legacy" not in by_code or by_code["legacy"]["can_rollback"] is False
    denied = await owner.client.post(f"/api/strategy/versions/{legacy.id}/rollback")
    assert denied.status_code == 409 and error_code(denied) == "strategy.cannot_rollback"
    back = await owner.client.post(f"/api/strategy/versions/{initial.id}/rollback")
    assert back.status_code == 200 and back.json()["status"] == "active"
    rules = (await owner.client.get("/api/strategy/versions")).json()["rules"]
    candidate = next(item for item in rules if item["code"] != "v3" and item["check"])
    assert candidate["check"]["since"] is not None


# --- базовая модель ---


async def test_manual_recalibration_is_not_auto(
    db: AsyncSession,
    ml_world: None,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    from app.services import recalibration

    admin = await admin_signed_in(make_client, make_user, login)
    manual = await recalibration.recalibrate(db, actor_id=admin.user.id, today=TODAY)
    assert manual.decision == "activated" and manual.version is not None
    assert manual.version.auto is False
    model = (await admin.client.get("/api/ml/model")).json()
    assert model["active"]["auto"] is False
    summary = (await admin.client.get("/api/learning")).json()
    assert summary["model"]["auto"] is False


# --- выгрузка JSONL ---


async def test_jsonl_export_admin_only_without_member_predictions(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    when = datetime(2026, 10, 6, 12, tzinfo=UTC)
    own = await maker.bet(admin.user, [LegSpec(names=("Jannik Sinner", "Carlos Alcaraz"))])
    await maker.bet(member.user, [LegSpec()], placed_at=when)
    archive = await maker.bet(member.user, [LegSpec(is_eval=True, p_final=0.55)], placed_at=when)
    own_pred = await db.scalar(select(Prediction).where(Prediction.user_id == admin.user.id))
    assert own_pred is not None
    match = await db.get_one(Match, own_pred.match_id)
    match.winner_id = match.player1_id
    fixed = Prediction(
        user_id=admin.user.id,
        match_id=own_pred.match_id,
        market="ML",
        selection=1,
        as_of=own_pred.as_of,
        p_final=0.7,
        supersedes=own_pred.id,
    )
    db.add(fixed)
    await db.commit()
    archive_pred = await db.scalar(
        select(Prediction.id).where(Prediction.is_eval.is_(True), Prediction.user_id.is_not(None))
    )
    assert own.id and archive.id

    denied = await member.client.get("/api/admin/ml/export.jsonl")
    assert denied.status_code == 403
    response = await admin.client.get("/api/admin/ml/export.jsonl")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/x-ndjson")
    assert "snapshots.jsonl" in response.headers["content-disposition"]
    rows = [json.loads(line) for line in response.text.splitlines()]
    # Исправленный прогноз — последней строкой цепочки; прогноз участника не выгружается
    assert {row["prediction_id"] for row in rows} == {fixed.id, archive_pred}
    mine = next(row for row in rows if row["prediction_id"] == fixed.id)
    assert (mine["source"], mine["outcome"], mine["p_final"]) == ("own", 1, 0.7)
    assert next(row for row in rows if row["source"] == "eval")["outcome"] is None
    assert "Sinner" not in response.text and "player1_id" not in response.text
