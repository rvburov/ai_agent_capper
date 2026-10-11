"""ИИ участника: лимит и расход (/api/ai/budget), свой ключ Claude, режим ключа и свой
потолок анализа (/api/me/ai-*), решения Р7, Р9, Р12, Р13.

Каждый маршрут берет пользователя из сеанса и меняет только его данные. Ключ Claude
наружу не отдается: в ответах только последние 4 символа.
"""

from fastapi import APIRouter, Response, status

from app.core.deps import ClientIp, CurrentUser, DbSession
from app.schemas.ai import (
    AiBudgetOut,
    AiModeIn,
    OwnCapIn,
    OwnCapOut,
    OwnKeyIn,
    OwnKeyOut,
    ReturnRequestOut,
)
from app.services import ai_budget, ai_keys

router = APIRouter(tags=["ai"])


@router.get("/ai/budget")
async def budget(user: CurrentUser, db: DbSession) -> AiBudgetOut:
    """Режим ключа, лимит и расход за месяц (UTC), анализы сегодня, потолок анализа,
    свой ключ (последние 4 символа) и причина, по которой анализ сейчас не запустится.
    Администратору — еще общий бюджет ключа администратора."""
    return await ai_budget.member_budget(db, user)


@router.put("/me/ai-key")
async def save_own_key(body: OwnKeyIn, user: CurrentUser, db: DbSession) -> OwnKeyOut:
    """Свой ключ: проверяется запросами к Claude API (список моделей и доступ к моделям
    из настроек), сохраняется только проверенный, режим становится own. Не прошел —
    400 ai.key_format / ai.key_rejected / ai.key_models, 502 ai.key_check_failed,
    503 ai.key_unavailable. Администратору — 409 ai.admin_key_only."""
    return await ai_budget.save_own_key(db, user, body.key)


@router.delete("/me/ai-key")
async def delete_own_key(user: CurrentUser, db: DbSession, ip: ClientIp) -> OwnKeyOut:
    """Удаляет свой ключ с сервера. Участник остается на своем ключе: анализы не
    запустятся, пока он не сохранит новый или администратор не вернет ключ администратора."""
    return await ai_budget.delete_own_key(db, user, ip=ip)


@router.post("/me/ai-key/check")
async def check_own_key(user: CurrentUser, db: DbSession) -> OwnKeyOut:
    """Проверяет сохраненный ключ и записывает итог. Нет ключа — 404 ai.no_own_key,
    нет связи с Anthropic — 503 ai.key_unavailable."""
    return await ai_budget.check_own_key(db, user)


@router.put("/me/ai-mode")
async def set_ai_mode(body: AiModeIn, user: CurrentUser, db: DbSession, ip: ClientIp) -> OwnKeyOut:
    """Переход на свой ключ (нужен проверенный ключ, иначе 409 ai.no_own_key). Вернуться
    на ключ администратора так нельзя (403 ai.return_needs_admin): только просьбой."""
    return await ai_budget.set_mode(db, user, body.mode, ip=ip)


@router.post("/me/ai-mode/return-request")
async def request_return(user: CurrentUser, db: DbSession) -> ReturnRequestOut:
    """Просьба вернуть ключ администратора (Р12): уведомление администраторам. Повторная
    просьба уведомлений не дублирует."""
    return ReturnRequestOut(requested_at=await ai_keys.request_return(db, user))


@router.delete("/me/ai-mode/return-request", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_return_request(user: CurrentUser, db: DbSession) -> Response:
    """Отмена просьбы: уведомления у администраторов убираются. Просьбы нет — ничего."""
    await ai_budget.cancel_return_request(db, user)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/me/ai-cap")
async def set_own_cap(body: OwnCapIn, user: CurrentUser, db: DbSession) -> OwnCapOut:
    """Свой потолок одного анализа на своем ключе, от $0,10 до $20 (400 ai.own_cap_range)."""
    cap = await ai_budget.set_own_cap(db, user, body.per_analysis_usd)
    return OwnCapOut(per_analysis_usd=cap)
