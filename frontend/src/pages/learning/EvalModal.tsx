import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import { Button, Callout, Dropdown, Field, FieldShell, Icon, Modal, Skeleton, useToast } from '../../components';
import { modelLabel } from '../../features/ai/models';
import type { EvalPlan, EvalRun, StrategyVersion } from '../../features/learning/types';
import { ciNum3, dec3, reasonText, runErrorText, signed3 } from '../../features/learning/versionView';
import { runActive, useCancelEval, useEvalPlan, useEvalRun, useStartEval } from '../../features/learning/versions';
import { formatDate, formatNumber, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';

// «Оценить версию на наборе» (evalModal макета, Т8, В2): что прогнать (активная — повтор для
// порога шума, кандидат); до запуска — пакеты, цена по прошлым прогонам, худший случай и
// остаток бюджета проверок (план сервера); запуск — кодом 2FA. Ход — опросом прогона: пакетов
// собрано, потрачено, «Остановить»; итог — метрики прогона. Сравнение — в окне «Сравнить».

const OTP_ERRORS = new Set(['admin.totp_required', 'admin.totp_invalid']);
const OTP_ID = 'learning-eval-otp';

function Plan({ plan }: { plan: EvalPlan }) {
  const { t } = useTranslation();
  const b = plan.budget;
  const set = plan.eval_set;
  const usd = (value: number) => formatUsd(value, Number.isInteger(value) ? 0 : 2);
  const budget = [
    t(b.reserved_usd > 0 ? 'learning.eval.budgetReserved' : 'learning.eval.budgetValue', {
      spent: formatUsd(b.spent_usd),
      total: usd(b.budget_usd),
      reserved: formatUsd(b.reserved_usd),
      left: formatUsd(b.left_usd),
    }),
    b.first_month && b.next_usd !== b.budget_usd ? t('learning.eval.budgetNext', { next: usd(b.next_usd) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const items = [
    {
      key: 'set',
      label: t('learning.eval.set'),
      value: set
        ? t('learning.eval.setValue', { code: set.code, matches: t('learning.plural.matches', { count: plan.events, n: formatNumber(plan.events) }) })
        : '—',
    },
    {
      key: 'how',
      label: t('learning.eval.how'),
      value: t('learning.eval.howValue', { chunks: t('learning.eval.chunks', { count: plan.chunks }), size: plan.batch_size, model: modelLabel(plan.model) }),
    },
    {
      key: 'repeat',
      label: t('learning.eval.repeat'),
      value: t(plan.repeat_no > 1 ? 'learning.eval.repeatValueN' : 'learning.eval.repeatValue1', { n: plan.repeat_no }),
    },
    // цена — средняя прошлых ответов проверок (live) или, пока их нет, по ценам модели (settings)
    plan.estimate_source === 'live'
      ? { key: 'estimate', label: t('learning.eval.estimate'), value: t('learning.eval.approx', { amount: formatUsd(plan.estimate_usd) }) }
      : { key: 'estimate', label: t('learning.eval.estimateSettings'), value: t('learning.eval.approxSettings', { amount: formatUsd(plan.estimate_usd) }) },
    {
      key: 'worst',
      label: t('learning.eval.worst'),
      // как считает сервер: (матчи набора + пакет повтора истекших и сбойных) × худший на матч
      value: t(plan.retry_events > 0 ? 'learning.eval.worstValueRetry' : 'learning.eval.worstValue', {
        amount: formatUsd(plan.worst_usd),
        n: formatNumber(plan.events),
        retries: t('learning.eval.retries', { count: plan.retry_events, n: formatNumber(plan.retry_events) }),
        per: formatUsd(plan.per_event_worst_usd),
        tokens: formatNumber(plan.max_tokens / 1000, 0),
        chunk: formatUsd(plan.worst_chunk_usd),
      }),
    },
    { key: 'budget', label: t('learning.eval.budget'), value: budget },
  ];
  // подписи длинные («Цена по прошлым прогонам»), значения — фразы: столбец подписей шире,
  // на телефоне — подпись над значением (как «Подробнее» урока)
  return (
    <dl className="learning-facts learning-plan">
      {items.map((item) => (
        <div key={item.key}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function RunProgress({ run }: { run: EvalRun }) {
  const { t } = useTranslation();
  const active = runActive(run);
  const m = run.metrics;
  const steps: { key: string; state: 'wait' | 'run' | 'done' | 'fail'; text: string }[] = [];
  if (active) {
    steps.push({
      key: 'chunks',
      state: 'run',
      text: t('learning.eval.chunksDone', {
        done: run.chunks_done,
        total: run.chunks_total,
        events: t('learning.plural.matches', { count: run.events, n: formatNumber(run.events) }),
      }),
    });
    steps.push({ key: 'cost', state: 'run', text: t('learning.eval.spent', { cost: formatUsd(run.cost_usd), worst: formatUsd(run.worst_usd) }) });
    if (run.waiting) steps.push({ key: 'waiting', state: 'wait', text: reasonText(run.waiting, t) });
    steps.push({ key: 'compare', state: 'wait', text: t('learning.eval.compareNext') });
  } else if (run.status === 'done' && m) {
    steps.push({ key: 'chunks', state: 'done', text: t('learning.eval.doneEvents', { n: formatNumber(m.n), total: formatNumber(m.total), cost: formatUsd(run.cost_usd) }) });
    steps.push({
      key: 'metrics',
      state: 'done',
      text: t('learning.eval.metrics', { ll: dec3(m.log_loss), brier: dec3(m.brier), errors: formatNumber(m.format_errors) }),
    });
    if (m.vs_market) steps.push({ key: 'market', state: 'done', text: t('learning.eval.vsMarket', { diff: signed3(m.vs_market.value), ci: ciNum3(m.vs_market) }) });
    steps.push({ key: 'compare', state: 'done', text: t('learning.eval.compareReady') });
  } else {
    steps.push({ key: 'fail', state: 'fail', text: runErrorText(run, t) });
    steps.push({ key: 'cost', state: 'done', text: t('learning.eval.spentFinal', { cost: formatUsd(run.cost_usd) }) });
  }
  const icon = { wait: 'clock', run: 'refresh', done: 'check', fail: 'x' } as const;
  return (
    <div aria-live="polite" className={cx('learning-steps-box', active && 'is-running')}>
      <ol className="learning-steps" aria-label={t('learning.eval.stepsLabel')}>
        {steps.map((step) => (
          <li key={step.key} className={step.state}>
            <Icon name={icon[step.state]} />
            <span>{step.text}</span>
          </li>
        ))}
      </ol>
      {active && <p className="xsmall muted learning-steps-note">{t('learning.eval.runningNote')}</p>}
    </div>
  );
}

interface EvalModalProps {
  /** Версии инструкций: прогнать можно активную и кандидатов. */
  versions: readonly StrategyVersion[];
  /** Идущий прогон: окно сразу показывает его ход. */
  runId: number | null;
  onClose: () => void;
}

export function EvalModal({ versions, runId: initialRun, onClose }: EvalModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const open = versions.filter((version) => version.status === 'active' || version.status === 'candidate');
  const firstCandidate = open.find((version) => version.status === 'candidate') ?? open[0] ?? null;
  const [versionId, setVersionId] = useState<number | null>(firstCandidate?.id ?? null);
  const [code, setCode] = useState('');
  const [otpError, setOtpError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runId, setRunId] = useState<number | null>(initialRun);
  const plan = useEvalPlan(versionId, { enabled: runId === null });
  const run = useEvalRun(runId);
  const start = useStartEval();
  const cancel = useCancelEval();
  const otpRef = useRef<HTMLInputElement>(null);
  // неверный код: ошибка у поля и фокус в нем — ввести новый код сразу
  const focusOtp = () => requestAnimationFrame(() => otpRef.current?.focus());

  function launch() {
    setError(null);
    if (!/^\d{6}$/.test(code)) {
      setOtpError(t('learning.eval.otpError'));
      focusOtp();
      return;
    }
    if (versionId === null) return;
    start.mutate(
      { versionId, totp: code },
      {
        onSuccess: (started) => {
          setRunId(started.id);
          toast.show(t('learning.eval.toastStarted', { chunks: t('learning.eval.chunks', { count: started.chunks_total }) }), { icon: 'clock', duration: 5000 });
        },
        onError: (failure) => {
          if (isApiError(failure) && OTP_ERRORS.has(failure.code)) {
            setCode('');
            setOtpError(errorMessage(failure));
            focusOtp();
          } else setError(errorMessage(failure));
        },
      },
    );
  }

  function stop(id: number) {
    setError(null);
    cancel.mutate(id, {
      onSuccess: (saved) => toast.show(t('learning.eval.stopped', { code: saved.version_code ?? '' }), { icon: 'pause' }),
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  let body;
  let footer;
  if (runId !== null) {
    const current = run.data;
    body = current ? <RunProgress run={current} /> : run.isError ? <p className="small muted" role="alert">{errorMessage(run.error)}</p> : <Skeleton lines={3} />;
    const canceling = current?.waiting === 'eval.canceling';
    footer =
      current && runActive(current) ? (
        <>
          {!canceling && (
            <Button kind="secondary" icon="pause" loading={cancel.isPending} onClick={() => stop(current.id)}>
              {t('learning.eval.stop')}
            </Button>
          )}
          <Button kind="primary" onClick={onClose}>
            {t('learning.eval.closeWait')}
          </Button>
        </>
      ) : (
        <Button kind="primary" onClick={onClose}>
          {t('common.close')}
        </Button>
      );
  } else {
    const data = plan.data;
    const blocked = data && !data.can_run ? data.reason : null;
    body = (
      <>
        <FieldShell id="learning-eval-version" label={t('learning.eval.what')}>
          <Dropdown<string>
            id="learning-eval-version"
            label={t('learning.eval.what')}
            options={open.map((version) => ({
              value: String(version.id),
              label: t(version.status === 'active' ? 'learning.eval.optionActive' : 'learning.eval.optionCandidate', { code: version.code }),
            }))}
            value={versionId === null ? null : String(versionId)}
            onChange={(value) => {
              setVersionId(Number(value));
              setError(null);
            }}
          />
        </FieldShell>
        {plan.isPending ? (
          <Skeleton lines={4} />
        ) : data ? (
          <Plan plan={data} />
        ) : (
          <p className="small muted" role="alert">
            {errorMessage(plan.error)}{' '}
            <Button kind="ghost" size="sm" icon="refresh" onClick={() => void plan.refetch()}>
              {t('common.retry')}
            </Button>
          </p>
        )}
        {blocked ? (
          <Callout kind="bad" icon="alert" role="status">
            {reasonText(blocked, t, { since: formatDate(data?.set_seen_since), lesson: data?.overlap_lesson ?? '' })}
          </Callout>
        ) : (
          <Callout kind="info" icon="info">
            {t('learning.eval.fromBudget')}
          </Callout>
        )}
        <Field
          ref={otpRef}
          id={OTP_ID}
          label={t('learning.eval.otp')}
          hint={t('learning.eval.otpHint')}
          error={otpError}
          value={code}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          onChange={(event) => {
            setCode(event.target.value.replace(/\D/g, '').slice(0, 6));
            setOtpError(null);
          }}
        />
      </>
    );
    footer = (
      <>
        <Button kind="secondary" onClick={onClose}>
          {t('learning.eval.cancel')}
        </Button>
        <Button kind="primary" icon="play" disabled={!data?.can_run} loading={start.isPending} onClick={launch}>
          {t('learning.eval.run')}
        </Button>
      </>
    );
  }

  const title = runId !== null && run.data ? t('learning.eval.runTitle', { code: run.data.version_code ?? '—', set: run.data.eval_set_code }) : t('learning.eval.title');
  return (
    <Modal open onClose={onClose} title={title} className="learning-modal" footer={footer}>
      {body}
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </Modal>
  );
}
