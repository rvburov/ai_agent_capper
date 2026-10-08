import type { ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface SegmentedItem<V extends string> {
  value: V;
  label: ReactNode;
}

export interface SegmentedProps<V extends string> {
  items: readonly SegmentedItem<V>[];
  value: V;
  onChange: (value: V) => void;
  /** Подпись группы для читалки экрана. */
  label: string;
  className?: string;
}

/** Переключатель из нескольких вариантов (.segmented): период, вид, тема. */
export function Segmented<V extends string>({ items, value, onChange, label, className }: SegmentedProps<V>) {
  return (
    <div className={cx('segmented', className)} role="group" aria-label={label}>
      {items.map((item) => (
        <button
          key={item.value}
          type="button"
          aria-pressed={item.value === value}
          onClick={() => {
            if (item.value !== value) onChange(item.value);
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
