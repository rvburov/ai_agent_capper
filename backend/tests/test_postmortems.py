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
    Dossier,
    Lesson,
    Match,
    MatchAssessment,
    Notification,
    Player,
    Postmortem,
)
from app.services import ai_access, lesson_check, postmortems
from app.workers.jobs import collect_all
from tests.analysis_helpers import install, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude, message
from tests.helpers_admin import signed_in
from tests.learning_helpers import MiniArchive, mini_archive, own_leg, reviews_from, upset
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
def fake() -> Iterator[FakeClaude]:
    yield from install(FakeClaude())


@pytest.fixture
async def world(db: AsyncSession, engine: AsyncEngine) -> MiniArchive:
    found = await mini_archive(db, engine)
    await reviews_from(db)
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
        and run.prompt_version == "postmortem.v2"
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


async def _dossier_in_order(
    db: AsyncSession,
    match: Match,
    first: int,
    second: int,
    *,
    p1_win: float,
    p1_claude: float,
    ids: tuple[int, int] | None = None,
) -> Dossier:
    """Досье анализа в его порядке игроков (first — игрок 1 анализа) и общая оценка Claude
    по нему; ids — id игроков в досье, если они уже не те (игроков потом слили). commit."""
    rows = await db.execute(select(Player.id, Player.name).where(Player.id.in_((first, second))))
    names = {player_id: name for player_id, name in rows}
    shown = ids or (first, second)
    dossier = Dossier(
        match_id=match.id,
        as_of=datetime(2026, 5, 19, 12, 0, tzinfo=UTC),
        content={
            "v": "test",
            "match": {"id": match.id, "surface": "clay", "bo": 3},
            "p_base": {
                "p1_win": p1_win,
                "p1_cover": round(p1_win - 0.15, 3),
                "p2_cover": round(0.85 - p1_win, 3),
                "elo_p": p1_win,
                "cal": True,
            },
            "p1": {"id": shown[0], "name": names[first], "elo": {"all": 1700 + first}},
            "p2": {"id": shown[1], "name": names[second], "elo": {"all": 1700 + second}},
            # Игрок 1 досье выиграл две встречи из трех, последнюю — тоже
            "h2h": {
                "n": 3,
                "p1": 2,
                "p2": 1,
                "surf": {"n": 1, "p1": 1, "p2": 0},
                "last": [{"d": "2026-01-10", "w": 1, "sc": "6-4 6-4"}],
            },
            "refs": {"elo": "p1.elo p2.elo", "news:7": "p1.news"},
        },
        sha256=f"{match.id:08d}{first:08d}{second:08d}".ljust(64, "0"),
        feature_set="test",
    )
    db.add(dossier)
    await db.flush()
    db.add(
        MatchAssessment(
            dossier_id=dossier.id,
            model="claude-opus-5-5",
            effort="high",
            prompt_version="analysis.v3",
            schema_version="a1",
            output={"p1_win": p1_claude, "p1_cover": 0.4, "p2_cover": 0.1},
        )
    )
    await db.commit()
    return dossier


