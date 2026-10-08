import { describe, expect, it } from 'vitest';

import {
  groupSecret,
  isCodeComplete,
  isEmailShape,
  isOtpComplete,
  isRecoveryCodeShape,
  maskCode,
  svgDataUri,
  svgSize,
} from './codes';

describe('маска кодов CAP-/RST-', () => {
  it('ставит префикс, дефисы и заглавные буквы', () => {
    expect(maskCode('CAP', 'k7qm2xpa')).toBe('CAP-K7QM-2XPA');
    expect(maskCode('CAP', 'cap k7qm 2xpa')).toBe('CAP-K7QM-2XPA');
    expect(maskCode('RST', 'rst-ab12-cd34')).toBe('RST-AB12-CD34');
    expect(maskCode('CAP', 'K7Q')).toBe('CAP-K7Q');
    expect(maskCode('CAP', 'K7QM2')).toBe('CAP-K7QM-2');
  });

  it('начало префикса не превращает в код, лишнее отрезает', () => {
    expect(maskCode('CAP', 'ca')).toBe('CA');
    expect(maskCode('CAP', '')).toBe('');
    expect(maskCode('CAP', 'CAP')).toBe('CAP');
    expect(maskCode('RST', 'AAAABBBBCCCC')).toBe('RST-AAAA-BBBB');
  });

  it('полный код — 8 букв и цифр после префикса', () => {
    expect(isCodeComplete('CAP', 'CAP-K7QM-2XPA')).toBe(true);
    expect(isCodeComplete('CAP', 'CAP-K7QM-2XP')).toBe(false);
    expect(isCodeComplete('RST', 'CAP-K7QM-2XPA')).toBe(false);
  });
});

describe('резервный код, код 2FA, email', () => {
  it('резервный код: регистр, пробелы и дефис не важны', () => {
    expect(isRecoveryCodeShape('4f7k-2m9q')).toBe(true);
    expect(isRecoveryCodeShape(' 4F7K 2M9Q ')).toBe(true);
    expect(isRecoveryCodeShape('4f7k-2m9')).toBe(false);
    expect(isRecoveryCodeShape('4f7k-2m9q!')).toBe(false);
  });

  it('код 2FA — ровно 6 цифр', () => {
    expect(isOtpComplete('123456')).toBe(true);
    expect(isOtpComplete('12345')).toBe(false);
    expect(isOtpComplete('12345a')).toBe(false);
  });

  it('email вида name@example.com', () => {
    expect(isEmailShape(' anna@example.com ')).toBe(true);
    expect(isEmailShape('anna@example')).toBe(false);
    expect(isEmailShape('anna example.com')).toBe(false);
  });
});

describe('секрет и QR-код', () => {
  it('секрет группами по 4', () => {
    expect(groupSecret('JK3MQ7XPL2VD6WRA')).toBe('JK3M Q7XP L2VD 6WRA');
    expect(groupSecret('ABCDEF')).toBe('ABCD EF');
  });

  it('SVG без xmlns и viewBox (как отдает сервер) становится картинкой data:', () => {
    const svg = '<svg width="148" height="148" class="segno"><path d="M2 2h1"/></svg>';
    const uri = svgDataUri(svg);
    expect(uri.startsWith('data:image/svg+xml;utf8,')).toBe(true);
    const text = decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length));
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('viewBox="0 0 148 148"');
    expect(text).toContain('<path d="M2 2h1"/>');
    expect(svgSize(svg)).toBe(148);
  });

  it('готовый SVG не меняется, а разметка кодируется целиком', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>#&"</text></svg>';
    const uri = svgDataUri(svg);
    expect(uri).not.toMatch(/[<>"#]/);
    expect(decodeURIComponent(uri.slice('data:image/svg+xml;utf8,'.length))).toBe(svg);
  });
});
