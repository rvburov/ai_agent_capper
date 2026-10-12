import type { components } from '../../api/schema';

// Типы API анализа — из schema.d.ts (npm run gen:api), здесь только короткие имена.
type S = components['schemas'];

export type Analysis = S['AnalysisOut'];
export type AnalysisStatus = Analysis['status'];
export type Draft = S['DraftOut'];
export type DraftEvent = S['DraftEventOut'];
export type PlayerPick = S['PlayerPick'];
export type PlayerBrief = S['PlayerBrief'];
export type ConfirmedEvent = S['ConfirmedEventOut'];
export type ConfirmIn = S['ConfirmIn'];
export type EventIn = S['EventIn'];
export type Preview = S['PreviewOut'];
export type PreviewEvent = S['PreviewEvent'];
export type PreviewPlayer = S['PreviewPlayer'];
export type Access = S['AccessOut'];
export type TextKey = S['TextKey'];
export type Step = S['StepOut'];
export type StepKind = Step['kind'];
export type StepState = Step['state'];
export type Totals = S['TotalsOut'];
export type ErrorInfo = S['ErrorInfoOut'];
export type ProgressEvent = S['ProgressEventOut'];
export type Result = S['ResultOut'];
export type MatchResult = S['MatchResult'];
export type MarketRow = S['MarketRow'];
export type Factor = S['FactorOut'];
export type ComparisonRow = S['ComparisonRow'];
export type Express = S['ExpressOut'];
export type ExpressLeg = S['ExpressLeg'];
export type Stake = S['StakeOut'];
export type StakeStep = S['StakeStepOut'];
export type RuleCheck = S['RuleCheck'];
export type Costs = S['CostsOut'];
export type AnalysisListItem = S['AnalysisListItem'];
export type Strategy = S['StrategyOut'];
export type StrategyParams = S['StrategyParamsOut'];
export type Bank = S['BankOut'];
export type AiBudget = S['AiBudgetOut'];
export type Market = MarketRow['market'];

/** Статусы, в которых анализ идет на сервере (поток событий открыт). */
export const ACTIVE_STATUSES: readonly AnalysisStatus[] = [
  'queued',
  'running',
  'building_dossier',
  'modelling',
  'llm_review',
  'composing',
];

export function isActive(status: AnalysisStatus | null | undefined): boolean {
  return status !== null && status !== undefined && ACTIVE_STATUSES.includes(status);
}

// Сколько ждем вызов Claude, начатый до отмены: он доработает, и сервер запишет его итог в
// отмененный анализ (шаг станет выполненным, расход — учтенным)
const SETTLE_MS = 10 * 60_000;

/** Отмененный анализ, у которого шаг еще «идет»: экран перечитывает анализ, пока шаг не закроется. */
export function isSettling(analysis: Analysis | undefined, now = Date.now()): boolean {
  if (analysis?.status !== 'cancelled' || !analysis.steps.some((step) => step.state === 'running')) return false;
  const finished = analysis.finished_at ? Date.parse(analysis.finished_at) : Number.NaN;
  return Number.isFinite(finished) && now - finished < SETTLE_MS;
}

/** Разбор текста не удался: такой анализ — несостоявшийся черновик (его место — «Новый анализ»). */
export function isParseFailed(analysis: Pick<Analysis, 'status' | 'error'>): boolean {
  return analysis.status === 'failed' && analysis.error?.step === 'parse';
}
