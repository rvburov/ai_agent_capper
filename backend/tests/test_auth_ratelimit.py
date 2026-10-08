"""Защита от подбора на маршрутах входа: пауза пары (email, IP), общий лимит IP,
лимит неудач 2FA аккаунта, уведомление владельцу и журнал входов."""

import httpx2
import pytest
from redis.asyncio import Redis
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import LoginEvent, Notification
from app.services import auth
from tests.helpers_auth import code_step, full_login, make_invite, make_reset_code, password_step
from tests.support import ClientFactory, TotpCodeFn, UserFactory

WRONG = "wrong-password-123"


async def _events(db: AsyncSession, user_id: int | None) -> list[tuple[str, str]]:
    condition = LoginEvent.user_id == user_id if user_id else LoginEvent.user_id.is_(None)
    rows = await db.execute(
        select(LoginEvent.result, LoginEvent.method).where(condition).order_by(LoginEvent.id)
    )
    return [(r[0], r[1]) for r in rows.all()]


async def _failure_notices(db: AsyncSession, user_id: int) -> list[str]:
    rows = await db.execute(
        select(Notification.body)
        .where(Notification.user_id == user_id, Notification.kind == "login_failures")
        .order_by(Notification.id)
    )
    return list(rows.scalars())


def _assert_locked(response: httpx2.Response, code: str = "auth.rate_limited") -> None:
    assert response.status_code == 429, response.text
    error = response.json()["error"]
    assert error["code"] == code
    assert error["retry_after"] > 0
    assert response.headers["Retry-After"] == str(error["retry_after"])


async def test_sixth_attempt_is_paused_but_other_ip_works(
    make_client: ClientFactory,
    make_user: UserFactory,
    totp_code: TotpCodeFn,
    db: AsyncSession,
) -> None:
    member = await make_user()
    attacker = await make_client("10.0.0.66")
    for _ in range(5):
        response = await password_step(attacker, member, password=WRONG)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "auth.invalid_credentials"
    # Шестая попытка — пауза, даже с верным паролем (пароль не проверяется)
    sixth = await password_step(attacker, member)
    _assert_locked(sixth)
    assert sixth.json()["error"]["retry_after"] <= 15 * 60

    # Владелец входит с другого IP как обычно
    owner = await make_client("10.0.0.1")
    await full_login(owner, member, await totp_code(member))
    assert (await owner.get("/api/me")).status_code == 200
    # Успешный вход с другого IP не снимает паузу с IP подбора
    _assert_locked(await password_step(attacker, member))

    events = await _events(db, member.id)
    assert events[:6] == [("bad_password", "password")] * 5 + [("rate_limited", "password")]
    assert events[6] == ("ok", "totp")

    notices = await _failure_notices(db, member.id)
    assert len(notices) == 1
    assert "IP-адреса 10.0.0.66: 5" in notices[0]
    assert "закрыт на 15 мин" in notices[0]


