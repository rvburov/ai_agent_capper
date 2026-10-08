import { describe, expect, it } from 'vitest';

import i18n, { FALLBACK_LANGUAGE, LANGUAGES, pickLanguage } from '.';

describe('i18n', () => {
  it('подключает все файлы locales, русский — запасной язык', () => {
    expect(LANGUAGES).toContain('ru');
    expect(i18n.language).toBe('ru');
    expect(document.documentElement.lang).toBe('ru');
  });

  it('язык — первый из языков браузера, для которого есть файл', () => {
    expect(pickLanguage(['en-US', 'en'], ['ru'])).toBe(FALLBACK_LANGUAGE);
    expect(pickLanguage(['de-DE', 'en-GB', 'ru'], ['ru', 'en'])).toBe('en');
    expect(pickLanguage(['ru-RU'], ['ru', 'en'])).toBe('ru');
    expect(pickLanguage([], ['ru', 'en'])).toBe(FALLBACK_LANGUAGE);
  });
});
