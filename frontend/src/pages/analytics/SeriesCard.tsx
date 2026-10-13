import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Card, Chip, DataTable, type DataColumn } from '../../components';
import { ChartWithTable, LineChart, type ValueFormat } from '../../components/charts';
import { capitalize, periodStart, signClass } from '../../features/analytics/display';
import type { Analytics, SeriesRow } from '../../features/analytics/types';
import type { Bank } from '../../features/bank/types';
import { currencyOf } from '../../features/bets/display';
import { currencySign, formatDate, formatDateLong, formatDateRange, formatMoney, formatNumber, formatPercent, stepDigits } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Howto, RoiText, TableBox } from './parts';

// Банк по дням (без фильтров рынка, покрытия и источника) или результат отобранных ставок
// нарастающим итогом (bankCard макета): график с опорной линией, таблица по неделям или
// месяцам, полоса итогов. Банк на начало и дни до его появления — по periodStart, как на главной.

function lastDayOfMonth(day: string): string {
  const [y, m] = day.split('-').map(Number);
  return new Date(Date.UTC(y ?? 2000, m ?? 1, 0)).toISOString().slice(0, 10);
}

/** «Октябрь», «Октябрь 2025», текущий неполный месяц — «Октябрь (по 13 окт)». */
function rowLabel(row: SeriesRow, group: 'week' | 'month', today: string, t: TFunction): string {
  if (group === 'week') return formatDateRange(row.date_from, row.date_to);
  const months: readonly string[] = t('bets.months', { returnObjects: true });
  const [year, month] = row.date_from.split('-');
  const name = months[Number(month) - 1] ?? row.date_from.slice(0, 7);
  const withYear = year !== today.slice(0, 4) ? `${name} ${year}` : name;
  return row.date_to < lastDayOfMonth(row.date_from) ? t('analytics.series.monthUntil', { month: withYear, date: formatDate(row.date_to) }) : withYear;
}

interface SeriesCardProps {
  data: Analytics;
  /** Банк из GET /api/me/bank: стартовый банк и рост к нему (null — еще грузится). */
  bank: Bank | null;
  ctx: string;
  mobile: boolean;
  pending: boolean;
}

