import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Chip, Skeleton, useToast } from '../../components';
import { timeLeft, whenInline } from '../../features/admin/display';
import { formatLimitUsd } from '../../features/admin/limits';
import type { Invite } from '../../features/admin/types';
import { useInvites, useRevokeInvite } from '../../features/admin/useInvites';
import { ConfirmDialog, HowTo, Item, LoadError } from './parts';

type Group = 'active' | 'used' | 'old';
const GROUPS: readonly Group[] = ['active', 'used', 'old'];

function groupOf(invite: Invite): Group {
  if (invite.status === 'active') return 'active';
  if (invite.status === 'used') return 'used';
  return 'old';
}

/** Вкладка «Приглашения» (PANELS.invites макета): список по статусам и как это работает. */
export function InvitesTab({ onInvite }: { onInvite: () => void }) {
  const { t } = useTranslation();
  const invites = useInvites();
  const [revoking, setRevoking] = useState<Invite | null>(null);

  let body;
  if (invites.isPending) body = <Skeleton lines={4} height={18} />;
  else if (invites.isError) body = <LoadError error={invites.error} onRetry={() => void invites.refetch()} />;
  else {
    body = GROUPS.map((group) => {
      const list = invites.data.filter((invite) => groupOf(invite) === group);
      return (
        <div key={group} className="adm-group">
          <div className="adm-group-title">
            {t(`admin.invites.groups.${group}`)}
            <Chip kind="outline">{list.length}</Chip>
          </div>
          {list.length ? (
            <div className="adm-list">
              {list.map((invite) => (
                <InviteItem key={invite.id} invite={invite} onRevoke={() => setRevoking(invite)} />
              ))}
            </div>
          ) : (
            <div className="adm-empty">{t(`admin.invites.empty.${group}`)}</div>
          )}
        </div>
      );
    });
  }

  return (
    <div className="adm-main">
      <Card
        title={t('admin.invites.title')}
        subtitle={t('admin.invites.subtitle')}
        actions={
          <Button kind="primary" size="sm" icon="userPlus" onClick={onInvite}>
            {t('admin.head.invite')}
          </Button>
        }
      >
        {body}
      </Card>
      <Card title={t('admin.invites.how.title')} subtitle={t('admin.invites.how.subtitle')}>
        <ol className="adm-steps">
          {(['1', '2', '3', '4'] as const).map((n) => (
            <li key={n}>
              <span>
                <b>{t(`admin.invites.how.s${n}b`)}</b>
                {t(`admin.invites.how.s${n}`)}
              </span>
            </li>
          ))}
        </ol>
        <HowTo>{t('admin.invites.how.consent')}</HowTo>
      </Card>
      {revoking && <RevokeInvite invite={revoking} onClose={() => setRevoking(null)} />}
    </div>
  );
}

function InviteItem({ invite, onRevoke }: { invite: Invite; onRevoke: () => void }) {
  const { t } = useTranslation();
  const key =
    invite.ai_mode === 'own'
      ? t('admin.invites.keyOwn')
      : invite.limit
        ? t('admin.invites.keySharedLimit', { amount: formatLimitUsd(invite.limit.monthly_usd) })
        : t('admin.invites.keyShared');
  const base = <div>{t('admin.invites.meta', { role: t(`admin.role.${invite.role}`), key })}</div>;

  if (invite.status === 'active') {
    return (
      <Item
        icon="mail"
        iconKind="info"
        title={invite.email}
        titleExtra={
          <Chip kind="info" icon="clock">
            {t('admin.invites.chips.active')}
          </Chip>
        }
        meta={
          <>
            {base}
            <div>
              {t('admin.invites.activeMeta', {
                created: whenInline(invite.created_at),
                expires: whenInline(invite.expires_at),
                left: timeLeft(invite.expires_at),
              })}
            </div>
          </>
        }
        side={
          <Button
            size="sm"
            icon="x"
            aria-label={t('admin.invites.revokeLabel', { email: invite.email })}
            onClick={onRevoke}
          >
            {t('admin.invites.revoke')}
          </Button>
        }
      />
    );
  }
  if (invite.status === 'used') {
    return (
      <Item
        icon="check"
        iconKind="good"
        title={invite.email}
        titleExtra={<Chip kind="good">{t('admin.invites.chips.used')}</Chip>}
        meta={
          <>
            {base}
            <div>
              {invite.used_by_name
                ? t('admin.invites.usedMetaName', { when: whenInline(invite.used_at), name: invite.used_by_name })
                : t('admin.invites.usedMeta', { when: whenInline(invite.used_at) })}
            </div>
          </>
        }
      />
    );
  }
  const revoked = invite.status === 'revoked';
  return (
    <Item
      icon={revoked ? 'x' : 'clock'}
      title={invite.email}
      titleExtra={<Chip kind="outline">{t(`admin.invites.chips.${invite.status}`)}</Chip>}
      old
      meta={
        <>
          {base}
          <div>
            {revoked
              ? t('admin.invites.revokedMeta', { when: whenInline(invite.revoked_at ?? invite.created_at) })
              : t('admin.invites.expiredMeta', { when: whenInline(invite.expires_at) })}
          </div>
        </>
      }
    />
  );
}

function RevokeInvite({ invite, onClose }: { invite: Invite; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const revoke = useRevokeInvite();
  return (
    <ConfirmDialog
      title={t('admin.invites.revokeTitle')}
      confirmLabel={t('admin.invites.revoke')}
      icon="x"
      danger
      run={() => revoke.mutateAsync(invite.id)}
      onDone={() => {
        onClose();
        toast.show(t('admin.invites.revokeDone', { email: invite.email }), { icon: 'x' });
      }}
      onClose={onClose}
    >
      <p className="small soft">{t('admin.invites.revokeText', { email: invite.email })}</p>
    </ConfirmDialog>
  );
}
