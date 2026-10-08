import { describe, expect, it } from 'vitest';

import { ApiError, networkError } from '../../api/errors';
import {
  codeFailure,
  formatCountdown,
  isPwned,
  loginFailure,
  pauseWords,
  registerFailure,
  resetFailure,
  stepAfterLogin,
} from './flow';

const err = (status: number, code: string, message = 'текст сервера', detail: Record<string, unknown> = {}) =>
  new ApiError(status, code, message, detail);

describe('шаги после входа паролем', () => {
  it('ok — в приложение, totp_required — код, totp_setup_required — настройка', () => {
    expect(stepAfterLogin('ok')).toBe('done');
    expect(stepAfterLogin('totp_required')).toBe('2fa');
    expect(stepAfterLogin('totp_setup_required')).toBe('setup');
  });
});

describe('ошибки шага «Пароль»', () => {
  it('429 auth.rate_limited — экран паузы с retry_after', () => {
    expect(loginFailure(err(429, 'auth.rate_limited', 'x', { retry_after: 893 }))).toEqual({
      kind: 'locked',
      retryAfter: 893,
    });
  });

  it('без retry_after пауза — 15 минут', () => {
    expect(loginFailure(err(429, 'auth.rate_limited'))).toEqual({ kind: 'locked', retryAfter: 900 });
  });

  it('неверный пароль, блокировка, сеть — сообщение над формой', () => {
    expect(loginFailure(err(401, 'auth.invalid_credentials', 'Неверный email или пароль'))).toEqual({
      kind: 'form',
      message: 'Неверный email или пароль',
    });
    expect(loginFailure(err(403, 'auth.blocked', 'Аккаунт заблокирован'))).toMatchObject({ kind: 'form' });
    expect(loginFailure(networkError())).toMatchObject({ kind: 'form', message: expect.stringContaining('Нет связи') });
  });
});

describe('ошибки шагов кода 2FA', () => {
  it('неверный код — ошибка поля, остаемся на шаге', () => {
    expect(codeFailure(err(401, 'auth.invalid_code', 'Код не подходит'))).toEqual({
      kind: 'field',
      field: 'code',
      message: 'Код не подходит',
    });
  });

  it('вход истек, заблокирован, шаг 2FA закрыт — снова шаг «Пароль»', () => {
    for (const code of ['auth.login_expired', 'auth.blocked', 'auth.two_factor_locked']) {
      expect(codeFailure(err(code === 'auth.blocked' ? 403 : 401, code))).toMatchObject({ kind: 'restart' });
    }
    expect(codeFailure(err(429, 'auth.two_factor_locked', 'x', { retry_after: 3600 }))).toMatchObject({
      kind: 'restart',
    });
  });

  it('пауза пары (email, IP) на шаге кода — экран паузы', () => {
    expect(codeFailure(err(429, 'auth.rate_limited', 'x', { retry_after: 60 }))).toEqual({
      kind: 'locked',
      retryAfter: 60,
    });
  });
});

describe('ошибки регистрации и сброса', () => {
  it('приглашение, пароль, условия — ошибка нужного поля', () => {
    expect(registerFailure(err(400, 'auth.invite_invalid'))).toMatchObject({ kind: 'field', field: 'invite' });
    expect(registerFailure(err(400, 'auth.password_pwned'))).toMatchObject({ kind: 'field', field: 'password' });
    expect(registerFailure(err(400, 'auth.password_too_short'))).toMatchObject({ kind: 'field', field: 'password' });
    expect(registerFailure(err(400, 'auth.terms_required'))).toMatchObject({ kind: 'field', field: 'age' });
  });

  it('422 по полю запроса — ошибка поля формы со своим текстом', () => {
    const e = err(422, 'validation', 'Проверьте поля формы', {
      fields: [{ loc: ['body', 'email'], code: 'value_error' }],
    });
    expect(registerFailure(e)).toEqual({
      kind: 'field',
      field: 'email',
      message: 'Введите email в формате name@example.com',
    });
    const tz = err(422, 'validation', 'x', { fields: [{ loc: ['body', 'tz'], code: 'value_error' }] });
    expect(registerFailure(tz)).toMatchObject({ kind: 'field', field: 'tz' });
  });

  it('лимит запросов и неизвестное — ошибка всей формы', () => {
    expect(registerFailure(err(429, 'common.rate_limited', 'Слишком много запросов'))).toEqual({
      kind: 'form',
      message: 'Слишком много запросов',
    });
    expect(resetFailure(err(500, 'common.internal', 'Сбой'))).toEqual({ kind: 'form', message: 'Сбой' });
  });

  it('сброс: неверный код — поле кода, утечка — поле пароля', () => {
    expect(resetFailure(err(400, 'auth.reset_invalid'))).toMatchObject({ kind: 'field', field: 'code' });
    expect(resetFailure(err(400, 'auth.password_pwned'))).toMatchObject({ kind: 'field', field: 'password' });
    const e = err(422, 'validation', 'x', { fields: [{ loc: ['body', 'new_password'], code: 'string_too_long' }] });
    expect(resetFailure(e)).toMatchObject({ kind: 'field', field: 'password' });
    expect(isPwned(err(400, 'auth.password_pwned'))).toBe(true);
    expect(isPwned(err(400, 'auth.reset_invalid'))).toBe(false);
  });
});

describe('обратный отсчет паузы', () => {
  it('мм:сс, от часа — ч:мм:сс', () => {
    expect(formatCountdown(900)).toBe('15:00');
    expect(formatCountdown(65)).toBe('1:05');
    expect(formatCountdown(9)).toBe('0:09');
    expect(formatCountdown(3725)).toBe('1:02:05');
    expect(formatCountdown(-3)).toBe('0:00');
  });

  it('словами: минуты с округлением вверх, меньше минуты — секунды', () => {
    expect(pauseWords(900)).toBe('15 мин');
    expect(pauseWords(61)).toBe('2 мин');
    expect(pauseWords(40)).toBe('40 с');
  });
});
