import { afterEach, describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { bankOut, strategyV3 } from '../analysis/testData';
import type { Adaptation } from '../bank/types';
import { actingNowText, adminTodo, bankStateText, readPeriod, ruleRows, savePeriod, topKind, usdLimit } from './display';
import { adminAttention, ADAPTATIONS, aiUsageOut } from './testData';

const t = i18n.t.bind(i18n);

function rules(change: Partial<Record<Adaptation['key'], Partial<Adaptation>>>): Adaptation[] {
  return ADAPTATIONS.map((rule) => ({ ...rule, ...change[rule.key] }));
}

describe('Главная: «Размер ставки»', () => {
  it('правила в порядке макета со статусом и текстами кабинета', () => {
    const bank = bankOut({ adaptations: ADAPTATIONS });
    const rows = ruleRows(bank, strategyV3().params, t);
    expect(rows.map((r) => [r.key, r.status])).toEqual([
      ['dd10', 'waiting'],
      ['dd20', 'waiting'],
      ['week_loss', 'waiting'],
      ['up15', 'off'],
      ['week_win', 'off'],
    ]);
    expect(rows[0]).toMatchObject({ label: 'Просадка от пика −10%', effect: 'ставка не больше 2,5% банка' });
    expect(rows[1]?.effect).toMatch(/^защитный режим: 1,5% банка, только 2 события с кэфами до 1\.50$/);
    expect(rows[3]).toMatchObject({ label: 'Банк +15% к вложенному и винрейт от 60%' });
    expect(rows[4]).toMatchObject({ label: 'Итог 7 дней +10% и лучше', effect: 'ставка +0,5 п.п.' });
  });

  it('просадка −22%: действует и −20%, и −10%; выключенный рост — «сработало бы» по met сервера', () => {
    const bank = bankOut({
      drawdown: '0.2200',
      week_change: '0.1200',
      adaptations: rules({ dd10: { met: true }, dd20: { active: true, met: true }, week_win: { met: true } }),
    });
    const rows = ruleRows(bank, null, t);
    expect(rows.find((r) => r.key === 'dd10')?.status).toBe('acting');
    expect(rows.find((r) => r.key === 'dd20')?.status).toBe('acting');
    // без параметров стратегии — простая запись действия
    expect(rows.find((r) => r.key === 'dd20')?.effect).toBe('ставка не больше 1,5% банка');
    expect(rows.find((r) => r.key === 'week_win')).toMatchObject({ status: 'off', met: true });
    expect(rows.find((r) => r.key === 'up15')).toMatchObject({ status: 'off', met: false });
  });

  it('met — с сервера, браузер не пересчитывает его по числам банка', () => {
    const bank = bankOut({ week_change: '0.1200', adaptations: rules({}) });
    expect(ruleRows(bank, null, t).find((r) => r.key === 'week_win')?.met).toBe(false);
  });

  it('состояние банка одной строкой: от пика, неделя, к вложенному, винрейт', () => {
    expect(bankStateText(bankOut({ drawdown: '0.0320', week_change: '0.0100', growth: '0.2460', winrate: '0.6120' }), t)).toBe(
      'Банк −3,2% от пика, за 7 дней +1,0%, к вложенному +24,6%, винрейт 61,2%',
    );
    expect(bankStateText(bankOut(), t)).toBe('Банк на пике');
  });

  it('банка еще нет — не «на пике», а «банка еще нет»', () => {
    expect(bankStateText(bankOut({ empty: true, equity: '0.00', peak: '0.00', drawdown: '0' }), t)).toMatch(/^Банка еще нет: суммы ставок посчитаются/);
  });

  it('«Сейчас …»: точка сокращения («п.п.») закрывает предложение, второй нет', () => {
    const bank = bankOut({ drawdown: '0.1200', week_change: '0.1200', adaptations: rules({ dd10: { active: true, met: true }, week_win: { enabled: true, active: true, met: true } }) });
    const rows = ruleRows(bank, null, t);
    const dd = rows.filter((r) => r.key === 'dd10');
    const win = rows.filter((r) => r.key === 'week_win');
    expect(actingNowText(dd, t)).toBe('Сейчас ставка не больше 2,5% банка.');
    expect(actingNowText(win, t)).toBe('Сейчас ставка +0,5 п.п.');
    expect(actingNowText([...dd, ...win], t)).toBe('Сейчас ставка не больше 2,5% банка; ставка +0,5 п.п.');
  });
});

describe('Главная: дела администратора и расход', () => {
  it('просьбы ключа и участники у лимита — только расход на ИИ', () => {
    expect(adminTodo(adminAttention(), t)).toEqual([
      'Олег просит вернуть ключ администратора.',
      'Анна — уже 85% месячного лимита ($8,50 из $10).',
    ]);
    expect(adminTodo(adminAttention({ return_requests: [], limits: [] }), t)).toEqual([]);
  });

  it('«Дороже всего»: первая задача сервера и ее доля с сервера; без расхода или доли — нет', () => {
    expect(topKind(aiUsageOut())).toEqual({ kind: 'analysis', share: 1.43 / 1.93 });
    expect(topKind(aiUsageOut({ kinds: [] }))).toBeNull();
    const [top] = aiUsageOut().kinds;
    expect(topKind(aiUsageOut({ kinds: [{ ...top!, cost_usd: 0, share: 0 }] }))).toBeNull();
    expect(topKind(aiUsageOut({ kinds: [{ ...top!, share: null }] }))).toBeNull();
  });

  it('запись лимита', () => {
    expect(usdLimit(10)).toBe('$10');
    expect(usdLimit(1.5)).toBe('$1,50');
  });
});

describe('Главная: период помнится до конца сеанса вкладки', () => {
  afterEach(() => window.sessionStorage.clear());

  it('по умолчанию 30 дней, выбранный — из sessionStorage, мусор — по умолчанию', () => {
    expect(readPeriod()).toBe('30d');
    savePeriod('7d');
    expect(readPeriod()).toBe('7d');
    window.sessionStorage.setItem('capper.dash.period', 'year');
    expect(readPeriod()).toBe('30d');
  });
});
