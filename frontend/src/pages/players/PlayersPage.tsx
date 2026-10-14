import type { TFunction } from 'i18next';
import { useCallback, useId, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import {
  Button,
  Callout,
  Card,
  Chip,
  DataTable,
  Dropdown,
  EmptyState,
  FieldShell,
  FormDots,
  Icon,
  Segmented,
  Skeleton,
  Stat,
  type DataColumn,
  type IconName,
} from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { usePlayerRanking } from '../../features/players/api';
import { countryName, eloDelta, eloText, hasSackmann, newsState, playerName } from '../../features/players/display';
import {
  DATA_FILTERS,
  filtersFromSearch,
  PAGE_SIZE,
  SEARCH_MAX,
  searchWithFilters,
  SORTS,
  SURFACES,
  withFilter,
  type PlayerFilters,
} from '../../features/players/filters';
import type { ArchiveInfo, PlayerRanking, PlayerRow } from '../../features/players/types';
import { formatDate, formatNumber, formatRelative } from '../../lib/format';
import { cx } from '../../lib/cx';
import { DATA_UPDATE_CLI } from '../../lib/terminal';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { Attribution, CountryCode, IconLine, inlineWhen, LastMatchCell, PlayerNameLink, SearchBox } from './parts';
import './players.css';

/*
 * «Игроки» (mockup/js/screens/players.js, В11): база игроков с местом и Эло по покрытиям, формой,
 * последним матчем в базе и свежестью новостей. Страницы по 50 с сервера (GET /api/players/ranking),
 * поиск — по всей базе, по-русски и латиницей, с опечатками; фильтры и страница — в адресе.
 */

/** «Новости: …» и метка свежести строки. */
function NewsCell({ row, hours }: { row: PlayerRow; hours: number }) {
  const { t } = useTranslation();
  const state = newsState(row.news_checked_at, row.news_fresh);
  const chip =
    state === 'fresh' ? (
      <Chip kind="good" icon="check">
        {t('players.list.newsFresh')}
      </Chip>
    ) : (
      <Chip kind="outline" icon={state === 'stale' ? 'clock' : 'globe'}>
        {state === 'stale' ? t('players.list.newsStale', { hours }) : t('players.list.newsNever')}
      </Chip>
    );
  return (
    <div className="players-cell-2 players-news-cell">
      {chip}
      <small>{row.news_checked_at ? formatRelative(row.news_checked_at) : t('players.list.newsBefore')}</small>
    </div>
  );
}

function newsLine(row: PlayerRow, t: TFunction): string {
  const state = newsState(row.news_checked_at, row.news_fresh);
  if (state === 'never' || !row.news_checked_at) return t('players.list.newsTextNever');
  const ago = formatRelative(row.news_checked_at);
  return state === 'stale' ? t('players.list.newsTextStale', { ago }) : ago;
}

/** Метка «сегодня»: игрок есть в своих ставках или анализах на сегодня. */
function TodayTag({ row }: { row: PlayerRow }) {
  const { t } = useTranslation();
  if (!row.today) return null;
  return (
    <span className="players-today-tag" title={t('players.list.todayTitle')}>
      <Icon name="ticket" />
      {t('players.list.today')}
    </span>
  );
}

/** Имя и под ним страна, возраст (или место по Эло) и метка «сегодня»; link — имя ссылкой. */
function NameCell({ row, rank, link = true }: { row: PlayerRow; rank?: boolean; link?: boolean }) {
  const { t } = useTranslation();
  const sub = rank
    ? row.rank !== null
      ? t('players.list.rankShort', { rank: row.rank })
      : t('players.list.rankNone')
    : row.age !== null
      ? t('players.list.age', { count: row.age })
      : null;
  return (
    <div className="players-name">
      {link ? <PlayerNameLink player={row} /> : <span className="players-link">{playerName(row)}</span>}
      <div className="players-sub">
        <CountryCode code={row.country} title={countryName(row.country, t)} />
        {sub}
        <TodayTag row={row} />
      </div>
    </div>
  );
}

function FormCell({ row }: { row: PlayerRow }) {
  return (
    <span className="players-form">
      <FormDots results={row.form} />
      <span className="small muted num">
        {row.wins}–{row.losses}
      </span>
    </span>
  );
}

function columns(t: TFunction, surface: string, hours: number): DataColumn<PlayerRow>[] {
  return [
    { key: 'player', label: t('players.list.cols.player'), render: (row) => <NameCell row={row} />, primary: true },
    {
      key: 'rank',
      label: t('players.list.cols.rank'),
      render: (row) =>
        row.rank !== null ? (
          <div className="players-cell-2">
            <b className="num">{t('players.list.rankNum', { rank: row.rank })}</b>
            <small>{t('players.list.rankWindow')}</small>
          </div>
        ) : (
          <div className="players-cell-2">
            <span className="muted">—</span>
            <small>{t('players.list.rankNone')}</small>
          </div>
        ),
    },
    { key: 'eloAll', label: t('players.list.cols.eloAll'), align: 'r', render: (row) => <span className="mono">{eloText(row.elo_all)}</span> },
    {
      key: 'eloSurface',
      label: t('players.list.cols.eloSurface', { surface }),
      align: 'r',
      render: (row) => (
        <div className="players-cell-2 players-right">
          <span className="mono players-strong">{eloText(row.elo_surface)}</span>
          {row.elo_delta !== null && <small>{t('players.list.toAll', { delta: eloDelta(row.elo_delta) })}</small>}
        </div>
      ),
    },
    { key: 'form', label: t('players.list.cols.form'), render: (row) => <FormCell row={row} /> },
    { key: 'last', label: t('players.list.cols.last'), render: (row) => <LastMatchCell match={row.last_match} /> },
    { key: 'news', label: t('players.list.cols.news'), render: (row) => <NewsCell row={row} hours={hours} /> },
  ];
}

/**
 * Строка списка на телефоне (players-item макета): имя, три числа, матч в базе и новости. Вся
 * строка — одна ссылка на карточку: зона нажатия большая, вложенных ссылок нет.
 */
function PlayerItem({ row, surface }: { row: PlayerRow; surface: string }) {
  const { t } = useTranslation();
  const last = row.last_match;
  return (
    <li>
      <Link className="players-item" to={paths.player(row.id)}>
      <div className="players-item-top">
        <NameCell row={row} rank link={false} />
      </div>
      <div className="players-item-mid">
        <div className="players-mini">
          <span className="players-mini-l">{t('players.list.mini.surface', { surface })}</span>
          <span className="players-mini-v">
            {eloText(row.elo_surface)}
            {row.elo_delta !== null && <small>{eloDelta(row.elo_delta)}</small>}
          </span>
        </div>
        <div className="players-mini">
          <span className="players-mini-l">{t('players.list.mini.all')}</span>
          <span className="players-mini-v">{eloText(row.elo_all)}</span>
        </div>
        <div className="players-mini">
          <span className="players-mini-l">{t('players.list.mini.form')}</span>
          <span className="players-mini-v">
            <FormDots results={row.form} />
          </span>
          <small className="players-mini-l">
            {row.wins}–{row.losses}
          </small>
        </div>
      </div>
      <div className="players-item-bot">
        <IconLine icon="database">
          {t('players.list.lastMobile', { text: last ? `${formatDate(last.day)}${last.tournament ? ` · ${last.tournament}` : ''}` : '—' })}
        </IconLine>
        <IconLine icon="globe">{t('players.list.newsMobile', { text: newsLine(row, t) })}</IconLine>
      </div>
      </Link>
    </li>
  );
}

function Tiles({ data }: { data: PlayerRanking }) {
  const { t } = useTranslation();
  const archive = data.archive;
  const hours = data.news_ttl_hours;
  // загрузок в журнале нет, а матчи в базе есть — не «еще не загружался»
  let resultsHint = archive.last_load ? t('players.tiles.resultsHint', { when: inlineWhen(archive.last_load, true) }) : archive.data_to ? t('players.tiles.resultsHintNoLog') : t('players.tiles.resultsHintNone');
  if (archive.stale && archive.stale_days !== null) resultsHint += t('players.tiles.staleDays', { count: archive.stale_days });
  const tiles: { key: string; icon: IconName; label: string; value: string; hint: string }[] = [
    { key: 'all', icon: 'users', label: t('players.tiles.all'), value: formatNumber(data.counts.all), hint: t('players.tiles.allHint') },
    { key: 'active', icon: 'calendar', label: t('players.tiles.active'), value: formatNumber(data.counts.active), hint: t('players.tiles.activeHint') },
    {
      key: 'results',
      icon: 'database',
      label: t('players.tiles.results'),
      value: archive.data_to ? t('players.tiles.resultsValue', { date: formatDate(archive.data_to) }) : '—',
      hint: resultsHint,
    },
    { key: 'news', icon: 'globe', label: t('players.tiles.news', { hours }), value: formatNumber(data.counts.news), hint: t('players.tiles.newsHint', { hours }) },
  ];
  return (
    <div className="grid players-tiles">
      {tiles.map((tile) => (
        <div key={tile.key} className="col-3 half-mobile">
          <Stat icon={tile.icon} label={tile.label} value={tile.value} hint={tile.hint} />
        </div>
      ))}
    </div>
  );
}

/** Архив давно не обновлялся: те же сроки, что у уведомления data_stale администратору. */
export function StaleArchive({ archive, admin }: { archive: ArchiveInfo; admin: boolean }) {
  const { t } = useTranslation();
  if (!archive.stale) return null;
  return (
    <Callout kind="warn" icon="database" role="status">
      {/* stale_days пусто — какой-то архив не загружался ни разу; если матчи в базе есть, «еще не загружался» неверно */}
      <b>{archive.stale_days !== null ? t('players.stale.strong', { count: archive.stale_days }) : archive.data_to ? t('players.stale.partly') : t('players.stale.never')}</b>
      {archive.data_to ? t('players.stale.text', { date: formatDate(archive.data_to) }) : t('players.stale.textNone')}
      {admin ? (
        <>
          {t('players.stale.admin')}
          <code className="mono">{DATA_UPDATE_CLI}</code>.
        </>
      ) : (
        t('players.stale.member')
      )}
    </Callout>
  );
}

function Sources({ sackmann }: { sackmann: boolean }) {
  const { t } = useTranslation();
  const items: { key: 'archives' | 'news' | 'odds' | 'legacy'; icon: IconName }[] = [
    { key: 'archives', icon: 'database' },
    { key: 'news', icon: 'globe' },
    { key: 'odds', icon: 'target' },
    { key: 'legacy', icon: 'history' },
  ];
  return (
    <Card title={t('players.sources.title')} subtitle={t('players.sources.subtitle')}>
      <div className="players-sources">
        {items.map((item) => (
          <div key={item.key} className="players-source">
            <span className="players-source-ic">
              <Icon name={item.icon} />
            </span>
            <div className="players-min">
              <h4>{t(`players.sources.${item.key}.title`)}</h4>
              <p>{t(`players.sources.${item.key}.text`)}</p>
            </div>
          </div>
        ))}
      </div>
      <Attribution sackmann={sackmann} />
    </Card>
  );
}

interface FiltersProps {
  filters: PlayerFilters;
  data: PlayerRanking | null;
  mobile: boolean;
  onChange: (next: PlayerFilters, replace?: boolean) => void;
}

function Filters({ filters, data, mobile, onChange }: FiltersProps) {
  const { t } = useTranslation();
  const searchId = useId();
  const sortId = useId();
  const hours = data?.news_ttl_hours ?? 12;
  const count = (value: number | undefined) => (value === undefined ? null : <span className="players-count">{formatNumber(value)}</span>);
  return (
    <div className="players-filters" role="search" aria-label={t('players.filters.region')}>
      <SearchBox
        id={searchId}
        value={filters.q}
        maxLength={SEARCH_MAX}
        label={t('players.filters.search')}
        placeholder={mobile ? t('players.filters.searchPlaceholderShort') : t('players.filters.searchPlaceholder')}
        onSearch={(q) => onChange(withFilter(filters, { q }), true)}
      />
      <div className="players-fgroup">
        <span className="players-flabel">{t('players.filters.data')}</span>
        <Segmented
          label={t('players.filters.dataLabel')}
          value={filters.data}
          onChange={(value) => onChange(withFilter(filters, { data: value }))}
          items={DATA_FILTERS.map((value) => ({
            value,
            label: (
              <>
                {mobile ? t(`players.filters.dataShort.${value}`) : t(`players.filters.dataItems.${value}`, { hours })}
                {count(data?.counts[value])}
              </>
            ),
          }))}
        />
      </div>
      <div className="players-fgroup">
        <span className="players-flabel">{t('players.filters.surface')}</span>
        <Segmented
          label={t('players.filters.surfaceLabel')}
          value={filters.surface}
          onChange={(value) => onChange(withFilter(filters, { surface: value }))}
          items={SURFACES.map((value) => ({ value, label: t(`analysis.surface.${value}`) }))}
        />
      </div>
      <FieldShell id={sortId} label={t('players.filters.sort')} className="players-fgroup players-sort">
        <Dropdown
          id={sortId}
          label={t('players.filters.sort')}
          value={filters.sort}
          options={SORTS.map((value) => ({ value, label: t(`players.filters.sorts.${value}`) }))}
          onChange={(value) => onChange(withFilter(filters, { sort: value }))}
        />
      </FieldShell>
    </div>
  );
}

export function PlayersPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const ranking = usePlayerRanking(filters);
  const data = ranking.head;

  // Адрес меняем от последнего записанного: две правки подряд не затирают друг друга
  const latest = useRef(params);
  const seen = useRef(params);
  if (seen.current !== params) {
    seen.current = params;
    latest.current = params;
  }
  const setFilters = useCallback(
    (next: PlayerFilters, replace = false) => {
      const search = searchWithFilters(next, latest.current);
      latest.current = search;
      setParams(search, { replace });
    },
    [setParams],
  );

  const surfaceLabel = t(`analysis.surface.${filters.surface}`);
  const hours = data?.news_ttl_hours ?? 12;
  const open = (row: PlayerRow) => navigate(paths.player(row.id));
  const q = filters.q.trim();
  const total = data?.total ?? 0;
  const shown = ranking.rows.length;
  const moreLeft = data !== null && shown < total;
  // Следующая страница уже в адресе и еще идет: кнопка ждет, повторный клик ничего не добавляет
  const waitingMore = ranking.loadedPages < filters.page && ranking.error === null;

  let results;
  if (ranking.loading) {
    results = (
      <div className="players-loading" aria-busy="true">
        <Skeleton lines={6} />
      </div>
    );
  } else if (!data) {
    results = (
      <Callout kind="bad" role="alert">
        {t('players.list.failed')} {apiErrorText(ranking.error)}{' '}
        <Button size="sm" kind="ghost" icon="refresh" onClick={ranking.refetch}>
          {t('common.retry')}
        </Button>
      </Callout>
    );
  } else if (!ranking.rows.length) {
    results = (
      <EmptyState
        className="players-empty"
        text={q ? t('players.list.emptyQuery', { q }) : t('players.list.empty')}
        action={
          <Button kind="secondary" size="sm" icon="x" onClick={() => setFilters({ ...filters, q: '', data: 'active', page: 1 })}>
            {t('players.list.reset')}
          </Button>
        }
      />
    );
  } else if (mobile) {
    results = (
      <ul className="players-items" aria-label={t('players.list.caption')}>
        {ranking.rows.map((row) => (
          <PlayerItem key={row.id} row={row} surface={surfaceLabel} />
        ))}
      </ul>
    );
  } else {
    results = (
      <DataTable
        className="players-table"
        caption={t('players.list.caption')}
        columns={columns(t, surfaceLabel, hours)}
        rows={ranking.rows}
        rowKey={(row) => row.id}
        onRowClick={open}
      />
    );
  }

  const countText = q
    ? data?.fuzzy
      ? t('players.list.foundFuzzy', { count: total })
      : t('players.list.found', { count: total })
    : t('players.list.shown', { shown: formatNumber(shown), total: formatNumber(total) });

  return (
    <div className="players-root stack">
      <div className="page-head players-head">
        <div className="players-min">
          <h2>{t('players.head.title')}</h2>
          <p className="lead">{t('players.head.lead', { page: PAGE_SIZE })}</p>
        </div>
      </div>
      {data ? (
        <Tiles data={data} />
      ) : (
        ranking.loading && (
          <div className="grid players-tiles" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="col-3 half-mobile">
                <Card>
                  <Skeleton lines={3} />
                </Card>
              </div>
            ))}
          </div>
        )
      )}
      {data && <StaleArchive archive={data.archive} admin={me?.role === 'admin'} />}
      <section className="card players-list" aria-label={t('players.list.label')}>
        <Filters filters={filters} data={data} mobile={mobile} onChange={setFilters} />
        <div className={cx('players-results', ranking.pending && 'players-pending')} aria-busy={ranking.pending || undefined}>
          {results}
        </div>
        {data && ranking.rows.length > 0 && (
          <div className="card-foot players-results-foot">
            <span>
              {countText}
              {t('players.list.foot', { page: PAGE_SIZE })}
            </span>
            {ranking.error !== null && shown > 0 && <span className="bad-text">{t('players.list.moreFailed')}</span>}
            {moreLeft && (
              <Button
                kind="secondary"
                size="sm"
                icon="list"
                loading={waitingMore}
                onClick={() => {
                  if (!waitingMore) setFilters({ ...filters, page: filters.page + 1 }, true);
                }}
              >
                {t('players.list.more', { n: Math.min(PAGE_SIZE, total - shown) })}
              </Button>
            )}
            {ranking.error !== null && shown > 0 && (
              <Button kind="ghost" size="sm" icon="refresh" onClick={ranking.refetch}>
                {t('common.retry')}
              </Button>
            )}
          </div>
        )}
      </section>
      <Sources sackmann={data ? hasSackmann(data.archive) : true} />
    </div>
  );
}

