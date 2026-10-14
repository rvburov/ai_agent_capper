import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import {
  Button,
  Callout,
  Card,
  DataTable,
  EmptyState,
  Icon,
  KeyValue,
  Meter,
  Skeleton,
  SurfaceChip,
  surfaceColor,
  isSurface,
} from '../../components';
import { ChartLegend, ChartWithTable, HBars } from '../../components/charts';
import { apiErrorText } from '../../features/analysis/codes';
import { analysisNumber } from '../../features/analysis/number';
import { roundLabel } from '../../features/analysis/rounds';
import { usePlayerH2H } from '../../features/players/api';
import { eloDelta, eloText, playerName, scoreText, shortName, winShare } from '../../features/players/display';
import type { PlayerCard, ServeMetrics, SurfaceElo, SurfaceResult, TodayMatch, WinLoss } from '../../features/players/types';
import { formatDate, formatDateLong, formatMonthYear, formatNumber, formatPercent, formatPp } from '../../lib/format';
import { cx } from '../../lib/cx';
import { inlineWhen, matchPlace } from './parts';

// Вкладка «Обзор» карточки игрока (tabOverview макета): Эло по покрытиям, форма, подача и прием
// против среднего по туру, результаты по покрытиям и ключевые матчи; «сегодня» — входные точки
// модели (Эло и личные встречи) из своих ставок и анализов.

/** «В–П · %»: «12–4 · 75%»; матчей нет — «0–0». */
function record(item: WinLoss): string {
  const share = winShare(item.wins, item.losses);
  return share === null ? `${item.wins}–${item.losses}` : `${item.wins}–${item.losses} · ${formatPercent(share, { digits: 0 })}`;
}

function surfaceOn(surface: string | null, t: TFunction): string | null {
  return isSurface(surface) ? t(`players.surfaceOn.${surface}`) : null;
}

/** Все личные встречи: грузятся по кнопке (GET /api/players/{id}/h2h/{opponent}). */
function H2HList({ playerId, opponentId }: { playerId: number; opponentId: number }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const h2h = usePlayerH2H(playerId, opponentId, open);
  return (
    <div className="players-h2h">
      <Button kind="ghost" size="sm" icon="list" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? t('players.overview.today.hide') : t('players.overview.today.all')}
      </Button>
      {open &&
        (h2h.data ? (
          h2h.data.matches.length ? (
            <ul className="players-h2h-list" aria-label={t('players.overview.today.listLabel')}>
              {h2h.data.matches.map((match) => (
                <li key={match.match_id}>
                  <span className="players-nowrap">{formatDate(match.day)}</span>
                  <span className="players-min">
                    {[match.tournament, roundLabel(match.round)].filter(Boolean).join(', ')}
                    {match.score ? ` · ${scoreText(match.score)}` : ''}
                  </span>
                  <b className={match.winner_id === playerId ? 'good-text' : 'bad-text'}>
                    {match.winner_id === playerId ? t('players.overview.today.won') : t('players.overview.today.lost')}
                  </b>
                </li>
              ))}
            </ul>
          ) : (
            <span className="xsmall">{t('players.overview.today.h2hNone')}</span>
          )
        ) : h2h.isError ? (
          <span className="xsmall bad-text">{apiErrorText(h2h.error)}</span>
        ) : (
          <Skeleton lines={2} />
        ))}
    </div>
  );
}

