import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Card, Chip, DataTable, EmptyState, type DataColumn } from '../../components';
import { CHART_MUTED, ChartWithTable, ColumnChart, type ColumnItem } from '../../components/charts';
import { ciPct1, noisy, signClass, signedPct } from '../../features/analytics/display';
import type { Analytics, ClvBin } from '../../features/analytics/types';
import { formatNumber, formatPercent, formatPercentNumber } from '../../lib/format';
import { Howto, TableBox } from './parts';

// Распределение CLV (В1, clvCard макета): столбцы по 1 п.п., средний CLV с 95% ДИ и CLV без
// маржи по событиям с обеими сторонами закрытия. Ставки старого бота не входят (В5).

/** Границы столбца целыми процентами со знаком, «%» — в подписи: «+2», «−1», «0». */
function pp(value: number): string {
  return formatPercentNumber(value, { signed: true });
}

function binLabel(bin: ClvBin, t: TFunction): string {
  if (bin.open_low) return t('analytics.clv.binTo', { to: pp(bin.high) });
  if (bin.open_high) return t('analytics.clv.binFrom', { from: pp(bin.low) });
  return t('analytics.clv.bin', { from: pp(bin.low), to: pp(bin.high) });
}

export function ClvCard({ data, mobile, pending }: { data: Analytics; mobile: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const { clv, kpi } = data;
  const legacy = data.calibration.kind === 'claude';
  if (!clv.n) {
    return (
      <Card className="analytics-card" title={t('analytics.clv.title')}>
        <EmptyState>{legacy ? t('analytics.clv.legacy') : t('analytics.clv.none')}</EmptyState>
      </Card>
    );
  }
  const notWorse = clv.n - clv.negative;
  const items: ColumnItem[] = clv.bins.map((bin) => {
    const color = bin.low < 0 ? CHART_MUTED : 'var(--s1)';
    return {
      key: String(bin.low),
      label: t('analytics.clv.tipTitle', { range: binLabel(bin, t) }),
      short: bin.open_high ? t('analytics.clv.shortFrom', { from: pp(bin.low) }) : pp(bin.low),
      value: bin.n,
      color,
      tip: [
        { key: 'n', name: t('analytics.clv.bets'), value: formatNumber(bin.n), color },
        { key: 'share', name: t('analytics.clv.share'), value: formatPercent(bin.share, { digits: 0 }) },
      ],
    };
  });
  const columns: DataColumn<ClvBin>[] = [
    { key: 'range', label: t('analytics.clv.cols.range'), render: (bin) => <span className="analytics-nowrap">{binLabel(bin, t)}</span> },
    { key: 'n', label: t('analytics.clv.cols.bets'), align: 'r', render: (bin) => formatNumber(bin.n) },
    { key: 'share', label: t('analytics.clv.cols.share'), align: 'r', render: (bin) => formatPercent(bin.share, { digits: 0 }) },
  ];
  const avg = kpi.clv;
  const noise = noisy(kpi.clv_ci);
  return (
    <Card
      className="analytics-card"
      title={t('analytics.clv.title')}
      subtitle={t('analytics.clv.subtitle')}
      actions={
        avg !== null ? (
          <Chip kind={noise ? 'outline' : avg > 0 ? 'good' : 'bad'} icon={avg > 0 ? 'arrowUp' : 'arrowDown'}>
            {t('analytics.clv.avgChip', { value: signedPct(avg) })}
          </Chip>
        ) : undefined
      }
    >
      <ChartWithTable
        pending={pending}
        legend={[
          { key: 'pos', name: t('analytics.clv.legendPos', { n: notWorse }), color: 'var(--s1)', type: 'box' },
          { key: 'neg', name: t('analytics.clv.legendNeg', { n: clv.negative }), color: CHART_MUTED, type: 'box' },
        ]}
        table={() => (
          <TableBox>
            <DataTable columns={columns} rows={clv.bins} rowKey={(bin) => String(bin.low)} caption={t('analytics.clv.title')} mobileLayout="table" />
          </TableBox>
        )}
      >
        <ColumnChart
          items={items}
          ariaLabel={t('analytics.clv.aria', { value: signedPct(avg) })}
          height={mobile ? 190 : 220}
          valueFormat={(value) => formatNumber(value)}
          integer
          seriesName={t('analytics.clv.bets')}
        />
      </ChartWithTable>
      <dl className="analytics-strip analytics-strip-2">
        <div>
          <dt>{t('analytics.clv.avgLabel')}</dt>
          <dd className={signClass(avg)}>
            {signedPct(avg)}
            <small>
              {[
                // интервала нет (меньше 2 ставок с закрытием) — ни «—», ни «в пределах шума»
                ...(kpi.clv_ci ? [ciPct1(kpi.clv_ci), ...(noise ? [t('analytics.clv.noise')] : [])] : []),
                t('analytics.count.bets', { count: clv.n }),
              ].join(' · ')}
            </small>
          </dd>
        </div>
        <div>
          <dt>{t('analytics.clv.fairLabel')}</dt>
          <dd className={signClass(clv.fair_mean)}>
            {clv.fair_mean === null ? '—' : signedPct(clv.fair_mean)}
            <small>{clv.fair_n ? t('analytics.clv.fairSub', { events: t('analytics.count.events', { count: clv.fair_n }) }) : t('analytics.clv.fairNone')}</small>
          </dd>
        </div>
      </dl>
      <Howto>{t('analytics.clv.howto')}</Howto>
    </Card>
  );
}
