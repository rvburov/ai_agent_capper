import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../../app/paths';
import { Button, Callout, Dropdown, Field, FieldShell, Icon, describedById } from '../../../components';
import { isCodeComplete, isEmailShape, maskCode } from '../../../features/auth/codes';
import { isPwned, registerFailure } from '../../../features/auth/flow';
import { checkPassword } from '../../../features/auth/password';
import { browserTimeZone, timeZoneOptions } from '../../../features/profile/timezones';
import { useRegister } from '../../../features/auth/useRegister';
import {
  AUTH_TITLE_ID,
  AuthHead,
  CodeField,
  Consent,
  PasswordField,
  PasswordMatch,
  PasswordStrength,
  RequiredMark,
  Stepper,
  useStepFocus,
} from '../parts';

type FieldName = 'invite' | 'name' | 'email' | 'password' | 'password2' | 'tz' | 'age' | 'ai';
type Errors = Partial<Record<FieldName, string>>;

const NAME_MIN = 2;
const DEFAULT_TIME_ZONE = 'Europe/Helsinki';
const NAME_MAX = 100;

// Первое поле с ошибкой в порядке формы — туда фокус после проверки
const INVALID_SELECTOR = '.input.invalid, .dd-trigger.invalid, .login-check.invalid input';

interface InviteStepProps {
  focus: boolean;
  /** Аккаунт создан: дальше настройка 2FA. */
  onRegistered: (email: string) => void;
}

