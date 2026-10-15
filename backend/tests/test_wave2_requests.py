"""Заявки этапа 5, волна 2: исход у уведомления «Ставка рассчитана» (цвет значка) и
подсказка исхода по новостям в карточке ставки, которая ждет результата (В1-Г)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PlayerNews
from app.services.news_hints import set_score
from app.services.notifications import notify
from tests.helpers_admin import signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory


async def test_notification_outcome(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    for status in ("won", "lost", "void"):
        await notify(
            db,
            user_id=member.id,
            kind="bet_settled",
            variant="auto",
            bet=1,
            status=status,
            outcome="x",
            bank="1 000 ₽",
        )
    await notify(db, user_id=member.id, kind="new_device", device="Safari", ip="1.2.3.4")
    await db.commit()
    items = (await member.client.get("/api/me/notifications")).json()["items"]
    assert sorted((item["kind"], item["outcome"]) for item in items) == [
        ("bet_settled", "lost"),
        ("bet_settled", "void"),
        ("bet_settled", "won"),
        ("new_device", None),
    ]


def test_set_score_from_news() -> None:
    assert set_score("6-3 6-4", 3) == (2, 0)
    assert set_score("3-6, 6:4, 7–6(5)", 3) == (2, 1)
    assert set_score("6-3 6-4 6-2", 5) == (3, 0)
    assert set_score("6-3", 3) is None
    assert set_score("победа в двух сетах", None) is None


async def test_news_result_hint_for_waiting_bet(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    day = datetime.now(UTC).date() - timedelta(days=2)
    bet = await maker.bet(
        member.user,
        [LegSpec(names=("Jannik Sinner", "Holger Rune"), match_day=day, selection=2)],
        placed_at=datetime.now(UTC) - timedelta(days=3),
    )
    detail = (await member.client.get(f"/api/bets/{bet.id}")).json()
    [leg] = detail["legs"]
    assert detail["awaiting_result"] is True and leg["news_result"] is None
    # Новость о проигрыше второго игрока (Руне): победил игрок 1 матча, счет 2:0
    db.add_all(
        [
            PlayerNews(
                player_id=leg["match"]["player2"]["id"],
                published_at=datetime.combine(day, datetime.min.time(), tzinfo=UTC),
                kind="result",
                summary="Руне проиграл Синнеру",
                source_url="https://www.atptour.com/news/rune-sinner",
                source_name="ATP Tour",
                details={
                    "opponent": "J. Sinner",
                    "score": "3-6 4-6",
                    "tournament": "Shanghai",
                    "date": day.isoformat(),
                    "won": False,
                },
            ),
            # Другой матч того же игрока (соперник не тот) — не подсказка
            PlayerNews(
                player_id=leg["match"]["player2"]["id"],
                published_at=datetime.combine(day, datetime.min.time(), tzinfo=UTC),
                kind="result",
                summary="Руне обыграл Зверева",
                source_url="https://www.atptour.com/news/rune-zverev",
                source_name="ATP Tour",
                details={
                    "opponent": "A. Zverev",
                    "score": "6-1 6-1",
                    "tournament": "Shanghai",
                    "date": day.isoformat(),
                    "won": True,
                },
            ),
        ]
    )
    await db.commit()
    hinted = (await member.client.get(f"/api/bets/{bet.id}")).json()["legs"][0]["news_result"]
    assert hinted["winner"] == 1 and hinted["sets"] == "2:0" and hinted["retired"] is False
    assert hinted["score"] == "3-6 4-6" and hinted["source_name"] == "ATP Tour"
    assert hinted["source_url"].endswith("rune-sinner")
    assert hinted["published_on"] == day.isoformat()
    # В списке ставок подсказки нет: только в карточке
    listed = (await member.client.get("/api/bets")).json()["items"][0]["legs"][0]
    assert listed.get("news_result") is None
    # Деньги подсказка не меняет: ставка открыта
    assert (await member.client.get(f"/api/bets/{bet.id}")).json()["status"] == "open"
