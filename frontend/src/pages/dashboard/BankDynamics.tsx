import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Card, Chip, DataTable, EmptyState, Icon, type DataColumn } from '../../components';
import { ChartWithTable, LineChart, type ValueFormat } from '../../components/charts';
import { capitalize, periodStart } from '../../features/analytics/display';
import { bankSteps, flowMarks, flowsText } from '../../features/analytics/flows';
import type { Bank } from '../../features/bank/types';
import { currencyOf, toneClass } from '../../features/bets/display';
import type { Dashboard, RecentBet } from '../../features/dashboard/types';
import { formatDate, formatDateLong, formatMoney, formatNumber, formatOdds, formatPercent, stepDigits } from '../../lib/format';
import { StatusChip } from '../bets/parts';

// «Динамика банка» (chartCard макета): банк по дням и пунктир «вложено» ступенькой с отметками
// пополнений (В7 этапа 5), таблица последних рассчитанных ставок и полоса итогов периода —
// прибыль ставок и пополнения отдельно. Банка еще нет (ни ставок, ни пополнений) — пустое
// состояние: нулевой график с «Вложено: старт 0 ₽» был бы неправдой.

function betPath(id: number): string {
  return `${paths.bets}?bet=${id}`;
}

/**
 * Рассчитанные ставки периода на «Ставках»: тот же период и status=settled — их число и есть N
 * в «Все N ставок за период» (kpi.settled).
 */
function periodBetsPath(period: Dashboard['period']): string {
  return period === 'all' ? `${paths.bets}?status=settled` : `${paths.bets}?period=${period}&status=settled`;
}

function kindText(bet: RecentBet, t: TFunction): string {
  return bet.legs > 1 ? t('bets.kind.parlay', { n: bet.legs }) : t('bets.kind.single');
}

