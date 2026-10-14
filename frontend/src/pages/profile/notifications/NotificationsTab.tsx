import { useTranslation } from 'react-i18next';

import type { Me } from '../../../api/hooks/useMe';
import { Button, Card, Chip, Icon, Skeleton, useToast } from '../../../components';
import { useAdminAttention } from '../../../features/admin/useAdminAttention';
import { apiErrorText } from '../../../features/analysis/codes';
import { useAiBudget } from '../../../features/ai/useAiBudget';
import { timeZoneDative, timeZoneName } from '../../../features/profile/timezones';
import { prefRows, useNotificationPrefs, useSetNotificationPref, type PrefRow } from '../../../features/notifications/prefs';
import { formatDate, formatRelative, formatUsd } from '../../../lib/format';
import { ProfileItem } from '../ProfileItem';
import { LoadError } from '../LoadError';
import './notifications.css';

/*
 * Кабинет → «Уведомления» (panelNotifications макета): «О чем сообщать» — виды по строкам с
 * переключателем «на сайте» (GET/PUT /api/me/notification-prefs, сохраняется сразу);
 * обязательные — включены и неактивны; push и тихие часы — неактивны до этапа 6. Какие строки
 * есть у человека, решает сервер (роль и режим ключа); числа в подписях — из лимита ИИ и дел
 * администратора, которые уже загружены в приложении.
 */

// Тихие часы по умолчанию — как в макете; заработают вместе с push (этап 6)
const HOURS = ['23:00', '08:00'] as const;

export function NotificationsTab({ me }: { me: Me }) {
  return (
    <div className="grid">
      <div className="col-8 profile-col">
        <WhatCard me={me} />
      </div>
      <div className="col-4 profile-col">
        <ChannelsCard />
        <QuietCard tz={me.tz} />
      </div>
    </div>
  );
}

/** Подпись строки с числами, где они есть. */
function useRowHint(me: Me) {
  const { t } = useTranslation();
  const admin = me.role === 'admin';
  const budget = useAiBudget();
  const attention = useAdminAttention(admin);
  return (row: PrefRow): string => {
    switch (row.id) {
      case 'limit': {
        // Порог в долларах считает сервер (alert_usd), здесь — только показ
        const limit = budget.data?.monthly_usd ?? null;
        const pct = budget.data?.alert_pct ?? null;
        const alert = budget.data?.alert_usd ?? null;
        return limit !== null && pct !== null && alert !== null
          ? t('profile.notifs.rows.limit.hint', { pct, alert: formatUsd(alert, 0), limit: formatUsd(limit, 0) })
          : t('profile.notifs.rows.limit.hintPlain');
      }
      case 'message':
        return admin ? t('profile.notifs.rows.message.hintAdmin') : t('profile.notifs.rows.message.hint');
      case 'requestsAdmin': {
        const text = t('profile.notifs.rows.requestsAdmin.hint');
        return attention.data ? `${text} ${t('profile.notifs.rows.requestsAdmin.waiting', { count: attention.data.return_requests.length })}` : text;
      }
      case 'usersAdmin': {
        const text = t('profile.notifs.rows.usersAdmin.hint', { pct: attention.data?.alert_pct ?? budget.data?.alert_pct ?? 80 });
        const near = attention.data?.limits.map((item) => item.name).filter(Boolean) ?? [];
        return near.length ? `${text} ${t('profile.notifs.rows.usersAdmin.near', { names: near.join(', ') })}` : text;
      }
      case 'budgetAdmin': {
        const value = budget.data?.budget?.budget_usd ?? null;
        return value !== null ? t('profile.notifs.rows.budgetAdmin.hint', { budget: formatUsd(value, 0) }) : t('profile.notifs.rows.budgetAdmin.hintPlain');
      }
      case 'archiveAdmin': {
        // Порог и последняя загрузка — с сервера (archive в делах администратора, пока архив устарел)
        const archive = attention.data?.archive ?? null;
        const text = archive
          ? t('profile.notifs.rows.archiveAdmin.hint', { count: archive.stale_after_days })
          : t('profile.notifs.rows.archiveAdmin.hintPlain');
        const last = archive?.last_load ?? null;
        return last
          ? t('profile.notifs.rows.archiveAdmin.last', { hint: text, date: formatDate(last), ago: formatRelative(last) })
          : text;
      }
      default:
        return t(`profile.notifs.rows.${row.id}.hint`);
    }
  };
}

function WhatCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const prefs = useNotificationPrefs();
  const hint = useRowHint(me);
  const rows = prefRows(prefs.data);
  const common = rows.filter((row) => !row.admin);
  const forAdmin = rows.filter((row) => row.admin);

  let body;
  if (prefs.error && !prefs.data) {
    body = <LoadError error={prefs.error} onRetry={() => void prefs.refetch()} />;
  } else if (!prefs.data) {
    body = <Skeleton lines={5} />;
  } else {
    body = (
      <div>
        <div className="profile-notif-head" aria-hidden="true">
          <span>{t('profile.notifs.head.event')}</span>
          <span>{t('profile.notifs.head.site')}</span>
          <span>
            {t('profile.notifs.head.push')}
            <small>{t('profile.notifs.head.pushStage')}</small>
          </span>
        </div>
        {common.map((row) => (
          <Row key={row.id} row={row} hint={hint(row)} />
        ))}
        {forAdmin.length > 0 && (
          <>
            <div className="profile-group-label">{t('profile.notifs.forAdmin')}</div>
            {forAdmin.map((row) => (
              <Row key={row.id} row={row} hint={hint(row)} />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <Card id="profile-notif" className="profile-anchor" title={t('profile.notifs.title')} subtitle={t('profile.notifs.subtitle')}>
      {body}
      <p className="profile-note">
        <Icon name="lock" />
        <span>{t('profile.notifs.lockNote')}</span>
      </p>
    </Card>
  );
}

function Row({ row, hint }: { row: PrefRow; hint: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetNotificationPref();
  const title = t(`profile.notifs.rows.${row.id}.title`);
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  const hintId = `profile-n-${row.id}-hint`;

  function change(onSite: boolean) {
    set.mutate(
      { kinds: row.kinds, onSite },
      {
        onSuccess: () =>
          toast.show(t(onSite ? 'profile.notifs.toastOn' : 'profile.notifs.toastOff', { title: lower }), { icon: onSite ? 'bell' : 'x' }),
        onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
      },
    );
  }

  return (
    <div className="profile-notif-row">
      <div className="profile-notif-text">
        <div className="profile-notif-t">
          {title}
          {row.id === 'alertAdmin' && (
            <>
              {' '}
              <Chip kind="info">{t('profile.notifs.new')}</Chip>
            </>
          )}
        </div>
        <div className="field-hint" id={hintId}>
          {hint}
        </div>
      </div>
      <div className="profile-notif-cell">
        {row.required ? (
          <span className="profile-notif-lock" title={t('profile.notifs.lockTitle')}>
            <Icon name="lock" />
            <span className="sr-only">{t('profile.notifs.alwaysOn', { title })}</span>
          </span>
        ) : (
          <span className="switch">
            <input
              type="checkbox"
              role="switch"
              id={`profile-n-${row.id}-site`}
              aria-label={t('profile.notifs.siteLabel', { title })}
              aria-describedby={hintId}
              checked={row.onSite}
              onChange={(event) => change(event.target.checked)}
            />
            <span />
          </span>
        )}
      </div>
      <div className="profile-notif-cell">
        <span className="switch">
          <input
            type="checkbox"
            role="switch"
            id={`profile-n-${row.id}-push`}
            aria-label={t('profile.notifs.pushLabel', { title })}
            checked={false}
            disabled
            readOnly
          />
          <span />
        </span>
      </div>
    </div>
  );
}

function ChannelsCard() {
  const { t } = useTranslation();
  return (
    <Card
      id="profile-channels"
      className="profile-anchor"
      title={t('profile.notifs.channels.title')}
      subtitle={t('profile.notifs.channels.subtitle')}
      foot={
        <Button icon="bell" disabled title={t('profile.notifs.channels.pushSoon')}>
          {t('profile.notifs.channels.allowPush')}
        </Button>
      }
    >
      <div className="profile-list">
        <ProfileItem
          icon="bell"
          iconKind="good"
          title={t('profile.notifs.channels.site')}
          titleExtra={
            <Chip kind="good" icon="check">
              {t('profile.notifs.channels.always')}
            </Chip>
          }
          meta={t('profile.notifs.channels.siteMeta')}
          below
        />
        <ProfileItem
          icon="device"
          title={t('profile.notifs.channels.push')}
          titleExtra={
            <Chip kind="outline" icon="clock">
              {t('profile.notifs.stage6')}
            </Chip>
          }
          meta={t('profile.notifs.channels.pushMeta')}
          below
        />
      </div>
    </Card>
  );
}

function QuietCard({ tz }: { tz: string }) {
  const { t } = useTranslation();
  const dative = timeZoneDative(t, tz);
  const zone = dative ? t('profile.notifs.quiet.tzCity', { city: dative }) : t('profile.notifs.quiet.tzName', { zone: timeZoneName(t, tz) });
  return (
    <Card
      id="profile-quiet"
      title={t('profile.notifs.quiet.title')}
      subtitle={t('profile.notifs.quiet.subtitle', { zone })}
      actions={
        <Chip kind="outline" icon="clock">
          {t('profile.notifs.stage6')}
        </Chip>
      }
    >
      <div className="profile-time">
        {(['from', 'to'] as const).map((part, i) => (
          <div className="field" key={part}>
            <label className="field-label" htmlFor={`profile-quiet-${part}`}>
              <span>{t(`profile.notifs.quiet.${part}`)}</span>
            </label>
            <input id={`profile-quiet-${part}`} className="input mono" value={HOURS[i]} disabled readOnly />
          </div>
        ))}
      </div>
      <p className="xsmall muted profile-quiet-note">{t('profile.notifs.quiet.note')}</p>
    </Card>
  );
}
