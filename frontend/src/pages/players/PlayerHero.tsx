import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Chip, FormDots, Icon } from '../../components';
import { analysisNumber, latestAnalysis } from '../../features/analysis/number';
import { countryName, eloDelta, eloText, handText, initials, newsState, playerName } from '../../features/players/display';
import type { PlayerCard, TodayMatch } from '../../features/players/types';
import { formatDate, formatOdds, formatTime } from '../../lib/format';
import { CountryCode, inlineWhen, matchPlace } from './parts';

// Шапка карточки игрока (heroNode макета): имя, страна, возраст, рука, лучшее покрытие; две
// меры свежести (новости и последний матч в базе, Т22); место и Эло, форма; «сегодня» — только
// из своих ставок и анализов.

function betsPath(betId: number): string {
  return `${paths.bets}?bet=${betId}`;
}

function NewsStatus({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const news = card.news;
  const state = newsState(news.checked_at, news.fresh);
  const chip =
    state === 'fresh' ? (
      <Chip kind="good" icon="check">
        {t('players.card.newsChip.fresh')}
      </Chip>
    ) : (
      <Chip kind="outline" icon={state === 'stale' ? 'clock' : 'globe'}>
        {state === 'stale' ? t('players.card.newsChip.stale', { hours: news.ttl_hours }) : t('players.card.newsChip.never')}
      </Chip>
    );
  const note = news.checked_at
    ? `${t('players.card.newsChecked', { when: inlineWhen(news.checked_at) })}${state === 'stale' ? t('players.card.newsStaleTail') : ''}`
    : t('players.card.newsNever');
  return (
    <div className="players-hero-st">
      {chip}
      <small>{note}</small>
    </div>
  );
}

function LastStatus({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const last = card.last_match;
  const place = last ? matchPlace(last) : '';
  const loaded = card.archive.last_load
    ? t('players.card.archiveLoaded', { when: inlineWhen(card.archive.last_load, true) })
    : card.archive.data_to
      ? t('players.card.archiveNoLog')
      : t('players.card.archiveNever');
  return (
    <div className="players-hero-st">
      <Chip kind="outline" icon="database">
        {t('players.card.lastChip', { date: last ? formatDate(last.day) : '—' })}
      </Chip>
      <small>{[place, loaded].filter(Boolean).join(' · ')}</small>
    </div>
  );
}

/** «Сегодня, 14:00 · соперник — Руне (№12 по Эло) · в вашей ставке №7 · кэф 1.30». */
function TodayLine({ today }: { today: TodayMatch }) {
  const { t } = useTranslation();
  const bet = today.bets[0];
  const analysis = latestAnalysis(today.analyses);
  let where = '';
  if (today.bets.length === 1 && bet) where = t('players.card.today.bet', { id: bet.bet_id, odds: formatOdds(bet.odds_taken) });
  else if (today.bets.length > 1) where = t('players.card.today.bets', { ids: today.bets.map((b) => t('players.card.today.betNo', { id: b.bet_id })).join(', ') });
  else if (analysis !== undefined) where = t('players.card.today.analysis', { id: analysisNumber(analysis) });
  return (
    <div className="players-today">
      <Icon name={bet ? 'ticket' : 'spark'} />
      <div className="players-today-text">
        <b>{today.scheduled_at ? t('players.card.today.time', { time: formatTime(today.scheduled_at) }) : t('players.card.today.label')} · </b>
        {t('players.card.today.opponent')}
        <Link to={paths.player(today.opponent.id)}>{playerName(today.opponent)}</Link>
        {today.opponent_rank !== null && t('players.card.today.rank', { rank: today.opponent_rank })}
        {where && ` · ${where}`}
      </div>
      {bet ? (
        <Button kind="ghost" size="sm" icon="ticket" to={betsPath(bet.bet_id)}>
          {t('players.card.today.settle')}
        </Button>
      ) : (
        analysis !== undefined && (
          <Button kind="ghost" size="sm" iconRight="arrowRight" to={paths.analysis(analysis)}>
            {t('players.card.today.openAnalysis')}
          </Button>
        )
      )}
    </div>
  );
}

export function PlayerHero({ card }: { card: PlayerCard }) {
  const { t } = useTranslation();
  const name = playerName(card);
  const hard = card.elo.surfaces.find((item) => item.surface === 'hard');
  const formResults = card.form.matches.map((match) => (match.won ? 'W' : 'L'));
  const meta = [
    countryName(card.country, t),
    card.age !== null ? t('players.list.age', { count: card.age }) : null,
    handText(card.hand, card.backhand, t),
  ].filter(Boolean);
  return (
    <section className="card players-hero" aria-label={t('players.card.label', { name })}>
      <div className="players-hero-top">
        <div className="players-avatar" aria-hidden="true">
          {initials(name)}
        </div>
        <div className="players-hero-id">
          <h2>{name}</h2>
          <div className="players-meta">
            <CountryCode code={card.country} title={null} /> {meta.join(' · ')}
          </div>
          <div className="row players-chips">
            {card.elo.best_surface && (
              <Chip kind="outline">{t('players.card.best', { surface: t(`analysis.surface.${card.elo.best_surface}`).toLowerCase() })}</Chip>
            )}
            {card.legacy_profile && (
              <Chip kind="outline" icon="history">
                {t('players.card.legacyChip')}
              </Chip>
            )}
          </div>
        </div>
        <div className="players-hero-status">
          <NewsStatus card={card} />
          <LastStatus card={card} />
        </div>
      </div>
      <div className="players-hero-stats">
        <div>
          <span className="players-hs-l">{t('players.card.stats.rank')}</span>
          <span className="players-hs-v">{card.rank !== null ? t('players.list.rankNum', { rank: card.rank }) : '—'}</span>
          <span className="players-hs-s">{card.rank !== null ? t('players.card.stats.rankHint') : t('players.list.rankNone')}</span>
        </div>
        <div>
          <span className="players-hs-l">{t('players.card.stats.eloAll')}</span>
          <span className="players-hs-v">{eloText(card.elo.all)}</span>
          <span className="players-hs-s">{t('players.card.stats.eloAllHint')}</span>
        </div>
        <div>
          <span className="players-hs-l">{t('players.card.stats.eloHard')}</span>
          <span className="players-hs-v">{eloText(hard?.elo)}</span>
          <span className="players-hs-s">{hard?.delta !== null && hard?.delta !== undefined ? t('players.list.toAll', { delta: eloDelta(hard.delta) }) : '—'}</span>
        </div>
        <div>
          <span className="players-hs-l">{t('players.card.stats.form')}</span>
          <span className="players-hs-v">
            {card.form.wins}–{card.form.losses}
            {formResults.length > 0 && <FormDots results={formResults} />}
          </span>
          <span className="players-hs-s">{t('players.card.stats.formHint')}</span>
        </div>
      </div>
      {card.today.map((today) => (
        <TodayLine key={today.match_id} today={today} />
      ))}
    </section>
  );
}
