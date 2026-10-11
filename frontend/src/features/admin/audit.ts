import i18n from '../../i18n';
import { limitText } from './limits';
import type { AuditAction, AuditEntry, Role } from './types';

/*
 * Журнал действий: группы фильтра «Тип действия» и человеческий текст записи.
 * Названия действий — admin.audit.actions.<action> в ru.json (те же ключи, что audit.* на сервере).
 * Подробности сервер отдает словарем details; здесь из него собирается строка, как в макете.
 */

export const AUDIT_GROUPS = ['all', 'invite', 'access', 'people', 'money', 'settings', 'import'] as const;
export type AuditGroup = (typeof AUDIT_GROUPS)[number];

// Группа «Команды терминала» из макета не сделана: сервер не фильтрует журнал по автору,
// а фильтр на странице по уже загруженным записям врал бы при постраничной загрузке.
// Импорт истории (его в макете нет, делается только из терминала) — своя группа на ее месте.
// Каждое действие журнала входит в одну из групп (проверяет audit.test.ts).
const GROUP_ACTIONS: Record<Exclude<AuditGroup, 'all'>, readonly AuditAction[]> = {
  invite: ['invite', 'invite_revoke'],
  access: ['reset_code', 'reset_code_revoke', 'reset_2fa', 'sessions_revoke', 'confirm_failed'],
  people: ['block', 'unblock', 'delete', 'role_change', 'create_admin'],
  money: ['key_change', 'limit_change', 'ai_mode_change', 'budget_change'],
  settings: ['currency_change', 'message', 'agent_config_change'],
  // Правка игроков — тоже команды терминала с общими данными, как импорт (этап 2)
  import: ['import', 'player_merge', 'player_edit'],
};

/** Действия группы для запроса ?action=...; для «Все действия» — без фильтра. */
export function groupActions(group: AuditGroup): readonly AuditAction[] | undefined {
  return group === 'all' ? undefined : GROUP_ACTIONS[group];
}

/** Команда терминала: автора нет (actor_name пустой), в details — source = terminal. */
export function isTerminal(entry: AuditEntry): boolean {
  return entry.details.source === 'terminal' || (entry.actor_id === null && entry.actor_name === '');
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isRole(value: unknown): value is Role {
  return value === 'admin' || value === 'member';
}

/** Кого касается запись: участник, email приглашения или null — «вся программа». */
export function auditTarget(entry: AuditEntry): string | null {
  const d = entry.details;
  if (entry.action === 'delete') {
    const name = text(d.display_name);
    const email = text(d.email);
    if (name && email) return `${name} (${email})`;
    return name ?? email ?? (text(entry.target_name) || null);
  }
  return text(entry.target_name) ?? text(d.email);
}

interface LimitDetails {
  monthly_usd: string | number;
  daily_analyses: number;
  per_analysis_usd: string | number;
}

function limitOf(value: unknown): LimitDetails | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const ok =
    (typeof v.monthly_usd === 'string' || typeof v.monthly_usd === 'number') &&
    typeof v.daily_analyses === 'number' &&
    (typeof v.per_analysis_usd === 'string' || typeof v.per_analysis_usd === 'number');
  return ok ? (v as unknown as LimitDetails) : null;
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Подробности записи одной строкой; неизвестное действие — пустая строка. */
export function auditDetails(entry: AuditEntry): string {
  const d = entry.details;
  const t = i18n.t;
  switch (entry.action) {
    case 'invite': {
      const role = isRole(d.role) ? t(`admin.role.${d.role}`) : '';
      const limit = limitOf(d.limit);
      const key =
        d.ai_mode === 'own'
          ? t('admin.audit.details.inviteKeyOwn')
          : limit
            ? t('admin.audit.details.inviteKeyShared', { limit: limitText(limit) })
            : t('admin.audit.details.inviteKeySharedDefault');
      return role ? t('admin.audit.details.invite', { role, key }) : key;
    }
    case 'invite_revoke':
      return t('admin.audit.details.inviteRevoke');
    case 'reset_code':
      return d.replaced ? t('admin.audit.details.resetCodeReplaced') : t('admin.audit.details.resetCode');
    case 'reset_code_revoke':
      return t('admin.audit.details.resetCodeRevoke');
    case 'reset_2fa':
      return t('admin.audit.details.reset2fa');
    case 'block':
      return count(d.reset_codes_revoked) > 0
        ? t('admin.audit.details.blockCodes')
        : t('admin.audit.details.block');
    case 'unblock':
      return t('admin.audit.details.unblock');
    case 'role_change':
      return isRole(d.from) && isRole(d.to)
        ? t('admin.audit.details.role', { from: t(`admin.role.${d.from}`), to: t(`admin.roleLower.${d.to}`) })
        : '';
    case 'sessions_revoke':
      return t('admin.audit.details.sessions');
    case 'delete':
      return d.consent_training === true
        ? t('admin.audit.details.deleteConsent')
        : t('admin.audit.details.deleteNoConsent');
    case 'create_admin':
      return isTerminal(entry) ? t('admin.audit.details.createAdmin') : '';
    case 'key_change': {
      const last4 = text(d.last4);
      if (!last4) return '';
      return d.verified === false
        ? t('admin.audit.details.keyUnverified', { last4 })
        : t('admin.audit.details.keyVerified', { last4 });
    }
    case 'import':
      return t('admin.audit.details.import', {
        file: text(d.file) ?? '—',
        players: count(d.players_created),
        tournaments: count(d.tournaments_created),
        matches: count(d.matches_created),
      });
    default:
      // limit_change, currency_change, message — появятся на этапах 3–4 вместе с их экранами;
      // confirm_failed, player_merge, player_edit (этап 2) пока без строки подробностей
      return '';
  }
}
