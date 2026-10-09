# AI Capper

Веб-приложение для аналитики теннисных ставок. Участник вводит матчи и кэфы, система собирает данные об игроках, считает вероятности, а Claude добавляет контекст и объяснение. Банк, ставки, прибыльность и калибровка прогнозов — в таблицах и графиках. Модель учится на своих результатах. Доступ — закрытый круг участников по приглашению.

**Статус:** этап 1 закрыт 8 октября 2026: вход с 2FA, регистрация по приглашению, сброс пароля, личный кабинет, кабинет администратора, импорт истории старого бота, docker и бэкапы. Код этапа 2 готов 9 октября: загрузка архивов матчей и кэфов, сопоставление игроков, Эло по покрытиям и бэктест против рынка. Осталось прогнать его на настоящих данных (ниже) и по отчету решить, нужен ли платный API ([план работ](docs/PLAN.md#10-дорожная-карта)). Сервера пока нет — приложение запускается на своем компьютере.

| Что | Где |
|---|---|
| Кликабельный макет интерфейса | [mockup/](mockup/README.md) |
| План, решения владельца, архитектура, этапы | [docs/PLAN.md](docs/PLAN.md) (раздел 0 главнее остального) |
| Экономия токенов Claude | [docs/TOKEN_ECONOMY.md](docs/TOKEN_ECONOMY.md) |
| Как модель учится на ставках | [docs/LLM_LEARNING.md](docs/LLM_LEARNING.md) |
| Как участнику получить свой ключ Claude API | [docs/CLAUDE_API_KEY.md](docs/CLAUDE_API_KEY.md) |
| Правила разработки | [CLAUDE.md](CLAUDE.md) |

## Структура репозитория

```
ai_agent_capper/
├── backend/                FastAPI: API, вход и права, банк и ставки, конвейер Claude, модели, фоновые задачи
├── frontend/               React + TypeScript + Vite: интерфейс для телефона и компьютера
├── deploy/                 docker compose, Caddy, бэкапы
├── lab/                    учебный трек по обучению LLM
├── docs/                   документация
├── mockup/                 макет интерфейса
├── legacy/telegram-bot/    старый Telegram-бот (не развивается)
├── scripts/                служебные скрипты
├── .githooks/              проверки правил перед коммитом
├── .github/workflows/      CI
├── .env.example            образец настроек
└── CLAUDE.md               правила разработки
```

Подробнее — в [backend/README.md](backend/README.md) и [frontend/README.md](frontend/README.md).

## Запуск у себя

Сервера пока нет (решение Р19 в [плане](docs/PLAN.md)), поэтому приложение запускается и проверяется на своем компьютере. Нужен [Docker Desktop](https://docs.docker.com/get-docker/) и bash (на Windows — Git Bash или WSL), свободные порты 80 и 443.

```bash
git clone https://github.com/rvburov/ai_agent_capper.git
cd ai_agent_capper
bash deploy/local.sh up                                # первый раз 5–10 минут
bash deploy/local.sh admin you@example.com "Имя"       # администратор, пароль спросит
```

Затем откройте https://localhost (браузер предупредит о сертификате — это нормально для своего компьютера), войдите и настройте 2FA в приложении-аутентификаторе. Остальные команды — `bash deploy/local.sh` без параметров: импорт истории старого бота, бэкап, логи, остановка (`down`, данные сохраняются) и полная очистка (`wipe`). Пароли и ключи скрипт создает сам в `deploy/.env.local`, в git они не попадают.

Данные о матчах и бэктест модели:

```bash
bash deploy/local.sh data --full        # первый раз: архивы с 2000 года, привязка старого бота, Эло (несколько минут)
bash deploy/local.sh backtest           # отчет — в deploy/reports/backtest-<дата>.md
```

Дальше данные обновляет воркер каждую ночь. Если tennis-data.co.uk ответит 403 (сайт закрыт Cloudflare от программ), скачайте файлы `ГОД.xlsx` в браузере со страницы http://www.tennis-data.co.uk/alldata.php в одну папку и запустите `bash deploy/local.sh data --full --tennis-data-dir ПАПКА` ([deploy/README.md](deploy/README.md#данные-о-матчах-и-бэктест)).

Данные: Jeff Sackmann / Tennis Abstract, CC BY-NC-SA 4.0 ([tennis_atp](https://github.com/JeffSackmann/tennis_atp)) — матчи и статистика ATP с 2000 года. Даты матчей и кэфы букмекеров — [tennis-data.co.uk](http://www.tennis-data.co.uk) (условия использования — проверить на сайте).

## Быстрый старт для разработки

Нужны Python 3.12+, Node 22, PostgreSQL 18 и Redis 8 (их проще поднять в Docker, команды — в [backend/README.md](backend/README.md)).

```bash
git clone https://github.com/rvburov/ai_agent_capper.git
cd ai_agent_capper
# Один раз для новой копии (правила CLAUDE.md)
git config user.name "Roman Burov"
git config user.email "romanburov89@gmail.com"
git config commit.gpgsign false
git config core.hooksPath .githooks      # проверки правил из CLAUDE.md
cp .env.example .env

# PostgreSQL и Redis на localhost
docker run -d --name capper-postgres -p 5432:5432 \
  -e POSTGRES_USER=capper -e POSTGRES_PASSWORD=capper -e POSTGRES_DB=capper postgres:18
docker run -d --name capper-redis -p 6379:6379 redis:8

# backend: http://localhost:8000/api/docs
cd backend && python -m venv .venv && source .venv/bin/activate
pip install --require-hashes -r requirements-dev.lock && pip install --no-deps -e .
alembic upgrade head                                   # схема базы
python -m app.admin.cli create-admin --email you@example.com --name "Имя"   # пароль спросит
uvicorn app.main:app --reload

# frontend (в другом терминале): http://localhost:5173
cd frontend && npm install && npm run dev
```

Макет открывается без сборки: `npx http-server mockup -p 8080`, затем http://localhost:8080.
