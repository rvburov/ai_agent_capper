import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Field, Icon, Modal } from '../../../components';
import { isRecoveryCodeShape } from '../../../features/auth/codes';
import { AUTH_TITLE_ID, AccountRow, AuthHead, CliLine, Stepper, useStepFocus } from '../parts';

interface BackupStepProps {
  email: string;
  busy: boolean;
  focus: boolean;
  error: { message: string } | null;
  onSubmit: (code: string) => void;
  onBack: () => void;
  onApp: () => void;
}

/** Вход по резервному коду: любой из 8 кодов, каждый срабатывает один раз. */
export function BackupStep({ email, busy, focus, error, onSubmit, onBack, onApp }: BackupStepProps) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const [code, setCode] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  useStepFocus(formRef, focus);

  useEffect(() => {
    if (!error) return;
    setLocalError(null);
    formRef.current?.querySelector<HTMLInputElement>('#login-backup-code')?.select();
  }, [error]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (!isRecoveryCodeShape(code)) {
      setLocalError(t('auth.backup.invalid'));
      formRef.current?.querySelector<HTMLInputElement>('#login-backup-code')?.focus();
      return;
    }
    onSubmit(code.trim());
  }

  return (
    <form ref={formRef} className="login-form" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <Stepper items={[t('auth.steps.password'), t('auth.steps.backup')]} current={1} />
      <AuthHead eyebrow={t('auth.backup.eyebrow')} title={t('auth.backup.title')} sub={t('auth.backup.sub')} />
      <AccountRow email={email} onNotYou={onBack} />
      <Field
        id="login-backup-code"
        className="login-backup"
        label={t('auth.backup.label')}
        value={code}
        placeholder={t('auth.backup.placeholder')}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        hint={t('auth.backup.hint')}
        error={localError ?? error?.message ?? null}
        data-autofocus
        onChange={(event) => {
          setCode(event.target.value);
          setLocalError(null);
        }}
      />
      <Button kind="primary" size="lg" block type="submit" icon="key" loading={busy}>
        {busy ? t('auth.backup.busy') : t('auth.backup.submit')}
      </Button>
      <Callout kind="info" icon="info">
        {t('auth.backup.info')}
      </Callout>
      <div className="login-alt between">
        <button type="button" className="login-link" onClick={onApp}>
          <Icon name="chevronLeft" />
          {t('auth.backup.toApp')}
        </button>
        <button type="button" className="login-link" onClick={() => setHelp(true)}>
          {t('auth.backup.noCodes')}
        </button>
      </div>
      <RecoveryHelp open={help} onClose={() => setHelp(false)} />
    </form>
  );
}

/** Потеря 2FA и резервных кодов (Р5): сбрасывает администратор, затем 2FA настраивается заново. */
export function RecoveryHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('auth.recovery.title')}
      footer={
        <Button kind="primary" onClick={onClose}>
          {t('auth.recovery.ok')}
        </Button>
      }
    >
      <p className="soft">{t('auth.recovery.lead')}</p>
      <ol className="login-ol">
        <li>{t('auth.recovery.step1')}</li>
        <li>{t('auth.recovery.step2')}</li>
        <li>{t('auth.recovery.step3')}</li>
      </ol>
      <Callout kind="info" icon="info">
        {t('auth.recovery.password')}
      </Callout>
      <CliLine lead={t('auth.recovery.cli')} command="reset-2fa" />
    </Modal>
  );
}
