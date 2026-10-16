import { describe, expect, it } from 'vitest';

import { freshest } from './api';
import { closingDraft, closingPayload, checkClosing } from './closing';
import { closingBookmaker, isImported, legShown, localDay, monthOf, monthRange, parlayProb } from './display';
import {
  anyActive,
  EMPTY_FILTERS,
  exportHref,
  filtersFromSearch,
  filtersQuery,
  searchWithFilters,
  sheetActiveCount,
} from './filters';
import { fromCents, payoutOf, productOdds, sumMoney, toCents } from './money';
import { bankAfter, checkScore, clvPreview, devigPower, scoreKey, settlePreview } from './settle';
import { betLeg, betOpen, betWon } from './testData';

describe('Ставки: фильтры в адресе', () => {
  it('берет из адреса только то, что примет сервер', () => {
    const f = filtersFromSearch(
      new URLSearchParams('period=30d&status=won&market=HCP_-1.5&surface=clay&surface=bogus&surface=hard&source=legacy&q=синнер&bet=7'),
    );
    expect(f).toEqual({
      period: '30d',
      from: null,
      to: null,
      status: 'won',
      market: 'HCP_-1.5',
      surfaces: ['hard', 'clay'],
      source: 'legacy',
      q: 'синнер',
    });
    expect(filtersFromSearch(new URLSearchParams('period=1y&status=all&market=X&source=bot'))).toEqual(EMPTY_FILTERS);
  });

  it('даты: только 2000–2100 и настоящие дни, конец раньше начала — меняются местами', () => {
    expect(filtersFromSearch(new URLSearchParams('from=2026-10-05&to=2026-10-01'))).toMatchObject({ from: '2026-10-01', to: '2026-10-05' });
    expect(filtersFromSearch(new URLSearchParams('from=1999-12-31&to=2026-02-30'))).toMatchObject({ from: null, to: null });
  });

  it('в адрес — без значений по умолчанию, прочие параметры остаются', () => {
    const params = searchWithFilters(
      { ...EMPTY_FILTERS, period: '7d', surfaces: ['grass', 'hard'], q: '  руне ' },
      new URLSearchParams('bet=5&status=won'),
    );
    expect(params.toString()).toBe('bet=5&period=7d&surface=hard&surface=grass&q=%D1%80%D1%83%D0%BD%D0%B5');
  });

  it('для API: свой диапазон дат важнее периода, пустое не передается', () => {
    expect(filtersQuery(EMPTY_FILTERS)).toEqual({});
    expect(filtersQuery({ ...EMPTY_FILTERS, period: '30d', from: '2026-10-01', to: null, q: ' №12 ' })).toEqual({ from: '2026-10-01', q: '№12' });
    expect(filtersQuery({ ...EMPTY_FILTERS, period: '90d', surfaces: ['unknown', 'clay'], market: 'ML' })).toEqual({
      period: '90d',
      market: 'ML',
      surface: ['clay', 'unknown'],
    });
  });

  it('счетчик фильтров шторки и «выбран хоть один»', () => {
    expect(sheetActiveCount({ ...EMPTY_FILTERS, status: 'open', surfaces: ['hard', 'clay'] })).toBe(3);
    expect(anyActive(EMPTY_FILTERS)).toBe(false);
    expect(anyActive({ ...EMPTY_FILTERS, q: ' ' })).toBe(false);
    expect(anyActive({ ...EMPTY_FILTERS, period: '7d' })).toBe(true);
  });

  it('CSV — по тем же фильтрам', () => {
    expect(exportHref(EMPTY_FILTERS)).toBe('/api/bets/export.csv');
    expect(exportHref({ ...EMPTY_FILTERS, status: 'lost', surfaces: ['hard', 'clay'] })).toBe(
      '/api/bets/export.csv?status=lost&surface=hard&surface=clay',
    );
  });
});

describe('Ставки: деньги без ошибок float', () => {
  it('копейки целыми', () => {
    expect(toCents('1234.5')).toBe(123450n);
    expect(toCents('-0.01')).toBe(-1n);
    expect(fromCents(-123450n)).toBe('-1234.50');
    expect(sumMoney(['0.10', '0.20', null])).toBe('0.30');
  });

  it('выплата — сумма × кэф до копеек, половина вверх', () => {
    expect(payoutOf('1320.00', '1.885')).toBe('2488.20');
    expect(payoutOf('33.33', '1.500')).toBe('50.00');
    expect(payoutOf('100.01', '1.005')).toBe('100.51');
  });

  it('кэф расчета — произведение до 0.001, половина вверх', () => {
    expect(productOdds(['1.150', '1.650'])).toBe('1.898');
    expect(productOdds(['1.450'])).toBe('1.450');
  });
});

