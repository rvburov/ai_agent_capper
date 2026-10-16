import type { StrategyVersion } from './types';

// Порядок и выбор версий стратегии без текстов: им пользуются и «Обучение модели», и кабинет
// («Банк и стратегия» — свои правила суммы), не подтягивая тексты чужого экрана.

/** Что за версия без кода: «v4 · сжатое досье» → «сжатое досье»; только код — пусто. */
export function versionShort(version: Pick<StrategyVersion, 'code' | 'name'>): string {
  const parts = version.name.split(' · ');
  const rest = parts[0] === version.code ? parts.slice(1).join(' · ') : version.name;
  return rest === version.code ? '' : rest;
}

/** Версии новыми сверху (как в макете). */
export function newestFirst<T extends Pick<StrategyVersion, 'created_at' | 'id'>>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id);
}

export const findActive = (items: readonly StrategyVersion[]) => items.find((item) => item.status === 'active') ?? null;
export const findCandidate = (items: readonly StrategyVersion[]) => newestFirst(items).find((item) => item.status === 'candidate') ?? null;

/**
 * Коды правил суммы на экране: r1, r2… по порядку в линии участника (исходные правила — r1).
 * Только показ: сервер хранит свои коды (исходные — общий код стратегии), на экране анализа
 * код версии остается серверным.
 */
const RULES_PREFIX = 'r';
/** Исходные правила участника (своих версий еще нет). */
export const RULES_FIRST_CODE = `${RULES_PREFIX}1`;

export function rulesCodes(items: readonly Pick<StrategyVersion, 'id' | 'created_at'>[]): Map<number, string> {
  const ordered = [...items].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id);
  return new Map(ordered.map((item, index) => [item.id, `${RULES_PREFIX}${index + 1}`]));
}

/** Код версии правил для экрана; версии нет в списке — серверный код. */
export function ruleCode(codes: ReadonlyMap<number, string>, version: Pick<StrategyVersion, 'id' | 'code'>): string {
  return codes.get(version.id) ?? version.code;
}
