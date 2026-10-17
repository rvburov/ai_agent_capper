import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import {
  Button,
  Callout,
  Card,
  Chip,
  Disclosure,
  Icon,
  Modal,
  ProgressBar,
  StepTimeline,
} from '../../components';
import { usdSmall } from '../../features/analysis/markets';
import { analysisNumber } from '../../features/analysis/number';
import { stepFinishingUntil, type Analysis, type Step } from '../../features/analysis/types';
import { formatDuration, formatTokens, formatUsd, type Currency } from '../../lib/format';
import { appPath } from './links';
import type { StopInfo } from './stopInfo';
import { STATE_LABELS, stepTitle, stepView, warningTexts, type StepContext } from './stepsView';

// Ход анализа: идет (шаги и счетчики, «Отменить анализ»), остановлен или отменен (причина и
// «Перезапустить с этого шага»), готов (счетчики, «Показать шаги»). progressRunning,
// progressStopped, stopBanner, progressDone в mockup/js/screens/analysis.js.

function usd(value: number): string {
  return usdSmall(value);
}

/** Время, токены и цена анализа — одни и те же числа в счетчиках и в строке расходов. */
export interface RunNumbers {
  elapsedMs: number;
  tokens: number;
  costUsd: number;
}

/**
 * Числа анализа. Деньги — analysis.cost_usd (учет agent_runs, источник правды): в нем и вызов,
 * который доработал после отмены. Пока анализ идет, cost_usd в кэше не обновляется — берем
 * больший из него и суммы шагов. Токены готового анализа — из итога (тот же учет).
 */
export function runNumbers(analysis: Analysis, liveMs = 0): RunNumbers {
  const totals = analysis.totals;
  return {
    elapsedMs: totals.elapsed_ms + liveMs,
    tokens: analysis.result?.costs.tokens ?? totals.tokens,
    costUsd: Math.max(analysis.cost_usd, totals.cost_usd),
  };
}

export function Numbers({
  analysis,
  numbers,
  lead,
  estimate,
}: {
  analysis: Analysis;
  numbers: RunNumbers;
  lead?: ReactNode;
  estimate?: boolean;
}) {
  const { t } = useTranslation();
  const est = analysis.estimate_usd;
  let estTitle = '';
  if (estimate && est !== null) {
    const d = numbers.costUsd - est;
    estTitle = Math.abs(d) < 0.01 ? t('analysis.nums.estSame') : d < 0 ? t('analysis.nums.estLess') : t('analysis.nums.estMore');
  }
  return (
    <div className="analysis-nums">
      {lead}
      <span>
        {t('analysis.nums.time')} <b>{formatDuration(numbers.elapsedMs)}</b>
      </span>
      <span>
        {t('analysis.nums.tokens')} <b>{formatTokens(numbers.tokens)}</b>
      </span>
      <span>
        {t('analysis.nums.cost')} <b>{usd(numbers.costUsd)}</b>
      </span>
      {estimate && est !== null && (
        <span title={estTitle}>
          {t('analysis.nums.estimate')} <b>≈{formatUsd(est)}</b>
        </span>
      )}
    </div>
  );
}

function CancelDialog({ open, spent, busy, onClose, onConfirm }: { open: boolean; spent: number; busy: boolean; onClose: () => void; onConfirm: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('analysis.cancel.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('analysis.cancel.keep')}</Button>
          <Button kind="danger" icon="x" loading={busy} onClick={onConfirm}>
            {t('analysis.cancel.confirm')}
          </Button>
        </>
      }
    >
      <p className="small soft">{t('analysis.cancel.text', { spent: usd(spent) })}</p>
      <p className="xsmall muted">{t('analysis.cancel.note')}</p>
    </Modal>
  );
}

interface RunningProps {
  analysis: Analysis;
  steps: Step[];
  ctx: StepContext;
  offline: boolean;
  cancelling: boolean;
  onCancel: () => Promise<boolean>;
  matchesCount: number;
}

