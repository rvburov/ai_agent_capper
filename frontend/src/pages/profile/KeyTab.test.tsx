import { onlineManager } from '@tanstack/react-query';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { adminBudget, adminKey } from '../../features/admin/testData';
import { aiBudget } from '../../features/ai/testData';
import type { AiBudget, OwnKey } from '../../features/ai/types';
import { apiError, json, ME_ADMIN, ME_MEMBER, mockFetch, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { setViewportWidth } from '../../test/setup';
import { ProfilePage } from './ProfilePage';

type Me = typeof ME_MEMBER | typeof ME_ADMIN;

const OWN_KEY = { last4: '7Qx2', verified_at: '2026-10-02T18:30:00Z', last_error: null };
const MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ model, available: true }));

function ownKey(over: Partial<OwnKey> = {}): OwnKey {
  return { mode: 'own', has_key: true, ...OWN_KEY, check: 'ok', models: MODELS, ...over };
}

function routes(me: Me, budget: AiBudget | (() => AiBudget), extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/auth/csrf': () => json({ csrf_token: 'csrf' }),
    'GET /api/me': () => json(me),
    'GET /api/me/sessions': () => json([]),
    'GET /api/me/login-events': () => json([]),
    'GET /api/me/recovery-codes': () => json({ left: 8, total: 8, created_at: '2026-06-30T10:00:00Z' }),
    'GET /api/me/trusted-devices': () => json([]),
    'GET /api/ai/budget': () => json(typeof budget === 'function' ? budget() : budget),
    'GET /api/admin/ai/key': () => json(adminKey()),
    ...extra,
  };
}

function renderKey(me: Me = ME_MEMBER) {
  const { router } = renderPage(<ProfilePage />, {
    path: '/profile/:tab?',
    url: '/profile/key',
    me,
    stubs: { '/admin/:tab?': 'Администрирование', '/costs': 'ИИ и расходы' },
  });
  return { router };
}

async function bodyOf(request: Request): Promise<unknown> {
  return JSON.parse(await request.clone().text());
}

const toast = (text: string | RegExp) => screen.findByText(text, { selector: '.toast span' });
const card = async (title: string) => (await screen.findByRole('heading', { name: title })).closest('section')!;

