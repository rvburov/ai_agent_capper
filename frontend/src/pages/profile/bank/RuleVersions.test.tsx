import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bankOut } from '../../../features/analysis/testData';
import type { Adaptation } from '../../../features/bank/types';
import { firstRules, ruleVersion, strategyVersions } from '../../../features/learning/testData';
import type { StrategyVersion } from '../../../features/learning/types';
import { fixClock } from '../../../test/clock';
import { apiError, json } from '../../../test/fetchMock';
import { bodyOf } from '../../../test/renderPage';
import { bankTabApi, renderBankTab } from './testApi';

// Кабинет → «Банк и стратегия»: правила суммы ставки меняются новой версией (В5 этапа 5) —
// «Предложить изменение» → кандидат с проверкой на своих ставках (сервер) → «Включить», откат
// — «Вернуть»; отказ сервера — его текстом.

fixClock('2026-10-15T09:00:00Z');

const ADAPT: Adaptation[] = [
  { key: 'dd10', enabled: true, active: false, met: false, params: { from: '0.10', max_pct: '0.025' } },
  { key: 'dd20', enabled: true, active: false, met: false, params: { from: '0.20', max_pct: '0.015' } },
  { key: 'up15', enabled: false, active: false, met: false, params: { bank_up: '0.15', min_winrate: '0.60', max_pct: '0.04' } },
  { key: 'week_loss', enabled: true, active: false, met: false, params: { loss: '-0.05', max_pct: '0.02' } },
  { key: 'week_win', enabled: false, active: false, met: false, params: { win: '0.10', add: '0.005' } },
];
const BANK = bankOut({ balance: '42000.00', equity: '43320.00', in_play: '1320.00', adaptations: ADAPT });

const CHECK = {
  since: '2026-08-01',
  bets: 12,
  changed: 2,
  stake_old: '6000',
  stake_new: '6720',
  stake_change: 0.12,
  profit_old: '-900',
  profit_new: '-1020',
  currency: 'RUB',
  triggered: { week_loss: 0 },
};

const candidate = (over: Partial<StrategyVersion> = {}) =>
  ruleVersion({ id: 21, code: 'r3', name: 'r3 · без правила недели', status: 'candidate', parent_id: 20, created_at: '2026-10-15T09:00:00Z', changes: ['Выключено «Итог 7 дней −5% и хуже»'], check: CHECK, can_activate: true, ...over });

const strategyCard = async () => (await screen.findByRole('heading', { name: 'Правила стратегии' })).closest('section') as HTMLElement;

