"""Публичные настройки программы для вошедшего пользователя: GET /api/settings
(валюта программы и т. п.).

Заполняет исполнитель раздела «Вход и личный кабинет».
"""

from fastapi import APIRouter

router = APIRouter(tags=["settings"])
