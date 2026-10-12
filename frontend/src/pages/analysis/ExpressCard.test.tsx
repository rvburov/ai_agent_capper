import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { loseRate } from './ExpressCard';

describe('предупреждение под экспрессом', () => {
  it('доля проигрышей: десятыми, а реже 1 из 10 — 1 из 20, 1 из 100', () => {
    expect(loseRate(0.89496)).toEqual({ count: 1, of: 10 });
    expect(loseRate(0.5)).toEqual({ count: 5, of: 10 });
    expect(loseRate(0.25)).toEqual({ count: 8, of: 10 });
    expect(loseRate(0.95)).toEqual({ count: 1, of: 20 });
    expect(loseRate(0.99)).toEqual({ count: 1, of: 100 });
    expect(loseRate(0.9999)).toEqual({ count: 1, of: 100 });
  });

  it('склонение: 1 раз, 2 раза, 5 раз', () => {
    const text = (count: number, of = 10) => i18n.t('analysis.express.disclaimer', { p: '50%', count, of });
    expect(text(1)).toContain('проигрывает примерно 1 раз из 10.');
    expect(text(2)).toContain('проигрывает примерно 2 раза из 10.');
    expect(text(5)).toContain('проигрывает примерно 5 раз из 10.');
    expect(text(1, 100)).toContain('проигрывает примерно 1 раз из 100.');
  });
});
