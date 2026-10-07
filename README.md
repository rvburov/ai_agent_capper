# Tennis Analytics

Личный бот для анализа теннисных матчей и управления ставками на основе Claude AI.

> **Веб-версия в разработке.** Кликабельный макет интерфейса лежит в [`mockup/`](mockup/README.md), план и решения — в [`docs/`](docs/README.md):
> [план веб-приложения](docs/PLAN.md) · [экономия токенов](docs/TOKEN_ECONOMY.md) · [как модель учится на ставках](docs/LLM_LEARNING.md).

---

## Структура проекта

```
ai_agent_capper/
├── README.md
├── bot.py                             ← Telegram-бот с tool use
├── requirements.txt
├── .env                               ← токены (создать из .env.example)
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── .github/
│   └── workflows/
│       └── deploy.yml                 ← авто-деплой на сервер при push в main
└── Tennis-Analytics/
    ├── CLAUDE.md
    ├── Стратегия-ставок.md
    ├── Инструкция-Авто.md
    ├── Инструкция-1-заполнение-базы.md
    ├── Инструкция-2-обновление.md
    ├── Инструкция-3-анализ.md
    ├── _Шаблоны/
    │   ├── 01-личные-данные.json
    │   ├── 02-игровой-профиль.json
    │   ├── 03-физика-и-техника.json
    │   ├── 04-психология.json
    │   ├── 05-текущее-состояние.json
    │   └── 06-матчи.json
    ├── Игроки/                        ← заполняется автоматически
    └── Ставки/
        └── История-ставок.json
```

---

## Подготовка (одинаково для обоих вариантов)

### 1. Создайте бота в Telegram
Напишите @BotFather → `/newbot` → скопируйте токен

### 2. Получите API ключ Anthropic
platform.anthropic.com → API Keys → Create Key

### 3. Создайте репозиторий на GitHub
```bash
git init
git add .
git commit -m "init"
git branch -M master 
git remote add origin https://github.com/ваш-логин/ai_agent_capper.git
git push -u origin master
```

### 4. Заполните .env
```bash
cp .env.example .env
```
Откройте `.env` и вставьте токены. Файл `.env` в `.gitignore` — никогда не попадёт в GitHub.

---

## Вариант 1 — Локально на компьютере

Бот работает пока открыт терминал. База данных хранится локально.

**Требования:** Docker Desktop (mac.docker.com или docker.com/products/docker-desktop)

```bash
# Клонируйте репозиторий
git clone https://github.com/ваш-логин/ai_agent_capper.git
cd ai_agent_capper

# Заполните .env
cp .env.example .env
# вставьте TELEGRAM_TOKEN и ANTHROPIC_API_KEY

# Запустите
docker compose up --build
```

**Управление:**
```bash
docker compose up -d          # запуск в фоне
docker compose logs -f        # логи в реальном времени
docker compose down           # остановка
docker compose restart        # перезапуск
```

**Обновление кода:**
```bash
git pull
docker compose down
docker compose up --build -d
```

База данных (`Игроки/` и `История-ставок.json`) хранится на вашем компьютере и не теряется при перезапуске контейнера — она смонтирована через volumes.

---

## Вариант 2 — Сервер с авто-деплоем через GitHub

Бот работает 24/7. При каждом `git push` в ветку `master` — автоматически деплоится на сервер.

**Требования:** любой VPS с Ubuntu (DigitalOcean, Hetzner, TimeWeb — от $3–5/мес)

### Шаг 1 — Подготовка сервера

```bash
# Зайдите на сервер
ssh user@ваш-сервер

# Установите Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
# Перезайдите в SSH чтобы группа применилась
exit && ssh user@ваш-сервер

# Клонируйте репозиторий
git clone https://github.com/ваш-логин/ai_agent_capper.git ~/ai_agent_capper
cd ~/ai_agent_capper

# Заполните .env на сервере
cp .env.example .env
nano .env   # вставьте токены

# Создайте папки базы данных
mkdir -p Tennis-Analytics/Игроки Tennis-Analytics/Ставки
touch bot.log

# Первый запуск
docker compose up --build -d
docker compose logs -f
```

### Шаг 2 — Настройка авто-деплоя через GitHub Actions

Добавьте три секрета в GitHub → Settings → Secrets and variables → Actions:

| Секрет           | Значение                                      |
| ---------------- | --------------------------------------------- |
| `SERVER_HOST`    | IP адрес вашего сервера                       |
| `SERVER_USER`    | имя пользователя (обычно `ubuntu` или `root`) |
| `SERVER_SSH_KEY` | приватный SSH ключ (`~/.ssh/id_rsa`)          |

**Как получить SSH ключ:**
```bash
# На вашем компьютере
cat ~/.ssh/id_rsa
# Скопируйте всё содержимое включая BEGIN и END строки
# Вставьте в секрет SERVER_SSH_KEY
```

Если ключа нет — создайте:
```bash
ssh-keygen -t rsa -b 4096
# Нажмите Enter на все вопросы
ssh-copy-id user@ваш-сервер  # добавит публичный ключ на сервер
cat ~/.ssh/id_rsa             # скопируйте приватный для GitHub Secrets
```

### Шаг 3 — Проверка авто-деплоя

```bash
# На компьютере — измените любой файл и запушьте
git add .
git commit -m "test deploy"
git push origin main
```

GitHub Actions автоматически: зайдёт на сервер → сделает `git pull` → пересоберёт Docker → перезапустит бот.

Статус деплоя: GitHub → Actions → последний workflow.

**Управление на сервере:**
```bash
cd ~/ai_agent_capper
docker compose logs -f        # логи
docker compose ps             # статус
docker compose restart        # перезапуск вручную
```

---

## Команды бота

| Что написать                     | Что получите                       |
| -------------------------------- | ---------------------------------- |
| Матчи + кэфы в свободном формате | Анализ + экспресс                  |
| `/статистика`                    | Банк, W/L, серия, последние ставки |
| `/игроки`                        | Список игроков в базе              |
| `/результат`                     | Кнопки ✅ W / ❌ L / ↩️ Возврат       |

## Формат запроса

```
Текущий банк: 10 000₽
Букмекер: Лига Ставок

События:
Навоне vs Меджедович, Рим, грунт
Кэфы: П1 = 2.25, П2 = 1.65
Фора: П1(+1.5) = 1.50, П1(-1.5) = 3.70, П2(-1.5) = 2.50, П2(+1.5) = 1.25

Синнер vs Попырин, Рим, грунт
Кэфы: П1 = 1.01, П2 = 15.00
Фора: П1(-1.5) = 1.17, П1(+1.5) = 1.01, П2(+1.5) = 4.60, П2(-1.5) = 25.00
```

---

## Как работает бот

Бот использует **tool use** — Claude сам вызывает инструменты в процессе анализа:

1. Получает ваш запрос
2. Смотрит кто есть в базе (`list_files`)
3. Ищет данные в интернете (`web_search`) для новых игроков
4. Записывает профили в базу (`write_file`)
5. Читает историю ставок и текущее состояние игроков (`read_file`)
6. Формирует экспресс по стратегии
7. Возвращает результат в Telegram

В Telegram вы видите статус в реальном времени: `Шаг 3: Ищу: Sinner ATP ranking 2026...`
