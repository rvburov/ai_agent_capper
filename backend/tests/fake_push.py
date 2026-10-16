"""Поддельный сервис push (Web Push) для сквозных тестов этапа 6: работает в том же
процессе, что поддельный Claude (tests/fake_claude.py, порт стека E2E_FAKE_CLAUDE_PORT, по
умолчанию порт API + 99), и проверяет, что сервер действительно отправил push.

Как пользоваться из Playwright (адрес — http://127.0.0.1:ПОРТ):
- POST /_fake/push/subscription → {"endpoint", "keys": {"p256dh", "auth"}, "expirationTime"}:
  новая «подписка браузера». Ее отдают странице вместо PushManager.subscribe (init script);
  закрытый ключ остается у сервиса, поэтому он расшифровывает push. endpoint —
  http://127.0.0.1:ПОРТ/push/<id>: сервер принимает http только с CAPPER_PUSH_ALLOW_HTTP
  (стек сквозных тестов его включает).
- POST /push/<id> — сам сервис push (сюда шлет воркер или API). Отвечает 201; неизвестная
  или удаленная подписка — 410, как настоящий сервис.
- GET /_fake/push[?device=<id>] → {"items": [...]}, старые первыми (последние 200): device,
  at, status (что ответил сервис), body_length, headers (ttl, urgency, topic,
  content_encoding, content_type), vapid (подпись VAPID верна), aud, payload (расшифрованный
  JSON {title, body, url, tag} или null).
- POST /_fake/push/fail {"status": 410, "times": 1, "device": "<id>"} — следующие ответы
  (device не задан — любой подписке); DELETE /_fake/push/subscription/<id> — подписка
  «истекла» (дальше 410); POST /_fake/push/reset — забыть запросы и сбои (подписки
  остаются: их endpoint уже в базе стенда).

Ответы с CORS «*»: страница может спросить сервис и сама.
"""

import base64
import json
import secrets
import threading
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

import http_ece
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec
from py_vapid import Vapid02
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

KEEP = 200


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _b64url_decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


@dataclass
class _Device:
    key: ec.EllipticCurvePrivateKey
    auth: bytes


@dataclass
class _Fail:
    status: int
    times: int
    device: str | None


@dataclass
class FakePush:
    devices: dict[str, _Device] = field(default_factory=dict)
    received: list[dict[str, Any]] = field(default_factory=list)
    fails: list[_Fail] = field(default_factory=list)
    lock: threading.Lock = field(default_factory=threading.Lock)

    def new_device(self, origin: str) -> dict[str, Any]:
        device_id = secrets.token_hex(8)
        key = ec.generate_private_key(ec.SECP256R1())
        auth = secrets.token_bytes(16)
        with self.lock:
            self.devices[device_id] = _Device(key, auth)
        point = key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return {
            "endpoint": f"{origin}/push/{device_id}",
            "keys": {"p256dh": _b64url(point), "auth": _b64url(auth)},
            "expirationTime": None,
        }

    def _status(self, device_id: str) -> int:
        with self.lock:
            for item in self.fails:
                if item.times > 0 and item.device in (None, device_id):
                    item.times -= 1
                    return item.status
            return 201 if device_id in self.devices else 410

    def receive(self, device_id: str, headers: dict[str, str], body: bytes) -> int:
        status = self._status(device_id)
        auth = headers.get("authorization", "")
        record: dict[str, Any] = {
            "device": device_id,
            "at": datetime.now(UTC).isoformat(),
            "status": status,
            "body_length": len(body),
            "headers": {
                "ttl": headers.get("ttl"),
                "urgency": headers.get("urgency"),
                "topic": headers.get("topic"),
                "content_encoding": headers.get("content-encoding"),
                "content_type": headers.get("content-type"),
            },
            "vapid": _vapid_ok(auth),
            "aud": _audience(auth),
            "payload": self._decrypt(device_id, body),
        }
        with self.lock:
            self.received.append(record)
            del self.received[:-KEEP]
        return status

    def _decrypt(self, device_id: str, body: bytes) -> Any:
        device = self.devices.get(device_id)
        if device is None:
            return None
        try:
            plain = http_ece.decrypt(
                body, private_key=device.key, auth_secret=device.auth, version="aes128gcm"
            )
            return json.loads(plain)
        except Exception:  # сломанное шифрование — тест увидит payload null
            return None


def _vapid_ok(auth: str) -> bool:
    try:
        return bool(Vapid02.verify(auth))
    except Exception:
        return False


def _audience(auth: str) -> str | None:
    try:
        token = auth.split("t=", 1)[1].split(",", 1)[0]
        claims = json.loads(_b64url_decode(token.split(".")[1]))
        return str(claims["aud"])
    except Exception:
        return None


STATE = FakePush()


def _origin(request: Request) -> str:
    return str(request.base_url).rstrip("/")


async def _subscription(request: Request) -> Response:
    return JSONResponse(STATE.new_device(_origin(request)))


async def _forget(request: Request) -> Response:
    with STATE.lock:
        STATE.devices.pop(request.path_params["device"], None)
    return JSONResponse({"ok": True})


async def _push(request: Request) -> Response:
    status = STATE.receive(
        request.path_params["device"],
        {key.lower(): value for key, value in request.headers.items()},
        await request.body(),
    )
    return Response(status_code=status)


async def _list(request: Request) -> Response:
    device = request.query_params.get("device")
    with STATE.lock:
        items = [item for item in STATE.received if device in (None, item["device"])]
    return JSONResponse({"items": items})


async def _fail(request: Request) -> Response:
    data = await request.json()
    with STATE.lock:
        STATE.fails.append(
            _Fail(int(data["status"]), int(data.get("times", 1)), data.get("device"))
        )
    return JSONResponse({"ok": True})


async def _reset(request: Request) -> Response:
    with STATE.lock:
        STATE.received.clear()
        STATE.fails.clear()
    return JSONResponse({"ok": True})


ROUTES = [
    Route("/_fake/push/subscription", _subscription, methods=["POST"]),
    Route("/_fake/push/subscription/{device}", _forget, methods=["DELETE"]),
    Route("/_fake/push/fail", _fail, methods=["POST"]),
    Route("/_fake/push/reset", _reset, methods=["POST"]),
    Route("/_fake/push", _list, methods=["GET"]),
    Route("/push/{device}", _push, methods=["POST"]),
]
