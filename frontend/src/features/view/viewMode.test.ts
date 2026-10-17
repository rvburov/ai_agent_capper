import { describe, expect, it } from 'vitest';

import { asUserQuery, isViewablePath, parseViewParam, switchTarget, viewKey, viewTo, withViewSearch } from './viewMode';

describe('режим просмотра данных участника (Р27): адрес и ключи', () => {
  it('экраны режима: главная, ставки, аналитика, анализы, анализ и «Банк и стратегия»', () => {
    for (const path of ['/', '/bets', '/analytics', '/new', '/analysis/12', '/profile/bank', '/bets/']) {
      expect(isViewablePath(path), path).toBe(true);
    }
    for (const path of ['/players', '/profile', '/profile/data', '/admin/summary', '/learning', '/costs', '/analysis']) {
      expect(isViewablePath(path), path).toBe(false);
    }
  });

  it('?as= — только целое положительное число', () => {
    expect(parseViewParam('?as=7')).toBe(7);
    expect(parseViewParam('?status=open&as=12')).toBe(12);
    for (const bad of ['', '?as=', '?as=0', '?as=-3', '?as=7a', '?as=1.5']) expect(parseViewParam(bad), bad).toBeNull();
  });

  it('адрес с ?as= сохраняет остальные параметры; смена участника — тот же экран без них', () => {
    expect(withViewSearch('?status=open', 7)).toBe('?status=open&as=7');
    expect(withViewSearch('?as=7&status=open', null)).toBe('?status=open');
    expect(viewTo('/bets?period=30d', 3)).toBe('/bets?period=30d&as=3');
    expect(switchTarget('/analysis/12')).toBe('/new');
    expect(switchTarget('/bets')).toBe('/bets');
    expect(switchTarget('/players')).toBe('/');
  });

  it('кэш: чужие данные — под ["view", id], свои — как были; запрос — с as_user только для чужих', () => {
    expect(viewKey(null, ['bank'])).toEqual(['bank']);
    expect(viewKey(7, ['bets', 'one', 5])).toEqual(['view', 7, 'bets', 'one', 5]);
    expect(asUserQuery(null)).toEqual({});
    expect(asUserQuery(7)).toEqual({ as_user: 7 });
  });
});
