import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Icon } from '../../components';
import { paths } from '../paths';
import { BrandMark } from './BrandMark';
import { NAV_GROUPS, NAV_ITEMS, type NavId } from './nav';
import { ThemeNavButton } from './ThemeNavButton';

interface SidebarProps {
  navId: NavId | undefined;
  isAdmin: boolean;
  onLogout: () => void;
}

/** Боковая панель на компьютере (на телефоне скрыта, вместо нее нижние вкладки). */
export function Sidebar({ navId, isAdmin, onLogout }: SidebarProps) {
  const { t } = useTranslation();
  return (
    <aside className="sidebar" aria-label={t('nav.mainLabel')}>
      <Link className="brand" to={paths.home}>
        <BrandMark />
        <div>
          <div className="brand-name">{t('app.name')}</div>
          <div className="brand-sub">{t('app.tagline')}</div>
        </div>
      </Link>
      {NAV_GROUPS.filter((group) => !group.adminOnly || isAdmin).map((group) => (
        <Fragment key={group.id}>
          <div className="eyebrow nav-group-label">{t(`nav.${group.label}`)}</div>
          {group.items.map((item) => (
            <Link
              key={item.id}
              className="nav-link"
              to={item.to}
              aria-current={navId === item.id ? 'page' : undefined}
            >
              <Icon name={item.icon} />
              {t(`nav.${item.id}`)}
            </Link>
          ))}
        </Fragment>
      ))}
      <div className="sidebar-foot">
        <Link
          className="nav-link"
          to={NAV_ITEMS.profile.to}
          aria-current={navId === 'profile' ? 'page' : undefined}
        >
          <Icon name="user" />
          {t('nav.profile')}
        </Link>
        <ThemeNavButton />
        <button type="button" className="nav-link" onClick={onLogout}>
          <Icon name="logout" />
          {t('nav.logout')}
        </button>
      </div>
    </aside>
  );
}
