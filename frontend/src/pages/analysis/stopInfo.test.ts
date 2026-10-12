import { describe, expect, it } from 'vitest';

import { aiBudget } from '../../features/ai/testData';
import { analysisFailed } from '../../features/analysis/testData';
import type { Analysis } from '../../features/analysis/types';
import i18n from '../../i18n';
import { stopInfo } from './stopInfo';

const t = i18n.t.bind(i18n);
// Пробелы в суммах ru-RU — неразрывные; в ожиданиях пишем обычные
const plain = (text: string) => text.replace(/\s/g, ' ');

function failed(code: string, params: Record<string, unknown> = {}, over: Partial<Analysis> = {}): Analysis {
  return analysisFailed({ error: { code, params, step: 'claude' }, key_source: 'admin', ...over });
}

describe('почему анализ остановился — по коду и по тому, кто смотрит', () => {
  it('сбой Claude: текст кода, перезапуск сразу', () => {
    const info = stopInfo(failed('ai.overloaded'), { isAdmin: false, access: aiBudget(), t });
    expect(info).toEqual({
      reason: 'Claude сейчас перегружен. Перезапустите анализ через несколько минут',
      restart: true,
      wait: null,
      link: null,
    });
  });

  it('месячный лимит: перезапуск ждет, пока лимит позволит', () => {
    const blocked = aiBudget({ reason_code: 'ai.monthly_limit', reason_params: { limit: '10,00' } });
    const info = stopInfo(failed('ai.monthly_limit', { limit: '10,00' }), { isAdmin: false, access: blocked, t });
    // сумма лимита — как в карточках и макете: $10, а не $10,00
    expect(info.reason).toBe(
      'Лимита на ИИ в этом месяце ($10) не хватает на следующий вызов Claude. Попросите администратора поднять лимит или подключите свой ключ',
    );
    expect(info.restart).toBe(false);
    // причина та же, что у остановки: совет уже сказан строкой выше — без «(сейчас: …)»
    expect(info.wait).toBe('Перезапуск станет доступен, когда лимит позволит');
    // лимит подняли — перезапуск доступен
    expect(stopInfo(failed('ai.monthly_limit'), { isAdmin: false, access: aiBudget(), t }).restart).toBe(true);
    // другая причина — коротко, без повтора совета
    const paused = stopInfo(failed('ai.monthly_limit', { limit: '1,50' }), {
      isAdmin: false,
      access: aiBudget({ paused: true, reason_code: 'ai.paused' }),
      t,
    });
    expect(paused.reason).toMatch(/^Лимита на ИИ в этом месяце \(\$1,50\)/);
    expect(paused.wait).toBe('Перезапуск станет доступен, когда лимит позволит (сейчас: анализы на паузе по решению администратора)');
  });

  it('остановленный анализ уже засчитан за день: дневной лимит перезапуск не держит (как reserve_for_run)', () => {
    // последний разрешенный анализ дня остановился по лимиту месяца; администратор поднял лимит,
    // /api/ai/budget про новый анализ отвечает «на сегодня анализы закончились»
    const daily = aiBudget({ analyses_today: 1, daily_analyses: 1, monthly_usd: 20, left_usd: 18.6, reason_code: 'ai.daily_limit', reason_params: { daily: 1 } });
    const counted = failed('ai.monthly_limit', { limit: '1,00' }, { started_at: '2026-10-11T21:08:00Z', key_source: 'admin' });
    const info = stopInfo(counted, { isAdmin: false, access: daily, t });
    expect(info.restart).toBe(true);
    expect(info.wait).toBe('Перезапуск станет доступен, когда лимит позволит');
    for (const code of ['ai.paused', 'ai.budget_exhausted']) {
      expect(stopInfo(failed(code, {}, { started_at: '2026-10-11T21:08:00Z', key_source: 'admin' }), { isAdmin: false, access: daily, t }).restart).toBe(true);
    }
    // дневной счетчик заслоняет другие причины: их видно по полям ответа
    const paused = stopInfo(counted, { isAdmin: false, access: { ...daily, paused: true }, t });
    expect(paused.restart).toBe(false);
    expect(paused.wait).toBe('Перезапуск станет доступен, когда лимит позволит (сейчас: анализы на паузе по решению администратора)');
    expect(stopInfo(counted, { isAdmin: false, access: { ...daily, left_usd: 0 }, t }).restart).toBe(false);
    // анализ еще не засчитан (шел на своем ключе): перезапуск — новый анализ дня, лимит дня держит
    const own = stopInfo(failed('ai.monthly_limit', {}, { started_at: '2026-10-11T21:08:00Z', key_source: 'own' }), { isAdmin: false, access: daily, t });
    expect(own.restart).toBe(false);
    expect(own.wait).toBe('Перезапуск станет доступен, когда лимит позволит (сейчас: на сегодня анализы закончились: 1 в день)');
  });

  it('потолок анализа: участник ждет администратора, администратор — убрать события', () => {
    const error = failed('ai.analysis_cap', { cap: '0.50' });
    const member = stopInfo(error, { isAdmin: false, access: aiBudget({ per_analysis_usd: 0.5 }), t });
    expect(plain(member.reason)).toMatch(/^Следующий вызов Claude вместе с уже потраченными \$0,06 .* потолка \$0,50/);
    expect(member.restart).toBe(false);
    expect(member.wait).toBe('Перезапуск станет доступен, когда администратор поднимет потолок');
    const raised = stopInfo(error, { isAdmin: false, access: aiBudget({ per_analysis_usd: 1 }), t });
    expect(raised).toMatchObject({ restart: true, wait: null });
    const admin = stopInfo(error, { isAdmin: true, access: aiBudget({ per_analysis_usd: 0.5 }), t });
    expect(admin.reason).toMatch(/жесткого потолка программы/);
    expect(admin.wait).toBe('Перезапуск с тем же составом событий упрется в тот же потолок');
  });

  it('поле restart с сервера главнее догадки по /api/ai/budget', () => {
    const allowed = { allowed: true, reason_code: null, reason_params: {}, retry_at: null };
    // бюджет про новый анализ говорит «лимит», но перезапуск этого анализа сервер пустит
    const limited = aiBudget({ reason_code: 'ai.monthly_limit', reason_params: { limit: '10,00' } });
    expect(stopInfo(failed('ai.monthly_limit', { limit: '10,00' }, { restart: allowed }), { isAdmin: false, access: limited, t }).restart).toBe(true);
    // и наоборот: бюджет пустой, но перезапуск держит пауза — короткая причина в скобках
    const paused = { allowed: false, reason_code: 'ai.paused', reason_params: {}, retry_at: null };
    const info = stopInfo(failed('ai.monthly_limit', { limit: '10,00' }, { restart: paused }), { isAdmin: false, access: aiBudget(), t });
    expect(info.restart).toBe(false);
    expect(info.wait).toBe('Перезапуск станет доступен, когда лимит позволит (сейчас: анализы на паузе по решению администратора)');
    // потолок подняли, но в него не помещается вызов Claude: кнопка ждет
    const cap = { allowed: false, reason_code: 'ai.analysis_cap', reason_params: { cap: '2,00' }, retry_at: null };
    const capped = stopInfo(failed('ai.analysis_cap', { cap: '1,00', need: '0,16' }, { restart: cap }), { isAdmin: false, access: aiBudget({ per_analysis_usd: 2 }), t });
    expect(capped.restart).toBe(false);
    expect(plain(capped.reason)).toBe(
      'Следующий вызов Claude может стоить до $0,16, а вместе с уже потраченными $0,06 это больше потолка $1 на один анализ. Попросите администратора поднять потолок или уберите часть событий',
    );
    expect(stopInfo(failed('ai.analysis_cap', { cap: '1,00' }, { restart: allowed }), { isAdmin: true, access: aiBudget(), t })).toMatchObject({ restart: true, wait: null });
  });

  it('свой ключ: потолок и отказ ключа ведут в «Ключ Claude»', () => {
    const cap = stopInfo(failed('ai.own_cap', { cap: 1 }, { key_source: 'own' }), { isAdmin: false, access: aiBudget(), t });
    expect(cap.link).toEqual({ label: 'Поднять свой потолок', to: 'profileKey' });
    expect(cap.reason).toMatch(/дороже вашего потолка \$1 на один анализ/);
    expect(cap.restart).toBe(true);
    const key = stopInfo(failed('ai.key_rejected', {}, { key_source: 'own' }), { isAdmin: false, access: aiBudget(), t });
    expect(key.reason).toBe('Anthropic не принял ваш ключ: он отозван или неверный. Анализы на вашем ключе остановлены');
    expect(key.link?.to).toBe('profileKey');
  });

  it('ключ администратора: участнику — «сообщили», администратору — ссылка на ключ', () => {
    const member = stopInfo(failed('ai.key_rejected'), { isAdmin: false, access: aiBudget(), t });
    expect(member.reason).toMatch(/Мы сообщили администратору/);
    expect(member.link).toBeNull();
    const admin = stopInfo(failed('ai.billing'), { isAdmin: true, access: aiBudget(), t });
    expect(admin.link).toEqual({ label: 'Ключ и бюджет', to: 'adminKey' });
    const budget = stopInfo(failed('ai.budget_exhausted'), { isAdmin: false, access: aiBudget(), t });
    expect(budget.reason).toBe('Общего бюджета ключа администратора на месяц не хватает на анализ: остаток меньше, чем может стоить вызов Claude');
  });

  it('неизвестный код и анализ без ошибки — общий текст', () => {
    expect(stopInfo(failed('ai.something_new'), { isAdmin: false, access: undefined, t }).reason).toBe(
      'Анализ прервался. Перезапустите — уже выполненные шаги повторно не оплачиваются',
    );
    expect(stopInfo(analysisFailed({ error: null }), { isAdmin: false, access: undefined, t }).reason).toBe(
      'Анализ прервался: сервер перезапустился или шаг завис. Перезапустите — уже выполненные шаги повторно не оплачиваются',
    );
  });
});
