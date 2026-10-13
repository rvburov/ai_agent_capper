import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { displayName, shortName } from '../../features/analysis/draft';
import type { PlayerRef } from '../../features/dashboard/types';

// Мелкие части главной.

/** Фамилия игрока ссылкой на карточку игрока (playerLink макета): полное имя — в подсказке. */
export function PlayerLink({ player }: { player: PlayerRef }) {
  const { t } = useTranslation();
  const full = displayName(player);
  return (
    <Link className="dashboard-player" to={paths.player(player.id)} title={t('bets.playerCard', { name: full })}>
      {shortName(full) || '—'}
    </Link>
  );
}

/** «Синнер — Руне» ссылками на карточки игроков. */
export function MatchLinks({ player1, player2 }: { player1: PlayerRef; player2: PlayerRef }) {
  return (
    <>
      <PlayerLink player={player1} /> — <PlayerLink player={player2} />
    </>
  );
}
