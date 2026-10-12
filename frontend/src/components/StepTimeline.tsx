import type { ReactNode } from 'react';

import { cx } from '../lib/cx';
import { Icon } from './Icon';
import './StepTimeline.css';

export type TimelineState = 'pending' | 'active' | 'done' | 'failed' | 'warn' | 'skipped';

export interface TimelineStep {
  key: string;
  title: ReactNode;
  /** Метка справа от названия: модель или «без ИИ». */
  chip?: ReactNode;
  /** Что сделано (видно у выполненного шага). */
  detail?: ReactNode;
  /** Строка под деталями: «Оценка Claude из анализа …» (видна, пока шаг не ожидает). */
  note?: ReactNode;
  /** Причина сбоя (failed) или предупреждение (warn). */
  message?: ReactNode;
  /** Справа: «12 с · 2 400 ток. · $0,004» или «ожидает». */
  meta?: ReactNode;
  state: TimelineState;
}

export interface StepTimelineProps {
  steps: readonly TimelineStep[];
  /** Подпись списка для читалки экрана. */
  label: string;
  /** Состояния для читалки: «готово», «выполняется»… */
  stateLabels: Record<TimelineState, string>;
  id?: string;
  hidden?: boolean;
  className?: string;
}

/**
 * Ход по шагам (stepEl в mockup/js/screens/analysis.js): ожидает, идет (кольцо), готово
 * (галочка), не выполнен (красный крестик), с предупреждением, не выполнялся.
 */
export function StepTimeline({ steps, label, stateLabels, id, hidden, className }: StepTimelineProps) {
  return (
    <ol className={cx('timeline', className)} aria-label={label} id={id} hidden={hidden}>
      {steps.map((step, i) => (
        <li key={step.key} className={cx('timeline-step', `is-${step.state}`)}>
          <span className="timeline-ic" aria-hidden="true">
            {step.state === 'done' ? (
              <Icon name="check" />
            ) : step.state === 'failed' ? (
              <Icon name="x" />
            ) : step.state === 'warn' ? (
              <Icon name="alert" />
            ) : (
              <span className="timeline-n">{i + 1}</span>
            )}
          </span>
          <div className="timeline-main">
            <div className="timeline-title">
              <span>{step.title}</span>
              {step.chip}
              <span className="sr-only">{stateLabels[step.state]}</span>
            </div>
            {step.detail && <div className="timeline-detail">{step.detail}</div>}
            {step.note && <div className="timeline-note">{step.note}</div>}
            {step.message && <div className="timeline-message">{step.message}</div>}
          </div>
          <div className="timeline-meta">{step.meta}</div>
        </li>
      ))}
    </ol>
  );
}
