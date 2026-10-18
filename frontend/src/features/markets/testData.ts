import type { MarketFamilyOut, Markets } from './types';

/*
 * Ответ GET /api/markets для тестов (Р28): П1/П2 и фора ±1.5 — в экспрессе, новые рынки — для
 * сравнения; у форы по геймам 47 событий из 150, у тотала геймов 160 событий, но модели нет —
 * порог не пройден (ready только у семейств с моделью). CLV и ROI сервер скрывает до 10 значений.
 */

function family(over: Partial<MarketFamilyOut> & Pick<MarketFamilyOut, 'family'>): MarketFamilyOut {
  return {
    status: 'compare',
    suspended_markets: [],
    has_model: true,
    promoted: false,
    events: 0,
    roi: null,
    roi_low: null,
    roi_high: null,
    clv: null,
    clv_low: null,
    clv_high: null,
    clv_n: 0,
    ready: false,
    can_promote: false,
    ...over,
  };
}

export function marketsOut(over: Partial<Markets> = {}): Markets {
  return {
    need: 150,
    need_max: 200,
    clv_need: 50,
    private_min: 10,
    families: [
      family({ family: 'ml', status: 'express', events: 412, roi: 0.031, roi_low: -0.01, roi_high: 0.07, clv: 0.014, clv_low: 0.002, clv_high: 0.026, clv_n: 300 }),
      family({ family: 'h15', status: 'express', events: 238, roi: 0.012, clv: 0.006, clv_n: 120 }),
      family({ family: 'shcp', events: 3 }),
      family({ family: 'stot', events: 21, roi: -0.031, roi_low: -0.38, roi_high: 0.317, clv: 0.004, clv_low: -0.022, clv_high: 0.03, clv_n: 12 }),
      family({ family: 'ghcp', events: 47, has_model: false, roi: 0.042, roi_low: -0.118, roi_high: 0.203, clv: 0.012, clv_low: -0.009, clv_high: 0.033, clv_n: 18 }),
      family({ family: 'gtot', events: 160, has_model: false, clv: 0.02, clv_low: 0.004, clv_high: 0.036, clv_n: 90 }),
    ],
    ...over,
  };
}
