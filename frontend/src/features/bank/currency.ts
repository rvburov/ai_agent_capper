import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { isApiError } from '../../api/errors';
import { analysisKeys } from '../analysis/keys';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from '../bets/keys';
import { publicSettingsKey } from '../profile/keys';
import { publicSettingsQuery } from '../profile/usePublicSettings';

// Ключ лимитов ответственной игры (GET /api/me/play-limits) — здесь, а не в playLimits.ts:
// сброс после смены валюты нужен формам ставки и анализа, а им ни к чему код лимитов
export const playKeys = {
  limits: ['play-limits'] as const,
};

/**
 * Все данные с суммами в валюте программы (Р17): валюта, банк и его журнал (analysisKeys.bank —
 * он же bankKeys.all), анализы, лимиты ответственной игры, ставки и их итоги, главная и
 * «Аналитика». После смены валюты их перечитываем вместе — иначе на одном экране суммы в разных
 * валютах.
 */
export const MONEY_QUERIES: readonly QueryKey[] = [
  publicSettingsKey,
  analysisKeys.bank,
  analysisKeys.all,
  playKeys.limits,
  betKeys.all,
  DASHBOARD_PREFIX,
  ANALYTICS_PREFIX,
];

/** Перечитать все суммы (MONEY_QUERIES): открытые экраны — сразу, остальные — при открытии. */
export function refreshMoney(client: QueryClient): Promise<unknown> {
  return Promise.all(MONEY_QUERIES.map((queryKey) => client.invalidateQueries({ queryKey })));
}

/**
 * Валюта программы сменилась, пока форма была открыта (409 common.currency_changed): суммы на
 * экране — в прежней валюте. Перечитываем все суммы — форма покажет новые, и человек повторит
 * действие уже в новой валюте.
 */
export function refreshAfterCurrencyChange(client: QueryClient, error: unknown): void {
  if (!isApiError(error) || error.code !== 'common.currency_changed') return;
  void refreshMoney(client);
}

// Ответы, у которых поле currency — валюта программы, а не валюта одной записи
const PROGRAM_CURRENCY: readonly QueryKey[] = [
  publicSettingsKey,
  analysisKeys.bank,
  playKeys.limits,
  DASHBOARD_PREFIX,
  ANALYTICS_PREFIX,
  ['bets', 'summary'],
];

function startsWith(key: QueryKey, prefix: QueryKey): boolean {
  return prefix.every((part, i) => key[i] === part);
}

/** Валюта программы из ответа, если ответ ее несет (поле currency верхнего уровня). */
export function programCurrencyOf(key: QueryKey, data: unknown): string | null {
  if (!PROGRAM_CURRENCY.some((prefix) => startsWith(key, prefix))) return null;
  if (typeof data !== 'object' || data === null) return null;
  const currency = (data as { currency?: unknown }).currency;
  return typeof currency === 'string' ? currency : null;
}

function isSettings(key: QueryKey): boolean {
  return key.length === publicSettingsKey.length && startsWith(key, publicSettingsKey);
}

/**
 * Смену валюты администратором участник замечает без перезагрузки. Источник правды — настройки
 * программы (GET /api/settings): пришел ответ с суммами (главная, итоги «Ставок», банк в шапке,
 * «Аналитика», лимиты) в другой валюте, чем известная, — перечитываем настройки; настройки
 * пришли в новой валюте — перечитываем все суммы. Иначе экран, перечитанный раньше других (у
 * каждого свой срок свежести), показывал бы € рядом с плашкой банка в ₽. Сброс сумм — только по
 * настройкам, поэтому расходящиеся ответы не перезапрашивают друг друга по кругу. Возвращает
 * отписку.
 */
export function watchProgramCurrency(client: QueryClient): () => void {
  const cache = client.getQueryCache();
  let known: string | null = null;
  return cache.subscribe((event) => {
    if (event.type === 'removed' && cache.getAll().length === 0) {
      // выход: кэш очищен — валюту следующего входа узнаем заново
      known = null;
      return;
    }
    if (event.type !== 'updated' || event.action.type !== 'success') return;
    const key = event.query.queryKey;
    const currency = programCurrencyOf(key, event.query.state.data);
    if (currency === null) return;
    if (isSettings(key)) {
      const changed = known !== null && currency !== known;
      known = currency;
      if (changed) {
        for (const queryKey of MONEY_QUERIES) {
          if (!isSettings(queryKey)) void client.invalidateQueries({ queryKey });
        }
      }
      return;
    }
    if (known === null) {
      known = currency;
      return;
    }
    if (currency === known) return;
    // сумма пришла в другой валюте: спросить настройки, сменилась ли валюта программы
    const settings = cache.find({ queryKey: publicSettingsKey, exact: true });
    if (settings?.state.fetchStatus === 'fetching') return;
    if (settings) void client.invalidateQueries({ queryKey: publicSettingsKey, exact: true, refetchType: 'all' });
    else void client.fetchQuery(publicSettingsQuery).catch(() => undefined);
  });
}
