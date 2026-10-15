import { isSurface, type Surface } from '../../components/SurfaceChip';
import type { ConfirmedEvent, Draft, DraftEvent, EventIn, PlayerPick } from './types';

/*
 * Черновик «Нового анализа»: события, которые участник проверяет и правит до запуска.
 * Источники — ответ разбора (DraftOut), подтвержденные события запуска (для «Изменить
 * события») или пустое событие формы. В API уходит EventIn: игроки — id из базы, кэфы —
 * строкой, пара [на игрока 1, на игрока 2] по рынку.
 */

export type OddKey = 'ml1' | 'ml2' | 'h1m' | 'h1p' | 'h2m' | 'h2p';
/** Порядок полей кэфов как в макете: П1, П2, Ф1(−1.5), Ф1(+1.5), Ф2(−1.5), Ф2(+1.5). */
export const ODD_KEYS: readonly OddKey[] = ['ml1', 'ml2', 'h1m', 'h1p', 'h2m', 'h2p'];
export const MAIN_ODDS: readonly OddKey[] = ['ml1', 'ml2'];
export const ODDS_MIN = 1.01;
export const ODDS_MAX = 50;

export interface PickedPlayer {
  id: number;
  name: string;
  nameRu: string | null;
  country: string | null;
  eloRank: number | null;
  lastMatch: string | null;
}

/**
 * Игрок события. matched — разбор нашел уверенно (≥ 0,9); check — похож (0,7–0,9), нужно
 * подтвердить; missing — нет в базе; manual — выбран из подсказок или подтвержден; typed —
 * набран текст, игрок еще не выбран; empty — пусто.
 */
export type SlotStatus = 'matched' | 'check' | 'missing' | 'manual' | 'typed' | 'empty';

export interface PlayerSlot {
  /** Как игрок назван в тексте (для «в тексте: «…»»). */
  raw: string;
  /** Текст в поле формы. */
  text: string;
  status: SlotStatus;
  /** Игрок из базы; у check — кандидат, которого нужно подтвердить. */
  player: PickedPlayer | null;
  score: number | null;
}

export interface EditEvent {
  key: string;
  lineNo: number | null;
  p1: PlayerSlot;
  p2: PlayerSlot;
  tournamentId: number | null;
  tournamentName: string;
  category: string | null;
  surface: Surface | null;
  bestOf: 3 | 5 | null;
  round: string;
  odds: Record<OddKey, string>;
  bookmaker: string | null;
  /** Новое пустое событие: ошибки проверки еще не показываем. */
  blank: boolean;
}

let seq = 0;
export function newKey(): string {
  seq += 1;
  return `ev${Date.now().toString(36)}${seq}`;
}

export function emptySlot(): PlayerSlot {
  return { raw: '', text: '', status: 'empty', player: null, score: null };
}

export function emptyOdds(): Record<OddKey, string> {
  return { ml1: '', ml2: '', h1m: '', h1p: '', h2m: '', h2p: '' };
}

export function blankEvent(): EditEvent {
  return {
    key: newKey(),
    lineNo: null,
    p1: emptySlot(),
    p2: emptySlot(),
    tournamentId: null,
    tournamentName: '',
    category: null,
    surface: 'hard',
    bestOf: null,
    round: '',
    odds: emptyOdds(),
    bookmaker: null,
    blank: true,
  };
}

/** Имя на экране: по-русски, если есть, иначе как в базе. */
export function displayName(player: { name: string; nameRu?: string | null; name_ru?: string | null }): string {
  return player.nameRu ?? player.name_ru ?? player.name;
}

// Инициал имени: «Я.», «K.» (буква и точка)
const INITIAL = /^\p{L}\.$/u;

/**
 * Фамилия для коротких подписей: «Синнер» из «Янник Синнер». Игроки из старого бота записаны
 * фамилией с инициалом («Синнер Я.»): инициал в конце отбрасывается, а не берется вместо фамилии.
 */
export function shortName(full: string): string {
  const parts = full.trim().split(/\s+/);
  if (parts.length > 1 && INITIAL.test(parts[parts.length - 1] ?? '') && !INITIAL.test(parts[0] ?? '')) {
    return parts.slice(0, -1).join(' ');
  }
  return parts.length > 1 ? parts.slice(1).join(' ') : full.trim();
}

