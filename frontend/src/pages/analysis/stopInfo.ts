import type { TFunction } from 'i18next';

import type { AppPath } from './links';
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
  const nowBlocked = access?.reason_code ? codeText(access.reason_code, access.reason_params, '') : '';
  const waitText = (key: 'limit' | 'budget') =>
    nowBlocked ? t(`analysis.stop.wait.${key}Now`, { now: nowBlocked.charAt(0).toLowerCase() + nowBlocked.slice(1) }) : t(`analysis.stop.wait.${key}`);

  switch (code) {
    case 'ai.monthly_limit':
      return { reason: t('analysis.stop.monthly', { limit: params.limit ?? '' }), restart: !access?.reason_code, wait: waitText('limit'), link: keyLink };
    case 'ai.paused':
      return { reason: codeText(code), restart: !access?.reason_code, wait: waitText('limit'), link: null };
    case 'ai.budget_exhausted':
      return isAdmin
        ? { reason: t('analysis.stop.budgetAdmin'), restart: !access?.reason_code, wait: waitText('budget'), link: adminLink }
        : { reason: codeText(code), restart: !access?.reason_code, wait: waitText('budget'), link: null };
    case 'ai.billing':
      if (own) return { reason: t('analysis.stop.billingOwn'), restart: true, wait: null, link: keyLink };
      return isAdmin
        ? { reason: t('analysis.stop.billingAdmin'), restart: true, wait: null, link: adminLink }
        : { reason: t('analysis.stop.billingMember'), restart: true, wait: null, link: null };
    case 'ai.analysis_cap':
    case 'ai.own_cap': {
      const cap = capNumber(params.cap);
      const capText = cap !== null ? formatUsd(cap) : String(params.cap ?? '');
      if (own) return { reason: t('analysis.stop.capOwn', { cap: capText, spent }), restart: true, wait: null, link: { label: t('analysis.stop.linkOwnCap'), to: 'profileKey' } };
      const now = access?.per_analysis_usd ?? null;
      const raised = cap !== null && now !== null && now > cap;
      return isAdmin
        ? { reason: t('analysis.stop.capAdmin', { cap: capText, spent }), restart: raised, wait: raised ? null : t('analysis.stop.wait.capAdmin'), link: null }
        : { reason: t('analysis.stop.capMember', { cap: capText, spent }), restart: raised, wait: raised ? null : t('analysis.stop.wait.cap'), link: null };
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
