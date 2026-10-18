import type { TFunction } from 'i18next';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Dropdown, FieldShell, Icon, Segmented, type DropdownOption } from '../../components';
import { marketLabel } from '../../features/analysis/markets';
import { filterLabel } from '../../features/analytics/insights';
import {
  isDefault,
  outcomeValue,
  OUTCOMES,
  parseOutcome,
  KINDS,
  PERIODS,
  SOURCES,
  SURFACES,
  type AnalyticsFilters,
} from '../../features/analytics/filters';
import type { Analytics, KindFilter, Period, SourceFilter, SurfaceFilter } from '../../features/analytics/types';
import { formatDateRange } from '../../lib/format';

// Фильтры «Аналитики» (filterBar макета): период, исход, покрытие, источник; строка «в выборке
// N ставок и M событий» с выбранными фильтрами метками и пояснениями про старый бот.

type Change = (next: AnalyticsFilters, options?: { replace?: boolean }) => void;
type All = 'all';

function marketOptions(t: TFunction, filters: AnalyticsFilters): DropdownOption[] {
  const options: DropdownOption[] = [
    { value: 'all', label: t('analytics.filters.marketAll') },
    ...OUTCOMES.map(([market, selection]) => ({ value: outcomeValue(market, selection), label: marketLabel(market, selection) })),
  ];
  // Рынок без стороны (пришел ссылкой): своя строка, чтобы список показал выбор
  if (filters.market && !filters.selection) {
    options.push({ value: filters.market, label: t(`analytics.markets.group.${MARKET_GROUP[filters.market]}`) });
  }
  return options;
}

const MARKET_GROUP = { ML: 'ml', 'HCP_-1.5': 'minus', 'HCP_+1.5': 'plus' } as const;

function surfaceOptions(t: TFunction): DropdownOption<SurfaceFilter | All>[] {
  return [{ value: 'all', label: t('analytics.filters.surfaceAll') }, ...SURFACES.map((s) => ({ value: s, label: t(`analytics.surfaces.${s}`) }))];
}

function sourceOptions(t: TFunction): DropdownOption<SourceFilter | All>[] {
  return [{ value: 'all', label: t('analytics.filters.sourceAll') }, ...SOURCES.map((s) => ({ value: s, label: t(`analytics.sources.${s}`) }))];
}

function kindOptions(t: TFunction): DropdownOption<KindFilter | All>[] {
  return [{ value: 'all', label: t('analytics.filters.kindAll') }, ...KINDS.map((k) => ({ value: k, label: t(`analytics.kinds.${k}`) }))];
}

function DatesChip({ filters, onChange }: { filters: AnalyticsFilters; onChange: Change }) {
  const { t } = useTranslation();
  if (!filters.from && !filters.to) return null;
  const text =
    filters.from && filters.to
      ? formatDateRange(filters.from, filters.to)
      : filters.from
        ? t('analytics.filters.since', { date: formatDateRange(filters.from, filters.from) })
        : t('analytics.filters.until', { date: formatDateRange(filters.to, filters.to) });
  return (
    <button
      type="button"
      className="chip accent analytics-chip-btn"
      title={t('analytics.filters.removeTitle')}
      aria-label={t('analytics.filters.remove', { name: text })}
      onClick={() => onChange({ ...filters, from: null, to: null })}
    >
      {text}
      <Icon name="x" />
    </button>
  );
}

