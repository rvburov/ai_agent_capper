import type { TFunction } from 'i18next';

import type { AppPath } from './links';
import { aiParams } from '../../features/ai/reasons';
import { codeText } from '../../features/analysis/codes';
import { usdSmall } from '../../features/analysis/markets';
import type { AiBudget, Analysis } from '../../features/analysis/types';
import { formatUsd } from '../../lib/format';

// Что сказать, когда анализ остановился (stopInfo в mockup/js/screens/analysis.js): текст по
// коду ошибки и по тому, кто смотрит — участник на ключе администратора, на своем ключе или
// администратор. wait — перезапуск зависит от лимита: кнопка доступна, когда лимит позволяет.

export interface StopInfo {
  reason: string;
  /** Перезапуск имеет смысл сразу (сбой Claude, сеть, ключ заменят). */
  restart: boolean;
  /** Перезапуск ждет лимита или потолка: пояснение под кнопками. */
  wait: string | null;
  link: { label: string; to: AppPath } | null;
}

function capNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

// Короткие причины для «(сейчас: …)»: полный текст ошибки повторил бы совет из строки выше
const NOW_KEYS = {
  'ai.paused': 'analysis.stop.now.paused',
  'ai.daily_limit': 'analysis.stop.now.daily',
  'ai.monthly_limit': 'analysis.stop.now.monthly',
  'ai.budget_exhausted': 'analysis.stop.now.budget',
  'ai.no_admin_key': 'analysis.stop.now.noAdminKey',
} as const;

/**
 * Что сейчас не дает перезапустить анализ (код причины) или null. Сервер отвечает сам в поле
 * restart анализа: та же проверка, что при запуске (дневной счетчик у засчитанного анализа,
 * потолок с потраченным и местом на вызов Claude, шаг, начатый до отмены). Без поля — догадка
 * по /api/ai/budget: он отвечает про новый анализ, а перезапуск анализа, уже засчитанного в
 * «анализы за день» (запускался на ключе администратора), дневной счетчик не держит. Код
 * ai.daily_limit заслоняет следующие причины, поэтому их смотрим по полям ответа.
 */
export function restartBlocker(analysis: Analysis, access: AiBudget | undefined): string | null {
  const restart = analysis.restart ?? null;
  if (restart) return restart.allowed ? null : (restart.reason_code ?? 'analysis.bad_state');
  const code = access?.reason_code ?? null;
  if (!access || code === null) return null;
  const counted = analysis.started_at !== null && analysis.key_source === 'admin';
  if (code !== 'ai.daily_limit' || !counted) return code;
  if (access.paused) return 'ai.paused';
  if (access.left_usd !== null && access.left_usd <= 0) return 'ai.monthly_limit';
  return null;
}

export function stopInfo(
  analysis: Analysis,
  { isAdmin, access, t }: { isAdmin: boolean; access: AiBudget | undefined; t: TFunction },
): StopInfo {
  const error = analysis.error;
  const code = error?.code ?? 'analysis.worker_lost';
  const params = error?.params ?? {};
  const own = analysis.key_source === 'own';
  // Как «Потрачено» в сообщении: учет agent_runs и тот же формат малых сумм ($0,0003)
  const spent = usdSmall(Math.max(analysis.cost_usd, analysis.totals.cost_usd));
  const keyLink = { label: t('analysis.stop.linkProfileKey'), to: 'profileKey' as const };
  const adminLink = { label: t('analysis.stop.linkAdminKey'), to: 'adminKey' as const };
  const blocker = restartBlocker(analysis, access);
  const restartNow = blocker === null;
  const blockerParams = analysis.restart ? analysis.restart.reason_params : (access?.reason_params ?? {});
  // Та же причина, что у остановки, уже сказана выше — без «(сейчас: …)»
  const nowCode = blocker !== null && blocker !== code ? blocker : null;
  const nowText = nowCode
    ? Object.hasOwn(NOW_KEYS, nowCode)
      ? t(NOW_KEYS[nowCode as keyof typeof NOW_KEYS], blockerParams)
      : codeText(nowCode, blockerParams, '')
    : '';
  const waitText = (key: 'limit' | 'budget') =>
    nowText ? t(`analysis.stop.wait.${key}Now`, { now: nowText.charAt(0).toLowerCase() + nowText.slice(1) }) : t(`analysis.stop.wait.${key}`);

  switch (code) {
    case 'ai.monthly_limit':
      return {
        reason: t('analysis.stop.monthly', { limit: aiParams(code, params).limit ?? '' }),
        restart: restartNow,
        wait: waitText('limit'),
        link: keyLink,
      };
    case 'ai.paused':
      return { reason: codeText(code), restart: restartNow, wait: waitText('limit'), link: null };
    case 'ai.budget_exhausted':
      return isAdmin
        ? { reason: t('analysis.stop.budgetAdmin'), restart: restartNow, wait: waitText('budget'), link: adminLink }
        : { reason: codeText(code), restart: restartNow, wait: waitText('budget'), link: null };
    case 'ai.billing':
      if (own) return { reason: t('analysis.stop.billingOwn'), restart: true, wait: null, link: keyLink };
      return isAdmin
        ? { reason: t('analysis.stop.billingAdmin'), restart: true, wait: null, link: adminLink }
        : { reason: t('analysis.stop.billingMember'), restart: true, wait: null, link: null };
    case 'ai.analysis_cap':
    case 'ai.own_cap': {
      const cap = capNumber(params.cap);
      // Потолок — как в макете и карточках лимитов: $1, но $0,50
      const capText = cap !== null ? formatUsd(cap, Number.isInteger(cap) ? 0 : 2) : String(params.cap ?? '');
      // До скольких мог стоить вызов, которому не хватило места (сервер присылает need), как в
      // макете: «Следующий вызов Claude может стоить до $0,16, а вместе с уже потраченными…»
      const need = capNumber(params.need);
      const vars = { cap: capText, spent, need: need !== null ? formatUsd(need, 2) : '' };
      const key = (who: 'Own' | 'Admin' | 'Member') => (need !== null ? (`analysis.stop.cap${who}Need` as const) : (`analysis.stop.cap${who}` as const));
      if (own) return { reason: t(key('Own'), vars), restart: true, wait: null, link: { label: t('analysis.stop.linkOwnCap'), to: 'profileKey' } };
      // Сервер сам знает, пустит ли перезапуск (потолок поднят и в него помещается вызов);
      // без поля restart — по потолку из /api/ai/budget
      const now = access?.per_analysis_usd ?? null;
      const raised = analysis.restart ? restartNow : cap !== null && now !== null && now > cap;
      return isAdmin
        ? { reason: t(key('Admin'), vars), restart: raised, wait: raised ? null : t('analysis.stop.wait.capAdmin'), link: null }
        : { reason: t(key('Member'), vars), restart: raised, wait: raised ? null : t('analysis.stop.wait.cap'), link: null };
    }
    case 'ai.key_rejected':
      if (own) return { reason: t('analysis.stop.keyOwn'), restart: true, wait: null, link: keyLink };
      return isAdmin
        ? { reason: t('analysis.stop.keyAdminSelf'), restart: true, wait: null, link: adminLink }
        : { reason: t('analysis.stop.keyAdmin'), restart: true, wait: null, link: null };
    default:
      return { reason: codeText(code, params, t('analysis.stop.unknown')), restart: true, wait: null, link: null };
  }
}
