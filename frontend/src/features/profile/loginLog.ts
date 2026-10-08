import type { ChipKind, IconName } from '../../components';
import { readStored, writeStored } from '../../lib/storage';
import type { LoginEvent, LoginResult } from './types';

/** Результат попытки входа — чип журнала, как в макете: «Успешно», «Неверный пароль». */
export const RESULT_CHIPS: Record<LoginResult, { kind: ChipKind; icon: IconName }> = {
  ok: { kind: 'good', icon: 'check' },
  bad_password: { kind: 'warn', icon: 'alert' },
  bad_totp: { kind: 'bad', icon: 'x' },
  bad_recovery: { kind: 'bad', icon: 'x' },
  rate_limited: { kind: 'serious', icon: 'clock' },
  blocked: { kind: 'bad', icon: 'ban' },
};

export function isFailed(event: LoginEvent): boolean {
  return event.result !== 'ok';
}

/** Последний успешный вход (журнал отсортирован: новые сверху). */
export function lastSuccessfulLogin(events: readonly LoginEvent[]): LoginEvent | null {
  return events.find((event) => event.result === 'ok') ?? null;
}

// Пароль был верный, а 2FA не пройдена: кто-то знает пароль
const PASSWORD_KNOWN: ReadonlySet<LoginResult> = new Set(['bad_totp', 'bad_recovery']);
const SUSPICIOUS_DAYS = 30;
// Ошибся сам: в течение 15 минут с того же адреса и устройства был успешный вход
const OWN_RETRY_MS = 15 * 60_000;

/**
 * Подозрительный вход для предупреждения в журнале (как в макете): за 30 дней кто-то ввел
 * верный пароль, но не прошел 2FA. Опечатку в коде самого владельца не считаем: за ней
 * в течение 15 минут идет успешный вход с того же адреса и устройства.
 */
export function findSuspicious(
  events: readonly LoginEvent[],
  now: number = Date.now(),
): LoginEvent | null {
  const since = now - SUSPICIOUS_DAYS * 86_400_000;
  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (!event || !PASSWORD_KNOWN.has(event.result)) continue;
    const at = Date.parse(event.at);
    if (!(at > since)) break;
    const retried = events
      .slice(0, i)
      .some(
        (later) =>
          later.result === 'ok' &&
          later.ip === event.ip &&
          later.device_label === event.device_label &&
          Date.parse(later.at) - at <= OWN_RETRY_MS,
      );
    if (!retried) return event;
  }
  return null;
}

// «Это был я»: время последнего просмотренного предупреждения — только в этом браузере
function seenKey(userId: number): string {
  return `capper.profile.suspiciousSeen.${userId}`;
}

export function isSuspiciousDismissed(userId: number, event: LoginEvent): boolean {
  const seen = readStored(seenKey(userId));
  return seen !== null && Date.parse(seen) >= Date.parse(event.at);
}

export function dismissSuspicious(userId: number, event: LoginEvent): void {
  writeStored(seenKey(userId), event.at);
}
