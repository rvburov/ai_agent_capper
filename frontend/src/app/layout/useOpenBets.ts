import { useBetCounts } from '../../features/bets/api';

// Сколько ставок в игре — счетчик у пункта «Ставки» в боковом и нижнем меню (app.js макета:
// badge у «Ставок»). Число — с сервера (GET /api/bets/counts, поле open): легкий запрос только
// по открытым ставкам, без итогов. Ключ — под betKeys.all: сохранение, расчет, сторно и
// уведомление «ставка рассчитана» (авторасчет по архиву) перечитывают его сами.

/** Число открытых ставок; пока не загрузилось или ошибка — 0 (счетчика нет). */
export function useOpenBetsCount(): number {
  return useBetCounts().data?.open ?? 0;
}

/** Текст счетчика: больше 99 — «99+». */
export function openBetsText(count: number): string {
  return count > 99 ? '99+' : String(count);
}
