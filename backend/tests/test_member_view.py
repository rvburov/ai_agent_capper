"""Р27: администратор видит данные участника (только просмотр) и сводку по всем.

- на каждом маршруте просмотра ответ администратора с as_user = ответ участника себе;
- as_user принимает только администратор: участнику — 403 (и со своим id тоже), удаленный
  участник — 404, заблокированный — виден;
- ключ Claude участника (даже последние 4 символа) в ответах не появляется;
- журнал: одна запись member_view на (администратор, участник, экран) за 10 минут, каждая
  выгрузка CSV — member_export; свои данные журнал не пишет;
- сводка: эталонные суммы на фикстуре, те же числа, что на «Главной» каждого.

Что as_user закрыт на остальных маршрутах (любой не-GET, сеансы, 2FA, уведомления), — в
tests/test_route_permissions.py.
"""

import io
import zipfile
from datetime import timedelta
from decimal import Decimal
from typing import Any

import httpx2
import pytest
from redis.asyncio import Redis
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import User
from app.services.sessions import utcnow
from tests.analysis_helpers import set_own_key
from tests.claude_mock import OTHER_KEY
from tests.helpers_admin import ADMIN_IP, Signed, admin_signed_in, audit_entries, signed_in
from tests.helpers_ai import analysis, spend
from tests.helpers_bets import BetMaker, LegSpec, settle
from tests.stage4_world import TZ, base_world
from tests.support import ClientFactory, LoginFn, UserFactory

D = Decimal
APPROX = 1e-9

# Маршруты просмотра и экран журнала: путь с {bet}, {analysis}, {version} — id из мира
VIEW_ROUTES: list[tuple[str, dict[str, Any], str]] = [
    ("/api/dashboard", {"period": "30d"}, "dashboard"),
    ("/api/analytics", {"period": "all"}, "analytics"),
    ("/api/bets", {"period": "all", "limit": 50}, "bets"),
    ("/api/bets/summary", {"period": "30d"}, "bets"),
    ("/api/bets/counts", {}, "bets"),
    ("/api/bets/{bet}", {}, "bets"),
    ("/api/bets/{bet}/review", {}, "bets"),
    ("/api/me/bank", {}, "bank"),
    ("/api/me/bank/history", {"period": "30d"}, "bank"),
    ("/api/me/bank/entries", {}, "bank"),
    ("/api/strategy/active", {}, "bank"),
    ("/api/strategy/versions", {}, "bank"),
    ("/api/strategy/versions/{version}", {}, "bank"),
    ("/api/strategy/versions/compare", {"a": 1, "b": 2}, "bank"),
    ("/api/me/play-limits", {}, "bank"),
    ("/api/me/bookmakers", {}, "bank"),
    ("/api/me/bookmakers/list", {}, "bank"),
    ("/api/analyses", {}, "analyses"),
    ("/api/analyses/{analysis}", {}, "analyses"),
    ("/api/learning", {}, "learning"),
    ("/api/ai/budget", {}, "ai"),
    ("/api/ai/usage", {}, "ai"),
]
EXPORT_ROUTES: list[tuple[str, dict[str, Any], str]] = [
    ("/api/bets/export.csv", {"period": "all"}, "bets"),
    ("/api/analytics/export.csv", {"period": "all", "part": "events"}, "analytics"),
    ("/api/analytics/export.zip", {"period": "all"}, "analytics"),
]


def view_templates() -> set[str]:
    """Шаблоны путей просмотра из таблиц теста (для сверки с приложением)."""
    names = {"{bet}": "{bet_id}", "{analysis}": "{analysis_id}", "{version}": "{version_id}"}
    paths = set()
    for path, _, _ in [*VIEW_ROUTES, *EXPORT_ROUTES]:
        for short, full in names.items():
            path = path.replace(short, full)
        paths.add(path)
    return paths


