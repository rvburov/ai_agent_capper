#!/usr/bin/env bash
# Проверка восстановления (раз в месяц по cron, 1-го числа в 02:30 UTC, и вручную):
# последняя копия расшифровывается и восстанавливается во временный PostgreSQL внутри
# контейнера backup, затем число пользователей, ставок, записей журнала банка и сумма
# журнала по валютам сверяются с рабочей базой. Бэкап, который ни разу не
# восстанавливали, считается непроверенным (PLAN.md, раздел 5).
#
#   restore-check.sh             самая свежая копия
#   restore-check.sh <файл>      конкретная копия (путь или имя в /backups/<вид>/)
#
# Сверяются строки, созданные не позже момента копии (метка времени в имени файла):
# новые ставки после бэкапа расхождением не считаются. Расхождение бывает и честным:
# между копией и проверкой удалили участника (Р15) или сменили валюту программы (Р17).
# Временный сервер слушает только свой сокет и удаляется после проверки.
set -Eeuo pipefail
SCRIPT_NAME=restore-check
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

umask 077
mkdir -p "$STATUS_DIR"

work=""
finished=0
on_exit() {
  if [ -n "$work" ] && [ -d "$work" ]; then
    gosu postgres pg_ctl --pgdata="$work/data" --mode=immediate stop > /dev/null 2>&1 || true
    rm -rf -- "$work"
  fi
  if [ "$finished" != 1 ]; then
    mark_status restore-check failed "проверка восстановления не прошла, подробности в логе"
  fi
}
trap on_exit EXIT

has_identity || die "не задан BACKUP_AGE_IDENTITY: без секретного ключа age копию не расшифровать"

exec 9> "$BACKUP_DIR/.lock"
acquire_lock 9 3600 || die "бэкап идет больше часа, проверка отложена"

file="${1:-}"
if [ -z "$file" ]; then
  file="$(latest_dump)"
  [ -n "$file" ] || die "в $BACKUP_DIR нет ни одной копии"
elif [ ! -f "$file" ]; then
  found="$(find "$BACKUP_DIR" -mindepth 2 -maxdepth 2 -type f -name "$(basename "$file")" | head -n 1)"
  [ -n "$found" ] || die "копия $file не найдена"
  file="$found"
fi
stamp="$(dump_stamp "$file")"
[[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "в имени $file нет метки времени копии"
at="$(stamp_to_iso "$stamp")"
log "проверяю копию ${file#"$BACKUP_DIR"/} (снята $at)"

work="$(mktemp -d /tmp/restore-check.XXXXXX)"
chown postgres:postgres "$work"
# Вывод временного сервера — в файлы; в лог контейнера только при сбое
if ! gosu postgres initdb --pgdata="$work/data" --username=postgres --auth=trust \
  --encoding=UTF8 --locale=C --no-sync > "$work/initdb.log" 2>&1; then
  cat "$work/initdb.log" >&2
  die "не удалось создать временный сервер PostgreSQL"
fi
if ! gosu postgres pg_ctl --pgdata="$work/data" --log="$work/server.log" --wait --silent \
  --options="-c listen_addresses='' -c unix_socket_directories='$work' -c fsync=off" start; then
  cat "$work/server.log" >&2
  die "временный сервер PostgreSQL не запустился"
fi
local_psql() {
  psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
    --host="$work" --username=postgres "$@"
}
local_psql --dbname=postgres --command="CREATE DATABASE restored"

# Копия расшифровывается потоком прямо в pg_restore; повреждение файла age обнаружит сам
age_decrypt "$file" | pg_restore --host="$work" --username=postgres --dbname=restored \
  --no-owner --no-privileges --exit-on-error
log "копия восстановлена во временную базу"

summary_sql="
SELECT concat_ws(' | ',
  'пользователей ' || (SELECT count(*) FROM users WHERE created_at <= '$at'),
  'ставок ' || (SELECT count(*) FROM bets WHERE created_at <= '$at'),
  'записей журнала банка ' || (SELECT count(*) FROM bankroll_ledger WHERE created_at <= '$at'),
  'банк ' || coalesce((
    SELECT string_agg(currency || ' ' || total, ', ' ORDER BY currency)
    FROM (SELECT currency, sum(amount) AS total FROM bankroll_ledger
          WHERE created_at <= '$at' GROUP BY currency) AS by_currency
  ), 'пусто'),
  'миграция ' || (SELECT string_agg(version_num, ',') FROM alembic_version)
)"

restored="$(local_psql --dbname=restored --command="$summary_sql")"
live="$(psql --no-psqlrc --quiet --tuples-only --no-align --set=ON_ERROR_STOP=1 \
  --command="$summary_sql")"
log "копия:        $restored"
log "рабочая база: $live"

# Номер миграции может вырасти после деплоя: сравниваются только данные
if [ "${restored% | миграция *}" != "${live% | миграция *}" ]; then
  die "данные копии не совпадают с рабочей базой. Если после копии удаляли участника или" \
    "меняли валюту, это ожидаемо: запустите проверку на свежей копии (backup.sh, затем" \
    "restore-check.sh). Иначе копия неполная — разберитесь до следующей ночи"
fi

mark_status restore-check ok "${file#"$BACKUP_DIR"/}: $restored"
finished=1
log "проверка восстановления пройдена"
