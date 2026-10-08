"""Кабинет администратора: /api/admin/*.

Доступ только у роли admin: зависимость require_admin стоит на уровне роутера,
поэтому любой маршрут здесь без сеанса отвечает 401, участнику — 403.
Заполняет исполнитель раздела «Кабинет администратора».
"""

from fastapi import APIRouter, Depends

from app.core.deps import require_admin

router = APIRouter(prefix="/admin", tags=["admin"], dependencies=[Depends(require_admin)])
