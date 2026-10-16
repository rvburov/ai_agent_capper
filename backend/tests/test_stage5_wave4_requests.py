"""Заявки к волне 4 этапа 5: новые виды уведомлений в «Что присылать» с группами,
отметкой «новое» и числами для подписей; порог «меньше 5» случаев урока — полем ответа;
smoke-eval этапа 3 — с system действующей версии инструкций (промпт и блок уроков)."""

from datetime import UTC, date, datetime

from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import load_agent_config
from app.agent.prompts import ANALYSIS_PROMPT, SystemPrompt, load_prompt
from app.ml.sets import Probs3
from app.services import smoke_eval
from app.services.lessons import PUBLIC_CASES_MIN
from app.services.notification_prefs import schedule_of
from tests.helpers_admin import signed_in
from tests.support import ClientFactory, LoginFn, UserFactory


def _groups(body: dict[str, object]) -> dict[str, tuple[str, bool, bool]]:
    items = body["items"]
    assert isinstance(items, list)
    return {item["kind"]: (item["group"], item["new"], item["admin"]) for item in items}


async def test_prefs_show_stage5_kinds_with_groups_and_schedule(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/me/notification-prefs")).json()
    kinds = _groups(body)
    # Участнику: ставка ждет результата и расхождение — одна строка, отчет недели
    assert kinds["bet_needs_result"] == ("needs", True, False)
    assert kinds["settle_conflict"] == ("needs", True, False)
    assert kinds["weekly_report"] == ("weekly", True, False)
    assert kinds["bet_settled"] == ("bet", False, False)
    assert "learning" not in kinds and "data_stale" not in kinds
    schedule = body["schedule"]
    assert (schedule["report_weekday"], schedule["report_hour"]) == (0, 7)
    assert schedule["settle_reminder_days"] == 3 and schedule["tz"] == "Europe/Helsinki"
    assert date.fromisoformat(schedule["next_report"]).weekday() == 0

    admin = await signed_in(make_client, make_user, login, role="admin", ip="10.0.0.7")
    kinds = _groups((await admin.client.get("/api/me/notification-prefs")).json())
    # Администратору: обучение модели (урок, кандидат, перекалибровка) и «пора загрузить файл»
    assert kinds["learning"] == ("learning", True, True)
    assert kinds["data_stale"] == ("archive", False, True)
    assert kinds["ai_alert"] == ("alert", True, True)
    assert kinds["weekly_report"] == ("weekly", True, False)


async def test_schedule_follows_member_zone(make_user: UserFactory) -> None:
    """Следующий отчет — понедельник по поясу: в понедельник до 07:00 — сегодня."""
    made = await make_user(tz="America/New_York")
    monday_night = datetime(2026, 10, 12, 10, 59, tzinfo=UTC)  # 06:59 в Нью-Йорке
    schedule = schedule_of(made.user, monday_night)
    assert schedule.next_report == date(2026, 10, 12) and schedule.tz == "America/New_York"
    assert schedule_of(made.user, datetime(2026, 10, 12, 11, 1, tzinfo=UTC)).next_report == date(
        2026, 10, 19
    )
    assert schedule.upload_hour == 7 and schedule.upload_stale_days == 7


async def test_lessons_answer_has_public_cases_threshold(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/lessons")).json()
    assert body["public_cases_min"] == PUBLIC_CASES_MIN == 5


async def test_smoke_request_sends_lessons_block(db: AsyncSession) -> None:
    """smoke-eval шлет system как анализ: промпт и блок уроков — каждый своей точкой кэша."""
    config = await load_agent_config(db)
    prompt = SystemPrompt(load_prompt(*ANALYSIS_PROMPT), "Уроки:\n- L-001: …", ("L-001",))
    event = smoke_eval.SmokeEvent(
        match_id=7,
        day=date(2026, 9, 1),
        flip=False,
        y=1,
        p1="A",
        p2="B",
        dossier_id=1,
        dossier_text="досье",
        as_of=datetime(2026, 9, 1, tzinfo=UTC),
        p_base=Probs3(0.6, 0.4, 0.7),
        refs=(),
        features={},
    )
    body = smoke_eval.batch_request(1, event, prompt, config)["params"]
    system = body["system"]
    assert isinstance(system, list) and len(system) == 2
    assert system[1]["text"].startswith("Уроки:")
    assert all(block["cache_control"] == {"type": "ephemeral", "ttl": "1h"} for block in system)
    plain = smoke_eval.batch_request(1, event, prompt.base, config)["params"]["system"]
    assert isinstance(plain, list) and len(plain) == 1
