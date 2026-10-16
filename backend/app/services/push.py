"""Push-уведомления браузера (Web Push, этап 6, Р3, Р26).

Подписки. Браузер подписывается у своего сервиса push (FCM, Mozilla, Apple, Windows) с
публичным ключом VAPID сервера и присылает endpoint и ключи (POST /api/me/push-subscriptions).
Одна строка на endpoint: повтор той же подписки — та же строка; если браузер раньше был у
другого аккаунта, строка переходит к текущему (снимается revoked_at, обнуляется
last_sent_at). Подписка привязана к сеансу, в котором ее включили (session_id; повтор после
нового входа — к новому сеансу): отзыв сеанса отзывает ее (app/services/sessions.py), а push
уходит только на подписки с действующим сеансом. Активных подписок у человека не больше
MAX_ACTIVE: лишние, самые старые, отзываются. Отзыв — revoked_at: «Отключить», выход из
аккаунта на устройстве, отзыв сеанса, ответ 404 или 410 сервиса push.

Отправка. notifications.notify после записи уведомления ставит задачу воркера send_push —
только после commit транзакции (schedule и слушатель after_commit ниже): если действие
откатилось, push не уходит. В задаче: человек активен, вид разрешен в push
(notification_prefs.push_allowed, значения по умолчанию В2), сейчас не тихие часы по его
поясу (кроме входа с нового устройства и неудачных попыток входа) — и запрос на каждую
активную подписку: payload JSON {title, body, url, tag}, шифрование aes128gcm (RFC 8291) и
подпись VAPID (RFC 8292) — pywebpush и py_vapid в отдельном потоке, запрос — httpx, цикл
событий не блокируется. TTL 12 часов, urgency high у входа с нового устройства. Тихие
часы: push не досылается позже, уведомление ждет в колокольчике.

Ответы сервиса push: 2xx — last_sent_at; 404 и 410 — подписка отозвана; 429, 5xx и сбой
сети — один повтор этих подписок через Retry-After (от 30 секунд до 10 минут, по умолчанию
2 минуты), после второго сбоя — пропуск; остальные 4xx — пропуск с записью в лог.

Тексты push — свои ключи локали push.<вид>[.<повод>].title и .body: без сумм, банка и
прибыли (В1, push видно на заблокированном экране) и без данных других участников. tag —
вид и номер сущности (ставка, урок, правило): повтор того же события заменяет push на
телефоне, а не копит их; заголовок Topic — хеш tag, им сервис push заменяет еще не
доставленный push.
"""

import asyncio
import hashlib
import json
import secrets
from collections.abc import Sequence
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta
from functools import lru_cache
from typing import Any
from urllib.parse import urlsplit

import httpx
import structlog
from py_vapid import Vapid02
from pywebpush import WebPusher
from redis.asyncio import Redis
from sqlalchemy import case, event, null, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.core.config import Settings, get_settings
from app.core.errors import AppError
from app.core.i18n import has_key, t
from app.core.redis import redis_key
from app.core.useragent import clip_user_agent, push_device_parts
from app.core.vapid import b64url_decode, b64url_encode, is_public_point, load_private_key
from app.db.models import PushSubscription, User, UserSession
from app.schemas.push import ENDPOINT_MAX_LENGTH
from app.services.bank import user_zone
from app.services.notification_prefs import push_allowed
from app.services.sessions import session_alive, utcnow

log = structlog.get_logger()

