import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { API_PORT, WEB_PORT } from './stack';
import { FAKE_PORT } from './fakeClaude';

/*
 * «Обучение модели» на стеке e2e: то, что в настоящей работе делают время и архив (сыгранные
 * матчи после среза знаний модели, проверка урока на архиве за годы, сбор пакета Batch по
 * расписанию воркера), делает e2e/support/learning_seed.py интерпретатором backend против
 * базы стека. Окружение — как backend_env в scripts/e2e-stack.sh (те же переменные E2E_*).
 */

const BACKEND = fileURLToPath(new URL('../../../backend/', import.meta.url));
const SEED = fileURLToPath(new URL('./learning_seed.py', import.meta.url));

function python(): string {
  if (process.env.E2E_PYTHON) return process.env.E2E_PYTHON;
  const venv = `${BACKEND}.venv/bin/python`;
  return existsSync(venv) ? venv : 'python3';
}

/** Окружение backend стека: то же, что backend_env в scripts/e2e-stack.sh. */
function stackEnv(): NodeJS.ProcessEnv {
  const admin = process.env.E2E_PG_ADMIN_URL ?? process.env.CAPPER_TEST_ADMIN_DATABASE_URL ?? 'postgresql://capper:capper@localhost:5432/postgres';
  const withoutScheme = admin.replace(/^[a-z+]+:\/\//, '');
  const database = `postgresql+asyncpg://${withoutScheme.replace(/\/[^/]*$/, '')}/capper_e2e_${API_PORT}`;
  return {
    ...process.env,
    PYTHONPATH: BACKEND,
    CAPPER_ENV: 'test',
    CAPPER_DATABASE_URL: database,
    CAPPER_REDIS_URL: process.env.E2E_REDIS_URL ?? process.env.CAPPER_REDIS_URL ?? 'redis://localhost:6379/0',
    CAPPER_REDIS_PREFIX: `capper-e2e-${API_PORT}:`,
    CAPPER_PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
    CAPPER_COOKIE_SECURE: 'false',
    CAPPER_HIBP_ENABLED: 'false',
    CAPPER_TRUSTED_PROXIES: '127.0.0.1',
    CAPPER_SECRET_KEY: '',
    CAPPER_MASTER_KEYS: '',
    CAPPER_ANTHROPIC_BASE_URL: `http://127.0.0.1:${FAKE_PORT}`,
    CAPPER_WORKER_CRON: 'false',
  };
}

/** learning_seed.py КОМАНДА ... против базы стека. */
export function learningSeed(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(python(), [SEED, ...args], { cwd: BACKEND, env: stackEnv(), timeout: 90_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`learning_seed ${args[0] ?? ''}: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}
