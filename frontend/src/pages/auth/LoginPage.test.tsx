import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { apiError, json, ME_ADMIN, mockFetch } from '../../test/fetchMock';
import { bodyOf, renderAuth, resizableViewport } from './testing';

const QR = '<svg width="148" height="148" class="segno"><path d="M2 2.5h7"/></svg>';
const CODES = ['4f7k-2m9q', 'x8c3-vn5d', '7hpt-k2wz', 'm6qa-93rf', 'e2yd-u7jb', 'r5ns-8gxk', 'b9wl-c4tm', 'q3jv-6pzh'];

async function fillLogin(user: ReturnType<typeof userEvent.setup>, email = 'owner@example.com') {
  await user.type(screen.getByLabelText('Email'), email);
  await user.type(screen.getByLabelText('Пароль'), 'Secret-password-1');
  await user.click(screen.getByRole('button', { name: 'Войти' }));
}

describe('вход: шаг «Пароль»', () => {
  it('пустые поля проверяются до сервера', async () => {
    const { calls } = mockFetch({});
    renderAuth('/login');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Введите email в формате name@example.com')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    expect(await screen.findByText('Введите пароль')).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });

  it('доверенное устройство: сразу в приложение, по адресу next, пользователь в кэше', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json({ status: 'ok', user: ME_ADMIN }),
    });
    const { router } = renderAuth('/login?next=%2Fbets%3Fstatus%3Dopen');
    await fillLogin(userEvent.setup());
    expect(await screen.findByText(/Приложение \/bets вошел Роман Буров/)).toBeInTheDocument();
    expect(router.state.location.search).toBe('?status=open');
    expect(await bodyOf(calls[0]!)).toEqual({ email: 'owner@example.com', password: 'Secret-password-1' });
  });

  it('чужой адрес в next не уводит с сайта', async () => {
    mockFetch({ 'POST /api/auth/login': () => json({ status: 'ok', user: ME_ADMIN }) });
    renderAuth('/login?next=%2F%2Fevil.example');
    await fillLogin(userEvent.setup());
    expect(await screen.findByText(/Приложение \/ вошел/)).toBeInTheDocument();
  });

  it('неверный пароль — текст сервера, пароль очищен', async () => {
    mockFetch({
      'POST /api/auth/login': () => apiError(401, 'auth.invalid_credentials', 'Неверный email или пароль'),
    });
    renderAuth('/login');
    await fillLogin(userEvent.setup());
    expect(await screen.findByRole('alert')).toHaveTextContent('Неверный email или пароль');
    expect(screen.getByLabelText('Пароль')).toHaveValue('');
    expect(screen.getByLabelText('Пароль')).toHaveFocus();
  });

  it('пауза (429): экран «Вход временно закрыт» с обратным отсчетом из retry_after', async () => {
    mockFetch({
      'POST /api/auth/login': () =>
        apiError(429, 'auth.rate_limited', 'Вход временно закрыт', { retry_after: 893 }),
    });
    renderAuth('/login');
    await fillLogin(userEvent.setup(), 'nobody@example.com');
    expect(await screen.findByRole('heading', { name: 'Вход временно закрыт' })).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/14:5\d/);
    expect(screen.getByText(/через 15 мин/)).toBeInTheDocument();
    expect(screen.getByText('nobody@example.com')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Сбросить пароль по коду' })).toHaveAttribute('href', '/reset');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Вернуться ко входу' }));
    expect(screen.getByRole('heading', { name: 'Вход в AI Capper' })).toBeInTheDocument();
  });

  it('сеанс закончился при открытом приложении — пояснение', () => {
    mockFetch({});
    renderAuth({ pathname: '/login', state: { sessionEnded: true } });
    expect(screen.getByRole('status')).toHaveTextContent('Сеанс завершен. Войдите снова.');
  });
});

