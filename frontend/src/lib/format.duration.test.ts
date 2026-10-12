import { describe, expect, it } from 'vitest';

import { formatDuration, formatEstimate, formatTokens } from './format';

// Пробелы в числах ru-RU — неразрывные; в ожиданиях пишем обычные
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('время и токены анализа', () => {
  it('formatDuration: секунды, минуты, часы', () => {
    expect(formatDuration(0)).toBe('0 с');
    expect(formatDuration(1145)).toBe('1 с');
    expect(formatDuration(59_400)).toBe('59 с');
    expect(formatDuration(83_000)).toBe('1 мин 23 с');
    expect(formatDuration(3_725_000)).toBe('1 ч 2 мин');
    expect(formatDuration(-5)).toBe('0 с');
    expect(formatDuration(null)).toBe('—');
  });

  it('formatEstimate: до минуты — шагом 5 с, дальше — минуты с десятыми', () => {
    expect(formatEstimate(2)).toBe('~5 с');
    expect(formatEstimate(43)).toBe('~45 с');
    expect(formatEstimate(60)).toBe('~1 мин');
    expect(formatEstimate(90)).toBe('~1,5 мин');
    expect(formatEstimate(125)).toBe('~2,1 мин');
    expect(formatEstimate(undefined)).toBe('—');
  });

  it('formatTokens: разряды; compact — тысячи от 10 000', () => {
    expect(plain(formatTokens(2400))).toBe('2 400');
    expect(plain(formatTokens(2400, { compact: true }))).toBe('2 400');
    expect(plain(formatTokens(41_230, { compact: true }))).toBe('41,2 тыс.');
    expect(formatTokens(null)).toBe('—');
  });
});
