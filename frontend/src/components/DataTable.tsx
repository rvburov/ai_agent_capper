import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import { MOBILE_QUERY, SHEET_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import { EmptyState } from './EmptyState';
import { KeyValue } from './KeyValue';

export interface DataColumn<Row> {
  key: string;
  label: string;
  /** Значение ячейки; без render берется row[key]. */
  render?: (row: Row) => ReactNode;
  align?: 'r' | 'c';
  width?: string;
  /** На телефоне колонка скрыта (как hideMobile в макете). */
  hideMobile?: boolean;
  /** Заголовок карточки на телефоне; по умолчанию — первая колонка. */
  primary?: boolean;
  /** Подпись в заголовке только для читалки экрана (столбец кнопок, как sr-only в макете). */
  hideLabel?: boolean;
}

export interface DataTableProps<Row> {
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string | number;
  onRowClick?: (row: Row) => void;
  /** Текст, когда строк нет. */
  empty?: ReactNode;
  /** Подпись таблицы для читалки экрана. */
  caption?: string;
  /** Своя карточка строки на телефоне (как карточки ставок в макете). */
  renderCard?: (row: Row) => ReactNode;
  /** 'table' — на телефоне остается таблица с прокруткой. */
  mobileLayout?: 'cards' | 'table';
  className?: string;
}

function cellValue<Row>(column: DataColumn<Row>, row: Row): ReactNode {
  if (column.render) return column.render(row);
  const value = (row as Record<string, unknown>)[column.key];
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Таблица (.table). До 960 px скрывает колонки с hideMobile, до 720 px превращается
 * в список карточек: заголовок — главная колонка, остальное — пары «подпись — значение».
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  empty,
  caption,
  renderCard,
  mobileLayout = 'cards',
  className,
}: DataTableProps<Row>) {
  const { t } = useTranslation();
  const narrow = useMediaQuery(MOBILE_QUERY);
  const phone = useMediaQuery(SHEET_QUERY);
  const visible = narrow ? columns.filter((c) => !c.hideMobile) : columns;
  const emptyText = empty ?? t('common.noData');

  if (phone && mobileLayout === 'cards') {
    if (!rows.length) return <EmptyState className={className}>{emptyText}</EmptyState>;
    const primary = visible.find((c) => c.primary) ?? visible[0];
    const rest = visible.filter((c) => c !== primary);
    return (
      <ul className={cx('dt-cards', className)} aria-label={caption}>
        {rows.map((row) => {
          const body = renderCard ? (
            renderCard(row)
          ) : (
            <>
              {primary && <div className="dt-card-title">{cellValue(primary, row)}</div>}
              {rest.length > 0 && (
                <KeyValue
                  items={rest.map((c) => ({ key: c.key, label: c.label, value: cellValue(c, row) }))}
                />
              )}
            </>
          );
          return (
            <li key={rowKey(row)}>
              {onRowClick ? (
                <button type="button" className="dt-card" onClick={() => onRowClick(row)}>
                  {body}
                </button>
              ) : (
                <div className="dt-card">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: Row) {
    if (!onRowClick || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    onRowClick(row);
  }

  return (
    <div className={cx('table-wrap', className)}>
      <table className="table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {visible.map((c) => (
              <th key={c.key} className={c.align} style={c.width ? { width: c.width } : undefined} scope="col">
                {c.hideLabel ? <span className="sr-only">{c.label}</span> : c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length ? (
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={onRowClick ? 'clickable' : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={onRowClick ? (event) => onRowKeyDown(event, row) : undefined}
              >
                {visible.map((c) => (
                  <td key={c.key} className={c.align}>
                    {cellValue(c, row)}
                  </td>
                ))}
              </tr>
            ))
          ) : (
            <tr>
              <td colSpan={visible.length}>
                <EmptyState>{emptyText}</EmptyState>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
