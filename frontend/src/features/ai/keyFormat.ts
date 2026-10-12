import i18n from '../../i18n';

// Формат ключа Claude — как на сервере (app/services/claude_key.py, _KEY_FORMAT): sk-ant- и
// еще не меньше 16 символов из латиницы, цифр, «_» и «-». Сервер проверяет его сам; здесь —
// чтобы не отправлять заведомо обрезанный ключ и сказать, что не так.
export const KEY_PREFIX = 'sk-ant-';
const KEY_FORMAT = /^sk-ant-[A-Za-z0-9_-]{16,}$/;
const MIN_TAIL = 16;

export type KeyProblem = 'empty' | 'prefix' | 'short' | 'format';

/** Что не так с введенным ключом; null — формат верный. */
export function keyProblem(raw: string): KeyProblem | null {
  const value = raw.trim();
  if (!value) return 'empty';
  if (!value.startsWith(KEY_PREFIX)) return 'prefix';
  if (value.length < KEY_PREFIX.length + MIN_TAIL) return 'short';
  return KEY_FORMAT.test(value) ? null : 'format';
}

/** Ключ на экране — только последние 4 символа: «sk-ant-…m9Tq». */
export function keyMask(last4: string | null | undefined): string {
  return i18n.t('profile.key.mask', { last4: last4 || '••••' });
}

/** Последние символы ключа по одному — для читалки экрана: «m 9 T q». */
export function spelled(last4: string | null | undefined): string {
  return (last4 ?? '').split('').join(' ');
}
