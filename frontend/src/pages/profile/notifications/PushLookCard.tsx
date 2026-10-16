import { Trans, useTranslation } from 'react-i18next';

import { Card, Icon, PushNotice } from '../../../components';
import { formatDayMonth, formatWeekday } from '../../../lib/format';

const SAMPLES = ['s1', 's2', 's3'] as const;

/**
 * «Как выглядит push» (previewCard макета, В1): экран блокировки телефона с тремя примерами.
 * В push только событие, без сумм: его видно на заблокированном экране.
 */
export function PushLookCard() {
  const { t } = useTranslation();
  const today = new Date();
  return (
    <Card id="profile-push-look" title={t('profile.notifs.look.title')} subtitle={t('profile.notifs.look.subtitle')}>
      <figure className="push-lock" aria-label={t('profile.notifs.look.label')}>
        <div className="push-lock-time" aria-hidden="true">
          {t('profile.notifs.look.time')}
        </div>
        <div className="push-lock-date" aria-hidden="true">
          {t('profile.notifs.look.date', { weekday: formatWeekday(today), date: formatDayMonth(today) })}
        </div>
        <div className="push-lock-list">
          {SAMPLES.map((sample) => (
            <PushNotice
              key={sample}
              title={t(`profile.notifs.look.${sample}Title`)}
              body={t(`profile.notifs.look.${sample}Body`)}
              when={t(`profile.notifs.look.${sample}When`)}
            />
          ))}
        </div>
      </figure>
      <p className="profile-note">
        <Icon name="eyeOff" />
        <span>
          <Trans i18nKey="profile.notifs.look.note" components={{ b: <b /> }} />
        </span>
      </p>
    </Card>
  );
}
