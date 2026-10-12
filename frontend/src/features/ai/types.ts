import type { components } from '../../api/schema';

// Типы ключа Claude и лимита участника — из схемы OpenAPI (npm run gen:api), руками не дублируются.
export type AiBudget = components['schemas']['AiBudgetOut'];
export type AdminBudget = components['schemas']['AdminBudgetOut'];
export type OwnKey = components['schemas']['OwnKeyOut'];
export type OwnKeyInfo = components['schemas']['OwnKeyInfoOut'];
export type KeyModel = components['schemas']['KeyModelOut'];
export type AiMode = AiBudget['mode'];