@pytest.fixture
async def world(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> tuple[Signed, Signed, Signed, dict[str, int]]:
    """Участник со ставками, банком и анализами, второй участник и администратор."""
    member = await signed_in(make_client, make_user, login, tz=TZ, display_name="Алексей")
    other = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    admin = await admin_signed_in(make_client, make_user, login)
    ids = await base_world(db, member, other)
    versions = (await member.client.get("/api/strategy/versions")).json()
    # Свои правила суммы ставки (версия появилась с первой ставкой)
    ids["version"] = (versions["rules"] or versions["instructions"])[0]["id"]
    ids["analysis"] = (await member.client.get("/api/analyses")).json()["items"][0]["id"]
    ids["bet"] = ids["parlay"]
    return member, other, admin, ids


def _url(path: str, ids: dict[str, int]) -> str:
    return path.format(**ids)


def _without_key(data: Any) -> Any:
    """Ответ без своего ключа Claude (его администратору не показывают)."""
    if isinstance(data, dict) and "own_key" in data:
        return {key: value for key, value in data.items() if key != "own_key"}
    return data


def _csv_files(response: httpx2.Response) -> dict[str, bytes]:
    if response.headers["content-type"].startswith("application/zip"):
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            return {name: archive.read(name) for name in archive.namelist()}
    return {"file": response.content}


async def test_admin_sees_member_data_on_every_view_route(
    world: tuple[Signed, Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Каждый маршрут просмотра: ответ администратору с as_user — ровно ответ участника
    самому себе (та же схема и числа); чужое (второго участника) не подмешивается."""
    member, other, admin, ids = world
    for path, params, _ in VIEW_ROUTES:
        url = _url(path, ids)
        own = await member.client.get(url, params=params)
        viewed = await admin.client.get(url, params={**params, "as_user": member.id})
        # Сравнение версий 1 и 2 — ошибка у обоих одинаковая, остальное — 200
        expected = own.status_code if path.endswith("/compare") else 200
        assert own.status_code == viewed.status_code == expected, (url, viewed.text)
        assert _without_key(viewed.json()) == _without_key(own.json()), url
    for path, params, _ in EXPORT_ROUTES:
        own = await member.client.get(path, params=params)
        viewed = await admin.client.get(path, params={**params, "as_user": member.id})
        assert own.status_code == viewed.status_code == 200, (path, viewed.text)
        assert _csv_files(viewed) == _csv_files(own), path
    # Ставка второго участника через просмотр первого — 404, как у него самого
    foreign = await admin.client.get(f"/api/bets/{ids['foreign']}", params={"as_user": member.id})
    assert foreign.status_code == 404
    # Данные второго участника — его, а не первого
    theirs = await admin.client.get("/api/bets/summary", params={"as_user": other.id})
    assert theirs.json() == (await other.client.get("/api/bets/summary")).json()


async def test_view_routes_match_app(world: tuple[Signed, Signed, Signed, dict[str, int]]) -> None:
    """Таблица теста — все маршруты, которые принимают as_user (сверка с приложением)."""
    from tests.test_route_permissions import VIEW_ROUTES as APP_VIEW_ROUTES

    assert {path for _, path in APP_VIEW_ROUTES} == view_templates()


async def test_view_journal_once_per_screen(
    world: tuple[Signed, Signed, Signed, dict[str, int]], db: AsyncSession, redis: Redis
) -> None:
    """Экран дергает несколько GET — одна запись member_view на (администратор, участник,
    экран) за 10 минут; через 10 минут (метка в Redis истекла) — новая; второй
    администратор пишет свою. Каждая выгрузка CSV — member_export."""
    member, _, admin, ids = world
    for _ in range(2):
        for path, params, _ in VIEW_ROUTES:
            await admin.client.get(_url(path, ids), params={**params, "as_user": member.id})
    views = await audit_entries(db, "member_view")
    screens = sorted(entry.details["screen"] for entry in views)
    assert screens == sorted({screen for _, _, screen in VIEW_ROUTES})
    for entry in views:
        assert entry.actor_id == admin.id and entry.target_user_id == member.id
        assert entry.details == {"user_id": member.id, "screen": entry.details["screen"]}
        assert str(entry.ip) == ADMIN_IP
    # Выгрузки — каждая отдельно, просмотр они не пишут
    for path, params, _ in [*EXPORT_ROUTES, EXPORT_ROUTES[0]]:
        response = await admin.client.get(path, params={**params, "as_user": member.id})
        assert response.status_code == 200
    exports = await audit_entries(db, "member_export")
    assert [entry.details["what"] for entry in exports] == [
        "bets", "analytics", "analytics", "bets",
    ]  # fmt: skip
    assert exports[1].details["parts"] == ["events"]
    assert exports[2].details["parts"] == ["bets", "events"]
    assert all(entry.target_user_id == member.id for entry in exports)
    assert len(await audit_entries(db, "member_view")) == len(views)

    # 10 минут прошли: метки в Redis нет — снова запись
    keys = [key async for key in redis.scan_iter(match="*member_view*")]
    assert keys
    for key in keys:
        assert 0 < await redis.ttl(key) <= 600
    await redis.delete(*keys)
    await admin.client.get("/api/bets", params={"as_user": member.id})
    assert len(await audit_entries(db, "member_view")) == len(views) + 1

    # Журнал фильтруется по новым действиям, подписи — в локали
    listed = await admin.client.get("/api/admin/audit", params={"action": "member_export"})
    assert listed.status_code == 200
    rows = listed.json()
    assert len(rows) == 4 and {row["target_name"] for row in rows} == {"Алексей"}


async def test_own_data_and_other_admin(
    world: tuple[Signed, Signed, Signed, dict[str, int]],
    db: AsyncSession,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Администратор со своим id в as_user — свои данные, без записи в журнал; второй
    администратор пишет свою запись о том же экране."""
    member, _, admin, _ = world
    own = await admin.client.get("/api/bets/summary")
    same = await admin.client.get("/api/bets/summary", params={"as_user": admin.id})
    assert same.status_code == 200 and same.json() == own.json()
    csv = await admin.client.get("/api/bets/export.csv", params={"as_user": admin.id})
    assert csv.status_code == 200
    assert await audit_entries(db, "member_view") == []
    assert await audit_entries(db, "member_export") == []

    second = await admin_signed_in(make_client, make_user, login)
    for client in (admin.client, second.client, admin.client):
        await client.get("/api/me/bank", params={"as_user": member.id})
    views = await audit_entries(db, "member_view")
    assert sorted(entry.actor_id or 0 for entry in views) == sorted([admin.id, second.id])


async def test_as_user_only_for_admin(
    world: tuple[Signed, Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Участник с as_user — 403 и с чужим, и со своим id (параметр только у
    администратора); чужие данные не уходят."""
    member, other, _, ids = world
    for path, params, _ in [*VIEW_ROUTES, *EXPORT_ROUTES]:
        url = _url(path, ids)
        for target in (other.id, member.id):
            response = await member.client.get(url, params={**params, "as_user": target})
            assert response.status_code == 403, (url, response.text)
            assert response.json()["error"]["code"] == "common.forbidden"
    assert await audit_entries(db, "member_view") == []


async def test_as_user_target_rules(
    world: tuple[Signed, Signed, Signed, dict[str, int]],
    db: AsyncSession,
    make_user: UserFactory,
) -> None:
    """Заблокированный участник и другой администратор видны; удаленный и
    несуществующий — 404; не число и 0 — 422."""
    member, _, admin, _ = world
    await db.execute(update(User).where(User.id == member.id).values(status="blocked"))
    await db.commit()
    blocked = await admin.client.get("/api/bets/summary", params={"as_user": member.id})
    # 6 рассчитанных ставок мира, включая ставку старого бота
    assert blocked.status_code == 200 and blocked.json()["settled"] == 6
    other_admin = await make_user(role="admin")
    response = await admin.client.get("/api/me/bank", params={"as_user": other_admin.id})
    assert response.status_code == 200 and response.json()["empty"] is True

    deleted = await make_user()
    await db.execute(update(User).where(User.id == deleted.id).values(status="deleted"))
    await db.commit()
    for target in (deleted.id, 999_999):
        response = await admin.client.get("/api/dashboard", params={"as_user": target})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "common.not_found"
    for bad in ("abc", "0", "-1", str(2**63)):
        response = await admin.client.get("/api/dashboard", params={"as_user": bad})
        assert response.status_code == 422, bad
        assert response.json()["error"]["fields"][0]["loc"] == ["query", "as_user"]
    logged = {entry.target_user_id for entry in await audit_entries(db, "member_view")}
    assert logged == {member.id, other_admin.id}


async def test_member_key_never_shown(
    world: tuple[Signed, Signed, Signed, dict[str, int]], db: AsyncSession
) -> None:
    """Свой ключ Claude участника: сам он видит последние 4 символа, администратор в
    просмотре — ничего (own_key пустой, ключа нет ни в одном ответе просмотра)."""
    member, _, admin, ids = world
    await set_own_key(db, member.user.user)
    own = (await member.client.get("/api/ai/budget")).json()
    assert own["own_key"]["last4"] == OTHER_KEY[-4:]
    viewed = (await admin.client.get("/api/ai/budget", params={"as_user": member.id})).json()
    assert viewed["own_key"] is None and viewed["has_key"] is True
    for path, params, _ in VIEW_ROUTES:
        response = await admin.client.get(_url(path, ids), params={**params, "as_user": member.id})
        assert OTHER_KEY[-4:] not in response.text and OTHER_KEY[:-4] not in response.text


# --- сводка ---


async def _summary(admin: Signed, period: str = "30d") -> dict[str, Any]:
    response = await admin.client.get("/api/admin/summary", params={"period": period})
    assert response.status_code == 200, response.text
    data: dict[str, Any] = response.json()
    return data


async def test_summary_reference_sums(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Эталон: Ольга — 100 по 2.00 выиграла (закрытие 1.90, рынок при прогнозе 0.50,
    модель 0.62); Дмитрий — 200 по 1.50 проиграл (рынок 0.55, модель 0.60); у
    администратора ставок нет; удаленный участник в сводку не попадает."""
    admin = await admin_signed_in(make_client, make_user, login, display_name="Роман")
    olga = await signed_in(make_client, make_user, login, display_name="Ольга")
    dmitry = await signed_in(make_client, make_user, login, ip="10.0.0.4", display_name="Дмитрий")
    deleted = await make_user(display_name="Удален")
    await db.execute(update(User).where(User.id == deleted.id).values(status="deleted"))
    await db.commit()
    maker = BetMaker(db)
    win = await maker.bet(
        olga.user, [LegSpec(odds="2.00", p_final=0.62, q_market=0.50)], stake="100",
        placed_at=utcnow() - timedelta(days=2),
    )  # fmt: skip
    assert (
        await settle(olga.client, win.id, "win", closing={"odds": "1.90", "by": "pinnacle"})
    ).status_code == 200
    loss = await maker.bet(
        dmitry.user, [LegSpec(odds="1.50", p_final=0.60, q_market=0.55)], stake="200",
        placed_at=utcnow() - timedelta(days=3),
    )  # fmt: skip
    assert (await settle(dmitry.client, loss.id, "loss")).status_code == 200
    await spend(db, olga.id, "1.25")
    await spend(db, olga.id, "0.50", key_source="own")  # свой ключ — не в расходе на ключе
    await analysis(db, olga.id)
    await analysis(db, olga.id)

    data = await _summary(admin)
    assert data["period"] == "30d" and data["currency"] == "RUB"
    totals = data["totals"]
    assert totals["bets"] == 2 and totals["members_with_bets"] == 2
    assert D(totals["turnover"]) == D("300.00") and D(totals["profit"]) == D("-100.00")
    assert totals["roi"] == pytest.approx(-1 / 3)
    assert totals["clv_n"] == 1 and totals["clv_avg"] == pytest.approx(2.00 / 1.90 - 1)
    assert totals["brier_n"] == 2
    assert totals["brier_model"] == pytest.approx(((0.62 - 1) ** 2 + 0.60**2) / 2)
    assert totals["brier_market"] == pytest.approx(((0.50 - 1) ** 2 + 0.55**2) / 2)
    # Банк: депозит 10 000 у каждого; Ольга +100, Дмитрий −200
    assert D(totals["bank"]) == D("19900.00")

    rows = data["members"]
    assert [row["name"] for row in rows] == ["Роман", "Ольга", "Дмитрий"]
    me, first, second = rows
    assert me["me"] is True and me["empty"] is True and me["bets"] == 0 and me["roi"] is None
    assert first["user_id"] == olga.id and first["role"] == "member"
    assert D(first["bank"]) == D("10100.00") and D(first["profit"]) == D("100.00")
    assert first["roi"] == pytest.approx(1.0) and first["bets"] == 1
    assert first["analyses"] == 2 and first["ai_spend_usd"] == pytest.approx(1.25)
    assert "last_login_at" in first
    assert D(second["profit"]) == D("-200.00") and second["clv_avg"] is None

    # Те же числа, что на «Главной» участника за тот же период
    for row, person in ((first, olga), (second, dmitry)):
        home = (await person.client.get("/api/dashboard", params={"period": "30d"})).json()
        assert row["bets"] == home["kpi"]["settled"]
        assert D(row["profit"]) == D(home["kpi"]["profit"])
        assert D(row["bank"]) == D(home["bank"]["balance"])

    # Период «7 дней» без ставок старше; «все» — те же ставки
    assert (await _summary(admin, "all"))["totals"]["bets"] == 2
    assert (await _summary(admin, "7d"))["totals"]["bets"] == 2


async def test_summary_journal_and_rights(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Открытие сводки — одна запись member_view (screen=summary, user_id null) за 10
    минут при любом периоде; участнику — 403."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    for period in ("30d", "7d", "all"):
        await _summary(admin, period)
    [entry] = await audit_entries(db, "member_view")
    assert entry.target_user_id is None and entry.actor_id == admin.id
    assert entry.details == {"user_id": None, "screen": "summary", "period": "30d"}
    response = await member.client.get("/api/admin/summary")
    assert response.status_code == 403
    assert (await admin.client.get("/api/admin/summary?period=1y")).status_code == 422
