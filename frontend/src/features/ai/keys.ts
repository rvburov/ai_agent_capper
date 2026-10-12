import type { QueryClient } from '@tanstack/react-query';

// Ключи запросов ключа Claude и лимита: по одному месту на ресурс. Не под ['me']: по этому
// ключу клиент запросов берет пояс показа дат (api/queryClient.ts).
export const aiKeys = {
  all: ['ai'] as const,
  budget: ['ai', 'budget'] as const,
};

/**
 * Лимит и расход изменились (свой ключ, режим, лимит, бюджет, уведомление о расходе, конец
 * анализа): перечитать их везде, где они показаны. Вкладка «Ключ Claude» и блок лимита
 * «Нового анализа» и «Анализа» читают GET /api/ai/budget под одним ключом aiKeys.budget.
 */
export function invalidateAiBudget(client: QueryClient): Promise<unknown> {
  return client.invalidateQueries({ queryKey: aiKeys.all });
}