function Scope({ data, filters, onChange }: { data: Analytics | undefined; filters: AnalyticsFilters; onChange: Change }) {
  const { t } = useTranslation();
  const chips: { key: string; label: string; drop: AnalyticsFilters }[] = [];
  if (filters.market) {
    const name = filters.selection ? marketLabel(filters.market, filters.selection) : filterLabel(t, { market: filters.market });
    chips.push({ key: 'market', label: t('analytics.filters.chipMarket', { name }), drop: { ...filters, market: null, selection: null } });
  }
  if (filters.surface) {
    chips.push({ key: 'surface', label: t('analytics.filters.chipSurface', { name: t(`analytics.surfaces.${filters.surface}`) }), drop: { ...filters, surface: null } });
  }
  if (filters.kind) {
    chips.push({ key: 'kind', label: t('analytics.filters.chipKind', { name: t(`analytics.kinds.${filters.kind}`) }), drop: { ...filters, kind: null } });
  }
  if (filters.source) {
    chips.push({ key: 'source', label: t('analytics.filters.chipSource', { name: t(`analytics.sources.${filters.source}`) }), drop: { ...filters, source: null } });
  }
  const sample = data?.sample;
  const range =
    sample?.first_day && sample.last_day
      ? sample.first_day === sample.last_day
        ? formatDateRange(sample.first_day, sample.first_day)
        : formatDateRange(sample.first_day, sample.last_day)
      : null;
  return (
    <div className="analytics-scope" aria-live="polite">
      {sample && (
        <span>
          {t('analytics.scope.in')} <b>{t('analytics.count.bets', { count: sample.bets })}</b> {t('analytics.scope.and')}{' '}
          <b>{t('analytics.count.events', { count: sample.events })}</b>
          {range && ` · ${range}`}
        </span>
      )}
      <DatesChip filters={filters} onChange={onChange} />
      {chips.map((chip) => (
        <button
          key={chip.key}
          type="button"
          className="chip accent analytics-chip-btn"
          title={t('analytics.filters.removeTitle')}
          aria-label={t('analytics.filters.remove', { name: chip.label })}
          onClick={() => onChange(chip.drop)}
        >
          {chip.label}
          <Icon name="x" />
        </button>
      ))}
      {sample && sample.legacy_bets > 0 && !filters.source && (
        <span className="muted xsmall">{t('analytics.scope.legacy', { count: sample.legacy_bets })}</span>
      )}
      {sample && sample.legacy_parlay_events > 0 && (
        <span className="muted xsmall">{t('analytics.scope.legacyParlays', { count: sample.legacy_parlay_events })}</span>
      )}
      {!filters.kind && <span className="muted xsmall">{t('analytics.scope.kinds')}</span>}
      {sample && sample.open_bets > 0 && <span className="muted xsmall">{t('analytics.scope.open', { count: sample.open_bets })}</span>}
    </div>
  );
}

interface FiltersProps {
  filters: AnalyticsFilters;
  data: Analytics | undefined;
  onChange: Change;
  onReset: () => void;
}

export function Filters({ filters, data, onChange, onReset }: FiltersProps) {
  const { t } = useTranslation();
  const id = useId();
  const custom = filters.from !== null || filters.to !== null;
  return (
    <section className="analytics-filters" aria-label={t('analytics.filters.label')} id="analytics-filters">
      <div className="analytics-filter analytics-filter-period">
        <span className="analytics-filter-label" id={`${id}-period`}>
          {t('analytics.filters.period')}
        </span>
        <Segmented<Period | 'custom'>
          label={t('analytics.filters.period')}
          items={PERIODS.map((value) => ({ value, label: t(`analytics.period.items.${value}`) }))}
          value={custom ? 'custom' : filters.period}
          onChange={(value) => {
            if (value !== 'custom') onChange({ ...filters, period: value, from: null, to: null });
          }}
        />
      </div>
      <FieldShell id={`${id}-market`} label={t('analytics.filters.market')} className="analytics-filter">
        <Dropdown
          id={`${id}-market`}
          label={t('analytics.filters.market')}
          options={marketOptions(t, filters)}
          value={outcomeValue(filters.market, filters.selection)}
          onChange={(value) => onChange({ ...filters, ...parseOutcome(value) })}
        />
      </FieldShell>
      <FieldShell id={`${id}-surface`} label={t('analytics.filters.surface')} className="analytics-filter">
        <Dropdown
          id={`${id}-surface`}
          label={t('analytics.filters.surface')}
          options={surfaceOptions(t)}
          value={filters.surface ?? 'all'}
          onChange={(value) => onChange({ ...filters, surface: value === 'all' ? null : value })}
        />
      </FieldShell>
      <FieldShell id={`${id}-source`} label={t('analytics.filters.source')} className="analytics-filter">
        <Dropdown
          id={`${id}-source`}
          label={t('analytics.filters.source')}
          options={sourceOptions(t)}
          value={filters.source ?? 'all'}
          onChange={(value) => onChange({ ...filters, source: value === 'all' ? null : value })}
        />
      </FieldShell>
      <FieldShell id={`${id}-kind`} label={t('analytics.filters.kind')} className="analytics-filter">
        <Dropdown
          id={`${id}-kind`}
          label={t('analytics.filters.kind')}
          options={kindOptions(t)}
          value={filters.kind ?? 'all'}
          onChange={(value) => onChange({ ...filters, kind: value === 'all' ? null : value })}
        />
      </FieldShell>
      {!isDefault(filters) && (
        <Button kind="ghost" size="sm" icon="refresh" className="analytics-filter-reset" onClick={onReset}>
          {t('analytics.filters.reset')}
        </Button>
      )}
      <Scope data={data} filters={filters} onChange={onChange} />
    </section>
  );
}
