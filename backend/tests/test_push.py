"""Push-уведомления браузера (этап 6): ключ VAPID, подписки устройств, тестовый push,
задача воркера send_push (отправка, отзыв по 404 и 410, повтор после 429 и 5xx, тихие часы
по поясу, значения по умолчанию В2), постановка задачи только после commit, тексты push без
сумм (В1), сообщение администратора с push (В8), экспорт и команда generate-vapid.

Сервис push подменен транспортом httpx (FakePushService): он записывает запросы, отвечает
заданными кодами и расшифровывает тело закрытым ключом «устройства» — так проверяется
настоящее шифрование aes128gcm и подпись VAPID. Время в проверках тихих часов задано явно.
"""

import hashlib
import json
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from datetime import UTC, datetime, time, timedelta
from typing import Any

import http_ece
import httpx
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from pydantic import SecretStr, ValidationError
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.admin import cli
from app.core.config import Settings
from app.core.i18n import _load, has_key
from app.core.vapid import b64url_decode, b64url_encode, generate_keys, keys_match, public_bytes
from app.db.models import Notification, PushSubscription, User
from app.db.models.auth import NOTIFICATION_KINDS
from app.services import push as push_service
from app.services.notification_prefs import default_push, push_allowed
from app.services.notifications import notify
from app.services.sessions import create_session
from app.workers import jobs
from tests.helpers_admin import admin_signed_in, error_code, signed_in
from tests.support import ClientFactory, LoginFn, SettingsOverride, UserFactory

PUBLIC_KEY, PRIVATE_KEY = generate_keys()
SUBJECT = "mailto:owner@example.com"
IPHONE_UA = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"
)
ANDROID_UA = (
    "Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36"
)


@dataclass
class Device:
    """Браузер с подпиской: закрытый ключ p256dh у него, сервер знает только публичный."""

    endpoint: str
    key: ec.EllipticCurvePrivateKey = field(
        default_factory=lambda: ec.generate_private_key(ec.SECP256R1())
    )
    secret: bytes = field(default_factory=lambda: hashlib.sha256(b"auth").digest()[:16])

    @property
    def keys(self) -> dict[str, str]:
        return {
            "p256dh": b64url_encode(public_bytes(self.key.public_key())),
            "auth": b64url_encode(self.secret),
        }

    def body(self) -> dict[str, Any]:
        return {"endpoint": self.endpoint, "keys": self.keys, "expirationTime": None}

    def decrypt(self, content: bytes) -> dict[str, Any]:
        plain = http_ece.decrypt(
            content, private_key=self.key, auth_secret=self.secret, version="aes128gcm"
        )
        data: dict[str, Any] = json.loads(plain)
        return data


def device(name: str) -> Device:
    return Device(endpoint=f"https://fcm.googleapis.com/fcm/send/{name}")


