import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { notificationsQueryKey } from '../../../api/keys';
import { adminBudget, dataUploads } from '../../../features/admin/testData';
import { aiBudget } from '../../../features/ai/testData';
import { adminAttention } from '../../../features/dashboard/testData';
import { playLimitsOut } from '../../../features/bank/testData';
import type { NotificationPrefs } from '../../../features/notifications/prefs';
import { adminPrefsOut, memberPrefsOut } from '../../../features/notifications/testData';
import type { PushSubscriptionOut } from '../../../features/pwa/api';
import { vapidKeyBytes } from '../../../features/pwa/push';
import { pushSubscriptionOut, VAPID_KEY } from '../../../features/pwa/testData';
import { fixClock } from '../../../test/clock';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../../test/fetchMock';
import { hashOf, IPHONE_UA, MAC_CHROME_UA, stubPushBrowser } from '../../../test/pushBrowser';
import { bodyOf, renderPage } from '../../../test/renderPage';
import { ProfilePage } from '../ProfilePage';

// Кабинет → «Уведомления»: виды по строкам «на сайте» и push (GET/PUT /api/me/notification-prefs),
// «Каналы» — push на этом устройстве (браузер подменен: stubPushBrowser), «Устройства с push»,
// «Тихие часы» и «Как выглядит push».

const toast = (text: string | RegExp) => screen.findByText(text, { selector: '.toast span' });

function api(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/me/notification-prefs': () => json(memberPrefsOut()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/login-events': () => json([]),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    'GET /api/me/push-config': () => json({ vapid_public_key: VAPID_KEY }),
    'GET /api/me/push-subscriptions': () => json({ items: [] }),
    ...over,
  };
}

/** Сервер push: список устройств живет между запросами, как на настоящем API. */
function pushServer(initial: PushSubscriptionOut[] = []) {
  let items = [...initial];
  let prefs: NotificationPrefs = { ...memberPrefsOut(), push_available: items.length > 0 };
  const handlers: Record<string, Handler> = {
    'GET /api/me/push-subscriptions': () => json({ items }),
    'GET /api/me/notification-prefs': () => json({ ...prefs, push_available: items.length > 0 }),
    'POST /api/me/push-subscriptions': async (request) => {
      const body = await bodyOf<{ endpoint: string }>(request);
      const out = pushSubscriptionOut({ id: 9, device: 'Android · Chrome', endpoint_hash: await hashOf(body.endpoint) });
      items = [out, ...items];
      return json(out, 201);
    },
    'POST /api/me/push-subscriptions/revoke': async (request) => {
      const body = await bodyOf<{ endpoint: string }>(request);
      const hash = await hashOf(body.endpoint);
      items = items.filter((item) => item.endpoint_hash !== hash);
      return new Response(null, { status: 204 });
    },
    'POST /api/me/push-subscriptions/test': () => json({ sent: items.length }, 202),
    'PUT /api/me/notification-prefs': async (request) => {
      const body = await bodyOf<{ items?: { kind: string; push?: boolean }[]; quiet_hours?: NotificationPrefs['quiet_hours'] }>(request);
      prefs = {
        ...prefs,
        items: prefs.items.map((item) => {
          const change = body.items?.find((c) => c.kind === item.kind);
          return change?.push !== undefined ? { ...item, push: change.push } : item;
        }),
        quiet_hours: body.quiet_hours ?? prefs.quiet_hours,
      };
      return json({ ...prefs, push_available: items.length > 0 });
    },
  };
  for (const item of initial) {
    handlers[`DELETE /api/me/push-subscriptions/${item.id}`] = () => {
      items = items.filter((other) => other.id !== item.id);
      return new Response(null, { status: 204 });
    };
  }
  return { handlers, items: () => items };
}

function renderTab(handlers: Record<string, Handler>, me: typeof ME_MEMBER | typeof ME_ADMIN = ME_MEMBER, width?: number) {
  return renderPage(<ProfilePage />, { path: '/profile/:tab?', url: '/profile/notifications', me, api: handlers, width });
}

