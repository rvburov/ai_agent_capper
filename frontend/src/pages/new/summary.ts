import type { TFunction } from 'i18next';

import type { Freshness } from '../../components';
import { codeText, inlineDateTime, keyText } from '../../features/analysis/codes';
import { checkEvent, displayName, resolvedPlayer, shortName, type EditEvent } from '../../features/analysis/draft';
import type { DraftState } from '../../features/analysis/draftStore';
import type { AiBudget, Preview, PreviewPlayer } from '../../features/analysis/types';
import { formatDate } from '../../lib/format';

// Сводка «Перед запуском» (summary в mockup/js/screens/new-analysis.js): игроки и свежесть их
// новостей, оценка цены и причина, по которой запускать нельзя. Числа — из ответа сервера.

export interface SidePlayer {
  key: string;
  name: string;
  short: string;
  freshness: Freshness;
  sub: string;
  /** Имя еще набирается: игрока нужно выбрать из подсказок. */
  typed?: boolean;
}

export interface LaunchSummary {
  n: number;
  /** Причина — сбой запроса: «Повторить» (preview — расчет «Перед запуском», draft — черновик на сервере). */
  retry: 'preview' | 'draft' | null;
  players: SidePlayer[];
  /** Игроки с устаревшими новостями: поищем перед анализом. */
  stale: SidePlayer[];
  costUsd: number | null;
  seconds: number | null;
  reusedMatches: number;
  /** Почему запускать нельзя (null — можно). */
  reason: string | null;
  /** Причина не зависит от событий (пауза, нет ключа, анализы на сегодня закончились). */
  blocked: boolean;
}

function newsText(info: PreviewPlayer | undefined, t: TFunction): string {
  if (!info) return '';
  const last = info.last_match ? t('new.player.lastMatch', { date: formatDate(info.last_match) }) : t('new.player.noMatches');
  const news = info.news_checked_at ? t('new.player.newsAt', { when: inlineDateTime(info.news_checked_at) }) : t('new.player.newsNone');
  return `${last} · ${news}${info.news_fresh ? '' : t('new.player.newsWillSearch')}`;
}

export function summarize(
  state: DraftState,
  preview: Preview | undefined,
  access: AiBudget | undefined,
  {
    parsing,
    t,
    previewError = null,
    draftError = null,
  }: {
    parsing: boolean;
    t: TFunction;
    /** Расчет «Перед запуском» не удался (текст ошибки). */
    previewError?: string | null;
    /** Черновик на сервере для событий формы не создался (текст ошибки). */
    draftError?: string | null;
  },
): LaunchSummary {
  const events = state.events;
  const infos = new Map<number, PreviewPlayer>();
  for (const event of preview?.events ?? []) for (const p of event.players) infos.set(p.id, p);

  const players: SidePlayer[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    for (const slot of [event.p1, event.p2]) {
      if (slot.status === 'empty') continue;
      const key = slot.player ? `id${slot.player.id}` : `raw${(slot.raw || slot.text).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const resolved = resolvedPlayer(slot);
      const info = slot.player ? infos.get(slot.player.id) : undefined;
      if (resolved) {
        const name = displayName(resolved);
        players.push({ key, name, short: shortName(name), freshness: info?.news_fresh ? 'fresh' : 'stale', sub: newsText(info, t) });
      } else if (slot.status === 'check' && slot.player) {
        const name = slot.raw || slot.text;
        players.push({ key, name, short: name, freshness: 'unconfirmed', sub: t('new.player.like', { name: displayName(slot.player) }) });
      } else if (slot.status === 'typed') {
        const name = slot.text.trim();
        players.push({ key, name, short: name, freshness: 'unconfirmed', sub: t('new.player.pick'), typed: true });
      } else {
        const name = slot.raw || slot.text;
        players.push({ key, name, short: name, freshness: 'missing', sub: t('new.player.notInBaseShort') });
      }
    }
  }
  const stale = players.filter((p) => p.freshness === 'stale');

  // Сначала то, что не зависит от событий (как DATA.ai.access(me, 0) в макете), потом ввод,
  // потом цена этого анализа (доступ из «Перед запуском»)
  const blockedText = access?.reason_code ? codeText(access.reason_code, access.reason_params, access.reason_code) : null;
  let retry: LaunchSummary['retry'] = null;
  const inputReason = (): string | null => {
    if (state.tab === 'text' && parsing) return t('new.reason.parsing');
    if (state.tab === 'text' && !state.text.trim() && !events.length) return t('new.reason.noText');
    if (state.tab === 'text' && state.parse && state.parsedText !== state.text) return t('new.reason.dirty');
    if (!events.length) return t('new.reason.noEvents');
    const bad = events.findIndex((event) => checkEvent(event).issues.length > 0);
    if (bad >= 0) return t('new.reason.event', { n: bad + 1, issue: firstIssue(events[bad] as EditEvent, t) });
    const missing = players.find((p) => p.freshness === 'missing');
    if (missing) return t('new.reason.missing', { name: missing.name });
    const typed = players.find((p) => p.typed);
    if (typed) return t('new.reason.pick', { name: typed.name });
    const unconfirmed = players.find((p) => p.freshness === 'unconfirmed');
    if (unconfirmed) return t('new.reason.unconfirmed', { name: unconfirmed.name });
    if (state.analysisId === null && draftError) {
      retry = 'draft';
      return t('new.reason.draftFailed', { reason: draftError });
    }
    if (previewError) {
      retry = 'preview';
      return t('new.reason.previewFailed', { reason: previewError });
    }
    const problem = preview?.problems[0] ?? preview?.events.flatMap((e) => e.problems)[0];
    if (problem) return keyText(problem.key, problem.params, problem.key);
    if (!preview) return t('new.reason.estimating');
    return null;
  };
  const costReason =
    preview && !preview.access.allowed && preview.access.reason_code
      ? codeText(preview.access.reason_code, preview.access.reason_params, preview.access.reason_code)
      : null;
  const reason = blockedText ?? inputReason() ?? costReason;
  const valid =
    events.length > 0 &&
    !preview?.problems.length &&
    !(preview?.events ?? []).some((e) => e.problems.length > 0);
  return {
    n: events.length,
    retry: reason !== null && reason !== blockedText ? retry : null,
    players,
    stale,
    // Цена — только для событий, которые сервер принял (иначе он считает 0)
    costUsd: preview && valid ? preview.estimate.cost_usd : null,
    seconds: preview ? preview.estimate.seconds : null,
    reusedMatches: preview?.estimate.reused_matches ?? 0,
    reason,
    blocked: Boolean(blockedText),
  };
}

function firstIssue(event: EditEvent, t: TFunction): string {
  const issue = checkEvent(event).issues[0];
  if (!issue) return '';
  const text =
    issue.kind === 'oddsRange'
      ? t('new.check.oddsRange', { list: issue.keys.map((key) => t(`new.odds.${key}`)).join(', ') })
      : t(`new.check.${issue.kind}`);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
