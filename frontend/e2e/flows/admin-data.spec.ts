import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Page } from '@playwright/test';

import { eventsText, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { expectScreenLayout } from '../support/layout';
import { expect, registeredMember, signedInAdmin, test, uniqueName } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';

// «Администрирование → Данные» и «Ставки» этапа 5 (Р25, В1) на настоящем стеке: участник
// сохраняет ставку по анализу → администратор загружает файл tennis-data 2026.xlsx на вкладке
// «Данные» → воркер привязывает матчи из анализа к архиву и рассчитывает ставку сам →
// уведомление «Ставка рассчитана автоматически» ведет на ставку → «Ставки» показывают
// «авто · архив», закрытие из архива и разбор ИИ. Телефон — 375 и 360 px, обе темы.
//
// Файл загружают один раз за прогон — в проекте desktop, вперемешку с остальными сценариями
// (после него анализы других участников идут через ту же очередь arq); телефон (375 и 360 px)
// проверяется в этом же сценарии. Обработка файла и ночное обновление идут под одной
// блокировкой: вторая загрузка в то же время ждала бы в очереди 2 минуты. Пары игроков —
// свои (в других сценариях их нет): файл рассчитывает только ставку этого сценария.

const BACKEND = fileURLToPath(new URL('../../../backend', import.meta.url));
const PYTHON =
  process.env.E2E_PYTHON ?? (existsSync(join(BACKEND, '.venv/bin/python')) ? join(BACKEND, '.venv/bin/python') : 'python3');

// Синнер и Джокович — фавориты (выше по Эло в мире стека), кэф 1.45: у обоих есть перевес
const EVENTS = [
  ['Синнер vs Медведев, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80'],
  ['Джокович vs Руне, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80'],
];

/**
 * 2026.xlsx с сегодняшними матчами этих пар (победил игрок 1, 6:4 6:4) и кэфами Pinnacle —
 * тем же генератором, что тесты backend (tests/test_ingest_tennis_data.py).
 */
async function archiveFile(dir: string): Promise<string> {
  const path = join(dir, '2026.xlsx');
  const script = `
import sys
from datetime import UTC, datetime
from tests.test_ingest_tennis_data import make_row, xlsx

day = datetime.now(UTC).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
odds = {"PSW": 1.40, "PSL": 3.10, "AvgW": 1.38, "AvgL": 3.00}
rows = [
    make_row(77, "E2E Archive Cup", day, winner, loser, round_label="Quarterfinals", series="ATP500", odds=odds)
    for winner, loser in (("Sinner J.", "Medvedev D."), ("Djokovic N.", "Rune H."))
]
with open(sys.argv[1], "wb") as out:
    out.write(xlsx(rows))
`;
  await new Promise<void>((resolve, reject) => {
    execFile(PYTHON, ['-c', script, path], { cwd: BACKEND, timeout: 60_000 }, (error, _stdout, stderr) =>
      error ? reject(new Error(`xlsx: ${stderr || error.message}`)) : resolve(),
    );
  });
  return path;
}

/** Анализ двух матчей и «Сохранить ставку»: номер ставки. */
async function placeBet(page: Page): Promise<number> {
  await parseEvents(page, eventsText(...EVENTS), 2);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  const express = page.getByRole('region', { name: 'Экспресс' });
  await express.getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена/);
  await expect(saved).toBeVisible();
  const id = Number(/№(\d+)/.exec(await saved.innerText())?.[1]);
  expect(id).toBeGreaterThan(0);
  return id;
}

interface BetOut {
  status: string;
  settled_by: string | null;
  archive_to: string | null;
  legs: { result: string | null; closing: { source: string; unverified: boolean } | null }[];
}

