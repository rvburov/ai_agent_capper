import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../../api/hooks/useMe';
import { Button, Callout, Chip, Icon, Spinner, useToast } from '../../../components';
import { copyText, downloadText } from '../../../features/auth/clipboard';
import { groupSecret, isOtpComplete, svgDataUri, svgSize } from '../../../features/auth/codes';
import { codeFailure, type Failure } from '../../../features/auth/flow';
import { useConfirmTotpSetup, useTotpSetup, type TotpSetupDoneOut } from '../../../features/auth/useTwoFactor';
import { cx } from '../../../lib/cx';
import { EMPTY_OTP, OtpInput, otpValue, type OtpDigits, type OtpHandle } from '../OtpInput';
import { AUTH_TITLE_ID, AccountRow, AuthHead, Consent, Stepper, useStepFocus } from '../parts';

export type SetupMode = 'register' | 'login';

interface SetupStepProps {
  /** register — сразу после регистрации; login — первый вход или 2FA сброшена администратором. */
  mode: SetupMode;
  email: string;
  focus: boolean;
  /** Незавершенный вход сброшен сервером (истек, аккаунт заблокирован): снова шаг «Пароль». */
  onRestart: (failure: Extract<Failure, { kind: 'restart' }>) => void;
  onLocked: (retryAfter: number) => void;
  onNotYou: () => void;
  /** «Готово — войти в кабинет»: коды сохранены, вход завершен — пользователя в кэш и в приложение. */
  onDone: (user: Me) => void;
}

/**
 * Настройка 2FA (обязательный шаг): 1) QR-код и ключ, 2) код из приложения — он включает 2FA
 * и завершает вход, 3) восемь резервных кодов, которые сервер показывает один раз.
 * Коды приходят только после проверки кода, поэтому шаг 3 до нее ждет.
 */