@pytest.mark.parametrize("favorite_won", [True, False], ids=["favorite-won", "favorite-lost"])
@pytest.mark.parametrize("reverse", [False, True], ids=["same-order", "reverse-order"])
async def test_dossier_order_against_archive(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
    reverse: bool,
    favorite_won: bool,
) -> None:
    """Досье — в порядке игроков анализа, сторона и исход — по матчу архива (в tennis-data
    первым идет победитель): при обратном порядке вероятности досье переворачиваются.
    Полуфинал m3: A (игрок 1 архива) обыграл B."""
    member = await signed_in(make_client, make_user, login)
    favorite = world.a if favorite_won else world.b
    first, second = (world.b, world.a) if reverse else (world.a, world.b)
    # Досье и оценка Claude: фаворит анализа — 0,8 и 0,75
    p1_win, p1_claude = (0.8, 0.75) if first == favorite else (0.2, 0.25)
    await _dossier_in_order(db, world.m3, first, second, p1_win=p1_win, p1_claude=p1_claude)
    # Ставка на фаворита, сторона — по матчу архива
    selection = 1 if favorite == world.a else 2
    bet, _, _ = await own_leg(
        db,
        member.id,
        world.m3,
        selection=selection,
        result="win" if favorite_won else "loss",
    )

    await _submit(db)
    [body] = [body for batch in fake.batches.values() for body in batch["requests"]]
    facts = json.loads(body["params"]["messages"][0]["content"][0]["text"])
    assert facts["subject"] == {"market": "ML", "side": selection, "won": favorite_won}
    assert facts["model"]["p_base"] == 0.8 and facts["model"]["p_claude"] == 0.75
    assert facts["match"]["winner"] == 1 and facts["match"]["p1"] == "Arno Aalto"
    # Досье в фактах — в порядке матча архива: p1 досье — игрок 1 матча, числа согласованы
    shown = facts["dossier"]
    assert shown["p1"]["name"] == facts["match"]["p1"] == "Arno Aalto"
    assert shown["p2"]["name"] == facts["match"]["p2"] == "Boris Berg"
    assert shown["p1"]["elo"] == {"all": 1700 + world.a}
    p_side = shown["p_base"]["p1_win"] if selection == 1 else 1 - shown["p_base"]["p1_win"]
    assert round(p_side, 3) == facts["model"]["p_base"] == 0.8
    assert shown["p_base"]["elo_p"] == shown["p_base"]["p1_win"]
    assert shown["p_base"]["p1_cover"] == round(shown["p_base"]["p1_win"] - 0.15, 3)
    h2h_first = (1, 2) if reverse else (2, 1)
    assert (shown["h2h"]["p1"], shown["h2h"]["p2"]) == h2h_first
    assert shown["h2h"]["last"][0]["w"] == (2 if reverse else 1)
    assert shown["refs"]["news:7"] == ("p2.news" if reverse else "p1.news")
    await collect_all(db)

    pm = await db.scalar(select(Postmortem))
    assert pm is not None and pm.status == "done"
    assert (pm.side, pm.winner) == (selection, 1)
    review = (await member.client.get(f"/api/bets/{bet.id}/review")).json()
    [leg] = review["legs"]
    assert leg["same_pick"] is True and leg["selection"] == selection
    if favorite_won:
        # Прогноз подтвердился, гипотезы нет
        assert pm.verdict == "fine" and pm.lesson_id is None
        assert leg["verdict"] == "fine" and leg["lesson"] is None
    else:
        # Фаворит проиграл: ошибка модели и урок-гипотеза
        assert pm.verdict == "model_error" and pm.lesson_id is not None
        assert leg["verdict"] == "model_error" and leg["lesson"]["status"] == "hypothesis"


