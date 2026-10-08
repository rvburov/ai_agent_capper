import { isApiError } from '../../api/errors';
import type { components } from '../../api/schema';
import i18n from '../../i18n';

/*
 * Логика шагов входа, регистрации и сброса пароля — без React, чтобы ее можно было проверить
 * тестами. Экраны (src/pages/auth) решают по этим функциям, куда идти после ответа сервера.
 * Шаги — как в макете (mockup/js/screens/login.js): login, 2fa, backup, setup, locked;
 * регистрация: invite → setup; сброс: reset → done.
 */

export type LoginStep = 'login' | '2fa' | 'backup' | 'setup' | 'locked';
export type LoginStatus = components['schemas']['LoginOut']['status'];

/** Куда идти после ответа «вход паролем» (и после регистрации). */
export function stepAfterLogin(status: LoginStatus): 'done' | '2fa' | 'setup' {
  if (status === 'ok') return 'done';
  if (status === 'totp_required') return '2fa';
  return 'setup';
}

/** Что показать после ошибки. */
export type Failure =
  /** Пауза защиты от подбора: экран «Вход временно закрыт» с обратным отсчетом. */
  | { kind: 'locked'; retryAfter: number }
  /** Незавершенный вход больше не годится: снова шаг «Пароль» с сообщением. */
  | { kind: 'restart'; message: string }
  /** Ошибка конкретного поля формы. */
  | { kind: 'field'; field: string; message: string }
  /** Ошибка всей формы (сеть, лимит запросов, сбой сервера). */
  | { kind: 'form'; message: string };

/** Ошибка формы регистрации или сброса: поле или вся форма. */
export type FormFailure = Extract<Failure, { kind: 'field' | 'form' }>;

function messageOf(error: unknown): string {
  return isApiError(error) ? error.message : i18n.t('errors.unknown');
}

function codeOf(error: unknown): string {
  return isApiError(error) ? error.code : '';
}

/** Пауза защиты от подбора входа (не путать с лимитом регистрации и сброса). */
function lockOf(error: unknown): Failure | null {
  if (isApiError(error) && error.status === 429 && error.code === 'auth.rate_limited') {
    return { kind: 'locked', retryAfter: Math.max(1, Math.ceil(error.retryAfter ?? 900)) };
  }
  return null;
}

/** Шаг «Пароль»: пауза — отдельный экран, остальное — сообщение над полями. */
export function loginFailure(error: unknown): Failure {
  return lockOf(error) ?? { kind: 'form', message: messageOf(error) };
}

// Ответы, после которых незавершенный вход сервером уже сброшен
const RESTART_CODES = new Set([
  'auth.login_expired',
  'auth.blocked',
  'auth.two_factor_locked',
  'auth.not_authenticated',
]);

/** Шаги «Код 2FA», «Резервный код», «Настройка 2FA». */
export function codeFailure(error: unknown): Failure {
  const lock = lockOf(error);
  if (lock) return lock;
  const code = codeOf(error);
  if (RESTART_CODES.has(code)) return { kind: 'restart', message: messageOf(error) };
  if (code === 'auth.invalid_code') return { kind: 'field', field: 'code', message: messageOf(error) };
  return { kind: 'form', message: messageOf(error) };
}

const PASSWORD_CODES = new Set([
  'auth.password_too_short',
  'auth.password_too_long',
  'auth.password_pwned',
]);

/** Поле ошибки проверки (422) по имени поля запроса; message — свой текст для поля. */
function validationFailure(
  error: unknown,
  fields: Readonly<Record<string, string>>,
  messages: Readonly<Record<string, string>>,
): FormFailure | null {
  if (!isApiError(error) || error.code !== 'validation') return null;
  for (const item of error.fields) {
    const name = item.loc[item.loc.length - 1];
    const field = typeof name === 'string' ? fields[name] : undefined;
    if (field) return { kind: 'field', field, message: messages[field] ?? error.message };
  }
  return null;
}

/** Регистрация: поля invite, name, email, password, tz, age. */
export function registerFailure(error: unknown): FormFailure {
  const code = codeOf(error);
  if (code === 'auth.invite_invalid') return { kind: 'field', field: 'invite', message: messageOf(error) };
  if (PASSWORD_CODES.has(code)) return { kind: 'field', field: 'password', message: messageOf(error) };
  if (code === 'auth.terms_required') return { kind: 'field', field: 'age', message: messageOf(error) };
  const invalid = validationFailure(
    error,
    {
      invite_code: 'invite',
      display_name: 'name',
      email: 'email',
      password: 'password',
      tz: 'tz',
      accept_terms: 'age',
    },
    {
      invite: i18n.t('auth.register.codeFormat'),
      name: i18n.t('auth.register.nameRequired'),
      email: i18n.t('auth.common.emailInvalid'),
      tz: i18n.t('auth.register.tzInvalid'),
    },
  );
  return invalid ?? { kind: 'form', message: messageOf(error) };
}

/** Сброс пароля: поля email, code, password. */
export function resetFailure(error: unknown): FormFailure {
  const code = codeOf(error);
  if (code === 'auth.reset_invalid') return { kind: 'field', field: 'code', message: messageOf(error) };
  if (PASSWORD_CODES.has(code)) return { kind: 'field', field: 'password', message: messageOf(error) };
  const invalid = validationFailure(
    error,
    { email: 'email', code: 'code', new_password: 'password' },
    { email: i18n.t('auth.common.emailInvalid'), code: i18n.t('auth.reset.codeFormat') },
  );
  return invalid ?? { kind: 'form', message: messageOf(error) };
}

/** Сервер ответил, что пароль встречался в утечках. */
export function isPwned(error: unknown): boolean {
  return codeOf(error) === 'auth.password_pwned';
}

/** Обратный отсчет паузы: «14:05», от часа — «1:02:05». */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(hours ? 2 : 1, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Остаток паузы словами для подзаголовка: «15 мин», меньше минуты — «40 с». */
export function pauseWords(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  if (s < 60) return i18n.t('auth.locked.seconds', { count: s });
  return i18n.t('auth.locked.minutes', { count: Math.ceil(s / 60) });
}
