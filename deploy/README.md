# Deploy

Все, что нужно для сервера: docker compose, Caddy, бэкапы, настройка VPS и деплой. Решения — [PLAN.md](../docs/PLAN.md), разделы 0 (Р19: сервер в Финляндии), 5 («Бэкапы») и 7 («Сервер»).

| Файл | Что делает |
|---|---|
| `docker-compose.yml` | Сервисы: caddy, api, worker, postgres, redis, backup |
| `Caddyfile` | HTTPS, статика интерфейса, `/api/*` на FastAPI, заголовки безопасности |
| `.env.example` | Образец `deploy/.env`: домен, пароли, ключи, бэкапы |
| `server-setup.sh` | Первичная настройка VPS (Ubuntu 24.04), один раз от root |
| `deploy.sh` | Деплой: код, сборка, копия базы, миграции, перезапуск, проверка здоровья |
| `backup/` | Образ бэкапов: `backup.sh`, `restore-check.sh`, `restore.sh`, расписание `crontab` |
| `../.github/workflows/deploy.yml` | Деплой из GitHub Actions после успешных проверок master |

## Как устроено

```
Интернет ─ 80, 443 ─▶ caddy ──/api/*──▶ api ─┬─▶ postgres
                       │ статика              ├─▶ redis ◀── worker ─▶ postgres
                       ▼                      │
                     /srv (React)           backup ─▶ postgres, S3
```

- **caddy** — образ из `frontend/Dockerfile`: внутри собранный интерфейс и этот `Caddyfile`. Сертификат Let's Encrypt выпускает и продлевает сам.
- **api** и **worker** — один образ из `backend/Dockerfile`. API — uvicorn, воркер — arq (`python -m app.workers.main`): ночная очистка сеансов и журнала входов, дальше — анализы и загрузка данных. Оба без root, файловая система только для чтения.
- **postgres** 18 и **redis** 8 — только во внутренней сети docker, наружу не открыты. Данные — в томах `capper_postgres-data` и `capper_redis-data` (у Redis включен AOF).
- **backup** — ночной `pg_dump`, шифрование age, выгрузка в S3, ежемесячная проверка восстановления.
- Сеть `edge` (Caddy и API) отдельная: только от ее адресов API верит заголовку `X-Forwarded-For` с IP клиента. Без этого у всех был бы IP Caddy, и лимит попыток входа закрывал бы вход всем.
- В сети `edge` включен IPv6. Тогда docker передает соединения по IPv6 в Caddy с настоящим адресом клиента. В сети только с IPv4 их принимал бы посредник docker-proxy, и все посетители по IPv6 пришли бы с одного адреса (шлюза сети docker): лимиты попыток входа стали бы для них общими, и один человек мог бы закрыть вход всем остальным. Нужен Docker 27 или новее (в нем ip6tables включен по умолчанию), `server-setup.sh` ставит свежий.

Все команды `docker compose` ниже — от пользователя `deploy` из папки `deploy/`, тогда `deploy/.env` подхватывается сам:

```bash
sudo -iu deploy
cd /opt/ai_agent_capper/deploy
```

## 1. Сервер

