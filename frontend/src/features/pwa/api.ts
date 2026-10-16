import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import type { components } from '../../api/schema';
import { notificationPrefsKey, useNotificationPrefs } from '../notifications/prefs';
import { currentPlatform, isStandalone } from './platform';
import {
  askPermission,
  detectDevicePush,
  subscribeBrowser,
  subscriptionBody,
  unsubscribeBrowser,
  type PermissionResult,
  type PushState,
} from './push';
import { revokeThisDevice } from './revoke';

/*
 * Push на сервере (Р26): ключ VAPID (GET /me/push-config), подписки устройств
 * (GET/POST /me/push-subscriptions, DELETE /{id}, POST /revoke), тестовый push (POST /test).
 * Настройки по видам и тихие часы — в notification-prefs (features/notifications/prefs.ts).
 */

export type PushSubscriptionOut = components['schemas']['PushSubscriptionOut'];

export const pushKeys = {
  config: ['push-config'] as const,
  subscriptions: ['push-subscriptions'] as const,
  device: ['push-device'] as const,
};

export function usePushConfig() {
  return useQuery({
    queryKey: pushKeys.config,
    queryFn: () => unwrap(api.GET('/api/me/push-config')),
    // ключи VAPID меняются только перезапуском сервера
    staleTime: Infinity,
  });
}

export function usePushSubscriptions() {
  return useQuery({
    queryKey: pushKeys.subscriptions,
    queryFn: () => unwrap(api.GET('/api/me/push-subscriptions')),
  });
}

/** Состояние браузера: перепроверяется при возврате на вкладку (разрешение могли дать в настройках). */
function useDevicePush(vapidKey: string | null | undefined) {
  return useQuery({
    queryKey: [...pushKeys.device, vapidKey ?? null],
    queryFn: () => detectDevicePush(currentPlatform(), isStandalone(), vapidKey ?? null),
    enabled: vapidKey !== undefined,
    staleTime: 0,
    refetchOnWindowFocus: 'always',
    retry: false,
  });
}

export interface PushChannel {
  state: PushState;
  /** Хэш подписки этого браузера (endpoint_hash) — «это устройство» в списке. */
  hash: string | null;
  vapidKey: string | null;
  /** Хотя бы одно устройство с push у аккаунта (столбец «Push» и тихие часы, В5). */
  available: boolean;
  /** Ошибка запроса ключа или списка — показать «Повторить». */
  error: unknown;
  retry: () => void;
}

/**
 * Push на этом устройстве для экрана: браузер + сервер. «Включен» — только если сервер знает
 * подписку браузера (ее могли отключить с другого устройства или сервер отозвал ее после
 * 404/410): иначе «не включен», и «Включить push» создаст новую.
 */
export function usePushChannel(): PushChannel {
  const config = usePushConfig();
  const list = usePushSubscriptions();
  const prefs = useNotificationPrefs();
  const vapidKey = config.data ? config.data.vapid_public_key : undefined;
  const device = useDevicePush(vapidKey);
  const items = list.data?.items;
  const local = device.data?.local ?? null;
  let state: PushState = 'checking';
  if (device.data) {
    state = device.data.state;
    if (state === 'on' && !items) state = 'checking';
    else if (state === 'on' && !items?.some((item) => item.endpoint_hash === local?.hash)) state = 'off';
  } else if (config.isError) {
    state = 'off';
  }
  return {
    state,
    hash: local?.hash ?? null,
    vapidKey: vapidKey ?? null,
    available: prefs.data?.push_available ?? Boolean(items?.length),
    error: config.error ?? list.error,
    retry: () => {
      void config.refetch();
      void list.refetch();
      void device.refetch();
    },
  };
}

function invalidatePush(client: QueryClient) {
  void client.invalidateQueries({ queryKey: pushKeys.device });
  void client.invalidateQueries({ queryKey: pushKeys.subscriptions });
  // push_available в настройках «что присылать» (столбец «Push» и тихие часы)
  void client.invalidateQueries({ queryKey: notificationPrefsKey });
}

/**
 * «Включить push»: окно разрешения браузера → подписка → POST /me/push-subscriptions.
 * Результат — что ответил человек: granted (включено), denied (запретил), dismissed (закрыл окно).
 */
export function useEnablePush() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { vapidKey: string; known: readonly string[] }): Promise<PermissionResult> => {
      const answer = await askPermission();
      if (answer !== 'granted') return answer;
      const subscription = await subscribeBrowser(vars.vapidKey, new Set(vars.known));
      await unwrap(api.POST('/api/me/push-subscriptions', { body: subscriptionBody(subscription) }));
      return answer;
    },
    networkMode: 'always',
    onSettled: () => invalidatePush(client),
  });
}

/** «Выключить» на этом устройстве. */
export function useDisablePush() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: revokeThisDevice,
    networkMode: 'always',
    onSettled: () => invalidatePush(client),
  });
}

/** «Отключить» устройство из списка; если это устройство — браузер тоже отписывается. */
export function useDisconnectDevice() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: number; current: boolean }) => {
      await unwrap(api.DELETE('/api/me/push-subscriptions/{subscription_id}', { params: { path: { subscription_id: vars.id } } }));
      if (vars.current) await unsubscribeBrowser();
    },
    networkMode: 'always',
    onSettled: () => invalidatePush(client),
  });
}

/** «Прислать тестовое»: сервер шлет push на все устройства аккаунта, ответ — сколько. */
export function useTestPush() {
  return useMutation({
    mutationFn: () => unwrap(api.POST('/api/me/push-subscriptions/test')),
    networkMode: 'always',
  });
}
