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
      ai_mode_change: true, budget_change: true, agent_config_change: true, settings_change: true,
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
    // этап 3: лимиты, бюджет и режим ключа — что поменялось, как в макете
    expect(
      d('limit_change', {
        changes: {
          monthly_usd: { from: '10.00', to: '8.00' },
          daily_analyses: { from: 3, to: 5 },
          paused: { from: false, to: true },
        },
      }),
    ).toBe('В месяц $10 → $8, анализов в день 3 → 5, анализы на паузе');
    expect(d('limit_change', { changes: { per_analysis_usd: { from: '1.00', to: '0.50' } } })).toBe(
      'На анализ $1 → $0,50',
    );
    expect(
      d('budget_change', {
        changes: { monthly_budget_usd: { from: '60.00', to: '70.00' }, budget_alert_pct: { from: 80, to: 90 } },
      }),
    ).toBe('Общий бюджет $60 → $70 в месяц, уведомление при 80% → 90%');
    expect(d('budget_change', { changes: { default_daily_analyses: { from: 3, to: 4 } } })).toBe(
      'По умолчанию анализов в день 3 → 4',
    );
    expect(d('ai_mode_change', { from: 'own', to: 'shared', decision: 'approved' })).toBe(
      'Разрешен возврат на ключ администратора',
    );
    expect(d('ai_mode_change', { from: 'own', to: 'own', decision: 'rejected' })).toBe(
      'Просьба вернуть ключ администратора отклонена',
    );
    expect(d('ai_mode_change', { from: 'shared', to: 'own' })).toBe('Перешел на свой ключ');
    // неожиданный вид details не ломает журнал
    expect(d('limit_change', { changes: 'x' })).toBe('');
    expect(d('budget_change', { changes: { unknown_field: { from: 1, to: 2 } } })).toBe('');
    expect(d('role_change', { from: 1 })).toBe('');
    expect(d('currency_change', { from: 'RUB', to: 'EUR', rate: 'x' })).toBe('');
  });

  it('смена валюты и сообщение участникам', () => {
    const d = (action: AuditAction, details: Record<string, unknown>) => auditDetails(auditEntry({ action, details }));
    expect(d('currency_change', { from: 'RUB', to: 'EUR', rate: '95.12', rate_base: 'EUR' })).toBe(
      'Валюта программы: рубли → евро, курс 1\u00a0€ = 95,12\u00a0₽',
    );
    expect(d('currency_change', { from: 'EUR', to: 'USD', rate: '1.08000000', rate_base: 'EUR' })).toBe(
      'Валюта программы: евро → доллары США, курс 1\u00a0€ = 1,08\u00a0$',
    );
    expect(d('message', { text: ' Завтра обновление архива ', to: 'all', recipients: 3 })).toBe('Завтра обновление архива');
    // смена часового пояса по умолчанию (миграция 0007): группа «Валюта, настройки, сообщения»
    expect(groupActions('settings')).toContain('settings_change');
    expect(d('settings_change', { field: 'default_tz', from: 'Europe/Berlin', to: 'Europe/Helsinki' })).toBe(
      'Часовой пояс для новых участников: Берлин → Хельсинки',
    );
    // пояса нет в списке городов — имя IANA без подчеркиваний
    expect(d('settings_change', { field: 'default_tz', from: 'Asia/Ho_Chi_Minh', to: 'Europe/Helsinki' })).toBe(
      'Часовой пояс для новых участников: Asia/Ho Chi Minh → Хельсинки',
    );
    expect(d('settings_change', { field: 'default_tz', from: 'Europe/Berlin' })).toBe('');
  });
});
