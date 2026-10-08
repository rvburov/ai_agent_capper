#!/usr/bin/env bash
# Деплой на сервере. Запускает пользователь deploy (вручную или GitHub Actions по SSH):
#   bash /opt/ai_agent_capper/deploy/deploy.sh                 последний коммит master
#   bash /opt/ai_agent_capper/deploy/deploy.sh --ref 3f2a9c1    конкретный коммит master (откат)
#   --no-fetch    не брать код из GitHub: развернуть то, что лежит в папке
#   --no-pull     не обновлять базовые образы (если Docker Hub недоступен или ограничил скачивание)
#   --no-backup   не снимать копию базы перед миграциями
#
# Шаги: код из origin/master (git fetch + reset) → сборка образов → PostgreSQL, Redis и
# бэкап → копия базы (manual/) → миграции одноразовым контейнером → перезапуск сервисов →
# проверка здоровья через Caddy с повторами. Миграции идут до перезапуска: если они
# упали, работает прежняя версия. При сбое — логи и код ошибки 1.
#
# Ключ GitHub Actions на сервере ограничен этой командой (authorized_keys:
# command="bash .../deploy.sh --ssh",restrict): тогда SSH_ORIGINAL_COMMAND —
# "deploy <sha коммита>", и развернуть можно только коммит из истории master, не старше
# уже развернутого (старый пропускается с кодом 0).
set -Eeuo pipefail

BRANCH=master
HEALTH_ATTEMPTS=30

log() {
  printf '%s [deploy] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

die() {
  log "ОШИБКА: $*" >&2
  exit 1
}

compose() {
  docker compose "$@"
}

show_failure() {
  log "состояние сервисов:"
  compose ps -a || true
  log "последние строки логов:"
  compose logs --no-color --tail=80 api worker caddy || true
}

env_value() {
  # Значение переменной из deploy/.env без кавычек
  local value
  value="$(grep -E "^$1=" .env | tail -n 1 | cut -d= -f2- || true)"
  value="${value%\"}"
  value="${value#\"}"
  printf '%s\n' "$value"
}

check_health() {
  # Проверка через Caddy по домену, как ходит браузер: TLS, прокси /api, API, база, Redis
  local domain="$1" version="$2" attempt body tls_opts=()
  [ "$domain" = localhost ] && tls_opts=(--insecure)
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if body="$(curl --silent --show-error --fail --max-time 5 --noproxy '*' "${tls_opts[@]}" \
      --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" 2>&1)"; then
      if [[ "$body" == *"\"version\":\"$version\""* ]]; then
        log "здоров: $body"
        return 0
      fi
      log "попытка $attempt: отвечает другая версия ($body)"
    else
      log "попытка $attempt: $body"
    fi
    sleep 4
  done
  return 1
}