1. [Hetzner Cloud](https://console.hetzner.cloud) → новый проект → **Add Server**: локация **Helsinki**, образ **Ubuntu 24.04**, тип с 2 vCPU и 4 ГБ памяти (x86), ключ SSH — ваш публичный ключ (`~/.ssh/id_ed25519.pub`). Пароль root не нужен.
2. **Firewalls** → Create Firewall: входящие TCP 22, 80, 443 и UDP 443, применить к серверу. Это второй слой к `ufw` на сервере, и он важен: порты, которые публикует docker, обходят `ufw`.
3. Запишите IPv4 сервера.

## 2. Домен

У регистратора домена — запись **A** на IPv4 сервера и **AAAA** на IPv6 (адрес вида `2a01:4f9:...::1` есть в консоли Hetzner у сервера), например `capper.example.com`. Проверка: `dig +short capper.example.com` и `dig +short AAAA capper.example.com` показывают адреса сервера. Без записи A Caddy не получит сертификат.

Запись AAAA — только при включенном IPv6 в сети docker (`CAPPER_EDGE_IPV6`, по умолчанию включен, раздел «Как устроено»). Если на сервере пришлось поставить `CAPPER_EDGE_IPV6=false`, AAAA не заводите: иначе все посетители по IPv6 получат один общий IP.

## 3. Первичная настройка

Отдельный ключ для деплоя из GitHub Actions — на своем компьютере, без пароля, нигде больше не используется:

```bash
ssh-keygen -t ed25519 -N "" -C "github-actions-deploy" -f capper-deploy
```

На сервере от root (имя `roman` — пример вашего пользователя, после `--ci-key` — содержимое файла `capper-deploy.pub` в кавычках):

```bash
ssh root@<IP>
curl -fsSLO https://raw.githubusercontent.com/rvburov/ai_agent_capper/master/deploy/server-setup.sh
bash server-setup.sh --admin roman --domain capper.example.com \
  --ci-key "ssh-ed25519 AAAA... github-actions-deploy"
```

Скрипт: обновляет систему и включает автоматические обновления безопасности (перезагрузка при необходимости в 04:00 UTC), ставит Docker из официального репозитория, создает пользователя-владельца с sudo и пользователя `deploy` без sudo в группе docker, запрещает вход root и по паролю, включает файрвол (22, 80, 443), клонирует репозиторий в `/opt/ai_agent_capper` и создает `deploy/.env` со случайными паролем базы, `CAPPER_SECRET_KEY` и `CAPPER_MASTER_KEYS`. В конце печатает значения для секретов GitHub.

Не закрывая сессию root, проверьте в новом терминале вход `ssh roman@<IP>`. Ключ `capper-deploy` на сервере может только запустить `deploy.sh`: ни терминала, ни других команд.

Репозиторий закрытый — скрипт не скачать по ссылке: скопируйте его со своего компьютера (`scp deploy/server-setup.sh root@<IP>:`) и добавьте `--repo git@github.com:rvburov/ai_agent_capper.git`. Скрипт создаст ключ сервера только для чтения и попросит добавить его в GitHub (Settings → Deploy keys), затем запустите скрипт еще раз.

## 4. Настройки `deploy/.env`

Образец со всеми переменными — [`.env.example`](.env.example). Файл лежит только на сервере (`chmod 600`), в git не попадает.

1. **`CAPPER_MASTER_KEYS`** — сохраните строку в менеджер паролей. Без нее копия базы не расшифрует 2FA и ключи Claude.
2. **Ключи age для бэкапов.** Нужны два ключа. Ключ владельца — на своем компьютере (`age-keygen -o capper-owner.age`, программа [age](https://github.com/FiloSottile/age)); секретная часть — только в менеджере паролей, на сервер не кладется. Ключ сервера — для ежемесячной проверки восстановления:

   ```bash
   docker compose build backup
   docker compose run --rm --no-deps backup age-keygen
   ```

   В `.env`: `BACKUP_AGE_RECIPIENTS=<публичный ключ владельца>,<публичный ключ сервера>` (строки `age1...`), `BACKUP_AGE_IDENTITY=<секретный ключ сервера>` (строка `AGE-SECRET-KEY-1...`). Копию расшифрует любой из двух ключей: даже если сервер пропадет целиком, ключ владельца остается.
3. **S3 для копий вне сервера.** Hetzner Console → Object Storage → бакет в Helsinki (`hel1`), затем ключ доступа (S3 credentials). В `.env`: `BACKUP_S3_ENDPOINT=https://hel1.your-objectstorage.com`, `BACKUP_S3_REGION=hel1`, `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`. Подойдет любое S3-совместимое хранилище в ЕС. Без этих значений копии лежат только на сервере, в логе бэкапа будет предупреждение.

## 5. Первый запуск

```bash
bash deploy.sh
```

Скрипт собирает образы, поднимает PostgreSQL, Redis и контейнер бэкапов, снимает копию базы в `manual/` (если ключи age заданы), применяет миграции (`docker compose run --rm api alembic upgrade head`), запускает остальное и ждет, пока `https://<домен>/api/health` ответит `ok` с версией нового коммита. Первая сборка идет 5–10 минут. Если копия перед миграциями не получилась, деплой останавливается до миграций (пропустить копию: `bash deploy.sh --no-backup`).

Перед сборкой образы работающей версии (`capper-backend`, `capper-web`, `capper-backup`) получают тег `previous`. Если дальше что-то не прошло — сборка, копия базы, миграции, запуск сервисов или проверка здоровья, — скрипт откатывается сам: тег `latest` снова указывает на образы `previous`, код в папке возвращается на коммит прежней версии (вместе с `docker-compose.yml`), сервисы поднимаются на них, и здоровье проверяется еще раз. Деплой все равно завершается с ошибкой (код 1), а в выводе есть строка «откат выполнен: работает <хеш>» или «откат не помог». Миграции при этом назад не откатываются (раздел 9). При первом деплое откатываться некуда. Ошибку в `deploy/.env` откат не исправит: этот файл не в git и одинаков для обеих версий.

При деплое миграции — отдельный шаг до перезапуска: если миграция упала, продолжает работать прежняя версия. Кроме того, в compose есть одноразовый сервис `migrate` (`python -m app.db.migrate`): он выполняет `alembic upgrade head` перед запуском `api` и `worker`, поэтому обычный `docker compose up` поднимает стек и на пустой базе. После шага deploy.sh ему делать нечего. Если схема базы новее кода (после отката, раздел 9), `migrate` пропускает миграции с предупреждением в логе и не мешает запуску. Пока миграции не применены, `/api/health` отвечает 503 (`"db": "fail"`), так что стек без схемы не выглядит здоровым. Вручную:

```bash
docker compose up -d --build                         # миграции применит сервис migrate
docker compose run --rm --no-deps api alembic upgrade head   # или отдельно, заранее
```

## 6. Первый администратор и ключ Claude

```bash
docker compose exec api python -m app.admin.cli create-admin --email you@example.com --name "Роман"
```

Пароль спрашивается дважды и не отображается. Затем войдите на сайт: при первом входе настраивается 2FA (приложение-аутентификатор) и выдаются резервные коды. Остальные команды терминала — `python -m app.admin.cli --help` (PLAN.md, раздел 7). Ключ Claude администратора:

```bash
docker compose exec api python -m app.admin.cli set-admin-key
```

## 7. Импорт истории старого бота

Файлы истории на сервер — в домашнюю папку `deploy` (с вашего компьютера):

```bash
ssh roman@<IP> 'mkdir -p /tmp/import'
scp -r История-ставок.json Игроки roman@<IP>:/tmp/import/
ssh roman@<IP> 'sudo mv /tmp/import /home/deploy/import && sudo chown -R deploy:deploy /home/deploy/import'
```

На сервере сначала пробный прогон (ничего не записывает, печатает отчет), потом настоящий, затем удалите файлы:

```bash
docker compose run --rm -v /home/deploy/import:/import:ro api \
  python -m app.ingest.legacy --email you@example.com \
  --history /import/История-ставок.json --players /import/Игроки --dry-run
# если отчет в порядке — та же команда без --dry-run
rm -rf /home/deploy/import
```

Повторный запуск дублей не создает.

## 8. Бэкапы

| Что | Когда (UTC) | Где |
|---|---|---|
| `pg_dump -Fc`, зашифрованный age | каждую ночь в 01:30 | `deploy/backup/dumps/daily/` и S3 |
| первая копия недели и месяца | вместе с ночной | `weekly/`, `monthly/` |
| копия перед деплоем и восстановлением | при `deploy.sh` и `restore.sh` | `manual/` |
| проверка восстановления | 1-го числа в 02:30 | временная база в контейнере backup |

Хранится 7 ежедневных, 4 еженедельных, 6 ежемесячных и 5 ручных копий, в S3 — так же. Удаления в S3 идут по списку самого хранилища, поэтому потеря диска сервера не стирает копии в S3. Незашифрованный дамп на диск не пишется.

```bash
docker compose ps backup                    # healthy — последние бэкап и проверка прошли
docker compose logs --tail=50 backup        # журнал бэкапов
docker compose exec backup backup.sh        # копия сейчас
docker compose exec backup restore-check.sh # проверка восстановления сейчас
docker compose exec backup restore.sh --list
```

Контейнер `backup` становится **unhealthy**, если последняя копия или проверка упали либо успешной копии нет больше 26 часов. Состояние обновляется раз в 5 минут.

**Проверка восстановления** берет последнюю копию, восстанавливает ее во временный PostgreSQL внутри контейнера и сверяет с рабочей базой число пользователей, ставок, записей журнала банка и сумму журнала по валютам (строки, созданные до момента копии). Если между копией и проверкой удалили участника или сменили валюту, расхождение ожидаемо: сделайте свежую копию и повторите проверку.

**Восстановление** стирает рабочую базу и заменяет ее копией. Перед этим `restore.sh` целиком расшифровывает и читает копию и снимает копию текущей базы в `manual/`:

```bash
docker compose stop api worker
docker compose exec backup restore.sh latest      # или daily/<файл>, или s3:monthly/<файл>
docker compose run --rm api alembic upgrade head
docker compose start api worker
```

Новый сервер после потери старого: шаги 1–4. В `.env` — прежние `CAPPER_MASTER_KEYS` и `CAPPER_SECRET_KEY` и ключ age, которым можно расшифровать копии (секретный ключ владельца подойдет как `BACKUP_AGE_IDENTITY`), и прежние `BACKUP_S3_*`. Затем:

```bash
docker compose up -d --build postgres backup
docker compose exec backup restore.sh --list
docker compose exec backup restore.sh s3:daily/<файл> --no-safety-copy
bash deploy.sh
```

## 9. Обновление

**Автоматически.** После push в master и зеленых «Проверок» GitHub Actions (`.github/workflows/deploy.yml`) заходит на сервер ключом `capper-deploy` и запускает `deploy.sh` для этого коммита. Секреты репозитория (Settings → Secrets and variables → Actions) — значения печатает `server-setup.sh`:

| Секрет | Значение |
|---|---|
| `DEPLOY_HOST` | IP сервера (или домен) |
| `DEPLOY_USER` | `deploy` |
| `DEPLOY_SSH_KEY` | содержимое файла `capper-deploy` (секретная часть) |
| `DEPLOY_KNOWN_HOSTS` | строка `<IP>,<домен> ssh-ed25519 AAAA...` из вывода `server-setup.sh`. Адрес из `DEPLOY_HOST` должен в ней быть: ssh ищет ключ сервера по этому имени и без него остановит деплой (`Host key verification failed`) |

Пока секретов нет, workflow пишет «Сервер еще не настроен» и завершается успешно. Ключ добавить позже: `sudo bash /opt/ai_agent_capper/deploy/server-setup.sh --admin roman --ci-key "ssh-ed25519 ..."`. Вручную деплой запускается кнопкой Run workflow или на сервере: `bash deploy.sh`.

**Откат.** Неудачный деплой откатывается на прежние образы сам (раздел 5). Вручную на любой прежний коммит master: `bash deploy.sh --ref <хеш>` — обычный деплой этого коммита со сборкой. Если более новая версия уже применила миграции, в базе ревизия, которой в коде прежней версии нет, и `alembic upgrade head` упал бы (`Can't locate revision`). Тогда `deploy.sh` миграции пропускает и пишет «схема базы новее кода» — если эта ревизия и все миграции разворачиваемого кода есть в master. Так же проходит повторный деплой прежнего кода после автоматического отката (`--no-fetch`).

**Миграции назад не откатываются** ни при автоматическом откате, ни при `--ref`. `alembic downgrade` удаляет новые колонки и таблицы вместе с данными, которые новая версия успела записать, и сам может упасть на полпути, а автоматически решить, можно ли терять эти данные, скрипт не может. Поэтому миграции пишутся так, чтобы прежняя версия кода работала и с новой схемой: новая колонка — с `NULL` или значением по умолчанию, удаление и переименование — следующим деплоем, когда код их уже не использует. Тогда после отката прежняя версия просто работает на новой схеме. Если она все же не работает (в выводе «откат не помог», в логах api ошибки базы):

1. Лучше всего — исправить ошибку новым коммитом и задеплоить его: вперед, а не назад. Файл примененной миграции при этом не удалять, в том числе через `git revert` коммита с ней: ошибку в миграции исправляет следующая миграция. Если ревизии из базы нет в master, `deploy.sh` останавливается на миграциях («в базе ревизия …: ее нет в этом коде»): схему, которую не знает ни один коммит, он не трогает. Выход — вернуть файл миграции коммитом или вернуть схему (пункты 2 и 3).
2. Если нужна прежняя версия, а данные с момента деплоя можно потерять: восстановить копию из `manual/`, которую этот деплой снял перед миграциями, и развернуть прежний коммит:
   ```bash
   docker compose stop api worker
   docker compose exec backup restore.sh --list            # копия manual/ со временем деплоя
   docker compose exec backup restore.sh manual/<файл>
   bash deploy.sh --ref <прежний хеш>
   ```
3. `alembic downgrade` — только если `downgrade` этой миграции точно ничего не удаляет. Запускать кодом, в котором эта миграция есть: в прежнем коде ее нет, и alembic ее не найдет. После отката (папка и образы — прежней версии):
   ```bash
   git -C /opt/ai_agent_capper reset --hard <новый хеш>    # код с этой миграцией
   docker compose build api
   docker compose run --rm api alembic downgrade <ревизия до нее>
   bash deploy.sh --ref <прежний хеш>
   ```

## 10. Если что-то сломалось

| Признак | Что смотреть и делать |
|---|---|
| Сайт не открывается | `docker compose ps`: все ли `Up`/`healthy`. `docker compose logs --tail=100 caddy api` |
| Ошибка сертификата | DNS указывает на сервер (`dig +short <домен>`), открыты 80 и 443 (файрвол Hetzner). `docker compose logs caddy` |
| `/api/health` — 503 | В ответе видно, что не отвечает: `db` или `redis`. `docker compose logs postgres redis`, `docker compose restart postgres` |
| Деплой упал на миграции | Миграция не применилась, прежняя версия работает (скрипт вернул и образы, и код). Причина — в выводе `deploy.sh` или Actions. Исправить миграцию и задеплоить снова. «В базе ревизия …: ее нет в этом коде» — удален файл примененной миграции: раздел 9, «Миграции назад не откатываются», пункт 1 |
| Деплой упал на проверке здоровья | `deploy.sh` печатает `ps` и логи новой версии и откатывается на прежние образы. «Откат выполнен» — сайт работает на прежней версии: исправить ошибку новым коммитом (файл миграции не удалять) и задеплоить снова. «Откат не помог» — раздел 9, «Миграции назад не откатываются» |
| Docker Hub не дает скачать образ (429) | `bash deploy.sh --no-pull` — сборка на образах, которые уже есть на сервере |
| `worker` unhealthy | `docker compose logs --tail=100 worker`, затем `docker compose restart worker` |
| `backup` unhealthy | `docker compose logs backup`; после исправления — `docker compose exec backup backup.sh` (и `restore-check.sh`, если упала проверка) |
| `docker compose up`: `Cannot read IPv6 setup for bridge` | В ядре нет IPv6. В `deploy/.env` — `CAPPER_EDGE_IPV6=false`, запись AAAA у домена удалить (раздел 2) |
| Кончается диск | `df -h`, `docker system df`; `docker builder prune` и `docker image prune` |
| Потерян доступ администратора | `create-admin`, `reset-code`, `reset-2fa`, `unblock` в `app.admin.cli` (раздел 6) |

После перезагрузки сервера сервисы поднимаются сами (`restart: unless-stopped`).

## Проверка на своей машине

Пока сервера нет, это основной способ запуска (PLAN.md, Р19). Проще всего — скриптом, он сам создает пароли и ключи в `deploy/.env.local`, собирает образы, применяет миграции и ждет готовности:

```bash
bash deploy/local.sh up                            # затем https://localhost
bash deploy/local.sh admin you@example.com "Имя"   # первый администратор
bash deploy/local.sh cli reset-code --email you@example.com   # любая команда терминала
bash deploy/local.sh import you@example.com История-ставок.json Игроки --dry-run
bash deploy/local.sh backup                        # бэкап и проверка восстановления
bash deploy/local.sh restore --list                # копии для восстановления
bash deploy/local.sh restore latest                # восстановить рабочую базу из копии
bash deploy/local.sh down                          # остановить, данные сохраняются
```

`restore` останавливает api и воркер, восстанавливает копию (`restore.sh` перед этим снимает копию текущей базы в `manual/` и спрашивает подтверждение), применяет миграции и запускает сервисы снова. Команды `docker compose exec backup restore.sh ...` из раздела 8 рассчитаны на сервер (проект `capper`, файл `deploy/.env`), для локального стека — только через `local.sh`.

Свои дополнения к compose (например, другие порты, если 80 или 443 заняты) — в `deploy/docker-compose.local.yml`: скрипт подключает его сам. Вручную, без скрипта, весь стек тоже поднимается без домена: Caddy выпускает для `localhost` свой сертификат.

```bash
cp deploy/.env.example deploy/.env    # CAPPER_DOMAIN=localhost, пароли и ключи — см. комментарии;
                                      # без IPv6 в системе — CAPPER_EDGE_IPV6=false
docker compose -f deploy/docker-compose.yml up -d --build   # миграции — сервис migrate
curl -k https://localhost/api/health
docker compose -f deploy/docker-compose.yml down -v   # удалить вместе с томами
```
