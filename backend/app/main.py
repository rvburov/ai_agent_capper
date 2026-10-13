"""Точка входа: создание приложения FastAPI.

create_app() подключает логирование, middleware (CSRF, заголовки, время ответа),
обработчики ошибок и маршруты. Подключения к PostgreSQL и Redis открываются в lifespan и
лежат в app.state: engine, sessionmaker, redis. Запуск: uvicorn app.main:app.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.agent.client import close_client
from app.api.router import api_router
from app.core.config import get_settings
from app.core.errors import install_error_handlers
from app.core.logging import setup_logging
from app.core.middleware import CsrfMiddleware, SecurityHeadersMiddleware
from app.core.redis import create_redis
from app.core.timing import TimingMiddleware
from app.db.session import create_engine, create_sessionmaker


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    engine = create_engine()
    redis = create_redis()
    app.state.engine = engine
    app.state.sessionmaker = create_sessionmaker(engine)
    app.state.redis = redis
    try:
        yield
    finally:
        await close_client()
        await redis.aclose()
        await engine.dispose()


def create_app() -> FastAPI:
    settings = get_settings()
    setup_logging(json_logs=settings.env == "prod", level=settings.log_level)
    # В prod страницы документации нет: Swagger UI грузит скрипты с CDN, их не пропускает
    # CSP Caddy (script-src 'self'). Схему для фронтенда дает app.openapi_export без сервера
    docs = settings.env != "prod"
    app = FastAPI(
        title="AI Capper API",
        version=settings.version,
        docs_url="/api/docs" if docs else None,
        openapi_url="/api/openapi.json" if docs else None,
        redoc_url=None,
        lifespan=lifespan,
    )
    install_error_handlers(app)
    # Последний добавленный middleware — внешний: заголовки получает и ответ CSRF-проверки
    app.add_middleware(CsrfMiddleware)
    app.add_middleware(SecurityHeadersMiddleware)
    # Время ответа в лог (основа p95): снаружи CSRF и заголовков, чтобы считались и отказы
    app.add_middleware(TimingMiddleware)
    # Самый внешний: IP клиента из X-Forwarded-For, но только от прокси из
    # CAPPER_TRUSTED_PROXIES (Caddy). Иначе у всех клиентов был бы адрес Caddy, и лимиты
    # попыток входа закрыли бы вход всем сразу
    app.add_middleware(ProxyHeadersMiddleware, trusted_hosts=settings.trusted_proxies)
    app.include_router(api_router, prefix="/api")
    return app


app = create_app()
