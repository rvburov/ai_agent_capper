import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { Button, Callout, Card, Chip, Skeleton, useToast } from '../../components';
import { deviceIcon, deviceName, lowerFirst, maskIp } from '../../features/profile/devices';
import type { TrustedDevice } from '../../features/profile/types';
import { RECOVERY_CODES_LOW, useRecoveryCodesStatus } from '../../features/profile/useRecoveryCodes';
import { useForgetDevice, useTrustedDevices } from '../../features/profile/useTrustedDevices';
import { formatDate, formatDateLong, formatDateTime } from '../../lib/format';
import { LoadError } from './LoadError';
import { MetaLine, ProfileItem } from './ProfileItem';
import { RecoveryCodesModal } from './RecoveryCodesModal';

/** «Двухфакторная аутентификация»: приложение, резервные коды и доверенные устройства. */
export function TwoFactorCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const codes = useRecoveryCodesStatus();
  const [codesOpen, setCodesOpen] = useState(false);

  let codesMeta;
  if (codes.data) {
    codesMeta =
      codes.data.total > 0
        ? t('profile.twofa.codesMeta', {
            left: codes.data.left,
            total: codes.data.total,
            date: formatDateLong(codes.data.created_at),
          })
        : t('profile.twofa.codesNone');
  } else if (codes.isError) {
    codesMeta = errorMessage(codes.error);
  } else {
    codesMeta = <Skeleton width={220} height={12} />;
  }
  const low = codes.data !== undefined && codes.data.left < RECOVERY_CODES_LOW;

  return (
    <Card
      id="profile-2fa"
      className="profile-anchor"
      title={t('profile.twofa.title')}
      subtitle={t('profile.twofa.subtitle')}
      actions={
        me.totp_enabled ? (
          <Chip kind="good" icon="shield">
            {t('profile.twofa.on')}
          </Chip>
        ) : (
          <Chip kind="warn" icon="alert">
            {t('profile.twofa.off')}
          </Chip>
        )
      }
    >
      <div className="profile-list">
        <ProfileItem
          icon="shield"
          iconKind={me.totp_enabled ? 'good' : undefined}
          title={t('profile.twofa.app')}
          meta={t('profile.twofa.appMeta')}
          below
        />
        <ProfileItem
          icon="key"
          title={t('profile.twofa.codes')}
          titleExtra={
            low ? (
              <Chip kind="warn" icon="alert">
                {t('profile.twofa.codesLow')}
              </Chip>
            ) : undefined
          }
          meta={codesMeta}
          below
          side={
            <Button size="sm" icon="refresh" disabled={!me.totp_enabled} onClick={() => setCodesOpen(true)}>
              {t('profile.twofa.reissue')}
            </Button>
          }
        />
      </div>
      <hr className="divider" />
      <TrustedDevices />
      <Callout icon="lock">
        {me.role === 'admin' ? (
          <Trans i18nKey="profile.twofa.calloutAdmin" components={{ code: <span className="mono" /> }} />
        ) : (
          t('profile.twofa.calloutMember')
        )}
      </Callout>
      <RecoveryCodesModal open={codesOpen} onClose={() => setCodesOpen(false)} email={me.email} />
    </Card>
  );
}

/** Доверенные устройства: здесь вход не спрашивает код 2FA. «Забыть» — снова спросит. */
function TrustedDevices() {
  const { t } = useTranslation();
  const toast = useToast();
  const devices = useTrustedDevices();
  const forget = useForgetDevice();
  const unknown = t('profile.unknownDevice');

  function onForget(device: TrustedDevice) {
    const name = deviceName(device.device_label, unknown);
    forget.mutate(device.id, {
      onSuccess: () => toast.show(t('profile.twofa.forgotten', { name }), { icon: 'trash' }),
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  const count = devices.data?.length ?? 0;
  return (
    <div className="stack" style={{ gap: 10 }} id="profile-devices">
      <div className="profile-section-title">
        <h4>{t('profile.twofa.devices')}</h4>
        {devices.data &&
          (count > 0 ? (
            <Chip kind="accent" icon="check">
              {t('profile.twofa.devicesCount', { count })}
            </Chip>
          ) : (
            <Chip kind="outline">{t('profile.twofa.devicesNone')}</Chip>
          ))}
      </div>
      <p className="small soft">{t('profile.twofa.devicesHint')}</p>
      {devices.isPending && <Skeleton lines={2} />}
      {devices.isError && <LoadError error={devices.error} onRetry={() => void devices.refetch()} />}
      {devices.data && count === 0 && <p className="xsmall muted">{t('profile.twofa.devicesEmpty')}</p>}
      {devices.data && count > 0 && (
        <div className="profile-list">
          {devices.data.map((device) => {
            const name = deviceName(device.device_label, unknown);
            return (
              <ProfileItem
                key={device.id}
                icon={deviceIcon(device.device_label)}
                iconKind={device.current ? 'good' : undefined}
                title={name}
                titleExtra={
                  device.current ? (
                    <Chip kind="accent" icon="check">
                      {t('profile.twofa.thisDevice')}
                    </Chip>
                  ) : undefined
                }
                meta={
                  <MetaLine
                    parts={[
                      <span key="ip" className="profile-ip">
                        {maskIp(device.ip)}
                      </span>,
                      device.last_used_at
                        ? t('profile.twofa.deviceUsed', { when: lowerFirst(formatDateTime(device.last_used_at)) })
                        : null,
                      t('profile.twofa.deviceUntil', { date: formatDate(device.expires_at) }),
                    ]}
                  />
                }
                side={
                  <Button
                    size="sm"
                    kind="ghost"
                    icon="trash"
                    aria-label={t('profile.twofa.forgetLabel', { name })}
                    loading={forget.isPending && forget.variables === device.id}
                    onClick={() => onForget(device)}
                  >
                    {t('profile.twofa.forget')}
                  </Button>
                }
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
