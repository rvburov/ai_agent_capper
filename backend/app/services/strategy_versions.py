"""Версии стратегии (этап 5, Р25 уточняет Р1).

Две линии версий:

- **инструкции анализа** — общая линия (user_id пустой), ее ведет администратор: промпт
  анализа (prompt_version — составная версия, например analysis.v1+lessons_block.v3:<sha>)
  и уроки в system (lessons — коды, params.lessons_block — снимок текста блока уроков на
  момент создания версии: перепроверка урока не меняет действующие инструкции тихо).
  Анализ берет system активной версии общей линии (instructions_prompt). Кандидат —
  новый промпт анализа или другой набор уроков; включает его только администратор и
  только после прогона на замороженном наборе (app/services/eval_runs.py); кандидат после
  прогона остается кандидатом. Включение урока «Использовать в анализе» — это решение
  администратора после быстрой проверки (В4): оно создает новую версию линии с этим уроком
  и сразу делает ее активной (прежняя — в архиве, откат в один клик); выключение и
  списание урока — так же, без урока;
- **правила суммы ставки** — свои у каждого участника (params, app/ml/strategy.py):
  активная v3 создается при первом анализе (ensure_active); изменение — кандидат с
  проверкой на своих ставках (app/services/rule_check.py), включает его владелец кнопкой,
  откат — в один клик. Другого способа поменять адаптации суммы нет (В7 этапа 4).

Активная версия в каждой линии одна (частичный UNIQUE NULLS NOT DISTINCT). Изменения
общей линии идут под одной рекомендательной блокировкой (SHARED_LOCK): две правки уроков
не создадут две активные версии. Испорченные параметры не роняют анализ: берутся
значения v3 по умолчанию, в лог — предупреждение.
"""

import math
import re
from collections.abc import Sequence
from datetime import datetime
from typing import Any

import structlog
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.prompts import (
    ANALYSIS_PROMPT,
    LESSON_LINE,
    LESSON_LINE_TEXT,
    LESSON_SHIFT,
    LESSONS_BLOCK,
    LESSONS_JOINER,
    SystemPrompt,
    base_version_id,
    compose_version_id,
    lessons_block_id,
    load_prompt,
    load_prompt_id,
    parse_version_id,
)
from app.core.errors import AppError
from app.core.i18n import t
from app.db.models import EvalComparison, EvalRun, EvalSet, Lesson, StrategyVersion, User
from app.ml.lesson_scope import Scope, ScopeError, describe, validate_scope
from app.ml.strategy import ADAPT_KEYS, StrategyParams
from app.schemas.learning import InstructionsCandidateIn, RulesCandidateIn
from app.schemas.strategy import (
    DrawdownOut,
    GrowthOut,
    StakeBandOut,
    StrategyOut,
    StrategyParamsOut,
    ValueAdjustOut,
    WeekOut,
)
from app.services.audit import write_audit
from app.services.sessions import utcnow

log = structlog.get_logger(__name__)

V3_CODE = "v3"
V3_NAME = "v3"
RULES_PREFIX = "r"
# Рекомендательная блокировка изменений общей линии инструкций
SHARED_LOCK = 0x737472617465677
# Версии линии: candidate → active → archived; rejected — отклоненный кандидат
ACTIVE = "active"
CANDIDATE = "candidate"
ARCHIVED = "archived"
REJECTED = "rejected"
NAME_MAX = 100
_CODE_NUMBER = re.compile(r"^[vr](\d+)$")


def current_prompt_version() -> str:
    """Версия промпта анализа, с которой создается новая версия стратегии."""
    return load_prompt(*ANALYSIS_PROMPT).version_id


# --- свои версии участника (правила суммы ставки) ---


async def active_version(db: AsyncSession, user_id: int) -> StrategyVersion | None:
    found: StrategyVersion | None = await db.scalar(
        select(StrategyVersion).where(
            StrategyVersion.user_id == user_id, StrategyVersion.status == ACTIVE
        )
    )
    return found


async def _free_code(db: AsyncSession, user_id: int) -> str:
    taken = set(
        await db.scalars(select(StrategyVersion.code).where(StrategyVersion.user_id == user_id))
    )
    if V3_CODE not in taken:
        return V3_CODE
    number = 2
    while f"{V3_CODE}-{number}" in taken:
        number += 1
    return f"{V3_CODE}-{number}"


