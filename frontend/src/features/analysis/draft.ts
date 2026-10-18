import { isSurface, type Surface } from '../../components/SurfaceChip';
import { EXTRA_FAMILIES, GAME_HCP_MAX, GAME_TOTAL_MAX, GAME_TOTAL_MIN, isHalfOrWhole, marketCode, marketSpec, type ExtraFamily } from './markets';
import type { ConfirmedEvent, Draft, DraftEvent, EventIn, PlayerPick, TextKey } from './types';

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
  /** Другие рынки (Р28): форы ±2.5 и по геймам, тоталы сетов и геймов. */
  extra: ExtraMarket[];
  /** Спорные форы из текста: «Ф1(−1.5)» без «сет» и «гейм» — по сетам или по геймам? */
  ambig: AmbigHcp[];
  bookmaker: string | null;
  /** Новое пустое событие: ошибки проверки еще не показываем. */
  blank: boolean;
}

export type { ExtraFamily } from './markets';

/**
 * Строка «Другие рынки»: семейство, линия и кэфы двух исходов. У фор line — фора игрока 1
 * (o1 — Ф1, o2 — Ф2), у тоталов o1 — больше, o2 — меньше. Линия — текстом поля («-3.5»).
 */
export interface ExtraMarket {
  key: string;
  family: ExtraFamily;
  line: string;
  o1: string;
  o2: string;
}

/**
 * Спорная фора из разбора («Ф1(-1.5) = 2.05, Ф2(+1.5) = 1.72» без «сет» и «гейм»): line —
 * фора игрока 1, o1 и o2 — кэфы Ф1 и Ф2. hint — подсказка сервера по кэфу победы
 * (analysis.draft.hcp_hint.sets или .games); setsOk — по сетам такая линия возможна.
 */
export interface AmbigHcp {
  line: number;
  o1: string;
  o2: string;
  hint: TextKey | null;
  setsOk: boolean;
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
    extra: [],
    ambig: [],
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
    extra: extrasFrom(event),
    ambig: ambigFrom(event),
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
    extra: extrasFrom(event),
    ambig: [],
    bookmaker: event.bookmaker,
    blank: false,
  };
}

// Другие рынки из ответа сервера: код рынка с линией (GTOT_22.5) или семейство и линия
interface ExtraOut {
  market: string;
  line?: string | number | null;
  o1?: string | number | null;
  o2?: string | number | null;
}

function extrasFrom(event: object): ExtraMarket[] {
  const list = (event as { extra?: readonly ExtraOut[] | null }).extra ?? [];
  const out: ExtraMarket[] = [];
  for (const item of list) {
    const spec = marketSpec(item.market);
    const family = (spec ? spec.family : item.market) as ExtraFamily;
    if (!EXTRA_FAMILIES.includes(family)) continue;
    const line = spec?.line ?? Number(item.line);
    if (!Number.isFinite(line)) continue;
    out.push(newExtra(family, null, { line: lineInputText(line), o1: oddText(item.o1 === null || item.o1 === undefined ? null : String(item.o1)), o2: oddText(item.o2 === null || item.o2 === undefined ? null : String(item.o2)) }));
  }
  return out;
}

