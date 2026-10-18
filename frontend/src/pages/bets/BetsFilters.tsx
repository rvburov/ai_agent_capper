import type { TFunction } from 'i18next';
import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Chip, Dropdown, FieldShell, Icon, Modal, Segmented, surfaceColor, type DropdownOption } from '../../components';
import { useBetSummary } from '../../features/bets/api';
import { FAMILIES, type MarketFamily } from '../../features/analysis/markets';
import { familyTitle } from '../../features/markets/status';
import {
  filtersQuery,
  KINDS,
  PERIODS,
  SEARCH_MAX,
  sheetActiveCount,
  SOURCES,
  STATUSES,
  SURFACES,
  type BetFilters,
} from '../../features/bets/filters';
import type { KindFilter, Period, SourceFilter, StatusFilter, SurfaceFilter } from '../../features/bets/types';
import { formatDateRange } from '../../lib/format';
import { cx } from '../../lib/cx';

// Фильтры «Ставок» (desktopFilters, mobileFilters и filterSheet макета): на компьютере — одной
// строкой, на телефоне — поиск, кнопка «Фильтры» со шторкой, период и выбранные фильтры метками.

type Change = (next: BetFilters) => void;

const SEARCH_DELAY_MS = 300;

/** Поиск по игроку, турниру, букмекеру и номеру: в адрес уходит после паузы ввода. */
function SearchBox({ value, onSearch }: { value: string; onSearch: (q: string) => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState(value);
  // Что ушло в адрес — обрезанным, как его пишет searchWithFilters: иначе пробел между словами
  // («Синнер Руне») после паузы считался бы изменением адреса снаружи и стирался из поля
  const sent = useRef(value.trim());
  const search = useRef(onSearch);
  useEffect(() => {
    search.current = onSearch;
  });
  // Адрес изменили снаружи (сброс фильтров, «Назад») — поле показывает его
  useEffect(() => {
    if (value.trim() !== sent.current) {
      sent.current = value.trim();
      setText(value);
    }
  }, [value]);
  useEffect(() => {
    if (text.trim() === sent.current) return undefined;
    const timer = window.setTimeout(() => {
      sent.current = text.trim();
      search.current(text);
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  return (
    <div className="bets-search">
      <Icon name="search" />
      <input
        className="input"
        type="search"
        value={text}
        maxLength={SEARCH_MAX}
        placeholder={t('bets.filters.searchPlaceholder')}
        aria-label={t('bets.filters.searchLabel')}
        autoComplete="off"
        onChange={(event) => setText(event.target.value)}
      />
    </div>
  );
}

function PeriodSwitch({ filters, onChange }: { filters: BetFilters; onChange: Change }) {
  const { t } = useTranslation();
  const custom = filters.from !== null || filters.to !== null;
  return (
    <Segmented<Period | 'custom'>
      label={t('bets.filters.period')}
      items={PERIODS.map((value) => ({ value, label: t(`bets.filters.periods.${value}`) }))}
      value={custom ? 'custom' : filters.period}
      onChange={(value) => {
        if (value !== 'custom') onChange({ ...filters, period: value, from: null, to: null });
      }}
    />
  );
}

function SurfaceToggle({ surface, pressed, onClick }: { surface: SurfaceFilter; pressed: boolean; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className="bets-chipbtn" aria-pressed={pressed} onClick={onClick}>
      {pressed ? (
        <Icon name="check" />
      ) : (
        <i className="bets-dot" style={{ background: surface === 'unknown' ? 'var(--fg-3)' : surfaceColor(surface) }} aria-hidden="true" />
      )}
      {t(`bets.filters.surfaces.${surface}`)}
    </button>
  );
}

function toggled<T>(list: readonly T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

type All = 'all';

function statusOptions(t: TFunction): DropdownOption<StatusFilter | All>[] {
  return [{ value: 'all', label: t('bets.filters.statusAll') }, ...STATUSES.map((s) => ({ value: s, label: t(`bets.filters.statuses.${s}`) }))];
}

function marketOptions(t: TFunction): DropdownOption<MarketFamily | All>[] {
  return [{ value: 'all', label: t('bets.filters.marketAll') }, ...FAMILIES.map((f) => ({ value: f, label: familyTitle(f) }))];
}

function sourceOptions(t: TFunction): DropdownOption<SourceFilter | All>[] {
  return [{ value: 'all', label: t('bets.filters.sourceAll') }, ...SOURCES.map((s) => ({ value: s, label: t(`bets.filters.sources.${s}`) }))];
}

function kindOptions(t: TFunction): DropdownOption<KindFilter | All>[] {
  return [{ value: 'all', label: t('bets.filters.kindAll') }, ...KINDS.map((k) => ({ value: k, label: t(`bets.filters.kinds.${k}`) }))];
}

function none<T extends string>(value: T | All): T | null {
  return value === 'all' ? null : value;
}

/** Свой диапазон дат (пришел ссылкой): метка «3–5 окт» с кнопкой «убрать». */
function DatesChip({ filters, onChange }: { filters: BetFilters; onChange: Change }) {
  const { t } = useTranslation();
  if (!filters.from && !filters.to) return null;
  const text = filters.from && filters.to
    ? formatDateRange(filters.from, filters.to)
    : filters.from
      ? t('bets.filters.since', { date: formatDateRange(filters.from, filters.from) })
      : t('bets.filters.until', { date: formatDateRange(filters.to, filters.to) });
  return (
    <button
      type="button"
      className="bets-chipbtn"
      aria-pressed="true"
      aria-label={t('bets.filters.remove', { name: text })}
      onClick={() => onChange({ ...filters, from: null, to: null })}
    >
      {text}
      <Icon name="x" />
    </button>
  );
}

export function DesktopFilters({ filters, onChange }: { filters: BetFilters; onChange: Change }) {
  const { t } = useTranslation();
  return (
    <div className="bets-filters" role="region" aria-label={t('bets.filters.region')}>
      <SearchBox value={filters.q} onSearch={(q) => onChange({ ...filters, q })} />
      <PeriodSwitch filters={filters} onChange={onChange} />
      <DatesChip filters={filters} onChange={onChange} />
      <Dropdown
        className="bets-select"
        label={t('bets.filters.status')}
        options={statusOptions(t)}
        value={filters.status ?? 'all'}
        onChange={(value) => onChange({ ...filters, status: none(value) })}
      />
      <Dropdown
        className="bets-select"
        label={t('bets.filters.market')}
        options={marketOptions(t)}
        value={filters.family ?? 'all'}
        onChange={(value) => onChange({ ...filters, family: none(value) })}
      />
      <Dropdown
        className="bets-select"
        label={t('bets.filters.source')}
        options={sourceOptions(t)}
        value={filters.source ?? 'all'}
        onChange={(value) => onChange({ ...filters, source: none(value) })}
      />
      <Dropdown
        className="bets-select"
        label={t('bets.filters.kind')}
        options={kindOptions(t)}
        value={filters.kind ?? 'all'}
        onChange={(value) => onChange({ ...filters, kind: none(value) })}
      />
      <div className="bets-chips" role="group" aria-label={t('bets.filters.surface')}>
        {SURFACES.map((surface) => (
          <SurfaceToggle
            key={surface}
            surface={surface}
            pressed={filters.surfaces.includes(surface)}
            onClick={() => onChange({ ...filters, surfaces: toggled(filters.surfaces, surface) })}
          />
        ))}
      </div>
    </div>
  );
}

export function MobileFilters({ filters, onChange, onReset }: { filters: BetFilters; onChange: Change; onReset: () => void }) {
  const { t } = useTranslation();
  const [sheet, setSheet] = useState(false);
  const count = sheetActiveCount(filters);
  const active: { key: string; label: string; drop: () => BetFilters }[] = [];
  if (filters.status) active.push({ key: 'status', label: t(`bets.filters.statuses.${filters.status}`), drop: () => ({ ...filters, status: null }) });
  if (filters.family) active.push({ key: 'market', label: familyTitle(filters.family), drop: () => ({ ...filters, family: null }) });
  if (filters.source) active.push({ key: 'source', label: t(`bets.filters.sources.${filters.source}`), drop: () => ({ ...filters, source: null }) });
  if (filters.kind) active.push({ key: 'kind', label: t(`bets.filters.kinds.${filters.kind}`), drop: () => ({ ...filters, kind: null }) });
  for (const surface of filters.surfaces) {
    active.push({
      key: `surface-${surface}`,
      label: t(`bets.filters.surfaces.${surface}`),
      drop: () => ({ ...filters, surfaces: filters.surfaces.filter((s) => s !== surface) }),
    });
  }
  const dates = filters.from !== null || filters.to !== null;
  return (
    <div className="bets-mfilters" role="region" aria-label={t('bets.filters.region')}>
      <div className="bets-mrow">
        <SearchBox value={filters.q} onSearch={(q) => onChange({ ...filters, q })} />
        <Button
          icon="filter"
          aria-label={count ? t('bets.filters.openCount', { count }) : t('bets.filters.open')}
          onClick={() => setSheet(true)}
        >
          {t('bets.filters.open')}
          {count > 0 && (
            <Chip kind="accent" className="bets-fcount">
              {count}
            </Chip>
          )}
        </Button>
      </div>
      <PeriodSwitch filters={filters} onChange={onChange} />
      {(active.length > 0 || dates) && (
        <div className="bets-active">
          <DatesChip filters={filters} onChange={onChange} />
          {active.map((item) => (
            <button
              key={item.key}
              type="button"
              className="bets-chipbtn"
              aria-pressed="true"
              aria-label={t('bets.filters.remove', { name: item.label })}
              onClick={() => onChange(item.drop())}
            >
              {item.label}
              <Icon name="x" />
            </button>
          ))}
          <button type="button" className="bets-chipbtn" onClick={onReset}>
            {t('bets.filters.resetAll')}
          </button>
        </div>
      )}
      {sheet && <FilterSheet filters={filters} onClose={() => setSheet(false)} onApply={(next) => { setSheet(false); onChange(next); }} />}
    </div>
  );
}

function ChipGroup<V extends string>({ label, options, value, onChange }: { label: string; options: { value: V; label: string }[]; value: V; onChange: (value: V) => void }) {
  return (
    <div className="bets-chipgroup" role="group" aria-label={label}>
      {options.map((option) => (
        <button key={option.value} type="button" className="bets-chipbtn" aria-pressed={option.value === value} onClick={() => onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Шторка фильтров телефона: выбор применяется кнопкой «Показать N ставок». */
function FilterSheet({ filters, onClose, onApply }: { filters: BetFilters; onClose: () => void; onApply: (next: BetFilters) => void }) {
  const { t } = useTranslation();
  const marketId = useId();
  const [draft, setDraft] = useState<BetFilters>(filters);
  const summary = useBetSummary(filtersQuery(draft));
  const found = summary.data ? summary.data.settled + summary.data.open : null;
  const all = t('bets.filters.all');
  return (
    <Modal
      open
      onClose={onClose}
      title={t('bets.filters.sheetTitle')}
      className="bets-sheet"
      footer={
        <>
          <Button onClick={() => onApply({ ...filters, status: null, family: null, source: null, kind: null, surfaces: [] })}>{t('bets.filters.sheetReset')}</Button>
          <Button kind="primary" disabled={found === 0} loading={summary.isFetching && found === null} onClick={() => onApply(draft)}>
            {found === null ? t('bets.filters.sheetApply') : found === 0 ? t('bets.filters.sheetNothing') : t('bets.filters.sheetShow', { count: found })}
          </Button>
        </>
      }
    >
      <div className="field">
        <div className="field-label">{t('bets.filters.statusShort')}</div>
        <ChipGroup<StatusFilter | All>
          label={t('bets.filters.status')}
          options={[{ value: 'all', label: all }, ...STATUSES.map((s) => ({ value: s, label: t(`bets.filters.statuses.${s}`) }))]}
          value={draft.status ?? 'all'}
          onChange={(value) => setDraft({ ...draft, status: none(value) })}
        />
      </div>
      <FieldShell id={marketId} label={t('bets.filters.market')} hint={t('bets.filters.marketHint')}>
        <Dropdown
          id={marketId}
          label={t('bets.filters.market')}
          options={marketOptions(t)}
          value={draft.family ?? 'all'}
          describedBy={`${marketId}-hint`}
          onChange={(value) => setDraft({ ...draft, family: none(value) })}
        />
      </FieldShell>
      <div className="field">
        <div className="field-label">{t('bets.filters.surface')}</div>
        <div className="bets-chipgroup" role="group" aria-label={t('bets.filters.surface')}>
          {SURFACES.map((surface) => (
            <SurfaceToggle
              key={surface}
              surface={surface}
              pressed={draft.surfaces.includes(surface)}
              onClick={() => setDraft({ ...draft, surfaces: toggled(draft.surfaces, surface) })}
            />
          ))}
        </div>
        <div className="field-hint">{t('bets.filters.surfaceHint')}</div>
      </div>
      <div className={cx('field')}>
        <div className="field-label">{t('bets.filters.source')}</div>
        <ChipGroup<SourceFilter | All>
          label={t('bets.filters.source')}
          options={[{ value: 'all', label: all }, ...SOURCES.map((s) => ({ value: s, label: t(`bets.filters.sources.${s}`) }))]}
          value={draft.source ?? 'all'}
          onChange={(value) => setDraft({ ...draft, source: none(value) })}
        />
        <div className="field-hint">{t('bets.filters.sourceHint')}</div>
      </div>
      <div className="field">
        <div className="field-label">{t('bets.filters.kind')}</div>
        <ChipGroup<KindFilter | All>
          label={t('bets.filters.kind')}
          options={[{ value: 'all', label: all }, ...KINDS.map((k) => ({ value: k, label: t(`bets.filters.kinds.${k}`) }))]}
          value={draft.kind ?? 'all'}
          onChange={(value) => setDraft({ ...draft, kind: none(value) })}
        />
      </div>
    </Modal>
  );
}
