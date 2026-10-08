// Общая подготовка тестов vitest (jsdom): матчеры jest-dom и то, чего нет в jsdom.
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

import '../i18n';

// matchMedia: по умолчанию «компьютер»; тест может выставить телефон через setViewportWidth
let viewportWidth = 1366;

export function setViewportWidth(width: number): void {
  viewportWidth = width;
}

function matches(query: string): boolean {
  const max = /max-width:\s*(\d+)px/.exec(query);
  if (max?.[1]) return viewportWidth <= Number(max[1]);
  const min = /min-width:\s*(\d+)px/.exec(query);
  if (min?.[1]) return viewportWidth >= Number(min[1]);
  return false;
}

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string): MediaQueryList => ({
    get matches() {
      return matches(query);
    },
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
});

// jsdom не умеет прокрутку
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = function scrollIntoView() {};

afterEach(() => {
  cleanup();
  viewportWidth = 1366;
  document.cookie.split(';').forEach((part) => {
    const name = part.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; max-age=0; path=/`;
  });
});
