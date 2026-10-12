import { spendTone, type SpendTone } from '../../components/LimitBar';
import type { AdminUser } from './types';

// Участники в кабинете администратора: фильтр, порядок, сводка и кандидаты для сброса доступа.

export const USER_FILTERS = ['all', 'active', 'blocked'] as const;
export type UserFilter = (typeof USER_FILTERS)[number];

export function personName(user: Pick<AdminUser, 'display_name' | 'email'>): string {
  return user.display_name.trim() || user.email;
}

/** Люди программы: удаленные (status = deleted) в списке не показываются. */
export function visiblePeople(users: readonly AdminUser[]): AdminUser[] {
  return users.filter((u) => u.status !== 'deleted');
}

export function matchesFilter(user: AdminUser, filter: UserFilter): boolean {
  if (filter === 'active') return user.status === 'active';
  if (filter === 'blocked') return user.status === 'blocked';
  return true;
}

/** Как в макете: сначала вы, заблокированные в конце, остальные — по расходу на ИИ. */
export function sortPeople(users: readonly AdminUser[], meId: number): AdminUser[] {
  return [...users].sort(
    (a, b) =>
      Number(b.id === meId) - Number(a.id === meId) ||
      Number(a.status === 'blocked') - Number(b.status === 'blocked') ||
      b.ai_spent_month_usd - a.ai_spent_month_usd ||
      personName(a).localeCompare(personName(b), 'ru'),
  );
}

export interface PeopleSummary {
  total: number;
  active: number;
  blocked: number;
  admins: number;
}

export function summarize(users: readonly AdminUser[]): PeopleSummary {
  const people = visiblePeople(users);
  return {
    total: people.length,
    active: people.filter((u) => u.status === 'active').length,
    blocked: people.filter((u) => u.status === 'blocked').length,
    admins: people.filter((u) => u.role === 'admin').length,
  };
}

export type { SpendTone };

/**
 * Доля израсходованного личного лимита и цвет полосы; без лимита — null. alertPct — порог
 * уведомления из настроек администратора (50–90%): с него полоса желтая, как в макете.
 */
export function spendShare(user: AdminUser, alertPct: number): { share: number | null; tone: SpendTone } {
  const monthly = user.limit?.monthly_usd;
  if (!monthly) return { share: null, tone: null };
  return { share: user.ai_spent_month_usd / monthly, tone: spendTone(user.ai_spent_month_usd, monthly, alertPct) };
}

const byName = (a: AdminUser, b: AdminUser) => personName(a).localeCompare(personName(b), 'ru');

/**
 * Кому можно выдать код сброса из кабинета: участникам, кроме себя. Администратору код
 * выдается только командой терминала (Р6), сервер ответит 403.
 */
export function resetCandidates(users: readonly AdminUser[], meId: number): AdminUser[] {
  return visiblePeople(users)
    .filter((u) => u.id !== meId && u.role === 'member')
    .sort(byName);
}

/** Кому можно сбросить 2FA: участникам с включенной 2FA. Администраторам — только в терминале. */
export function twoFactorCandidates(users: readonly AdminUser[], meId: number): AdminUser[] {
  return resetCandidates(users, meId).filter((u) => u.totp_enabled);
}

/** Email похож на адрес: name@domain.zone (как проверка формы в макете). */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}
