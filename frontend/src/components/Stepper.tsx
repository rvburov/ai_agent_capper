import { cx } from '../lib/cx';
import { Icon } from './Icon';
import './Stepper.css';

export interface StepperItem {
  label: string;
  /** Короткая подпись для узкого экрана (до 480 px); полная остается для читалки. */
  short?: string;
}

export interface StepperProps {
  items: readonly (StepperItem | string)[];
  /** Текущий шаг (0…); шаги до него — выполненные. */
  current: number;
  /** Подпись списка для читалки экрана. */
  label: string;
  /** Пометка выполненного шага для читалки: «готово». */
  doneLabel: string;
  /** line — шаги входа (числа и черта между ними), pills — «Ввод → Проверка → Анализ». */
  variant?: 'line' | 'pills';
  className?: string;
}

/** Шаги процесса: «Пароль → Код», «Ввод событий → Проверка → Анализ». */
export function Stepper({ items, current, label, doneLabel, variant = 'line', className }: StepperProps) {
  return (
    <ol className={cx('stepper', variant, className)} aria-label={label}>
      {items.map((raw, i) => {
        const item = typeof raw === 'string' ? { label: raw } : raw;
        const done = i < current;
        return (
          <li
            key={item.label}
            className={cx('stepper-item', done && 'done', i === current && 'current')}
            aria-current={i === current ? 'step' : undefined}
          >
            <span className="stepper-n" aria-hidden="true">
              {done ? <Icon name="check" /> : i + 1}
            </span>
            <span className="stepper-label">
              {item.short ? (
                <>
                  <span className="stepper-full">{item.label}</span>
                  <span className="stepper-short" aria-hidden="true">
                    {item.short}
                  </span>
                </>
              ) : (
                item.label
              )}
              {done && <span className="sr-only">{doneLabel}</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
