# Frontend

Интерфейс AI Capper: React 19 + TypeScript 7 + Vite 8. Экраны и поведение повторяют согласованный макет ([mockup/](../mockup/README.md)). Правила написания кода — в [CLAUDE.md](../CLAUDE.md).

## Запуск для разработки

Нужен Node.js 22.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, запросы /api уходят на backend (порт 8000)
```

Без запущенного backend оболочка покажет ошибку связи: `GET /api/me` — первый запрос приложения.

## Типы API

Типы запросов и ответов генерируются из OpenAPI бэкенда и руками не дублируются:

```bash
npm run gen:api      # backend → openapi.json → src/api/schema.d.ts
```

Скрипт `scripts/gen-api.mjs` запускает `python -m app.openapi_export` из `../backend` (Python из `backend/.venv`, а если его нет — `python3`; сервер и база не нужны), затем `openapi-typescript`. Генератор работает только с TypeScript 5, а приложение собирается TypeScript 7, поэтому он стоит отдельным пакетом в `scripts/openapi-ts/` со своим `package-lock.json` и при первом запуске ставится сам. Оба файла (`openapi.json`, `src/api/schema.d.ts`) коммитятся; после изменения API бэкенда — перегенерировать.

## Проверки

```bash
npm run typecheck    # tsc: приложение и e2e
npm run test         # vitest: форматирование, компоненты, клиент API, защита маршрутов
npm run build        # tsc + vite build → dist/
npm run e2e          # Playwright: смоук оболочки и сквозные сценарии на настоящем API
```

### Сквозные тесты (Playwright)

Три проекта в `playwright.config.ts`:

- `shell` — смоук оболочки на 375 и 1366 px в обеих темах, API подменяется в самих тестах (`e2e/shell.spec.ts`);
- `desktop` (1366 px) и `mobile` (375 px, сенсорный экран) — сценарии `e2e/flows/` на настоящем backend:
  1. администратор из терминала: первый вход, настройка 2FA, резервные коды, вход с кодом и резервным кодом;
  2. приглашение → регистрация → 2FA; у участника нет «Администрирования» ни в меню, ни по адресам `/admin/*`, API отвечает 403;
  3. код сброса от администратора → новый пароль на `/reset` → вход с 2FA, старый пароль не подходит;
  4. пять неверных паролей → экран «Вход временно закрыт» с отсчетом; с другого IP вход работает;
  5. участник завершает сеанс на другом устройстве — то уходит на вход с «Сеанс завершен»;
  6. блокировка закрывает открытый сеанс участника, после разблокировки вход работает.

Стек для них поднимает `scripts/e2e-stack.sh` (Playwright запускает его сам): временная база `capper_e2e_<порт>` с миграциями, свой префикс ключей Redis, uvicorn на порту 8000 (`CAPPER_ENV=test`), сборка фронтенда и `vite preview` на 4173 с прокси `/api`. При остановке база и ключи удаляются. Нужны PostgreSQL и Redis, как для тестов backend (`capper:capper@localhost:5432`, `localhost:6379`), и зависимости backend (`backend/.venv` или `python3`).

```bash
npx playwright test                          # все: стек поднимется и остановится сам
npx playwright test --project=desktop        # только сценарии на 1366 px
bash ../scripts/e2e-stack.sh                 # стек в отдельном терминале: тесты его переиспользуют,
                                             # а в браузере можно войти как owner@e2e.test
                                             # (пароль — в начале скрипта)
E2E_API_PORT=8400 E2E_WEB_PORT=4400 npx playwright test   # если порты 8000 и 4173 заняты
```

Как устроены сценарии (`e2e/support/`):

- Администраторов создает команда терминала: `bash scripts/e2e-stack.sh cli create-admin --email ... --password-stdin`. Подготовка, которая не проверяется в сценарии (2FA администратора, участник по приглашению), идет через API.
- Коды 2FA тест считает сам по секрету с экрана настройки (`support/totp.ts`, RFC 6238 на `node:crypto`). Сервер не принимает шаг кода дважды, поэтому помощник помнит последний шаг и берет следующий, без ожидания 30 секунд.
- У каждого браузера свой IP-адрес: заголовок `X-Forwarded-For` проходит через `vite preview`, а API верит ему от `127.0.0.1` (`CAPPER_TRUSTED_PROXIES`). Так лимиты попыток входа у тестов не пересекаются, а сценарий 4 проверяет паузу честно: один IP закрыт, другой входит.
- Почта и имена у каждого теста свои, поэтому тесты идут параллельно и повторяются на уже запущенном стеке. Ответ API 5xx и необработанное исключение на странице валят тест, даже если сценарий прошел.
- `vite preview` отдает ту же CSP, что Caddy: `vite.config.ts` берет ее строкой из `deploy/Caddyfile`. Нарушение CSP (встроенный скрипт, стиль или ресурс `data:`, которые сайт не пустит) — ошибка в консоли, и тест падает; смоук `shell` сверяет заголовок с Caddyfile.

В CI это job `e2e` (`.github/workflows/ci.yml`): службы PostgreSQL и Redis, `npx playwright install --with-deps chromium`, `npx playwright test`; при падении — артефакт `playwright-report` (HTML-отчет, трассы, скриншоты и логи стека). Локально Chromium берется из `PLAYWRIGHT_BROWSERS_PATH`; версия `@playwright/test` закреплена под установленный браузер (1.56.1 — Chromium 1194). На своей машине: `npx playwright install chromium`. Отчет после падения: `npx playwright show-report` или `npx playwright show-trace test-results/<тест>/trace.zip`.

## Где что лежит

```
frontend/
├── index.html, public/       theme-init.js (тема до первой отрисовки), favicon
├── openapi.json              схема API бэкенда (генерируется)
├── scripts/                  gen-api.mjs и пакет генератора типов openapi-ts/
├── e2e/                      тесты Playwright (playwright.config.ts в корне): shell.spec.ts — смоук оболочки,
│                             flows/ — сквозные сценарии на настоящем API, support/ — помощники
└── src/
    ├── main.tsx              точка входа: шрифты, стили, <App />
    ├── app/                  провайдеры, маршруты (router.tsx), адреса (paths.ts)
    │   ├── layout/           оболочка: AppShell, боковая панель, шапка, нижние вкладки, «Еще», меню пользователя,
    │   │                     колокольчик (NotificationsBell)
    │   ├── guards/           RequireAuth (нет сеанса → /login?next=...), RequireAdmin
    │   └── theme/            светлая, темная, как в системе; выбор в localStorage
    ├── pages/                экраны, по папке на экран (auth — вход, регистрация, сброс); разделы следующих этапов — заглушки
    ├── features/             хуки запросов и логика разделов без разметки: auth (шаги входа), notifications,
    │                         profile (сеансы, устройства, журнал входов, пароль), admin (участники, приглашения,
    │                         коды сброса, журнал действий)
    ├── components/           компоненты из макета: Button, Card, Dropdown (один на все приложение),
    │                         Modal, Toast, DataTable, Field, ActionMenu (меню «⋯»: popover на компьютере,
    │                         шторка на телефоне), ChoiceCards (выбор карточками) и др.;
    │                         графики появятся в components/charts/
    ├── api/                  клиент openapi-fetch (CSRF, ошибки → ApiError), TanStack Query, хуки
    ├── i18n/                 переводы: locales/ru.json — все тексты; ключи t('...') проверяет tsc
    ├── lib/                  format.ts (деньги, кэфы, проценты, даты), утилиты
    ├── styles/               tokens.css (токены макета), global.css, components.css, shell.css
    └── test/                 настройка vitest и подмена fetch
```

Правила, которые легко нарушить:

- Тексты — только `t('раздел.ключ')` из `src/i18n/locales/ru.json`, даже в `aria-label`. Каждый файл `locales/*.json` подключается сам (`src/i18n/index.ts`): английский — файл `en.json` без правки кода, язык берется из браузера, запасной — русский.
- Деньги, проценты, кэфы и даты — только через `src/lib/format.ts`; даты показываются в часовом поясе пользователя (`users.tz`). Пояс ставит клиент запросов, когда в кэше меняется профиль (`meQueryKey`), поэтому после входа достаточно `queryClient.setQueryData(meQueryKey, user)`.
- Возврат после входа — только через `safeNext(next)` из `src/app/paths.ts`: он отбрасывает чужие адреса.
- Выпадающий список — только `Dropdown`, без `select` и `datalist`.
- Цвета и размеры — токены из `src/styles/tokens.css`.
- Данные с сервера — `api` из `src/api/client.ts` + TanStack Query; ошибка — `ApiError`, показываем ее `message`.