/** «Сегодня: Синнер — Руне»: Эло, личные встречи и где итог (eloNote макета). */
function TodayNote({ card, today }: { card: PlayerCard; today: TodayMatch }) {
  const { t } = useTranslation();
  const on = surfaceOn(today.surface, t);
  const h2h = today.h2h;
  const total = h2h.wins + h2h.losses;
  const analysis = today.analyses[0];
  let prob;
  if (today.elo_prob === null) prob = t('players.overview.today.noProb');
  else if (on) prob = t('players.overview.today.prob', { surface: on, p: formatPercent(today.elo_prob, { digits: 0 }) });
  else prob = t('players.overview.today.probAny', { p: formatPercent(today.elo_prob, { digits: 0 }) });
  let meetings;
  if (!total) meetings = t('players.overview.today.h2hNone');
  else {
    meetings = t('players.overview.today.h2h', { w: h2h.wins, l: h2h.losses });
    if (on) meetings += t('players.overview.today.h2hSurface', { surface: on, w: h2h.surface_wins, l: h2h.surface_losses });
    if (h2h.last_day) {
      meetings += t('players.overview.today.h2hLast', {
        date: formatDate(h2h.last_day),
        result: h2h.last_won ? t('players.overview.today.won') : t('players.overview.today.lost'),
      });
    }
  }
  return (
    <Callout kind="info" icon="target">
      <div className="stack players-today-note">
        <b>{t('players.overview.today.title', { a: shortName(playerName(card)), b: shortName(playerName(today.opponent)) })}</b>
        <div>{prob}</div>
        <div>{meetings}</div>
        <div className="xsmall players-soft">
          {t('players.overview.today.input')}
          {analysis !== undefined ? (
            <Link to={paths.analysis(analysis)}>{t('players.overview.today.inAnalysis', { id: analysisNumber(analysis) })}</Link>
          ) : (
            t('players.overview.today.inBet')
          )}
          .
        </div>
        {total > 0 && <H2HList playerId={card.id} opponentId={today.opponent.id} />}
      </div>
    </Callout>
  );
}

