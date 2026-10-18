import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Callout, Card, EmptyState, Skeleton, useToast } from '../../components';
import { marketLabel, type MarketFamily } from '../../features/analysis/markets';
import { familyTitle } from '../../features/markets/status';
import { apiErrorText } from '../../features/analysis/codes';
import { readSample, saveSample, type CalibrationSample } from '../../features/analytics/accuracy';
import { useAnalytics, useAnalyticsEver } from '../../features/analytics/api';
import { capitalize, periodContext, prevContext } from '../../features/analytics/display';
import {
  EMPTY_FILTERS,
  filtersFromSearch,
  filtersQuery,
  hasSliceFilter,
  searchWithFilters,
  withoutSlices,
  type AnalyticsFilters,
} from '../../features/analytics/filters';
import type { Analytics, InsightFilter, Market } from '../../features/analytics/types';
import { formatDate } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { BrierCard } from './BrierCard';
import { CalibrationCard } from './CalibrationCard';
import { ClvCard } from './ClvCard';
import { Filters } from './Filters';
import { Insights } from './Insights';
import { Kpis } from './Kpis';
import { MarketTable } from './MarketTable';
import { MarketsCard } from './MarketsCard';
import { ExplainModal, ExportModal } from './Modals';
import { ParlaysCard } from './ParlaysCard';
import { Section } from './parts';
import { SeriesCard } from './SeriesCard';
import { MarketCard, OddsCard, SurfaceCard, TotalCard } from './SliceCards';
import './analytics.css';

/*
 * «Аналитика» (mockup/js/screens/analytics.js): фильтры в адресе, показатели с ДИ, выводы кодом,
 * банк или результат отобранных ставок, ROI по срезам (Р21), экспрессы против ординаров,
 * калибровка, Brier против рынка, CLV, сводка по рынкам, выгрузка CSV. Все числа и пороги —
 * из GET /api/analytics; экран только рисует.
 */

/** К фильтрам вверху, если страница прокручена ниже них (scrollToFilters макета). */
function scrollToFilters(): void {
  const el = document.getElementById('analytics-filters');
  if (!el) return;
  const top = el.getBoundingClientRect().top + window.scrollY - 76;
  if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
}

function NoBets({ filters, data, onWiden, onReset }: { filters: AnalyticsFilters; data: Analytics; onWiden: () => void; onReset: () => void }) {
  const { t } = useTranslation();
  const dated = filters.period !== 'all' || filters.from !== null || filters.to !== null;
  // Такие ставки за все время: есть — предлагаем расширить период, нет — снять фильтры
  const ever = useAnalyticsEver(filtersQuery({ ...filters, period: 'all', from: null, to: null }), dated);
  const everBets = ever.data?.sample.bets ?? null;
  if (!hasSliceFilter(filters) && (!dated || everBets === 0)) {
    return (
      <Card>
        <EmptyState
          icon="chart"
          title={t('analytics.empty.newTitle')}
          text={t('analytics.empty.newText')}
          action={
            <Button kind="primary" icon="ticket" to={paths.bets}>
              {t('analytics.empty.toBets')}
            </Button>
          }
        />
      </Card>
    );
  }
  const ctx = capitalize(periodContext(t, data.period, data.date_from, data.date_to));
  // Ответ «за все время» не пришел (ошибка) — кнопка остается: там может что-то быть
  const canWiden = dated && (everBets === null ? ever.isError : everBets > 0);
  const lastDay = ever.data?.sample.last_day ?? null;
  let text: string;
  if (!dated || everBets === 0) text = t('analytics.empty.textFilters');
  else if (everBets !== null && lastDay) text = t('analytics.empty.textEver', { ctx, date: formatDate(lastDay), bets: t('analytics.count.bets', { count: everBets }) });
  else if (ever.isError) text = t('analytics.empty.textPeriod', { ctx });
  else text = t('analytics.empty.textPeriodShort', { ctx });
  return (
    <Card>
      <EmptyState
        icon="filter"
        title={t('analytics.empty.title')}
        text={text}
        action={
          <div className="row" style={{ justifyContent: 'center' }}>
            {canWiden && (
              <Button kind="primary" icon="calendar" onClick={onWiden}>
                {t('analytics.empty.widen')}
              </Button>
            )}
            <Button kind={canWiden ? 'secondary' : 'primary'} icon="refresh" onClick={onReset}>
              {t('analytics.filters.reset')}
            </Button>
          </div>
        }
      />
    </Card>
  );
}

