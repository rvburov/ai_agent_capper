"""Заявки этапа 5, волна 2: исход у уведомления «Ставка рассчитана» (цвет значка) и
подсказка исхода по новостям в карточке ставки, которая ждет результата (В1-Г)."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import PlayerNews
from app.ml.markets import games_leg_result, parse_games
from app.services.news_hints import games_score, set_score
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


def test_games_score_from_news_player1_first() -> None:
    """Р28: счет по геймам — первым игрок 1 матча, с какой бы стороны ни записала новость."""
    # Руне (игрок 2) выиграл 6-4 7-6: новость Руне и новость Синнера «со стороны победителя»
    assert games_score("6-4 7-6(5)", winner=2, number=2) == "4:6 6:7(5)"
    assert games_score("6-4 7-6(5)", winner=2, number=1) == "4:6 6:7(5)"
    # Новость Синнера со своей стороны (как просит промпт)
    assert games_score("4-6 6-7(7-5)", winner=2, number=1) == "4:6 6:7(5)"
    assert games_score("6-4 3-6 [10-8]", winner=1, number=1) == "6:4 3:6 [10:8]"
    assert games_score("4-6 6-3 [8-10]", winner=1, number=2) == "6:4 3:6 [10:8]"
    # Без перевеса по сетам — со стороны игрока новости
    assert games_score("6-4 1-2", winner=1, number=2) == "4:6 2:1"
    assert games_score("победа в двух сетах", winner=1, number=1) is None
    # Фора Синнера −2.5 по геймам при победе Руне 6-4 7-6 — проигрыш, а не выигрыш
    games = parse_games(games_score("6-4 7-6(5)", winner=2, number=2))
    assert games is not None and games_leg_result("GHCP_-2.5", 1, games) == "loss"


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
    assert hinted["games"] == "6:3 6:4"
    assert hinted["score"] == "3-6 4-6" and hinted["source_name"] == "ATP Tour"
    assert hinted["source_url"].endswith("rune-sinner")
    assert hinted["published_on"] == day.isoformat()
    # В списке ставок подсказки нет: только в карточке
    listed = (await member.client.get("/api/bets")).json()["items"][0]["legs"][0]
    assert listed.get("news_result") is None
    # Деньги подсказка не меняет: ставка открыта
    assert (await member.client.get(f"/api/bets/{bet.id}")).json()["status"] == "open"


async def test_news_games_hint_from_player1_side(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Р28: нога «Фора по геймам Синнер −2.5», выиграл Руне 6-4 7-6 — в подсказке
    геймы игрока 1 первыми (4:6 6:7), исход по ним — проигрыш."""
    member = await signed_in(make_client, make_user, login)
    maker = BetMaker(db)
    day = datetime.now(UTC).date() - timedelta(days=2)
    bet = await maker.bet(
        member.user,
        [
            LegSpec(
                names=("Jannik Sinner", "Holger Rune"),
                match_day=day,
                market="GHCP_-2.5",
                selection=1,
                p_final=None,
                p_base=None,
                p_claude=None,
            )
        ],
        placed_at=datetime.now(UTC) - timedelta(days=3),
    )
    [leg] = (await member.client.get(f"/api/bets/{bet.id}")).json()["legs"]
    db.add(
        PlayerNews(
            player_id=leg["match"]["player2"]["id"],
            published_at=datetime.combine(day, datetime.min.time(), tzinfo=UTC),
            kind="result",
            summary="Руне обыграл Синнера",
            source_url="https://www.atptour.com/news/rune-sinner",
            source_name="ATP Tour",
            details={
                "opponent": "J. Sinner",
                "score": "6-4 7-6(5)",
                "tournament": "Shanghai",
                "date": day.isoformat(),
                "won": True,
            },
        )
    )
    await db.commit()
    [leg] = (await member.client.get(f"/api/bets/{bet.id}")).json()["legs"]
    hinted = leg["news_result"]
    assert leg["score_kind"] == "games"
    assert hinted["winner"] == 2 and hinted["games"] == "4:6 6:7(5)"
    games = parse_games(hinted["games"])
    assert games is not None and games_leg_result(leg["market"], 1, games) == "loss"
