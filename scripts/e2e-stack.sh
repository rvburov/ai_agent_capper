#!/usr/bin/env bash
# Стек для сквозных тестов в браузере (Playwright, frontend/e2e): временная база PostgreSQL
# с миграциями, свой префикс ключей Redis, поддельный Claude API (backend/tests/fake_claude.py,
# ключ Claude не нужен), API (uvicorn), воркер arq (выполняет анализы, без расписания) и
# собранный фронтенд (vite preview, /api проксируется на API). В базе — 6 игроков с матчами
# (tests/analysis_helpers.py: Синнер, Алькарас, Джокович, Медведев, Рублев, Руне). При
# остановке база и ключи Redis удаляются.
#
#   bash scripts/e2e-stack.sh [up]           поднять и держать до Ctrl+C или SIGTERM
#   bash scripts/e2e-stack.sh cli КОМАНДА ...  команда терминала backend (python -m app.admin.cli)
#                                            против базы этого стека; так тесты создают
#                                            администраторов: cli create-admin --email E --password-stdin
#
# Обычно стек поднимает сам Playwright (webServer в frontend/playwright.config.ts):
#   cd frontend && npx playwright test
# Нужны PostgreSQL (роль с правом CREATEDB) и Redis, как для тестов backend, и зависимости
# backend (backend/.venv или пакеты в python3). Настройки — переменные окружения:
#   E2E_API_PORT=8000  E2E_WEB_PORT=4173      порты API и фронтенда
#   E2E_FAKE_CLAUDE_PORT                       порт поддельного Claude (по умолчанию порт API + 99);
#                      сбой шага для теста: POST http://127.0.0.1:ПОРТ/_fake/fail
#                      {"step": "analysis", "error": "overloaded", "times": 3}, сброс — /_fake/reset
#   E2E_PG_ADMIN_URL   служебная база, из которой создается временная
#                      (по умолчанию CAPPER_TEST_ADMIN_DATABASE_URL или capper:capper@localhost)
#   E2E_REDIS_URL      Redis (по умолчанию CAPPER_REDIS_URL или redis://localhost:6379/0)
#   E2E_STATE_DIR      логи (api, worker, fake_claude, web) и собранный фронтенд (по умолчанию
#                      во временной папке)
#   E2E_SKIP_BUILD=1   не собирать фронтенд заново, взять сборку из E2E_STATE_DIR
#   E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD  администратор, которого стек создает при запуске
#                      (для ручной проверки; тесты создают своих через cli); ключ администратора
#                      Claude — фальшивый sk-ant-..., его проверку отвечает поддельный Claude
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

API_PORT="${E2E_API_PORT:-8000}"
WEB_PORT="${E2E_WEB_PORT:-4173}"
FAKE_PORT="${E2E_FAKE_CLAUDE_PORT:-$((API_PORT + 99))}"
PG_ADMIN_URL="${E2E_PG_ADMIN_URL:-${CAPPER_TEST_ADMIN_DATABASE_URL:-postgresql://capper:capper@localhost:5432/postgres}}"
REDIS_URL="${E2E_REDIS_URL:-${CAPPER_REDIS_URL:-redis://localhost:6379/0}}"
# Имена зависят от порта API: два стека на разных портах друг другу не мешают
DB_NAME="capper_e2e_${API_PORT}"
REDIS_PREFIX="capper-e2e-${API_PORT}:"
STATE_DIR="${E2E_STATE_DIR:-${TMPDIR:-/tmp}/capper-e2e-${API_PORT}}"
WEB_DIST="$STATE_DIR/dist"
ADMIN_EMAIL="${E2E_ADMIN_EMAIL:-owner@e2e.test}"
ADMIN_PASSWORD="${E2E_ADMIN_PASSWORD:-e2e-owner-password-2026}"
FAKE_ADMIN_KEY="sk-ant-e2e-fake-admin-key-0000"

if [[ -n "${E2E_PYTHON:-}" ]]; then PY="$E2E_PYTHON"
elif [[ -x "$BACKEND/.venv/bin/python" ]]; then PY="$BACKEND/.venv/bin/python"
else PY="python3"; fi

say() { printf '[e2e-stack] %s\n' "$*"; }
die() { printf '[e2e-stack] Ошибка: %s\n' "$*" >&2; exit 1; }