main() {
  local ref="origin/$BRANCH" fetch=1 pull=1 backup=1 ssh_mode=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --ref) ref="${2:?после --ref нужен коммит}"; shift ;;
      --no-fetch) fetch=0 ;;
      --no-pull) pull=0 ;;
      --no-backup) backup=0 ;;
      --ssh) ssh_mode=1 ;;
      *) die "неизвестный аргумент: $1" ;;
    esac
    shift
  done

  if [ "$ssh_mode" = 1 ]; then
    # Команда от GitHub Actions: "deploy" или "deploy <sha>"; другое не принимается
    local words=()
    read -r -a words <<< "${SSH_ORIGINAL_COMMAND:-deploy}"
    if [ "${words[0]:-}" != deploy ] || [ "${#words[@]}" -gt 2 ]; then
      die "разрешена только команда deploy"
    fi
    if [ -n "${words[1]:-}" ]; then
      [[ "${words[1]}" =~ ^[0-9a-f]{7,40}$ ]] || die "ожидается хеш коммита"
      ref="${words[1]}"
    fi
  fi

  cd "$(dirname "$(readlink -f "$0")")/.."
  [ -f deploy/.env ] || die "нет deploy/.env: скопируйте deploy/.env.example и заполните"

  exec 9> /tmp/capper-deploy.lock
  flock -n 9 || die "деплой уже идет"

  if [ "$fetch" = 1 ]; then
    local before target
    before="$(git rev-parse HEAD)"
    log "код из GitHub"
    git fetch --prune --quiet origin "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH"
    target="$(git rev-parse --verify --quiet "$ref^{commit}")" || die "коммит $ref не найден"
    git merge-base --is-ancestor "$target" "origin/$BRANCH" \
      || die "коммит $ref не из истории $BRANCH: такой не разворачиваем"
    # Из GitHub Actions — только вперед. Старый коммит приходит, если «Проверки» для него
    # закончились позже, чем для нового, или старый запуск перезапустили. Откат — вручную
    # (--ref). Строку «деплой пропущен» ищет .github/workflows/deploy.yml
    if [ "$ssh_mode" = 1 ] && [ "$target" != "$before" ] \
      && git merge-base --is-ancestor "$target" "$before"; then
      log "деплой пропущен: на сервере уже более новый коммит $(git rev-parse --short=12 "$before")," \
        "а $(git rev-parse --short=12 "$target") старше. Откат — вручную: bash deploy.sh --ref <хеш>"
      exit 0
    fi
    git reset --hard --quiet "$target"
    # Новая версия этого скрипта сама доделывает деплой
    if [ "${CAPPER_DEPLOY_REEXEC:-}" != 1 ] && ! git diff --quiet "$before" "$target" -- deploy/deploy.sh; then
      log "deploy.sh изменился, запускаю новую версию"
      local rest=()
      [ "$pull" = 1 ] || rest+=(--no-pull)
      [ "$backup" = 1 ] || rest+=(--no-backup)
      CAPPER_DEPLOY_REEXEC=1 exec bash deploy/deploy.sh --no-fetch "${rest[@]}"
    fi
  fi

  local version domain
  version="$(git rev-parse --short=12 HEAD)"
  export CAPPER_VERSION="$version"
  log "разворачиваю $version: $(git log -1 --format=%s)"

  cd deploy
  domain="$(env_value CAPPER_DOMAIN)"
  [ -n "$domain" ] || die "в deploy/.env не задан CAPPER_DOMAIN"

  log "сборка образов"
  local build_args=()
  [ "$pull" = 1 ] && build_args+=(--pull)
  compose build "${build_args[@]}" || die "сборка образов не удалась, работает прежняя версия"
  if [ "$pull" = 1 ]; then
    compose pull --quiet postgres redis || die "не удалось скачать образы postgres и redis" \
      "(Docker Hub недоступен? повторите с --no-pull)"
  fi

  log "PostgreSQL, Redis и бэкап"
  compose up -d --wait postgres redis || die "PostgreSQL или Redis не запустились"
  # Контейнер backup — сразу с новыми образом и настройками: копию перед миграциями
  # снимает уже он. Его здоровья не ждем: прошлый сбой бэкапа не должен мешать деплою
  compose up -d --no-deps backup || die "контейнер backup не запустился"

  if [ "$backup" = 1 ] && [ -z "$(env_value BACKUP_AGE_RECIPIENTS)" ]; then
    log "ВНИМАНИЕ: бэкапы не настроены (BACKUP_AGE_RECIPIENTS в deploy/.env)," \
      "копия перед миграциями не снимается"
  elif [ "$backup" = 1 ]; then
    log "копия базы перед миграциями"
    compose exec -T backup backup.sh --manual \
      || die "копия базы не создана, деплой остановлен (без копии: --no-backup)"
  fi

  log "миграции"
  if ! compose run --rm --no-deps api alembic upgrade head; then
    show_failure
    die "миграции не применились, работает прежняя версия"
  fi

  log "перезапуск сервисов"
  if ! compose up -d --remove-orphans \
    || ! compose up -d --wait --wait-timeout 180 api worker caddy; then
    show_failure
    die "сервисы не стали здоровыми за 3 минуты"
  fi

  log "проверка https://$domain/api/health"
  if ! check_health "$domain" "$version"; then
    show_failure
    die "приложение не отвечает через Caddy. Проверьте DNS домена и сертификат:" \
      "docker compose logs caddy"
  fi

  local backup_health
  backup_health="$(docker inspect --format '{{.State.Health.Status}}' "$(compose ps -q backup)" \
    2> /dev/null || true)"
  if [ "$backup_health" = unhealthy ]; then
    log "ВНИМАНИЕ: контейнер backup нездоров (последний бэкап или проверка упали):" \
      "docker compose logs backup"
  fi

  # Старые образы и кэш сборки старше недели занимают место на диске
  docker image prune --force > /dev/null
  docker builder prune --force --filter until=168h > /dev/null
  log "готово: $version"
}

main "$@"
