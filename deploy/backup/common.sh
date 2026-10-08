# shellcheck shell=bash
# Общие функции скриптов бэкапа. Подключается из backup.sh, restore.sh, restore-check.sh
# и healthcheck.sh: . /usr/local/bin/common.sh
#
# Настройки — переменные окружения контейнера backup (deploy/docker-compose.yml,
# значения из deploy/.env):
#   PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE   рабочая база
#   BACKUP_AGE_RECIPIENTS   публичные ключи age (age1...), через запятую или пробел
#   BACKUP_AGE_IDENTITY     секретный ключ age (AGE-SECRET-KEY-1...): нужен для проверки
#                           восстановления и для restore.sh
#   BACKUP_KEEP_DAILY / _WEEKLY / _MONTHLY / _MANUAL   сколько копий хранить
#   BACKUP_S3_*             S3-совместимое хранилище (необязательно)

BACKUP_DIR="${BACKUP_DIR:-/backups}"
STATUS_DIR="$BACKUP_DIR/.status"
TIERS=(daily weekly monthly manual)
DUMP_SUFFIX=".dump.age"
S3_REMOTE="s3backup"

# Сообщения — в stderr: stdout остается для данных (restore.sh --list, age-keygen)
log() {
  printf '%s [%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${SCRIPT_NAME:-backup}" "$*" >&2
}

warn() {
  log "ВНИМАНИЕ: $*"
}

die() {
  log "ОШИБКА: $*"
  exit 1
}

keep_count() {
  case "$1" in
    daily) echo "${BACKUP_KEEP_DAILY:-7}" ;;
    weekly) echo "${BACKUP_KEEP_WEEKLY:-4}" ;;
    monthly) echo "${BACKUP_KEEP_MONTHLY:-6}" ;;
    manual) echo "${BACKUP_KEEP_MANUAL:-5}" ;;
    *) die "неизвестный вид копий: $1" ;;
  esac
}

