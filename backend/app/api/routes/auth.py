"""Вход, регистрация по приглашению, 2FA, выход, сброс пароля: /api/auth/*.

Заполняет исполнитель раздела «Вход» (схемы — app/schemas/auth.py,
логика — app/services/auth.py).
"""

from fastapi import APIRouter

router = APIRouter(prefix="/auth", tags=["auth"])
