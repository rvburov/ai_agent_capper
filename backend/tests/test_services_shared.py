"""Общие помощники сервисов: журнал действий и уведомления."""

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.i18n import t
from app.services.audit import write_audit
from app.services.notifications import notify
from tests.support import UserFactory


async def test_write_audit_terminal_marks_source(db: AsyncSession) -> None:
    entry = await write_audit(db, action="create_admin", actor_id=None, details={"email": "a@b.c"})
    await db.commit()
    assert entry.id is not None
    assert entry.details == {"email": "a@b.c", "source": "terminal"}


async def test_write_audit_rejects_unknown_action(db: AsyncSession) -> None:
    with pytest.raises(ValueError):
        await write_audit(db, action="hack", actor_id=None)


async def test_notify_uses_locale_text(db: AsyncSession, make_user: UserFactory) -> None:
    made = await make_user()
    note = await notify(
        db, user_id=made.id, kind="new_device", device="Chrome · Windows", ip="1.2.3.4"
    )
    assert note is not None
    await db.commit()
    assert note.title == "Вход с нового устройства"
    assert "Chrome · Windows" in note.body and "1.2.3.4" in note.body
    assert note.params == {"device": "Chrome · Windows", "ip": "1.2.3.4"}
    assert note.read_at is None


async def test_notify_variant_text(db: AsyncSession, make_user: UserFactory) -> None:
    made = await make_user()
    note = await notify(
        db, user_id=made.id, kind="login_failures", variant="two_factor", ip="1.2.3.4", count=10
    )
    assert note is not None
    await db.commit()
    assert note.kind == "login_failures"
    assert note.title == t("notifications.login_failures.two_factor.title")
    assert "1.2.3.4" in note.body and "10" in note.body
    # Повод сохранен: текст можно построить заново на другом языке
    assert note.params == {"ip": "1.2.3.4", "count": "10", "variant": "two_factor"}


async def test_notify_rejects_unknown_kind(db: AsyncSession, make_user: UserFactory) -> None:
    made = await make_user()
    with pytest.raises(ValueError):
        await notify(db, user_id=made.id, kind="spam")
