import type { Page } from '@playwright/test';

import { BASE_URL } from '../support/stack';
import { expectScreenLayout } from '../support/layout';
import { deviceOf, fakeSubscription, receivedPushes, stubBrowserPush, SUBSCRIBED_KEY, type FakeSubscription } from '../support/push';
import { expect, registeredMember, signedInAdmin, test, uniqueName, type Device } from '../support/test';
import { heading, signInWithBackupCode, signOut, toast } from '../support/ui';

// Этап 6 «PWA и push» на настоящем API: манифест, значки и service worker; «Нет связи» без сети;
// push участника — включить, тестовый push, настройки, отключить, выход отзывает; сообщение
// администратора уходит push. Push принимает поддельный сервис стека (backend/tests/fake_push.py):
// он проверяет подпись VAPID и расшифровывает текст. Service worker в сценариях выключен
// (playwright.config.ts) — здесь устройства включают его сами.

const THEMES = ['light', 'dark'] as const;

/** Страница под управлением service worker (первая загрузка — еще нет: claim при включении). */
async function controlled(page: Page): Promise<void> {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller)), { timeout: 15_000 }).toBe(true);
}

/** Push на эту подписку, которые дошли до поддельного сервиса (ответ 201), с текстом. */
async function delivered(subscription: FakeSubscription): Promise<string[]> {
  return (await receivedPushes(subscription)).filter((item) => item.status === 201).map((item) => item.payload?.title ?? '');
}

test('манифест, значки и service worker: оболочка в кэше, ответов API в кэше нет', async ({ device, isMobile }) => {
  test.skip(isMobile, 'не зависит от ширины');
  const guest = await device({ serviceWorkers: 'allow' });
  const page = guest.page;

  const manifest = await page.request.get('/manifest.webmanifest');
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()['content-type']).toContain('application/manifest+json');
  const body = (await manifest.json()) as { name: string; short_name: string; display: string; start_url: string; icons: { src: string }[] };
  expect(body).toMatchObject({ name: 'AI Capper — теннисная аналитика', short_name: 'AI Capper', display: 'standalone', start_url: '/' });
  for (const src of [...body.icons.map((icon) => icon.src), '/icons/apple-touch-icon.png', '/icons/badge-96.png']) {
    const icon = await page.request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()['content-type'], src).toBe('image/png');
  }
  const sw = await page.request.get('/sw.js');
  expect(sw.status()).toBe(200);
  expect(sw.headers()['content-type']).toContain('javascript');
  expect(await sw.text()).toMatch(/^self\.__CAPPER_SW__ = \{"version":"[0-9a-f]{12}"/);
  const offline = await page.request.get('/offline.html');
  expect(await offline.text()).toContain('<h1 id="off-title">Нет связи с интернетом</h1>');

  await page.goto('/login');
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href', '/icons/apple-touch-icon.png');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)).toBe(`${BASE_URL}/`);
  // оболочка в кэше: index.html, страница «Нет связи», файлы сборки; ответов /api нет
  const cached = async () =>
    page.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) {
        const cache = await caches.open(name);
        urls.push(...(await cache.keys()).map((request) => new URL(request.url).pathname));
      }
      return urls;
    });
  await expect.poll(cached).toEqual(expect.arrayContaining(['/index.html', '/offline.html', '/manifest.webmanifest']));
  await page.goto('/login');
  await page.request.get('/api/health');
  const urls = await cached();
  expect(urls.some((url) => url.startsWith('/assets/'))).toBe(true);
  expect(urls.filter((url) => url.startsWith('/api'))).toEqual([]);
});

test('без сети — «Нет связи»; связь вернулась — экран ушел сам; без сети после перезагрузки — оболочка из кэша', { tag: '@360' }, async ({ device, apiClient }) => {
  const admin = await device();
  await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName('Без Связи'));
  const m = await device({ serviceWorkers: 'allow' });
  const page = m.page;
  await signInWithBackupCode(page, member);
  await page.reload();
  await expect(heading(page, 'Главная')).toBeVisible();
  await controlled(page);

  await m.context.setOffline(true);
  const offline = page.getByRole('heading', { name: 'Нет связи с интернетом' });
  await expect(offline).toBeVisible();
  for (const scheme of THEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page, { root: page.locator('.off-overlay') });
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // связь вернулась — экран ушел сам, приложение на месте
  await m.context.setOffline(false);
  await expect(offline).toBeHidden();
  await expect(heading(page, 'Главная')).toBeVisible();

  // без сети после перезагрузки: оболочка из кэша service worker, данных нет — «Нет связи»
  await m.context.setOffline(true);
  await page.reload();
  await expect(offline).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(page.getByText('Связи по-прежнему нет. Попробуйте еще раз через минуту')).toBeVisible();
  await m.context.setOffline(false);
  await expect(offline).toBeHidden();
  await expect(heading(page, 'Главная')).toBeVisible();

  // /offline по ссылке из кабинета: «Повторить» со связью — на главную
  await page.goto('/profile');
  await page.getByRole('link', { name: 'Как приложение выглядит без связи' }).click();
  await expect(offline).toBeVisible();
  await page.getByRole('button', { name: 'Повторить' }).click();
  await expect(toast(page, 'Связь восстановлена')).toBeVisible();
  await expect(heading(page, 'Главная')).toBeVisible();
});

