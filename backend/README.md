# Backend

Серверная часть AI Capper на FastAPI: API, вход и права, банк и ставки, конвейер Claude, модели и метрики, фоновые задачи. Правила написания кода — в [CLAUDE.md](../CLAUDE.md).

## Запуск для разработки

Нужны Python 3.12 или новее, PostgreSQL 18 и Redis 8 — те же версии, что на сервере (`deploy/docker-compose.yml`) и в CI.

PostgreSQL и Redis проще всего поднять в Docker:

```bash
docker run -d --name capper-postgres -p 5432:5432 \
  -e POSTGRES_USER=capper -e POSTGRES_PASSWORD=capper -e POSTGRES_DB=capper postgres:18
docker run -d --name capper-redis -p 6379:6379 redis:8
```

Если PostgreSQL свой, нужна роль `capper` с правом `CREATEDB` (тесты создают временные базы) и база `capper`, которой она владеет.

```bash
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install --require-hashes -r requirements-dev.lock   # те же версии, что в CI
pip install --no-deps -e .
alembic upgrade head               # схема БД
python -m app.admin.cli create-admin --email you@example.com --name "Имя"   # первый администратор
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

Ставится всегда в два шага: `pip install --require-hashes -r <lock-файл>`, затем сам пакет без зависимостей `pip install --no-deps -e .`. С хешами pip не поставит другую версию или подмененный файл, а набор пакетов на сервере, в CI и у разработчика один и тот же. В CI после установки идет `pip check`, для каждого lock-файла свой: job backend ставит `requirements-dev.lock`, job frontend — `requirements.lock`. Он упадет, если lock-файл отстал от `pyproject.toml` (нового пакета нет или версия ниже границы). `pip check` сверяет то, что стоит в окружении, с метаданными пакета, а их обновляет только `pip install --no-deps -e .`: без него правка `pyproject.toml` не видна.

Lock-файлы собирает [uv](https://docs.astral.sh/uv/) 0.11 или новее (`pip install uv`). Сборка общая для Linux, macOS и Windows (`--universal`), хеши — для файлов всех платформ.

**Добавить или поменять зависимость.** Правка в `pyproject.toml`, затем обе команды из `backend/`. Вторая ограничена первым файлом, поэтому общие пакеты в двух файлах одной версии:

```bash
uv pip compile pyproject.toml --universal --generate-hashes -o requirements.lock
uv pip compile pyproject.toml --extra dev --universal --generate-hashes -c requirements.lock -o requirements-dev.lock
pip install --require-hashes -r requirements-dev.lock && pip install --no-deps -e . && pip check
```

Уже записанные версии uv не меняет, только дописывает новое. Третья команда проверяет `requirements-dev.lock`. `requirements.lock` проверяет CI (job frontend ставит только его) или чистое окружение: `python -m venv /tmp/lock-check`, в нем те же два шага с `requirements.lock` и `pip check`.

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

## Команды терминала и воркер

```bash
python -m app.admin.cli --help          # create-admin, reset-code, reset-2fa, set-role, unblock, set-admin-key
python -m app.admin.cli reset-code --email member@example.com
python -m app.workers.main              # фоновые задачи arq и расписание (нужен Redis)
python -m app.db.migrate                # alembic upgrade head, как сервис migrate в compose
```

Игроки: `players-find`, `players-merge --from ID --into ID [--yes]`, `players-edit ID [--name-ru] [--add-alias] [--remove-alias]`, `players-link-legacy [--dry-run]`, `players-unmatched`, а для записей-копий одного матча — `matches-merge --from ID --into ID [--yes]` (`python -m app.admin.cli <команда> --help`). Слияние и правка игроков пишут в журнал действий `player_merge` и `player_edit`.

Агент: `agent-config` показывает настройки агента (модели, effort, лимиты токенов, новости), `agent-config --set ИМЯ=ЗНАЧЕНИЕ [--set ...] [--reset ИМЯ ...]` меняет их поверх значений по умолчанию и пишет в журнал действий `agent_config_change`; `prices` показывает цены моделей Claude ($ за 1 млн токенов); `agent-smoke` — проверка на живом ключе (подробнее — в разделе «Агент Claude»). После слияния игроков копии матчей tennis-data, которые у игрока совпали с матчами Сакманна (та же пара в окне турнира), сливаются в матчи Сакманна сами; неоднозначные команда показывает — их сливают `matches-merge`.

Расписание воркера (UTC): 03:15 — очистка сеансов, доверенных устройств и журнала входов; 05:25 (час — `CAPPER_DATA_UPDATE_HOUR_UTC`) — `update_data`: те же шаги, что `python -m app.ingest.update` без `--full`, затем проверка свежести. Если успешной загрузки Сакманна или tennis-data не было больше 3 дней, активные администраторы получают уведомление `data_stale`, не чаще раза в сутки.

Команды терминала пишут в журнал действий с пометкой «терминал» и работают на чистой базе после `alembic upgrade head`. В Docker-стеке те же команды — `bash deploy/local.sh cli <команда> ...` на своем компьютере и `docker compose exec api python -m app.admin.cli ...` на сервере (`deploy/README.md`).

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

## Данные о матчах и модель

Одна команда — все шаги по очереди: архив Сакманна → tennis-data.co.uk → привязка матчей старого бота → пересчет Эло.

```bash
python -m app.ingest.update --full                     # первый раз: все годы, файлы разбираются заново
python -m app.ingest.update                            # текущий год (в январе и прошлый), как ночью
python -m app.ingest.update --years 2024-2026 --tennis-data-dir ~/tennis-data --skip-elo
python -m app.ml.backtest --report backtest.md         # бэктест; --report - печатает отчет в stdout
```

- Неизменившийся файл (тот же sha256, что в прошлом успешном запуске) не разбирается заново, кроме `--full`. Ошибка шага не останавливает следующие, но код возврата 1. Одновременно идет одно обновление (блокировка в PostgreSQL); ту же блокировку берут отдельные команды шагов ниже, `players-merge` и `matches-merge`: пока идет обновление, они отвечают «Обновление данных уже идет» и ничего не меняют. Журнал каждого шага — `ingestion_runs` (`sackmann`, `tennis_data`, `players_link`, `elo`): файлы с sha256, счетчики, несопоставленные строки, свежесть.
- tennis-data.co.uk может ответить 403 (Cloudflare не пускает программы): файлы `ГОД.xlsx` скачиваются в браузере со страницы http://www.tennis-data.co.uk/alldata.php и грузятся из папки (`--tennis-data-dir`). Условия использования сайта — проверить на сайте.
- Шаги можно запускать и по отдельности:
  - `python -m app.ingest.sackmann [--years 2000-2026] [--dir ПАПКА] [--force]` — архив Сакманна (`atp_players.csv`, `atp_matches_ГОД.csv`). Данные: Jeff Sackmann / Tennis Abstract, CC BY-NC-SA 4.0;
  - `python -m app.ingest.tennis_data [--years 2013-2026] [--dir ПАПКА] [--force]` — дни матчей, кэфы (`odds_snapshots`, вид `archive`) и матчи, которых у Сакманна еще нет;
  - `python -m app.admin.cli players-link-legacy [--dry-run]` — привязка ставок старого бота к матчам архивов;
  - `python -m app.ml.elo` — пересчет Эло по всей истории в `player_ratings` и модель `elo-v1`.
- Бэктест (`app/ml/backtest.py`, отчет — `app/ml/report.py`): вес покрытия подбирается на 2019–2021, калибровка Платта — на 2022–2023, тест — 2024–2025 (`--test-years`), сравнение с рынком без маржи (эталон по порядку: Pinnacle → биржа Betfair → средний кэф рынка, степенной метод), ROI по правилам стратегии, проверка приманкой. Результат пишется в `ml_models` и `eval_runs` (`--no-save` — без записи).

Модули:

| Модуль | Что делает |
|---|---|
| `ingest/fetch.py` | файлы по HTTP (повторы, предел 50 МБ, User-Agent `AI-Capper/<версия>`) или из папки |
| `ingest/runs.py` | журнал `ingestion_runs`, отчет загрузчика `IngestReport` |
| `ingest/rounds.py`, `ingest/names.py` | раунды и сетки, имена: латиница, кириллица, «Фамилия И.» |
| `ingest/sackmann.py`, `ingest/tennis_data.py` | загрузчики архивов |
| `ingest/players_link.py` | привязка матчей и игроков старого бота |
| `ingest/update.py` | одна команда обновления, ее же вызывает воркер |
| `services/players.py` | поиск, слияние и правка игроков, слияние матчей |
| `ml/elo.py`, `ml/market.py`, `ml/metrics.py` | Эло по покрытиям, снятие маржи, лог-лосс, Brier, ECE, бутстрэп |
| `ml/backtest.py`, `ml/report.py` | бэктест и отчет Markdown |
| `ml/sets.py`, `ml/strategy.py` | модель сетов (форы ±1.5), разбор счета по сетам и исход ноги по счету; правила стратегии v3: валуй, экспресс, сумма ставки, поправка Claude (Р22) |
| `services/dossier.py`, `services/bank.py` | досье матча для Claude (0 токенов), банк, пик и просадка по журналу |

## Агент Claude (этап 3, в работе)

Числа считает код, контекст дает Claude: досье матча и базовую вероятность собирает код (0 токенов), Claude разбирает текст, ищет новости и дает поправку к вероятности по JSON-схеме, код ее проверяет и ограничивает (±10 п.п., Р22). Агент в базу не пишет. Шаги и модели:

| Шаг | Модель и effort | Инструменты | Где |
|---|---|---|---|
| Разбор текста ввода | Haiku 5.5, `low` | нет | `agent/parse.py`, прямо в `POST /analyses` |
| Новости игроков (если старше 12 ч) | Sonnet 5.5, `low` | `web_search` (до 2 поисков на матч, до 6 на анализ) и свой `record_news` | `agent/news.py`, в воркере |
| Оценка матча | Opus 5.5, `medium`, поток | нет | `agent/analysis.py`, в воркере, один вызов на матч |

Модели, effort, лимиты токенов и поисков — в настройках (`app_settings.agent_config` поверх `agent/config.py`, команда `agent-config`), промпты — в `app/prompts/*.md` с номером версии. Каждый вызов Claude пишет строку `agent_runs` (токены, стоимость по `model_prices`, `request_id`); перед вызовом проверяются лимиты и потолок анализа (вызов ждет свои вызовы в полете или урезает `max_tokens` до остатка, но не ниже `analysis_min_tokens`; PLAN.md, раздел 6). Свободный текст участника в запросы Claude не идет: в досье и в сообщении шага новостей — только названия турниров из архивов, а текстовые поля ввода — одной строкой без управляющих символов.

| Модуль | Что делает |
|---|---|
| `agent/config.py` | настройки агента `AgentConfig`, значения по умолчанию |
| `agent/client.py` | клиент Claude API: пул соединений на цикл событий, ключ — на каждый вызов |
| `agent/errors.py` | ошибки SDK → коды `ai.*` (ключ отклонен, перегрузка, тайм-аут, отказ, не по схеме) |
| `agent/runs.py` | учет вызова: usage, стоимость, худший случай перед вызовом |
| `agent/prompts.py`, `agent/schemas.py` | промпты с версией и sha256, схемы ответов (разбор, новости, оценка матча) |
| `services/ai_access.py` | доступ к Claude: режим, лимиты, резерв бюджета под `FOR UPDATE`, проверка перед вызовом, уведомления 80% и 100% |
| `services/claude_key.py`, `services/ai_keys.py` | проверка и расшифровка ключа, свой ключ участника, режимы (Р7, Р12), лимиты и бюджет администратора |
| `services/ai_budget.py` | сводки для экранов «Ключ Claude» и «Ключ и бюджет» (`/api/ai/budget`, `/api/me/ai-*`, `/api/admin/ai/*`), замена ключа администратора (сначала код 2FA, потом проверка ключа), лимиты по умолчанию для новых участников |
| `agent/calls.py` | один вызов Claude: проверка лимитов до вызова, учет после (и неудачного, и снятого по тайм-ауту), usage оборванного потока |
| `agent/parse.py`, `agent/news.py`, `agent/analysis.py` | шаги Claude: разбор текста, новости (`web_search` + `record_news`), оценка матча до 3 итераций в одном разговоре |
| `services/analyses.py`, `services/analysis_input.py`, `services/analysis_view.py` | анализ для API: разбор, черновик, «Перед запуском», запуск и резерв, перезапуск, отмена; матчи и кэфы из ввода; вид анализа и события прогресса |
| `services/analysis_run.py`, `services/analysis_result.py`, `services/progress.py` | выполнение в воркере с чекпойнтами (предел 840 с), прогнозы и экспресс, уборщик зависших анализов; прогресс (Redis Streams, SSE) |
| `services/bets.py`, `services/strategy_versions.py` | ставка по экспрессу, банк и букмекеры участника; активная версия стратегии v3 |
| `services/agent_smoke.py` | команда `agent-smoke`: проверка конвейера на живом ключе; `--only news` — новости одного игрока с вариантами шага для сравнения |
| `admin/acceptance.py`, `services/acceptance_runs.py`, `services/smoke_eval.py`, `services/parse_eval.py`, `services/check_runs.py` | команды приемки этапа 3: `acceptance-runs` (20 анализов шагами воркера), `smoke-eval` (оценка матча через Batch API), `parse-eval` (эталон разбора и его черновик из Telegram); администратор для вызовов и бюджет проверок |

Маршруты ключей и бюджета: `GET /api/ai/budget`; свой ключ — `PUT`/`DELETE /api/me/ai-key`, `POST /api/me/ai-key/check`; режим — `PUT /api/me/ai-mode`, `POST`/`DELETE /api/me/ai-mode/return-request`; свой потолок — `PUT /api/me/ai-cap`; администратор — `GET`/`PUT /api/admin/ai/key` (замена с `totp_code`), `GET`/`PUT /api/admin/ai/budget`, `GET /api/admin/ai/limits`, `PUT /api/admin/ai/limits/{user_id}`, `PUT /api/admin/ai/defaults`, `POST /api/admin/users/{user_id}/ai-mode` (`approve` с лимитом или `reject`). Ключ ни в одном ответе не возвращается — только последние 4 символа. Расход участника и общий бюджет — без проверочных прогонов (`eval`, `shadow`): у них свой бюджет `eval_budget_usd`. «Анализов за месяц» везде считается по `analyses.started_at` на ключе администратора, как «анализы сегодня». Потолок анализа по умолчанию для новых участников — настройка `default_per_analysis_usd` в `agent_config` (ее меняет и `PUT /api/admin/ai/defaults`, и `agent-config`).

Маршруты анализа и ставки: `POST /api/analyses` (разбор текста или пустая форма), `GET /api/analyses`, `GET /api/analyses/{id}`, `POST /api/analyses/{id}/preview` («Перед запуском»), `POST /api/analyses/{id}/run` (запуск; без тела — перезапуск с упавшего шага; можно ли перезапустить сейчас — поле `restart` в `GET /api/analyses/{id}`), `POST /api/analyses/{id}/cancel`, `PUT /api/analyses/{id}/decision`, `GET /api/analyses/{id}/events` (прогресс, SSE), `POST /api/bets`, `GET /api/me/bank`, `GET /api/me/bookmakers`, `GET /api/players?q=`, `GET /api/strategy/active`. Разбор текста — не больше 30 в час на участника, проверка своего ключа Claude (сохранение и «Проверить») — не больше 10 в час на участника и на IP, потоков прогресса анализов в работе — не больше 5 одновременно у участника (сверх — 429 `common.rate_limited`). Анализ выполняет воркер (`run_analysis`, предел 15 минут, без повтора arq); уборщик раз в 5 минут переводит в `failed` (`analysis.worker_lost`) анализы без движения дольше 15 минут, в том числе зависший разбор.

Проверка на живом ключе: `python -m app.admin.cli agent-smoke [--match ID] [--yes]` — один разбор образца, новости одного игрока (совместимость `web_search` и `record_news` в одном запросе), два вызова оценки одного матча из базы (второй проверяет чтение кэша); печатает токены, стоимость и чтение кэша, прогнозы и новости не пишет, перед запуском спрашивает подтверждение с оценкой цены (≈ $0,36, в худшем случае до $3,10). Код возврата 1, если разбор образца нашел не одно событие, модель не искала перед `record_news` или второй вызов анализа не прочитал кэш. Матч по умолчанию — последний сыгранный (у матча без даты — по началу турнира), досье строится на день матча, чтобы его результат не попал в досье. `agent-smoke --only news [--news-model M] [--news-dynamic] [--news-max-uses N] [--news-no-cache] [--player ID]` — только шаг новостей одного игрока с вариантами шага (модель, фильтрация поиска кодом, число поисков, точка кэша; настройки агента не меняются): до платного вызова `models.retrieve` сверяет `capabilities` модели (веб-поиск, programmatic tool calling для фильтрации), затем печатает токены, стоимость, итерации серверного цикла каждого вызова (`usage.iterations`) и цену того же разговора без точки кэша, факты и источники; код 1 — шаг не выполнен или ни один поиск не прошел. `--match` с `--only news` не действует: игрока задает `--player`. Шаг новостей (`app/agent/news.py`): `web_search_20260209` у любой модели, по умолчанию `allowed_callers: ["direct"]`; при `news_dynamic_filtering` поле не задается, адреса для сверки и ошибки поиска берутся из всех `web_search_tool_result` (и с полем `caller`), сбои выполнения кода — отдельно (`code_errors`: `error_code` инструмента или `return_code:N` упавшего кода), продолжение идет в том же контейнере; `news_prompt_cache` — точка кэша на system (без нее сервер не пишет в кэш результаты поиска). В тестах Claude не вызывается: ответы подменяются через транспорт `httpx2` (`tests/claude_mock.py`, `tests/fake_claude.py`).

Приемка этапа 3: `python -m app.admin.cli acceptance-runs [--count 20] [--email АДМИН] [--yes] [--report ПУТЬ.md]`, `smoke-eval [--events 40] [--since 2026-08-01] [--before-cutoff] [--no-wait] | --resume ID | --abandon ID`, `parse-eval --file ПАРЫ.json` и `parse-eval --draft --from-telegram result.json --out ПАРЫ.json` (критерии и цены — `docs/PLAN.md`, этап 3, «Как принять этап»). Анализы приемки — обычные анализы администратора с меткой `acceptance` в чекпойнте: их прогнозы пишутся с `is_eval`, поиски новостей не входят в дневной лимит поисков программы (`analysis_run.ACCEPTANCE_MARK`). Коды команд: 0 — приемка пройдена, 1 — нет, 2 — отменено, 3 — пробный прогон, 130 — Ctrl+C (`app/admin/terminal.py`). `smoke-eval` пишет `eval_runs` (`version_kind = strategy`, `split = test`) и строки `agent_runs` с `kind = eval`, `batch = true`, `request_id = «пакет/запрос»`; `parse-eval` — `agent_runs` с `kind = eval`. Обе тратят бюджет проверок (`eval_budget_usd`), в резерве — худший случай незабранных пакетов (29 дней после отправки) и потерянных или закрытых (`lost`, `abandoned`) до конца месяца отправки. Поддельный сервер отвечает и на Message Batches (`POST /v1/messages/batches`, опрос, результаты JSONL).

Локальный прогон без ключа: поддельный сервер Claude `uvicorn tests.fake_claude:app --port 8099` (из `backend/`) и `CAPPER_ANTHROPIC_BASE_URL=http://127.0.0.1:8099` у API и воркера; ключ администратора — любой `sk-ant-...` (`set-admin-key`, проверку ключа тоже отвечает поддельный сервер). Сбои включаются запросом `POST /_fake/fail` (сбросить — `POST /_fake/reset`) или переменной `FAKE_CLAUDE_FAIL`. В prod адрес Claude API — только https.

## Ставки и банк (этап 4, в работе)

Числа считает код: выплата, CLV, итоги «Ставок» и капитал по дням считаются на сервере (суммы — в SQL), фронтенд их только показывает. Все деньги участника меняются под блокировкой его денег (`lock_member_money`) и `FOR UPDATE`; расчет, сторно и закрытие несут версию ставки, иначе 409.

| Модуль | Что делает |
|---|---|
| `services/bets.py` | ставка по экспрессу; список «Ставок» с фильтрами и курсором, итоги, карточка (ноги, закрытие, CLV, вердикт, исход по каждому полному счету), выгрузка CSV частями |
| `services/settlement.py` | ручной расчет ставки и исправление результата (сторно): выплата и возврат в журнал до копеек, повтор того же действия — 200 |
| `services/closing.py` | закрывающий кэф ноги: свой исход, обратный по желанию, чей кэф; `q_close` степенным методом, CLV |
| `services/bet_versions.py` | версия ставки `updated_at`: допуск меньше 1 мс (браузер хранит миллисекунды), новая версия позже прежней хотя бы на 2 мс |
| `services/bank.py` | состояние банка одним запросом, капитал на конец дня по поясу участника, журнал с балансом после строки, пополнение, вывод и корректировка |
| `ml/metrics.py` | еще CLV ноги и экспресса: с маржой (кэф / закрытие − 1) и без маржи (кэф · `q_close` − 1) |
| `ingest/user_matches.py` | Т14: матч из ввода участника при загрузке tennis-data сливается в архивную строку (ноги, прогнозы, кэфы переходят, сторона переворачивается) |
| `core/timing.py` | время ответа в лог `http.request`: метод, шаблон маршрута, статус, `ms`, `ttfb_ms` (основа p95) |

Маршруты: `GET /api/bets` (фильтры `period`, `from`, `to`, `status`, `market`, `surface` — можно несколько, `source`, `q`; курсор `before`, `limit` до 100), `GET /api/bets/summary`, `GET /api/bets/export.csv` (те же фильтры без курсора), `GET /api/bets/{id}`, `PUT /api/bets/{id}/result`, `POST /api/bets/{id}/reverse`, `PUT /api/bets/{id}/legs/{leg_id}/closing`, `GET /api/me/bank/history?period=`, `GET /api/me/bank/entries`, `POST /api/me/bank/entries`. Чужая ставка — 404, как несуществующая. Результат, перенесенный импортом старого бота, не пересчитывается (409 `bet.legacy`); открытую ставку бота участник рассчитывает сам.

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
│   ├── db/            base.py, session.py, migrate.py (сервис migrate), models/ — модели
│   │                  SQLAlchemy по разделам
│   ├── agent/         конвейер Claude: разбор текста, новости, анализ, учет стоимости
│   ├── prompts/       промпты в markdown с номером версии
│   ├── ml/            Эло, снятие маржи, метрики, бэктест и отчет
│   ├── ingest/        загрузчики данных: архив Сакманна, tennis-data.co.uk, история старого бота,
│   │                  привязка старого бота, команда обновления update.py
│   ├── workers/       фоновые задачи arq и расписание
│   ├── admin/         команды терминала (cli.py); логика кабинета администратора — в services/
│   │                  (admin_users, access_codes, admin_confirm, admin_key)
│   └── locales/       тексты сервера (ошибки, уведомления, журнал), ru.json
└── tests/             тесты pytest: conftest.py (фикстуры), support.py (типы и помощники)
```
