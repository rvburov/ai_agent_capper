import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import ru from '../../i18n/locales/ru.json';
import { ciDec3, ciPct, ciPct1, ciPp, noisy, oddsRange, periodContext, periodStart, prevContext, trendOf } from './display';
import {
  EMPTY_FILTERS,
  exportHref,
  filtersFromSearch,
  filtersQuery,
  isDefault,
  outcomeValue,
  parseOutcome,
  sameOutcome,
  searchWithFilters,
  withoutSlices,
} from './filters';
import { formatPercentNumber, formatPercentRange } from '../../lib/format';
import { countText, filterLabel, insightTexts } from './insights';
import { insightWith, seriesOut } from './testData';

const t = i18n.t.bind(i18n);

describe('Аналитика: фильтры в адресе', () => {
  it('разбирает адрес: период, даты, исход, покрытие, источник; мусор не берет', () => {
    const f = filtersFromSearch(new URLSearchParams('period=30d&market=HCP_-1.5&selection=2&surface=clay&source=legacy&x=1'));
    expect(f).toEqual({ ...EMPTY_FILTERS, period: '30d', market: 'HCP_-1.5', selection: 2, surface: 'clay', source: 'legacy' });
    // сторона без рынка, неизвестные значения и 7 дней (их нет у «Аналитики») — не берутся
    expect(filtersFromSearch(new URLSearchParams('period=7d&selection=1&surface=sand&source=bot'))).toEqual(EMPTY_FILTERS);
    // даты: неверные — нет, перепутанные концы — местами
    expect(filtersFromSearch(new URLSearchParams('from=2026-10-05&to=2026-10-01'))).toMatchObject({ from: '2026-10-01', to: '2026-10-05' });
    expect(filtersFromSearch(new URLSearchParams('from=2026-02-30&to=1999-01-01'))).toMatchObject({ from: null, to: null });
  });

  it('пишет в адрес только не значения по умолчанию и сохраняет чужие параметры', () => {
    const f = { ...EMPTY_FILTERS, period: '90d' as const, market: 'ML' as const, selection: 1 as const, surface: 'hard' as const };
    const params = searchWithFilters(f, new URLSearchParams('tab=x&period=30d'));
    expect(params.toString()).toBe('tab=x&period=90d&market=ML&selection=1&surface=hard');
    expect(filtersFromSearch(params)).toEqual(f);
    expect(searchWithFilters(EMPTY_FILTERS).toString()).toBe('');
  });

  it('запрос API: даты важнее периода, покрытие — списком, сторона — только с рынком', () => {
    expect(filtersQuery(EMPTY_FILTERS)).toEqual({});
    expect(filtersQuery({ ...EMPTY_FILTERS, period: '30d', from: '2026-10-01', to: '2026-10-05' })).toEqual({ from: '2026-10-01', to: '2026-10-05' });
    expect(filtersQuery({ ...EMPTY_FILTERS, period: '30d', market: 'ML', selection: 2, surface: 'grass', source: 'app' })).toEqual({
      period: '30d',
      market: 'ML',
      selection: 2,
      surface: ['grass'],
      source: 'app',
    });
  });

  it('вид ставки (Р29): из адреса, в адрес и в запрос; «все» не пишется; снимается с остальными', () => {
    const f = filtersFromSearch(new URLSearchParams('kind=single'));
    expect(f).toEqual({ ...EMPTY_FILTERS, kind: 'single' });
    expect(filtersFromSearch(new URLSearchParams('kind=all'))).toEqual(EMPTY_FILTERS);
    expect(filtersFromSearch(new URLSearchParams('kind=legacy'))).toEqual(EMPTY_FILTERS);
    expect(searchWithFilters(f).toString()).toBe('kind=single');
    expect(filtersQuery(f)).toEqual({ kind: 'single' });
    expect(isDefault(f)).toBe(false);
    expect(withoutSlices({ ...f, period: '30d' })).toEqual({ ...EMPTY_FILTERS, period: '30d' });
  });

  it('сброс, «снять фильтры» и исход в выпадающем списке', () => {
    expect(isDefault(EMPTY_FILTERS)).toBe(true);
    expect(isDefault({ ...EMPTY_FILTERS, from: '2026-10-01' })).toBe(false);
    const f = { ...EMPTY_FILTERS, period: '30d' as const, market: 'ML' as const, selection: 1 as const, surface: 'clay' as const, source: 'app' as const };
    expect(withoutSlices(f)).toEqual({ ...EMPTY_FILTERS, period: '30d' });
    expect(outcomeValue('HCP_+1.5', 2)).toBe('HCP_+1.5:2');
    expect(outcomeValue('ML', null)).toBe('ML');
    expect(outcomeValue(null, null)).toBe('all');
    expect(parseOutcome('HCP_-1.5:1')).toEqual({ market: 'HCP_-1.5', selection: 1 });
    expect(parseOutcome('all')).toEqual({ market: null, selection: null });
    expect(sameOutcome({ ...EMPTY_FILTERS, market: 'ML', selection: null }, 'ML', 2)).toBe(true);
    expect(sameOutcome({ ...EMPTY_FILTERS, market: 'ML', selection: 1 }, 'ML', 2)).toBe(false);
  });

  it('выгрузка: одна часть — CSV, несколько — ZIP, ничего — нет ссылки; те же фильтры', () => {
    const f = { ...EMPTY_FILTERS, period: '30d' as const, surface: 'clay' as const };
    expect(exportHref(f, ['bets'])).toBe('/api/analytics/export.csv?period=30d&surface=clay&part=bets');
    expect(exportHref(f, ['bets', 'events', 'calibration', 'brier'])).toBe(
      '/api/analytics/export.zip?period=30d&surface=clay&part=bets&part=events&part=calibration&part=brier',
    );
    expect(exportHref(f, [])).toBeNull();
  });
});

