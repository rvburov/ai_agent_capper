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
    expect(info.reason).toBe(
      'Лимита на ИИ в этом месяце ($10,00) не хватает на следующий вызов Claude. Попросите администратора поднять лимит или подключите свой ключ',
    );
    expect(info.restart).toBe(false);
    expect(info.wait).toBe(
      'Перезапуск станет доступен, когда лимит позволит (сейчас: лимита на ИИ в этом месяце ($10,00) не хватает на анализ: остаток меньше, чем может стоить вызов Claude. Попросите администратора поднять лимит или подключите свой ключ)',
    );
    // лимит подняли — перезапуск доступен
    expect(stopInfo(failed('ai.monthly_limit'), { isAdmin: false, access: aiBudget(), t }).restart).toBe(true);
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

  it('свой ключ: потолок и отказ ключа ведут в «Ключ Claude»', () => {
    const cap = stopInfo(failed('ai.own_cap', { cap: 1 }, { key_source: 'own' }), { isAdmin: false, access: aiBudget(), t });
    expect(cap.link).toEqual({ label: 'Поднять свой потолок', to: 'profileKey' });
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
