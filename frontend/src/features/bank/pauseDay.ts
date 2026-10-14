/**
 * Последний день паузы включительно: пауза длится до полуночи после него (по поясу участника),
 * поэтому день — это момент окончания минус миллисекунда. Один расчет для кабинета, шапки и
 * текстов ошибок play.paused и play.pause_shorter.
 */
export function pauseLastDay(pausedUntil: string): Date {
  return new Date(Date.parse(pausedUntil) - 1);
}
