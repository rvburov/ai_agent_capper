import type { KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, Chip, EmptyState } from '../../components';
import { marketLabel } from '../../features/analysis/markets';
import { outcomeDescription } from '../../features/analytics/display';
import { sameOutcome, type AnalyticsFilters } from '../../features/analytics/filters';
import { filterLabel } from '../../features/analytics/insights';
import type { Analytics, Market } from '../../features/analytics/types';
import { formatNumber, formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { FootNote, Howto, RoiText, SmallMark } from './parts';

// «Сводка по рынкам» (marketTableCard макета): исходы по событиям как ординарам, строка «Все
// рынки»; нажатие на исход ставит фильтр market + selection на всю страницу, повторное — снимает.
// В узкой карточке — список кнопок вместо таблицы.

interface Row {
  key: string;
  market: Market | null;
  selection: number | null;
  label: string;
  desc: string | null;
  n: number;
  winrate: number;
  roi: number;
  avgOdds: number;
  small: boolean;
  total: boolean;
}

interface MarketTableProps {
  data: Analytics;
  filters: AnalyticsFilters;
  /** Выбрать исход (null — все рынки). */
  onPick: (market: Market | null, selection: number | null) => void;
}

export function MarketTable({ data, filters, onPick }: MarketTableProps) {
  const { t } = useTranslation();
  const rows: Row[] = data.slices.markets.map((g) => ({
    key: `${g.market}:${g.selection}`,
    market: g.market,
    selection: g.selection,
    label: marketLabel(g.market, g.selection),
    desc: outcomeDescription(t, g.market, g.selection),
    n: g.n,
    winrate: g.winrate,
    roi: g.roi,
    avgOdds: g.avg_odds,
    small: g.small,
    total: false,
  }));
  if (!rows.length) {
    return (
      <Card className="analytics-card" title={t('analytics.marketTable.title')}>
        <EmptyState>{t('analytics.slices.noEvents')}</EmptyState>
      </Card>
    );
  }
  const total = data.slices.markets_total;
  if (total) {
    rows.push({
      key: 'all',
      market: null,
      selection: null,
      label: t('analytics.marketTable.all'),
      desc: null,
      n: total.n,
      winrate: total.winrate,
      roi: total.roi,
      avgOdds: total.avg_odds,
      small: false,
      total: true,
    });
  }
  const isActive = (row: Row) => row.market !== null && row.selection !== null && sameOutcome(filters, row.market, row.selection) && filters.selection !== null;
  // повторное нажатие на выбранный исход и строка «Все рынки» снимают фильтр
  const pick = (row: Row) => (row.total || isActive(row) ? onPick(null, null) : onPick(row.market, row.selection));
  const hint = (row: Row) =>
    row.total
      ? t('analytics.marketTable.rowAll', { label: row.label })
      : isActive(row)
        ? t('analytics.marketTable.rowActive', { label: row.label })
        : t('analytics.marketTable.rowPick', { label: row.label });
  function onKeyDown(event: KeyboardEvent<HTMLTableRowElement>, row: Row) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    pick(row);
  }
  const selectedName = filters.market ? (filters.selection ? marketLabel(filters.market, filters.selection) : filterLabel(t, { market: filters.market })) : null;
  return (
    <Card
      className="analytics-card analytics-mkt-card"
      title={t('analytics.marketTable.title')}
      subtitle={t('analytics.marketTable.subtitle')}
      actions={
        selectedName ? (
          <Chip kind="accent" icon="filter">
            {t('analytics.marketTable.selected', { name: selectedName })}
          </Chip>
        ) : undefined
      }
    >
      <div className="analytics-mtable analytics-tablebox">
        <div className="table-wrap">
          <table className="table">
            <caption className="sr-only">{t('analytics.marketTable.title')}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: '40%' }}>
                  {t('analytics.marketTable.cols.market')}
                </th>
                <th scope="col" className="r">
                  {t('analytics.marketTable.cols.events')}
                </th>
                <th scope="col" className="r">
                  {t('analytics.marketTable.cols.winrate')}
                </th>
                <th scope="col" className="r">
                  {t('analytics.marketTable.cols.roi')}
                </th>
                <th scope="col" className="r">
                  {t('analytics.marketTable.cols.avgOdds')}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.key}
                  className={cx('clickable', row.total && 'is-total', isActive(row) && 'is-active')}
                  tabIndex={0}
                  aria-label={hint(row)}
                  onClick={() => pick(row)}
                  onKeyDown={(event) => onKeyDown(event, row)}
                >
                  <td>
                    <div className="analytics-min">
                      <div className="analytics-mname">
                        {row.label}
                        {row.small && <SmallMark n={data.thresholds.small_sample} />}
                      </div>
                      {row.desc && <div className="analytics-mdesc">{row.desc}</div>}
                    </div>
                  </td>
                  <td className="r">{formatNumber(row.n)}</td>
                  <td className="r">{formatPercent(row.winrate)}</td>
                  <td className="r">
                    <RoiText value={row.roi} />
                  </td>
                  <td className="r">
                    <span className="odds">{formatOdds(row.avgOdds)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <ul className="analytics-mlist" aria-label={t('analytics.marketTable.title')}>
        {rows.map((row) => (
          <li key={row.key}>
            <button type="button" className="analytics-mrow" aria-pressed={isActive(row)} aria-label={hint(row)} onClick={() => pick(row)}>
              <span>
                <span className="analytics-mname">
                  {row.label}
                  {row.small && <SmallMark n={data.thresholds.small_sample} />}
                </span>
                <span className="analytics-mrow-sub">
                  {t('analytics.marketTable.listSub', {
                    desc: row.total ? (filters.market ? t('analytics.marketTable.dropFilter') : t('analytics.marketTable.noFilter')) : row.desc,
                    events: t('analytics.count.events', { count: row.n }),
                  })}
                </span>
              </span>
              <span className="analytics-mrow-val">
                <RoiText value={row.roi} />
                <span className="analytics-mrow-sub">
                  {t('analytics.marketTable.listVal', { winrate: formatPercent(row.winrate, { digits: 0 }), odds: formatOdds(row.avgOdds) })}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      {rows.some((row) => row.small) && <FootNote>{t('analytics.small.note', { count: data.thresholds.small_sample })}</FootNote>}
      <Howto>{t('analytics.marketTable.howto')}</Howto>
    </Card>
  );
}