describe('Ставки: окно результата', () => {
  const bet = betOpen();

  it('проигрыш виден сразу, даже если отмечены не все события', () => {
    expect(settlePreview(bet, ['loss', null])).toEqual({ status: 'lost', payout: '0.00', profit: '-1320.00', recalculated: null });
    expect(settlePreview(bet, ['win', null])).toBeNull();
  });

  it('все возвраты — возврат суммы; без возвратов — итоговый кэф ставки', () => {
    expect(settlePreview(bet, ['void', 'void'])).toEqual({ status: 'void', payout: '1320.00', profit: '0.00', recalculated: null });
    expect(settlePreview(bet, ['win', 'win'])).toEqual({ status: 'won', payout: '2488.20', profit: '1168.20', recalculated: null });
  });

  it('возврат ноги — кэф 1.00, кэф пересчитан', () => {
    expect(settlePreview(bet, ['win', 'void'])).toEqual({ status: 'won', payout: '1716.00', profit: '396.00', recalculated: '1.300' });
  });

  it('банк после — капитал плюс прибыль', () => {
    expect(bankAfter('48000.00', '-1320.00')).toBe('46680.00');
  });

  it('счет: как у сервера («2:1», «2-1», «21»), исход — по таблице score_outcomes', () => {
    const outcomes = betLeg().score_outcomes;
    expect(scoreKey(' 2-1 ')).toBe('2:1');
    expect(scoreKey('21')).toBe('2:1');
    expect(scoreKey('2:1:0')).toBeNull();
    expect(checkScore('2:1', outcomes)).toEqual({ kind: 'ok', key: '2:1', result: 'win' });
    expect(checkScore('0 2', outcomes)).toEqual({ kind: 'ok', key: '0:2', result: 'loss' });
    expect(checkScore('3:0', outcomes)).toEqual({ kind: 'invalid' });
    expect(checkScore('2', outcomes)).toEqual({ kind: 'typing' });
    expect(checkScore('  ', outcomes)).toEqual({ kind: 'empty' });
    expect(checkScore('2:0', null)).toEqual({ kind: 'invalid' });
  });

  it('вероятность без маржи — степенной метод, как devig_pair сервера', () => {
    // эталон: backend/app/ml/market.py, devig_pair
    expect(devigPower(1.25, 4.2)).toBeCloseTo(0.7865325781357353, 12);
    expect(devigPower(1.8, 2.05)).toBeCloseTo(0.534586227432871, 12);
    expect(devigPower(1.9, 1.9)).toBeCloseTo(0.5, 12);
  });

  it('CLV на лету: кэф ÷ закрытие − 1; без маржи — только при двух сторонах', () => {
    const one = clvPreview(1.3, 1.25, null);
    expect(one.clv).toBeCloseTo(0.04, 12);
    expect(one.fair).toBeNull();
    expect(clvPreview(1.3, 1.25, 4.2).fair).toBeCloseTo(1.3 * 0.7865325781357353 - 1, 12);
  });
});

describe('Ставки: закрывающий кэф', () => {
  it('поля из закрытия ставки', () => {
    expect(closingDraft(null)).toEqual({ by: 'pinnacle', bookmaker: null, own: '', opp: '' });
    expect(closingDraft(betWon().legs[0]?.closing ?? null)).toEqual({ by: 'pinnacle', bookmaker: null, own: '1.25', opp: '4.20' });
  });

  it('разбор: свой кэф обязателен, обратный — по желанию, 1.01–50', () => {
    expect(checkClosing({ by: 'avg', bookmaker: null, own: '1,8', opp: '' })).toMatchObject({ kind: 'ok', own: 1.8, opp: null, value: { odds: '1.8', opp_odds: null, by: 'avg', bookmaker: null } });
    expect(checkClosing({ by: 'pinnacle', bookmaker: null, own: '1.0', opp: '' })).toEqual({ kind: 'invalid', field: 'own', typing: false });
    expect(checkClosing({ by: 'pinnacle', bookmaker: null, own: '1.', opp: '' })).toEqual({ kind: 'invalid', field: 'own', typing: true });
    expect(checkClosing({ by: 'pinnacle', bookmaker: null, own: '1.8', opp: '99' })).toEqual({ kind: 'invalid', field: 'opp', typing: true });
    expect(checkClosing({ by: 'pinnacle', bookmaker: null, own: '', opp: '2.1' })).toEqual({ kind: 'invalid', field: 'own', typing: false });
  });

  it('что отправить: без изменений — поле не передается, стерли — null', () => {
    const closing = betWon().legs[0]?.closing ?? null;
    expect(closingPayload(closingDraft(closing), closing)).toBeUndefined();
    expect(closingPayload({ ...closingDraft(closing), own: '' , opp: '' }, closing)).toBeNull();
    expect(closingPayload({ ...closingDraft(closing), opp: '' }, closing)).toEqual({ odds: '1.25', opp_odds: null, by: 'pinnacle', bookmaker: null });
    expect(closingPayload(closingDraft(null), null)).toBeUndefined();
    expect(closingPayload({ by: 'bookmaker', bookmaker: null, own: '1.7777', opp: '' }, null)).toEqual({ odds: '1.778', opp_odds: null, by: 'bookmaker', bookmaker: null });
    expect(closingPayload({ by: 'pinnacle', bookmaker: null, own: 'abc', opp: '' }, null)).toBe('invalid');
  });
});

