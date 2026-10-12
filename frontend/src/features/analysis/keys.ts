// Ключи запросов анализа, ставки и справочников «Нового анализа»: по одному месту на ресурс.
export const analysisKeys = {
  all: ['analyses'] as const,
  list: ['analyses', 'list'] as const,
  one: (id: number) => ['analyses', 'one', id] as const,
  preview: (id: number, body: string) => ['analyses', 'preview', id, body] as const,
  strategy: ['strategy', 'active'] as const,
  bank: ['bank'] as const,
  bookmakers: ['bookmakers'] as const,
};
