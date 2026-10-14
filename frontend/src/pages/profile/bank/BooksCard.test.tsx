import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bookmakerOut } from '../../../features/bookmakers/testData';
import { apiError, json } from '../../../test/fetchMock';
import { bodyOf } from '../../../test/renderPage';
import { bankTabApi, renderBankTab } from './testApi';

// «Мои букмекеры» (В9): список из GET /api/me/bookmakers/list — действующие и скрытые;
// добавить, переименовать, скрыть и вернуть, удалить; ставки в игре — «Пока нельзя».

async function card() {
  return (await screen.findByRole('heading', { name: 'Мои букмекеры' })).closest('section') as HTMLElement;
}

const listReads = (calls: Request[]) => calls.filter((r) => r.method === 'GET' && r.url.endsWith('/api/me/bookmakers/list')).length;

describe('Кабинет: мои букмекеры', () => {
  it('список: число ставок и сумма в игре, скрытые отдельно', async () => {
    renderBankTab(bankTabApi());
    const books = await card();
    expect(await within(books).findByText('Fonbet')).toBeInTheDocument();
    expect(within(books).getByText('12 ставок · в игре 1 320 ₽')).toBeInTheDocument();
    expect(within(books).getByText('0 ставок')).toBeInTheDocument();
    expect(within(books).getByText('Скрытые')).toBeInTheDocument();
    expect(within(books).getByText('3 ставки · в выборе не показывается')).toBeInTheDocument();
    expect(within(books).getByRole('button', { name: 'Вернуть Pari в список' })).toBeInTheDocument();
  });

  it('добавить: повтор и «Другой» — под полем, новый — в списке и в формах', async () => {
    const posted: unknown[] = [];
    const { user, calls } = renderBankTab(
      bankTabApi({
        'POST /api/me/bookmakers': async (request) => {
          const body = (await request.clone().json()) as { name: string };
          posted.push(body);
          if (body.name === 'Другой') return apiError(422, 'bookmaker.reserved', '«Другой» уже есть', { name: 'Другой' });
          return json(bookmakerOut({ id: 9, name: body.name }), 201);
        },
      }),
    );
    const books = await card();
    await within(books).findByText('Fonbet');
    await user.click(within(books).getByRole('button', { name: 'Добавить букмекера' }));
    const dialog = await screen.findByRole('dialog', { name: 'Новый букмекер' });
    const field = within(dialog).getByRole('textbox', { name: 'Букмекер' });
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(within(dialog).getByText('Укажите название')).toBeInTheDocument();
    await user.type(field, 'pari');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    // скрытый тоже занимает название
    expect(within(dialog).getByText('«pari» уже есть в списке букмекеров')).toBeInTheDocument();
    await user.clear(field);
    await user.type(field, 'Другой');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await within(dialog).findByText('«Другой» уже есть в выборе при анализе — укажите название букмекера')).toBeInTheDocument();
    const before = listReads(calls);
    await user.clear(field);
    await user.type(field, ' Betfair ');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить' }));
    expect(await screen.findByText('Betfair добавлен')).toBeInTheDocument();
    expect(posted).toEqual([{ name: 'Другой' }, { name: 'Betfair' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(listReads(calls)).toBeGreaterThan(before));
  });

  it('переименовать: новое название, сохраненные ставки остаются с прежним', async () => {
    const { user, calls } = renderBankTab(bankTabApi({ 'PATCH /api/me/bookmakers/2': () => json(bookmakerOut({ id: 2, name: 'Winline RU' })) }));
    const books = await card();
    await user.click(await within(books).findByRole('button', { name: 'Переименовать Winline' }));
    const dialog = await screen.findByRole('dialog', { name: 'Переименовать Winline' });
    expect(within(dialog).getByText('В уже сохраненных ставках останется прежнее название')).toBeInTheDocument();
    const field = within(dialog).getByRole('textbox', { name: 'Новое название' });
    await user.clear(field);
    await user.type(field, 'Winline RU');
    await user.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('Winline теперь называется Winline RU')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PATCH') as Request)).toEqual({ name: 'Winline RU', archived: null });
  });

  it('скрыть со ставками в игре — «Пока нельзя», без запроса; без ставок — подтверждение', async () => {
    const { user, calls } = renderBankTab(
      bankTabApi({ 'PATCH /api/me/bookmakers/2': () => json(bookmakerOut({ id: 2, name: 'Winline', archived_at: '2026-10-14T10:00:00Z' })) }),
    );
    const books = await card();
    await user.click(await within(books).findByRole('button', { name: 'Скрыть Fonbet' }));
    const blocked = await screen.findByRole('dialog', { name: 'Пока нельзя скрыть Fonbet' });
    expect(within(blocked).getByText('В игре 2 ставки у Fonbet на 1 320 ₽. Скрыть букмекера можно после расчета.')).toBeInTheDocument();
    await waitFor(() => expect(within(blocked).getByRole('button', { name: 'Понятно' })).toHaveFocus());
    await user.click(within(blocked).getByRole('button', { name: 'Понятно' }));
    expect(calls.some((r) => r.method === 'PATCH')).toBe(false);

    await user.click(within(books).getByRole('button', { name: 'Скрыть Winline' }));
    const confirm = await screen.findByRole('dialog', { name: 'Скрыть Winline?' });
    expect(within(confirm).getByText(/История ставок у него \(0\) останется/)).toBeInTheDocument();
    await user.click(within(confirm).getByRole('button', { name: 'Скрыть' }));
    expect(await screen.findByText('Winline скрыт. История ставок осталась')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PATCH') as Request)).toEqual({ name: null, archived: true });
  });

  it('скрытого — вернуть или удалить; ставка в игре появилась — понятный текст сервера', async () => {
    let deletes = 0;
    const { user, calls } = renderBankTab(
      bankTabApi({
        'PATCH /api/me/bookmakers/3': () => json(bookmakerOut({ id: 3, name: 'Pari', bets: 3 })),
        'DELETE /api/me/bookmakers/3': () => {
          deletes += 1;
          return deletes === 1
            ? apiError(409, 'bookmaker.open_bets', 'Нельзя', { name: 'Pari', open_bets: 1, in_play: '500.00', currency: 'RUB' })
            : new Response(null, { status: 204 });
        },
      }),
    );
    const books = await card();
    await user.click(await within(books).findByRole('button', { name: 'Вернуть Pari в список' }));
    expect(await screen.findByText('Pari снова в списке')).toBeInTheDocument();
    expect(await bodyOf(calls.find((r) => r.method === 'PATCH') as Request)).toEqual({ name: null, archived: false });

    await user.click(within(books).getByRole('button', { name: 'Удалить Pari из списка' }));
    let dialog = await screen.findByRole('dialog', { name: 'Удалить Pari из списка?' });
    expect(within(dialog).getByText(/Ставки у него \(3\) останутся в истории с этим названием/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    const blocked = await screen.findByRole('dialog', { name: 'Пока нельзя удалить Pari' });
    expect(within(blocked).getByText('У «Pari» в игре ставок: 1 на 500 ₽. Скрыть или удалить букмекера можно после расчета')).toBeInTheDocument();
    await user.click(within(blocked).getByRole('button', { name: 'Понятно' }));

    await user.click(within(books).getByRole('button', { name: 'Удалить Pari из списка' }));
    dialog = await screen.findByRole('dialog', { name: 'Удалить Pari из списка?' });
    await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('Pari удален из списка')).toBeInTheDocument();
    expect(deletes).toBe(2);
  });

  it('список не загрузился — текст ошибки и «Повторить»', async () => {
    renderBankTab(bankTabApi({ 'GET /api/me/bookmakers/list': () => apiError(500, 'common.internal', 'Сбой сервера') }));
    const books = await card();
    expect(await within(books).findByText(/Сбой сервера/)).toBeInTheDocument();
    expect(within(books).getByRole('button', { name: 'Добавить букмекера' })).toBeDisabled();
  });
});
