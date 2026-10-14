import type { Bookmaker, BookmakerList } from './api';

/** Букмекер кабинета для тестов (GET /api/me/bookmakers/list). */
export function bookmakerOut(over: Partial<Bookmaker> = {}): Bookmaker {
  return {
    id: 1,
    name: 'Fonbet',
    created_at: '2026-10-01T09:00:00Z',
    archived_at: null,
    bets: 0,
    open_bets: 0,
    in_play: '0.00',
    ...over,
  };
}

/** Fonbet с 12 ставками (2 в игре на 1 320 ₽), Winline без ставок и скрытый Pari. */
export function bookmakersOut(over: Partial<BookmakerList> = {}): BookmakerList {
  return {
    currency: 'RUB',
    items: [
      bookmakerOut({ id: 1, name: 'Fonbet', bets: 12, open_bets: 2, in_play: '1320.00' }),
      bookmakerOut({ id: 2, name: 'Winline', bets: 0 }),
      bookmakerOut({ id: 3, name: 'Pari', bets: 3, archived_at: '2026-10-10T09:00:00Z' }),
    ],
    ...over,
  };
}
