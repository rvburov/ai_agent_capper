import i18n from '../../i18n';

/** Имя модели для людей: «claude-opus-5-5» → «Opus 5.5», «claude-haiku-4-5» → «Haiku 4.5». */
export function modelLabel(model: string): string {
  const match = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model);
  if (!match?.[1] || !match[2]) return model;
  const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
  return match[3] ? `${name} ${match[2]}.${match[3]}` : `${name} ${match[2]}`;
}

// Порядок в списке — от старшей модели к младшей, как в макете
const FAMILY_ORDER = ['opus', 'sonnet', 'haiku'];

function rank(model: string): number {
  const at = FAMILY_ORDER.findIndex((family) => model.includes(`-${family}-`));
  return at < 0 ? FAMILY_ORDER.length : at;
}

/** Список через запятую и «и»: «Opus 5.5, Sonnet 5.5 и Haiku 5.5». */
export function modelList(models: readonly string[]): string {
  const labels = [...models].sort((a, b) => rank(a) - rank(b)).map(modelLabel);
  return new Intl.ListFormat(i18n.t('format.locale'), { type: 'conjunction' }).format(labels);
}
