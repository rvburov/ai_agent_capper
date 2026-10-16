#!/usr/bin/env bash
# Деплой на сервере. Запускает пользователь deploy (вручную или GitHub Actions по SSH):
#   bash /opt/ai_agent_capper/deploy/deploy.sh                 последний коммит master
#   bash /opt/ai_agent_capper/deploy/deploy.sh --ref 3f2a9c1    конкретный коммит master (откат)
#   --no-fetch    не брать код из GitHub: развернуть то, что лежит в папке
#   --no-pull     не обновлять базовые образы (если Docker Hub недоступен или ограничил скачивание)
#   --no-backup   не снимать копию базы перед миграциями
#
# Шаги: код из origin/master (git fetch + reset) → образы работающей версии получают тег
# previous → сборка образов → PostgreSQL, Redis и бэкап → копия базы (manual/) → миграции
# одноразовым контейнером → перезапуск сервисов → проверка здоровья через Caddy с
# повторами. Миграции идут до перезапуска: если они упали, работает прежняя версия.
# Сбой после начала сборки (сборка, миграции, здоровье) — откат: тег latest снова на
# образах previous, код — коммит прежней версии, сервисы поднимаются на них, проверка
# здоровья; затем логи и код ошибки 1. Миграции вниз не откатываются (deploy/README.md,
# раздел 9). Поэтому после отката схема базы бывает новее кода: при деплое прежнего
# коммита миграции тогда пропускаются, если ревизия базы и миграции кода есть в master.
#
# Ключ GitHub Actions на сервере ограничен этой командой (authorized_keys:
# command="bash .../deploy.sh --ssh",restrict): тогда SSH_ORIGINAL_COMMAND —
# "deploy <sha коммита>", и развернуть можно только коммит из истории master, не старше
# уже развернутого (старый пропускается с кодом 0).
set -Eeuo pipefail

BRANCH=master
HEALTH_ATTEMPTS=30
# Сервис → образ. Перед сборкой образ, на котором работает сервис, получает тег previous;
# worker работает на том же образе, что api
SERVICE_IMAGES=(api:capper-backend caddy:capper-web backup:capper-backup)
# Заполняются по ходу деплоя: домен, откуда код (git или папка как есть), прежняя версия
DOMAIN=""
CODE_FROM_GIT=0
ROLLBACK_READY=0
PREV_VERSION=""

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
  # Проверка через Caddy по домену, как ходит браузер: TLS, прокси /api, API, база, Redis.
  # Пустая версия — подойдет любая (у прежнего образа ее могло не быть)
  local domain="$1" version="$2" attempt body tls_opts=()
  [ "$domain" = localhost ] && tls_opts=(--insecure)
  for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt++)); do
    if body="$(curl --silent --show-error --fail --max-time 5 --noproxy '*' "${tls_opts[@]}" \
      --resolve "$domain:443:127.0.0.1" "https://$domain/api/health" 2>&1)"; then
      if [ -z "$version" ] || [[ "$body" == *"\"version\":\"$version\""* ]]; then
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

image_version() {
  # CAPPER_VERSION из образа backend: хеш коммита, из которого он собран
  docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$1" 2> /dev/null \
    | sed -n 's/^CAPPER_VERSION=//p' | head -n 1
}

db_revisions() {
  # Ревизии Alembic в базе. Пусто — таблицы еще нет (первый деплой) или база не ответила:
  # тогда ошибку покажет сам alembic upgrade head
  compose exec -T postgres psql --username=capper --dbname=capper --no-align --tuples-only \
    --command 'SELECT version_num FROM alembic_version' 2> /dev/null || true
}

code_revisions() {
  # Все ревизии миграций в новом образе, то есть в коде разворачиваемой версии
  compose run --rm --no-deps -T api python -c 'from alembic.config import Config
from alembic.script import ScriptDirectory
script = ScriptDirectory.from_config(Config("alembic.ini"))
print(*(revision.revision for revision in script.walk_revisions()))'
}

