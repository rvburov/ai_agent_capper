import { describe, expect, it } from 'vitest';

import { archiveConflicts, closingByHand, isArchiveClosing, lastMatchDay, missingInArchive, settledBy } from './display';
import { legNewsResult, newsResultOutcome, newsScoreText, reviewShown, safeSourceUrl } from './review';
import { archiveClosing, betAuto, betAwaiting, betLeg, betLegacy, betOpen, betReview, betWon, legReview, newsResult } from './testData';

describe('ставки этапа 5: расчет по архиву', () => {
  it('кто рассчитал: авто, вручную; у открытой и перенесенной из бота — нет', () => {
    expect(settledBy(betAuto())).toBe('auto');
    expect(settledBy(betWon())).toBe('manual');
    expect(settledBy(betOpen())).toBeNull();
    expect(settledBy(betLegacy())).toBeNull();
    // ставку бота участник рассчитал сам — «внесено вами»
    expect(settledBy(betLegacy({ settled_by: 'manual' }))).toBe('manual');
  });

  it('«внесите сами» — только у форы рассчитанной ставки приложения без закрытия', () => {
    const auto = betAuto();
    const [ml, hcp] = auto.legs;
    expect(closingByHand(auto, hcp!)).toBe(true);
    expect(closingByHand(auto, ml!)).toBe(false);
    expect(closingByHand(betOpen(), { ...hcp!, result: null })).toBe(false);
    expect(closingByHand(auto, { ...hcp!, result: 'void' })).toBe(false);
    expect(closingByHand(betLegacy(), { ...hcp!, closing: null })).toBe(false);
    expect(isArchiveClosing(archiveClosing())).toBe(true);
    expect(isArchiveClosing({ source: 'user' })).toBe(false);
  });

  it('расхождение с архивом — ноги с исходом архива; у открытой — нет', () => {
    const leg = betLeg({ id: 61, result: 'win', archive_result: 'loss', archive_score: '1:2' });
    expect(archiveConflicts(betWon({ legs: [leg, betLeg({ id: 62, result: 'win' })] })).map((l) => l.id)).toEqual([61]);
    expect(archiveConflicts(betOpen({ legs: [leg] }))).toEqual([]);
  });

  it('день последнего матча ставки', () => {
    expect(lastMatchDay(betAwaiting())).toBe('2026-10-10');
    const legs = [betLeg({ match: { ...betLeg().match, day: '2026-10-12' } }), betLeg({ match: { ...betLeg().match, day: null } })];
    expect(lastMatchDay({ legs })).toBe('2026-10-12');
    expect(lastMatchDay({ legs: [betLeg({ match: { ...betLeg().match, day: null } })] })).toBeNull();
  });
});

describe('разбор ИИ и подсказка из новостей', () => {
  it('состояние блока разбора', () => {
    expect(reviewShown(betOpen(), undefined)).toEqual({ kind: 'open' });
    expect(reviewShown(betLegacy(), undefined)).toEqual({ kind: 'not_reviewed', reason: 'legacy' });
    expect(reviewShown(betWon({ status: 'void' }), undefined)).toEqual({ kind: 'not_reviewed', reason: 'void' });
    // ответа еще нет — готовится
    expect(reviewShown(betAuto(), null)).toEqual({ kind: 'pending', legs: [] });
    expect(reviewShown(betAuto(), betReview({ state: 'pending' }, [legReview({ status: 'queued' })]))).toEqual({ kind: 'pending', legs: [] });
    const done = legReview();
    expect(reviewShown(betAuto(), betReview({ state: 'pending' }, [done, legReview({ leg_id: 91, status: 'submitted' })]))).toEqual({ kind: 'pending', legs: [done] });
    expect(reviewShown(betAuto(), betReview({}, [done]))).toEqual({ kind: 'done', legs: [done] });
    expect(reviewShown(betAuto(), betReview({ state: 'failed' }, []))).toEqual({ kind: 'failed' });
    expect(reviewShown(betAuto(), betReview({ state: 'not_reviewed', reason: 'no_prediction' }, []))).toEqual({ kind: 'not_reviewed', reason: 'no_prediction' });
  });

  it('подсказка: читается только целая, исход на победу — по победителю', () => {
    const leg = betAwaiting({}, newsResult()).legs[0]!;
    expect(legNewsResult(leg)).toEqual(newsResult());
    expect(legNewsResult(betLeg())).toBeNull();
    expect(newsResultOutcome({ market: 'ML', selection: 1 }, { winner: 1 })).toBe('win');
    expect(newsResultOutcome({ market: 'ML', selection: 2 }, { winner: 1 })).toBe('loss');
    expect(newsResultOutcome({ market: 'HCP_-1.5', selection: 1 }, { winner: 1 })).toBeNull();
    expect(safeSourceUrl('https://www.atptour.com/x')).toBe('https://www.atptour.com/x');
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull();
    expect(safeSourceUrl('не адрес')).toBeNull();
  });
});

describe('ждет результата: архив уже дальше дня матча', () => {
  it('исхода нет, хотя архив дальше дня матчей; архив по день матча или раньше — еще ждем', () => {
    expect(missingInArchive(betAwaiting({ archive_matches_to: '2026-10-11' }))).toBe(true);
    expect(missingInArchive(betAwaiting({ archive_matches_to: '2026-10-10' }))).toBe(false);
    expect(missingInArchive(betAwaiting({ archive_matches_to: '2026-10-04' }))).toBe(false);
    expect(missingInArchive(betAwaiting({ archive_matches_to: null }))).toBe(false);
    // не ждет результата — не наш случай
    expect(missingInArchive(betAwaiting({ awaiting_result: false, archive_matches_to: '2026-10-11' }))).toBe(false);
  });
});

describe('счет из новостей', () => {
  it('дефис между цифрами — двоеточие, остальное как есть', () => {
    expect(newsScoreText('6-3 3-6 7-6(5)')).toBe('6:3 3:6 7:6(5)');
    expect(newsScoreText('6–4 6 - 2')).toBe('6:4 6:2');
    expect(newsScoreText('6:3 2:0, отказ')).toBe('6:3 2:0, отказ');
  });
});