/** Участник с push: браузер (service worker и подписка поддельного сервиса) — и его подписка. */
async function pushMember(device: (options?: { serviceWorkers?: 'allow' | 'block' }) => Promise<Device>, signIn: (page: Page) => Promise<void>) {
  const m = await device({ serviceWorkers: 'allow' });
  const subscription = await fakeSubscription();
  await stubBrowserPush(m.context, BASE_URL, subscription);
  await signIn(m.page);
  return { m, subscription };
}

test('push: включить → тестовый push дошел → настройки сохраняются → сообщение администратора push → отключить → выход отзывает', async ({ device, apiClient }) => {
  test.setTimeout(120_000);
  const admin = await device();
  await signedInAdmin(admin);
  const name = uniqueName('Пуш Участник');
  const member = await registeredMember(admin, apiClient, name);
  const { m, subscription } = await pushMember(device, (page) => signInWithBackupCode(page, member));
  const page = m.page;

  // Кабинет → «Уведомления»: push не включен, столбец «Push» неактивен
  await page.goto('/profile/notifications');
  const channels = page.locator('#profile-channels');
  await expect(channels.getByText('Не включен', { exact: true })).toBeVisible();
  const betPush = page.getByRole('switch', { name: /^Push: Ставка рассчитана автоматически/ });
  await expect(betPush).toBeDisabled();
  await channels.getByRole('button', { name: 'Включить push' }).click();
  await expect(toast(page, 'Push включен на этом устройстве')).toBeVisible();
  await expect(channels.getByText('Включено', { exact: true })).toBeVisible();
  const devices = page.locator('#profile-push-devices');
  await expect(devices.getByText('это устройство')).toBeVisible();
  await expect(betPush).toBeEnabled();
  await expectScreenLayout(page);

  // тихие часы по умолчанию выключены (с 18.10.2026): включить и снова выключить —
  // сценарий не должен зависеть от времени суток
  const quiet = page.getByRole('switch', { name: 'Тихие часы' });
  await expect(quiet).not.toBeChecked();
  await quiet.click();
  await expect(toast(page, 'Тихие часы включены')).toBeVisible();
  await quiet.click();
  await expect(toast(page, 'Тихие часы выключены: push круглые сутки')).toBeVisible();

  // тестовый push дошел: подпись VAPID верна, текст расшифрован, без сумм
  await channels.getByRole('button', { name: 'Прислать тестовое' }).click();
  await expect(toast(page, 'Тестовое уведомление отправлено на 1 устройство')).toBeVisible();
  await expect.poll(() => delivered(subscription)).toContain('Проверка: push работает');
  const [first] = await receivedPushes(subscription);
  expect(first).toMatchObject({ vapid: true, aud: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/) as unknown, headers: { content_encoding: 'aes128gcm' } });

  // настройки push сохраняются на сервере: после перезагрузки — те же
  await betPush.click();
  await expect(toast(page, 'Push выключен: ставка рассчитана автоматически')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('switch', { name: 'Push: Ставка рассчитана автоматически' })).not.toBeChecked();
  await expect(page.getByRole('switch', { name: 'Тихие часы' })).not.toBeChecked();
  await expect(channels.getByText('Включено', { exact: true })).toBeVisible();

  // сообщение администратора с «Также push» доходит до телефона участника
  const text = `Проверка push ${uniqueName('Сообщ')}`;
  await sendAdminMessage(admin.page, name, text, 1);
  await expect.poll(() => receivedPushes(subscription).then((items) => items.map((item) => item.payload?.body ?? '')), { timeout: 20_000 }).toContain(text);

  // «Отключить» это устройство в списке: браузер отписан, «Не включен»
  await devices.getByRole('button', { name: /^Отключить push: / }).click();
  await expect(toast(page, /^Push отключен: /)).toBeVisible();
  await expect(channels.getByText('Не включен', { exact: true })).toBeVisible();
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SUBSCRIBED_KEY)).toBeNull();

  // снова включить и выйти: выход отзывает push этого устройства
  await channels.getByRole('button', { name: 'Включить push' }).click();
  await expect(channels.getByText('Включено', { exact: true })).toBeVisible();
  await signOut(page);
  expect(await page.evaluate((key) => window.localStorage.getItem(key), SUBSCRIBED_KEY)).toBeNull();
  const before = (await receivedPushes(subscription)).length;
  await sendAdminMessage(admin.page, name, `После выхода ${uniqueName('Сообщ')}`, 0);
  // воркер успел бы отправить: ждем и проверяем, что на отозванную подписку ничего не ушло
  await page.waitForTimeout(3000);
  expect((await receivedPushes(subscription)).length).toBe(before);
  expect(deviceOf(subscription)).not.toBe('');
});

/** Администратор: «Сообщение» одному участнику с «Также push»; push — сколько получит push. */
async function sendAdminMessage(page: Page, name: string, text: string, push: number): Promise<void> {
  await page.goto('/admin/message');
  await page.getByRole('button', { name: 'Одному' }).click();
  await page.getByRole('button', { name: /^Получатель:/ }).click();
  await page.getByRole('option', { name }).click();
  await page.getByRole('textbox', { name: /^Текст/ }).fill(text);
  await expect(page.getByRole('checkbox', { name: /Также push/ })).toBeChecked();
  await expect(
    page.getByText(push ? 'У получателя push включен — придет и на телефон.' : 'У получателя push не включен — придет только на сайт.'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await expect(toast(page, push ? `Отправлено 1 участнику: на сайте, push — ${push}` : 'Отправлено 1 участнику: на сайте')).toBeVisible();
}