async def test_unknown_email_behaves_the_same(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    await make_user(email="real@example.com")
    client = await make_client("10.0.0.70")
    body = {"email": "nobody@example.com", "password": WRONG}
    for _ in range(5):
        response = await client.post("/api/auth/login", json=body)
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "auth.invalid_credentials"
    _assert_locked(await client.post("/api/auth/login", json=body))
    events = await _events(db, None)
    assert events == [("bad_password", "password")] * 5 + [("rate_limited", "password")]
    total = await db.execute(select(func.count()).select_from(Notification))
    assert total.scalar_one() == 0


async def test_rejections_write_one_journal_row_per_pause(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    """Зная только email, журнал владельца отказами 429 не заполнить: на паузу пары —
    одна строка rate_limited, остальные отказы только считаются."""
    member = await make_user()
    attacker = await make_client("10.0.0.67")
    for _ in range(5):
        assert (await password_step(attacker, member, password=WRONG)).status_code == 401
    # 14 отказов: общий лимит IP (20 в минуту) еще не наступил, отказывает пауза пары
    for _ in range(14):
        _assert_locked(await password_step(attacker, member, password=WRONG))
    events = await _events(db, member.id)
    assert events == [("bad_password", "password")] * 5 + [("rate_limited", "password")]

    # Общий лимит IP: тоже одна строка на окно
    flood = await make_client("10.0.0.68")
    for n in range(20):
        await flood.post("/api/auth/login", json={"email": f"u{n}@example.com", "password": WRONG})
    for _ in range(10):
        _assert_locked(await password_step(flood, member, password=WRONG))
    events = await _events(db, member.id)
    assert events.count(("rate_limited", "password")) == 2


async def test_login_releases_db_connection_while_hashing(
    make_user: UserFactory, db: AsyncSession, redis: Redis, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Пока считается хеш пароля (и ждет места), соединение с БД не занято: поток
    входов с выдуманными email не исчерпает пул."""
    seen: list[bool] = []

    async def fake_verify(*_args: object) -> bool:
        seen.append(db.in_transaction())
        return False

    monkeypatch.setattr(auth, "verify_password_async", fake_verify)
    monkeypatch.setattr(auth, "verify_dummy_async", fake_verify)
    member = await make_user()
    for email in (member.email, "nobody@example.com"):
        with pytest.raises(AppError):
            await auth.login_with_password(
                db,
                redis,
                email=email,
                password=WRONG,
                client=auth.ClientInfo(ip="10.0.0.69", user_agent=None),
            )
    assert seen == [False, False]


async def test_general_ip_limit(make_client: ClientFactory, make_user: UserFactory) -> None:
    member = await make_user()
    client = await make_client("10.0.0.80")
    for n in range(20):
        response = await client.post(
            "/api/auth/login", json={"email": f"user{n}@example.com", "password": WRONG}
        )
        assert response.status_code == 401
    # 21-й запрос за минуту с этого IP — 429 для любого email
    response = await password_step(client, member)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "auth.rate_limited"
    assert response.json()["error"]["retry_after"] <= 60
    # С другого IP вход работает
    other = await make_client("10.0.0.81")
    assert (await password_step(other, member)).json()["status"] == "totp_required"


async def test_wrong_2fa_codes_count_in_the_pair(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    client = await make_client("10.0.0.90")
    assert (await password_step(client, member)).json()["status"] == "totp_required"
    for _ in range(5):
        response = await code_step(client, code="000000")
        assert response.status_code == 401
        assert response.json()["error"]["code"] == "auth.invalid_code"
    # Пара закрыта: и код, и пароль с этого IP — 429
    _assert_locked(await code_step(client, code=member.current_totp()))
    _assert_locked(await password_step(client, member))
    notices = await _failure_notices(db, member.id)
    assert len(notices) == 1
    assert "IP-адреса 10.0.0.90: 5" in notices[0]

    other = await make_client("10.0.0.91")
    assert (await password_step(other, member)).json()["status"] == "totp_required"
    assert (await code_step(other, code=member.current_totp())).status_code == 200

    events = await _events(db, member.id)
    assert events.count(("bad_totp", "totp")) == 5
    assert ("rate_limited", "totp") in events


async def test_2fa_failures_per_account_close_the_code_step(
    make_client: ClientFactory, make_user: UserFactory, totp_code: TotpCodeFn, db: AsyncSession
) -> None:
    member = await make_user()

    async def wrong_codes(ip: str, count: int) -> httpx2.AsyncClient:
        client = await make_client(ip)
        assert (await password_step(client, member)).json()["status"] == "totp_required"
        for _ in range(count):
            assert (await code_step(client, code="000000")).status_code == 401
        return client

    # По 4 неудачи с двух адресов: пауза пары (5) не наступает ни на одном
    await wrong_codes("10.1.0.1", 4)
    await wrong_codes("10.1.0.2", 4)
    # Верный код не считается неудачей и не обнуляет счетчик аккаунта
    owner = await wrong_codes("10.1.0.3", 1)
    assert (await code_step(owner, code=await totp_code(member))).status_code == 200
    assert await _failure_notices(db, member.id) == []
    # Десятая неудача за час закрывает шаг 2FA аккаунта и обрывает незавершенный вход
    tenth = await wrong_codes("10.1.0.4", 1)
    notices = await _failure_notices(db, member.id)
    assert len(notices) == 1
    # Текст про закрытый шаг 2FA, а не про 5 попыток с одного адреса
    assert "кодов 2FA за час: 10" in notices[0] and "10.1.0.4" in notices[0]
    assert "закрыта на 60 мин" in notices[0]
    expired = await code_step(tenth, code=await totp_code(member))
    assert expired.json()["error"]["code"] == "auth.login_expired"

    fresh = await make_client("10.1.0.5")
    assert (await password_step(fresh, member)).json()["status"] == "totp_required"
    locked = await code_step(fresh, code=await totp_code(member))
    _assert_locked(locked, code="auth.two_factor_locked")
    assert 0 < locked.json()["error"]["retry_after"] <= 3600


async def test_two_factor_lock_notice_is_not_swallowed_by_pair_notice(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    member = await make_user()
    for ip in ("10.2.0.1", "10.2.0.2"):
        client = await make_client(ip)
        assert (await password_step(client, member)).json()["status"] == "totp_required"
        for _ in range(5):
            assert (await code_step(client, code="000000")).status_code == 401
    # Первая пятерка — пауза пары, вторая — еще и закрытый шаг 2FA аккаунта (10 за час):
    # о нем владелец узнает, хотя уведомление о паузе было меньше 15 минут назад
    notices = await _failure_notices(db, member.id)
    assert len(notices) == 2
    assert "IP-адреса 10.2.0.1: 5" in notices[0]
    assert "кодов 2FA за час: 10" in notices[1] and "10.2.0.2" in notices[1]


async def test_successful_login_resets_the_pair(
    make_client: ClientFactory, make_user: UserFactory, totp_code: TotpCodeFn
) -> None:
    member = await make_user()
    client = await make_client("10.0.0.95")
    for _ in range(4):
        assert (await password_step(client, member, password=WRONG)).status_code == 401
    await full_login(client, member, await totp_code(member))
    for _ in range(4):
        assert (await password_step(client, member, password=WRONG)).status_code == 401
    assert (await password_step(client, member)).json()["status"] == "totp_required"


async def test_register_and_reset_ip_limits(
    make_client: ClientFactory, make_user: UserFactory, db: AsyncSession
) -> None:
    code = await make_invite(db, email="invited@example.com")
    client = await make_client("10.0.0.99")
    body = {
        "invite_code": code,
        "email": "other@example.com",
        "display_name": "Гость",
        "password": "long-enough-password",
        "accept_terms": True,
    }
    for _ in range(10):
        assert (await client.post("/api/auth/register", json=body)).status_code == 400
    limited = await client.post("/api/auth/register", json=body)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "common.rate_limited"
    assert limited.json()["error"]["retry_after"] > 0

    member = await make_user()
    reset_code = await make_reset_code(db, user_id=member.id)
    other = await make_client("10.0.0.98")
    wrong = {"email": "nobody@example.com", "code": reset_code, "new_password": "x" * 20}
    for _ in range(10):
        assert (await other.post("/api/auth/reset", json=wrong)).status_code == 400
    limited = await other.post("/api/auth/reset", json=wrong)
    assert limited.status_code == 429
    assert limited.json()["error"]["code"] == "common.rate_limited"
