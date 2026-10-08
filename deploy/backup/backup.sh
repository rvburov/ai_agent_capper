#!/usr/bin/env bash
# Бэкап рабочей базы: pg_dump -Fc, шифрование age публичными ключами, хранение
# 7 ежедневных, 4 еженедельных и 6 ежемесячных копий, выгрузка в S3-совместимое
# хранилище через rclone (если заданы BACKUP_S3_*).
#
#   backup.sh            ночная копия (cron в контейнере backup, 01:30 UTC)
#   backup.sh --manual   копия перед рискованным действием (деплой, восстановление):
#                        хранятся последние 5, в недельные и месячные не попадает
#
# Каталоги в томе /backups: daily/, weekly/, monthly/, manual/. Первая копия недели
# и месяца сохраняется и в weekly/ и monthly/ (жесткая ссылка, место не занимает).
# Незашифрованный дамп на диск не пишется: pg_dump идет в age через канал.
set -Eeuo pipefail
SCRIPT_NAME=backup
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

tier=daily
case "${1:-}" in
  "") ;;
  --manual) tier=manual ;;
  *) die "неизвестный аргумент: $1 (есть только --manual)" ;;
esac

umask 077
mkdir -p "$BACKUP_DIR"/{daily,weekly,monthly,manual} "$STATUS_DIR"

tmp=""
finished=0
on_exit() {
  [ -n "$tmp" ] && rm -f -- "$tmp"
  if [ "$finished" != 1 ]; then
    mark_status backup failed "копия $tier: сбой, подробности в логе контейнера backup"
  fi
}
trap on_exit EXIT

exec 9> "$BACKUP_DIR/.lock"
acquire_lock 9 3600 || die "другой бэкап или проверка восстановления идет больше часа"

age_recipient_args || die "не задан BACKUP_AGE_RECIPIENTS: без публичного ключа age бэкап не делается"

# Две копии в одну секунду (ручной запуск сразу после ночного) не должны совпасть по имени
while :; do
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  name="capper-$stamp$DUMP_SUFFIX"
  target="$BACKUP_DIR/$tier/$name"
  [ -e "$target" ] || break
  sleep 1
done
tmp="$BACKUP_DIR/$tier/.tmp-$name"

log "копия $tier: база $PGDATABASE на $PGHOST"
pg_dump --format=custom --no-password | age --encrypt "${AGE_RECIPIENT_ARGS[@]}" > "$tmp"
mv -- "$tmp" "$target"
tmp=""
size="$(du -h "$target" | cut -f1)"

# Проверка, что копия читается: целиком расшифровать и прочитать оглавление архива.
# Без секретного ключа — только заголовок age
if has_identity; then
  listing="$(age_decrypt "$target" | pg_restore --list)"
  log "копия читается: $(grep -c ' TABLE DATA ' <<< "$listing" || true) таблиц с данными"
else
  [ "$(head -c 21 "$target")" = "age-encryption.org/v1" ] || die "файл $target не похож на зашифрованную копию"
  warn "нет BACKUP_AGE_IDENTITY: копия проверена только по заголовку"
fi
log "готово: $tier/$name ($size)"

# Первая копия недели и месяца остается в weekly/ и monthly/
if [ "$tier" = daily ]; then
  week="$(date -u +%G-W%V)"
  month="$(date -u +%Y-%m)"
  for pair in "weekly:$week" "monthly:$month"; do
    kind="${pair%%:*}"
    label="${pair#*:}"
    if ! compgen -G "$BACKUP_DIR/$kind/capper-${label}_*$DUMP_SUFFIX" > /dev/null; then
      copy="$BACKUP_DIR/$kind/capper-${label}_$stamp$DUMP_SUFFIX"
      ln -- "$target" "$copy" 2> /dev/null || cp -- "$target" "$copy"
      log "копия сохранена как $kind/$(basename "$copy")"
    fi
  done
fi

for kind in daily weekly monthly manual; do
  prune_local "$kind"
done

# В хранилище догружается все, чего там еще нет: новая копия и то, что не ушло в прошлый
# раз (сбой сети, S3 настроили позже). Удаления в S3 — только по его собственному списку
if s3_enabled; then
  s3_setup
  for kind in "${TIERS[@]}"; do
    rclone copy --ignore-existing --include "capper-*$DUMP_SUFFIX" \
      "$BACKUP_DIR/$kind" "$(s3_path "$kind")"
    prune_s3 "$kind"
  done
  log "S3: копии выгружены в $(s3_path "")"
else
  warn "S3 не настроен (BACKUP_S3_*): копии только на этом сервере. Сбой диска или" \
    "сервера унесет и базу, и бэкапы"
fi

mark_status backup ok "$tier/$name $size"
finished=1