async function phoneLayout(page: Page, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 800 });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectScreenLayout(page);
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('файл tennis-data → ставка рассчитана сама → уведомление → «авто · архив»', async ({ device, apiClient, isMobile }) => {
  test.skip(
    isMobile || test.info().project.name !== 'desktop',
    'файл загружается один раз за прогон; телефон — тот же сценарий на 375 и 360 px',
  );
  test.setTimeout(240_000);
  const dir = await mkdtemp(join(tmpdir(), 'capper-e2e-xlsx-'));
  try {
    const file = await archiveFile(dir);
    const adminDevice = await device();
    await signedInAdmin(adminDevice, uniqueName('Даша Данные'));
    const member = await registeredMember(adminDevice, apiClient, uniqueName('Ава Автоматова'));
    const m = await device();
    await signInWithBackupCode(m.page, member);
    const id = await placeBet(m.page);

    // Администратор: «Данные» — статус архива, загрузка файла, ход и отчет
    const admin = adminDevice.page;
    await admin.goto('/admin/data');
    await expect(admin.getByRole('tab', { name: 'Данные' })).toHaveAttribute('aria-selected', 'true');
    const upload = admin.locator('#adm-upload');
    await expect(upload.getByRole('heading', { name: 'Результаты матчей: файл tennis-data' })).toBeVisible();
    await expect(upload.getByText(/Только \.xlsx до 10 МБ/)).toBeVisible();
    await upload.getByLabel('Выбрать файл .xlsx').setInputFiles(file);
    await expect(upload.getByText('Файл загружен.')).toBeVisible({ timeout: 120_000 });
    await expect(toast(admin, /^Файл загружен: 2 новых матча/)).toBeVisible();
    await expect(admin.getByRole('heading', { name: /^Отчет загрузки / })).toBeVisible();
    const report = admin.getByRole('heading', { name: /^Отчет загрузки / }).locator('xpath=ancestor::section[1]');
    await expect(report).toContainText('2026.xlsx');
    // Р14: ни сумм, ни валюты участников
    await expect(report).not.toContainText('₽');
    await expect(admin.getByRole('heading', { name: 'История загрузок' })).toBeVisible();
    await expectScreenLayout(admin);

    // Ставка рассчитана сама: выигрыш по архиву, закрытие П1 из архива (момент снятия не проверен)
    const bet = (await (await m.api.get(`/api/bets/${id}`)).json()) as BetOut;
    expect(bet.status).toBe('won');
    expect(bet.settled_by).toBe('auto');
    expect(bet.archive_to).not.toBeNull();
    expect(bet.legs.every((leg) => leg.result === 'win' && leg.closing?.source === 'archive' && leg.closing.unverified)).toBe(true);

    // Участник: уведомление ведет на ставку, строка истории раскрыта
    const page = m.page;
    await page.goto('/');
    await page.getByRole('button', { name: /^Уведомления: непрочитанных/ }).click();
    const bell = page.getByRole('dialog', { name: 'Уведомления' });
    const note = bell.getByRole('button', { name: new RegExp(`Ставка №${id} рассчитана автоматически`) });
    await expect(note).toContainText('По архиву tennis-data: выигрыш');
    await expect(note.locator('.notif-ic')).toHaveClass(/notif-ic( good)?$/);
    await note.click();
    await expect(page).toHaveURL(/\/bets$/);
    const row = page.locator(`tr[data-bet="${id}"]`);
    await expect(row).toContainText(/авто · архив \d+ [а-я]+/);
    await expect(row).toContainText('Выигрыш');
    const legs = page.getByRole('table', { name: `События ставки №${id}` });
    await expect(legs.getByText('архив tennis-data · Pinnacle')).toHaveCount(2);
    await expect(legs.getByText('архив tennis-data · Pinnacle').first()).toHaveAttribute('title', /момент снятия не проверен/);
    const detail = legs.locator('xpath=ancestor::div[@class="bets-detail"][1]');
    await expect(detail).toContainText(/Рассчитана автоматически .* по архиву tennis-data \(матчи по /);
    await expect(detail.getByText('Разбор ИИ')).toBeVisible();
    await expect(detail.getByRole('button', { name: 'Исправить результат' })).toBeVisible();
    await expectScreenLayout(page);

    // Телефон: карточка в истории и нижний лист — 375 и 360 px, обе темы
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/bets');
    const history = page.getByRole('region', { name: 'История ставок' });
    const card = history.getByRole('button', { name: new RegExp(`^Ставка №${id},.*Выигрыш`) });
    await expect(card).toBeVisible();
    await phoneLayout(page, 375);
    await card.click();
    const sheet = page.getByRole('dialog', { name: `Ставка №${id}` });
    await expect(sheet).toContainText('Разбор ИИ');
    await expect(sheet).toContainText(/Рассчитана автоматически .* по архиву tennis-data/);
    await expect(sheet.getByText('архив tennis-data · Pinnacle')).toHaveCount(2);
    await expect(sheet.getByRole('button', { name: 'Исправить' })).toBeVisible();
    await expectScreenLayout(page, { root: sheet });
    await sheet.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
    await expect(sheet).toBeHidden();
    await phoneLayout(page, 360);

    // «Данные» на телефоне
    await admin.goto('/admin/data');
    await expect(admin.getByRole('heading', { name: /^Отчет загрузки / })).toBeVisible();
    await phoneLayout(admin, 375);
    await phoneLayout(admin, 360);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
