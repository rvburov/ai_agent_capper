#!/usr/bin/env bash
# AI Capper на своем компьютере, без сервера и домена: весь стек в Docker на https://localhost.
#
#   bash deploy/local.sh up                 собрать и запустить (первый раз 5–10 минут)
#   bash deploy/local.sh admin EMAIL [ИМЯ]  создать администратора (пароль спросит)
#   bash deploy/local.sh cli КОМАНДА ...    любая команда терминала: reset-code, reset-2fa, ...
#   bash deploy/local.sh import EMAIL ФАЙЛ [ПАПКА_ИГРОКОВ] [--dry-run]
#                                           импорт истории старого бота
#   bash deploy/local.sh data [--full] [--years ГОДЫ] [--sackmann-dir ПАПКА]
#                             [--tennis-data-dir ПАПКА] [--skip-elo]
#                                           архивы матчей и кэфов, привязка старого бота, Эло;
#                                           первый раз — с --full. tennis-data.co.uk закрыт от
#                                           программ: файлы ГОД.xlsx скачать в браузере в папку
#   bash deploy/local.sh backtest [--test-years 2024,2025]
#                                           бэктест модели: отчет в deploy/reports/backtest-ДАТА.md
#   bash deploy/local.sh acceptance-runs [--count 20] [--yes]
#                                           приемка этапа 3: 20 анализов на ключе администратора
#                                           (оценка ≈ $12, по живым ценам ≈ $8, худший случай $20;
#                                           общий бюджет); отчет — deploy/reports/acceptance-runs-ДАТА.md
#   bash deploy/local.sh smoke-eval [--events 40] [--since 2026-08-01] [--yes] [--no-wait]
#   bash deploy/local.sh smoke-eval --resume ID | --abandon ID
#                                           оценка Claude через Batch API (оценка ≈ $2,30, по живым
#                                           ценам ≈ $0,50–0,60, худший случай ≈ $8; бюджет проверок);
#                                           отчет — deploy/reports/smoke-eval-ДАТА.md
#   bash deploy/local.sh parse-eval --file ПАРЫ.json [--yes]
#   bash deploy/local.sh parse-eval --draft --from-telegram result.json --out ПАРЫ.json
#                                           разбор эталонных сообщений (отчет — parse-eval-ДАТА.md)
#                                           или черновик эталона из экспорта Telegram Desktop
#                                           Коды команд приемки: 0 — пройдена, 1 — нет, 2 — отменено,
#                                           3 — пробный прогон (выборка меньше, чем для приемки),
#                                           130 — прервано (Ctrl+C останавливает и команду в контейнере)
#   bash deploy/local.sh backup             ночной бэкап вручную и проверка восстановления
#   bash deploy/local.sh restore latest | --list | <вид>/<файл>
#                                           восстановить рабочую базу из копии
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
# Git Bash на Windows (MSYS) сам переделывает аргументы вида /tmp/... в пути Windows
# (C:/Users/.../Temp/...) и передает их docker, а внутри контейнера таких путей нет.
# Поэтому переделку отключаем, а пути этого компьютера для docker пишем сразу как C:/...
if [[ -n "${MSYSTEM:-}" ]] && command -v cygpath >/dev/null 2>&1; then
  export MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'
  DEPLOY_DIR="$(cygpath -m "$DEPLOY_DIR")"
fi
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
  local i body=""
  for i in $(seq 1 60); do
    # Мимо прокси: VPN-программы прописывают в системе прокси (HTTPS_PROXY и т. п.),
    # а сайт работает на этом же компьютере
    body="$(curl -sSk --noproxy '*' --max-time 3 "$URL/api/health" 2>&1 || true)"
    if [[ "$body" == *'"status":"ok"'* ]]; then
      printf '%s\n' "$body"
      return
    fi
    sleep 2
  done
  dc ps
  printf 'Последний ответ: %s\n' "${body:-пусто}" >&2
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
  dc run --rm --no-deps api alembic upgrade head
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

# Папка запуска data в контейнере: у каждого запуска своя, чтобы второй запуск (например,
# повтор в другом окне) не удалил и не подменил файлы первого
DATA_TMP=""

data_cleanup() {
  [[ -n "$DATA_TMP" ]] && dc exec -T api rm -rf "$DATA_TMP" >/dev/null 2>&1 || true
}

