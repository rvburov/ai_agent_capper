import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Chip, DataTable, EmptyState, Skeleton, SurfaceChip, type DataColumn } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { categoryLabel, roundLabel } from '../../features/analysis/rounds';
import { usePlayerMatches } from '../../features/players/api';
import { playerName, scoreText } from '../../features/players/display';
import type { PlayerCard, PlayerMatch } from '../../features/players/types';
import { formatDate, formatNumber } from '../../lib/format';
import { cx } from '../../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { inlineWhen, PlayerNameLink } from './parts';

// Вкладка «Матчи» (tabMatches макета): матчи игрока в базе страницами с сервера (курсор), сверху
// последний; итоги двух сезонов (победы, тай-брейки, решающие сеты, матчи до трех побед) — с
// сервера, на первой странице. Неявка показана, но в форму и итоги не входит.

function ResultChip({ match }: { match: PlayerMatch }) {
  const { t } = useTranslation();
  if (match.walkover) {
    return (
      <Chip kind="outline" icon="refresh">
        {t('players.matches.result.wo')}
      </Chip>
    );
  }
  return match.won ? (
    <Chip kind="good" icon="check">
      {t('players.matches.result.won')}
    </Chip>
  ) : (
    <Chip kind="bad" icon="x">
      {t('players.matches.result.lost')}
    </Chip>
  );
}

function Opponent({ match }: { match: PlayerMatch }) {
  const { t } = useTranslation();
  if (match.walkover) {
    return (
      <span>
        {match.won ? t('players.matches.oppWithdrew', { name: playerName(match.opponent) }) : t('players.matches.selfWithdrew', { name: playerName(match.opponent) })}
      </span>
    );
  }
  return (
    <span>
      <PlayerNameLink player={match.opponent} />
      {match.opponent_rank !== null && (
        <>
          {' '}
          <span className="muted xsmall" title={t('players.matches.oppRankTitle')}>
            {t('players.matches.oppRank', { rank: match.opponent_rank })}
          </span>
        </>
      )}
    </span>
  );
}

function columns(t: TFunction): DataColumn<PlayerMatch>[] {
  return [
    { key: 'date', label: t('players.matches.cols.date'), render: (m) => <span className="players-nowrap">{formatDate(m.day)}</span> },
    {
      key: 'tournament',
      label: t('players.matches.cols.tournament'),
      render: (m) => (
        <div className="players-cell-2">
          <span className="players-w500">{m.tournament ?? '—'}</span>
          {categoryLabel(m.category) && <small>{categoryLabel(m.category)}</small>}
        </div>
      ),
    },
    { key: 'surface', label: t('players.matches.cols.surface'), render: (m) => <SurfaceChip surface={m.surface} /> },
    { key: 'round', label: t('players.matches.cols.round'), render: (m) => roundLabel(m.round) },
    { key: 'opponent', label: t('players.matches.cols.opponent'), render: (m) => <Opponent match={m} /> },
    {
      key: 'score',
      label: t('players.matches.cols.score'),
      render: (m) => (m.walkover ? <span className="muted">{t('players.matches.wo')}</span> : <span className="mono players-nowrap">{scoreText(m.score)}</span>),
    },
    { key: 'result', label: t('players.matches.cols.result'), render: (m) => <ResultChip match={m} /> },
  ];
}

function MatchRow({ match }: { match: PlayerMatch }) {
  const { t } = useTranslation();
  return (
    <li className={cx('players-mrow', match.walkover && 'players-wo')}>
      <div className="players-mrow-line">
        <span className="small players-min">
          <b>{match.tournament ?? '—'}</b>
          {match.round ? ` · ${roundLabel(match.round)}` : ''}
        </span>
        <span className="xsmall muted players-nowrap">{formatDate(match.day)}</span>
      </div>
      <div className="players-mrow-line">
        <span className="players-min">
          {!match.walkover && t('players.matches.opponentLabel')}
          <Opponent match={match} />
        </span>
        <ResultChip match={match} />
      </div>
      {!match.walkover && (
        <div className="players-mrow-line">
          <span className="mono small">{scoreText(match.score)}</span>
          <span className="xsmall muted">{match.surface ? t(`analysis.surface.${match.surface}`, { defaultValue: match.surface }) : ''}</span>
        </div>
      )}
    </li>
  );
}

export function MatchesTab({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const query = usePlayerMatches(card.id);
  const pages = query.data?.pages ?? [];
  const items = pages.flatMap((page) => page.items);
  const first = pages[0];
  const summary = first?.summary ?? null;
  const archive = card.archive;
  const wo = items.some((m) => m.walkover);

  let body;
  if (query.isPending) body = <Skeleton lines={6} />;
  else if (!first) {
    body = (
      <Callout kind="bad" role="alert">
        {t('players.matches.failed')} {apiErrorText(query.error)}{' '}
        <Button size="sm" kind="ghost" icon="refresh" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </Callout>
    );
  } else if (!items.length) body = <EmptyState>{t('players.matches.empty')}</EmptyState>;
  else {
    body = (
      <>
        {summary && (
          <dl className="players-strip">
            <div>
              <dt>{t('players.matches.strip.wins')}</dt>
              <dd>{t('players.matches.strip.winsValue', { w: summary.wins, n: summary.played })}</dd>
            </div>
            <div>
              <dt>{t('players.matches.strip.tiebreaks')}</dt>
              <dd>{`${summary.tiebreaks.wins}–${summary.tiebreaks.losses}`}</dd>
            </div>
            <div>
              <dt>{t('players.matches.strip.deciders')}</dt>
              <dd>{`${summary.deciders.wins}–${summary.deciders.losses}`}</dd>
            </div>
            <div>
              <dt>{t('players.matches.strip.bo5')}</dt>
              <dd>{formatNumber(summary.best_of_5)}</dd>
            </div>
          </dl>
        )}
        <div className="players-flush">
          {mobile ? (
            <ul className="players-mlist" aria-label={t('players.matches.caption')}>
              {items.map((match) => (
                <MatchRow key={match.match_id} match={match} />
              ))}
            </ul>
          ) : (
            <DataTable className="players-matches" caption={t('players.matches.caption')} columns={columns(t)} rows={items} rowKey={(m) => m.match_id} />
          )}
        </div>
      </>
    );
  }

  const subtitle = [
    archive.data_to ? t('players.matches.subtitle', { date: formatDate(archive.data_to) }) : t('players.matches.subtitleNone'),
    summary ? t('players.matches.since', { date: formatDate(summary.since) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Card
      className="players-card"
      title={t('players.matches.title')}
      subtitle={`${subtitle}${wo ? t('players.matches.woNote') : ''}`}
      actions={
        archive.last_load ? (
          <Chip kind={archive.stale ? 'warn' : 'outline'} icon="database">
            {t('players.matches.archiveChip', { when: inlineWhen(archive.last_load, true) })}
          </Chip>
        ) : undefined
      }
      foot={
        first ? (
          <>
            <span className="small muted players-grow">{t('players.matches.foot', { count: first.total })}</span>
            {query.isFetchNextPageError && <span className="small bad-text">{t('players.matches.moreFailed')}</span>}
            {query.hasNextPage && (
              <Button kind="secondary" size="sm" icon="list" loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
                {t('players.matches.more')}
              </Button>
            )}
          </>
        ) : undefined
      }
    >
      {body}
    </Card>
  );
}
