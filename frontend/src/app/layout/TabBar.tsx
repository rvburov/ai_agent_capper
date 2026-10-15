import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Icon } from '../../components';
import { MORE_ITEMS, TAB_ITEMS, type NavId } from './nav';
import { OpenBetsBadge } from './OpenBetsBadge';

interface TabBarProps {
  navId: NavId | undefined;
  moreOpen: boolean;
  onMore: () => void;
}

/** Нижние вкладки на телефоне: Главная, Ставки, Анализ (круглая кнопка), Аналитика, Еще. */
export function TabBar({ navId, moreOpen, onMore }: TabBarProps) {
  const { t } = useTranslation();
  const inMore = MORE_ITEMS.some((item) => item.id === navId);
  return (
    <nav className="tabbar" aria-label={t('nav.bottomLabel')}>
      {TAB_ITEMS.map((item) => {
        const current = navId === item.id ? 'page' : undefined;
        if (item.id === 'new') {
          return (
            <Link key={item.id} className="tab tab-primary" to={item.to} aria-current={current}>
              <span className="tab-plus">
                <Icon name={item.icon} />
              </span>
              {t('nav.tabAnalysis')}
            </Link>
          );
        }
        return (
          <Link key={item.id} className="tab" to={item.to} aria-current={current}>
            <Icon name={item.icon} />
            {t(`nav.${item.id}`)}
            {item.id === 'bets' && <OpenBetsBadge place="tabbar" />}
          </Link>
        );
      })}
      <button
        type="button"
        className="tab"
        aria-current={inMore ? 'page' : undefined}
        aria-haspopup="dialog"
        aria-expanded={moreOpen}
        onClick={onMore}
      >
        <Icon name="menu" />
        {t('nav.more')}
      </button>
    </nav>
  );
}
