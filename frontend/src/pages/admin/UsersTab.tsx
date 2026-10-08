import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import {
  ActionMenu,
  Callout,
  Card,
  Chip,
  DataTable,
  EmptyState,
  Meter,
  Segmented,
  Skeleton,
  type DataColumn,
} from '../../components';
import { spendMonth, whenInline } from '../../features/admin/display';
import { formatLimitUsd, limitShort } from '../../features/admin/limits';
import {
  matchesFilter,
  personName,
  sortPeople,
  spendShare,
  USER_FILTERS,
  visiblePeople,
  type UserFilter,
} from '../../features/admin/people';
import type { AdminUser } from '../../features/admin/types';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { cx } from '../../lib/cx';
import { formatDate, formatDateTime, formatPercent, formatUsd } from '../../lib/format';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { NARROW_QUERY } from './media';
import { Avatar, LoadError, RoleChip, StatusChip, TwoFactorChip } from './parts';
import { useUserActions } from './UserActions';

/** Вкладка «Участники» (PANELS.users макета): таблица на компьютере, карточки на узком экране. */
export function UsersTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const narrow = useMediaQuery(NARROW_QUERY);
  const users = useAdminUsers();
  const actions = useUserActions(me);
  const [filter, setFilter] = useState<UserFilter>('all');
  const month = spendMonth();

  const all = users.data ? visiblePeople(users.data) : [];
  const rows = sortPeople(all.filter((u) => matchesFilter(u, filter)), me.id);
  const menu = (user: AdminUser) => (
    <ActionMenu
      title={user.id === me.id ? t('admin.menu.titleMe', { name: personName(user) }) : personName(user)}
      label={t('admin.menu.label', { name: personName(user) })}
      items={actions.itemsFor(user)}
    />
  );

  const filters = (
    <div className="adm-toolbar">
      <Segmented
        label={t('admin.users.filterLabel')}
        items={USER_FILTERS.map((id) => ({
          value: id,
          label: t(`admin.users.filters.${id}`, { count: all.filter((u) => matchesFilter(u, id)).length }),
        }))}
        value={filter}
        onChange={setFilter}
      />
    </div>
  );
  const privacy = (
    <Callout kind="info" icon="eyeOff">
      <b>{t('admin.users.privacyStrong')}</b> {t('admin.users.privacy')}
    </Callout>
  );

  let content;
  if (users.isPending) content = <Skeleton lines={4} height={18} />;
  else if (users.isError) content = <LoadError error={users.error} onRetry={() => void users.refetch()} />;

  if (narrow) {
    return (
      <div className="stack">
        {content ?? (
          <>
            {filters}
            {privacy}
            {rows.length ? (
              <div className="adm-ucards">
                {rows.map((user) => (
                  <UserCardItem key={user.id} user={user} me={me} menu={menu(user)} month={month} />
                ))}
              </div>
            ) : (
              <EmptyState>{t('admin.users.empty')}</EmptyState>
            )}
          </>
        )}
        {actions.dialogs}
      </div>
    );
  }

  const columns: DataColumn<AdminUser>[] = [
    {
      key: 'person',
      label: t('admin.users.columns.person'),
      render: (user) => (
        <div className="adm-person">
          <Avatar user={user} meId={me.id} className={cx(user.status === 'blocked' && 'adm-dim')} />
          <div>
            <div className={cx('adm-person-name', user.status === 'blocked' && 'adm-dim')}>
              <span className="adm-nowrap">{personName(user)}</span>
              {user.id === me.id && <MeChip />}
            </div>
            <div className={cx('adm-person-mail adm-nowrap', user.status === 'blocked' && 'adm-dim')}>
              {user.email}
            </div>
            <div className="row adm-chips" style={{ marginTop: 6 }}>
              <RoleChip role={user.role} />
              <StatusChip status={user.status} />
            </div>
          </div>
        </div>
      ),
    },
    { key: 'key', label: t('admin.users.columns.key'), render: (user) => <KeyCell user={user} /> },
    {
      key: 'spend',
      label: t('admin.users.columns.spend', { month }),
      render: (user) => <SpendBlock user={user} />,
    },
    {
      key: 'analyses',
      label: t('admin.users.columns.analyses'),
      align: 'r',
      render: (user) => (
        <div className="adm-cell2 r">
          <span className="mono">{user.analyses_month}</span>
          <span className="adm-sub">
            {dailyLimit(user) !== null
              ? t('admin.users.analysesDaily', { count: dailyLimit(user) })
              : t('admin.users.analysesSub')}
          </span>
        </div>
      ),
    },
    {
      key: 'login',
      label: t('admin.users.columns.login'),
      render: (user) => (
        <div className="adm-cell2">
          <span className="adm-nowrap">
            {user.last_login_at ? formatDateTime(user.last_login_at) : t('admin.users.never')}
          </span>
          <span className={cx('adm-sub', !user.totp_enabled && 'warn-text')}>
            {user.totp_enabled ? t('admin.totpOn') : t('admin.totpOff')}
          </span>
        </div>
      ),
    },
    { key: 'menu', label: '', align: 'r', render: menu },
  ];

  return (
    <>
      <Card
        title={t('admin.users.title')}
        subtitle={t('admin.users.subtitle', { count: all.length, month })}
        flush
      >
        <div className="adm-users-top">
          {content ?? (
            <>
              {filters}
              {privacy}
            </>
          )}
        </div>
        {!content && (
          <div className="adm-users-wrap">
            <DataTable
              className="adm-users-table"
              caption={t('admin.users.caption')}
              columns={columns}
              rows={rows}
              rowKey={(user) => user.id}
              empty={t('admin.users.empty')}
              mobileLayout="table"
            />
          </div>
        )}
      </Card>
      {actions.dialogs}
    </>
  );
}

