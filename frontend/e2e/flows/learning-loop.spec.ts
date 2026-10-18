import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Locator, Page } from '@playwright/test';

import { DJOKOVIC_RUBLEV, SINNER_RUNE, eventsText, parseEvents } from '../support/analysis';
import { withFakeClaude } from '../support/fakeClaude';
import { learningSeed } from '../support/learning';
import { expectScreenLayout } from '../support/layout';
import { stackCli } from '../support/stack';
import { expect, registeredMember, signedInAdmin, test, uniqueName, type Device } from '../support/test';
import { signInWithBackupCode, toast } from '../support/ui';

// Сквозной сценарий этапа 5 «Петля обучения» на одном стеке с поддельным Claude: участник
// разбирает два матча и сохраняет экспресс → администратор загружает файл tennis-data → воркер
// рассчитывает ставку сам (фаворит Синнер проиграл Рублеву) → уведомление ведет на «Ставки»
// (авто · архив) → разбор ИИ пакетом Batch (на стеке пакет отправляет и собирает команда
// терминала postmortems — то же, что задачи воркера по расписанию) → гипотеза из разбора —
// урок → проверка на истории (learning_seed.py: архива за годы на стеке нет) → быстрая проверка
// пакетом → «Включить в инструкции» → следующий анализ пишет версию инструкций с уроком →
// «Вернуть» прежнюю версию. Раскладка экранов с данными — на 375 и 360 px в обеих темах.
//
// Сценарий меняет общее для стека (инструкции анализа, уроки): идет после всех остальных
// (проект loop) или вручную: npx playwright test learning-loop --project=loop --no-deps.
// В конце learning_seed.py postmortem-cleanup убирает разборы матчей ставки, их вызовы Claude и
// пакеты, урок с его версиями инструкций и быстрыми проверками — сценарий повторяется на одном
// стеке. Матчи архива остаются: повторная загрузка того же файла рассчитывает новую ставку.

const EXCLUSIVE = process.env.E2E_EXCLUSIVE === '1';
const THEMES = ['light', 'dark'] as const;
const PAGE_LAYOUT = { exclude: '.skip-link' } as const;

const BACKEND = fileURLToPath(new URL('../../../backend', import.meta.url));
const PYTHON =
  process.env.E2E_PYTHON ?? (existsSync(join(BACKEND, '.venv/bin/python')) ? join(BACKEND, '.venv/bin/python') : 'python3');

// Пары только этого сценария; фавориты (выше по Эло в мире стека) с кэфом 1.45 — есть перевес.
// Синнер записан первым, а в архиве первым идет победитель Рублев: разбор переворачивает
// вероятности досье к порядку игроков архива
const EVENTS = [
  ['Алькарас vs Руне, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80'],
  ['Синнер vs Рублев, Test Open 9, хард, 1/8', 'Кэфы: П1 = 1.45, П2 = 2.80'],
];

/**
 * 2026.xlsx с сегодняшними матчами этих пар: Алькарас выиграл, фаворит Синнер проиграл Рублеву
 * (разбор: ошибка модели и гипотеза), кэфы Pinnacle — генератор тестов backend.
 */
