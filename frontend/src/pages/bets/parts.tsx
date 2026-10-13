import type { TFunction } from 'i18next';
import type { MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Chip, Icon } from '../../components';
import { displayName, shortName } from '../../features/analysis/draft';
import { marketLabel } from '../../features/analysis/markets';
import {
  closingBookmaker,
  currencyOf,
  LEG_CHIP,
  LEG_ICON,
  STATUS_CHIP,
  toneClass,
  VERDICT_CHIP,
  type LegShown,
} from '../../features/bets/display';
import type { BetItem, BetLeg, BetStatus, Closing, Verdict } from '../../features/bets/types';
import { formatMoney, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';

// Мелкие части экрана «Ставки» (mockup/js/screens/bets.js): метки, исходы, имена игроков, CLV.

export function StatusChip({ status }: { status: BetStatus }) {
  const { t } = useTranslation();
  const meta = STATUS_CHIP[status];
  return (
    <Chip kind={meta.kind} icon={meta.icon}>
      {t(`bets.status.${status}`)}
    </Chip>
  );
}

export function VerdictChip({ verdict }: { verdict: Verdict | null }) {
  const { t } = useTranslation();
  if (!verdict) return null;
  const meta = VERDICT_CHIP[verdict];
  return (
    <Chip kind={meta.kind} icon={meta.icon}>
      {t(`bets.verdict.${verdict}`)}
    </Chip>
  );
}

/** Кружок исхода события: зашло, не зашло, возврат, еще не сыграно, не записан ботом. */
export function ResultIcon({ shown }: { shown: LegShown }) {
  const { t } = useTranslation();
  const label = t(`bets.leg.icon.${shown}`);
  return (
    <span className={cx('bets-res', shown)} role="img" aria-label={label} title={label}>
      <Icon name={LEG_ICON[shown]} />
    </span>
  );
}

export function LegChip({ shown }: { shown: LegShown }) {
  const { t } = useTranslation();
  const meta = LEG_CHIP[shown];
  return (
    <Chip kind={meta.kind} icon={meta.icon}>
      {t(`bets.leg.chip.${shown}`)}
    </Chip>
  );
}

type Player = BetLeg['match']['player1'];

function stop(event: MouseEvent) {
  event.stopPropagation();
}

/** Фамилия игрока ссылкой на карточку игрока. */
export function PlayerLink({ player }: { player: Player }) {
  const { t } = useTranslation();
  const full = displayName(player);
  return (
    <Link className="bets-plink" to={paths.player(player.id)} title={t('bets.playerCard', { name: full })} onClick={stop}>
      {shortName(full)}
    </Link>
  );
}

/** «Синнер — Руне»: links — фамилии ссылками на карточки игроков. */
export function MatchName({ leg, links = false }: { leg: Pick<BetLeg, 'match'>; links?: boolean }) {
  const { player1, player2 } = leg.match;
  if (!links) return <>{`${shortName(displayName(player1))} — ${shortName(displayName(player2))}`}</>;
  return (
    <>
      <PlayerLink player={player1} /> — <PlayerLink player={player2} />
    </>
  );
}

/** Текст матча без ссылок (подписи для читалки и заголовки окон). */
export function matchText(leg: Pick<BetLeg, 'match'>): string {
  const { player1, player2 } = leg.match;
  return `${shortName(displayName(player1))} — ${shortName(displayName(player2))}`;
}

/** Исход ставки на матч: П1, Ф2(+1.5). */
export function legMarket(leg: Pick<BetLeg, 'market' | 'selection'>): string {
  return marketLabel(leg.market, leg.selection);
}

/** Деньги ставки в ее валюте. */
export function money(bet: Pick<BetItem, 'currency'>, amount: string | null | undefined, signed = false): string {
  return formatMoney(amount, currencyOf(bet.currency), { signed });
}

/** Число со знаком и цветом: прибыль, ROI, CLV. */
export function Signed({ value, text, className }: { value: number | string | null | undefined; text: string; className?: string }) {
  return <span className={cx(toneClass(value), className)}>{text}</span>;
}

/** CLV: доля со знаком; у ставки бота — прочерк с пояснением (В5). */
export function ClvValue({ value, legacy = false }: { value: number | null | undefined; legacy?: boolean }) {
  const { t } = useTranslation();
  if (legacy) {
    return (
      <span className="muted" title={t('bets.botClv')}>
        —
      </span>
    );
  }
  return <Signed value={value} text={formatPercent(value, { signed: true })} />;
}

/** Чей закрывающий кэф: «эталон · Pinnacle», «свой · Fonbet». */
export function closingWhoText(closing: Pick<Closing, 'by' | 'bookmaker'>, betBookmaker: string, t: TFunction): string {
  const own = closingBookmaker(closing, betBookmaker);
  return own !== null ? t('bets.closing.whoOwn', { name: own }) : t(`bets.closing.whoRef.${closing.by as 'pinnacle' | 'betfair_ex' | 'avg'}`);
}

/** «Ординар», «Экспресс × 2». */
export function betKind(bet: Pick<BetItem, 'legs'>, t: TFunction): string {
  return bet.legs.length > 1 ? t('bets.kind.parlay', { n: bet.legs.length }) : t('bets.kind.single');
}

/** «Ординар», «Экспресс из 2 событий». */
export function betKindLong(bet: Pick<BetItem, 'legs'>, t: TFunction): string {
  return bet.legs.length > 1 ? t('bets.kind.parlayLong', { count: bet.legs.length }) : t('bets.kind.single');
}
