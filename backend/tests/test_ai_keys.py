"""Свой ключ Claude участника, режимы ключа (Р7, Р12), сбой ключа, лимиты и бюджет
администратора, расшифровка ключа перед вызовом (ответы Anthropic подменены через httpx2)."""

import base64
import logging
from collections.abc import Iterator
from decimal import Decimal

import httpx2
import pytest
from pydantic import SecretStr
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.client import client_for
from app.agent.errors import ClaudeStepError
from app.core.config import get_settings
from app.core.errors import AppError
from app.core.i18n import has_key
from app.core.security import crypto
from app.db.models import (
    AdminAuditLog,
    AiLimit,
    Analysis,
    AppSettings,
    Notification,
    User,
    UserSecret,
)
from app.services.ai_keys import (
    admin_set_ai_mode,
    cancel_return_request,
    check_own_key,
    decide_return,
    delete_own_key,
    report_key_failure,
    request_return,
    save_own_key,
    set_ai_mode,
    set_budget,
    set_default_limits,
    set_member_limit,
    set_own_cap,
)
from app.services.claude_key import key_for, key_for_run
from app.services.sessions import utcnow
from tests.claude_mock import (
    KEY,
    OTHER_KEY,
    ClaudeMock,
    api_error,
    installed_mock,
    model_info,
    models_list,
    text_message,
)
from tests.helpers_admin import audit_entries
from tests.support import MadeUser, SettingsOverride, UserFactory

MODELS = ("claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5")


@pytest.fixture
def claude() -> Iterator[ClaudeMock]:
    yield from installed_mock()


def _key_api(claude: ClaudeMock, *, missing: tuple[str, ...] = ()) -> None:
    """Ответы проверки ключа: список моделей и каждая модель из настроек."""
    claude.add(httpx2.Response(200, json=models_list()))
    for model in MODELS:
        if model in missing:
            claude.add(api_error(404, "not_found_error"))
        else:
            claude.add(httpx2.Response(200, json=model_info(model)))


async def _fresh(db: AsyncSession, user: MadeUser | User) -> User:
    uid = user.id
    return await db.get_one(User, uid, populate_existing=True)


async def _secret(db: AsyncSession, user_id: int) -> UserSecret | None:
    return await db.scalar(
        select(UserSecret)
        .where(UserSecret.user_id == user_id)
        .execution_options(populate_existing=True)
    )


async def _notes(db: AsyncSession, user_id: int) -> list[Notification]:
    return list(
        await db.scalars(
            select(Notification)
            .where(Notification.user_id == user_id)
            .order_by(Notification.id)
            .execution_options(populate_existing=True)
        )
    )


async def _with_own_key(db: AsyncSession, claude: ClaudeMock, user: MadeUser, key: str) -> None:
    _key_api(claude)
    await save_own_key(db, user.user, key)


def test_notification_texts_for_every_variant() -> None:
    for base in (
        "notifications.ai_key_failed",
        "notifications.ai_key_failed.billing",
        "notifications.ai_key_failed.admin",
        "notifications.ai_key_failed.admin_billing",
        "notifications.ai_mode_request",
        "notifications.ai_mode_decision",
        "notifications.ai_mode_decision.rejected",
        "notifications.ai_mode_decision.own",
        "notifications.limit_80",
        "notifications.limit_80.admin",
        "notifications.limit_100",
        "notifications.limit_100.admin",
        "notifications.budget_80",
        "notifications.budget_100",
    ):
        assert has_key(f"{base}.title") and has_key(f"{base}.body"), base


