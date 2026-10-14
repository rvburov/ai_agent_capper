import core from 'virtual:capper-texts/core';
import rest from 'virtual:capper-texts/rest';
import { describe, expect, it } from 'vitest';

import i18n, { FALLBACK_LANGUAGE, LANGUAGES, pickLanguage } from '.';
import ru from './locales/ru.json';
import { CORE_TEXTS, SCREEN_SECTIONS, SCREEN_TEXTS, screenTexts, splitTexts } from './sections';

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

// ---------- тексты частями: ядро и разделы экранов ----------

type Texts = { [key: string]: unknown };

/** Все пути к строкам: «nav.dashboard», «format.monthsShort». */
function leaves(texts: Texts, prefix = ''): string[] {
  return Object.entries(texts).flatMap(([key, value]) =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? leaves(value as Texts, `${prefix}${key}.`) : [`${prefix}${key}`],
  );
}

function get(texts: Texts, path: string): unknown {
  return path.split('.').reduce<unknown>((node, part) => (node && typeof node === 'object' ? (node as Texts)[part] : undefined), texts);
}

describe('тексты: ядро и разделы экранов', () => {
  it('файл делится без потерь и повторов: ядро + остальное = весь ru.json', () => {
    const { core: head, rest: tail } = splitTexts(ru);
    const all = leaves(ru).sort();
    expect([...leaves(head), ...leaves(tail)].sort()).toEqual(all);
    for (const path of leaves(head)) expect(get(head, path)).toEqual(get(ru, path));
    // исходный объект не меняется
    expect(leaves(ru)).toHaveLength(all.length);
  });

  it('все вне ядра — разделы экранов', () => {
    const sections: readonly string[] = SCREEN_SECTIONS;
    expect(Object.keys(splitTexts(ru).rest).filter((key) => !sections.includes(key))).toEqual([]);
  });

  it('плагин сборки отдает ту же разбивку по каждому языку; тексты экрана — его ветки', async () => {
    expect(Object.keys(core)).toEqual(Object.keys(rest));
    expect(core.ru).toEqual(splitTexts(ru).core);
    expect(rest.ru).toEqual(splitTexts(ru).rest);
    const deletion = (await import('virtual:capper-texts/screen/profile/deletion/DeletionPendingScreen')).default;
    expect(deletion.ru).toEqual(screenTexts(ru, SCREEN_TEXTS['profile/deletion/DeletionPendingScreen']));
    expect(Object.keys(deletion.ru ?? {})).toEqual(['profile']);
    expect(Object.keys((deletion.ru?.profile ?? {}) as Texts)).toEqual(['deletion']);
    // ветка множественного числа — все формы
    expect(screenTexts(ru, ['bets.count'])).toEqual({ bets: Object.fromEntries(Object.entries(ru.bets).filter(([key]) => key.startsWith('count_'))) });
  });

  it('каждая ветка в списках экранов есть в ru.json и не в ядре', () => {
    for (const [page, paths] of Object.entries(SCREEN_TEXTS)) {
      for (const path of paths) {
        const tail = splitTexts(ru).rest;
        expect(get(tail, path) ?? get(tail, `${path}_one`), `${page}: ${path}`).toBeDefined();
      }
    }
  });

  it('каждый путь ядра есть в ru.json', () => {
    for (const path of CORE_TEXTS) expect(get(ru, path), path).toBeDefined();
  });

  it('ядро — малая часть текстов: экраны свои тексты грузят сами', () => {
    const size = (texts: unknown) => JSON.stringify(texts).length;
    expect(size(core.ru)).toBeLessThan(size(ru) * 0.25);
  });
});

// ---------- что берут экраны: импорты и ключи по исходникам ----------

const SOURCES = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../**/*.d.ts', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
});

