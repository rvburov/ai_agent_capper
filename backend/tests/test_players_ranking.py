"""Список «Игроки» (GET /api/players/ranking, этап 4): набор по умолчанию — игроки с
матчами за 52 недели по месту по Эло, страницы с сервера, поиск по всей базе по-русски и
латиницей с опечатками, фильтры и сортировки как в макете, «сегодня» — только свое."""

import asyncio
from collections.abc import Generator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

from app.db.models import Player, PlayerEloCurrent
from app.db.session import create_sessionmaker
from app.services import players
from app.services.players import exact_match
from tests.helpers_admin import signed_in
from tests.players_world import PlayersWorld, build_players_world, own_open_bet, today
from tests.support import ClientFactory, LoginFn, UserFactory


@pytest.fixture
def factory(engine: AsyncEngine, db: AsyncSession) -> async_sessionmaker[AsyncSession]:
    return create_sessionmaker(engine)


@pytest.fixture
async def world(db: AsyncSession, factory: async_sessionmaker[AsyncSession]) -> PlayersWorld:
    return await build_players_world(db, factory)


async def current(db: AsyncSession) -> dict[int, PlayerEloCurrent]:
    rows = await db.scalars(select(PlayerEloCurrent).execution_options(populate_existing=True))
    return {row.player_id: row for row in rows}


async def test_ranking_requires_login(make_client: ClientFactory) -> None:
    response = await (await make_client()).get("/api/players/ranking")
    assert response.status_code == 401


