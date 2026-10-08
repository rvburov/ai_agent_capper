// Правила пароля на экранах регистрации и сброса (как в макете): не короче 12 символов,
// буквы и цифры. Длину и утечки (Have I Been Pwned) проверяет и сервер: утечку видно только
// по его ответу, поэтому это правило до отправки «ждет проверки».

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type PasswordLevel = 'empty' | 'weak' | 'medium' | 'good' | 'strong';

export interface PasswordCheck {
  long: boolean;
  tooLong: boolean;
  mix: boolean;
  /** Сервер ответил, что этот пароль встречался в утечках. */
  leaked: boolean;
  score: 0 | 1 | 2 | 3 | 4;
  level: PasswordLevel;
  /** Можно отправлять на сервер. */
  ok: boolean;
}

const LEVELS: readonly PasswordLevel[] = ['empty', 'weak', 'medium', 'good', 'strong'];

const LETTER = /[a-zа-я\u0451]/i;
const DIGIT = /\d/;
const OTHER = /[^a-zа-я\u04510-9]/i;

/** Надежность по шкале макета: 0 — пусто, 1 — слабый … 4 — надежный. */
export function checkPassword(password: string, leaked = false): PasswordCheck {
  const length = [...password].length;
  const long = length >= PASSWORD_MIN;
  const tooLong = length > PASSWORD_MAX;
  const mix = LETTER.test(password) && DIGIT.test(password);
  let score: PasswordCheck['score'] = 0;
  if (password) {
    score = 1;
    if (length >= 8) score = 2;
    if (long && mix) score = 3;
    const cases = /[A-ZА-Я\u0401]/.test(password) && /[a-zа-я\u0451]/.test(password);
    if (long && mix && (length >= 16 || OTHER.test(password) || cases)) score = 4;
  }
  if (leaked) score = Math.min(score, 1) as PasswordCheck['score'];
  return {
    long,
    tooLong,
    mix,
    leaked,
    score,
    level: LEVELS[score] ?? 'empty',
    ok: Boolean(password) && long && !tooLong && mix && !leaked,
  };
}