cmd_data() {
  local args=() name
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --full|--skip-elo) args+=("$1"); shift ;;
      --years)
        [[ $# -ge 2 ]] || die "укажите годы: --years 2025 или --years 2020-2026"
        args+=(--years "$2"); shift 2 ;;
      --sackmann-dir|--tennis-data-dir)
        [[ $# -ge 2 ]] || die "укажите папку: $1 ПАПКА"
        [[ -d "$2" ]] || die "нет папки $2"
        if [[ -z "$DATA_TMP" ]]; then
          # /tmp контейнера — tmpfs, docker cp туда не пишет: папки передаются через tar
          DATA_TMP="$(dc exec -T api mktemp -d /tmp/data.XXXXXX)"
          [[ "$DATA_TMP" == /tmp/data.* ]] || die "не удалось создать временную папку в контейнере api"
          trap data_cleanup EXIT
        fi
        name="${1#--}"; name="${name%-dir}"
        dc exec -T api mkdir -p "$DATA_TMP/$name"
        # COPYFILE_DISABLE: tar на macOS не добавляет служебные файлы ._*
        COPYFILE_DISABLE=1 tar -C "$2" -cf - . | dc exec -T api tar -C "$DATA_TMP/$name" -xf -
        args+=("$1" "$DATA_TMP/$name"); shift 2 ;;
      *) die "неизвестный ключ $1. Справка: bash deploy/local.sh" ;;
    esac
  done
  dc exec -T api python -m app.ingest.update ${args[@]+"${args[@]}"}
}

cmd_backtest() {
  local report
  report="$DEPLOY_DIR/reports/backtest-$(date +%F).md"
  mkdir -p "$DEPLOY_DIR/reports"
  # Отчет целиком идет в stdout — в файл на этом компьютере, короткий вывод — на экран
  if ! dc exec -T api python -m app.ml.backtest --report - "$@" > "$report.tmp"; then
    rm -f "$report.tmp"
    die "бэктест не выполнен, причина — в выводе выше"
  fi
  mv "$report.tmp" "$report"
  printf '\nОтчет: %s\n' "$report"
}

# Папка команды приемки в контейнере: у каждого запуска своя, как у data
RUN_TMP=""

run_cleanup() {
  [[ -n "$RUN_TMP" ]] && dc exec -T api rm -rf "$RUN_TMP" >/dev/null 2>&1 || true
}

run_tmp() {
  [[ -n "$RUN_TMP" ]] && return
  RUN_TMP="$(dc exec -T api mktemp -d /tmp/run.XXXXXX)"
  [[ "$RUN_TMP" == /tmp/run.* ]] || die "не удалось создать временную папку в контейнере api"
  trap run_cleanup EXIT
}

# Свободное имя отчета: deploy/reports/ИМЯ-ДАТА.md, если оно занято — ИМЯ-ДАТА-2.md и т. д.
# (второй запуск за день не стирает первый отчет)
report_path() {
  local base n=2 path
  base="$DEPLOY_DIR/reports/$1-$(date +%F)"
  mkdir -p "$DEPLOY_DIR/reports"
  path="$base.md"
  while [[ -e "$path" ]]; do path="$base-$n.md"; n=$((n + 1)); done
  printf '%s' "$path"
}

# Команда терминала в контейнере с pid в файле: Ctrl+C без терминала (Git Bash в mintty,
# вывод через | tee) docker до команды не доносит — выходит только docker, а команда в
# контейнере шла бы дальше и тратила деньги. Тогда ее останавливает stop_run
run_cli() {
  local status=0
  trap 'true' INT TERM
  dc exec api sh -c 'echo $$ > "$1"; shift; exec python -m app.admin.cli "$@"' \
    sh "$RUN_TMP/pid" "$@" || status=$?
  stop_run
  trap - INT TERM
  return "$status"
}

# Команда из run_cli еще идет (docker вышел по Ctrl+C) — Ctrl+C ей самой и ждем конца
# (до 2 минут): она дописывает отчет по законченному
stop_run() {
  dc exec -T api sh -c '
    pid="$(cat "$1" 2>/dev/null)" || exit 0
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || exit 0
    grep -q app.admin.cli "/proc/$pid/cmdline" 2>/dev/null || exit 0
    echo "Останавливаю команду в контейнере…" >&2
    kill -INT "$pid"
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 120 ]; do sleep 1; i=$((i + 1)); done
  ' sh "$RUN_TMP/pid" || true
}