PUSH_JOB = "send_push"
# Активных подписок у одного человека (лишние, самые старые, отзываются)
MAX_ACTIVE = 10
AUTH_KEY_BYTES = 16
# Сколько сервис push хранит недоставленный push (телефон без сети)
TTL_SECONDS = 12 * 3600
# Срок подписи VAPID: не больше суток (RFC 8292), берем столько же, сколько TTL
VAPID_EXP_SECONDS = 12 * 3600
SEND_TIMEOUT_SECONDS = 10.0
# Повтор после 429 и 5xx: один раз, через Retry-After в этих пределах
RETRY_DEFAULT_SECONDS = 120
RETRY_MIN_SECONDS = 30
RETRY_MAX_SECONDS = 600
# Тестовый push: не чаще TEST_LIMIT раз за TEST_WINDOW_SECONDS
TEST_LIMIT = 5
TEST_WINDOW_SECONDS = 3600
# Длина текста push: экран блокировки все равно показывает две-три строки
TITLE_MAX = 120
BODY_MAX = 300
# Приходят и в тихие часы: защита аккаунта
ALWAYS_KINDS = frozenset({"new_device", "login_failures"})
HIGH_URGENCY_KINDS = frozenset({"new_device"})
# Параметр уведомления — номер сущности для tag (первый найденный)
_TAG_PARAMS = ("bet", "code", "subject", "rule", "week", "model")
# Каждое такое уведомление — отдельное событие: tag с номером уведомления
_UNIQUE_KINDS = frozenset({"new_device", "login_failures", "admin_message"})
# Ответы сервиса push: подписки больше нет
GONE_STATUSES = frozenset({404, 410})
# Запрос не собран (шифрование или подпись): не повторяем и подписку не трогаем
LOCAL_ERROR = -1
TEST_LINK = "/profile/notifications"
_PENDING_KEY = "push_pending"