master_revisions() {
  # Все ревизии миграций в последнем коммите master (файлы backend/alembic/versions)
  git -C .. grep -h -o -E "^revision(: *str)? *= *[\"'][A-Za-z0-9_]+[\"']" "origin/$BRANCH" \
    -- backend/alembic/versions | sed -E "s/.*[\"']([A-Za-z0-9_]+)[\"']$/\1/"
}

missing_from() {
  # Слова из $1, которых нет среди слов $2 (через пробел или с новой строки)
  local word words=" ${2//$'\n'/ } "
  for word in $1; do
    [[ "$words" == *" $word "* ]] || printf '%s ' "$word"
  done
}

migrate() {
  # alembic upgrade head. Если в базе ревизия, которой код не знает, upgrade падает
  # («Can't locate revision»): так бывает при деплое прежнего коммита после отката, когда
  # схему уже обновил более новый коммит. Тогда миграции пропускаются, а прежний код
  # работает на новой схеме (deploy/README.md, раздел 9) — но только если и ревизия базы,
  # и все миграции кода есть в master: иначе файл миграции удален или код не из master
  local db_revs code_revs master_revs ahead
  db_revs="$(db_revisions)"
  if [ -n "$db_revs" ] && code_revs="$(code_revisions)" && [ -n "$code_revs" ]; then
    ahead="$(missing_from "$db_revs" "$code_revs")"
  fi
  if [ -z "${ahead:-}" ]; then
    compose run --rm --no-deps api alembic upgrade head
    return
  fi
  master_revs="$(master_revisions || true)"
  if [ -n "$(missing_from "$ahead $code_revs" "$master_revs")" ]; then
    log "в базе ревизия ${ahead% }: ее нет в этом коде, а в $BRANCH нет ее самой или миграций" \
      "этого кода (удален файл миграции?). Схему вернуть копией из manual/ или downgrade:" \
      "deploy/README.md, раздел 9"
    return 1
  fi
  log "схема базы новее кода: ревизия ${ahead% } из более нового коммита $BRANCH." \
    "Миграции пропущены, вниз они не откатываются (deploy/README.md, раздел 9)"
}

remember_images() {
  # Образы, на которых сервисы работают сейчас, получают тег previous: на них откат.
  # Контейнера нет (сервис остановлен через down) — берется текущий тег latest. Образа
  # контейнера может уже не быть: с хранилищем образов containerd он удаляется, когда
  # ручная сборка (docker compose build) забрала у него последний тег
  local pair service image container id
  ROLLBACK_READY=1
  for pair in "${SERVICE_IMAGES[@]}"; do
    service="${pair%%:*}"
    image="${pair#*:}"
    id=""
    container="$(compose ps --all --quiet "$service" 2> /dev/null | head -n 1 || true)"
    if [ -n "$container" ]; then
      id="$(docker inspect --format '{{.Image}}' "$container" 2> /dev/null || true)"
    fi
    [ -n "$id" ] || id="$(docker image inspect --format '{{.Id}}' "$image:latest" 2> /dev/null || true)"
    if [ -z "$id" ] || ! docker tag "$id" "$image:previous" 2> /dev/null; then
      ROLLBACK_READY=0
      continue
    fi
  done
  if [ "$ROLLBACK_READY" = 1 ]; then
    PREV_VERSION="$(image_version capper-backend:previous)"
    log "образы прежней версии ${PREV_VERSION:-(версия неизвестна)} сохранены с тегом previous"
  else
    log "прежних образов нет (первый деплой или ручная сборка): при сбое откатывать некуда"
  fi
}

