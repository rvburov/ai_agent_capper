import 'i18next';

import type ru from './locales/ru.json';

// Ключи t('...') проверяются при сборке: опечатка в ключе — ошибка tsc, а не пустой текст.
declare module 'i18next' {
  interface CustomTypeOptions {
    resources: { translation: typeof ru };
  }
}
