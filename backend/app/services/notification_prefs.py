"""Что присылать в центр уведомлений (кабинет «Уведомления», Р3, Р24).

Настройка — по видам уведомлений (notifications.kind): «на сайте» включено или нет. Строки
нет — включено. Push — только показ: он появится на этапе 6 (notification_prefs.push).

Обязательные виды приходят всегда, выключить их нельзя: вход с нового устройства,
неудачные попытки входа (защита аккаунта) и сообщение администратора (как в макете).
Какие виды человек может получать, зависит от роли и режима ключа (макет, «О чем
сообщать»): участнику на ключе администратора — лимит ИИ, на своем ключе — сбой ключа;
администратору — просьбы вернуть ключ, участники у лимита, бюджет ключа, архив матчей и
сигналы расхода ИИ. group — строка экрана: limit_80 и limit_100 (и budget_80 с budget_100,
bet_needs_result с settle_conflict) показываются одной строкой. Этап 5: ставка ждет
результата или архив показывает другое, еженедельный отчет; администратору — обучение
модели.

notifications.notify спрашивает is_enabled перед записью уведомления.
"""

from collections.abc import Sequence
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import NotificationPref, User
from app.schemas.cabinet import (
    AlertRulesOut,
    NotificationPrefIn,
    NotificationPrefOut,
    NotificationPrefsOut,
)

# Приходят всегда: защита аккаунта и важные новости от администратора
REQUIRED_KINDS = frozenset({"new_device", "login_failures", "admin_message"})


@dataclass(frozen=True)
class PrefKind:
    """Вид уведомления в настройках: строка экрана (group) и раздел администратора."""

    kind: str
    group: str
    admin: bool = False

    @property
    def required(self) -> bool:
        return self.kind in REQUIRED_KINDS


def available_kinds(user: User) -> list[PrefKind]:
    """Виды, которые этот человек может получать, по порядку экрана (макет profile.js,
    notifEvents)."""
    admin = user.role == "admin"
    own = user.ai_mode == "own"
    kinds = [
        PrefKind("bet_settled", "bet"),
        PrefKind("bet_needs_result", "needs"),
        PrefKind("settle_conflict", "needs"),
        PrefKind("weekly_report", "weekly"),
    ]
    if not admin:
        if own:
            kinds.append(PrefKind("ai_key_failed", "key"))
        else:
            kinds += [PrefKind("limit_80", "limit"), PrefKind("limit_100", "limit")]
        kinds.append(PrefKind("ai_mode_decision", "decision"))
    kinds += [
        PrefKind("new_device", "login"),
        PrefKind("login_failures", "fails"),
        PrefKind("admin_message", "message"),
    ]
    if admin:
        kinds += [
            PrefKind("learning", "learning", admin=True),
            PrefKind("ai_mode_request", "requests", admin=True),
            PrefKind("limit_80", "users", admin=True),
            PrefKind("limit_100", "users", admin=True),
            PrefKind("budget_80", "budget", admin=True),
            PrefKind("budget_100", "budget", admin=True),
            PrefKind("ai_key_failed", "key", admin=True),
            PrefKind("data_stale", "archive", admin=True),
            PrefKind("ai_alert", "alert", admin=True),
        ]
    return kinds


async def _stored(db: AsyncSession, user_id: int) -> dict[str, NotificationPref]:
    rows = await db.scalars(select(NotificationPref).where(NotificationPref.user_id == user_id))
    return {row.kind: row for row in rows}


def _out(
    kinds: Sequence[PrefKind],
    stored: dict[str, NotificationPref],
    alert_rules: AlertRulesOut | None = None,
) -> NotificationPrefsOut:
    items: list[NotificationPrefOut] = []
    for item in kinds:
        row = stored.get(item.kind)
        on_site = True if item.required or row is None else row.on_site
        items.append(
            NotificationPrefOut(
                kind=item.kind,  # type: ignore[arg-type]
                group=item.group,
                on_site=on_site,
                push=row.push if row is not None else False,
                required=item.required,
                admin=item.admin,
            )
        )
    return NotificationPrefsOut(items=items, push_available=False, alert_rules=alert_rules)


async def alert_rules(db: AsyncSession) -> AlertRulesOut:
    """Пороги сигналов расхода ИИ — из правил воркера (ai_alerts.RULES) и настроек агента."""
    # ai_alerts шлет уведомления через notifications, а та спрашивает is_enabled отсюда
    from app.agent.config import load_agent_config
    from app.services.ai_alerts import RULES

    config = await load_agent_config(db)
    return AlertRulesOut(
        cache_min_share=RULES.cache_min_share,
        cache_analyses=RULES.cache_analyses,
        cost_factor=float(RULES.cost_factor),
        cost_window_days=RULES.cost_window.days,
        stops_max_share=RULES.stops_max_share,
        searches_per_day=config.news_max_searches_per_day,
        rate_limit_series=RULES.rate_limit_series,
        rate_limit_window_minutes=int(RULES.rate_limit_window.total_seconds() // 60),
    )


async def get_prefs(db: AsyncSession, user: User) -> NotificationPrefsOut:
    rules = await alert_rules(db) if user.role == "admin" else None
    return _out(available_kinds(user), await _stored(db, user.id), rules)


async def update_prefs(
    db: AsyncSession, user: User, changes: Sequence[NotificationPrefIn]
) -> NotificationPrefsOut:
    """Частичное обновление: меняются только переданные виды. Обязательный вид выключить
    нельзя (422 notification.required), вид, которого у человека нет, — 422
    notification.kind_unavailable. Делает commit."""
    kinds = available_kinds(user)
    known = {item.kind for item in kinds}
    for change in changes:
        if change.kind not in known:
            raise AppError(422, "notification.kind_unavailable", kind=change.kind)
        if change.kind in REQUIRED_KINDS and not change.on_site:
            raise AppError(422, "notification.required", kind=change.kind)
    for change in changes:
        if change.kind in REQUIRED_KINDS:
            continue
        stmt = insert(NotificationPref).values(
            user_id=user.id, kind=change.kind, on_site=change.on_site
        )
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=[NotificationPref.user_id, NotificationPref.kind],
                set_={"on_site": stmt.excluded.on_site},
            )
        )
    await db.commit()
    return await get_prefs(db, user)


async def is_enabled(db: AsyncSession, user_id: int, kind: str) -> bool:
    """Присылать ли уведомление этого вида на сайт. Обязательные — всегда."""
    if kind in REQUIRED_KINDS:
        return True
    on_site = await db.scalar(
        select(NotificationPref.on_site).where(
            NotificationPref.user_id == user_id, NotificationPref.kind == kind
        )
    )
    return on_site is None or bool(on_site)
