"""Разбор рассчитанных ставок ИИ и пакеты Batch (этап 5, волна 2) на поддельном Claude:
один разбор на матч (общий для участников, только по архиву и досье: без ставок, исходов
и анализов участников), вердикт по своей ноге кодом, запросы пакета без денег и текста
участника,
учет agent_runs (batch, request_id «пакет/запрос», цена со скидкой, без участника, вне
лимита участника), резерв худшего случая в общем бюджете, ожидание бюджета с
уведомлением, частичные ошибки и истекшие запросы (повтор), потерянный пакет, повторный
сбор без двойной записи, гипотеза — в урок, разбор для владельца ставки (чужая — 404)."""

import json
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from anthropic.types import Message
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.agent import batches
from app.agent.runs import cost_usd, price_for, usage_from
from app.db.models import (
    AgentRun,
    AppSettings,
    BatchJob,
    Bet,
    BetLeg,
    Lesson,
    Match,
    Notification,
    Postmortem,
)
from app.services import ai_access, postmortems
from app.workers.jobs import collect_all
from tests.analysis_helpers import install, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude, message
from tests.helpers_admin import signed_in
from tests.learning_helpers import MiniArchive, mini_archive, own_leg, upset
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> MiniArchive:
    found = await mini_archive(db, engine)
    await set_admin_key(db)
    await seed_prices(db)
    return found


async def _submit(db: AsyncSession) -> dict[str, object]:
    return await postmortems.submit(db, force=True)


