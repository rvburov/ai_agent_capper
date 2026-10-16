// Значки приложения (PWA) из исходников макета: npm run gen:icons.
// SVG — mockup/icons/*.svg (В9, mockup/README.md, «Значок приложения и экран-заставка»),
// PNG — frontend/public/icons/. Растеризует Chromium из Playwright (он уже стоит для e2e),
// поэтому новых зависимостей нет. PNG коммитятся: в Docker-сборке макета рядом нет.
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from '@playwright/test';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(frontend, '../mockup/icons');
const out = join(frontend, 'public/icons');

// файл PNG → исходник и размер; opaque — без прозрачности (iPhone скругляет углы сам)
const ICONS = [
  { file: 'icon-192.png', svg: 'icon.svg', size: 192 },
  { file: 'icon-512.png', svg: 'icon.svg', size: 512 },
  { file: 'icon-maskable-512.png', svg: 'icon-maskable.svg', size: 512, opaque: true },
  { file: 'apple-touch-icon.png', svg: 'icon-maskable.svg', size: 180, opaque: true },
  { file: 'badge-96.png', svg: 'badge.svg', size: 96 },
];

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const icon of ICONS) {
    const svg = readFileSync(join(source, icon.svg), 'utf8').replace(
      /<svg\b([^>]*?)\swidth="\d+"\s+height="\d+"/,
      `<svg$1 width="${icon.size}" height="${icon.size}"`,
    );
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`,
    );
    await page.screenshot({
      path: join(out, icon.file),
      clip: { x: 0, y: 0, width: icon.size, height: icon.size },
      omitBackground: !icon.opaque,
    });
    console.log(`${icon.file}: ${icon.size}×${icon.size} из ${icon.svg}`);
  }
} finally {
  await browser.close();
}