rollback() {
  # Возврат на прежнюю версию: образы previous снова latest, код — ее коммит (вместе с
  # docker-compose.yml), сервисы поднимаются на них. Схема базы остается новой:
  # миграции вниз не откатываются (deploy/README.md, раздел 9)
  local pair commit
  if [ "$ROLLBACK_READY" != 1 ]; then
    log "откат невозможен: прежних образов нет"
    return 1
  fi
  log "откат на прежнюю версию ${PREV_VERSION:-(версия неизвестна)}"
  for pair in "${SERVICE_IMAGES[@]}"; do
    docker tag "${pair#*:}:previous" "${pair#*:}:latest" || return 1
  done
  if [ "$CODE_FROM_GIT" = 1 ] && [[ "$PREV_VERSION" =~ ^[0-9a-f]{7,40}$ ]] \
    && commit="$(git rev-parse --verify --quiet "$PREV_VERSION^{commit}")"; then
    git reset --hard --quiet "$commit"
  else
    log "ВНИМАНИЕ: код в папке не возвращен (нет коммита прежней версии или --no-fetch):" \
      "образы прежние, docker-compose.yml — из папки"
  fi
  if compose up -d --no-build --remove-orphans \
    && compose up -d --no-build --wait --wait-timeout 180 api worker caddy \
    && check_health "$DOMAIN" "$PREV_VERSION"; then
    log "откат выполнен: работает ${PREV_VERSION:-прежняя версия}"
    return 0
  fi
  show_failure
  log "ОШИБКА: откат не помог, сайт может не работать. Логи выше; дальше — deploy/README.md," \
    "раздел 10"
  return 1
}

fail() {
  # Сбой после начала сборки: откат на прежние образы, затем выход с ошибкой
  rollback || true
  die "$@"
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
  # Код из git (а не правки в папке): при откате его можно вернуть на прежний коммит
  if [ "$fetch" = 1 ] || [ "${CAPPER_DEPLOY_REEXEC:-}" = 1 ]; then
    CODE_FROM_GIT=1
  fi

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

  local version
  version="$(git rev-parse --short=12 HEAD)"
  export CAPPER_VERSION="$version"
  log "разворачиваю $version: $(git log -1 --format=%s)"

  cd deploy
  DOMAIN="$(env_value CAPPER_DOMAIN)"
  [ -n "$DOMAIN" ] || die "в deploy/.env не задан CAPPER_DOMAIN"

  # Лимит процессора api по умолчанию (1.5) больше, чем есть на сервере с 1 vCPU, и docker
  # тогда не создает контейнер. Если в .env лимит не задан — не больше числа процессоров
  if [ -z "$(env_value CAPPER_API_CPUS)" ] && [ -z "${CAPPER_API_CPUS:-}" ] && [ "$(nproc)" -lt 2 ]; then
    export CAPPER_API_CPUS=1
    log "процессор один: лимит api — CAPPER_API_CPUS=1"
  fi

  remember_images

  log "сборка образов"
  local build_args=()
  [ "$pull" = 1 ] && build_args+=(--pull)
  compose build "${build_args[@]}" || fail "сборка образов не удалась"
  if [ "$pull" = 1 ]; then
    compose pull --quiet postgres redis || fail "не удалось скачать образы postgres и redis" \
      "(Docker Hub недоступен? повторите с --no-pull)"
  fi

  log "PostgreSQL, Redis и бэкап"
  compose up -d --wait postgres redis || fail "PostgreSQL или Redis не запустились"
  # Контейнер backup — сразу с новыми образом и настройками: копию перед миграциями
  # снимает уже он. Его здоровья не ждем: прошлый сбой бэкапа не должен мешать деплою
  compose up -d --no-deps backup || fail "контейнер backup не запустился"

  if [ "$backup" = 1 ] && [ -z "$(env_value BACKUP_AGE_RECIPIENTS)" ]; then
    log "ВНИМАНИЕ: бэкапы не настроены (BACKUP_AGE_RECIPIENTS в deploy/.env)," \
      "копия перед миграциями не снимается"
  elif [ "$backup" = 1 ]; then
    log "копия базы перед миграциями"
    compose exec -T backup backup.sh --manual \
      || fail "копия базы не создана, деплой остановлен (без копии: --no-backup)"
  fi

  log "миграции"
  if ! migrate; then
    show_failure
    fail "миграции не применились"
  fi

  log "перезапуск сервисов"
  if ! compose up -d --remove-orphans \
    || ! compose up -d --wait --wait-timeout 180 api worker caddy; then
    show_failure
    fail "сервисы не стали здоровыми за 3 минуты"
  fi

  log "проверка https://$DOMAIN/api/health"
  if ! check_health "$DOMAIN" "$version"; then
    show_failure
    fail "приложение не отвечает через Caddy. Проверьте DNS домена и сертификат:" \
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
