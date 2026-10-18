"""Кабинет этапа 4: что присылать в уведомлениях (GET/PUT /api/me/notification-prefs и учет
настроек в notify), «Мои букмекеры» (/api/me/bookmakers*), согласие на обезличенные
прогнозы (PATCH /api/me), CSRF на изменяющих маршрутах."""

import asyncio
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import Bet, Bookmaker, Notification, User
from app.services import bookmakers as bookmakers_service
from app.services.notifications import notify
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import ClientFactory, LoginFn, UserFactory

# --- что присылать ---


def _kinds(body: dict[str, Any]) -> list[str]:
    return [item["kind"] for item in body["items"]]


async def test_member_prefs_by_key_mode(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    body = (await member.client.get("/api/me/notification-prefs")).json()
    assert _kinds(body) == [
        "bet_settled",
        "bet_needs_result",
        "settle_conflict",
        "weekly_report",
        "limit_80",
        "limit_100",
        "ai_mode_decision",
        "new_device",
        "login_failures",
        "admin_message",
    ]
    assert body["push_available"] is False
    required = {item["kind"] for item in body["items"] if item["required"]}
    assert required == {"new_device", "login_failures", "admin_message"}
    # Push по умолчанию включен у всех видов участника (В2, этап 6)
    assert all(item["on_site"] and item["push"] and not item["admin"] for item in body["items"])
    # Тихие часы по умолчанию выключены (0013), окно 23:00–08:00 — на случай включения
    assert body["quiet_hours"] == {"enabled": False, "start": "23:00", "end": "08:00"}
    groups = {item["kind"]: item["group"] for item in body["items"]}
    assert groups["limit_80"] == groups["limit_100"] == "limit"
    own = await signed_in(make_client, make_user, login, ip="10.0.0.2", ai_mode="own")
    kinds = _kinds((await own.client.get("/api/me/notification-prefs")).json())
    assert "ai_key_failed" in kinds and "limit_80" not in kinds


async def test_admin_prefs_include_archive_and_ai_alert(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    body = (await admin.client.get("/api/me/notification-prefs")).json()
    admin_kinds = [item["kind"] for item in body["items"] if item["admin"]]
    assert admin_kinds == [
        "learning",
        "ai_mode_request",
        "limit_80",
        "limit_100",
        "budget_80",
        "budget_100",
        "ai_key_failed",
        "data_stale",
        "ai_alert",
    ]
    assert "ai_mode_decision" not in _kinds(body)


async def test_prefs_update_and_notify_respects_them(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.put(
        "/api/me/notification-prefs",
        json={"items": [{"kind": "limit_80", "on_site": False}]},
    )
    assert response.status_code == 200, response.text
    by_kind = {item["kind"]: item["on_site"] for item in response.json()["items"]}
    assert by_kind["limit_80"] is False and by_kind["limit_100"] is True
    # Выключенный вид не пишется, обязательный и остальные — как раньше
    skipped = await notify(db, user_id=member.id, kind="limit_80", pct=80, spent="8", limit="10")
    sent = await notify(db, user_id=member.id, kind="new_device", device="Chrome", ip="1.1.1.1")
    await db.commit()
    assert skipped is None and sent is not None
    kinds = list(
        await db.scalars(select(Notification.kind).where(Notification.user_id == member.id))
    )
    assert kinds == ["new_device"]
    # Включить обратно — снова приходит
    await member.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "limit_80", "on_site": True}]}
    )
    again = await notify(db, user_id=member.id, kind="limit_80", pct=80, spent="8", limit="10")
    assert again is not None


@pytest.mark.parametrize(
    ("item", "code"),
    [
        ({"kind": "new_device", "on_site": False}, "notification.required"),
        ({"kind": "admin_message", "on_site": False}, "notification.required"),
        ({"kind": "data_stale", "on_site": False}, "notification.kind_unavailable"),
    ],
)
async def test_prefs_refusals(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    item: dict[str, Any],
    code: str,
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.put("/api/me/notification-prefs", json={"items": [item]})
    assert response.status_code == 422 and error_code(response) == code


async def test_prefs_are_personal(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    alice = await signed_in(make_client, make_user, login)
    bob = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    await alice.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "bet_settled", "on_site": False}]}
    )
    bob_prefs = (await bob.client.get("/api/me/notification-prefs")).json()
    assert all(item["on_site"] for item in bob_prefs["items"])
    assert await notify(
        db, user_id=bob.id, kind="bet_settled", bet=1, result="+", bank=1, currency="RUB"
    )


