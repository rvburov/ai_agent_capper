import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { DataTable, Icon, type DataColumn, type DataTableProps } from '../../components';
import { ciPct, signClass, signedPct } from '../../features/analytics/display';
import type { Ci } from '../../features/analytics/types';
import { cx } from '../../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';

// Мелкие части «Аналитики» (howto, smallMark, footNote, section, roiText, ciCell макета).

/** «Как читать: …» внизу карточки. */
export function Howto({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="analytics-howto">
      <Icon name="info" />
      <span>
        <b>{t('analytics.howto')}</b> {children}
      </span>
    </div>
  );
}

/** Метка «мало данных» у среза (меньше n событий или ставок): значок с подсказкой, для читалки — текст. */
export function SmallMark({ n, unit = 'events' }: { n: number; unit?: 'events' | 'bets' }) {
  const { t } = useTranslation();
  return (
    <span className="analytics-small" title={unit === 'bets' ? t('analytics.small.titleBets', { count: n }) : t('analytics.small.title', { count: n })}>
      <Icon name="alert" />
      <span className="sr-only">{t('analytics.small.sr')}</span>
    </span>
  );
}

/** Сноска со значком предупреждения. */
export function FootNote({ children, plain = false }: { children: ReactNode; plain?: boolean }) {
  return (
    <div className={cx('analytics-foot-note', plain && 'plain')}>
      {!plain && <Icon name="alert" />}
      <span>{children}</span>
    </div>
  );
}

/** Заголовок раздела страницы: «Где стратегия зарабатывает». */
export function Section({ title, text }: { title: string; text?: string }) {
  return (
    <div className="analytics-section">
      <div className="analytics-min">
        <h3>{title}</h3>
        {text && <p>{text}</p>}
      </div>
    </div>
  );
}

/** ROI со знаком и цветом: «+12,4%». */
export function RoiText({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  return <span className={cx(signClass(value), 'analytics-bold', 'analytics-nowrap')}>{signedPct(value)}</span>;
}

/**
 * 95% ДИ в таблице: «−8…+16%», приглушенно. В узкой колонке переносится после «…», а не
 * раздвигает таблицу шире карточки.
 */
export function CiCell({ ci }: { ci: Ci | null | undefined }) {
  const { t } = useTranslation();
  const text = ciPct(ci);
  const cut = text.indexOf('…') + 1;
  return (
    <span className="analytics-ci muted" title={t('analytics.ciTitle')}>
      {cut > 0 ? (
        <>
          {text.slice(0, cut)}
          <wbr />
          {text.slice(cut)}
        </>
      ) : (
        text
      )}
    </span>
  );
}

/**
 * ROI среза и под ним 95% ДИ — на телефоне и планшете (до 960 px), где отдельной колонки ДИ
 * нет: таблица помещается в карточку без прокрутки вбок, а интервал не теряется.
 */
export function RoiCiCell({ roi, ci }: { roi: number | null | undefined; ci: Ci | null | undefined }) {
  if (roi === null || roi === undefined) return <RoiText value={roi} />;
  return (
    <span className="analytics-roi-ci">
      <RoiText value={roi} />
      <CiCell ci={ci} />
    </span>
  );
}

/** Таблица в рамке (tableBox макета). */
export function TableBox({ children, scroll = false }: { children: ReactNode; scroll?: boolean }) {
  return <div className={scroll ? 'analytics-scroll' : 'analytics-tablebox'}>{children}</div>;
}

interface FitTableProps<Row> extends Omit<DataTableProps<Row>, 'columns' | 'mobileLayout'> {
  /** Колонки; compact — сжатый вид (колонки hideMobile убираются, см. FitTable). */
  columns: (compact: boolean) => readonly DataColumn<Row>[];
}

/**
 * Таблица в рамке не шире своей карточки. Если полные колонки не помещаются — на телефоне
 * и планшете (до 960 px) или в узкой колонке из двух карточек (1181–1366 px), — таблица
 * переходит в сжатый вид: без колонок hideMobile, а columns(true) может свести числа в одну
 * ячейку (ДИ под ROI). Сжатый вид держится, пока рамка не станет шире той, где полный не
 * поместился.
 */
export function FitTable<Row>({ columns, ...table }: FitTableProps<Row>) {
  const narrow = useMediaQuery(MOBILE_QUERY);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  // Самая широкая рамка, в которую полная таблица не поместилась
  const [overflowAt, setOverflowAt] = useState(0);
  const compact = narrow || (width > 0 && width <= overflowAt);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    if (el.clientWidth !== width) setWidth(el.clientWidth);
    if (compact) return;
    const wrap = el.querySelector<HTMLElement>('.table-wrap');
    // скрытая таблица («Показать таблицей» еще не нажата) ширины не имеет
    if (wrap && wrap.clientWidth > 0 && wrap.scrollWidth > wrap.clientWidth + 1) setOverflowAt((at) => Math.max(at, el.clientWidth));
  });

  const all = columns(compact);
  return (
    <div ref={box} className="analytics-tablebox">
      <DataTable {...table} columns={compact ? all.filter((column) => !column.hideMobile) : all} mobileLayout="table" />
    </div>
  );
}
