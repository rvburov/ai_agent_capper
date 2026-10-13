import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Card, Chip, EmptyState } from '../../components';
import { displayName, shortName } from '../../features/analysis/draft';
import { marketLabel } from '../../features/analysis/markets';
import { analysisNumber } from '../../features/analysis/number';
import { roundLabel } from '../../features/analysis/rounds';
import type { Dashboard, MyMatch, PlayerRef } from '../../features/dashboard/types';
import { timeZoneDative, timeZoneName } from '../../features/profile/timezones';
import { formatOdds, formatTime } from '../../lib/format';
import { PlayerLink } from './parts';

// «Мои матчи сегодня» (В6, myMatchesCard макета): только матчи из своих открытых ставок и
// сегодняшних анализов. Расписания турниров и линии кэфов в программе нет (Р10).

function Player({ player, rank }: { player: PlayerRef; rank: number | null }) {
  const { t } = useTranslation();
  return (
    <div className="dashboard-match-name">
      <PlayerLink player={player} />
      {rank !== null && (
        <span className="rank" title={t('dashboard.matches.rankTitle')}>
          {t('dashboard.matches.rank', { rank })}
        </span>
      )}
    </div>
  );
}

function MatchRow({ match }: { match: MyMatch }) {
  const { t } = useTranslation();
  const time = match.scheduled_at ? formatTime(match.scheduled_at) : null;
  const place = [match.tournament, roundLabel(match.round)].filter(Boolean).join(', ');
  const name = `${shortName(displayName(match.player1))} — ${shortName(displayName(match.player2))}`;
  const firstBet = match.bets[0];
  const firstAnalysis = match.analyses[0];
  return (
    <article className="dashboard-match" aria-label={time ? `${name}, ${time}` : name}>
      <div className="dashboard-match-time">
        <span className="mono">{time ?? '—'}</span>
        {place && <span className="xsmall">{place}</span>}
      </div>
      <div className="dashboard-match-players">
        <div className="dashboard-match-pair">
          <Player player={match.player1} rank={match.rank1} />
          <span className="muted" aria-hidden="true">
            —
          </span>
          <Player player={match.player2} rank={match.rank2} />
        </div>
        <div className="dashboard-match-extra">
          {match.bets.map((bet) => (
            <Chip key={bet.leg_id} kind="accent" icon="ticket">
              {t('dashboard.matches.inBet', { id: bet.bet_id, market: marketLabel(bet.market, bet.selection), odds: formatOdds(bet.odds_taken) })}
            </Chip>
          ))}
          {match.analyses.map((id) => (
            <Chip key={id} kind="outline" icon="spark">
              {t('dashboard.matches.inAnalysis', { number: analysisNumber(id) })}
            </Chip>
          ))}
        </div>
      </div>
      <div className="dashboard-match-action">
        {firstBet ? (
          <Button size="sm" icon="ticket" to={`${paths.bets}?bet=${firstBet.bet_id}`} aria-label={t('dashboard.matches.openBetLabel', { id: firstBet.bet_id })}>
            {t('dashboard.matches.openBet', { id: firstBet.bet_id })}
          </Button>
        ) : firstAnalysis !== undefined ? (
          <Button
            size="sm"
            icon="spark"
            to={paths.analysis(firstAnalysis)}
            aria-label={t('dashboard.matches.openAnalysisLabel', { number: analysisNumber(firstAnalysis) })}
          >
            {t('dashboard.matches.openAnalysis')}
          </Button>
        ) : null}
      </div>
    </article>
  );
}

export function MyMatches({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  const list = data.my_matches;
  const withBets = list.filter((match) => match.bets.length > 0).length;
  const withAnalyses = list.length - withBets;
  const dative = timeZoneDative(t, data.tz);
  const zone = dative ? t('dashboard.matches.tzCity', { city: dative }) : t('dashboard.matches.tzName', { zone: timeZoneName(t, data.tz) });
  const parts = [
    ...(withBets ? [t('dashboard.matches.inBets', { count: withBets })] : []),
    ...(withAnalyses ? [t('dashboard.matches.inAnalyses', { count: withAnalyses })] : []),
    zone,
  ];
  return (
    <Card
      className="dashboard-matches-card dashboard-card"
      title={t('dashboard.matches.title')}
      subtitle={list.length ? parts.join(' · ') : t('dashboard.matches.subtitleEmpty')}
      flush
      foot={
        <>
          <Button kind="primary" size="sm" icon="spark" to={paths.newAnalysis}>
            {t('dashboard.matches.newAnalysis')}
          </Button>
          <span className="xsmall muted dashboard-foot-note">{t('dashboard.matches.note')}</span>
        </>
      }
    >
      {list.length ? (
        <div>
          {list.map((match) => (
            <MatchRow key={match.match_id} match={match} />
          ))}
        </div>
      ) : (
        <div className="dashboard-matches-empty">
          <EmptyState>{t('dashboard.matches.empty')}</EmptyState>
        </div>
      )}
    </Card>
  );
}
