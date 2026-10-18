import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import { formatAmountInput } from '../../lib/format';
import { amountForApi, parseAmount } from './amount';
import { apiErrorText, codeText, keyText } from './codes';
import {
  blankEvent,
  checkEvent,
  eventsFromDraft,
  fromConfirmedEvent,
  fromDraftEvent,
  normalizeOdd,
  oddForApi,
  oddInputText,
  shortName,
  slotName,
  toEventIn,
  validOdd,
} from './draft';
import { formatShare, marketDescription, marketLabel, modelName, ppDelta, shownMarkets, usdSmall } from './markets';
import { analysisNumber } from './number';
import { categoryLabel, roundLabel } from './rounds';
import { moneyRules, payout, shareOf, stakeForShare, stakeProblem, totalOdds } from './stake';
import { analysisDone, analysisDraft, strategyV3 } from './testData';

// Пробелы в числах ru-RU — неразрывные; в ожиданиях пишем обычные
const plain = (text: string) => text.replace(/\s/g, ' ');

describe('сумма из поля ввода', () => {
  it('понимает пробелы, валюту и запятую', () => {
    expect(parseAmount('48 000')).toBe(48000);
    expect(parseAmount('48 000 руб')).toBe(48000);
    expect(parseAmount('477,14')).toBe(477.14);
    expect(parseAmount('$519.48')).toBe(519.48);
    expect(parseAmount('1.234,5')).toBe(1234.5);
    expect(parseAmount('48,000')).toBe(48000);
  });

  it('пусто, ноль и мусор — null', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('руб')).toBeNull();
    expect(parseAmount('0')).toBeNull();
    expect(amountForApi('0')).toBeNull();
    expect(amountForApi('99999999999')).toBeNull();
  });

  it('в API — строка с двумя знаками, в поле — по валюте', () => {
    expect(amountForApi('48 000')).toBe('48000.00');
    expect(amountForApi('477,1')).toBe('477.10');
    expect(plain(formatAmountInput('48000.00', 'RUB'))).toBe('48 000');
    expect(plain(formatAmountInput(477.1, 'EUR'))).toBe('477,10');
    expect(formatAmountInput(null, 'RUB')).toBe('');
  });
});

describe('сумма ставки', () => {
  const rub = moneyRules('RUB', strategyV3().params);
  const usd = moneyRules('USD', strategyV3().params);

  it('правила валюты из стратегии', () => {
    expect(rub).toEqual({ decimals: 0, roundTo: 10, min: 50 });
    expect(usd).toEqual({ decimals: 2, roundTo: 1, min: 0.5 });
    expect(moneyRules('EUR')).toEqual({ decimals: 2, roundTo: 1, min: 0.5 });
  });

  it('итоговый кэф и выплата', () => {
    expect(totalOdds([1.45, 1.3])).toBe(1.885);
    expect(totalOdds([1.47, 1.32])).toBe(1.94);
    expect(payout(1320, 1.885, rub)).toBe(2488);
    expect(payout(13.2, 1.885, usd)).toBe(24.88);
  });

  it('итоговый кэф и выплата — как Decimal с ROUND_HALF_UP на сервере, без ошибок float', () => {
    // 1.15 × 1.65 = 1.8975 → 1.898 (в float 1.89749… → 1.897)
    expect(totalOdds([1.15, 1.65])).toBe(1.898);
    expect(payout(1000, totalOdds([1.15, 1.65]), rub)).toBe(1898);
    expect(totalOdds([1.45, 1.55])).toBe(2.248);
    expect(totalOdds([1.65, 1.35])).toBe(2.228);
    expect(totalOdds([1.2, 1.3, 1.4])).toBe(2.184);
    expect(totalOdds([1.5])).toBe(1.5);
    expect(totalOdds([])).toBe(1);
    // половина копейки — вверх: $1 × 1.885 = 1.885 → $1.89 (в float 188.4999… центов → 1.88)
    expect(payout(1, 1.885, usd)).toBe(1.89);
  });

  it('итоговый кэф совпадает с Decimal на всем коридоре кэфов ног 1.13–1.80', () => {
    // Эталон — точная арифметика в целых: a·b в десятитысячных, половина вверх до тысячных
    for (let a = 113; a <= 180; a += 1) {
      for (let b = 113; b <= 180; b += 1) {
        const exact = Math.floor((a * b * 10 + 50) / 100) / 1000;
        expect(totalOdds([a / 100, b / 100])).toBe(exact);
      }
    }
  });

  it('доля банка вниз до шага округления', () => {
    expect(stakeForShare(48000, 0.0275, rub)).toBe(1320);
    expect(stakeForShare(48123, 0.02, rub)).toBe(960);
    expect(stakeForShare(519.48, 0.02, usd)).toBe(10);
    expect(shareOf(1320, 48000)).toBeCloseTo(0.0275);
    expect(shareOf(100, 0)).toBe(0);
  });

  it('проверки как у сервера', () => {
    expect(stakeProblem(null, 48000, rub)).toBe('empty');
    expect(stakeProblem(0, 48000, rub)).toBe('empty');
    expect(stakeProblem(50000, 48000, rub)).toBe('aboveBank');
    expect(stakeProblem(40, 48000, rub)).toBe('belowMin');
    expect(stakeProblem(1320, 48000, rub)).toBeNull();
  });
});

