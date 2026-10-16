import { useTranslation } from 'react-i18next';

import { Button, Card, Chip, Skeleton, useToast } from '../../../components';
import { apiErrorText } from '../../../features/analysis/codes';
import { useDisconnectDevice, usePushSubscriptions, type PushChannel, type PushSubscriptionOut } from '../../../features/pwa/api';
import { formatDate, formatRelative } from '../../../lib/format';
import { LoadError } from '../LoadError';
import { MetaLine, ProfileItem } from '../ProfileItem';

/** Сегодня ли (в поясе показа) подключено устройство. */
function isToday(iso: string): boolean {
  return formatDate(iso) === formatDate(new Date());
}

/**
 * «Устройства с push» (devicesCard макета, В4): все активные подписки аккаунта — название
 * (устройство и браузер, как назвал его сервер), когда подключено, когда был последний push и
 * «Отключить». Подписка этого браузера помечена «это устройство» (по endpoint_hash).
 */
export function DevicesCard({ push }: { push: PushChannel }) {
  const { t } = useTranslation();
  const list = usePushSubscriptions();
  const items = list.data?.items ?? [];

  let body;
  if (list.error && !list.data) {
    body = <LoadError error={list.error} onRetry={() => void list.refetch()} />;
  } else if (!list.data) {
    body = <Skeleton lines={2} />;
  } else if (items.length === 0) {
    body = <p className="small soft">{t('profile.notifs.devices.empty')}</p>;
  } else {
    body = (
      <div className="profile-list">
        {items.map((item) => (
          <Device key={item.id} item={item} current={push.hash !== null && item.endpoint_hash === push.hash} />
        ))}
      </div>
    );
  }

  return (
    <Card
      id="profile-push-devices"
      className="profile-anchor"
      title={t('profile.notifs.devices.title')}
      subtitle={list.data ? (items.length ? t('profile.notifs.devices.count', { count: items.length }) : t('profile.notifs.devices.none')) : undefined}
    >
      {body}
      <p className="xsmall muted profile-devices-note">{t('profile.notifs.devices.note')}</p>
    </Card>
  );
}

function Device({ item, current }: { item: PushSubscriptionOut; current: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const disconnect = useDisconnectDevice();
  // Значок — по названию системы (имена систем на всех языках одни)
  const phone = /iPhone|iPad|Android/.test(item.device);
  return (
    <ProfileItem
      icon={phone ? 'device' : 'laptop'}
      title={item.device}
      titleExtra={current ? <Chip kind="accent">{t('profile.notifs.devices.thisDevice')}</Chip> : undefined}
      meta={
        <MetaLine
          parts={[
            isToday(item.created_at)
              ? t('profile.notifs.devices.addedToday')
              : t('profile.notifs.devices.added', { date: formatDate(item.created_at) }),
            item.last_sent_at ? t('profile.notifs.devices.lastSent', { ago: formatRelative(item.last_sent_at) }) : null,
          ]}
        />
      }
      wrap
      side={
        <Button
          size="sm"
          icon="bellOff"
          aria-label={t('profile.notifs.devices.disconnectLabel', { name: item.device })}
          loading={disconnect.isPending}
          disabled={disconnect.isPending}
          onClick={() =>
            disconnect.mutate(
              { id: item.id, current },
              {
                onSuccess: () => toast.show(t('profile.notifs.devices.toast', { name: item.device }), { icon: 'bellOff' }),
                onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
              },
            )
          }
        >
          {t('profile.notifs.devices.disconnect')}
        </Button>
      }
    />
  );
}
