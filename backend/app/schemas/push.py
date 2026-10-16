"""Схемы push-уведомлений браузера (этап 6): ключ VAPID для подписки, подписки устройств,
тестовый push. Сам endpoint подписки в ответы не попадает: только его хеш (endpoint_hash),
по нему фронтенд узнает «это устройство»."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

# Длина адреса подписки: у сервисов push браузеров — до 500 знаков, запас вчетверо
ENDPOINT_MAX_LENGTH = 2000


class PushConfigOut(BaseModel):
    """Публичный ключ VAPID (applicationServerKey для PushManager.subscribe); null — на
    сервере ключей нет, push не поддерживается сервером."""

    vapid_public_key: str | None


class PushKeysIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    p256dh: str = Field(min_length=1, max_length=200)
    auth: str = Field(min_length=1, max_length=100)


class PushSubscriptionIn(BaseModel):
    """PushSubscription.toJSON() браузера: endpoint и ключи. Остальные поля (например,
    expirationTime) не нужны и пропускаются. endpoint — https сервиса push браузера (на
    localhost и в тестах — и http), ключи — base64url; иначе 422."""

    model_config = ConfigDict(extra="ignore")

    endpoint: str = Field(min_length=1, max_length=ENDPOINT_MAX_LENGTH)
    keys: PushKeysIn


class PushSubscriptionOut(BaseModel):
    """Устройство с push: device — «iPhone · Safari» (неизвестное — «Браузер»), когда
    подключено и когда последний раз доставлен push; endpoint_hash — первые 16 hex
    sha256(endpoint)."""

    id: int
    device: str
    created_at: datetime
    last_sent_at: datetime | None
    endpoint_hash: str


class PushSubscriptionsOut(BaseModel):
    """Активные подписки, новые сверху."""

    items: list[PushSubscriptionOut]


class PushRevokeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    endpoint: str = Field(min_length=1, max_length=ENDPOINT_MAX_LENGTH)


class PushTestOut(BaseModel):
    """Сколько устройств приняли тестовый push (сервис push ответил 2xx)."""

    sent: int
