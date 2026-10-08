# Backend

Серверная часть AI Capper на FastAPI: API, вход и права, банк и ставки, конвейер Claude, модели и метрики, фоновые задачи. Правила написания кода — в [CLAUDE.md](../CLAUDE.md).

## Запуск для разработки

Нужны Python 3.12 или новее, PostgreSQL 16 и Redis 7.

PostgreSQL и Redis проще всего поднять в Docker:

```bash
docker run -d --name capper-postgres -p 5432:5432 \
  -e POSTGRES_USER=capper -e POSTGRES_PASSWORD=capper -e POSTGRES_DB=capper postgres:16
docker run -d --name capper-redis -p 6379:6379 redis:7
```

Если PostgreSQL свой, нужна роль `capper` с правом `CREATEDB` (тесты создают временные базы) и база `capper`, которой она владеет.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install --require-hashes -r requirements-dev.lock   # те же версии, что в CI
pip install --no-deps -e .
alembic upgrade head               # схема БД
uvicorn app.main:app --reload      # документация API: http://localhost:8000/api/docs
```

Настройки берутся из переменных окружения `CAPPER_*` и файла `.env` в корне репозитория (образец со всеми переменными — [`.env.example`](../.env.example)). Для разработки достаточно значений по умолчанию: база `capper` на `localhost`, Redis на `localhost`, ключи для разработки. Ключи для разработки лежат в открытом репозитории, поэтому годятся только для запуска на `http://localhost`: в `prod` и на любом другом адресе (`CAPPER_PUBLIC_ORIGIN`) без своих `CAPPER_SECRET_KEY` и `CAPPER_MASTER_KEYS` приложение не стартует.

## Запуск на сервере

```bash
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-server-header
```

Нужны `CAPPER_ENV=prod`, свои `CAPPER_SECRET_KEY`, `CAPPER_MASTER_KEYS`, `CAPPER_PUBLIC_ORIGIN=https://<домен>` и `CAPPER_TRUSTED_PROXIES` — адрес или сеть Caddy (например, сеть docker `172.18.0.0/16`). IP клиента приложение берет из `X-Forwarded-For` только от этих адресов. Если адрес Caddy не указан, у всех клиентов будет один IP — адрес Caddy, и лимит попыток входа закроет вход всем.

В `prod` адресов `/api/docs` и `/api/openapi.json` нет: Swagger UI грузит скрипты с CDN, а CSP Caddy их не пропускает. Документацию смотрим при локальном запуске, схему для фронтенда дает `python -m app.openapi_export`.

## Зависимости

В `pyproject.toml` — списки зависимостей с нижними границами. Точные версии с хешами — в двух lock-файлах:

| Файл | Что внутри | Кто ставит |
|---|---|---|
| `requirements.lock` | все, что нужно приложению | образ Docker, проверка схемы API в CI frontend |
| `requirements-dev.lock` | то же плюс pytest, ruff, mypy, версии общих пакетов те же | CI backend, разработка |

Ставится всегда в два шага: `pip install --require-hashes -r <lock-файл>`, затем сам пакет без зависимостей `pip install --no-deps -e .`. С хешами pip не поставит другую версию или подмененный файл, а набор пакетов на сервере, в CI и у разработчика один и тот же. В CI после установки идет `pip check`: он упадет, если lock-файл отстал от `pyproject.toml` (нового пакета нет или версия ниже границы).

