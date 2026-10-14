import type { LegacyProfile } from './types';

/*
 * Профиль из старого бота (player_profiles, source = legacy_llm): файлы 01–04 шаблонов бота
 * «как есть» (legacy/telegram-bot/Tennis-Analytics/_Шаблоны). Это данные, а не тексты
 * интерфейса: имена полей ниже — ключи JSON бота, подписи оценок («взрывная сила») — тоже из
 * данных. Модель бота заполняла их сама, часто по памяти, поэтому все поля необязательны:
 * чего нет или что не того вида — просто не показывается.
 */

export interface Rating {
  /** Подпись из ключа бота: «Взрывная сила» из «взрывная_сила». */
  label: string;
  value: number;
  comment: string | null;
}

export interface Pattern {
  label: string;
  text: string;
}

export interface LegacyView {
  /** Когда бот заполнил профиль (meta.дата_заполнения), если указано. */
  filledAt: string | null;
  /** Источник из meta, если бот его указал. */
  source: string | null;
  style: string | null;
  position: string | null;
  serveType: string | null;
  grip: string | null;
  physical: Rating[];
  /** Средняя оценка раздела — как ее записал бот (средняя_оценка), а не расчет в браузере. */
  physicalAvg: number | null;
  technical: Rating[];
  technicalAvg: number | null;
  strengths: string[];
  weaknesses: string[];
  psychType: string | null;
  psychRatings: Rating[];
  patterns: Pattern[];
  notes: string | null;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter((item): item is string => item !== null) : [];
}

/** «взрывная_сила» → «Взрывная сила». */
export function fieldLabel(key: string): string {
  const words = key.replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Оценки 1–10 из раздела: { скорость: { оценка: 8, комментарий: "…" }, средняя_оценка: 7.4 }. */
function ratings(section: unknown): Rating[] {
  const items = obj(section);
  if (!items) return [];
  const out: Rating[] = [];
  for (const [key, raw] of Object.entries(items)) {
    if (key === 'средняя_оценка') continue;
    const item = obj(raw);
    const value = item ? item['оценка'] : raw;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10) continue;
    out.push({ label: fieldLabel(key), value, comment: item ? text(item['комментарий']) : null });
  }
  return out;
}

/** Средняя оценка раздела из профиля бота (средняя_оценка 0–10); нет или не число — null. */
function sectionAverage(section: unknown): number | null {
  const value = obj(section)?.['средняя_оценка'];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10 ? value : null;
}

function part(profile: Json, key: string): Json {
  return obj(profile[key]) ?? {};
}

/** Профиль бота в виде для вкладки «Профиль из бота». */
export function legacyView(legacy: LegacyProfile): LegacyView {
  const profile = obj(legacy.profile) ?? {};
  const personal = part(profile, '01');
  const game = part(profile, '02');
  const physique = part(profile, '03');
  const psych = part(profile, '04');
  const metas = ['01', '02', '03', '04'].map((key) => obj(part(profile, key)['meta']) ?? {});
  const filledAt = metas.map((meta) => text(meta['дата_заполнения'])).find((value) => value !== null) ?? null;
  const source = metas.map((meta) => text(meta['источник'])).find((value) => value !== null) ?? null;
  const gameProfile = obj(game['игровой_профиль']) ?? {};
  const personalData = obj(personal['личные_данные']) ?? {};
  const psychType = obj(psych['психотип']) ?? {};
  const patterns = Object.entries(obj(psych['поведенческие_паттерны']) ?? {})
    .map(([key, value]) => ({ label: fieldLabel(key), text: text(value) }))
    .filter((item): item is Pattern => item.text !== null);
  return {
    filledAt,
    source,
    style: text(gameProfile['стиль_игры']),
    position: text(gameProfile['позиция_на_корте']),
    serveType: text(gameProfile['тип_подачи']),
    grip: text(personalData['хват_ракетки']),
    physical: ratings(physique['физические_способности']),
    physicalAvg: sectionAverage(physique['физические_способности']),
    technical: ratings(physique['технические_способности']),
    technicalAvg: sectionAverage(physique['технические_способности']),
    strengths: texts(physique['сильные_стороны']),
    weaknesses: texts(physique['слабые_стороны']),
    psychType: text(psychType['тип_характера']),
    psychRatings: ratings(psych['оценки']),
    patterns,
    notes: text(psych['заметки']),
  };
}

// Варианты психотипа в шаблоне бота (04-психология.json): цвет метки на карточке
const PSYCH_TONE: Readonly<Record<string, 'good' | 'warn'>> = { Стабильный: 'good', Нестабильный: 'warn' };

/** Цвет метки психотипа: стабильный — зеленый, нестабильный — желтый, остальное — нейтральный. */
export function psychTone(type: string | null): 'good' | 'warn' | 'outline' {
  return (type && PSYCH_TONE[type]) || 'outline';
}

/** В профиле есть хоть что-то, что можно показать. */
export function hasContent(view: LegacyView): boolean {
  return Boolean(
    view.style ||
      view.position ||
      view.serveType ||
      view.grip ||
      view.physical.length ||
      view.technical.length ||
      view.strengths.length ||
      view.weaknesses.length ||
      view.psychType ||
      view.psychRatings.length ||
      view.patterns.length ||
      view.notes,
  );
}
