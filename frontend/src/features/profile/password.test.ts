import { describe, expect, it } from 'vitest';

import {
  passwordRequirements,
  passwordScore,
  strengthLevel,
  validatePasswordChange,
} from './password';

describe('надежность пароля (как в макете)', () => {
  it('уровни: слабый, средний, надежный', () => {
    expect(strengthLevel('')).toBeNull();
    expect(strengthLevel('abc')).toBe('weak');
    expect(strengthLevel('Abcdef1!')).toBe('medium');
    expect(strengthLevel('correcthorse12')).toBe('medium');
    expect(strengthLevel('Correct-Horse-12')).toBe('strong');
  });

  it('короче 8 символов — не выше одного балла', () => {
    expect(passwordScore('A1!b')).toBe(1);
  });

  it('кириллица считается буквами', () => {
    expect(passwordRequirements('', 'парольдлинный12').mix).toBe(true);
    expect(passwordScore('ПарольДлинный-12')).toBe(5);
  });

  it('длина — в символах, а не в единицах UTF-16', () => {
    // 11 эмодзи — 22 единицы UTF-16, но всего 11 символов
    expect(passwordRequirements('', '\u{1F600}'.repeat(11)).length).toBe(false);
  });
});

describe('проверка формы смены пароля', () => {
  it('пустые поля', () => {
    expect(validatePasswordChange('', '', '')).toEqual({ current: 'errCurrent', next: 'errShort' });
  });

  it('короткий, без цифр, совпадает с текущим, длинный', () => {
    expect(validatePasswordChange('old', 'short1', 'short1').next).toBe('errShort');
    expect(validatePasswordChange('old', 'onlyletterslong', 'onlyletterslong').next).toBe('errMix');
    expect(validatePasswordChange('same-pass-123', 'same-pass-123', 'same-pass-123').next).toBe(
      'errSame',
    );
    const long = 'a1'.repeat(65);
    expect(validatePasswordChange('old', long, long).next).toBe('errLong');
  });

  it('повтор не совпадает', () => {
    expect(validatePasswordChange('old', 'new-password-12', 'new-password-13')).toEqual({
      confirm: 'errConfirm',
    });
  });

  it('все верно — ошибок нет', () => {
    expect(validatePasswordChange('old', 'new-password-12', 'new-password-12')).toEqual({});
  });
});