export function AnalyticsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const query = useMemo(() => filtersQuery(filters), [filters]);
  const analytics = useAnalytics(query);
  // Выборка калибровки (этап 5): «Все мои прогнозы» или только ноги ставок — оба блока в ответе
  const [sample, setSample] = useState<CalibrationSample>(readSample);
  const chooseSample = useCallback((next: CalibrationSample) => {
    saveSample(next);
    setSample(next);
  }, []);
  // Стартовый банк для «Банка по дням» (тот же запрос, что у плашки «Банк» в шапке)
  const [explain, setExplain] = useState(false);
  const [exporting, setExporting] = useState(false);

  // Адрес меняем от последнего записанного: две правки подряд не затирают друг друга
  const latest = useRef(params);
  const seen = useRef(params);
  if (seen.current !== params) {
    seen.current = params;
    latest.current = params;
  }
  const setFilters = useCallback(
    (next: AnalyticsFilters) => {
      const search = searchWithFilters(next, latest.current);
      latest.current = search;
      setParams(search);
    },
    [setParams],
  );
  const reset = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
  const widen = useCallback(() => setFilters({ ...filters, period: 'all', from: null, to: null }), [filters, setFilters]);

  function applyFilter(filter: InsightFilter, label: string) {
    if (filter.surface) setFilters({ ...filters, surface: filter.surface });
    else if (filter.market) setFilters({ ...filters, market: filter.market, selection: filter.selection === 1 || filter.selection === 2 ? filter.selection : null });
    scrollToFilters();
    toast.show(t('analytics.toast.filter', { label }), { icon: 'filter' });
  }

  function pickMarket(market: Market | null, selection: number | null) {
    const side = selection === 1 || selection === 2 ? selection : null;
    setFilters({ ...filters, market, selection: market ? side : null, family: null });
    scrollToFilters();
    toast.show(market && side ? t('analytics.toast.market', { label: marketLabel(market, side) }) : t('analytics.toast.allMarkets'), { icon: 'filter' });
  }

  function pickFamily(family: MarketFamily) {
    setFilters({ ...filters, market: null, selection: null, family });
    scrollToFilters();
    toast.show(t('analytics.toast.market', { label: familyTitle(family) }), { icon: 'filter' });
  }

  const data = analytics.data;
  const pending = analytics.isPlaceholderData;
  const ctx = data ? periodContext(t, data.period, data.date_from, data.date_to) : '';
  const prevCtx = data && data.change ? prevContext(t, data.period) : null;

  let content;
  if (!data) {
    content = analytics.isError ? null : (
      <div className="analytics-kpis" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Card key={i}>
            <Skeleton lines={3} />
          </Card>
        ))}
      </div>
    );
  } else if (data.sample.bets === 0) {
    content = <NoBets filters={filters} data={data} onWiden={widen} onReset={reset} />;
  } else {
    content = (
      <>
        <Kpis data={data} ctx={ctx} prevCtx={prevCtx} pending={pending} />
        <Insights
          data={data}
          ctx={ctx}
          actions={{
            onCalibration: () => document.getElementById('analytics-calib')?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
            onFilter: applyFilter,
            onWiden: widen,
            onClear: () => setFilters(withoutSlices(filters)),
            onExplain: () => setExplain(true),
          }}
        />
        <SeriesCard data={data} ctx={ctx} mobile={mobile} pending={pending} />
        <Section title={t('analytics.sections.slices.title')} text={t('analytics.sections.slices.text')} />
        <ParlaysCard data={data} />
        <div className="analytics-grid">
          <SurfaceCard data={data} filters={filters} pending={pending} />
          <MarketCard data={data} filters={filters} pending={pending} />
          <OddsCard data={data} filters={filters} pending={pending} />
          <TotalCard data={data} filters={filters} pending={pending} />
        </div>
        <Section title={t('analytics.sections.accuracy.title')} text={t('analytics.sections.accuracy.text')} />
        <div className="analytics-grid">
          <CalibrationCard data={data} mobile={mobile} pending={pending} sample={sample} onSample={chooseSample} />
          <BrierCard data={data} mobile={mobile} pending={pending} onExplain={() => setExplain(true)} />
        </div>
        <Section title={t('analytics.sections.price.title')} text={t('analytics.sections.price.text')} />
        <div className="analytics-grid">
          <ClvCard data={data} mobile={mobile} pending={pending} />
          <MarketTable data={data} filters={filters} onPick={pickMarket} onPickFamily={pickFamily} />
        </div>
        <MarketsCard />
      </>
    );
  }

  const scope = data
    ? t('analytics.export.scopeValue', {
        ctx,
        bets: t('analytics.count.bets', { count: data.sample.bets }),
        events: t('analytics.count.events', { count: data.sample.events }),
      })
    : '';

  return (
    <div className="analytics-root stack">
      <div className="page-head analytics-head">
        <div className="analytics-min">
          <h2>{t('analytics.head.title')}</h2>
          <p className="lead">{t('analytics.head.lead')}</p>
        </div>
        <div className="analytics-head-actions">
          <Button icon="download" size={mobile ? 'sm' : 'md'} disabled={!data} onClick={() => setExporting(true)}>
            {t('analytics.head.export')}
          </Button>
        </div>
      </div>
      <Filters filters={filters} data={data} onChange={setFilters} onReset={reset} />
      {analytics.isError && (
        <Callout kind="bad" role="alert">
          {apiErrorText(analytics.error)}{' '}
          <Button size="sm" kind="ghost" icon="refresh" onClick={() => void analytics.refetch()}>
            {t('common.retry')}
          </Button>
        </Callout>
      )}
      {content}
      {explain && <ExplainModal onClose={() => setExplain(false)} />}
      {exporting && data && <ExportModal filters={filters} scope={scope} onClose={() => setExporting(false)} />}
    </div>
  );
}
