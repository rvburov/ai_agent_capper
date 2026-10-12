import { expect, type Page } from '@playwright/test';

import { registeredMember, signedInAdmin, uniqueName, type Device } from './test';
import { heading, signInWithBackupCode } from './ui';

/*
 * Шаги сценариев анализа (e2e/flows/analysis*.spec.ts): участник по приглашению входит,
 * вставляет текст и разбирает его. Игроки — маленький мир стека (scripts/e2e-stack.sh).
 */

export const SINNER_RUNE = ['Синнер vs Руне, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.30, П2 = 3.60'];
export const DJOKOVIC_RUBLEV = ['Джокович vs Рублев, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80'];
export const ALCARAZ_MEDVEDEV = ['Алькарас vs Медведев, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.35, П2 = 3.20'];

/** Текст в формате бота: банк, букмекер и события. */
export function eventsText(...events: string[][]): string {
  return ['Текущий банк: 48 000 ₽', 'Букмекер: Fonbet', '', 'События:', ...events.flat()].join('\n');
}

type DeviceFactory = (options?: { ip?: string }) => Promise<Device>;
type ApiFactory = Parameters<typeof registeredMember>[1];

/** Участник (приглашение администратора, 2FA) вошел в браузере своего устройства. */
export async function memberDevice(device: DeviceFactory, apiClient: ApiFactory, name: string): Promise<Device> {
  const admin = await device();
  await signedInAdmin(admin);
  const member = await registeredMember(admin, apiClient, uniqueName(name));
  const m = await device();
  await signInWithBackupCode(m.page, member);
  return m;
}

/** «Новый анализ»: текст в поле и «Разобрать» — до карточек «Что распознано». */
export async function parseEvents(page: Page, text: string, count: number): Promise<void> {
  await page.goto('/new');
  await expect(heading(page, 'Новый анализ')).toBeVisible();
  await page.getByRole('textbox', { name: 'Текст событий' }).fill(text);
  await page.getByRole('button', { name: 'Разобрать', exact: true }).click();
  await expect(page.getByText(`Разобрано · ${count} ${count === 1 ? 'событие' : 'события'}`)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Что распознано' }).getByRole('article')).toHaveCount(count);
  await expect(page).toHaveURL(/\/new\?draft=\d+$/);
}

/** Кнопка запуска доступна: «Перед запуском» посчитан, причин запрета нет. */
export async function expectReadyToLaunch(page: Page): Promise<void> {
  const launch = page.getByRole('complementary', { name: 'Перед запуском' });
  await expect(launch.getByText(/^Займет ~/)).toBeVisible();
  await expect(launch.getByRole('button', { name: 'Запустить анализ' })).toBeEnabled();
}