@dataclass(frozen=True)
class PushMessage:
    """Что увидит человек: заголовок, текст, ссылка внутри приложения и tag."""

    user_id: int
    kind: str
    title: str
    body: str
    url: str
    tag: str
    urgency: str = "normal"

    def payload(self) -> bytes:
        data = {"title": self.title, "body": self.body, "url": self.url, "tag": self.tag}
        return json.dumps(data, ensure_ascii=False).encode()

    @property
    def topic(self) -> str:
        """Заголовок Topic: не длиннее 32 знаков base64url (RFC 8030)."""
        digest = hashlib.sha256(self.tag.encode()).digest()
        return b64url_encode(digest)[:32]

    def as_job(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_job(cls, data: dict[str, Any]) -> "PushMessage":
        return cls(**{name: data[name] for name in cls.__dataclass_fields__ if name in data})


@dataclass(frozen=True)
class Delivery:
    """Итог запроса к сервису push по одной подписке. status None — сбой сети, LOCAL_ERROR —
    запрос не собран."""

    subscription_id: int
    status: int | None
    retry_after: int | None = None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300

    @property
    def gone(self) -> bool:
        return self.status in GONE_STATUSES

    @property
    def transient(self) -> bool:
        return self.status is None or self.status == 429 or self.status >= 500


@dataclass(frozen=True)
class SendResult:
    """Итог задачи: сколько доставлено, почему пропущено (skipped), какие подписки
    повторить и через сколько секунд."""

    sent: int = 0
    gone: int = 0
    failed: int = 0
    skipped: str | None = None
    retry_ids: tuple[int, ...] = ()
    retry_after: int = RETRY_DEFAULT_SECONDS


def endpoint_hash(endpoint: str) -> str:
    """Первые 16 hex sha256(endpoint): фронтенд считает тот же хеш своей подписки и
    помечает «это устройство». Сам endpoint в ответы не попадает."""
    return hashlib.sha256(endpoint.encode()).hexdigest()[:16]


def device_name(user_agent: str | None) -> str:
    """«iPhone · Safari», «Android · Chrome»; не удалось узнать — пустая строка (в ответе —
    подпись push.device_unknown)."""
    return " · ".join(part for part in push_device_parts(user_agent) if part)


def device_label(device: str) -> str:
    return device or t("push.device_unknown")


def config_key(settings: Settings | None = None) -> str | None:
    """Публичный ключ VAPID для браузера; None — ключей на сервере нет, push выключен."""
    settings = settings or get_settings()
    return settings.vapid_public_key.strip() if settings.push_enabled else None


# --- подписки ---


def _host_allowed(host: str, settings: Settings) -> bool:
    return any(host == item or host.endswith("." + item) for item in settings.push_hosts)


def check_endpoint(endpoint: str, settings: Settings | None = None) -> None:
    """Адрес сервиса push: https и сервер из push_service_hosts. С push_allow_http (localhost,
    тесты, стек сквозных тестов) — http и https на любом сервере. Иначе 422."""
    settings = settings or get_settings()
    try:
        parts = urlsplit(endpoint)
        port_ok = parts.port is None or parts.port > 0
    except ValueError:  # «http://[::1», порт не числом
        raise AppError(422, "push.endpoint_invalid") from None
    schemes = ("https", "http") if settings.push_allow_http else ("https",)
    host = (parts.hostname or "").lower()
    valid = (
        len(endpoint) <= ENDPOINT_MAX_LENGTH
        and parts.scheme in schemes
        and bool(host)
        and parts.username is None
        and parts.password is None
        and port_ok
        and (settings.push_allow_http or _host_allowed(host, settings))
    )
    if not valid:
        raise AppError(422, "push.endpoint_invalid")


def check_keys(p256dh: str, auth: str) -> None:
    """p256dh — точка P-256 (65 байт), auth — 16 байт, оба base64url. Иначе 422."""
    try:
        point = b64url_decode(p256dh)
        secret = b64url_decode(auth)
    except ValueError:
        raise AppError(422, "push.keys_invalid") from None
    if not is_public_point(point) or len(secret) != AUTH_KEY_BYTES:
        raise AppError(422, "push.keys_invalid")


async def subscribe(
    db: AsyncSession,
    user: User,
    *,
    endpoint: str,
    p256dh: str,
    auth: str,
    user_agent: str | None,
    session_id: int,
) -> PushSubscription:
    """Сохранить подписку этого браузера (идемпотентно по endpoint) и привязать ее к
    текущему сеансу session_id: подписка живет, пока жив сеанс. Ключей VAPID на сервере
    нет — 409 push.not_configured. Делает commit."""
    settings = get_settings()
    if not settings.push_enabled:
        raise AppError(409, "push.not_configured")
    check_endpoint(endpoint, settings)
    check_keys(p256dh, auth)
    now = utcnow()
    agent = clip_user_agent(user_agent)
    stmt = insert(PushSubscription).values(
        user_id=user.id,
        endpoint=endpoint,
        p256dh=p256dh,
        auth=auth,
        user_agent=agent,
        device=device_name(agent),
        session_id=session_id,
        created_at=now,
    )
    table = PushSubscription.__table__
    # Подписка вернулась (была отозвана) или перешла к другому аккаунту — для человека это
    # новое подключение: дата «подключено» — сейчас, прежних доставок не было
    renewed = (table.c.user_id != stmt.excluded.user_id) | table.c.revoked_at.is_not(None)
    upsert = stmt.on_conflict_do_update(
        index_elements=[PushSubscription.endpoint],
        set_={
            "user_id": stmt.excluded.user_id,
            "p256dh": stmt.excluded.p256dh,
            "auth": stmt.excluded.auth,
            "user_agent": stmt.excluded.user_agent,
            "device": stmt.excluded.device,
            "session_id": stmt.excluded.session_id,
            "revoked_at": None,
            "created_at": case((renewed, stmt.excluded.created_at), else_=table.c.created_at),
            "last_sent_at": case((renewed, null()), else_=table.c.last_sent_at),
        },
    ).returning(PushSubscription.id)
    sub_id = int((await db.execute(upsert)).scalar_one())
    await _trim(db, user.id, keep=sub_id, now=now)
    await db.commit()
    return await db.get_one(PushSubscription, sub_id, populate_existing=True)


async def _trim(db: AsyncSession, user_id: int, *, keep: int, now: datetime) -> None:
    """Не больше MAX_ACTIVE активных подписок: самые старые отзываются (только что
    сохраненная остается)."""
    rows = await db.scalars(
        select(PushSubscription.id)
        .where(
            PushSubscription.user_id == user_id,
            PushSubscription.revoked_at.is_(None),
            PushSubscription.id != keep,
        )
        .order_by(PushSubscription.created_at.desc(), PushSubscription.id.desc())
        .offset(MAX_ACTIVE - 1)
    )
    extra = list(rows)
    if extra:
        await db.execute(
            update(PushSubscription).where(PushSubscription.id.in_(extra)).values(revoked_at=now)
        )


async def list_active(
    db: AsyncSession, user_id: int, *, now: datetime | None = None
) -> list[PushSubscription]:
    """Активные подписки, новые сверху: не отозваны и их сеанс действует (истекший сеанс
    push не получает, даже если его еще никто не отозвал)."""
    rows = await db.scalars(
        select(PushSubscription)
        .join(UserSession, UserSession.id == PushSubscription.session_id)
        .where(
            PushSubscription.user_id == user_id,
            PushSubscription.revoked_at.is_(None),
            *session_alive(now),
        )
        .order_by(PushSubscription.created_at.desc(), PushSubscription.id.desc())
    )
    return list(rows)


async def revoke(db: AsyncSession, user_id: int, subscription_id: int) -> None:
    """«Отключить» подписку из списка. Чужая или несуществующая — 404; уже отозванная —
    ничего не меняется. Делает commit."""
    row = await db.scalar(
        select(PushSubscription).where(
            PushSubscription.id == subscription_id, PushSubscription.user_id == user_id
        )
    )
    if row is None:
        raise AppError(404, "push.subscription_not_found")
    if row.revoked_at is None:
        row.revoked_at = utcnow()
    await db.commit()


async def revoke_endpoint(db: AsyncSession, user_id: int, endpoint: str) -> None:
    """Отзыв подписки этого браузера по endpoint (выход из аккаунта, «Выключить»). Чужой
    или неизвестный endpoint — ничего не меняется, ответ тот же. Делает commit."""
    await db.execute(
        update(PushSubscription)
        .where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == user_id,
            PushSubscription.revoked_at.is_(None),
        )
        .values(revoked_at=utcnow())
    )
    await db.commit()


