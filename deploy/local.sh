#!/usr/bin/env bash
# AI Capper на своем компьютере, без сервера и домена: весь стек в Docker на https://localhost.
#
#   bash deploy/local.sh up                 собрать и запустить (первый раз 5–10 минут)
#   bash deploy/local.sh admin EMAIL [ИМЯ]  создать администратора (пароль спросит)
#   bash deploy/local.sh cli КОМАНДА ...    любая команда терминала: reset-code, reset-2fa, ...
#   bash deploy/local.sh import EMAIL ФАЙЛ [ПАПКА_ИГРОКОВ] [--dry-run]
#                                           импорт истории старого бота
#   bash deploy/local.sh backup             ночной бэкап вручную и проверка восстановления
#   bash deploy/local.sh status | logs [СЕРВИС]
#   bash deploy/local.sh down               остановить, данные сохраняются
#   bash deploy/local.sh wipe               остановить и удалить все данные
#
# Нужен Docker (Docker Desktop на Windows и macOS) и bash (на Windows — Git Bash или WSL).
# Порты 80 и 443 должны быть свободны. Пароли и ключи создаются сами в deploy/.env.local
# (в git не попадает). Браузер предупредит о сертификате: Caddy выпускает свой сертификат
# для localhost, это нормально для проверки на своем компьютере.
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$DEPLOY_DIR/.env.local"
URL="https://localhost"

# Свои дополнения к compose (например, другие порты) — в deploy/docker-compose.local.yml,
# он подключается сам, если есть, и в git не попадает
COMPOSE_FILES=(-f "$DEPLOY_DIR/docker-compose.yml")
[[ -f "$DEPLOY_DIR/docker-compose.local.yml" ]] && COMPOSE_FILES+=(-f "$DEPLOY_DIR/docker-compose.local.yml")

dc() {
  docker compose "${COMPOSE_FILES[@]}" -p capper-local --env-file "$ENV_FILE" "$@"
}

say() { printf '\n== %s\n' "$*"; }
die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

rand_hex() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -hex "$1"
  else python3 -c "import secrets; print(secrets.token_hex($1))"; fi
}

rand_b64_32() {
  if command -v openssl >/dev/null 2>&1; then openssl rand -base64 32
  else python3 -c "import base64, os; print(base64.b64encode(os.urandom(32)).decode())"; fi
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "не найден docker. Установите Docker Desktop: https://docs.docker.com/get-docker/"
  docker info >/dev/null 2>&1 || die "Docker не запущен. Запустите Docker Desktop и повторите"
}

ensure_env() {
  [[ -f "$ENV_FILE" ]] && return
  say "Создаю $ENV_FILE с новыми паролями и ключами"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Создано deploy/local.sh $(date -u +%Y-%m-%dT%H:%MZ). Только для своего компьютера, в git не попадает.
CAPPER_DOMAIN=localhost
# На своем компьютере IPv6 в сети Docker не нужен (и не везде поддерживается)
CAPPER_EDGE_IPV6=false
POSTGRES_PASSWORD=$(rand_hex 24)
CAPPER_SECRET_KEY=$(rand_hex 32)
CAPPER_MASTER_KEYS=1:$(rand_b64_32)
BACKUP_LOCAL_DIR=./backup/dumps-local
EOF
}

ensure_backup_keys() {
  grep -q '^BACKUP_AGE_RECIPIENTS=age1' "$ENV_FILE" && return
  say "Создаю ключи age для локальных бэкапов"
  local out pub sec
  out="$(dc run --rm --no-deps --entrypoint age-keygen backup 2>&1)"
  pub="$(printf '%s\n' "$out" | sed -n 's/.*public key: \(age1[0-9a-z]*\).*/\1/p' | head -n1)"
  sec="$(printf '%s\n' "$out" | grep -o 'AGE-SECRET-KEY-1[0-9A-Z]*' | head -n1)"
  [[ -n "$pub" && -n "$sec" ]] || die "не удалось создать ключи age: $out"
  printf 'BACKUP_AGE_RECIPIENTS=%s\nBACKUP_AGE_IDENTITY=%s\n' "$pub" "$sec" >> "$ENV_FILE"
}

wait_health() {
  say "Жду, пока $URL/api/health ответит"
  local i body
  for i in $(seq 1 60); do
    body="$(curl -sk --max-time 3 "$URL/api/health" || true)"
    if [[ "$body" == *'"status":"ok"'* ]]; then
      printf '%s\n' "$body"
      return
    fi
    sleep 2
  done
  dc ps
  die "сайт не ответил за 2 минуты. Логи: bash deploy/local.sh logs api"
}

cmd_up() {
  need_docker
  ensure_env
  say "Сборка образов"
  dc build
  ensure_backup_keys
  say "База и Redis"
  dc up -d --wait postgres redis
  say "Миграции базы"
  dc run --rm api alembic upgrade head
  say "Запуск всех сервисов"
  dc up -d
  wait_health
  cat <<EOF

Готово: откройте $URL (браузер предупредит о сертификате — продолжите).
Первый раз создайте администратора:  bash deploy/local.sh admin you@example.com "Имя"
Затем войдите: при первом входе настраивается 2FA (Google Authenticator, Яндекс Ключ,
1Password и т. п.) и показываются 8 резервных кодов.
EOF
}

cmd_admin() {
  [[ $# -ge 1 ]] || die "укажите email: bash deploy/local.sh admin you@example.com \"Имя\""
  local args=(create-admin --email "$1")
  [[ $# -ge 2 ]] && args+=(--name "$2")
  dc exec api python -m app.admin.cli "${args[@]}"
}

cmd_import() {
  [[ $# -ge 2 ]] || die "bash deploy/local.sh import EMAIL История-ставок.json [папка Игроки] [--dry-run]"
  local email="$1" history="$2"; shift 2
  [[ -f "$history" ]] || die "нет файла $history"
  local args=(--email "$email" --history /tmp/import/history.json)
  # /tmp контейнера — tmpfs, docker cp туда не пишет: файлы передаются через stdin
  dc exec -T api sh -c 'rm -rf /tmp/import && mkdir -p /tmp/import/players && cat > /tmp/import/history.json' < "$history"
  if [[ $# -ge 1 && "$1" != --* ]]; then
    [[ -d "$1" ]] || die "нет папки $1"
    tar -C "$1" -cf - . | dc exec -T api tar -C /tmp/import/players -xf -
    args+=(--players /tmp/import/players)
    shift
  fi
  dc exec -T api python -m app.ingest.legacy "${args[@]}" "$@" || { dc exec -T api rm -rf /tmp/import; exit 1; }
  dc exec -T api rm -rf /tmp/import
}

cmd_backup() {
  dc exec backup backup.sh
  dc exec backup restore-check.sh
}

cmd_wipe() {
  read -r -p "Удалить все данные локальной копии (базу, Redis, бэкапы)? Введите да: " answer
  [[ "$answer" == "да" ]] || die "отменено"
  dc down -v
  rm -rf "$DEPLOY_DIR/backup/dumps-local"
  echo "Удалено. Пароли и ключи остались в $ENV_FILE; удалите файл, чтобы создать новые."
}

case "${1:-}" in
  up) cmd_up ;;
  admin) shift; cmd_admin "$@" ;;
  cli) shift; dc exec api python -m app.admin.cli "$@" ;;
  import) shift; cmd_import "$@" ;;
  backup) cmd_backup ;;
  status) dc ps ;;
  logs) shift; dc logs -f --tail 200 "$@" ;;
  down) dc down ;;
  wipe) cmd_wipe ;;
  *) sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
