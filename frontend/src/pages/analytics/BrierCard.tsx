import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Chip, DataTable, EmptyState, Segmented, type DataColumn } from '../../components';
import { ChartWithTable, LineChart } from '../../components/charts';
import { brierView, mainRef, type BrierRef, type BrierView } from '../../features/analytics/accuracy';
import { brierDiff, brierText, ciDec3 } from '../../features/analytics/display';
import type { Analytics, BrierPoint } from '../../features/analytics/types';
import { formatDate } from '../../lib/format';
import { Howto, TableBox } from './parts';

// Brier модели против рынка (В2, brierCard макета): скользящее окно; «точнее рынка X из Y» —
// X = better, Y = windows (все окна, а не точки графика: их сервер прореживает до 200).
// Этап 5: переключатель «При прогнозе / Закрытие»; главный ряд — по ответу сервера (закрытие,
// когда закрытий больше), второй ряд — строкой под графиком.

function Verdict({ b }: { b: BrierView }) {
  const { t } = useTranslation();
  if (b.model === null || b.market === null || b.diff === null) return null;
  const params = {
    model: brierText(b.model),
    market: brierText(b.market),
    diff: brierDiff(b.diff),
    range: ciDec3(b.diffCi),
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

/**
 * Строка под графиком (этап 5): выбранный ряд и второй. «Главный ряд» — подпись ряда, который
 * главным назначил сервер (brier.main, В2: закрытие, когда закрытий больше), а не выбранного
 * переключателем; закрытию, пока оно не главное, — «станет главным, когда закрытий будет больше».
 */
function RefStrip({ b, main }: { b: BrierView; main: BrierRef }) {
  const { t } = useTranslation();
  const rows = [
    { ref: b.ref, n: b.n, model: b.model, market: b.market },
    { ref: b.other.ref, n: b.other.n, model: b.other.model, market: b.other.market },
  ];
  return (
    <dl className="analytics-strip analytics-strip-2">
      {rows.map((row) => {
        const name = t(`analytics.brier.ref.${row.ref}`);
        return (
          <div key={row.ref}>
            <dt>{row.ref === main ? t('analytics.brier.mainRow', { name }) : name}</dt>
            <dd>
              {row.market === null ? '—' : brierText(row.market)}
              <small>
                {row.n
                  ? t(row.ref === 'closing' && main !== 'closing' ? 'analytics.brier.rowSubClose' : 'analytics.brier.rowSub', {
                      model: brierText(row.model),
                      events: t('analytics.count.events', { count: row.n }),
                    })
                  : t('analytics.brier.rowNone')}
              </small>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function BrierCard({ data, mobile, pending, onExplain }: { data: Analytics; mobile: boolean; pending: boolean; onExplain: () => void }) {
  const { t } = useTranslation();
  const { thresholds } = data;
  const [chosen, setChosen] = useState<BrierRef | null>(null);
  const ref = chosen ?? mainRef(data.brier);
  const brier = brierView(data.brier, ref);
  const refName = t(`analytics.brier.ref.${ref}`);
  const head = {
    className: 'analytics-card',
    title: t('analytics.brier.title'),
    subtitle: t(ref === 'closing' ? 'analytics.brier.subtitleClose' : 'analytics.brier.subtitle', { window: thresholds.rolling_window }),
  };
  const refSwitch = (
    <Segmented<BrierRef>
      className="analytics-sample"
      label={t('analytics.brier.refLabel')}
      value={ref}
      onChange={setChosen}
      items={[
        { value: 'pred', label: t('analytics.brier.refPred', { n: data.brier.n }) },
        { value: 'closing', label: t('analytics.brier.refClose', { n: data.brier.closing_n }) },
      ]}
    />
  );
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
        {refSwitch}
        <EmptyState>
          {t(ref === 'closing' ? 'analytics.brier.fewClose' : 'analytics.brier.few', { need: thresholds.rolling_window + thresholds.rolling_step, n: brier.n })}
        </EmptyState>
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
      {refSwitch}
      <ChartWithTable
        pending={pending}
        legend={[
          { key: 'model', name: t('analytics.brier.legendModel', { value: brierText(lastPoint.model) }), color: 'var(--s1)' },
          { key: 'market', name: t('analytics.brier.legendRef', { name: refName, value: brierText(lastPoint.market) }), color: 'var(--s2)' },
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
            { key: 'market', name: refName, color: 'var(--s2)', values: points.map((p) => p.market) },
          ]}
          ariaLabel={t('analytics.brier.ariaRef', { model: brierText(lastPoint.model), name: refName.toLowerCase(), market: brierText(lastPoint.market) })}
          height={mobile ? 210 : 280}
          yFormat={(value) => brierText(value)}
          xFormat={(day) => formatDate(day)}
          tipTitle={(day) => t('analytics.brier.tipTitle', { window: thresholds.rolling_window, date: formatDate(day) })}
        />
      </ChartWithTable>
      <Verdict b={brier} />
      <RefStrip b={brier} main={mainRef(data.brier)} />
      <Howto>{t('analytics.brier.howto', { window: thresholds.rolling_window })}</Howto>
      <Button kind="ghost" size="sm" icon="book" className="chart-table-toggle" onClick={onExplain}>
        {t('analytics.explain.open')}
      </Button>
    </Card>
  );
}