async def ensure_active(db: AsyncSession, user_id: int) -> StrategyVersion:
    """Активная версия участника; нет — создается v3 с параметрами по умолчанию. flush;
    commit — за вызывающим. Параллельное создание (UNIQUE активной) — берется чужая."""
    found = await active_version(db, user_id)
    if found is not None:
        return found
    version = StrategyVersion(
        user_id=user_id,
        code=await _free_code(db, user_id),
        name=V3_NAME,
        params=StrategyParams().to_params(),
        prompt_version=current_prompt_version(),
        status=ACTIVE,
        approved_at=func.now(),
        goal="rules",
    )
    try:
        async with db.begin_nested():
            db.add(version)
            await db.flush()
    except IntegrityError:
        again = await active_version(db, user_id)
        if again is None:
            raise
        return again
    return version


def params_of(version: StrategyVersion | None) -> StrategyParams:
    """Параметры версии; нет версии или параметры испорчены — v3 по умолчанию."""
    if version is None or version.user_id is None:
        return StrategyParams()
    try:
        return StrategyParams.from_params(version.params or {})
    except ValueError:
        log.warning("strategy.bad_params", version_id=version.id)
        return StrategyParams()


def prompt_version_of(version: StrategyVersion | None) -> str:
    """Версия промпта анализа (без блока уроков): из версии стратегии, иначе текущая."""
    if version is None or not version.prompt_version:
        return current_prompt_version()
    try:
        return load_prompt_id(base_version_id(version.prompt_version)).version_id
    except (ValueError, OSError):
        log.warning("strategy.bad_prompt_version", version_id=version.id)
        return current_prompt_version()


def strategy_out(version: StrategyVersion | None) -> StrategyOut:
    """Активная версия для экрана; нет версии — значения v3 по умолчанию."""
    return StrategyOut(
        id=version.id if version is not None else None,
        code=version.code if version is not None else V3_CODE,
        name=version.name if version is not None else V3_NAME,
        prompt_version=version.prompt_version if version is not None else None,
        created_at=version.created_at if version is not None else None,
        params=params_out(params_of(version)),
    )


def params_out(strategy: StrategyParams) -> StrategyParamsOut:
    params = strategy.to_params()
    return StrategyParamsOut(
        **{
            **params,
            "stake_bands": [
                StakeBandOut(low=low, high=high, pct=pct)
                for low, high, pct in params["stake_bands"]
            ],
            "single_bands": [
                StakeBandOut(low=low, high=high, pct=pct)
                for low, high, pct in params["single_bands"]
            ],
            "value_adjust": [
                ValueAdjustOut(min_value=min_value, add=add)
                for min_value, add in params["value_adjust"]
            ],
            "drawdown": [
                DrawdownOut(
                    start=level["from"],
                    max_pct=level["max_pct"],
                    max_legs=level.get("max_legs"),
                    max_leg_odds=level.get("max_leg_odds"),
                )
                for level in params["drawdown"]
            ],
            "growth": GrowthOut(**params["growth"]),
            "week": WeekOut(**params["week"]),
        }
    )


# --- блок уроков в system анализа ---


def _shift_text(value: float) -> str:
    return f"{value * 100:+.1f}".replace(".", ",").replace("-", "−")


def lesson_line(lesson: Lesson) -> str:
    """Строка урока для system анализа всех участников. Числовой урок — только то, что
    собрал код (m7 волны 3): код, условие из словаря (lesson_scope.describe), направление
    и поправка по архиву с усадкой (Т20: в анализ — текстом, поправку числом в коде делаем
    после 300 событий). Текст урока, написанный участником или разбором, — заметка для
    людей на экране «Уроки», в инструкции он не попадает. Процессный урок (его пишет только
    администратор, проверки на архиве у него нет) — код и текст."""
    if lesson.kind == "process":
        return load_prompt(*LESSON_LINE_TEXT).format(code=lesson.code, text=lesson.text).strip()
    scope = _scope_of(lesson)
    if scope is None:
        # Условие не из словаря (испорчено): только код и поправка, без текста
        line = load_prompt(*LESSON_LINE_TEXT).format(code=lesson.code, text="—").strip()
    else:
        line = (
            load_prompt(*LESSON_LINE)
            .format(code=lesson.code, condition=describe(scope), direction=scope.direction)
            .strip()
        )
    if lesson.effect_shrunk is not None:
        shift = load_prompt(*LESSON_SHIFT).format(shift=_shift_text(lesson.effect_shrunk))
        line = f"{line} {shift.strip()}"
    return line


