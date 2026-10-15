"""Заявки волны 6 этапа 4 к серверу: числа кабинета «Данные» (GET /api/me/export/summary),
пороги сигналов расхода ИИ в настройках уведомлений (alert_rules), свежесть архива в делах
администратора и когда архив свежий (archive_status), ссылка у data_stale, смена часового
пояса по умолчанию в журнале администратора (settings_change)."""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.db.models import AgentRun, Bet, BetLeg, IngestionRun, Notification
from app.services.ai_alerts import RULES
from app.workers.jobs import STALE_LINK, notify_stale_data
from tests.helpers_admin import admin_signed_in, audit_entries, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory

# --- «Данные»: что войдет в экспорт и статус импорта бота ---


async def _run(db: AsyncSession, user_id: int) -> None:
    db.add(
        AgentRun(
            user_id=user_id,
            key_source="admin",
            kind="parse",
            model="claude-haiku-5-5",
            input_tokens=10,
            output_tokens=2,
            cost_usd=Decimal("0.001"),
        )
    )


async def test_export_summary_counts_only_own(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Ставки (в игре, из бота), события, свои вызовы Claude, период ставок бота по поясу
    участника и ноги рассчитанных экспрессов бота без исхода. Чужое не считается."""
    member = await signed_in(make_client, make_user, login, tz="Asia/Tokyo")
    other = await make_user(email="other@example.com")
    maker = BetMaker(db)
    await maker.bet(member.user, [LegSpec()])
    # Бот: экспресс из 3 событий проигран, у двух ног исход не записан; ставка в 23:30 UTC
    # по Токио — уже следующий день
    first = datetime(2025, 3, 1, 23, 30, tzinfo=UTC)
    lost = await maker.bet(
        member.user, [LegSpec(), LegSpec(), LegSpec()], source="legacy", placed_at=first
    )
    won = await maker.bet(
        member.user, [LegSpec()], source="legacy", placed_at=datetime(2025, 9, 10, 9, tzinfo=UTC)
    )
    await db.execute(update(Bet).where(Bet.id.in_([lost.id, won.id])).values(status="lost"))
    lost_legs = list(
        await db.scalars(select(BetLeg.id).where(BetLeg.bet_id == lost.id).order_by(BetLeg.id))
    )
    await db.execute(update(BetLeg).where(BetLeg.id == lost_legs[0]).values(result="loss"))
    await db.execute(update(BetLeg).where(BetLeg.bet_id == won.id).values(result="loss"))
    await _run(db, member.id)
    await _run(db, member.id)
    # Чужие ставка бота и вызов Claude
    await maker.bet(other, [LegSpec(), LegSpec()], source="legacy")
    await _run(db, other.id)
    await db.commit()

    response = await member.client.get("/api/me/export/summary")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "bets": 3,
        "open_bets": 1,
        "legacy_bets": 2,
        "events": 5,
        "ai_runs": 2,
        "legacy_period": {"first": "2025-03-02", "last": "2025-09-10"},
        "legacy_no_result": 2,
    }


async def test_export_summary_empty_and_rights(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/me/export/summary")).json()
    assert body["bets"] == body["events"] == body["ai_runs"] == body["legacy_no_result"] == 0
    assert body["legacy_period"] is None
    anonymous = await make_client("10.0.0.9")
    assert (await anonymous.get("/api/me/export/summary")).status_code == 401


# --- пороги сигналов расхода ИИ ---


async def test_alert_rules_for_admin_only(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Пороги — те же числа, что проверяет воркер (RULES и настройки агента); у участника
    порогов нет, как и вида ai_alert."""
    admin = await admin_signed_in(make_client, make_user, login)
    body = (await admin.client.get("/api/me/notification-prefs")).json()
    config = await load_agent_config(db)
    assert body["alert_rules"] == {
        "cache_min_share": RULES.cache_min_share,
        "cache_analyses": RULES.cache_analyses,
        "cost_factor": float(RULES.cost_factor),
        "cost_window_days": RULES.cost_window.days,
        "stops_max_share": RULES.stops_max_share,
        "searches_per_day": config.news_max_searches_per_day,
        "rate_limit_series": RULES.rate_limit_series,
        "rate_limit_window_minutes": 60,
    }
    assert body["alert_rules"]["cache_min_share"] == 0.5
    assert body["alert_rules"]["searches_per_day"] == 30
    # PUT отвечает тем же видом ответа
    saved = await admin.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "ai_alert", "on_site": False}]}
    )
    assert saved.status_code == 200 and saved.json()["alert_rules"] == body["alert_rules"]
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    assert (await member.client.get("/api/me/notification-prefs")).json()["alert_rules"] is None


