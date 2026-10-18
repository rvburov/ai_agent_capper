/*
 * Тексты интерфейса по частям (бюджет JS первого экрана — 250 КБ gzip, docs/PLAN.md). Все
 * тексты лежат в одном файле locales/<язык>.json; при сборке он делится (плагин capperTexts в
 * vite.config.ts) на «ядро» и разделы экранов:
 *   - ядро (CORE_TEXTS) — в начальной загрузке: оболочка, меню, колокольчик, ошибки, форматы и
 *     тексты общих компонентов и модулей, которые импортирует почти каждый экран;
 *   - тексты экрана (SCREEN_TEXTS: свой раздел и нужные ветки чужих) — отдельным файлом, экран
 *     грузит его вместе со своим кодом (src/app/lazyPage.ts).
 * Что какой экран и оболочка берут, проверяет i18n.test.ts по исходникам (импорты и ключи):
 * новый ключ из чужого раздела — тест назовет экран и ветку, которую нужно дописать.
 */
export const CORE_TEXTS: readonly string[] = [
  'app',
  'nav',
  'shell',
  'pages',
  'crumbs',
  'notifications',
  'notFound',
  'common',
  'format',
  'charts',
  // тексты кодов ошибок сервера (api/errors.ts, features/analysis/codes.ts) — на любом экране
  'errors',
  // PWA: «Нет связи» (без сети других текстов не загрузить), окно установки из меню, push
  'pwa',
  // режим просмотра данных участника (Р27): плашка и выбор в оболочке, подсказка у кнопок
  'view',
  // счетчик дел администратора у пункта меню (Sidebar) и «только для администратора»
  // (RequireAdmin: участник открыл /admin — экран администрирования не грузится)
  'admin.overview.decisions.tabNote',
  'admin.onlyTitle',
  'admin.onlyText',
  // общие компоненты и модули (components/*, features/analysis/*, features/profile/timezones)
  'analysis.form',
  'analysis.surface',
  'analysis.market',
  'analysis.warnings',
  'new.fresh',
  'new.errors',
  'new.categories',
  'new.rounds',
  'profile.tz',
];

/** Разделы ru.json вне ядра: тексты экранов. */
export const SCREEN_SECTIONS = [
  'auth',
  'dashboard',
  'new',
  'analysis',
  'bets',
  'analytics',
  'players',
  'costs',
  'learning',
  'profile',
  'admin',
] as const;

/**
 * Тексты каждого экрана (ключ — файл экрана в src/pages без .tsx): разделы и отдельные ветки
 * чужих разделов, которые берут экран и его импорты. При сборке из них — один файл текстов
 * экрана (virtual:capper-texts/screen/<экран>), он грузится вместе с кодом экрана. Список
 * проверяет i18n.test.ts: не хватает ветки — тест назовет файл и ключ.
 */
