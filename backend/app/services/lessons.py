"""Уроки (этап 5, п. 8; LLM_LEARNING.md, 1.1; Р25: уроки общие, ведет администратор).

Путь урока: гипотеза (из разбора ставки или предложена вручную) копит свои случаи — матчи
рассчитанных ставок под условием; с lesson_min_cases (у процессного —
lesson_min_cases_process) числовой урок проверяется на архиве кодом
(app/services/lesson_check.py) и становится ready (ждет решения) или rejected; процессный
вероятность не меняет — сразу ready. В анализ урок включает только администратор, после
быстрой проверки (app/services/lesson_quick.py) и не больше lessons_max_active; включение,
выключение и списание урока создают новую активную версию общей линии инструкций с блоком
уроков в system (app/services/strategy_versions.py). Раз в месяц действующие и готовые
уроки перепроверяются на новых матчах: не держится — retired (из анализа) или rejected.

Т21, Р14: основание урока — прогнозы и матчи (общие); ставки-источники хранятся, но каждый
видит только свои. Администратору приходят уведомления о готовых уроках, участник —
только если сам попросил «сообщить, когда наберется» (lesson_watches).
"""

from collections.abc import Sequence
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

import structlog
from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.config import AgentConfig, load_agent_config
from app.core.errors import AppError
from app.core.formatting import format_int
from app.core.i18n import t
from app.db.models import Bet, BetLeg, EvalRun, Lesson, LessonWatch, User
from app.ml.lesson_scope import (
    DIRECTIONS,
    MAX_CONDITIONS,
    Scope,
    ScopeError,
    dictionary,
    scope_key,
    validate_scope,
)
from app.schemas.lessons import (
    FeatureOut,
    LessonDictionaryOut,
    LessonEstimateOut,
    LessonHistoryOut,
    LessonIn,
    LessonOut,
    LessonQuickOut,
    LessonsOut,
    LessonStatus,
    ScopeIO,
)
from app.services import lesson_check, strategy_versions
from app.services.audit import write_audit
from app.services.check_runs import PENDING_RESERVE
from app.services.notifications import notify
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

# pg_advisory_xact_lock: код урока выдается по одному
CODE_LOCK = 0x6C6573736F6E0001
CODE_PREFIX = "L-"
# Ручных уроков от участника в сутки (администратор — без предела)
MEMBER_PROPOSALS_PER_DAY = 5
# Общее число случаев урока участнику — только с этого числа (иначе «меньше 5»)
PUBLIC_CASES_MIN = 5
# Куда ведут уведомления об уроках
LEARNING_LINK = "/learning"
# Порядок статусов в списке, как на экране «Уроки»
STATUS_ORDER = {"ready": 0, "hypothesis": 1, "confirmed": 2, "rejected": 3, "retired": 4}
# Уроки, которые проверяются на архиве и перепроверяются раз в месяц
CHECKED_STATUSES = ("ready", "confirmed")


def need_cases(lesson: Lesson, config: AgentConfig) -> int:
    if lesson.kind == "process":
        return config.lesson_min_cases_process
    return config.lesson_min_cases


def stored_scope(lesson: Lesson) -> Scope | None:
    """Условие урока из базы; не из словаря (старое или испорченное) — None."""
    if not lesson.scope:
        return None
    try:
        return validate_scope(lesson.scope)
    except ScopeError:
        return None


def _scope_io(scope: Scope | None) -> ScopeIO | None:
    if scope is None:
        return None
    raw = scope.to_json()
    return ScopeIO.model_validate({"direction": raw["direction"], "conditions": raw["conditions"]})


async def _next_code(db: AsyncSession) -> str:
    """Следующий код общего урока L-NNN (под блокировкой: два урока не получат один код)."""
    await db.execute(select(func.pg_advisory_xact_lock(CODE_LOCK)))
    codes = await db.scalars(select(Lesson.code).where(Lesson.user_id.is_(None)))
    numbers = [
        int(code[2:]) for code in codes if code.startswith(CODE_PREFIX) and code[2:].isdigit()
    ]
    return f"{CODE_PREFIX}{max(numbers, default=0) + 1:03d}"


