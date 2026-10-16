import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { InstallModal, useInstallTitle } from '../../app/layout/InstallModal';
import { paths } from '../../app/paths';
import { AppIcon, Button, Card, Chip } from '../../components';
import { useInstall } from '../../features/pwa/install';
import { currentPlatform, deviceLabel, isStandalone } from '../../features/pwa/platform';

/**
 * «Приложение на телефоне» (installCard макета): установлено ли приложение на этом устройстве,
 * кнопка установки (окно установки, В6) и ссылка на экран «Нет связи».
 */
export function InstallCard() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { installed } = useInstall();
  const installTitle = useInstallTitle();
  const platform = currentPlatform();

  return (
    <Card
      id="profile-install"
      className="profile-anchor"
      title={t('profile.install.title')}
      subtitle={t('profile.install.subtitle')}
      foot={
        installed ? (
          <Button icon="check" onClick={() => setOpen(true)}>
            {t('profile.install.more')}
          </Button>
        ) : (
          <Button kind="primary" icon="download" onClick={() => setOpen(true)}>
            {installTitle}
          </Button>
        )
      }
    >
      <div className="profile-list">
        <div className="profile-item">
          <span className="profile-item-ic profile-install-ic" aria-hidden="true">
            <AppIcon size={40} />
          </span>
          <div className="profile-item-body">
            <div className="profile-item-title">
              {t('app.name')}
              {installed ? (
                <Chip kind="good" icon="check">
                  {t('profile.install.installed')}
                </Chip>
              ) : (
                <Chip kind="outline">{t('profile.install.notInstalled')}</Chip>
              )}
            </div>
            <div className="profile-item-meta">
              {t('profile.install.thisDevice', { device: deviceLabel(t, platform, isStandalone()) })}
            </div>
          </div>
          <span />
        </div>
      </div>
      <p className="xsmall muted profile-install-note">
        {platform.ios && !installed ? t('profile.install.noteIos') : t('profile.install.note')}
      </p>
      <div className="profile-install-links">
        <Link to={paths.offline}>{t('profile.install.offlineLink')}</Link>
      </div>
      <InstallModal open={open} onClose={() => setOpen(false)} />
    </Card>
  );
}
