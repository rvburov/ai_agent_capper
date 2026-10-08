import i18n from '../i18n';
import type { components } from './schema';

export type ErrorDetail = components['schemas']['ErrorDetail'];
export type ErrorField = components['schemas']['ErrorField'];

/**
 * Ошибка API в одном виде для всего интерфейса. Сервер отвечает
 * {"error": {"code": "auth.invalid_credentials", "message": "...", ...}}; message уже на языке
 * пользователя, его и показываем. Нет связи или ответ не того вида — свой текст из ru.json.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.detail = detail;
  }

  /** Через сколько секунд можно повторить (429 и пауза входа). */
  get retryAfter(): number | null {
    const value = this.detail.retry_after;
    return typeof value === 'number' ? value : null;
  }

  /** Поля с ошибкой проверки (code = validation). */
  get fields(): ErrorField[] {
    const value = this.detail.fields;
    return Array.isArray(value) ? (value as ErrorField[]) : [];
  }
}

export const NETWORK_ERROR = 'network';
export const UNKNOWN_ERROR = 'unknown';

function isErrorBody(body: unknown): body is { error: ErrorDetail } {
  if (typeof body !== 'object' || body === null || !('error' in body)) return false;
  const error = (body as { error: unknown }).error;
  return (
    typeof error === 'object' &&
    error !== null &&
    typeof (error as { code?: unknown }).code === 'string' &&
    typeof (error as { message?: unknown }).message === 'string'
  );
}

/** Ошибка из ответа сервера: тело уже разобрано (JSON или текст). */
export function apiErrorFrom(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    const { code, message, ...detail } = body.error;
    return new ApiError(status, code, message, detail);
  }
  // Не наш формат: страница ошибки прокси (502/503/504) или сбой без тела
  const message = status >= 502 && status <= 504 ? i18n.t('errors.unavailable') : i18n.t('errors.unknown');
  return new ApiError(status, UNKNOWN_ERROR, message);
}

/** Запрос не дошел до сервера: нет сети, сервер не отвечает. */
export function networkError(cause?: unknown): ApiError {
  const error = new ApiError(0, NETWORK_ERROR, i18n.t('errors.network'));
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** Нет сеанса или он истек: нужно войти заново. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** Текст ошибки для показа пользователю. */
export function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : i18n.t('errors.unknown');
}
