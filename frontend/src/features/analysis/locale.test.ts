import { describe, expect, it } from 'vitest';

import ru from '../../i18n/locales/ru.json';

// Локаль сервера: шаги, правила, заметки, ошибки анализа и ставки приходят из API ключами
// с параметрами, тексты для них — во фронтенде
const backend = import.meta.glob<Record<string, unknown>>('../../../../backend/app/locales/ru.json', {
  eager: true,
  import: 'default',
});

const GROUPS = [
  'errors.analysis',
  'errors.bet',
  'analysis.steps',
  'analysis.draft',
  'analysis.warnings',
  'analysis.rules',
  'analysis.leg',
  'analysis.express',
  'analysis.stake',
  'analysis.compare',
];

function get(tree: unknown, path: string): unknown {
  let node = tree;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null || !(part in node)) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

function leaves(node: unknown, path: string): [string, string][] {
  if (typeof node === 'string') return [[path, node]];
  if (typeof node !== 'object' || node === null) return [];
  return Object.entries(node).flatMap(([key, value]) => leaves(value, `${path}.${key}`));
}

/** Имена подстановок: «{cap}» на сервере и «{{cap}}» в i18next. */
function placeholders(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{?(\w+)\}\}?/g)].map((m) => m[1] ?? ''))].sort();
}

describe('ключи анализа из API', () => {
  const files = Object.values(backend);

  it('локаль сервера найдена', () => {
    expect(files).toHaveLength(1);
  });

  it.each(GROUPS)('каждый ключ %s сервера есть во фронтенде, подстановки — только из параметров сервера', (group) => {
    const server = leaves(get(files[0], group), group);
    expect(server.length).toBeGreaterThan(0);
    for (const [key, text] of server) {
      const client = get(ru, key) ?? get(ru, `${key}_one`);
      expect(typeof client, key).toBe('string');
      const allowed = placeholders(text);
      for (const name of placeholders(client as string)) expect(allowed, `${key}: {{${name}}}`).toContain(name);
    }
  });
});
