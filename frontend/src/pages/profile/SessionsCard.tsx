import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout, Card, Chip, Skeleton, useToast } from '../../components';
import { deviceIcon, deviceName, lowerFirst, maskIp } from '../../features/profile/devices';
import type { Session } from '../../features/profile/types';
import { useEndOtherSessions, useEndSession, useSessions } from '../../features/profile/useSessions';
import { formatDateTime } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { LoadError } from './LoadError';
import { MetaLine, ProfileItem } from './ProfileItem';

// Текущий сеанс первым, остальные — по последней активности
function ordered(list: readonly Session[]): Session[] {
  return [...list].sort((a, b) =>
    a.current !== b.current ? (a.current ? -1 : 1) : Date.parse(b.last_seen_at) - Date.parse(a.last_seen_at),
  );
}

/** «Активные сеансы» (sessionsCard макета): где открыт аккаунт, «Завершить» и выход на других. */
export function SessionsCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const sessions = useSessions();
  const endOne = useEndSession();
  const endOthers = useEndOtherSessions();
  const [confirming, setConfirming] = useState(false);
  const endButton = useRef<HTMLButtonElement>(null);
  const unknown = t('profile.unknownDevice');

  const list = sessions.data ? ordered(sessions.data) : [];
  const current = list.find((s) => s.current);
  const others = list.filter((s) => !s.current);

  function onEnd(session: Session) {
    const name = deviceName(session.device_label, unknown);
    endOne.mutate(session.id, {
      onSuccess: () => toast.show(t('profile.sessions.ended', { name }), { icon: 'logout' }),
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  function onEndOthers() {
    endOthers.mutate(undefined, {
      onSuccess: () => {
        setConfirming(false);
        toast.show(t('profile.sessions.endedOthers'), { icon: 'logout' });
      },
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  let foot;
  if (!sessions.data) foot = undefined;
  else if (others.length === 0) foot = <span className="small muted">{t('profile.sessions.none')}</span>;
  else if (!confirming) {
    foot = (
      <Button
        ref={endButton}
        icon="logout"
        onClick={() => {
          setConfirming(true);
          // Фокус — на «Да, завершить», как в макете
          requestAnimationFrame(() => document.getElementById('profile-sessions-yes')?.focus());
        }}
      >
        {t('profile.sessions.endOthers')}
      </Button>
    );
  } else {
    foot = (
      <div className="profile-confirm">
        <Callout kind="warn">
          {t('profile.sessions.confirm', {
            count: others.length,
            list: [...new Set(others.map((s) => deviceName(s.device_label, unknown)))].join(', '),
            current: current ? deviceName(current.device_label, unknown) : unknown,
          })}
        </Callout>
        <div className="row">
          <Button
            id="profile-sessions-yes"
            kind="danger"
            icon="logout"
            loading={endOthers.isPending}
            onClick={onEndOthers}
          >
            {t('profile.sessions.confirmYes')}
          </Button>
          <Button
            kind="ghost"
            onClick={() => {
              setConfirming(false);
              requestAnimationFrame(() => endButton.current?.focus());
            }}
          >
            {t('profile.form.cancel')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card
      id="profile-sessions"
      className="profile-anchor"
      title={t('profile.sessions.title')}
      subtitle={t('profile.sessions.subtitle')}
      foot={foot}
    >
      {sessions.isPending && <Skeleton lines={2} height={18} />}
      {sessions.isError && <LoadError error={sessions.error} onRetry={() => void sessions.refetch()} />}
      {sessions.data && (
        <div className={mobile ? 'profile-list' : 'profile-sessions'}>
          {list.map((session) => {
            const name = deviceName(session.device_label, unknown);
            return (
              <ProfileItem
                key={session.id}
                below={!mobile}
                icon={deviceIcon(session.device_label)}
                iconKind={session.current ? 'good' : undefined}
                title={name}
                titleExtra={
                  session.current ? (
                    <Chip kind="accent" icon="check">
                      {t('profile.sessions.current')}
                    </Chip>
                  ) : undefined
                }
                meta={
                  <MetaLine
                    parts={[
                      <span key="ip" className="profile-ip">
                        {maskIp(session.ip)}
                      </span>,
                      session.current
                        ? t('profile.sessions.activeNow')
                        : lowerFirst(formatDateTime(session.last_seen_at)),
                    ]}
                  />
                }
                side={
                  session.current ? undefined : (
                    <Button
                      kind={mobile ? 'ghost' : 'secondary'}
                      size="sm"
                      aria-label={t('profile.sessions.endLabel', { name })}
                      loading={endOne.isPending && endOne.variables === session.id}
                      onClick={() => onEnd(session)}
                    >
                      {t('profile.sessions.end')}
                    </Button>
                  )
                }
              />
            );
          })}
        </div>
      )}
    </Card>
  );
}
