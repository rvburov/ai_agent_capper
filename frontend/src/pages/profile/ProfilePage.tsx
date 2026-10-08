import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { Card, EmptyState, Tabs, type IconName } from '../../components';
import { paths, PROFILE_TABS, type ProfileTab } from '../../app/paths';

const ICONS: Record<ProfileTab, IconName> = {
  profile: 'user',
  security: 'shield',
  bank: 'wallet',
  key: 'key',
  notifications: 'bell',
  data: 'database',
};

function isProfileTab(value: string): value is ProfileTab {
  return (PROFILE_TABS as readonly string[]).includes(value);
}

/** Личный кабинет: вкладки-адреса /profile/<вкладка>; содержимое — на этапе 4. */
export function ProfilePage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  if (tab !== undefined && (!isProfileTab(tab) || tab === 'profile')) {
    return <Navigate to={paths.profile()} replace />;
  }
  const active: ProfileTab = tab ?? 'profile';
  return (
    <>
      <Tabs
        label={t('profile.tabsLabel')}
        panelId="profile-panel"
        active={active}
        items={PROFILE_TABS.map((id) => ({
          id,
          label: t(`profile.tabs.${id}`),
          icon: ICONS[id],
          to: paths.profile(id),
        }))}
      />
      <div id="profile-panel" role="tabpanel" aria-label={t(`profile.tabs.${active}`)}>
        <Card>
          <EmptyState icon={ICONS[active]} title={t('stub.stage', { stage: 4 })} text={t('stub.profile')} />
        </Card>
      </div>
    </>
  );
}
