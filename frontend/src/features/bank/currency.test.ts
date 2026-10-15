import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { analysisKeys } from '../analysis/keys';
import { ANALYTICS_PREFIX, betKeys, DASHBOARD_PREFIX } from '../bets/keys';
import { staleQueriesFor } from '../notifications/notifications';
import { publicSettingsKey } from '../profile/keys';
import { MONEY_QUERIES, playKeys, programCurrencyOf, watchProgramCurrency } from './currency';

const summaryKey = [...betKeys.all, 'summary', {}] as const;

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const stop = watchProgramCurrency(client);
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  return { client, stop, invalidate };
}

describe('валюта программы', () => {
  it('валюту несут только ответы с валютой программы, а не валюта одной записи', () => {
    expect(programCurrencyOf(publicSettingsKey, { currency: 'RUB' })).toBe('RUB');
    expect(programCurrencyOf([...DASHBOARD_PREFIX, 'all'], { currency: 'EUR' })).toBe('EUR');
    expect(programCurrencyOf(summaryKey, { currency: 'USD' })).toBe('USD');
    expect(programCurrencyOf(betKeys.one(7), { currency: 'USD' })).toBeNull();
    expect(programCurrencyOf(analysisKeys.one(3), { currency: 'USD' })).toBeNull();
    expect(programCurrencyOf(analysisKeys.bank, null)).toBeNull();
  });

  it('ответ в новой валюте — перечитать настройки; настройки в новой валюте — все суммы', async () => {
    const { client, invalidate } = setup();
    client.setQueryData(publicSettingsKey, { currency: 'RUB' });
    client.setQueryData(analysisKeys.bank, { currency: 'RUB', balance: '49168.00' });
    client.setQueryData(summaryKey, { currency: 'RUB' });
    client.setQueryData([...ANALYTICS_PREFIX, 'all'], { currency: 'RUB' });
    expect(invalidate).not.toHaveBeenCalled();
    // главная перечиталась первой (истек срок свежести) — уже в евро: сначала спросить настройки
    client.setQueryData([...DASHBOARD_PREFIX, 'all'], { currency: 'EUR' });
    expect(invalidate.mock.calls.map(([filters]) => filters?.queryKey)).toEqual([publicSettingsKey]);
    invalidate.mockClear();
    // настройки ответили: валюта — евро; перечитать все суммы (кроме самих настроек)
    client.setQueryData(publicSettingsKey, { currency: 'EUR' });
    const keys = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(keys).toEqual(MONEY_QUERIES.filter((key) => key !== publicSettingsKey));
    expect(keys).toEqual(expect.arrayContaining([analysisKeys.bank, betKeys.all, ANALYTICS_PREFIX, DASHBOARD_PREFIX, playKeys.limits]));
    // остальные ответы пришли в той же новой валюте — второго сброса нет
    invalidate.mockClear();
    client.setQueryData(analysisKeys.bank, { currency: 'EUR', balance: '517.56' });
    client.setQueryData(summaryKey, { currency: 'EUR' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('ответы расходятся, а настройки те же — без перезапросов по кругу', () => {
    const { client, invalidate } = setup();
    client.setQueryData(publicSettingsKey, { currency: 'RUB' });
    client.setQueryData(analysisKeys.bank, { currency: 'USD' });
    expect(invalidate).toHaveBeenCalledTimes(1);
    // настройки перечитаны: та же валюта — суммы не сбрасываются
    client.setQueryData(publicSettingsKey, { currency: 'RUB' });
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it('после выхода (кэш очищен) валюта следующего входа — не смена', () => {
    const { client, invalidate } = setup();
    client.setQueryData(publicSettingsKey, { currency: 'RUB' });
    client.clear();
    client.setQueryData(publicSettingsKey, { currency: 'USD' });
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('уведомление о смене валюты сбрасывает все суммы', () => {
    expect(staleQueriesFor('currency_changed')).toEqual(MONEY_QUERIES);
  });
});
