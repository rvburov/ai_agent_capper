"""Кабинет администратора, «Ключ и бюджет»: /api/admin/ai/* и решение о режиме ключа
участника /api/admin/users/{user_id}/ai-mode (Р8, Р9, Р12, Р13).

Доступ только у роли admin (require_admin на роутере). Смена ключа администратора —
опасное действие: в теле totp_code, текущий код 2FA (PLAN.md, раздел 7). Ключ наружу
не отдается: только последние 4 символа. Р14: об участниках — только расход на ИИ и
активность.
"""

from typing import Annotated

from fastapi import APIRouter, Depends, Path

from app.api.routes.admin import Confirm
from app.core.deps import AdminUser, ClientIp, DbSession, require_admin
from app.schemas.ai import (
    AdminBudgetOut,
    AdminKeyIn,
    AdminKeyOut,
    AdminLimitsOut,
    BudgetIn,
    LimitDefaultsOut,
    LimitIn,
    LimitPatchIn,
    MemberLimitOut,
    ModeDecisionIn,
)
from app.services import ai_budget

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])

# Номер строки в БД: BIGINT, больше не бывает
RowId = Annotated[int, Path(ge=1, le=2**63 - 1)]


@router.get("/ai/key")
async def get_admin_key(db: DbSession) -> AdminKeyOut:
    """Последние 4 символа ключа, когда проверен, состояние и сколько людей на ключе."""
    return await ai_budget.admin_key_info(db)


@router.put("/ai/key")
async def replace_admin_key(
    db: DbSession, admin: AdminUser, ip: ClientIp, confirm: Confirm, body: AdminKeyIn
) -> AdminKeyOut:
    """Замена ключа: код 2FA, затем проверка ключа и доступа к моделям, сохранение и
    журнал key_change. Без totp_code — 422; неверный код — 403 admin.totp_invalid
    (Anthropic не спрашиваем). Ключ не прошел — 400 ai.key_format / ai.key_rejected /
    ai.key_models, 502 ai.key_check_failed, 503 ai.key_unavailable: принятый код при этом
    уже потрачен, для новой попытки нужен следующий."""
    return await ai_budget.replace_admin_key(
        db, body.key, actor=admin, confirm=confirm.with_code(body.totp_code), ip=ip
    )


@router.get("/ai/budget")
async def get_budget(db: DbSession) -> AdminBudgetOut:
    """Бюджет месяца (UTC), потрачено, резервы, прогноз, сумма личных лимитов, порог
    уведомления; отдельно — бюджет проверочных прогонов."""
    return await ai_budget.admin_budget(db)


@router.put("/ai/budget")
async def update_budget(
    db: DbSession, admin: AdminUser, ip: ClientIp, body: BudgetIn
) -> AdminBudgetOut:
    """Бюджет на месяц ($1–5000) и порог уведомления (50, 70, 80 или 90%); журнал
    budget_change. Бюджет меньше потраченного за месяц — 400 ai.budget_below_spent."""
    return await ai_budget.update_budget(
        db,
        monthly_usd=body.monthly_usd,
        alert_pct=body.alert_pct,
        eval_budget_usd=body.eval_budget_usd,
        actor=admin,
        ip=ip,
    )


@router.get("/ai/limits")
async def get_limits(db: DbSession) -> AdminLimitsOut:
    """Лимиты по умолчанию и по каждому участнику: режим, лимит, пауза, расход за месяц,
    анализы сегодня и за месяц, просьба вернуть ключ администратора."""
    return await ai_budget.limits_view(db)


@router.put("/ai/limits/{user_id}")
async def update_limit(
    db: DbSession, admin: AdminUser, ip: ClientIp, user_id: RowId, body: LimitPatchIn
) -> MemberLimitOut:
    """Лимит участника на ключе администратора и пауза; журнал limit_change. В месяц
    $1–500, анализов в день 1–30, на анализ от $0,10 до месячного лимита (иначе 422 или
    400 ai.cap_above_month). У администратора личного лимита нет — 409 ai.admin_no_limit."""
    return await ai_budget.update_member_limit(db, user_id, body, actor=admin, ip=ip)


@router.put("/ai/defaults")
async def update_defaults(
    db: DbSession, admin: AdminUser, ip: ClientIp, body: LimitIn
) -> LimitDefaultsOut:
    """Лимиты по умолчанию для новых участников; у зарегистрированных не меняются, потолок
    анализов администратора и мягкий потолок — тоже. Границы — как у лимита участника."""
    return await ai_budget.update_defaults(db, body, actor=admin, ip=ip)


@router.post("/users/{user_id}/ai-mode")
async def decide_ai_mode(
    db: DbSession, admin: AdminUser, ip: ClientIp, user_id: RowId, body: ModeDecisionIn
) -> MemberLimitOut:
    """Решение по просьбе вернуть ключ администратора (Р12): approve — участник снова на
    ключе администратора (с limit — с этим лимитом), reject — остается на своем.
    При одобрении свой ключ участника удаляется с сервера. Уведомление участнику, журнал
    ai_mode_change. Просьбы нет — 409 ai.no_return_request; администратор — 409
    ai.return_not_needed."""
    return await ai_budget.decide_mode(
        db,
        user_id,
        approve=body.decision == "approve",
        limit=body.limit,
        actor=admin,
        ip=ip,
    )
