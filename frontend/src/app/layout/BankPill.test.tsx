import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { bankOut } from '../../features/analysis/testData';
import { json } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { BankPill } from './BankPill';

// Плашка «Банк» в шапке (bank-pill макета): капитал с учетом ставок в игре из GET /api/me/bank.

describe('Плашка «Банк»', () => {
  it('капитал в валюте программы; на телефоне подпись «Банк» скрыта классом hide-mobile', async () => {
    renderPage(<BankPill />, { path: '/', api: { 'GET /api/me/bank': () => json(bankOut({ equity: '50860.40', balance: '49540.40', currency: 'USD' })) } });
    const pill = await screen.findByTitle('Текущий банк — с учетом ставок в игре');
    expect(pill).toHaveTextContent('Банк50 860,40 $');
    expect(screen.getByText('Банк')).toHaveClass('hide-mobile');
  });

  it('банка еще нет — плашки нет', async () => {
    renderPage(
      <>
        <BankPill />
        <p>Экран</p>
      </>,
      { path: '/', api: { 'GET /api/me/bank': () => json(bankOut({ empty: true, equity: '0.00', balance: '0.00' })) } },
    );
    expect(await screen.findByText('Экран')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTitle('Текущий банк — с учетом ставок в игре')).toBeNull();
  });

  it('банк не загрузился — плашки нет', async () => {
    renderPage(
      <>
        <BankPill />
        <p>Экран</p>
      </>,
      { path: '/', api: { 'GET /api/me/bank': () => json({ error: { code: 'common.internal', message: 'Ошибка' } }, 500) } },
    );
    expect(await screen.findByText('Экран')).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTitle('Текущий банк — с учетом ставок в игре')).toBeNull();
  });
});