# Настройки backend как в тестах: CAPPER_ENV=test (без HIBP, cookie без Secure), ключи для
# разработки (годятся только для http://localhost), доверенный прокси — сам компьютер:
# vite preview передает заголовок X-Forwarded-For браузера, и тесты задают каждому
# браузеру свой IP-адрес (лимиты попыток входа считаются по IP)
backend_env() {
  export CAPPER_ENV=test
  export CAPPER_DATABASE_URL="postgresql+asyncpg://${PG_ADMIN_URL#*://}"
  CAPPER_DATABASE_URL="${CAPPER_DATABASE_URL%/*}/$DB_NAME"
  export CAPPER_REDIS_URL="$REDIS_URL"
  export CAPPER_REDIS_PREFIX="$REDIS_PREFIX"
  export CAPPER_PUBLIC_ORIGIN="http://localhost:$WEB_PORT"
  export CAPPER_COOKIE_SECURE=false
  export CAPPER_HIBP_ENABLED=false
  export CAPPER_TRUSTED_PROXIES=127.0.0.1
  export CAPPER_SECRET_KEY="" CAPPER_MASTER_KEYS=""
  # Claude API — поддельный сервер этого стека (http разрешен везде, кроме prod)
  export CAPPER_ANTHROPIC_BASE_URL="http://127.0.0.1:$FAKE_PORT"
  # Воркер без расписания: ночная загрузка архивов и уборщик не начнутся посреди прогона
  export CAPPER_WORKER_CRON=false
}

# Создать (drop=0) или удалить (drop=1) временную базу через служебную
db_admin() {
  E2E_PG_ADMIN_URL="$PG_ADMIN_URL" E2E_DB_NAME="$DB_NAME" E2E_DROP="$1" "$PY" - <<'PY'
import asyncio, os

import asyncpg


async def main() -> None:
    conn = await asyncpg.connect(os.environ["E2E_PG_ADMIN_URL"])
    name = os.environ["E2E_DB_NAME"]
    try:
        await conn.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
        if os.environ["E2E_DROP"] != "1":
            await conn.execute(f'CREATE DATABASE "{name}"')
    finally:
        await conn.close()


asyncio.run(main())
PY
}

redis_clear() {
  E2E_REDIS_URL="$REDIS_URL" E2E_REDIS_PREFIX="$REDIS_PREFIX" "$PY" - <<'PY'
import os

import redis

client = redis.Redis.from_url(os.environ["E2E_REDIS_URL"])
keys = list(client.scan_iter(match=os.environ["E2E_REDIS_PREFIX"] + "*", count=500))
for start in range(0, len(keys), 500):
    client.delete(*keys[start : start + 500])
PY
}

port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

wait_url() {
  local url="$1" pid="$2" log="$3"
  for _ in $(seq 1 120); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then return 0; fi
    if ! kill -0 "$pid" 2>/dev/null; then
      tail -n 40 "$log" >&2 || true
      die "процесс завершился, не дождавшись $url (лог: $log)"
    fi
    sleep 0.5
  done
  tail -n 40 "$log" >&2 || true
  die "$url не ответил за 60 секунд (лог: $log)"
}

API_PID=""
WEB_PID=""
WORKER_PID=""
FAKE_PID=""
cleanup() {
  local code=$?
  trap - EXIT INT TERM
  say "останавливаю стек"
  for pid in $WEB_PID $API_PID $WORKER_PID $FAKE_PID; do kill -TERM "$pid" 2>/dev/null || true; done
  for pid in $WEB_PID $API_PID $WORKER_PID $FAKE_PID; do wait "$pid" 2>/dev/null || true; done
  db_admin 1 || say "не удалось удалить базу $DB_NAME"
  redis_clear || say "не удалось удалить ключи $REDIS_PREFIX* в Redis"
  exit "$code"
}

