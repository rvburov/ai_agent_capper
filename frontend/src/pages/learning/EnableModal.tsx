import { useQueryClient } from '@tanstack/react-query';
import type { TFunction } from 'i18next';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Icon, KeyValue, Modal, Skeleton, useToast } from '../../components';
import { modelLabel } from '../../features/ai/models';
import { ci3, plural, quickView, reasonKey, signed3, type QuickView } from '../../features/learning/display';
import { learningKeys } from '../../features/learning/keys';
import {
  lessonsQuery,
  quickRunning,
  useLesson,
  useLessonAction,
  useQuickCheckPreview,
  useStartQuickCheck,
} from '../../features/learning/lessons';
import type { Lesson, LessonQuick, QuickCheck } from '../../features/learning/types';
import { formatNumber, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';

// «Урок … в анализ» (enableModal макета, В4): урок попадает в инструкции анализа только по
// кнопке администратора и после быстрой проверки — матчи набора с уроком и без через Batch из
// бюджета проверок. До запуска — цена по живым числам, худший случай и остаток бюджета (числа
// сервера); ход — опрос урока (quick), итог — разница лог-лосса с ДИ и ошибки формата.

type Translate = TFunction;
type StepState = 'wait' | 'run' | 'done' | 'fail';

const STEP_ICON = { wait: 'clock', run: 'refresh', done: 'check', fail: 'x' } as const;

function Steps({ steps }: { steps: readonly { key: string; state: StepState; text: string }[] }) {
  const { t } = useTranslation();
  return (
    <ol className="learning-steps" aria-label={t('learning.enable.stepsLabel')}>
      {steps.map((step) => (
        <li key={step.key} className={step.state}>
          <Icon name={STEP_ICON[step.state]} />
          <span>
            <span className="sr-only">{t(`learning.enable.stepState.${step.state}`)}. </span>
            {step.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function reasonText(code: string, t: Translate): string {
  const loose = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return loose(`learning.enable.reasons.${reasonKey(code)}`, { defaultValue: t('learning.enable.reasons.other') });
}

function quickErrorText(quick: LessonQuick, t: Translate): string {
  const loose = t as unknown as (key: string, options: { defaultValue: string }) => string;
  return quick.error ? loose(`learning.enable.errors.${reasonKey(quick.error)}`, { defaultValue: t('learning.enable.errors.other') }) : t('learning.enable.errors.other');
}

function Budget({ preview }: { preview: QuickCheck }) {
  const { t } = useTranslation();
  return (
    <KeyValue
      items={[
        {
          key: 'budget',
          label: t('learning.enable.budget'),
          value: t(preview.reserved_usd > 0 ? 'learning.enable.budgetValueReserved' : 'learning.enable.budgetValue', {
            spent: formatUsd(preview.spent_usd),
            total: formatUsd(preview.budget_usd, Number.isInteger(preview.budget_usd) ? 0 : 2),
            reserved: formatUsd(preview.reserved_usd),
            left: formatUsd(preview.left_usd),
          }),
        },
        { key: 'estimate', label: t('learning.enable.estimate'), value: t('learning.enable.approx', { amount: formatUsd(preview.estimate_usd) }) },
        {
          key: 'worst',
          label: t('learning.enable.worst'),
          value: t('learning.enable.worstValue', { amount: formatUsd(preview.worst_usd), requests: t('learning.enable.requests', { count: preview.requests }) }),
        },
        { key: 'active', label: t('learning.enable.active'), value: t('learning.enable.activeValue', { n: preview.active, max: preview.max_active }) },
      ]}
    />
  );
}

function introSteps(preview: QuickCheck | undefined, t: Translate) {
  const matches = preview ? plural(t, 'matches', preview.events) : '';
  const model = preview ? modelLabel(preview.model) : '';
  return [
    {
      key: 'run',
      state: 'wait' as const,
      text: preview?.baseline_reused
        ? t('learning.enable.introRunReused', { matches, model, reused: formatNumber(preview.baseline_reused) })
        : t('learning.enable.introRun', { matches, model }),
    },
    { key: 'compare', state: 'wait' as const, text: t('learning.enable.introCompare') },
    { key: 'decide', state: 'wait' as const, text: t('learning.enable.introDecide') },
  ];
}

function resultSteps(view: QuickView, quick: LessonQuick, t: Translate) {
  const checked = t('learning.enable.checked', { onMatches: plural(t, 'onMatches', quick.events), cost: formatUsd(quick.cost_usd) });
  const diff = quick.diff
    ? t('learning.enable.diff', { diff: signed3(quick.diff.value), ci: ci3(quick.diff), errors: formatNumber(quick.format_errors) })
    : t('learning.enable.diffNone', { errors: formatNumber(quick.format_errors), unrated: formatNumber(quick.unrated) });
  if (view === 'passed') {
    return [
      { key: 'run', state: 'done' as const, text: checked },
      { key: 'compare', state: 'done' as const, text: t('learning.enable.notWorse', { diff }) },
      { key: 'decide', state: 'run' as const, text: t('learning.enable.waitsYou') },
    ];
  }
  return [
    { key: 'run', state: 'done' as const, text: checked },
    { key: 'compare', state: 'fail' as const, text: t('learning.enable.worse', { diff }) },
    { key: 'decide', state: 'wait' as const, text: t('learning.enable.notEnabled') },
  ];
}

interface EnableModalProps {
  lesson: Lesson;
  onClose: () => void;
  /** Урок включен (окно уже закрыто): фокус — на выключатель карточки. */
  onEnabled?: (lesson: Lesson) => void;
}

export function EnableModal({ lesson: initial, onClose, onEnabled }: EnableModalProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const lessonQuery = useLesson(initial.id, { poll: true, initial });
  const lesson = lessonQuery.data ?? initial;
  const preview = useQuickCheckPreview(lesson.id);
  const start = useStartQuickCheck(lesson.id);
  const enable = useLessonAction('enable');
  const [error, setError] = useState<string | null>(null);
  // запустили здесь — ход виден сразу, не дожидаясь опроса урока
  const [started, setStarted] = useState(false);
  let view = quickView(lesson);
  // проверку уже запустил другой администратор (предпросмотр знает ее прогон) — показываем ход
  const previewRunning = preview.data?.status === 'pending' || preview.data?.status === 'running';
  if (view === 'intro' && ((started && start.isSuccess) || previewRunning)) view = 'running';
  const quick = lesson.quick;
  const client = useQueryClient();
  // урок в кэше еще без хода (проверку запустили не здесь): перечитать — включится опрос
  const lessonRunning = quickRunning(lesson);
  useEffect(() => {
    if (previewRunning && !lessonRunning) void client.invalidateQueries({ queryKey: learningKeys.lesson(lesson.id) });
  }, [client, lesson.id, previewRunning, lessonRunning]);
  // проверка закончилась, пока окно открыто: список уроков, плитки и главная — заново
  const wasRunning = useRef(view === 'running');
  useEffect(() => {
    if (wasRunning.current && view !== 'running') {
      void client.invalidateQueries({ queryKey: learningKeys.lessons });
      void client.invalidateQueries({ queryKey: learningKeys.quickCheck(lesson.id) });
    }
    wasRunning.current = view === 'running';
  }, [client, lesson.id, view]);

  function run() {
    setError(null);
    start.mutate(undefined, {
      onSuccess: () => {
        setStarted(true);
        void lessonQuery.refetch();
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  function turnOn() {
    setError(null);
    enable.mutate(lesson.id, {
      onSuccess: (saved) => {
        onClose();
        onEnabled?.(saved);
        // уроков в анализе — по свежему списку (как в макете: «уроков в анализе N из 15»)
        void client
          .fetchQuery(lessonsQuery())
          .then((list) => t('learning.enable.toastOnCount', { code: saved.code, n: list.active, max: list.max_active }))
          .catch(() => t('learning.enable.toastOn', { code: saved.code }))
          .then((text) => toast.show(text, { icon: 'check', duration: 5000 }));
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }

  function later() {
    onClose();
    toast.show(t('learning.enable.toastLater', { code: lesson.code }), { icon: 'clock' });
  }

  let steps;
  let footer;
  if (view === 'running') {
    steps = [
      { key: 'run', state: 'run' as const, text: t('learning.enable.sent', { requests: t('learning.enable.requests', { count: quick?.requests ?? preview.data?.requests ?? 0 }) }) },
      { key: 'compare', state: 'wait' as const, text: t('learning.enable.compare') },
      { key: 'decide', state: 'wait' as const, text: t('learning.enable.decide') },
    ];
    footer = (
      <Button kind="secondary" onClick={onClose}>
        {t('learning.enable.closeWait')}
      </Button>
    );
  } else if ((view === 'passed' || view === 'worse') && quick) {
    steps = resultSteps(view, quick, t);
    footer =
      view === 'passed' ? (
        <>
          <Button kind="secondary" onClick={later}>
            {t('learning.enable.notNow')}
          </Button>
          <Button kind="primary" icon="check" loading={enable.isPending} onClick={turnOn}>
            {t('learning.enable.turnOn')}
          </Button>
        </>
      ) : (
        <Button kind="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      );
  } else {
    steps = introSteps(preview.data, t);
    const can = preview.data?.can_run === true;
    footer = (
      <>
        <Button kind="secondary" onClick={onClose}>
          {t('learning.enable.cancel')}
        </Button>
        <Button kind="primary" icon="play" disabled={!can} loading={start.isPending} onClick={run}>
          {preview.data ? t(view === 'failed' ? 'learning.enable.runAgain' : 'learning.enable.run', { amount: formatUsd(preview.data.estimate_usd) }) : t('learning.enable.runPlain')}
        </Button>
      </>
    );
  }

  const blocked = view !== 'running' && view !== 'passed' && preview.data && !preview.data.can_run && preview.data.reason;
  // отказ сервера при запуске (409) повторяет свежую причину предпросмотра или «уже идет» —
  // тогда показываем только ее или ход проверки
  const shownError = error && !blocked && view !== 'running' ? error : null;
  return (
    <Modal open onClose={onClose} title={t('learning.enable.title', { code: lesson.code })} className="learning-modal" footer={footer}>
      <blockquote className="learning-quote">{lesson.text}</blockquote>
      {preview.isPending ? (
        <Skeleton lines={3} />
      ) : preview.data ? (
        <Budget preview={preview.data} />
      ) : (
        <p className="small muted" role="alert">
          {errorMessage(preview.error)}
        </p>
      )}
      <div aria-live="polite" className={cx('learning-steps-box', view === 'running' && 'is-running')}>
        <Steps steps={steps} />
        {view === 'running' && <p className="xsmall muted learning-steps-note">{t('learning.enable.runningNote')}</p>}
      </div>
      {view === 'failed' && quick && (
        <Callout kind="bad" icon="alert" role="status">
          <b>{t('learning.enable.failedTitle')} </b>
          {quickErrorText(quick, t)}
        </Callout>
      )}
      {view === 'worse' && (
        <Callout kind="warn" icon="alert" role="status">
          {t('learning.enable.worseText')}
        </Callout>
      )}
      {blocked && (
        <Callout kind="warn" icon="alert" role="status">
          {reasonText(blocked, t)}
        </Callout>
      )}
      {shownError && (
        <Callout kind="bad" icon="alert" role="alert">
          {shownError}
        </Callout>
      )}
      <Callout kind="info" icon="info">
        {t('learning.enable.shared')}
      </Callout>
    </Modal>
  );
}