describe('Аналитика: вид чисел', () => {
  it('интервалы: ROI целыми с одним «%», CLV с десятыми, разница ROI в п.п., Brier три знака', () => {
    expect(ciPct({ low: -0.08, high: 0.16 })).toBe('−8…+16%');
    expect(ciPct({ low: 0.001, high: 0.004 })).toBe('0…0%');
    expect(ciPct1({ low: 0.004, high: 0.038 })).toBe('+0,4%…+3,8%');
    expect(ciPp({ low: -0.08, high: 0.11 })).toBe('−8…+11 п.п.');
    expect(ciDec3({ low: -0.018, high: 0.006 })).toBe('−0,018…+0,006');
    expect(ciPct(null)).toBe('—');
  });

  it('проценты через format.ts: число процентов без «%» и интервал с «%» один раз', () => {
    expect(formatPercentNumber(0.7)).toBe('70');
    expect(formatPercentNumber(0.02, { signed: true })).toBe('+2');
    expect(formatPercentNumber(-0.01, { signed: true })).toBe('−1');
    expect(formatPercentNumber(0, { signed: true })).toBe('0');
    // сумма с ошибкой округления двоичной дроби — все равно целое
    expect(formatPercentNumber(0.07, { signed: true })).toBe('+7');
    expect(formatPercentNumber(null)).toBe('—');
    expect(formatPercentRange(-0.08, 0.16, { signed: true })).toBe('−8…+16%');
    expect(formatPercentRange(0.65, 0.7)).toBe('65…70%');
    expect(formatPercentRange(null, 0.1)).toBe('—');
  });

  it('«в пределах шума» — интервал задевает ноль или его нет', () => {
    expect(noisy({ low: -0.01, high: 0.02 })).toBe(true);
    expect(noisy({ low: 0, high: 0.02 })).toBe(true);
    expect(noisy({ low: 0.001, high: 0.02 })).toBe(false);
    expect(noisy(null)).toBe(true);
  });

  it('стрелка — по показанным знакам: разница меньше 0,05 п.п. — без стрелки', () => {
    expect(trendOf(0.021)).toBe('up');
    expect(trendOf(-0.0006)).toBe('down');
    expect(trendOf(0.0004)).toBe('flat');
    expect(trendOf(null)).toBe('flat');
    expect(trendOf(0.004, 2)).toBe('flat');
  });

  it('диапазоны кэфа и подписи периода', () => {
    expect(oddsRange('1.30', '1.49')).toBe('1.30–1.49');
    expect(oddsRange('2.00', null)).toBe('2.00+');
    expect(oddsRange(null, null)).toBeNull();
    expect(periodContext(t, '30d', '2026-09-14', '2026-10-13')).toBe('за 30 дней');
    expect(periodContext(t, 'all', null, '2026-10-13')).toBe('за все время');
    expect(periodContext(t, null, '2026-10-03', '2026-10-05')).toMatch(/^за 3–5 окт/);
    expect(prevContext(t, '90d')).toBe('к пред. 3 месяцам');
    expect(prevContext(t, 'all')).toBeNull();
    expect(prevContext(t, null)).toBeNull();
  });
});

