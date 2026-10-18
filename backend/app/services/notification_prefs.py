"""Что присылать: на сайт (колокольчик) и push (кабинет «Уведомления», Р3, Р24, Р26).

Настройка — по видам уведомлений (notifications.kind): «на сайте» и «push», включено или
нет. Строки нет — значения по умолчанию: на сайте — да, push — да у всех видов, кроме
обучения модели и сигналов расхода ИИ (В2: их удобнее смотреть на сайте). Строка пишется
всегда с обоими значениями. Настройки общие для аккаунта: push приходит на все устройства
с подпиской (app/services/push.py). push_available — есть ли у человека хоть одна активная
подписка: пока нет, столбец «Push» на экране неактивен (В5).

Обязательные виды на сайте приходят всегда, выключить их нельзя: вход с нового устройства,
неудачные попытки входа (защита аккаунта) и сообщение администратора (как в макете). Push
у них можно выключить.

Тихие часы push (В3) — у пользователя (users.quiet_*): по умолчанию включены, 23:00–08:00
по его поясу, шаг 30 минут, начало и конец не совпадают (422 notification.quiet_same).
Какие виды человек может получать, зависит от роли и режима ключа (макет, «О чем
сообщать»): участнику на ключе администратора — лимит ИИ, на своем ключе — сбой ключа;
администратору — просьбы вернуть ключ, участники у лимита, бюджет ключа, архив матчей и
сигналы расхода ИИ. group — строка экрана: limit_80 и limit_100 (и budget_80 с budget_100,
bet_needs_result с settle_conflict) показываются одной строкой. Этап 5: ставка ждет
результата или архив показывает другое, еженедельный отчет; администратору — обучение
модели.

notifications.notify спрашивает kind_prefs перед записью уведомления и постановкой push.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, time

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.db.models import NotificationPref, PushSubscription, User, UserSession
from app.schemas.cabinet import (
    AlertRulesOut,
    NotificationPrefIn,
    NotificationPrefOut,
    NotificationPrefsOut,
    NotificationScheduleOut,
    QuietHoursIn,
    QuietHoursOut,
)

# Приходят всегда: защита аккаунта и важные новости от администратора
REQUIRED_KINDS = frozenset({"new_device", "login_failures", "admin_message"})
# Push по умолчанию выключен (В2): обучение модели и сигналы расхода ИИ
PUSH_OFF_KINDS = frozenset({"learning", "ai_alert"})
# Новые виды (отметка «новое» в макете): этап 5 и сигналы расхода ИИ
NEW_KINDS = frozenset(
    {"bet_needs_result", "settle_conflict", "weekly_report", "learning", "ai_alert"}
)


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
            # Р28: рынок «для сравнения» прошел порог — строка «Обучение модели»
            PrefKind("market_ready", "learning", admin=True),
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
    # populate_existing: после upsert в том же сеансе — значения из базы, а не прежние
    rows = await db.scalars(
        select(NotificationPref)
        .where(NotificationPref.user_id == user_id)
        .execution_options(populate_existing=True)
    )
    return {row.kind: row for row in rows}


def default_push(kind: str) -> bool:
    """Push вида, пока человек его не менял (В2)."""
    return kind not in PUSH_OFF_KINDS


def _hhmm(value: time) -> str:
    return value.strftime("%H:%M")


def _parse_hhmm(value: str) -> time:
    hours, minutes = value.split(":")
    return time(int(hours), int(minutes))


def quiet_hours_of(user: User) -> QuietHoursOut:
    return QuietHoursOut(
        enabled=user.quiet_enabled, start=_hhmm(user.quiet_start), end=_hhmm(user.quiet_end)
    )


def _out(
    kinds: Sequence[PrefKind],
    stored: dict[str, NotificationPref],
    schedule: NotificationScheduleOut,
    *,
    push_available: bool,
    quiet_hours: QuietHoursOut,
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
                push=row.push if row is not None else default_push(item.kind),
                required=item.required,
                admin=item.admin,
                new=item.kind in NEW_KINDS,
            )
        )
    return NotificationPrefsOut(
        items=items,
        push_available=push_available,
        quiet_hours=quiet_hours,
        alert_rules=alert_rules,
        schedule=schedule,
    )


def schedule_of(user: User, now: datetime | None = None) -> NotificationScheduleOut:
    """Когда приходят виды этапа 5 — те же константы, что у воркера."""
    # Импорт внутри: сервисы ниже шлют уведомления через этот модуль
    from app.services.auto_settlement import REMINDER_DAYS
    from app.services.bank import user_zone
    from app.services.data_status import UPLOAD_HOUR
    from app.services.data_uploads import STALE_DAYS
    from app.services.learning import REPORT_HOUR, next_report_day
    from app.services.sessions import utcnow

    return NotificationScheduleOut(
        tz=user_zone(user.tz).key,
        report_weekday=0,
        report_hour=REPORT_HOUR,
        next_report=next_report_day(now or utcnow(), user.tz),
        settle_reminder_days=REMINDER_DAYS,
        upload_hour=UPLOAD_HOUR,
        upload_stale_days=STALE_DAYS,
    )


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


async def has_push(db: AsyncSession, user_id: int) -> bool:
    """Есть хоть одна активная подписка push с действующим сеансом (столбец «Push»
    активен, В5)."""
    from app.services.sessions import session_alive

    found = await db.scalar(
        select(PushSubscription.id)
        .join(UserSession, UserSession.id == PushSubscription.session_id)
        .where(
            PushSubscription.user_id == user_id,
            PushSubscription.revoked_at.is_(None),
            *session_alive(),
        )
        .limit(1)
    )
    return found is not None


async def get_prefs(db: AsyncSession, user: User) -> NotificationPrefsOut:
    rules = await alert_rules(db) if user.role == "admin" else None
    return _out(
        available_kinds(user),
        await _stored(db, user.id),
        schedule_of(user),
        push_available=await has_push(db, user.id),
        quiet_hours=quiet_hours_of(user),
        alert_rules=rules,
    )


def _check_quiet(quiet: QuietHoursIn) -> tuple[time, time]:
    start, end = _parse_hhmm(quiet.start), _parse_hhmm(quiet.end)
    if start == end:
        raise AppError(422, "notification.quiet_same")
    return start, end


async def update_prefs(
    db: AsyncSession,
    user: User,
    changes: Sequence[NotificationPrefIn],
    quiet: QuietHoursIn | None = None,
) -> NotificationPrefsOut:
    """Частичное обновление: меняются только переданные виды и поля (on_site, push) и,
    если переданы, тихие часы. Обязательный вид выключить на сайте нельзя (422
    notification.required), push у него — можно; вид, которого у человека нет, — 422
    notification.kind_unavailable; начало тихих часов равно концу — 422
    notification.quiet_same. Делает commit."""
    kinds = available_kinds(user)
    known = {item.kind for item in kinds}
    for change in changes:
        if change.kind not in known:
            raise AppError(422, "notification.kind_unavailable", kind=change.kind)
        if change.kind in REQUIRED_KINDS and change.on_site is False:
            raise AppError(422, "notification.required", kind=change.kind)
    window = _check_quiet(quiet) if quiet is not None else None
    stored = await _stored(db, user.id)
    for change in changes:
        row = stored.get(change.kind)
        on_site = row.on_site if row is not None else True
        push = row.push if row is not None else default_push(change.kind)
        if change.on_site is not None and change.kind not in REQUIRED_KINDS:
            on_site = change.on_site
        if change.push is not None:
            push = change.push
        stmt = insert(NotificationPref).values(
            user_id=user.id, kind=change.kind, on_site=on_site, push=push
        )
        await db.execute(
            stmt.on_conflict_do_update(
                index_elements=[NotificationPref.user_id, NotificationPref.kind],
                set_={"on_site": stmt.excluded.on_site, "push": stmt.excluded.push},
            )
        )
    if quiet is not None and window is not None:
        user.quiet_enabled = quiet.enabled
        user.quiet_start, user.quiet_end = window
    await db.commit()
    return await get_prefs(db, user)


async def kind_prefs(db: AsyncSession, user_id: int, kind: str) -> tuple[bool, bool]:
    """(на сайте, push) для вида у человека. Обязательные на сайте — всегда."""
    row = (
        await db.execute(
            select(NotificationPref.on_site, NotificationPref.push).where(
                NotificationPref.user_id == user_id, NotificationPref.kind == kind
            )
        )
    ).first()
    if row is None:
        return True, default_push(kind)
    return bool(row.on_site) or kind in REQUIRED_KINDS, bool(row.push)


async def is_enabled(db: AsyncSession, user_id: int, kind: str) -> bool:
    """Присылать ли уведомление этого вида на сайт. Обязательные — всегда."""
    return (await kind_prefs(db, user_id, kind))[0]


async def push_allowed(db: AsyncSession, user_id: int, kind: str) -> bool:
    """Разрешен ли вид в push (В2 — значение по умолчанию)."""
    return (await kind_prefs(db, user_id, kind))[1]
