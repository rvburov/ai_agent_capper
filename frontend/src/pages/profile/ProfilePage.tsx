import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { paths, PROFILE_TABS, type ProfileTab } from '../../app/paths';
import { Card, EmptyState, Tabs, type IconName } from '../../components';
import { useLoginEvents } from '../../features/profile/useLoginEvents';
import { useSuspiciousLogin } from '../../features/profile/useSuspiciousLogin';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { ProfileHero } from './ProfileHero';
import { ProfileTabPanel } from './ProfileTabPanel';
import { SecurityTab } from './SecurityTab';
import './profile.css';

const ICONS: Record<ProfileTab, IconName> = {
  profile: 'user',
  security: 'shield',
  bank: 'wallet',
  key: 'key',
  notifications: 'bell',
  data: 'database',
};

// Вкладки следующих этапов (docs/PLAN.md, раздел 10): банк и стратегия, ключ Claude и данные —
// личный кабинет этапа 4; выбор уведомлений вместе с push — этап 6
type StubTab = Exclude<ProfileTab, 'profile' | 'security'>;
const STAGES: Record<StubTab, number> = { bank: 4, key: 4, notifications: 6, data: 4 };

function isProfileTab(value: string): value is ProfileTab {
  return (PROFILE_TABS as readonly string[]).includes(value);
}

/** Личный кабинет (mockup/js/screens/profile.js): сводка, вкладки-адреса /profile/<вкладка>. */
export function ProfilePage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const events = useLoginEvents();
  const suspicious = useSuspiciousLogin(me?.id ?? 0, events.data);

  if (tab !== undefined && (!isProfileTab(tab) || tab === 'profile')) {
    return <Navigate to={paths.profile()} replace />;
  }
  // Страница внутри RequireAuth: профиль уже загружен
  if (!me) return null;
  const active: ProfileTab = tab ?? 'profile';

  return (
    <>
      <ProfileHero me={me} suspicious={suspicious.event} />
      <Tabs
        label={t('profile.tabsLabel')}
        panelId="profile-panel"
        active={active}
        className="profile-tabs"
        items={PROFILE_TABS.map((id) => ({
          id,
          icon: ICONS[id],
          to: paths.profile(id),
          label: (
            <>
              {mobile ? t(`profile.tabsShort.${id}`) : t(`profile.tabs.${id}`)}
              {id === 'security' && suspicious.event && (
                <>
                  <span className="profile-tab-dot" aria-hidden="true" />
                  <span className="sr-only">{t('profile.tabAttention')}</span>
                </>
              )}
            </>
          ),
        }))}
      />
      <div
        id="profile-panel"
        className="profile-panel"
        role="tabpanel"
        tabIndex={-1}
        aria-label={t(`profile.tabs.${active}`)}
      >
        {active === 'profile' && <ProfileTabPanel me={me} />}
        {active === 'security' && (
          <SecurityTab me={me} suspicious={suspicious.event} onDismissSuspicious={suspicious.dismiss} />
        )}
        {active !== 'profile' && active !== 'security' && (
          <Card>
            <EmptyState
              className="profile-stub"
              icon={ICONS[active]}
              title={t('stub.stage', { stage: STAGES[active] })}
              text={t(`profile.stubs.${active}`)}
            />
          </Card>
        )}
      </div>
    </>
  );
}
