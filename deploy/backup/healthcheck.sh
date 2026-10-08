#!/usr/bin/env bash
# Healthcheck контейнера backup: нездоров, если последняя попытка бэкапа или проверки
# восстановления упала либо успешной копии нет дольше 26 часов (ночной cron не сработал).
# Состояние видно в docker compose ps; причины — в docker compose logs backup.
set -uo pipefail
# shellcheck source=common.sh
. "$(dirname "$0")/common.sh"

max_age=$((26 * 3600))
now="$(date +%s)"

mtime() {
  if [ -f "$1" ]; then stat -c %Y "$1"; else echo 0; fi
}

ok="$(mtime "$STATUS_DIR/backup.ok")"
failed="$(mtime "$STATUS_DIR/backup.failed")"
if [ "$failed" -gt "$ok" ]; then
  echo "последний бэкап упал: $(cat "$STATUS_DIR/backup.failed")"
  exit 1
fi
reference="$ok"
if [ "$reference" = 0 ]; then
  reference="$(cat /tmp/backup-started 2> /dev/null || echo "$now")"
fi
if [ $((now - reference)) -gt "$max_age" ]; then
  echo "нет успешного бэкапа больше 26 часов"
  exit 1
fi

if [ "$(mtime "$STATUS_DIR/restore-check.failed")" -gt "$(mtime "$STATUS_DIR/restore-check.ok")" ]; then
  echo "проверка восстановления не прошла: $(cat "$STATUS_DIR/restore-check.failed")"
  exit 1
fi
exit 0
