import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminSettings, CurrencyPreview } from '../../features/admin/settings';
import { formatRate, lastRateFor, parseRate, rateDigits, ratePair } from '../../features/admin/settings';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { AdminPage } from './AdminPage';

const SETTINGS: AdminSettings = {
  currency: 'RUB',
  default_tz: 'Europe/Helsinki',
  currency_changed: {
    at: '2026-09-01T09:00:00Z',
    actor_name: 'Роман Буров',
    from_currency: 'EUR',
    to_currency: 'RUB',
    rate: '95.12',
    rate_base: 'EUR',
  },
  updated_at: '2026-09-01T09:00:00Z',
};

function preview(over: Partial<CurrencyPreview> = {}): CurrencyPreview {
  return {
    applied: false,
    overflow: false,
    from_currency: 'RUB',
    to_currency: 'EUR',
    rate: '95.12',
    rate_base: 'EUR',
    factor: '0.01051303',
    bets: 128,
    ledger_entries: 341,
    play_limits: 2,
    analyses: 57,
    members: 4,
    corrections: 3,
    own_bank: { before: '48000.00', after: '504.63' },
    samples: [
      { before: '100', after: '1.05' },
      { before: '1000', after: '10.51' },
      { before: '10000', after: '105.13' },
    ],
    ...over,
  };
}

function api(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/admin/users': () => json([]),
    'GET /api/admin/invites': () => json([]),
    'GET /api/admin/settings': () => json(SETTINGS),
    ...extra,
  };
}

function renderSettings(extra: Record<string, Handler> = {}, width?: number) {
  return renderPage(<AdminPage />, { path: '/admin/:tab?', url: '/admin/settings', me: ME_ADMIN, api: api(extra), width });
}

const toast = (text: string | RegExp) => screen.findByText(text, { selector: '.toast span' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Настройки: курс и пара', () => {
  it('курс из поля: запятая или точка, границы 0,001–1 000, до 8 знаков', () => {
    expect(parseRate('95,12')).toBe('95.12');
    expect(parseRate(' 1 000 ')).toBe('1000');
    expect(parseRate('0.001')).toBe('0.001');
    expect(parseRate('0,0009')).toBeNull();
    expect(parseRate('1000,01')).toBeNull();
    expect(parseRate('1,123456789')).toBeNull();
    expect(parseRate('abc')).toBeNull();
    expect(parseRate('')).toBeNull();
  });

  it('пара как в окне макета: рубль справа, доллар и евро — 1 € = … $', () => {
    expect(ratePair('RUB', 'EUR')).toEqual({ base: 'EUR', quote: 'RUB' });
    expect(ratePair('USD', 'RUB')).toEqual({ base: 'USD', quote: 'RUB' });
    expect(ratePair('USD', 'EUR')).toEqual({ base: 'EUR', quote: 'USD' });
    expect(ratePair('EUR', 'USD')).toEqual({ base: 'EUR', quote: 'USD' });
  });

  it('курс без лишних нулей; прошлый курс подставляется только для той же пары', () => {
    expect(rateDigits('95.12000000')).toBe(2);
    expect(rateDigits('1')).toBe(0);
    expect(formatRate('95.12000000')).toBe('95,12');
    expect(lastRateFor(SETTINGS.currency_changed, { base: 'EUR', quote: 'RUB' })).toBe('95,12');
    expect(lastRateFor(SETTINGS.currency_changed, { base: 'USD', quote: 'RUB' })).toBe('');
    expect(lastRateFor(SETTINGS.currency_changed, { base: 'EUR', quote: 'USD' })).toBe('');
    expect(lastRateFor(null, { base: 'EUR', quote: 'RUB' })).toBe('');
  });
});

