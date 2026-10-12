# AI Capper

Веб-приложение для аналитики теннисных ставок. Участник вводит матчи и кэфы, система собирает данные об игроках, считает вероятности, а Claude добавляет контекст и объяснение. Банк, ставки, прибыльность и калибровка прогнозов — в таблицах и графиках. Модель учится на своих результатах. Доступ — закрытый круг участников по приглашению.

**Статус:** этап 1 закрыт 8 октября 2026: вход с 2FA, регистрация по приглашению, сброс пароля, личный кабинет, кабинет администратора, импорт истории старого бота, docker и бэкапы. Этап 2 закрыт 11 октября: загрузка архивов матчей и кэфов, сопоставление игроков, Эло по покрытиям и бэктест против рынка на настоящих данных. Эло лучше монетки (лог-лосс 0,624 против 0,693), но хуже рынка букмекеров на 0,035 — платный API пока не берем ([план работ](docs/PLAN.md#10-дорожная-карта)). Этап 3 в работе: анализ матча с поправкой Claude (разбор текста — Haiku 5.5, новости — Sonnet 5.5 с веб-поиском, оценка матча — Opus 5.5), два режима ключа Claude, лимиты и бюджет; в backend готовы схема и учет вызовов, лимиты, ключи, расчеты стратегии, конвейер анализа и ставки, маршруты ключей и бюджета; в интерфейсе — «Новый анализ», ход и итог анализа со ставкой, «Ключ Claude» участника и «Ключ и бюджет» администратора ([backend/README.md](backend/README.md#агент-claude-этап-3-в-работе)). Сервера пока нет — приложение запускается на своем компьютере.

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

### Ключ Claude и первая проверка

Анализы идут на ключе Claude администратора: пока его нет, «Новый анализ» не запускается.

1. Получите ключ в консоли Anthropic — шаги 1–6 в [docs/CLAUDE_API_KEY.md](docs/CLAUDE_API_KEY.md) (там же лимит трат в консоли).
2. Сохраните ключ в приложении: «Администрирование → Ключ и бюджет» → «Задать ключ», с кодом 2FA. Или в терминале — ключ спросит и на экране не покажет:

   ```bash
   bash deploy/local.sh cli set-admin-key
   ```

3. Проверьте конвейер на живом ключе: разбор образца, новости одного игрока и две оценки одного матча (по оценке ≈ $0,36, живая проверка 12 октября стоила $0,18). Матч берется последний сыгранный из базы, поэтому сначала нужны данные о матчах (`data --full` выше) или явный матч `--match ID`. Команда покажет оценку цены и спросит подтверждение, затем напечатает токены, стоимость и чтение кэша; прогнозы и новости в базу не пишет.

   ```bash
   bash deploy/local.sh cli agent-smoke
   ```

4. Первый анализ: «Новый анализ» → вставьте матчи с кэфами → «Разобрать» → «Запустить анализ».
5. Приемка этапа 3 (критерии — [docs/PLAN.md](docs/PLAN.md), этап 3): три команды на ключе администратора. Каждая покажет оценку цены и худший случай и спросит подтверждение; отчет — в `deploy/reports/<команда>-<дата>.md`. Код 0 — приемка пройдена, 1 — критерий не выполнен, 3 — пробный прогон на выборке меньше нужной (приемкой не считается), 130 — прервано Ctrl+C.

   ```bash
   bash deploy/local.sh acceptance-runs     # 20 анализов: p90 времени, средняя цена, доля кэша (оценка ≈ $12, по живым ценам ≈ $8)
   bash deploy/local.sh smoke-eval          # 40 матчей через Batch API, Claude против базовой модели (оценка ≈ $2,30, по живым ценам ≈ $0,50–0,60)
   bash deploy/local.sh smoke-eval --resume ID   # забрать результаты пакета позже
   bash deploy/local.sh parse-eval --draft --from-telegram result.json --out pairs.json  # черновик эталона
   bash deploy/local.sh parse-eval --file pairs.json   # разбор эталона (от 50 сообщений): нужно 100%
   ```

Данные: Jeff Sackmann / Tennis Abstract, CC BY-NC-SA 4.0 — матчи и статистика ATP с 2000 года. Сакманн убрал репозиторий `tennis_atp` с GitHub в сентябре 2026, программа берет файлы из архивной копии [tennis-sackmann-archive](https://github.com/Aneeshers/tennis-sackmann-archive) (снимок июня 2026, та же лицензия); матчи после мая 2026 года дает tennis-data.co.uk. Даты матчей и кэфы букмекеров — [tennis-data.co.uk](http://www.tennis-data.co.uk) (условия использования — проверить на сайте).

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
