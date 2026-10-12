import { describe, expect, it } from 'vitest';

import {
  looksLikeEmail,
  matchesFilter,
  resetCandidates,
  sortPeople,
  spendShare,
  summarize,
  twoFactorCandidates,
  visiblePeople,
} from './people';
import { adminUser } from './testData';

const ME = adminUser({ id: 1, display_name: 'Роман Буров', role: 'admin', ai_spent_month_usd: 0, limit: null });
const OLGA = adminUser({ id: 2, ai_spent_month_usd: 1.93 });
const ALEXEY = adminUser({ id: 3, display_name: 'Алексей Ковалев', ai_spent_month_usd: 7.28 });
const IGOR = adminUser({ id: 4, display_name: 'Игорь Нестеров', status: 'blocked', ai_spent_month_usd: 9 });
const MARIA = adminUser({ id: 5, display_name: 'Мария Виртанен', role: 'admin' });
const GONE = adminUser({ id: 6, display_name: '', status: 'deleted' });
const NO_2FA = adminUser({ id: 7, display_name: 'Дмитрий Шульц', totp_enabled: false });
const ALL = [IGOR, OLGA, GONE, ALEXEY, ME, MARIA, NO_2FA];

describe('участники в кабинете администратора', () => {
  it('удаленных нет в списке', () => {
    expect(visiblePeople(ALL).map((u) => u.id)).not.toContain(6);
  });

  it('порядок как в макете: сначала вы, заблокированные в конце, остальные по расходу', () => {
    // при равном расходе — по имени: Дмитрий, Мария, Ольга
    expect(sortPeople(visiblePeople(ALL), 1).map((u) => u.id)).toEqual([1, 3, 7, 5, 2, 4]);
  });

  it('фильтр по статусу', () => {
    const people = visiblePeople(ALL);
    expect(people.filter((u) => matchesFilter(u, 'all'))).toHaveLength(6);
    expect(people.filter((u) => matchesFilter(u, 'active'))).toHaveLength(5);
    expect(people.filter((u) => matchesFilter(u, 'blocked')).map((u) => u.id)).toEqual([4]);
  });

  it('сводка для шапки: удаленные не считаются', () => {
    expect(summarize(ALL)).toEqual({ total: 6, active: 5, blocked: 1, admins: 2 });
  });

  it('доля лимита и цвет полосы: с порога уведомления — предупреждение, со 100% — красный', () => {
    expect(spendShare(adminUser({ ai_spent_month_usd: 5 }), 80)).toEqual({ share: 0.5, tone: null });
    expect(spendShare(adminUser({ ai_spent_month_usd: 8 }), 80).tone).toBe('warn');
    expect(spendShare(adminUser({ ai_spent_month_usd: 7 }), 80).tone).toBeNull();
    // порог — из настроек администратора, а не 80% из кода
    expect(spendShare(adminUser({ ai_spent_month_usd: 7 }), 70).tone).toBe('warn');
    expect(spendShare(adminUser({ ai_spent_month_usd: 10 }), 90).tone).toBe('bad');
    expect(spendShare(adminUser({ limit: null }), 80)).toEqual({ share: null, tone: null });
  });

  it('код сброса и сброс 2FA — только участникам, кроме себя; 2FA — тем, у кого она включена', () => {
    expect(resetCandidates(ALL, 1).map((u) => u.id)).toEqual([3, 7, 4, 2]);
    expect(twoFactorCandidates(ALL, 1).map((u) => u.id)).toEqual([3, 4, 2]);
  });

  it('проверка email как в форме макета', () => {
    expect(looksLikeEmail('name@example.com')).toBe(true);
    expect(looksLikeEmail('name@example')).toBe(false);
    expect(looksLikeEmail('na me@example.com')).toBe(false);
  });
});
