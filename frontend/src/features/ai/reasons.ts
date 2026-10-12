import type ru from '../../i18n/locales/ru.json';
import i18n from '../../i18n';
import { formatNumber } from '../../lib/format';

/*
 * Коды ИИ из ответов API (reason_code в /api/ai/budget, last_error своего ключа) — тексты по
 * ключу errors.ai.<код> в ru.json, те же, что errors.ai.* на сервере (backend/app/locales/ru.json).
 * Ошибки запросов (ApiError) приходят уже с текстом сервера и показываются через errorMessage.
 */
export type AiErrorKey = keyof (typeof ru)['errors']['ai'];

function aiKey(code: string): AiErrorKey | null {
  const key = code.startsWith('ai.') ? code.slice(3) : code;
  return /^[a-z_]+$/.test(key) && i18n.exists(`errors.ai.${key}`) ? (key as AiErrorKey) : null;
}

// Параметры приходят из API словарем (cap, daily, limit...): у каждого кода свои, поэтому ключ
// проверен выше (aiKey), а подстановка — без проверки имен переменных при сборке
const translate = i18n.t.bind(i18n) as (key: string, options?: Record<string, unknown>) => string;

// Лимиты и потолки в текстах причин — как в макете и рядом в карточках: целые без центов
// ($1, $10), иначе с центами ($1,50). Сервер присылает их строкой «1,00».
const LIMIT_PARAMS: Readonly<Record<string, readonly string[]>> = {
  monthly_limit: ['limit'],
  analysis_cap: ['cap'],
  own_cap: ['cap'],
  cap_above_month: ['cap', 'limit'],
};

function limitNumber(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const n = Number(String(value).replace(/\s/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  return formatNumber(n, Number.isInteger(n) ? 0 : 2);
}

/** Параметры текста errors.ai.<код>: суммы лимитов — без лишних «,00». */
export function aiParams(code: string, params: Record<string, unknown>): Record<string, unknown> {
  const names = LIMIT_PARAMS[code.replace(/^(errors\.)?ai\./, '')];
  if (!names) return params;
  const out = { ...params };
  for (const name of names) {
    const text = limitNumber(params[name]);
    if (text !== null) out[name] = text;
  }
  return out;
}

/** Текст причины по коду «ai.paused»; неизвестный код — общий текст ошибки. */
export function aiErrorText(code: string, params: Record<string, unknown> = {}): string {
  const key = aiKey(code);
  return key ? translate(`errors.ai.${key}`, aiParams(key, params)) : i18n.t('errors.unknown');
}

// Причины, которые администратор устраняет сам в «Администрирование → Ключ и бюджет»: ему —
// что сделать и ссылка туда, а не «напишите администратору» (участнику текст с сервера)
const ADMIN_FIXES: Readonly<Record<string, 'errors.aiAdmin.no_admin_key' | 'errors.aiAdmin.budget_exhausted'>> = {
  'ai.no_admin_key': 'errors.aiAdmin.no_admin_key',
  'ai.budget_exhausted': 'errors.aiAdmin.budget_exhausted',
};

/** Причину устраняет сам администратор в «Ключ и бюджет»: показать ссылку туда. */
export function adminFixes(code: string | null | undefined, isAdmin: boolean): boolean {
  return isAdmin && typeof code === 'string' && Object.hasOwn(ADMIN_FIXES, code);
}

/** Текст для администратора по коду причины; null — у кода нет отдельного текста. */
export function adminReasonText(code: string | null | undefined, isAdmin: boolean): string | null {
  if (!adminFixes(code, isAdmin)) return null;
  return i18n.t(ADMIN_FIXES[code as string] as 'errors.aiAdmin.no_admin_key');
}

/** Текст причины по коду для того, кто смотрит: администратору — что сделать самому. */
export function aiReasonText(code: string, params: Record<string, unknown> = {}, isAdmin = false): string {
  return adminReasonText(code, isAdmin) ?? aiErrorText(code, params);
}

/**
 * Последняя ошибка своего ключа (user_secrets.last_error): «rejected:401» и «error:500» — итог
 * проверки, «models:a,b» — ключу недоступны модели, «ai.billing» — сбой на настоящем вызове.
 */
export function keyErrorText(lastError: string | null | undefined): string | null {
  if (!lastError) return null;
  const [kind, rest = ''] = lastError.split(/:(.*)/s);
  switch (kind) {
    case 'rejected':
      return aiErrorText('ai.key_rejected');
    case 'models':
      return aiErrorText('ai.key_models', { models: rest.split(',').join(', ') });
    case 'unavailable':
      return aiErrorText('ai.key_unavailable');
    case 'error':
      return aiErrorText('ai.key_check_failed', { status: rest });
    default:
      return aiErrorText(lastError);
  }
}
