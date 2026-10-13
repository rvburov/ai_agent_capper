import { oddForApi, oddInputText, oddNumber, validOdd } from '../analysis/draft';
import { toMilli } from './money';
import type { Closing, ClosingBy, ClosingIn } from './types';

/*
 * Поля закрывающего кэфа ноги (В1): чей кэф (эталон по Р17 или свой букмекер), кэф на свой
 * исход — обязательно, на обратный — по желанию (тогда есть CLV без маржи). Здесь — разбор
 * полей и что отправить серверу: поле closing не передается, если ничего не менялось.
 */

export const CLOSING_BY: readonly ClosingBy[] = ['pinnacle', 'betfair_ex', 'avg', 'bookmaker'];

export interface ClosingDraft {
  by: ClosingBy;
  /** Свой букмекер, если закрытие было внесено по другому букмекеру, чем у ставки. */
  bookmaker: string | null;
  own: string;
  opp: string;
}

export function closingDraft(closing: Closing | null): ClosingDraft {
  return {
    by: closing?.by ?? 'pinnacle',
    bookmaker: closing?.by === 'bookmaker' ? closing.bookmaker : null,
    own: closing ? oddInputText(Number(closing.odds)) : '',
    opp: closing?.opp_odds ? oddInputText(Number(closing.opp_odds)) : '',
  };
}

export type ClosingCheck =
  | { kind: 'empty' }
  /** field — какое поле неверно; typing — пока вводят (меньше 3 знаков), ошибку не показываем. */
  | { kind: 'invalid'; field: 'own' | 'opp'; typing: boolean }
  | { kind: 'ok'; own: number; opp: number | null; value: ClosingIn };

function typing(text: string): boolean {
  return text.trim().length < 3;
}

/** Разбор полей: кэфы 1.01–50, до 3 знаков (как у сервера). */
export function checkClosing(draft: ClosingDraft): ClosingCheck {
  const own = draft.own.trim();
  const opp = draft.opp.trim();
  if (!own && !opp) return { kind: 'empty' };
  if (!validOdd(own)) return { kind: 'invalid', field: 'own', typing: own === '' ? false : typing(own) };
  if (opp && !validOdd(opp)) return { kind: 'invalid', field: 'opp', typing: typing(opp) };
  const value: ClosingIn = {
    odds: oddForApi(own) ?? own,
    opp_odds: opp ? (oddForApi(opp) ?? opp) : null,
    by: draft.by,
    bookmaker: draft.by === 'bookmaker' ? draft.bookmaker : null,
  };
  return { kind: 'ok', own: oddNumber(own), opp: opp ? oddNumber(opp) : null, value };
}

function sameOdds(a: string | number | null | undefined, b: string | number | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  return toMilli(a) === toMilli(b);
}

/**
 * Что отправить в closing ноги: undefined — поле не передавать (закрытие не менялось), null —
 * стереть, объект — записать. Неверные поля — 'invalid' (сохранять нельзя).
 */
export function closingPayload(draft: ClosingDraft, original: Closing | null): ClosingIn | null | undefined | 'invalid' {
  const check = checkClosing(draft);
  if (check.kind === 'invalid') return 'invalid';
  if (check.kind === 'empty') return original ? null : undefined;
  if (!original) return check.value;
  const same =
    sameOdds(check.value.odds, original.odds) &&
    sameOdds(check.value.opp_odds ?? null, original.opp_odds) &&
    check.value.by === original.by &&
    (check.value.by !== 'bookmaker' || (check.value.bookmaker ?? null) === (original.bookmaker ?? null));
  return same ? undefined : check.value;
}