async def test_dossier_order_by_name_after_player_merge(
    db: AsyncSession, world: MiniArchive, fake: FakeClaude, make_user: UserFactory
) -> None:
    """id игроков в досье устарели (игроков слили с игроками архива): порядок — по имени,
    в том числе по псевдониму; не понять — только Эло, без вероятностей досье."""
    member = await make_user()
    await upset(db, world.m3)  # B (игрок 2 архива) обыграл A
    player_b = await db.get_one(Player, world.b)
    player_b.aliases = ["Boris Berg Jr"]
    await db.commit()
    # Анализ «B — A», B — фаворит; id в досье — удаленных игроков
    dossier = await _dossier_in_order(
        db, world.m3, world.b, world.a, p1_win=0.7, p1_claude=0.65, ids=(990001, 990002)
    )
    dossier.content = {
        **dossier.content,
        "p1": {"id": 990001, "name": "Boris Berg Jr"},
    }
    await db.commit()
    await own_leg(db, member.id, world.m3, selection=2, result="win")
    await _submit(db)
    [body] = [body for batch in fake.batches.values() for body in batch["requests"]]
    facts = json.loads(body["params"]["messages"][0]["content"][0]["text"])
    assert facts["subject"] == {"market": "ML", "side": 2, "won": True}
    assert facts["model"]["p_base"] == 0.7 and facts["model"]["p_claude"] == 0.65
    assert facts["dossier"]["p1"]["name"] == "Arno Aalto"
    assert facts["dossier"]["p_base"]["p1_win"] == 0.3

    # Имен в досье нет среди игроков матча — вероятности досье не берутся
    elo = await lesson_check.match_sides(db, [world.m3.id])
    dossier.content = {
        **dossier.content,
        "p1": {"id": 990001, "name": "Someone Else"},
        "p2": {"id": 990002, "name": "Nobody"},
    }
    await db.commit()
    pm = await db.scalar(select(Postmortem))
    assert pm is not None
    found = await postmortems.facts_for(db, pm, elo)
    assert found is not None
    facts, won, side, winner = found
    assert side == 1 and winner == 2 and won is False  # фаворит по Эло — A
    assert facts["model"]["p_base"] == round(elo[(world.m3.id, 1)].p_base, 3)
    assert facts["model"]["p_claude"] is None
    # Досье не в факты: порядок его игроков не понять
    assert facts["dossier"] is None


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


async def test_old_bets_are_not_reviewed_and_batch_is_capped(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """Очередь разборов берет только ставки, рассчитанные с postmortem_since: не задан —
    первый запуск записывает свой момент, рассчитанные раньше ставки (история, копия базы)
    не разбираются и на карточке — «Разбора нет» (before_start). В пакете — не больше
    postmortem_batch_max матчей, остальные ждут следующего."""
    await db.execute(update(AppSettings).values(agent_config={"postmortem_batch_max": 1}))
    await db.commit()
    member = await signed_in(make_client, make_user, login)
    # Рассчитаны 21 мая — до первого запуска очереди
    old_m2, _, _ = await own_leg(db, member.id, world.m2, result="loss")
    old_m3, _, _ = await own_leg(db, member.id, world.m3, result="win")
    start = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)

    summary = await postmortems.submit(db, now=start, force=True)
    assert (summary["queued"], summary["sent"]) == (0, 0)
    assert await db.scalar(select(func.count()).select_from(Postmortem)) == 0
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.agent_config["postmortem_since"] == start.isoformat()
    review = (await member.client.get(f"/api/bets/{old_m2.id}/review")).json()
    assert (review["state"], review["reason"], review["legs"]) == (
        "not_reviewed",
        "before_start",
        [],
    )

    # Рассчитаны после начала: оба матча в очереди, в пакете — один
    after = datetime(2026, 6, 2, 9, 0, tzinfo=UTC)
    new_m1, _, _ = await own_leg(db, member.id, world.m1, result="win", placed_at=after)
    new_m0, _, _ = await own_leg(db, member.id, world.m0, result="loss", placed_at=after)
    later = start + timedelta(days=3)
    summary = await postmortems.submit(db, now=later, force=True)
    assert (summary["queued"], summary["sent"]) == (2, 1)
    pms = list(await db.scalars(select(Postmortem).order_by(Postmortem.id)))
    assert {pm.match_id for pm in pms} == {world.m0.id, world.m1.id}
    assert {pm.bet_id for pm in pms} == {new_m0.id, new_m1.id}
    assert sorted(pm.status for pm in pms) == ["queued", "submitted"]
    # Момент начала не сдвигается следующими запусками
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.agent_config["postmortem_since"] == start.isoformat()
    summary = await postmortems.submit(db, now=later + timedelta(hours=2), force=True)
    assert (summary["queued"], summary["sent"]) == (0, 1)
    assert await db.scalar(select(func.count()).select_from(Postmortem)) == 2
    pending = (await member.client.get(f"/api/bets/{new_m1.id}/review")).json()
    assert pending["state"] == "pending"
    still_old = (await member.client.get(f"/api/bets/{old_m3.id}/review")).json()
    assert still_old["reason"] == "before_start"


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
