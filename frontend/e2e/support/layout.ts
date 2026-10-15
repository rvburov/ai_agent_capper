import { expect, type Locator, type Page } from '@playwright/test';

/*
 * Проверки раскладки на телефоне (CLAUDE.md, PLAN.md «Готово, когда»): страница не
 * прокручивается вбок на 360 и 375 px, зоны нажатия не меньше 40 px. Общие для смоука
 * оболочки (e2e/shell.spec.ts) и сквозных сценариев экранов (e2e/flows).
 */

/** Минимальная зона нажатия на телефоне, px (--tap в tokens.css). */
export const MIN_TAP = 40;

/** На сколько px страница шире окна (0 — горизонтальной прокрутки нет). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

export async function expectNoHorizontalScroll(page: Page): Promise<void> {
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
}

export interface TapTargetOptions {
  /** Где искать; по умолчанию — вся страница. */
  root?: Locator;
  /** Минимум по ширине и высоте, px. */
  min?: number;
  /** CSS-селектор того, что проверять не нужно (например, ссылка внутри абзаца текста). */
  exclude?: string;
}

/**
 * Видимые элементы, на которые нажимают, с зоной меньше min px по ширине или высоте:
 * «button "Показать таблицей" 120×32». Флажок и переключатель внутри подписи меряются по
 * подписи (нажимают на нее); ссылки внутри строки текста (WCAG 2.5.8) не считаются; зона,
 * расширенная псевдоэлементом ::before или ::after (position: absolute), считается целиком.
 */
export async function smallTapTargets(page: Page, options: TapTargetOptions = {}): Promise<string[]> {
  const root = options.root ?? page.locator('body');
  return root.evaluate(
    (element, { min, exclude }) => {
      const selector = [
        'a[href]',
        'button',
        'input:not([type="hidden"])',
        'select',
        'textarea',
        'summary',
        '[role="button"]',
        '[role="tab"]',
        '[role="link"]',
        '[role="menuitem"]',
        '[role="option"]',
        '[role="switch"]',
        '[role="checkbox"]',
      ].join(',');
      const out: string[] = [];
      for (const el of element.querySelectorAll<HTMLElement>(selector)) {
        if (exclude && el.matches(exclude)) continue;
        if (el.closest('[hidden], [aria-hidden="true"], [inert]')) continue;
        const style = getComputedStyle(el);
        if (style.visibility === 'hidden' || style.display === 'none') continue;
        // ссылка внутри предложения — часть текста (исключение WCAG 2.5.8): строчная и с текстом рядом
        const own = (el.textContent ?? '').trim().length;
        const around = (el.parentElement?.textContent ?? '').trim().length;
        if (el.tagName === 'A' && style.display === 'inline' && around > own) continue;
        let target: Element = el;
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          target = el.closest('label') ?? el;
        }
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        // зона нажатия, расширенная псевдоэлементом (::before с position: absolute, как у
        // .login-link): нажатие на него попадает в саму ссылку
        let width = rect.width;
        let height = rect.height;
        for (const pseudo of ['::before', '::after']) {
          const box = getComputedStyle(target, pseudo);
          if (box.content === 'none' || box.content === 'normal' || box.position !== 'absolute') continue;
          width = Math.max(width, parseFloat(box.width) || 0);
          height = Math.max(height, parseFloat(box.height) || 0);
        }
        if (width + 0.5 < min || height + 0.5 < min) {
          const name = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
          out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(width)}×${Math.round(height)}`);
        }
      }
      return out;
    },
    { min: options.min ?? MIN_TAP, exclude: options.exclude ?? null },
  );
}

export async function expectTapTargets(page: Page, options: TapTargetOptions = {}): Promise<void> {
  expect(await smallTapTargets(page, options)).toEqual([]);
}

/**
 * Раскладка экрана: нет горизонтальной прокрутки, а на телефоне (до 960 px) еще и зоны
 * нажатия не меньше 40 px — по умолчанию в области экрана (#view), без оболочки: шапку и
 * нижние вкладки проверяет смоук оболочки.
 */
export async function expectScreenLayout(page: Page, options: TapTargetOptions = {}): Promise<void> {
  await expectNoHorizontalScroll(page);
  const width = page.viewportSize()?.width ?? 0;
  if (width > 0 && width <= 960) {
    await expectTapTargets(page, { ...options, root: options.root ?? page.locator('#view') });
  }
}
