import type { TFunction } from 'i18next';

import { Chip, type TimelineStep } from '../../components';
import { keyText } from '../../features/analysis/codes';
import { displayName, shortName } from '../../features/analysis/draft';
import { modelName, usdSmall } from '../../features/analysis/markets';
import type { Analysis, Step } from '../../features/analysis/types';
import { formatDuration, formatTokens } from '../../lib/format';

// Шаги хода анализа для StepTimeline (buildSteps и stepEl в mockup/js/screens/analysis.js):
// название с матчем, модель или «без ИИ», что сделано, время, токены и цена.

/** Матч по id: «Синнер — Руне» (из подтвержденных событий или итога). */
export function matchNames(analysis: Analysis, t: TFunction): Map<number, string> {
  const names = new Map<number, string>();
  for (const event of analysis.events) {
    if (event.match_id === null) continue;
    names.set(
      event.match_id,
      t('analysis.matchTitle', {
        p1: shortName(displayName(event.player1)),
        p2: shortName(displayName(event.player2)),
      }),
    );
  }
  for (const match of analysis.result?.matches ?? []) {
    if (names.has(match.match_id)) continue;
    names.set(match.match_id, t('analysis.matchTitle', { p1: shortName(match.player1.name), p2: shortName(match.player2.name) }));
  }
  return names;
}

const NEWS_WARN = new Set(['analysis.steps.news_failed', 'analysis.steps.news_limit']);

/** Шаг новостей не получил новости (сбой поиска или лимит) — «выполнен с предупреждением». */
export function isWarnStep(step: Step): boolean {
  return step.kind === 'news' && step.state === 'skipped' && NEWS_WARN.has(step.detail_key ?? '');
}

export function stepTitle(step: Step, names: Map<number, string>, t: TFunction, inputKind: string): string {
  const match = step.match_id !== null ? (names.get(step.match_id) ?? t('analysis.steps.someMatch')) : '';
  switch (step.kind) {
    case 'parse':
      return inputKind === 'form' ? t('analysis.steps.title.parseForm') : t('analysis.steps.title.parse');
    case 'news':
      return t('analysis.steps.title.news', { match });
    case 'claude':
      return t('analysis.steps.title.claude', { match });
    default:
      return t(`analysis.steps.title.${step.kind}`);
  }
}

function metaText(step: Step, elapsedMs: number, t: TFunction): string {
  if (step.detail_key === 'analysis.steps.claude_reused') return t('analysis.steps.meta.free');
  const parts = [formatDuration(elapsedMs)];
  if (!step.tokens) parts.push(t('analysis.steps.meta.noTokens'));
  else {
    parts.push(t('analysis.steps.meta.tokens', { n: formatTokens(step.tokens) }));
    parts.push(usdSmall(step.cost_usd));
  }
  if (step.web_searches) parts.push(t('analysis.steps.meta.searches', { count: step.web_searches }));
  return parts.join(' · ');
}

function chipFor(step: Step, t: TFunction) {
  if (step.detail_key === 'analysis.steps.claude_reused') {
    return (
      <Chip kind="info" icon="history">
        {t('analysis.steps.chip.reused')}
      </Chip>
    );
  }
  // «без ИИ» — у шагов без модели и у выполненных без токенов (новости из кэша)
  const cached = step.state === 'done' && step.tokens === 0;
  if (step.model && !cached) {
    const name = modelName(step.model);
    return (
      <Chip kind="accent" icon="spark">
        {step.kind === 'news' ? t('analysis.steps.chip.search', { model: name }) : name}
      </Chip>
    );
  }
  return (
    <Chip kind="outline" icon="database">
      {t('analysis.steps.chip.noAi')}
    </Chip>
  );
}

export interface StepContext {
  names: Map<number, string>;
  inputKind: string;
  /** Сколько идет шаг, который сейчас выполняется (мс), — для живого времени. */
  runningMs: (step: Step) => number;
  /** Причина остановки для упавшего шага, если у шага нет своей. */
  failText: string;
}

export function stepView(step: Step, ctx: StepContext, t: TFunction): TimelineStep {
  const warn = isWarnStep(step);
  const state = step.state === 'running' ? 'active' : warn ? 'warn' : step.state === 'skipped' ? 'skipped' : step.state;
  const detail =
    step.kind === 'parse' && step.state === 'done' && !step.detail_key
      ? t('analysis.steps.parseDone')
      : keyText(step.detail_key, step.detail_params);
  let meta: string;
  if (step.state === 'pending') meta = t('analysis.steps.meta.pending');
  else if (step.state === 'running') meta = metaText(step, ctx.runningMs(step), t);
  // Прерванный шаг, вызов которого успел оплатиться, — с ценой, иначе «не выполнялся»
  else if (step.state === 'skipped' && !warn) meta = step.tokens ? metaText(step, step.elapsed_ms, t) : t('analysis.steps.meta.skipped');
  else meta = metaText(step, step.elapsed_ms, t);
  return {
    key: String(step.index),
    title: stepTitle(step, ctx.names, t, ctx.inputKind),
    chip: chipFor(step, t),
    detail: state === 'failed' || warn ? undefined : detail || undefined,
    note: step.detail_key === 'analysis.steps.claude_reused' ? detail : undefined,
    message:
      state === 'failed'
        ? t('analysis.steps.failed', { reason: keyText(step.detail_key, step.detail_params, ctx.failText) })
        : warn
          ? detail
          : undefined,
    meta,
    state,
  };
}

export const STATE_LABELS = (t: TFunction) => ({
  pending: t('analysis.steps.state.pending'),
  active: t('analysis.steps.state.active'),
  done: t('analysis.steps.state.done'),
  failed: t('analysis.steps.state.failed'),
  warn: t('analysis.steps.state.warn'),
  skipped: t('analysis.steps.state.skipped'),
});