def _scope_of(lesson: Lesson) -> Scope | None:
    if not lesson.scope:
        return None
    try:
        return validate_scope(lesson.scope or {})
    except ScopeError:
        return None


def lessons_block(lessons: Sequence[Lesson]) -> str:
    """Блок уроков для system анализа (prompts/lessons_block.v3.md)."""
    lines = "\n".join(lesson_line(lesson) for lesson in lessons)
    return load_prompt(*LESSONS_BLOCK).format(lessons=lines).strip()


def system_prompt_of(version: StrategyVersion | None) -> SystemPrompt:
    """System анализа версии общей линии: промпт и снимок блока уроков. Нет версии —
    текущий промпт без уроков."""
    if version is None:
        return SystemPrompt(load_prompt(*ANALYSIS_PROMPT))
    base = load_prompt_id(prompt_version_of(version))
    block = (version.params or {}).get("lessons_block") if version.user_id is None else None
    # Версия блока — из сохраненной prompt_version, а не из LESSONS_BLOCK: после выкладки
    # новой версии блока ключ активной версии тот же, анализы находят ее уроки (H1 волны 3)
    return SystemPrompt(
        base,
        block if isinstance(block, str) and block else None,
        tuple(version.lessons or ()),
        block_id=lessons_block_id(version.prompt_version),
    )


async def shared_active(db: AsyncSession) -> StrategyVersion | None:
    """Активная версия общей линии инструкций (нет — None: еще не было анализов)."""
    found: StrategyVersion | None = await db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.user_id.is_(None), StrategyVersion.status == ACTIVE)
        .execution_options(populate_existing=True)
    )
    return found


async def instructions_prompt(db: AsyncSession) -> SystemPrompt:
    """System анализа по активной версии общей линии (только чтение)."""
    return system_prompt_of(await shared_active(db))


async def resolve_prompt(db: AsyncSession, version_id: str | None) -> SystemPrompt:
    """System по сохраненной составной версии (analyses.prompt_version): без уроков —
    файл промпта; с уроками — версия общей линии с этим prompt_version. Не нашлась (ее
    удалили) — промпт без уроков, в лог — предупреждение."""
    if not version_id:
        return await instructions_prompt(db)
    if LESSONS_JOINER not in version_id:
        try:
            return SystemPrompt(load_prompt_id(version_id))
        except (ValueError, OSError):
            log.warning("strategy.bad_prompt_version", prompt_version=version_id)
            return await instructions_prompt(db)
    found = await db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.user_id.is_(None), StrategyVersion.prompt_version == version_id)
        .order_by(StrategyVersion.id.desc())
        .limit(1)
    )
    if found is None:
        log.warning("strategy.lessons_block_missing", prompt_version=version_id)
        return SystemPrompt(load_prompt_id(base_version_id(version_id)))
    return system_prompt_of(found)


async def lessons_of_prompt(db: AsyncSession, version_id: str | None) -> list[str]:
    """Коды уроков в system этой составной версии (predictions.lessons_applied)."""
    if not version_id or LESSONS_JOINER not in version_id:
        return []
    found = await db.scalar(
        select(StrategyVersion.lessons)
        .where(StrategyVersion.user_id.is_(None), StrategyVersion.prompt_version == version_id)
        .order_by(StrategyVersion.id.desc())
        .limit(1)
    )
    return list(found or [])


# --- общая линия инструкций ---


async def lock_shared(db: AsyncSession) -> None:
    """Изменения общей линии — по одному (до commit вызывающего)."""
    await db.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": SHARED_LOCK})


async def prompt_lessons(db: AsyncSession) -> list[Lesson]:
    """Общие уроки, которые сейчас в инструкциях анализа (in_prompt), по коду."""
    return list(
        await db.scalars(
            select(Lesson)
            .where(Lesson.user_id.is_(None), Lesson.in_prompt.is_(True))
            .order_by(Lesson.code)
        )
    )


def _number(code: str) -> int:
    found = _CODE_NUMBER.match(code)
    return int(found.group(1)) if found else 0


