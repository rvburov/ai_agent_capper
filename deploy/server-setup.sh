#!/usr/bin/env bash
# Первичная настройка VPS под AI Capper: сервер в Финляндии (Р19), Ubuntu 24.04 или 26.04.
# Запускается один раз от root на чистом сервере. Повторный запуск безопасен: уже
# сделанное пропускается, так можно, например, позже добавить ключ GitHub Actions.
#
#   curl -fsSLO https://raw.githubusercontent.com/rvburov/ai_agent_capper/master/deploy/server-setup.sh
#   bash server-setup.sh --admin roman --domain capper.example.com
#
#   --admin ИМЯ        пользователь для входа владельца: sudo, ssh по ключу (обязательно)
#   --domain ДОМЕН     домен сайта, попадет в deploy/.env (CAPPER_DOMAIN)
#   --admin-key КЛЮЧ   публичный ssh-ключ владельца; без него берется ключ root,
#                      который Hetzner кладет при создании сервера
#   --ci-key КЛЮЧ      публичный ключ ed25519 только для деплоя из GitHub Actions; на
#                      сервере он может лишь запустить deploy.sh (command=..., restrict)
#   --repo URL         репозиторий (по умолчанию https://github.com/rvburov/ai_agent_capper.git;
#                      для закрытого — git@github.com:rvburov/ai_agent_capper.git)
#
# Что делает: обновления ОС и автоматические обновления безопасности
# (unattended-upgrades, перезагрузка при необходимости в 04:00 UTC), swap 2 ГБ, Docker из
# официального репозитория с ротацией логов, пользователи (владелец с sudo; deploy без
# sudo, в группе docker), ssh только по ключу и без root, файрвол ufw (22, 80, 443),
# клон репозитория в /opt/ai_agent_capper и deploy/.env со случайными паролями и ключами.
set -Eeuo pipefail

APP_DIR=/opt/ai_agent_capper
DEPLOY_USER=deploy
REPO_URL=https://github.com/rvburov/ai_agent_capper.git
REBOOT_TIME=04:00
SWAP_SIZE=2G

log() {
  printf '\n==> %s\n' "$*"
}

die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}

admin=""
domain=""
admin_key=""
ci_key=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --admin) admin="${2:?}"; shift ;;
    --domain) domain="${2:?}"; shift ;;
    --admin-key) admin_key="${2:?}"; shift ;;
    --ci-key) ci_key="${2:?}"; shift ;;
    --repo) REPO_URL="${2:?}"; shift ;;
    *) die "неизвестный аргумент: $1" ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || die "запускать от root"
[ -n "$admin" ] || die "укажите --admin <имя пользователя для входа>"
[[ "$admin" =~ ^[a-z][a-z0-9_-]{0,30}$ ]] || die "имя пользователя: строчные латинские буквы и цифры"
[ "$admin" != "$DEPLOY_USER" ] || die "имя $DEPLOY_USER занято под деплой"
# shellcheck source=/dev/null
. /etc/os-release
# Обе версии — LTS, Docker выпускает для них пакеты (noble и resolute)
[ "${ID:-}" = ubuntu ] && { [ "${VERSION_ID:-}" = "24.04" ] || [ "${VERSION_ID:-}" = "26.04" ]; } \
  || die "скрипт рассчитан на Ubuntu 24.04 или 26.04, а здесь ${PRETTY_NAME:-неизвестная система}"

export DEBIAN_FRONTEND=noninteractive

log "Обновление системы и пакеты"
apt-get update -q
apt-get -y -q -o Dpkg::Options::=--force-confold upgrade
apt-get -y -q install ca-certificates curl git openssl ufw unattended-upgrades
timedatectl set-timezone UTC

log "Автоматические обновления безопасности"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
EOF
cat > /etc/apt/apt.conf.d/52capper-unattended-upgrades <<EOF
// Ядро и библиотеки обновляются только после перезагрузки. Сервисы в docker compose
// поднимаются сами (restart: unless-stopped)
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "$REBOOT_TIME";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
EOF

log "Swap $SWAP_SIZE (сборка образов на 4 ГБ памяти)"
if ! swapon --show=NAME --noheadings | grep -q .; then
  fallocate -l "$SWAP_SIZE" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile > /dev/null
  swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -q -w vm.swappiness=10
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-capper-swap.conf
else
  echo "swap уже есть"
fi

log "Docker из официального репозитория"
if ! command -v docker > /dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update -q
  apt-get -y -q install docker-ce docker-ce-cli containerd.io docker-buildx-plugin \
    docker-compose-plugin
