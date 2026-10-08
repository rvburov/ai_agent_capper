# AI Capper

Веб-приложение для аналитики теннисных ставок. Участник вводит матчи и кэфы, система собирает данные об игроках, считает вероятности, а Claude добавляет контекст и объяснение. Банк, ставки, прибыльность и калибровка прогнозов — в таблицах и графиках. Модель учится на своих результатах. Доступ — закрытый круг участников по приглашению.

**Статус:** макет и план согласованы 8 октября 2026. Идет этап 1 — фундамент приложения: вход, роли, база, сервер ([план работ](docs/PLAN.md#10-дорожная-карта)).

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

## Быстрый старт для разработки

```bash
git clone https://github.com/rvburov/ai_agent_capper.git
cd ai_agent_capper
git config core.hooksPath .githooks      # проверки правил из CLAUDE.md
cp .env.example .env

# backend: http://localhost:8000/api/docs
cd backend && python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]" && uvicorn app.main:app --reload

# frontend (в другом терминале): http://localhost:5173
cd frontend && npm install && npm run dev
```

Макет открывается без сборки: `npx http-server mockup -p 8080`, затем http://localhost:8080.