/**
 * Кэф в поле ввода: как в базе (NUMERIC(6, 3)) — до 3 знаков, но не меньше 2: «1.30», «1.625».
 * Округлять до 2 нельзя: 1.833 стал бы 1.83 и поменял маржу, сумму и кэф ставки (CLV).
 */
export function oddInputText(n: number): string {
  const text = (Math.round(n * 1000) / 1000).toFixed(3);
  return text.endsWith('0') ? text.slice(0, -1) : text;
}

function oddText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const n = Number(value);
  return Number.isFinite(n) ? oddInputText(n) : String(value);
}

function slotFromPick(pick: PlayerPick): PlayerSlot {
  const player = pick.player
    ? {
        id: pick.player.id,
        name: pick.player.name,
        nameRu: pick.player.name_ru,
        country: pick.player.country,
        eloRank: pick.player.elo_rank,
        lastMatch: pick.player.last_match,
      }
    : null;
  return {
    raw: pick.raw,
    text: player ? displayName(player) : pick.raw,
    status: pick.status === 'matched' && player ? 'matched' : pick.status === 'check' && player ? 'check' : 'missing',
    player,
    score: pick.score,
  };
}

/** Событие из ответа разбора. */
export function fromDraftEvent(event: DraftEvent): EditEvent {
  const pair = (market: 'ML' | 'HCP_-1.5' | 'HCP_+1.5') => event.odds[market] ?? [null, null];
  const [ml1, ml2] = pair('ML');
  const [h1m, h2m] = pair('HCP_-1.5');
  const [h1p, h2p] = pair('HCP_+1.5');
  return {
    key: newKey(),
    lineNo: event.line_no,
    p1: slotFromPick(event.player1),
    p2: slotFromPick(event.player2),
    tournamentId: event.tournament?.id ?? null,
    tournamentName: event.tournament?.name ?? '',
    category: event.tournament?.category ?? null,
    surface: isSurface(event.surface) ? event.surface : null,
    bestOf: event.best_of === 5 ? 5 : event.best_of === 3 ? 3 : null,
    round: event.round,
    odds: {
      ml1: oddText(ml1),
      ml2: oddText(ml2),
      h1m: oddText(h1m),
      h1p: oddText(h1p),
      h2m: oddText(h2m),
      h2p: oddText(h2p),
    },
    bookmaker: event.bookmaker,
    blank: false,
  };
}

/** Событие из подтвержденных при запуске («Изменить события» после запуска). */
export function fromConfirmedEvent(event: ConfirmedEvent): EditEvent {
  const slot = (p: ConfirmedEvent['player1']): PlayerSlot => {
    const player = { id: p.id, name: p.name, nameRu: p.name_ru, country: p.country, eloRank: null, lastMatch: null };
    return { raw: '', text: displayName(player), status: 'manual', player, score: null };
  };
  const pair = (market: 'ML' | 'HCP_-1.5' | 'HCP_+1.5') => event.odds[market] ?? [null, null];
  const [ml1, ml2] = pair('ML');
  const [h1m, h2m] = pair('HCP_-1.5');
  const [h1p, h2p] = pair('HCP_+1.5');
  return {
    key: newKey(),
    lineNo: null,
    p1: slot(event.player1),
    p2: slot(event.player2),
    tournamentId: event.tournament_id,
    tournamentName: event.tournament_name ?? '',
    category: null,
    surface: isSurface(event.surface) ? event.surface : null,
    bestOf: event.best_of === 5 ? 5 : event.best_of === 3 ? 3 : null,
    round: event.round,
    odds: {
      ml1: oddText(ml1),
      ml2: oddText(ml2),
      h1m: oddText(h1m),
      h1p: oddText(h1p),
      h2m: oddText(h2m),
      h2p: oddText(h2p),
    },
    bookmaker: event.bookmaker,
    blank: false,
  };
}

export function eventsFromDraft(draft: Draft | null | undefined): EditEvent[] {
  return (draft?.events ?? []).map(fromDraftEvent);
}

// ---------- кэфы ----------

