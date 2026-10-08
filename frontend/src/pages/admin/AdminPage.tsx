import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe, type Me } from '../../api/hooks/useMe';
import { ADMIN_TABS, paths, type AdminTab } from '../../app/paths';
import { Button, Card, EmptyState, Icon, Skeleton, Tabs, type IconName } from '../../components';
import { summarize } from '../../features/admin/people';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { useInvites } from '../../features/admin/useInvites';
import { AccessTab } from './AccessTab';
import { AuditTab } from './AuditTab';
import { InviteModal } from './InviteModal';
import { InvitesTab } from './InvitesTab';
import { UsersTab } from './UsersTab';
import './admin.css';

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

// Вкладки следующих этапов (docs/PLAN.md, раздел 10): ключ Claude, бюджет и лимиты — этап 3;
// обзор с бюджетом, расход ИИ по людям, настройки (валюта) и сообщения в центр уведомлений — этап 4
type StubTab = Exclude<AdminTab, 'users' | 'invites' | 'access' | 'audit'>;
const STAGES: Record<StubTab, number> = { overview: 4, key: 3, usage: 4, settings: 4, message: 4 };

function isAdminTab(value: string): value is AdminTab {
  return (ADMIN_TABS as readonly string[]).includes(value);
}

/**
 * Кабинет администратора (mockup/js/screens/admin.js): шапка с «Пригласить» и вкладки-адреса
 * /admin/<вкладка>. Об участниках — только учетная запись, активность и расход на ИИ (Р14).
 * Страница внутри RequireAdmin: участник сюда не попадает, а сервер отвечает ему 403.
 */
export function AdminPage() {
  const { t } = useTranslation();
  const { tab } = useParams();
  const { data: me } = useMe();
  const [inviteOpen, setInviteOpen] = useState(false);

  if (tab !== undefined && (!isAdminTab(tab) || tab === 'overview')) {
    return <Navigate to={paths.admin()} replace />;
  }
  if (!me) return null;
  const active: AdminTab = tab ?? 'overview';
  const openInvite = () => setInviteOpen(true);

  return (
    <>
      <AdminHead me={me} onInvite={openInvite} />
      <Tabs
        label={t('admin.tabsLabel')}
        panelId="admin-panel"
        active={active}
        className="adm-tabs"
        items={ADMIN_TABS.map((id) => ({
          id,
          label: t(`admin.tabs.${id}`),
          icon: ICONS[id],
          to: paths.admin(id),
        }))}
      />
      <div
        id="admin-panel"
        className="adm-panel"
        role="tabpanel"
        tabIndex={-1}
        aria-label={t(`admin.tabs.${active}`)}
      >
        {active === 'users' && <UsersTab me={me} />}
        {active === 'invites' && <InvitesTab onInvite={openInvite} />}
        {active === 'access' && <AccessTab me={me} />}
        {active === 'audit' && <AuditTab />}
        {active !== 'users' && active !== 'invites' && active !== 'access' && active !== 'audit' && (
          <Card>
            <EmptyState
              className="adm-stub"
              icon={ICONS[active]}
              title={t('stub.stage', { stage: STAGES[active] })}
              text={t(`admin.stubs.${active}`)}
            />
          </Card>
        )}
      </div>
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </>
  );
}

/** Шапка раздела (headBlock макета): кто вы, сколько людей и приглашений, «Пригласить». */
function AdminHead({ me, onInvite }: { me: Me; onInvite: () => void }) {
  const { t } = useTranslation();
  const users = useAdminUsers();
  const invites = useInvites();

  let lead;
  if (users.data) {
    const s = summarize(users.data);
    const facts = [t('admin.head.active', { count: s.active })];
    if (s.blocked) facts.push(t('admin.head.blocked', { count: s.blocked }));
    facts.push(t('admin.head.admins', { count: s.admins }));
    const waiting = invites.data?.filter((i) => i.status === 'active').length ?? 0;
    lead = (
      <p className="lead">
        {t('admin.head.lead', {
          people: t('admin.head.people', { count: s.total }),
          facts: facts.join(', '),
        })}
        {waiting > 0 && ` ${t('admin.head.invites', { count: waiting })}`}
      </p>
    );
  } else if (users.isPending) {
    lead = (
      <p className="lead">
        <Skeleton width={320} />
      </p>
    );
  }

  return (
    <div className="page-head adm-head">
      <div style={{ minWidth: 0 }}>
        <div className="eyebrow">
          <Icon name="admin" />
          {t('admin.head.eyebrow', { name: me.display_name || me.email })}
        </div>
        <h2>{t('admin.head.title')}</h2>
        {lead}
        <div className="adm-private">
          <Icon name="eyeOff" />
          {t('admin.head.private')}
        </div>
      </div>
      <div className="adm-head-actions">
        <Button kind="primary" icon="userPlus" onClick={onInvite}>
          {t('admin.head.invite')}
        </Button>
      </div>
    </div>
  );
}
