import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe, type Me } from '../../api/hooks/useMe';
import { ADMIN_TABS, paths, type AdminTab } from '../../app/paths';
import { Button, Icon, Skeleton, Tabs, type IconName } from '../../components';
import { summarize } from '../../features/admin/people';
import { decisionsCount, useAdminAttention } from '../../features/admin/useAdminAttention';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { useInvites } from '../../features/admin/useInvites';
import { AccessTab } from './AccessTab';
import { AuditTab } from './AuditTab';
import { DataTab } from './DataTab';
import { InviteModal } from './InviteModal';
import { InvitesTab } from './InvitesTab';
import { KeyTab } from './KeyTab';
import { MessagesTab } from './MessagesTab';
import { OverviewTab } from './OverviewTab';
import { SettingsTab } from './SettingsTab';
import { SummaryTab } from './SummaryTab';
import { UsageTab } from './UsageTab';
import { UsersTab } from './UsersTab';
import './admin.css';

const ICONS: Record<AdminTab, IconName> = {
  overview: 'layers',
  users: 'users',
  summary: 'chart',
  invites: 'userPlus',
  access: 'lock',
  key: 'key',
  usage: 'coins',
  data: 'database',
  settings: 'sliders',
  audit: 'history',
  message: 'megaphone',
};

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
  const decisions = useDecisionsCount();

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
          label:
            id === 'overview' && decisions > 0 ? (
              <>
                {t('admin.tabs.overview')}
                <span className="adm-tab-dot" aria-hidden="true" />
                <span className="sr-only">{t('admin.overview.decisions.tabNote', { count: decisions })}</span>
              </>
            ) : (
              t(`admin.tabs.${id}`)
            ),
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
        {active === 'overview' && <OverviewTab me={me} />}
        {active === 'users' && <UsersTab me={me} />}
        {active === 'summary' && <SummaryTab me={me} />}
        {active === 'invites' && <InvitesTab onInvite={openInvite} />}
        {active === 'access' && <AccessTab me={me} />}
        {active === 'key' && <KeyTab me={me} />}
        {active === 'usage' && <UsageTab me={me} />}
        {active === 'data' && <DataTab />}
        {active === 'settings' && <SettingsTab />}
        {active === 'audit' && <AuditTab />}
        {active === 'message' && <MessagesTab me={me} />}
      </div>
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
    </>
  );
}

/** Сколько дел ждет решения — точка у вкладки «Обзор» (drawTabs макета); дела решает сервер. */
function useDecisionsCount(): number {
  return decisionsCount(useAdminAttention().data);
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