@dataclass
class FakePushService:
    """Сервис push: запросы по порядку; statuses[endpoint] — коды ответов по очереди
    (по умолчанию 201)."""

    requests: list[httpx.Request] = field(default_factory=list)
    statuses: dict[str, list[int]] = field(default_factory=dict)
    retry_after: str | None = None

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        queue = self.statuses.get(str(request.url), [])
        status = queue.pop(0) if queue else 201
        headers = {"Retry-After": self.retry_after} if self.retry_after else {}
        return httpx.Response(status, headers=headers)

    def client(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(transport=httpx.MockTransport(self.handler))

    def to(self, target: Device) -> list[httpx.Request]:
        return [item for item in self.requests if str(item.url) == target.endpoint]


@pytest.fixture
def vapid(override_settings: SettingsOverride) -> Settings:
    return override_settings(
        vapid_public_key=PUBLIC_KEY,
        vapid_private_key=SecretStr(PRIVATE_KEY),
        vapid_subject=SUBJECT,
        push_allow_http=False,
    )


@pytest.fixture
def push_server(monkeypatch: pytest.MonkeyPatch) -> FakePushService:
    fake = FakePushService()
    monkeypatch.setattr(push_service, "make_client", fake.client)
    return fake


@pytest.fixture
def queued(monkeypatch: pytest.MonkeyPatch) -> Iterator[list[dict[str, Any]]]:
    """Задачи send_push, которые ушли бы в очередь (после commit)."""
    items: list[dict[str, Any]] = []

    async def record(messages: list[dict[str, Any]]) -> None:
        items.extend(messages)

    monkeypatch.setattr(push_service, "enqueue", record)
    yield items


async def _subscribe(
    db: AsyncSession, user: User, target: Device, *, agent: str | None = ANDROID_UA
) -> PushSubscription:
    """Подписка в новом сеансе этого человека (как после входа на устройстве)."""
    keys = target.keys
    made = await create_session(db, user_id=user.id, ip="10.0.0.50", user_agent=agent)
    return await push_service.subscribe(
        db,
        user,
        endpoint=target.endpoint,
        p256dh=keys["p256dh"],
        auth=keys["auth"],
        user_agent=agent,
        session_id=made.session.id,
    )


def _message(user_id: int, kind: str = "bet_settled", **params: str) -> push_service.PushMessage:
    return push_service.build_message(
        user_id=user_id, kind=kind, variant=None, params={"bet": "75", **params}, link="/bets/75"
    )


# --- ключ, подписки, устройства ---


async def test_without_keys_push_is_off(
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    queued: list[dict[str, Any]],
) -> None:
    alice = await signed_in(make_client, make_user, login)
    assert (await alice.client.get("/api/me/push-config")).json() == {"vapid_public_key": None}
    refused = await alice.client.post("/api/me/push-subscriptions", json=device("a").body())
    assert refused.status_code == 409 and error_code(refused) == "push.not_configured"
    # Подписка осталась с тех пор, когда ключи были: без ключей ничего не уходит
    db.add(
        PushSubscription(
            user_id=alice.user.id, endpoint="https://fcm.googleapis.com/x", p256dh="p", auth="a"
        )
    )
    await db.commit()
    await notify(db, user_id=alice.user.id, kind="bet_settled", bet=1, status="won")
    await db.commit()
    await push_service.drain()
    assert queued == []
    result = await push_service.send_message(db, _message(alice.user.id))
    assert result.skipped == "disabled"
    tested = await alice.client.post("/api/me/push-subscriptions/test")
    assert tested.status_code == 409 and error_code(tested) == "push.not_configured"


async def test_subscribe_list_and_endpoint_hash(
    vapid: Settings, make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    alice = await signed_in(make_client, make_user, login)
    config = (await alice.client.get("/api/me/push-config")).json()
    assert config == {"vapid_public_key": PUBLIC_KEY}
    phone, laptop = device("phone"), device("laptop")
    made = await alice.client.post(
        "/api/me/push-subscriptions", json=phone.body(), headers={"User-Agent": IPHONE_UA}
    )
    assert made.status_code == 201, made.text
    body = made.json()
    assert body["device"] == "iPhone · Safari" and body["last_sent_at"] is None
    assert body["endpoint_hash"] == hashlib.sha256(phone.endpoint.encode()).hexdigest()[:16]
    assert "endpoint" not in body and phone.endpoint not in made.text
    unknown = await alice.client.post(
        "/api/me/push-subscriptions", json=laptop.body(), headers={"User-Agent": ""}
    )
    assert unknown.json()["device"] == "Браузер"
    listed = (await alice.client.get("/api/me/push-subscriptions")).json()["items"]
    assert [item["id"] for item in listed] == [unknown.json()["id"], body["id"]]
    prefs = (await alice.client.get("/api/me/notification-prefs")).json()
    assert prefs["push_available"] is True


@pytest.mark.parametrize(
    ("agent", "name"),
    [
        (IPHONE_UA, "iPhone · Safari"),
        (ANDROID_UA, "Android · Chrome"),
        (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)"
            " Chrome/141.0 Safari/537.36 Edg/141.0",
            "Windows · Edge",
        ),
        (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/537.36 (KHTML, like Gecko)"
            " Chrome/141.0 Safari/537.36",
            "Mac · Chrome",
        ),
        (
            "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
            "Linux · Firefox",
        ),
        (None, ""),
    ],
)
def test_device_name(agent: str | None, name: str) -> None:
    assert push_service.device_name(agent) == name


async def test_subscription_is_idempotent_and_moves_to_new_account(
    vapid: Settings,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    phone = device("shared-phone")
    first = (await alice.client.post("/api/me/push-subscriptions", json=phone.body())).json()
    again = (await alice.client.post("/api/me/push-subscriptions", json=phone.body())).json()
    assert again["id"] == first["id"] and again["created_at"] == first["created_at"]
    assert await db.scalar(select(func.count()).select_from(PushSubscription)) == 1
    # Доставка была — потом браузер достался Бобу: та же строка, но уже его и без истории
    row = await db.get_one(PushSubscription, first["id"])
    row.last_sent_at = datetime.now(UTC)
    await db.commit()
    bob = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    moved = (await bob.client.post("/api/me/push-subscriptions", json=phone.body())).json()
    assert moved["id"] == first["id"] and moved["last_sent_at"] is None
    assert moved["created_at"] > first["created_at"]
    assert (await alice.client.get("/api/me/push-subscriptions")).json()["items"] == []
    owner = await db.scalar(
        select(PushSubscription.user_id).execution_options(populate_existing=True)
    )
    assert owner == bob.user.id
    # Отозванная и снова подписанная — та же строка, снова активна
    assert (await bob.client.delete(f"/api/me/push-subscriptions/{first['id']}")).status_code == 204
    back = (await bob.client.post("/api/me/push-subscriptions", json=phone.body())).json()
    assert back["id"] == first["id"]
    assert [
        item["id"] for item in (await bob.client.get("/api/me/push-subscriptions")).json()["items"]
    ] == [first["id"]]


async def test_subscription_checks(
    vapid: Settings,
    override_settings: SettingsOverride,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    good = device("x").keys
    bad_endpoints = (
        "http://fcm.googleapis.com/fcm/send/x",
        "https://example.com/push/x",
        "https://user:pw@fcm.googleapis.com/x",
        "https://10.0.0.5/x",
        "ftp://fcm.googleapis.com/x",
        # urlsplit падает (ValueError) — тоже 422, а не 500
        "https://[::1].fcm.googleapis.com/x",
        "http://[::1",
        "https://fcm.googleapis.com:99999/x",
        "https://fcm.googleapis.com:abc/x",
    )
    for endpoint in bad_endpoints:
        refused = await alice.client.post(
            "/api/me/push-subscriptions", json={"endpoint": endpoint, "keys": good}
        )
        assert refused.status_code == 422, endpoint
        assert error_code(refused) == "push.endpoint_invalid"
    for host in (
        "updates.push.services.mozilla.com",
        "web.push.apple.com",
        "wns2-par02p.notify.windows.com",
    ):
        ok = await alice.client.post(
            "/api/me/push-subscriptions", json={"endpoint": f"https://{host}/x", "keys": good}
        )
        assert ok.status_code == 201, host
    too_long = "https://fcm.googleapis.com/" + "x" * 2000
    assert (
        await alice.client.post(
            "/api/me/push-subscriptions", json={"endpoint": too_long, "keys": good}
        )
    ).status_code == 422
    bad_keys = (
        {"p256dh": "not base64 !", "auth": good["auth"]},
        {"p256dh": b64url_encode(b"\x04" + b"\x01" * 64), "auth": good["auth"]},
        {"p256dh": good["p256dh"], "auth": b64url_encode(b"short")},
    )
    for keys in bad_keys:
        refused = await alice.client.post(
            "/api/me/push-subscriptions",
            json={"endpoint": "https://fcm.googleapis.com/fcm/send/k", "keys": keys},
        )
        assert refused.status_code == 422 and error_code(refused) == "push.keys_invalid"
    # Стек сквозных тестов и localhost: http и любой сервер (поддельный сервис push)
    override_settings(push_allow_http=True)
    local = await alice.client.post(
        "/api/me/push-subscriptions",
        json={"endpoint": "http://127.0.0.1:8099/push/abc", "keys": good},
    )
    assert local.status_code == 201, local.text


async def test_at_most_ten_active_subscriptions(
    vapid: Settings, make_user: UserFactory, db: AsyncSession
) -> None:
    alice = (await make_user()).user
    made = [await _subscribe(db, alice, device(f"d{n}")) for n in range(11)]
    active = await push_service.list_active(db, alice.id)
    assert len(active) == 10
    assert made[0].id not in {row.id for row in active}
    oldest = await db.get_one(PushSubscription, made[0].id, populate_existing=True)
    assert oldest.revoked_at is not None


async def test_revoke_by_id_and_by_endpoint(
    vapid: Settings,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    bob = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    mine, his = device("mine"), device("his")
    mine_id = (await alice.client.post("/api/me/push-subscriptions", json=mine.body())).json()["id"]
    his_id = (await bob.client.post("/api/me/push-subscriptions", json=his.body())).json()["id"]
    # Чужое: по id — 404, по endpoint — 204, но ничего не меняется
    foreign = await alice.client.delete(f"/api/me/push-subscriptions/{his_id}")
    assert foreign.status_code == 404 and error_code(foreign) == "push.subscription_not_found"
    other = await alice.client.post(
        "/api/me/push-subscriptions/revoke", json={"endpoint": his.endpoint}
    )
    assert other.status_code == 204
    unknown = await alice.client.post(
        "/api/me/push-subscriptions/revoke", json={"endpoint": "https://fcm.googleapis.com/nope"}
    )
    assert unknown.status_code == 204
    assert len((await bob.client.get("/api/me/push-subscriptions")).json()["items"]) == 1
    # Свое по endpoint (выход из аккаунта) и снова по id — 204
    own = await alice.client.post(
        "/api/me/push-subscriptions/revoke", json={"endpoint": mine.endpoint}
    )
    assert own.status_code == 204
    assert (await alice.client.get("/api/me/push-subscriptions")).json()["items"] == []
    assert (await alice.client.delete(f"/api/me/push-subscriptions/{mine_id}")).status_code == 204
    row = await db.get_one(PushSubscription, mine_id, populate_existing=True)
    assert row.revoked_at is not None
    prefs = (await alice.client.get("/api/me/notification-prefs")).json()
    assert prefs["push_available"] is False


# --- отправка ---


async def test_test_push_is_encrypted_and_signed(
    vapid: Settings,
    push_server: FakePushService,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    phone = device("phone")
    sub_id = (await alice.client.post("/api/me/push-subscriptions", json=phone.body())).json()["id"]
    sent = await alice.client.post("/api/me/push-subscriptions/test")
    assert sent.status_code == 202 and sent.json() == {"sent": 1}
    (request,) = push_server.to(phone)
    assert request.method == "POST"
    assert request.headers["TTL"] == str(12 * 3600)
    assert request.headers["Urgency"] == "normal"
    assert request.headers["Content-Encoding"] == "aes128gcm"
    assert request.headers["Content-Type"] == "application/octet-stream"
    assert len(request.headers["Topic"]) <= 32
    auth = request.headers["Authorization"]
    assert auth.startswith("vapid t=") and f"k={PUBLIC_KEY}" in auth
    assert Vapid02.verify(auth)
    token = auth.split("t=", 1)[1].split(",", 1)[0]
    claims = json.loads(b64url_decode(token.split(".")[1]))
    assert claims["aud"] == "https://fcm.googleapis.com" and claims["sub"] == SUBJECT
    assert claims["exp"] <= datetime.now(UTC).timestamp() + 24 * 3600
    payload = phone.decrypt(request.content)
    assert payload == {
        "title": "Проверка: push работает",
        "body": "Так будут приходить уведомления AI Capper",
        "url": "/profile/notifications",
        "tag": "test",
    }
    row = await db.get_one(PushSubscription, sub_id, populate_existing=True)
    assert row.last_sent_at is not None


async def test_test_push_limits(
    vapid: Settings,
    push_server: FakePushService,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    none = await alice.client.post("/api/me/push-subscriptions/test")
    assert none.status_code == 409 and error_code(none) == "push.no_subscriptions"
    await alice.client.post("/api/me/push-subscriptions", json=device("phone").body())
    for _ in range(push_service.TEST_LIMIT):
        assert (await alice.client.post("/api/me/push-subscriptions/test")).status_code == 202
    limited = await alice.client.post("/api/me/push-subscriptions/test")
    assert limited.status_code == 429 and error_code(limited) == "push.test_limit"
    assert 0 < int(limited.headers["Retry-After"]) <= 3600
    assert len(push_server.requests) == push_service.TEST_LIMIT


async def test_gone_subscriptions_are_revoked(
    vapid: Settings, push_server: FakePushService, make_user: UserFactory, db: AsyncSession
) -> None:
    alice = (await make_user()).user
    ok, gone, missing = device("ok"), device("gone"), device("missing")
    for target in (ok, gone, missing):
        await _subscribe(db, alice, target)
    push_server.statuses = {gone.endpoint: [410], missing.endpoint: [404]}
    result = await push_service.send_message(db, _message(alice.id))
    assert (result.sent, result.gone, result.failed, result.retry_ids) == (1, 2, 0, ())
    active = await push_service.list_active(db, alice.id)
    assert [row.endpoint for row in active] == [ok.endpoint]
    payload = ok.decrypt(push_server.to(ok)[0].content)
    assert payload == {
        "title": "Ставка №75 рассчитана",
        "body": "Откройте, чтобы посмотреть результат",
        "url": "/bets/75",
        "tag": "bet_settled-75",
    }


@dataclass
class FakeQueue:
    jobs: list[tuple[tuple[Any, ...], dict[str, Any]]] = field(default_factory=list)

    async def enqueue_job(self, *args: Any, **kwargs: Any) -> None:
        self.jobs.append((args, kwargs))


async def test_busy_push_service_is_retried_once(
    vapid: Settings,
    push_server: FakePushService,
    make_user: UserFactory,
    db: AsyncSession,
    engine: Any,
) -> None:
    from app.db.session import create_sessionmaker

    alice = (await make_user()).user
    ok, busy, limited = device("ok"), device("busy"), device("limited")
    subs = {target.endpoint: await _subscribe(db, alice, target) for target in (ok, busy, limited)}
    push_server.statuses = {busy.endpoint: [503], limited.endpoint: [429]}
    push_server.retry_after = "45"
    queue = FakeQueue()
    ctx: dict[Any, Any] = {"sessionmaker": create_sessionmaker(engine), "redis": queue}
    message = _message(alice.id).as_job()
    first = await jobs.send_push(ctx, message)
    assert (first["sent"], first["failed"]) == (1, 2)
    ((args, kwargs),) = queue.jobs
    retry_ids = sorted([subs[busy.endpoint].id, subs[limited.endpoint].id])
    assert args[0] == "send_push" and args[1] == message and args[2] == 1
    assert sorted(args[3]) == retry_ids and kwargs == {"_defer_by": 45}
    # Повтор: только эти подписки; второй сбой — пропуск без новой задачи
    push_server.statuses = {busy.endpoint: [500]}
    second = await jobs.send_push(ctx, message, 1, retry_ids)
    assert (second["sent"], second["failed"]) == (1, 1)
    assert len(queue.jobs) == 1
    assert len(push_server.to(ok)) == 1
    # Retry-After меньше 30 секунд или без него — в пределах 30 с … 10 мин
    push_server.retry_after = "5"
    push_server.statuses = {busy.endpoint: [502]}
    assert (await push_service.send_message(db, _message(alice.id))).retry_after == 30
    push_server.retry_after = None
    push_server.statuses = {busy.endpoint: [502]}
    assert (await push_service.send_message(db, _message(alice.id))).retry_after == 120


async def test_network_error_is_transient(
    vapid: Settings, monkeypatch: pytest.MonkeyPatch, make_user: UserFactory, db: AsyncSession
) -> None:
    def broken(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("down", request=request)

    monkeypatch.setattr(
        push_service,
        "make_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(broken)),
    )
    alice = (await make_user()).user
    sub = await _subscribe(db, alice, device("phone"))
    result = await push_service.send_message(db, _message(alice.id))
    assert result.retry_ids == (sub.id,) and result.sent == 0
    assert (await push_service.list_active(db, alice.id))[0].revoked_at is None


# --- тихие часы, настройки, обязательные виды ---


def _user(**fields: Any) -> User:
    base: dict[str, Any] = {
        "tz": "Europe/Helsinki",
        "quiet_enabled": True,
        "quiet_start": time(23, 0),
        "quiet_end": time(8, 0),
    }
    return User(**{**base, **fields})


@pytest.mark.parametrize(
    ("tz", "utc_hour", "quiet"),
    [
        # Хельсинки летом UTC+3: 20:00 UTC — 23:00 (начало включено), 05:00 UTC — 08:00
        ("Europe/Helsinki", 20, True),
        ("Europe/Helsinki", 19, False),
        ("Europe/Helsinki", 4, True),
        ("Europe/Helsinki", 5, False),
        # Токио UTC+9: 15:00 UTC — полночь, 00:00 UTC — 09:00
        ("Asia/Tokyo", 15, True),
        ("Asia/Tokyo", 0, False),
    ],
)
def test_quiet_hours_by_timezone(tz: str, utc_hour: int, quiet: bool) -> None:
    now = datetime(2026, 7, 1, utc_hour, 0, tzinfo=UTC)
    assert push_service.in_quiet_hours(_user(tz=tz), now) is quiet


def test_quiet_hours_window_inside_day_and_off() -> None:
    noon = datetime(2026, 7, 1, 10, 30, tzinfo=UTC)  # 13:30 в Хельсинки
    lunch = _user(quiet_start=time(13, 0), quiet_end=time(14, 0))
    assert push_service.in_quiet_hours(lunch, noon)
    assert not push_service.in_quiet_hours(lunch, noon + timedelta(hours=1))
    assert not push_service.in_quiet_hours(_user(quiet_enabled=False), noon.replace(hour=22))


async def test_quiet_hours_skip_push_but_not_login_alerts(
    vapid: Settings, push_server: FakePushService, make_user: UserFactory, db: AsyncSession
) -> None:
    alice = (await make_user(tz="Asia/Tokyo")).user
    phone = device("phone")
    await _subscribe(db, alice, phone)
    night = datetime(2026, 10, 16, 15, 30, tzinfo=UTC)  # 00:30 в Токио
    skipped = await push_service.send_message(db, _message(alice.id), now=night)
    assert skipped.skipped == "quiet" and push_server.requests == []
    for kind in ("new_device", "login_failures"):
        message = push_service.build_message(
            user_id=alice.id,
            kind=kind,
            variant=None,
            params={"device": "Chrome · Windows", "ip": "1.2.3.4"},
            link="/profile/security",
            ref="9",
        )
        assert (await push_service.send_message(db, message, now=night)).sent == 1
    urgencies = [request.headers["Urgency"] for request in push_server.requests]
    assert urgencies == ["high", "normal"]
    morning = datetime(2026, 10, 16, 23, 30, tzinfo=UTC)  # 08:30 в Токио
    assert (await push_service.send_message(db, _message(alice.id), now=morning)).sent == 1
    # Тихие часы выключены — push круглые сутки
    alice.quiet_enabled = False
    await db.commit()
    assert (await push_service.send_message(db, _message(alice.id), now=night)).sent == 1


async def test_push_defaults_and_prefs(
    vapid: Settings,
    push_server: FakePushService,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    # В2: push включен у всех видов, кроме обучения модели и сигналов расхода ИИ
    assert [kind for kind in NOTIFICATION_KINDS if not default_push(kind)] == [
        "ai_alert",
        "learning",
    ]
    admin = await admin_signed_in(make_client, make_user, login)
    prefs = {
        item["kind"]: item["push"]
        for item in (await admin.client.get("/api/me/notification-prefs")).json()["items"]
        if item["admin"]
    }
    assert prefs["learning"] is False and prefs["ai_alert"] is False
    assert prefs["data_stale"] is True
    alice = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    uid = alice.user.id
    assert await push_allowed(db, uid, "bet_settled")
    off = await alice.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "bet_settled", "push": False}]}
    )
    assert off.status_code == 200, off.text
    item = next(row for row in off.json()["items"] if row["kind"] == "bet_settled")
    assert (item["on_site"], item["push"]) == (True, False)
    # Смена «на сайте» не трогает push (строка пишется с обоими значениями)
    site = await alice.client.put(
        "/api/me/notification-prefs",
        json={
            "items": [
                {"kind": "bet_settled", "on_site": False},
                {"kind": "weekly_report", "on_site": False},
            ]
        },
    )
    items = {row["kind"]: row for row in site.json()["items"]}
    assert (items["bet_settled"]["on_site"], items["bet_settled"]["push"]) == (False, False)
    assert (items["weekly_report"]["on_site"], items["weekly_report"]["push"]) == (False, True)
    await _subscribe(db, alice.user.user, device("phone"))
    assert (await push_service.send_message(db, _message(uid))).skipped == "pref"
    # Обязательные: на сайте всегда, push выключить можно
    required = await alice.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "new_device", "push": False}]}
    )
    assert required.status_code == 200
    row = next(item for item in required.json()["items"] if item["kind"] == "new_device")
    assert (row["on_site"], row["push"], row["required"]) == (True, False, True)
    message = push_service.build_message(
        user_id=uid, kind="new_device", variant=None, params={"device": "x"}, link=None
    )
    assert (await push_service.send_message(db, message)).skipped == "pref"
    bodies: tuple[dict[str, Any], ...] = (
        {"items": [{"kind": "new_device", "on_site": False}]},
        {"items": [{"kind": "bet_settled"}]},
        {"items": []},
        {},
    )
    for body in bodies:
        assert (await alice.client.put("/api/me/notification-prefs", json=body)).status_code == 422
    assert push_server.requests == []


