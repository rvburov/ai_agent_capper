import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../../app/paths';
import { Button, Icon } from '../../../components';
import { AUTH_TITLE_ID, AuthHead, useStepFocus } from '../parts';

/** «Пароль изменен»: сеансы завершены, код сброса больше не действует, 2FA сохранена. */
export function ResetDoneStep({ email, focus }: { email: string; focus: boolean }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  useStepFocus(rootRef, focus);
  return (
    <div ref={rootRef} className="login-form" role="region" aria-labelledby={AUTH_TITLE_ID}>
      <div className="login-bigic" aria-hidden="true">
        <Icon name="check" />
      </div>
      <AuthHead title={t('auth.done.title')} sub={t('auth.done.sub')} />
      <ul className="login-bul">
        <li>
          {t('auth.done.account')} <b>{email}</b>.
        </li>
        <li>{t('auth.done.codeUsed')}</li>
        <li>{t('auth.done.twoFactor')}</li>
      </ul>
      <Button
        kind="primary"
        size="lg"
        block
        iconRight="arrowRight"
        to={paths.login}
        state={{ email }}
        replace
        data-autofocus
      >
        {t('auth.done.submit')}
      </Button>
    </div>
  );
}