async def _next_shared_code(db: AsyncSession) -> str:
    codes = list(
        await db.scalars(select(StrategyVersion.code).where(StrategyVersion.user_id.is_(None)))
    )
    return f"v{max([3 - 1, *(_number(code) for code in codes)]) + 1}"


def _name(code: str, summary: str) -> str:
    return f"{code} · {summary}"[:NAME_MAX] if summary else code


def _block_params(lessons: Sequence[Lesson]) -> tuple[dict[str, Any], str | None]:
    block = lessons_block(lessons) if lessons else None
    return ({"lessons_block": block} if block else {}), block


async def ensure_shared_active(db: AsyncSession) -> StrategyVersion:
    """Активная версия общей линии; нет — создается v3: текущий промпт анализа и уроки,
    которые уже в анализе. flush; commit — за вызывающим."""
    found = await shared_active(db)
    if found is not None:
        return found
    await lock_shared(db)
    found = await shared_active(db)
    if found is not None:
        return found
    lessons = await prompt_lessons(db)
    params, block = _block_params(lessons)
    version = StrategyVersion(
        user_id=None,
        code=V3_CODE,
        name=V3_NAME,
        params=params,
        prompt_version=compose_version_id(current_prompt_version(), block),
        lessons=[lesson.code for lesson in lessons],
        status=ACTIVE,
        approved_at=utcnow(),
        goal="quality",
        changes=[t("learning.changes.initial")],
    )
    db.add(version)
    await db.flush()
    return version


async def ensure_shared_ready(db: AsyncSession) -> StrategyVersion:
    """Активная версия общей линии для экранов (GET /learning, /dashboard,
    /strategy/versions): есть — она; нет (еще не было анализов) — v3 создается сейчас
    (под lock_shared, повторный вызов вернет ту же) и сохраняется (commit). Так на экране
    действующие инструкции видны с первого дня, а не «—»."""
    found = await shared_active(db)
    if found is not None:
        return found
    version = await ensure_shared_active(db)
    await db.commit()
    return version


async def _archive(db: AsyncSession, version: StrategyVersion, status: str = ARCHIVED) -> None:
    """Активную версию — в архив (или в кандидаты при откате) до вставки новой активной:
    частичный UNIQUE активной проверяется сразу."""
    version.status = status
    version.archived_at = utcnow() if status == ARCHIVED else None
    await db.flush()


async def sync_lessons(
    db: AsyncSession, *, actor_id: int | None, change: str
) -> StrategyVersion | None:
    """Уроки в анализе поменялись (включен, выключен или списан урок): новая активная
    версия общей линии с этим набором уроков (решение администратора или правило
    перепроверки), прежняя — в архив. Набор тот же — None. Вызывающий держит lock_shared
    или берет ее здесь. flush; commit — за вызывающим."""
    await lock_shared(db)
    active = await ensure_shared_active(db)
    lessons = await prompt_lessons(db)
    codes = [lesson.code for lesson in lessons]
    if codes == list(active.lessons or []):
        return None
    params, block = _block_params(lessons)
    moment = utcnow()
    code = await _next_shared_code(db)
    version = StrategyVersion(
        user_id=None,
        code=code,
        name=_name(code, change),
        params=params,
        prompt_version=compose_version_id(prompt_version_of(active), block),
        lessons=codes,
        status=ACTIVE,
        parent_id=active.id,
        goal="quality",
        changes=[change],
        approved_by=actor_id,
        approved_at=moment,
        decided_by=actor_id,
    )
    await _archive(db, active)
    db.add(version)
    await db.flush()
    return version


