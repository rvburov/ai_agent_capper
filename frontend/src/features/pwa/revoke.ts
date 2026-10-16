import { api, unwrap } from '../../api/client';
import { localSubscription, unsubscribeBrowser } from './push';

/*
 * Отзыв push этого браузера: «Выключить» в «Каналах» и выход из аккаунта (В4). Отдельно от
 * хуков экрана: выход живет в оболочке приложения, ему не нужен весь модуль push.
 */

/** Отозвать подписку этого браузера на сервере (по endpoint) и отписать браузер. */
export async function revokeThisDevice(): Promise<void> {
  const subscription = await localSubscription();
  if (!subscription) return;
  await unwrap(api.POST('/api/me/push-subscriptions/revoke', { body: { endpoint: subscription.endpoint } }));
  await subscription.unsubscribe().catch(() => false);
}

// Выход не ждет отзыва дольше этого: нет связи — выходим все равно
const LOGOUT_REVOKE_MS = 3000;

/**
 * Перед выходом из аккаунта: отозвать push этого устройства и отписать браузер, чтобы push
 * прежнего аккаунта сюда больше не приходили. Сервер не ответил — браузер все равно
 * отписывается: сервис push ответит серверу 404/410, и тот отзовет подписку сам.
 */
export async function revokePushBeforeLogout(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const done = await Promise.race([
      revokeThisDevice().then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), LOGOUT_REVOKE_MS);
      }),
    ]);
    if (!done) await unsubscribeBrowser();
  } catch {
    await unsubscribeBrowser();
  } finally {
    clearTimeout(timer);
  }
}
