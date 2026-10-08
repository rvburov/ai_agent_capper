import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Chip, Icon } from '../../../components';
import { isOtpComplete } from '../../../features/auth/codes';
import { EMPTY_OTP, OtpInput, otpValue, type OtpDigits, type OtpHandle } from '../OtpInput';
import { AUTH_TITLE_ID, AccountRow, AuthHead, Note, Stepper, useStepFocus } from '../parts';

interface TwoFactorStepProps {
  email: string;
  remember: boolean;
  busy: boolean;
  focus: boolean;
  /** Код не подошел (или сбой): текст под клетками, клетки очищаются. */
  error: { message: string } | null;
  onSubmit: (code: string) => void;
  onBack: () => void;
  onBackup: () => void;
}

/** Шаг 2: шесть цифр из приложения. Набрали шестую — код уходит сам. */
export function TwoFactorStep({ email, remember, busy, focus, error, onSubmit, onBack, onBackup }: TwoFactorStepProps) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const otpRef = useRef<OtpHandle>(null);
  const [digits, setDigits] = useState<OtpDigits>(EMPTY_OTP);
  const [localError, setLocalError] = useState<string | null>(null);
  useStepFocus(formRef, focus);

  useEffect(() => {
    if (!error) return;
    setDigits(EMPTY_OTP);
    setLocalError(null);
    // клетки очищены — фокус на первую после отрисовки
    requestAnimationFrame(() => otpRef.current?.focus());
  }, [error]);

  const message = localError ?? error?.message ?? null;

  function send(code: string) {
    if (busy) return;
    if (!isOtpComplete(code)) {
      setLocalError(t('auth.twoFactor.incomplete'));
      otpRef.current?.focus();
      return;
    }
    onSubmit(code);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    send(otpValue(digits));
  }

  return (
    <form ref={formRef} className="login-form" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <Stepper items={[t('auth.steps.password'), t('auth.steps.code')]} current={1} />
      <AuthHead
        eyebrow={t('auth.twoFactor.eyebrow')}
        title={t('auth.twoFactor.title')}
        sub={t('auth.twoFactor.sub', { apps: t('auth.common.apps') })}
      />
      <AccountRow email={email} onNotYou={onBack} />
      <div className="field">
        <label className="field-label" htmlFor="login-otp-1" id="login-otp-label">
          {t('auth.twoFactor.label')}
        </label>
        <OtpInput
          ref={otpRef}
          id="login-otp-1"
          labelledBy="login-otp-label"
          value={digits}
          invalid={Boolean(message)}
          describedBy={message ? 'login-otp-error' : 'login-otp-hint'}
          readOnly={busy}
          autoFocus
          onChange={(next) => {
            setDigits(next);
            setLocalError(null);
          }}
          onComplete={send}
        />
        {message ? (
          <div className="field-error" id="login-otp-error" role="alert">
            {message}
          </div>
        ) : (
          <div className="field-hint" id="login-otp-hint">
            {t('auth.twoFactor.hint')}
          </div>
        )}
      </div>
      {remember && (
        <div className="row">
          <Chip kind="accent" icon="device">
            {t('auth.twoFactor.remembered')}
          </Chip>
        </div>
      )}
      <Button kind="primary" size="lg" block type="submit" loading={busy}>
        {busy ? t('auth.twoFactor.busy') : t('auth.twoFactor.submit')}
      </Button>
      <div className="login-alt between">
        <button type="button" className="login-link" onClick={onBack}>
          <Icon name="chevronLeft" />
          {t('auth.common.back')}
        </button>
        <button type="button" className="login-link" onClick={onBackup}>
          <Icon name="key" />
          {t('auth.twoFactor.noApp')}
        </button>
      </div>
      <Note icon="bell">{t('auth.twoFactor.newDeviceNote')}</Note>
    </form>
  );
}
