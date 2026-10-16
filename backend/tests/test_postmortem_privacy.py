"""Чужое не утекает через разборы и уроки (Р14, Т21; замечания M5, m2, m3, m5 проверки
backend волны 2 и №2 проверки экранов): общий разбор матча строится только по архиву и
досье, вердикт по своей ноге считает код, участник видит только свои случаи урока и не
предлагает процессный урок; исправленный архив ставит разбор в очередь заново."""

import json
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.db.models import Bet, Match, Postmortem, Prediction
from app.services import postmortems
from app.workers.jobs import collect_all
from tests.analysis_helpers import install, set_admin_key
from tests.claude_mock import seed_prices
from tests.fake_claude import FakeClaude
from tests.helpers_admin import admin_signed_in, signed_in
from tests.learning_helpers import MiniArchive, mini_archive, own_leg, reviews_from
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


def _facts(fake: FakeClaude) -> dict[str, object]:
    calls = [body for batch in fake.batches.values() for body in batch["requests"]]
    result: dict[str, object] = json.loads(calls[0]["params"]["messages"][0]["content"][0]["text"])
    return result


async def test_shared_review_does_not_follow_first_members_pick(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """А первым ставит на аутсайдера (проиграл), Б — на фаворита (выиграл). Разбор — про
    фаворита модели, а не про ставку А: в фактах нет ни стороны А, ни его вероятностей,
    кэфов и объяснения. Каждому вердикт по своей ноге."""
    first = await signed_in(make_client, make_user, login, email="a@example.com")
    second = await signed_in(make_client, make_user, login, email="b@example.com")
    bet_a, _, pred_a = await own_leg(db, first.id, world.m3, selection=2, p_final=0.43)
    await db.execute(
        update(Prediction)
        .where(Prediction.id == pred_a.id)
        .values(rationale="Личная заметка анализа А: беру крупно", q_market_at_pred=0.31)
    )
    await db.commit()
    bet_b, _, _ = await own_leg(
        db,
        second.id,
        world.m3,
        selection=1,
        result="win",
        placed_at=datetime(2026, 5, 20, 11, 0, tzinfo=UTC),
    )
    await postmortems.submit(db, force=True)
    facts = _facts(fake)
    assert facts["subject"] == {"market": "ML", "side": 1, "won": True}
    text = json.dumps(facts, ensure_ascii=False)
    for private in ("pick", "explanation", "Личная заметка", "0.43", "0.31", "q_market"):
        assert private not in text
    await collect_all(db)
    seen_b = (await second.client.get(f"/api/bets/{bet_b.id}/review")).json()
    [leg_b] = seen_b["legs"]
    assert (leg_b["selection"], leg_b["same_pick"], leg_b["won"]) == (1, True, True)
    assert leg_b["verdict"] == "fine"
    seen_a = (await first.client.get(f"/api/bets/{bet_a.id}/review")).json()
    [leg_a] = seen_a["legs"]
    # А видит, что разбирали фаворита модели (общее), его проигрыш — невезение по коду
    assert (leg_a["selection"], leg_a["same_pick"], leg_a["won"]) == (1, False, False)
    assert leg_a["verdict"] == "luck" and leg_a["what"] == leg_b["what"]


async def test_review_uses_archive_outcome_not_manual_result(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """№2: участник вручную внес выигрыш ставки на игрока 2, архив — победа игрока 1.
    Общий разбор — по архиву (фаворит выиграл); вердикт по ноге участника — по его
    исходу; матч без исхода архива в очередь не встает."""
    member = await signed_in(make_client, make_user, login)
    bet, _, _ = await own_leg(db, member.id, world.m3, selection=2, result="win")
    user_match = Match(
        tournament_id=world.m3.tournament_id,
        round="F",
        match_date=world.day,
        player1_id=world.a,
        player2_id=world.c,
        status="scheduled",
        source="user",
    )
    db.add(user_match)
    await db.commit()
    waiting, _, _ = await own_leg(db, member.id, user_match, result="win")
    summary = await postmortems.submit(db, force=True)
    assert summary["queued"] == 1 and summary["sent"] == 1
    facts = _facts(fake)
    assert facts["subject"] == {"market": "ML", "side": 1, "won": True}
    match_facts = facts["match"]
    assert isinstance(match_facts, dict) and match_facts["winner"] == 1
    await collect_all(db)
    pm = await db.scalar(select(Postmortem).where(Postmortem.match_id == world.m3.id))
    assert pm is not None and (pm.verdict, pm.side, pm.winner) == ("fine", 1, 1)
    review = (await member.client.get(f"/api/bets/{bet.id}/review")).json()
    [leg] = review["legs"]
    assert (leg["same_pick"], leg["won"], leg["verdict"]) == (False, True, "fine")
    pending = (await member.client.get(f"/api/bets/{waiting.id}/review")).json()
    assert pending["state"] == "pending" and pending["legs"][0]["status"] == "queued"


async def test_corrected_archive_requeues_review(
    db: AsyncSession,
    world: MiniArchive,
    fake: FakeClaude,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """m5: исправление результата ставки — вердикт по ноге пересчитывается сразу (код), а
    общий разбор, построенный на другом исходе архива, снова в очереди и уходит заново."""
    member = await signed_in(make_client, make_user, login)
    bet, _, _ = await own_leg(db, member.id, world.m3, selection=2, result="loss")
    await postmortems.submit(db, force=True)
    await collect_all(db)
    pm = await db.scalar(select(Postmortem))
    assert pm is not None and pm.status == "done" and pm.winner == 1
    # Исправление результата без смены архива — разбор остается, ставка снова открыта
    detail = (await member.client.get(f"/api/bets/{bet.id}")).json()
    answer = await member.client.post(
        f"/api/bets/{bet.id}/reverse", json={"expected_updated_at": detail["updated_at"]}
    )
    assert answer.status_code == 200, answer.text
    await db.refresh(pm)
    assert pm.status == "done"
    # Архив исправлен: победил игрок 2 — разбор, построенный на победе игрока 1, устарел
    await db.execute(update(Match).where(Match.id == world.m3.id).values(winner_id=world.b))
    await db.execute(
        update(Bet).where(Bet.id == bet.id).values(status="won", settled_at=datetime.now(UTC))
    )
    await db.commit()
    assert await postmortems.refresh_stale(db, [world.m3.id]) == 1
    await db.commit()
    await db.refresh(pm)
    assert (pm.status, pm.verdict, pm.summary, pm.winner) == ("queued", None, None, None)
    assert (await postmortems.submit(db, force=True))["sent"] == 1
    facts = json.loads(
        fake.batches["msgbatch_fake2"]["requests"][0]["params"]["messages"][0]["content"][0]["text"]
    )
    assert facts["subject"]["won"] is False


async def test_member_sees_only_own_cases_and_no_process_lessons(
    db: AsyncSession,
    world: MiniArchive,
    make_user: UserFactory,
    make_client: ClientFactory,
    login: LoginFn,
) -> None:
    """m2: по n_cases своего предложения участник не узнает, на что ставили другие
    (видит только свои случаи; администратор — все). m3: процессный урок предлагает
    только администратор."""
    other = await signed_in(make_client, make_user, login, email="a2@example.com")
    prober = await signed_in(make_client, make_user, login, email="p@example.com")
    admin = await admin_signed_in(make_client, make_user, login)
    await own_leg(db, other.id, world.m3, selection=1, result="win")
    scope = {
        "direction": "lower",
        "conditions": [
            {"feature": "surface", "op": "eq", "values": ["clay"]},
            {"feature": "round", "op": "eq", "values": ["SF"]},
            {"feature": "role", "op": "eq", "values": ["favorite"]},
        ],
    }
    made = await prober.client.post(
        "/api/lessons", json={"text": "Зондирующее условие для проверки", "scope": scope}
    )
    # Общее число (1) меньше 5 — участнику не показывается, только свои (№3 проверки
    # экранов волны 3); администратору — точно
    assert made.status_code == 201 and made.json()["n_cases"] is None
    assert made.json()["n_cases_few"] is True and made.json()["own_cases"] == 0
    lesson_id = made.json()["id"]
    seen_admin = (await admin.client.get(f"/api/lessons/{lesson_id}")).json()
    assert seen_admin["n_cases"] == 1
    listed = (await prober.client.get("/api/lessons")).json()
    [mine] = [item for item in listed["items"] if item["id"] == lesson_id]
    assert (mine["n_cases"], mine["own_cases"]) == (None, 0)
    seen_other = (await other.client.get(f"/api/lessons/{lesson_id}")).json()
    assert (seen_other["n_cases"], seen_other["own_cases"]) == (None, 1)

    process = {
        "text": "Процессный урок от участника: всегда верь фавориту",
        "kind": "process",
        "scope": {
            "direction": "raise",
            "conditions": [{"feature": "role", "op": "eq", "values": ["favorite"]}],
        },
    }
    refused = await prober.client.post("/api/lessons", json=process)
    assert refused.status_code == 422
    assert refused.json()["error"]["code"] == "lesson.process_admin_only"
    allowed = await admin.client.post("/api/lessons", json=process)
    assert allowed.status_code == 201 and allowed.json()["kind"] == "process"