export function RunningCard({ analysis, steps, ctx, offline, cancelling, onCancel, matchesCount }: RunningProps) {
  const { t } = useTranslation();
  const [confirm, setConfirm] = useState(false);
  const total = steps.length || analysis.totals.steps;
  const done = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  const current = steps.find((s) => s.state === 'running') ?? steps.find((s) => s.state === 'pending');
  const currentNumber = current ? current.index + 1 : total;
  const noAi = steps.filter((s) => !s.model).length;
  const queued = analysis.status === 'queued';
  // Время растет вместе с идущим шагом (как totalsAt в макете), а не только по готовым шагам
  const liveMs = steps.filter((s) => s.state === 'running').reduce((sum, s) => sum + Math.max(0, ctx.runningMs(s) - s.elapsed_ms), 0);
  const numbers = runNumbers(analysis, liveMs);
  return (
    <Card
      className="analysis-progress"
      eyebrow={
        analysis.attempt > 1
          ? t('analysis.run.eyebrowAttempt', { id: analysisNumber(analysis.id), attempt: analysis.attempt })
          : t('analysis.run.eyebrow', { id: analysisNumber(analysis.id) })
      }
      title={t('analysis.run.title', { count: matchesCount })}
      subtitle={analysis.attempt > 1 ? t('analysis.run.subtitleRestart') : queued ? t('analysis.run.subtitleQueued') : t('analysis.run.subtitle')}
      actions={
        <Button kind="ghost" size="sm" icon="x" onClick={() => setConfirm(true)} ro>
          {t('analysis.cancel.button')}
        </Button>
      }
    >
      <div className="analysis-prog-top">
        <ProgressBar
          value={done}
          max={total || 1}
          label={t('analysis.run.progress')}
          valueText={t('analysis.run.stepOf', { n: currentNumber, total })}
        />
        <Numbers
          analysis={analysis}
          numbers={numbers}
          lead={
            <span>
              {t('analysis.nums.step')} <b>{t('analysis.nums.stepOf', { n: currentNumber, total })}</b>
            </span>
          }
        />
      </div>
      {offline && (
        <div className="analysis-offline" role="status">
          <span className="analysis-spin" aria-hidden="true" />
          {t('analysis.run.offline')}
        </div>
      )}
      <StepTimeline steps={steps.map((s) => stepView(s, ctx, t))} label={t('analysis.steps.label')} stateLabels={STATE_LABELS(t)} />
      <Callout>{t('analysis.run.noAi', { count: noAi, total })}</Callout>
      <p className="sr-only" aria-live="polite">
        {current ? t('analysis.run.live', { n: currentNumber, total, title: stepTitle(current, ctx.names, t, ctx.inputKind) }) : ''}
      </p>
      <CancelDialog
        open={confirm}
        spent={numbers.costUsd}
        busy={cancelling}
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          void onCancel().then((ok) => {
            if (ok) setConfirm(false);
          });
        }}
      />
    </Card>
  );
}

/** Заглушка результата, пока анализ идет. */
export function ResultSkeleton() {
  const { t } = useTranslation();
  return (
    <section className="card analysis-skel-card" aria-busy="true" aria-label={t('analysis.run.resultLabel')}>
      <div className="card-body">
        <div className="row">
          <Icon name="clock" size={16} className="muted" />
          <span className="muted small">{t('analysis.run.resultSoon')}</span>
        </div>
        <div className="analysis-skel" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
        </div>
      </div>
    </section>
  );
}

interface StopProps {
  analysis: Analysis;
  steps: Step[];
  ctx: StepContext;
  info: StopInfo | null;
  restarting: boolean;
  onRestart: () => void;
}

/** Сообщение сверху: анализ остановлен на шаге N или отменен — что случилось и что делать. */
export function StopBanner({ analysis, steps, ctx, info, restarting, onRestart }: StopProps) {
  const { t } = useTranslation();
  const cancelled = analysis.status === 'cancelled';
  const failedStep = steps.find((s) => s.state === 'failed') ?? steps.find((s) => s.state === 'pending' || s.state === 'running');
  const at = failedStep ? failedStep.index + 1 : steps.length;
  const total = steps.length;
  const paidDone = steps
    .filter((s) => (s.state === 'done' || s.state === 'skipped') && s.cost_usd > 0)
    .map((s) => stepTitle(s, ctx.names, t, ctx.inputKind));
  const editTo = `${paths.newAnalysis}?draft=${analysis.id}`;
  const spent = usd(runNumbers(analysis).costUsd);
  // Шаг, который шел при отмене, дорабатывает: «Продолжить» — когда он закончится (экран
  // перечитывает анализ), иначе сервер ответит 409 и шаг был бы оплачен дважды
  const finishUntil = stepFinishingUntil(analysis);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (finishUntil === null) return;
    const left = finishUntil - Date.now();
    if (left <= 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), left + 500);
    return () => window.clearTimeout(timer);
  }, [finishUntil]);
  const finishing = finishUntil !== null && Math.max(now, Date.now()) < finishUntil;
  if (cancelled) {
    return (
      <div className="callout analysis-stop" role="alert">
        <Icon name="x" />
        <div className="callout-body">
          <b>{t('analysis.stop.cancelledTitle', { n: at, total })}</b> {t('analysis.stop.cancelledText', { spent })}
          <div className="analysis-stop-acts">
            <Button kind="primary" size="sm" icon="refresh" disabled={finishing} loading={restarting} onClick={onRestart} ro>
              {t('analysis.stop.continue', { n: at })}
            </Button>
            <Button size="sm" icon="edit" to={editTo} ro>
              {t('analysis.edit')}
            </Button>
          </div>
          {finishing && (
            <div className="analysis-stop-note">
              <Icon name="clock" />
              <span>{t('analysis.stop.finishing')}</span>
            </div>
          )}
          <div className="analysis-stop-note">
            <Icon name="check" />
            <span>{t('analysis.stop.paidOnce')}</span>
          </div>
        </div>
      </div>
    );
  }
  const title = failedStep ? stepTitle(failedStep, ctx.names, t, ctx.inputKind) : '';
  return (
    <div className="callout bad analysis-stop" role="alert">
      <Icon name="alert" />
      <div className="callout-body">
        <b>{t('analysis.stop.title', { n: at, total, title })}</b> {info?.reason}.
        <div className="analysis-stop-acts">
          <Button kind="primary" size="sm" icon="refresh" disabled={!info?.restart} loading={restarting} onClick={onRestart} ro>
            {t('analysis.stop.restart')}
          </Button>
          {info?.link && (
            <Button size="sm" icon="key" to={appPath(info.link.to)} ro>
              {info.link.label}
            </Button>
          )}
          <Button size="sm" icon="edit" to={editTo} ro>
            {t('analysis.edit')}
          </Button>
        </div>
        {info?.wait && !info.restart && (
          <div className="analysis-stop-note">
            <Icon name="info" />
            <span>{info.wait}</span>
          </div>
        )}
        <div className="analysis-stop-note">
          <Icon name="check" />
          <span>
            {paidDone.length
              ? t('analysis.stop.paidList', { list: paidDone.join(', '), spent })
              : t('analysis.stop.paidNone', { spent })}
          </span>
        </div>
      </div>
    </div>
  );
}

