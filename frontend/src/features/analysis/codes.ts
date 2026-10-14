import { isApiError } from '../../api/errors';
import i18n from '../../i18n';
import { adminReasonText, aiParams } from '../ai/reasons';
import { currencySign, formatDate, formatDateTime, formatDayMonth, formatMoney, type Currency } from '../../lib/format';
import { pauseLastDay } from '../bank/pauseDay';

// Тексты по ключам и кодам с сервера (analysis.steps.*, analysis.rules.*, errors.*): сервер
// присылает ключ и параметры, слова — в ru.json фронтенда. Ключа нет — запасной текст.

type Translate = (key: string, options?: Record<string, unknown>) => string;
const translate: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Дата и время внутри фразы: «сегодня, 04:10» (а не «Сегодня, 04:10»). */
export function inlineDateTime(value: string | null | undefined): string {
  const text = formatDateTime(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
}
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Валюта для денежных параметров (валюта программы, Р17). */
export interface TextOptions {
  currency?: Currency | null;
}

const CURRENCIES: ReadonlySet<string> = new Set(['RUB', 'USD', 'EUR']);

// Суммы в параметрах с сервера приходят строкой Decimal («20000.00») — показываем деньгами
// в валюте программы («20 000 ₽»); у ошибки ставки валюта есть в самих параметрах
const MONEY_PARAMS: Readonly<Record<string, readonly string[]>> = {
  'analysis.warnings.bank_differs': ['input', 'ledger'],
  'errors.bet.stake_range': ['bank'],
  'errors.bet.payout_range': ['payout', 'max'],
  'errors.bet.payout_overflow': ['payout', 'max'],
  'errors.bank.withdrawal_range': ['balance'],
  'errors.bank.correction_range': ['balance'],
  // Ответственная игра и «Мои букмекеры» (этап 4): валюта — в параметрах ошибки
  'errors.play.stake_limit': ['limit', 'left'],
  'errors.play.stake_used': ['limit'],
  'errors.bookmaker.open_bets': ['in_play'],
};

// Конец паузы — момент «полночь после последнего дня». Везде (кабинет, шапка, ошибки)
// показываем последний день включительно: «до 21 октября включительно», а не «до 22 окт, 00:00»
const PAUSE_END_PARAMS: ReadonlySet<string> = new Set(['errors.play.paused', 'errors.play.pause_shorter']);

// Код валюты в параметре ошибки — знаком: «теперь €»
const CURRENCY_SIGN_PARAMS: ReadonlySet<string> = new Set(['errors.common.currency_changed', 'errors.admin.currency_same']);

function moneyCurrency(params: Record<string, unknown>, options: TextOptions): Currency | null {
  if (options.currency) return options.currency;
  const own = params.currency;
  return typeof own === 'string' && CURRENCIES.has(own) ? (own as Currency) : null;
}

// Даты в параметрах — в поясе пользователя и в его формате, суммы — деньгами
function shownParams(key: string, params: Record<string, unknown>, options: TextOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const money = MONEY_PARAMS[key] ?? [];
  const currency = money.length ? moneyCurrency(params, options) : null;
  for (const [name, value] of Object.entries(params)) {
    if (name === 'until' && PAUSE_END_PARAMS.has(key) && typeof value === 'string' && ISO_TIME.test(value)) {
      out[name] = formatDayMonth(pauseLastDay(value));
    } else if (name === 'currency' && CURRENCY_SIGN_PARAMS.has(key) && typeof value === 'string' && CURRENCIES.has(value)) {
      out[name] = currencySign(value as Currency);
    } else if (currency && money.includes(name) && (typeof value === 'string' || typeof value === 'number') && Number.isFinite(Number(value))) {
      out[name] = formatMoney(value, currency);
    } else if (typeof value === 'string' && ISO_TIME.test(value)) out[name] = inlineDateTime(value);
    else if (typeof value === 'string' && ISO_DATE.test(value)) out[name] = formatDate(value);
    else if (Array.isArray(value)) out[name] = value.join(', ');
    else out[name] = value;
  }
  return out;
}

export function hasText(key: string | null | undefined): key is string {
  return typeof key === 'string' && key.length > 0 && i18n.exists(key);
}

/** Текст ключа локали с параметрами; ключа нет — fallback. */
export function keyText(
  key: string | null | undefined,
  params: Record<string, unknown> = {},
  fallback = '',
  options: TextOptions = {},
): string {
  return hasText(key) ? translate(key, shownParams(key, params, options)) : fallback;
}

/** Текст кода ошибки (ai.overloaded → errors.ai.overloaded). */
export function codeText(
  code: string | null | undefined,
  params: Record<string, unknown> = {},
  fallback = '',
  options: TextOptions = {},
): string {
  if (!code) return fallback;
  const key = code.startsWith('errors.') ? code : `errors.${code}`;
  return keyText(key, key.startsWith('errors.ai.') ? aiParams(key, params) : params, fallback, options);
}

/** Текст причины запрета для того, кто смотрит: администратору — что сделать самому. */
export function reasonText(
  code: string | null | undefined,
  params: Record<string, unknown> = {},
  { isAdmin = false, fallback = '' }: { isAdmin?: boolean; fallback?: string } = {},
): string {
  return adminReasonText(code, isAdmin) ?? codeText(code, params, fallback);
}

/**
 * Текст ошибки API: по коду из ru.json фронтенда (параметры — из тела ошибки), иначе текст
 * сервера (он уже на языке пользователя) или общий.
 */
export function apiErrorText(error: unknown): string {
  if (!isApiError(error)) return i18n.t('errors.unknown');
  const detail = error.detail as Record<string, unknown>;
  if (error.code === 'common.rate_limited' && error.retryAfter !== null) {
    return i18n.t('new.errors.rateLimited', { minutes: Math.max(1, Math.ceil(error.retryAfter / 60)) });
  }
  return codeText(error.code, detail, error.message);
}
