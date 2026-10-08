import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { api, unwrap } from '../../api/client';
import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Button, Card, KeyValue, Skeleton } from '../../components';
import { accountKeys } from '../../features/profile/keys';

/** «Доступ к аккаунту»: роль, способ входа; администратору — сколько участников и приглашений. */
export function AccessCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const admin = me.role === 'admin';
  return (
    <Card
      title={t('profile.access.title')}
      subtitle={t('profile.access.subtitle')}
      foot={
        admin ? (
          <>
            <Button icon="admin" to={paths.admin('users')}>
              {t('profile.access.toAdmin')}
            </Button>
            <Button kind="ghost" icon="userPlus" to={paths.admin('invites')}>
              {t('profile.access.invite')}
            </Button>
          </>
        ) : undefined
      }
    >
      <KeyValue
        items={[
          {
            label: t('profile.access.role'),
            value: admin ? t('profile.access.roleAdmin') : t('profile.access.roleMember'),
          },
          { label: t('profile.access.login'), value: t('profile.access.loginValue') },
          admin
            ? { label: t('profile.access.people'), value: <PeopleSummary me={me} /> }
            : { label: t('profile.access.others'), value: t('profile.access.othersValue') },
        ]}
      />
      <p className="xsmall muted">
        {admin ? t('profile.access.noteAdmin') : t('profile.access.noteMember')}
      </p>
    </Card>
  );
}

/** «3 человека · 1 приглашение ждет» — только администратору (данные кабинета администратора). */
function PeopleSummary({ me }: { me: Me }) {
  const { t } = useTranslation();
  const users = useQuery({
    queryKey: accountKeys.adminPeople,
    queryFn: () => unwrap(api.GET('/api/admin/users')),
  });
  const invites = useQuery({
    queryKey: accountKeys.adminInvites,
    queryFn: () => unwrap(api.GET('/api/admin/invites', { params: { query: { status: 'active' } } })),
  });
  if (users.isError) return '—';
  if (!users.data) return <Skeleton width={110} />;
  const others = users.data.filter((u) => u.id !== me.id && u.status !== 'deleted').length;
  const waiting = invites.data?.length ?? 0;
  const text = [
    t('profile.access.peopleCount', { count: others }),
    waiting > 0 ? t('profile.access.invitesWaiting', { count: waiting }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <Link className="profile-kv-link" to={paths.admin('users')}>
      {text}
    </Link>
  );
}
