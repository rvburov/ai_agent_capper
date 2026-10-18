import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, Chip, EmptyState, SurfaceChip, isSurface, surfaceColor, type DataColumn } from '../../components';
import { ChartWithTable, HBars, type HBarItem } from '../../components/charts';
import { familyOf, formatShare } from '../../features/analysis/markets';
import { familyTitle } from '../../features/markets/status';
import { oddsRange, signClass, signedPct } from '../../features/analytics/display';
import type { AnalyticsFilters } from '../../features/analytics/filters';
import type { Analytics, OddsSlice, SurfaceSlice, SurfaceFilter, TotalSlice } from '../../features/analytics/types';
import { currencyOf } from '../../features/bets/display';
import { formatMoney, formatNumber, formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { CiCell, FitTable, FootNote, Howto, RoiCiCell, RoiText, SmallMark } from './parts';

// ROI по срезам (surfaceCard, marketCard, oddsCard, totalCard макета): события как ординары на
// равную сумму (Р21) по покрытиям, исходам и кэфу события; реальные ставки — по итоговому кэфу.
// У каждого среза 95% ДИ и метка «мало данных» — от сервера (small), своих порогов нет.

const pctText = (value: number) => signedPct(value);

/** Цвет покрытия (токен); «не указано» — приглушенный. */
function surfaceTone(surface: SurfaceFilter): string {
  return isSurface(surface) ? surfaceColor(surface) : 'var(--fg-3)';
}

/** Подпись полосы: цветной квадрат, название (выбранное — жирнее, другие — бледнее), «мало данных». */
function BarLabel({ color, name, picked, dim, small }: { color: string; name: string; picked: boolean; dim: boolean; small: number | null }) {
  return (
    <>
      <i className="analytics-dot" style={{ background: color }} aria-hidden="true" />
      {/* название из двух слов («Не указано») на узком телефоне переносится, а не обрезается */}
      <span className={cx('hbar-name', picked && 'analytics-picked', dim && 'muted', name.includes(' ') && 'analytics-hbar-wrap')}>{name}</span>
      {small !== null && <SmallMark n={small} />}
    </>
  );
}

function sliceItem(
  key: string,
  label: string,
  slice: { n: number; roi: number; roi_ci: { low: number; high: number } | null; small: boolean },
  color: string,
  picked: boolean,
  dim: boolean,
  note: ReactNode,
  threshold: number,
): HBarItem {
  // выбранное в фильтре значение подсвечено, остальные приглушены (цвет на 30%)
  const fill = dim ? `color-mix(in srgb, ${color} 30%, var(--surface))` : color;
  return {
    key,
    label,
    value: slice.roi,
    color: fill,
    note,
    ci: slice.roi_ci ? [slice.roi_ci.low, slice.roi_ci.high] : null,
    labelNode: <BarLabel color={fill} name={label} picked={picked} dim={dim} small={slice.small ? threshold : null} />,
  };
}

interface SliceProps {
  data: Analytics;
  filters: AnalyticsFilters;
  pending: boolean;
}

/**
 * Первая колонка таблицы среза в сжатом виде (FitTable): название и под ним число событий или
 * ставок — отдельной колонки числа там нет.
 */
function NameWithCount({ name, count }: { name: ReactNode; count: string | null }) {
  if (count === null) return <>{name}</>;
  return (
    <span className="analytics-cell-count">
      {name}
      <small className="muted">{count}</small>
    </span>
  );
}

/**
 * Колонки ROI и 95% ДИ таблицы среза. В сжатом виде отдельной колонки ДИ нет — он второй
 * строкой под ROI. shown — у строки есть ставки (иначе ROI — прочерк).
 */
function roiColumns<Row>(
  t: TFunction,
  compact: boolean,
  roi: (row: Row) => number | null,
  ci: (row: Row) => { low: number; high: number } | null,
  shown: (row: Row) => boolean = () => true,
): DataColumn<Row>[] {
  return [
    {
      key: 'roi',
      label: compact ? t('analytics.slices.cols.roiCi') : t('analytics.slices.cols.roi'),
      align: 'r',
      render: (row) => (!shown(row) ? '—' : compact ? <RoiCiCell roi={roi(row)} ci={ci(row)} /> : <RoiText value={roi(row)} />),
    },
    { key: 'ci', label: t('analytics.slices.cols.ci'), align: 'r', hideMobile: true, render: (row) => <CiCell ci={ci(row)} /> },
  ];
}

export function SurfaceCard({ data, filters, pending }: SliceProps) {
  const { t } = useTranslation();
  const groups = data.slices.surfaces;
  const total = groups.reduce((sum, g) => sum + g.n, 0);
  const missing = (['hard', 'clay', 'grass'] as const).filter((s) => !groups.some((g) => g.surface === s));
  const name = (s: SurfaceFilter) => t(`analytics.surfaces.${s}`);
  const items = groups.map((g) =>
    sliceItem(
      g.surface,
      name(g.surface),
      g,
      surfaceTone(g.surface),
      filters.surface === g.surface,
      filters.surface !== null && filters.surface !== g.surface,
      t('analytics.count.events', { count: g.n }),
      data.thresholds.small_sample,
    ),
  );
  const columns = (compact: boolean): DataColumn<SurfaceSlice>[] => [
    {
      key: 'surface',
      label: t('analytics.slices.cols.surface'),
      render: (g) => (
        <NameWithCount
          name={isSurface(g.surface) ? <SurfaceChip surface={g.surface} /> : <Chip kind="outline">{name(g.surface)}</Chip>}
          count={compact ? t('analytics.count.events', { count: g.n }) : null}
        />
      ),
    },
    { key: 'n', label: t('analytics.slices.cols.events'), align: 'r', hideMobile: true, render: (g) => formatNumber(g.n) },
    { key: 'winrate', label: t('analytics.slices.cols.winrate'), align: 'r', render: (g) => formatPercent(g.winrate) },
    { key: 'odds', label: t('analytics.slices.cols.avgOdds'), align: 'r', hideMobile: true, render: (g) => <span className="odds">{formatOdds(g.avg_odds)}</span> },
    ...roiColumns<SurfaceSlice>(t, compact, (g) => g.roi, (g) => g.roi_ci),
  ];
  return (
    <Card
      className="analytics-card"
      title={t('analytics.slices.surfaceTitle')}
      subtitle={t('analytics.slices.surfaceSubtitle')}
      actions={<Chip kind="outline">{t('analytics.count.events', { count: total })}</Chip>}
    >
      {groups.length ? (
        <ChartWithTable
          pending={pending}
          table={() => (
            <FitTable columns={columns} rows={groups} rowKey={(g) => g.surface} caption={t('analytics.slices.surfaceTitle')} />
          )}
        >
          <HBars items={items} ariaLabel={t('analytics.slices.surfaceTitle')} valueFormat={pctText} />
        </ChartWithTable>
      ) : (
        <EmptyState>{t('analytics.slices.noEvents')}</EmptyState>
      )}
      {groups.some((g) => g.small) && <FootNote>{t('analytics.small.note', { count: data.thresholds.small_sample })}</FootNote>}
      {groups.length > 0 && missing.length > 0 && (
        <FootNote plain>{t('analytics.slices.missing', { list: missing.map(name).join(', ') })}</FootNote>
      )}
      <Howto>{t('analytics.slices.surfaceHowto')}</Howto>
    </Card>
  );
}

export function MarketCard({ data, filters, pending }: SliceProps) {
  const { t } = useTranslation();
  // Р28: ROI по рынкам — по семействам (все исходы и линии рынка)
  const groups = data.slices.families;
  const total = groups.reduce((sum, g) => sum + g.n, 0);
  const picked = filters.family ?? (filters.market ? familyOf(filters.market) : null);
  const items = groups.map((g) =>
    sliceItem(
      g.family,
      familyTitle(g.family),
      g,
      'var(--s1)',
      picked === g.family,
      picked !== null && picked !== g.family,
      t('analytics.count.events', { count: g.n }),
      data.thresholds.small_sample,
    ),
  );
  return (
    <Card
      className="analytics-card"
      title={t('analytics.slices.marketTitle')}
      subtitle={t('analytics.slices.marketSubtitle')}
      actions={<Chip kind="outline">{t('analytics.count.events', { count: total })}</Chip>}
    >
      {groups.length ? (
        <div className={cx('chart-block', pending && 'pending')}>
          <HBars items={items} ariaLabel={t('analytics.slices.marketTitle')} valueFormat={pctText} />
        </div>
      ) : (
        <EmptyState>{t('analytics.slices.noEvents')}</EmptyState>
      )}
      {groups.some((g) => g.small) && <FootNote>{t('analytics.small.note', { count: data.thresholds.small_sample })}</FootNote>}
      <Howto>{t('analytics.slices.marketHowto')}</Howto>
    </Card>
  );
}

export function OddsCard({ data, pending }: SliceProps) {
  const { t } = useTranslation();
  const groups = data.slices.odds;
  const label = (g: OddsSlice) => oddsRange(g.low, g.high) ?? '—';
  const items = groups.map((g) => sliceItem(g.low, label(g), g, 'var(--s1)', false, false, t('analytics.count.events', { count: g.n }), data.thresholds.small_sample));
  const columns = (compact: boolean): DataColumn<OddsSlice>[] => [
    { key: 'range', label: t('analytics.slices.cols.odds'), render: (g) => <span className="odds analytics-nowrap">{label(g)}</span> },
    { key: 'n', label: t('analytics.slices.cols.events'), align: 'r', hideMobile: true, render: (g) => formatNumber(g.n) },
    { key: 'winrate', label: t('analytics.slices.cols.winrate'), align: 'r', render: (g) => formatPercent(g.winrate) },
    // «для нуля» — доля выигрышей, при которой средний кэф диапазона выходит в ноль: 1 / кэф
    { key: 'need', label: t('analytics.slices.cols.need'), align: 'r', render: (g) => <span className="muted">{g.avg_odds > 0 ? formatPercent(1 / g.avg_odds) : '—'}</span> },
    ...roiColumns<OddsSlice>(t, compact, (g) => g.roi, (g) => g.roi_ci),
  ];
  const total = groups.reduce((sum, g) => sum + g.n, 0);
  return (
    <Card
      className="analytics-card"
      title={t('analytics.slices.oddsTitle')}
      subtitle={t('analytics.slices.oddsSubtitle')}
      actions={<Chip kind="outline">{t('analytics.count.events', { count: total })}</Chip>}
    >
      {groups.length ? (
        <ChartWithTable
          pending={pending}
          table={() => (
            <FitTable columns={columns} rows={groups} rowKey={(g) => g.low} caption={t('analytics.slices.oddsTitle')} />
          )}
        >
          <HBars items={items} ariaLabel={t('analytics.slices.oddsTitle')} valueFormat={pctText} />
        </ChartWithTable>
      ) : (
        <EmptyState>{t('analytics.slices.noEvents')}</EmptyState>
      )}
      {groups.some((g) => g.small) && <FootNote>{t('analytics.small.note', { count: data.thresholds.small_sample })}</FootNote>}
      <Howto>{t('analytics.slices.oddsHowto')}</Howto>
    </Card>
  );
}

export function TotalCard({ data, pending }: SliceProps) {
  const { t } = useTranslation();
  const groups = data.slices.totals;
  const currency = currencyOf(data.currency);
  const label = (g: TotalSlice) => oddsRange(g.low, g.high) ?? t('analytics.slices.outside');
  const first = groups.find((g) => g.low !== null);
  const triple = groups.find((g) => g.triple);
  const items: HBarItem[] = groups.map((g) => ({
    key: g.low ?? 'outside',
    label: label(g),
    value: g.roi ?? 0,
    ...(g.bets ? {} : { valueText: '—' }),
    color: 'var(--s1)',
    note: g.bets ? t('analytics.count.bets', { count: g.bets }) : t('analytics.slices.noBets'),
    ci: g.roi_ci ? [g.roi_ci.low, g.roi_ci.high] : null,
    labelNode: (
      <>
        <i className="analytics-dot" style={{ background: 'var(--s1)' }} aria-hidden="true" />
        {/* «Вне таблицы» на узком телефоне переносится на вторую строку, а не обрезается до «Вне табл…» */}
        <span className={cx('hbar-name', !g.bets && 'muted', g.low === null && 'analytics-hbar-wrap')}>{label(g)}</span>
        {g.bets > 0 && g.small && <SmallMark n={data.thresholds.small_sample} unit="bets" />}
      </>
    ),
  }));
  const columns = (compact: boolean): DataColumn<TotalSlice>[] => [
    {
      key: 'range',
      label: t('analytics.slices.cols.odds'),
      render: (g) => (
        <NameWithCount
          name={
            // диапазон не переносится, «Вне таблицы» в узкой колонке — на две строки
            <span className={cx('odds', g.low !== null && 'analytics-nowrap')} title={g.triple ? t('analytics.slices.tripleTitle') : undefined}>
              {label(g)}
            </span>
          }
          count={compact ? t('analytics.count.bets', { count: g.bets }) : null}
        />
      ),
    },
    { key: 'bets', label: t('analytics.slices.cols.bets'), align: 'r', hideMobile: true, render: (g) => formatNumber(g.bets) },
    {
      key: 'pct',
      label: t('analytics.slices.cols.stake'),
      align: 'r',
      hideMobile: true,
      render: (g) => (
        <span className="analytics-nowrap" title={t('analytics.slices.stakeTitle')}>
          {g.stake_pct === null ? '—' : formatShare(g.stake_pct)}
        </span>
      ),
    },
    {
      key: 'profit',
      label: t('analytics.slices.cols.profit'),
      align: 'r',
      render: (g) => (
        <span className={cx(signClass(g.profit), 'analytics-bold', 'analytics-nowrap')}>{formatMoney(g.profit, currency, { signed: true })}</span>
      ),
    },
    ...roiColumns<TotalSlice>(t, compact, (g) => g.roi, (g) => g.roi_ci, (g) => g.bets > 0),
  ];
  const hasBets = groups.some((g) => g.bets > 0 || g.voids > 0);
  return (
    <Card
      className="analytics-card"
      title={t('analytics.slices.totalTitle')}
      subtitle={t('analytics.slices.totalSubtitle')}
      actions={<Chip kind="outline">{t('analytics.count.bets', { count: data.kpi.settled })}</Chip>}
    >
      {hasBets ? (
        <ChartWithTable
          pending={pending}
          table={() => (
            <FitTable columns={columns} rows={groups} rowKey={(g) => g.low ?? 'outside'} caption={t('analytics.slices.totalTitle')} />
          )}
        >
          <HBars items={items} ariaLabel={t('analytics.slices.totalTitle')} valueFormat={pctText} />
        </ChartWithTable>
      ) : (
        <EmptyState>{t('analytics.slices.noBetsPeriod')}</EmptyState>
      )}
      {groups.some((g) => g.bets > 0 && g.small) && <FootNote>{t('analytics.small.noteBets', { count: data.thresholds.small_sample })}</FootNote>}
      <Howto>
        {t('analytics.slices.totalHowto', {
          triple: triple ? (oddsRange(triple.low, triple.high) ?? '—') : '—',
          high: first?.high ? formatOdds(first.high) : '—',
          pct: first?.stake_pct ? formatShare(first.stake_pct) : '—',
        })}
      </Howto>
    </Card>
  );
}

