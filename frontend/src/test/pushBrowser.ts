import { onTestFinished, vi } from 'vitest';

/*
 * Подмена браузера для push (в jsdom нет service worker, PushManager и Notification):
 * разрешение, подписка, ответ на окно разрешения, User-Agent и «открыто как приложение».
 * Все подмены снимаются после теста.
 */

export const PIXEL_UA =
  'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';
export const IPHONE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
export const MAC_CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export interface PushBrowserOptions {
  /** Есть ли у браузера service worker, PushManager и Notification. */
  supported?: boolean;
  permission?: NotificationPermission;
  /** Что ответит человек в окне разрешения. */
  answer?: NotificationPermission;
  /** Подписка уже есть: ее endpoint. */
  endpoint?: string | null;
  /** Ключ сервера, с которым создана уже имеющаяся подписка (null — браузер его не сообщает). */
  subscriptionKey?: Uint8Array | null;
  /** endpoint новой подписки после subscribe(). */
  newEndpoint?: string;
  userAgent?: string;
  /** Открыто с экрана «Домой» (navigator.standalone на iPhone). */
  standalone?: boolean;
}

export interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => { endpoint: string; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

export interface PushBrowser {
  /** Текущая подписка браузера (null — нет). */
  subscription: () => FakeSubscription | null;
  permission: () => NotificationPermission;
  setPermission: (value: NotificationPermission) => void;
  subscribe: ReturnType<typeof vi.fn>;
  requestPermission: ReturnType<typeof vi.fn>;
}

function define(target: object, key: string, value: unknown): void {
  const own = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, writable: true, value });
  onTestFinished(() => {
    if (own) Object.defineProperty(target, key, own);
    else delete (target as Record<string, unknown>)[key];
  });
}

export function stubPushBrowser(options: PushBrowserOptions = {}): PushBrowser {
  const { supported = true, answer = 'granted', newEndpoint = 'https://push.example/sub/new', userAgent = PIXEL_UA, standalone = false } = options;
  let permission: NotificationPermission = options.permission ?? 'default';
  let current: FakeSubscription | null = null;

  const makeSubscription = (endpoint: string, key: Uint8Array | null = null): FakeSubscription => {
    const sub: FakeSubscription = {
      endpoint,
      options: { applicationServerKey: key ? (key.slice().buffer as ArrayBuffer) : null },
      toJSON: () => ({ endpoint, keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' } }),
      unsubscribe: async () => {
        if (current === sub) current = null;
        return true;
      },
    };
    return sub;
  };
  if (options.endpoint) current = makeSubscription(options.endpoint, options.subscriptionKey ?? null);

  define(navigator, 'userAgent', userAgent);
  define(navigator, 'standalone', standalone);

  const requestPermission = vi.fn(async () => {
    permission = answer;
    return answer;
  });
  const subscribe = vi.fn(async (opts?: { applicationServerKey?: Uint8Array }) => {
    current = makeSubscription(newEndpoint, opts?.applicationServerKey ?? null);
    return current;
  });

  if (supported) {
    const registration = {
      pushManager: {
        getSubscription: async () => current,
        subscribe,
      },
    };
    define(navigator, 'serviceWorker', {
      getRegistration: async () => registration,
      register: async () => registration,
      ready: Promise.resolve(registration),
    });
    vi.stubGlobal('PushManager', class PushManager {});
    vi.stubGlobal(
      'Notification',
      class Notification {
        static get permission() {
          return permission;
        }
        static requestPermission = requestPermission;
      },
    );
  }

  return {
    subscription: () => current,
    permission: () => permission,
    setPermission: (value) => {
      permission = value;
    },
    subscribe,
    requestPermission,
  };
}

/** Хэш endpoint, как endpoint_hash сервера: первые 16 hex sha256. */
export async function hashOf(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}
