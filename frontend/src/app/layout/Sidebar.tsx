import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Chip, Icon, Spinner } from '../../components';
import { decisionsCount, useAdminAttention } from '../../features/admin/useAdminAttention';
import { paths } from '../paths';
import { BrandMark } from './BrandMark';
import { useInstallTitle } from './InstallModal';
import { NAV_GROUPS, NAV_ITEMS, type NavId } from './nav';
import { OpenBetsBadge } from './OpenBetsBadge';
import { ThemeNavButton } from './ThemeNavButton';

interface SidebarProps {
  navId: NavId | undefined;
  isAdmin: boolean;
  onLogout: () => void;
  /** Идет выход (отзыв push и /auth/logout): кнопка «Выйти» неактивна, с индикатором. */
  loggingOut?: boolean;
  /** «Установить приложение» — окно установки. */
  onInstall: () => void;
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
export function Sidebar({ navId, isAdmin, onLogout, loggingOut = false, onInstall }: SidebarProps) {
  const { t } = useTranslation();
  const installTitle = useInstallTitle();
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
              {item.id === 'bets' && <OpenBetsBadge place="sidebar" />}
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
        <button type="button" className="nav-link" onClick={onInstall}>
          <Icon name="download" />
          {installTitle}
        </button>
        <ThemeNavButton />
        <button type="button" className="nav-link" onClick={onLogout} disabled={loggingOut} aria-busy={loggingOut || undefined}>
          {loggingOut ? <Spinner size="sm" decorative /> : <Icon name="logout" />}
          {t('nav.logout')}
        </button>
      </div>
    </aside>
  );
}
