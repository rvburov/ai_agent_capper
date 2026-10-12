import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API_PORT } from './stack';

/*
 * Поддельный Claude стека (backend/tests/fake_claude.py): сбои шагов включаются на весь сервер
 * (POST /_fake/fail), поэтому сценарии, которые запускают анализы, идут по очереди — под общей
 * блокировкой между процессами Playwright (папка-замок во временной папке). Иначе сбой,
 * включенный одним тестом, достался бы анализу другого.
 */
export const FAKE_PORT = Number(process.env.E2E_FAKE_CLAUDE_PORT ?? API_PORT + 99);
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const LOCK_DIR = join(tmpdir(), `capper-e2e-fake-claude-${FAKE_PORT}.lock`);
const STALE_MS = 3 * 60_000;

export type FakeStep = 'parse' | 'news' | 'analysis' | 'any';
export type FakeError = 'overloaded' | 'rate_limited' | 'key_rejected' | 'server' | 'refusal' | 'bad_json';

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(`${FAKE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fake Claude ${path}: ${response.status}`);
}

/** Следующие times запросов шага step ответят ошибкой (SDK повторяет 429/5xx дважды). */
export function failNext(step: FakeStep, error: FakeError, times: number): Promise<void> {
  return post('/_fake/fail', { step, error, times });
}

/** Снять все сбои (счетчики запросов тоже обнуляются). */
export function resetFake(): Promise<void> {
  return post('/_fake/reset');
}

function tryLock(): boolean {
  try {
    mkdirSync(LOCK_DIR);
    return true;
  } catch {
    // Замок остался от упавшего прогона — снимаем
    try {
      if (Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_MS) rmSync(LOCK_DIR, { recursive: true, force: true });
    } catch {
      // замок уже сняли
    }
    return false;
  }
}

/** Выполнить fn, пока другие сценарии с анализом ждут; сбои поддельного Claude — снять после. */
export async function withFakeClaude<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5 * 60_000;
  while (!tryLock()) {
    if (Date.now() > deadline) throw new Error('поддельный Claude занят другим сценарием дольше 5 минут');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    return await fn();
  } finally {
    await resetFake().catch(() => undefined);
    rmSync(LOCK_DIR, { recursive: true, force: true });
  }
}