function MeChip() {
  const { t } = useTranslation();
  return <Chip kind="accent">{t('admin.you')}</Chip>;
}

/** Анализов в день по личному лимиту на ключе администратора; на своем ключе лимит задает участник. */
function dailyLimit(user: AdminUser): number | null {
  return user.ai_mode === 'shared' && user.limit ? user.limit.daily_analyses : null;
}

/** «Ключ администратора · $10 · 3 в день · $1» или «Свой ключ · лимиты задает сам». */
function KeyCell({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  if (user.ai_mode === 'own') {
    return (
      <div className="adm-cell2">
        <span className="adm-nowrap">{t('admin.users.keyOwn')}</span>
        <span className="adm-sub">{t('admin.users.ownLimits')}</span>
      </div>
    );
  }
  return (
    <div className="adm-cell2">
      <span className="adm-nowrap">{t('admin.users.keyShared')}</span>
      <span className="adm-sub">{user.limit ? limitShort(user.limit) : t('admin.users.noLimit')}</span>
    </div>
  );
}

/** Расход ИИ за месяц на ключе администратора и доля личного лимита (spendBlock макета). */
function SpendBlock({ user }: { user: AdminUser }) {
  const { t } = useTranslation();
  const spent = formatUsd(user.ai_spent_month_usd);
  const dim = user.status === 'blocked' && 'adm-dim';
  if (user.ai_mode === 'own') {
    return (
      <div className={cx('adm-spend', dim)}>
        <div className="adm-spend-top">
          <span>
            <b>{t('admin.users.ownAccount')}</b>
          </span>
          <span className="muted">{t('admin.users.outOfBudget')}</span>
        </div>
        {user.ai_spent_month_usd > 0 && (
          <span className="adm-sub">{t('admin.users.onYourKey', { amount: spent })}</span>
        )}
      </div>
    );
  }
  if (!user.limit) {
    return (
      <div className={cx('adm-spend', dim)}>
        <div className="adm-spend-top">
          <span>
            <b>{spent}</b>
          </span>
          <span className="muted">{t('admin.users.inBudget')}</span>
        </div>
      </div>
    );
  }
  const { share, tone } = spendShare(user);
  const limit = formatLimitUsd(user.limit.monthly_usd);
  return (
    <div className={cx('adm-spend', dim)}>
      <div className="adm-spend-top">
        <span>
          <b>{spent}</b> {t('admin.users.spendOf', { limit })}
        </span>
        <span className={tone ? `${tone}-text` : 'muted'}>{formatPercent(share, { digits: 0 })}</span>
      </div>
      <Meter
        value={user.ai_spent_month_usd}
        max={user.limit.monthly_usd}
        kind={tone ?? undefined}
        label={t('admin.users.spentAria', { spent, limit })}
      />
      {user.limit.paused && (
        <Chip kind="warn" icon="pause" className="adm-self-start">
          {t('admin.users.paused')}
        </Chip>
      )}
    </div>
  );
}

interface UserCardItemProps {
  user: AdminUser;
  me: Me;
  menu: ReactNode;
  month: string;
}

/** Карточка участника на узком экране (userCard макета). */
function UserCardItem({ user, me, menu, month }: UserCardItemProps) {
  const { t } = useTranslation();
  const blocked = user.status === 'blocked';
  const daily = dailyLimit(user);
  return (
    <section className="card adm-ucard" aria-label={personName(user)}>
      <div className="adm-ucard-head">
        <Avatar user={user} meId={me.id} className={cx(blocked && 'adm-dim')} />
        <div style={{ minWidth: 0 }}>
          <div className="adm-person-name">
            {personName(user)}
            {user.id === me.id && <MeChip />}
          </div>
          <div className="adm-person-mail">{user.email}</div>
        </div>
        {menu}
      </div>
      <div className="row adm-chips">
        <RoleChip role={user.role} />
        <StatusChip status={user.status} />
        <Chip kind={user.ai_mode === 'own' ? 'info' : 'outline'} icon="key">
          {user.ai_mode === 'own' ? t('admin.users.keyOwn') : t('admin.users.keyShared')}
        </Chip>
      </div>
      <SpendBlock user={user} />
      <dl className="adm-facts two">
        <div>
          <dt>{t('admin.users.factMonth', { month })}</dt>
          <dd>{t('admin.users.analyses', { count: user.analyses_month })}</dd>
        </div>
        {daily !== null ? (
          <div>
            <dt>{t('admin.users.factDaily')}</dt>
            <dd>{t('admin.users.analyses', { count: daily })}</dd>
          </div>
        ) : (
          <div>
            <dt>{t('admin.users.factSince')}</dt>
            <dd>{formatDate(user.created_at, { year: 'always' })}</dd>
          </div>
        )}
      </dl>
      <div className="row" style={{ gap: '6px 10px' }}>
        <TwoFactorChip enabled={user.totp_enabled} />
        <span className="xsmall muted">
          {t('admin.users.loginShort', {
            when: user.last_login_at ? whenInline(user.last_login_at) : t('admin.users.never'),
          })}
        </span>
      </div>
    </section>
  );
}