# --- букмекеры ---


async def test_bookmakers_add_rename_hide(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login)
    client = member.client
    created = await client.post("/api/me/bookmakers", json={"name": "  Fonbet "})
    assert created.status_code == 201, created.text
    fonbet = created.json()
    assert fonbet["name"] == "Fonbet" and fonbet["bets"] == 0 and fonbet["archived_at"] is None
    pari = (await client.post("/api/me/bookmakers", json={"name": "Pari"})).json()
    # Название без учета регистра — одно
    taken = await client.post("/api/me/bookmakers", json={"name": "fonbet"})
    assert taken.status_code == 409 and error_code(taken) == "bookmaker.name_taken"
    reserved = await client.post("/api/me/bookmakers", json={"name": "ДРУГОЙ"})
    assert reserved.status_code == 422 and error_code(reserved) == "bookmaker.reserved"
    # Ставка у Fonbet (рассчитанная): переименование не трогает ее название
    bet = await BetMaker(db).bet(member.user, [LegSpec()], bookmaker="Fonbet")
    bet.status = "won"
    await db.commit()
    renamed = await client.patch(f"/api/me/bookmakers/{fonbet['id']}", json={"name": "Фонбет"})
    assert renamed.status_code == 200 and renamed.json()["name"] == "Фонбет"
    stored = await db.scalar(select(Bet.bookmaker).where(Bet.id == bet.id))
    assert stored == "Fonbet"
    clash = await client.patch(f"/api/me/bookmakers/{pari['id']}", json={"name": "фонбет"})
    assert clash.status_code == 409
    # Скрыть: в формах нет, в кабинете — среди скрытых
    hidden = await client.patch(f"/api/me/bookmakers/{pari['id']}", json={"archived": True})
    assert hidden.status_code == 200 and hidden.json()["archived_at"] is not None
    assert (await client.get("/api/me/bookmakers")).json() == ["Фонбет"]
    listed = (await client.get("/api/me/bookmakers/list")).json()
    assert listed["currency"] == "RUB"
    assert [(item["name"], item["archived_at"] is not None) for item in listed["items"]] == [
        ("Фонбет", False),
        ("Pari", True),
    ]
    # Скрытое название тоже занято
    again = await client.post("/api/me/bookmakers", json={"name": "PARI"})
    assert again.status_code == 409
    back = await client.patch(f"/api/me/bookmakers/{pari['id']}", json={"archived": False})
    assert back.json()["archived_at"] is None
    assert sorted((await client.get("/api/me/bookmakers")).json()) == ["Pari", "Фонбет"]


async def test_bookmaker_with_open_bets_cannot_be_hidden_or_deleted(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login)
    row = (await member.client.post("/api/me/bookmakers", json={"name": "Winline"})).json()
    await BetMaker(db).bet(member.user, [LegSpec()], bookmaker="winline", stake="300")
    listed = (await member.client.get("/api/me/bookmakers/list")).json()["items"][0]
    assert (listed["bets"], listed["open_bets"], listed["in_play"]) == (1, 1, "300.00")
    for method, body in (("PATCH", {"archived": True}), ("DELETE", None)):
        response = await member.client.request(method, f"/api/me/bookmakers/{row['id']}", json=body)
        assert response.status_code == 409 and error_code(response) == "bookmaker.open_bets"
        assert response.json()["error"]["open_bets"] == 1
    await db.execute(update(Bet).values(status="lost"))
    await db.commit()
    deleted = await member.client.delete(f"/api/me/bookmakers/{row['id']}")
    assert deleted.status_code == 204
    # Ставка осталась, букмекера в списке нет
    assert await db.scalar(select(func.count()).select_from(Bet)) == 1
    assert await db.scalar(select(func.count()).select_from(Bookmaker)) == 0
    missing = await member.client.delete(f"/api/me/bookmakers/{row['id']}")
    assert missing.status_code == 404 and error_code(missing) == "bookmaker.not_found"