async def users_with_push(db: AsyncSession, user_ids: Sequence[int], kind: str) -> int:
    """Сколько из этих людей получат push вида kind: есть активная подписка и вид
    разрешен в push. Без ключей VAPID — 0. Только число (Р14)."""
    if not user_ids or not get_settings().push_enabled:
        return 0
    rows = await db.scalars(
        select(PushSubscription.user_id)
        .join(UserSession, UserSession.id == PushSubscription.session_id)
        .where(
            PushSubscription.user_id.in_(list(user_ids)),
            PushSubscription.revoked_at.is_(None),
            *session_alive(),
        )
        .distinct()
    )
    count = 0
    for user_id in rows:
        count += await push_allowed(db, int(user_id), kind)
    return count


# --- текст push ---


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _tag(kind: str, variant: str | None, params: dict[str, str], ref: str) -> str:
    entity = next((params[name] for name in _TAG_PARAMS if params.get(name)), None)
    if kind in _UNIQUE_KINDS:
        entity = ref
    parts = [kind, variant if entity is None else None, entity]
    return "-".join(part for part in parts if part)


def build_message(
    *,
    user_id: int,
    kind: str,
    variant: str | None,
    params: dict[str, str],
    link: str | None,
    ref: str | None = None,
) -> PushMessage:
    """Текст push по виду и поводу: push.<вид>.<повод>, если такой есть, иначе push.<вид>.
    ref — номер уведомления в колокольчике (у событий, которые не заменяют друг друга)."""
    key = f"push.{kind}"
    if variant is not None and has_key(f"{key}.{variant}.title"):
        key = f"{key}.{variant}"
    return PushMessage(
        user_id=user_id,
        kind=kind,
        title=_clip(t(f"{key}.title", **params), TITLE_MAX),
        body=_clip(t(f"{key}.body", **params), BODY_MAX),
        url=link or "/",
        tag=_tag(kind, variant, params, ref or secrets.token_hex(4)),
        urgency="high" if kind in HIGH_URGENCY_KINDS else "normal",
    )


def test_message(user_id: int) -> PushMessage:
    return PushMessage(
        user_id=user_id,
        kind="test",
        title=t("push.test.title"),
        body=t("push.test.body"),
        url=TEST_LINK,
        tag="test",
    )


# --- постановка задачи после commit ---

_tasks: set["asyncio.Task[None]"] = set()


