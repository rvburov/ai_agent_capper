import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { paths } from '../../app/paths';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { useToast } from '../../components';
import type { Failure } from '../../features/auth/flow';
import { useFinishLogin } from '../../features/auth/useFinishLogin';
import { AuthLayout } from './AuthLayout';
import { InviteStep } from './steps/InviteStep';
import { SetupStep } from './steps/SetupStep';

/**
 * /register: код приглашения, данные и согласия → обязательная настройка 2FA → главная.
 * Если незавершенный вход истек на шаге 2FA, ведем на /login: аккаунт уже создан.
 */
export function RegisterPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const finishLogin = useFinishLogin();
  const [email, setEmail] = useState<string | null>(null);
  useDocumentTitle(t(email === null ? 'auth.titles.invite' : 'auth.titles.setup'));

  function toLogin(failure?: Extract<Failure, { kind: 'restart' }>) {
    if (failure) toast.show(failure.message, { icon: 'alert', duration: 6000 });
    void navigate(paths.login, { replace: true, state: { email } });
  }

  return (
    <AuthLayout>
      {email === null ? (
        <InviteStep
          // со страницы входа — фокус на код приглашения; открыли по адресу — без фокуса
          focus={location.key !== 'default'}
          onRegistered={(value) => {
            setEmail(value);
            toast.show(t('auth.register.created'), { icon: 'check' });
          }}
        />
      ) : (
        <SetupStep
          mode="register"
          email={email}
          focus
          onRestart={toLogin}
          onLocked={() => toLogin()}
          onNotYou={() => toLogin()}
          onDone={(user) => {
            finishLogin(user);
            toast.show(t('auth.toast.setupDone'), { icon: 'shield' });
            void navigate(paths.home, { replace: true });
          }}
        />
      )}
    </AuthLayout>
  );
}
