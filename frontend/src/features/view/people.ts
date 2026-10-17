import { personName, visiblePeople } from '../admin/people';
import type { AdminUser } from '../admin/types';
import { useAdminUsers } from '../admin/useAdminUsers';
import { useViewAs } from './context';

/** Чьи данные можно открыть: все люди программы, кроме удаленных и самого администратора. */
export interface ViewPerson {
  id: number;
  name: string;
  blocked: boolean;
}

export function viewPeople(users: readonly AdminUser[], meId: number): ViewPerson[] {
  return visiblePeople(users)
    .filter((u) => u.id !== meId)
    .map((u) => ({ id: u.id, name: personName(u), blocked: u.status === 'blocked' }))
    .sort((a, b) => Number(a.blocked) - Number(b.blocked) || a.name.localeCompare(b.name, 'ru'));
}

/**
 * Имя участника, чьи данные на экране (приветствие главной, подписи): null — свои данные или
 * список людей еще не пришел.
 */
export function useViewedName(): string | null {
  const asUser = useViewAs();
  const users = useAdminUsers({ enabled: asUser !== null });
  if (asUser === null) return null;
  const user = users.data?.find((u) => u.id === asUser);
  return user ? personName(user) : null;
}

/** Список «Чьи данные смотреть» (GET /api/admin/users, только администратору). */
export function useViewPeople(meId: number): { people: ViewPerson[]; loaded: boolean } {
  const users = useAdminUsers();
  return { people: users.data ? viewPeople(users.data, meId) : [], loaded: users.data !== undefined };
}
