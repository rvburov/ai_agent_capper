#!/usr/bin/env bash
# Запуск контейнера backup: проверка настроек, затем cron (crond -f).
# Расписание — /etc/crontabs/root (deploy/backup/crontab), время UTC.
# Другие команды (age-keygen, restore.sh через docker compose run) запускаются как есть.
set -Eeuo pipefail
if [ "${1:-}" != crond ]; then
  exec "$@"
fi
SCRIPT_NAME=backup-start
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

umask 077
mkdir -p "$BACKUP_DIR"/{daily,weekly,monthly,manual} "$STATUS_DIR"
chmod 700 "$BACKUP_DIR"
# Отсчет для healthcheck: до первой ночной копии контейнер считается здоровым 26 часов
date +%s > /tmp/backup-started

age_recipient_args || warn "не задан BACKUP_AGE_RECIPIENTS: ночной бэкап не будет создан"
has_identity || warn "не задан BACKUP_AGE_IDENTITY: проверка восстановления не сможет" \
  "расшифровать копии"
if s3_enabled; then
  log "S3: $(s3_path "")"
else
  warn "S3 не настроен (BACKUP_S3_*): копии только на этом сервере"
fi
log "расписание (UTC): $(grep -v '^#' /etc/crontabs/root | grep -v '^$' | cut -d' ' -f1-6 \
  | tr '\n' ';')"

exec "$@"
