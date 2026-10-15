import type { IconName } from '../../components';
import { paths } from '../paths';

// Пункты меню — как NAV и TABS в макете (mockup/js/app.js). Подписи — nav.<id> в ru.json.
export type NavId =
  | 'dashboard'
  | 'new'
  | 'bets'
  | 'players'
  | 'analytics'
  | 'learning'
  | 'costs'
  | 'profile'
  | 'admin';

export interface NavItem {
  id: NavId;
  to: string;
  icon: IconName;
}

export interface NavGroup {
  id: 'work' | 'model' | 'manage';
  label: 'groupWork' | 'groupModel' | 'groupManage';
  /** Группа «Управление» видна только роли admin. */
  adminOnly?: boolean;
  items: NavItem[];
}

export const NAV_ITEMS: Record<NavId, NavItem> = {
  dashboard: { id: 'dashboard', to: paths.home, icon: 'home' },
  new: { id: 'new', to: paths.newAnalysis, icon: 'plus' },
  bets: { id: 'bets', to: paths.bets, icon: 'ticket' },
  players: { id: 'players', to: paths.players, icon: 'users' },
  analytics: { id: 'analytics', to: paths.analytics, icon: 'chart' },
  learning: { id: 'learning', to: paths.learning(), icon: 'brain' },
  costs: { id: 'costs', to: paths.costs, icon: 'coins' },
  profile: { id: 'profile', to: paths.profile(), icon: 'user' },
  // Пункт меню ведет к «Обзору» раздела (этап 4): дела, бюджет ключа, последние действия
  admin: { id: 'admin', to: paths.admin(), icon: 'admin' },
};

export const NAV_GROUPS: NavGroup[] = [
  {
    id: 'work',
    label: 'groupWork',
    items: [NAV_ITEMS.dashboard, NAV_ITEMS.new, NAV_ITEMS.bets, NAV_ITEMS.players],
  },
  {
    id: 'model',
    label: 'groupModel',
    items: [NAV_ITEMS.analytics, NAV_ITEMS.learning, NAV_ITEMS.costs],
  },
  { id: 'manage', label: 'groupManage', adminOnly: true, items: [NAV_ITEMS.admin] },
];

/** Нижние вкладки на телефоне: «Анализ» — круглая кнопка посередине, «Еще» открывает шторку. */
export const TAB_ITEMS: NavItem[] = [NAV_ITEMS.dashboard, NAV_ITEMS.bets, NAV_ITEMS.new, NAV_ITEMS.analytics];

/** Разделы в шторке «Еще»; «Администрирование» — только роли admin. */
export const MORE_ITEMS: NavItem[] = [
  NAV_ITEMS.players,
  NAV_ITEMS.learning,
  NAV_ITEMS.costs,
  NAV_ITEMS.profile,
  NAV_ITEMS.admin,
];

export function visibleMoreItems(isAdmin: boolean): NavItem[] {
  return MORE_ITEMS.filter((item) => isAdmin || item.id !== 'admin');
}
