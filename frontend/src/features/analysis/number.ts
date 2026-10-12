/** Номер анализа на экране, как в макете: 142 → «A-0142». */
export function analysisNumber(id: number): string {
  return `A-${String(id).padStart(4, '0')}`;
}
