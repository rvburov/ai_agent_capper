# Backend

Серверная часть AI Capper на FastAPI: API, вход и права, банк и ставки, конвейер Claude, модели и метрики, фоновые задачи. Правила написания кода — в [CLAUDE.md](../CLAUDE.md).

## Запуск для разработки

Нужен Python 3.12 или новее.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
uvicorn app.main:app --reload      # документация API: http://localhost:8000/api/docs
```

Настройки берутся из `.env` в корне репозитория (образец — [`.env.example`](../.env.example)).

## Проверки

```bash
ruff check . && ruff format --check .
mypy
pytest
```

## Где что лежит

```
backend/
├── pyproject.toml     зависимости и настройки ruff, mypy, pytest
├── app/
│   ├── main.py        создание приложения, подключение маршрутов
│   ├── core/          настройки из .env, пароли и 2FA, сеансы, ошибки, логирование
│   ├── api/           HTTP-слой: router.py собирает routes/<раздел>.py
│   ├── schemas/       схемы Pydantic: что API принимает и отдает
│   ├── services/      бизнес-логика: банк, ставки, лимиты ИИ, приглашения, уведомления, валюта
│   ├── db/            подключение к PostgreSQL, модели SQLAlchemy, запросы
│   ├── agent/         конвейер Claude: разбор текста, новости, анализ, учет стоимости
│   ├── prompts/       промпты в markdown с номером версии
│   ├── ml/            Эло, базовая модель, калибровка, метрики, бэктест
│   ├── ingest/        загрузчики данных: архив Сакманна, tennis-data.co.uk, история старого бота
│   ├── workers/       фоновые задачи arq и расписание
│   ├── admin/         команды терминала (cli.py) и логика кабинета администратора
│   └── locales/       тексты сервера (ошибки, уведомления), ru.json
├── alembic/           миграции схемы БД (появятся на этапе 1)
└── tests/             тесты pytest
```

Сейчас это каркас: работает только `GET /api/health`. SQLAlchemy, asyncpg, Alembic, arq и Anthropic SDK добавляются на этапе 1 вместе с кодом, который их использует ([PLAN.md](../docs/PLAN.md), раздел 10).