fi
if [ ! -f /etc/docker/daemon.json ]; then
  # Логи контейнеров с ротацией; live-restore: контейнеры живут при перезапуске dockerd
  cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "local",
  "log-opts": {"max-size": "10m", "max-file": "5"},
  "live-restore": true
}
EOF
  systemctl restart docker
fi
systemctl enable --now docker > /dev/null

log "Пользователи: $admin (sudo) и $DEPLOY_USER (docker, без sudo)"
if [ -z "$admin_key" ] && [ -s /root/.ssh/authorized_keys ]; then
  admin_key="$(grep -E '^(ssh-|ecdsa-|sk-)' /root/.ssh/authorized_keys || true)"
fi
admin_home="/home/$admin"
if [ -z "$admin_key" ] && [ ! -s "$admin_home/.ssh/authorized_keys" ]; then
  die "нет ssh-ключа владельца: передайте --admin-key \"ssh-ed25519 ...\". Без ключа после" \
    "запрета входа root на сервер будет не попасть"
fi
id "$admin" > /dev/null 2>&1 || adduser --disabled-password --gecos "" "$admin" > /dev/null
usermod -aG sudo "$admin"
# Пароля у владельца нет (вход только по ключу), поэтому sudo без пароля. Если хотите
# sudo с паролем: sudo passwd <имя> и удалите этот файл
echo "$admin ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-capper-$admin"
chmod 440 "/etc/sudoers.d/90-capper-$admin"
install -d -m 700 -o "$admin" -g "$admin" "$admin_home/.ssh"
if [ -n "$admin_key" ]; then
  touch "$admin_home/.ssh/authorized_keys"
  while IFS= read -r key; do
    [ -n "$key" ] || continue
    grep -qxF "$key" "$admin_home/.ssh/authorized_keys" || echo "$key" >> "$admin_home/.ssh/authorized_keys"
  done <<< "$admin_key"
fi
chown "$admin:$admin" "$admin_home/.ssh/authorized_keys"
chmod 600 "$admin_home/.ssh/authorized_keys"

id "$DEPLOY_USER" > /dev/null 2>&1 || adduser --disabled-password --gecos "" "$DEPLOY_USER" > /dev/null
usermod -aG docker "$DEPLOY_USER"
deploy_home="/home/$DEPLOY_USER"
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$deploy_home/.ssh"
touch "$deploy_home/.ssh/authorized_keys"
if [ -n "$ci_key" ]; then
  [[ "$ci_key" =~ ^ssh-ed25519\ [A-Za-z0-9+/=]+(\ .*)?$ ]] || die "--ci-key: нужен публичный ключ ssh-ed25519"
  key_body="$(cut -d' ' -f1-2 <<< "$ci_key")"
  # Этим ключом можно только запустить деплой: без терминала, пересылки портов и агента
  if ! grep -qF "$key_body" "$deploy_home/.ssh/authorized_keys"; then
    echo "command=\"bash $APP_DIR/deploy/deploy.sh --ssh\",restrict $ci_key" \
      >> "$deploy_home/.ssh/authorized_keys"
  fi
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$deploy_home/.ssh/authorized_keys"
chmod 600 "$deploy_home/.ssh/authorized_keys"

log "SSH: только ключи, root не входит"
# 00- в имени: sshd берет первое значение параметра, а файл 50-cloud-init.conf
# на образах Ubuntu разрешает вход по паролю
cat > /etc/ssh/sshd_config.d/00-capper.conf <<EOF
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
AuthenticationMethods publickey
MaxAuthTries 3
X11Forwarding no
AllowUsers $admin $DEPLOY_USER
EOF
sshd -t || die "ошибка в настройках sshd, вход не менялся"
systemctl restart ssh

log "Файрвол: открыты только 22, 80 и 443"
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow 22/tcp > /dev/null
ufw allow 80/tcp > /dev/null
ufw allow 443/tcp > /dev/null
# HTTP/3
ufw allow 443/udp > /dev/null
ufw --force enable > /dev/null
ufw status verbose | sed -n '1,12p'