describe('черновик событий', () => {
  it('из разбора: игроки, турнир, кэфы', () => {
    const [first] = eventsFromDraft(analysisDraft().draft);
    expect(first?.p1).toMatchObject({ status: 'matched', raw: 'Синнер', text: 'Янник Синнер' });
    expect(first?.p2.player?.id).toBe(6);
    expect(first?.tournamentId).toBe(6);
    expect(first?.round).toBe('R16');
    expect(first?.odds).toMatchObject({ ml1: '1.30', ml2: '3.60', h1m: '' });
    expect(checkEvent(first!).issues).toEqual([]);
  });

  it('в API для запуска — только подтвержденные игроки', () => {
    const [event] = eventsFromDraft(analysisDraft().draft);
    const check = { ...event!, p2: { ...event!.p2, status: 'check' as const } };
    expect(toEventIn(check).player2_id).toBe(6);
    expect(toEventIn(check, { forRun: true }).player2_id).toBeNull();
    expect(toEventIn(check, { forRun: true }).odds.ML).toEqual(['1.3', '3.6']);
    expect(toEventIn(check, { forRun: true }).odds['HCP_-1.5']).toEqual([null, null]);
  });

  it('из подтвержденных событий запуска — для «Изменить события»', () => {
    const event = fromConfirmedEvent(analysisDone().events[1]!);
    expect(event.p1).toMatchObject({ status: 'manual', text: 'Новак Джокович' });
    expect(slotName(event.p2, '')).toBe('Андрей Рублев');
    expect(event.tournamentName).toBe('Test Open 5');
    expect(event.odds.ml1).toBe('1.45');
  });

  it('проверка пустого и неверного события', () => {
    const blank = blankEvent();
    expect(checkEvent(blank).issues.map((i) => i.kind)).toEqual(['players', 'ml']);
    const [event] = eventsFromDraft(analysisDraft().draft);
    const bad = { ...event!, odds: { ...event!.odds, ml1: '0,9', h1m: '60' } };
    const result = checkEvent(bad);
    expect(result.issues).toContainEqual({ kind: 'oddsRange', keys: ['ml1', 'h1m'] });
    const same = { ...event!, p2: event!.p1 };
    expect(checkEvent(same).issues).toEqual([{ kind: 'same' }]);
  });

  it('кэфы: запятая, границы, точность', () => {
    expect(validOdd('1,62')).toBe(true);
    expect(validOdd('1.005')).toBe(false);
    expect(validOdd('50.01')).toBe(false);
    expect(validOdd('abc')).toBe(false);
    expect(oddForApi('1,6249')).toBe('1.625');
    expect(normalizeOdd('1,6')).toBe('1.60');
    expect(normalizeOdd(' 0,5 ')).toBe('0,5');
  });

  it('кэф с 3 знаками не округляется до 2: ни из разбора, ни при уходе из поля', () => {
    const [event] = analysisDraft().draft!.events;
    const edit = fromDraftEvent({ ...event!, odds: { ML: ['1.625', '2.375'], 'HCP_-1.5': ['1.833', null], 'HCP_+1.5': [null, null] } });
    expect(edit.odds).toMatchObject({ ml1: '1.625', ml2: '2.375', h1m: '1.833' });
    expect(toEventIn(edit, { forRun: true }).odds.ML).toEqual(['1.625', '2.375']);
    expect(normalizeOdd('1,833')).toBe('1.833');
    expect(normalizeOdd('1.8333')).toBe('1.833');
    expect(normalizeOdd('2.5')).toBe('2.50');
    expect(oddInputText(1.3)).toBe('1.30');
    expect(oddInputText(1.885)).toBe('1.885');
  });

  it('короткое имя — фамилия', () => {
    expect(shortName('Янник Синнер')).toBe('Синнер');
    expect(shortName('Felix Auger Aliassime')).toBe('Auger Aliassime');
    expect(shortName('Синнер')).toBe('Синнер');
    // игроки старого бота: фамилия и инициал — короткое имя по фамилии, а не «Я.»
    expect(shortName('Синнер Я.')).toBe('Синнер');
    expect(shortName('Ауже-Альяссим Ф.')).toBe('Ауже-Альяссим');
    expect(shortName('Я. Синнер')).toBe('Синнер');
  });
});

