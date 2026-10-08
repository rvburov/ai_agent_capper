// Типы API из схемы OpenAPI бэкенда: npm run gen:api.
// 1) backend: python -m app.openapi_export > frontend/openapi.json (сервер и база не нужны);
// 2) openapi-typescript openapi.json -o src/api/schema.d.ts.
// Python берется из backend/.venv, а если его нет — python3 из PATH.
// openapi-typescript работает только с TypeScript 5, а приложение собирается TypeScript 7,
// поэтому генератор живет в отдельном пакете scripts/openapi-ts со своим package-lock.json.
import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(frontend, '../backend');
const venvPython = join(backend, '.venv/bin/python');
const python = existsSync(venvPython) ? venvPython : 'python3';

const schema = execFileSync(python, ['-m', 'app.openapi_export'], {
  cwd: backend,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'inherit'],
});
writeFileSync(join(frontend, 'openapi.json'), schema);

const tool = join(frontend, 'scripts/openapi-ts');
const bin = join(tool, 'node_modules/.bin/openapi-typescript');
if (!existsSync(bin)) {
  execFileSync('npm', ['ci', '--no-audit', '--no-fund', '--prefix', tool], { stdio: 'inherit' });
}
execFileSync(bin, ['openapi.json', '-o', 'src/api/schema.d.ts'], {
  cwd: frontend,
  stdio: 'inherit',
});