Lock-файлы собирает [uv](https://docs.astral.sh/uv/) 0.11 или новее (`pip install uv`). Сборка общая для Linux, macOS и Windows (`--universal`), хеши — для файлов всех платформ.

**Добавить или поменять зависимость.** Правка в `pyproject.toml`, затем обе команды из `backend/`. Вторая ограничена первым файлом, поэтому общие пакеты в двух файлах одной версии:

```bash
uv pip compile pyproject.toml --universal --generate-hashes -o requirements.lock
uv pip compile pyproject.toml --extra dev --universal --generate-hashes -c requirements.lock -o requirements-dev.lock
pip install --require-hashes -r requirements-dev.lock && pip check
```

Уже записанные версии uv не меняет, только дописывает новое.

**Обновить версии.** В первую команду добавить `--upgrade-package <пакет>` (один пакет) или `--upgrade` (все), вторую запустить как есть: она возьмет новые версии из `requirements.lock`. Инструменты разработки (`ruff`, `mypy`, `pytest`) обновляются флагом `--upgrade-package` во второй команде. После обновления pydantic или FastAPI — `npm run gen:api` во `frontend/`: от них зависит схема OpenAPI, и CI сверяет `openapi.json` и `src/api/schema.d.ts` с кодом. Изменения проверяются полным прогоном (раздел «Проверки») и коммитятся вместе: `pyproject.toml`, оба lock-файла и, если менялись, файлы схемы.

## Миграции

Схема меняется только миграциями Alembic (`alembic/versions/`). Примененную миграцию не правим.

```bash
alembic revision --autogenerate -m "что изменилось"   # затем вычитать файл руками
alembic upgrade head
alembic check                                         # модели и база совпадают
```

Autogenerate и `alembic check` не видят CHECK-ограничения, условия частичных индексов и вставку данных — их дописывают руками. Расхождение моделей и миграции в них ловит `tests/test_migration.py`: он сверяет каталог PostgreSQL базы после миграций с базой из `Base.metadata.create_all`.

## Проверки

```bash
ruff check . && ruff format --check .
mypy
pytest
```

Тесты создают свою базу `capper_test_<pid>_<случайное>` через служебную базу `postgres` (`CAPPER_TEST_ADMIN_DATABASE_URL`, по умолчанию `postgresql://capper:capper@localhost:5432/postgres`) и подключаются к ней на том же сервере с той же учетной записью. Они применяют к базе миграции и удаляют ее в конце. Базу прогона, который убили (SIGTERM, SIGKILL), удаляет следующий запуск. Ключи Redis — со своим префиксом. Поэтому тесты можно запускать одновременно в нескольких терминалах. Фикстуры описаны в `tests/conftest.py`, типы для тестов — в `tests/support.py`.

Асинхронные тесты — `pytest-asyncio` в режиме `auto`: достаточно `async def test_...`.

## Схема API для фронтенда

```bash
python -m app.openapi_export > ../frontend/openapi.json
```

## Импорт истории старого бота

```bash
python -m app.ingest.legacy --email owner@example.com \
  --history <папка бота>/Ставки/История-ставок.json --players <папка бота>/Игроки --dry-run
```

Команда переносит историю старого Telegram-бота участнику с этим email (его сначала создают командой `create-admin` или по приглашению): каждая запись становится анализом, ставкой (`source = legacy`, повторный запуск ее не дублирует), событиями экспресса, прогнозами (`p_claude` из `вероятность_процент`, версия стратегии `legacy`) и кэфами, а игроки, турниры и матчи создаются заготовками. Профили игроков берутся из файлов `01–04`, файлы `05` и `06` пропускаются. Журнал банка строится заново и сверяется с числами бота: если банк до ставки расходится с журналом не только из-за времени (открытые ставки бот не списывал, результат внесли после следующей ставки), пишется корректировка с пояснением, а совпадение ее суммы с ошибкой бота (пустой банк, двойное нажатие «Победа») отмечается в отчете для проверки; итоговая разница с `meta.текущий_банк` объясняется этими ошибками. При повторном запуске новые ставки дописываются, пополнение второй раз не пишется, а если записи добавлены перед уже перенесенными, журнал выравнивается по пересчету файла одной корректировкой. Сначала запускайте с `--dry-run`: отчет тот же, но в базе ничего не меняется. Код — `app/ingest/legacy*.py`, синтетический пример истории с ошибками бота — `tests/fixtures/legacy/`.

## Где что лежит

```
backend/
├── pyproject.toml     зависимости и настройки ruff, mypy, pytest
├── alembic.ini        настройки Alembic (адрес базы — из CAPPER_DATABASE_URL)
├── alembic/           миграции схемы БД: env.py, versions/
├── app/
│   ├── main.py        create_app(): middleware, обработчики ошибок, маршруты, lifespan
│   ├── openapi_export.py  печать схемы OpenAPI
│   ├── core/          настройки, ошибки, тексты (i18n), логи, Redis, лимиты попыток,
│   │                  зависимости FastAPI, cookie, CSRF, security/ (пароли, 2FA, шифрование, коды)
│   ├── api/           HTTP-слой: router.py собирает routes/<раздел>.py
│   ├── schemas/       схемы Pydantic: что API принимает и отдает
│   ├── services/      бизнес-логика: сеансы, банк, ставки, лимиты ИИ, приглашения, уведомления
│   ├── db/            base.py, session.py, models/ — модели SQLAlchemy по разделам
│   ├── agent/         конвейер Claude: разбор текста, новости, анализ, учет стоимости
│   ├── prompts/       промпты в markdown с номером версии
│   ├── ml/            Эло, базовая модель, калибровка, метрики, бэктест
│   ├── ingest/        загрузчики данных: архив Сакманна, tennis-data.co.uk, история старого бота
│   ├── workers/       фоновые задачи arq и расписание
│   ├── admin/         команды терминала (cli.py) и логика кабинета администратора
│   └── locales/       тексты сервера (ошибки, уведомления, журнал), ru.json
└── tests/             тесты pytest: conftest.py (фикстуры), support.py (типы и помощники)
```