async def test_save_own_key_checks_and_switches_mode(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    member = await make_user()
    _key_api(claude)
    status = await save_own_key(db, member.user, f"  {KEY} \n")
    assert (status.has_key, status.last4, status.mode) == (True, KEY[-4:], "own")
    assert status.verified_at is not None and status.last_error is None
    assert status.models == tuple((model, True) for model in MODELS)
    assert [r.url.path for r in claude.requests] == [
        "/v1/models",
        *(f"/v1/models/{model}" for model in MODELS),
    ]
    assert set(claude.keys) == {KEY}
    secret = await _secret(db, member.id)
    assert secret is not None and KEY.encode() not in secret.ciphertext
    aad = crypto.aad_for(crypto.AAD_USER_SECRET, member.id)
    assert crypto.decrypt_str(secret.ciphertext, secret.key_version, aad) == KEY
    assert (await _fresh(db, member)).ai_mode == "own"
    # Участник переключился сам: это не действие администратора
    assert await audit_entries(db) == []

    # Замена ключа
    _key_api(claude)
    replaced = await save_own_key(db, member.user, OTHER_KEY)
    assert replaced.last4 == OTHER_KEY[-4:]
    secret = await _secret(db, member.id)
    assert secret is not None
    assert crypto.decrypt_str(secret.ciphertext, secret.key_version, aad) == OTHER_KEY


@pytest.mark.parametrize(
    ("replies", "status", "code"),
    [
        ([api_error(401, "authentication_error")], 400, "ai.key_rejected"),
        ([api_error(403, "permission_error")], 400, "ai.key_rejected"),
        ([api_error(400, "invalid_request_error")], 502, "ai.key_check_failed"),
        ([httpx2.ConnectError("down"), httpx2.ConnectError("down")], 503, "ai.key_unavailable"),
    ],
)
async def test_save_own_key_refused(
    db: AsyncSession,
    make_user: UserFactory,
    claude: ClaudeMock,
    replies: list[httpx2.Response | Exception],
    status: int,
    code: str,
) -> None:
    member = await make_user()
    claude.add(*replies)
    with pytest.raises(AppError) as caught:
        await save_own_key(db, member.user, KEY)
    assert (caught.value.status_code, caught.value.code) == (status, code)
    assert KEY not in str(caught.value.params)
    assert await _secret(db, member.id) is None
    assert (await _fresh(db, member)).ai_mode == "shared"


async def test_save_own_key_bad_format_and_missing_model(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    member = await make_user()
    with pytest.raises(AppError) as fmt:
        await save_own_key(db, member.user, "sk-proj-" + "x" * 30)
    assert (fmt.value.status_code, fmt.value.code) == (400, "ai.key_format")
    assert claude.requests == []

    _key_api(claude, missing=("claude-sonnet-5-5",))
    with pytest.raises(AppError) as models:
        await save_own_key(db, member.user, KEY)
    assert models.value.code == "ai.key_models"
    assert models.value.params == {"models": "claude-sonnet-5-5"}
    assert await _secret(db, member.id) is None


async def test_check_own_key(db: AsyncSession, make_user: UserFactory, claude: ClaudeMock) -> None:
    member = await make_user()
    with pytest.raises(AppError) as none:
        await check_own_key(db, member.user)
    assert none.value.status_code == 404
    await _with_own_key(db, claude, member, KEY)

    claude.add(httpx2.ConnectError("down"), httpx2.ConnectError("down"))
    with pytest.raises(AppError) as down:
        await check_own_key(db, member.user)
    assert down.value.code == "ai.key_unavailable"
    secret = await _secret(db, member.id)
    assert secret is not None and secret.verified_at is not None

    _key_api(claude, missing=("claude-opus-5-5",))
    status = await check_own_key(db, member.user)
    assert status.last_error == "models:claude-opus-5-5"
    assert dict(status.models)["claude-opus-5-5"] is False

    claude.add(api_error(401, "authentication_error"))
    status = await check_own_key(db, member.user)
    assert (status.verified_at, status.last_error) == (None, "rejected:401")

    _key_api(claude)
    status = await check_own_key(db, member.user)
    assert status.verified_at is not None and status.last_error is None


async def test_delete_own_key(db: AsyncSession, make_user: UserFactory, claude: ClaudeMock) -> None:
    member = await make_user()
    admin = await make_user(role="admin")
    await _with_own_key(db, claude, member, KEY)
    await _with_own_key(db, claude, admin, OTHER_KEY)
    # Переход администратора на свой ключ — в журнале
    [switch] = await audit_entries(db, "ai_mode_change")
    assert switch.actor_id == admin.id and switch.details == {"from": "shared", "to": "own"}

    status = await delete_own_key(db, member.user)
    assert (status.has_key, status.mode) == (False, "own")
    assert await _secret(db, member.id) is None

    status = await delete_own_key(db, admin.user, ip="10.0.0.7")
    assert (status.has_key, status.mode) == (False, "shared")
    entries = await audit_entries(db, "ai_mode_change")
    assert entries[-1].details == {"from": "own", "to": "shared"}
    assert entries[-1].ip == "10.0.0.7"


async def test_set_ai_mode(db: AsyncSession, make_user: UserFactory, claude: ClaudeMock) -> None:
    member = await make_user()
    with pytest.raises(AppError) as no_key:
        await set_ai_mode(db, member.user, "own")
    assert (no_key.value.status_code, no_key.value.code) == (409, "ai.no_own_key")

    await _with_own_key(db, claude, member, KEY)
    assert (await set_ai_mode(db, member.user, "own")).mode == "own"
    with pytest.raises(AppError) as back:
        await set_ai_mode(db, member.user, "shared")
    assert (back.value.status_code, back.value.code) == (403, "ai.return_needs_admin")

    admin = await make_user(role="admin")
    await _with_own_key(db, claude, admin, OTHER_KEY)
    status = await set_ai_mode(db, admin.user, "shared")
    assert (status.mode, status.has_key) == ("shared", False)
    assert await _secret(db, admin.id) is None


async def test_return_request_and_decision(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    admin = await make_user(role="admin")
    other_admin = await make_user(role="admin")
    member = await make_user(display_name="Ольга")
    await _with_own_key(db, claude, member, KEY)

    requested = await request_return(db, member.user)
    for admin_user in (admin, other_admin):
        [note] = await _notes(db, admin_user.id)
        assert note.kind == "ai_mode_request"
        assert note.title == "Ольга просит вернуть ключ администратора"
    assert await request_return(db, member.user) == requested
    assert len(await _notes(db, admin.id)) == 1

    # Отмена убирает просьбу у администраторов
    await cancel_return_request(db, member.user)
    assert await _notes(db, admin.id) == []
    limit = await db.get_one(AiLimit, member.id, populate_existing=True)
    assert limit.return_requested_at is None
    with pytest.raises(AppError) as nothing:
        await decide_return(db, member.id, approve=True, actor=admin.user)
    assert (nothing.value.status_code, nothing.value.code) == (409, "ai.no_return_request")
    await db.commit()

    await request_return(db, member.user)
    await decide_return(db, member.id, approve=True, actor=admin.user, ip="10.0.0.7")
    assert (await _fresh(db, member)).ai_mode == "shared"
    [entry] = await audit_entries(db, "ai_mode_change")
    assert entry.actor_id == admin.id and entry.target_user_id == member.id
    assert entry.details == {"from": "own", "to": "shared", "decision": "approved"}
    [decision] = await _notes(db, member.id)
    assert decision.kind == "ai_mode_decision"
    assert decision.title == "Вы снова на ключе администратора"
    assert "10,00" in decision.body and "1,00" in decision.body
    # Просьба у администраторов отмечена прочитанной
    assert all(n.read_at is not None for n in await _notes(db, other_admin.id))
    # Свой ключ участника удален с сервера, как в макете («его ключ отключится»)
    assert await _secret(db, member.id) is None


async def test_return_request_rejected_and_refusals(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    admin = await make_user(role="admin")
    member = await make_user()
    with pytest.raises(AppError) as shared:
        await request_return(db, member.user)
    assert shared.value.code == "ai.already_shared"
    await db.commit()
    await _with_own_key(db, claude, member, KEY)
    await request_return(db, member.user)
    await decide_return(db, member.id, approve=False, actor=None)
    assert (await _fresh(db, member)).ai_mode == "own"
    [entry] = await audit_entries(db, "ai_mode_change")
    assert entry.details == {
        "from": "own",
        "to": "own",
        "decision": "rejected",
        "source": "terminal",
    }
    [note] = await _notes(db, member.id)
    assert note.title == "Просьба вернуть ключ администратора отклонена"

    await _with_own_key(db, claude, admin, OTHER_KEY)
    with pytest.raises(AppError) as self_return:
        await request_return(db, admin.user)
    assert self_return.value.code == "ai.return_not_needed"
    await db.commit()


async def test_admin_set_ai_mode(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    admin = await make_user(role="admin")
    member = await make_user()
    with pytest.raises(AppError) as no_key:
        await admin_set_ai_mode(db, member.id, "own", actor=admin.user)
    assert no_key.value.code == "ai.no_own_key"
    await db.commit()
    with pytest.raises(AppError):
        await admin_set_ai_mode(db, member.id, "guest", actor=admin.user)

    await _with_own_key(db, claude, member, KEY)
    await admin_set_ai_mode(db, member.id, "shared", actor=admin.user)
    assert (await _fresh(db, member)).ai_mode == "shared"
    await admin_set_ai_mode(db, member.id, "own", actor=admin.user)
    assert (await _fresh(db, member)).ai_mode == "own"
    titles = [n.title for n in await _notes(db, member.id)]
    assert titles == ["Вы снова на ключе администратора", "Анализы переведены на ваш ключ"]
    entries = await audit_entries(db, "ai_mode_change")
    assert [e.details for e in entries] == [
        {"from": "own", "to": "shared"},
        {"from": "shared", "to": "own"},
    ]
    # Тот же режим — ничего не меняется
    await admin_set_ai_mode(db, member.id, "own", actor=admin.user)
    assert len(await audit_entries(db, "ai_mode_change")) == 2
    with pytest.raises(AppError) as missing:
        await admin_set_ai_mode(db, 999_999, "shared", actor=admin.user)
    assert missing.value.status_code == 404


async def test_set_own_cap(db: AsyncSession, make_user: UserFactory) -> None:
    admin = await make_user(role="admin")
    for bad in ("0.05", "20.01", "-1"):
        with pytest.raises(AppError) as caught:
            await set_own_cap(db, admin.user, Decimal(bad))
        assert caught.value.code == "ai.own_cap_range"
        assert caught.value.params == {"min": "0,10", "max": "20,00"}
    assert await set_own_cap(db, admin.user, Decimal("2.505")) == Decimal("2.50")
    row = await db.get_one(AiLimit, admin.id, populate_existing=True)
    # Строки лимитов у администратора не было: создана со значениями по умолчанию
    assert row.own_per_analysis_usd == Decimal("2.50") and row.monthly_usd == Decimal("10.00")


async def test_report_key_failure(
    db: AsyncSession, make_user: UserFactory, claude: ClaudeMock
) -> None:
    admin = await make_user(role="admin")
    member = await make_user()
    await _with_own_key(db, claude, member, KEY)

    [first] = await report_key_failure(db, "own", member.id, "ai.key_rejected")
    await db.commit()
    assert first.title == "Ваш ключ Claude не работает"
    secret = await _secret(db, member.id)
    assert secret is not None
    assert (secret.verified_at, secret.last_error) == (None, "ai.key_rejected")
    # Повтор в течение 6 часов — без нового уведомления; другой повод — свое уведомление
    assert await report_key_failure(db, "own", member.id, "ai.key_rejected") == []
    [billing] = await report_key_failure(db, "own", member.id, "ai.billing")
    assert billing.title == "На счете вашего ключа Claude нет денег"
    await db.commit()

    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    settings.key_verified_at = utcnow()
    await db.commit()
    [admin_note] = await report_key_failure(db, "admin", member.id, "ai.key_rejected")
    await db.commit()
    assert admin_note.user_id == admin.id
    assert admin_note.title == "Ключ Claude администратора не работает"
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert settings.key_verified_at is None
    [money] = await report_key_failure(db, "admin", None, "ai.billing")
    assert money.title == "На счете ключа администратора нет денег"
    assert await report_key_failure(db, "admin", None, "ai.billing") == []


async def test_limits_and_budget_are_audited(db: AsyncSession, make_user: UserFactory) -> None:
    D = Decimal
    admin = await make_user(role="admin")
    member = await make_user()
    limits = await set_member_limit(
        db, member.id, monthly_usd=D("15"), paused=True, actor=admin.user, ip="10.0.0.7"
    )
    assert (limits.monthly_usd, limits.paused, limits.daily_analyses) == (D("15.00"), True, 3)
    [entry] = await audit_entries(db, "limit_change")
    assert entry.target_user_id == member.id and entry.actor_id == admin.id
    assert entry.details == {
        "changes": {
            "monthly_usd": {"from": "10.00", "to": "15.00"},
            "paused": {"from": False, "to": True},
        }
    }
    await set_member_limit(db, member.id, monthly_usd=D("15"), actor=admin.user)
    assert len(await audit_entries(db, "limit_change")) == 1
    with pytest.raises(AppError) as negative_money:
        await set_member_limit(db, member.id, monthly_usd=D("-1"), actor=admin.user)
    with pytest.raises(AppError) as negative_count:
        await set_member_limit(db, member.id, daily_analyses=-1, actor=admin.user)
    assert negative_money.value.code == negative_count.value.code == "ai.limit_invalid"

    with pytest.raises(AppError) as soft:
        await set_default_limits(db, per_analysis_soft_usd=D("2"), actor=admin.user)
    assert soft.value.code == "ai.limit_invalid"
    await db.commit()
    await set_default_limits(
        db, default_member_limit_usd=D("12"), default_daily_analyses=4, actor=None
    )
    with pytest.raises(AppError) as pct:
        await set_budget(db, budget_alert_pct=75, actor=admin.user)
    assert pct.value.code == "ai.alert_pct"
    row = await set_budget(
        db, monthly_budget_usd=D("80"), budget_alert_pct=90, eval_budget_usd=D("30"), actor=None
    )
    assert (row.monthly_budget_usd, row.budget_alert_pct, row.eval_budget_usd) == (
        D("80.00"),
        90,
        D("30.00"),
    )
    entries = await audit_entries(db, "budget_change")
    assert [e.details["changes"] for e in entries] == [
        {
            "default_member_limit_usd": {"from": "10.00", "to": "12.00"},
            "default_daily_analyses": {"from": 3, "to": 4},
        },
        {
            "monthly_budget_usd": {"from": "60.00", "to": "80.00"},
            "budget_alert_pct": {"from": 80, "to": 90},
            "eval_budget_usd": {"from": "25.00", "to": "30.00"},
        },
    ]
    assert all(e.details["source"] == "terminal" for e in entries)
    # Новый участник без строки лимитов получит новые значения по умолчанию
    newcomer = await make_user()
    fresh = await set_member_limit(db, newcomer.id, actor=None)
    assert (fresh.monthly_usd, fresh.daily_analyses) == (D("12.00"), 4)


def _b64(key: bytes) -> str:
    return base64.b64encode(key).decode()


async def test_key_for_run_uses_the_right_key_and_reencrypts(
    db: AsyncSession,
    make_user: UserFactory,
    claude: ClaudeMock,
    override_settings: SettingsOverride,
    caplog: pytest.LogCaptureFixture,
) -> None:
    """Запрос уходит с ключом участника при key_source = own и с ключом администратора
    при admin; записи старым мастер-ключом перешифровываются; ключ не попадает в лог."""
    caplog.set_level(logging.DEBUG)
    member = await make_user()
    await _with_own_key(db, claude, member, OTHER_KEY)
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    settings.anthropic_key_enc, settings.key_version = crypto.encrypt_str(
        KEY, crypto.aad_for(crypto.AAD_ADMIN_KEY, 1)
    )
    await db.commit()
    own_run = Analysis(user_id=member.id, input_text="x", key_source="own")
    admin_run = Analysis(user_id=member.id, input_text="x", key_source="admin")
    db.add_all([own_run, admin_run])
    await db.commit()

    old_keys = get_settings().master_key_map
    rotated = ",".join([f"{v}:{_b64(k)}" for v, k in old_keys.items()] + [f"9:{_b64(b'n' * 32)}"])
    override_settings(master_keys=SecretStr(rotated))

    claude.add(text_message("ok"), text_message("ok"))
    for analysis in (own_run, admin_run):
        key = await key_for_run(db, analysis)
        await db.commit()
        await client_for(key, timeout=5.0).messages.create(
            model="claude-haiku-5-5", max_tokens=100, messages=[{"role": "user", "content": "x"}]
        )
    assert claude.keys[-2:] == [OTHER_KEY, KEY]
    secret = await _secret(db, member.id)
    settings = await db.get_one(AppSettings, 1, populate_existing=True)
    assert secret is not None and secret.key_version == 9 and settings.key_version == 9
    assert await key_for(db, key_source="own", user_id=member.id) == OTHER_KEY
    assert "sk-ant-api03" not in caplog.text


async def test_key_for_failures(db: AsyncSession, make_user: UserFactory) -> None:
    member = await make_user()
    cases = [
        ({"key_source": "admin", "user_id": member.id}, "no_admin_key"),
        ({"key_source": "own", "user_id": member.id}, "no_own_key"),
        ({"key_source": None, "user_id": member.id}, "no_key_source"),
    ]
    for kwargs, detail in cases:
        with pytest.raises(ClaudeStepError) as caught:
            await key_for(db, **kwargs)  # type: ignore[arg-type]
        assert (caught.value.code, caught.value.detail) == ("ai.no_key", detail)
    # Шифротекст из чужой строки не расшифровывается (aad по user_id)
    other = await make_user()
    ciphertext, version = crypto.encrypt_str(KEY, crypto.aad_for(crypto.AAD_USER_SECRET, other.id))
    db.add(
        UserSecret(
            user_id=member.id,
            kind="anthropic_key",
            ciphertext=ciphertext,
            key_version=version,
            last4="abcd",
        )
    )
    await db.commit()
    with pytest.raises(ClaudeStepError) as broken:
        await key_for(db, key_source="own", user_id=member.id)
    assert broken.value.detail == "own_key_decrypt"
    assert not list(await db.scalars(select(AdminAuditLog)))
