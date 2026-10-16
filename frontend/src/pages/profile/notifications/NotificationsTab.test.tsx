import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { notificationsQueryKey } from '../../../api/keys';
import { adminBudget, dataUploads } from '../../../features/admin/testData';
import { aiBudget } from '../../../features/ai/testData';
import { adminAttention } from '../../../features/dashboard/testData';
import { playLimitsOut } from '../../../features/bank/testData';
import { adminPrefsOut, memberPrefsOut } from '../../../features/notifications/testData';
import { fixClock } from '../../../test/clock';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../../test/fetchMock';
import { bodyOf, renderPage } from '../../../test/renderPage';
import { ProfilePage } from '../ProfilePage';

// Кабинет → «Уведомления»: виды по строкам «на сайте» (GET/PUT /api/me/notification-prefs),
// обязательные — включены и неактивны; push и тихие часы — этап 6.

function api(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/me/notification-prefs': () => json(memberPrefsOut()),
    'GET /api/ai/budget': () => json(aiBudget()),
    'GET /api/me/login-events': () => json([]),
    'GET /api/me/play-limits': () => json(playLimitsOut()),
    ...over,
  };
}

function renderTab(handlers: Record<string, Handler>, me: typeof ME_MEMBER | typeof ME_ADMIN = ME_MEMBER) {
  return renderPage(<ProfilePage />, { path: '/profile/:tab?', url: '/profile/notifications', me, api: handlers });
}

async function card() {
  return (await screen.findByRole('heading', { name: 'О чем сообщать' })).closest('section') as HTMLElement;
}

// даты образцов — октябрь 2026 (см. fixClock)
fixClock('2026-10-15T09:00:00Z');

