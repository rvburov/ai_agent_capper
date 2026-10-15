import i18n from '../../i18n';
import { currencySign, formatPercent, type Currency } from '../../lib/format';
import { formatLimitUsd, limitText } from './limits';
import { timeZoneName } from '../profile/timezones';
import { formatRate } from './settings';
import type { AuditAction, AuditEntry, Role } from './types';

/*
 * Журнал действий: группы фильтра «Тип действия» и человеческий текст записи.
 * Названия действий — admin.audit.actions.<action> в ru.json (те же ключи, что audit.* на сервере).
 * Подробности сервер отдает словарем details; здесь из него собирается строка, как в макете.
 */

export const AUDIT_GROUPS = [
  'all',
  'invite',
  'access',
  'people',
  'money',
  'settings',
  'import',
  'learning',
] as const;
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
  settings: ['currency_change', 'settings_change', 'message', 'agent_config_change'],
  // Правка игроков — тоже команды терминала с общими данными, как импорт (этап 2)
  import: ['import', 'player_merge', 'player_edit'],
  // Этап 5: загрузка файла tennis-data, наборы и прогоны проверок, включение версий
  learning: ['data_upload', 'eval_set', 'eval_run', 'version_on', 'lesson_on', 'model_on'],
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

function isCurrency(value: unknown): value is Currency {
  return value === 'RUB' || value === 'USD' || value === 'EUR';
}

function count(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** Изменения из details.changes: {поле: {from, to}} (журнал limit_change и budget_change). */
function changesOf(value: unknown): Array<[string, unknown, unknown]> {
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([name, change]) =>
    typeof change === 'object' && change !== null && 'to' in change
      ? [[name, (change as { from?: unknown }).from, (change as { to: unknown }).to] as [string, unknown, unknown]]
      : [],
  );
}

function usdOf(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? formatLimitUsd(n) : '—';
}

function plain(value: unknown): string {
  return typeof value === 'number' || typeof value === 'string' ? String(value) : '—';
}

// Поля изменений журнала и вид значения: доллары, число или проценты
const CHANGE_FIELDS = {
  monthly_usd: 'usd',
  daily_analyses: 'count',
  per_analysis_usd: 'usd',
  monthly_budget_usd: 'usd',
  budget_alert_pct: 'pct',
  eval_budget_usd: 'usd',
  default_member_limit_usd: 'usd',
  default_daily_analyses: 'count',
  default_per_analysis_usd: 'usd',
  per_analysis_soft_usd: 'usd',
  per_analysis_hard_usd: 'usd',
} as const;
type ChangeField = keyof typeof CHANGE_FIELDS;

function isChangeField(name: string): name is ChangeField {
  return Object.hasOwn(CHANGE_FIELDS, name);
}

/** «В месяц $10 → $15, анализов в день 3 → 5, анализы на паузе» — как limitDiff в макете. */
function changesText(value: unknown): string {
  const parts = changesOf(value).flatMap(([name, from, to]) => {
    if (name === 'paused') {
      return [i18n.t(to === true ? 'admin.audit.changes.pausedOn' : 'admin.audit.changes.pausedOff')];
    }
    if (!isChangeField(name)) return [];
    const kind = CHANGE_FIELDS[name];
    const show = (v: unknown) =>
      kind === 'usd' ? usdOf(v) : kind === 'pct' ? formatPercent(Number(v) / 100, { digits: 0 }) : plain(v);
    return [i18n.t(`admin.audit.changes.${name}`, { from: show(from), to: show(to) })];
  });
  const line = parts.join(', ');
  return line.charAt(0).toLocaleUpperCase('ru') + line.slice(1);
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
    case 'limit_change':
    case 'budget_change':
      return changesText(d.changes);
    case 'ai_mode_change':
      if (d.decision === 'approved') return t('admin.audit.details.modeApproved');
      if (d.decision === 'rejected') return t('admin.audit.details.modeRejected');
      return d.to === 'own' ? t('admin.audit.details.modeOwn') : d.to === 'shared' ? t('admin.audit.details.modeShared') : '';
    case 'import':
      return t('admin.audit.details.import', {
        file: text(d.file) ?? '—',
        players: count(d.players_created),
        tournaments: count(d.tournaments_created),
        matches: count(d.matches_created),
      });
    case 'currency_change': {
      // «Валюта программы: рубли → евро, курс 1 € = 95,12 ₽» (курс задан для пары rate_base)
      if (!isCurrency(d.from) || !isCurrency(d.to) || !isCurrency(d.rate_base) || typeof d.rate !== 'string') return '';
      const quote = d.rate_base === d.from ? d.to : d.from;
      return t('admin.audit.details.currency', {
        from: t(`admin.settings.currency.lower.${d.from}`),
        to: t(`admin.settings.currency.lower.${d.to}`),
        base: currencySign(d.rate_base),
        rate: formatRate(d.rate),
        quote: currencySign(quote),
      });
    }
    case 'message':
      return text(d.text) ?? '';
    case 'settings_change': {
      // «Часовой пояс для новых участников: Москва → Хельсинки» ({field, from, to})
      const from = text(d.from);
      const to = text(d.to);
      if (d.field !== 'default_tz' || !from || !to) return '';
      return t('admin.audit.details.defaultTz', { from: timeZoneName(t, from), to: timeZoneName(t, to) });
    }
    default:
      // confirm_failed, player_merge, player_edit (этап 2) и agent_config_change пока без
      // строки подробностей
      return '';
  }
}
