# Deploy

Все, что нужно для сервера. Наполняется на этапе 1 ([PLAN.md](../docs/PLAN.md), раздел 10).

| Файл | Что делает |
|---|---|
| `docker-compose.yml` | Сервисы: caddy, api, worker, postgres, redis |
| `Caddyfile` | HTTPS, раздача фронтенда, прокси `/api` на FastAPI |
| `backup/` | Ночной `pg_dump`, хранение копий, проверка восстановления |

Сервер — VPS в Финляндии (решение Р19), например Hetzner Cloud в Хельсинки: 2 vCPU, 4 ГБ памяти, Ubuntu LTS. Вход по SSH только по ключу, открыты порты 22, 80 и 443 (PLAN.md, раздел 7).
