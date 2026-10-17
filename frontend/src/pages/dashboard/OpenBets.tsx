import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Card, EmptyState } from '../../components';
import { betTournament, currencyOf, legProb } from '../../features/bets/display';
import type { Dashboard, OpenBet } from '../../features/dashboard/types';
import { formatDate, formatMoney, formatOdds, formatProb, formatTime } from '../../lib/format';
import { betKindLong, legMarket, StatusChip } from '../bets/parts';
import { MatchLinks } from './parts';

// «Открытые ставки» (openBetsCard макета): события с вероятностью модели и 1/кэф, кэф, сумма,
// возможная выплата и «Внести результат» — переход на «Ставки» с окном результата.

/**
 * Время события, как в макете: у сегодняшнего матча с известным началом — «13:30» (время
 * начала — из «Моих матчей сегодня», тот же ответ сервера), иначе день: «сегодня», «14 окт».
 */
function legTime(match: OpenBet['legs'][number]['match'], starts: ReadonlyMap<number, string>, today: string, t: TFunction): string {
  const start = starts.get(match.id);
  if (start) return formatTime(start);
  if (!match.day) return '—';
  return match.day === today ? t('bets.today') : formatDate(match.day);
}

function OpenBetCard({ bet, today, starts }: { bet: OpenBet; today: string; starts: ReadonlyMap<number, string> }) {
  const { t } = useTranslation();
  const currency = currencyOf(bet.currency);
  const tournament = betTournament(bet);
  const meta = [t('bets.number', { id: bet.id }), bet.bookmaker, ...(tournament ? [tournament] : [])].join(' · ');
  return (
    <article className="dashboard-bet" aria-label={t('dashboard.open.betLabel', { id: bet.id })}>
      <div className="dashboard-bet-head">
        <div>
          <strong>{betKindLong(bet, t)}</strong>
          <div className="xsmall muted">{meta}</div>
        </div>
        <StatusChip status="open" />
      </div>
      <ul className="dashboard-legs">
        {bet.legs.map((leg, i) => {
          const p = legProb(leg);
          return (
            <li key={leg.id} className="dashboard-leg">
              <span className="dashboard-leg-time">{legTime(leg.match, starts, today, t)}</span>
              <div className="dashboard-leg-match">
                <MatchLinks player1={leg.match.player1} player2={leg.match.player2} />
              </div>
              <span className="odds" aria-label={t('dashboard.open.oddsLabel', { odds: formatOdds(leg.odds_taken) })}>
                {formatOdds(leg.odds_taken)}
              </span>
              <div className="dashboard-leg-meta" title={t('dashboard.open.probTitle')}>
                <b>{legMarket(leg)}</b>
                <span>
                  {p !== null
                    ? t('dashboard.open.probs', { model: formatProb(p), implied: formatProb(bet.implied[i] ?? null) })
                    : t('dashboard.open.implied', { implied: formatProb(bet.implied[i] ?? null) })}
                </span>
              </div>
            </li>
          );
        })}
      </ul>
      <dl className="dashboard-bet-sum">
        <div>
          <dt>{t('dashboard.open.total')}</dt>
          <dd className="odds">{formatOdds(bet.total_odds)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.open.stake')}</dt>
          <dd>{formatMoney(bet.stake, currency)}</dd>
        </div>
        <div>
          <dt>{t('dashboard.open.payout')}</dt>
          <dd>{formatMoney(bet.payout, currency)}</dd>
        </div>
      </dl>
      <Button
        kind="secondary"
        size="sm"
        icon="edit"
        block
        to={`${paths.bets}?bet=${bet.id}`}
        aria-label={t('dashboard.open.settleLabel', { id: bet.id })}
        ro
      >
        {t('dashboard.open.settle')}
      </Button>
    </article>
  );
}

export function OpenBets({ data }: { data: Dashboard }) {
  const { t } = useTranslation();
  // «Сегодня» — день сервера в поясе участника, как у строки с датой и «Моих матчей сегодня»
  const today = data.today;
  const currency = currencyOf(data.currency);
  const more = data.open_count - data.open_bets.length;
  const starts = new Map(data.my_matches.flatMap((match) => (match.scheduled_at ? [[match.match_id, match.scheduled_at] as const] : [])));
  return (
    <Card
      className="dashboard-card"
      title={t('dashboard.open.title')}
      subtitle={t('dashboard.open.subtitle', {
        count: data.open_count,
        stake: formatMoney(data.open_stake, currency),
      })}
      actions={
        <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.bets}>
          {t('dashboard.open.all')}
        </Button>
      }
    >
      {data.open_bets.length ? (
        <div className="dashboard-bets">
          {data.open_bets.map((bet) => (
            <OpenBetCard key={bet.id} bet={bet} today={today} starts={starts} />
          ))}
          {more > 0 && (
            <Button kind="ghost" size="sm" iconRight="chevronRight" className="dashboard-more" to={`${paths.bets}?status=open`}>
              {t('dashboard.open.more', { count: more })}
            </Button>
          )}
        </div>
      ) : (
        <EmptyState>{t('dashboard.open.empty')}</EmptyState>
      )}
    </Card>
  );
}