/** Регистрация только по коду приглашения (Р4) с уведомлением о данных и согласиями (Р15, GDPR). */
export function InviteStep({ focus, onRegistered }: InviteStepProps) {
  const { t } = useTranslation();
  const formRef = useRef<HTMLFormElement>(null);
  const register = useRegister();
  const [invite, setInvite] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  // По умолчанию — пояс браузера; список — тот же, что в личном кабинете (города из макета)
  const [tz, setTz] = useState(() => browserTimeZone() ?? DEFAULT_TIME_ZONE);
  const [zones] = useState(() => timeZoneOptions(t, tz));
  const [age, setAge] = useState(false);
  const [ai, setAi] = useState(false);
  const [train, setTrain] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pwned, setPwned] = useState<string | null>(null);
  const [checkSeq, setCheckSeq] = useState(0);
  useStepFocus(formRef, focus);

  useEffect(() => {
    if (checkSeq) formRef.current?.querySelector<HTMLElement>(INVALID_SELECTOR)?.focus();
  }, [checkSeq]);

  const clear = (field: FieldName) => setErrors((e) => ({ ...e, [field]: undefined }));

  function validate(): Errors {
    const e: Errors = {};
    const code = maskCode('CAP', invite);
    if (!code) e.invite = t('auth.register.codeRequired');
    else if (!isCodeComplete('CAP', code)) e.invite = t('auth.register.codeFormat');
    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN) e.name = t('auth.register.nameRequired');
    else if (trimmed.length > NAME_MAX) e.name = t('auth.register.nameTooLong');
    if (!isEmailShape(email)) e.email = t('auth.common.emailInvalid');
    const check = checkPassword(password, pwned !== null && pwned === password);
    if (!password) e.password = t('auth.register.passwordRequired');
    else if (check.tooLong) e.password = t('auth.password.tooLong');
    else if (!check.ok) e.password = t('auth.password.invalid');
    if (!e.password && password2 !== password) e.password2 = t('auth.password.mismatch');
    if (!age) e.age = t('auth.register.ageRequired');
    if (!ai) e.ai = t('auth.register.aiRequired');
    return e;
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (register.isPending) return;
    setInvite(maskCode('CAP', invite));
    setFormError(null);
    const e = validate();
    setErrors(e);
    if (Object.values(e).some(Boolean)) {
      setCheckSeq((n) => n + 1);
      return;
    }
    register.mutate(
      {
        invite_code: maskCode('CAP', invite),
        email: email.trim(),
        display_name: name.trim(),
        password,
        accept_terms: age && ai,
        consent_training: train,
        tz,
      },
      {
        onSuccess: () => onRegistered(email.trim()),
        onError: (error) => {
          if (isPwned(error)) setPwned(password);
          const failure = registerFailure(error);
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

  const tzHint = t('auth.register.tzHint');
  return (
    <form ref={formRef} className="login-form" noValidate aria-labelledby={AUTH_TITLE_ID} onSubmit={submit}>
      <Stepper items={[t('auth.steps.account'), t('auth.steps.protect')]} current={0} />
      <AuthHead eyebrow={t('auth.register.eyebrow')} title={t('auth.register.title')} sub={t('auth.register.sub')} />
      {formError && (
        <Callout kind="bad" icon="alert" role="alert">
          {formError}
        </Callout>
      )}
      <CodeField
        prefix="CAP"
        id="login-inv-code"
        label={t('auth.register.code')}
        value={invite}
        hint={t('auth.register.codeHint')}
        error={errors.invite}
        autoFocus
        onChange={(value) => {
          setInvite(value);
          clear('invite');
        }}
      />
      <Field
        id="login-inv-name"
        label={t('auth.register.name')}
        value={name}
        placeholder={t('auth.register.namePlaceholder')}
        autoComplete="name"
        autoCapitalize="words"
        error={errors.name}
        onChange={(event) => {
          setName(event.target.value);
          clear('name');
        }}
      />
      <Field
        id="login-inv-email"
        label={t('auth.register.email')}
        type="email"
        value={email}
        placeholder="you@example.com"
        autoComplete="email"
        inputMode="email"
        spellCheck={false}
        autoCapitalize="off"
        hint={t('auth.register.emailHint')}
        error={errors.email}
        onChange={(event) => {
          setEmail(event.target.value);
          clear('email');
        }}
      />
      <PasswordField
        id="login-inv-pwd"
        label={t('auth.register.password')}
        value={password}
        autoComplete="new-password"
        error={errors.password}
        after={<PasswordStrength password={password} leaked={pwned !== null && pwned === password} />}
        onChange={(value) => {
          setPassword(value);
          clear('password');
        }}
      />
      <PasswordField
        id="login-inv-pwd2"
        label={t('auth.register.password2')}
        value={password2}
        autoComplete="new-password"
        error={errors.password2}
        after={<PasswordMatch password={password} repeat={password2} />}
        onChange={(value) => {
          setPassword2(value);
          clear('password2');
        }}
      />
      <FieldShell id="login-inv-tz" label={t('auth.register.tz')} hint={tzHint} error={errors.tz}>
        <Dropdown
          id="login-inv-tz"
          label={t('auth.register.tz')}
          options={zones}
          value={tz}
          invalid={Boolean(errors.tz)}
          describedBy={describedById('login-inv-tz', tzHint, errors.tz)}
          onChange={(value) => {
            setTz(value);
            clear('tz');
          }}
        />
      </FieldShell>
      <section className="login-data" aria-labelledby="login-data-h">
        <div className="login-data-h" id="login-data-h">
          <Icon name="database" />
          {t('auth.register.dataTitle')}
        </div>
        <ul>
          <li>{t('auth.register.data1')}</li>
          <li>{t('auth.register.data2')}</li>
          <li>{t('auth.register.data3')}</li>
        </ul>
      </section>
      <div className="login-consents" role="group" aria-label={t('auth.register.consents')}>
        <Consent
          id="login-inv-age"
          checked={age}
          error={errors.age}
          required
          label={
            <>
              {t('auth.register.age')}
              <RequiredMark />
            </>
          }
          onChange={(value) => {
            setAge(value);
            if (value) clear('age');
          }}
        />
        <Consent
          id="login-inv-ai"
          checked={ai}
          error={errors.ai}
          required
          label={
            <>
              {t('auth.register.ai')}
              <RequiredMark />
            </>
          }
          onChange={(value) => {
            setAi(value);
            if (value) clear('ai');
          }}
        />
        <Consent
          id="login-inv-train"
          checked={train}
          label={t('auth.register.train')}
          hint={t('auth.register.trainHint')}
          onChange={setTrain}
        />
        <div className="field-hint">
          <RequiredMark /> {t('auth.register.requiredNote')}
        </div>
      </div>
      <Button kind="primary" size="lg" block type="submit" iconRight={register.isPending ? undefined : 'arrowRight'} loading={register.isPending}>
        {register.isPending ? t('auth.register.busy') : t('auth.register.submit')}
      </Button>
      <div className="login-alt">
        <span className="muted">{t('auth.register.haveAccount')}</span>
        <Link className="login-link" to={paths.login} state={{ email: email.trim() }}>
          {t('auth.register.signIn')}
        </Link>
      </div>
    </form>
  );
}
