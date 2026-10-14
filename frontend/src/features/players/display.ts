import type { TFunction } from 'i18next';

import { displayName, shortName } from '../analysis/draft';
import { formatNumber } from '../../lib/format';
import type { ArchiveInfo, PlayerRef } from './types';

// Подписи «Игроков» и карточки: имя, страна, рука, Эло, свежесть новостей. Числа (Эло, место,
// форма, свежесть) считает сервер, здесь только вид.

export { displayName, shortName };

/** Имя игрока на экране: по-русски, если есть (PlayerRefOut, строка списка, карточка). */
export function playerName(player: Pick<PlayerRef, 'name' | 'name_ru'>): string {
  return displayName(player);
}

/** Инициалы для круга в шапке карточки: «ЯС» из «Янник Синнер». */
export function initials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join('');
}

/** Страна по коду IOC: «Италия» из ITA (players.countries; кода нет в списке — сам код). */
export function countryName(code: string | null | undefined, t: TFunction): string | null {
  if (!code) return null;
  return t(`players.countries.${code.toUpperCase()}`, { defaultValue: code });
}

/** Рейтинг Эло — целым числом без разделителя разрядов, как в макете: «2150». */
export function eloText(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : String(Math.round(value));
}

/** Разница Эло со знаком: «+12», «−30», ноль — «±0». */
export function eloDelta(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value === 0 ? '±0' : formatNumber(value, 0, { signed: true });
}

export type NewsState = 'fresh' | 'stale' | 'never';

/** Свежесть новостей игрока: свежие (моложе кэша новостей), старше, не искали. */
export function newsState(checkedAt: string | null | undefined, fresh: boolean): NewsState {
  if (!checkedAt) return 'never';
  return fresh ? 'fresh' : 'stale';
}

/**
 * Счет матча как в макете: «6:3 7:6(4)». Архив пишет геймы через дефис («6-3 7-6(4)»); меняем
 * только дефис между числами геймов, тай-брейк в скобках и пометки (RET, W/O) не трогаем.
 */
export function scoreText(score: string | null | undefined): string {
  if (!score) return '—';
  return score.replace(/(\d+)-(\d+)/g, '$1:$2');
}

/** Доля побед 0…1; матчей нет — null. */
export function winShare(wins: number, losses: number): number | null {
  const total = wins + losses;
  return total > 0 ? wins / total : null;
}

/** Рука и бэкхенд: «правша, двуручный бэкхенд»; неизвестное не пишется. */
export function handText(hand: string | null, backhand: string | null, t: TFunction): string | null {
  const parts: string[] = [];
  if (hand === 'R' || hand === 'L' || hand === 'A') parts.push(t(`players.card.hand.${hand}`));
  if (backhand === 'one' || backhand === 'two') parts.push(t(`players.card.backhand.${backhand}`));
  return parts.length ? parts.join(', ') : null;
}

/**
 * Нужна ли в списке строка авторства Сакманна (CC BY-NC-SA). Лицензия требует ее, когда его
 * данные есть, а по журналу загрузок это видно не всегда: матчи могли попасть в базу до записей
 * о загрузках. Поэтому при сомнении — показываем: загрузка Сакманна записана или матчи в базе
 * есть. Без строки — только пустая база (точный признак — заявка A: sackmann в ответе списка).
 */
export function hasSackmann(archive: ArchiveInfo): boolean {
  return archive.data_to !== null || archive.sources.some((source) => source.source === 'sackmann' && source.last_load !== null);
}

/**
 * Адрес источника новости — только http(s): ссылку пишет шаг новостей по ответу Claude, и
 * javascript: или data: в href недопустимы.
 */
export function safeHttpUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Сайт источника для подписи: имя из ответа или домен без www. */
export function siteName(name: string | null | undefined, url: string | null | undefined): string {
  if (name && name.trim()) return name.trim();
  const safe = safeHttpUrl(url);
  if (!safe) return '—';
  return new URL(safe).hostname.replace(/^www\./, '');
}

/** Номер карточки из адреса: только целое положительное. */
export function playerIdOf(raw: string | undefined): number | null {
  if (!raw || !/^\d{1,18}$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
