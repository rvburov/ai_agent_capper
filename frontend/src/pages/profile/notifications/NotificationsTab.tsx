import { Trans, useTranslation } from 'react-i18next';

import type { Me } from '../../../api/hooks/useMe';
import { Button, Callout, Card, Chip, Icon, Skeleton, useToast } from '../../../components';
import { useDataUploads } from '../../../features/admin/dataUploads';
import { useAdminAttention } from '../../../features/admin/useAdminAttention';
import { apiErrorText } from '../../../features/analysis/codes';
import { useAiBudget } from '../../../features/ai/useAiBudget';
import { usePushChannel, type PushChannel } from '../../../features/pwa/api';
import { timeZoneName } from '../../../features/profile/timezones';
import { prefRows, useNotificationPrefs, useSetNotificationPref, type NotificationPrefs, type PrefRow } from '../../../features/notifications/prefs';
import { cx } from '../../../lib/cx';
import { formatDate, formatNumber, formatPercent, formatRelative, formatUsd } from '../../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { LoadError } from '../LoadError';
import { ChannelsCard, focusEnablePush } from './ChannelsCard';
import { DevicesCard } from './DevicesCard';
import { PushLookCard } from './PushLookCard';
import { QuietCard } from './QuietCard';
import './notifications.css';

/*
 * Кабинет → «Уведомления» (panelNotifications макета, Р26): «О чем сообщать» — виды по строкам
 * с переключателями «на сайте» и push (GET/PUT /api/me/notification-prefs, сохраняется сразу);
 * «Каналы» — push на этом устройстве; «Устройства с push»; «Тихие часы»; «Как выглядит push».
 * Обязательные виды на сайте приходят всегда, push у них выключается. Пока push нет ни на
 * одном устройстве (push_available, В5), столбец «Push» и тихие часы неактивны. Какие строки
 * есть у человека, решает сервер (роль и режим ключа); числа в подписях — из лимита ИИ и дел
 * администратора, которые уже загружены в приложении.
 */

export function NotificationsTab({ me }: { me: Me }) {
  const mobile = useMediaQuery(MOBILE_QUERY);
  const push = usePushChannel();
  // На телефоне сначала — push на этом устройстве, потом длинный список видов
  if (mobile) {
    return (
      <div className="profile-col">
        <ChannelsCard push={push} />
        <DevicesCard push={push} />
        <WhatCard me={me} push={push} />
        <QuietCard tz={me.tz} available={push.available} />
        <PushLookCard />
      </div>
    );
  }
  return (
    <div className="grid">
      <div className="col-8 profile-col">
        <WhatCard me={me} push={push} />
        <QuietCard tz={me.tz} available={push.available} />
      </div>
      <div className="col-4 profile-col">
        <ChannelsCard push={push} />
        <DevicesCard push={push} />
        <PushLookCard />
      </div>
    </div>
  );
}

/** Подпись строки с числами, где они есть. */
function useRowHint(me: Me, prefs: NotificationPrefs | undefined) {
  const { t } = useTranslation();
  const admin = me.role === 'admin';
  const budget = useAiBudget();
  const attention = useAdminAttention(admin);
  const uploads = useDataUploads({ enabled: admin });
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
      case 'needs': {
        // через сколько дней без исхода в архиве напоминать — настройка сервера (schedule)
        const days = prefs?.schedule.settle_reminder_days ?? null;
        return days !== null ? t('profile.notifs.rows.needs.hintDays', { count: days }) : t('profile.notifs.rows.needs.hint');
      }
      case 'weekly': {
        const schedule = prefs?.schedule ?? null;
        const zone = timeZoneName(t, schedule?.tz ?? me.tz);
        const hour = `${String(schedule?.report_hour ?? 7).padStart(2, '0')}:00`;
        const next = schedule ? t('profile.notifs.rows.weekly.next', { date: formatDate(schedule.next_report) }) : '';
        return `${t('profile.notifs.rows.weekly.hint', { zone, hour })}${next}`;
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
        // Пора загрузить файл tennis-data (data_stale): час и порог дней — те же, что у воркера
        // (schedule сервера), последняя загрузка файла — из «Данных» (GET /admin/data/uploads)
        const schedule = prefs?.schedule ?? null;
        const text = schedule
          ? t('profile.notifs.rows.archiveAdmin.hint', {
              count: schedule.upload_stale_days,
              hour: `${String(schedule.upload_hour).padStart(2, '0')}:00`,
            })
          : t('profile.notifs.rows.archiveAdmin.hintPlain');
        const last = uploads.data?.archive.last_load ?? null;
        return last
          ? t('profile.notifs.rows.archiveAdmin.last', { hint: text, date: formatDate(last), ago: formatRelative(last) })
          : text;
      }
      case 'alertAdmin': {
        // Пороги сигналов расхода — те же числа, что проверяет воркер (alert_rules с сервера)
        const rules = prefs?.alert_rules ?? null;
        return rules
          ? t('profile.notifs.rows.alertAdmin.hintRules', {
              cache: formatPercent(rules.cache_min_share, { digits: 0 }),
              analyses: formatNumber(rules.cache_analyses),
              factor: formatNumber(rules.cost_factor, Number.isInteger(rules.cost_factor) ? 0 : 1),
              days: formatNumber(rules.cost_window_days),
              stops: formatPercent(rules.stops_max_share, { digits: 0 }),
              searches: formatNumber(rules.searches_per_day),
            })
          : t('profile.notifs.rows.alertAdmin.hint');
      }
      default:
        return t(`profile.notifs.rows.${row.id}.hint`);
    }
  };
}

