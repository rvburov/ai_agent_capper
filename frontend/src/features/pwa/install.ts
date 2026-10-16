import { useSyncExternalStore } from 'react';

import { currentPlatform, isStandalone, STANDALONE_QUERY, type InstallKind } from './platform';

/*
 * Установка приложения (окно установки, карточка «Приложение на телефоне»). Chrome и Edge
 * присылают событие beforeinstallprompt: его откладываем и показываем окно браузера по кнопке
 * «Установить». Событие приходит один раз и рано, поэтому слушатель ставится при старте
 * приложения (main.tsx → listenInstallEvents), а не в окне. iPhone такого события не знает —
 * там только шаги «Поделиться → На экран «Домой»».
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface InstallSnapshot {
  /** Есть отложенное событие: кнопка «Установить» откроет окно браузера. */
  canPrompt: boolean;
  /** Открыто как приложение или только что установлено. */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let justInstalled = false;
let snapshot: InstallSnapshot = { canPrompt: false, installed: false };
const listeners = new Set<() => void>();

function refresh(): void {
  const next = { canPrompt: deferred !== null, installed: justInstalled || isStandalone() };
  if (next.canPrompt !== snapshot.canPrompt || next.installed !== snapshot.installed) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
}

let listening = false;

/** Слушать события установки; вызывается один раз при старте приложения. */
export function listenInstallEvents(target: Window = window): void {
  if (listening) return;
  listening = true;
  target.addEventListener('beforeinstallprompt', (event) => {
    // свое окно браузер не показывает: установка — по кнопке в приложении
    event.preventDefault();
    deferred = event as BeforeInstallPromptEvent;
    refresh();
  });
  target.addEventListener('appinstalled', () => {
    deferred = null;
    justInstalled = true;
    refresh();
  });
  target.matchMedia?.(STANDALONE_QUERY).addEventListener?.('change', refresh);
  refresh();
}

/** Для тестов: забыть отложенное событие и установку. */
export function resetInstallState(): void {
  deferred = null;
  justInstalled = false;
  listening = false;
  snapshot = { canPrompt: false, installed: false };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): InstallSnapshot {
  refresh();
  return snapshot;
}

export type PromptOutcome = 'accepted' | 'dismissed' | 'unavailable';

/** Окно установки браузера (Chrome, Edge). Событие одноразовое: после ответа кнопки нет. */
export async function promptInstall(): Promise<PromptOutcome> {
  const event = deferred;
  if (!event) return 'unavailable';
  deferred = null;
  refresh();
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') {
    justInstalled = true;
    refresh();
  }
  return outcome;
}

export interface InstallInfo extends InstallSnapshot {
  /** Какую инструкцию показать: iPhone, Android или компьютер. */
  kind: InstallKind;
}

export function useInstall(): InstallInfo {
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { ...state, kind: currentPlatform().install };
}