# --- свежесть архива и data_stale ---


def _load(source: str, ago: timedelta) -> IngestionRun:
    return IngestionRun(
        source=source,
        status="ok",
        finished_at=datetime.now(UTC) - ago,
        details={"files": {"x.csv": "new"}},
    )


async def test_archive_status_when_fresh_and_stale(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Архив свежий: дела «архив» нет, но порог и последняя загрузка есть (stale = false).
    Устарел — archive_status совпадает с делом archive и stale = true."""
    admin = await admin_signed_in(make_client, make_user, login)
    db.add(_load("sackmann", timedelta(days=1, hours=2)))
    db.add(_load("tennis_data", timedelta(hours=3)))
    await db.commit()
    fresh = (await admin.client.get("/api/admin/attention")).json()
    assert fresh["archive"] is None
    status = fresh["archive_status"]
    assert status["stale"] is False and status["stale_after_days"] == 3
    assert status["days"] == 1 and status["last_load"] is not None
    assert {item["source"] for item in status["sources"]} == {"sackmann", "tennis_data"}
    dashboard = (await admin.client.get("/api/dashboard")).json()
    assert dashboard["admin"]["archive_status"]["stale"] is False

    db.add(_load("sackmann", timedelta(days=0)))
    await db.execute(
        update(IngestionRun)
        .where(IngestionRun.source == "tennis_data")
        .values(finished_at=datetime.now(UTC) - timedelta(days=5))
    )
    await db.commit()
    stale = (await admin.client.get("/api/admin/attention")).json()
    assert stale["archive_status"]["stale"] is True and stale["archive_status"]["days"] == 5
    archive = dict(stale["archive_status"])
    del archive["stale"]
    assert stale["archive"] == archive


async def test_archive_status_is_admin_only(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    assert (await member.client.get("/api/admin/attention")).status_code == 403
    assert (await member.client.get("/api/dashboard")).json()["admin"] is None


async def test_data_stale_has_link_to_overview(db: AsyncSession, make_user: UserFactory) -> None:
    admin = await make_user(role="admin")
    sent = await notify_stale_data(db)
    assert sent == [admin.id]
    note = await db.scalar(select(Notification).where(Notification.kind == "data_stale"))
    assert note is not None and note.link == STALE_LINK == "/admin"


# --- журнал: часовой пояс по умолчанию ---


async def test_default_tz_change_in_audit(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Смена пояса — запись settings_change с прежним и новым поясом и IP; тот же пояс —
    без записи. Запись видна в журнале с фильтром по действию."""
    admin = await admin_signed_in(make_client, make_user, login)
    saved = await admin.client.put("/api/admin/settings", json={"default_tz": "Europe/Berlin"})
    assert saved.status_code == 200
    again = await admin.client.put("/api/admin/settings", json={"default_tz": "Europe/Berlin"})
    assert again.status_code == 200
    [entry] = await audit_entries(db, "settings_change")
    assert entry.actor_id == admin.id and entry.target_user_id is None
    assert entry.details == {
        "field": "default_tz",
        "from": "Europe/Helsinki",
        "to": "Europe/Berlin",
    }
    assert entry.ip is not None
    listed = await admin.client.get("/api/admin/audit", params={"action": "settings_change"})
    assert listed.status_code == 200, listed.text
    items = listed.json()
    assert [item["action"] for item in items] == ["settings_change"]
    assert items[0]["details"]["to"] == "Europe/Berlin"