async function card(name: string) {
  return (await screen.findByRole('heading', { name })).closest('section') as HTMLElement;
}

const what = () => card('О чем сообщать');
const channels = () => card('Каналы');

// даты образцов — октябрь 2026 (см. fixClock)
fixClock('2026-10-15T09:00:00Z');

describe('Кабинет: уведомления', () => {
  it('участник: виды по строкам, лимит с числами, обязательные на сайте — всегда; push нигде не включен — столбец неактивен', async () => {
    // порог в долларах — с сервера (alert_usd), а не limit × pct на экране
    renderTab(api({ 'GET /api/ai/budget': () => json(aiBudget({ alert_usd: 8 })) }));
    const box = await what();
    expect(await within(box).findByRole('switch', { name: 'На сайте: Ставка рассчитана автоматически' })).toBeChecked();
    // лимит участника: 80% от $10 — как в макете, из /api/ai/budget
    expect(within(box).getByText('На 80% ($8 из $10) — предупреждение; когда остатка не хватит на вызов Claude, анализы остановятся до решения администратора')).toBeInTheDocument();
    expect(within(box).getByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' })).toBeChecked();
    expect(within(box).getByRole('switch', { name: 'На сайте: Решение по ключу администратора' })).toBeChecked();
    for (const title of ['Вход с нового устройства', 'Неудачные попытки входа', 'Сообщение администратора']) {
      expect(within(box).getByText(`${title}: на сайте всегда включено`)).toBeInTheDocument();
      expect(within(box).queryByRole('switch', { name: `На сайте: ${title}` })).toBeNull();
    }
    // В5: push нет ни на одном устройстве — столбец неактивен, сверху подсказка с кнопкой
    const push = within(box).getAllByRole('switch', { name: /^Push: .*Сначала включите push на этом устройстве$/ });
    expect(push).toHaveLength(8);
    for (const item of push) {
      expect(item).toBeDisabled();
      expect(item).not.toBeChecked();
    }
    expect(within(box).getByText('Сначала включите push на этом устройстве.')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Включить push' })).toBeInTheDocument();
    expect(within(box).getByText(/Push для них можно выключить/)).toBeInTheDocument();
    expect(within(box).queryByText('Для администратора')).toBeNull();
    // тихие часы — тоже неактивны
    const quiet = await card('Тихие часы');
    expect(within(quiet).getByText('Ночью без push · время по Хельсинки')).toBeInTheDocument();
    expect(within(quiet).getByRole('switch', { name: 'Тихие часы. Сначала включите push на этом устройстве' })).toBeDisabled();
    expect(within(quiet).getByRole('button', { name: /^Тихие часы — с: 23:00/ })).toBeDisabled();
    expect(within(quiet).getByText('Сначала включите push на этом устройстве: тихие часы действуют только для push.')).toBeInTheDocument();
    // jsdom не умеет push: «не поддерживается»
    const ch = await channels();
    expect(await within(ch).findByText('Не поддерживается')).toBeInTheDocument();
    expect(within(ch).queryByRole('button', { name: 'Включить push' })).toBeNull();
  });

  it('этап 5: «ждет результата или архив показывает другое» одной строкой, еженедельный отчет — по поясу', async () => {
    const { user, calls } = renderTab(api({ 'PUT /api/me/notification-prefs': () => json(memberPrefsOut(['bet_needs_result', 'settle_conflict'])) }));
    const box = await what();
    const needs = await within(box).findByRole('switch', { name: 'На сайте: Ставка ждет результата или архив показывает другое' });
    expect(within(box).getByText(/^Понедельник, 07:00 по вашему поясу \(Хельсинки\): ставки, прибыль, CLV/)).toBeInTheDocument();
    expect(within(box).getByRole('switch', { name: 'На сайте: Еженедельный отчет' })).toBeChecked();
    await user.click(needs);
    const put = calls.find((r) => r.method === 'PUT') as Request;
    expect(await bodyOf(put)).toEqual({ items: [{ kind: 'bet_needs_result', on_site: false }, { kind: 'settle_conflict', on_site: false }] });
  });

  it('выключить вид: сразу в переключателе, оба вида строки — одним запросом; колокольчик перечитан', async () => {
    const { user, calls, client } = renderTab(api({ 'PUT /api/me/notification-prefs': () => json(memberPrefsOut(['limit_80', 'limit_100'])) }));
    client.setQueryData(notificationsQueryKey, { items: [], unread: 0 });
    const box = await what();
    const limit = await within(box).findByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' });
    await user.click(limit);
    expect(limit).not.toBeChecked();
    expect(await toast('Выключено на сайте: лимит ИИ: 80% и остановка')).toBeInTheDocument();
    const put = calls.find((r) => r.method === 'PUT') as Request;
    expect(await bodyOf(put)).toEqual({ items: [{ kind: 'limit_80', on_site: false }, { kind: 'limit_100', on_site: false }] });
    // колокольчик перечитает список: выключенное он прячет, включенное снова показывает
    await waitFor(() => expect(client.getQueryState(notificationsQueryKey)?.isInvalidated).toBe(true));
  });

  it('сервер не принял — переключатель вернулся, текст ошибки', async () => {
    const { user } = renderTab(
      api({ 'PUT /api/me/notification-prefs': () => apiError(422, 'notification.kind_unavailable', 'Нет', { kind: 'bet_settled' }) }),
    );
    const box = await what();
    const bet = await within(box).findByRole('switch', { name: 'На сайте: Ставка рассчитана автоматически' });
    await user.click(bet);
    expect(await screen.findByText('Таких уведомлений у вас нет')).toBeInTheDocument();
    await waitFor(() => expect(bet).toBeChecked());
  });

  it('администратор: «Для администратора» с делами, бюджетом и сигналами расхода ИИ; push по умолчанию (В2)', async () => {
    renderTab(
      api({
        'GET /api/ai/budget': () => json(aiBudget({ budget: adminBudget() })),
        // дела администратора (GET /api/admin/attention): одна просьба вернуть ключ, Игорь у лимита
        'GET /api/admin/attention': () =>
          json(
            adminAttention({
              archive: null,
              return_requests: [{ user_id: 5, name: 'Дмитрий', at: '2026-10-12T10:00:00Z' }],
              limits: [{ user_id: 4, name: 'Игорь Нестеров', spent_usd: 8.6, limit_usd: 10, share: 0.86, level: '80', runs_out_on: null }],
              alert_pct: 80,
            }),
          ),
        'GET /api/me/notification-prefs': () => json({ ...adminPrefsOut(['data_stale']), push_available: true }),
        'GET /api/admin/data/uploads': () => json(dataUploads()),
      }),
      ME_ADMIN,
    );
    const box = await what();
    expect(await within(box).findByText('Для администратора')).toBeInTheDocument();
    expect(within(box).getByText('Сообщение администратора: на сайте всегда включено')).toBeInTheDocument();
    expect(within(box).getByText('От других администраторов: работы на сервере, изменения в программе')).toBeInTheDocument();
    expect(within(box).getByRole('switch', { name: 'На сайте: Пора загрузить файл tennis-data' })).not.toBeChecked();
    expect(within(box).getByRole('switch', { name: 'На сайте: Сигналы расхода ИИ' })).toBeChecked();
    // пороги сигналов расхода — с сервера (alert_rules), те же числа, что проверяет воркер
    expect(
      within(box).getByText(/^Доля кэша ниже 50% по 10 анализам, анализ дороже 2 медиан за 7 дн\., больше 2% обрезанных ответов или отказов, больше 30 поисков в день/),
    ).toBeInTheDocument();
    // новые виды этапа 5 и сигналы расхода — с пометкой «новое»
    expect(within(box).getAllByText('новое')).toHaveLength(4);
    expect(within(box).getByRole('switch', { name: 'На сайте: Обучение модели' })).toBeChecked();
    // В2: push у обучения модели и сигналов расхода выключен, у остальных — включен
    expect(within(box).getByRole('switch', { name: 'Push: Обучение модели' })).not.toBeChecked();
    expect(within(box).getByRole('switch', { name: 'Push: Сигналы расхода ИИ' })).not.toBeChecked();
    expect(within(box).getByRole('switch', { name: 'Push: Пора загрузить файл tennis-data' })).toBeChecked();
    expect(within(box).getByRole('switch', { name: 'Push: Вход с нового устройства' })).toBeChecked();
    expect(within(box).getByText('Урок готов к решению, кандидат версии проверен, базовая модель перекалибрована или не включена')).toBeInTheDocument();
    expect(await within(box).findByText(/^Общий бюджет ключа администратора — \$60 в месяц/)).toBeInTheDocument();
    expect(await within(box).findByText('Участник на своем ключе просит вернуть его на ваш. Сейчас ждут: 1')).toBeInTheDocument();
    expect(within(box).getByText('Участник израсходовал 80% лимита или ему не хватает на вызов Claude. Сейчас у порога: Игорь Нестеров')).toBeInTheDocument();
    expect(within(box).queryByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' })).toBeNull();
  });

  it('администратор: «Пора загрузить файл tennis-data» — час и порог по расписанию сервера, последняя загрузка файла', async () => {
    renderTab(
      api({
        'GET /api/ai/budget': () => json(aiBudget({ budget: adminBudget() })),
        'GET /api/admin/attention': () => json(adminAttention({ archive: null, return_requests: [], limits: [], alert_pct: 80 })),
        // порог и час — schedule сервера (upload_stale_days, upload_hour), как у воркера data_stale
        'GET /api/me/notification-prefs': () => json({ ...adminPrefsOut(), schedule: { ...adminPrefsOut().schedule, upload_hour: 8, upload_stale_days: 5 } }),
        'GET /api/admin/data/uploads': () => json(dataUploads([], { last_load: '2026-10-12T08:14:00Z' })),
      }),
      ME_ADMIN,
    );
    const box = await what();
    expect(await within(box).findByRole('switch', { name: 'На сайте: Пора загрузить файл tennis-data' })).toBeChecked();
    expect(
      await within(box).findByText(
        /^Напоминание по понедельникам, 08:00, и если файл не загружали больше 5 дней: без него ставки не рассчитываются сами, Эло и форма устаревают\. Последняя загрузка — 12 окт \(3 дня назад\)$/,
      ),
    ).toBeInTheDocument();
  });

  it('настройки не загрузились — текст ошибки и «Повторить»', async () => {
    renderTab(api({ 'GET /api/me/notification-prefs': () => apiError(500, 'common.internal', 'Сбой сервера') }));
    const box = await what();
    expect(await within(box).findByText(/Сбой сервера/)).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});

describe('Каналы: push на этом устройстве', () => {
  it('не включен → «Включить push»: окно разрешения, подписка с ключом сервера, POST подписки → «Включено», «это устройство»', async () => {
    const browser = stubPushBrowser({ permission: 'default', answer: 'granted', newEndpoint: 'https://push.example/sub/pixel' });
    const server = pushServer();
    const { user, calls } = renderTab(api(server.handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    expect(within(ch).getByText('Android · Chrome')).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Включить push' }));
    expect(await toast('Push включен на этом устройстве')).toBeInTheDocument();
    expect(browser.requestPermission).toHaveBeenCalledTimes(1);
    // подписка — с ключом VAPID сервера (байты из base64url) и только видимыми уведомлениями
    const options = browser.subscribe.mock.calls[0]?.[0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect(options.applicationServerKey).toHaveLength(65);
    const post = calls.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/me/push-subscriptions') as Request;
    expect(await bodyOf(post)).toEqual({ endpoint: 'https://push.example/sub/pixel', keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' } });
    expect(await within(ch).findByText('Включено')).toBeInTheDocument();
    expect(within(ch).getByRole('button', { name: 'Прислать тестовое' })).toBeInTheDocument();
    // устройство в списке — «это устройство»; столбец «Push» ожил (push_available)
    const devices = await card('Устройства с push');
    expect(await within(devices).findByText('это устройство')).toBeInTheDocument();
    expect(within(devices).getByText('1 устройство')).toBeInTheDocument();
    expect(within(devices).getByText('подключено сегодня')).toBeInTheDocument();
    const box = await what();
    await waitFor(() => expect(within(box).getByRole('switch', { name: 'Push: Ставка рассчитана автоматически' })).toBeEnabled());
    expect(within(box).queryByText('Сначала включите push на этом устройстве.')).toBeNull();
  });

  it('человек нажал «Блокировать» — «Запрещено в браузере» и шаги, как разрешить; «Проверить снова» без разрешения — тост', async () => {
    stubPushBrowser({ permission: 'default', answer: 'denied' });
    const { user, calls } = renderTab(api(pushServer().handlers));
    const ch = await channels();
    await user.click(await within(ch).findByRole('button', { name: 'Включить push' }));
    expect(await toast('Уведомления запрещены в браузере. Как разрешить — в карточке «Каналы»')).toBeInTheDocument();
    expect(await within(ch).findByText('Запрещено в браузере')).toBeInTheDocument();
    expect(within(ch).getByText('Откройте «Разрешения» → «Уведомления».')).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Проверить снова' }));
    expect(await toast('Уведомления по-прежнему запрещены в настройках браузера')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
  });

  it('разрешение дали в настройках — «Проверить снова» включает push', async () => {
    const browser = stubPushBrowser({ permission: 'denied' });
    const { user } = renderTab(api(pushServer().handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Запрещено в браузере')).toBeInTheDocument();
    browser.setPermission('granted');
    await user.click(within(ch).getByRole('button', { name: 'Проверить снова' }));
    expect(await toast('Push включен на этом устройстве')).toBeInTheDocument();
    expect(await within(ch).findByText('Включено')).toBeInTheDocument();
  });

  it('компьютер: шаги для настроек сайта в браузере', async () => {
    stubPushBrowser({ permission: 'denied', userAgent: MAC_CHROME_UA });
    renderTab(api(pushServer().handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Откройте «Настройки сайтов» → «Уведомления».')).toBeInTheDocument();
    expect(within(ch).getByText('Mac · Chrome')).toBeInTheDocument();
  });

  it('iPhone в Safari — «Нужна установка»: шаги и окно установки; с экрана «Домой» — можно включить', async () => {
    stubPushBrowser({ userAgent: IPHONE_UA });
    const { user } = renderTab(api(pushServer().handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Нужна установка')).toBeInTheDocument();
    expect(within(ch).getByText(/На iPhone push работает только из установленного приложения/)).toBeInTheDocument();
    expect(within(ch).getByRole('list', { name: 'Как включить push на iPhone' })).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Как установить' }));
    const dialog = await screen.findByRole('dialog', { name: 'Установить приложение' });
    expect(within(dialog).getByRole('list', { name: 'Как установить на iPhone' }).querySelectorAll('li')).toHaveLength(5);
    expect(within(dialog).queryByRole('button', { name: 'Установить' })).toBeNull();
  });

  it('iPhone с экрана «Домой» — push можно включить, устройство — «приложение AI Capper»', async () => {
    stubPushBrowser({ userAgent: IPHONE_UA, standalone: true });
    renderTab(api(pushServer().handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    expect(within(ch).getByText('iPhone · приложение AI Capper')).toBeInTheDocument();
    expect(within(ch).getByRole('button', { name: 'Включить push' })).toBeEnabled();
  });

  it('на сервере нет ключей VAPID — «Не настроен на сервере»', async () => {
    stubPushBrowser();
    renderTab(api({ ...pushServer().handlers, 'GET /api/me/push-config': () => json({ vapid_public_key: null }) }));
    const ch = await channels();
    expect(await within(ch).findByText('Не настроен на сервере')).toBeInTheDocument();
    expect(within(ch).getByText(/нужны ключи VAPID/)).toBeInTheDocument();
    expect(within(ch).queryByRole('button', { name: 'Включить push' })).toBeNull();
  });

  it('включен: «Прислать тестовое» — сколько устройств; не чаще 5 в час — текст сервера; «Выключить» — отзыв по endpoint', async () => {
    const endpoint = 'https://push.example/sub/this';
    const browser = stubPushBrowser({ permission: 'granted', endpoint });
    const mine = pushSubscriptionOut({ id: 3, endpoint_hash: await hashOf(endpoint) });
    const phone = pushSubscriptionOut({ id: 4, device: 'iPhone · Safari', endpoint_hash: 'ffffffffffffffff', created_at: '2026-10-10T08:00:00Z', last_sent_at: '2026-10-15T08:30:00Z' });
    const server = pushServer([mine, phone]);
    let tests = 0;
    const { user, calls } = renderTab(
      api({
        ...server.handlers,
        'POST /api/me/push-subscriptions/test': () =>
          ++tests > 1 ? apiError(429, 'push.test_limit', 'Тестовое уведомление — не чаще 5 раз в час. Повторите через 40 мин.', { limit: 5, minutes: 40 }) : json({ sent: 2 }, 202),
      }),
    );
    const ch = await channels();
    expect(await within(ch).findByText('Включено')).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Прислать тестовое' }));
    expect(await toast('Тестовое уведомление отправлено на 2 устройства')).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Прислать тестовое' }));
    expect(await toast('Тестовое уведомление — не чаще 5 раз в час. Повторите через 40 мин.')).toBeInTheDocument();

    const devices = await card('Устройства с push');
    expect(within(devices).getByText('2 устройства')).toBeInTheDocument();
    expect(within(devices).getByText('подключено 10 окт · последний push 30 мин назад')).toBeInTheDocument();
    expect(within(devices).getAllByText('это устройство')).toHaveLength(1);

    await user.click(within(ch).getByRole('button', { name: 'Выключить' }));
    expect(await toast('Push на этом устройстве выключен')).toBeInTheDocument();
    const revoke = calls.find((r) => new URL(r.url).pathname === '/api/me/push-subscriptions/revoke') as Request;
    expect(await bodyOf(revoke)).toEqual({ endpoint });
    expect(browser.subscription()).toBeNull();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    await waitFor(() => expect(within(devices).getByText('1 устройство')).toBeInTheDocument());
  });

  it('подписку браузера сервер не знает (отключили с другого устройства) — «Не включен»; включение создает новую', async () => {
    const browser = stubPushBrowser({ permission: 'granted', endpoint: 'https://push.example/sub/old', newEndpoint: 'https://push.example/sub/fresh' });
    const { user, calls } = renderTab(api(pushServer().handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    await user.click(within(ch).getByRole('button', { name: 'Включить push' }));
    expect(await toast('Push включен на этом устройстве')).toBeInTheDocument();
    // старая подписка отписана, на сервер ушла новая; окно разрешения не открывалось — оно уже есть
    expect(browser.requestPermission).not.toHaveBeenCalled();
    expect(browser.subscription()?.endpoint).toBe('https://push.example/sub/fresh');
    const post = calls.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/me/push-subscriptions') as Request;
    expect(await bodyOf(post)).toMatchObject({ endpoint: 'https://push.example/sub/fresh' });
  });
});

describe('Каналы: смена ключей VAPID на сервере', () => {
  it('подписка с прежним ключом — «Не включен», хотя сервер ее помнит; «Включить push» отписывает старую и создает новую', async () => {
    const endpoint = 'https://push.example/sub/old-key';
    const oldKey = new Uint8Array(65).fill(7);
    const browser = stubPushBrowser({ permission: 'granted', endpoint, subscriptionKey: oldKey, newEndpoint: 'https://push.example/sub/new-key' });
    const server = pushServer([pushSubscriptionOut({ id: 3, endpoint_hash: await hashOf(endpoint) })]);
    const { user, calls } = renderTab(api(server.handlers));
    const ch = await channels();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    expect(within(ch).queryByRole('button', { name: 'Прислать тестовое' })).toBeNull();
    await user.click(within(ch).getByRole('button', { name: 'Включить push' }));
    expect(await toast('Push включен на этом устройстве')).toBeInTheDocument();
    // новая подписка — с ключом сервера
    const key = (browser.subscribe.mock.calls[0]?.[0] as { applicationServerKey: Uint8Array }).applicationServerKey;
    expect(Array.from(key)).toEqual(Array.from(vapidKeyBytes(VAPID_KEY)));
    expect(browser.subscription()?.endpoint).toBe('https://push.example/sub/new-key');
    const post = calls.find((r) => r.method === 'POST' && new URL(r.url).pathname === '/api/me/push-subscriptions') as Request;
    expect(await bodyOf(post)).toMatchObject({ endpoint: 'https://push.example/sub/new-key' });
    expect(await within(ch).findByText('Включено')).toBeInTheDocument();
  });

  it('подписка с ключом сервера — «Включено»', async () => {
    const endpoint = 'https://push.example/sub/same-key';
    stubPushBrowser({ permission: 'granted', endpoint, subscriptionKey: vapidKeyBytes(VAPID_KEY) });
    renderTab(api(pushServer([pushSubscriptionOut({ id: 3, endpoint_hash: await hashOf(endpoint) })]).handlers));
    expect(await within(await channels()).findByText('Включено')).toBeInTheDocument();
  });
});

describe('Устройства с push', () => {
  it('«Отключить» другое устройство — DELETE по id, браузер этого не трогаем', async () => {
    const endpoint = 'https://push.example/sub/this';
    const browser = stubPushBrowser({ permission: 'granted', endpoint });
    const mine = pushSubscriptionOut({ id: 3, endpoint_hash: await hashOf(endpoint) });
    const phone = pushSubscriptionOut({ id: 4, device: 'iPhone · Safari', endpoint_hash: 'ffffffffffffffff' });
    const { user, calls } = renderTab(api(pushServer([mine, phone]).handlers));
    const devices = await card('Устройства с push');
    await user.click(await within(devices).findByRole('button', { name: 'Отключить push: iPhone · Safari' }));
    expect(await toast('Push отключен: iPhone · Safari')).toBeInTheDocument();
    expect(calls.some((r) => r.method === 'DELETE' && new URL(r.url).pathname === '/api/me/push-subscriptions/4')).toBe(true);
    expect(browser.subscription()?.endpoint).toBe(endpoint);
    await waitFor(() => expect(within(devices).queryByText('iPhone · Safari')).toBeNull());
  });

  it('«Отключить» это устройство — и браузер отписан, в «Каналах» «Не включен»', async () => {
    const endpoint = 'https://push.example/sub/this';
    const browser = stubPushBrowser({ permission: 'granted', endpoint });
    const mine = pushSubscriptionOut({ id: 3, endpoint_hash: await hashOf(endpoint) });
    const { user } = renderTab(api(pushServer([mine]).handlers));
    const devices = await card('Устройства с push');
    await user.click(await within(devices).findByRole('button', { name: 'Отключить push: Android · Chrome' }));
    expect(await toast('Push отключен: Android · Chrome')).toBeInTheDocument();
    expect(browser.subscription()).toBeNull();
    const ch = await channels();
    expect(await within(ch).findByText('Не включен')).toBeInTheDocument();
    expect(await within(devices).findByText('Push приходит только на устройства, где вы его включили.')).toBeInTheDocument();
  });
});

describe('Столбец «Push» и тихие часы', () => {
  it('push выключить у вида — PUT только push, тост', async () => {
    const server = pushServer([pushSubscriptionOut()]);
    const { user, calls } = renderTab(api(server.handlers));
    const box = await what();
    const bet = await within(box).findByRole('switch', { name: 'Push: Ставка рассчитана автоматически' });
    await waitFor(() => expect(bet).toBeEnabled());
    expect(bet).toBeChecked();
    await user.click(bet);
    expect(await toast('Push выключен: ставка рассчитана автоматически')).toBeInTheDocument();
    const put = calls.find((r) => r.method === 'PUT') as Request;
    expect(await bodyOf(put)).toEqual({ items: [{ kind: 'bet_settled', push: false }] });
    expect(bet).not.toBeChecked();
    // обязательный вид: на сайте всегда, а push выключается
    const login = within(box).getByRole('switch', { name: 'Push: Вход с нового устройства' });
    await user.click(login);
    expect(await toast('Push выключен: вход с нового устройства')).toBeInTheDocument();
  });

  it('тихие часы: 23:00–08:00 по умолчанию, шаг 30 минут, начало ≠ конец, выключить', async () => {
    const server = pushServer([pushSubscriptionOut()]);
    const { user, calls } = renderTab(api(server.handlers));
    const quiet = await card('Тихие часы');
    const sw = await within(quiet).findByRole('switch', { name: 'Тихие часы' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).toBeChecked();
    expect(within(quiet).getByText('С 23:00 до 08:00 (9 часов) push не приходят. Уведомления за это время ждут вас в колокольчике на сайте.')).toBeInTheDocument();
    expect(within(quiet).getByText('Вход с нового устройства и неудачные попытки входа приходят всегда, даже в тихие часы.')).toBeInTheDocument();

    await user.click(within(quiet).getByRole('button', { name: /^Тихие часы — с: 23:00/ }));
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(48);
    expect(options[1]).toHaveTextContent('00:30');
    await user.click(screen.getByRole('option', { name: '22:30' }));
    expect(await toast('Тихие часы: с 22:30 до 08:00, время по Хельсинки')).toBeInTheDocument();
    let put = calls.filter((r) => r.method === 'PUT').at(-1) as Request;
    expect(await bodyOf(put)).toEqual({ quiet_hours: { enabled: true, start: '22:30', end: '08:00' } });
    expect(within(quiet).getByText(/^С 22:30 до 08:00 \(9 ч 30 мин\)/)).toBeInTheDocument();

    // конец как начало — ошибка у поля, запроса нет
    const puts = calls.filter((r) => r.method === 'PUT').length;
    await user.click(within(quiet).getByRole('button', { name: /^Тихие часы — до: 08:00/ }));
    await user.click(screen.getByRole('option', { name: '22:30' }));
    expect(within(quiet).getByRole('alert')).toHaveTextContent('Начало и конец совпадают');
    expect(calls.filter((r) => r.method === 'PUT')).toHaveLength(puts);

    await user.click(sw);
    expect(await toast('Тихие часы выключены: push круглые сутки')).toBeInTheDocument();
    put = calls.filter((r) => r.method === 'PUT').at(-1) as Request;
    expect(await bodyOf(put)).toEqual({ quiet_hours: { enabled: false, start: '22:30', end: '08:00' } });
    expect(within(quiet).getByText('Выключены: push приходят круглые сутки.')).toBeInTheDocument();
    expect(within(quiet).getByRole('button', { name: /^Тихие часы — с: 22:30/ })).toBeDisabled();
  });

  it('«Как выглядит push»: три примера без сумм', async () => {
    renderTab(api());
    const look = await card('Как выглядит push');
    expect(within(look).getByRole('figure', { name: 'Пример: push на экране блокировки телефона' })).toBeInTheDocument();
    expect(within(look).getByText('Ставка №75 рассчитана')).toBeInTheDocument();
    expect(within(look).getByText('Отчет за неделю готов')).toBeInTheDocument();
    expect(within(look).getByText('четверг, 15 октября')).toBeInTheDocument();
    expect(within(look).getByText('В push нет сумм.')).toBeInTheDocument();
  });

  it('на телефоне сначала «Каналы» и устройства, потом виды', async () => {
    renderTab(api(), ME_MEMBER, 375);
    const headings = (await screen.findAllByRole('heading', { level: 3 })).map((h) => h.textContent);
    expect(headings.indexOf('Каналы')).toBeLessThan(headings.indexOf('О чем сообщать'));
    expect(headings.indexOf('Устройства с push')).toBeLessThan(headings.indexOf('О чем сообщать'));
    expect(headings.indexOf('Тихие часы')).toBeGreaterThan(headings.indexOf('О чем сообщать'));
  });
});
