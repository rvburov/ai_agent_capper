import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Card, Chip, EmptyState } from '../../components';
import { betTournament, impliedProb, legProb, localDay } from '../../features/bets/display';
import { sumMoney } from '../../features/bets/money';
import { analysisNumber } from '../../features/analysis/number';
import type { BetItem } from '../../features/bets/types';
import { cx } from '../../lib/cx';
import { formatDate, formatOdds, formatProb } from '../../lib/format';
import { betKindLong, legMarket, MatchName, money, StatusChip } from './parts';

// «В игре» (openSection и openCard макета): открытые ставки карточками с «Внести результат».

interface OpenSectionProps {
  bets: BetItem[];
  /** Фильтры выбраны: пустой раздел не показываем вовсе. */
  filtered: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  onSettle: (bet: BetItem) => void;
  /** Ставка, только что сохраненная на экране «Анализ», — подсвечена (lastSavedBet макета). */
  fresh: number | null;
}

export function OpenSection({ bets, filtered, hasMore, loadingMore, onMore, onSettle, fresh }: OpenSectionProps) {
  const { t } = useTranslation();
  if (!bets.length) {
    if (filtered) return null;
    return (
      <section className="stack" aria-label={t('bets.open.label')}>
        <div className="bets-sec-head">
          <h3>{t('bets.open.title')}</h3>
        </div>
        <Card>
          <EmptyState>
            {t('bets.open.empty')} <Link to={paths.newAnalysis}>{t('bets.open.emptyLink')}</Link> {t('bets.open.emptyTail')}
          </EmptyState>
        </Card>
      </section>
    );
  }
  const first = bets[0];
  const stake = sumMoney(bets.map((b) => b.stake));
  const payout = sumMoney(bets.map((b) => b.payout));
  return (
    <section className="stack" aria-label={t('bets.open.label')}>
      <div className="bets-sec-head">
        <h3>{t('bets.open.title')}</h3>
        <Chip kind="info" icon="clock">
          {t('bets.count', { count: bets.length })}
          {hasMore ? '+' : ''}
        </Chip>
        {first && <span className="small muted">{t('bets.open.atStake', { stake: money(first, stake), payout: money(first, payout) })}</span>}
      </div>
      <div className="bets-open-grid">
        {bets.map((bet) => (
          <OpenCard key={bet.id} bet={bet} fresh={bet.id === fresh} onSettle={onSettle} />
        ))}
      </div>
      {hasMore && (
        <div className="row">
          <Button size="sm" icon="chevronDown" loading={loadingMore} onClick={onMore}>
            {t('bets.open.more')}
          </Button>
        </div>
      )}
    </section>
  );
}

function dayText(day: string | null, today: string, t: TFunction): string {
  if (!day) return '—';
  return day === today ? t('bets.today') : formatDate(day);
}

function OpenCard({ bet, fresh, onSettle }: { bet: BetItem; fresh: boolean; onSettle: (bet: BetItem) => void }) {
  const { t } = useTranslation();
  const today = localDay(new Date());
  const placed = localDay(bet.placed_at);
  const tournament = betTournament(bet);
  const meta = [t('bets.number', { id: bet.id }), bet.bookmaker, tournament ? `${tournament}, ${dayText(placed, today, t)}` : dayText(placed, today, t)];
  return (
    <article className={cx('card bets-open', fresh && 'is-new')} aria-label={t('bets.open.cardLabel', { id: bet.id })} data-open-bet={bet.id}>
      <div className="bets-open-head">
        <div className="bets-min">
          <div className="bets-open-title">{betKindLong(bet, t)}</div>
          <div className="xsmall muted">{meta.join(' · ')}</div>
        </div>
        <StatusChip status="open" />
      </div>
      <ul className="bets-olegs">
        {bet.legs.map((leg) => {
          const p = legProb(leg);
          const implied = impliedProb(leg.odds_taken);
          return (
            <li key={leg.id} className="bets-oleg">
              <span className="bets-oleg-time">{dayText(leg.match.day, today, t)}</span>
              <div className="bets-min">
                <div className="bets-oleg-match">
                  <MatchName leg={leg} links />
                </div>
                <div className="bets-oleg-meta" title={t('bets.open.probTitle')}>
                  <b>{legMarket(leg)}</b>
                  {p !== null && (
                    <>
                      {' · '}
                      <span className="bets-nw">{t('bets.open.model', { p: formatProb(p) })}</span>
                    </>
                  )}
                  {' · '}
                  <span className="bets-nw">{t('bets.open.byOdds', { p: formatProb(implied) })}</span>
                </div>
              </div>
              <span className="odds bets-oleg-odds">{formatOdds(leg.odds_taken)}</span>
            </li>
          );
        })}
      </ul>
      <dl className="bets-open-sum">
        <div>
          <dt>{t('bets.open.total')}</dt>
          <dd className="odds">{formatOdds(bet.total_odds)}</dd>
        </div>
        <div>
          <dt>{t('bets.open.stake')}</dt>
          <dd>{money(bet, bet.stake)}</dd>
        </div>
        <div>
          <dt>{t('bets.open.payout')}</dt>
          <dd>{money(bet, bet.payout)}</dd>
        </div>
      </dl>
      <div className="bets-open-actions">
        <Button kind="primary" icon="edit" onClick={() => onSettle(bet)}>
          {t('bets.actions.settle')}
        </Button>
        {bet.analysis_id !== null && (
          <Button icon="info" to={paths.analysis(bet.analysis_id)} title={t('bets.actions.whyTitle', { id: analysisNumber(bet.analysis_id) })}>
            {t('bets.actions.why')}
          </Button>
        )}
      </div>
    </article>
  );
}
