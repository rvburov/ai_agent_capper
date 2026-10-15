import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { learningKeys } from './keys';

/*
 * Сводка «Обучения модели» (плитки, шапка, пороги и цены в текстах) — GET /api/learning: все
 * числа считает сервер (Т15), пороги и цены — из настроек (app_settings.agent_config), день
 * следующего отчета — по поясу участника. Пока сводка грузится или не пришла — null: тексты
 * без чисел.
 */

export function useLearningSummary() {
  return useQuery({
    queryKey: learningKeys.summary,
    queryFn: () => unwrap(api.GET('/api/learning')),
    staleTime: 30_000,
  });
}
