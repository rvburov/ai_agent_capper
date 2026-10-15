import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { isApiError } from '../../api/errors';
import type { components } from '../../api/schema';
import { formatNumber, type Currency } from '../../lib/format';
import { refreshMoney } from '../bank/currency';
import { adminKeys, invalidateAdmin } from './keys';

/*
 * «Администрирование → Настройки» (PANELS.settings макета admin.js): валюта программы со сменой
 * по курсу (Р17, Т30) и часовой пояс по умолчанию для новых участников. Что станет после
 * смены — считает сервер (PUT /api/admin/settings/currency с preview): число сумм у всех
 * участников, ваш банк до и после, признак «сумма не поместится». Суммы участников он не
 * показывает (Р14). Окно присылает валюту, от которой считает (from_currency): если ее уже сменил
 * другой администратор или другая вкладка, сервер отвечает 409 common.currency_changed и курс
 * чужой пары не применяет.
 */

export type AdminSettings = components['schemas']['AdminSettingsOut'];
export type CurrencyPreview = components['schemas']['CurrencyPreviewOut'];

export const CURRENCIES: readonly Currency[] = ['RUB', 'USD', 'EUR'];
// Границы курса — как на сервере (app/schemas/admin_settings.py, RATE_MIN и RATE_MAX)
export const RATE_MIN = 0.001;
export const RATE_MAX = 1000;
// Пауза в наборе курса до запроса предпросмотра
export const PREVIEW_DELAY_MS = 400;

export const settingsKeys = {
  settings: [...adminKeys.all, 'settings'] as const,
  // Предпросмотр — не под adminKeys.all: после смены валюты invalidateAdmin не должен
  // спрашивать предпросмотр заново (валюта уже другая — сервер ответил бы 409)
  previewAll: ['currency-preview'] as const,
  preview: (from: Currency, to: Currency, rate: string, base: Currency) =>
    ['currency-preview', from, to, rate, base] as const,
};

/**
 * Пара для курса, как в окне макета: в паре с рублем — «1 € = … ₽» или «1 $ = … ₽» (рубль
 * всегда справа), доллар и евро — «1 € = … $». base — валюта слева (rate_base), quote — справа.
 */
export function ratePair(from: Currency, to: Currency): { base: Currency; quote: Currency } {
  if (from === 'RUB' || to === 'RUB') return { base: to === 'RUB' ? from : to, quote: 'RUB' };
  return { base: 'EUR', quote: 'USD' };
}

/**
 * Курс из поля: запятая или точка, до 8 знаков после запятой, от RATE_MIN до RATE_MAX. Годный —
 * строка для API («95.12»), иначе null.
 */
export function parseRate(text: string): string | null {
  const value = text.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,8})?$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < RATE_MIN || number > RATE_MAX) return null;
  return value;
}

/** Знаков после запятой в курсе без хвостовых нулей: «95.12000000» → 2, «1» → 0. */
export function rateDigits(rate: string): number {
  const fraction = rate.split('.')[1] ?? '';
  return fraction.replace(/0+$/, '').length;
}

/** Курс для показа и для поля: «95,12», «1 000» (formatNumber, без лишних нулей). */
export function formatRate(rate: string): string {
  return formatNumber(rate, rateDigits(rate));
}

/**
 * Курс прошлой смены для поля окна, если пара та же: после «₽ → € по 1 € = 95,12 ₽» обратная
 * смена «€ → ₽» начнется с 95,12. Иначе поле пустое — курс вводит администратор.
 */
export function lastRateFor(
  change: AdminSettings['currency_changed'],
  pair: { base: Currency; quote: Currency },
): string {
  if (!change || change.rate_base !== pair.base) return '';
  const used = [change.from_currency, change.to_currency];
  return used.includes(pair.base) && used.includes(pair.quote) ? formatRate(change.rate) : '';
}

export function useAdminSettings() {
  return useQuery({
    queryKey: settingsKeys.settings,
    queryFn: () => unwrap(api.GET('/api/admin/settings')),
  });
}

/** Что станет при смене валюты from → to по курсу (без записи и без кода 2FA). */
export function useCurrencyPreview(
  from: Currency,
  to: Currency,
  rate: string | null,
  base: Currency,
  enabled: boolean,
) {
  return useQuery({
    queryKey: settingsKeys.preview(from, to, rate ?? '', base),
    queryFn: ({ signal }) =>
      unwrap(
        api.PUT('/api/admin/settings/currency', {
          body: { from_currency: from, currency: to, rate: rate ?? '', rate_base: base, preview: true },
          signal,
        }),
      ),
    enabled: enabled && rate !== null,
    staleTime: 0,
    gcTime: 60_000,
    retry: false,
  });
}

/**
 * После смены валюты: все суммы (валюта, банк, анализы, лимиты, ставки, главная, «Аналитика» —
 * MONEY_QUERIES) — в новой валюте; раздел администратора — заново (журнал, обзор).
 */
export function refreshAfterCurrency(client: QueryClient): Promise<unknown> {
  client.removeQueries({ queryKey: settingsKeys.previewAll });
  return Promise.all([invalidateAdmin(client), refreshMoney(client)]);
}

/** Валюту программы сменили, пока окно смены было открыто (409 common.currency_changed). */
export function isCurrencyStale(error: unknown): boolean {
  return isApiError(error) && error.code === 'common.currency_changed';
}

export function useChangeCurrency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: { from: Currency; currency: Currency; rate: string; base: Currency; totpCode: string }) =>
      unwrap(
        api.PUT('/api/admin/settings/currency', {
          body: {
            from_currency: body.from,
            currency: body.currency,
            rate: body.rate,
            rate_base: body.base,
            totp_code: body.totpCode,
            preview: false,
          },
        }),
      ),
    networkMode: 'always',
    onSuccess: () => refreshAfterCurrency(client),
    // Чужая смена: перечитать настройки и суммы — окно закроется, новое начнется от новой валюты
    onError: (error) => (isCurrencyStale(error) ? refreshAfterCurrency(client) : undefined),
  });
}

export function useUpdateDefaultTz() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (defaultTz: string) => unwrap(api.PUT('/api/admin/settings', { body: { default_tz: defaultTz } })),
    networkMode: 'always',
    onSuccess: (data) => {
      client.setQueryData(settingsKeys.settings, data);
      return invalidateAdmin(client);
    },
  });
}
