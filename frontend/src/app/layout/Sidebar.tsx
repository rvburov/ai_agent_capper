import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Chip, Icon } from '../../components';
import { decisionsCount, useAdminAttention } from '../../features/admin/useAdminAttention';
import { paths } from '../paths';
import { BrandMark } from './BrandMark';
import { NAV_GROUPS, NAV_ITEMS, type NavId } from './nav';
import { ThemeNavButton } from './ThemeNavButton';

interface SidebarProps {
  navId: NavId | undefined;
  isAdmin: boolean;
  onLogout: () => void;
}

/**
 * Счетчик дел администратора у пункта меню (nav-badge макета): просьбы вернуть ключ и участники
 * у лимита — то же число, что в «Обзоре» и на главной. Дел нет — ничего.
 */
function AdminBadge() {
  const { t } = useTranslation();
  const count = decisionsCount(useAdminAttention().data);
  if (!count) return null;
  return (
    <>
      <Chip kind="info" className="nav-badge">
        <span aria-hidden="true">{count}</span>
      </Chip>
      <span className="sr-only">{t('admin.overview.decisions.tabNote', { count })}</span>
    </>
  );
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
              {item.id === 'admin' && isAdmin && <AdminBadge />}
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
