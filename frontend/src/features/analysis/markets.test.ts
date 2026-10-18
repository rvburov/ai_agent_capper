import { describe, expect, it } from 'vitest';

import '../../i18n';
import { checkGamesScore, gamesOutcome, parseGamesScore } from '../bets/settle';
import { answerAmbig, blankEvent, checkEvent, extraLine, newExtra, nextExtraFamily, type EditEvent } from './draft';
import { groupTitle, marketDescription, marketGroups } from './outcomes';
import {
  marketCode,
  marketLabel,
  marketSpec,
  oppositeOf,
  outcomeLabel,
} from './markets';
import type { MarketRow } from './types';

const names = { p1: 'Синнер', p2: 'Руне' };

function row(market: string, selection: number, odds: string | null = '1.90'): MarketRow {
  return { market, selection, odds } as unknown as MarketRow;
}

describe('коды рынков (Р28)', () => {
  it('разбор и сборка кода — как market_spec сервера', () => {
    expect(marketSpec('ML')).toEqual({ family: 'ml', line: null });
    expect(marketSpec('HCP_-1.5')).toEqual({ family: 'h15', line: -1.5 });
    expect(marketSpec('HCP_+2.5')).toEqual({ family: 'shcp', line: 2.5 });
    expect(marketSpec('STOT_3.5')).toEqual({ family: 'stot', line: 3.5 });
    expect(marketSpec('GHCP_-3')).toEqual({ family: 'ghcp', line: -3 });
    expect(marketSpec('GTOT_22.5')).toEqual({ family: 'gtot', line: 22.5 });
    for (const bad of ['HCP_1.5', 'HCP_-3.5', 'STOT_3', 'STOT_+2.5', 'GTOT_22.25', 'GTOT_5', 'GHCP_3', 'XX_1']) {
      expect(marketSpec(bad)).toBeNull();
    }
    expect(marketCode('ghcp', -3.5)).toBe('GHCP_-3.5');
    expect(marketCode('ghcp', 4)).toBe('GHCP_+4');
    expect(marketCode('gtot', 22)).toBe('GTOT_22');
    expect(marketCode('stot', 2.5)).toBe('STOT_2.5');
    expect(oppositeOf('GHCP_-3.5', 1)).toEqual({ market: 'GHCP_+3.5', selection: 2 });
    expect(oppositeOf('GTOT_22', 1)).toEqual({ market: 'GTOT_22', selection: 2 });
  });

  it('подписи исходов как в макете', () => {
    expect(outcomeLabel('ML', 1, names)).toBe('Синнер П1');
    expect(outcomeLabel('HCP_+1.5', 2, names)).toBe('Руне Ф2(+1.5)');
    expect(outcomeLabel('HCP_-2.5', 1, names)).toBe('Фора по сетам Синнер −2.5');
    expect(outcomeLabel('GHCP_+4.5', 2, names)).toBe('Фора по геймам Руне +4.5');
    expect(outcomeLabel('GTOT_22.5', 2, names)).toBe('Тотал геймов меньше 22.5');
    expect(outcomeLabel('STOT_2.5', 1, names)).toBe('Тотал сетов больше 2.5');
    expect(marketLabel('GHCP_-3.5', 1)).toBe('Ф1(−3.5) по геймам');
    expect(marketLabel('HCP_-2.5', 1)).toBe('Ф1(−2.5)');
  });

  it('описания исходов: возврат на целой линии, падежи геймов', () => {
    expect(marketDescription('GTOT_22.5', 1, '', 3)).toBe('23 гейма и больше');
    expect(marketDescription('GTOT_22.5', 2, '', 3)).toBe('22 гейма и меньше');
    expect(marketDescription('GTOT_22', 1, '', 3)).toBe('больше 22 геймов, ровно 22 — возврат');
    expect(marketDescription('GHCP_-4.5', 1, 'Синнер', 3)).toBe('Синнер выигрывает с разницей от 5 геймов');
    expect(marketDescription('GHCP_+4.5', 2, 'Руне', 3)).toBe('Руне выигрывает или уступает не больше 4 геймов');
    expect(marketDescription('GHCP_-3', 1, 'Синнер', 3)).toBe('Синнер выигрывает с разницей больше 3 геймов, ровно 3 — возврат');
    expect(marketDescription('STOT_2.5', 2, '', 3)).toBe('два сета: 2:0 или 0:2');
    expect(marketDescription('STOT_3.5', 1, '', 5)).toBe('сетов 4 и больше');
    expect(marketDescription('HCP_-2.5', 1, 'Синнер', 5)).toBe('Синнер выигрывает 3:0');
  });

  it('группы таблицы: победа, ±1.5, новые рынки по семействам; без кэфа — нет строки', () => {
    const rows = [
      row('GTOT_22.5', 1),
      row('GTOT_22.5', 2),
      row('ML', 2),
      row('GHCP_-4.5', 1),
      row('GHCP_+4.5', 2),
      row('HCP_+1.5', 2),
      row('HCP_-1.5', 1),
      row('HCP_-1.5', 2, null),
      row('ML', 1, null),
    ];
    const groups = marketGroups(rows);
    expect(groups.map((g) => g.key)).toEqual(['ml', 'h15', 'ghcp:-4.5', 'gtot:22.5']);
    expect(groups[0]!.rows.map((r) => r.selection)).toEqual([1, 2]);
    expect(groups[1]!.rows.map((r) => `${r.market}/${r.selection}`)).toEqual(['HCP_-1.5/1', 'HCP_+1.5/2']);
    expect(groups.map((g) => groupTitle(g, names))).toEqual([
      'Победа в матче',
      'Фора по сетам ±1.5',
      'Фора по геймам: Синнер −4.5',
      'Тотал геймов 22.5',
    ]);
  });
});

