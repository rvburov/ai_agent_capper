import type { TFunction } from 'i18next';

import { formatNumber, formatPercent, formatUsd } from '../../lib/format';
import { modelLabel } from '../ai/models';
import type { AgentSettings, AiRun, AiUsage, CostPart, RunCost, RunFilter, UsageDay, UsageKind } from './types';

// Подписи «ИИ и расходов»: виды вызовов, effort, суммы мелких вызовов. Все суммы, доли кэша,
// прогноз и «хватит на N» считает сервер (GET /api/ai/usage, /ai/runs, /ai/budget), здесь — вид.

/** Виды вызовов в порядке макета (оценка матча, новости, разбор текста) и этапа 5. */
export const KIND_ORDER = ['analysis', 'news', 'parse', 'refresh', 'postmortem'] as const;
export type KnownKind = (typeof KIND_ORDER)[number];

export function isKnownKind(kind: string): kind is KnownKind {
  return (KIND_ORDER as readonly string[]).includes(kind);
}

/** Фильтр журнала в адресе (/costs?runs=news): вид вызова или shared; иначе — все вызовы. */
const RUN_FILTERS: readonly RunFilter[] = [...KIND_ORDER, 'shared'];

export function runFilterOf(search: URLSearchParams): RunFilter | null {
  const value = search.get('runs');
  return value !== null && (RUN_FILTERS as readonly string[]).includes(value) ? (value as RunFilter) : null;
}

/** Адрес с фильтром журнала; остальные параметры — как были. null — все вызовы. */
export function searchWithRunFilter(search: URLSearchParams, filter: RunFilter | null): URLSearchParams {
  const next = new URLSearchParams(search);
  if (filter) next.set('runs', filter);
  else next.delete('runs');
  return next;
}

/** Короткое имя вида вызова: «Оценка матча», «Новости», «Разбор текста». */
export function kindLabel(kind: string, t: TFunction): string {
  return isKnownKind(kind) ? t(`costs.kinds.${kind}`) : kind;
}

/**
 * Как работает задача (WHAT макета): «Opus 5.5 · effort medium · один вызов на матч». Модели —
 * те, что вызывались (с сервера), effort и «на матч» — из настроек агента, если они загружены.
 */
export function kindSetup(kind: string, models: readonly string[], settings: AgentSettings | null | undefined, t: TFunction): string {
  const parts = [models.map(modelLabel).join(', ')];
  if (settings) {
    const effort = kind === 'analysis' ? settings.analysis_effort : kind === 'news' ? settings.news_effort : kind === 'parse' ? settings.parse_effort : null;
    if (effort) parts.push(t('costs.effortChip', { effort }));
    if (kind === 'analysis') parts.push(t('costs.types.perAnalysis'));
    else if (kind === 'news') parts.push(t('costs.types.perNews', { count: settings.news_searches_per_match }));
    else if (kind === 'parse') parts.push(t('costs.types.perParse'));
  }
  return parts.filter(Boolean).join(' · ');
}

/** effort словами: «средний уровень размышлений»; неизвестный — как пришел. */
export function effortWord(effort: string | null | undefined, t: TFunction): string | null {
  if (!effort) return null;
  return effort === 'low' || effort === 'medium' || effort === 'high' ? t(`costs.effort.${effort}`) : effort;
}

/** Цена одного вызова: разбор текста на Haiku стоит доли цента — четыре знака, иначе три. */
export function usdRun(value: number): string {
  return formatUsd(value, value > 0 && value < 0.001 ? 4 : 3);
}

/** Суммы в сводках: копейки не превращаются в «$0,00». */
export function usdSum(value: number, t: TFunction): string {
  return value > 0 && value < 0.01 ? t('costs.lessCent') : formatUsd(value);
}

/** Доля с сервера в сводке: меньше 0,5% — «< 1%», иначе целыми процентами; нет доли — «—». */
export function shareText(share: number | null | undefined, t: TFunction): string {
  if (share === null || share === undefined) return '—';
  return share > 0 && share < 0.005 ? t('costs.lessPct') : formatPercent(share, { digits: 0 });
}

/** Сколько анализов законченных (без прогонов приемки) — для «Цены анализа». */
export function doneAnalyses(usage: AiUsage) {
  return usage.analyses.filter((analysis) => analysis.done && !analysis.acceptance);
}

/** Виды вызовов месяца по расходу, сначала дорогие; без вызовов — не показываются. */
export function kindsByCost(usage: AiUsage): UsageKind[] {
  return usage.kinds.filter((kind) => kind.runs > 0).sort((a, b) => b.cost_usd - a.cost_usd);
}

/** Самый дорогой день месяца (null — вызовов нет). */
export function priciestDay(days: readonly UsageDay[]): UsageDay | null {
  let best: UsageDay | null = null;
  for (const day of days) if (day.cost_usd > 0 && (!best || day.cost_usd > best.cost_usd)) best = day;
  return best;
}

export interface PricePart {
  key: 'cache_read' | 'cache_write_5m' | 'cache_write_1h' | 'input' | 'output' | 'searches';
  part: CostPart;
  color: string;
}

// Цвета частей цены — как в окне вызова макета: чтение кэша, запись, новый вход, выход, поиски
const PART_COLORS: Record<PricePart['key'], string> = {
  cache_read: 'var(--s1)',
  cache_write_5m: 'var(--s5)',
  cache_write_1h: 'var(--s6)',
  input: 'var(--s2)',
  output: 'var(--s3)',
  searches: 'var(--s4)',
};

/** Части цены вызова в порядке окна макета; все, включая нулевые (таблица), — с цветом. */
export function priceParts(price: RunCost): PricePart[] {
  const keys: PricePart['key'][] = ['cache_read', 'cache_write_5m', 'cache_write_1h', 'input', 'output', 'searches'];
  return keys.map((key) => ({ key, part: price[key], color: PART_COLORS[key] }));
}

/** Цена за 1 млн токенов: «$4», «$0,10», «$0,125»; за поиск — «$0,01». */
export function unitPrice(value: number): string {
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) < 1e-9) return formatUsd(value, Number.isInteger(value) ? 0 : 2);
  return formatUsd(value, 3);
}

/**
 * Формула цены вызова из частей сервера: «(12 400 × $0,20 + … ) / 1 000 000 + 2 × $0,01 = $0,113».
 * Вторая ступень и Batch — множителями.
 */
export function priceFormula(run: AiRun, price: RunCost, t: TFunction): string {
  const tokenParts = (['cache_read', 'cache_write_5m', 'cache_write_1h', 'input', 'output'] as const)
    .map((key) => price[key])
    .filter((part) => part.tokens > 0)
    .map((part) => `${formatNumber(part.tokens)} × ${unitPrice(part.price)}`);
  let text = tokenParts.length ? `(${tokenParts.join(' + ')}) / 1 000 000` : '';
  if (tokenParts.length && price.long_factor !== 1) text += ` × ${formatNumber(price.long_factor, 0)}`;
  if (tokenParts.length && price.batch) text += ` × ${formatNumber(0.5, 1)}`;
  if (price.searches.tokens > 0) text += `${text ? ' + ' : ''}${price.searches.tokens} × ${unitPrice(price.searches.price)}`;
  return t('costs.run.formulaValue', { formula: text || '0', total: usdRun(run.cost_usd) });
}

/** Доля входа из кэша вызова или дня: «68%»; входа нет — null. */
export function cacheShareText(share: number | null | undefined): string | null {
  return share === null || share === undefined ? null : formatPercent(share, { digits: 0 });
}
