import type { Platform } from './platform';

/*
 * Push на этом устройстве (Р26, В4–В6): что умеет браузер, есть ли разрешение и подписка, как
 * включить и выключить. Только работа с браузером (Notification, service worker, PushManager);
 * запросы к серверу — в api.ts. Подписка браузера — одна на сайт; сервер хранит ее строкой
 * push_subscriptions, а «это устройство» в списке узнается по хэшу endpoint (endpoint_hash):
 * сам endpoint сервер не отдает.
 */

/**
 * Состояние push на этом устройстве (карточка «Каналы»):
 * - checking — еще проверяем;
 * - off — можно включить;
 * - on — включен: разрешение есть, подписка браузера есть и сервер ее знает;
 * - denied — уведомления для сайта запрещены в браузере, сайт сам спросить не может;
 * - ios — iPhone или iPad, сайт открыт в браузере, а не с экрана «Домой»;
 * - unsupported — браузер не умеет push;
 * - server — на сервере нет ключей VAPID (vapid_public_key: null).
 */
export type PushState = 'checking' | 'off' | 'on' | 'denied' | 'ios' | 'unsupported' | 'server';

/** Подписка браузера на этом устройстве: endpoint и его хэш, как endpoint_hash сервера. */
export interface LocalPush {
  endpoint: string;
  hash: string;
}

/** Что известно о push на устройстве без сервера: состояние браузера и его подписка. */
export interface DevicePush {
  state: Exclude<PushState, 'checking'>;
  local: LocalPush | null;
}

/** Браузер умеет push: service worker, PushManager и уведомления, сайт по HTTPS (или localhost). */
export function browserSupportsPush(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext !== false &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Первые 16 hex sha256(endpoint) — так же считает сервер (endpoint_hash). */
export async function endpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);
}

/** Ключ VAPID сервера (base64url) → байты для pushManager.subscribe. */
export function vapidKeyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = (key + '='.repeat((4 - (key.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function sameBytes(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return true; // браузер не сообщает ключ подписки — считаем, что тот же
  const left = new Uint8Array(a);
  return left.length === b.length && left.every((byte, i) => byte === b[i]);
}

/** Регистрация service worker этой страницы, если она есть (в разработке ее нет). */
async function currentRegistration(): Promise<ServiceWorkerRegistration | null> {
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

/** Подписка браузера, если она есть. */
export async function localSubscription(): Promise<PushSubscription | null> {
  if (!browserSupportsPush()) return null;
  const registration = await currentRegistration();
  if (!registration) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Состояние push на устройстве по браузеру: iPhone вне приложения с экрана «Домой», нет
 * поддержки, нет ключей на сервере, запрет, есть подписка с ключом сервера или нет. Знает ли
 * сервер подписку, решает вызывающий (список GET /me/push-subscriptions).
 */
export async function detectDevicePush(platform: Platform, standalone: boolean, vapidKey: string | null): Promise<DevicePush> {
  if (platform.ios && !standalone) return { state: 'ios', local: null };
  if (!browserSupportsPush()) return { state: 'unsupported', local: null };
  if (vapidKey === null) return { state: 'server', local: null };
  if (Notification.permission === 'denied') return { state: 'denied', local: null };
  const subscription = await localSubscription();
  if (!subscription || Notification.permission !== 'granted') return { state: 'off', local: null };
  // Ключи VAPID на сервере сменили: старая подписка не работает (сервис push ответит 401/403),
  // хотя сервер ее еще помнит. «Не включен» — «Включить push» пересоздаст подписку
  if (!sameBytes(subscription.options.applicationServerKey, vapidKeyBytes(vapidKey))) return { state: 'off', local: null };
  return { state: 'on', local: { endpoint: subscription.endpoint, hash: await endpointHash(subscription.endpoint) } };
}

/** Service worker не стал активным за это время — push включить не выйдет (ошибка, а не вечное ожидание). */
const READY_TIMEOUT_MS = 10_000;

export class PushSetupError extends Error {
  constructor(readonly reason: 'no-worker' | 'subscribe') {
    super(reason);
    this.name = 'PushSetupError';
  }
}

/** Активный service worker: зарегистрированный при загрузке приложения, иначе регистрируем сейчас. */
async function readyRegistration(): Promise<ServiceWorkerRegistration> {
  if (!(await currentRegistration())) {
    try {
      await navigator.serviceWorker.register('/sw.js');
    } catch {
      throw new PushSetupError('no-worker');
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PushSetupError('no-worker')), READY_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Тело POST /me/push-subscriptions из подписки браузера. */
export interface SubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function subscriptionBody(subscription: PushSubscription): SubscriptionBody {
  const json = subscription.toJSON();
  return { endpoint: subscription.endpoint, keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' } };
}

export type PermissionResult = 'granted' | 'denied' | 'dismissed';

/** Спросить разрешение (окно браузера); уже разрешено — сразу granted. Окно закрыли — dismissed. */
export async function askPermission(): Promise<PermissionResult> {
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  const answer = await Notification.requestPermission();
  return answer === 'granted' ? 'granted' : answer === 'denied' ? 'denied' : 'dismissed';
}

/**
 * Подписка браузера для сервера с ключом vapidKey. Старая подписка остается, только если ее
 * знает сервер (known — хэши его списка) и у нее тот же ключ: иначе она отписывается и
 * создается новая (ключи VAPID сменили или сервер отозвал подписку после ответа 404/410).
 */
export async function subscribeBrowser(vapidKey: string, known: ReadonlySet<string>): Promise<PushSubscription> {
  const registration = await readyRegistration();
  const key = vapidKeyBytes(vapidKey);
  let subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    const keep = known.has(await endpointHash(subscription.endpoint)) && sameBytes(subscription.options.applicationServerKey, key);
    if (!keep) {
      await subscription.unsubscribe().catch(() => false);
      subscription = null;
    }
  }
  if (subscription) return subscription;
  try {
    return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    throw new PushSetupError('subscribe');
  }
}

/** Отписать браузер (после отзыва на сервере). Ошибку отписки не показываем: сервер уже не шлет. */
export async function unsubscribeBrowser(): Promise<void> {
  const subscription = await localSubscription();
  await subscription?.unsubscribe().catch(() => false);
}
