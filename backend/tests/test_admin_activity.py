"""Активность участников для администратора (GET /api/admin/activity, этап 4): входы из
журнала входов и число запущенных анализов по людям за период; Р14 — без адресов,
устройств и содержимого анализов."""

from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import LoginEvent
from tests.helpers_admin import admin_signed_in, signed_in
from tests.helpers_ai import analysis
from tests.support import ClientFactory, LoginFn, UserFactory


async def login_event(db: AsyncSession, user_id: int, ago: timedelta, result: str = "ok") -> None:
    db.add(
        LoginEvent(
            user_id=user_id,
            at=datetime.now(UTC) - ago,
            ip="10.1.2.3",
            user_agent="Mozilla/5.0 Safari",
            result=result,
            method="password",
        )
    )
    await db.commit()


async def test_activity_by_people(
    db: AsyncSession, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login)
    quiet = await make_user()
    gone = await make_user(status="deleted")
    await login_event(db, member.id, timedelta(minutes=5))
    await login_event(db, member.id, timedelta(days=3))
    await login_event(db, member.id, timedelta(days=3), result="bad_password")
    await login_event(db, member.id, timedelta(days=40))
    await login_event(db, admin.id, timedelta(days=10))
    await analysis(db, member.id, started_ago=timedelta(days=2))
    await analysis(db, member.id, started_ago=timedelta(days=50))
    await analysis(db, quiet.id, started_ago=timedelta(days=1))

    body = (await admin.client.get("/api/admin/activity")).json()
    assert body["period"] == "30d"
    people = {item["user_id"]: item for item in body["people"]}
    assert set(people) == {admin.id, member.id, quiet.id}
    assert gone.id not in people
    mine = people[member.id]
    assert (mine["logins"], mine["failed_logins"], mine["analyses"]) == (2, 1, 1)
    assert mine["last_analysis_at"] is not None
    assert (people[quiet.id]["logins"], people[quiet.id]["analyses"]) == (0, 1)
    assert (body["logins"], body["failed_logins"], body["analyses"]) == (3, 1, 2)
    assert body["active_users"] == 2
    assert body["today_users"] in (0, 1)  # вход 5 минут назад — сегодня, если не полночь
    assert body["people"][0]["user_id"] in (member.id, quiet.id)
    # Р14: ни адресов, ни устройств
    assert "10.1.2.3" not in str(body) and "Safari" not in str(body)

    year = (await admin.client.get("/api/admin/activity?period=90d")).json()
    year_people = {item["user_id"]: item for item in year["people"]}
    assert (year_people[member.id]["logins"], year_people[member.id]["analyses"]) == (3, 2)
    day = (await admin.client.get("/api/admin/activity?period=1d")).json()
    assert {item["user_id"]: item["logins"] for item in day["people"]}[member.id] == 1
    assert (await admin.client.get("/api/admin/activity?period=365d")).status_code == 422
    assert (await member.client.get("/api/admin/activity")).status_code == 403