# Аргументы -r для age из BACKUP_AGE_RECIPIENTS (через запятую, пробел или перевод строки)
age_recipient_args() {
  local raw="${BACKUP_AGE_RECIPIENTS:-}" item
  AGE_RECIPIENT_ARGS=()
  for item in ${raw//,/ }; do
    AGE_RECIPIENT_ARGS+=(-r "$item")
  done
  [ "${#AGE_RECIPIENT_ARGS[@]}" -gt 0 ]
}

has_identity() {
  [ -n "${BACKUP_AGE_IDENTITY:-}" ]
}

# Расшифровка в stdout. Секретный ключ передается age через дескриптор, не через файл
age_decrypt() {
  age --decrypt --identity <(printf '%s\n' "$BACKUP_AGE_IDENTITY") "$1"
}

# Метка времени копии из имени файла: capper-20261008T013000Z.dump.age и
# capper-2026-W41_20261008T013000Z.dump.age дают 20261008T013000Z
dump_stamp() {
  local base
  base="$(basename "$1" "$DUMP_SUFFIX")"
  printf '%s\n' "${base##*[-_]}"
}

# 20261008T013000Z → 2026-10-08T01:30:00Z (для SQL)
stamp_to_iso() {
  local s="$1"
  printf '%s-%s-%sT%s:%s:%sZ\n' "${s:0:4}" "${s:4:2}" "${s:6:2}" "${s:9:2}" "${s:11:2}" "${s:13:2}"
}

# Файлы копий вида копий, старые первыми
list_tier() {
  local dir="$BACKUP_DIR/$1"
  [ -d "$dir" ] || return 0
  find "$dir" -maxdepth 1 -type f -name "*$DUMP_SUFFIX" | sort
}

# Самая свежая копия среди всех видов (по метке времени в имени)
latest_dump() {
  local tier file best="" best_stamp="" stamp
  for tier in "${TIERS[@]}"; do
    while IFS= read -r file; do
      [ -n "$file" ] || continue
      stamp="$(dump_stamp "$file")"
      if [[ -z "$best" || "$stamp" > "$best_stamp" ]]; then
        best="$file"
        best_stamp="$stamp"
      fi
    done < <(list_tier "$tier")
  done
  printf '%s\n' "$best"
}

# Удаляет старые локальные копии сверх лимита
prune_local() {
  local tier="$1" keep files count i
  keep="$(keep_count "$tier")"
  mapfile -t files < <(list_tier "$tier")
  count="${#files[@]}"
  for ((i = 0; i < count - keep; i++)); do
    rm -f -- "${files[$i]}"
    log "удалена старая копия $tier/$(basename "${files[$i]}")"
  done
}

s3_enabled() {
  [ -n "${BACKUP_S3_BUCKET:-}" ] && [ -n "${BACKUP_S3_ENDPOINT:-}" ] \
    && [ -n "${BACKUP_S3_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_S3_SECRET_ACCESS_KEY:-}" ]
}

# rclone настраивается переменными окружения, без файла с ключами на диске
s3_setup() {
  export RCLONE_CONFIG=/dev/null
  export RCLONE_CONFIG_S3BACKUP_TYPE=s3
  export RCLONE_CONFIG_S3BACKUP_PROVIDER="${BACKUP_S3_PROVIDER:-Other}"
  export RCLONE_CONFIG_S3BACKUP_ENDPOINT="$BACKUP_S3_ENDPOINT"
  export RCLONE_CONFIG_S3BACKUP_REGION="${BACKUP_S3_REGION:-}"
  export RCLONE_CONFIG_S3BACKUP_ACCESS_KEY_ID="$BACKUP_S3_ACCESS_KEY_ID"
  export RCLONE_CONFIG_S3BACKUP_SECRET_ACCESS_KEY="$BACKUP_S3_SECRET_ACCESS_KEY"
  # Ключу хватает прав на запись в существующий бакет, создавать бакеты не нужно
  export RCLONE_CONFIG_S3BACKUP_NO_CHECK_BUCKET=true
  # Итоговую статистику передачи в лог не выводить
  export RCLONE_STATS_LOG_LEVEL=DEBUG
}

# Путь в хранилище: s3backup:<бакет>/<префикс>/<вид>
s3_path() {
  local prefix="${BACKUP_S3_PREFIX:-capper}"
  printf '%s:%s/%s/%s\n' "$S3_REMOTE" "$BACKUP_S3_BUCKET" "${prefix%/}" "$1"
}

# Удаляет старые копии в хранилище сверх лимита. Считает по списку в самом хранилище,
# поэтому потеря локального тома не стирает копии в S3
prune_s3() {
  local tier="$1" keep files count i
  keep="$(keep_count "$tier")"
  mapfile -t files < <(rclone lsf --files-only --include "*$DUMP_SUFFIX" "$(s3_path "$tier")" | sort)
  count="${#files[@]}"
  for ((i = 0; i < count - keep; i++)); do
    rclone deletefile "$(s3_path "$tier")/${files[$i]}"
    log "удалена старая копия в S3: $tier/${files[$i]}"
  done
}

# Блокировка на время бэкапа и проверок: копия и проверка не идут одновременно.
# acquire_lock <номер дескриптора> <сколько секунд ждать>; дескриптор открыт заранее:
#   exec 9> "$BACKUP_DIR/.lock"
# (у flock из busybox нет ожидания с таймаутом, поэтому повторы)
acquire_lock() {
  local fd="$1" limit="$2" waited=0
  until flock -n "$fd"; do
    [ "$waited" -lt "$limit" ] || return 1
    sleep 5
    waited=$((waited + 5))
  done
}

mark_status() {
  # mark_status <backup|restore-check> <ok|failed> <текст>
  mkdir -p "$STATUS_DIR"
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$3" > "$STATUS_DIR/$1.$2"
}