cmd_up() {
  port_busy "$API_PORT" && die "порт $API_PORT занят (другой стек или uvicorn?)"
  port_busy "$WEB_PORT" && die "порт $WEB_PORT занят (другой стек или vite?)"
  port_busy "$FAKE_PORT" && die "порт $FAKE_PORT занят (другой стек или поддельный Claude?)"
  mkdir -p "$STATE_DIR"
  backend_env
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  say "временная база $DB_NAME, префикс Redis $REDIS_PREFIX"
  db_admin 0
  redis_clear
  (cd "$BACKEND" && "$PY" -m alembic upgrade head) >"$STATE_DIR/migrate.log" 2>&1 \
    || { cat "$STATE_DIR/migrate.log" >&2; die "миграции не применились"; }

  # Маленький теннисный мир для сценариев анализа (те же игроки и матчи, что в тестах backend:
  # tests/analysis_helpers.py) и повтор оценки Claude выключен: каждый прогон вызывает
  # поддельный Claude, и сбой шага, включенный тестом, действительно случается
  say "игроки и матчи для сценариев анализа (лог: $STATE_DIR/seed.log)"
  (cd "$BACKEND" && "$PY" - <<'PY'
import asyncio

from app.db.session import create_engine, create_sessionmaker
from tests.analysis_helpers import seed_world


async def main() -> None:
    engine = create_engine()
    try:
        async with create_sessionmaker(engine)() as db:
            await seed_world(db, engine)
    finally:
        await engine.dispose()


asyncio.run(main())
PY
  ) >"$STATE_DIR/seed.log" 2>&1 || { cat "$STATE_DIR/seed.log" >&2; die "игроки для сценариев анализа не загружены"; }
  (cd "$BACKEND" && "$PY" -m app.admin.cli agent-config --set assessment_reuse_hours=0) \
    >>"$STATE_DIR/seed.log" 2>&1 || { cat "$STATE_DIR/seed.log" >&2; die "настройки агента не сохранены"; }

  say "поддельный Claude API на http://127.0.0.1:$FAKE_PORT (лог: $STATE_DIR/fake_claude.log)"
  (cd "$BACKEND" && exec "$PY" -m uvicorn tests.fake_claude:app --host 127.0.0.1 \
    --port "$FAKE_PORT" --no-access-log) >"$STATE_DIR/fake_claude.log" 2>&1 &
  FAKE_PID=$!
  wait_url "http://127.0.0.1:$FAKE_PORT/_fake/calls" "$FAKE_PID" "$STATE_DIR/fake_claude.log"

  say "администратор из терминала: $ADMIN_EMAIL"
  (cd "$BACKEND" && printf '%s\n' "$ADMIN_PASSWORD" \
    | "$PY" -m app.admin.cli create-admin --email "$ADMIN_EMAIL" --name "Владелец" --password-stdin)
  (cd "$BACKEND" && printf '%s\n' "$FAKE_ADMIN_KEY" \
    | "$PY" -m app.admin.cli set-admin-key --key-stdin) >"$STATE_DIR/admin-key.log" 2>&1 \
    || { cat "$STATE_DIR/admin-key.log" >&2; die "ключ администратора не сохранен"; }

  say "воркер arq (лог: $STATE_DIR/worker.log)"
  (cd "$BACKEND" && exec "$PY" -m app.workers.main) >"$STATE_DIR/worker.log" 2>&1 &
  WORKER_PID=$!

  say "API на http://127.0.0.1:$API_PORT (лог: $STATE_DIR/api.log)"
  (cd "$BACKEND" && exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port "$API_PORT" \
    --proxy-headers --forwarded-allow-ips=127.0.0.1 --no-server-header) \
    >"$STATE_DIR/api.log" 2>&1 &
  API_PID=$!
  wait_url "http://127.0.0.1:$API_PORT/api/health" "$API_PID" "$STATE_DIR/api.log"

  if [[ "${E2E_SKIP_BUILD:-}" != "1" || ! -f "$WEB_DIST/index.html" ]]; then
    say "собираю фронтенд в $WEB_DIST"
    (cd "$FRONTEND" && node_modules/.bin/vite build --outDir "$WEB_DIST" --emptyOutDir) >"$STATE_DIR/build.log" 2>&1 \
      || { tail -n 40 "$STATE_DIR/build.log" >&2; die "сборка фронтенда не прошла"; }
  fi

  say "фронтенд на http://localhost:$WEB_PORT (лог: $STATE_DIR/web.log)"
  (cd "$FRONTEND" && CAPPER_API_URL="http://127.0.0.1:$API_PORT" exec node_modules/.bin/vite preview \
    --outDir "$WEB_DIST" --port "$WEB_PORT" --strictPort) >"$STATE_DIR/web.log" 2>&1 &
  WEB_PID=$!
  wait_url "http://localhost:$WEB_PORT/api/health" "$WEB_PID" "$STATE_DIR/web.log"

  say "готово: http://localhost:$WEB_PORT, вход $ADMIN_EMAIL"
  # Ждем, пока не остановят или пока не упадет один из процессов
  while kill -0 "$API_PID" 2>/dev/null && kill -0 "$WEB_PID" 2>/dev/null \
    && kill -0 "$WORKER_PID" 2>/dev/null && kill -0 "$FAKE_PID" 2>/dev/null; do
    sleep 1 &
    wait $! || true
  done
  die "сервер остановился сам (логи: $STATE_DIR)"
}

cmd_cli() {
  backend_env
  cd "$BACKEND"
  exec "$PY" -m app.admin.cli "$@"
}

case "${1:-up}" in
  up) cmd_up ;;
  cli) shift; cmd_cli "$@" ;;
  -h|--help|help) sed -n '2,30p' "${BASH_SOURCE[0]}" ;;
  *) die "неизвестная команда: $1 (up, cli)" ;;
esac