function RecentList({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  const currency = currencyOf(data.currency);
  const rows = data.recent.slice(0, 10);
  return (
    <ul className="dashboard-betlist" aria-label={t('dashboard.chart.tableCaption')}>
      {rows.map((bet) => (
        <li key={bet.id}>
          <Link className="dashboard-betlist-row" to={betPath(bet.id)}>
            <div className="dashboard-min">
              <div className="small" style={{ fontWeight: 600 }}>
                {formatDate(bet.settled_at ?? bet.placed_at)} · {kindText(bet, t)}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 4 }}>
                <StatusChip status={bet.status} />
                <span className="odds small">{formatOdds(bet.total_odds)}</span>
              </div>
            </div>
            <div className="dashboard-betlist-side">
              <div className={toneClass(bet.profit)} style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                {formatMoney(bet.profit, currency, { signed: true })}
              </div>
              {bet.equity_after !== null && (
                <div className="xsmall muted" style={{ whiteSpace: 'nowrap' }}>
                  {t('dashboard.chart.bankAfterShort', { amount: formatMoney(bet.equity_after, currency) })}
                </div>
              )}
            </div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function RecentTable({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const currency = currencyOf(data.currency);
  const columns: DataColumn<RecentBet>[] = [
    { key: 'date', label: t('dashboard.chart.cols.date'), render: (bet) => <span style={{ whiteSpace: 'nowrap' }}>{formatDate(bet.settled_at ?? bet.placed_at)}</span> },
    { key: 'kind', label: t('dashboard.chart.cols.bet'), render: (bet) => <span style={{ whiteSpace: 'nowrap' }}>{kindText(bet, t)}</span> },
    { key: 'odds', label: t('dashboard.chart.cols.odds'), align: 'r', render: (bet) => <span className="odds">{formatOdds(bet.total_odds)}</span> },
    { key: 'status', label: t('dashboard.chart.cols.status'), render: (bet) => <StatusChip status={bet.status} /> },
    {
      key: 'profit',
      label: t('dashboard.chart.cols.profit'),
      align: 'r',
      render: (bet) => (
        <span className={toneClass(bet.profit)} style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>
          {formatMoney(bet.profit, currency, { signed: true })}
        </span>
      ),
    },
    {
      key: 'bank',
      label: t('dashboard.chart.cols.bankAfter'),
      align: 'r',
      render: (bet) => <span style={{ whiteSpace: 'nowrap' }}>{formatMoney(bet.equity_after, currency)}</span>,
    },
  ];
  return (
    <DataTable
      columns={columns}
      rows={data.recent}
      rowKey={(bet) => bet.id}
      onRowClick={(bet) => void navigate(betPath(bet.id))}
      caption={t('dashboard.chart.tableCaption')}
      empty={t('dashboard.chart.empty')}
      mobileLayout="table"
    />
  );
}

function Recent({ data, mobile }: { data: Dashboard; mobile: boolean }) {
  const { t } = useTranslation();
  const shown = mobile ? Math.min(10, data.recent.length) : data.recent.length;
  const total = data.kpi.settled;
  return (
    <div className="stack" style={{ gap: 8 }}>
      {mobile ? data.recent.length ? <RecentList data={data} /> : <p className="small muted">{t('dashboard.chart.empty')}</p> : <RecentTable data={data} />}
      {total > shown && (
        <Button kind="ghost" size="sm" iconRight="chevronRight" className="dashboard-more" to={periodBetsPath(data.period)}>
          {t('dashboard.chart.all', { count: total })}
        </Button>
      )}
    </div>
  );
}

interface BankDynamicsProps {
  data: Dashboard;
  /** Банк из GET /api/me/bank (empty — банка еще нет). */
  bank: Bank;
  ctx: string;
  mobile: boolean;
  pending: boolean;
}

export function BankDynamics({ data, bank, ctx, mobile, pending }: BankDynamicsProps) {
  const { t } = useTranslation();
  const { kpi, series } = data;
  const currency = currencyOf(data.currency);
  if (bank.empty) {
    return (
      <Card className="dashboard-card" title={t('dashboard.chart.title')}>
        <EmptyState
          icon="wallet"
          text={t('dashboard.chart.noBank')}
          action={
            <Button kind="secondary" size="sm" iconRight="chevronRight" to={paths.profile('bank')}>
              {t('dashboard.hero.emptyLink')}
            </Button>
          }
        />
      </Card>
    );
  }
  const digits = currency === 'RUB' ? 0 : 2;
  // Подписи без знака валюты (он в подзаголовке): деления — с точностью шага, значение дня —
  // с копейками или центами, если они есть
  const yFormat: ValueFormat = (value, axis) => formatNumber(value, axis ? Math.min(digits, stepDigits(axis.step)) : digits);
  const profit = Number(kpi.profit);
  // Дни до появления банка не рисуем, опорная линия — банк на начало (см. periodStart)
  const start = periodStart(series);
  const last = start.points[start.points.length - 1]?.value ?? series.last;
  const labels = start.points.map((point) => point.day);
  // В7: пунктир «вложено» — ступенькой (старт периода, пополнения и выводы), в день движения —
  // отметка с подписью; на телефоне подпись без даты (дата — в подсказке и по оси)
  const steps = bankSteps(series, start);
  const marks = flowMarks(t, steps.flows, labels, currency, mobile);
  const flows = steps.flows.length ? `; ${flowsText(t, steps.flows, currency)}` : '';
  return (
    <Card
      className="dashboard-card"
      title={t('dashboard.chart.title')}
      subtitle={t('dashboard.chart.subtitle', { ctx: capitalize(ctx), currency: t(`dashboard.chart.currency.${currency}`) })}
      actions={
        <Chip kind={profit > 0 ? 'good' : profit < 0 ? 'bad' : 'outline'} {...(profit ? { icon: profit > 0 ? 'arrowUp' : 'arrowDown' } : {})}>
          {formatMoney(kpi.profit, currency, { signed: true })}
        </Chip>
      }
    >
      <ChartWithTable
        pending={pending}
        legend={[
          { key: 'bank', name: t('dashboard.chart.legendBank'), color: 'var(--s1)' },
          {
            key: 'invested',
            name: t(steps.flows.length ? 'dashboard.chart.legendInvestedFlows' : 'dashboard.chart.legendInvested', {
              amount: formatMoney(start.amount, currency),
            }),
            type: 'dash',
          },
        ]}
        table={() => <Recent data={data} mobile={mobile} />}
      >
        <LineChart
          labels={labels}
          series={[
            { key: 'bank', name: t('dashboard.chart.series'), color: 'var(--s1)', values: start.points.map((point) => Number(point.value)) },
            { key: 'invested', name: t('dashboard.chart.seriesInvested'), color: 'var(--fg-3)', values: steps.invested, dashed: true, step: true, thin: true, noEnd: true },
          ]}
          marks={marks}
          ariaLabel={`${t('dashboard.chart.aria', { ctx, from: formatMoney(start.amount, currency), to: formatMoney(last, currency) })}${flows}`}
          height={mobile ? 200 : 250}
          area
          endLabel
          yFormat={yFormat}
          xFormat={(day) => formatDate(day)}
          tipTitle={(day) => formatDateLong(day)}
        />
      </ChartWithTable>
      <div className="dashboard-howto">
        <Icon name="info" />
        <span>{mobile ? t('dashboard.chart.howtoStepsTouch') : t('dashboard.chart.howtoStepsHover')}</span>
      </div>
      <dl className="dashboard-strip">
        <div>
          <dt>{t('dashboard.chart.betsProfit')}</dt>
          <dd className={toneClass(kpi.profit)}>{formatMoney(kpi.profit, currency, { signed: true })}</dd>
        </div>
        <div>
          <dt>{t('dashboard.chart.flows')}</dt>
          <dd>{steps.flowSum === null ? t('dashboard.chart.flowsNone') : formatMoney(steps.flowSum, currency, { signed: true })}</dd>
        </div>
        <div>
          <dt>{t('dashboard.chart.turnover')}</dt>
          <dd>{formatMoney(kpi.turnover, currency)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.chart.drawdown')}</dt>
          <dd>{series.max_drawdown < 0 ? formatPercent(series.max_drawdown, { signed: true }) : formatPercent(0, { digits: 0 })}</dd>
        </div>
      </dl>
    </Card>
  );
}
