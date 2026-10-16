import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import ru from '../i18n/locales/ru.json';
import { SHELL_STATIC } from './build';
import { writePwaFiles, type PwaSources } from './plugin';
import swSource from './sw.js?raw';

// Плагин сборки PWA: версия sw.js — по содержимому файлов оболочки в dist, а не по их именам.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const SOURCES: PwaSources = { texts: ru, tokensCss: read('../styles/tokens.css'), swSource };
const INDEX = '<script type="module" src="/assets/index-a1.js"></script><link rel="stylesheet" href="/assets/index-c3.css">';

/** dist как после vite build: index.html, файлы сборки и файлы из public. */
function fakeDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'capper-pwa-'));
  mkdirSync(join(dir, 'assets'));
  mkdirSync(join(dir, 'icons'));
  writeFileSync(join(dir, 'index.html'), INDEX);
  writeFileSync(join(dir, 'assets/index-a1.js'), 'console.log(1)');
  writeFileSync(join(dir, 'assets/index-c3.css'), 'body{}');
  for (const path of SHELL_STATIC) {
    if (['/index.html', '/offline.html', '/manifest.webmanifest'].includes(path)) continue;
    writeFileSync(join(dir, path), `content of ${path}`);
  }
  return dir;
}

const sw = (dir: string) => readFileSync(join(dir, 'sw.js'), 'utf8');

describe('плагин PWA: sw.js в dist', () => {
  it('пишет манифест, offline.html и sw.js со списком оболочки', () => {
    const dir = fakeDist();
    writePwaFiles(dir, SOURCES);
    expect(JSON.parse(readFileSync(join(dir, 'manifest.webmanifest'), 'utf8'))).toMatchObject({ short_name: 'AI Capper' });
    expect(readFileSync(join(dir, 'offline.html'), 'utf8')).toContain('href="/assets/index-c3.css"');
    expect(sw(dir)).toContain('"/assets/index-a1.js"');
    expect(sw(dir)).toContain('"/theme-init.js"');
  });

  it('та же сборка — тот же sw.js; поменялось содержимое файла под тем же именем — другая версия', () => {
    const dir = fakeDist();
    const first = writePwaFiles(dir, SOURCES);
    const firstSw = sw(dir);
    expect(writePwaFiles(dir, SOURCES)).toBe(first);
    expect(sw(dir)).toBe(firstSw);
    for (const path of ['/theme-init.js', '/offline.js', '/favicon.svg', '/icons/icon-192.png', '/icons/badge-96.png', '/assets/index-c3.css']) {
      const before = writePwaFiles(dir, SOURCES);
      writeFileSync(join(dir, path), `changed ${path} ${before}`);
      const after = writePwaFiles(dir, SOURCES);
      expect(after, path).not.toBe(before);
      expect(sw(dir)).toContain(`"version":"${after}"`);
    }
  });

  it('поменялся текст страницы «Нет связи» — другая версия', () => {
    const dir = fakeDist();
    const before = writePwaFiles(dir, SOURCES);
    const texts = structuredClone(ru);
    texts.pwa.offline.title = 'Связи нет';
    expect(writePwaFiles(dir, { ...SOURCES, texts })).not.toBe(before);
  });
});
