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
npm run e2e          # Playwright: смоук оболочки на 375 и 1366 px, светлая и темная темы
```

`npm run e2e` сам собирает приложение и поднимает `vite preview`; API подменяется в тестах, backend не нужен. Chromium берется из `PLAYWRIGHT_BROWSERS_PATH`; версия `@playwright/test` закреплена под установленный браузер (1.56.1 — Chromium 1194). На своей машине: `npx playwright install chromium`.

## Где что лежит

```
frontend/
├── index.html, public/       theme-init.js (тема до первой отрисовки), favicon
├── openapi.json              схема API бэкенда (генерируется)
├── scripts/                  gen-api.mjs и пакет генератора типов openapi-ts/
├── e2e/                      тесты Playwright (playwright.config.ts в корне)
└── src/
    ├── main.tsx              точка входа: шрифты, стили, <App />
    ├── app/                  провайдеры, маршруты (router.tsx), адреса (paths.ts)
    │   ├── layout/           оболочка: AppShell, боковая панель, шапка, нижние вкладки, «Еще», меню пользователя,
    │   │                     колокольчик (NotificationsBell)
    │   ├── guards/           RequireAuth (нет сеанса → /login?next=...), RequireAdmin
    │   └── theme/            светлая, темная, как в системе; выбор в localStorage
    ├── pages/                экраны, по папке на экран (auth — вход, регистрация, сброс); разделы следующих этапов — заглушки
    ├── features/             хуки запросов и логика разделов без разметки: auth (шаги входа), notifications
    ├── components/           компоненты из макета: Button, Card, Dropdown (один на все приложение),
    │                         Modal, Toast, DataTable, Field и др.; графики появятся в components/charts/
    ├── api/                  клиент openapi-fetch (CSRF, ошибки → ApiError), TanStack Query, хуки
    ├── i18n/                 переводы: locales/ru.json — все тексты; ключи t('...') проверяет tsc
    ├── lib/                  format.ts (деньги, кэфы, проценты, даты), утилиты
    ├── styles/               tokens.css (токены макета), global.css, components.css, shell.css
    └── test/                 настройка vitest и подмена fetch
```

Правила, которые легко нарушить:

- Тексты — только `t('раздел.ключ')` из `src/i18n/locales/ru.json`, даже в `aria-label`.
- Деньги, проценты, кэфы и даты — только через `src/lib/format.ts`; даты показываются в часовом поясе пользователя (`users.tz`). Пояс ставит клиент запросов, когда в кэше меняется профиль (`meQueryKey`), поэтому после входа достаточно `queryClient.setQueryData(meQueryKey, user)`.
- Возврат после входа — только через `safeNext(next)` из `src/app/paths.ts`: он отбрасывает чужие адреса.
- Выпадающий список — только `Dropdown`, без `select` и `datalist`.
- Цвета и размеры — токены из `src/styles/tokens.css`.
- Данные с сервера — `api` из `src/api/client.ts` + TanStack Query; ошибка — `ApiError`, показываем ее `message`.
