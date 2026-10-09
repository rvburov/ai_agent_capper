import { describe, expect, it } from 'vitest';

import { AUDIT_GROUPS, auditDetails, auditTarget, groupActions, isTerminal } from './audit';
import { auditEntry } from './testData';
import type { AuditAction } from './types';

describe('журнал действий', () => {
  it('группы фильтра: «Все действия» без фильтра, остальные — список действий', () => {
    expect(groupActions('all')).toBeUndefined();
    expect(groupActions('invite')).toEqual(['invite', 'invite_revoke']);
    expect(groupActions('people')).toContain('create_admin');
    expect(groupActions('import')).toEqual(['import', 'player_merge', 'player_edit']);
    expect(groupActions('access')).toContain('confirm_failed');
    // каждое действие сервера попадает ровно в одну группу; новое действие в схеме API
    // без строки здесь не пройдет tsc (Record по всем AuditAction)
    const grouped = AUDIT_GROUPS.flatMap((g) => groupActions(g) ?? []);
    const all: Record<AuditAction, true> = {
      invite: true, invite_revoke: true, reset_code: true, reset_code_revoke: true, reset_2fa: true,
      block: true, unblock: true, delete: true, role_change: true, sessions_revoke: true,
      limit_change: true, key_change: true, currency_change: true, create_admin: true, import: true,
      message: true, confirm_failed: true, player_merge: true, player_edit: true,
    };
    for (const action of Object.keys(all)) {
      expect(grouped.filter((a) => a === action)).toHaveLength(1);
    }
  });

  it('команда терминала: автора нет, source = terminal', () => {
    expect(isTerminal(auditEntry({ actor_id: null, actor_name: '', details: { source: 'terminal' } }))).toBe(true);
    expect(isTerminal(auditEntry())).toBe(false);
  });

  it('кого касается: участник, email приглашения или вся программа', () => {
    expect(auditTarget(auditEntry())).toBe('Ольга Лехтинен');
    expect(
      auditTarget(auditEntry({ action: 'invite', target_user_id: null, target_name: '', details: { email: 'new@example.com' } })),
    ).toBe('new@example.com');
    expect(
      auditTarget(
        auditEntry({
          action: 'delete',
          target_name: 'Удаленный пользователь',
          details: { display_name: 'Игорь Нестеров', email: 'igor@example.com', consent_training: false },
        }),
      ),
    ).toBe('Игорь Нестеров (igor@example.com)');
    expect(auditTarget(auditEntry({ action: 'key_change', target_user_id: null, target_name: '' }))).toBeNull();
  });

  it('подробности собираются из details', () => {
    const d = (action: AuditAction, details: Record<string, unknown>, over = {}) =>
      auditDetails(auditEntry({ action, details, ...over }));
    expect(
      d('invite', {
        role: 'member',
        ai_mode: 'shared',
        limit: { monthly_usd: '10.00', daily_analyses: 3, per_analysis_usd: '1.00' },
      }),
    ).toBe('Участник, ключ администратора, $10 в месяц · 3\u00a0анализа в день · $1 на анализ');
    expect(d('invite', { role: 'admin', ai_mode: 'own' })).toBe('Администратор, свой ключ');
    expect(d('reset_code', { replaced: 1 })).toBe('Код сброса пароля, 24 часа; прежний код отозван');
    expect(d('reset_code', { replaced: 0 })).toBe('Код сброса пароля, 24 часа');
    expect(d('block', { sessions_revoked: 2, reset_codes_revoked: 0 })).toBe('Заблокирован, сеансы завершены');
    expect(d('block', { sessions_revoked: 2, reset_codes_revoked: 1 })).toBe(
      'Заблокирован, сеансы завершены, код сброса отозван',
    );
    expect(d('role_change', { from: 'member', to: 'admin' })).toBe('Участник → администратор');
    expect(d('delete', { consent_training: true })).toMatch(/^Удалены ставки.*Обезличенные прогнозы сохранены/);
    expect(d('delete', { consent_training: false })).toMatch(/и прогнозы: согласия на обезличенное использование нет$/);
    expect(d('create_admin', { email: 'a@b.c', source: 'terminal' }, { actor_id: null, actor_name: '' })).toBe(
      'python -m app.admin.cli create-admin',
    );
    expect(d('key_change', { last4: 'm9Tq', verified: true })).toBe('Ключ администратора заменен: sk-ant-…m9Tq, проверен');
    expect(d('import', { file: 'История-ставок.json', players_created: 4, tournaments_created: 2, matches_created: 9 })).toBe(
      'Файл История-ставок.json: новых игроков 4, турниров 2, матчей 9',
    );
    // неожиданный вид details не ломает журнал
    expect(d('role_change', { from: 1 })).toBe('');
    expect(d('message', { text: 'Привет' })).toBe('');
  });
});
