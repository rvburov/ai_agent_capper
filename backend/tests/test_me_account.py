"""Личный кабинет: журнал входов, перевыпуск резервных кодов, уведомления,
доверенные устройства."""

import asyncio
from datetime import timedelta

import httpx2
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.models import LoginEvent, Notification
from app.services.notifications import notify
from app.services.sessions import utcnow
from tests.helpers_auth import code_step, cookie_value, full_login, password_step
from tests.support import ClientFactory, LoginFn, TotpCodeFn, UserFactory


async def test_login_events_journal(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    browser = await make_client("10.0.0.7")
    assert (await password_step(browser, member, password="wrong-password-1")).status_code == 401
    await full_login(browser, member, await totp_code(member))

    response = await browser.get("/api/me/login-events")
    assert response.status_code == 200
    events = response.json()
    assert [(e["result"], e["method"]) for e in events] == [
        ("ok", "totp"),
        ("bad_password", "password"),
    ]
    assert events[0]["ip"] == "10.0.0.7"
    assert events[0]["device_label"] == "Chrome · Windows"
    assert set(events[0]) == {"at", "ip", "device_label", "result", "method"}

    assert len((await browser.get("/api/me/login-events?limit=1")).json()) == 1
    # Только выбранные результаты: по ним интерфейс ищет подозрительный вход
    only = await browser.get(
        "/api/me/login-events", params=[("result", "ok"), ("result", "bad_totp")]
    )
    assert [e["result"] for e in only.json()] == ["ok"]
    assert (await browser.get("/api/me/login-events?result=nope")).status_code == 422
    assert (await browser.get("/api/me/login-events?limit=0")).status_code == 422
    assert (await browser.get("/api/me/login-events?limit=1000")).status_code == 422

    # Старше 90 дней не показываются
    await db.execute(
        update(LoginEvent)
        .where(LoginEvent.result == "bad_password")
        .values(at=utcnow() - timedelta(days=91))
    )
    await db.commit()
    assert len((await browser.get("/api/me/login-events")).json()) == 1


async def test_reissue_recovery_codes(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
) -> None:
    member = await make_user()
    owner = await login(await make_client(), member)

    wrong = await owner.post("/api/me/recovery-codes", json={"code": "000000"})
    assert wrong.status_code == 400
    assert wrong.json()["error"]["code"] == "auth.invalid_code"
    bad_format = await owner.post("/api/me/recovery-codes", json={"code": "abc"})
    assert bad_format.status_code == 422

    first = (
        await owner.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    ).json()["recovery_codes"]
    second = await owner.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    assert second.status_code == 200
    new_codes = second.json()["recovery_codes"]
    assert len(new_codes) == 8 and not set(first) & set(new_codes)

    # Прежние коды больше не действуют, новые — действуют
    browser = await make_client("10.0.0.8")
    assert (await password_step(browser, member)).json()["status"] == "totp_required"
    assert (await code_step(browser, recovery_code=first[0])).status_code == 401
    assert (await code_step(browser, recovery_code=new_codes[0])).status_code == 200


async def test_reissue_needs_unused_code(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, totp_code: TotpCodeFn
) -> None:
    member = await make_user()
    await login(client, member)
    code = await totp_code(member)
    assert (await client.post("/api/me/recovery-codes", json={"code": code})).status_code == 200
    # Тот же код второй раз не принимается
    replay = await client.post("/api/me/recovery-codes", json={"code": code})
    assert replay.status_code == 400


async def _failure_notices(db: AsyncSession, user_id: int) -> list[tuple[str, str]]:
    rows = await db.execute(
        select(Notification.title, Notification.body)
        .where(Notification.user_id == user_id, Notification.kind == "login_failures")
        .order_by(Notification.id)
    )
    return [(r[0], r[1]) for r in rows.all()]


async def test_wrong_reissue_codes_end_that_session_not_owner_login(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    owner = await login(await make_client("198.51.100.1"), member)
    # У вора только украденная cookie сеанса, пароля и кода он не знает
    thief = await login(await make_client("203.0.113.7"), member)

    for _ in range(4):
        wrong = await thief.post("/api/me/recovery-codes", json={"code": "000000"})
        assert wrong.status_code == 400
        assert wrong.json()["error"]["code"] == "auth.invalid_code"
    fifth = await thief.post("/api/me/recovery-codes", json={"code": "000000"})
    assert fifth.status_code == 401
    assert fifth.json()["error"]["code"] == "auth.too_many_codes"
    # Сеанс вора завершен, дальнейшие попытки упираются в вход
    assert (await thief.get("/api/me")).status_code == 401
    for _ in range(5):
        again = await thief.post("/api/me/recovery-codes", json={"code": "000000"})
        assert again.json()["error"]["code"] == "auth.not_authenticated"

    # Владельца это не задело: его сеанс работает, коды выпускаются, вход с 2FA проходит
    assert (await owner.get("/api/me")).status_code == 200
    reissued = await owner.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    assert reissued.status_code == 200
    browser = await make_client("198.51.100.2")
    await full_login(browser, member, await totp_code(member))
    assert (await browser.get("/api/me")).status_code == 200

    notices = await _failure_notices(db, member.id)
    assert len(notices) == 1
    title, body = notices[0]
    assert "кабинете" in title
    assert "резервных кодов: 5" in body and "203.0.113.7" in body
    assert "Chrome · Windows" in body and "сеанс завершен" in body


async def test_reissue_counter_survives_parallel_requests(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn
) -> None:
    member = await make_user()
    await login(client, member)
    results = await asyncio.gather(
        *(client.post("/api/me/recovery-codes", json={"code": "000000"}) for _ in range(8))
    )
    # Код проверен не больше 5 раз: четыре ответа «код не подходит», остальные — сеанс завершен
    assert sorted(r.status_code for r in results) == [400] * 4 + [401] * 4
    assert (await client.get("/api/me")).status_code == 401


async def test_correct_reissue_code_resets_the_counter(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, totp_code: TotpCodeFn
) -> None:
    member = await make_user()
    await login(client, member)

    async def wrong_codes(count: int) -> None:
        for _ in range(count):
            response = await client.post("/api/me/recovery-codes", json={"code": "000000"})
            assert response.status_code == 400

    await wrong_codes(4)
    ok = await client.post("/api/me/recovery-codes", json={"code": await totp_code(member)})
    assert ok.status_code == 200
    # Верный код обнулил счетчик: еще четыре ошибки сеанс не завершают
    await wrong_codes(4)
    assert (await client.get("/api/me")).status_code == 200


async def test_notifications_list_and_read(
    client: httpx2.AsyncClient, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member = await make_user()
    await login(client, member)
    first = await notify(db, user_id=member.id, kind="new_device", device="Chrome", ip="1.1.1.1")
    second = await notify(db, user_id=member.id, kind="login_failures", ip="2.2.2.2")
    await db.commit()

    listed = (await client.get("/api/me/notifications")).json()
    assert listed["unread"] == 2
    assert {item["id"] for item in listed["items"]} == {first.id, second.id}
    item = next(i for i in listed["items"] if i["id"] == second.id)
    assert item["kind"] == "login_failures"
    assert "2.2.2.2" in item["body"] and item["title"] and item["read_at"] is None
    assert len((await client.get("/api/me/notifications?limit=1")).json()["items"]) == 1

    assert (await client.post(f"/api/me/notifications/{first.id}/read")).status_code == 204
    after = (await client.get("/api/me/notifications")).json()
    assert after["unread"] == 1
    # Повторная отметка не ошибка
    assert (await client.post(f"/api/me/notifications/{first.id}/read")).status_code == 204
    assert (await client.post("/api/me/notifications/999999/read")).status_code == 404

    assert (await client.post("/api/me/notifications/read-all")).status_code == 204
    final = (await client.get("/api/me/notifications")).json()
    assert final["unread"] == 0
    assert all(i["read_at"] is not None for i in final["items"])


async def test_trusted_devices_list_and_forget_current(
    client: httpx2.AsyncClient, make_user: UserFactory, totp_code: TotpCodeFn
) -> None:
    member = await make_user()
    await full_login(client, member, await totp_code(member), remember_device=True)
    devices = (await client.get("/api/me/trusted-devices")).json()
    assert len(devices) == 1
    device = devices[0]
    assert device["current"] is True
    assert device["device_label"] == "Chrome · Windows"
    assert device["ip"] == "10.0.0.1"
    assert device["expires_at"] > device["created_at"]

    response = await client.delete(f"/api/me/trusted-devices/{device['id']}")
    assert response.status_code == 204
    assert cookie_value(client, "device") is None
    assert (await client.get("/api/me/trusted-devices")).json() == []
    assert (await client.delete(f"/api/me/trusted-devices/{device['id']}")).status_code == 404