async def test_default_is_active_players_by_elo_rank(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/players/ranking")).json()
    rows = await current(db)
    active = sorted(
        (row for row in rows.values() if row.matches_52w > 0),
        key=lambda row: (row.rank_all, -(row.elo_all or 0)),
    )
    assert [item["id"] for item in body["items"]] == [row.player_id for row in active]
    assert {world.sinner, world.alcaraz, world.medvedev} == {row.player_id for row in active}
    assert body["total"] == 3
    assert body["counts"] == {"all": 5, "active": 3, "news": 0}
    assert (body["data"], body["surface"], body["sort"]) == ("active", "hard", "rank")
    assert (body["offset"], body["limit"], body["query"], body["fuzzy"]) == (0, 50, None, False)
    assert body["rank_days"] == 364
    assert body["as_of"] == today().isoformat()
    assert body["archive"]["data_to"] == (today() - timedelta(days=35)).isoformat()

    sinner = next(item for item in body["items"] if item["id"] == world.sinner)
    row = rows[world.sinner]
    assert sinner["rank"] == row.rank_all
    assert sinner["elo_all"] == round(row.elo_all or 0)
    assert sinner["elo_surface"] == round(row.elo_hard or 0)
    assert sinner["elo_delta"] == round(row.elo_hard or 0) - round(row.elo_all or 0)
    # Неявка в матчи за 52 недели не входит (как место по Эло анализа)
    assert sinner["matches_52w"] == 4
    # Форма: финал (поражение), полуфинал, 1/8 и четвертьфинал грунта; неявка не в счет
    assert sinner["form"] == ["L", "W", "W", "W"]
    assert (sinner["wins"], sinner["losses"]) == (3, 1)
    assert sinner["last_match"] == {
        "match_id": world.matches["hard_f"],
        "day": (today() - timedelta(days=35)).isoformat(),
        "tournament": "Hard Open",
        "category": "masters",
        "round": "F",
    }
    assert sinner["age"] is not None and sinner["country"] == "ITA"
    assert sinner["today"] is False
    assert (sinner["news_checked_at"], sinner["news_fresh"]) == (None, False)


async def test_elo_delta_is_difference_of_shown_numbers(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Разница Эло на покрытии и общего — разница показанных целых чисел (как в макете):
    1446,6 и 1512,4 показываются как 1447 и 1512, разница −65 (а не round(−65,8) = −66)."""
    await db.execute(
        update(PlayerEloCurrent)
        .where(PlayerEloCurrent.player_id == world.sinner)
        .values(elo_all=1512.4, elo_hard=1446.6)
    )
    await db.commit()
    member = await signed_in(make_client, make_user, login)
    items = (await member.client.get("/api/players/ranking")).json()["items"]
    sinner = next(item for item in items if item["id"] == world.sinner)
    assert (sinner["elo_all"], sinner["elo_surface"], sinner["elo_delta"]) == (1512, 1447, -65)
    card = (await member.client.get(f"/api/players/{world.sinner}")).json()["elo"]
    hard = next(item for item in card["surfaces"] if item["surface"] == "hard")
    assert (card["all"], hard["elo"], hard["delta"]) == (1512, 1447, -65)


async def test_filters_sorts_and_pages(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)
    rows = await current(db)

    everyone = (await member.client.get("/api/players/ranking?data=all")).json()
    assert everyone["total"] == 5
    ids = [item["id"] for item in everyone["items"]]
    # Без места по Эло — в конце: ветеран (рейтинг есть), затем тот, кто не играл
    assert ids[-2:] == [world.veteran, world.nobody]
    nobody = everyone["items"][-1]
    assert (nobody["rank"], nobody["elo_all"], nobody["form"], nobody["last_match"]) == (
        None,
        None,
        [],
        None,
    )

    by_clay = (await member.client.get("/api/players/ranking?sort=elo&surface=clay")).json()
    clay = [item["elo_surface"] for item in by_clay["items"]]
    known = [value for value in clay if value is not None]
    # Без матчей на покрытии (Medvedev на грунте — только неявка) — в конце
    assert clay == [*sorted(known, reverse=True), *[None] * (len(clay) - len(known))]
    assert None in clay
    assert by_clay["items"][0]["elo_surface"] == round(
        max(row.elo_clay for row in rows.values() if row.elo_clay is not None and row.rank_all)
    )

    by_last = (await member.client.get("/api/players/ranking?data=all&sort=last")).json()
    days = [item["last_match"]["day"] for item in by_last["items"] if item["last_match"]]
    assert days == sorted(days, reverse=True)
    assert by_last["items"][-1]["id"] == world.nobody

    page = (await member.client.get("/api/players/ranking?data=all&offset=2&limit=2")).json()
    assert [item["id"] for item in page["items"]] == ids[2:4]
    assert (page["total"], page["offset"], page["limit"]) == (5, 2, 2)

    for bad in ("limit=0", "limit=101", "offset=-1", "data=x", "sort=x", "surface=carpet"):
        assert (await member.client.get(f"/api/players/ranking?{bad}")).status_code == 422


async def test_news_filter_uses_cache_age(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    now = datetime.now(UTC)
    await db.execute(update(Player).where(Player.id == world.alcaraz).values(news_checked_at=now))
    await db.execute(
        update(Player)
        .where(Player.id == world.medvedev)
        .values(news_checked_at=now - timedelta(hours=13))
    )
    await db.commit()
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/players/ranking?data=news")).json()
    assert [item["id"] for item in body["items"]] == [world.alcaraz]
    assert body["counts"]["news"] == 1 and body["news_ttl_hours"] == 12
    assert body["items"][0]["news_fresh"] is True
    medvedev = next(
        item
        for item in (await member.client.get("/api/players/ranking")).json()["items"]
        if item["id"] == world.medvedev
    )
    assert medvedev["news_fresh"] is False and medvedev["news_checked_at"] is not None


async def test_search_whole_base_russian_latin_and_typos(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    member = await signed_in(make_client, make_user, login)

    async def search(query: str, extra: str = "") -> dict[str, Any]:
        response = await member.client.get(
            "/api/players/ranking", params={"q": query} | dict([extra.split("=")] if extra else [])
        )
        assert response.status_code == 200, response.text
        data: dict[str, Any] = response.json()
        return data

    found = await search("синнер")
    assert [item["id"] for item in found["items"]] == [world.sinner]
    assert found["fuzzy"] is False and found["query"] == "синнер"
    assert [i["id"] for i in (await search("алькарас"))["items"]] == [world.alcaraz]
    assert [i["id"] for i in (await search("Sinn"))["items"]] == [world.sinner]
    # Вся база: игрок без матчей за 52 недели тоже находится
    assert [i["id"] for i in (await search("veteran"))["items"]] == [world.veteran]
    typo = await search("синер")
    assert typo["fuzzy"] is True
    assert [item["id"] for item in typo["items"]] == [world.sinner]
    # Поиск с data=news сужает до свежих новостей
    assert (await search("синнер", "data=news"))["total"] == 0
    # Индекс поиска пересобирается, когда меняются имена игроков
    assert (await search("квадрат"))["total"] == 0
    await db.execute(update(Player).where(Player.id == world.medvedev).values(aliases=["Квадрат"]))
    await db.commit()
    assert [i["id"] for i in (await search("квадрат"))["items"]] == [world.medvedev]
    assert (await search("   "))["query"] is None
    for bad in ("x" * 101, "a\x00b"):
        response = await member.client.get("/api/players/ranking", params={"q": bad})
        assert response.status_code == 422


async def test_search_like_mockup(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Поиск как в макете (searchMatch): точные — подстрока слова имени или страны по всей
    базе, сколько бы игроков ни было похожи сильнее; похожие — только с расстоянием
    Левенштейна 1 (2 у слов от 7 букв), без случайных совпадений слогов."""
    others = {
        name: Player(name=name, country=country)
        for name, country in (
            ("Andrey Rublev", "RUS"),
            ("Casper Ruud", "NOR"),
            ("Pablo Llamas Ruiz", "ESP"),
            ("Holger Rune", "DEN"),
            ("Novak Djokovic", "SRB"),
            ("Karen Khachanov", "RUS"),
            ("Tomas Machac", "CZE"),
        )
    }
    # Больше 200 игроков, у которых «ov» — почти все имя: раньше поиск смотрел только 200
    # самых похожих по триграммам, и Djokovic в них не попадал
    crowd = [Player(name=f"Ov Ovo{number}") for number in range(210)]
    db.add_all([*others.values(), *crowd])
    await db.commit()
    member = await signed_in(make_client, make_user, login)

    async def search(query: str, **extra: str) -> tuple[list[int], int, bool]:
        response = await member.client.get(
            "/api/players/ranking", params={"q": query, "limit": "100", **extra}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        return [item["id"] for item in body["items"]], body["total"], body["fuzzy"]

    players = list(await db.scalars(select(Player)))
    _, total, fuzzy = await search("ov")
    # 210 «Ov Ovo…», Djokovic и Khachanov
    assert total == sum(1 for player in players if exact_match(player, "ov")) == 212
    assert not fuzzy
    pages = [(await search("ov", offset=str(offset)))[0] for offset in (0, 100, 200)]
    assert others["Novak Djokovic"].id in [pid for page in pages for pid in page]
    assert sum(len(page) for page in pages) == 212

    # Похожие: только сам игрок, без посторонних с похожими слогами
    assert await search("рублв") == ([others["Andrey Rublev"].id], 1, True)
    assert await search("хачанв") == ([others["Karen Khachanov"].id], 1, True)
    assert await search("синер") == ([world.sinner], 1, True)
    # Слово короче 4 букв с опечаткой не ищется (как в макете)
    assert await search("снр") == ([], 0, True)

    # Страна: код IOC и название по-русски — точные, название с опечаткой — похожее
    assert await search("ITA") == ([world.sinner], 1, False)
    assert await search("Италия") == ([world.sinner], 1, False)
    assert await search("италя") == ([world.sinner], 1, True)
    spain, total, fuzzy = await search("испания")
    assert set(spain) == {world.alcaraz, others["Pablo Llamas Ruiz"].id} and not fuzzy
    # Порядок — выбранная сортировка (место по Эло), как в макете
    russians, _, _ = await search("Россия", data="all")
    rows = await current(db)
    ranked = [pid for pid in russians if pid in rows and rows[pid].rank_all is not None]
    assert ranked == sorted(ranked, key=lambda pid: rows[pid].rank_all or 0)
    assert world.medvedev in russians


async def test_search_index_built_once_and_yields_event_loop(
    world: PlayersWorld,
    db: AsyncSession,
    factory: async_sessionmaker[AsyncSession],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Сборка индекса поиска отдает цикл событий (параллельные запросы не ждут ее
    целиком), а параллельные поиски после изменения таблицы players собирают его один
    раз."""
    ticks = 0
    builds: list[int] = []
    steps = players.SearchIndex._steps.__func__  # type: ignore[attr-defined]

    def counted(cls: type[players.SearchIndex], rows: Any) -> Generator[None, None, Any]:
        before = ticks
        index = yield from steps(cls, rows)
        # Сколько раз за сборку успела поработать другая задача
        builds.append(ticks - before)
        return index

    monkeypatch.setattr(players.SearchIndex, "_steps", classmethod(counted))
    monkeypatch.setattr(players, "BUILD_SLICE", 0.0)
    players._SEARCH_INDEX.clear()
    running = True

    async def ticker() -> None:
        nonlocal ticks
        while running:
            ticks += 1
            await asyncio.sleep(0)

    async def find(query: str) -> set[int]:
        async with factory() as session:
            index = await players.search_index(session)
        return index.find(query)[0]

    task = asyncio.create_task(ticker())
    try:
        first, second = await asyncio.gather(find("sinner"), find("медведев"))
        assert (first, second) == ({world.sinner}, {world.medvedev})
        assert len(builds) == 1 and builds[0] > 0
        # Без изменений — из памяти; после правки имени — одна новая сборка
        assert await find("sinner") == {world.sinner}
        assert len(builds) == 1
        await db.execute(update(Player).where(Player.id == world.sinner).values(aliases=["Лис"]))
        await db.commit()
        assert list(await asyncio.gather(find("лис"), find("лис"))) == [{world.sinner}] * 2
        assert len(builds) == 2
    finally:
        running = False
        await task
    # Обычная сборка (без цикла событий) дает тот же индекс
    rows = [(world.sinner, "Jannik Sinner", "Янник Синнер", ["Лис"], "ITA")]
    assert players.SearchIndex.build(rows).find("лис")[0] == {world.sinner}


async def test_exact_match_rules(db: AsyncSession) -> None:
    player = Player(
        name="Felix Auger-Aliassime", name_ru="Феликс Оже-Альяссим", aliases=[], country="CAN"
    )
    assert exact_match(player, "оже")
    assert exact_match(player, "aliassime f")
    assert exact_match(player, "Альяссим")
    assert not exact_match(player, "оже-альясим")
    assert exact_match(player, "can")
    assert exact_match(player, "Канада")
    assert exact_match(player, "канад оже")
    assert not exact_match(player, "Canada")


async def test_today_flag_only_for_own_bets(
    world: PlayersWorld,
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    owner = await signed_in(make_client, make_user, login)
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    await own_open_bet(db, owner.id, world.sinner, world.medvedev)

    def flags(body: dict[str, list[dict[str, object]]]) -> dict[object, object]:
        return {item["id"]: item["today"] for item in body["items"]}

    mine = flags((await owner.client.get("/api/players/ranking")).json())
    assert mine == {world.sinner: True, world.medvedev: True, world.alcaraz: False}
    theirs = flags((await other.client.get("/api/players/ranking")).json())
    assert set(theirs.values()) == {False}