describe('Аналитика: банк на начало периода', () => {
  it('старт периода — как есть с сервера: день, сумма и изменение долей', () => {
    const start = periodStart(seriesOut());
    expect(start).toMatchObject({ day: '2026-08-31', amount: '48000.00' });
    expect(start.points).toHaveLength(4);
    expect(start.share).toBeCloseTo(2860 / 48000, 6);
    // банк появился внутри периода: сервер присылает первый день банка, вложенное и рост
    const late = seriesOut({ start: '2026-09-13', base: '0.00', start_day: '2026-09-23', start_amount: '20000.00', change_share: 0.015, points: [{ day: '2026-09-23', value: '20350.00', invested: null }, { day: '2026-10-13', value: '20300.00', invested: null }] });
    expect(periodStart(late)).toMatchObject({ day: '2026-09-23', amount: '20000.00', share: 0.015 });
    expect(periodStart(late).points.map((point) => point.day)).toEqual(['2026-09-23', '2026-10-13']);
  });

  it('ряд результата — с нуля, без процента', () => {
    const result = seriesOut({ kind: 'result', base: '0.00', start_amount: '0.00', change_share: null, points: [{ day: '2026-08-31', value: '0.00', invested: null }, { day: '2026-10-13', value: '860.00', invested: null }] });
    expect(periodStart(result)).toMatchObject({ day: '2026-08-31', amount: '0.00', share: null });
  });
});

