"""Сигналы расхода ИИ (TOKEN_ECONOMY.md, раздел 6): каждое правило на синтетических
agent_runs и analyses, уведомление ai_alert только администраторам, одно на правило в
сутки, настройки уведомлений учитываются."""

from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import DEFAULT_CONFIG
from app.core.i18n import has_key
from app.db.models import (
    AgentRun,
    Analysis,
    AppSettings,
    ModelPrice,
    Notification,
    NotificationPref,
)
from app.services import ai_alerts
from app.services.sessions import utcnow
from tests.claude_mock import seed_prices
from tests.support import UserFactory

D = Decimal


def _run(**values: Any) -> AgentRun:
    base: dict[str, Any] = {
        "key_source": "admin",
        "kind": "analysis",
        "model": "claude-opus-5-5",
        "input_tokens": 1000,
        "output_tokens": 100,
        "cost_usd": D("0.10"),
    }
    base.update(values)
    return AgentRun(**base)


async def _analysis(db: AsyncSession, user_id: int, **values: Any) -> Analysis:
    row = Analysis(user_id=user_id, input_text="", input_kind="form", status="done", **values)
    db.add(row)
    await db.flush()
    return row


async def _rules(db: AsyncSession, now: datetime | None = None) -> set[str]:
    return {item.rule for item in await ai_alerts.evaluate(db, now=now)}


async def test_quiet_when_everything_is_fine(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db)
    member = await make_user()
    for _ in range(10):
        analysis = await _analysis(db, member.id, cost_usd=D("0.30"), finished_at=utcnow())
        db.add(
            _run(
                analysis_id=analysis.id,
                user_id=member.id,
                input_tokens=1000,
                cache_read_tokens=4000,
                stop_reason="end_turn",
            )
        )
    await db.commit()
    assert await _rules(db) == set()


async def test_cache_rule(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db)
    member = await make_user()
    analyses = [await _analysis(db, member.id) for _ in range(10)]
    for index, analysis in enumerate(analyses):
        # Доля кэша 40%: 400 из 1000 токенов входа
        db.add(
            _run(
                analysis_id=analysis.id,
                user_id=member.id,
                input_tokens=600,
                cache_read_tokens=400,
                created_at=utcnow() - timedelta(minutes=index),
            )
        )
    await db.commit()
    fired = {item.rule: item for item in await ai_alerts.evaluate(db)}
    assert fired["cache"].params == {"share": "40", "min": "50", "analyses": 10}
    # 9 анализов — мало для вывода
    await db.execute(
        update(AgentRun).where(AgentRun.analysis_id == analyses[0].id).values(kind="parse")
    )
    await db.commit()
    assert "cache" not in await _rules(db)


async def test_cost_rule(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db)
    member = await make_user()
    now = utcnow()
    for day in range(1, 6):
        await _analysis(db, member.id, cost_usd=D("0.20"), finished_at=now - timedelta(days=day))
    await db.commit()
    assert "cost" not in await _rules(db, now)
    # Сегодня анализ за $0,45 — больше двух медиан ($0,20)
    await _analysis(db, member.id, cost_usd=D("0.45"), finished_at=now - timedelta(hours=2))
    await db.commit()
    fired = {item.rule: item for item in await ai_alerts.evaluate(db, now=now)}
    assert fired["cost"].params["cost"] == "0.45" and fired["cost"].params["median"] == "0.20"
    # Ровно две медианы — еще не сигнал
    await db.execute(
        update(Analysis).where(Analysis.cost_usd == D("0.45")).values(cost_usd=D("0.40"))
    )
    await db.commit()
    assert "cost" not in await _rules(db, now)


async def test_stops_rule(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db)
    now = utcnow()
    db.add_all(_run(stop_reason="end_turn") for _ in range(49))
    db.add(_run(stop_reason="max_tokens"))
    # Проверочные прогоны и старые вызовы не считаются
    db.add(_run(kind="eval", stop_reason="refusal"))
    db.add(_run(stop_reason="refusal", created_at=now - timedelta(days=2)))
    await db.commit()
    # 1 из 50 — 2%, не больше порога
    assert "stops" not in await _rules(db, now)
    db.add(_run(stop_reason="refusal"))
    await db.commit()
    fired = {item.rule: item for item in await ai_alerts.evaluate(db, now=now)}
    assert fired["stops"].params == {"share": "3.9", "max": "2", "stopped": 2, "runs": 51}