describe('Кабинет: уведомления', () => {
  it('участник: виды по строкам, лимит с числами, обязательные — неактивны с пояснением', async () => {
    // порог в долларах — с сервера (alert_usd), а не limit × pct на экране
    renderTab(api({ 'GET /api/ai/budget': () => json(aiBudget({ alert_usd: 8 })) }));
    const what = await card();
    expect(await within(what).findByRole('switch', { name: 'На сайте: Ставка рассчитана автоматически' })).toBeChecked();
    // лимит участника: 80% от $10 — как в макете, из /api/ai/budget
    expect(within(what).getByText('На 80% ($8 из $10) — предупреждение; когда остатка не хватит на вызов Claude, анализы остановятся до решения администратора')).toBeInTheDocument();
    expect(within(what).getByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' })).toBeChecked();
    expect(within(what).getByRole('switch', { name: 'На сайте: Решение по ключу администратора' })).toBeChecked();
    for (const title of ['Вход с нового устройства', 'Неудачные попытки входа', 'Сообщение администратора']) {
      expect(within(what).getByText(`${title}: на сайте всегда включено`)).toBeInTheDocument();
      expect(within(what).queryByRole('switch', { name: `На сайте: ${title}` })).toBeNull();
    }
    // push — этап 6, все неактивны
    const push = within(what).getAllByRole('switch', { name: /^Push: / });
    expect(push).toHaveLength(8);
    for (const item of push) expect(item).toBeDisabled();
    expect(within(what).queryByText('Для администратора')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Тихие часы' })).toBeInTheDocument();
    expect(screen.getByText('Push без звука · время по Хельсинки')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'С' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Разрешить push' })).toBeDisabled();
  });

  it('этап 5: «ждет результата или архив показывает другое» одной строкой, еженедельный отчет — по поясу', async () => {
    const { user, calls } = renderTab(api({ 'PUT /api/me/notification-prefs': () => json(memberPrefsOut(['bet_needs_result', 'settle_conflict'])) }));
    const what = await card();
    const needs = await within(what).findByRole('switch', { name: 'На сайте: Ставка ждет результата или архив показывает другое' });
    expect(within(what).getByText(/^Понедельник, 07:00 по вашему поясу \(Хельсинки\): ставки, прибыль, CLV/)).toBeInTheDocument();
    expect(within(what).getByRole('switch', { name: 'На сайте: Еженедельный отчет' })).toBeChecked();
    await user.click(needs);
    const put = calls.find((r) => r.method === 'PUT') as Request;
    expect(await bodyOf(put)).toEqual({ items: [{ kind: 'bet_needs_result', on_site: false }, { kind: 'settle_conflict', on_site: false }] });
    expect(within(what).queryByText('Для администратора')).toBeNull();
  });

  it('выключить вид: сразу в переключателе, оба вида строки — одним запросом; колокольчик перечитан', async () => {
    const { user, calls, client } = renderTab(
      api({
        'PUT /api/me/notification-prefs': () => json(memberPrefsOut(['limit_80', 'limit_100'])),
      }),
    );
    client.setQueryData(notificationsQueryKey, { items: [], unread: 0 });
    const what = await card();
    const limit = await within(what).findByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' });
    await user.click(limit);
    expect(limit).not.toBeChecked();
    expect(await screen.findByText('Выключено на сайте: лимит ИИ: 80% и остановка')).toBeInTheDocument();
    const put = calls.find((r) => r.method === 'PUT') as Request;
    expect(await bodyOf(put)).toEqual({ items: [{ kind: 'limit_80', on_site: false }, { kind: 'limit_100', on_site: false }] });
    // колокольчик перечитает список: выключенное он прячет, включенное снова показывает
    await waitFor(() => expect(client.getQueryState(notificationsQueryKey)?.isInvalidated).toBe(true));
  });

  it('сервер не принял — переключатель вернулся, текст ошибки', async () => {
    const { user } = renderTab(
      api({
        'PUT /api/me/notification-prefs': () => apiError(422, 'notification.kind_unavailable', 'Нет', { kind: 'bet_settled' }),
      }),
    );
    const what = await card();
    const bet = await within(what).findByRole('switch', { name: 'На сайте: Ставка рассчитана автоматически' });
    await user.click(bet);
    expect(await screen.findByText('Таких уведомлений у вас нет')).toBeInTheDocument();
    await waitFor(() => expect(bet).toBeChecked());
  });

  it('администратор: «Для администратора» с делами, бюджетом и сигналами расхода ИИ', async () => {
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
        'GET /api/me/notification-prefs': () => json(adminPrefsOut(['data_stale'])),
        'GET /api/admin/data/uploads': () => json(dataUploads()),
      }),
      ME_ADMIN,
    );
    const what = await card();
    expect(await within(what).findByText('Для администратора')).toBeInTheDocument();
    expect(within(what).getByText('Сообщение администратора: на сайте всегда включено')).toBeInTheDocument();
    expect(within(what).getByText('От других администраторов: работы на сервере, изменения в программе')).toBeInTheDocument();
    expect(within(what).getByRole('switch', { name: 'На сайте: Пора загрузить файл tennis-data' })).not.toBeChecked();
    expect(within(what).getByRole('switch', { name: 'На сайте: Сигналы расхода ИИ' })).toBeChecked();
    // пороги сигналов расхода — с сервера (alert_rules), те же числа, что проверяет воркер
    expect(
      within(what).getByText(/^Доля кэша ниже 50% по 10 анализам, анализ дороже 2 медиан за 7 дн\., больше 2% обрезанных ответов или отказов, больше 30 поисков в день/),
    ).toBeInTheDocument();
    // новые виды этапа 5 и сигналы расхода — с пометкой «новое»
    expect(within(what).getAllByText('новое')).toHaveLength(4);
    expect(within(what).getByRole('switch', { name: 'На сайте: Обучение модели' })).toBeChecked();
    expect(within(what).getByText('Урок готов к решению, кандидат версии проверен, базовая модель перекалибрована или не включена')).toBeInTheDocument();
    expect(await within(what).findByText(/^Общий бюджет ключа администратора — \$60 в месяц/)).toBeInTheDocument();
    expect(await within(what).findByText('Участник на своем ключе просит вернуть его на ваш. Сейчас ждут: 1')).toBeInTheDocument();
    expect(within(what).getByText('Участник израсходовал 80% лимита или ему не хватает на вызов Claude. Сейчас у порога: Игорь Нестеров')).toBeInTheDocument();
    // лимита участника у администратора нет
    expect(within(what).queryByRole('switch', { name: 'На сайте: Лимит ИИ: 80% и остановка' })).toBeNull();
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
    const what = await card();
    expect(await within(what).findByRole('switch', { name: 'На сайте: Пора загрузить файл tennis-data' })).toBeChecked();
    expect(
      await within(what).findByText(
        /^Напоминание по понедельникам, 08:00, и если файл не загружали больше 5 дней: без него ставки не рассчитываются сами, Эло и форма устаревают\. Последняя загрузка — 12 окт \(3 дня назад\)$/,
      ),
    ).toBeInTheDocument();
  });

  it('настройки не загрузились — текст ошибки и «Повторить»', async () => {
    renderTab(api({ 'GET /api/me/notification-prefs': () => apiError(500, 'common.internal', 'Сбой сервера') }));
    const what = await card();
    expect(await within(what).findByText(/Сбой сервера/)).toBeInTheDocument();
    expect(within(what).getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });
});
