import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Chip, Modal } from '../../components';
import { baseText, ci3, conditionText, dec3, historyReason, plural, quickState, signed3 } from '../../features/learning/display';
import { usePublicCasesMin } from '../../features/learning/lessons';
import type { Lesson } from '../../features/learning/types';
import { formatDate, formatInterval, formatNumber, formatPp, formatUsd } from '../../lib/format';
import { LessonChip, shiftText } from './LessonCard';

// «Подробнее» об уроке (lessonModal макета): откуда он, основание, проверка на архиве с ДИ,
// отложенная часть, поправка с усадкой, быстрая проверка и условие из словаря. Свои ставки в
// основании видит только их владелец (Т21): сервер присылает только их.

type Translate = TFunction;

/** Быстрая проверка словами — тем же разбором, что окно включения (quickState). */
function quickText(lesson: Lesson, t: Translate): string | null {
  const quick = lesson.quick;
  const state = quickState(lesson);
  if (!quick || state === 'none') return null;
  if (state === 'running') return t('learning.detail.quickRunning');
  if (state === 'failed') return t('learning.detail.quickFailed');
  const diff = quick.diff
    ? t('learning.detail.quickDiff', { diff: signed3(quick.diff.value), ci: ci3(quick.diff) })
    : '';
  const params = {
    count: quick.events,
    events: formatNumber(quick.events),
    diff,
    cost: formatUsd(quick.cost_usd),
    date: formatDate(quick.finished_at),
  };
  if (state === 'worse') return t('learning.detail.quickWorse', params);
  const passed = t('learning.detail.quickPassed', params);
  // прошла «не хуже», но после нее урок выключали или перепроверили на истории — для
  // включения нужна новая быстрая проверка
  if (state === 'reset') return t('learning.detail.quickReset', { passed });
  if (state === 'stale') return t('learning.detail.quickStale', { passed });
  return passed;
}

function facts(lesson: Lesson, shrinkK: number | null, min: number, t: Translate): [string, ReactNode][] {
  const out: [string, ReactNode][] = [];
  const history = lesson.history;
  out.push([t('learning.detail.from'), t(`learning.detail.origin.${lesson.origin}`)]);
  if (lesson.own_bets.length) {
    out.push([t('learning.detail.ownBets'), t('learning.detail.ownBetsValue', { bets: lesson.own_bets.map((id) => t('learning.detail.betNo', { id })).join(', ') })]);
  }
  out.push([t('learning.detail.kind'), t(`learning.detail.kindValue.${lesson.kind}`)]);
  out.push([
    t('learning.detail.base'),
    lesson.status === 'hypothesis' ? t('learning.detail.baseNeed', { base: baseText(lesson, t, min), need: lesson.need_cases }) : baseText(lesson, t, min),
  ]);
  if (history?.bias) {
    out.push([
      t('learning.detail.bias'),
      t('learning.detail.biasValue', {
        bias: formatPp(history.bias.value, { zero: '±' }),
        ci: formatInterval(history.bias.low, history.bias.high, (v) => formatPp(v, { unit: false })),
        onMatches: plural(t, 'onMatches', history.n_history),
      }),
    ]);
  }
  if (history && history.log_loss_with !== null && history.log_loss_without !== null && history.gain) {
    out.push([
      t('learning.detail.archive'),
      t('learning.detail.archiveValue', {
        with: dec3(history.log_loss_with),
        without: dec3(history.log_loss_without),
        gain: signed3(history.gain.value),
        ci: ci3(history.gain),
      }),
    ]);
  }
  if (history?.holdout_gain) {
    out.push([
      t('learning.detail.holdout'),
      t(history.holdout_since ? 'learning.detail.holdoutValue' : 'learning.detail.holdoutValueNoDate', {
        gain: signed3(history.holdout_gain.value),
        ci: ci3(history.holdout_gain),
        onMatches: plural(t, 'onMatches', history.n_holdout),
        date: formatDate(history.holdout_since),
      }),
    ]);
  }
  const reason = lesson.status === 'rejected' ? historyReason(history?.reason) : null;
  if (reason) out.push([t('learning.detail.reason'), t(`learning.lessons.historyReason.${reason}`)]);
  // Поправка с усадкой: n — случаи истории архива (history.n_shrink), одно и то же для всех,
  // поэтому формула сходится с числами и у участника
  const shift = lesson.kind === 'numeric' ? shiftText(lesson, t) : null;
  if (shift && lesson.effect !== null) {
    const nShrink = history?.n_shrink ?? 0;
    const value = formatPp(lesson.effect_shrunk, { zero: '±' });
    out.push([
      t('learning.detail.shift'),
      nShrink > 0 && shrinkK !== null
        ? t('learning.detail.shiftValue', { shift: value, raw: formatPp(lesson.effect, { zero: '±' }), n: formatNumber(nShrink), k: formatNumber(shrinkK) })
        : t('learning.detail.shiftValueShort', { shift: value, raw: formatPp(lesson.effect, { zero: '±' }) }),
    ]);
  }
  const quick = quickText(lesson, t);
  if (quick) out.push([t('learning.detail.quick'), quick]);
  if (lesson.rechecked_at) out.push([t('learning.detail.recheck'), t('learning.detail.recheckValue', { date: formatDate(lesson.rechecked_at) })]);
  return out;
}

interface LessonModalProps {
  lesson: Lesson;
  /** Усадка k из настроек (GET /api/lessons). */
  shrinkK: number | null;
  onClose: () => void;
}

export function LessonModal({ lesson, shrinkK, onClose }: LessonModalProps) {
  const min = usePublicCasesMin();
  const { t } = useTranslation();
  // направление поправки — только у урока про вероятность (как чипы карточки)
  const conditions = lesson.scope
    ? [
        ...(lesson.kind === 'numeric' ? [t(`learning.scope.direction.${lesson.scope.direction}`)] : []),
        ...lesson.scope.conditions.map((condition) => conditionText(condition, t)),
      ]
    : [];
  return (
    <Modal
      open
      onClose={onClose}
      title={t('learning.detail.title', { code: lesson.code })}
      className="learning-modal"
      footer={
        <Button kind="secondary" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="row">
        <LessonChip lesson={lesson} />
        {lesson.status === 'confirmed' &&
          (lesson.in_prompt ? (
            <Chip kind="accent" icon="book">
              {t('learning.lessons.inPrompt')}
            </Chip>
          ) : (
            <Chip kind="outline" icon="eyeOff">
              {t('learning.detail.off')}
            </Chip>
          ))}
      </div>
      <blockquote className="learning-quote">{lesson.text}</blockquote>
      <dl className="learning-facts">
        {facts(lesson, shrinkK, min, t).map(([label, value]) => (
          <div key={label} className="learning-fact">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {conditions.length > 0 ? (
        <div className="learning-cond-box">
          <div className="eyebrow">{t('learning.detail.condTitle')}</div>
          <pre className="learning-code">{conditions.join('\n')}</pre>
        </div>
      ) : (
        <p className="small soft">{t('learning.detail.noScope')}</p>
      )}
      <Callout kind="neutral" icon="shield">
        {t('learning.detail.safety')}
      </Callout>
    </Modal>
  );
}
