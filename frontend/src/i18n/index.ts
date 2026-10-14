/// <reference path="./texts.d.ts" />
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import core from 'virtual:capper-texts/core';

/*
 * Все тексты интерфейса — в locales/<язык>.json (Р18). Каждый файл папки подключается сам:
 * английский добавляется файлом en.json без правки кода. Язык — первый из языков браузера,
 * для которого есть файл, иначе русский; недостающие в файле тексты тоже берутся из русского.
 *
 * Сразу, синхронно — только ядро: оболочка, меню, ошибки, форматы и общие компоненты (список —
 * sections.ts). Тексты экрана — отдельным файлом сборки: экран грузит его вместе со своим кодом
 * (src/app/lazyPage.ts, SCREEN_TEXTS) и рисуется уже со своими текстами. Так первый экран не
 * несет тексты всех экранов (docs/PLAN.md: JS первого экрана < 250 КБ gzip).
 */
export const FALLBACK_LANGUAGE = 'ru';

// Копия: i18next дописывает в ресурсы тексты экранов (addResourceBundle), а модуль ядра — только для чтения
const resources = Object.fromEntries(
  Object.entries(core).map(([language, translation]) => [language, { translation: structuredClone(translation) }]),
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

/** Модуль текстов сборки: { <язык>: тексты } (virtual:capper-texts/*, src/i18n/texts.d.ts). */
export type TextsModule = { default: Record<string, Record<string, unknown>> };

/** Добавить загруженные тексты (экрана или все) к ядру. */
export function addTexts({ default: texts }: TextsModule): void {
  for (const [language, part] of Object.entries(texts)) {
    i18n.addResourceBundle(language, 'translation', part, true, false);
  }
}

let allTexts: Promise<void> | null = null;

/**
 * Все тексты вне ядра — один раз на вкладку: тесты экранов и запасной путь, если экрану не
 * хватило текста. Не загрузились — следующий вызов пробует снова.
 */
export function loadAllTexts(): Promise<void> {
  allTexts ??= import('virtual:capper-texts/rest').then(addTexts, (error: unknown) => {
    allTexts = null;
    throw error;
  });
  return allTexts;
}

void i18n.use(initReactI18next).init({
  resources,
  lng: pickLanguage(browserLanguages()),
  fallbackLng: FALLBACK_LANGUAGE,
  supportedLngs: LANGUAGES,
  initAsync: false,
  interpolation: { escapeValue: false },
  // Тексты экрана добавились — компоненты на экране перерисовываются с ними
  react: { bindI18nStore: 'added' },
  // Запасной путь: экрану понадобился текст раздела, которого нет в его списке (например, ключ
  // пришел с сервера), — догружаем остальные разделы, и экран перерисуется с текстом. Списки
  // экранов проверяет i18n.test.ts, так что в обычной работе этого не происходит
  saveMissing: true,
  missingKeyHandler: () => {
    loadAllTexts().catch(() => undefined);
  },
});

export default i18n;
