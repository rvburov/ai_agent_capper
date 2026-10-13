import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Chip, DataTable, EmptyState, type DataColumn } from '../../components';
import { ChartWithTable, LineChart } from '../../components/charts';
import { brierDiff, brierText, ciDec3 } from '../../features/analytics/display';
import type { Analytics, BrierPoint } from '../../features/analytics/types';
import { formatDate } from '../../lib/format';
import { Howto, TableBox } from './parts';

// Brier модели против рынка (В2, brierCard макета): главный ряд — рынок при прогнозе без маржи,
// скользящее окно; «точнее рынка X из Y» — X = brier.better, Y = brier.windows (все окна, а не
// точки графика: их сервер прореживает до 200). Рынок закрытия — отдельной строкой.

function Verdict({ data }: { data: Analytics }) {
  const { t } = useTranslation();
  const b = data.brier;
  if (b.model === null || b.market === null || b.diff === null) return null;
  const params = {
    model: brierText(b.model),
    market: brierText(b.market),
    diff: brierDiff(b.diff),
    range: ciDec3(b.diff_ci),
    events: t('analytics.count.events', { count: b.n }),
    eventsLoc: t('analytics.count.eventsLoc', { count: b.n }),
  };
  if (b.noise !== false) {
    return (
      <Callout kind="neutral" icon="info">
        <b>{t('analytics.brier.forPeriod')} </b>
        {t('analytics.brier.noise', params)}
      </Callout>
    );
  }
  if (b.diff < 0) {
    return (
      <Callout kind="good" icon="check">
        <b>{t('analytics.brier.forPeriod')} </b>
        {t('analytics.brier.modelBetter', params)}
      </Callout>
    );
  }
  return (
    <Callout kind="warn" icon="alert">
      <b>{t('analytics.brier.forPeriod')} </b>
      {t('analytics.brier.marketBetter', params)}
    </Callout>
  );
}

export function BrierCard({ data, mobile, pending, onExplain }: { data: Analytics; mobile: boolean; pending: boolean; onExplain: () => void }) {
  const { t } = useTranslation();
  const { brier, thresholds } = data;
  const head = {
    className: 'analytics-card',
    title: t('analytics.brier.title'),
    subtitle: t('analytics.brier.subtitle', { window: thresholds.rolling_window }),
  };
  if (data.calibration.kind === 'claude') {
    return (
      <Card {...head}>
        <EmptyState>{t('analytics.brier.legacy')}</EmptyState>
      </Card>
    );
  }
  const points = brier.points;
  const lastPoint = points[points.length - 1];
  if (points.length < 2 || !lastPoint) {
    return (
      <Card {...head}>
        <EmptyState>{t('analytics.brier.few', { need: thresholds.rolling_window + thresholds.rolling_step, n: brier.n })}</EmptyState>
        <Howto>{t('analytics.brier.howtoShort')}</Howto>
      </Card>
    );
  }
  const good = brier.better * 2 >= brier.windows;
  const columns: DataColumn<BrierPoint>[] = [
    { key: 'day', label: t('analytics.brier.cols.day'), render: (p) => <span className="analytics-nowrap">{formatDate(p.day)}</span> },
    { key: 'model', label: t('analytics.brier.cols.model'), align: 'r', render: (p) => brierText(p.model) },
    { key: 'market', label: t('analytics.brier.cols.market'), align: 'r', render: (p) => brierText(p.market) },
    {
      key: 'diff',
      label: t('analytics.brier.cols.diff'),
      align: 'r',
      render: (p) => (
        <span className={p.model < p.market ? 'good-text' : p.model > p.market ? 'bad-text' : undefined}>{brierDiff(p.model - p.market)}</span>
      ),
    },
  ];
  return (
    <Card
      {...head}
      actions={
        <span title={t('analytics.brier.betterTitle', { window: thresholds.rolling_window })}>
          <Chip kind={good ? 'good' : 'warn'} icon={good ? 'check' : 'alert'}>
            {t('analytics.brier.better', { x: brier.better, y: brier.windows })}
          </Chip>
        </span>
      }
    >
      <ChartWithTable
        pending={pending}
        legend={[
          { key: 'model', name: t('analytics.brier.legendModel', { value: brierText(lastPoint.model) }), color: 'var(--s1)' },
          { key: 'market', name: t('analytics.brier.legendMarket', { value: brierText(lastPoint.market) }), color: 'var(--s2)' },
        ]}
        table={() => (
          <TableBox scroll>
            <DataTable columns={columns} rows={points.slice().reverse()} rowKey={(p) => p.day} caption={t('analytics.brier.title')} mobileLayout="table" />
          </TableBox>
        )}
      >
        <LineChart
          labels={points.map((p) => p.day)}
          series={[
            { key: 'model', name: t('analytics.brier.seriesModel'), color: 'var(--s1)', values: points.map((p) => p.model) },
            { key: 'market', name: t('analytics.brier.seriesMarket'), color: 'var(--s2)', values: points.map((p) => p.market) },
          ]}
          ariaLabel={t('analytics.brier.aria', { model: brierText(lastPoint.model), market: brierText(lastPoint.market) })}
          height={mobile ? 210 : 280}
          yFormat={(value) => brierText(value)}
          xFormat={(day) => formatDate(day)}
          tipTitle={(day) => t('analytics.brier.tipTitle', { window: thresholds.rolling_window, date: formatDate(day) })}
        />
      </ChartWithTable>
      <Verdict data={data} />
      <dl className="analytics-strip analytics-strip-2">
        <div>
          <dt>{t('analytics.brier.atPred')}</dt>
          <dd>
            {brierText(brier.market)}
            <small>{t('analytics.brier.atPredSub', { events: t('analytics.count.events', { count: brier.n }) })}</small>
          </dd>
        </div>
        <div>
          <dt>{t('analytics.brier.closing')}</dt>
          <dd>
            {brier.closing_market === null ? '—' : brierText(brier.closing_market)}
            <small>
              {brier.closing_n
                ? t('analytics.brier.closingSub', { model: brierText(brier.closing_model), events: t('analytics.count.events', { count: brier.closing_n }) })
                : t('analytics.brier.closingNone')}
            </small>
          </dd>
        </div>
      </dl>
      <Howto>{t('analytics.brier.howto', { window: thresholds.rolling_window })}</Howto>
      <Button kind="ghost" size="sm" icon="book" className="chart-table-toggle" onClick={onExplain}>
        {t('analytics.explain.open')}
      </Button>
    </Card>
  );
}
