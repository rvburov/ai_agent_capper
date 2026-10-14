import { describe, expect, it } from 'vitest';

import { formatShare } from './format';

describe('formatShare: доля бюджета и лимита — один формат', () => {
  it('до 10% — с десятыми, от 10% — целыми', () => {
    expect(formatShare(0.005)).toBe('0,5%');
    expect(formatShare(0.073)).toBe('7,3%');
    expect(formatShare(0.0996)).toBe('10%');
    expect(formatShare(0.6867)).toBe('69%');
    expect(formatShare(1.25)).toBe('125%');
  });

  it('потраченные центы — не «0%»', () => {
    expect(formatShare(0.0001)).toBe('< 0,1%');
    expect(formatShare(0)).toBe('0%');
    expect(formatShare(null)).toBe('—');
  });
});
