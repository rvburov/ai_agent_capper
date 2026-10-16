import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, Dropdown, FieldShell, Icon, Skeleton, useToast } from '../../../components';
import { apiErrorText } from '../../../features/analysis/codes';
import {
  QUIET_TIMES,
  quietMinutes,
  useNotificationPrefs,
  useSetQuietHours,
  type QuietHours,
} from '../../../features/notifications/prefs';
import { timeZoneDative, timeZoneName } from '../../../features/profile/timezones';

const OPTIONS = QUIET_TIMES.map((time) => ({ value: time, label: time }));

type Part = 'from' | 'to';

/**
 * «Тихие часы» (quietCard макета, В3): с start до end по поясу человека push не приходят,
 * уведомления ждут в колокольчике; вход с нового устройства и неудачные входы приходят всегда.
 * Шаг — 30 минут, начало и конец совпадать не могут (ловим до запроса, сервер проверит тоже).
 * Пока push нет ни на одном устройстве — неактивны.
 */
export function QuietCard({ tz, available }: { tz: string; available: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const prefs = useNotificationPrefs();
  const set = useSetQuietHours();
  const [error, setError] = useState<Part | null>(null);
  const quiet = prefs.data?.quiet_hours;
  const dative = timeZoneDative(t, tz);
  const zone = dative ? t('profile.notifs.quiet.tzCity', { city: dative }) : t('profile.notifs.quiet.tzName', { zone: timeZoneName(t, tz) });
  const off = !(prefs.data?.push_available ?? available);

  function save(next: QuietHours, done: string) {
    set.mutate(next, {
      onSuccess: () => toast.show(done, { icon: next.enabled ? 'moon' : 'bell' }),
      onError: (failure) => toast.show(apiErrorText(failure), { icon: 'alert' }),
    });
  }

  function pick(part: Part, value: string) {
    if (!quiet) return;
    const next = part === 'from' ? { ...quiet, start: value } : { ...quiet, end: value };
    if (next.start === next.end) {
      setError(part);
      return;
    }
    setError(null);
    save(next, t('profile.notifs.quiet.toast', { from: next.start, to: next.end, zone }));
  }

  function duration(q: QuietHours): string {
    const total = quietMinutes(q.start, q.end);
    const hours = Math.floor(total / 60);
    const minutes = total % 60;
    return minutes ? t('profile.notifs.quiet.hoursMinutes', { hours, minutes }) : t('profile.notifs.quiet.hours', { count: hours });
  }

  const enabled = Boolean(quiet?.enabled) && !off;
  const summary = off
    ? t('profile.notifs.quiet.summaryNoPush')
    : quiet?.enabled
      ? t('profile.notifs.quiet.summaryOn', { from: quiet.start, to: quiet.end, duration: duration(quiet) })
      : t('profile.notifs.quiet.summaryOff');

  return (
    <Card
      id="profile-quiet"
      className="profile-anchor"
      title={t('profile.notifs.quiet.title')}
      subtitle={t('profile.notifs.quiet.subtitle', { zone })}
      actions={
        quiet && (
          <span className="switch" title={off ? t('profile.notifs.pushFirst') : undefined}>
            <input
              type="checkbox"
              role="switch"
              id="profile-quiet-on"
              aria-label={off ? t('profile.notifs.quiet.switchLabelOff') : t('profile.notifs.quiet.switchLabel')}
              checked={enabled}
              disabled={off}
              onChange={(event) => {
                const on = event.target.checked;
                setError(null);
                save({ ...quiet, enabled: on }, on ? t('profile.notifs.quiet.toastOn') : t('profile.notifs.quiet.toastOff'));
              }}
            />
            <span />
          </span>
        )
      }
    >
      {!quiet ? (
        <Skeleton lines={2} />
      ) : (
        <>
          <div className="profile-time">
            {(['from', 'to'] as const).map((part) => {
              const id = `profile-quiet-${part}`;
              return (
                <FieldShell
                  key={part}
                  id={id}
                  label={t(`profile.notifs.quiet.${part}`)}
                  error={error === part ? t('profile.notifs.quiet.same') : undefined}
                >
                  <Dropdown
                    id={id}
                    label={t(`profile.notifs.quiet.${part}Label`)}
                    value={part === 'from' ? quiet.start : quiet.end}
                    options={OPTIONS}
                    disabled={!enabled}
                    invalid={error === part}
                    describedBy={error === part ? `${id}-error` : undefined}
                    onChange={(value) => pick(part, value)}
                  />
                </FieldShell>
              );
            })}
          </div>
          <p className="small soft profile-quiet-summary" aria-live="polite">
            {summary}
          </p>
          <p className="profile-note">
            <Icon name="shield" />
            <span>{t('profile.notifs.quiet.security')}</span>
          </p>
          <p className="xsmall muted profile-quiet-note">{t('profile.notifs.quiet.tzNote', { zone: timeZoneName(t, tz) })}</p>
        </>
      )}
    </Card>
  );
}
