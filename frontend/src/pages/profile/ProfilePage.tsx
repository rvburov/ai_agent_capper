import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { paths, PROFILE_TABS, type ProfileTab } from '../../app/paths';
import { Card, EmptyState, Tabs, type IconName } from '../../components';
import { useSuspiciousCandidates } from '../../features/profile/useLoginEvents';
import { useSuspiciousLogin } from '../../features/profile/useSuspiciousLogin';
import { useAiBudget } from '../../features/ai/useAiBudget';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { BankTab } from './bank/BankTab';
import { KeyTab, keyNeedsAttention } from './KeyTab';
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

// Вкладки следующих этапов (docs/PLAN.md, раздел 10): центр уведомлений и данные — этап 4
// (волна 5); push-переключатели этап 6 добавит в уже готовую вкладку «Уведомления».
// «Ключ Claude» — этап 3 (два режима ключа, Р7 и Р12), «Банк и стратегия» — этап 4
type StubTab = Exclude<ProfileTab, 'profile' | 'security' | 'key' | 'bank'>;
const STAGES: Record<StubTab, number> = { notifications: 4, data: 4 };
const READY: readonly ProfileTab[] = ['profile', 'security', 'key', 'bank'];

function isStubTab(tab: ProfileTab): tab is StubTab {
  return !READY.includes(tab);
}

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
        {isStubTab(active) && (
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
