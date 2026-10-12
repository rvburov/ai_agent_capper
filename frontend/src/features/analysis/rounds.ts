import i18n from '../../i18n';

// Раунды турнира: код в базе (R16, QF) и подпись на экране (1/8 финала, 1/4 финала).
export const ROUND_CODES = ['R128', 'R64', 'R32', 'R16', 'QF', 'SF', 'F'] as const;
export type RoundCode = (typeof ROUND_CODES)[number];

export function isRoundCode(value: string): value is RoundCode {
  return (ROUND_CODES as readonly string[]).includes(value);
}

// Категории турнира: код в базе (tournaments.category) и подпись на экране, как в макете
export const CATEGORY_CODES = ['grand_slam', 'masters', '500', '250', 'atp', 'finals', 'davis_cup', 'olympics'] as const;
export type CategoryCode = (typeof CATEGORY_CODES)[number];

/** Подпись категории: «Masters 1000»; неизвестный код не показываем (это не текст для человека). */
export function categoryLabel(category: string | null | undefined): string {
  if (!category || !(CATEGORY_CODES as readonly string[]).includes(category)) return '';
  return i18n.t(`new.categories.${category as CategoryCode}`);
}

/** Подпись раунда: известный код — «1/8 финала», иначе как пришло. */
export function roundLabel(round: string | null | undefined): string {
  if (!round) return '';
  return isRoundCode(round) ? i18n.t(`new.rounds.${round}`) : round;
}
