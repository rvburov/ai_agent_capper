import type { components } from '../../api/schema';

// Типы кабинета администратора — из схемы OpenAPI (npm run gen:api), руками не дублируются.
export type AdminUser = components['schemas']['AdminUserOut'];
export type AdminUserDetail = components['schemas']['AdminUserDetailOut'];
export type UserLimit = components['schemas']['LimitOut'];
export type Invite = components['schemas']['InviteOut'];
export type InviteRequest = components['schemas']['InviteIn'];
export type InviteCreated = components['schemas']['InviteCreatedOut'];
export type InviteLimit = components['schemas']['InviteLimit'];
export type ResetCode = components['schemas']['ResetCodeOut'];
export type ResetCodeCreated = components['schemas']['ResetCodeCreatedOut'];
export type AuditEntry = components['schemas']['AuditOut'];
export type AuditAction = AuditEntry['action'];
export type Role = AdminUser['role'];
export type AiMode = AdminUser['ai_mode'];
// «Ключ и бюджет» (этап 3)
export type AdminKey = components['schemas']['AdminKeyOut'];
export type AdminBudget = components['schemas']['AdminBudgetOut'];
export type AdminLimits = components['schemas']['AdminLimitsOut'];
export type LimitDefaults = components['schemas']['LimitDefaultsOut'];
export type MemberLimit = components['schemas']['MemberLimitOut'];
export type LimitPatch = components['schemas']['LimitPatchIn'];
export type LimitRequest = components['schemas']['LimitIn'];
export type AlertPct = components['schemas']['BudgetIn']['alert_pct'];
