import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

/*
 * Все тексты интерфейса — в locales/<язык>.json (Р18). Каждый файл папки подключается сам:
 * английский добавляется файлом en.json без правки кода. Язык — первый из языков браузера,
 * для которого есть файл, иначе русский; недостающие в файле тексты тоже берутся из русского.
 * Ресурсы встроены в сборку, поэтому инициализация синхронная: тексты готовы до первой отрисовки.
 */
export const FALLBACK_LANGUAGE = 'ru';

const files = import.meta.glob<Record<string, unknown>>('./locales/*.json', {
  eager: true,
  import: 'default',
});

const resources = Object.fromEntries(
  Object.entries(files).map(([path, translation]) => [
    path.replace(/^.*\/([^/]+)\.json$/, '$1'),
    { translation },
  ]),
);

export const LANGUAGES: readonly string[] = Object.keys(resources);

/** Язык интерфейса: первый из языков браузера, для которого есть файл перевода. */
export function pickLanguage(wanted: readonly string[], available: readonly string[] = LANGUAGES): string {
  for (const tag of wanted) {
    const base = tag.toLowerCase().split('-')[0];
    if (base && available.includes(base)) return base;
  }
  return FALLBACK_LANGUAGE;
}

function browserLanguages(): readonly string[] {
  if (typeof navigator === 'undefined') return [];
  return navigator.languages.length > 0 ? navigator.languages : [navigator.language];
}

// <html lang> — язык текста на странице (озвучка экрана, переносы, проверка орфографии)
i18n.on('languageChanged', (language) => {
  if (typeof document !== 'undefined') document.documentElement.lang = language;
});

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(browserLanguages()),
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: LANGUAGES,
  initAsync: false,
  interpolation: { escapeValue: false },
});

export default i18n;