async def create_instructions_candidate(
    db: AsyncSession, admin: User, body: InstructionsCandidateIn, *, ip: str | None
) -> StrategyVersion:
    """Кандидат инструкций (администратор): промпт анализа (опубликованный analysis.vN) и
    уроки (подтвержденные или готовые общие уроки, не больше lessons_max_active). Такой же,
    как активная, — 409 strategy.same_as_active; такой кандидат уже есть — 409
    strategy.candidate_exists. Кандидат не включается сам: сначала прогон на наборе. commit."""
    from app.agent.config import load_agent_config

    config = await load_agent_config(db)
    await lock_shared(db)
    active = await ensure_shared_active(db)
    base = prompt_version_of(active)
    if body.prompt_version is not None:
        try:
            name, _ = parse_version_id(body.prompt_version)
            base = load_prompt_id(body.prompt_version).version_id
        except (ValueError, OSError):
            raise AppError(422, "strategy.prompt_unknown", version=body.prompt_version) from None
        if name != ANALYSIS_PROMPT[0]:
            raise AppError(422, "strategy.prompt_unknown", version=body.prompt_version)
    codes = (
        list(active.lessons or []) if body.lessons is None else list(dict.fromkeys(body.lessons))
    )
    lessons: list[Lesson] = []
    if codes:
        found = {
            lesson.code: lesson
            for lesson in await db.scalars(
                select(Lesson).where(Lesson.user_id.is_(None), Lesson.code.in_(codes))
            )
        }
        missing = [code for code in codes if code not in found]
        if missing:
            raise AppError(422, "strategy.lesson_unknown", lesson=missing[0])
        bad = [code for code in codes if found[code].status not in ("ready", "confirmed")]
        if bad:
            raise AppError(422, "strategy.lesson_not_checked", lesson=bad[0])
        if len(codes) > config.lessons_max_active:
            raise AppError(
                409,
                "lesson.max_active",
                max=config.lessons_max_active,
                count=config.lessons_max_active,
            )
        lessons = sorted((found[code] for code in codes), key=lambda lesson: lesson.code)
    params, block = _block_params(lessons)
    prompt_id = compose_version_id(base, block)
    if prompt_id == active.prompt_version:
        raise AppError(409, "strategy.same_as_active")
    same = await db.scalar(
        select(StrategyVersion.code).where(
            StrategyVersion.user_id.is_(None),
            StrategyVersion.status == CANDIDATE,
            StrategyVersion.prompt_version == prompt_id,
        )
    )
    if same is not None:
        raise AppError(409, "strategy.candidate_exists", version=same)
    changes: list[str] = []
    if base != prompt_version_of(active):
        changes.append(t("learning.changes.prompt", version=base))
    added = sorted(set(codes) - set(active.lessons or []))
    removed = sorted(set(active.lessons or []) - set(codes))
    if added:
        changes.append(t("learning.changes.lessons_added", codes=", ".join(added)))
    if removed:
        changes.append(t("learning.changes.lessons_removed", codes=", ".join(removed)))
    if body.note:
        changes.append(body.note)
    code = await _next_shared_code(db)
    version = StrategyVersion(
        user_id=None,
        code=code,
        name=_name(code, changes[0] if changes else ""),
        params=params,
        prompt_version=prompt_id,
        lessons=[lesson.code for lesson in lessons],
        status=CANDIDATE,
        parent_id=active.id,
        goal=body.goal,
        changes=changes,
    )
    db.add(version)
    await db.flush()
    await write_audit(
        db,
        action="version_on",
        actor_id=admin.id,
        details={"code": code, "step": "candidate", "prompt_version": prompt_id},
        ip=ip,
    )
    await db.commit()
    return version


def _answered(run: EvalRun, share: float) -> bool:
    """В прогоне оценено не меньше доли share событий набора."""
    summary = (run.metrics or {}).get("summary") or {}
    total = int(summary.get("total") or run.n_events or 0)
    return total > 0 and int(summary.get("n") or 0) >= math.ceil(share * total - 1e-9)


