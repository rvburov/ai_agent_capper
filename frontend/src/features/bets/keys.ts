import type { BetFiltersQuery, BetListQuery } from './types';

// Ключи запросов «Ставок»: по одному месту на ресурс. all — префикс всех списков, итогов и
// карточек: расчет, сторно и закрытие сбрасывают его целиком.
export const betKeys = {
  all: ['bets'] as const,
  list: (query: Omit<BetListQuery, 'before'>) => ['bets', 'list', query] as const,
  summary: (query: BetFiltersQuery) => ['bets', 'summary', query] as const,
  one: (id: number) => ['bets', 'one', id] as const,
};

// Экраны, которые считают по ставкам и банку: главная и «Аналитика» (волна 3 этапа 4) кладут
// свои запросы под эти префиксы — расчет ставки сбрасывает и их.
export const DASHBOARD_PREFIX = ['dashboard'] as const;
export const ANALYTICS_PREFIX = ['analytics'] as const;
