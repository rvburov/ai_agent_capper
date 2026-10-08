import { describe, expect, it } from 'vitest';

import { checkPassword } from './password';

describe('надежность пароля', () => {
  it('пустой — не задан, отправлять нельзя', () => {
    const check = checkPassword('');
    expect(check.level).toBe('empty');
    expect(check.ok).toBe(false);
  });

  it('короткий — слабый или средний', () => {
    expect(checkPassword('abc').level).toBe('weak');
    expect(checkPassword('abcdefgh1').level).toBe('medium');
  });

  it('12+ символов, буквы и цифры — хороший; длиннее или с символами — надежный', () => {
    expect(checkPassword('abcdefgh1234').level).toBe('good');
    expect(checkPassword('abcdefgh1234').ok).toBe(true);
    expect(checkPassword('Abcdefgh1234').level).toBe('strong');
    expect(checkPassword('abcdefgh-1234').level).toBe('strong');
    expect(checkPassword('пароль-кириллицей-2026').level).toBe('strong');
  });

  it('без цифр не проходит, даже длинный', () => {
    const check = checkPassword('correct horse battery staple');
    expect(check.mix).toBe(false);
    expect(check.ok).toBe(false);
  });

  it('длиннее 128 символов не проходит', () => {
    const check = checkPassword(`a1${'x'.repeat(127)}`);
    expect(check.tooLong).toBe(true);
    expect(check.ok).toBe(false);
  });

  it('пароль из утечки (ответ сервера) — слабый и не проходит', () => {
    const check = checkPassword('Abcdefgh1234', true);
    expect(check.level).toBe('weak');
    expect(check.ok).toBe(false);
  });
});
