import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../../app/paths';
import { Button, Callout, Field, Icon } from '../../../components';
import { isCodeComplete, isEmailShape, maskCode } from '../../../features/auth/codes';
import { isPwned, resetFailure } from '../../../features/auth/flow';
import { checkPassword } from '../../../features/auth/password';
import { useReset } from '../../../features/auth/useReset';
import {
  AUTH_TITLE_ID,
  AuthHead,
  CliLine,
  CodeField,
  Note,
  PasswordField,
  PasswordMatch,
  PasswordStrength,
  useStepFocus,
} from '../parts';

type FieldName = 'email' | 'code' | 'password' | 'password2';
type Errors = Partial<Record<FieldName, string>>;

interface ResetStepProps {
  initialEmail: string;
  focus: boolean;
  onDone: (email: string) => void;
}

/** «Забыли пароль?» (Р5, Р6): без почты — одноразовый код сброса от администратора, 24 часа. */
export function ResetStep({ initialEmail, focus, onDone }: ResetStepProps) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const reset = useReset();
  const [email, setEmail] = useState(initialEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pwned, setPwned] = useState<string | null>(null);
  const [checkSeq, setCheckSeq] = useState(0);
  useStepFocus(formRef, focus);

  useEffect(() => {
    if (checkSeq) formRef.current?.querySelector<HTMLElement>('.input.invalid')?.focus();
  }, [checkSeq]);

  const clear = (field: FieldName) => setErrors((e) => ({ ...e, [field]: undefined }));
  const leaked = pwned !== null && pwned === password;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (reset.isPending) return;
    const masked = maskCode('RST', code);
    setCode(masked);
    setFormError(null);
    const e: Errors = {};
    if (!isEmailShape(email)) e.email = t('auth.common.emailInvalid');
    if (!masked) e.code = t('auth.reset.codeRequired');
    else if (!isCodeComplete('RST', masked)) e.code = t('auth.reset.codeFormat');
    const check = checkPassword(password, leaked);
    if (!password) e.password = t('auth.reset.passwordRequired');
    else if (check.tooLong) e.password = t('auth.password.tooLong');
    else if (!check.ok) e.password = t('auth.password.invalid');
    if (!e.password && password2 !== password) e.password2 = t('auth.password.mismatch');
    setErrors(e);
    if (Object.values(e).some(Boolean)) {
      setCheckSeq((n) => n + 1);
      return;
    }
    reset.mutate(
      { email: email.trim(), code: masked, new_password: password },
      {
        onSuccess: () => onDone(email.trim()),
        onError: (error) => {
          if (isPwned(error)) setPwned(password);
          const failure = resetFailure(error);
          if (failure.kind === 'field') {
            setErrors({ [failure.field]: failure.message });
            setCheckSeq((n) => n + 1);
          } else {
            setFormError(failure.message);
          }
        },
      },
    );
  }

  return (
    <form ref={formRef} className="login-form" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <AuthHead eyebrow={t('auth.reset.eyebrow')} title={t('auth.reset.title')} />
      <Callout kind="accent" icon="key">
        <b>{t('auth.reset.askAdmin')}</b> {t('auth.reset.askAdminText')}
      </Callout>
      {formError && (
        <Callout kind="bad" icon="alert" role="alert">
          {formError}
        </Callout>
      )}
      <Field
        id="login-rs-email"
        label={t('auth.reset.email')}
        type="email"
        value={email}
        autoComplete="username"
        inputMode="email"
        spellCheck={false}
        autoCapitalize="off"
        error={errors.email}
        data-autofocus={!email || undefined}
        onChange={(event) => {
          setEmail(event.target.value);
          clear('email');
        }}
      />
      <CodeField
        prefix="RST"
        id="login-rs-code"
        label={t('auth.reset.code')}
        value={code}
        hint={t('auth.reset.codeHint')}
        error={errors.code}
        autoFocus={Boolean(email)}
        onChange={(value) => {
          setCode(value);
          clear('code');
        }}
      />
      <PasswordField
        id="login-rs-pwd"
        label={t('auth.reset.password')}
        value={password}
        autoComplete="new-password"
        error={errors.password}
        after={<PasswordStrength password={password} leaked={leaked} />}
        onChange={(value) => {
          setPassword(value);
          clear('password');
        }}
      />
      <PasswordField
        id="login-rs-pwd2"
        label={t('auth.reset.password2')}
        value={password2}
        autoComplete="new-password"
        error={errors.password2}
        after={<PasswordMatch password={password} repeat={password2} />}
        onChange={(value) => {
          setPassword2(value);
          clear('password2');
        }}
      />
      <Button kind="primary" size="lg" block type="submit" icon="lock" loading={reset.isPending}>
        {reset.isPending ? t('auth.reset.busy') : t('auth.reset.submit')}
      </Button>
      <Note icon="lock">{t('auth.reset.note')}</Note>
      <CliLine lead={t('auth.reset.cli')} command="reset-code" />
      <div className="login-alt">
        <Link className="login-link" to={paths.login} state={{ email: email.trim() }}>
          <Icon name="chevronLeft" />
          {t('auth.common.backToLogin')}
        </Link>
      </div>
    </form>
  );
}
