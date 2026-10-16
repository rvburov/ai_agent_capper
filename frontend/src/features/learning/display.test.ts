import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { formatNumber } from '../../lib/format';
import { baseText, casesText, conditionText, filterCounts, historyReason, plural, quickState, quickView, reasonKey, scopeValueText, sortLessons } from './display';
import { lesson, lessonQuick, readyLesson } from './testData';

const t = i18n.t.bind(i18n);

describe('уроки: фильтр и счетчики', () => {
  it('«Отклонены» — и отклоненные, и списанные', () => {
    const items = [
      lesson({ status: 'hypothesis' }),
      readyLesson(),
      readyLesson({ status: 'confirmed', in_prompt: true }),
      lesson({ status: 'rejected' }),
      lesson({ status: 'retired' }),
    ];
    expect(filterCounts(items)).toEqual({ all: 5, confirmed: 1, ready: 1, hypothesis: 1, off: 2 });
  });
});

describe('уроки: порядок и числа словами', () => {
  it('порядок макета: ждут решения, подтвержденные, гипотезы, отклоненные, списанные; внутри — порядок сервера', () => {
    const items = [
      lesson({ id: 1, status: 'hypothesis' }),
      lesson({ id: 2, status: 'retired' }),
      lesson({ id: 3, status: 'confirmed' }),
      readyLesson({ id: 4 }),
      lesson({ id: 5, status: 'hypothesis' }),
      lesson({ id: 6, status: 'rejected' }),
    ];
    expect(sortLessons(items).map((item) => item.id)).toEqual([4, 3, 1, 5, 6, 2]);
  });

  it('склонение с числом: 1 матч, 34 матча, на 21 матче, с 20 своих случаев', () => {
    expect(plural(t, 'matches', 1)).toBe('1 матч');
    expect(plural(t, 'matches', 34)).toBe('34 матча');
    expect(plural(t, 'matches', 40)).toBe('40 матчей');
    expect(plural(t, 'onMatches', 21)).toBe('21 матче');
    expect(plural(t, 'onMatches', 1860)).toBe(`${formatNumber(1860)} матчах`);
    expect(plural(t, 'fromCases', 21)).toBe('21 своего случая');
    expect(plural(t, 'fromCases', 20)).toBe('20 своих случаев');
    expect(plural(t, 'onCases', 10)).toBe('10 случаях');
  });
});

describe('условие из словаря словами', () => {
  it('перечень, число, кэф и рынок', () => {
    expect(conditionText({ feature: 'surface', op: 'in', values: ['hard', 'clay'] }, t)).toBe('покрытие: хард, грунт');
    expect(conditionText({ feature: 'elo_gap', op: 'lt', value: 120 }, t)).toBe('разница Эло меньше 120');
    expect(conditionText({ feature: 'odds', op: 'ge', value: 2.6 }, t)).toBe('кэф на победу не меньше 2.60');
    expect(conditionText({ feature: 'market', op: 'eq', values: ['HCP_-1.5'] }, t)).toBe('рынок: фора −1.5');
    // незнакомое значение — как есть
    expect(scopeValueText('round', 'Q1', t)).toBe('Q1');
  });

  it('коды с сервера — ключи локали; неизвестная причина — null', () => {
    expect(reasonKey('lesson.quick_check_budget')).toBe('lesson_quick_check_budget');
    expect(historyReason('holdout')).toBe('holdout');
    expect(historyReason('other')).toBeNull();
  });
});

describe('окно быстрой проверки: что показать', () => {
  it('нет проверки, идет, не удалась', () => {
    expect(quickView(readyLesson())).toBe('intro');
    expect(quickView(readyLesson({ quick: lessonQuick({ status: 'pending' }) }))).toBe('running');
    expect(quickView(readyLesson({ quick: lessonQuick({ status: 'running' }) }))).toBe('running');
    expect(quickView(readyLesson({ quick: lessonQuick({ status: 'failed', passed: null }) }))).toBe('failed');
  });

  it('«не хуже» — только свежее проверки на истории', () => {
    expect(quickView(readyLesson({ quick: lessonQuick({ finished_at: '2026-10-14T10:12:00Z' }) }))).toBe('passed');
    // проверку на истории повторили позже — нужна новая быстрая проверка
    expect(quickView(readyLesson({ validated_at: '2026-10-15T06:33:00Z', quick: lessonQuick({ finished_at: '2026-10-14T10:12:00Z' }) }))).toBe('intro');
  });

  it('хуже — по числам сервера; сброшенная выключением урока — снова запуск', () => {
    const worse = lessonQuick({ passed: false, diff: { value: 0.02, low: 0.008, high: 0.034, n: 40 } });
    expect(quickView(readyLesson({ quick: worse }))).toBe('worse');
    expect(quickView(readyLesson({ quick: lessonQuick({ passed: false, format_errors: 2 }) }))).toBe('worse');
    // выключение урока ставит passed = false при числах «не хуже»
    expect(quickView(readyLesson({ status: 'confirmed', quick: lessonQuick({ passed: false }) }))).toBe('intro');
  });

  it('«Подробнее»: прошла, но выключали или перепроверили позже — нужна новая', () => {
    expect(quickState(readyLesson({ status: 'confirmed', quick: lessonQuick({ passed: false }) }))).toBe('reset');
    expect(quickState(readyLesson({ validated_at: '2026-10-15T06:33:00Z', quick: lessonQuick({ finished_at: '2026-10-14T10:12:00Z' }) }))).toBe('stale');
    expect(quickState(readyLesson({ quick: lessonQuick({ passed: false, format_errors: 1 }) }))).toBe('worse');
    expect(quickState(readyLesson())).toBe('none');
  });
});

describe('случаи урока у участника: порог показа — с сервера', () => {
  it('меньше порога — «меньше N случаев» (public_cases_min), иначе число и свои', () => {
    expect(casesText({ n_cases: null }, t)).toBe('меньше 5 случаев');
    expect(casesText({ n_cases: null }, t, 3)).toBe('меньше 3 случаев');
    expect(baseText({ n_cases: 21, n_hist: 412, own_cases: 2 }, t)).toBe('21 случай + 412 из архива · из них ваших 2');
  });
});
