import type { PushSubscriptionOut } from './api';

/** Ключ VAPID сервера (base64url, 65 байт, как у настоящего). */
export const VAPID_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';

/** Устройство с push (GET /me/push-subscriptions). */
export function pushSubscriptionOut(over: Partial<PushSubscriptionOut> = {}): PushSubscriptionOut {
  return {
    id: 1,
    device: 'Android · Chrome',
    created_at: '2026-10-15T08:00:00Z',
    last_sent_at: null,
    endpoint_hash: '0000000000000000',
    ...over,
  };
}