async def eval_ready(db: AsyncSession, version: StrategyVersion) -> str | None:
    """Можно ли включить кандидата инструкций по прогону на последнем наборе (m2 волны 3):
    None — да; иначе код причины. strategy.eval_needed — законченного прогона нет или нет
    сравнения с нынешней активной версией (ее тоже надо прогнать); strategy.eval_few_answers
    — в последнем прогоне оценено меньше eval_min_answered событий набора;
    strategy.eval_format — ошибок формата, остановок по max_tokens или отказов больше, чем
    у активной (TOKEN_ECONOMY.md, 2.4 п. 4)."""
    from app.agent.config import load_agent_config

    latest = await db.scalar(
        select(EvalSet.id)
        .where(EvalSet.frozen_at.is_not(None))
        .order_by(EvalSet.frozen_at.desc(), EvalSet.id.desc())
        .limit(1)
    )
    if latest is None:
        return "strategy.eval_needed"
    run = await db.scalar(
        select(EvalRun)
        .where(
            EvalRun.strategy_version_id == version.id,
            EvalRun.eval_set_id == latest,
            EvalRun.status == "done",
            EvalRun.metrics["kind"].astext == "eval",
        )
        .order_by(EvalRun.id.desc())
        .limit(1)
    )
    if run is None:
        return "strategy.eval_needed"
    config = await load_agent_config(db)
    if not _answered(run, config.eval_min_answered):
        return "strategy.eval_few_answers"
    active = await shared_active(db)
    baseline = (
        await db.scalar(
            select(EvalRun.id)
            .where(
                EvalRun.strategy_version_id == active.id,
                EvalRun.eval_set_id == latest,
                EvalRun.status == "done",
                EvalRun.metrics["kind"].astext == "eval",
            )
            .order_by(EvalRun.id.desc())
            .limit(1)
        )
        if active is not None and active.id != version.id
        else None
    )
    if baseline is None:
        return "strategy.eval_needed"
    comparison = await db.scalar(
        select(EvalComparison.metrics)
        .where(
            EvalComparison.candidate_run_id == run.id,
            EvalComparison.baseline_run_id == baseline,
        )
        .order_by(EvalComparison.id.desc())
        .limit(1)
    )
    if comparison is None:
        return "strategy.eval_needed"
    for key in ("format_errors", "max_tokens", "refusals"):
        if (comparison.get(key) or {}).get("ok") is False:
            return "strategy.eval_format"
    return None


async def checked_on_set(db: AsyncSession, version_id: int) -> bool:
    """У версии есть законченный прогон на последнем наборе («кандидат ждет решения» на
    экранах). Можно ли включить — eval_ready."""
    latest = await db.scalar(
        select(EvalSet.id)
        .where(EvalSet.frozen_at.is_not(None))
        .order_by(EvalSet.frozen_at.desc(), EvalSet.id.desc())
        .limit(1)
    )
    if latest is None:
        return False
    found = await db.scalar(
        select(EvalRun.id)
        .where(
            EvalRun.strategy_version_id == version_id,
            EvalRun.eval_set_id == latest,
            EvalRun.status == "done",
            EvalRun.metrics["kind"].astext == "eval",
        )
        .limit(1)
    )
    return found is not None


async def lessons_allowed(db: AsyncSession, codes: Sequence[str]) -> None:
    """Уроки версии, которую включают или возвращают (M3 волны 3): каждый сейчас ready
    или confirmed (отклоненный или списанный перепроверкой урок в анализ не вернется,
    вердикт перепроверки не стирается) и их не больше lessons_max_active. Иначе 409
    strategy.lesson_closed с кодом урока или lesson.max_active."""
    from app.agent.config import load_agent_config

    if not codes:
        return
    found = dict(
        (
            await db.execute(
                select(Lesson.code, Lesson.status).where(
                    Lesson.user_id.is_(None), Lesson.code.in_(list(codes))
                )
            )
        ).all()
    )
    for code in codes:
        if found.get(code) not in ("ready", "confirmed"):
            raise AppError(409, "strategy.lesson_closed", lesson=code)
    config = await load_agent_config(db)
    if len(codes) > config.lessons_max_active:
        raise AppError(
            409,
            "lesson.max_active",
            max=config.lessons_max_active,
            count=config.lessons_max_active,
        )


async def _apply_lesson_flags(db: AsyncSession, codes: Sequence[str], actor_id: int) -> None:
    """Уроки активной версии — в анализе (in_prompt; готовый урок становится
    подтвержденным), остальные — нет. Статус отклоненного или списанного урока не
    переписывается: такие версии не включаются (lessons_allowed)."""
    moment = utcnow()
    for lesson in await db.scalars(select(Lesson).where(Lesson.user_id.is_(None))):
        inside = lesson.code in codes
        if inside and not lesson.in_prompt:
            lesson.in_prompt = True
            if lesson.status == "ready":
                lesson.status = "confirmed"
            lesson.decided_by, lesson.decided_at = actor_id, moment
        elif not inside and lesson.in_prompt:
            lesson.in_prompt = False
            lesson.decided_by, lesson.decided_at = actor_id, moment