# Код команды приемки → строка и выход (код тот же). Отказ и пробный прогон — не ошибка:
# свой текст команда уже напечатала
finish() {
  case "$2" in
    0) ;;
    2) exit 2 ;;
    3) printf '\n%s: пробный прогон, приемкой не считается (выборка меньше, чем в PLAN.md)\n' "$1"; exit 3 ;;
    130) printf '\n%s: прервано, команда в контейнере остановлена\n' "$1" >&2; exit 130 ;;
    *) die "$1: критерий не выполнен или команда не выполнена (код $2), причина — в выводе выше" ;;
  esac
}

# Команда приемки: вопросы и прогресс — на экран (терминал контейнера), отчет — во
# временную папку контейнера, оттуда в deploy/reports/. Отчет сохраняется и тогда, когда
# критерий не выполнен (код 1) или серию прервали (код 130)
cmd_acceptance() {
  local name="$1" status=0 report
  shift
  run_tmp
  run_cli "$name" --local-sh --report "$RUN_TMP/report.md" "$@" || status=$?
  if dc exec -T api test -s "$RUN_TMP/report.md"; then
    report="$(report_path "$name")"
    dc exec -T api cat "$RUN_TMP/report.md" > "$report"
    printf '\nОтчет: %s\n' "$report"
  fi
  finish "$name" "$status"
}

# parse-eval: файлы этого компьютера (эталон, экспорт Telegram) передаются в контейнер
# через stdin, черновик (--out) копируется обратно. В выводе и отчете — имена файлов, как
# их указал владелец (--file-label, --out-label), а не пути в контейнере
cmd_parse_eval() {
  local args=() out="" status=0
  run_tmp
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --file|--from-telegram)
        [[ $# -ge 2 ]] || die "укажите файл: $1 ФАЙЛ"
        [[ -f "$2" ]] || die "нет файла $2"
        dc exec -T api sh -c 'cat > "$1"' sh "$RUN_TMP/${1#--}.json" < "$2"
        args+=("$1" "$RUN_TMP/${1#--}.json" --file-label "$2"); shift 2 ;;
      --out)
        [[ $# -ge 2 ]] || die "укажите файл: --out ФАЙЛ"
        out="$2"; args+=(--out "$RUN_TMP/out.json" --out-label "$2"); shift 2 ;;
      *) args+=("$1"); shift ;;
    esac
  done
  if [[ -z "$out" ]]; then
    cmd_acceptance parse-eval ${args[@]+"${args[@]}"}
    return
  fi
  run_cli parse-eval --local-sh ${args[@]+"${args[@]}"} || status=$?
  [[ "$status" == 0 ]] || finish parse-eval "$status"
  dc exec -T api cat "$RUN_TMP/out.json" > "$out"
}

cmd_backup() {
  dc exec backup backup.sh
  dc exec backup restore-check.sh
}

cmd_restore() {
  [[ $# -ge 1 ]] || die "какую копию? bash deploy/local.sh restore --list | latest | <вид>/<файл>"
  if [[ "$1" == --list ]]; then
    dc exec backup restore.sh --list
    return
  fi
  say "Останавливаю api и воркер"
  dc stop api worker
  local status=0
  dc exec backup restore.sh "$@" || status=$?
  # Миграции применит сервис migrate (копия могла быть снята до новых миграций)
  say "Миграции и запуск"
  dc up -d
  wait_health
  [[ "$status" == 0 ]] || die "восстановление не выполнено (код $status), причина — в выводе restore.sh выше"
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
  data) shift; cmd_data "$@" ;;
  backtest) shift; cmd_backtest "$@" ;;
  acceptance-runs|smoke-eval) name="$1"; shift; cmd_acceptance "$name" "$@" ;;
  parse-eval) shift; cmd_parse_eval "$@" ;;
  backup) cmd_backup ;;
  restore) shift; cmd_restore "$@" ;;
  status) dc ps ;;
  logs) shift; dc logs -f --tail 200 "$@" ;;
  down) dc down ;;
  wipe) cmd_wipe ;;
  *) sed -n '2,42p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
