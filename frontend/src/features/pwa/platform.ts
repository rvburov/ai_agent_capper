import type { TFunction } from 'i18next';

import { matchesMedia } from '../../lib/useMediaQuery';

/*
 * Это устройство (кабинет → «Уведомления» и окно установки): система и браузер по User-Agent,
 * открыт ли сайт как установленное приложение. Только для подписей и выбора инструкции —
 * права и данные от этого не зависят. Тексты — pwa.os.* и pwa.browser.* в ru.json.
 */

export type Os = 'iphone' | 'ipad' | 'android' | 'windows' | 'mac' | 'linux' | 'chromeos' | 'other';
export type Browser = 'safari' | 'chrome' | 'edge' | 'firefox' | 'samsung' | 'opera' | 'yandex' | 'other';
/** Какую инструкцию установки показать. */
export type InstallKind = 'ios' | 'android' | 'desktop';

export interface Platform {
  os: Os;
  browser: Browser;
  /** iPhone и iPad: push только в установленном приложении (iOS 16.4+), установка — «Поделиться». */
  ios: boolean;
  /** Телефон или планшет. */
  mobile: boolean;
  install: InstallKind;
}

/** iPadOS 13+ называет себя Mac, но у него сенсорный экран. */
function isIpadAsMac(ua: string, touchPoints: number): boolean {
  return /Macintosh/.test(ua) && touchPoints > 1;
}

export function detectOs(ua: string, touchPoints = 0): Os {
  if (/iPhone|iPod/.test(ua)) return 'iphone';
  if (/iPad/.test(ua) || isIpadAsMac(ua, touchPoints)) return 'ipad';
  if (/Android/.test(ua)) return 'android';
  if (/CrOS/.test(ua)) return 'chromeos';
  if (/Windows/.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/.test(ua)) return 'mac';
  if (/Linux/.test(ua)) return 'linux';
  return 'other';
}

export function detectBrowser(ua: string): Browser {
  // Порядок важен: Edge, Opera, Samsung и Яндекс пишут в UA и «Chrome», и «Safari»
  if (/Edg(e|A|iOS)?\//.test(ua)) return 'edge';
  if (/OPR\/|OPT\/|Opera/.test(ua)) return 'opera';
  if (/SamsungBrowser\//.test(ua)) return 'samsung';
  if (/YaBrowser\//.test(ua)) return 'yandex';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

export function platformOf(ua: string, touchPoints = 0): Platform {
  const os = detectOs(ua, touchPoints);
  const browser = detectBrowser(ua);
  const ios = os === 'iphone' || os === 'ipad';
  const mobile = ios || os === 'android';
  return { os, browser, ios, mobile, install: ios ? 'ios' : os === 'android' ? 'android' : 'desktop' };
}

export function currentPlatform(): Platform {
  if (typeof navigator === 'undefined') return platformOf('');
  return platformOf(navigator.userAgent, navigator.maxTouchPoints || 0);
}

export const STANDALONE_QUERY = '(display-mode: standalone)';

/** Сайт открыт как установленное приложение (с иконки), а не во вкладке браузера. */
export function isStandalone(): boolean {
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || matchesMedia(STANDALONE_QUERY) || matchesMedia('(display-mode: fullscreen)');
}

/** Это устройство словами: «Android · Chrome», «iPhone · приложение AI Capper». */
export function deviceLabel(t: TFunction, platform: Platform, standalone: boolean): string {
  const os = t(`pwa.os.${platform.os}`);
  if (platform.ios && standalone) return t('pwa.deviceApp', { os });
  return t('pwa.device', { os, browser: t(`pwa.browser.${platform.browser}`) });
}
