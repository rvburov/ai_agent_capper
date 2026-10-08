import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import ru from './locales/ru.json';

// Все тексты интерфейса — в locales/*.json. Английский добавляется файлом en.json без правки кода.
// Ресурсы встроены в сборку, поэтому инициализация синхронная: тексты готовы до первой отрисовки.
void i18n.use(initReactI18next).init({
  resources: { ru: { translation: ru } },
  lng: 'ru',
  fallbackLng: 'ru',
  initAsync: false,
  interpolation: { escapeValue: false },
});

export default i18n;
