"""Версии стратегии для экранов (этап 5, волна 3): «Обучение модели → Версии стратегии» и
«Кабинет → Банк и стратегия». Общая линия инструкций видна всем, свои правила суммы —
только владельцу (чужая версия — 404). Метрики версии на замороженном наборе и сравнение
кандидата с активной считает app/services/eval_runs.py; проверку правил на своих ставках —
app/services/rule_check.py (при создании кандидата)."""

from collections.abc import Mapping
from typing import Any

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import AppError
from app.core.redis import redis_key
from app.db.models import StrategyVersion, User
from app.schemas.learning import (
    ParamDiffOut,
    RulesCheckOut,
    StrategyVersionOut,
    StrategyVersionsOut,
    VersionCompareOut,
)
from app.services import eval_runs, eval_sets
from app.services.strategy_versions import (
    CANDIDATE,
    active_version,
    ensure_shared_ready,
    eval_ready,
    lessons_allowed,
    owned_version,
    params_of,
    params_out,
    prompt_version_of,
    shared_active,
    was_active,
)

# Сравнений версий у участника — не больше COMPARE_LIMIT в минуту
COMPARE_LIMIT = 20
COMPARE_WINDOW_SECONDS = 60


def _line(version: StrategyVersion) -> str:
    return "instructions" if version.user_id is None else "rules"


async def version_out(
    db: AsyncSession,
    user: User,
    version: StrategyVersion,
    *,
    codes: Mapping[int, str],
    active: StrategyVersion | None,
) -> StrategyVersionOut:
    shared = version.user_id is None
    allowed = user.role == "admin" if shared else version.user_id == user.id
    evaluated = await eval_runs.version_eval(db, version) if shared else None
    comparison = None
    if shared and version.status == CANDIDATE and active is not None:
        comparison = await eval_runs.compare_versions(db, version, active)
    reason: str | None = None
    if version.status != CANDIDATE:
        reason = "strategy.not_candidate"
    elif not allowed:
        reason = "common.forbidden"
    elif shared:
        reason = await eval_ready(db, version)
        if reason is None:
            try:
                await lessons_allowed(db, version.lessons or [])
            except AppError as exc:
                reason = exc.code
    check = (version.metrics or {}).get("check") if not shared else None
    return StrategyVersionOut(
        id=version.id,
        line=_line(version),  # type: ignore[arg-type]
        code=version.code,
        name=version.name or version.code,
        status=version.status,  # type: ignore[arg-type]
        goal=version.goal,  # type: ignore[arg-type]
        parent_id=version.parent_id,
        parent_code=codes.get(version.parent_id) if version.parent_id is not None else None,
        changes=list(version.changes or []),
        created_at=version.created_at,
        activated_at=version.approved_at,
        archived_at=version.archived_at,
        prompt_version=version.prompt_version if shared else None,
        base_prompt=prompt_version_of(version) if shared else None,
        lessons=list(version.lessons or []) if shared else [],
        params=None if shared else params_out(params_of(version)),
        eval=evaluated,
        comparison=comparison,
        check=_check_out(check, version) if isinstance(check, dict) else None,
        can_activate=reason is None,
        activate_reason=reason,
        can_rollback=allowed and was_active(version),
    )


def _check_out(check: dict[str, Any], version: StrategyVersion) -> RulesCheckOut:
    """Проверка кандидата на своих ставках; у снимков до волны 4 since не было — день
    создания кандидата."""
    since = check.get("since") or version.created_at.date().isoformat()
    return RulesCheckOut(**{**check, "since": since})


async def _codes(db: AsyncSession, versions: list[StrategyVersion]) -> dict[int, str]:
    parents = {version.parent_id for version in versions if version.parent_id is not None}
    if not parents:
        return {}
    rows = await db.execute(
        select(StrategyVersion.id, StrategyVersion.code).where(StrategyVersion.id.in_(parents))
    )
    return {int(row_id): str(code) for row_id, code in rows}