// Комментарии не код: ключ, упомянутый в комментарии, экрану не нужен
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Путь от src: «../pages/x/X.tsx» → «pages/x/X.tsx»
const FILES = new Map(Object.entries(SOURCES).map(([file, source]) => [file.replace(/^\.\.\//, ''), withoutComments(source)]));

function resolveImport(from: string, spec: string): string | null {
  const parts = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const base = parts.join('/');
  for (const file of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) if (FILES.has(file)) return file;
  return null;
}

const STATIC_IMPORT = /(?:^|\n)\s*(?:import|export)\s(?:[^'"]*?\sfrom\s)?['"](\.[^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;

/** Файл и все, что он импортирует (с динамическими import() или без). */
function closure(start: string, { dynamic }: { dynamic: boolean }): Set<string> {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = FILES.get(file) ?? '';
    const specs = [...source.matchAll(STATIC_IMPORT), ...(dynamic ? source.matchAll(DYNAMIC_IMPORT) : [])].map((m) => m[1] ?? '');
    for (const spec of specs) {
      const next = resolveImport(file, spec);
      if (next) stack.push(next);
    }
  }
  return seen;
}

const SECTION_KEY = new RegExp(`['"\`]((?:${SCREEN_SECTIONS.join('|')})\\.[A-Za-z0-9_.]*)`, 'g');

/** Ключи разделов экранов в строках файла: «profile.data.title» или начало шаблона «analysis.surface.». */
function sectionKeys(source: string): string[] {
  return [...source.matchAll(SECTION_KEY)]
    .map((m) => (m[1] ?? '').replace(/\.+$/, ''))
    .filter((key) => get(ru, key) !== undefined || get(ru, `${key}_one`) !== undefined);
}

function inCoreTexts(key: string): boolean {
  const head = core.ru as Texts;
  return get(head, key) !== undefined || get(head, `${key}_one`) !== undefined;
}

/** Ключи из closure, которых нет ни в ядре, ни в ветках paths экрана: «файл: ключ». */
function uncovered(files: Iterable<string>, paths: readonly string[]): string[] {
  const missing: string[] = [];
  for (const file of files) {
    for (const key of sectionKeys(FILES.get(file) ?? '')) {
      const loaded = paths.some((path) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}_`));
      if (!inCoreTexts(key) && !loaded) missing.push(`${file}: ${key}`);
    }
  }
  return [...new Set(missing)].sort();
}

describe('экран грузит все свои тексты', () => {
  it('нашли исходники', () => {
    expect(FILES.has('pages/profile/ProfilePage.tsx')).toBe(true);
    expect(closure('pages/profile/ProfilePage.tsx', { dynamic: true }).has('pages/profile/data/DataTab.tsx')).toBe(true);
  });

  it.each(Object.entries(SCREEN_TEXTS))('%s: ключи экрана и его импортов — в ядре или в его ветках', (page, paths) => {
    const file = `pages/${page}.tsx`;
    expect(FILES.has(file), file).toBe(true);
    expect(uncovered(closure(file, { dynamic: true }), paths)).toEqual([]);
  });

  it('начальная загрузка (main.tsx без ленивых экранов) берет тексты только из ядра', () => {
    expect(uncovered(closure('main.tsx', { dynamic: false }), [])).toEqual([]);
  });

  it('каждый ленивый экран грузит свои тексты (virtual:capper-texts/screen/<экран>)', () => {
    const screens: string[] = [];
    const call = /lazyPage\(\s*\(\)\s*=>\s*import\('(?:\.\.\/)+pages\/([^']+)'\)[^;]*?import\('virtual:capper-texts\/screen\/([^']+)'\)/g;
    for (const [file, source] of FILES) {
      if (file === 'app/lazyPage.ts') continue;
      const found = [...source.matchAll(call)];
      for (const m of found) {
        expect(m[2], `${file}: ${m[1]}`).toBe(m[1]);
        screens.push(m[1] ?? '');
      }
      expect(found.length, `${file}: lazyPage без текстов экрана`).toBe((source.match(/\blazyPage\(/g) ?? []).length);
    }
    expect(screens.sort()).toEqual(Object.keys(SCREEN_TEXTS).sort());
  });
});

// Оболочка (меню, шапка, колокольчик, ошибки) рисуется до того, как первый экран загрузит тексты
// экранов: каждый ее ключ t('…') должен быть в ядре. Компоненты, которые рисуют только экраны
// (форма игрока, свежесть данных, покрытие), — исключение: экран грузит тексты до отрисовки.
const SHELL_SOURCES = import.meta.glob<string>(
  [
    '../app/**/*.{ts,tsx}',
    '../api/**/*.ts',
    '../lib/format.ts',
    '../features/notifications/*.ts',
    '../features/admin/useAdminAttention.ts',
    '../pages/not-found/*.tsx',
    '../pages/stub/*.tsx',
    '../components/*.tsx',
    '!../**/*.test.{ts,tsx}',
  ],
  { query: '?raw', import: 'default', eager: true },
);

/** Ключи t('…'): полный ключ или начало шаблона t(`nav.${id}`) — «nav.». */
function usedKeys(source: string): string[] {
  return [...source.matchAll(/\bt\(\s*['"`]([A-Za-z0-9_.]+)/g)].map((match) => match[1] ?? '');
}

function inCore(key: string): boolean {
  const head = core.ru as Texts;
  if (key.endsWith('.')) {
    const section = get(head, key.slice(0, -1));
    return typeof section === 'object' && section !== null;
  }
  // множественное число: t('x', { count }) берет x_one, x_few …
  return get(head, key) !== undefined || get(head, `${key}_one`) !== undefined;
}

describe('оболочка рисуется на текстах ядра', () => {
  it('нашли файлы оболочки', () => {
    expect(Object.keys(SHELL_SOURCES).some((file) => file.endsWith('app/layout/Sidebar.tsx'))).toBe(true);
    expect(Object.keys(SHELL_SOURCES).some((file) => file.endsWith('components/Modal.tsx'))).toBe(true);
  });

  it('каждый ключ t() оболочки — в ядре', () => {
    const missing: string[] = [];
    for (const [file, source] of Object.entries(SHELL_SOURCES)) {
      for (const key of usedKeys(source)) if (!inCore(key)) missing.push(`${file}: ${key}`);
    }
    expect(missing).toEqual([]);
  });

});
