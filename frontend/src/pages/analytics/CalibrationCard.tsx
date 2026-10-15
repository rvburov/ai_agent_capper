import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, EmptyState, Segmented, type DataColumn } from '../../components';
import { CalibrationChart, ChartWithTable } from '../../components/charts';
import { calibrationAll, type CalibrationSample } from '../../features/analytics/accuracy';
import type { Analytics, Calibration, CalibrationBinOut, CalibrationFlag } from '../../features/analytics/types';
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

function Verdict({ calibration, thresholds }: { calibration: Calibration; thresholds: Analytics['thresholds'] }) {
  const { t } = useTranslation();
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

interface CalibrationCardProps {
  data: Analytics;
  mobile: boolean;
  pending: boolean;
  /** Выборка, выбранная участником (этап 5): все прогнозы или только ноги ставок. */
  sample: CalibrationSample;
  onSample: (sample: CalibrationSample) => void;
}

export function CalibrationCard({ data, mobile, pending, sample: chosen, onSample }: CalibrationCardProps) {
  const { t } = useTranslation();
  const { thresholds } = data;
  const bot = data.calibration.kind === 'claude';
  // «Все мои прогнозы» — отдельный блок ответа (calibration_all); под фильтром бота его нет —
  // тогда одна выборка «Ноги ставок», как в макете
  const allBlock = bot ? null : calibrationAll(data);
  const supported = allBlock !== null;
  const sample: CalibrationSample = supported ? chosen : 'legs';
  const all = supported && sample === 'all';
  const calibration = all && allBlock ? allBlock : data.calibration;
  let sampleSwitch;
  if (supported) {
    sampleSwitch = (
      <Segmented<CalibrationSample>
        className="analytics-sample"
        label={t('analytics.calibration.sampleLabel')}
        value={sample}
        onChange={onSample}
        items={[
          {
            value: 'all',
            label: t('analytics.calibration.sampleAllCount', { n: allBlock?.events ?? 0 }),
          },
          { value: 'legs', label: t('analytics.calibration.sampleOnlyLegs') },
        ]}
      />
    );
  } else {
    sampleSwitch = (
      <div className="segmented analytics-sample" role="group" aria-label={t('analytics.calibration.sampleLabel')}>
        <button type="button" aria-pressed="true">
          {t('analytics.calibration.sampleLegs')}
        </button>
      </div>
    );
  }
  const head = {
    className: 'analytics-card',
    id: 'analytics-calib',
    title: t('analytics.calibration.title'),
    subtitle: bot
      ? t('analytics.calibration.subtitleBot')
      : all
        ? t('analytics.calibration.subtitleAll')
        : t('analytics.calibration.subtitle'),
    actions: <Chip kind="outline">{t('analytics.count.events', { count: calibration.events })}</Chip>,
  };
  // у бота по событиям считаются только ординары; на паре событий график ничего не говорит
  if (bot && calibration.events < thresholds.small_sample) {
    return (
      <Card {...head}>
        {sampleSwitch}
        <EmptyState>{t('analytics.calibration.botFew', { n: calibration.events, min: thresholds.small_sample })}</EmptyState>
      </Card>
    );
  }
  // События вне корзин 50–95% (outside с сервера): у «Всех прогнозов» вероятность стороны
  // прогноза не ниже 50% — вне графика только 95%+; у ног ставок — и ниже 50% (ставка на
  // аутсайдера). Чип считает все события — пояснение, почему на графике их меньше
  const outsideKind = all ? 'High' : 'Any';
  const outsideEvents = t('analytics.count.events', { count: calibration.outside });
  if (calibration.status === 'empty' || !calibration.bins.length) {
    return (
      <Card {...head}>
        {sampleSwitch}
        <EmptyState>
          {calibration.outside > 0
            ? t(`analytics.calibration.emptyOutside${outsideKind}`, { events: outsideEvents })
            : t('analytics.calibration.empty')}
        </EmptyState>
      </Card>
    );
  }
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
        // разница «факт − прогноз» — с сервера (diff), здесь только цвет по порогу
        const far = Math.abs(b.diff) >= thresholds.calibration_gap;
        return (
          <span
            className={far ? (b.diff < 0 ? 'bad-text analytics-nowrap' : 'warn-text analytics-nowrap') : 'analytics-nowrap'}
            title={far ? (b.diff < 0 ? t('analytics.calibration.overTitle') : t('analytics.calibration.underTitle')) : undefined}
          >
            {formatPp(b.diff, { digits: 0, unit: false })}
          </span>
        );
      },
    },
  ];
  return (
    <Card {...head}>
      {sampleSwitch}
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
      <Verdict calibration={calibration} thresholds={thresholds} />
      {calibration.outside > 0 && <FootNote plain>{t(`analytics.calibration.outside${outsideKind}`, { events: outsideEvents })}</FootNote>}
      {calibration.events < thresholds.calibration_few && <FootNote>{t('analytics.calibration.fewNote', { n: thresholds.calibration_few })}</FootNote>}
      <Howto>{bot ? t('analytics.calibration.howtoBot') : t('analytics.calibration.howto')}</Howto>
    </Card>
  );
}