describe('Аналитика: выводы', () => {
  it('калибровка: диапазон, вероятности и разница в п.п.', () => {
    const insight = insightWith('calibration_over', { low: 0.7, high: 0.75, p: 0.72, actual: 0.62, gap: 0.1 });
    expect(insightTexts(t, insight, 'RUB')).toEqual({
      // диапазон не рвется на две строки: у тире невидимый соединитель U+2060
      title: 'Переоценка фаворитов в диапазоне 70\u2060–\u206075%',
      text: 'Модель давала в среднем 72%, а сыграло 62% — на 10 п.п. меньше. Валуй в этом диапазоне, вероятно, завышен.',
    });
    const ok = insightWith('calibration_ok', { min_n: 8, gap: 0.04 });
    expect(insightTexts(t, ok, 'RUB').text).toBe('Ни в одном диапазоне с 8+ событиями прогноз не расходится с фактом на 4 п.п. и больше — ни вверх, ни вниз.');
  });

  it('итоговый кэф: деньги в валюте программы, доля банка, самый крупный диапазон', () => {
    const params = { low: '1.28', high: '1.70', roi: -0.124, bets: 21, profit: '-1640.00', stake_pct: '0.0275', largest: true };
    const { title, text } = insightTexts(t, insightWith('total_negative', params), 'RUB');
    expect(title).toBe('Экспрессы с итоговым кэфом 1.28\u2060–\u20601.70 в минусе');
    expect(title.replaceAll('\u2060', '')).toBe('Экспрессы с итоговым кэфом 1.28–1.70 в минусе');
    expect(text).toBe('ROI −12,4% на 21 ставке (−1 640 ₽). При этом по таблице стратегии на них идет самая крупная ставка — 2,75% банка.');
    const usd = insightTexts(t, insightWith('total_negative', { ...params, bets: 8, largest: false, profit: '-16.40' }), 'USD');
    expect(usd.text).toBe('ROI −12,4% на 8 ставках (−16,40 $). Ставка по таблице стратегии — 2,75% банка.');
  });

  it('срез на малой выборке: название среза и склонения', () => {
    const surface = insightWith('small_slice', { dimension: 'surface', surface: 'clay', roi: 0.182, n: 12, roi_after_loss: 0.091, pattern_n: 30 });
    expect(insightTexts(t, surface, 'RUB')).toEqual({
      title: 'Покрытие Грунт: ROI +18,2% — пока не закономерность',
      text: 'Выборка мала: 12 событий. Один следующий проигрыш опустит ROI до +9,1%. Чтобы отличить преимущество от везения, нужно хотя бы 30 событий.',
    });
    const market = insightWith('small_slice', { dimension: 'market', market: 'HCP_+1.5', selection: 2, roi: 0.05, n: 21, roi_after_loss: 0.002, pattern_n: 30 });
    expect(insightTexts(t, market, 'RUB').title).toBe('Рынок Ф2(+1.5): ROI +5,0% — пока не закономерность');
    expect(filterLabel(t, { surface: 'clay' })).toBe('Грунт');
    expect(filterLabel(t, { market: 'ML', selection: 2 })).toBe('П2');
    expect(filterLabel(t, { market: 'ML' })).toBe('Победа в матче (П1 и П2)');
  });

  it('Brier против рынка: интервал разницы и CLV, если он есть', () => {
    const params = { model: 0.214, market: 0.22, ci_low: -0.018, ci_high: 0.006, clv: 0.021, clv_positive: 24, clv_n: 34 };
    expect(insightTexts(t, insightWith('brier_noise', params), 'RUB')).toEqual({
      title: 'Модель на уровне рынка',
      text: 'Brier 0,214 против 0,220 у рынка при прогнозе, 95% ДИ разницы −0,018…+0,006 — в пределах шума. Надежнее смотреть на CLV: +2,1% в среднем, лучше закрытия в 24 из 34.',
    });
    const noClv = insightTexts(t, insightWith('brier_model_better', { ...params, clv: null, clv_n: 0 }), 'RUB');
    expect(noClv.text).toBe('Brier 0,214 против 0,220 у рынка при прогнозе, 95% ДИ разницы −0,018…+0,006.');
  });

  it('выборка мала: ставки и события со склонениями', () => {
    const sample = insightWith('sample', { bets: 12, events: 21, min_events: 30 });
    expect(insightTexts(t, sample, 'RUB').text).toBe(
      'Под фильтром 12 ставок и 21 событие. На таком объеме ROI и калибровка почти целиком зависят от везения — опирайтесь на них не раньше 30 событий.',
    );
    expect(countText(t, 'bets', 3)).toBe('3 ставки');
    expect(countText(t, 'events', 25)).toBe('25 событий');
  });
});

// Тексты выводов: ключи и числа приходят с сервера, тексты — во фронтенде (как у анализа)
const backend = import.meta.glob<Record<string, unknown>>('../../../../backend/app/locales/ru.json', { eager: true, import: 'default' });

describe('Аналитика: тексты выводов сервера', () => {
  it('тексты выводов — копия сервера ({x} → {{x}}) без отличий', () => {
    const files = Object.values(backend);
    expect(files).toHaveLength(1);
    const server = (files[0] as { analytics: { insights: Record<string, Record<string, string>> } }).analytics.insights;
    const client = ru.analytics.insights as unknown as Record<string, Record<string, string>>;
    expect(Object.keys(server).length).toBe(9);
    for (const [code, texts] of Object.entries(server)) {
      for (const part of ['title', 'text'] as const) {
        const copy = (texts[part] ?? '').replace(/\{(\w+)\}/g, '{{$1}}');
        expect(client[code]?.[part], `${code}.${part}`).toBe(copy);
      }
    }
  });
});
