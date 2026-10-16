import { useQuery } from '@tanstack/react-query';

import { api, unwrap } from '../../api/client';
import { learningKeys } from './keys';

/*
 * Еженедельные отчеты (В8 Р25): неделя — с понедельника по воскресенье по поясу участника,
 * отчет собирается в понедельник в 07:00 по тому же поясу и хранится снимком. Только свои
 * (чужой — 404). Все числа считает сервер; уведомление weekly_report ведет на
 * /learning/reports?report=ID и сбрасывает ключи ['learning'].
 */

export function useWeeklyReports({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: learningKeys.reports,
    queryFn: () => unwrap(api.GET('/api/learning/reports')),
    staleTime: 60_000,
    enabled,
  });
}

/** Один отчет: снимок не меняется — кэш без срока. */
export function useWeeklyReport(id: number | null) {
  return useQuery({
    queryKey: learningKeys.report(id ?? 0),
    queryFn: () => unwrap(api.GET('/api/learning/reports/{report_id}', { params: { path: { report_id: id ?? 0 } } })),
    staleTime: Infinity,
    retry: false,
    enabled: id !== null,
  });
}
