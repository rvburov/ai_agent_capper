import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../../app/paths';
import { Button, Callout, Field, Icon } from '../../../components';
import { isEmailShape } from '../../../features/auth/codes';
import { AUTH_TITLE_ID, AuthHead, Consent, PasswordField, Stepper, useStepFocus } from '../parts';

interface LoginStepProps {
  email: string;
  onEmail: (email: string) => void;
  remember: boolean;
  onRemember: (remember: boolean) => void;
  /** Ошибка входа или прошлого шага (вход истек). Новый объект — новая ошибка, даже с тем же текстом. */
  error: { message: string } | null;
  /** Сообщение-пояснение, не ошибка: «Сеанс завершен. Войдите снова». */
  info: string | null;
  busy: boolean;
  focus: boolean;
  onSubmit: (password: string) => void;
}

/** Шаг 1: email и пароль. Пустые поля проверяются до сервера и не тратят попытку входа. */
export function LoginStep({ email, onEmail, remember, onRemember, error, info, busy, focus, onSubmit }: LoginStepProps) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  // пароль после ошибки перепечатывают — подсветка поля снимается сразу
  const [retyped, setRetyped] = useState(false);
  useStepFocus(formRef, focus);

  // Ошибка сервера пришла — пароль очищаем, фокус на него (как в макете)
  useEffect(() => {
    if (!error) return;
    setPassword('');
    setRetyped(false);
    formRef.current?.querySelector<HTMLInputElement>('#login-password')?.focus();
  }, [error]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!isEmailShape(email)) {
      setEmailError(t('auth.common.emailInvalid'));
      formRef.current?.querySelector<HTMLInputElement>('#login-email')?.focus();
      return;
    }
    if (!password) {
      setPasswordError(t('auth.login.passwordRequired'));
      formRef.current?.querySelector<HTMLInputElement>('#login-password')?.focus();
      return;
    }
    onSubmit(password);
  }

  return (
    <form ref={formRef} className="login-form" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <Stepper items={[t('auth.steps.password'), t('auth.steps.code')]} current={0} />
      <AuthHead eyebrow={t('auth.login.eyebrow')} title={t('auth.login.title')} sub={t('auth.login.sub')} />
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          <b id="login-error">{error.message}</b>
        </Callout>
      )}
      {!error && info && (
        <Callout kind="info" icon="info" role="status">
          {info}
        </Callout>
      )}
      <Field
        id="login-email"
        label={t('auth.common.email')}
        type="email"
        name="email"
        value={email}
        autoComplete="username"
        inputMode="email"
        spellCheck={false}
        autoCapitalize="off"
        error={emailError}
        data-autofocus={!email || undefined}
        onChange={(event) => {
          onEmail(event.target.value);
          setEmailError(null);
        }}
      />
      <PasswordField
        id="login-password"
        label={t('auth.login.password')}
        value={password}
        autoComplete="current-password"
        invalid={Boolean(error) && !retyped}
        error={passwordError}
        describedBy={error ? 'login-error' : undefined}
        autoFocus={Boolean(email)}
        aside={
          <Link className="login-link" to={paths.reset} state={{ email }}>
            {t('auth.login.forgot')}
          </Link>
        }
        onChange={(value) => {
          setPassword(value);
          setPasswordError(null);
          setRetyped(true);
        }}
      />
      <Consent
        id="login-remember"
        checked={remember}
        onChange={onRemember}
        label={t('auth.login.remember')}
        hint={t('auth.login.rememberHint')}
      />
      <Button kind="primary" size="lg" block type="submit" iconRight={busy ? undefined : 'arrowRight'} loading={busy}>
        {busy ? t('auth.login.busy') : t('auth.login.submit')}
      </Button>
      <div className="login-alt">
        <span className="muted">{t('auth.login.noAccount')}</span>
        <Link className="login-link" to={paths.register}>
          {t('auth.login.inviteOnly')}
          <Icon name="chevronRight" />
        </Link>
      </div>
    </form>
  );
}