describe('Администрирование → Настройки', () => {
  it('валюта сейчас, с какой даты и по какому курсу, выбор, часовой пояс и сервер', async () => {
    renderSettings();
    expect(await screen.findByText('Рубли', { selector: '.adm-cur-name' })).toBeInTheDocument();
    expect(screen.getByText('с 1 сентября 2026 · Роман Буров · курс 1 € = 95,12 ₽')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Валюта программы' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    expect(within(buttons[0]!).getByText('сейчас')).toBeInTheDocument();
    expect(within(buttons[2]!).getByText('курс вводится вручную')).toBeInTheDocument();
    expect(screen.getByText('Pinnacle → Betfair → средний по рынку')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Часовой пояс: Хельсинки/ })).toBeInTheDocument();
    expect(screen.getByText('Финляндия, Хельсинки')).toBeInTheDocument();
    // Вкладка выбрана, заглушки нет
    expect(screen.getByRole('tab', { name: 'Настройки' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/Раздел появится/)).not.toBeInTheDocument();
  });

  it('смена валюты: предпросмотр с сервера, «Понимаю», код 2FA, пересчет и сообщение', async () => {
    const view = renderSettings({
      'PUT /api/admin/settings/currency': async (request) => {
        const body = await bodyOf<{ preview?: boolean }>(request);
        return json(body.preview ? preview() : preview({ applied: true }));
      },
    });
    const { user, calls } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Сменить валюту программы' });
    // Курс прошлой смены той же пары — в поле; предпросмотр считает сервер
    const rate = within(dialog).getByLabelText('Курс: 1 € =');
    expect(rate).toHaveValue('95,12');
    expect(await within(dialog).findByText('504,63 €')).toBeInTheDocument();
    expect(within(dialog).getByText('48 000 ₽')).toBeInTheDocument();
    expect(within(dialog).getByText(/Пересчитается: 128 ставок, 341 запись банка, 57 анализов с суммами, 2 лимита на ставки/)).toBeInTheDocument();
    expect(within(dialog).getByText('Банк ведут 4 участника')).toBeInTheDocument();
    const go = within(dialog).getByRole('button', { name: 'Пересчитать и сменить' });
    expect(go).toBeDisabled();
    await user.click(within(dialog).getByLabelText('Понимаю: суммы пересчитаются у всех участников'));
    expect(go).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    expect(go).toBeEnabled();
    await user.click(go);
    expect(await toast('Валюта программы — евро. Суммы пересчитаны у всех участников')).toBeInTheDocument();
    const puts = calls.filter((r) => r.method === 'PUT' && r.url.endsWith('/api/admin/settings/currency'));
    expect(await bodyOf(puts[0]!)).toEqual({
      from_currency: 'RUB',
      currency: 'EUR',
      rate: '95.12',
      rate_base: 'EUR',
      preview: true,
    });
    // После смены предпросмотр заново не спрашивается: валюта уже другая
    expect(puts).toHaveLength(2);
    expect(await bodyOf(puts[1]!)).toEqual({
      from_currency: 'RUB',
      currency: 'EUR',
      rate: '95.12',
      rate_base: 'EUR',
      totp_code: '123456',
      preview: false,
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('валюту сменили, пока окно было открыто: сервер отказал, окно закрыто, настройки перечитаны', async () => {
    const STALE = 'Валюта программы сменилась: теперь $. Обновите страницу и проверьте суммы';
    let current: AdminSettings = SETTINGS;
    const view = renderSettings({
      'GET /api/admin/settings': () => json(current),
      'GET /api/settings': () => json({ currency: current.currency }),
      'PUT /api/admin/settings/currency': async (request) => {
        const body = await bodyOf<{ preview?: boolean }>(request);
        if (body.preview) return json(preview());
        // Другой администратор успел сменить ₽ → $; окно считало от рублей
        current = { ...SETTINGS, currency: 'USD' };
        return apiError(409, 'common.currency_changed', STALE);
      },
    });
    const { user, calls } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('504,63 €');
    await user.click(within(dialog).getByLabelText('Понимаю: суммы пересчитаются у всех участников'));
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    await user.click(within(dialog).getByRole('button', { name: 'Пересчитать и сменить' }));
    expect(
      await toast(`${STALE}. Окно смены закрыто: курс был введен для другой пары — откройте смену заново`),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // Экран показывает валюту, которая действует сейчас
    expect(await screen.findByText('Доллары США', { selector: '.adm-cur-name' })).toBeInTheDocument();
    const reads = calls.filter((r) => r.method === 'GET' && r.url.endsWith('/api/admin/settings'));
    expect(reads.length).toBeGreaterThanOrEqual(2);
  });

  it('валюту сменили до предпросмотра — окно закрывается, курс чужой пары не отправляется', async () => {
    const STALE = 'Валюта программы сменилась: теперь $. Обновите страницу и проверьте суммы';
    const view = renderSettings({
      'PUT /api/admin/settings/currency': () => apiError(409, 'common.currency_changed', STALE),
    });
    const { user, calls } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    expect(await toast(new RegExp(`^${STALE.replace(/[.$]/g, '\\$&')}\\. Окно смены закрыто`))).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const puts = calls.filter((r) => r.method === 'PUT');
    expect(puts.every((r) => r.url.endsWith('/api/admin/settings/currency'))).toBe(true);
    for (const put of puts) expect(await bodyOf(put)).toMatchObject({ preview: true, from_currency: 'RUB' });
  });

  it('подписи предпросмотра — по валютам из ответа сервера', async () => {
    const view = renderSettings({
      'PUT /api/admin/settings/currency': () =>
        json(preview({ from_currency: 'USD', own_bank: { before: '500.00', after: '459.26' } })),
    });
    const { user } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText('500,00 $')).toBeInTheDocument();
    expect(within(dialog).getByText('459,26 €')).toBeInTheDocument();
  });

  it('неверный курс: подсказка под полем, предпросмотра нет, кнопка недоступна', async () => {
    const view = renderSettings({ 'PUT /api/admin/settings/currency': () => json(preview()) });
    const { user, calls } = view;
    await user.click(await screen.findByRole('button', { name: /Доллары США/ }));
    const dialog = await screen.findByRole('dialog');
    const rate = within(dialog).getByLabelText('Курс: 1 $ =');
    expect(rate).toHaveValue('');
    expect(within(dialog).getByText('Введите курс — покажем, что станет с суммами')).toBeInTheDocument();
    await user.type(rate, '1500');
    await user.tab();
    expect(within(dialog).getByText('Курс — число от 0,001 до 1 000')).toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Понимаю: суммы пересчитаются у всех участников'));
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    expect(within(dialog).getByRole('button', { name: 'Пересчитать и сменить' })).toBeDisabled();
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(calls.some((r) => r.url.endsWith('/api/admin/settings/currency'))).toBe(false);
  });

  it('сумма не поместится — только «да или нет» без сумм участников (Р14), смена недоступна', async () => {
    const view = renderSettings({
      'PUT /api/admin/settings/currency': () => json(preview({ overflow: true, own_bank: null })),
    });
    const { user } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    const dialog = await screen.findByRole('dialog');
    expect(
      await within(dialog).findByText('По этому курсу одна из сумм не поместится в учет, и смена не пройдет. Проверьте курс.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByText(/Ваш банк/)).not.toBeInTheDocument();
    await user.click(within(dialog).getByLabelText('Понимаю: суммы пересчитаются у всех участников'));
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '123456');
    expect(within(dialog).getByRole('button', { name: 'Пересчитать и сменить' })).toBeDisabled();
  });

  it('неверный код 2FA — ошибка под полем кода, окно остается', async () => {
    const view = renderSettings({
      'PUT /api/admin/settings/currency': async (request) => {
        const body = await bodyOf<{ preview?: boolean }>(request);
        return body.preview
          ? json(preview())
          : apiError(403, 'admin.totp_invalid', 'Код 2FA не подходит: проверьте приложение и введите новый код');
      },
    });
    const { user } = view;
    await user.click(await screen.findByRole('button', { name: /Евро/ }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('504,63 €');
    await user.click(within(dialog).getByLabelText('Понимаю: суммы пересчитаются у всех участников'));
    await user.type(within(dialog).getByLabelText('Код 2FA из вашего приложения'), '000000');
    await user.click(within(dialog).getByRole('button', { name: 'Пересчитать и сменить' }));
    expect(await within(dialog).findByText(/Код 2FA не подходит/)).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('часовой пояс для новых участников: выбор и «Сохранить»', async () => {
    let saved = SETTINGS;
    const view = renderSettings({
      'GET /api/admin/settings': () => json(saved),
      'PUT /api/admin/settings': async (request) => {
        const body = await bodyOf<{ default_tz: string }>(request);
        saved = { ...SETTINGS, default_tz: body.default_tz };
        return json(saved);
      },
    });
    const { user, calls } = view;
    const save = await screen.findByRole('button', { name: 'Сохранить' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Часовой пояс: Хельсинки/ }));
    await user.click(screen.getByRole('option', { name: /^Берлин/ }));
    expect(save).toBeEnabled();
    await user.click(save);
    expect(await toast('Часовой пояс для новых участников: Берлин')).toBeInTheDocument();
    const put = calls.find((r) => r.method === 'PUT' && r.url.endsWith('/api/admin/settings'))!;
    expect(await bodyOf(put)).toEqual({ default_tz: 'Europe/Berlin' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled());
  });

  it('настройки не загрузились — ошибка и «Повторить»', async () => {
    renderSettings({ 'GET /api/admin/settings': () => apiError(500, 'internal', 'Внутренняя ошибка') });
    expect(await screen.findByText(/Внутренняя ошибка/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('телефон 375 px: карточки одна под другой, выбор валюты кнопками', async () => {
    renderSettings({}, 375);
    expect(await screen.findByRole('group', { name: 'Валюта программы' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { pressed: false }).length).toBeGreaterThanOrEqual(2);
  });
});
