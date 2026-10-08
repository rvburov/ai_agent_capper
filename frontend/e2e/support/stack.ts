import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/*
 * Адреса стека сквозных тестов (scripts/e2e-stack.sh). Порты — те же переменные окружения,
 * что читает скрипт, поэтому конфиг Playwright, тесты и стек всегда смотрят в одно место.
 */
export const API_PORT = Number(process.env.E2E_API_PORT ?? 8000);
export const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 4173);
export const BASE_URL = `http://localhost:${WEB_PORT}`;
export const STACK_SCRIPT = fileURLToPath(new URL('../../../scripts/e2e-stack.sh', import.meta.url));

/** Команда терминала backend против базы стека: bash scripts/e2e-stack.sh cli ... */
export function stackCli(args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('bash', [STACK_SCRIPT, 'cli', ...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(`cli ${args[0] ?? ''}: ${stderr || error.message}`));
      else resolve(stdout);
    });
    child.stdin?.end(input === undefined ? undefined : `${input}\n`);
  });
}
