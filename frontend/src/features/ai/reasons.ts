import type ru from '../../i18n/locales/ru.json';
import i18n from '../../i18n';

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

/** Текст причины по коду «ai.paused»; неизвестный код — общий текст ошибки. */
export function aiErrorText(code: string, params: Record<string, unknown> = {}): string {
  const key = aiKey(code);
  return key ? translate(`errors.ai.${key}`, params) : i18n.t('errors.unknown');
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