/** Шаги остановленного анализа: ожидавшие и прерванные — «не выполнялся» (оплаченный — с ценой). */
export function stoppedSteps(steps: readonly Step[]): Step[] {
  return steps.map((s) =>
    s.state === 'pending' || s.state === 'running' ? { ...s, state: 'skipped' as const, detail_key: null, detail_params: {} } : s,
  );
}

export function StoppedCard({ analysis, steps, ctx }: { analysis: Analysis; steps: Step[]; ctx: StepContext }) {
  const { t } = useTranslation();
  const cancelled = analysis.status === 'cancelled';
  const failed = steps.find((s) => s.state === 'failed');
  const doneCount = steps.filter((s) => s.state === 'done' || s.state === 'skipped').length;
  // Шаги после места остановки на экране — «не выполнялся». Шаг, который шел в момент отмены
  // или сбоя (у сервера он так и остался running), — тоже: живого времени у него больше нет
  const shown = stoppedSteps(steps);
  return (
    <Card
      eyebrow={
        analysis.attempt > 1
          ? t('analysis.run.eyebrowAttempt', { id: analysisNumber(analysis.id), attempt: analysis.attempt })
          : t('analysis.run.eyebrow', { id: analysisNumber(analysis.id) })
      }
      title={cancelled ? t('analysis.stopped.cancelledTitle') : failed ? t('analysis.stopped.title', { n: failed.index + 1 }) : t('analysis.stopped.titleNoStep')}
      subtitle={cancelled ? t('analysis.stopped.cancelledSub') : t('analysis.stopped.sub')}
      actions={
        cancelled ? (
          <Chip kind="outline" icon="x">
            {t('analysis.stopped.cancelledChip')}
          </Chip>
        ) : (
          <Chip kind="bad" icon="alert">
            {t('analysis.stopped.chip')}
          </Chip>
        )
      }
    >
      <Numbers
        analysis={analysis}
        numbers={runNumbers(analysis)}
        lead={
          <span>
            {t('analysis.nums.doneSteps')} <b>{t('analysis.nums.stepOf', { n: doneCount, total: steps.length })}</b>
          </span>
        }
      />
      <StepTimeline steps={shown.map((s) => stepView(s, ctx, t))} label={t('analysis.steps.label')} stateLabels={STATE_LABELS(t)} />
    </Card>
  );
}

export function DoneCard({ analysis, steps, ctx, currency }: { analysis: Analysis; steps: Step[]; ctx: StepContext; currency: Currency }) {
  const { t } = useTranslation();
  const warnings = analysis.result?.warnings ?? [];
  return (
    <section className="card" aria-label={t('analysis.done.label')}>
      <div className="card-body">
        <div className="analysis-done-row">
          <Chip kind="good" icon="check">
            {t('analysis.done.chip')}
          </Chip>
          <Numbers
            analysis={analysis}
            numbers={runNumbers(analysis)}
            estimate
            lead={
              <span>
                {t('analysis.nums.steps')} <b>{steps.length}</b>
              </span>
            }
          />
        </div>
        {warnings.length > 0 && (
          <Callout kind="warn">
            <b>{t('analysis.done.warnTitle')}</b> {warningTexts(warnings, ctx.names, t, { currency }).join('. ')}.{' '}
            {t('analysis.done.warnTail')}
          </Callout>
        )}
        <Disclosure summary={(open) => (open ? t('analysis.done.hideSteps') : t('analysis.done.showSteps'))}>
          <StepTimeline steps={steps.map((s) => stepView(s, ctx, t))} label={t('analysis.steps.label')} stateLabels={STATE_LABELS(t)} />
        </Disclosure>
      </div>
    </section>
  );
}