async def test_quiet_hours_settings(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    alice = await signed_in(make_client, make_user, login)
    saved = await alice.client.put(
        "/api/me/notification-prefs",
        json={"quiet_hours": {"enabled": False, "start": "22:30", "end": "07:00"}},
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["quiet_hours"] == {"enabled": False, "start": "22:30", "end": "07:00"}
    row = await db.get_one(User, alice.user.id, populate_existing=True)
    assert (row.quiet_enabled, row.quiet_start, row.quiet_end) == (False, time(22, 30), time(7))
    same = await alice.client.put(
        "/api/me/notification-prefs",
        json={"quiet_hours": {"enabled": True, "start": "07:00", "end": "07:00"}},
    )
    assert same.status_code == 422 and error_code(same) == "notification.quiet_same"
    for start in ("23:15", "24:00", "7:00", "07:00:00"):
        bad = await alice.client.put(
            "/api/me/notification-prefs",
            json={"quiet_hours": {"enabled": True, "start": start, "end": "08:00"}},
        )
        assert bad.status_code == 422, start
    # Вместе с видами — одним запросом
    both = await alice.client.put(
        "/api/me/notification-prefs",
        json={
            "items": [{"kind": "weekly_report", "push": False}],
            "quiet_hours": {"enabled": True, "start": "00:00", "end": "06:30"},
        },
    )
    assert both.json()["quiet_hours"] == {"enabled": True, "start": "00:00", "end": "06:30"}


async def test_blocked_user_gets_no_push(
    vapid: Settings, push_server: FakePushService, make_user: UserFactory, db: AsyncSession
) -> None:
    alice = (await make_user()).user
    await _subscribe(db, alice, device("phone"))
    alice.status = "blocked"
    await db.commit()
    assert (await push_service.send_message(db, _message(alice.id))).skipped == "user"
    assert push_server.requests == []


# --- постановка задачи из notify ---


async def test_notify_schedules_push_only_after_commit(
    vapid: Settings, make_user: UserFactory, db: AsyncSession, queued: list[dict[str, Any]]
) -> None:
    alice = (await make_user()).user
    bob = (await make_user()).user
    await _subscribe(db, alice, device("phone"))
    # Откат действия — push не уходит
    await notify(db, user_id=alice.id, kind="bet_settled", link="/bets/7", bet=7, status="won")
    await db.rollback()
    await push_service.drain()
    assert queued == []
    await db.refresh(alice)
    await db.refresh(bob)
    # Без подписки (Боб) — задачи нет; у Алисы — после commit
    note = await notify(
        db,
        user_id=alice.id,
        kind="bet_settled",
        variant="auto",
        link="/bets/7",
        bet=7,
        status="won",
        outcome="выигрыш +1 500 ₽",
        bank="70 485 ₽",
    )
    await notify(db, user_id=bob.id, kind="bet_settled", bet=8, status="lost")
    assert note is not None
    await push_service.drain()
    assert queued == []
    await db.commit()
    await push_service.drain()
    assert queued == [
        {
            "user_id": alice.id,
            "kind": "bet_settled",
            "title": "Ставка №7 рассчитана",
            "body": "Откройте, чтобы посмотреть результат",
            "url": "/bets/7",
            "tag": "bet_settled-7",
            "urgency": "normal",
        }
    ]
    # Вид выключен на сайте, push включен: в колокольчике нет, push уходит
    queued.clear()
    from app.schemas.cabinet import NotificationPrefIn
    from app.services.notification_prefs import update_prefs

    await update_prefs(db, alice, [NotificationPrefIn(kind="settle_conflict", on_site=False)])
    none = await notify(
        db, user_id=alice.id, kind="settle_conflict", bet=9, event="x", archive="a", yours="b"
    )
    await db.commit()
    await push_service.drain()
    assert none is None and [item["tag"] for item in queued] == ["settle_conflict-9"]
    notes = await db.scalar(
        select(func.count()).select_from(Notification).where(Notification.kind == "settle_conflict")
    )
    assert notes == 0
    # Выключен и push — ни уведомления, ни задачи
    queued.clear()
    await update_prefs(db, alice, [NotificationPrefIn(kind="settle_conflict", push=False)])
    assert await notify(db, user_id=alice.id, kind="settle_conflict", bet=9) is None
    await db.commit()
    await push_service.drain()
    assert queued == []


# --- тексты push без сумм (В1) ---

# Параметры уведомлений с деньгами и банком — их не должно быть в тексте push
_MONEY_PARAMS = {
    "bank": "70 485 ₽",
    "profit": "+1 234 ₽",
    "outcome": "выигрыш +1 500 ₽",
    "result": "выигрыш 2 345 ₽",
    "spent": "12.34",
    "limit": "56.78",
    "budget": "90.12",
    "cost": "0.61",
    "need": "3.45",
    "left": "6.78",
    "median": "0.42",
    "cap": "1.50",
    "currency": "RUB",
    "roi": "+7.5%",
    "clv": "+2.1%",
}
_OTHER_PARAMS = {
    "bet": "75",
    "code": "L-022",
    "week": "28 сен – 4 окт",
    "device": "Chrome · Windows",
    "ip": "203.0.113.7",
    "text": "Работы на сервере в субботу",
    "model": "elo-2026-10",
    "name": "Боб Участник",
    "subject": "12",
    "rule": "cache",
    "count": "5",
    "minutes": "15",
    "pct": "80",
    "days": "3",
    "event": "Синнер — Алькарас",
    "archive": "победа Синнера",
    "yours": "победа Алькараса",
    "reason": "снятие игрока",
}


def _variants(kind: str) -> list[str | None]:
    node = _load("ru")["notifications"][kind]
    return [None, *(name for name, value in node.items() if isinstance(value, dict))]


@pytest.mark.parametrize("kind", NOTIFICATION_KINDS)
def test_push_texts_have_no_money_or_other_people(kind: str) -> None:
    assert has_key(f"push.{kind}.title") and has_key(f"push.{kind}.body")
    for variant in _variants(kind):
        message = push_service.build_message(
            user_id=1,
            kind=kind,
            variant=variant,
            params={**_MONEY_PARAMS, **_OTHER_PARAMS},
            link="/x",
            ref="1",
        )
        text = f"{message.title} {message.body}"
        assert "{" not in text, (kind, variant, text)
        for sign in ("₽", "$", "€", "RUB", "USD", "EUR", "%"):
            assert sign not in text, (kind, variant, text)
        for name, value in _MONEY_PARAMS.items():
            assert value not in text, (kind, variant, name)
        # Имя другого участника (у администратора — просьбы и лимиты участников)
        assert _OTHER_PARAMS["name"] not in text, (kind, variant)
        assert _OTHER_PARAMS["ip"] not in text, (kind, variant)


def test_push_variant_texts_are_complete() -> None:
    tree = _load("ru")["push"]
    for kind in NOTIFICATION_KINDS:
        for name, value in tree[kind].items():
            if isinstance(value, dict):
                assert set(value) == {"title", "body"}, (kind, name)
                assert name in _variants(kind), (kind, name)


# --- сообщение администратора (В8) ---


async def test_admin_message_push(
    vapid: Settings,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
    queued: list[dict[str, Any]],
) -> None:
    admin = await admin_signed_in(make_client, make_user, login)
    alice = await signed_in(make_client, make_user, login, ip="10.0.0.2")
    await make_user()
    await _subscribe(db, alice.user.user, device("alice-phone"))
    listed = (await admin.client.get("/api/admin/messages")).json()
    assert (listed["recipients_all"], listed["push_recipients_all"]) == (2, 1)
    preview = await admin.client.post(
        "/api/admin/messages", json={"text": "Работы на сервере", "preview": True}
    )
    assert preview.json()["push_recipients"] == 1 and preview.json()["also_push"] is True
    assert "alice-phone" not in preview.text
    sent = await admin.client.post("/api/admin/messages", json={"text": "Работы на сервере"})
    assert sent.status_code == 201 and sent.json()["push_recipients"] == 1
    await push_service.drain()
    assert [(item["user_id"], item["title"], item["body"]) for item in queued] == [
        (alice.user.id, "Сообщение администратора", "Работы на сервере")
    ]
    queued.clear()
    quiet = await admin.client.post(
        "/api/admin/messages", json={"text": "Без push", "also_push": False}
    )
    assert quiet.json()["push_recipients"] == 0 and quiet.json()["also_push"] is False
    await push_service.drain()
    assert queued == []
    history = (await admin.client.get("/api/admin/messages")).json()["items"]
    assert [(item["also_push"], item["push_recipients"]) for item in history] == [
        (False, 0),
        (True, 1),
    ]
    # Участница выключила push сообщений администратора — в числе ее нет
    await alice.client.put(
        "/api/me/notification-prefs", json={"items": [{"kind": "admin_message", "push": False}]}
    )
    one = await admin.client.post(
        "/api/admin/messages",
        json={"text": "Лично", "user_id": alice.user.id, "preview": True},
    )
    assert one.json()["push_recipients"] == 0


# --- экспорт, ключи, команда ---


async def test_export_has_devices_without_endpoint(
    vapid: Settings,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    alice = await signed_in(make_client, make_user, login)
    phone = device("export-phone")
    await alice.client.post(
        "/api/me/push-subscriptions", json=phone.body(), headers={"User-Agent": IPHONE_UA}
    )
    exported = await alice.client.get("/api/me/export")
    data = exported.json()
    (row,) = data["tables"]["push_subscriptions"]
    assert row["device"] == "iPhone · Safari" and row["revoked_at"] is None
    assert phone.endpoint not in exported.text and phone.keys["p256dh"] not in exported.text
    profile = data["profile"]
    assert (profile["quiet_enabled"], profile["quiet_start"], profile["quiet_end"]) == (
        True,
        "23:00:00",
        "08:00:00",
    )


def test_generate_vapid_command(capsys: pytest.CaptureFixture[str]) -> None:
    assert cli.main(["generate-vapid", "--subject", "mailto:owner@example.com"]) == 0
    lines = capsys.readouterr().out.strip().splitlines()
    values = dict(line.split("=", 1) for line in lines)
    assert list(values) == [
        "CAPPER_VAPID_PUBLIC_KEY",
        "CAPPER_VAPID_PRIVATE_KEY",
        "CAPPER_VAPID_SUBJECT",
    ]
    assert keys_match(values["CAPPER_VAPID_PUBLIC_KEY"], values["CAPPER_VAPID_PRIVATE_KEY"])
    assert values["CAPPER_VAPID_SUBJECT"] == "mailto:owner@example.com"
    assert cli.main(["generate-vapid", "--subject", "owner@example.com"]) == 1


def _settings(**fields: Any) -> Callable[[], Settings]:
    return lambda: Settings(_env_file=None, **fields)


def test_vapid_settings_are_checked() -> None:
    other_public, _ = generate_keys()
    good = {
        "vapid_public_key": PUBLIC_KEY,
        "vapid_private_key": PRIVATE_KEY,
        "vapid_subject": SUBJECT,
    }
    assert _settings(**good)().push_enabled
    assert not _settings()().push_enabled
    broken = (
        {"vapid_public_key": PUBLIC_KEY},
        {**good, "vapid_public_key": other_public},
        {**good, "vapid_private_key": "short"},
        {**good, "vapid_subject": "owner@example.com"},
        {**good, "vapid_subject": "https://example.com/path"},
    )
    for fields in broken:
        with pytest.raises(ValidationError):
            _settings(**fields)()


async def test_redis_counter_is_per_user(
    vapid: Settings,
    push_server: FakePushService,
    make_user: UserFactory,
    db: AsyncSession,
    redis: Redis,
) -> None:
    """Лимит тестового push у каждого свой: чужие пять попыток не закрывают свои."""
    alice = (await make_user()).user
    bob = (await make_user()).user
    await _subscribe(db, alice, device("a"))
    await _subscribe(db, bob, device("b"))
    for _ in range(push_service.TEST_LIMIT):
        await push_service.send_test(db, redis, alice)
    assert await push_service.send_test(db, redis, bob) == 1


async def test_fake_push_service_for_e2e(
    vapid: Settings,
    override_settings: SettingsOverride,
    monkeypatch: pytest.MonkeyPatch,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
) -> None:
    """Поддельный сервис push стека сквозных тестов (tests/fake_push.py): выдает подписку,
    принимает push, проверяет подпись и расшифровывает текст, отвечает заданным кодом."""
    from tests import fake_claude, fake_push

    override_settings(push_allow_http=True)
    transport = httpx.ASGITransport(app=fake_claude.app)
    monkeypatch.setattr(
        push_service,
        "make_client",
        lambda: httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8099"),
    )
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8099") as fake:
        await fake.post("/_fake/push/reset")
        subscription = (await fake.post("/_fake/push/subscription")).json()
        device_id = subscription["endpoint"].rsplit("/", 1)[1]
        assert subscription["endpoint"] == f"http://127.0.0.1:8099/push/{device_id}"
        alice = await signed_in(make_client, make_user, login)
        made = await alice.client.post("/api/me/push-subscriptions", json=subscription)
        assert made.status_code == 201, made.text
        assert (await alice.client.post("/api/me/push-subscriptions/test")).json() == {"sent": 1}
        (item,) = (await fake.get("/_fake/push", params={"device": device_id})).json()["items"]
        assert item["status"] == 201 and item["vapid"] is True
        assert item["aud"] == "http://127.0.0.1:8099"
        assert item["headers"]["content_encoding"] == "aes128gcm"
        assert item["payload"]["title"] == "Проверка: push работает"
        # Подписка «истекла» у сервиса — 410, сервер ее отзывает
        await fake.post("/_fake/push/fail", json={"status": 410, "device": device_id})
        assert (await alice.client.post("/api/me/push-subscriptions/test")).json() == {"sent": 0}
        assert (await alice.client.get("/api/me/push-subscriptions")).json()["items"] == []
        cors = await fake.get("/_fake/push", headers={"Origin": "http://localhost:4173"})
        assert cors.headers["access-control-allow-origin"] == "*"
    assert fake_push.STATE.devices


# --- подписка живет вместе с сеансом ---


async def _active_endpoints(db: AsyncSession, user_id: int) -> list[str]:
    db.expire_all()
    return sorted(row.endpoint for row in await push_service.list_active(db, user_id))


async def test_push_follows_session(
    vapid: Settings,
    push_server: FakePushService,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    """«Выйти на других устройствах», смена пароля и выход отзывают подписки чужих сеансов;
    свое устройство push получает дальше. Новый вход и повторная подписка перепривязывают
    подписку к новому сеансу."""
    alice = await signed_in(make_client, make_user, login)
    uid = alice.user.id
    other = await login(await make_client("10.0.0.9"), alice.user)
    mine, thief = device("mine"), device("thief")
    assert (await alice.client.post("/api/me/push-subscriptions", json=mine.body())).is_success
    assert (await other.post("/api/me/push-subscriptions", json=thief.body())).is_success
    assert (await push_service.send_message(db, _message(uid))).sent == 2
    # «Выйти на всех других устройствах»
    ended = await alice.client.post("/api/me/sessions/revoke-others")
    assert ended.status_code == 204
    assert (await other.get("/api/me")).status_code == 401
    assert await _active_endpoints(db, uid) == [mine.endpoint]
    push_server.requests.clear()
    assert (await push_service.send_message(db, _message(uid))).sent == 1
    assert len(push_server.to(mine)) == 1 and push_server.to(thief) == []
    # Снова вошли на том устройстве и включили push — та же строка, новый сеанс
    other = await login(await make_client("10.0.0.9"), alice.user)
    again = await other.post("/api/me/push-subscriptions", json=thief.body())
    assert again.status_code == 201
    assert await _active_endpoints(db, uid) == sorted([mine.endpoint, thief.endpoint])
    # Смена пароля: свое устройство остается (подписка переходит к новому сеансу)
    before = await db.scalar(
        select(PushSubscription.session_id).where(PushSubscription.endpoint == mine.endpoint)
    )
    changed = await alice.client.post(
        "/api/me/password",
        json={"current_password": alice.user.password, "new_password": "new-long-password-2026"},
    )
    assert changed.status_code == 204, changed.text
    assert await _active_endpoints(db, uid) == [mine.endpoint]
    after = await db.scalar(
        select(PushSubscription.session_id).where(PushSubscription.endpoint == mine.endpoint)
    )
    assert after is not None and after != before
    assert (await alice.client.get("/api/me/push-subscriptions")).json()["items"][0][
        "endpoint_hash"
    ] == hashlib.sha256(mine.endpoint.encode()).hexdigest()[:16]
    push_server.requests.clear()
    assert (await push_service.send_message(db, _message(uid))).sent == 1
    assert push_server.to(thief) == []
    # Выход на своем устройстве — и его push выключен
    assert (await alice.client.post("/api/auth/logout")).status_code < 300
    assert await _active_endpoints(db, uid) == []


async def test_expired_session_gets_no_push(
    vapid: Settings,
    push_server: FakePushService,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    """Сеанс истек (его никто не отзывал) или удален ночной очисткой — push туда не уходит,
    подписки нет ни в списке, ни в числе получателей, столбец «Push» неактивен."""
    from app.db.models import UserSession

    alice = (await make_user()).user
    sub = await _subscribe(db, alice, device("phone"))
    assert await push_service.users_with_push(db, [alice.id], "admin_message") == 1
    session = await db.get_one(UserSession, sub.session_id)
    session.expires_at = datetime.now(UTC) - timedelta(minutes=1)
    await db.commit()
    assert await push_service.list_active(db, alice.id) == []
    assert (await push_service.send_message(db, _message(alice.id))).skipped == ("no_subscriptions")
    assert await push_service.users_with_push(db, [alice.id], "admin_message") == 0
    # Бездействие дольше срока — то же
    session.expires_at = datetime.now(UTC) + timedelta(days=1)
    session.last_seen_at = datetime.now(UTC) - timedelta(days=60)
    await db.commit()
    assert await push_service.list_active(db, alice.id) == []
    # Ночная очистка удалила сеанс — у подписки сеанса нет, push не уходит
    await db.delete(session)
    await db.commit()
    row = await db.get_one(PushSubscription, sub.id, populate_existing=True)
    assert row.session_id is None and row.revoked_at is None
    assert await push_service.list_active(db, alice.id) == []
    assert push_server.requests == []
    bob = await signed_in(make_client, make_user, login, ip="10.0.0.3")
    prefs = (await bob.client.get("/api/me/notification-prefs")).json()
    assert prefs["push_available"] is False


async def test_admin_reset_of_sessions_revokes_push(
    vapid: Settings,
    make_client: ClientFactory,
    make_user: UserFactory,
    login: LoginFn,
    db: AsyncSession,
) -> None:
    """Администратор завершил все сеансы участника — подписки участника отозваны."""
    from app.services.sessions import revoke_user_sessions

    alice = (await make_user()).user
    await _subscribe(db, alice, device("a1"))
    await _subscribe(db, alice, device("a2"))
    assert len(await push_service.list_active(db, alice.id)) == 2
    assert await revoke_user_sessions(db, alice.id) == 2
    await db.commit()
    revoked = await db.scalar(
        select(func.count())
        .select_from(PushSubscription)
        .where(PushSubscription.revoked_at.is_not(None))
    )
    assert revoked == 2