def schedule(db: AsyncSession, message: PushMessage) -> None:
    """Поставить push в очередь воркера, когда транзакция db будет записана (commit).
    Откат — push не уходит."""
    pending: list[dict[str, Any]] = db.info.setdefault(_PENDING_KEY, [])
    pending.append(message.as_job())


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    pending = session.info.pop(_PENDING_KEY, None)
    if not pending:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        log.warning("push.no_event_loop", count=len(pending))
        return
    task = loop.create_task(enqueue(pending))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop(_PENDING_KEY, None)


async def enqueue(messages: list[dict[str, Any]]) -> None:
    """Задачи send_push в очередь arq. Сбой очереди не роняет действие: push пропадет,
    уведомление в колокольчике останется."""
    from app.workers.queue import create_queue_pool

    async def put() -> None:
        pool = await create_queue_pool(retries=0)
        try:
            for message in messages:
                await pool.enqueue_job(PUSH_JOB, message)
        finally:
            await pool.aclose()

    try:
        await asyncio.wait_for(put(), timeout=5)
    except (TimeoutError, OSError) as exc:
        log.warning("push.enqueue_failed", count=len(messages), error=type(exc).__name__)
    except Exception as exc:  # RedisError и прочее: действие пользователя уже сделано
        log.warning("push.enqueue_failed", count=len(messages), error=type(exc).__name__)


async def drain() -> None:
    """Дождаться постановки задач (команды терминала перед выходом, тесты)."""
    while _tasks:
        await asyncio.gather(*list(_tasks), return_exceptions=True)


# --- отправка ---


@lru_cache(maxsize=4)
def _vapid(private_key: str) -> Vapid02:
    return Vapid02(private_key=load_private_key(private_key))


def _audience(endpoint: str) -> str:
    parts = urlsplit(endpoint)
    return f"{parts.scheme}://{parts.netloc}"


def _prepare(
    sub: PushSubscription, message: PushMessage, settings: Settings, now: datetime
) -> tuple[dict[str, str], bytes]:
    """Шифрование (aes128gcm) и подпись VAPID — заголовки и тело запроса."""
    pusher = WebPusher({"endpoint": sub.endpoint, "keys": {"p256dh": sub.p256dh, "auth": sub.auth}})
    body = bytes(pusher.encode(message.payload(), content_encoding="aes128gcm")["body"])
    claims = {
        "aud": _audience(sub.endpoint),
        "sub": settings.vapid_subject.strip(),
        "exp": int((now + timedelta(seconds=VAPID_EXP_SECONDS)).timestamp()),
    }
    signed = _vapid(settings.vapid_private_key.get_secret_value().strip()).sign(claims)
    headers = {
        "Authorization": str(signed["Authorization"]),
        "TTL": str(TTL_SECONDS),
        "Urgency": message.urgency,
        "Topic": message.topic,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
    }
    return headers, body


def _retry_after(response: httpx.Response) -> int | None:
    value = response.headers.get("Retry-After", "")
    return int(value) if value.isdigit() else None


async def _deliver_one(
    client: httpx.AsyncClient,
    sub: PushSubscription,
    message: PushMessage,
    settings: Settings,
    now: datetime,
) -> Delivery:
    try:
        headers, body = await asyncio.to_thread(_prepare, sub, message, settings, now)
    except Exception as exc:  # pywebpush и py_vapid бросают свои исключения
        log.warning("push.prepare_failed", subscription_id=sub.id, error=type(exc).__name__)
        return Delivery(sub.id, LOCAL_ERROR)
    try:
        response = await client.post(sub.endpoint, content=body, headers=headers)
    except httpx.HTTPError as exc:
        log.warning("push.network_error", subscription_id=sub.id, error=type(exc).__name__)
        return Delivery(sub.id, None)
    if response.status_code >= 300:
        log.warning("push.rejected", subscription_id=sub.id, status=response.status_code)
    return Delivery(sub.id, response.status_code, _retry_after(response))


def make_client() -> httpx.AsyncClient:
    """Клиент HTTP для сервисов push (тесты подменяют транспорт)."""
    return httpx.AsyncClient(timeout=SEND_TIMEOUT_SECONDS, follow_redirects=False)