@pytest.mark.parametrize("name", ["İddaa", "ΟΠΑΠ ΣΤΟΙΧΗΜΑΤΟΣ", "Фонбет"])
async def test_bookmaker_open_bets_found_for_any_letters(
    name: str, make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    """Регистр приводит PostgreSQL: у lower в Python для «İ» и конечной «ς» другой ответ,
    и ставка в игре не находилась — букмекера можно было скрыть и удалить."""
    member = await signed_in(make_client, make_user, login)
    row = (await member.client.post("/api/me/bookmakers", json={"name": name})).json()
    await BetMaker(db).bet(member.user, [LegSpec()], bookmaker=name, stake="100")
    listed = (await member.client.get("/api/me/bookmakers/list")).json()["items"][0]
    assert (listed["bets"], listed["open_bets"]) == (1, 1)
    for method, body in (("PATCH", {"archived": True}), ("DELETE", None)):
        response = await member.client.request(method, f"/api/me/bookmakers/{row['id']}", json=body)
        assert response.status_code == 409 and error_code(response) == "bookmaker.open_bets"
    # То же название другим регистром — занято
    taken = await member.client.post("/api/me/bookmakers", json={"name": name.upper()})
    assert taken.status_code == 409 and error_code(taken) == "bookmaker.name_taken"


async def test_bookmaker_cap_holds_under_parallel_adds(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login)
    db.add_all(Bookmaker(user_id=member.id, name=f"B{n}") for n in range(49))
    await db.commit()
    other = await login(await make_client("10.0.0.7"), member.user)
    responses = await asyncio.gather(
        *[
            client.post("/api/me/bookmakers", json={"name": f"N{n}"})
            for n, client in enumerate([member.client, other] * 3)
        ]
    )
    assert sorted(response.status_code for response in responses) == [201] + [409] * 5
    assert await db.scalar(select(func.count()).select_from(Bookmaker)) == 50


async def test_remember_adds_new_names_once(make_user: UserFactory, db: AsyncSession) -> None:
    made = await make_user()
    db.add(Bookmaker(user_id=made.id, name="Hidden", archived_at=func.now()))
    await db.commit()
    await bookmakers_service.remember(db, made.id, ["Pari", " pari ", "Другой", "", None, "hidden"])
    await db.commit()
    rows = list(
        await db.scalars(
            select(Bookmaker.name, Bookmaker.archived_at).where(Bookmaker.user_id == made.id)
        )
    )
    names = sorted(await db.scalars(select(Bookmaker.name).where(Bookmaker.user_id == made.id)))
    assert names == ["Hidden", "Pari"] and len(rows) == 2
    # Скрытый не вернулся
    user = await db.get_one(User, made.id)
    assert await bookmakers_service.form_names(db, user) == ["Pari"]


async def test_bookmaker_name_validation(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    for name in ("", "   ", "x" * 65, "bad\x00name"):
        response = await member.client.post("/api/me/bookmakers", json={"name": name})
        assert response.status_code == 422, name


# --- согласие и CSRF ---


async def test_consent_training_via_patch_me(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await signed_in(make_client, make_user, login)
    assert (await member.client.get("/api/me")).json()["consent_training"] is False
    response = await member.client.patch("/api/me", json={"consent_training": True})
    assert response.status_code == 200 and response.json()["consent_training"] is True
    row = await db.get_one(User, member.id, populate_existing=True)
    assert row.consent_training is True
    off = await member.client.patch("/api/me", json={"consent_training": False})
    assert off.json()["consent_training"] is False


@pytest.mark.parametrize(
    ("method", "path", "body"),
    [
        (
            "PUT",
            "/api/me/notification-prefs",
            {"items": [{"kind": "bet_settled", "on_site": False}]},
        ),
        ("POST", "/api/me/bookmakers", {"name": "Pari"}),
        ("PUT", "/api/me/play-limits", {"bets_per_day": 3, "stake_per_day": None}),
        ("POST", "/api/me/pause", {"days": 1}),
        ("POST", "/api/me/deletion", {"password": "x", "code": "123456"}),
        ("DELETE", "/api/me/deletion", None),
        ("PATCH", "/api/me", {"consent_training": True}),
        ("PATCH", "/api/me/bookmakers/1", {"archived": True}),
        ("DELETE", "/api/me/bookmakers/1", None),
        ("PUT", "/api/admin/settings", {"default_tz": "Europe/Berlin"}),
        (
            "PUT",
            "/api/admin/settings/currency",
            {"from_currency": "RUB", "currency": "EUR", "rate": "95", "rate_base": "EUR"},
        ),
        ("POST", "/api/admin/messages", {"text": "x"}),
    ],
)
async def test_changes_need_csrf(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    method: str,
    path: str,
    body: dict[str, Any] | None,
) -> None:
    user = await make_user()
    client = await login(await make_client("10.0.0.9", csrf=False), user)
    response = await client.request(method, path, json=body)
    assert response.status_code == 403 and error_code(response) == "common.csrf"