function WhatCard({ me, push }: { me: Me; push: PushChannel }) {
  const { t } = useTranslation();
  const prefs = useNotificationPrefs();
  const hint = useRowHint(me, prefs.data);
  const rows = prefRows(prefs.data);
  const common = rows.filter((row) => !row.admin);
  const forAdmin = rows.filter((row) => row.admin);
  // Push есть хотя бы на одном устройстве аккаунта (В5): настройки общие, менять можно отовсюду
  const pushOn = prefs.data?.push_available ?? push.available;

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
            {!pushOn && <small>{t('profile.notifs.head.pushOff')}</small>}
          </span>
        </div>
        {common.map((row) => (
          <Row key={row.id} row={row} hint={hint(row)} pushOn={pushOn} />
        ))}
        {forAdmin.length > 0 && (
          <>
            <div className="profile-group-label">{t('profile.notifs.forAdmin')}</div>
            {forAdmin.map((row) => (
              <Row key={row.id} row={row} hint={hint(row)} pushOn={pushOn} />
            ))}
          </>
        )}
      </div>
    );
  }

  return (
    <Card
      id="profile-notif"
      className={cx('profile-anchor', !pushOn && 'profile-notif-off')}
      title={t('profile.notifs.title')}
      subtitle={t('profile.notifs.subtitle')}
    >
      {prefs.data && !pushOn && (
        <Callout kind="info" icon="bell">
          <div className="stack profile-push-first">
            <span>
              <Trans i18nKey="profile.notifs.pushFirstCallout" components={{ b: <b /> }} />
            </span>
            <div>
              <Button size="sm" icon="bell" onClick={focusEnablePush}>
                {t('profile.notifs.enablePush')}
              </Button>
            </div>
          </div>
        </Callout>
      )}
      {body}
      <p className="profile-note">
        <Icon name="lock" />
        <span>{t('profile.notifs.lockNote')}</span>
      </p>
    </Card>
  );
}

function Row({ row, hint, pushOn }: { row: PrefRow; hint: string; pushOn: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const set = useSetNotificationPref();
  const title = t(`profile.notifs.rows.${row.id}.title`);
  const lower = title.charAt(0).toLowerCase() + title.slice(1);
  const hintId = `profile-n-${row.id}-hint`;

  function changeSite(onSite: boolean) {
    set.mutate(
      { kinds: row.kinds, onSite },
      {
        onSuccess: () =>
          toast.show(t(onSite ? 'profile.notifs.toastOn' : 'profile.notifs.toastOff', { title: lower }), { icon: onSite ? 'bell' : 'x' }),
        onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
      },
    );
  }

  function changePush(push: boolean) {
    set.mutate(
      { kinds: row.kinds, push },
      {
        onSuccess: () =>
          toast.show(t(push ? 'profile.notifs.pushToastOn' : 'profile.notifs.pushToastOff', { title: lower }), { icon: push ? 'bell' : 'bellOff' }),
        onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
      },
    );
  }

  return (
    <div className="profile-notif-row">
      <div className="profile-notif-text">
        <div className="profile-notif-t">
          {title}
          {row.isNew && (
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
              onChange={(event) => changeSite(event.target.checked)}
            />
            <span />
          </span>
        )}
      </div>
      <div className="profile-notif-cell">
        <span className="switch" title={pushOn ? undefined : t('profile.notifs.pushFirst')}>
          <input
            type="checkbox"
            role="switch"
            id={`profile-n-${row.id}-push`}
            aria-label={pushOn ? t('profile.notifs.pushLabel', { title }) : t('profile.notifs.pushLabelOff', { title })}
            aria-describedby={hintId}
            checked={pushOn && row.push}
            disabled={!pushOn}
            onChange={(event) => changePush(event.target.checked)}
          />
          <span />
        </span>
      </div>
    </div>
  );
}
