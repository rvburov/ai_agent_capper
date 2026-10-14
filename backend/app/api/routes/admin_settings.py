"""«Администрирование → Настройки»: /api/admin/settings — валюта программы с курсом (Р17,
Т30) и часовой пояс по умолчанию для новых участников.

Доступ только у роли admin (require_admin на роутере). Смена валюты — опасное действие:
в теле totp_code, текущий код 2FA (PLAN.md, раздел 7); предпросмотр (preview) — без кода
и без записи.
"""

from fastapi import APIRouter, Depends

from app.api.routes.admin import Confirm
from app.core.deps import AdminUser, ClientIp, DbSession, RedisClient, require_admin
from app.schemas.admin_settings import (
    AdminSettingsIn,
    AdminSettingsOut,
    CurrencyIn,
    CurrencyPreviewOut,
)
from app.services import app_settings

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])


@router.get("/settings")
async def get_settings(db: DbSession) -> AdminSettingsOut:
    """Валюта программы, последняя смена валюты (когда, кто, курс) и часовой пояс по
    умолчанию."""
    return await app_settings.admin_settings(db)


@router.put("/settings")
async def update_settings(
    db: DbSession, admin: AdminUser, body: AdminSettingsIn
) -> AdminSettingsOut:
    """Часовой пояс по умолчанию для новых участников (база IANA, иначе 422)."""
    return await app_settings.update_settings(db, default_tz=body.default_tz, actor=admin)


@router.put("/settings/currency")
async def change_currency(
    db: DbSession,
    redis: RedisClient,
    admin: AdminUser,
    ip: ClientIp,
    confirm: Confirm,
    body: CurrencyIn,
) -> CurrencyPreviewOut:
    """Смена валюты программы по курсу «1 rate_base = rate второй валюты»: пересчет
    ставок, журнала банка, лимитов и банка из ввода анализа у всех участников с
    округлением каждой суммы до копеек; журнал currency_change; кэш аналитики сбрасывается.
    preview=true — только итоги и примеры «до и после». Без totp_code — 403
    admin.totp_required; та же валюта — 409 admin.currency_same; from_currency не валюта
    программы (окно открыто до чужой смены) — 409 common.currency_changed, и в предпросмотре."""
    return await app_settings.change_currency(
        db,
        redis,
        from_currency=body.from_currency,
        currency=body.currency,
        rate=body.rate,
        rate_base=body.rate_base,
        actor=admin,
        preview=body.preview,
        confirm=confirm.with_code(body.totp_code),
        ip=ip,
    )
