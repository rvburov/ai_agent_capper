import { describe, expect, it } from 'vitest';

import i18n from '../../i18n';
import { deviceLabel, detectBrowser, detectOs, platformOf } from './platform';
import { endpointHash, vapidKeyBytes } from './push';
import { VAPID_KEY } from './testData';

// Это устройство по User-Agent, хэш подписки как у сервера, ключ VAPID для подписки.

const UA = {
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadAsMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  pixel: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36',
  samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0',
  yandex: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 YaBrowser/25.8.0.0 Safari/537.36',
  iosChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1',
};

describe('это устройство', () => {
  it('система и браузер по User-Agent', () => {
    expect([detectOs(UA.iphone), detectBrowser(UA.iphone)]).toEqual(['iphone', 'safari']);
    expect([detectOs(UA.pixel), detectBrowser(UA.pixel)]).toEqual(['android', 'chrome']);
    expect([detectOs(UA.samsung), detectBrowser(UA.samsung)]).toEqual(['android', 'samsung']);
    expect([detectOs(UA.edge), detectBrowser(UA.edge)]).toEqual(['windows', 'edge']);
    expect([detectOs(UA.firefox), detectBrowser(UA.firefox)]).toEqual(['linux', 'firefox']);
    expect(detectBrowser(UA.yandex)).toBe('yandex');
    expect(detectBrowser(UA.iosChrome)).toBe('chrome');
    expect(detectOs('')).toBe('other');
    expect(detectBrowser('')).toBe('other');
  });

  it('iPad называет себя Mac, но у него сенсорный экран: инструкция — как на iPhone', () => {
    expect(platformOf(UA.ipadAsMac, 0)).toMatchObject({ os: 'mac', ios: false, install: 'desktop' });
    expect(platformOf(UA.ipadAsMac, 5)).toMatchObject({ os: 'ipad', ios: true, mobile: true, install: 'ios' });
    expect(platformOf(UA.pixel)).toMatchObject({ install: 'android', mobile: true });
  });

  it('подпись: «Android · Chrome», с экрана «Домой» на iPhone — «приложение AI Capper»', () => {
    expect(deviceLabel(i18n.t, platformOf(UA.pixel), false)).toBe('Android · Chrome');
    expect(deviceLabel(i18n.t, platformOf(UA.iphone), true)).toBe('iPhone · приложение AI Capper');
    expect(deviceLabel(i18n.t, platformOf(''), false)).toBe('Устройство · браузер');
  });
});

describe('подписка push', () => {
  it('хэш endpoint — первые 16 hex sha256, как endpoint_hash сервера', async () => {
    expect(await endpointHash('https://push.example/sub/1')).toMatch(/^[0-9a-f]{16}$/);
    expect(await endpointHash('abc')).toBe('ba7816bf8f01cfea');
  });

  it('ключ VAPID (base64url без «=») → 65 байт несжатой точки P-256', () => {
    const bytes = vapidKeyBytes(VAPID_KEY);
    expect(bytes).toHaveLength(65);
    expect(bytes[0]).toBe(4);
  });
});