function EloCard({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const known = card.elo.surfaces.filter((item): item is SurfaceElo & { elo: number; delta: number } => item.elo !== null && item.delta !== null);
  const maxDelta = Math.max(0, ...known.map((item) => Math.abs(item.delta)));
  const lim = Math.max(50, Math.ceil(maxDelta / 50) * 50);
  const surfaceName = (surface: SurfaceElo['surface']) => t(`analysis.surface.${surface}`);
  return (
    <Card
      className="col-7 players-card"
      title={t('players.overview.elo.title')}
      subtitle={card.elo.all !== null ? t('players.overview.elo.subtitle', { elo: eloText(card.elo.all) }) : undefined}
    >
      {card.elo.all === null || !known.length ? (
        <EmptyState>{t('players.overview.elo.none')}</EmptyState>
      ) : (
        <ChartWithTable
          table={() => (
            <DataTable
              mobileLayout="table"
              caption={t('players.overview.elo.title')}
              rows={card.elo.surfaces}
              rowKey={(item) => item.surface}
              columns={[
                { key: 'surface', label: t('players.overview.elo.cols.surface'), render: (item) => <SurfaceChip surface={item.surface} /> },
                { key: 'elo', label: t('players.overview.elo.cols.elo'), align: 'r', render: (item) => <span className="mono">{eloText(item.elo)}</span> },
                { key: 'delta', label: t('players.overview.elo.cols.delta'), align: 'r', render: (item) => eloDelta(item.delta) },
                { key: 'matches', label: t('players.overview.elo.cols.matches'), align: 'r', render: (item) => formatNumber(item.matches) },
              ]}
            />
          )}
        >
          <HBars
            ariaLabel={t('players.overview.elo.aria')}
            domain={[-lim, lim]}
            items={known.map((item) => ({
              key: item.surface,
              label: surfaceName(item.surface),
              value: item.delta,
              valueText: eloText(item.elo),
              note: eloDelta(item.delta),
              color: surfaceColor(item.surface),
            }))}
          />
        </ChartWithTable>
      )}
      <p className="players-hint">{t('players.overview.elo.hint')}</p>
      {card.today.map((today) => (
        <TodayNote key={today.match_id} card={card} today={today} />
      ))}
    </Card>
  );
}

function FormCard({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const form = card.form;
  const last = card.last_match;
  const news = card.news;
  const words = form.matches.map((match) => (match.won ? t('players.overview.form.winWord') : t('players.overview.form.lossWord')));
  const items = [
    {
      key: 'last',
      label: t('players.overview.form.last'),
      value: last ? [formatDate(last.day), matchPlace(last)].filter(Boolean).join(' · ') : '—',
    },
    { key: 'm14', label: t('players.overview.form.m14'), value: formatNumber(form.matches_14d) },
    ...(card.today.length && form.rest_days !== null ? [{ key: 'rest', label: t('players.overview.form.rest'), value: formatNumber(form.rest_days) }] : []),
    {
      key: 'news',
      label: t('players.overview.form.news'),
      value: news.checked_at
        ? `${inlineWhen(news.checked_at)}${news.fresh ? '' : t('players.overview.form.newsStale', { hours: news.ttl_hours })}`
        : t('players.overview.form.newsNever'),
    },
  ];
  return (
    <Card
      className="col-5 players-card"
      title={t('players.overview.form.title')}
      subtitle={card.archive.data_to ? t('players.overview.form.subtitle', { date: formatDate(card.archive.data_to) }) : undefined}
    >
      {form.matches.length ? (
        <div className="stack players-gap8">
          <div className="players-formbig" role="img" aria-label={t('players.overview.form.aria', { count: words.length, list: words.join(', ') })}>
            {form.matches.map((match) => (
              <span key={match.match_id} className={match.won ? 'w' : 'l'} aria-hidden="true">
                {match.won ? t('players.overview.form.win') : t('players.overview.form.loss')}
              </span>
            ))}
          </div>
          <div className="players-hint">
            {t('players.overview.form.hint', { wins: t('players.overview.form.wins', { count: form.wins }), total: form.matches.length })}
          </div>
        </div>
      ) : (
        <EmptyState>{t('players.overview.form.none')}</EmptyState>
      )}
      <KeyValue className="players-kv" items={items} />
      <p className="players-hint">{t('players.overview.form.noFields')}</p>
    </Card>
  );
}

type MetricKey = keyof Omit<ServeMetrics, 'matches'>;

interface MetricSpec {
  key: MetricKey;
  /** Доля 0…1 (показ в %) или число за матч. */
  percent: boolean;
  /** Правый край полосы. */
  max: number;
  /** Меньше — лучше (двойные ошибки). */
  lowerBetter?: boolean;
}

const SERVE: readonly MetricSpec[] = [
  { key: 'first_in', percent: true, max: 1 },
  { key: 'first_won', percent: true, max: 1 },
  { key: 'second_won', percent: true, max: 1 },
  { key: 'aces_per_match', percent: false, max: 15 },
  { key: 'double_faults_per_match', percent: false, max: 6, lowerBetter: true },
];
const RETURN: readonly MetricSpec[] = [
  { key: 'first_return_won', percent: true, max: 1 },
  { key: 'second_return_won', percent: true, max: 1 },
  { key: 'bp_converted', percent: true, max: 1 },
  { key: 'bp_saved', percent: true, max: 1 },
];

function metricText(spec: MetricSpec, value: number): string {
  return spec.percent ? formatPercent(value, { digits: 0 }) : formatNumber(value, 1);
}

function Metric({ spec, player, tour }: { spec: MetricSpec; player: ServeMetrics; tour: ServeMetrics | null }) {
  const { t } = useTranslation();
  const label = t(`players.overview.serve.metrics.${spec.key}`);
  const value = player[spec.key];
  const base = tour?.[spec.key] ?? null;
  if (value === null) {
    return (
      <div className="players-metric">
        <div className="players-metric-top">
          <span className="players-metric-label">{label}</span>
          <span className="players-metric-val">—</span>
        </div>
      </div>
    );
  }
  const clamp = (v: number) => Math.max(0, Math.min(100, (v / spec.max) * 100));
  let delta = null;
  if (base !== null) {
    const diff = value - base;
    const flat = Math.abs(diff) < (spec.percent ? 0.01 : 0.3);
    const good = spec.lowerBetter ? diff < 0 : diff > 0;
    const text = flat ? t('players.overview.serve.tour') : spec.percent ? formatPp(diff, { digits: 0 }) : formatNumber(diff, 1, { signed: true });
    delta = (
      <span className={cx('players-metric-delta', flat ? 'flat' : good ? 'good-text' : 'bad-text')} title={t('players.overview.serve.tourTitle', { value: metricText(spec, base) })}>
        {!flat && <Icon name={diff > 0 ? 'arrowUp' : 'arrowDown'} />}
        {text}
      </span>
    );
  }
  return (
    <div className="players-metric">
      <div className="players-metric-top">
        <span className="players-metric-label">{label}</span>
        <span className="players-metric-val">
          {metricText(spec, value)}
          {delta}
        </span>
      </div>
      <div
        className="players-bullet"
        role="img"
        aria-label={
          base !== null
            ? t('players.overview.serve.aria', { label, value: metricText(spec, value), tour: metricText(spec, base) })
            : t('players.overview.serve.ariaAlone', { label, value: metricText(spec, value) })
        }
      >
        <i style={{ width: `${clamp(value)}%` }} />
        {base !== null && <b style={{ left: `${clamp(base)}%` }} />}
      </div>
    </div>
  );
}

function ServeCard({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const serve = card.serve;
  const player = serve?.player ?? null;
  return (
    <Card
      className="col-7 players-card"
      title={t('players.overview.serve.title')}
      subtitle={
        serve
          ? t('players.overview.serve.subtitle', {
              month: formatMonthYear(serve.period_to),
              to: formatDateLong(serve.period_to),
              n: serve.tour_players,
            })
          : undefined
      }
      actions={
        player && serve?.tour ? (
          <ChartLegend
            items={[
              { key: 'player', name: shortName(playerName(card)), color: 'var(--s1)', type: 'box' },
              { key: 'tour', name: t('players.overview.serve.legendTour'), type: 'dash' },
            ]}
          />
        ) : undefined
      }
    >
      {serve && player ? (
        <>
          <div className="players-metrics">
            <div className="players-metrics-col">
              <div className="eyebrow">{t('players.overview.serve.serveCol')}</div>
              {SERVE.map((spec) => (
                <Metric key={spec.key} spec={spec} player={player} tour={serve.tour} />
              ))}
            </div>
            <div className="players-metrics-col">
              <div className="eyebrow">{t('players.overview.serve.returnCol')}</div>
              {RETURN.map((spec) => (
                <Metric key={spec.key} spec={spec} player={player} tour={serve.tour} />
              ))}
            </div>
          </div>
          <p className="players-hint">
            {t('players.overview.serve.hint', { to: formatDateLong(serve.period_to), count: player.matches })}
          </p>
        </>
      ) : (
        <EmptyState>{t('players.overview.serve.none')}</EmptyState>
      )}
    </Card>
  );
}

type ResultRow = SurfaceResult | (WinLoss & { surface: 'total' });

function ResultsCard({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const rows: ResultRow[] = [...card.results.surfaces, { ...card.results.total, surface: 'total' }];
  const key = card.key_matches;
  const played = card.results.total.wins + card.results.total.losses;
  return (
    <Card className="col-5 players-card" title={t('players.overview.results.title')} subtitle={t('players.overview.results.subtitle', { date: formatDate(card.results.since) })} flush>
      {played ? (
        <DataTable
          mobileLayout="table"
          caption={t('players.overview.results.title')}
          rows={rows}
          rowKey={(row) => row.surface}
          columns={[
            {
              key: 'surface',
              label: t('players.overview.results.cols.surface'),
              render: (row) => (row.surface === 'total' ? <b>{t('players.overview.results.total')}</b> : <SurfaceChip surface={row.surface} />),
            },
            { key: 'wl', label: t('players.overview.results.cols.wl'), align: 'r', render: (row) => <span className="mono">{`${row.wins}–${row.losses}`}</span> },
            {
              key: 'pct',
              label: t('players.overview.results.cols.pct'),
              align: 'r',
              render: (row) => {
                const share = winShare(row.wins, row.losses);
                return (
                  <span className="players-wl-meter">
                    <b className="num">{share === null ? '—' : formatPercent(share, { digits: 0 })}</b>
                    <Meter value={row.wins} max={row.wins + row.losses} label={t('players.overview.results.cols.pct')} />
                  </span>
                );
              },
            },
          ]}
        />
      ) : (
        <div className="players-pad">
          <EmptyState>{t('players.overview.results.none')}</EmptyState>
        </div>
      )}
      <div className="players-vs">
        <div className="eyebrow">{t('players.overview.results.key')}</div>
        <KeyValue
          className="players-kv"
          items={[
            { key: 'top10', label: t('players.overview.results.top10'), value: <span className="num">{record(key.top10)}</span> },
            { key: 'deciders', label: t('players.overview.results.deciders'), value: <span className="num">{record(key.deciders)}</span> },
            { key: 'tiebreaks', label: t('players.overview.results.tiebreaks'), value: <span className="num">{record(key.tiebreaks)}</span> },
          ]}
        />
      </div>
    </Card>
  );
}

export function OverviewTab({ card }: { card: PlayerCard }) {
  return (
    <div className="grid">
      <EloCard card={card} />
      <FormCard card={card} />
      <ServeCard card={card} />
      <ResultsCard card={card} />
    </div>
  );
}

