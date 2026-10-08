import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';

import type { Me } from '../../api/hooks/useMe';
import { safeNext } from '../../app/paths';
import { useDocumentTitle } from '../../app/useDocumentTitle';
import { useToast } from '../../components';
import { codeFailure, loginFailure, stepAfterLogin, type Failure, type LoginStep as Step } from '../../features/auth/flow';
import { useFinishLogin } from '../../features/auth/useFinishLogin';
import { useLogin } from '../../features/auth/useLogin';
import { useTwoFactor } from '../../features/auth/useTwoFactor';
import { AuthLayout } from './AuthLayout';
import { BackupStep } from './steps/BackupStep';
import { LockedStep } from './steps/LockedStep';
import { LoginStep } from './steps/LoginStep';
import { SetupStep } from './steps/SetupStep';
import { TwoFactorStep } from './steps/TwoFactorStep';

/** Что может прийти на /login через состояние перехода. */
interface LoginLocationState {
  /** Email с экранов регистрации и сброса пароля («Пароль изменен», «Вернуться ко входу»). */
  email?: unknown;
  /** Сеанс закончился, пока приложение было открыто (RequireAuth). */
  sessionEnded?: unknown;
}

function readState(state: unknown): { email: string; fromAuth: boolean; sessionEnded: boolean } {
  const value = (typeof state === 'object' && state !== null ? state : {}) as LoginLocationState;
  return {
    email: typeof value.email === 'string' ? value.email : '',
    // email в состоянии передают только экраны регистрации и сброса пароля
    fromAuth: typeof value.email === 'string',
    sessionEnded: value.sessionEnded === true,
  };
}

type ErrorBox = { message: string } | null;

/**
 * /login: пароль → код 2FA (или резервный код) → приложение. Новый аккаунт и аккаунт после
 * сброса 2FA проходят настройку 2FA. Пауза защиты от подбора — экран «Вход временно закрыт».
 * Состояние шагов живет в памяти: незавершенный вход сервер держит в cookie 5 минут.
 */
export function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const toast = useToast();
  const finishLogin = useFinishLogin();
  const login = useLogin();
  const twoFactor = useTwoFactor();
  const initial = readState(location.state);

  const [step, setStep] = useState<Step>('login');
  // Пришли с экрана регистрации или сброса пароля — это смена шага, как в макете: фокус на первое
  // пустое поле. При открытии страницы по адресу и после выхода фокус не ставим
  const [moved, setMoved] = useState(initial.fromAuth);
  const [email, setEmail] = useState(initial.email);
  const [remember, setRemember] = useState(false);
  const [loginError, setLoginError] = useState<ErrorBox>(null);
  const [info, setInfo] = useState<string | null>(initial.sessionEnded ? t('auth.login.sessionEnded') : null);
  const [codeError, setCodeError] = useState<ErrorBox>(null);
  const [lockedUntil, setLockedUntil] = useState(0);

  useDocumentTitle(t(`auth.titles.${step}`));
  const next = safeNext(params.get('next'));

  const go = useCallback((to: Step) => {
    setStep(to);
    setMoved(true);
    setCodeError(null);
  }, []);

  const enter = useCallback(
    (user: Me, message: string) => {
      finishLogin(user);
      toast.show(message, { icon: 'shield' });
      void navigate(next, { replace: true });
    },
    [finishLogin, toast, navigate, next],
  );

  const restart = useCallback(
    (failure: Extract<Failure, { kind: 'restart' }>) => {
      setLoginError({ message: failure.message });
      go('login');
    },
    [go],
  );

  const lock = useCallback(
    (retryAfter: number) => {
      setLockedUntil(Date.now() + retryAfter * 1000);
      go('locked');
    },
    [go],
  );

  function submitPassword(password: string) {
    setInfo(null);
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: (result) => {
          setLoginError(null);
          const to = stepAfterLogin(result.status);
          if (to === 'done' && result.user) {
            enter(result.user, t('auth.toast.signedIn', { name: result.user.display_name || result.user.email }));
          } else if (to === '2fa') go('2fa');
          else if (to === 'setup') go('setup');
        },
        onError: (error) => {
          const failure = loginFailure(error);
          if (failure.kind === 'locked') lock(failure.retryAfter);
          else setLoginError({ message: failure.message });
        },
      },
    );
  }

  function submitCode(body: { code: string } | { recovery_code: string }) {
    twoFactor.mutate(
      { ...body, remember_device: remember },
      {
        onSuccess: (result) => {
          if (!result.user) return;
          const name = result.user.display_name || result.user.email;
          enter(
            result.user,
            'recovery_code' in body ? t('auth.toast.signedInBackup') : t('auth.toast.signedIn', { name }),
          );
        },
        onError: (error) => {
          const failure = codeFailure(error);
          if (failure.kind === 'locked') lock(failure.retryAfter);
          else if (failure.kind === 'restart') restart(failure);
          else setCodeError({ message: failure.message });
        },
      },
    );
  }

  let view;
  if (step === '2fa') {
    view = (
      <TwoFactorStep
        email={email}
        remember={remember}
        busy={twoFactor.isPending}
        focus={moved}
        error={codeError}
        onSubmit={(code) => submitCode({ code })}
        onBack={() => go('login')}
        onBackup={() => go('backup')}
      />
    );
  } else if (step === 'backup') {
    view = (
      <BackupStep
        email={email}
        busy={twoFactor.isPending}
        focus={moved}
        error={codeError}
        onSubmit={(code) => submitCode({ recovery_code: code })}
        onBack={() => go('login')}
        onApp={() => go('2fa')}
      />
    );
  } else if (step === 'setup') {
    view = (
      <SetupStep
        mode="login"
        email={email}
        focus={moved}
        onRestart={restart}
        onLocked={lock}
        onNotYou={() => go('login')}
        onDone={(user) => enter(user, t('auth.toast.setupDone'))}
      />
    );
  } else if (step === 'locked') {
    view = (
      <LockedStep
        email={email}
        until={lockedUntil}
        focus={moved}
        onRetry={() => {
          setLoginError(null);
          go('login');
        }}
      />
    );
  } else {
    view = (
      <LoginStep
        email={email}
        onEmail={setEmail}
        remember={remember}
        onRemember={setRemember}
        error={loginError}
        info={info}
        busy={login.isPending}
        focus={moved}
        onSubmit={submitPassword}
      />
    );
  }

  return <AuthLayout>{view}</AuthLayout>;
}