async def test_searches_rule_uses_agent_setting(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db)
    limit = DEFAULT_CONFIG.news_max_searches_per_day
    assert limit == 30
    now = utcnow().replace(hour=12)
    db.add(_run(kind="news", model="claude-sonnet-5-5", web_searches=limit - 1, created_at=now))
    # Прогон приемки в дневной лимит не входит
    member = await make_user()
    acceptance = await _analysis(db, member.id, checkpoint={"acceptance": 1})
    db.add(
        _run(
            kind="news",
            model="claude-sonnet-5-5",
            web_searches=6,
            analysis_id=acceptance.id,
            created_at=now,
        )
    )
    await db.commit()
    assert "searches" not in await _rules(db, now)
    db.add(_run(kind="news", model="claude-sonnet-5-5", web_searches=1, created_at=now))
    await db.commit()
    fired = {item.rule: item for item in await ai_alerts.evaluate(db, now=now)}
    assert fired["searches"].params == {"searches": limit, "limit": limit}
    # Порог берется из настроек агента
    await db.execute(
        update(AppSettings).values(agent_config={"news_max_searches_per_day": limit + 5})
    )
    await db.commit()
    assert "searches" not in await _rules(db, now)


async def test_no_price_rule(db: AsyncSession) -> None:
    await seed_prices(db, "claude-haiku-5-5", "claude-sonnet-5-5")
    fired = {item.rule: item for item in await ai_alerts.evaluate(db)}
    assert fired["no_price"].params == {"models": "claude-opus-5-5"}
    await seed_prices(db, "claude-opus-5-5")
    assert "no_price" not in await _rules(db)
    assert await db.scalar(select(ModelPrice.model).where(ModelPrice.model == "claude-opus-5-5"))


async def test_rate_limit_rule(db: AsyncSession) -> None:
    await seed_prices(db)
    now = utcnow()
    db.add(_run(error="429:rate_limit_error", created_at=now - timedelta(minutes=90)))
    db.add(_run(error="429:rate_limit_error"))
    db.add(_run(error="rate_limit_error | Number of request tokens has exceeded"))
    await db.commit()
    assert "rate_limit" not in await _rules(db, now)
    db.add(_run(error="429:rate_limit_error"))
    await db.commit()
    fired = {item.rule: item for item in await ai_alerts.evaluate(db, now=now)}
    assert fired["rate_limit"].params == {"errors": 3, "minutes": 60}


async def test_check_runs_and_acceptance_not_in_rules(
    make_user: UserFactory, db: AsyncSession
) -> None:
    """Проверки качества (eval, shadow) не дают 429-сигнал; прогоны приемки не входят в
    цену анализа и долю кэша."""
    await seed_prices(db)
    member = await make_user()
    now = utcnow()
    for kind in ("eval", "shadow", "eval"):
        db.add(_run(kind=kind, error="429:rate_limit_error"))
    for day in range(1, 7):
        await _analysis(db, member.id, cost_usd=D("0.30"), finished_at=now - timedelta(days=day))
    # Прогон приемки: дорогой анализ сегодня и 10 анализов без кэша
    await _analysis(
        db, member.id, cost_usd=D("2.00"), finished_at=now, checkpoint={"acceptance": 1}
    )
    for index in range(10):
        accepted = await _analysis(db, member.id, checkpoint={"acceptance": 1})
        db.add(
            _run(
                analysis_id=accepted.id,
                user_id=member.id,
                created_at=now - timedelta(minutes=index),
            )
        )
    await db.commit()
    assert not {"rate_limit", "cost", "cache"} & await _rules(db, now)
    # Та же серия 429 у рабочих вызовов — сигнал
    for _ in range(3):
        db.add(_run(error="429:rate_limit_error"))
    await db.commit()
    assert "rate_limit" in await _rules(db, now)


async def test_notifications_to_admins_once_a_day(make_user: UserFactory, db: AsyncSession) -> None:
    await seed_prices(db, "claude-haiku-5-5", "claude-sonnet-5-5")
    first = await make_user(role="admin")
    second = await make_user(role="admin")
    member = await make_user()
    await make_user(role="admin", status="blocked")
    # Второй администратор выключил сигналы расхода
    db.add(NotificationPref(user_id=second.id, kind="ai_alert", on_site=False))
    await db.commit()
    now = utcnow()
    assert await ai_alerts.run_checks(db, now=now) == ["no_price"]
    notes = list(await db.scalars(select(Notification).where(Notification.kind == "ai_alert")))
    assert [note.user_id for note in notes] == [first.id]
    note = notes[0]
    assert note.params["rule"] == "no_price" and note.params["variant"] == "no_price"
    assert "claude-opus-5-5" in note.body and note.link == "/costs"
    assert note.user_id != member.id
    # Через час — правило еще действует, но второго уведомления нет; через сутки — есть
    await ai_alerts.run_checks(db, now=now + timedelta(hours=1))
    await ai_alerts.run_checks(db, now=now + timedelta(hours=24))
    count = len(
        list(await db.scalars(select(Notification.id).where(Notification.kind == "ai_alert")))
    )
    assert count == 2


def test_every_rule_has_texts() -> None:
    for rule in ai_alerts.RULE_NAMES:
        for part in ("title", "body"):
            assert has_key(f"notifications.ai_alert.{rule}.{part}"), rule
    assert len(ai_alerts.CHECKS) == len(ai_alerts.RULE_NAMES)
