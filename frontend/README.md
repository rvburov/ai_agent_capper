# Frontend

Интерфейс AI Capper: React + TypeScript + Vite. Экраны и поведение повторяют согласованный макет ([mockup/](../mockup/README.md)). Правила написания кода — в [CLAUDE.md](../CLAUDE.md).

## Запуск для разработки

Нужен Node.js 22.

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173, запросы /api уходят на backend (порт 8000)
```

## Проверки

```bash
npm run typecheck
npm run build
```

## Где что лежит

```
frontend/
├── index.html
├── vite.config.ts
├── public/              иконки и manifest для установки на телефон (PWA)
└── src/
    ├── main.tsx         точка входа
    ├── app/             корень приложения: маршруты, оболочка (меню, шапка), провайдеры
    ├── pages/           экраны, по папке на экран: home, login, dashboard, new-analysis, analysis,
    │                    bets, players, analytics, learning, costs, profile, admin
    ├── components/      общие компоненты: ui/ (кнопки, поля, выпадающий список, таблица, окна),
    │                    charts/ (графики)
    ├── api/             клиент API и типы, сгенерированные из OpenAPI бэкенда
    ├── i18n/            переводы: locales/ru.json — все тексты интерфейса
    ├── lib/             форматирование денег и дат, утилиты
    └── styles/          токены дизайна из макета и общие стили
```

Сейчас это каркас с одной страницей. Папки `components/` и `api/` появятся на этапе 1 вместе с первыми экранами.
