import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { Card, EmptyState, Tabs, type IconName } from '../../components';
import { ADMIN_TABS, paths, type AdminTab } from '../../app/paths';

const ICONS: Record<AdminTab, IconName> = {
  overview: 'layers',
  users: 'users',
  invites: 'userPlus',
  access: 'lock',
  key: 'key',
  usage: 'coins',
  settings: 'sliders',
  audit: 'history',
  message: 'megaphone',
};

function isAdminTab(value: string): value is AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value);
}

/** Кабинет администратора: вкладки-адреса /admin/<вкладка>. Содержимое — следующая сборка этапа 1. */
export function AdminPage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  if (tab !== undefined && (!isAdminTab(tab) || tab === 'overview')) {
    return <Navigate to={paths.admin()} replace />;
  }
  const active: AdminTab = tab ?? 'overview';
  return (
    <>
      <Tabs
        label={t('admin.tabsLabel')}
        panelId="admin-panel"
        active={active}
        items={ADMIN_TABS.map((id) => ({
          id,
          label: t(`admin.tabs.${id}`),
          icon: ICONS[id],
          to: paths.admin(id),
        }))}
      />
      <div id="admin-panel" role="tabpanel" aria-label={t(`admin.tabs.${active}`)}>
        <Card>
          <EmptyState icon={ICONS[active]} title={t('stub.inProgress')} text={t('stub.admin')} />
        </Card>
      </div>
    </>
  );
}
