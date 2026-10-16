import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { aiBudget } from '../../../features/ai/testData';
import { bankOut, strategyV3 } from '../../../features/analysis/testData';
import type { Adaptation, BankEntry } from '../../../features/bank/types';
import { playLimitsOut } from '../../../features/bank/testData';
import { betsSummary } from '../../../features/bets/testData';
import { bookmakersOut } from '../../../features/bookmakers/testData';
import { strategyVersions } from '../../../features/learning/testData';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../../test/fetchMock';
import { bodyOf, renderPage } from '../../../test/renderPage';
import { ProfilePage } from '../ProfilePage';

// Правила В7: защита банка включена, рост ставки выключен (как у стратегии после миграции 0004)
const ADAPT: Adaptation[] = [
  { key: 'dd10', enabled: true, active: true, met: true, params: { from: '0.10', max_pct: '0.025' } },
  { key: 'dd20', enabled: true, active: false, met: false, params: { from: '0.20', max_pct: '0.015' } },
  { key: 'up15', enabled: false, active: false, met: false, params: { bank_up: '0.15', min_winrate: '0.60', max_pct: '0.04' } },
  { key: 'week_loss', enabled: true, active: false, met: false, params: { loss: '-0.05', max_pct: '0.02' } },
  { key: 'week_win', enabled: false, active: false, met: true, params: { win: '0.10', add: '0.005' } },
];

const BANK = bankOut({
  balance: '42000.00',
  in_play: '1320.00',
  equity: '43320.00',
  peak: '48500.00',
  drawdown: '0.1068',
  invested: '45000.00',
  growth: '-0.0373',
  week_change: '0.1200',
  winrate: '0.5000',
  settled_bets: 4,
  drawdown_level: 'dd10',
  adaptations: ADAPT,
});

function entry(over: Partial<BankEntry>): BankEntry {
  return { id: 1, at: '2026-10-01T09:00:00Z', kind: 'deposit', amount: '48000.00', currency: 'RUB', bet_id: null, note: 'Начальный банк', reversed_by: null, balance_after: '48000.00', ...over };
}

const ENTRIES = {
  items: [
    entry({ id: 30, at: '2026-10-12T10:00:00Z', kind: 'withdrawal', amount: '-3000.00', note: null, balance_after: '42000.00' }),
    entry({ id: 1 }),
  ],
  next_before: null,
  last_id: 42,
};

function api(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/me/bank': () => json(BANK),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/strategy/versions': () => json(strategyVersions()),
    'GET /api/me/bank/entries': () => json(ENTRIES),
    'GET /api/bets/summary': () => json(betsSummary()),
    'GET /api/me/bookmakers': () => json(['Fonbet', 'Winline']),
    'GET /api/me/bookmakers/list': () => json(bookmakersOut()),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/login-events': () => json([]),
    ...over,
  };
}

function renderBank(handlers: Record<string, Handler> = api(), me: typeof ME_MEMBER | typeof ME_ADMIN = ME_MEMBER, width?: number) {
  return renderPage(<ProfilePage />, { path: '/profile/:tab?', url: '/profile/bank', me, api: handlers, width, stubs: { '/admin/:tab?': 'Администрирование' } });
}