export const SCREEN_TEXTS = {
  'auth/LoginPage': ['auth'],
  'auth/RegisterPage': ['auth'],
  'auth/ResetPage': ['auth'],
  'dashboard/DashboardPage': [
    'dashboard',
    'admin.left',
    'admin.months',
    'analytics.flows',
    'analytics.markets',
    'analytics.period',
    'bets.botClv',
    'bets.closing',
    'bets.gamesOutcome',
    'bets.kind',
    'bets.kindChip',
    'bets.leg',
    'bets.number',
    'bets.playerCard',
    'bets.status',
    'bets.today',
    'bets.verdict',
    'profile.bank.adapt.rules',
  ],
  'new/NewAnalysisPage': ['new', 'admin.months', 'analysis.draft', 'analysis.marketChip', 'analysis.marketGroup', 'analysis.marketName', 'analysis.marketStatus', 'analysis.matchTitle'],
  'analysis/AnalysisPage': ['analysis', 'bets.kind', 'bets.kindChip', 'bets.playerCard'],
  'bets/BetsPage': ['bets', 'analysis.marketChip', 'analysis.marketName', 'analysis.marketStatus'],
  'analytics/AnalyticsPage': ['analytics', 'analysis.marketChip', 'analysis.marketName', 'analysis.marketStatus', 'bets.months'],
  'players/PlayersPage': ['players'],
  'players/PlayerPage': ['players'],
  'costs/CostsPage': [
    'costs',
    'analytics.markets',
    'analytics.period',
    'dashboard.attention.admin',
    'dashboard.attention.rules',
    'dashboard.costs.monthsIn',
    'profile.bank.adapt.rules',
    'profile.key.limit',
    'profile.key.reason',
  ],
  'learning/LearningPage': ['learning', 'analysis.marketChip', 'analysis.marketName', 'costs.months'],
  'profile/ProfilePage': [
    'profile',
    'admin.left',
    'admin.limitShort',
    'admin.limitText',
    'admin.months',
    'analysis.calc.rangeBetween',
    'analysis.calc.rangeFrom',
    'analysis.calc.rangeTo',
    'analysis.marketChip',
    'analysis.marketName',
    'analysis.marketStatus',
    'analysis.variants.also',
    'bets.count',
  ],
  'profile/deletion/DeletionPendingScreen': ['profile.deletion'],
  'admin/AdminPage': [
    'admin',
    'analysis.marketChip',
    'analysis.marketName',
    'analytics.markets',
    'analytics.period',
    'costs.effort',
    'costs.effortChip',
    'costs.kinds',
    'costs.lessCent',
    'costs.lessPct',
    'costs.run.formulaValue',
    'costs.types',
    'profile.key.approx',
    'profile.key.lastSymbols',
    'profile.key.mask',
    'profile.key.setup',
    'profile.log',
    'profile.unknownDevice',
  ],
} as const satisfies Record<string, readonly string[]>;

export type ScreenName = keyof typeof SCREEN_TEXTS;

type Texts = { [key: string]: unknown };

function isTexts(value: unknown): value is Texts {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pick(texts: Texts, path: readonly string[]): unknown {
  let node: unknown = texts;
  for (const part of path) {
    if (!isTexts(node) || !(part in node)) return undefined;
    node = node[part];
  }
  return node;
}

function put(texts: Texts, path: readonly string[], value: unknown): void {
  let node = texts;
  for (const part of path.slice(0, -1)) {
    const next = node[part];
    node = isTexts(next) ? next : (node[part] = {});
  }
  node[path[path.length - 1] as string] = value;
}

/** Удалить путь; опустевшие разделы — тоже. */
function drop(texts: Texts, path: readonly string[]): void {
  const [head, ...rest] = path;
  if (head === undefined || !(head in texts)) return;
  const child = texts[head];
  if (rest.length === 0 || !isTexts(child)) {
    delete texts[head];
    return;
  }
  drop(child, rest);
  if (Object.keys(child).length === 0) delete texts[head];
}

/** Тексты одного языка → ядро (core) и остальное (rest); вместе — весь файл без повторов. */
export function splitTexts(texts: Texts, core: readonly string[] = CORE_TEXTS): { core: Texts; rest: Texts } {
  const head: Texts = {};
  const rest = structuredClone(texts);
  for (const entry of core) {
    const path = entry.split('.');
    const value = pick(texts, path);
    if (value === undefined) continue;
    put(head, path, structuredClone(value));
    drop(rest, path);
  }
  return { core: head, rest };
}

/** Тексты экрана: ветки paths из того, что не вошло в ядро (повторы веток не страшны). */
export function screenTexts(texts: Texts, paths: readonly string[]): Texts {
  const { rest } = splitTexts(texts);
  const out: Texts = {};
  for (const entry of paths) {
    const path = entry.split('.');
    const value = pick(rest, path);
    if (value !== undefined) {
      put(out, path, structuredClone(value));
      continue;
    }
    // Множественное число: ветка «bets.count» — это count_one, count_few, count_many …
    const last = path[path.length - 1] ?? '';
    const parent = pick(rest, path.slice(0, -1));
    if (!isTexts(parent)) continue;
    for (const [key, form] of Object.entries(parent)) {
      if (key.startsWith(`${last}_`)) put(out, [...path.slice(0, -1), key], structuredClone(form));
    }
  }
  return out;
}
