import { useState, type ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { Button, Card, Chip, Icon, KeyCap, type ChipKind, type IconName, useToast } from '../../../components';
import { InstallModal } from '../../../app/layout/InstallModal';
import { apiErrorText } from '../../../features/analysis/codes';
import { useDisablePush, useEnablePush, usePushSubscriptions, useTestPush, type PushChannel } from '../../../features/pwa/api';
import { currentPlatform, deviceLabel, isStandalone } from '../../../features/pwa/platform';
import { PushSetupError, type PushState } from '../../../features/pwa/push';
import { LoadError } from '../LoadError';
import { ProfileItem } from '../ProfileItem';

const CHANNELS_ID = 'profile-channels';

/** «Включить push» из подсказки над столбцом «Push»: к карточке «Каналы», фокус на ее кнопку. */
export function focusEnablePush(): void {
  const card = document.getElementById(CHANNELS_ID);
  card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card?.querySelector<HTMLElement>('.card-foot .btn')?.focus({ preventScroll: true });
}

const CHIPS: Record<PushState, { kind: ChipKind; icon?: IconName }> = {
  checking: { kind: 'outline' },
  off: { kind: 'outline' },
  on: { kind: 'good', icon: 'check' },
  denied: { kind: 'bad', icon: 'ban' },
  ios: { kind: 'warn', icon: 'alert' },
  unsupported: { kind: 'outline', icon: 'x' },
  server: { kind: 'outline', icon: 'x' },
};

const STEP_PARTS = { share: <KeyCap icon="share" />, home: <KeyCap icon="plusSquare" /> };

/**
 * «Каналы» (channelsCard макета): на сайте — всегда; push на этом устройстве — одно из
 * состояний PushState с подсказкой и кнопками. Разрешение спрашивает браузер (свое окно);
 * запрещено — шаги, как разрешить в настройках; iPhone в Safari — как установить на экран
 * «Домой» (В6); браузер или сервер push не умеют — только текст.
 */
export function ChannelsCard({ push }: { push: PushChannel }) {
  const { t } = useTranslation();
  const toast = useToast();
  const list = usePushSubscriptions();
  const enable = useEnablePush();
  const disable = useDisablePush();
  const test = useTestPush();
  const [installOpen, setInstallOpen] = useState(false);
  const platform = currentPlatform();
  const state = push.state;
  const busy = enable.isPending || disable.isPending;

  function turnOn() {
    if (!push.vapidKey) return;
    enable.mutate(
      { vapidKey: push.vapidKey, known: list.data?.items.map((item) => item.endpoint_hash) ?? [] },
      {
        onSuccess: (answer) => {
          if (answer === 'granted') toast.show(t('profile.notifs.channels.toastOn'), { icon: 'bell' });
          else if (answer === 'denied') toast.show(t('profile.notifs.channels.toastDenied'), { icon: 'x' });
          else toast.show(t('profile.notifs.channels.toastDismissed'), { icon: 'info' });
        },
        onError: (error) => {
          const text =
            error instanceof PushSetupError
              ? t(error.reason === 'no-worker' ? 'profile.notifs.channels.failedWorker' : 'profile.notifs.channels.failedSubscribe')
              : apiErrorText(error);
          toast.show(text, { icon: 'alert' });
        },
      },
    );
  }

  function turnOff() {
    disable.mutate(undefined, {
      onSuccess: () => toast.show(t('profile.notifs.channels.toastOff'), { icon: 'bellOff' }),
      onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
    });
  }

  function sendTest() {
    test.mutate(undefined, {
      onSuccess: (out) => toast.show(t('profile.notifs.channels.testSent', { count: out.sent }), { icon: 'send' }),
      onError: (error) => toast.show(apiErrorText(error), { icon: 'alert' }),
    });
  }

  // «Проверить снова»: разрешение дали в настройках браузера — сразу включаем push
  function recheck() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      toast.show(t('profile.notifs.channels.toastStillDenied'), { icon: 'x' });
      push.retry();
      return;
    }
    turnOn();
  }

  let body: ReactNode = null;
  let foot: ReactNode = null;
  switch (state) {
    case 'off':
      body = <p className="small soft">{t('profile.notifs.channels.text.off')}</p>;
      foot = (
        <Button kind="primary" icon="bell" loading={enable.isPending} disabled={busy || !push.vapidKey} onClick={turnOn}>
          {t('profile.notifs.channels.enable')}
        </Button>
      );
      break;
    case 'on':
      body = <p className="small soft">{t('profile.notifs.channels.text.on')}</p>;
      foot = (
        <>
          <Button kind="primary" icon="send" loading={test.isPending} disabled={test.isPending} onClick={sendTest}>
            {t('profile.notifs.channels.test')}
          </Button>
          <Button kind="ghost" icon="bellOff" loading={disable.isPending} disabled={busy} onClick={turnOff}>
            {t('profile.notifs.channels.disable')}
          </Button>
        </>
      );
      break;
    case 'denied': {
      const steps: readonly string[] = t(`profile.notifs.channels.deniedSteps.${platform.install}`, { returnObjects: true });
      body = (
        <>
          <p className="small soft">{t('profile.notifs.channels.text.denied')}</p>
          <ol className="pwa-steps">
            {steps.map((step) => (
              <li key={step}>
                <span>{step}</span>
              </li>
            ))}
          </ol>
        </>
      );
      foot = (
        <Button icon="refresh" loading={enable.isPending} disabled={busy} onClick={recheck}>
          {t('profile.notifs.channels.recheck')}
        </Button>
      );
      break;
    }
    case 'ios':
      body = (
        <>
          <p className="small soft">{t('profile.notifs.channels.text.ios')}</p>
          <ol className="pwa-steps" aria-label={t('profile.notifs.channels.iosSteps.label')}>
            {(['s1', 's2', 's3'] as const).map((step) => (
              <li key={step}>
                <span>
                  <Trans i18nKey={`profile.notifs.channels.iosSteps.${step}`} components={STEP_PARTS} />
                </span>
              </li>
            ))}
          </ol>
        </>
      );
      foot = (
        <Button kind="primary" icon="download" onClick={() => setInstallOpen(true)}>
          {t('profile.notifs.channels.howInstall')}
        </Button>
      );
      break;
    case 'unsupported':
    case 'server':
      body = <p className="small soft">{t(`profile.notifs.channels.text.${state}`)}</p>;
      break;
    case 'checking':
      break;
  }

  const chip = CHIPS[state];
  const icon: IconName =
    state === 'on' ? 'bell' : state === 'denied' || state === 'unsupported' || state === 'server' ? 'bellOff' : platform.mobile ? 'device' : 'laptop';

  return (
    <Card
      id={CHANNELS_ID}
      className="profile-anchor"
      title={t('profile.notifs.channels.title')}
      subtitle={t('profile.notifs.channels.subtitle')}
      foot={foot ?? undefined}
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
      </div>
      <div className="profile-push" aria-live="polite">
        <div className="profile-push-head">
          <span className={state === 'on' ? 'profile-item-ic good' : 'profile-item-ic'} aria-hidden="true">
            <Icon name={icon} />
          </span>
          <div className="profile-item-body">
            <div className="profile-push-title">
              {t('profile.notifs.channels.pushThis')}
              <Chip kind={chip.kind} icon={chip.icon}>
                {t(`profile.notifs.channels.state.${state}`)}
              </Chip>
            </div>
            <div className="profile-item-meta">{deviceLabel(t, platform, isStandalone())}</div>
          </div>
        </div>
        {push.error !== null && push.error !== undefined && state !== 'on' ? (
          <LoadError error={push.error} onRetry={push.retry} />
        ) : (
          body
        )}
      </div>
      <InstallModal open={installOpen} onClose={() => setInstallOpen(false)} />
    </Card>
  );
}