log "Репозиторий в $APP_DIR"
install -d -m 755 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR"
as_deploy() {
  sudo -u "$DEPLOY_USER" -H "$@"
}
if [[ "$REPO_URL" == git@github.com:* ]]; then
  # Закрытый репозиторий: ключ сервера только для чтения (Deploy key в GitHub)
  read_key="$deploy_home/.ssh/github_read_ed25519"
  if [ ! -f "$read_key" ]; then
    as_deploy ssh-keygen -q -t ed25519 -N "" -C "capper-server-read" -f "$read_key"
  fi
  if [ ! -f "$deploy_home/.ssh/config" ] || ! grep -q 'Host github.com' "$deploy_home/.ssh/config"; then
    printf 'Host github.com\n  IdentityFile %s\n  IdentitiesOnly yes\n' "$read_key" \
      >> "$deploy_home/.ssh/config"
  fi
  # Ключи github.com — из API GitHub по HTTPS, а не доверием при первом подключении
  curl -fsSL https://api.github.com/meta \
    | grep -oE '"ssh-ed25519 [A-Za-z0-9+/=]+"' | tr -d '"' | sed 's/^/github.com /' \
    > "$deploy_home/.ssh/known_hosts"
  chown "$DEPLOY_USER:$DEPLOY_USER" "$deploy_home/.ssh/config" "$deploy_home/.ssh/known_hosts"
  chmod 600 "$deploy_home/.ssh/config"
fi
if [ ! -d "$APP_DIR/.git" ]; then
  if ! as_deploy git clone --quiet --branch master "$REPO_URL" "$APP_DIR"; then
    if [ -n "${read_key:-}" ]; then
      echo
      echo "Нет доступа к репозиторию. Добавьте ключ сервера в GitHub: репозиторий →"
      echo "Settings → Deploy keys → Add deploy key (без права записи):"
      echo
      cat "$read_key.pub"
      echo
      echo "и запустите этот скрипт еще раз с теми же параметрами."
      exit 2
    fi
    die "не удалось склонировать $REPO_URL"
  fi
else
  echo "репозиторий уже на месте"
fi

log "Настройки deploy/.env"
env_file="$APP_DIR/deploy/.env"
if [ ! -f "$env_file" ]; then
  install -m 600 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR/deploy/.env.example" "$env_file"
  set_env() {
    # Заменяет строку KEY=... (значения из openssl: без символов, важных для sed)
    sed -i "s|^$1=.*|$1=$2|" "$env_file"
  }
  set_env POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  set_env CAPPER_SECRET_KEY "$(openssl rand -hex 32)"
  set_env CAPPER_MASTER_KEYS "1:$(openssl rand -base64 32)"
  [ -z "$domain" ] || set_env CAPPER_DOMAIN "$domain"
  echo "создан $env_file: пароль базы, CAPPER_SECRET_KEY и CAPPER_MASTER_KEYS заполнены"
else
  echo "$env_file уже есть, не трогаю"
fi

host_key="$(cut -d' ' -f1-2 /etc/ssh/ssh_host_ed25519_key.pub)"
ip="$(hostname -I | awk '{print $1}')"
# Домен из deploy/.env, если не передан: при повторном запуске (--ci-key) его не указывают
if [ -z "$domain" ]; then
  domain="$(grep -E '^CAPPER_DOMAIN=' "$env_file" | tail -n 1 | cut -d= -f2- | tr -d '"' || true)"
  case "$domain" in localhost | *example.com) domain="" ;; esac
fi
# ssh ищет ключ сервера по имени из DEPLOY_HOST: в строке и IP, и домен
known_names="$ip${domain:+,$domain}"
log "Готово"
cat <<EOF
Дальше (подробно — deploy/README.md):
  1. Проверьте вход в новом терминале, не закрывая этот:  ssh $admin@$ip
     Root по ssh больше не входит.
  2. Сохраните строку CAPPER_MASTER_KEYS из $env_file в менеджер паролей.
  3. Ключи бэкапа и S3 — в $env_file (раздел «Бэкапы» в deploy/README.md).
  4. Команды docker compose — от пользователя $DEPLOY_USER из папки deploy:
       sudo -iu $DEPLOY_USER
       cd $APP_DIR/deploy
  5. Первый запуск:  bash deploy.sh
  6. Администратор:  docker compose exec api python -m app.admin.cli create-admin --email ВАШ_EMAIL

Секреты GitHub Actions для деплоя (Settings → Secrets and variables → Actions):
  DEPLOY_HOST          $ip${domain:+  (или $domain)}
  DEPLOY_USER          $DEPLOY_USER
  DEPLOY_KNOWN_HOSTS   $known_names $host_key
  DEPLOY_SSH_KEY       секретная часть ключа, публичную часть передайте сюда через --ci-key
EOF