export function SeriesCard({ data, bank, ctx, mobile, pending }: SeriesCardProps) {
  const { t } = useTranslation();
  const { series, kpi } = data;
  const isBank = series.kind === 'bank';
  const currency = currencyOf(data.currency);
  const digits = currency === 'RUB' ? 0 : 2;
  const money = (value: string | number) => formatMoney(value, currency);
  const signed = (value: string | number) => formatMoney(value, currency, { signed: true });
  // Подписи без знака валюты — он в подзаголовке; у результата — со знаком
  const yFormat: ValueFormat = (value, axis) =>
    formatNumber(value, axis ? Math.min(digits, stepDigits(axis.step)) : digits, { signed: !isBank });
  const start = periodStart(series, kpi.profit, data.period === 'all', bank);
  const values = start.points.map((point) => Number(point.value));
  const last = start.points[start.points.length - 1]?.value ?? series.last;
  const profit = Number(kpi.profit);

  const columns: DataColumn<SeriesRow>[] = [
    {
      key: 'label',
      label: series.group === 'week' ? t('analytics.series.cols.week') : t('analytics.series.cols.month'),
      // подпись недели или месяца переносится по словам, а не раздвигает таблицу на телефоне
      render: (row) => rowLabel(row, series.group, data.date_to, t),
    },
    { key: 'bets', label: t('analytics.series.cols.bets'), align: 'r', hideMobile: true, render: (row) => formatNumber(row.bets) },
    {
      key: 'profit',
      label: t('analytics.series.cols.profit'),
      align: 'r',
      render: (row) => <span className={cx(signClass(row.profit), 'analytics-bold', 'analytics-nowrap')}>{signed(row.profit)}</span>,
    },
    { key: 'roi', label: t('analytics.series.cols.roi'), align: 'r', hideMobile: true, render: (row) => <RoiText value={row.roi} /> },
    {
      key: 'end',
      label: isBank ? t('analytics.series.cols.bankEnd') : t('analytics.series.cols.resultEnd'),
      align: 'r',
      render: (row) => <span className="analytics-nowrap">{isBank ? money(row.end) : signed(row.end)}</span>,
    },
  ];

  const strip: { key: string; label: string; value: string; sub?: string }[] = isBank
    ? [
        { key: 'start', label: t('analytics.series.start'), value: money(start.amount), sub: formatDate(start.day) },
        { key: 'peak', label: t('analytics.series.peak'), value: money(series.peak) },
        {
          key: 'dd',
          label: t('analytics.series.drawdown'),
          value: series.max_drawdown < 0 ? formatPercent(series.max_drawdown, { signed: true }) : formatPercent(0, { digits: 0 }),
          sub: t('analytics.series.fromPeak'),
        },
        { key: 'turnover', label: t('analytics.series.turnover'), value: money(kpi.turnover), sub: t('analytics.count.bets', { count: kpi.settled }) },
      ]
    : [
        { key: 'best', label: t('analytics.series.best'), value: signed(series.best) },
        { key: 'worst', label: t('analytics.series.worst'), value: signed(series.worst) },
        { key: 'turnover', label: t('analytics.series.turnover'), value: money(kpi.turnover), sub: t('analytics.count.bets', { count: kpi.settled }) },
        { key: 'roi', label: t('analytics.series.roi'), value: kpi.roi === null ? '—' : formatPercent(kpi.roi, { signed: true }) },
      ];

  return (
    <Card
      className="analytics-card"
      title={isBank ? t('analytics.series.bankTitle') : t('analytics.series.resultTitle')}
      subtitle={
        isBank
          ? t('analytics.series.bankSubtitle', { ctx: capitalize(ctx), sign: currencySign(currency) })
          : t('analytics.series.resultSubtitle', { sign: currencySign(currency) })
      }
      actions={
        <Chip kind={profit > 0 ? 'good' : profit < 0 ? 'bad' : 'outline'} {...(profit ? { icon: profit > 0 ? 'arrowUp' : 'arrowDown' } : {})}>
          {signed(kpi.profit)}
        </Chip>
      }
    >
      <ChartWithTable
        pending={pending}
        legend={
          isBank
            ? [
                { key: 'bank', name: t('analytics.series.legendBank'), color: 'var(--s1)' },
                { key: 'base', name: t('analytics.series.legendBase', { amount: money(start.amount) }), type: 'dash' },
              ]
            : [
                { key: 'result', name: t('analytics.series.legendResult'), color: 'var(--s1)' },
                { key: 'zero', name: t('analytics.series.legendZero'), type: 'dash' },
              ]
        }
        table={() => (
          <TableBox>
            <DataTable
              columns={columns}
              rows={series.rows}
              rowKey={(row) => row.date_from}
              caption={isBank ? t('analytics.series.bankTitle') : t('analytics.series.resultTitle')}
              empty={t('analytics.series.empty')}
              mobileLayout="table"
            />
          </TableBox>
        )}
      >
        <LineChart
          labels={start.points.map((point) => point.day)}
          series={[
            {
              key: 'series',
              name: isBank ? t('analytics.series.seriesBank') : t('analytics.series.seriesResult'),
              color: 'var(--s1)',
              values,
            },
          ]}
          ariaLabel={
            isBank
              ? t('analytics.series.ariaBank', { ctx, from: money(start.amount), to: money(last) })
              : t('analytics.series.ariaResult', { value: signed(last) })
          }
          height={mobile ? 210 : 270}
          area
          {...(isBank ? {} : { areaBase: 0 })}
          endLabel
          refLines={[{ value: Number(start.amount) }]}
          yFormat={yFormat}
          xFormat={(day) => formatDate(day)}
          tipTitle={(day) => formatDateLong(day)}
        />
      </ChartWithTable>
      <dl className="analytics-strip">
        {strip.map((cell) => (
          <div key={cell.key}>
            <dt>{cell.label}</dt>
            <dd>
              {cell.value}
              {cell.sub && <small>{cell.sub}</small>}
            </dd>
          </div>
        ))}
      </dl>
      <Howto>
        {isBank ? t('analytics.series.howtoBank') : t('analytics.series.howtoResult')} {mobile ? t('analytics.series.touch') : t('analytics.series.hover')}
      </Howto>
    </Card>
  );
}
