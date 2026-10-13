import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, EmptyState, type DataColumn } from '../../components';
import { CalibrationChart, ChartWithTable } from '../../components/charts';
import type { Analytics, CalibrationBinOut, CalibrationFlag } from '../../features/analytics/types';
import { formatNumber, formatPp, formatProb, formatProbRange } from '../../lib/format';
import { FitTable, FootNote, Howto } from './parts';

// Калибровка (В3, calibrationCard макета): события рассчитанных ставок, итоговая вероятность
// модели против доли сыгравших с ДИ Уилсона; в таблице — базовая модель и оценка Claude. Под
// фильтром «старый бот» — оценка Claude его ординаров (Т10). Пороги — из thresholds сервера.

// Разница целыми п.п. без единицы: «п.п.» стоит в тексте (в конце предложения его точка — и точка
// предложения, как в макете: «…на 26 п.п. А в диапазоне…»)
const PP0 = { digits: 0, signed: false, unit: false } as const;

function FlagText({ flag }: { flag: CalibrationFlag }) {
  const { t } = useTranslation();
  return (
    <>
      {t('analytics.calibration.flag', {
        p: formatProb(flag.p),
        actual: formatProb(flag.actual),
        events: t('analytics.count.events', { count: flag.n }),
        direction: t(`analytics.calibration.direction.${flag.direction}`),
        gap: formatPp(flag.gap, PP0),
      })}
    </>
  );
}

function Verdict({ data }: { data: Analytics }) {
  const { t } = useTranslation();
  const { calibration, thresholds } = data;
  const gap = formatPp(thresholds.calibration_gap, PP0);
  if (calibration.status === 'few') {
    return <Callout kind="neutral" icon="info">{t('analytics.calibration.few', { n: thresholds.calibration_min_n })}</Callout>;
  }
  if (calibration.status === 'off' && calibration.worst) {
    const worst = calibration.worst;
    const opposite = calibration.opposite;
    return (
      <Callout kind="warn" icon="alert">
        <b>{t('analytics.calibration.range', { range: formatProbRange(worst.low, worst.high) })} </b>
        <FlagText flag={worst} />
        {opposite &&
          ` ${t('analytics.calibration.opposite', {
            range: formatProbRange(opposite.low, opposite.high),
            direction: t(`analytics.calibration.direction.${opposite.direction}`),
            p: formatProb(opposite.p),
            actual: formatProb(opposite.actual),
          })}`}
      </Callout>
    );
  }
  return (
    <Callout kind="good" icon="check">
      {t('analytics.calibration.ok', { n: thresholds.calibration_min_n, gap })}
    </Callout>
  );
}

export function CalibrationCard({ data, mobile, pending }: { data: Analytics; mobile: boolean; pending: boolean }) {
  const { t } = useTranslation();
  const { calibration, thresholds } = data;
  const bot = calibration.kind === 'claude';
  const sample = (
    <div className="segmented analytics-sample" role="group" aria-label={t('analytics.calibration.sampleLabel')}>
      <button type="button" aria-pressed="true">
        {t('analytics.calibration.sampleLegs')}
      </button>
      <button type="button" aria-pressed="false" disabled title={t('analytics.calibration.sampleAllTitle')}>
        {t('analytics.calibration.sampleAll')}
      </button>
    </div>
  );
  const head = {
    className: 'analytics-card',
    id: 'analytics-calib',
    title: t('analytics.calibration.title'),
    subtitle: bot ? t('analytics.calibration.subtitleBot') : t('analytics.calibration.subtitle'),
    actions: <Chip kind="outline">{t('analytics.count.events', { count: calibration.events })}</Chip>,
  };
  // у бота по событиям считаются только ординары; на паре событий график ничего не говорит
  if (bot && calibration.events < thresholds.small_sample) {
    return (
      <Card {...head}>
        {sample}
        <EmptyState>{t('analytics.calibration.botFew', { n: calibration.events, min: thresholds.small_sample })}</EmptyState>
      </Card>
    );
  }
  if (calibration.status === 'empty' || !calibration.bins.length) {
    return (
      <Card {...head}>
        {sample}
        <EmptyState>{t('analytics.calibration.empty')}</EmptyState>
      </Card>
    );
  }
  const gapLimit = thresholds.calibration_gap * 100;
  // Сжатый вид (FitTable) — без колонок hideMobile: событий, база, Claude
  const columns = (): DataColumn<CalibrationBinOut>[] => [
    { key: 'range', label: t('analytics.calibration.cols.range'), render: (b) => <span className="analytics-nowrap">{formatProbRange(b.low, b.high)}</span> },
    { key: 'n', label: t('analytics.calibration.cols.events'), align: 'r', hideMobile: true, render: (b) => formatNumber(b.n) },
    { key: 'p', label: bot ? t('analytics.calibration.cols.claude') : t('analytics.calibration.cols.final'), align: 'r', render: (b) => formatProb(b.p) },
    { key: 'base', label: t('analytics.calibration.cols.base'), align: 'r', hideMobile: true, render: (b) => (bot ? '—' : formatProb(b.p_base)) },
    { key: 'claude', label: t('analytics.calibration.cols.claude'), align: 'r', hideMobile: true, render: (b) => (bot ? '—' : formatProb(b.p_claude)) },
    { key: 'actual', label: t('analytics.calibration.cols.actual'), align: 'r', render: (b) => formatProb(b.actual) },
    {
      key: 'diff',
      label: t('analytics.calibration.cols.diff'),
      align: 'r',
      render: (b) => {
        const d = Math.round((b.actual - b.p) * 100);
        const far = Math.abs(d) >= gapLimit;
        return (
          <span
            className={far ? (d < 0 ? 'bad-text analytics-nowrap' : 'warn-text analytics-nowrap') : 'analytics-nowrap'}
            title={far ? (d < 0 ? t('analytics.calibration.overTitle') : t('analytics.calibration.underTitle')) : undefined}
          >
            {formatNumber(d, 0, { signed: true })}
          </span>
        );
      },
    },
  ];
  return (
    <Card {...head}>
      {sample}
      <ChartWithTable
        pending={pending}
        legend={[
          { key: 'model', name: bot ? t('analytics.calibration.legendBot') : t('analytics.calibration.legendModel'), color: 'var(--s1)' },
          { key: 'ideal', name: t('analytics.calibration.legendIdeal'), type: 'dash' },
        ]}
        table={() => (
          <FitTable columns={columns} rows={calibration.bins} rowKey={(b) => String(b.low)} caption={t('analytics.calibration.title')} />
        )}
      >
        <CalibrationChart
          bins={calibration.bins.map((b) => ({ key: String(b.low), lo: b.low, hi: b.high, p: b.p, actual: b.actual, n: b.n, ci: [b.ci_low, b.ci_high] as const }))}
          ariaLabel={t('analytics.calibration.aria', { events: t('analytics.count.events', { count: calibration.events }) })}
          height={mobile ? 250 : 280}
        />
      </ChartWithTable>
      <Verdict data={data} />
      {calibration.events < thresholds.calibration_few && <FootNote>{t('analytics.calibration.fewNote', { n: thresholds.calibration_few })}</FootNote>}
      <Howto>{bot ? t('analytics.calibration.howtoBot') : t('analytics.calibration.howto')}</Howto>
    </Card>
  );
}
