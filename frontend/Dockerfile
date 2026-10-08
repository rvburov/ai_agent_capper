# Образ веб-сервера: Caddy с готовой статикой интерфейса и deploy/Caddyfile.
# Интерфейс собирается внутри образа Caddy (многоэтапная сборка): отдельного
# контейнера и общего тома со статикой нет, поэтому после деплоя не бывает старой
# статики при новом API, а откат образа откатывает и интерфейс, и настройки Caddy.
#
# Caddyfile лежит в deploy/ и приходит вторым контекстом сборки "deploy"
# (в compose — build.additional_contexts). Из него копируется только Caddyfile.
# Сборка без compose, из корня репозитория:
#   docker build --build-context deploy=deploy -f frontend/Dockerfile frontend

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM caddy:2.11-alpine
COPY --from=deploy Caddyfile /etc/caddy/Caddyfile
# Ошибка в Caddyfile ломает сборку образа, а не запуск на сервере
RUN CAPPER_DOMAIN=localhost caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
 && rm -rf /data/caddy /config/caddy
COPY --from=build /app/dist /srv
