import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AdminMessage } from '../../features/admin/messages';
import { MESSAGE_MAX, recipientsOf } from '../../features/admin/messages';
import { adminUser, LIMIT_DEFAULTS } from '../../features/admin/testData';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { AdminPage } from './AdminPage';

const ME = adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null });
const OLGA = adminUser({ id: 2 });
const ALEX = adminUser({ id: 3, display_name: 'Алексей Ковалев', email: 'alexey@example.com' });
const IGOR = adminUser({ id: 4, display_name: 'Игорь Нестеров', email: 'igor@example.com', status: 'blocked' });
const MARIA = adminUser({ id: 5, display_name: 'Мария Виртанен', email: 'maria@example.com', role: 'admin' });
const USERS = [ME, OLGA, ALEX, IGOR, MARIA];

function message(over: Partial<AdminMessage> = {}): AdminMessage {
  return {
    id: 10,
    sent: true,
    at: '2026-10-12T08:00:00Z',
    text: 'В субботу сервер обновляется',
    user_id: null,
    recipient_name: null,
    recipients: 3,
    actor_name: 'Роман Буров',
    ...over,
  };
}

function api(extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/admin/users': () => json(USERS),
    'GET /api/admin/invites': () => json([]),
    'GET /api/admin/ai/limits': () => json({ defaults: LIMIT_DEFAULTS, members: [] }),
    'GET /api/admin/messages': () => json({ items: [], recipients_all: 3 }),
    ...extra,
  };
}

function renderMessages(extra: Record<string, Handler> = {}, width?: number) {
  return renderPage(<AdminPage />, { path: '/admin/:tab?', url: '/admin/message', me: ME_ADMIN, api: api(extra), width });
}

const toast = (text: string | RegExp) => screen.findByText(text, { selector: '.toast span' });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-13T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Сообщение: получатели', () => {
  it('активные люди программы, кроме вас, по имени', () => {
    expect(recipientsOf(USERS, 1).map((u) => u.id)).toEqual([3, 5, 2]);
    expect(recipientsOf(undefined, 1)).toEqual([]);
  });
});

