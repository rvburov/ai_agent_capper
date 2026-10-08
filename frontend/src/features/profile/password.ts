// Смена пароля: надежность и проверка формы — как в макете (mockup/js/screens/profile.js,
// strengthOf и passwordCard). Сервер сам проверяет длину и утечки (HIBP); здесь — подсказки
// до отправки, чтобы не гонять заведомо неподходящий пароль.

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type StrengthLevel = 'weak' | 'medium' | 'strong';

const LETTER = /\p{L}/u;
const DIGIT = /\p{N}/u;
const LOWER = /\p{Ll}/u;
const UPPER = /\p{Lu}/u;
const SYMBOL = /[^\p{L}\p{N}]/u;

/** Длина в символах, а не в единицах UTF-16: эмодзи — один символ, как считает сервер. */
export function passwordLength(password: string): number {
  return Array.from(password).length;
}

/** Баллы 0..5: длина 12+ и 16+, строчные и заглавные, цифры, другие символы. */
export function passwordScore(password: string): number {
  const length = passwordLength(password);
  let score = 0;
  if (length >= PASSWORD_MIN) score++;
  if (length >= 16) score++;
  if (LOWER.test(password) && UPPER.test(password)) score++;
  if (DIGIT.test(password)) score++;
  if (SYMBOL.test(password)) score++;
  if (length < 8) score = Math.min(score, 1);
  return score;
}

export function strengthLevel(password: string): StrengthLevel | null {
  if (!password) return null;
  const score = passwordScore(password);
  if (score <= 1) return 'weak';
  if (score <= 3) return 'medium';
  return 'strong';
}

export function hasLettersAndDigits(password: string): boolean {
  return LETTER.test(password) && DIGIT.test(password);
}

export interface PasswordRequirements {
  length: boolean;
  mix: boolean;
  differs: boolean;
}

export function passwordRequirements(current: string, next: string): PasswordRequirements {
  return {
    length: passwordLength(next) >= PASSWORD_MIN,
    mix: hasLettersAndDigits(next),
    differs: next.length > 0 && next !== current,
  };
}

export type PasswordErrorKey =
  | 'errCurrent'
  | 'errShort'
  | 'errLong'
  | 'errMix'
  | 'errSame'
  | 'errConfirm';

export interface PasswordFormErrors {
  current?: PasswordErrorKey;
  next?: PasswordErrorKey;
  confirm?: PasswordErrorKey;
}

/** Ошибки формы смены пароля: ключи текстов profile.password.*; пустой объект — можно отправлять. */
export function validatePasswordChange(
  current: string,
  next: string,
  confirm: string,
): PasswordFormErrors {
  const errors: PasswordFormErrors = {};
  if (!current) errors.current = 'errCurrent';
  const length = passwordLength(next);
  if (length < PASSWORD_MIN) errors.next = 'errShort';
  else if (length > PASSWORD_MAX) errors.next = 'errLong';
  else if (!hasLettersAndDigits(next)) errors.next = 'errMix';
  else if (next === current) errors.next = 'errSame';
  if (next && confirm !== next) errors.confirm = 'errConfirm';
  return errors;
}
