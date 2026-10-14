import type { components } from '../../api/schema';

// Типы банка — из OpenAPI бэкенда (src/api/schema.d.ts).

type Schemas = components['schemas'];

export type Bank = Schemas['BankOut'];
export type Adaptation = Schemas['AdaptationOut'];
export type AdaptationKey = Adaptation['key'];
export type BankEntry = Schemas['BankEntryOut'];
export type BankEntries = Schemas['BankEntriesOut'];
export type BankEntryIn = Schemas['BankEntryIn'];
export type MoveKind = BankEntryIn['kind'];
export type Strategy = Schemas['StrategyOut'];
export type StrategyParams = Schemas['StrategyParamsOut'];

// Ответственная игра (В8)
export type PlayLimits = Schemas['PlayLimitsOut'];
export type PlayLimitsIn = Schemas['PlayLimitsIn'];
export type PlayBlocked = NonNullable<PlayLimits['blocked']>;