async def find_same(db: AsyncSession, scope: Scope) -> Lesson | None:
    """Общий урок с тем же условием и направлением (каноническая форма)."""
    key = scope_key(scope)
    rows = await db.scalars(
        select(Lesson)
        .where(Lesson.user_id.is_(None), Lesson.scope.is_not(None))
        .order_by(Lesson.id)
    )
    for lesson in rows:
        found = stored_scope(lesson)
        if found is not None and scope_key(found) == key:
            return lesson
    return None


def _add_ids(current: Sequence[int] | None, new: Sequence[int]) -> list[int]:
    merged = list(current or [])
    for value in new:
        if value not in merged:
            merged.append(value)
    return merged


async def attach_hypothesis(
    db: AsyncSession,
    *,
    scope: Scope,
    text: str,
    prediction_id: int | None,
    bet_id: int | None,
) -> Lesson:
    """Гипотеза из разбора: тот же урок (по условию) получает еще одно основание, иначе —
    новый общий урок-гипотеза. Отклоненный урок с тем же условием второй раз не
    создается: разбор ссылается на него. flush; commit — за вызывающим."""
    lesson = await find_same(db, scope)
    predictions = [prediction_id] if prediction_id is not None else []
    bets = [bet_id] if bet_id is not None else []
    if lesson is None:
        lesson = Lesson(
            user_id=None,
            code=await _next_code(db),
            text=text,
            scope=scope.to_json(),
            kind="numeric",
            status="hypothesis",
            origin="postmortem",
            source_prediction_ids=predictions,
            source_bet_ids=bets,
            metrics={},
        )
        db.add(lesson)
    else:
        lesson.source_prediction_ids = _add_ids(lesson.source_prediction_ids, predictions)
        lesson.source_bet_ids = _add_ids(lesson.source_bet_ids, bets)
    await db.flush()
    return lesson


async def propose(db: AsyncSession, user: User, body: LessonIn) -> Lesson:
    """«Предложить урок»: гипотеза с условием из словаря; проверка та же, что у гипотез из
    разборов. Условие не из словаря — 422; процессный урок (без проверки на архиве) —
    только администратор, участнику 422; такой урок уже есть — 409 с его кодом; участник —
    не больше MEMBER_PROPOSALS_PER_DAY в сутки (429): счетчик — под FOR UPDATE строки
    участника, параллельные запросы считаются по одному (М6). Свои случаи считаются после
    commit урока, в той же сессии: под блокировкой кода второе соединение не берется.
    commit."""
    try:
        scope = validate_scope(body.scope.model_dump())
    except ScopeError as exc:
        raise AppError(422, f"{exc.code}", **exc.params) from None
    if body.kind == "process" and user.role != "admin":
        raise AppError(422, "lesson.process_admin_only")
    if user.role != "admin":
        await db.execute(select(User.id).where(User.id == user.id).with_for_update())
        since = utcnow() - timedelta(days=1)
        count = await db.scalar(
            select(func.count())
            .select_from(Lesson)
            .where(Lesson.created_by == user.id, Lesson.created_at >= since)
        )
        if int(count or 0) >= MEMBER_PROPOSALS_PER_DAY:
            raise AppError(429, "lesson.too_many", limit=MEMBER_PROPOSALS_PER_DAY)
    same = await find_same(db, scope)
    if same is not None:
        raise AppError(409, "lesson.exists", lesson=same.code)
    lesson = Lesson(
        user_id=None,
        code=await _next_code(db),
        text=" ".join(body.text.split()),
        scope=scope.to_json(),
        kind=body.kind,
        status="hypothesis",
        origin="manual",
        created_by=user.id,
        metrics={},
    )
    db.add(lesson)
    await db.commit()
    try:
        locked = await db.get(Lesson, lesson.id, with_for_update=True, populate_existing=True)
        if locked is not None:
            await refresh_cases(db, locked)
            lesson = locked
        await db.commit()
    except Exception:
        # Урок уже сохранен: случаи досчитает ежедневная проверка уроков
        await db.rollback()
        log.warning("lessons.propose.cases_failed", lesson_id=lesson.id, exc_info=True)
    return lesson


