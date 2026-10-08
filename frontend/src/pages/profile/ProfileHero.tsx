import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { initials } from '../../app/layout/initials';
import { Button, Chip, Icon, Meter, Skeleton } from '../../components';
import { useLogout } from '../../features/auth/useLogout';
import { deviceName } from '../../features/profile/devices';
import { lastSuccessfulLogin } from '../../features/profile/loginLog';
import type { LoginEvent } from '../../features/profile/types';
import { useLoginEvents } from '../../features/profile/useLoginEvents';
import { RECOVERY_CODES_LOW, useRecoveryCodesStatus } from '../../features/profile/useRecoveryCodes';
import { useSessions } from '../../features/profile/useSessions';
import { formatDateLong, formatDateTime } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';

interface Check {
  id: string;
  ok: boolean;
  title: string;
  hint: ReactNode;
}

interface ProfileHeroProps {
  me: Me;
  suspicious: LoginEvent | null;
}

/** Сводка аккаунта (heroCard макета): кто вы, последний вход, сеансы и «Защита аккаунта». */
export function ProfileHero({ me, suspicious }: ProfileHeroProps) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const sessions = useSessions();
  const events = useLoginEvents();
  const codes = useRecoveryCodesStatus();
  const unknown = t('profile.unknownDevice');

  const days = Math.max(0, Math.floor((Date.now() - Date.parse(me.created_at)) / 86_400_000));
  const last = events.data ? lastSuccessfulLogin(events.data) : null;
  const deviceList = sessions.data
    ? [...new Set(sessions.data.map((s) => deviceName(s.device_label, unknown)))].join(', ')
    : null;

  const checks: Check[] = [
    {
      id: 'password',
      ok: true,
      title: t('profile.guard.password'),
      hint: t('profile.guard.passwordHint'),
    },
    {
      id: 'totp',
      ok: me.totp_enabled,
      title: t('profile.guard.totp'),
      hint: me.totp_enabled ? t('profile.guard.totpHint') : t('profile.guard.totpOff'),
    },
    {
      id: 'codes',
      ok: codes.data ? codes.data.total > 0 && codes.data.left >= RECOVERY_CODES_LOW : true,
      title: t('profile.guard.codes'),
      hint: codes.data ? (
        codes.data.total > 0 ? (
          t('profile.guard.codesHint', { left: codes.data.left, total: codes.data.total })
        ) : (
          t('profile.guard.codesNone')
        )
      ) : codes.isError ? (
        '—'
      ) : (
        <Skeleton width={140} height={12} />
      ),
    },
  ];
  const done = checks.filter((c) => c.ok).length;
  const shown = mobile ? checks.filter((c) => !c.ok) : checks;

  return (
    <section className="card profile-hero" aria-label={t('profile.hero.label')}>
      <div className="profile-hero-main">
        <div className="profile-id">
          <div className="profile-avatar" aria-hidden="true">
            {initials(me.display_name, me.email)}
          </div>
          <div className="profile-id-text">
            <h2 className="profile-name">{me.display_name || me.email}</h2>
            <div className="profile-email">{me.email}</div>
            <div className="row profile-chips">
              <Chip kind="accent" icon={me.role === 'admin' ? 'admin' : 'user'}>
                {t(`profile.hero.role.${me.role}`)}
              </Chip>
              {me.totp_enabled ? (
                <Chip kind="good" icon="shield">
                  {t('profile.hero.totpOn')}
                </Chip>
              ) : (
                <Chip kind="warn" icon="alert">
                  {t('profile.hero.totpOff')}
                </Chip>
              )}
            </div>
          </div>
          {!mobile && <HeroLogout />}
        </div>
        <dl className="profile-facts">
          <div>
            <dt>{t('profile.hero.since')}</dt>
            <dd>
              {t('profile.hero.sinceValue', { date: formatDateLong(me.created_at) })}
              <small>{t('profile.hero.days', { count: days })}</small>
            </dd>
          </div>
          <div>
            <dt>{t('profile.hero.lastLogin')}</dt>
            <dd>
              {events.isPending ? (
                <Skeleton width={120} />
              ) : last ? (
                <>
                  {formatDateTime(last.at)}
                  <small>{deviceName(last.device_label, unknown)}</small>
                </>
              ) : (
                '—'
              )}
            </dd>
          </div>
          <div>
            <dt>{t('profile.hero.sessions')}</dt>
            <dd>
              {sessions.data ? (
                <>
                  {sessions.data.length}
                  <small>{deviceList}</small>
                </>
              ) : sessions.isError ? (
                '—'
              ) : (
                <Skeleton width={60} />
              )}
            </dd>
          </div>
        </dl>
        {!mobile && (
          <div className="profile-quick">
            <span className="eyebrow">{t('profile.hero.quick')}</span>
            <div className="row">
              <Button
                size="sm"
                icon="lock"
                to={{ pathname: paths.profile('security'), hash: '#profile-password' }}
              >
                {t('profile.hero.quickPassword')}
              </Button>
              <Button size="sm" icon="key" to={paths.profile('key')}>
                {t('profile.hero.quickKey')}
              </Button>
              <Button size="sm" icon="pause" to={paths.profile('bank')}>
                {t('profile.hero.quickLimits')}
              </Button>
              <Button size="sm" icon="download" to={paths.profile('data')}>
                {t('profile.hero.quickExport')}
              </Button>
            </div>
          </div>
        )}
      </div>
      <div className="profile-guard">
        <div className="row-between">
          <h3>{t('profile.guard.title')}</h3>
          <Chip
            kind={done === checks.length ? 'good' : 'outline'}
            icon={done === checks.length ? 'check' : undefined}
          >
            {t('profile.guard.count', { done, total: checks.length })}
          </Chip>
        </div>
        <Meter
          value={done}
          max={checks.length}
          label={t('profile.guard.meter', { done, total: checks.length })}
        />
        {mobile && shown.length === 0 && <div className="small soft">{t('profile.guard.allDone')}</div>}
        {mobile && shown.length > 0 && (
          <div className="xsmall muted">
            {t('profile.guard.mobileSome', { done, total: checks.length })}
          </div>
        )}
        {shown.length > 0 && (
          <ul className="profile-guard-list">
            {shown.map((c) => (
              <li key={c.id}>
                <span className={`profile-guard-ic ${c.ok ? 'ok' : 'todo'}`} aria-hidden="true">
                  <Icon name={c.ok ? 'check' : 'plus'} />
                </span>
                <div className="profile-guard-text">
                  <div>
                    {c.title}
                    <span className="sr-only">
                      {c.ok ? t('profile.guard.done') : t('profile.guard.todo')}
                    </span>
                  </div>
                  <div className="xsmall muted">{c.hint}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {suspicious && (
          <div className="profile-guard-alert" role="note">
            <Icon name="alert" />
            <div style={{ minWidth: 0 }}>
              {t('profile.guard.suspicious', {
                when: formatDateTime(suspicious.at),
                device: deviceName(suspicious.device_label, unknown),
              })}
            </div>
            <Button
              kind="ghost"
              size="sm"
              to={{ pathname: paths.profile('security'), hash: '#profile-log' }}
            >
              {t('profile.guard.check')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}

/** «Выйти» в сводке (на компьютере): тот же выход, что в меню пользователя. */
function HeroLogout() {
  const { t } = useTranslation();
  const { logout, pending } = useLogout();
  return (
    <Button kind="ghost" size="sm" icon="logout" loading={pending} onClick={logout}>
      {t('profile.hero.logout')}
    </Button>
  );
}