async def deliver(
    db: AsyncSession,
    subs: Sequence[PushSubscription],
    message: PushMessage,
    *,
    now: datetime | None = None,
) -> list[Delivery]:
    """Запросы ко всем подпискам сразу. Итог — в базу: last_sent_at у доставленных,
    revoked_at у тех, кого сервис push больше не знает (404, 410). commit — за вызывающим."""
    settings = get_settings()
    moment = now or utcnow()
    async with make_client() as client:
        results = await asyncio.gather(
            *(_deliver_one(client, sub, message, settings, moment) for sub in subs)
        )
    sent = [item.subscription_id for item in results if item.ok]
    gone = [item.subscription_id for item in results if item.gone]
    if sent:
        await db.execute(
            update(PushSubscription)
            .where(PushSubscription.id.in_(sent))
            .values(last_sent_at=moment)
        )
    if gone:
        await db.execute(
            update(PushSubscription)
            .where(PushSubscription.id.in_(gone), PushSubscription.revoked_at.is_(None))
            .values(revoked_at=moment)
        )
    return list(results)


def in_quiet_hours(user: User, now: datetime) -> bool:
    """Сейчас тихие часы по поясу пользователя (начало включено, конец — нет)."""
    if not user.quiet_enabled:
        return False
    local = now.astimezone(user_zone(user.tz)).time().replace(tzinfo=None)
    start, end = user.quiet_start, user.quiet_end
    if start < end:
        return start <= local < end
    return local >= start or local < end


async def send_message(
    db: AsyncSession,
    message: PushMessage,
    *,
    only: Sequence[int] | None = None,
    now: datetime | None = None,
) -> SendResult:
    """Задача воркера send_push: все проверки и отправка на активные подписки (only — только
    эти, повтор). Делает commit."""
    moment = now or utcnow()
    if not get_settings().push_enabled:
        return SendResult(skipped="disabled")
    user = await db.get(User, message.user_id)
    if user is None or user.status != "active" or user.deletion_requested_at is not None:
        return SendResult(skipped="user")
    if not await push_allowed(db, user.id, message.kind):
        return SendResult(skipped="pref")
    if message.kind not in ALWAYS_KINDS and in_quiet_hours(user, moment):
        return SendResult(skipped="quiet")
    subs = await list_active(db, user.id, now=moment)
    if only is not None:
        wanted = set(only)
        subs = [sub for sub in subs if sub.id in wanted]
    if not subs:
        return SendResult(skipped="no_subscriptions")
    results = await deliver(db, subs, message, now=moment)
    await db.commit()
    retry = [item for item in results if item.transient]
    waits = [item.retry_after for item in retry if item.retry_after is not None]
    wait = max(waits) if waits else RETRY_DEFAULT_SECONDS
    return SendResult(
        sent=sum(item.ok for item in results),
        gone=sum(item.gone for item in results),
        failed=sum(not item.ok and not item.gone for item in results),
        retry_ids=tuple(item.subscription_id for item in retry),
        retry_after=min(max(wait, RETRY_MIN_SECONDS), RETRY_MAX_SECONDS),
    )


async def send_test(db: AsyncSession, redis: Redis, user: User) -> int:
    """«Прислать тестовое»: push на все активные подписки, без тихих часов и настроек
    видов. Без ключей — 409 push.not_configured, без подписок — 409 push.no_subscriptions,
    чаще TEST_LIMIT раз в час — 429 push.test_limit. Возвращает, сколько доставлено.
    Делает commit."""
    if not get_settings().push_enabled:
        raise AppError(409, "push.not_configured")
    subs = await list_active(db, user.id)
    if not subs:
        raise AppError(409, "push.no_subscriptions")
    key = redis_key("rl", "push_test", user.id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, TEST_WINDOW_SECONDS, nx=True)
        count = int((await pipe.execute())[0])
    if count > TEST_LIMIT:
        wait = max(int(await redis.ttl(key)), 1)
        raise AppError(
            429, "push.test_limit", retry_after=wait, limit=TEST_LIMIT, minutes=-(-wait // 60)
        )
    results = await deliver(db, subs, test_message(user.id))
    await db.commit()
    return sum(item.ok for item in results)
