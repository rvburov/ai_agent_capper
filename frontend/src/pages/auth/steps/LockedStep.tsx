import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../../app/paths';
import { Button, Callout, Icon, KeyValue } from '../../../components';
import { formatCountdown, pauseWords } from '../../../features/auth/flow';
import { AUTH_TITLE_ID, AuthHead, useStepFocus } from '../parts';

interface LockedStepProps {
  email: string;
  /** Когда пауза закончится (мс, Date.now()). */
  until: number;
  focus: boolean;
  onRetry: () => void;
}

function secondsLeft(until: number): number {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/**
 * Пауза после неудачных попыток с этого IP (PLAN.md, раздел 7): обратный отсчет из retry_after.
 * С других устройств вход работает; экран одинаковый и для несуществующих email.
 */
export function LockedStep({ email, until, focus, onRetry }: LockedStepProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(() => secondsLeft(until));
  useStepFocus(rootRef, focus);

  useEffect(() => {
    setLeft(secondsLeft(until));
    const timer = window.setInterval(() => {
      const next = secondsLeft(until);
      setLeft(next);
      if (next <= 0) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  const over = left <= 0;
  return (
    <div ref={rootRef} className="login-form" role="region" aria-labelledby={AUTH_TITLE_ID}>
      <div className="login-bigic bad" aria-hidden="true">
        <Icon name="lock" />
      </div>
      <AuthHead
        eyebrow={t('auth.locked.eyebrow')}
        title={t('auth.locked.title')}
        sub={over ? t('auth.locked.subOver') : t('auth.locked.sub', { time: pauseWords(left) })}
      />
      <KeyValue
        items={[
          { key: 'email', label: t('auth.locked.email'), value: <span className="login-break">{email}</span> },
          {
            key: 'pause',
            label: t('auth.locked.pause'),
            value: (
              <span className="login-countdown" role="timer">
                {over ? t('auth.locked.pauseOver') : formatCountdown(left)}
              </span>
            ),
          },
          { key: 'others', label: t('auth.locked.others'), value: t('auth.locked.othersValue') },
          { key: 'notice', label: t('auth.locked.notice'), value: t('auth.locked.noticeValue') },
        ]}
      />
      <Callout kind="warn" icon="alert">
        {t('auth.locked.warn')}
      </Callout>
      {over ? (
        <Button kind="primary" size="lg" block icon="arrowRight" onClick={onRetry} data-autofocus>
          {t('auth.locked.retry')}
        </Button>
      ) : (
        <>
          <Button kind="primary" size="lg" block icon="key" to={paths.reset} state={{ email }} data-autofocus>
            {t('auth.locked.reset')}
          </Button>
          <Button kind="ghost" block icon="chevronLeft" onClick={onRetry}>
            {t('auth.locked.retry')}
          </Button>
        </>
      )}
    </div>
  );
}