describe('Администрирование → Сообщение', () => {
  it('всем: счетчик, предпросмотр в колокольчике, отправка и отправленные', async () => {
    let sent: AdminMessage[] = [];
    const view = renderMessages({
      'GET /api/admin/messages': () => json({ items: sent, recipients_all: 3 }),
      'POST /api/admin/messages': async (request) => {
        const body = await bodyOf<{ text: string }>(request);
        const out = message({ id: 11, text: body.text, at: '2026-10-13T12:00:00Z' });
        sent = [out, ...sent];
        return json(out, 201);
      },
    });
    const { user, calls } = view;
    expect(await screen.findByRole('button', { name: 'Всем участникам · 3' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Сообщений еще не было.')).toBeInTheDocument();
    const send = screen.getByRole('button', { name: 'Отправить' });
    expect(send).toBeDisabled();
    // Предпросмотр — как в центре уведомлений
    const preview = screen.getByText('Сообщение администратора').closest('.notif-item')!;
    expect(within(preview as HTMLElement).getByText('Текст сообщения появится здесь')).toBeInTheDocument();

    const text = screen.getByLabelText(/^Текст/);
    await user.type(text, '  Сервер обновится в 10:00  ');
    expect(screen.getByText(`28 / ${MESSAGE_MAX}`)).toBeInTheDocument();
    expect(within(preview as HTMLElement).getByText('Сервер обновится в 10:00')).toBeInTheDocument();
    await user.click(send);
    expect(await toast('Отправлено 3 участникам: на сайте')).toBeInTheDocument();
    const post = calls.find((r) => r.method === 'POST' && r.url.endsWith('/api/admin/messages'))!;
    expect(await bodyOf(post)).toEqual({ text: 'Сервер обновится в 10:00', user_id: null, preview: false });
    expect(text).toHaveValue('');
    const history = screen.getByRole('heading', { name: 'Отправленные' }).closest('section')!;
    expect(await within(history).findByText('Сегодня, 15:00 · Все участники (3)')).toBeInTheDocument();
    expect(within(history).getByText('Сервер обновится в 10:00')).toBeInTheDocument();
    expect(within(history).getByText('Отправил Роман Буров')).toBeInTheDocument();
  });

  it('одному: получатель в общем выпадающем списке, на сервер уходит его id', async () => {
    const view = renderMessages({
      'POST /api/admin/messages': () => json(message({ user_id: 2, recipient_name: 'Ольга Лехтинен', recipients: 1 }), 201),
    });
    const { user, calls } = view;
    await user.click(await screen.findByRole('button', { name: 'Одному' }));
    await user.click(screen.getByRole('button', { name: /^Получатель: Алексей Ковалев/ }));
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Алексей Ковалев',
      'Мария Виртанен',
      'Ольга Лехтинен',
    ]);
    await user.click(screen.getByRole('option', { name: 'Ольга Лехтинен' }));
    await user.type(screen.getByLabelText(/^Текст/), 'Привет');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await toast('Отправлено 1 участнику: на сайте')).toBeInTheDocument();
    const post = calls.find((r) => r.method === 'POST')!;
    expect(await bodyOf(post)).toEqual({ text: 'Привет', user_id: 2, preview: false });
  });

  it('шаблоны подставляют текст, лимит — из лимитов по умолчанию; у 250+ знаков счетчик желтеет', async () => {
    const { user } = renderMessages();
    await user.click(await screen.findByRole('button', { name: 'Лимиты' }));
    // Неразрывные пробелы после чисел — как обычные
    const value = () => (screen.getByLabelText(/^Текст/) as HTMLTextAreaElement).value.replace(/\s/g, ' ');
    expect(value()).toBe('Напоминаю: на моем ключе лимит — $10 в месяц · 3 анализа в день · $1 на анализ. Если нужно больше, напишите мне.');
    await user.click(screen.getByRole('button', { name: 'Работы на сервере' }));
    expect(screen.getByLabelText(/^Текст/)).toHaveValue(
      'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.',
    );
    const text = screen.getByLabelText(/^Текст/);
    expect(text).toHaveAttribute('maxLength', String(MESSAGE_MAX));
    await user.clear(text);
    await user.click(text);
    await user.paste('a'.repeat(260));
    const counter = screen.getByText(`260 / ${MESSAGE_MAX}`);
    expect(counter).toHaveClass('adm-count', 'warn');
  });

  it('ошибка сервера остается над кнопкой, текст не теряется', async () => {
    const { user } = renderMessages({
      'POST /api/admin/messages': () =>
        apiError(409, 'admin.message_no_recipients', 'Некому отправить: в программе нет других активных участников'),
    });
    await user.type(await screen.findByLabelText(/^Текст/), 'Привет');
    await user.click(screen.getByRole('button', { name: 'Отправить' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Некому отправить');
    expect(screen.getByLabelText(/^Текст/)).toHaveValue('Привет');
  });

  it('«Всем участникам · N» — число сервера, а не подсчет по списку людей', async () => {
    renderMessages({ 'GET /api/admin/messages': () => json({ items: [], recipients_all: 7 }) });
    expect(await screen.findByRole('button', { name: 'Всем участникам · 7' })).toBeInTheDocument();
  });

  it('некому отправить: подсказка и кнопка недоступна', async () => {
    const { user } = renderMessages({
      'GET /api/admin/users': () => json([ME, IGOR]),
      'GET /api/admin/messages': () => json({ items: [], recipients_all: 0 }),
    });
    expect(await screen.findByText('Некому отправить: в программе нет других активных участников.')).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Текст/), 'Привет');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
  });

  it('отправленные: одному — имя получателя, последние 5', async () => {
    const items = Array.from({ length: 7 }, (_, i) =>
      message({ id: 20 - i, user_id: 2, recipient_name: 'Ольга Лехтинен', recipients: 1, text: `Сообщение ${i}` }),
    );
    renderMessages({ 'GET /api/admin/messages': () => json({ items, recipients_all: 3 }) }, 375);
    const history = (await screen.findByRole('heading', { name: 'Отправленные' })).closest('section')!;
    await waitFor(() => expect(within(history).getAllByText(/Ольга Лехтинен/)).toHaveLength(5));
    expect(within(history).queryByText('Сообщение 5')).not.toBeInTheDocument();
  });
});