# --- свои случаи и проверка ---


async def refresh_cases(db: AsyncSession, lesson: Lesson) -> lesson_check.OwnCases | None:
    """Свои случаи урока по условию (запрос только для чтения): n_cases, ставки и прогнозы
    основания, metrics.own. Условие не из словаря — None. flush."""
    scope = stored_scope(lesson)
    if scope is None:
        return None
    own = await lesson_check.own_cases(db, scope)
    lesson.n_cases = own.n
    lesson.source_bet_ids = _add_ids(lesson.source_bet_ids, own.bet_ids)
    lesson.source_prediction_ids = _add_ids(lesson.source_prediction_ids, own.prediction_ids)
    lesson.metrics = {
        **(lesson.metrics or {}),
        "own": {
            "n": own.n,
            "legs": own.legs,
            "residual": own.residual,
            # Ноги случаев: по ним участнику считаются только его случаи (own_cases)
            "leg_ids": list(own.leg_ids),
        },
    }
    await db.flush()
    return own


def apply_history(lesson: Lesson, check: lesson_check.HistoryCheck, now: datetime) -> None:
    """Итог проверки на архиве — в поля урока и metrics.history."""
    lesson.n_hist = check.n_hist
    lesson.metrics = {
        **(lesson.metrics or {}),
        "history": {**check.to_json(), "checked_at": now.isoformat()},
    }
    if check.bias is not None:
        lesson.effect = check.bias.value
        lesson.effect_ci = [check.bias.low, check.bias.high]
        lesson.effect_shrunk = check.shift
    if check.holdout_gain is not None:
        lesson.holdout_effect = check.holdout_gain.value
        lesson.holdout_ci = [check.holdout_gain.low, check.holdout_gain.high]
    lesson.validated_at = now


async def _admins(db: AsyncSession) -> list[int]:
    return list(
        await db.scalars(select(User.id).where(User.role == "admin", User.status == "active"))
    )


async def notify_status(db: AsyncSession, lesson: Lesson, variant: str) -> int:
    """Уведомление «урок готов / не подтвердился / списан»: администраторам и тем, кто
    просил сообщить (каждому один раз). flush. → сколько отправлено."""
    params: dict[str, Any] = {
        "code": lesson.code,
        "cases": format_int(lesson.n_cases),
        "hist": format_int(lesson.n_hist),
    }
    recipients = set(await _admins(db))
    watches = list(
        await db.scalars(
            select(LessonWatch).where(
                LessonWatch.lesson_id == lesson.id, LessonWatch.notified_at.is_(None)
            )
        )
    )
    recipients |= {watch.user_id for watch in watches}
    sent = 0
    for user_id in sorted(recipients):
        note = await notify(
            db, user_id=user_id, kind="learning", variant=variant, link=LEARNING_LINK, **params
        )
        sent += note is not None
    moment = utcnow()
    for watch in watches:
        watch.notified_at = moment
    await db.flush()
    return sent


