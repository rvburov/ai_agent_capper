#!/usr/bin/env bash
# Восстановление рабочей базы из копии. Стирает текущую базу целиком, поэтому:
# сначала остановить api и worker, перед удалением снимается копия текущей базы
# (manual/), а копия для восстановления сначала целиком расшифровывается и читается.
#
#   restore.sh --list                       копии в томе и в S3
#   restore.sh latest                       самая свежая локальная копия
#   restore.sh daily/capper-20261008T013000Z.dump.age
#   restore.sh s3:monthly/capper-2026-10_20261001T013000Z.dump.age   скачать из S3
#   --yes                                   не спрашивать подтверждение
#   --no-safety-copy                        не снимать копию текущей базы (если она сломана)
#
# Запуск (из папки deploy на сервере):
#   docker compose stop api worker
#   docker compose exec backup restore.sh latest
#   docker compose run --rm api alembic upgrade head
#   docker compose start api worker
set -Eeuo pipefail
SCRIPT_NAME=restore
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

list_copies() {
  local tier file
  for tier in "${TIERS[@]}"; do
    while IFS= read -r file; do
      [ -n "$file" ] && printf '%s/%s  %s\n' "$tier" "$(basename "$file")" "$(du -h "$file" | cut -f1)"
    done < <(list_tier "$tier")
  done
  if s3_enabled; then
    s3_setup
    echo "--- в S3 ($(s3_path "")):"
    for tier in "${TIERS[@]}"; do
      rclone lsf --files-only --include "*$DUMP_SUFFIX" "$(s3_path "$tier")" 2> /dev/null \
        | sort | sed "s|^|s3:$tier/|"
    done
  fi
}

source_arg=""
assume_yes=0
safety_copy=1
for arg in "$@"; do
  case "$arg" in
    --list) list_copies; exit 0 ;;
    --yes) assume_yes=1 ;;
    --no-safety-copy) safety_copy=0 ;;
    -*) die "неизвестный ключ: $arg" ;;
    *) source_arg="$arg" ;;
  esac
done
[ -n "$source_arg" ] || die "какую копию восстановить? restore.sh --list покажет список"
has_identity || die "не задан BACKUP_AGE_IDENTITY: без секретного ключа age копию не расшифровать"

umask 077
work="$(mktemp -d /tmp/restore.XXXXXX)"
trap 'rm -rf -- "$work"' EXIT

# Откуда берем копию
case "$source_arg" in
  latest)
    file="$(latest_dump)"
    [ -n "$file" ] || die "в $BACKUP_DIR нет копий; копия из S3: restore.sh s3:<вид>/<файл>"
    ;;
  s3:*)
    s3_enabled || die "S3 не настроен (BACKUP_S3_*)"
    s3_setup
    remote="${source_arg#s3:}"
    file="$work/$(basename "$remote")"
    log "скачиваю $remote из S3"
    rclone copyto "$(s3_path "$(dirname "$remote")")/$(basename "$remote")" "$file"
    ;;
  *)
    if [ -f "$source_arg" ]; then
      file="$source_arg"
    elif [ -f "$BACKUP_DIR/$source_arg" ]; then
      file="$BACKUP_DIR/$source_arg"
    else
      die "копия $source_arg не найдена (restore.sh --list)"
    fi
    ;;
esac

# Расшифровать и прочитать до того, как трогать рабочую базу
log "расшифровываю ${file#"$BACKUP_DIR"/}"
age_decrypt "$file" > "$work/restore.dump"
pg_restore --list "$work/restore.dump" > /dev/null
log "копия цела: $(du -h "$work/restore.dump" | cut -f1) после расшифровки"

others="$(psql --no-psqlrc --tuples-only --no-align --dbname=postgres --command="
  SELECT count(*) FROM pg_stat_activity
  WHERE datname = '$PGDATABASE' AND pid <> pg_backend_pid()")"
if [ "$others" != 0 ]; then
  die "к базе $PGDATABASE подключено соединений: $others. Остановите приложение:" \
    "docker compose stop api worker"
fi

if [ "$assume_yes" != 1 ]; then
  printf 'База %s на %s будет стерта и заменена копией. Введите имя базы для подтверждения: ' \
    "$PGDATABASE" "$PGHOST"
  read -r answer
  [ "$answer" = "$PGDATABASE" ] || die "отменено"
fi

if [ "$safety_copy" = 1 ]; then
  log "копия текущей базы перед восстановлением (manual/)"
  "$(dirname "$0")/backup.sh" --manual
fi

exec 8> "$BACKUP_DIR/.lock"
acquire_lock 8 3600 || die "бэкап идет больше часа, восстановление отложено"

log "пересоздаю базу $PGDATABASE"
psql --no-psqlrc --quiet --set=ON_ERROR_STOP=1 --dbname=postgres \
  --command="DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE)" \
  --command="CREATE DATABASE \"$PGDATABASE\" OWNER \"$PGUSER\""
pg_restore --dbname="$PGDATABASE" --no-owner --exit-on-error --jobs=2 "$work/restore.dump"

log "база восстановлена из ${source_arg}: $(psql --no-psqlrc --tuples-only --no-align --command="
  SELECT 'пользователей ' || (SELECT count(*) FROM users)
    || ', ставок ' || (SELECT count(*) FROM bets)
    || ', миграция ' || (SELECT string_agg(version_num, ',') FROM alembic_version)")"
log "дальше: docker compose run --rm api alembic upgrade head && docker compose start api worker"
