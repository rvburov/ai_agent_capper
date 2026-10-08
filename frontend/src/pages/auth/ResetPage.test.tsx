import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { apiError, json, mockFetch } from '../../test/fetchMock';
import { bodyOf, renderAuth } from './testing';

async function fill(user: ReturnType<typeof userEvent.setup>, code = 'rst-ab12-cd34') {
  await user.type(screen.getByLabelText('Код сброса'), code);
  await user.type(screen.getByLabelText('Новый пароль'), 'New-password-2026');
  await user.type(screen.getByLabelText('Повторите новый пароль'), 'New-password-2026');
}

describe('сброс пароля кодом от администратора', () => {
  it('email с экрана входа, код по маске → «Пароль изменен» → вход с тем же email', async () => {
    const { calls } = mockFetch({ 'POST /api/auth/reset': () => json({ status: 'ok' }) });
    const { router } = renderAuth({ pathname: '/reset', state: { email: 'anna@example.com' } });
    const user = userEvent.setup();
    expect(screen.getByLabelText('Email аккаунта')).toHaveValue('anna@example.com');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(await screen.findByRole('heading', { name: 'Пароль изменен' })).toBeInTheDocument();
    expect(await bodyOf(calls[0]!)).toEqual({
      email: 'anna@example.com',
      code: 'RST-AB12-CD34',
      new_password: 'New-password-2026',
    });
    await user.click(screen.getByRole('link', { name: 'Войти с новым паролем' }));
    expect(router.state.location.pathname).toBe('/login');
    expect(screen.getByLabelText('Email')).toHaveValue('anna@example.com');
  });

  it('пароли не совпадают и неполный код — до сервера', async () => {
    const { calls } = mockFetch({});
    renderAuth('/reset');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email аккаунта'), 'anna@example.com');
    await user.type(screen.getByLabelText('Код сброса'), 'ab12');
    await user.type(screen.getByLabelText('Новый пароль'), 'New-password-2026');
    await user.type(screen.getByLabelText('Повторите новый пароль'), 'New-password-2025');
    expect(screen.getByText('Пока не совпадают')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(screen.getByText(/Код выглядит так: RST-XXXX-XXXX/)).toBeInTheDocument();
    expect(screen.getByText('Пароли не совпадают')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('код не подходит — ошибка под полем кода; лимит запросов — над формой', async () => {
    let limited = false;
    mockFetch({
      'POST /api/auth/reset': () =>
        limited
          ? apiError(429, 'common.rate_limited', 'Слишком много запросов. Повторите чуть позже', { retry_after: 60 })
          : apiError(400, 'auth.reset_invalid', 'Код не подходит'),
    });
    renderAuth('/reset');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email аккаунта'), 'anna@example.com');
    await fill(user);
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(await screen.findByText('Код не подходит')).toBeInTheDocument();
    expect(screen.getByLabelText('Код сброса')).toHaveFocus();
    limited = true;
    await user.click(screen.getByRole('button', { name: 'Сменить пароль' }));
    expect(await screen.findByText('Слишком много запросов. Повторите чуть позже')).toBeInTheDocument();
  });
});
