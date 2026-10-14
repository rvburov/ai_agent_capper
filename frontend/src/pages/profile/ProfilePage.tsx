import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { paths, PROFILE_TABS, type ProfileTab } from '../../app/paths';
import { Tabs, type IconName } from '../../components';
import { useSuspiciousCandidates } from '../../features/profile/useLoginEvents';
import { useSuspiciousLogin } from '../../features/profile/useSuspiciousLogin';
import { useAiBudget } from '../../features/ai/useAiBudget';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { BankTab } from './bank/BankTab';
import { DataTab } from './data/DataTab';
import { KeyTab, keyNeedsAttention } from './KeyTab';
import { NotificationsTab } from './notifications/NotificationsTab';
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

// Все вкладки работают с этапа 4; push-переключатели и тихие часы во вкладке «Уведомления»
// заработают на этапе 6 (сейчас — неактивны с пометкой)
function isProfileTab(value: string): value is ProfileTab {
  return (PROFILE_TABS as readonly string[]).includes(value);
}

/** Личный кабинет (mockup/js/screens/profile.js): сводка, вкладки-адреса /profile/<вкладка>. */
export function ProfilePage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const candidates = useSuspiciousCandidates();
  const suspicious = useSuspiciousLogin(me?.id ?? 0, candidates.data);
  // Точка у «Ключ Claude»: нет своего ключа или лимит у порога, пауза (tabAttention макета)
  const budget = useAiBudget();

  if (tab !== undefined && (!isProfileTab(tab) || tab === 'profile')) {
    return <Navigate to={paths.profile()} replace />;
  }
  // Страница внутри RequireAuth: профиль уже загружен
  if (!me) return null;
  const active: ProfileTab = tab ?? 'profile';
  const attention: Partial<Record<ProfileTab, boolean>> = {
    security: Boolean(suspicious.event),
    key: keyNeedsAttention(budget.data, me.role === 'admin'),
  };

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
              {attention[id] && (
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
        {active === 'key' && <KeyTab me={me} />}
        {active === 'bank' && <BankTab me={me} />}
        {active === 'notifications' && <NotificationsTab me={me} />}
        {active === 'data' && <DataTab me={me} />}
      </div>
    </>
  );
}
