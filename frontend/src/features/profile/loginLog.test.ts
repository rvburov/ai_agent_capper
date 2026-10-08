import { afterEach, describe, expect, it } from 'vitest';

import { dismissSuspicious, findSuspicious, isSuspiciousDismissed, lastSuccessfulLogin } from './loginLog';
import type { LoginEvent } from './types';

const NOW = Date.parse('2026-10-08T12:00:00Z');

function event(at: string, result: LoginEvent['result'], extra: Partial<LoginEvent> = {}): LoginEvent {
  return { at, result, ip: '10.0.0.1', device_label: 'Chrome · Windows', method: 'totp', ...extra };
}

afterEach(() => window.localStorage.clear());

describe('журнал входов', () => {
  it('последний успешный вход', () => {
    const events = [event('2026-10-08T10:00:00Z', 'bad_password'), event('2026-10-07T10:00:00Z', 'ok')];
    expect(lastSuccessfulLogin(events)?.at).toBe('2026-10-07T10:00:00Z');
    expect(lastSuccessfulLogin([])).toBeNull();
  });

  it('верный пароль, но 2FA не пройдена — подозрительно', () => {
    const stranger = event('2026-10-04T03:17:00Z', 'bad_totp', { ip: '185.220.1.2', device_label: 'Firefox · Windows' });
    const events = [event('2026-10-06T10:00:00Z', 'ok'), stranger, event('2026-10-01T10:00:00Z', 'ok')];
    expect(findSuspicious(events, NOW)).toBe(stranger);
  });

  it('своя опечатка в коде (успешный вход следом) и неверный пароль — не подозрительно', () => {
    const events = [
      event('2026-10-08T10:02:00Z', 'ok'),
      event('2026-10-08T10:01:00Z', 'bad_totp'),
      event('2026-10-07T10:00:00Z', 'bad_password', { ip: '185.220.1.2' }),
    ];
    expect(findSuspicious(events, NOW)).toBeNull();
  });

  it('старше 30 дней — не показываем', () => {
    expect(findSuspicious([event('2026-09-01T10:00:00Z', 'bad_recovery')], NOW)).toBeNull();
  });

  it('«Это был я» скрывает это предупреждение, но не следующее', () => {
    const first = event('2026-10-04T03:17:00Z', 'bad_totp');
    const later = event('2026-10-05T03:17:00Z', 'bad_totp');
    expect(isSuspiciousDismissed(7, first)).toBe(false);
    dismissSuspicious(7, first);
    expect(isSuspiciousDismissed(7, first)).toBe(true);
    expect(isSuspiciousDismissed(8, first)).toBe(false);
    expect(isSuspiciousDismissed(7, later)).toBe(false);
  });
});