async def check_one(
    db: AsyncSession, lesson: Lesson, config: AgentConfig, *, now: datetime
) -> str | None:
    """Гипотеза с нужным числом своих случаев — проверка: числовой урок на архиве,
    процессный — сразу ready (его проверит быстрая проверка). → новый статус или None.
    flush; commit — за вызывающим."""
    if lesson.status != "hypothesis":
        return None
    own = await refresh_cases(db, lesson)
    if own is None or lesson.n_cases < need_cases(lesson, config):
        return None
    if lesson.kind == "process":
        lesson.status = "ready"
        lesson.validated_at = now
        await notify_status(db, lesson, "lesson_ready")
        return lesson.status
    scope = stored_scope(lesson)
    assert scope is not None
    check = await lesson_check.check_history(
        db, scope, today=now.date(), shrink_k=config.lesson_shrink_k
    )
    apply_history(lesson, check, now)
    if check.status == "insufficient":
        await db.flush()
        return None
    lesson.status = check.status
    await notify_status(
        db, lesson, "lesson_ready" if check.status == "ready" else "lesson_rejected"
    )
    return lesson.status


async def check_lessons(
    db: AsyncSession, *, now: datetime | None = None, lesson_ids: Sequence[int] | None = None
) -> dict[str, int]:
    """Счетчики своих случаев и проверка гипотез на пороге (задача раз в сутки и после
    сбора разборов). commit после каждого урока. → сколько стало ready и rejected."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    stmt = select(Lesson.id).where(Lesson.user_id.is_(None), Lesson.status == "hypothesis")
    if lesson_ids is not None:
        stmt = stmt.where(Lesson.id.in_(list(lesson_ids)))
    counts = {"checked": 0, "ready": 0, "rejected": 0}
    for lesson_id in list(await db.scalars(stmt.order_by(Lesson.id))):
        lesson = await db.get(Lesson, lesson_id, with_for_update=True, populate_existing=True)
        if lesson is None:
            continue
        status = await check_one(db, lesson, config, now=moment)
        counts["checked"] += 1
        if status in counts:
            counts[status] += 1
        await db.commit()
    return counts


async def recheck_lessons(db: AsyncSession, *, now: datetime | None = None) -> dict[str, int]:
    """Ежемесячная перепроверка готовых и действующих числовых уроков на архиве с новыми
    матчами: не держится — confirmed становится retired (из анализа), ready — rejected.
    commit после каждого урока."""
    moment = now or utcnow()
    config = await load_agent_config(db)
    ids = list(
        await db.scalars(
            select(Lesson.id)
            .where(
                Lesson.user_id.is_(None),
                Lesson.status.in_(CHECKED_STATUSES),
                Lesson.kind == "numeric",
            )
            .order_by(Lesson.id)
        )
    )
    counts = {"checked": 0, "kept": 0, "retired": 0, "rejected": 0}
    for lesson_id in ids:
        # Порядок блокировок — как у решений администратора: общая линия, затем урок
        await strategy_versions.lock_shared(db)
        await strategy_versions.ensure_shared_active(db)
        lesson = await db.get(Lesson, lesson_id, with_for_update=True, populate_existing=True)
        scope = stored_scope(lesson) if lesson is not None else None
        if lesson is None or scope is None:
            continue
        await refresh_cases(db, lesson)
        check = await lesson_check.check_history(
            db, scope, today=moment.date(), shrink_k=config.lesson_shrink_k
        )
        apply_history(lesson, check, moment)
        lesson.rechecked_at = moment
        counts["checked"] += 1
        if check.status == "rejected":
            if lesson.status == "confirmed":
                was_on = lesson.in_prompt
                lesson.status = "retired"
                lesson.in_prompt = False
                lesson.retired_at = moment
                counts["retired"] += 1
                await notify_status(db, lesson, "lesson_retired")
                if was_on:
                    # Списанный урок уходит из инструкций новой версией общей линии
                    await db.flush()
                    await strategy_versions.sync_lessons(
                        db,
                        actor_id=None,
                        change=t("learning.changes.lesson_retired", code=lesson.code),
                    )
            else:
                lesson.status = "rejected"
                counts["rejected"] += 1
                await notify_status(db, lesson, "lesson_rejected")
        else:
            counts["kept"] += 1
        await db.commit()
    return counts


# --- решения администратора ---


async def shared_lesson(db: AsyncSession, lesson_id: int, *, lock: bool = False) -> Lesson:
    stmt = select(Lesson).where(Lesson.id == lesson_id, Lesson.user_id.is_(None))
    if lock:
        stmt = stmt.with_for_update()
    lesson = await db.scalar(stmt.execution_options(populate_existing=True))
    if lesson is None:
        raise AppError(404, "lesson.not_found")
    return lesson


async def active_count(db: AsyncSession) -> int:
    count = await db.scalar(
        select(func.count()).select_from(Lesson).where(Lesson.in_prompt.is_(True))
    )
    return int(count or 0)


def quick_passed(lesson: Lesson) -> bool:
    """Быстрая проверка пройдена после последней проверки на истории."""
    quick = (lesson.metrics or {}).get("quick") or {}
    if quick.get("status") != "done" or quick.get("passed") is not True:
        return False
    finished = quick.get("finished_at")
    if lesson.validated_at is None or not isinstance(finished, str):
        return True
    try:
        return datetime.fromisoformat(finished) >= lesson.validated_at
    except ValueError:
        return False


async def enable(db: AsyncSession, admin: User, lesson_id: int, *, ip: str | None) -> Lesson:
    """«Использовать в анализе» (В4): урок ready или confirmed, быстрая проверка пройдена,
    в анализе меньше lessons_max_active. Решение администратора после быстрой проверки:
    новая версия общей линии инструкций с этим уроком в блоке уроков system становится
    активной (strategy_versions.sync_lessons; прежняя — в архиве, откат в один клик).
    Журнал lesson_on. commit."""
    config = await load_agent_config(db)
    # Порядок блокировок: общая линия инструкций, затем урок (как перепроверка и
    # включение версии): включения уроков идут по одному, предел не превысить
    await strategy_versions.lock_shared(db)
    # Активная версия линии — до изменения урока: иначе первая версия (v3) создалась бы
    # уже с ним, и новой версии «+ урок» не было бы
    await strategy_versions.ensure_shared_active(db)
    lesson = await shared_lesson(db, lesson_id, lock=True)
    if lesson.in_prompt:
        await db.commit()
        return lesson
    if lesson.status not in CHECKED_STATUSES:
        raise AppError(409, "lesson.not_ready")
    if not quick_passed(lesson):
        raise AppError(409, "lesson.quick_check_needed")
    active = await active_count(db)
    if active >= config.lessons_max_active:
        raise AppError(
            409,
            "lesson.max_active",
            max=config.lessons_max_active,
            count=config.lessons_max_active,
        )
    moment = utcnow()
    lesson.status = "confirmed"
    lesson.in_prompt = True
    lesson.decided_by = admin.id
    lesson.decided_at = moment
    await db.flush()
    version = await strategy_versions.sync_lessons(
        db, actor_id=admin.id, change=t("learning.changes.lesson_on", code=lesson.code)
    )
    await write_audit(
        db,
        action="lesson_on",
        actor_id=admin.id,
        details={
            "code": lesson.code,
            "active": active + 1,
            "version": version.code if version is not None else None,
        },
        ip=ip,
    )
    await db.commit()
    return lesson


async def disable(db: AsyncSession, admin: User, lesson_id: int, *, ip: str | None) -> Lesson:
    """Выключить урок из анализа: статус остается confirmed, новая версия общей линии без
    него становится активной; включить снова — после новой быстрой проверки. Журнал
    lesson_off. commit."""
    await strategy_versions.lock_shared(db)
    await strategy_versions.ensure_shared_active(db)
    lesson = await shared_lesson(db, lesson_id, lock=True)
    if not lesson.in_prompt:
        await db.commit()
        return lesson
    lesson.in_prompt = False
    lesson.decided_by = admin.id
    lesson.decided_at = utcnow()
    quick = dict((lesson.metrics or {}).get("quick") or {})
    if quick:
        # Включить снова — только после новой быстрой проверки (макет: «с быстрой проверкой»)
        lesson.metrics = {**(lesson.metrics or {}), "quick": {**quick, "passed": False}}
    await db.flush()
    version = await strategy_versions.sync_lessons(
        db, actor_id=admin.id, change=t("learning.changes.lesson_off", code=lesson.code)
    )
    await write_audit(
        db,
        action="lesson_off",
        actor_id=admin.id,
        details={
            "code": lesson.code,
            "version": version.code if version is not None else None,
        },
        ip=ip,
    )
    await db.commit()
    return lesson


async def watch(db: AsyncSession, user: User, lesson_id: int) -> Lesson:
    """«Сообщить, когда наберется»: уведомление в центре уведомлений, когда урок проверят
    (только на сайте, push — этап 6). Урок уже проверен — 409. Повтор ничего не меняет.
    commit."""
    lesson = await visible_lesson(db, user, lesson_id)
    if lesson.status != "hypothesis":
        raise AppError(409, "lesson.already_checked")
    await db.execute(
        insert(LessonWatch)
        .values(lesson_id=lesson.id, user_id=user.id)
        .on_conflict_do_nothing(index_elements=[LessonWatch.lesson_id, LessonWatch.user_id])
    )
    await db.commit()
    return lesson


# --- чтение ---


async def visible_lesson(db: AsyncSession, user: User, lesson_id: int) -> Lesson:
    """Общий урок или свой (user_id — только владельцу); иначе 404."""
    lesson = await db.scalar(
        select(Lesson).where(Lesson.id == lesson_id).execution_options(populate_existing=True)
    )
    if lesson is None or (lesson.user_id is not None and lesson.user_id != user.id):
        raise AppError(404, "lesson.not_found")
    return lesson


def _estimate(raw: Any) -> LessonEstimateOut | None:
    if not isinstance(raw, dict):
        return None
    try:
        return LessonEstimateOut(
            value=float(raw["value"]),
            low=float(raw["low"]),
            high=float(raw["high"]),
            n=int(raw["n"]),
        )
    except (KeyError, TypeError, ValueError):
        return None


def _when(raw: Any) -> datetime | None:
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def history_out(raw: Any) -> LessonHistoryOut | None:
    if not isinstance(raw, dict) or raw.get("status") not in ("ready", "rejected", "insufficient"):
        return None
    since = raw.get("holdout_since")
    return LessonHistoryOut(
        checked_at=_when(raw.get("checked_at")),
        status=raw["status"],
        reason=raw.get("reason"),
        method=str(raw.get("method") or lesson_check.METHOD),
        n_hist=int(raw.get("n_hist") or 0),
        n_history=int(raw.get("n_history") or 0),
        n_holdout=int(raw.get("n_holdout") or 0),
        # Проверки до №3 (n с учетом своих) не хранили n_shrink: показываем историю
        n_shrink=int(raw.get("n_shrink") or raw.get("n_history") or 0),
        holdout_since=datetime.fromisoformat(since).date() if isinstance(since, str) else None,
        bias=_estimate(raw.get("bias")),
        shift=raw.get("shift"),
        log_loss_without=raw.get("log_loss_without"),
        log_loss_with=raw.get("log_loss_with"),
        gain=_estimate(raw.get("gain")),
        holdout_gain=_estimate(raw.get("holdout_gain")),
        seed=int(raw.get("seed") or lesson_check.SEED),
    )


def quick_out(raw: Any) -> LessonQuickOut | None:
    if not isinstance(raw, dict) or raw.get("eval_run_id") is None:
        return None
    return LessonQuickOut(
        eval_run_id=int(raw["eval_run_id"]),
        status=raw.get("status") or "pending",
        started_at=_when(raw.get("started_at")),
        finished_at=_when(raw.get("finished_at")),
        events=int(raw.get("events") or 0),
        requests=int(raw.get("requests") or 0),
        passed=raw.get("passed"),
        diff=_estimate(raw.get("diff")),
        margin=float(raw.get("margin") or 0.0),
        format_errors=int(raw.get("format_errors") or 0),
        refusals=int(raw.get("refusals") or 0),
        unrated=int(raw.get("unrated") or 0),
        cost_usd=Decimal(str(raw.get("cost_usd") or "0")),
        worst_usd=Decimal(str(raw.get("worst_usd") or "0")),
        error=raw.get("error"),
    )


def lesson_out(
    lesson: Lesson,
    config: AgentConfig,
    *,
    own_bets: Sequence[int] = (),
    watching: bool = False,
    n_cases: int | None = None,
    own: int = 0,
) -> LessonOut:
    """Урок для экрана. n_cases — общее число случаев, которое можно показать смотрящему
    (public_cases; None — меньше PUBLIC_CASES_MIN), own — сколько из них его."""
    metrics = lesson.metrics or {}
    scope = stored_scope(lesson)
    return LessonOut(
        id=lesson.id,
        code=lesson.code,
        text=lesson.text,
        kind=lesson.kind,  # type: ignore[arg-type]
        status=lesson.status,  # type: ignore[arg-type]
        origin=lesson.origin,  # type: ignore[arg-type]
        shared=lesson.user_id is None,
        scope=_scope_io(scope),
        scope_ok=scope is not None,
        in_prompt=lesson.in_prompt,
        created_at=lesson.created_at,
        n_cases=n_cases,
        n_cases_few=n_cases is None,
        own_cases=own,
        need_cases=need_cases(lesson, config),
        n_hist=lesson.n_hist,
        effect=lesson.effect,
        effect_ci=lesson.effect_ci,
        effect_shrunk=lesson.effect_shrunk,
        holdout_effect=lesson.holdout_effect,
        holdout_ci=lesson.holdout_ci,
        validated_at=lesson.validated_at,
        decided_at=lesson.decided_at,
        retired_at=lesson.retired_at,
        rechecked_at=lesson.rechecked_at,
        history=history_out(metrics.get("history")),
        quick=quick_out(metrics.get("quick")),
        own_bets=list(own_bets),
        watching=watching,
    )


async def _own_bets(db: AsyncSession, user: User, lessons: Sequence[Lesson]) -> set[int]:
    """Ставки этого участника среди ставок-источников уроков (Т21: чужие не видны)."""
    ids = {bet_id for lesson in lessons for bet_id in (lesson.source_bet_ids or [])}
    if not ids:
        return set()
    return set(await db.scalars(select(Bet.id).where(Bet.id.in_(ids), Bet.user_id == user.id)))


def public_cases(user: User, lesson: Lesson) -> int | None:
    """Общее число случаев урока (по ставкам всех участников), которое можно показать:
    администратору — всегда, участнику — с PUBLIC_CASES_MIN (№3 проверки экранов волны 3):
    при меньшем числе по нему вычислялась бы чужая ставка (m2 волны 2). None — «меньше
    PUBLIC_CASES_MIN»."""
    if user.role == "admin" or lesson.n_cases >= PUBLIC_CASES_MIN:
        return lesson.n_cases
    return None


async def own_cases(db: AsyncSession, user: User, lessons: Sequence[Lesson]) -> dict[int, int]:
    """Сколько случаев урока — матчи ставок этого человека (у администратора — его
    собственных). → урок → случаев."""
    if not lessons:
        return {}
    legs: dict[int, list[int]] = {}
    for lesson in lessons:
        own = (lesson.metrics or {}).get("own") or {}
        raw = own.get("leg_ids") if isinstance(own, dict) else None
        legs[lesson.id] = [int(value) for value in raw or [] if isinstance(value, int)]
    every = {leg_id for ids in legs.values() for leg_id in ids}
    mine: dict[int, int] = {}
    if every:
        mine = {
            int(leg_id): int(match_id)
            for leg_id, match_id in (
                await db.execute(
                    select(BetLeg.id, BetLeg.match_id)
                    .join(Bet, Bet.id == BetLeg.bet_id)
                    .where(BetLeg.id.in_(every), Bet.user_id == user.id)
                )
            ).all()
        }
    return {
        lesson.id: len({mine[leg_id] for leg_id in legs[lesson.id] if leg_id in mine})
        for lesson in lessons
    }


async def _watching(db: AsyncSession, user: User, lessons: Sequence[Lesson]) -> set[int]:
    if not lessons:
        return set()
    return set(
        await db.scalars(
            select(LessonWatch.lesson_id).where(
                LessonWatch.user_id == user.id,
                LessonWatch.lesson_id.in_([lesson.id for lesson in lessons]),
            )
        )
    )


async def lessons_for(
    db: AsyncSession, user: User, lessons: Sequence[Lesson], config: AgentConfig
) -> list[LessonOut]:
    mine = await _own_bets(db, user, lessons)
    watching = await _watching(db, user, lessons)
    mine_cases = await own_cases(db, user, lessons)
    return [
        lesson_out(
            lesson,
            config,
            own_bets=sorted(bet_id for bet_id in (lesson.source_bet_ids or []) if bet_id in mine),
            watching=lesson.id in watching,
            n_cases=public_cases(user, lesson),
            own=mine_cases.get(lesson.id, 0),
        )
        for lesson in lessons
    ]


async def list_lessons(
    db: AsyncSession, user: User, *, status: LessonStatus | None = None
) -> LessonsOut:
    """Общие уроки и свои (если есть): по статусу (готовые — первыми), новые сверху."""
    config = await load_agent_config(db)
    stmt = select(Lesson).where((Lesson.user_id.is_(None)) | (Lesson.user_id == user.id))
    if status is not None:
        stmt = stmt.where(Lesson.status == status)
    rows = list(await db.scalars(stmt))
    rows.sort(
        key=lambda item: (STATUS_ORDER.get(item.status, 9), -item.created_at.timestamp(), -item.id)
    )
    return LessonsOut(
        items=await lessons_for(db, user, rows, config),
        active=await active_count(db),
        max_active=config.lessons_max_active,
        min_cases=config.lesson_min_cases,
        min_cases_process=config.lesson_min_cases_process,
        shrink_k=config.lesson_shrink_k,
        public_cases_min=PUBLIC_CASES_MIN,
    )


async def lesson_detail(db: AsyncSession, user: User, lesson_id: int) -> LessonOut:
    config = await load_agent_config(db)
    lesson = await visible_lesson(db, user, lesson_id)
    [item] = await lessons_for(db, user, [lesson], config)
    return item


async def lesson_view(db: AsyncSession, user: User, lesson: Lesson) -> LessonOut:
    config = await load_agent_config(db)
    [item] = await lessons_for(db, user, [lesson], config)
    return item


def dictionary_out() -> LessonDictionaryOut:
    return LessonDictionaryOut(
        features=[FeatureOut.model_validate(item) for item in dictionary()],
        directions=list(DIRECTIONS),  # type: ignore[arg-type]
        max_conditions=MAX_CONDITIONS,
    )


async def running_quick(db: AsyncSession, lesson_id: int) -> EvalRun | None:
    """Быстрая проверка урока, которая еще идет: пакет ушел (running со строкой пакета)
    или прогон моложе PENDING_RESERVE (старше без пакета — завис, его уберет
    lesson_quick.reap_stuck; запуск не блокирует)."""
    fresh = utcnow() - PENDING_RESERVE
    found: EvalRun | None = await db.scalar(
        select(EvalRun)
        .where(
            EvalRun.metrics["kind"].astext == "quick",
            EvalRun.metrics["lesson_id"].astext == str(lesson_id),
            EvalRun.status.in_(("pending", "running")),
            EvalRun.batch_job_id.is_not(None) | (EvalRun.created_at >= fresh),
        )
        .order_by(EvalRun.id.desc())
        .limit(1)
    )
    return found