/** Число из поля кэфа: «1,62» и «1.62»; пусто или мусор — NaN. */
export function oddNumber(value: string | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  const text = value.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

export function validOdd(value: string | null | undefined): boolean {
  const n = oddNumber(value);
  return n >= ODDS_MIN && n <= ODDS_MAX;
}

/** Кэф для API: строка с точкой и не больше 3 знаков; неверный — null (о нем скажет проверка). */
export function oddForApi(value: string): string | null {
  if (!validOdd(value)) return null;
  return (Math.round(oddNumber(value) * 1000) / 1000).toString();
}

/** Уход из поля: верный кэф — «1.62», «1.625» (запятая — точкой). */
export function normalizeOdd(value: string): string {
  return validOdd(value) ? oddInputText(oddNumber(value)) : value.trim();
}

// ---------- игроки ----------

/** Игрок, с которым можно запускать: найден уверенно, выбран или подтвержден. */
export function resolvedPlayer(slot: PlayerSlot): PickedPlayer | null {
  return slot.status === 'matched' || slot.status === 'manual' ? slot.player : null;
}

/** id для «Перед запуском»: у неподтвержденного — кандидат (оценка цены), запуск его не пустит. */
function previewPlayerId(slot: PlayerSlot): number | null {
  return slot.status === 'check' ? (slot.player?.id ?? null) : (resolvedPlayer(slot)?.id ?? null);
}

/** Название игрока в карточке: подтвержденный — из базы, иначе как в тексте или поле. */
export function slotName(slot: PlayerSlot, fallback: string): string {
  const player = resolvedPlayer(slot);
  if (player) return displayName(player);
  return slot.raw || slot.text || fallback;
}

// ---------- проверка события ----------

export type EventIssue =
  | { kind: 'players' }
  | { kind: 'same' }
  | { kind: 'oddsRange'; keys: OddKey[] }
  | { kind: 'ml' };

export interface EventCheck {
  issues: EventIssue[];
  /** Поля кэфов с неверным значением. */
  bad: Set<OddKey>;
}

/** Проверки события до запуска (check в mockup/js/screens/new-analysis.js). */
export function checkEvent(event: EditEvent): EventCheck {
  const issues: EventIssue[] = [];
  const bad = new Set<OddKey>();
  const filled = (slot: PlayerSlot) => slot.status !== 'empty' && (slot.player !== null || slot.text.trim() !== '' || slot.raw !== '');
  if (!filled(event.p1) || !filled(event.p2)) issues.push({ kind: 'players' });
  else if (event.p1.player && event.p2.player && event.p1.player.id === event.p2.player.id) issues.push({ kind: 'same' });
  for (const key of ODD_KEYS) {
    const value = event.odds[key];
    if (value.trim() !== '' && !validOdd(value)) bad.add(key);
  }
  if (bad.size) issues.push({ kind: 'oddsRange', keys: ODD_KEYS.filter((key) => bad.has(key)) });
  if (!event.odds.ml1.trim() || !event.odds.ml2.trim()) issues.push({ kind: 'ml' });
  return { issues, bad };
}

// ---------- в API ----------

function oddsPairs(odds: Record<OddKey, string>): EventIn['odds'] {
  return {
    ML: [oddForApi(odds.ml1), oddForApi(odds.ml2)],
    'HCP_-1.5': [oddForApi(odds.h1m), oddForApi(odds.h2m)],
    'HCP_+1.5': [oddForApi(odds.h1p), oddForApi(odds.h2p)],
  };
}

/** Событие для API. forRun — запуск: только уверенно найденные и подтвержденные игроки. */
export function toEventIn(event: EditEvent, { forRun = false }: { forRun?: boolean } = {}): EventIn {
  const id = (slot: PlayerSlot) => (forRun ? (resolvedPlayer(slot)?.id ?? null) : previewPlayerId(slot));
  const name = event.tournamentName.trim();
  return {
    player1_id: id(event.p1),
    player2_id: id(event.p2),
    tournament_id: event.tournamentId,
    tournament_name: name ? name.slice(0, 200) : null,
    surface: event.surface,
    best_of: event.bestOf,
    round: event.round.slice(0, 16),
    odds: oddsPairs(event.odds),
    bookmaker: event.bookmaker ? event.bookmaker.slice(0, 64) : null,
    line_no: event.lineNo,
  };
}
