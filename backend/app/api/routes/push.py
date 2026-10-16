"""Push-уведомления браузера в личном кабинете (этап 6, Р3, Р26): /api/me/push-config и
/api/me/push-subscriptions.

Только вошедший пользователь и только свои подписки: чужой id отвечает 404, как
несуществующий; чужой endpoint при отзыве ничего не меняет. Изменяющие запросы — с CSRF,
как остальные. Настройки «что присылать в push» и тихие часы — в /api/me/notification-prefs.
"""

from typing import Annotated

from fastapi import APIRouter, Path, Response, status

from app.api.routes.auth import RequestClient
from app.core.deps import CurrentAuth, CurrentUser, DbSession, RedisClient
from app.db.models import PushSubscription
from app.schemas.push import (
    PushConfigOut,
    PushRevokeIn,
    PushSubscriptionIn,
    PushSubscriptionOut,
    PushSubscriptionsOut,
    PushTestOut,
)
from app.services import push as push_service

router = APIRouter(prefix="/me", tags=["me"])

RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


def _out(row: PushSubscription) -> PushSubscriptionOut:
    return PushSubscriptionOut(
        id=row.id,
        device=push_service.device_label(row.device),
        created_at=row.created_at,
        last_sent_at=row.last_sent_at,
        endpoint_hash=push_service.endpoint_hash(row.endpoint),
    )


@router.get("/push-config")
async def push_config(user: CurrentUser) -> PushConfigOut:
    """Публичный ключ VAPID для подписки браузера; null — ключей на сервере нет, push не
    поддерживается сервером."""
    return PushConfigOut(vapid_public_key=push_service.config_key())


@router.post("/push-subscriptions", status_code=status.HTTP_201_CREATED)
async def subscribe(
    body: PushSubscriptionIn, auth: CurrentAuth, db: DbSession, client: RequestClient
) -> PushSubscriptionOut:
    """Подписка этого браузера, привязанная к текущему сеансу: выход, отзыв сеанса или
    его истечение выключают push на устройстве. Повтор той же подписки — та же строка
    (если браузер был у другого аккаунта или вошли заново — переходит к текущему сеансу).
    Активных подписок не больше 10: самая старая отзывается. endpoint не https сервиса
    push или ключи не base64url нужной длины — 422 push.endpoint_invalid или
    push.keys_invalid; ключей VAPID на сервере нет — 409 push.not_configured."""
    row = await push_service.subscribe(
        db,
        auth.user,
        endpoint=body.endpoint,
        p256dh=body.keys.p256dh,
        auth=body.keys.auth,
        user_agent=client.user_agent,
        session_id=auth.session.id,
    )
    return _out(row)


@router.get("/push-subscriptions")
async def list_subscriptions(user: CurrentUser, db: DbSession) -> PushSubscriptionsOut:
    """Устройства с push (активные подписки), новые сверху."""
    rows = await push_service.list_active(db, user.id)
    return PushSubscriptionsOut(items=[_out(row) for row in rows])


@router.delete("/push-subscriptions/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_subscription(subscription_id: RowId, user: CurrentUser, db: DbSession) -> Response:
    """«Отключить» устройство: подписка отозвана. Чужая или несуществующая — 404
    push.subscription_not_found."""
    await push_service.revoke(db, user.id, subscription_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/push-subscriptions/revoke", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_by_endpoint(body: PushRevokeIn, user: CurrentUser, db: DbSession) -> Response:
    """Отзыв подписки этого браузера по endpoint: перед выходом из аккаунта и по
    «Выключить». Неизвестный или чужой endpoint — тоже 204, ничего не меняется."""
    await push_service.revoke_endpoint(db, user.id, body.endpoint)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/push-subscriptions/test", status_code=status.HTTP_202_ACCEPTED)
async def send_test(user: CurrentUser, db: DbSession, redis: RedisClient) -> PushTestOut:
    """Тестовый push «Проверка: push работает» на все свои устройства (без тихих часов).
    sent — сколько сервисов push его приняли. Подписок нет — 409 push.no_subscriptions;
    чаще 5 раз в час — 429 push.test_limit; ключей VAPID нет — 409 push.not_configured."""
    return PushTestOut(sent=await push_service.send_test(db, redis, user))
