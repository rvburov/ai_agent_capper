// Когда придет следующий отчет недели (В8, Р25): понедельник 07:00 по поясу участника.
// Неделя — с понедельника по воскресенье по его поясу; отчет собирает сервер, экран только
// говорит, когда ждать первый (пустое состояние «Отчетов»).

/** Час отправки отчета по поясу участника. */
export const REPORT_HOUR = 7;

const formats = new Map<string, Intl.DateTimeFormat>();

/** Календарный день и час момента now в поясе timeZone (цифры en-US — всегда ASCII). */
function localParts(now: Date, timeZone: string): { y: number; m: number; d: number; hour: number } {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
    formats.set(timeZone, format);
  }
  const out = { y: 0, m: 0, d: 0, hour: 0 };
  for (const part of format.formatToParts(now)) {
    if (part.type === 'year') out.y = Number(part.value);
    else if (part.type === 'month') out.m = Number(part.value);
    else if (part.type === 'day') out.d = Number(part.value);
    else if (part.type === 'hour') out.hour = Number(part.value);
  }
  return out;
}

/**
 * День следующего отчета («2026-10-19») по поясу участника: ближайший понедельник; в сам
 * понедельник до 07:00 — сегодня, после — через неделю. Неизвестный пояс — UTC.
 */
export function nextReportDay(now: Date, timeZone: string): string {
  let parts;
  try {
    parts = localParts(now, timeZone);
  } catch {
    parts = localParts(now, 'UTC');
  }
  const day = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  // getUTCDay: 0 — воскресенье, 1 — понедельник
  const weekday = day.getUTCDay();
  let ahead = (8 - weekday) % 7;
  if (ahead === 0 && parts.hour >= REPORT_HOUR) ahead = 7;
  day.setUTCDate(day.getUTCDate() + ahead);
  return day.toISOString().slice(0, 10);
}
