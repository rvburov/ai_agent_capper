import { Trans, useTranslation } from 'react-i18next';

import { AppIcon, Button, Callout, Chip, Icon, KeyCap, Modal, useToast } from '../../components';
import { promptInstall, useInstall } from '../../features/pwa/install';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import './InstallModal.css';

/** Подпись пункта меню и заголовок окна: на телефоне — «на телефон», на компьютере — «приложение». */
export function useInstallTitle(): string {
  const { t } = useTranslation();
  return useMediaQuery(MOBILE_QUERY) ? t('pwa.installMobile') : t('pwa.installDesktop');
}

// Разметка внутри шагов инструкции: <b>, кнопки iPhone и меню браузера
const STEP_PARTS = {
  b: <b />,
  share: <KeyCap icon="share" />,
  home: <KeyCap icon="plusSquare" />,
  key: <KeyCap />,
  more: <KeyCap icon="more" />,
};

function Pros() {
  const { t } = useTranslation();
  return (
    <ul className="install-pros">
      {(['pro1', 'pro2', 'pro3'] as const).map((key) => (
        <li key={key}>
          <Icon name="check" />
          <span>{t(`pwa.install.${key}`)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Окно установки (installModal макета, В6): что дает приложение и как поставить его на этом
 * устройстве. Android и компьютер (Chrome, Edge) — кнопка «Установить» открывает окно браузера
 * (если браузер прислал beforeinstallprompt), иначе — где это в меню; iPhone — шаги «Поделиться →
 * На экран «Домой»»; уже открыто как приложение — «Приложение установлено».
 */
export function InstallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const title = useInstallTitle();
  const { canPrompt, installed, kind } = useInstall();
  const view = installed ? 'installed' : kind;

  async function install() {
    const outcome = await promptInstall();
    if (outcome === 'accepted') toast.show(kind === 'desktop' ? t('pwa.install.toastDesktop') : t('pwa.install.toastMobile'), { icon: 'check' });
    else if (outcome === 'dismissed') toast.show(t('pwa.install.dismissed'), { icon: 'info' });
  }

  let body;
  if (view === 'installed') {
    body = (
      <>
        <div className="row">
          <Chip kind="good" icon="check">
            {t('pwa.install.installed')}
          </Chip>
        </div>
        <p className="small soft">{t('pwa.install.installedText')}</p>
        <p className="xsmall muted">{t('pwa.install.installedRemove')}</p>
      </>
    );
  } else if (view === 'ios') {
    body = (
      <>
        <Pros />
        <ol className="pwa-steps" aria-label={t('pwa.install.iosLabel')}>
          {(['ios1', 'ios2', 'ios3', 'ios4', 'ios5'] as const).map((step) => (
            <li key={step}>
              <span>
                <Trans i18nKey={`pwa.install.${step}`} components={STEP_PARTS} />
              </span>
            </li>
          ))}
        </ol>
        <Callout kind="info">{t('pwa.install.iosNote')}</Callout>
      </>
    );
  } else if (view === 'android') {
    body = (
      <>
        <Pros />
        {canPrompt && <p className="small soft">{t('pwa.install.android')}</p>}
        <p className={canPrompt ? 'xsmall muted' : 'small soft'}>
          <Trans i18nKey="pwa.install.androidManual" components={STEP_PARTS} />
        </p>
      </>
    );
  } else {
    body = (
      <>
        <Pros />
        <p className="small soft">{canPrompt ? t('pwa.install.desktop') : t('pwa.install.desktopManual')}</p>
        <p className="xsmall muted">{t('pwa.install.desktopNote')}</p>
      </>
    );
  }

  const footer =
    view !== 'installed' && view !== 'ios' && canPrompt ? (
      <>
        <Button kind="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
        <Button kind="primary" icon="download" onClick={() => void install()}>
          {t('pwa.install.action')}
        </Button>
      </>
    ) : (
      <Button kind="primary" onClick={onClose}>
        {view === 'installed' ? t('pwa.install.done') : t('pwa.install.gotIt')}
      </Button>
    );

  return (
    <Modal open={open} onClose={onClose} title={title} footer={footer}>
      <div className="stack install-body">
        <div className="install-app">
          <AppIcon size={56} />
          <div className="install-app-text">
            <div className="install-app-name">{t('app.name')}</div>
            <div className="small soft">{t('pwa.install.appSub')}</div>
          </div>
        </div>
        {body}
      </div>
    </Modal>
  );
}