describe('исходы и подписи', () => {
  it('подписи и описания рынков', () => {
    expect(marketLabel('ML', 1)).toBe('П1');
    expect(marketLabel('HCP_-1.5', 2)).toBe('Ф2(−1.5)');
    expect(marketLabel('HCP_+1.5', 1)).toBe('Ф1(+1.5)');
    expect(marketDescription('HCP_-1.5', 'Синнер', 3)).toBe('Синнер выигрывает 2:0');
    expect(marketDescription('HCP_-1.5', 'Синнер', 5)).toBe('Синнер выигрывает 3:0 или 3:1');
    expect(marketDescription('HCP_+1.5', 'Руне', 5)).toBe('Руне берет хотя бы 2 сета');
  });

  it('в таблице — П1 и П2 всегда, форы только с кэфом', () => {
    const rows = analysisDone().result!.matches[0]!.markets;
    expect(shownMarkets(rows).map((r) => `${r.market}/${r.selection}`)).toEqual(['ML/1', 'ML/2']);
    const withHcp = rows.map((r) => (r.market === 'HCP_+1.5' && r.selection === 2 ? { ...r, odds: '1.40' } : r));
    expect(shownMarkets(withHcp).map((r) => `${r.market}/${r.selection}`)).toEqual(['ML/1', 'HCP_+1.5/2', 'ML/2']);
  });

  it('проценты, пункты, модели, доллары', () => {
    expect(ppDelta(0.04)).toBe('+4 п.п.');
    expect(ppDelta(-0.021)).toBe('−2 п.п.');
    expect(ppDelta(0.001)).toBe('±0 п.п.');
    expect(ppDelta(0.04, { unit: false })).toBe('+4');
    expect(plain(formatShare('0.0225'))).toMatch(/^2,25\s?%$/);
    expect(plain(formatShare(0.015))).toMatch(/^1,5\s?%$/);
    expect(plain(formatShare(0.02))).toMatch(/^2\s?%$/);
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-haiku-5-5-20261001')).toBe('Haiku 5.5');
    expect(modelName('gpt')).toBe('gpt');
    expect(plain(usdSmall(0.0003))).toMatch(/0,0003/);
    expect(plain(usdSmall(0.004))).toMatch(/0,004/);
    expect(plain(usdSmall(0.13))).toMatch(/0,13/);
  });

  it('номер анализа и раунд', () => {
    expect(analysisNumber(142)).toBe('A-0142');
    expect(analysisNumber(12345)).toBe('A-12345');
    expect(roundLabel('R16')).toBe('1/8 финала');
    expect(roundLabel('Q1')).toBe('Q1');
    expect(roundLabel(null)).toBe('');
    // категория турнира — подписью из ru.json, а не кодом базы (masters, grand_slam)
    expect(categoryLabel('masters')).toBe('Masters 1000');
    expect(categoryLabel('grand_slam')).toBe('Большой шлем');
    expect(categoryLabel('500')).toBe('ATP 500');
    expect(categoryLabel('davis_cup')).toBe('Кубок Дэвиса');
    expect(categoryLabel('challenger')).toBe('');
    expect(categoryLabel(null)).toBe('');
  });
});

describe('тексты по ключам и кодам сервера', () => {
  it('ключ с параметрами, даты — в формате пользователя', () => {
    expect(keyText('errors.analysis.too_many_events', { max: 5 })).toBe('Не больше 5 событий в одном анализе');
    expect(keyText('analysis.steps.unknown_key', {}, 'запасной')).toBe('запасной');
    expect(codeText('ai.overloaded')).toBe('Claude сейчас перегружен. Перезапустите анализ через несколько минут');
    expect(codeText('errors.bet.duplicate')).toBe('Такая ставка по этому анализу уже сохранена');
    expect(codeText(null, {}, 'нет')).toBe('нет');
  });

  it('суммы в ошибках банка — деньгами в валюте из параметров', () => {
    expect(codeText('bank.withdrawal_range', { balance: '20000.00', currency: 'RUB' })).toBe(
      'Вывести можно не больше баланса (20\u00a0000\u00a0₽): ставки в игре вывести нельзя',
    );
    expect(codeText('errors.bet.closing_range', { odds: '0.9' })).toBe('Закрывающий кэф 0.9 — допустимо от 1.01 до 50');
    expect(
      codeText('bet.payout_range', { payout: '15000000000.00', max: '9999999999.99', currency: 'USD' }),
    ).toBe(
      'Возможная выплата 15 000 000 000,00 $ больше предела учета '
        + '(9 999 999 999,99 $): уменьшите сумму ставки',
    );
  });

  it('429 — через сколько минут повторить; неизвестный код — текст сервера', () => {
    const limited = new ApiError(429, 'common.rate_limited', 'Too many', { retry_after: 125 });
    expect(apiErrorText(limited)).toBe('Слишком много разборов за час. Повторите через 3 мин');
    const odd = new ApiError(422, 'errors.analysis.odds_ml', '', { position: 2 });
    expect(apiErrorText(odd)).toBe('Событие 2: нужны кэфы П1 и П2');
    const unknown = new ApiError(500, 'server.boom', 'Сервер упал');
    expect(apiErrorText(unknown)).toBe('Сервер упал');
  });
});
