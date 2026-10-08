import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { apiError, json, ME_MEMBER, mockFetch } from '../../test/fetchMock';
import { bodyOf, renderAuth } from './testing';

async function fillForm(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByLabelText('Код приглашения'), 'cap k7qm 2xpa');
  await user.type(screen.getByLabelText('Имя'), '  Анна Петрова ');
  await user.type(screen.getByLabelText('Email'), 'anna@example.com');
  await user.type(screen.getByLabelText('Пароль'), 'Member-pass-2026');
  await user.type(screen.getByLabelText('Повторите пароль'), 'Member-pass-2026');
  await user.click(screen.getByRole('checkbox', { name: /Мне 18 лет/ }));
  await user.click(screen.getByRole('checkbox', { name: /прогнозы делает ИИ/ }));
}

describe('регистрация по приглашению', () => {
  it('пустая форма: ошибки полей и согласий, запроса нет, фокус на первом поле', async () => {
    const { calls } = mockFetch({});
    renderAuth('/register');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(screen.getByText('Введите код приглашения от администратора')).toBeInTheDocument();
    expect(screen.getByText('Напишите имя — так вас увидит администратор')).toBeInTheDocument();
    expect(screen.getByText('Придумайте пароль')).toBeInTheDocument();
    expect(screen.getByText('Без подтверждения возраста регистрация невозможна')).toBeInTheDocument();
    expect(screen.getByText('Отметьте, чтобы продолжить')).toBeInTheDocument();
    expect(screen.getByLabelText('Код приглашения')).toHaveFocus();
    expect(calls).toHaveLength(0);
  });

  it('маска кода, правила пароля, часовой пояс браузера по умолчанию', async () => {
    mockFetch({});
    renderAuth('/register');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Код приглашения'), 'k7qm2xpa');
    expect(screen.getByLabelText('Код приглашения')).toHaveValue('CAP-K7QM-2XPA');
    await user.type(screen.getByLabelText('Пароль'), 'short1');
    const rules = screen.getByRole('list', { name: 'Требования к паролю' });
    expect(within(rules).getByText('12+ символов (сейчас 6)')).toBeInTheDocument();
    expect(within(rules).getByText('Не встречался в утечках').closest('li')).toHaveTextContent('проверим при отправке');
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.getByRole('button', { name: /Часовой пояс/ })).toHaveTextContent(tz === 'Europe/Helsinki' ? 'Хельсинки' : tz.replace(/_/g, ' '));
  });

  it('отправка: код, email, имя, согласия и пояс; дальше — настройка 2FA', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/register': () => json({ status: 'totp_setup_required' }),
      'POST /api/auth/2fa/setup': () =>
        json({ secret: 'ABCDABCDABCDABCD', otpauth_uri: 'otpauth://x', qr_svg: '<svg width="10" height="10"></svg>' }),
      'POST /api/auth/2fa/setup/confirm': () => json({ status: 'ok', user: ME_MEMBER, recovery_codes: ['aaaa-bbbb'] }),
    });
    renderAuth('/register');
    const user = userEvent.setup();
    await fillForm(user);
    await user.click(screen.getByRole('checkbox', { name: /обезличенном виде/ }));
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByRole('heading', { name: 'Включите двухфакторную защиту' })).toBeInTheDocument();
    const body = await bodyOf(calls.find((r) => r.url.endsWith('/api/auth/register'))!);
    expect(body).toEqual({
      invite_code: 'CAP-K7QM-2XPA',
      email: 'anna@example.com',
      display_name: 'Анна Петрова',
      password: 'Member-pass-2026',
      accept_terms: true,
      consent_training: true,
      tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    });
    // настройка 2FA после регистрации → главная
    await user.click(await screen.findByRole('textbox', { name: 'Цифра 1 из 6' }));
    await user.keyboard('123456');
    await user.click(screen.getByRole('button', { name: 'Проверить код и включить 2FA' }));
    await user.click(await screen.findByRole('checkbox', { name: /Я сохранил\(а\)/ }));
    await user.click(screen.getByRole('button', { name: 'Готово — войти в кабинет' }));
    expect(await screen.findByText(/Приложение \/ вошел Анна Петрова/)).toBeInTheDocument();
  });

  it('код не подходит — ошибка под полем кода, текст сервера', async () => {
    mockFetch({
      'POST /api/auth/register': () => apiError(400, 'auth.invite_invalid', 'Код не подходит: он неверный'),
    });
    renderAuth('/register');
    const user = userEvent.setup();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByText('Код не подходит: он неверный')).toBeInTheDocument();
    expect(screen.getByLabelText('Код приглашения')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Код приглашения')).toHaveFocus();
  });

  it('пароль из утечки — правило «Встречался в утечках»', async () => {
    mockFetch({
      'POST /api/auth/register': () => apiError(400, 'auth.password_pwned', 'Этот пароль встречался в утечках'),
    });
    renderAuth('/register');
    const user = userEvent.setup();
    await fillForm(user);
    await user.click(screen.getByRole('button', { name: 'Создать аккаунт' }));
    expect(await screen.findByText('Этот пароль встречался в утечках')).toBeInTheDocument();
    expect(screen.getByText('Встречался в утечках — придумайте другой')).toBeInTheDocument();
  });
});
