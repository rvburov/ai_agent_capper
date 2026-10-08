import { Fragment, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface KeyValueItem {
  label: ReactNode;
  value: ReactNode;
  /** Ключ React, если подпись — не строка. */
  key?: string;
}

/** Пары «подпись — значение» (.kv, список dl): значения выровнены вправо. */
export function KeyValue({ items, className }: { items: KeyValueItem[]; className?: string }) {
  return (
    <dl className={cx('kv', className)}>
      {items.map((item, i) => (
        <Fragment key={item.key ?? (typeof item.label === 'string' ? item.label : i)}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}