describe('другие рынки в форме', () => {
  function event(over: Partial<EditEvent> = {}): EditEvent {
    return { ...blankEvent(), blank: false, odds: { ml1: '1.34', ml2: '3.35', h1m: '', h1p: '', h2m: '', h2p: '' }, ...over };
  }

  it('проверка линий: фора ±2.5 только до 3 побед, тотал сетов по формату, четвертных нет', () => {
    const three = event({ bestOf: 3, extra: [newExtra('shcp', 3), newExtra('stot', 3, { line: '3.5' }), newExtra('gtot', null, { line: '22.25' })] });
    const kinds = checkEvent(three).issues.map((i) => i.kind);
    expect(kinds).toEqual(expect.arrayContaining(['hcp25', 'setsTotal', 'extraLine']));
    const low = event({ extra: [newExtra('gtot', null, { line: '3.5' })] });
    expect(checkEvent(low).issues.map((i) => i.kind)).toContain('gamesTotalLow');
    const ok = event({ bestOf: 5, extra: [newExtra('shcp', 5, { o1: '3.10' }), newExtra('ghcp', null, { line: '-3', o1: '1.8', o2: 'x' })] });
    const check = checkEvent(ok);
    expect(check.issues.map((i) => i.kind).filter((k) => k !== 'players')).toEqual(['extraOdds']);
    expect(extraLine({ line: '−3,5' })).toBe(-3.5);
  });

  it('«Добавить рынок»: следующий не введенный, фора ±2.5 — только до 3 побед', () => {
    expect(nextExtraFamily({ extra: [], bestOf: 3 })).toBe('stot');
    expect(nextExtraFamily({ extra: [], bestOf: 5 })).toBe('shcp');
    expect(nextExtraFamily({ extra: [newExtra('stot', 3)], bestOf: 3 })).toBe('ghcp');
  });

  it('спорная фора: ответ «по сетам» — в поля ±1.5, «по геймам» — в строку форы по геймам', () => {
    const ambig = { line: -1.5, o1: '2.05', o2: '1.72', hint: { key: 'analysis.draft.hcp_hint.sets', params: { odds: '2.05', ml: '1.34' } }, setsOk: true };
    const ev = event({ ambig: [ambig] });
    expect(checkEvent(ev).issues.map((i) => i.kind)).toContain('ambig');
    const sets = answerAmbig(ev, 0, 'sets');
    expect(sets.ambig).toEqual([]);
    expect(sets.odds.h1m).toBe('2.05');
    expect(sets.odds.h2p).toBe('1.72');
    const games = answerAmbig(ev, 0, 'games');
    expect(games.extra).toHaveLength(1);
    expect(games.extra[0]).toMatchObject({ family: 'ghcp', line: '-1.5', o1: '2.05', o2: '1.72' });
  });
});

describe('счет по геймам', () => {
  it('разбор: тай-брейк, супер-тай-брейк, недоигранный матч', () => {
    const ok = parseGamesScore('6:4 7-6(5)', 3);
    expect(ok).toMatchObject({ kind: 'ok', score: { games: [13, 10], text: '6:4 7:6(5)' } });
    expect(parseGamesScore('6:4 3:6 [10-8]', 3)).toMatchObject({ kind: 'ok', score: { games: [10, 10] } });
    expect(parseGamesScore('6:4 3:2', 3).kind).toBe('unfinished');
    expect(parseGamesScore('6:4 6:3', 5).kind).toBe('unfinished');
    expect(parseGamesScore('6:4 6:3 6:1', 3).kind).toBe('invalid');
    expect(parseGamesScore('6:6', 3).kind).toBe('invalid');
  });

  it('исход: ровно линия — возврат, фора — разница плюс линия', () => {
    const score = { sets: [], games: [13, 10] as [number, number], text: '' };
    expect(gamesOutcome('GTOT_23', 2, score)).toEqual({ result: 'void', value: 23, line: 23 });
    expect(gamesOutcome('GTOT_22.5', 1, score)?.result).toBe('win');
    expect(gamesOutcome('GHCP_-3.5', 1, score)?.result).toBe('loss');
    expect(gamesOutcome('GHCP_+3.5', 2, score)?.result).toBe('win');
    expect(gamesOutcome('GHCP_-3', 1, score)?.result).toBe('void');
    expect(gamesOutcome('ML', 1, score)).toBeNull();
    expect(checkGamesScore('6:4 7:6', 'GTOT_23', 2, 3)).toMatchObject({ kind: 'ok', key: '6:4 7:6', outcome: { result: 'void' } });
    expect(checkGamesScore('6:4 7', 'GTOT_23', 2, 3).kind).toBe('typing');
    expect(checkGamesScore('6:4 7:1', 'GTOT_23', 2, 3).kind).toBe('invalid');
  });
});