async def _shared_version(db: AsyncSession, version_id: int) -> StrategyVersion:
    found: StrategyVersion | None = await db.scalar(
        select(StrategyVersion)
        .where(StrategyVersion.id == version_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if found is None:
        raise AppError(404, "strategy.not_found")
    return found


async def owned_version(
    db: AsyncSession, user: User, version_id: int, *, lock: bool = False
) -> StrategyVersion:
    """Своя версия правил или версия общей линии; чужая — 404."""
    query = (
        select(StrategyVersion)
        .where(StrategyVersion.id == version_id)
        .execution_options(populate_existing=True)
    )
    if lock:
        query = query.with_for_update()
    found: StrategyVersion | None = await db.scalar(query)
    if found is None or (found.user_id is not None and found.user_id != user.id):
        raise AppError(404, "strategy.not_found")
    return found


async def activate(
    db: AsyncSession, user: User, version_id: int, *, ip: str | None
) -> StrategyVersion:
    """«Включить»: кандидат становится активным, прежняя активная — в архив. Общая линия —
    только администратор (403) и только после прогона на замороженном наборе (409
    strategy.eval_needed); свои правила — владелец. Не кандидат — 409 strategy.not_candidate.
    Журнал version_on (общая линия). commit."""
    version = await owned_version(db, user, version_id)
    shared = version.user_id is None
    if shared and user.role != "admin":
        raise AppError(403, "common.forbidden")
    if shared:
        await lock_shared(db)
    version = await owned_version(db, user, version_id, lock=True)
    if version.status != CANDIDATE:
        raise AppError(409, "strategy.not_candidate")
    if shared:
        reason = await eval_ready(db, version)
        if reason is not None:
            raise AppError(409, reason)
        await lessons_allowed(db, version.lessons or [])
    current = await shared_active(db) if shared else await active_version(db, user.id)
    moment = utcnow()
    if current is not None:
        await _archive(db, current)
        if shared:
            await _close_runs(db, current.id, user.id)
    version.status = ACTIVE
    version.archived_at = None
    version.approved_by = user.id
    version.approved_at = moment
    version.decided_by = user.id
    await db.flush()
    if shared:
        await _apply_lesson_flags(db, version.lessons or [], user.id)
        await write_audit(
            db,
            action="version_on",
            actor_id=user.id,
            details={
                "code": version.code,
                "step": "activate",
                "previous": current.code if current is not None else None,
            },
            ip=ip,
        )
    await db.commit()
    return version


def was_active(version: StrategyVersion) -> bool:
    """Версию можно вернуть: она в архиве и уже действовала. Исходные правила участника
    действовали и без approved_at (строки, созданные до того, как его стали писать), если
    ушли в архив; история старого бота (legacy, без цели) — не правила, ее не вернуть."""
    if version.status != ARCHIVED:
        return False
    if version.approved_at is not None:
        return True
    return (
        version.user_id is not None and version.goal == "rules" and version.archived_at is not None
    )


async def rollback(
    db: AsyncSession, user: User, version_id: int, *, ip: str | None
) -> StrategyVersion:
    """«Вернуть»: версия в архиве, которая уже была активной, снова активна. Нынешняя
    активная общей линии возвращается в кандидаты (ее можно включить снова), свои
    правила — в архив. Общая линия — только администратор. Журнал version_on. commit."""
    version = await owned_version(db, user, version_id)
    shared = version.user_id is None
    if shared and user.role != "admin":
        raise AppError(403, "common.forbidden")
    if shared:
        await lock_shared(db)
    version = await owned_version(db, user, version_id, lock=True)
    if not was_active(version):
        raise AppError(409, "strategy.cannot_rollback")
    if shared:
        await lessons_allowed(db, version.lessons or [])
    current = await shared_active(db) if shared else await active_version(db, user.id)
    if current is not None:
        await _archive(db, current, CANDIDATE if shared else ARCHIVED)
    version.status = ACTIVE
    version.archived_at = None
    version.decided_by = user.id
    await db.flush()
    if shared:
        await _apply_lesson_flags(db, version.lessons or [], user.id)
        await write_audit(
            db,
            action="version_on",
            actor_id=user.id,
            details={
                "code": version.code,
                "step": "rollback",
                "previous": current.code if current is not None else None,
            },
            ip=ip,
        )
    await db.commit()
    return version


async def reject(db: AsyncSession, user: User, version_id: int) -> StrategyVersion:
    """«Отклонить» кандидата: rejected. Общая линия — администратор. commit."""
    version = await owned_version(db, user, version_id)
    if version.user_id is None and user.role != "admin":
        raise AppError(403, "common.forbidden")
    if version.user_id is None:
        await lock_shared(db)
    version = await owned_version(db, user, version_id, lock=True)
    if version.status != CANDIDATE:
        raise AppError(409, "strategy.not_candidate")
    version.status = REJECTED
    version.decided_by = user.id
    if version.user_id is None:
        # Прогон отклоненного кандидата больше не тратит бюджет проверок (M2 волны 3)
        await _close_runs(db, version.id, user.id)
    await db.commit()
    return version


async def _close_runs(db: AsyncSession, version_id: int, actor_id: int | None) -> None:
    from app.services.eval_runs import close_version_runs

    await close_version_runs(db, version_id, actor_id=actor_id)


# --- свои правила суммы ставки ---


async def _next_rules_code(db: AsyncSession, user_id: int) -> str:
    codes = list(
        await db.scalars(select(StrategyVersion.code).where(StrategyVersion.user_id == user_id))
    )
    number = len(codes) + 1
    while f"{RULES_PREFIX}{number}" in codes:
        number += 1
    return f"{RULES_PREFIX}{number}"


def _pct_text(value: float) -> str:
    return f"{value * 100:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def rules_params(
    current: StrategyParams, body: RulesCandidateIn
) -> tuple[StrategyParams, list[str]]:
    """Параметры кандидата и что изменилось (тексты для экрана). Ничего не изменилось —
    422 strategy.no_changes; неверное значение — 422 strategy.bad_params."""
    raw = current.to_params()
    changes: list[str] = []
    adapt = dict(raw["adapt"])
    for key in ADAPT_KEYS:
        if key in body.adapt and body.adapt[key] != current.adapt_on(key):
            adapt[key] = body.adapt[key]
            text_key = "adapt_on" if body.adapt[key] else "adapt_off"
            changes.append(t(f"learning.changes.{text_key}", rule=t(f"learning.adapt.{key}")))
    raw["adapt"] = adapt
    bands = [list(band) for band in raw["stake_bands"]]
    for item in body.stake_bands:
        if item.index >= len(bands):
            raise AppError(422, "strategy.bad_params", key="stake_bands")
        old = float(bands[item.index][2])
        new = round(item.pct, 5)
        if abs(old - new) > 1e-9:
            bands[item.index][2] = str(new)
            changes.append(
                t(
                    "learning.changes.band",
                    low=bands[item.index][0],
                    high=bands[item.index][1],
                    old=_pct_text(old),
                    new=_pct_text(new),
                )
            )
    raw["stake_bands"] = bands
    if not changes:
        raise AppError(422, "strategy.no_changes")
    try:
        params = StrategyParams.from_params(raw)
    except ValueError:
        raise AppError(422, "strategy.bad_params", key="params") from None
    if body.note:
        changes.append(body.note)
    return params, changes


async def create_rules_candidate(
    db: AsyncSession, user: User, body: RulesCandidateIn
) -> StrategyVersion:
    """Кандидат своих правил суммы: прежний кандидат участника отклоняется (кандидат один),
    проверка на своих ставках (app/services/rule_check.py) — в metrics.check. commit."""
    from app.services.rule_check import check_rules

    # Кандидат у участника один (m5 волны 3): параллельные запросы — по одному, под
    # блокировкой строки участника (как lessons.propose)
    await db.execute(select(User.id).where(User.id == user.id).with_for_update())
    active = await ensure_active(db, user.id)
    current = params_of(active)
    params, changes = rules_params(current, body)
    check = await check_rules(db, user.id, current, params)
    moment: datetime = utcnow()
    for old in await db.scalars(
        select(StrategyVersion)
        .where(StrategyVersion.user_id == user.id, StrategyVersion.status == CANDIDATE)
        .with_for_update()
    ):
        old.status = REJECTED
        old.decided_by = user.id
    code = await _next_rules_code(db, user.id)
    version = StrategyVersion(
        user_id=user.id,
        code=code,
        name=_name(code, changes[0]),
        params=params.to_params(),
        prompt_version=active.prompt_version,
        status=CANDIDATE,
        parent_id=active.id,
        goal="rules",
        changes=changes,
        metrics={"check": check, "checked_at": moment.isoformat()},
    )
    db.add(version)
    await db.commit()
    return version
