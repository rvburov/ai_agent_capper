/** Номер анализа на экране, как в макете: 142 → «A-0142». */
export function analysisNumber(id: number): string {
  return `A-${String(id).padStart(4, '0')}`;
}

/**
 * Последний анализ матча — с самой свежей оценкой Claude: сервер отдает номера по возрастанию,
 * но порядок схемой не закреплен, поэтому берем наибольший. Нет анализов — undefined.
 */
export function latestAnalysis(ids: readonly number[]): number | undefined {
  return ids.length ? Math.max(...ids) : undefined;
}
