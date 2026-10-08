# Образ backend: один на API и воркер, отличаются командой (deploy/docker-compose.yml).
#   api:     uvicorn app.main:app ...
#   worker:  python -m app.workers.main
#   миграции и команды терминала: docker compose run --rm api alembic upgrade head
# Секретов в образе нет: настройки CAPPER_* приходят из окружения контейнера.

FROM python:3.13-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

# Зависимости отдельным слоем: он пересобирается только при правке pyproject.toml
FROM base AS deps
WORKDIR /build
COPY pyproject.toml ./
RUN python -c "import tomllib; deps = tomllib.load(open('pyproject.toml', 'rb'))['project']['dependencies']; print('\n'.join(deps))" > requirements.txt \
 && python -m venv /opt/venv \
 && /opt/venv/bin/pip install -r requirements.txt

FROM base
RUN groupadd --gid 10001 capper \
 && useradd --uid 10001 --gid capper --home-dir /app --no-create-home \
      --shell /usr/sbin/nologin capper
COPY --from=deps /opt/venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY alembic.ini ./
COPY alembic ./alembic
COPY app ./app
# Байт-код заранее: в контейнере файловая система только для чтения
RUN python -m compileall -q app alembic
# Версия для GET /api/health: deploy.sh передает хеш коммита и сверяет его после запуска
ARG CAPPER_VERSION=dev
ENV CAPPER_VERSION=$CAPPER_VERSION
USER capper
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--no-server-header"]