describe('Ставки: вид', () => {
  it('исход ноги: возврат всей ставки, еще не сыграно, бот не записал', () => {
    expect(legShown({ status: 'void' }, { result: 'win' })).toBe('void');
    expect(legShown({ status: 'open' }, { result: null })).toBe('open');
    expect(legShown({ status: 'lost' }, { result: null })).toBe('unknown');
    expect(legShown({ status: 'lost', source: 'legacy' }, { result: null })).toBe('unknown');
    // проигранный экспресс приложения рассчитан по архиву без исхода ноги со снятием
    expect(legShown({ status: 'lost', source: 'app' }, { result: null })).toBe('none');
    expect(legShown({ status: 'won' }, { result: 'win' })).toBe('win');
  });

  it('шанс экспресса по модели — произведение; у ноги без вероятности — нет', () => {
    expect(parlayProb(betOpen().legs)).toBeCloseTo(0.81 * 0.74, 12);
    expect(parlayProb([{ p_final: null, p_claude: 0.7 }])).toBeCloseTo(0.7, 12);
    expect(parlayProb([{ p_final: null, p_claude: null }])).toBeNull();
  });

  it('чей закрывающий кэф: свой букмекер — названный или букмекер ставки', () => {
    expect(closingBookmaker({ by: 'bookmaker', bookmaker: null }, 'Fonbet')).toBe('Fonbet');
    expect(closingBookmaker({ by: 'bookmaker', bookmaker: 'Winline' }, 'Fonbet')).toBe('Winline');
    expect(closingBookmaker({ by: 'pinnacle', bookmaker: null }, 'Fonbet')).toBeNull();
  });

  it('исправить нельзя только результат, перенесенный импортом бота', () => {
    expect(isImported({ source: 'legacy', status: 'won', settled_by: 'legacy' })).toBe(true);
    expect(isImported({ source: 'legacy', status: 'won', settled_by: 'manual' })).toBe(false);
    expect(isImported({ source: 'legacy', status: 'open', settled_by: null })).toBe(false);
    expect(isImported({ source: 'app', status: 'lost', settled_by: 'manual' })).toBe(false);
  });

  it('версия ставки для расчета — более свежая из кэша и списка', () => {
    const older = betOpen({ updated_at: '2026-10-13T08:30:00.123456Z' });
    const newer = betOpen({ updated_at: '2026-10-13T09:00:00Z' });
    expect(freshest(older, newer)).toBe(newer);
    expect(freshest(newer, older)).toBe(newer);
    expect(freshest(undefined, older)).toBe(older);
    expect(freshest(betWon(), older)).toBe(older);
  });

  it('месяц ставки — в поясе участника', () => {
    expect(localDay('2026-09-30T22:30:00Z', 'Europe/Helsinki')).toBe('2026-10-01');
    expect(monthOf('2026-09-30T22:30:00Z', 'Europe/Helsinki')).toBe('2026-10');
    expect(monthOf('2026-09-30T22:30:00Z', 'America/New_York')).toBe('2026-09');
  });

  it('даты итогов месяца — в пределах периода и своего диапазона', () => {
    const today = '2026-10-13';
    expect(monthRange('2026-10', { period: 'all', from: null, to: null }, today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(monthRange('2026-10', { period: '7d', from: null, to: null }, today)).toEqual({ from: '2026-10-07', to: '2026-10-31' });
    expect(monthRange('2026-09', { period: '30d', from: null, to: null }, today)).toEqual({ from: '2026-09-14', to: '2026-09-30' });
    expect(monthRange('2026-09', { period: '7d', from: null, to: null }, today)).toBeNull();
    expect(monthRange('2026-02', { period: '7d', from: '2026-02-10', to: '2026-02-12' }, today)).toEqual({ from: '2026-02-10', to: '2026-02-12' });
  });
});