async def list_versions(db: AsyncSession, user: User) -> StrategyVersionsOut:
    """Общая линия инструкций (действующая версия есть всегда: ensure_shared_ready) и
    свои правила суммы (новые сверху)."""
    await ensure_shared_ready(db)
    shared = list(
        await db.scalars(
            select(StrategyVersion)
            .where(StrategyVersion.user_id.is_(None))
            .order_by(StrategyVersion.created_at.desc(), StrategyVersion.id.desc())
        )
    )
    own = list(
        await db.scalars(
            select(StrategyVersion)
            .where(StrategyVersion.user_id == user.id)
            .order_by(StrategyVersion.created_at.desc(), StrategyVersion.id.desc())
        )
    )
    codes = await _codes(db, [*shared, *own])
    active = await shared_active(db)
    eval_set = await eval_sets.latest_set(db)
    return StrategyVersionsOut(
        instructions=[
            await version_out(db, user, version, codes=codes, active=active) for version in shared
        ],
        rules=[await version_out(db, user, version, codes=codes, active=active) for version in own],
        eval_set=eval_sets.set_out(eval_set) if eval_set is not None else None,
    )


async def version_detail(db: AsyncSession, user: User, version_id: int) -> StrategyVersionOut:
    version = await owned_version(db, user, version_id)
    codes = await _codes(db, [version])
    return await version_out(db, user, version, codes=codes, active=await shared_active(db))


def _flat(raw: Any, prefix: str = "") -> dict[str, str]:
    """Параметры одной строкой на ключ: adapt.up15, stake_bands.2 …"""
    if isinstance(raw, Mapping):
        found: dict[str, str] = {}
        for key, value in raw.items():
            found |= _flat(value, f"{prefix}.{key}" if prefix else str(key))
        return found
    if isinstance(raw, list) and raw and isinstance(raw[0], (list, Mapping)):
        found = {}
        for index, value in enumerate(raw):
            found |= _flat(value, f"{prefix}.{index}")
        return found
    if isinstance(raw, list):
        return {prefix: "–".join(str(item) for item in raw)}
    return {prefix: str(raw).lower() if isinstance(raw, bool) else str(raw)}


def _diff(a: StrategyVersion, b: StrategyVersion) -> list[ParamDiffOut]:
    if a.user_id is None:
        left = {"prompt": prompt_version_of(a), "lessons": ", ".join(a.lessons or [])}
        right = {"prompt": prompt_version_of(b), "lessons": ", ".join(b.lessons or [])}
    else:
        left = _flat(params_of(a).to_params())
        right = _flat(params_of(b).to_params())
    return [
        ParamDiffOut(key=key, a=left.get(key), b=right.get(key))
        for key in sorted(set(left) | set(right))
        if left.get(key) != right.get(key)
    ]


async def hit_compare_limit(redis: Redis, user: User) -> None:
    """Предел сравнений для участника (m6 волны 3): COMPARE_LIMIT за COMPARE_WINDOW_SECONDS,
    сверх — 429 common.rate_limited. Посчитанное сравнение пары прогонов хранится, но
    первый расчет — около 0,5 с CPU, поэтому перебор пар ограничен. Администратору без
    предела."""
    if user.role == "admin":
        return
    key = redis_key("rl", "strategy_compare", user.id)
    async with redis.pipeline(transaction=True) as pipe:
        pipe.incr(key)
        pipe.expire(key, COMPARE_WINDOW_SECONDS, nx=True)
        count = int((await pipe.execute())[0])
    if count > COMPARE_LIMIT:
        wait = max(int(await redis.ttl(key)), 1)
        raise AppError(429, "common.rate_limited", retry_after=wait)


async def compare(db: AsyncSession, user: User, a_id: int, b_id: int) -> VersionCompareOut:
    """Сравнение двух версий одной линии (a — база, b — кандидат). Разные линии — 422."""
    a = await owned_version(db, user, a_id)
    b = await owned_version(db, user, b_id)
    if (a.user_id is None) != (b.user_id is None):
        raise AppError(422, "strategy.compare_lines")
    codes = await _codes(db, [a, b])
    active = await shared_active(db) if a.user_id is None else await active_version(db, user.id)
    comparison = await eval_runs.compare_versions(db, b, a) if a.user_id is None else None
    return VersionCompareOut(
        a=await version_out(db, user, a, codes=codes, active=active),
        b=await version_out(db, user, b, codes=codes, active=active),
        diff=_diff(a, b),
        comparison=comparison,
    )