describe('Личный кабинет: ключ Claude, участник на ключе администратора', () => {
  it('лимит, расход, полоса с порогом, анализы сегодня и что будет на 80% и 100%', async () => {
    mockFetch(routes(ME_MEMBER, aiBudget()));
    renderKey();
    const modes = await screen.findByRole('radiogroup', { name: 'Чей ключ Claude использовать' });
    expect(within(modes).getByRole('radio', { name: /Ключ администратора/ })).toBeChecked();
    expect(within(modes).getByText('Ничего вводить не нужно. Платит администратор, у вас лимит $10 в месяц.')).toBeInTheDocument();
    expect(within(modes).getByText('Действует')).toBeInTheDocument();

    const limit = await card('Ключ администратора');
    expect(within(limit).getByText('Подключено')).toBeInTheDocument();
    expect(within(limit).getByText('Расход за октябрь · обновляется после каждого запуска')).toBeInTheDocument();
    expect(limit.querySelector('.profile-keyline')).toHaveTextContent(
      'Подключено к ключу администратора · ваш лимит $10 в месяц · израсходовано $1,93 · осталось $8,07',
    );
    const meter = within(limit).getByRole('meter', { name: 'Расход лимита на ИИ за октябрь' });
    expect(meter).toHaveAttribute('aria-valuetext', '$1,93 из $10');
    expect(within(limit).getByText('80% · $8')).toBeInTheDocument();
    expect(within(limit).getByText('1 из 3')).toBeInTheDocument();
    expect(within(limit).getByText('≈ $0,13')).toBeInTheDocument();
    expect(within(limit).getByText('$8 — уведомление')).toBeInTheDocument();
    expect(within(limit).getByText('$10 — анализы останавливаются')).toBeInTheDocument();
    expect(within(limit).getByText('Лимит меняет администратор. С 1 ноября расход начнется заново.')).toBeInTheDocument();
    expect(within(limit).getByRole('link', { name: 'Подробнее в «ИИ и расходы»' })).toHaveAttribute('href', '/costs');
    // справка: шаги свернуты (ключ сейчас не нужен), модели на ключе
    expect(screen.getByText('Шаги 1–7').closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Opus 5.5')).toBeInTheDocument();
  });

  it('у порога уведомления — метка и точка у вкладки; пауза и анализы на сегодня — причина из API', async () => {
    mockFetch(routes(ME_MEMBER, aiBudget({ spent_usd: 8.5, left_usd: 1.5, limit_share: 0.85 })));
    const first = renderKey();
    expect(await screen.findByText('Больше 80% лимита')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ключ Claude\s*\(есть что проверить\)/ })).toBeInTheDocument();
    first.router.dispose();
  });

  it('остатка лимита меньше, чем может стоить вызов Claude: анализы остановлены, но не «исчерпан»', async () => {
    mockFetch(
      routes(
        ME_MEMBER,
        aiBudget({ monthly_usd: 1, spent_usd: 0.67, left_usd: 0.33, reason_code: 'ai.monthly_limit', reason_params: { limit: '1,00' } }),
      ),
    );
    renderKey();
    const limit = await card('Ключ администратора');
    expect(within(limit).getByText('Анализы остановлены')).toBeInTheDocument();
    const why = limit.querySelector('.callout');
    expect(why).toHaveTextContent(
      'Остатка лимита ($0,33) не хватает на вызов Claude — анализы остановлены до решения администратора. Он может поднять лимит. Или перейдите на свой ключ — это можно сразу.',
    );
    // совет «поднять лимит или свой ключ» — один раз, а не дважды подряд
    expect(why?.textContent?.match(/свой ключ/g)).toHaveLength(1);
    expect(within(limit).queryByText(/Лимит исчерпан/)).not.toBeInTheDocument();
    expect(limit.querySelector('.profile-keyline')).toHaveTextContent('осталось $0,33');
  });

  it('пауза администратора и «на сегодня анализы закончились»', async () => {
    mockFetch(routes(ME_MEMBER, aiBudget({ paused: true, reason_code: 'ai.paused' })));
    renderKey();
    expect(await screen.findByText('Анализы на паузе — решение администратора')).toBeInTheDocument();
    expect(screen.getByText(/Новые анализы на ключе администратора не запускаются/)).toBeInTheDocument();
  });

  it('на сегодня анализы закончились: текст причины из ru.json по коду и параметрам', async () => {
    mockFetch(routes(ME_MEMBER, aiBudget({ analyses_today: 3, reason_code: 'ai.daily_limit', reason_params: { daily: 3 } })));
    renderKey();
    expect(await screen.findByText('На сегодня анализы закончились: 3 в день.')).toBeInTheDocument();
    expect(screen.getByText(/Новые — после полуночи по вашему времени/)).toBeInTheDocument();
  });

  it('свой ключ: формат на месте, ошибка Anthropic под полем, сбой связи — плашкой, успех — переход', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    let saved = false;
    const { calls } = mockFetch(
      routes(ME_MEMBER, () => (saved ? aiBudget({ mode: 'own', key_source: 'own', monthly_usd: null, own_key: OWN_KEY }) : aiBudget()), {
        'PUT /api/me/ai-key': () => {
          attempt += 1;
          if (attempt === 1) {
            return apiError(400, 'ai.key_rejected', 'Anthropic не принял ключ Claude: он отозван, неверный или не дает доступа к нужной модели');
          }
          if (attempt === 2) return apiError(503, 'ai.key_unavailable', 'Не удалось проверить ключ: нет связи с Anthropic');
          saved = true;
          return json(ownKey());
        },
      }),
    );
    renderKey();
    await user.click(await screen.findByRole('radio', { name: /Свой ключ/ }));
    const setup = await card('Свой ключ Claude API');
    expect(within(setup).getByText(/Пока анализы идут на ключе администратора/)).toBeInTheDocument();
    // шаги инструкции раскрыты: ключ нужен сейчас; ссылка «Как получить свой ключ» ведет к ним
    expect(screen.getByText('Шаги 1–7').closest('details')).toHaveAttribute('open');
    expect(within(setup).getByRole('link', { name: 'Как получить свой ключ' })).toHaveAttribute('href', '#profile-key-guide');
    const input = within(setup).getByLabelText('Ваш ключ');
    expect(input).toHaveAttribute('type', 'password');
    await user.click(within(setup).getByRole('button', { name: 'Показать ключ' }));
    expect(input).toHaveAttribute('type', 'text');
    const save = within(setup).getByRole('button', { name: 'Проверить и сохранить' });
    await user.click(save);
    expect(within(setup).getByText('Вставьте ключ — скопируйте его в консоли Anthropic')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    await user.type(input, 'ant-123');
    await user.click(save);
    expect(within(setup).getByText(/Ключ Claude начинается с sk-ant-\. Проверьте/)).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'sk-ant-short');
    await user.click(save);
    expect(within(setup).getByText('Ключ слишком короткий — скопируйте его целиком')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'PUT')).toBe(false);

    await user.clear(input);
    await user.type(input, 'sk-ant-api03-ABCDEFGHIJKLMNOP7Qx2');
    await user.click(save);
    expect(await within(setup).findByText(/Anthropic не принял ключ Claude/)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveFocus());
    await user.click(save);
    expect(await within(setup).findByText('Не удалось проверить ключ: нет связи с Anthropic')).toBeInTheDocument();
    // старая ошибка ключа под полем не остается рядом с новой: на экране одно сообщение
    expect(within(setup).queryByText(/Anthropic не принял ключ Claude/)).not.toBeInTheDocument();
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(within(setup).getAllByRole('alert')).toHaveLength(1);
    // кнопка на время запроса выключалась: фокус возвращается в поле ключа, а не теряется
    await waitFor(() => expect(input).toHaveFocus());
    await user.click(save);
    expect(await toast('Ключ проверен и сохранен. Анализы теперь идут с вашего счета')).toBeInTheDocument();
    expect(await bodyOf(calls.filter((r) => r.method === 'PUT').at(-1)!)).toEqual({ key: 'sk-ant-api03-ABCDEFGHIJKLMNOP7Qx2' });
    const own = await card('Свой ключ');
    expect(within(own).getByText('sk-ant-…7Qx2')).toBeInTheDocument();
    expect(within(screen.getByRole('radiogroup')).getByRole('radio', { name: /Свой ключ/ })).toBeChecked();
  });

  it('без сети «Проверить и сохранить» сразу говорит «Нет связи», а не ждет сеть молча', async () => {
    const user = userEvent.setup();
    mockFetch(
      routes(ME_MEMBER, aiBudget(), {
        'PUT /api/me/ai-key': () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    );
    renderKey();
    await user.click(await screen.findByRole('radio', { name: /Свой ключ/ }));
    const setup = await card('Свой ключ Claude API');
    await user.type(within(setup).getByLabelText('Ваш ключ'), 'sk-ant-api03-ABCDEFGHIJKLMNOP7Qx2');
    onlineManager.setOnline(false);
    try {
      await user.click(within(setup).getByRole('button', { name: 'Проверить и сохранить' }));
      expect(await within(setup).findByText('Нет связи с сервером. Проверьте интернет и повторите.')).toBeInTheDocument();
      expect(within(setup).getByRole('button', { name: 'Проверить и сохранить' })).toBeEnabled();
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it('на свой ключ — сразу, если ключ уже сохранен и проверен (Р12)', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, aiBudget({ own_key: OWN_KEY }), { 'PUT /api/me/ai-mode': () => json(ownKey({ check: null })) }),
    );
    renderKey();
    await user.click(await screen.findByRole('radio', { name: /Свой ключ/ }));
    expect(await toast('Готово: анализы теперь идут с вашего счета')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PUT')!)).toEqual({ mode: 'own' });
  });
});

describe('Личный кабинет: ключ Claude, участник на своем ключе', () => {
  const OWN = aiBudget({
    mode: 'own',
    key_source: 'own',
    monthly_usd: null,
    left_usd: null,
    daily_analyses: null,
    spent_usd: 3.4,
    own_key: OWN_KEY,
    own_cap_usd: 1,
    avg_analysis_usd: 0.31,
  });

  it('ключ: последние символы, «Проверить», свой потолок, удаление с подтверждением', async () => {
    const user = userEvent.setup();
    const { calls } = mockFetch(
      routes(ME_MEMBER, OWN, {
        'POST /api/me/ai-key/check': () => json(ownKey()),
        'PUT /api/me/ai-cap': async (request) => json(await bodyOf(request)),
        'DELETE /api/me/ai-key': () => json(ownKey({ has_key: false, last4: null, verified_at: null, check: null, models: [] })),
      }),
    );
    renderKey();
    const own = await card('Свой ключ');
    expect(within(own).getByText('Работает')).toBeInTheDocument();
    expect(own.querySelector('.profile-keyline')).toHaveTextContent(/Ваш ключ sk-ant-…7Qx2 · проверен .* · израсходовано \$3,40 в этом месяце/);
    expect(within(own).getByLabelText('Свой потолок на один анализ, $')).toHaveValue('1');
    expect(within(own).getByText(/Средний анализ сейчас ≈ \$0,31/)).toBeInTheDocument();

    await user.click(within(own).getByRole('button', { name: 'Проверить' }));
    expect(await toast('Ключ работает: доступны Opus 5.5, Sonnet 5.5 и Haiku 5.5')).toBeInTheDocument();

    const cap = within(own).getByLabelText('Свой потолок на один анализ, $');
    await user.clear(cap);
    await user.type(cap, '25');
    await user.click(within(own).getByRole('button', { name: 'Сохранить' }));
    expect(within(own).getByText('От $0,10 до $20')).toBeInTheDocument();
    await user.clear(cap);
    await user.type(cap, '2,5');
    await user.click(within(own).getByRole('button', { name: 'Сохранить' }));
    expect(await toast('Потолок на анализ: $2,50')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.url.endsWith('/ai-cap'))!)).toEqual({ per_analysis_usd: '2.50' });

    await user.click(within(own).getByRole('button', { name: 'Удалить ключ' }));
    expect(within(own).getByText(/Ключ удалим с сервера/)).toBeInTheDocument();
    const confirm = within(own).getByRole('button', { name: 'Удалить ключ' });
    expect(confirm).toHaveFocus();
    await user.click(confirm);
    expect(await toast('Ключ удален с сервера. Отзовите его в консоли Anthropic')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('ключ перестал работать: метка и причина по коду последней ошибки', async () => {
    mockFetch(routes(ME_MEMBER, { ...OWN, own_key: { ...OWN_KEY, verified_at: null, last_error: 'rejected:401' } }));
    renderKey();
    const own = await card('Свой ключ');
    expect(within(own).getByText('Не работает')).toBeInTheDocument();
    expect(within(own).getByText(/Anthropic не принял ключ Claude: он отозван/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Ключ Claude' })).toBeInTheDocument();
  });

  it('ключа нет: форма ключа с причиной, точка у вкладки', async () => {
    mockFetch(routes(ME_MEMBER, { ...OWN, own_key: null, reason_code: 'ai.no_own_key' }));
    renderKey();
    const setup = await card('Свой ключ Claude API');
    expect(within(setup).getByText('Нет ключа Claude: добавьте свой ключ в личном кабинете.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ключ Claude\s*\(есть что проверить\)/ })).toBeInTheDocument();
  });

  it('вернуться на ключ администратора — только просьбой (Р12), и ее можно отменить', async () => {
    const user = userEvent.setup();
    let requested: string | null = null;
    const { calls } = mockFetch(
      routes(ME_MEMBER, () => ({ ...OWN, return_requested_at: requested }), {
        'POST /api/me/ai-mode/return-request': () => {
          requested = '2026-10-06T21:15:00Z';
          return json({ requested_at: requested });
        },
        'DELETE /api/me/ai-mode/return-request': () => {
          requested = null;
          return new Response(null, { status: 204 });
        },
      }),
    );
    renderKey();
    await user.click(await screen.findByRole('radio', { name: /Ключ администратора/ }));
    const ret = await card('Вернуться на ключ администратора');
    expect(within(ret).getByText(/вернуться можно только с его разрешения/)).toBeInTheDocument();
    await user.click(within(ret).getByRole('button', { name: 'Попросить администратора вернуть ключ' }));
    expect(await toast('Просьба отправлена администратору')).toBeInTheDocument();
    expect(await within(ret).findByText('Ждет решения')).toBeInTheDocument();
    expect(screen.getByText('Запрос отправлен')).toBeInTheDocument();
    await user.click(within(ret).getByRole('button', { name: 'Отменить запрос' }));
    expect(await toast('Просьба отменена')).toBeInTheDocument();
    await waitFor(() => expect(within(ret).queryByText('Ждет решения')).not.toBeInTheDocument());
    expect(calls.filter((r) => r.url.endsWith('/return-request')).map((r) => r.method)).toEqual(['POST', 'DELETE']);
  });

  it('замена ключа из инструкции: «К полю ключа» открывает форму замены', async () => {
    const user = userEvent.setup();
    mockFetch(routes(ME_MEMBER, OWN));
    renderKey();
    await card('Свой ключ');
    await user.click(screen.getByRole('button', { name: 'К полю ключа' }));
    const setup = await card('Замена своего ключа');
    expect(within(setup).getByText(/Сейчас работает ключ sk-ant-…7Qx2/)).toBeInTheDocument();
    await waitFor(() => expect(within(setup).getByLabelText('Ваш ключ')).toHaveFocus());
    await user.click(within(setup).getByRole('button', { name: 'Отмена' }));
    expect(await card('Свой ключ')).toBeInTheDocument();
  });
});

describe('Личный кабинет: ключ Claude у администратора', () => {
  it('плашка администратора, «Свой ключ» недоступен, общий бюджет и ключ программы', async () => {
    mockFetch(
      routes(
        ME_ADMIN,
        aiBudget({ monthly_usd: null, left_usd: null, daily_analyses: null, spent_usd: 2.4, analyses_today: 2, budget: adminBudget() }),
      ),
    );
    renderKey(ME_ADMIN);
    expect(await screen.findByText(/ваш ключ — это ключ администратора/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Открыть' })).toHaveAttribute('href', '/admin/key');
    expect(screen.getByRole('radio', { name: /Свой ключ/ })).toBeDisabled();
    expect(screen.getByText(/Ключ программы. Ваши анализы идут в общий бюджет \$60 в месяц/)).toBeInTheDocument();
    const owner = await card('Ключ администратора');
    expect(await within(owner).findByText('sk-ant-…m9Tq')).toBeInTheDocument();
    expect(owner.querySelector('.profile-keyline')).toHaveTextContent(
      'Общий бюджет ключа $60 в месяц · израсходовано $41,20 · осталось $18,80',
    );
    expect(within(owner).getByText('без ограничения')).toBeInTheDocument();
    expect(within(owner).getByText(/общие фоновые задачи \(\$3,10 за октябрь\)/)).toBeInTheDocument();
  });

  it('ключ администратора не задан: администратору — задать его в «Ключ и бюджет», без «Действует»', async () => {
    mockFetch(
      routes(
        ME_ADMIN,
        aiBudget({
          has_key: false,
          monthly_usd: null,
          left_usd: null,
          daily_analyses: null,
          budget: adminBudget(),
          reason_code: 'ai.no_admin_key',
        }),
        { 'GET /api/admin/ai/key': () => json(adminKey({ status: 'missing', last4: null, verified_at: null })) },
      ),
    );
    renderKey(ME_ADMIN);
    const owner = await card('Ключ администратора');
    expect(within(owner).getByText('Ключ Claude администратора не задан. Задайте его в «Администрирование → Ключ и бюджет».')).toBeInTheDocument();
    expect(screen.queryByText(/Напишите администратору/)).not.toBeInTheDocument();
    const modes = screen.getByRole('radiogroup', { name: 'Чей ключ Claude использовать' });
    expect(within(modes).queryByText('Действует')).not.toBeInTheDocument();
    expect(within(modes).getByText('Ключа нет')).toBeInTheDocument();
  });

  it('на телефоне — та же вкладка и выбор режима', async () => {
    setViewportWidth(375);
    mockFetch(routes(ME_MEMBER, aiBudget()));
    renderKey();
    expect(await screen.findByRole('radiogroup', { name: 'Чей ключ Claude использовать' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Ключ Claude' })).toHaveAttribute('aria-selected', 'true');
  });
});
