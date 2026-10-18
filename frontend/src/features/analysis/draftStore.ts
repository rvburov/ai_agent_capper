import type { EditEvent } from './draft';
import type { TextKey } from './types';

/*
 * Черновик «Нового анализа» переживает уход со страницы (как замыкание модуля в макете):
 * он лежит здесь, пока открыта вкладка, и в sessionStorage — на случай перезагрузки.
 * Адрес /new?draft=ID указывает анализ на сервере, с которым связан черновик.
 * sessionStorage — только удобство одной вкладки: недоступен — черновик живет до перезагрузки.
 * Черновик привязан к участнику: в нем банк, букмекер и события, а после выхода в той же
 * вкладке может войти другой человек — чужой черновик стирается, не показываясь.
 */

export interface ParseInfo {
  /** Банк из текста в валюте программы (строка Decimal) или null. */
  bank: string | null;
  ledgerBank: string | null;
  currency: string;
  /** Почему банк из текста не взят или расходится с учетом (analysis.draft.*). */
  bankNoteKey: string | null;
  bookmaker: string | null;
  unknown: { line_no: number; text: string; reason_key?: string | null }[];
  costUsd: number;
  warnings: TextKey[];
}

export type InputTab = 'text' | 'form';

export interface DraftState {
  /** Анализ на сервере: по нему «Перед запуском» и запуск. */
  analysisId: number | null;
  /** Анализ уже запускали: события другие — запуск создаст новый анализ. */
  launched: boolean;
  tab: InputTab;
  text: string;
  /** Текст, который разобрали последним (изменился — «разберите заново»). */
  parsedText: string | null;
  parse: ParseInfo | null;
  /** Банк как в поле формы; пусто — по учету. */
  bank: string;
  bookmaker: string | null;
  events: EditEvent[];
  /** События в режиме «Исправить» и их копии до правки (для «Отменить»). */
  editing: string[];
  snapshots: Record<string, EditEvent>;
}

export function emptyDraft(): DraftState {
  return {
    analysisId: null,
    launched: false,
    tab: 'text',
    text: '',
    parsedText: null,
    parse: null,
    bank: '',
    bookmaker: null,
    events: [],
    editing: [],
    snapshots: {},
  };
}

const STORAGE_KEY = 'capper.new-analysis.draft';

interface Stored {
  userId: number;
  draft: DraftState;
}

let current: Stored | null = null;

function readStored(): Stored | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Stored> | null;
    if (!value || typeof value.userId !== 'number' || !Array.isArray(value.draft?.events)) return null;
    return { userId: value.userId, draft: { ...emptyDraft(), ...value.draft } };
  } catch {
    return null;
  }
}

/** Последний черновик этой вкладки — только того же участника (иначе он стирается). */
export function loadDraft(userId: number | null): DraftState | null {
  current ??= readStored();
  if (!current) return null;
  if (userId === null || current.userId !== userId) {
    clearDraft();
    return null;
  }
  return current.draft;
}

export function saveDraft(state: DraftState, userId: number | null): void {
  if (userId === null) return;
  current = { userId, draft: state };
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // хранилище недоступно: черновик живет до перезагрузки
  }
}

export function clearDraft(): void {
  current = null;
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // нечего удалять
  }
}