export function SetupStep({ mode, email, focus, onRestart, onLocked, onNotYou, onDone }: SetupStepProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const formRef = useRef<HTMLFormElement>(null);
  const otpRef = useRef<OtpHandle>(null);
  const keyRef = useRef<HTMLElement>(null);
  const codesRef = useRef<HTMLOListElement>(null);
  const codesTitleRef = useRef<HTMLHeadingElement>(null);
  const setup = useTotpSetup();
  const confirm = useConfirmTotpSetup();
  const [digits, setDigits] = useState<OtpDigits>(EMPTY_OTP);
  const [otpError, setOtpError] = useState<string | null>(null);
  const [done, setDone] = useState<TotpSetupDoneOut | null>(null);
  const [saved, setSaved] = useState(false);
  const [savedError, setSavedError] = useState<string | null>(null);
  useStepFocus(formRef, focus);

  // Секрет не выдали: вход истек или аккаунт заблокирован — снова пароль
  const setupError = setup.error;
  useEffect(() => {
    if (!setupError || done) return;
    const failure = codeFailure(setupError);
    if (failure.kind === 'restart') onRestart(failure);
    else if (failure.kind === 'locked') onLocked(failure.retryAfter);
  }, [setupError, done, onRestart, onLocked]);

  useEffect(() => {
    if (done) codesTitleRef.current?.focus();
  }, [done]);

  function handleFailure(error: unknown) {
    const failure = codeFailure(error);
    if (failure.kind === 'restart') onRestart(failure);
    else if (failure.kind === 'locked') onLocked(failure.retryAfter);
    else {
      setOtpError(failure.message);
      setDigits(EMPTY_OTP);
      requestAnimationFrame(() => otpRef.current?.focus());
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (done) {
      if (!saved) {
        setSavedError(t('auth.setup.savedRequired'));
        formRef.current?.querySelector<HTMLInputElement>('#login-setup-saved')?.focus();
        return;
      }
      onDone(done.user);
      return;
    }
    if (confirm.isPending || !setup.data) return;
    const code = otpValue(digits);
    if (!isOtpComplete(code)) {
      setOtpError(t('auth.setup.enterInvalid'));
      otpRef.current?.focus();
      return;
    }
    confirm.mutate(code, {
      // Вход уже завершен (cookie сеанса стоит), но кэш меняем по «Готово»: иначе экран
      // потерял бы секрет настройки, а коды еще нужно сохранить
      onSuccess: setDone,
      onError: handleFailure,
    });
  }

  async function copy(text: string, node: Node | null, okMessage: string) {
    const ok = await copyText(text, node);
    toast.show(ok ? okMessage : t('auth.common.copyFailed'), { icon: ok ? 'copy' : 'info' });
  }

  function download(codes: readonly string[]) {
    const lines = [
      t('auth.setup.fileTitle'),
      t('auth.setup.fileAccount', { email: done?.user.email ?? email }),
      '',
      ...codes.map((code, i) => `${i + 1}. ${code}`),
      '',
      t('auth.setup.fileNote'),
      '',
    ];
    downloadText(t('auth.setup.fileName'), lines.join('\n'));
  }

  const register = mode === 'register';
  const setupFailure = setup.error ? codeFailure(setup.error) : null;
  const secret = setup.data?.secret ?? '';
  const qr = setup.data?.qr_svg;
  const qrSize = qr ? svgSize(qr) : undefined;

  return (
    <form ref={formRef} className="login-form wide" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <Stepper
        items={register ? [t('auth.steps.account'), t('auth.steps.protect')] : [t('auth.steps.password'), t('auth.steps.protect')]}
        current={1}
      />
      <AuthHead
        eyebrow={t('auth.setup.eyebrow')}
        title={t('auth.setup.title')}
        sub={register ? t('auth.setup.sub') : t('auth.setup.loginSub')}
      />
      {!register && !done && <AccountRow email={email} onNotYou={onNotYou} />}
      {setupFailure?.kind === 'form' && !setup.isFetching && (
        <Callout kind="bad" icon="alert" role="alert">
          <div className="stack">
            <span>{setupFailure.message}</span>
            <div>
              <Button size="sm" icon="refresh" onClick={() => void setup.refetch()}>
                {t('common.retry')}
              </Button>
            </div>
          </div>
        </Callout>
      )}
      <div className="login-secs">
        <section className="login-s" aria-labelledby="login-s1">
          <span className="login-s-n" aria-hidden="true">
            {done ? <Icon name="check" /> : 1}
          </span>
          <div className="login-s-body">
            <h2 id="login-s1">{t('auth.setup.scan')}</h2>
            <div className="login-qrrow">
              <div className="login-qr">
                {qr ? (
                  <img src={svgDataUri(qr)} width={qrSize} height={qrSize} alt={t('auth.setup.qrAlt')} />
                ) : (
                  <div className="login-qr-wait">{setup.isPending && <Spinner label={t('auth.setup.loading')} />}</div>
                )}
              </div>
              <div className="login-qr-side">
                <div className="small soft">{t('auth.setup.apps')}</div>
                <div className="login-apps">
                  <Chip kind="outline" icon="device">
                    {t('auth.common.appGoogle')}
                  </Chip>
                  <Chip kind="outline" icon="device">
                    {t('auth.common.appMicrosoft')}
                  </Chip>
                  <Chip kind="outline" icon="device">
                    {t('auth.common.app1Password')}
                  </Chip>
                </div>
                <div className="small soft">{t('auth.setup.manual')}</div>
                <div className="login-key">
                  <code ref={keyRef}>
                    {groupSecret(secret)}
                  </code>
                  <Button
                    size="sm"
                    icon="copy"
                    disabled={!secret}
                    onClick={() => void copy(secret, keyRef.current, t('auth.setup.keyCopied'))}
                  >
                    {t('auth.setup.copy')}
                  </Button>
                </div>
                <div className="xsmall muted">{t('auth.setup.keyType')}</div>
              </div>
            </div>
          </div>
        </section>
        <section className="login-s" aria-labelledby="login-s2">
          <span className="login-s-n" aria-hidden="true">
            {done ? <Icon name="check" /> : 2}
          </span>
          <div className="login-s-body">
            <h2 id="login-s2">
              <label htmlFor="login-setup-otp" id="login-setup-otp-label">
                {t('auth.setup.enter')}
              </label>
            </h2>
            <OtpInput
              ref={otpRef}
              id="login-setup-otp"
              labelledBy="login-setup-otp-label"
              value={digits}
              invalid={Boolean(otpError)}
              describedBy={otpError ? 'login-setup-otp-error' : 'login-setup-otp-hint'}
              readOnly={confirm.isPending || Boolean(done)}
              onChange={(next) => {
                setDigits(next);
                setOtpError(null);
              }}
            />
            {otpError ? (
              <div className="field-error" id="login-setup-otp-error" role="alert">
                {otpError}
              </div>
            ) : done ? (
              <div className="field-hint login-ok" id="login-setup-otp-hint">
                {t('auth.setup.enabled')}
              </div>
            ) : (
              <div className="field-hint" id="login-setup-otp-hint">
                {t('auth.setup.enterHint')}
              </div>
            )}
          </div>
        </section>
        <section className={cx('login-s', !done && 'waiting')} aria-labelledby="login-s3">
          <span className="login-s-n" aria-hidden="true">
            3
          </span>
          <div className="login-s-body">
            <h2 id="login-s3" ref={codesTitleRef} tabIndex={-1}>
              {t('auth.setup.save')}
            </h2>
            <p className="small soft">{t('auth.setup.saveText')}</p>
            {done ? (
              <>
                <ol className="login-codes" ref={codesRef} aria-label={t('auth.setup.codesLabel')}>
                  {done.recovery_codes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ol>
                <div className="row">
                  <Button
                    size="sm"
                    icon="copy"
                    onClick={() =>
                      void copy(done.recovery_codes.join('\n'), codesRef.current, t('auth.setup.codesCopied'))
                    }
                  >
                    {t('auth.setup.copyCodes')}
                  </Button>
                  <Button size="sm" icon="download" onClick={() => download(done.recovery_codes)}>
                    {t('auth.setup.download')}
                  </Button>
                </div>
                <Consent
                  id="login-setup-saved"
                  checked={saved}
                  error={savedError}
                  label={t('auth.setup.saved')}
                  onChange={(value) => {
                    setSaved(value);
                    if (value) setSavedError(null);
                  }}
                />
              </>
            ) : (
              <div className="login-codes-wait">{t('auth.setup.codesPending')}</div>
            )}
          </div>
        </section>
      </div>
      {done ? (
        <Button kind="primary" size="lg" block type="submit" icon="check">
          {t('auth.setup.finish')}
        </Button>
      ) : (
        <Button kind="primary" size="lg" block type="submit" icon="shield" loading={confirm.isPending} disabled={!setup.data}>
          {confirm.isPending ? t('auth.setup.confirmBusy') : t('auth.setup.confirm')}
        </Button>
      )}
    </form>
  );
}