describe('Кабинет: банк и стратегия', () => {
  it('валюта и плитки банка из GET /api/me/bank', async () => {
    renderBank();
    expect(await screen.findByText('Валюта программы: рубли (₽)')).toBeInTheDocument();
    // ссылка на смену валюты — только администратору
    expect(screen.queryByRole('link', { name: 'Изменить в настройках программы' })).toBeNull();
    expect(screen.getByText('45 000 ₽')).toBeInTheDocument();
    expect(screen.getByText('43 320 ₽')).toBeInTheDocument();
    expect(screen.getByText('−3,7%')).toBeInTheDocument();
    expect(await screen.findByText('1 ставка · 3,0% банка')).toBeInTheDocument();
    expect(screen.getAllByText('−10,7%').length).toBeGreaterThan(0);
    expect(screen.getByText('пик 48 500 ₽')).toBeInTheDocument();
    expect(screen.getByText('старт и движения банка')).toBeInTheDocument();
  });

  it('администратору — ссылка на валюту программы', async () => {
    renderBank(api(), ME_ADMIN);
    expect(await screen.findByRole('link', { name: 'Изменить в настройках программы' })).toHaveAttribute('href', '/admin/settings');
  });

  it('правила стратегии — из действующей версии, только просмотр', async () => {
    renderBank();
    const card = (await screen.findByRole('heading', { name: 'Правила стратегии' })).closest('section') as HTMLElement;
    expect(await within(card).findByText('Инструкции анализа v3 — общие, правила суммы — ваши · ИИ не предложит событие вне этих рамок')).toBeInTheDocument();
    expect(within(card).getByText('6 исходов')).toBeInTheDocument();
    expect(within(card).getByText('от 65%')).toBeInTheDocument();
    expect(within(card).getByText('в экспрессе из 3 событий — от 70%')).toBeInTheDocument();
    expect(within(card).getByText('1.13–1.80')).toBeInTheDocument();
    expect(within(card).getByText('от 3–2')).toBeInTheDocument();
    expect(within(card).getByText('итоговый кэф 1.44–4.10')).toBeInTheDocument();
    expect(within(card).getByText('2,75%')).toBeInTheDocument();
    // 43 320 × 2,75% = 1 191,3 → вниз до 10 ₽
    expect(within(card).getByText('сейчас это 1 190 ₽')).toBeInTheDocument();
    expect(within(card).getByText('только экспресс из 3 событий')).toBeInTheDocument();
    expect(within(card).getByText('перевес от 15%')).toBeInTheDocument();
    expect(within(card).getByText('−0,25%')).toBeInTheDocument();
    expect(within(card).getByText(/потолок — 3% банка\. Сумма округляется вниз до 10 ₽; меньше 50 ₽ — ставки нет\./)).toBeInTheDocument();
  });

  it('адаптации: статус по банку, рост ставки выключен, переключатели неактивны', async () => {
    renderBank();
    const card = (await screen.findByRole('heading', { name: 'Адаптации ставки' })).closest('section') as HTMLElement;
    const dd10 = within(card).getByRole('switch', { name: /^Просадка от пика −10% → ставка не больше 2,5% банка: включено/ });
    expect(dd10).toBeChecked();
    expect(dd10).toBeDisabled();
    const up15 = within(card).getByRole('switch', { name: /^Банк \+15% к вложенному и винрейт от 60% → потолок ставки 4% вместо 3%: выключено/ });
    expect(up15).not.toBeChecked();
    expect(within(card).getByText('Действует сейчас')).toBeInTheDocument();
    expect(within(card).getAllByText('Выключено')).toHaveLength(2);
    expect(within(card).getByText('Сейчас действует хотя бы одно правило — ставки в новых анализах изменены.')).toBeInTheDocument();
    // прибыльная неделя: +12% за 7 дней — с правилом оно бы действовало
    expect(within(card).getByText('За 7 дней +12,0% — с правилом оно бы действовало')).toBeInTheDocument();
    expect(within(card).getByText(/Сейчас условие выполнено/)).toBeInTheDocument();
    expect(within(card).getByRole('meter', { name: 'Просадка от пика банка' })).toHaveAttribute('aria-valuenow', '10.7');
  });

  it('движение банка: пополнение с последней строкой журнала, журнал и сообщение с новым банком', async () => {
    let posted = false;
    const { user, calls } = renderBank(
      api({
        'GET /api/me/bank': () => json(posted ? { ...BANK, balance: '47000.00', equity: '48320.00' } : BANK),
        'POST /api/me/bank/entries': () => {
          posted = true;
          return json(entry({ id: 43, amount: '5000.00', note: null, balance_after: '47000.00' }), 201);
        },
      }),
    );
    const moves = await screen.findByRole('region', { name: 'Движение банка' });
    expect(await within(moves).findByText('Стартовый банк')).toBeInTheDocument();
    expect(within(moves).getByText('−3 000 ₽')).toBeInTheDocument();
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма' }), '5 000');
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    // банк в сообщении — перечитанный после записи, как в макете
    expect(await screen.findByText('Пополнение +5 000 ₽ записано. Банк 48 320 ₽, в прибыль и ROI не входит')).toBeInTheDocument();
    const post = calls.find((r) => r.method === 'POST');
    // валюта, в которой форма показывала суммы: сменилась на сервере — 409, а не запись в новой
    expect(await bodyOf(post as Request)).toEqual({ kind: 'deposit', amount: '5000.00', note: null, expected_last_id: 42, currency: 'RUB' });
  });

  it('вывод и корректировка — сообщение в своем роде; двойной клик шлет одну запись', async () => {
    const { user, calls } = renderBank(
      api({
        'POST /api/me/bank/entries': async (request) => {
          const body = (await request.clone().json()) as { kind: BankEntry['kind']; amount: string };
          return json(entry({ id: 44, kind: body.kind, amount: body.kind === 'deposit' ? body.amount : `-${body.amount.replace('-', '')}`, note: null }), 201);
        },
      }),
    );
    const moves = await screen.findByRole('region', { name: 'Движение банка' });
    await screen.findByText('Стартовый банк');
    const kinds = within(moves).getByRole('group', { name: 'Что записать' });
    await user.click(within(kinds).getByRole('button', { name: 'Вывод' }));
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма' }), '100');
    await user.dblClick(within(moves).getByRole('button', { name: 'Записать' }));
    expect(await screen.findByText('Вывод −100 ₽ записан. Банк 43 320 ₽, в прибыль и ROI не входит')).toBeInTheDocument();
    expect(calls.filter((r) => r.method === 'POST')).toHaveLength(1);
    expect(screen.getAllByText(/^Вывод −100 ₽ записан/)).toHaveLength(1);
    await user.click(within(kinds).getByRole('button', { name: 'Корректировка' }));
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма со знаком' }), '−50');
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    expect(await screen.findByText(/^Корректировка −50 ₽ записана\./)).toBeInTheDocument();
  });

  it('вывод больше баланса и корректировка без суммы — подсказка под полем, без запроса', async () => {
    const { user, calls } = renderBank();
    const moves = await screen.findByRole('region', { name: 'Движение банка' });
    await screen.findByText('Стартовый банк');
    await user.click(within(within(moves).getByRole('group', { name: 'Что записать' })).getByRole('button', { name: 'Вывод' }));
    expect(within(moves).getByText('Свободно 42 000 ₽: ставки в игре вывести нельзя')).toBeInTheDocument();
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма' }), '50000');
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    expect(within(moves).getByText('Вывести можно не больше баланса (42 000 ₽): ставки в игре вывести нельзя')).toBeInTheDocument();
    await user.click(within(within(moves).getByRole('group', { name: 'Что записать' })).getByRole('button', { name: 'Корректировка' }));
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма со знаком' }), '0');
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    expect(within(moves).getByText('Введите сумму со знаком, например −500')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
  });

  it('корректировка со знаком и ответы сервера: сумма — под полем, гонка — плашкой и перечитать журнал', async () => {
    let posts = 0;
    const { user, calls } = renderBank(
      api({
        'POST /api/me/bank/entries': () => {
          posts += 1;
          return posts === 1
            ? apiError(422, 'bank.correction_range', 'Корректировка уводит банк в минус', { balance: '42000.00', currency: 'RUB' })
            : apiError(409, 'bank.changed', 'Журнал изменился');
        },
      }),
    );
    const moves = await screen.findByRole('region', { name: 'Движение банка' });
    await screen.findByText('Стартовый банк');
    await user.click(within(within(moves).getByRole('group', { name: 'Что записать' })).getByRole('button', { name: 'Корректировка' }));
    await user.type(within(moves).getByRole('textbox', { name: 'Сумма со знаком' }), '−50 000');
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    expect(await within(moves).findByText('Корректировка уводит банк в минус: сейчас по учету 42 000 ₽')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'POST') as Request)).toMatchObject({ kind: 'correction', amount: '-50000.00' });
    const before = calls.filter((r) => r.url.includes('/api/me/bank/entries') && r.method === 'GET').length;
    await user.click(within(moves).getByRole('button', { name: 'Записать' }));
    expect(await within(moves).findByText('Журнал банка изменился в другом окне или вкладке. Обновите страницу и проверьте запись')).toBeInTheDocument();
    await waitFor(() => expect(calls.filter((r) => r.url.includes('/api/me/bank/entries') && r.method === 'GET').length).toBeGreaterThan(before));
  });

  it('просадка глубже −20%: правило −10% тоже действует, как в макете', async () => {
    const deep = bankOut({
      ...BANK,
      drawdown: '0.5627',
      drawdown_level: 'dd20',
      adaptations: ADAPT.map((rule) => (rule.key === 'dd10' ? { ...rule, active: false } : rule.key === 'dd20' ? { ...rule, active: true, met: true } : rule)),
    });
    renderBank(api({ 'GET /api/me/bank': () => json(deep) }));
    const card = (await screen.findByRole('heading', { name: 'Адаптации ставки' })).closest('section') as HTMLElement;
    const rows = within(card).getAllByText('Сейчас −56,3% от пика').map((el) => el.closest('.profile-rule') as HTMLElement);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(within(row).getByText('Действует сейчас')).toBeInTheDocument();
      expect(within(row).queryByText('Ждет условия')).toBeNull();
    }
  });

  it('банк не загрузился — текст ошибки и «Повторить»', async () => {
    renderBank(api({ 'GET /api/me/bank': () => apiError(500, 'common.internal', 'Сбой сервера') }));
    expect(await screen.findByText(/Сбой сервера/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});