// Спорные форы разбора: без слов «сет» и «гейм» (ответ — кнопкой в карточке события)
function ambigFrom(event: DraftEvent): AmbigHcp[] {
  return event.disputed.map((d) => ({
    line: d.line,
    o1: oddText(d.o1),
    o2: oddText(d.o2),
    hint: d.hint,
    setsOk: d.sets_ok,
  }));
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
  | { kind: 'ml' }
  | { kind: 'extraOdds'; families: ExtraFamily[] }
  | { kind: 'extraLine'; family: ExtraFamily }
  | { kind: 'hcp25' }
  | { kind: 'setsTotal'; bestOf: 3 | 5 }
  | { kind: 'gamesTotalLow'; line: number }
  | { kind: 'extraSame'; family: ExtraFamily }
  | { kind: 'ambig'; abs: number };

export interface EventCheck {
  issues: EventIssue[];
  /** Поля кэфов с неверным значением: ключи П1…Ф2 и «ключ строки-o1/o2» других рынков. */
  bad: Set<string>;
  /** Строки других рынков с неверной линией. */
  badLines: Set<string>;
}

/** Проверки события до запуска (check и checkExtra в mockup/js/screens/new-analysis.js). */
export function checkEvent(event: EditEvent): EventCheck {
  const issues: EventIssue[] = [];
  const bad = new Set<string>();
  const badLines = new Set<string>();
  const filled = (slot: PlayerSlot) => slot.status !== 'empty' && (slot.player !== null || slot.text.trim() !== '' || slot.raw !== '');
  if (!filled(event.p1) || !filled(event.p2)) issues.push({ kind: 'players' });
  else if (event.p1.player && event.p2.player && event.p1.player.id === event.p2.player.id) issues.push({ kind: 'same' });
  for (const key of ODD_KEYS) {
    const value = event.odds[key];
    if (value.trim() !== '' && !validOdd(value)) bad.add(key);
  }
  if (bad.size) issues.push({ kind: 'oddsRange', keys: ODD_KEYS.filter((key) => bad.has(key)) });
  if (!event.odds.ml1.trim() || !event.odds.ml2.trim()) issues.push({ kind: 'ml' });
  for (const ambig of event.ambig) issues.push({ kind: 'ambig', abs: Math.abs(ambig.line) });
  issues.push(...checkExtra(event, bad, badLines));
  return { issues, bad, badLines };
}

function checkExtra(event: EditEvent, bad: Set<string>, badLines: Set<string>): EventIssue[] {
  const issues: EventIssue[] = [];
  const oddsBad = new Set<ExtraFamily>();
  const seen = new Set<string>();
  for (const x of event.extra) {
    for (const side of ['o1', 'o2'] as const) {
      if (x[side].trim() !== '' && !validOdd(x[side])) {
        bad.add(`${x.key}-${side}`);
        oddsBad.add(x.family);
      }
    }
    const line = extraLine(x);
    const lineIssue = extraLineIssue(x.family, line, event.bestOf);
    if (lineIssue) {
      badLines.add(x.key);
      if (!issues.some((i) => JSON.stringify(i) === JSON.stringify(lineIssue))) issues.push(lineIssue);
      continue;
    }
    const code = marketCode(x.family, line);
    if (seen.has(code) && !issues.some((i) => i.kind === 'extraSame' && i.family === x.family)) issues.push({ kind: 'extraSame', family: x.family });
    seen.add(code);
  }
  if (oddsBad.size) issues.unshift({ kind: 'extraOdds', families: [...oddsBad] });
  return issues;
}

/** Что не так с линией строки других рынков (null — все в порядке). */
export function extraLineIssue(family: ExtraFamily, line: number, bestOf: 3 | 5 | null): EventIssue | null {
  if (!isHalfOrWhole(line)) return { kind: 'extraLine', family };
  if (family === 'shcp' || family === 'stot') {
    if (setLines(family, bestOf).includes(line)) return null;
    if (family === 'shcp') return { kind: 'hcp25' };
    return bestOf ? { kind: 'setsTotal', bestOf } : { kind: 'extraLine', family };
  }
  if (family === 'gtot') {
    if (line > 0 && line < GAME_TOTAL_MIN) return { kind: 'gamesTotalLow', line };
    return line > GAME_TOTAL_MAX || line <= 0 ? { kind: 'extraLine', family } : null;
  }
  return line === 0 || Math.abs(line) > GAME_HCP_MAX ? { kind: 'extraLine', family } : null;
}

// ---------- другие рынки (Р28) ----------

let extraSeq = 0;

/**
 * Линии рынков по сетам: фора ±2.5 — только в матчах до 3 побед; тотал сетов — 2.5, а до 3
 * побед — 3.5 и 4.5. Формат еще не известен (сервер узнает его по турниру) — все варианты.
 */
export function setLines(family: 'shcp' | 'stot', bestOf: 3 | 5 | null): number[] {
  if (family === 'shcp') return bestOf === 3 ? [] : [-2.5, 2.5];
  if (bestOf === 5) return [3.5, 4.5];
  if (bestOf === 3) return [2.5];
  return [2.5, 3.5, 4.5];
}

export function defaultLine(family: ExtraFamily, bestOf: 3 | 5 | null): number {
  if (family === 'shcp') return -2.5;
  if (family === 'stot') return setLines('stot', bestOf)[0] ?? 2.5;
  return family === 'ghcp' ? -3.5 : 22.5;
}

/** Линия из поля: «-3.5», «−3,5», «+4»; не число — NaN. */
export function extraLine(x: Pick<ExtraMarket, 'line'>): number {
  const text = x.line.trim().replace(',', '.').replace(/[\u2212\u2013]/, '-');
  if (!/^[+-]?\d+(\.\d+)?$/.test(text)) return Number.NaN;
  return Number(text);
}

/** Линия в поле: −3.5 → «-3.5», 22 → «22». */
export function lineInputText(line: number): string {
  return String(line);
}

export function newExtra(family: ExtraFamily, bestOf: 3 | 5 | null, over: Partial<ExtraMarket> = {}): ExtraMarket {
  extraSeq += 1;
  return { key: `x${Date.now().toString(36)}${extraSeq}`, family, line: lineInputText(defaultLine(family, bestOf)), o1: '', o2: '', ...over };
}

/** Рынок для «Добавить рынок»: первый еще не введенный (фора ±2.5 — только до 3 побед), иначе тотал геймов. */
export function nextExtraFamily(event: Pick<EditEvent, 'extra' | 'bestOf'>): ExtraFamily {
  const used = new Set(event.extra.map((x) => x.family));
  return EXTRA_FAMILIES.find((f) => !used.has(f) && (f !== 'shcp' || event.bestOf === 5)) ?? 'gtot';
}

/** Поставить кэф стороны в строку рынка с этой линией игрока 1 (строки нет — новая). */
function putExtra(extra: readonly ExtraMarket[], family: ExtraFamily, line: number, side: 1 | 2, odds: string, bestOf: 3 | 5 | null): ExtraMarket[] {
  const i = extra.findIndex((x) => x.family === family && extraLine(x) === line);
  const field = side === 1 ? 'o1' : 'o2';
  if (i >= 0) return extra.map((x, k) => (k === i ? { ...x, [field]: odds } : x));
  return [...extra, newExtra(family, bestOf, { line: lineInputText(line), [field]: odds })];
}

export type HcpUnit = 'sets' | 'games';

/** Ответ на спорную фору: кэфы уходят в фору ±1.5 по сетам, в фору ±2.5 или в фору по геймам. */
export function answerAmbig(event: EditEvent, index: number, unit: HcpUnit): EditEvent {
  const ambig = event.ambig[index];
  if (!ambig) return event;
  let odds = event.odds;
  let extra = event.extra;
  if (unit === 'sets' && Math.abs(ambig.line) === 1.5) {
    const minus1 = ambig.line < 0;
    // Ф1(−1.5) и Ф2(+1.5) или Ф1(+1.5) и Ф2(−1.5)
    const put = (key: OddKey, value: string) => {
      if (value) odds = { ...odds, [key]: value };
    };
    put(minus1 ? 'h1m' : 'h1p', ambig.o1);
    put(minus1 ? 'h2p' : 'h2m', ambig.o2);
  } else {
    const family = unit === 'sets' ? 'shcp' : 'ghcp';
    if (ambig.o1) extra = putExtra(extra, family, ambig.line, 1, ambig.o1, event.bestOf);
    if (ambig.o2) extra = putExtra(extra, family, ambig.line, 2, ambig.o2, event.bestOf);
  }
  return { ...event, odds, extra, ambig: event.ambig.filter((_, k) => k !== index), blank: false };
}

/** Подсказка сервера к спорной форе: «похоже на сеты» или «похоже на геймы»; нет — null. */
export function ambigGuess(ambig: AmbigHcp): HcpUnit | null {
  const key = ambig.hint?.key ?? '';
  if (key.endsWith('.sets')) return 'sets';
  if (key.endsWith('.games')) return 'games';
  return null;
}

/** Есть кэфы вне победы: фора ±1.5 или другие рынки (строка «в экспресс сейчас идут только…»). */
export function hasOtherMarkets(event: EditEvent): boolean {
  return (['h1m', 'h1p', 'h2m', 'h2p'] as const).some((k) => validOdd(event.odds[k])) || event.extra.some((x) => validOdd(x.o1) || validOdd(x.o2));
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
    extra: extraForApi(event.extra),
    disputed: event.ambig.map((d) => ({ line: d.line, o1: oddForApi(d.o1), o2: oddForApi(d.o2) })),
    bookmaker: event.bookmaker ? event.bookmaker.slice(0, 64) : null,
    line_no: event.lineNo,
  };
}

/**
 * Другие рынки для API: строки с верной линией и хотя бы одним кэфом (пустые строки формы не
 * уходят). Неверную линию отправляем как есть — о ней скажет проверка формы и сервер.
 */
function extraForApi(extra: readonly ExtraMarket[]): EventIn['extra'] {
  const out: NonNullable<EventIn['extra']> = [];
  for (const x of extra) {
    const o1 = oddForApi(x.o1);
    const o2 = oddForApi(x.o2);
    const line = extraLine(x);
    if ((o1 === null && o2 === null) || !Number.isFinite(line)) continue;
    out.push({ market: x.family, line, o1, o2 });
  }
  return out;
}
