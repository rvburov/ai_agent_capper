import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, FormDots, Icon, Segmented, type ChipKind, type IconName } from '../../components';
import { inlineDateTime, keyText } from '../../features/analysis/codes';
import { shortName } from '../../features/analysis/draft';
import { formatProb, marketDescription, marketLabel, ppDelta, shownMarkets, valueTier } from '../../features/analysis/markets';
import { roundLabel } from '../../features/analysis/rounds';
import type { ComparisonRow, Factor, MarketRow, MatchResult } from '../../features/analysis/types';
import { formatDate, formatNumber, formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';

// Карточка матча итога (matchCard в mockup/js/screens/analysis.js): выбор, сравнение игроков,
// вероятности по рынкам (модель, Claude с поправкой, рынок без маржи, кэф, валуй), факторы.
// На телефоне — переключатель «Вероятности / Сравнение / Факторы» и список вместо таблицы.

type T = TFunction;

export interface MatchNames {
  /** Имя игрока на экране по id (по-русски из подтвержденных событий, если есть). */
  name: (id: number, fallback: string) => string;
}

export function outcomeName(row: MarketRow, match: MatchResult, names: MatchNames): string {
  const player = row.selection === 1 ? match.player1 : match.player2;
  return `${shortName(names.name(player.id, player.name))} ${marketLabel(row.market, row.selection)}`;
}

export function outcomeDesc(row: MarketRow, match: MatchResult, names: MatchNames): string {
  const player = row.selection === 1 ? match.player1 : match.player2;
  return marketDescription(row.market, shortName(names.name(player.id, player.name)), match.best_of);
}

function ValueCell({ row }: { row: MarketRow }) {
  const { t } = useTranslation();
  if (row.value === null) return <span className="analysis-val-none">—</span>;
  const tier = valueTier(row.tier);
  return (
    <div className="analysis-val">
      <span className={cx('analysis-val-num', row.value >= 0.05 && 'is-pos', row.value < 0 && 'is-neg')}>
        {formatPercent(row.value, { signed: true })}
      </span>
      {tier ? (
        <Chip kind={tier === 'small' ? 'info' : 'good'} icon={tier === 'strong' ? 'spark' : 'arrowUp'}>
          {t(`analysis.value.${tier}`)}
        </Chip>
      ) : (
        <span className="analysis-val-none">{row.value < 0 ? t('analysis.value.none') : t('analysis.value.low')}</span>
      )}
    </div>
  );
}

function Outcome({ row, match, names }: { row: MarketRow; match: MatchResult; names: MatchNames }) {
  const { t } = useTranslation();
  return (
    <div className="analysis-out">
      <b>{outcomeName(row, match, names)}</b>
      <small>{outcomeDesc(row, match, names)}</small>
      {row.in_express ? (
        <Chip kind="accent" icon="ticket">
          {t('analysis.match.inExpress')}
        </Chip>
      ) : (
        row.note_key && <small>{keyText(row.note_key, {}, '')}</small>
      )}
    </div>
  );
}

function ClaudeCell({ row }: { row: MarketRow }) {
  const { t } = useTranslation();
  const clamped = Math.abs(row.p_claude - row.p_final) > 0.0005;
  return (
    <span className="analysis-pnum" title={clamped ? t('analysis.match.clamped', { p: formatProb(row.p_claude) }) : undefined}>
      {formatProb(row.p_final)}
      <small>{ppDelta(row.p_final - row.p_base)}</small>
    </span>
  );
}

function ProbTable({ match, names, bookmaker }: { match: MatchResult; names: MatchNames; bookmaker: string | null }) {
  const { t } = useTranslation();
  const rows = shownMarkets(match.markets);
  const th = (label: string, sub: string | null, cls?: string) => (
    <th scope="col" className={cls}>
      {label}
      {sub && <span className="analysis-th-sub">{sub}</span>}
    </th>
  );
  return (
    <div className="table-wrap analysis-ptable-wrap">
      <table className="table analysis-ptable">
        <caption className="sr-only">{t('analysis.match.probsCaption', { match: matchTitle(match, names, t) })}</caption>
        <thead>
          <tr>
            {th(t('analysis.match.colOutcome'), null, 'analysis-th-out')}
            {th(t('analysis.match.colModel'), t('analysis.match.colModelSub'), 'r')}
            {th(t('analysis.match.colClaude'), match.news_state === 'failed' || match.news_state === 'limit' || match.news_state === 'off' ? t('analysis.match.colClaudeNoNews') : t('analysis.match.colClaudeSub'), 'r')}
            {th(t('analysis.match.colMarket'), t('analysis.match.colMarketSub'), 'r')}
            {th(t('analysis.match.colOdds'), bookmaker, 'r')}
            {th(t('analysis.match.colValue'), t('analysis.match.colValueSub'), 'r')}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.market}-${row.selection}`} className={cx(row.in_express && 'is-pick')}>
              <td>
                <Outcome row={row} match={match} names={names} />
              </td>
              <td className="r">
                <span className="analysis-pnum">{formatProb(row.p_base)}</span>
              </td>
              <td className="r">
                <ClaudeCell row={row} />
              </td>
              <td className="r">
                <span className="analysis-pnum">{row.q_market === null ? '—' : formatProb(row.q_market)}</span>
              </td>
              <td className="r">
                <span className="odds">{row.odds === null ? '—' : formatOdds(row.odds)}</span>
              </td>
              <td className="r">
                <ValueCell row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ProbList({ match, names }: { match: MatchResult; names: MatchNames }) {
  const { t } = useTranslation();
  return (
    <ul className="analysis-plist" aria-label={t('analysis.match.probs')}>
      {shownMarkets(match.markets).map((row) => (
        <li key={`${row.market}-${row.selection}`} className={cx('analysis-pitem', row.in_express && 'is-pick')}>
          <div className="analysis-pitem-top">
            <Outcome row={row} match={match} names={names} />
            <ValueCell row={row} />
          </div>
          <dl className="analysis-pgrid">
            <div>
              <dt>{t('analysis.match.colModel')}</dt>
              <dd>{formatProb(row.p_base)}</dd>
            </div>
            <div>
              <dt>{t('analysis.match.colClaude')}</dt>
              <dd>
                {formatProb(row.p_final)} <small>{ppDelta(row.p_final - row.p_base, { unit: false })}</small>
              </dd>
            </div>
            <div>
              <dt>{t('analysis.match.colMarket')}</dt>
              <dd>{row.q_market === null ? '—' : formatProb(row.q_market)}</dd>
            </div>
            <div>
              <dt>{t('analysis.match.colOddsShort')}</dt>
              <dd className="odds">{row.odds === null ? '—' : formatOdds(row.odds)}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function compareValue(row: ComparisonRow, side: 'left' | 'right', match: MatchResult, t: T): { main: ReactNode; sub: string | null } {
  const value = side === 'left' ? row.left : row.right;
  const sub = side === 'left' ? row.sub_left : row.sub_right;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  switch (row.key) {
    case 'elo_rank':
      return { main: num(value) !== null ? t('analysis.compare.rank', { rank: value }) : '—', sub: null };
    case 'elo_surface':
      return { main: num(value) !== null ? formatNumber(num(value)) : '—', sub: num(sub) !== null ? t('analysis.compare.matches', { count: num(sub) ?? 0 }) : null };
    case 'form10': {
      const form = side === 'left' ? match.form.p1 : match.form.p2;
      return {
        main: (
          <span className="analysis-vs-form">
            <FormDots results={form} />
            {String(value ?? '—').replace('-', '–')}
          </span>
        ),
        sub: sub ? t('analysis.compare.last5', { score: String(sub).replace('-', '–') }) : null,
      };
    }
    case 'load14':
      return { main: value === null ? '—' : String(value), sub: num(sub) !== null ? t('analysis.compare.rest', { count: num(sub) ?? 0 }) : null };
    case 'serve_first':
    case 'serve_second':
    case 'return':
      return { main: num(value) !== null ? formatPercent(num(value), { digits: 0 }) : '—', sub: null };
    case 'tiebreaks':
      return { main: String(value ?? '—').replace('-', '–'), sub: num(sub) !== null ? formatPercent(num(sub), { digits: 0 }) : null };
    case 'h2h':
      return { main: value === null ? '—' : String(value), sub: sub !== null ? t('analysis.compare.onSurface', { n: sub }) : null };
    default:
      return { main: value === null ? '—' : String(value), sub: sub === null ? null : String(sub) };
  }
}

function compareLabel(row: ComparisonRow, match: MatchResult, t: T): string {
  if (row.key === 'elo_surface') {
    const surface = match.surface;
    return surface === 'clay' || surface === 'grass' || surface === 'hard' || surface === 'carpet'
      ? t(`analysis.compare.eloOn.${surface}`)
      : t('analysis.compare.elo_surface');
  }
  return keyText(`analysis.compare.${row.key}`, {}, row.key);
}

function Comparison({ match, names }: { match: MatchResult; names: MatchNames }) {
  const { t } = useTranslation();
  const head = (player: MatchResult['player1'], cls: 'l' | 'r') => (
    <div className={cx('analysis-vs-side', cls)}>
      <span className="analysis-vs-name">{shortName(names.name(player.id, player.name))}</span>
      <span className="analysis-vs-sub">
        {[player.country, player.elo_rank ? t('analysis.compare.rankOf', { rank: player.elo_rank }) : null].filter(Boolean).join(' · ')}
      </span>
    </div>
  );
  return (
    <div className="analysis-vs">
      <div className="analysis-vs-head">
        {head(match.player1, 'l')}
        <div className="analysis-vs-vs">{t('analysis.compare.vs')}</div>
        {head(match.player2, 'r')}
      </div>
      {match.comparison.map((row) => {
        const cell = (side: 'left' | 'right') => {
          const { main, sub } = compareValue(row, side, match, t);
          const better = row.better === side;
          return (
            <div className={cx('analysis-vs-side', side === 'left' ? 'l' : 'r', better && 'is-better')}>
              <span className="analysis-vs-num">
                {better && <Icon name="check" />}
                {main}
              </span>
              {better && <span className="sr-only">{t('analysis.compare.better')}</span>}
              {sub && <span className="analysis-vs-sub">{sub}</span>}
            </div>
          );
        };
        return (
          <div key={row.key} className="analysis-vs-row">
            {cell('left')}
            <div className="analysis-vs-label">{compareLabel(row, match, t)}</div>
            {cell('right')}
          </div>
        );
      })}
    </div>
  );
}

const REF_SOURCES = new Set(['elo', 'form', 'h2h', 'serve', 'load']);

function sourceText(factor: Factor, t: T): string {
  if (factor.source_name || factor.source_url) {
    const name = factor.source_name ?? (factor.source_url ? new URL(factor.source_url).hostname : '');
    return factor.date ? t('analysis.factors.sourceDate', { name, date: formatDate(factor.date) }) : name;
  }
  return REF_SOURCES.has(factor.ref) ? t('analysis.factors.archive') : t('analysis.factors.news');
}

function Factors({ match, pickSide, pickName }: { match: MatchResult; pickSide: number; pickName: string }) {
  const { t } = useTranslation();
  const supports = (f: Factor) => (f.player === pickSide) === (f.effect === 'plus');
  const pro = match.factors.filter(supports);
  const con = match.factors.filter((f) => !supports(f));
  const item = (factor: Factor, kind: 'pro' | 'con', index: number) => (
    <li key={`${kind}-${index}`}>
      <span className={cx('analysis-sign', kind)} role="img" aria-label={kind === 'pro' ? t('analysis.factors.pro') : t('analysis.factors.con')}>
        {kind === 'pro' ? '+' : '−'}
      </span>
      <div className="analysis-fbody">
        <div>{factor.text}</div>
        <div className="analysis-src">
          <Icon name="globe" />
          {factor.source_url ? (
            <a href={factor.source_url} target="_blank" rel="noopener noreferrer">
              {sourceText(factor, t)}
            </a>
          ) : (
            sourceText(factor, t)
          )}
        </div>
      </div>
    </li>
  );
  return (
    <div className="analysis-factors">
      <div className="analysis-fcol">
        <h5>{t('analysis.factors.for', { pick: pickName })}</h5>
        {pro.length ? <ul className="analysis-fl">{pro.map((f, i) => item(f, 'pro', i))}</ul> : <p className="small muted">{t('analysis.factors.empty')}</p>}
      </div>
      <div className="analysis-fcol">
        <h5>{t('analysis.factors.against')}</h5>
        {con.length ? <ul className="analysis-fl">{con.map((f, i) => item(f, 'con', i))}</ul> : <p className="small muted">{t('analysis.factors.empty')}</p>}
      </div>
    </div>
  );
}

export function matchTitle(match: MatchResult, names: MatchNames, t: T): string {
  return t('analysis.matchTitle', {
    p1: shortName(names.name(match.player1.id, match.player1.name)),
    p2: shortName(names.name(match.player2.id, match.player2.name)),
  });
}

const CONFIDENCE: Record<MatchResult['confidence'], [ChipKind, IconName]> = {
  high: ['good', 'shield'],
  medium: ['warn', 'alert'],
  low: ['bad', 'alert'],
};

function newsState(state: string | null, t: T): string {
  switch (state) {
    case 'done':
      return t('analysis.match.newsDone');
    case 'cache':
      return t('analysis.match.newsCache');
    case 'failed':
      return t('analysis.match.newsFailed');
    case 'limit':
      return t('analysis.match.newsLimit');
    case 'off':
      return t('analysis.match.newsOff');
    default:
      return '';
  }
}

type Tab = 'probs' | 'cmp' | 'factors';

export function MatchCard({ match, names, bookmaker, oddsHint }: { match: MatchResult; names: MatchNames; bookmaker: string | null; oddsHint: string }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const [tab, setTab] = useState<Tab>('probs');
  const pick = match.markets.find((r) => r.in_express) ?? null;
  const pickSide = pick?.selection ?? 1;
  const pickName = pick ? outcomeName(pick, match, names) : shortName(names.name(match.player1.id, match.player1.name));
  const [confKind, confIcon] = CONFIDENCE[match.confidence];
  const eyebrow = [roundLabel(match.round), match.tournament].filter(Boolean).join(' · ');
  const data = [
    match.data_as_of ? t('analysis.match.archiveTo', { date: formatDate(match.data_as_of) }) : null,
    newsState(match.news_state, t),
  ]
    .filter(Boolean)
    .join(' · ');
  const notes = (
    <>
      {match.reused_from && (
        <div className="analysis-reused">
          <Chip kind="info" icon="history">
            {t('analysis.match.reused', { at: inlineDateTime(match.reused_from) })}
          </Chip>
        </div>
      )}
      {(match.news_state === 'failed' || match.news_state === 'limit') && (
        <Callout kind="warn">
          <b>{t('analysis.match.newsMissingTitle')}</b> {t('analysis.match.newsMissingText')}
        </Callout>
      )}
      {match.highlight && match.divergence_note && (
        <Callout kind="warn">
          <b>{t('analysis.match.divergenceTitle')}</b> {match.divergence_note}
        </Callout>
      )}
    </>
  );
  const pickLine = pick ? (
    <div className="analysis-pickline">
      <Icon name="target" />
      <span>
        {t('analysis.match.pick')} <b>{outcomeName(pick, match, names)}</b> @<span className="odds">{pick.odds ? formatOdds(pick.odds) : '—'}</span> ·{' '}
        {t('analysis.match.p')} <b>{formatProb(pick.p_final)}</b> · {t('analysis.match.value')}{' '}
        <b>{pick.value === null ? '—' : formatPercent(pick.value, { signed: true })}</b>
      </span>
    </div>
  ) : (
    <div className="analysis-pickline none">
      <Icon name="info" />
      <span>{t('analysis.match.noPick')}</span>
    </div>
  );
  const probHint = <p className="analysis-hint">{t('analysis.match.probHint')}</p>;
  const sec = (title: string, hint: string | null, body: ReactNode) => (
    <div className="analysis-sec">
      <div className="analysis-sec-head">
        <h4>{title}</h4>
        {hint && <span className="analysis-hint">{hint}</span>}
      </div>
      {body}
    </div>
  );
  return (
    <Card
      className="analysis-match"
      eyebrow={eyebrow || undefined}
      title={matchTitle(match, names, t)}
      subtitle={data ? t('analysis.match.data', { data }) : undefined}
      actions={
        <span title={match.explanation}>
          <Chip kind={confKind} icon={confIcon}>
            {t(`analysis.match.confidence.${match.confidence}`)}
          </Chip>
        </span>
      }
    >
      {notes}
      {pickLine}
      {mobile ? (
        <>
          <Segmented
            label={t('analysis.match.sections')}
            className="analysis-seg"
            value={tab}
            onChange={setTab}
            items={[
              { value: 'probs', label: t('analysis.match.tabProbs') },
              { value: 'cmp', label: t('analysis.match.tabCompare') },
              { value: 'factors', label: t('analysis.match.tabFactors') },
            ]}
          />
          <div className="stack" aria-live="polite">
            {tab === 'probs' && (
              <>
                <p className="analysis-hint">{t('analysis.match.probsMobileHint', { odds: oddsHint })}</p>
                <ProbList match={match} names={names} />
                {probHint}
              </>
            )}
            {tab === 'cmp' && (
              <>
                <Comparison match={match} names={names} />
                <p className="analysis-hint">{t('analysis.match.betterHint')}</p>
              </>
            )}
            {tab === 'factors' && <Factors match={match} pickSide={pickSide} pickName={pickName} />}
          </div>
        </>
      ) : (
        <>
          {sec(t('analysis.match.compare'), t('analysis.match.compareHint'), <Comparison match={match} names={names} />)}
          {sec(
            t('analysis.match.probs'),
            t('analysis.match.probsHint', { odds: oddsHint }),
            <>
              <div className="analysis-bleed">
                <ProbTable match={match} names={names} bookmaker={bookmaker} />
              </div>
              {probHint}
            </>,
          )}
          {sec(t('analysis.match.factors'), t('analysis.match.factorsHint'), <Factors match={match} pickSide={pickSide} pickName={pickName} />)}
        </>
      )}
    </Card>
  );
}