describe('вход: код 2FA и резервный код', () => {
  it('шестая цифра отправляет код сама, с «запомнить устройство»', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_required' }),
      'POST /api/auth/2fa': () => json({ status: 'ok', user: ME_ADMIN }),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Пароль'), 'Secret-password-1');
    await user.click(screen.getByRole('checkbox', { name: /Запомнить это устройство/ }));
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    const first = await screen.findByRole('textbox', { name: 'Цифра 1 из 6' });
    expect(first).toHaveAttribute('autocomplete', 'one-time-code');
    expect(first).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByText('Устройство запомним на 30 дней')).toBeInTheDocument();
    expect(screen.getByText('owner@example.com')).toBeInTheDocument();
    await user.click(first);
    await user.keyboard('123456');
    expect(await screen.findByText(/Приложение \/ вошел Роман Буров/)).toBeInTheDocument();
    const twoFa = calls.find((r) => r.url.endsWith('/api/auth/2fa'))!;
    expect(await bodyOf(twoFa)).toEqual({ code: '123456', remember_device: true });
  });

  it('вставка кода целиком; неверный код — ошибка и пустые клетки', async () => {
    mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_required' }),
      'POST /api/auth/2fa': () => apiError(401, 'auth.invalid_code', 'Код не подходит'),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await fillLogin(user);
    const first = await screen.findByRole('textbox', { name: 'Цифра 1 из 6' });
    await user.click(first);
    await user.paste('654 321');
    expect(await screen.findByRole('alert')).toHaveTextContent('Код не подходит');
    for (const box of screen.getAllByRole('textbox', { name: /Цифра/ })) expect(box).toHaveValue('');
  });

  it('незавершенный вход истек — снова шаг «Пароль» с сообщением', async () => {
    mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_required' }),
      'POST /api/auth/2fa': () => apiError(401, 'auth.login_expired', 'Время на вход истекло'),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(await screen.findByRole('textbox', { name: 'Цифра 1 из 6' }));
    await user.keyboard('111111');
    expect(await screen.findByRole('heading', { name: 'Вход в AI Capper' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Время на вход истекло');
    expect(screen.getByLabelText('Email')).toHaveValue('owner@example.com');
  });

  it('резервный код: проверка вида, отправка recovery_code', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_required' }),
      'POST /api/auth/2fa': () => json({ status: 'ok', user: ME_ADMIN }),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(await screen.findByRole('button', { name: 'Нет доступа к приложению-аутентификатору' }));
    const field = screen.getByLabelText('Резервный код');
    await user.type(field, '4f7k');
    await user.click(screen.getByRole('button', { name: 'Войти по резервному коду' }));
    expect(screen.getByText('Код состоит из 8 букв и цифр, например 4f7k-2m9q')).toBeInTheDocument();
    await user.type(field, '-2M9Q');
    await user.click(screen.getByRole('button', { name: 'Войти по резервному коду' }));
    expect(await screen.findByText(/Приложение \/ вошел/)).toBeInTheDocument();
    const twoFa = calls.find((r) => r.url.endsWith('/api/auth/2fa'))!;
    expect(await bodyOf(twoFa)).toEqual({ recovery_code: '4f7k-2M9Q', remember_device: false });
  });

  it('«Нет и резервных кодов?» — пояснение и команда для администратора, Esc закрывает', async () => {
    mockFetch({ 'POST /api/auth/login': () => json({ status: 'totp_required' }) });
    renderAuth('/login');
    const user = userEvent.setup();
    await fillLogin(user);
    await user.click(await screen.findByRole('button', { name: 'Нет доступа к приложению-аутентификатору' }));
    await user.click(screen.getByRole('button', { name: 'Нет и резервных кодов?' }));
    const dialog = screen.getByRole('dialog', { name: 'Нет ни приложения, ни резервных кодов' });
    expect(within(dialog).getByText(/deploy\/local\.sh cli reset-2fa/)).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('вход: настройка 2FA', () => {
  it('QR-код картинкой, ключ группами, код → 8 резервных кодов → «Готово» только после отметки', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_setup_required' }),
      'POST /api/auth/2fa/setup': () =>
        json({ secret: 'JK3MQ7XPL2VD6WRA', otpauth_uri: 'otpauth://totp/x', qr_svg: QR }),
      'POST /api/auth/2fa/setup/confirm': () => json({ status: 'ok', user: ME_ADMIN, recovery_codes: CODES }),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await fillLogin(user);
    const qr = await screen.findByRole('img', { name: 'QR-код для приложения-аутентификатора' });
    expect(qr.getAttribute('src')).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(decodeURIComponent(qr.getAttribute('src')!)).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(screen.getByText('JK3M Q7XP L2VD 6WRA')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Резервные коды' })).not.toBeInTheDocument();
    expect(screen.queryByText(/устройство не запоминаем/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Проверить код и включить 2FA' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Введите 6 цифр из приложения');
    await user.click(screen.getByRole('textbox', { name: 'Цифра 1 из 6' }));
    await user.keyboard('246810');
    await user.click(screen.getByRole('button', { name: 'Проверить код и включить 2FA' }));

    const list = await screen.findByRole('list', { name: 'Резервные коды' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(8);
    expect(screen.getByRole('button', { name: 'Скачать .txt' })).toBeInTheDocument();
    const confirm = calls.find((r) => r.url.endsWith('/2fa/setup/confirm'))!;
    expect(await bodyOf(confirm)).toEqual({ code: '246810' });

    await user.click(screen.getByRole('button', { name: 'Готово — войти в кабинет' }));
    expect(screen.getByText(/Отметьте, что сохранили коды/)).toBeInTheDocument();
    expect(screen.queryByText(/Приложение/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Я сохранил\(а\) резервные коды/ }));
    await user.click(screen.getByRole('button', { name: 'Готово — войти в кабинет' }));
    expect(await screen.findByText(/Приложение \/ вошел Роман Буров/)).toBeInTheDocument();
    // секрет запрошен один раз: после входа экран не просит его снова
    expect(calls.filter((r) => r.url.endsWith('/api/auth/2fa/setup'))).toHaveLength(1);
  });

  it('смена раскладки (поворот планшета) после подтверждения кода не убирает резервные коды', async () => {
    const viewport = resizableViewport(1366);
    try {
      mockFetch({
        'POST /api/auth/login': () => json({ status: 'totp_setup_required' }),
        'POST /api/auth/2fa/setup': () =>
          json({ secret: 'JK3MQ7XPL2VD6WRA', otpauth_uri: 'otpauth://totp/x', qr_svg: QR }),
        'POST /api/auth/2fa/setup/confirm': () => json({ status: 'ok', user: ME_ADMIN, recovery_codes: CODES }),
      });
      renderAuth('/login');
      const user = userEvent.setup();
      await fillLogin(user);
      await screen.findByRole('img', { name: 'QR-код для приложения-аутентификатора' });
      await user.click(screen.getByRole('textbox', { name: 'Цифра 1 из 6' }));
      await user.keyboard('246810');
      await user.click(screen.getByRole('button', { name: 'Проверить код и включить 2FA' }));
      await screen.findByRole('list', { name: 'Резервные коды' });
      await user.click(screen.getByRole('checkbox', { name: /Я сохранил\(а\) резервные коды/ }));

      viewport.resize(900);
      expect(document.querySelector('.login-m')).not.toBeNull();
      const list = screen.getByRole('list', { name: 'Резервные коды' });
      expect(within(list).getAllByRole('listitem')).toHaveLength(8);
      expect(screen.getByRole('checkbox', { name: /Я сохранил\(а\) резервные коды/ })).toBeChecked();
      expect(screen.queryByRole('button', { name: 'Проверить код и включить 2FA' })).not.toBeInTheDocument();

      viewport.resize(1366);
      expect(document.querySelector('.login-page')).not.toBeNull();
      expect(screen.getByRole('list', { name: 'Резервные коды' })).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Готово — войти в кабинет' }));
      expect(await screen.findByText(/Приложение \/ вошел Роман Буров/)).toBeInTheDocument();
    } finally {
      viewport.restore();
    }
  });

  it('«Запомнить устройство» на шаге «Пароль»: настройка 2FA говорит, что устройство не запомнит', async () => {
    const { calls } = mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_setup_required' }),
      'POST /api/auth/2fa/setup': () =>
        json({ secret: 'JK3MQ7XPL2VD6WRA', otpauth_uri: 'otpauth://totp/x', qr_svg: QR }),
    });
    renderAuth('/login');
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email'), 'owner@example.com');
    await user.type(screen.getByLabelText('Пароль'), 'Secret-password-1');
    await user.click(screen.getByRole('checkbox', { name: /Запомнить это устройство/ }));
    await user.click(screen.getByRole('button', { name: 'Войти' }));
    await screen.findByRole('img', { name: 'QR-код для приложения-аутентификатора' });
    expect(screen.getByText(/При настройке 2FA устройство не запоминаем/)).toBeInTheDocument();
    expect(calls.filter((r) => r.url.endsWith('/api/auth/2fa/setup'))).toHaveLength(1);
  });

  it('секрет не выдали (вход истек) — снова шаг «Пароль»', async () => {
    mockFetch({
      'POST /api/auth/login': () => json({ status: 'totp_setup_required' }),
      'POST /api/auth/2fa/setup': () => apiError(401, 'auth.login_expired', 'Время на вход истекло'),
    });
    renderAuth('/login');
    await fillLogin(userEvent.setup());
    expect(await screen.findByRole('alert')).toHaveTextContent('Время на вход истекло');
    expect(screen.getByRole('heading', { name: 'Вход в AI Capper' })).toBeInTheDocument();
  });
});