async function archiveFile(dir: string): Promise<string> {
  const path = join(dir, '2026.xlsx');
  const script = `
import sys
from datetime import UTC, datetime
from tests.tennis_data_files import make_row, xlsx

day = datetime.now(UTC).replace(tzinfo=None, hour=0, minute=0, second=0, microsecond=0)
rows = [
    make_row(78, "E2E Loop Cup", day, "Alcaraz C.", "Rune H.", round_label="Quarterfinals",
             series="ATP500", odds={"PSW": 1.40, "PSL": 3.10, "AvgW": 1.38, "AvgL": 3.00}),
    make_row(78, "E2E Loop Cup", day, "Rublev A.", "Sinner J.", round_label="Quarterfinals",
             series="ATP500", odds={"PSW": 2.95, "PSL": 1.42, "AvgW": 2.85, "AvgL": 1.40}),
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

/** Анализ на поддельном Claude до экспресса: номер анализа. */
async function runAnalysis(page: Page, events: string[][]): Promise<number> {
  await parseEvents(page, eventsText(...events), events.length);
  await withFakeClaude(async () => {
    await page.getByRole('button', { name: /^Запустить/ }).last().click();
    await expect(page).toHaveURL(/\/analysis\/\d+$/);
    await expect(page.getByRole('heading', { level: 2, name: /^Экспресс из 2 событий/ })).toBeVisible({ timeout: 30_000 });
  });
  return Number(/\/analysis\/(\d+)/.exec(page.url())?.[1]);
}

/** «Сохранить ставку» экспресса анализа: номер ставки. */
async function saveBet(page: Page): Promise<number> {
  const express = page.getByRole('region', { name: 'Экспресс стратегии' });
  await express.getByRole('button', { name: 'Сохранить ставку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Сохранить ставку' });
  await dialog.getByRole('button', { name: 'Сохранить ставку' }).click();
  const saved = toast(page, /Ставка №\d+ сохранена/);
  await expect(saved).toBeVisible();
  const id = Number(/№(\d+)/.exec(await saved.innerText())?.[1]);
  expect(id).toBeGreaterThan(0);
  return id;
}

async function layoutPhones(page: Page, root?: () => Locator): Promise<void> {
  const before = page.viewportSize() ?? { width: 1366, height: 900 };
  for (const width of [375, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scheme of THEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await expectScreenLayout(page, { ...PAGE_LAYOUT, ...(root ? { root: root() } : {}) });
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(before);
}

interface BetOut {
  status: string;
  settled_by: string | null;
  legs: { result: string | null }[];
}

interface ReviewOut {
  legs: { verdict: string | null; lesson: { code: string; status: string } | null }[];
}

interface VersionOut {
  code: string;
  status: string;
  prompt_version: string | null;
  lessons: string[];
}

interface RunOut {
  kind: string;
  analysis_id: number | null;
  prompt_version: string | null;
}

async function instructions(device: Device): Promise<VersionOut[]> {
  const out = (await (await device.api.get('/api/strategy/versions')).json()) as { instructions: VersionOut[] };
  return out.instructions;
}

/** Версии инструкций, с которыми шла оценка матча анализа (журнал вызовов Claude участника). */
async function analysisPrompts(device: Device, analysisId: number): Promise<string[]> {
  const out = (await (await device.api.get('/api/ai/runs?limit=100')).json()) as { items: RunOut[] };
  const found = out.items.filter((run) => run.analysis_id === analysisId && run.kind === 'analysis');
  return [...new Set(found.map((run) => run.prompt_version ?? ''))];
}

test('анализ → ставка → файл tennis-data → авторасчет → разбор ИИ → урок → включение → откат', async ({ device, apiClient, isMobile }) => {
  test.skip(isMobile || (!EXCLUSIVE && test.info().project.name !== 'loop'), 'меняет инструкции анализа у всех: идет после остальных');
  test.setTimeout(360_000);
  const dir = await mkdtemp(join(tmpdir(), 'capper-e2e-loop-'));
  let betId = 0;
  try {
    const admin = await device();
    await signedInAdmin(admin, uniqueName('Админ Петли'));
    const member = await registeredMember(admin, apiClient, uniqueName('Петр Петлев'));
    const m = await device();
    await signInWithBackupCode(m.page, member);
    const page = m.page;

    // Разборы идут для ставок, рассчитанных после начала разборов (postmortem_since): на стеке
    // его записывает learning_seed.py, как первый запуск очереди воркером по расписанию
    await learningSeed(['postmortem-start']);

    // 1. Анализ и ставка: инструкции v3 без уроков
    const before = (await instructions(m)).find((v) => v.status === 'active');
    expect(before?.lessons).toEqual([]);
    const firstAnalysis = await runAnalysis(page, EVENTS);
    betId = await saveBet(page);
    expect(await analysisPrompts(m, firstAnalysis)).toEqual([before?.prompt_version]);

    // 2. Администратор загружает файл: ставка рассчитана сама — проигрыш по архиву
    const file = await archiveFile(dir);
    const adminPage = admin.page;
    await adminPage.goto('/admin/data');
    const upload = adminPage.locator('#adm-upload');
    await upload.getByLabel('Выбрать файл .xlsx').setInputFiles(file);
    await expect(upload.getByText('Файл загружен.')).toBeVisible({ timeout: 120_000 });
    await expect(adminPage.getByRole('heading', { name: /^Отчет загрузки / })).toBeVisible();
    const bet = (await (await m.api.get(`/api/bets/${betId}`)).json()) as BetOut;
    expect(bet.status).toBe('lost');
    expect(bet.settled_by).toBe('auto');
    expect(bet.legs.map((leg) => leg.result).sort()).toEqual(['loss', 'win']);

    // 3. Уведомление ведет на ставку: «авто · архив», проигрыш
    await page.goto('/');
    await page.getByRole('button', { name: /^Уведомления: непрочитанных/ }).click();
    const bell = page.getByRole('dialog', { name: 'Уведомления' });
    const note = bell.getByRole('button', { name: new RegExp(`Ставка №${betId} рассчитана автоматически`) });
    await expect(note).toContainText('По архиву tennis-data: проигрыш');
    await note.click();
    await expect(page).toHaveURL(/\/bets$/);
    const row = page.locator(`tr[data-bet="${betId}"]`);
    await expect(row).toContainText(/авто · архив \d+ [а-я]+/);
    await expect(row).toContainText('Проигрыш');
    const detail = page.getByRole('table', { name: `События ставки №${betId}` }).locator('xpath=ancestor::div[@class="bets-detail"][1]');
    // разбор еще в очереди: пакет уходит по расписанию
    await expect(detail.getByText('Разбор ИИ')).toBeVisible();

    // 4–6 — под одной блокировкой поддельного Claude: разбор и быстрая проверка пакетом
    let code = '';
    const lesson = () => adminPage.getByRole('article', { name: `Урок ${code}` });
    await withFakeClaude(async () => {
      // 4. Разбор ИИ: пакет Sonnet 5.5 через Batch на поддельном Claude — отправка и сбор
      expect(await stackCli(['postmortems'])).toMatch(/отправлено [1-9]/);
      const review = (await (await m.api.get(`/api/bets/${betId}/review`)).json()) as ReviewOut;
      const lost = review.legs.find((leg) => leg.lesson !== null);
      expect(lost?.verdict).toBe('model_error');
      expect(lost?.lesson?.status).toBe('hypothesis');
      code = lost?.lesson?.code ?? '';
      expect(code).toMatch(/^L-\d+$/);
      await page.reload();
      await expect(detail.getByText('Ошибка модели', { exact: true })).toBeVisible();
      await expect(detail.getByText('Прогноз подтвердился', { exact: true })).toBeVisible();
      await expect(detail.getByRole('link', { name: code })).toBeVisible();
      await expect(detail).toContainText(`${code} — гипотеза`);
      await expect(detail).toContainText('Фаворит на этом покрытии выигрывает реже, чем дает модель');
      // телефон: нижний лист ставки с разбором
      await page.setViewportSize({ width: 375, height: 812 });
      await page.goto('/bets');
      const card = page.getByRole('region', { name: 'История ставок' }).getByRole('button', { name: new RegExp(`^Ставка №${betId},.*Проигрыш`) });
      await card.click();
      const sheet = page.getByRole('dialog', { name: `Ставка №${betId}` });
      await expect(sheet.getByText('Ошибка модели', { exact: true })).toBeVisible();
      await layoutPhones(page, () => page.getByRole('dialog', { name: `Ставка №${betId}` }));
      await sheet.getByRole('button', { name: 'Закрыть', exact: true }).last().click();
      await page.setViewportSize({ width: 1366, height: 900 });

      // 5. Гипотеза — урок на «Обучении модели»; проверка на истории (на стеке — learning_seed.py)
      await adminPage.goto('/learning');
      await expect(lesson().getByText('Гипотеза', { exact: true })).toBeVisible();
      await learningSeed(['ready', code]);
      await adminPage.reload();
      await expect(lesson().getByText('Ждет решения', { exact: true })).toBeVisible();
      // модель завышает фаворита — поправка вниз: −5,0 × 309 / (309 + 200) = −3,0
      await expect(lesson().getByText('−3,0 п.п. с усадкой (сырая −5,0 п.п.)')).toBeVisible();
      await layoutPhones(adminPage);

      // 6. Быстрая проверка пакетом и «Включить в инструкции»: новая активная версия с уроком
      await lesson().getByRole('button', { name: 'Использовать в анализе' }).click();
      const dialog = adminPage.getByRole('dialog', { name: `Урок ${code} в анализ` });
      const run = dialog.getByRole('button', { name: /^Запустить проверку · ≈ \$/ });
      await expect(run).toBeEnabled();
      await layoutPhones(adminPage, () => adminPage.getByRole('dialog'));
      await run.click();
      await expect(dialog.getByText(/Пакет отправлен: \d+ запрос/)).toBeVisible();
      await learningSeed(['collect']);
      await expect(dialog.getByText('Ждет вашего решения')).toBeVisible({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Включить в инструкции' }).click();
    });
    await expect(adminPage.getByText(new RegExp(`^Урок ${code} в инструкциях со следующего анализа — для всех участников`))).toBeVisible();
    const withLesson = (await instructions(m)).find((v) => v.status === 'active');
    expect(withLesson?.lessons).toEqual([code]);
    expect(withLesson?.code).not.toBe(before?.code);
    expect(withLesson?.prompt_version).not.toBe(before?.prompt_version);

    // 7. Следующий анализ участника идет с уроком: версия инструкций в журнале вызовов и в
    // «ИИ и расходы»; разбор ставки показывает урок «в инструкциях анализа»
    const nextAnalysis = await runAnalysis(page, [SINNER_RUNE, DJOKOVIC_RUBLEV]);
    expect(await analysisPrompts(m, nextAnalysis)).toEqual([withLesson?.prompt_version]);
    await page.goto('/costs');
    const versions = page.getByRole('table', { name: 'Версии инструкций: цена и качество' });
    await expect(versions.getByText(`${withLesson?.code} · ${withLesson?.prompt_version}`)).toBeVisible();
    await expect(versions.getByText(`${before?.code} · ${before?.prompt_version}`)).toBeVisible();
    await page.goto(`/bets?bet=${betId}`);
    await expect(page.getByRole('table', { name: `События ставки №${betId}` }).locator('xpath=ancestor::div[@class="bets-detail"][1]')).toContainText(
      `${code} — в инструкциях анализа`,
    );

    // 8. Откат: «Вернуть» прежнюю версию — урок выходит из инструкций
    await adminPage.goto('/learning/versions');
    const panel = adminPage.getByRole('tabpanel', { name: 'Версии стратегии' });
    const table = panel.getByRole('table', { name: 'Инструкции анализа' });
    await expect(table.getByRole('row', { name: new RegExp(`^${withLesson?.code}`) })).toContainText('Активная');
    await layoutPhones(adminPage);
    await table.getByRole('row', { name: new RegExp(`^${before?.code}`) }).click();
    const version = adminPage.getByRole('dialog', { name: new RegExp(`^Версия ${before?.code}`) });
    await expect(version.getByRole('button', { name: `Вернуть ${before?.code}` })).toBeVisible();
    await layoutPhones(adminPage, () => adminPage.getByRole('dialog'));
    await version.getByRole('button', { name: `Вернуть ${before?.code}` }).click();
    await expect(adminPage.getByText(`Снова активна ${before?.code} · ${withLesson?.code} вернулась в кандидаты`)).toBeVisible();
    await expect(table.getByRole('row', { name: new RegExp(`^${before?.code}`) })).toContainText('Активная');
    const after = (await instructions(m)).find((v) => v.status === 'active');
    expect(after?.code).toBe(before?.code);
    expect(after?.lessons).toEqual([]);
    await adminPage.goto('/learning');
    await expect(lesson().getByRole('switch', { name: /Использовать в анализе/ })).not.toBeChecked();
  } finally {
    await rm(dir, { recursive: true, force: true });
    // Разборы матчей ставки (вызовы Claude, пакеты), урок, его версии и быстрые проверки
    if (betId) await learningSeed(['postmortem-cleanup', String(betId)]);
  }
});
