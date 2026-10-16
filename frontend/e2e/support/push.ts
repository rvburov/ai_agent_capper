import type { BrowserContext } from '@playwright/test';

import { FAKE_PORT } from './fakeClaude';

/*
 * Поддельный сервис push стека (backend/tests/fake_push.py, тот же порт, что у поддельного
 * Claude): «подписка браузера» с настоящими ключами и список push, которые туда отправил сервер
 * (с расшифрованным текстом). Chromium без сети Google настоящую подписку не выдаст, поэтому
 * PushManager.subscribe в странице подменяется (init script) и отдает подписку этого сервиса.
 * Страница сама к сервису не ходит (CSP connect-src 'self'): подписку берет тест.
 */

const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;

export interface FakeSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: null;
}

export interface ReceivedPush {
  device: string;
  status: number;
  body_length: number;
  headers: { ttl: string | null; urgency: string | null; topic: string | null; content_encoding: string | null };
  vapid: boolean;
  aud: string | null;
  payload: { title: string; body: string; url: string; tag: string } | null;
}

/** Новая подписка на поддельном сервисе push (endpoint http://127.0.0.1:ПОРТ/push/<id>). */
export async function fakeSubscription(): Promise<FakeSubscription> {
  const response = await fetch(`${FAKE_URL}/_fake/push/subscription`, { method: 'POST' });
  if (!response.ok) throw new Error(`fake push: ${response.status}`);
  return (await response.json()) as FakeSubscription;
}

export function deviceOf(subscription: FakeSubscription): string {
  return subscription.endpoint.split('/push/')[1] ?? '';
}

/** Push, которые сервер отправил на эту подписку, старые первыми. */
export async function receivedPushes(subscription: FakeSubscription): Promise<ReceivedPush[]> {
  const response = await fetch(`${FAKE_URL}/_fake/push?device=${deviceOf(subscription)}`);
  if (!response.ok) throw new Error(`fake push: ${response.status}`);
  return ((await response.json()) as { items: ReceivedPush[] }).items;
}

/**
 * Браузер контекста «умеет push»: уведомления разрешены, PushManager.subscribe отдает
 * подписку поддельного сервиса, getSubscription — ее же, пока не отписались (метка в
 * localStorage сайта переживает перезагрузку, как настоящая подписка). Headless Chromium
 * отвечает Notification.permission = 'denied' даже после grantPermissions (Permissions API при
 * этом говорит granted), поэтому разрешение тоже подменяется.
 */
export async function stubBrowserPush(context: BrowserContext, origin: string, subscription: FakeSubscription): Promise<void> {
  await context.grantPermissions(['notifications'], { origin });
  await context.addInitScript((sub: FakeSubscription) => {
    const KEY = 'e2e.push.subscribed';
    const make = (): PushSubscription => {
      const fake = {
        endpoint: sub.endpoint,
        expirationTime: null,
        options: { applicationServerKey: null, userVisibleOnly: true },
        getKey: () => null,
        toJSON: () => ({ endpoint: sub.endpoint, expirationTime: null, keys: sub.keys }),
        unsubscribe: async () => {
          window.localStorage.removeItem(KEY);
          return true;
        },
      };
      return fake as unknown as PushSubscription;
    };
    Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
    Notification.requestPermission = async () => 'granted';
    PushManager.prototype.subscribe = async function subscribe() {
      window.localStorage.setItem(KEY, '1');
      return make();
    };
    PushManager.prototype.getSubscription = async function getSubscription() {
      return window.localStorage.getItem(KEY) ? make() : null;
    };
  }, subscription);
}

/** Подписан ли браузер (метка подмены в localStorage). */
export const SUBSCRIBED_KEY = 'e2e.push.subscribed';