async def test_one_review_per_match_shared_and_costed(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    admin = await make_user(role="admin")
    first = await signed_in(make_client, make_user, login, email="first@example.com")
    second = await signed_in(make_client, make_user, login, email="second@example.com")
    stranger = await signed_in(make_client, make_user, login, email="stranger@example.com")
    # Две ставки на полуфинал (у первого — раньше): разбор один, по прогнозу первого
    won_bet, won_leg, won_pred = await own_leg(db, first.id, world.m3, result="win", odds="1.45")
    other_bet, _, _ = await own_leg(
        db,
        second.id,
        world.m3,
        result="win",
        placed_at=datetime(2026, 5, 20, 10, 0, tzinfo=UTC),
    )
    # Четвертьфинал выиграл аутсайдер: разбор по фавориту модели — ошибка модели, гипотеза
    await upset(db, world.m2)
    lost_bet, _, _ = await own_leg(db, first.id, world.m2, result="loss")
    # Не разбираются: возврат, ставка старого бота
    void_bet, _, _ = await own_leg(db, first.id, world.m1, result="void")
    await own_leg(db, first.id, world.m0, result="loss", source="legacy")

    summary = await _submit(db)
    assert summary["queued"] == 2 and summary["sent"] == 2
    pms = list(await db.scalars(select(Postmortem).order_by(Postmortem.id)))
    assert [(pm.match_id, pm.status) for pm in pms] == [
        (world.m2.id, "submitted"),
        (world.m3.id, "submitted"),
    ]
    by_match = {pm.match_id: pm for pm in pms}
    assert by_match[world.m3.id].prediction_id == won_pred.id
    assert by_match[world.m3.id].bet_id == won_bet.id and by_match[world.m3.id].user_id == first.id
    job = await db.scalar(select(BatchJob))
    assert job is not None and job.kind == "postmortem" and job.status == "submitted"
    assert job.requests == 2 and job.worst_usd > 0
    # Запросы: Sonnet 5.5, effort low, схема разбора, без поиска; без денег и букмекера
    calls = [body for batch in fake.batches.values() for body in batch["requests"]]
    assert [call["custom_id"] for call in calls] == [f"pm{pm.id}" for pm in pms]
    params = calls[1]["params"]
    assert params["model"] == "claude-sonnet-5-5" and "tools" not in params
    assert params["output_config"]["effort"] == "low"
    assert "verdict" in params["output_config"]["format"]["schema"]["properties"]
    facts = json.loads(params["messages"][0]["content"][0]["text"])
    # Разбирается фаворит базовой модели на победу в матче, исход — только из архива
    assert facts["subject"] == {"market": "ML", "side": 1, "won": True}
    assert "pick" not in facts and "explanation" not in facts
    assert set(facts["model"]) == {"p_base", "p_claude", "q_close", "close_gap"}
    assert facts["model"]["p_base"] > 0.5 and facts["model"]["p_claude"] is None
    assert 0.65 < facts["model"]["q_close"] < 0.75  # архив pinnacle 1.40 / 3.00 без маржи
    assert facts["match"]["p1"] == "Arno Aalto" and facts["match"]["score"] == "6-1 6-1"
    assert facts["match"]["winner"] == 1 and facts["match"]["round"] == "SF"
    assert facts["features"]["sets_48h"] == 5 and facts["features"]["role"] == "favorite"
    text = json.dumps(facts, ensure_ascii=False)
    for private in ("Fonbet", "1.45", "stake", "bank", "Преимущество в Эло", "p_final"):
        assert private not in text
    # Резерв худшего случая — в общем бюджете ключа администратора, не у участника
    settings = await db.get_one(AppSettings, 1)
    left = await ai_access.shared_budget_left(db)
    assert left == settings.monthly_budget_usd - job.worst_usd

    result = await collect_all(db)
    assert result["collected"] == 1
    await db.refresh(job)
    assert job.status == "collected" and job.cost_usd > 0
    runs = list(await db.scalars(select(AgentRun).order_by(AgentRun.id)))
    assert len(runs) == 2
    assert all(
        run.kind == "postmortem"
        and run.batch
        and run.user_id is None
        and run.key_source == "admin"
        and run.model == "claude-sonnet-5-5"
        and run.prompt_version == "postmortem.v1"
        and run.schema_version == "pm1"
        for run in runs
    )
    assert {run.request_id for run in runs} == {f"{job.batch_id}/pm{pm.id}" for pm in pms}
    price = await price_for(db, "claude-sonnet-5-5")
    usage = usage_from(
        Message.model_validate(
            message([], model="claude-sonnet-5-5", input_tokens=3000, output_tokens=600)
        )
    )
    assert runs[0].cost_usd == cost_usd(price, replace(usage, batch=True))
    assert job.cost_usd == sum((run.cost_usd for run in runs), Decimal(0))
    # Расход — в общем бюджете, в лимит участника не входит
    assert await ai_access.member_spent(db, first.id, datetime.now(UTC)) == 0
    assert await ai_access.shared_budget_left(db) == settings.monthly_budget_usd - job.cost_usd
    for pm in pms:
        await db.refresh(pm)
    won_pm, lost_pm = by_match[world.m3.id], by_match[world.m2.id]
    assert (won_pm.side, won_pm.winner, lost_pm.side, lost_pm.winner) == (1, 1, 1, 2)
    assert won_pm.status == "done" and won_pm.verdict == "fine" and won_pm.lesson_id is None
    assert won_pm.summary and won_pm.why and won_pm.hypothesis is None
    assert lost_pm.status == "done" and lost_pm.verdict == "model_error"
    lesson = await db.get_one(Lesson, lost_pm.lesson_id)
    assert (
        lesson.user_id is None and lesson.status == "hypothesis" and lesson.origin == "postmortem"
    )
    assert lesson.code == "L-001" and lesson.scope is not None
    assert lesson.scope["direction"] == "lower"
    assert lesson.source_prediction_ids == [lost_pm.prediction_id]
    assert lesson.source_bet_ids == [lost_bet.id]

    # Повторный сбор ничего не пишет второй раз
    again = await collect_all(db)
    assert again["collected"] == 0
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 2
    # Новых матчей нет — пакет не собирается
    assert (await _submit(db))["sent"] == 0

    # Разбор — только владельцу ставки; второй участник видит тот же разбор матча
    mine = (await first.client.get(f"/api/bets/{won_bet.id}/review")).json()
    assert mine["state"] == "done" and mine["clv_verdict"] == "no_closing"
    [leg] = mine["legs"]
    assert leg["leg_id"] == won_leg.id and leg["verdict"] == "fine" and leg["same_pick"]
    assert leg["won"] is True and leg["clv"] is None
    assert leg["model"] == "claude-sonnet-5-5" and leg["cost_usd"] > 0 and leg["what"]
    shared = (await second.client.get(f"/api/bets/{other_bet.id}/review")).json()
    assert shared["legs"][0]["what"] == leg["what"]
    lost = (await first.client.get(f"/api/bets/{lost_bet.id}/review")).json()
    assert lost["legs"][0]["verdict"] == "model_error" and lost["legs"][0]["won"] is False
    assert lost["legs"][0]["lesson"]["code"] == "L-001"
    assert lost["legs"][0]["lesson"]["need_cases"] == 20
    # Случаи урока — как на «Уроках» (заявка волны 3): общее число участнику — с 5, свои —
    # отдельно; администратору общее — всегда
    assert lost["legs"][0]["lesson"]["n_cases"] is None
    assert lost["legs"][0]["lesson"]["n_cases_few"] is True
    assert lost["legs"][0]["lesson"]["own_cases"] == 0
    lost_leg_id = await db.scalar(select(BetLeg.id).where(BetLeg.bet_id == lost_bet.id))
    lesson.n_cases = 7
    lesson.metrics = {**(lesson.metrics or {}), "own": {"leg_ids": [lost_leg_id]}}
    await db.commit()
    again_lost = (await first.client.get(f"/api/bets/{lost_bet.id}/review")).json()
    seen = again_lost["legs"][0]["lesson"]
    assert (seen["n_cases"], seen["n_cases_few"], seen["own_cases"]) == (7, False, 1)
    assert (await stranger.client.get(f"/api/bets/{won_bet.id}/review")).status_code == 404
    assert (await first.client.get("/api/bets/999999/review")).status_code == 404
    void = (await first.client.get(f"/api/bets/{void_bet.id}/review")).json()
    assert void == {
        "bet_id": void_bet.id,
        "state": "not_reviewed",
        "reason": "void",
        "clv_verdict": "void",
        "legs": [],
    }
    assert admin.id  # администратор не нужен для разбора, но есть в системе


async def test_review_states_before_batch(
    db: AsyncSession,
    world: MiniArchive,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    settled, _, _ = await own_leg(db, member.id, world.m3, result="loss")
    pending = (await member.client.get(f"/api/bets/{settled.id}/review")).json()
    assert pending["state"] == "pending" and pending["legs"][0]["status"] == "queued"
    await db.execute(update(Bet).where(Bet.id == settled.id).values(status="open"))
    await db.commit()
    opened = (await member.client.get(f"/api/bets/{settled.id}/review")).json()
    assert opened["state"] == "open" and opened["legs"] == []
    legacy, _, _ = await own_leg(db, member.id, world.m2, result="win", source="legacy")
    old = (await member.client.get(f"/api/bets/{legacy.id}/review")).json()
    assert (old["state"], old["reason"], old["clv_verdict"]) == (
        "not_reviewed",
        "legacy",
        "legacy",
    )


async def test_partial_errors_expired_and_retry(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    """Истекший запрос и сбой у Anthropic — разбор снова в очереди (не больше двух попыток),
    ответ не по проверкам кода — failed. Ошибки пакета не оплачиваются."""
    member = await make_user()
    for match in (world.m1, world.m2, world.m3):
        await own_leg(db, member.id, match, result="loss")
    fake.fail("batch", "expired")
    fake.fail("postmortem", "bad_checks")
    fake.fail("postmortem", "overloaded")
    assert (await _submit(db))["sent"] == 3
    await collect_all(db)
    pms = list(await db.scalars(select(Postmortem).order_by(Postmortem.id)))
    assert [pm.status for pm in pms] == ["queued", "failed", "queued"]
    runs = list(await db.scalars(select(AgentRun).order_by(AgentRun.id)))
    assert [run.error for run in runs] == [
        "batch:expired",
        "checks:verdict",
        "batch:overloaded_error",
    ]
    assert runs[0].cost_usd == 0 and runs[2].cost_usd == 0 and runs[1].cost_usd > 0
    # Вторая попытка: оба снова в пакете и разобраны
    assert (await _submit(db))["sent"] == 2
    await collect_all(db)
    for pm in pms:
        await db.refresh(pm)
    assert [pm.status for pm in pms] == ["done", "failed", "done"]
    assert await db.scalar(select(func.count()).select_from(AgentRun)) == 5
    # Третьей попытки нет: истекший второй раз — failed
    member2 = await make_user()
    extra = Match(
        tournament_id=world.m3.tournament_id,
        round="F",
        match_date=world.day + timedelta(days=1),
        player1_id=world.a,
        player2_id=world.c,
        winner_id=world.a,
        score="6-0 6-0",
        status="finished",
        best_of=3,
        source="sackmann",
        source_ref="mini-f",
    )
    db.add(extra)
    await db.commit()
    await own_leg(db, member2.id, extra, result="win")
    for _ in range(2):
        fake.fail("batch", "expired")
        await _submit(db)
        await collect_all(db)
    last = await db.scalar(select(Postmortem).where(Postmortem.match_id == extra.id))
    assert last is not None and last.status == "failed"


async def test_scope_outside_dictionary_keeps_text_without_lesson(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    member = await make_user()
    await upset(db, world.m3)
    await own_leg(db, member.id, world.m3, result="loss")
    fake.fail("postmortem", "bad_scope")
    await _submit(db)
    await collect_all(db)
    pm = await db.scalar(select(Postmortem))
    assert pm is not None and pm.status == "done" and pm.hypothesis and pm.scope is None
    assert pm.lesson_id is None
    assert await db.scalar(select(func.count()).select_from(Lesson)) == 0


async def test_same_hypothesis_joins_one_lesson(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    member = await make_user()
    await upset(db, world.m2)
    await upset(db, world.m3)
    _, _, p2 = await own_leg(db, member.id, world.m2, result="loss")
    _, _, p3 = await own_leg(db, member.id, world.m3, result="loss")
    await _submit(db)
    await collect_all(db)
    lessons = list(await db.scalars(select(Lesson)))
    assert len(lessons) == 1
    assert sorted(lessons[0].source_prediction_ids) == sorted([p2.id, p3.id])
    assert {pm.lesson_id for pm in await db.scalars(select(Postmortem))} == {lessons[0].id}


async def test_budget_wait_and_notice_once(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    admin = await make_user(role="admin")
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    await db.execute(update(AppSettings).values(monthly_budget_usd=Decimal("0.01")))
    await db.commit()
    summary = await _submit(db)
    assert summary["sent"] == 0 and summary["waiting"] == 1 and fake.batches == {}
    notes = list(await db.scalars(select(Notification).where(Notification.kind == "learning")))
    assert [(note.user_id, note.params["variant"]) for note in notes] == [
        (admin.id, "postmortem_budget")
    ]
    assert notes[0].link == "/admin/key" and "В очереди разборов: 1" in notes[0].body
    await _submit(db)
    assert await db.scalar(select(func.count()).select_from(Notification)) == 1
    pm = await db.scalar(select(Postmortem))
    assert pm is not None and pm.status == "queued"
    await db.execute(update(AppSettings).values(monthly_budget_usd=Decimal("60")))
    await db.commit()
    assert (await _submit(db))["sent"] == 1


async def test_cadence_and_disabled(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    assert (await postmortems.submit(db))["sent"] == 1
    await own_leg(db, member.id, world.m2, result="loss")
    # Прошлый пакет отправлен только что: следующий — через postmortem_every_minutes
    assert (await postmortems.submit(db))["skipped"] == "cadence"
    later = datetime.now(UTC) + timedelta(minutes=61)
    assert (await postmortems.submit(db, now=later))["sent"] == 1
    await db.execute(update(AppSettings).values(agent_config={"postmortem_enabled": False}))
    await db.commit()
    assert await postmortems.submit(db, force=True) == {"skipped": "disabled"}


async def test_lost_batch_requeues_and_keeps_reserve(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    fake.batch_polls = 100
    await _submit(db)
    assert (await collect_all(db))["collected"] == 0  # пакет в работе
    job = await db.scalar(select(BatchJob))
    assert job is not None and job.status == "submitted"
    fake.batches.clear()
    assert (await collect_all(db))["lost"] == 1
    await db.refresh(job)
    assert job.status == "lost" and job.error == batches.BATCH_NOT_FOUND
    pm = await db.scalar(select(Postmortem))
    assert pm is not None and pm.status == "queued" and pm.batch_job_id is None
    # Худший случай потерянного пакета — в резерве до конца месяца отправки
    assert await batches.reserved_usd(db, ("postmortem",)) == job.worst_usd


async def test_unsent_job_is_reaped(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    member = await make_user()
    await own_leg(db, member.id, world.m3, result="loss")
    await postmortems.queue(db)
    job = await batches.open_job(
        db, kind="postmortem", requests=1, worst_usd=Decimal("0.05"), params={}
    )
    pm = await db.scalar(select(Postmortem))
    assert pm is not None
    pm.status, pm.batch_job_id = "submitted", job.id
    await db.commit()
    assert await batches.reserved_usd(db, ("postmortem",)) == Decimal("0.0500")
    old = datetime.now(UTC) - timedelta(hours=2)
    await db.execute(update(BatchJob).values(created_at=old))
    await db.commit()
    assert await batches.reserved_usd(db, ("postmortem",)) == 0
    summary = await collect_all(db)
    assert summary["failed_sends"] == 1
    await db.refresh(job)
    await db.refresh(pm)
    assert job.status == "failed" and job.error == "not_sent"
    assert pm.status == "queued" and pm.batch_job_id is None


async def test_reserve_windows(db: AsyncSession) -> None:
    """Резерв пакета: pending — час, submitted — 29 дней или до конца месяца отправки, lost
    и abandoned — до конца месяца отправки, собранный и не ушедший — нет."""
    now = datetime(2026, 10, 31, 12, 0, tzinfo=UTC)
    rows = [
        ("pending", now - timedelta(minutes=10), None, "1"),
        ("pending", now - timedelta(hours=3), None, "2"),
        ("submitted", now, datetime(2026, 9, 20, tzinfo=UTC), "4"),  # 41 д. — нет
        ("submitted", now, datetime(2026, 10, 5, tzinfo=UTC), "8"),
        ("lost", now, datetime(2026, 9, 30, tzinfo=UTC), "16"),  # прошлый месяц — нет
        ("lost", now, datetime(2026, 10, 2, tzinfo=UTC), "32"),
        ("abandoned", now, datetime(2026, 10, 3, tzinfo=UTC), "64"),
        ("collected", now, datetime(2026, 10, 3, tzinfo=UTC), "128"),
        ("failed", now, None, "256"),
    ]
    for status, created, sent, worst in rows:
        db.add(
            BatchJob(
                kind="postmortem",
                status=status,
                worst_usd=Decimal(worst),
                created_at=created,
                submitted_at=sent,
            )
        )
    db.add(BatchJob(kind="eval", status="submitted", worst_usd=Decimal("512"), submitted_at=now))
    await db.commit()
    assert await batches.reserved_usd(db, ("postmortem",), now) == Decimal(1 + 8 + 32 + 64)
    assert await batches.reserved_usd(db, ("eval", "shadow"), now) == Decimal(512)
    later = datetime(2026, 11, 4, tzinfo=UTC)
    assert await batches.reserved_usd(db, ("postmortem",), later) == 0


async def test_cli_commands(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Команды терминала тем же кодом, что задачи воркера: разборы сейчас и проверка
    уроков."""
    import asyncio

    from app.admin import cli

    member = await make_user()
    await upset(db, world.m3)
    await own_leg(db, member.id, world.m3, result="loss")
    assert await asyncio.to_thread(cli.main, ["postmortems"]) == 0
    out = capsys.readouterr().out
    assert "в очередь 1, отправлено 1" in out and "собрано пакетов 1" in out
    pm = await db.scalar(select(Postmortem).execution_options(populate_existing=True))
    assert pm is not None and pm.status == "done"
    assert await asyncio.to_thread(cli.main, ["lessons-check"]) == 0
    assert "Уроки: проверено 1, готовы к решению 0" in capsys.readouterr().out
    assert await asyncio.to_thread(cli.main, ["lessons-check", "--recheck"]) == 0
    assert "Перепроверка уроков: проверено 0" in capsys.readouterr().out