describe('Кабинет: версии правил суммы ставки', () => {
  it('«Предложить изменение» → кандидат с проверкой на своих ставках → «Включить»', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({
        'GET /api/me/bank': () => json(BANK),
        'POST /api/strategy/versions': () => json(candidate(), 201),
        'POST /api/strategy/versions/21/activate': () => json(candidate({ status: 'active' })),
      }),
    );
    const card = await strategyCard();
    expect(await within(card).findByText('r2 · рост ставки выключен')).toBeInTheDocument();
    expect(within(card).getByText('нет')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Предложить изменение' }));
    const dialog = await screen.findByRole('dialog', { name: 'Предложить изменение правил' });
    await user.click(within(dialog).getByRole('button', { name: 'Создать кандидата' }));
    expect(within(dialog).getByText('Выберите, что изменить')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Что изменить:/ }));
    await user.click(await screen.findByRole('option', { name: /^Выключить «Итог 7 дней/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Создать кандидата' }));
    const post = calls.find((request) => request.method === 'POST' && new URL(request.url).pathname === '/api/strategy/versions')!;
    expect(await bodyOf(post)).toEqual({ adapt: { week_loss: false } });

    const created = await screen.findByRole('dialog', { name: 'Кандидат r3' });
    expect(within(created).getByText('Выключено «Итог 7 дней −5% и хуже»')).toBeInTheDocument();
    const check = within(created).getByText('Проверка на ваших ставках:').parentElement!;
    expect(check).toHaveTextContent(/С 1 авг: 12 ставок, у 2 сумма изменилась бы\. Сумма ставок 6\s000 ₽ → 6\s720 ₽ \(\+12%\)\. Прибыль при тех же исходах −900 ₽ → −1\s020 ₽\./);
    await user.click(within(created).getByRole('button', { name: 'Включить r3' }));
    expect(await screen.findByText(/^r3 действует со следующего анализа/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('доля банка в диапазоне: проверка поля, в запрос — доля, а не проценты; отказ сервера — текстом', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({
        'GET /api/me/bank': () => json(BANK),
        'POST /api/strategy/versions': () => apiError(422, 'strategy.bad_params', 'Такие правила суммы не годятся (параметр «stake_bands»)'),
      }),
    );
    const card = await strategyCard();
    await user.click(within(card).getByRole('button', { name: 'Предложить изменение' }));
    const dialog = await screen.findByRole('dialog', { name: 'Предложить изменение правил' });
    await user.click(within(dialog).getByRole('button', { name: /^Что изменить:/ }));
    await user.click((await screen.findAllByRole('option', { name: /^Доля банка при итоговом кэфе/ }))[0]!);
    const field = within(dialog).getByRole('textbox', { name: 'Новая доля банка' });
    await user.type(field, '9');
    await user.click(within(dialog).getByRole('button', { name: 'Создать кандидата' }));
    expect(within(dialog).getByText('Доля банка — от 0,1 до 5%')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, '1,5');
    await user.click(within(dialog).getByRole('button', { name: 'Создать кандидата' }));
    expect(await within(dialog).findByText('Такие правила суммы не годятся (параметр «stake_bands»)')).toBeInTheDocument();
    const post = calls.find((request) => request.method === 'POST')!;
    expect(await bodyOf(post)).toEqual({ stake_bands: [{ index: 0, pct: 0.015 }] });
  });

  it('кандидат ждет решения — проверка и «Включить», «Отклонить»; без кандидата — «Вернуть» прежнюю', async () => {
    const { user } = renderBankTab(
      bankTabApi({
        'GET /api/me/bank': () => json(BANK),
        'GET /api/strategy/versions': () => json(strategyVersions({ rules: [firstRules(), ruleVersion(), candidate({ check: { ...CHECK, bets: 0, changed: 0 } })] })),
        'POST /api/strategy/versions/21/reject': () => json(candidate({ status: 'rejected' })),
      }),
    );
    const card = await strategyCard();
    expect(await within(card).findByText(/^Рассчитанных ставок приложения пока нет — проверить не на чем/)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Включить r3' })).toBeEnabled();
    await user.click(within(card).getByRole('button', { name: 'Отклонить' }));
    expect(await screen.findByText('Кандидат r3 отклонен')).toBeInTheDocument();
  });

  it('прежнюю версию можно вернуть; отказ сервера — текстом', async () => {
    const { user } = renderBankTab(
      bankTabApi({
        'GET /api/me/bank': () => json(BANK),
        'GET /api/strategy/versions': () => json(strategyVersions({ rules: [firstRules(), ruleVersion({ id: 22, code: 'r3', name: 'r3 · без правила недели', created_at: '2026-10-12T09:00:00Z' }), ruleVersion({ status: 'archived', can_rollback: true })] })),
        'POST /api/strategy/versions/20/rollback': () => apiError(409, 'strategy.cannot_rollback', 'Вернуть можно только версию, которая уже была активной'),
      }),
    );
    const card = await strategyCard();
    await user.click(await within(card).findByRole('button', { name: 'Вернуть r2' }));
    expect(await within(card).findByText('Вернуть можно только версию, которая уже была активной')).toBeInTheDocument();
  });

  it('«Вернуть» — любую архивную версию, которая действовала (и исходные r1); коды — r1, r2… по порядку в линии', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({
        'GET /api/me/bank': () => json(BANK),
        'GET /api/strategy/versions': () =>
          json(
            strategyVersions({
              rules: [
                // исходные правила: на сервере код стратегии (v3), на экране — r1
                firstRules({ can_rollback: true, archived_at: '2026-10-10T09:00:00Z' }),
                ruleVersion({ status: 'archived', archived_at: '2026-10-14T09:00:00Z', can_rollback: true }),
                // отклоненный кандидат — в линии, но не возвращается
                ruleVersion({ id: 21, code: 'r3', name: 'r3 · без правила недели', status: 'rejected', created_at: '2026-10-05T09:00:00Z' }),
                ruleVersion({ id: 22, code: 'r5', name: 'r5 · доля 2%', status: 'active', created_at: '2026-10-14T09:00:00Z' }),
              ],
            }),
          ),
        'POST /api/strategy/versions/19/rollback': () => json(firstRules({ status: 'active', archived_at: null })),
      }),
    );
    const card = await strategyCard();
    expect(await within(card).findByText('r4 · доля 2%')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Вернуть r2' })).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Вернуть r1' }));
    expect(await screen.findByText('Снова действует r1')).toBeInTheDocument();
    expect(calls.some((request) => request.method === 'POST' && new URL(request.url).pathname === '/api/strategy/versions/19/rollback')).toBe(true);
  });

  it('адаптации: «Предложить изменение» открывает то же окно', async () => {
    const { user } = renderBankTab(bankTabApi({ 'GET /api/me/bank': () => json(BANK) }));
    const adapt = (await screen.findByRole('heading', { name: 'Адаптации ставки' })).closest('section')!;
    await user.click(within(adapt).getByRole('button', { name: 'Предложить изменение' }));
    expect(await screen.findByRole('dialog', { name: 'Предложить изменение правил' })).toBeInTheDocument();
  });
});
