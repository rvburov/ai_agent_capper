import {
  useEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { useTranslation } from 'react-i18next';

import {
  Checkbox,
  Chip,
  FieldShell,
  Icon,
  Meter,
  Stepper as BaseStepper,
  describedById,
  type ChipKind,
  type IconName,
} from '../../components';
import { maskCode, type CodePrefix } from '../../features/auth/codes';
import { checkPassword, type PasswordLevel } from '../../features/auth/password';
import { cx } from '../../lib/cx';
import { terminalCommand } from '../../lib/terminal';

// Мелкие части экранов входа — как в макете (mockup/js/screens/login.js).

/** id заголовка формы шага: на него ссылается aria-labelledby формы. */
export const AUTH_TITLE_ID = 'auth-title';

/**
 * Шаг сменился — фокус на поле с data-autofocus и страница к началу, как в макете.
 * При первом открытии страницы фокус не ставим: на телефоне сразу выехала бы клавиатура.
 */
export function useStepFocus(root: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    root.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true });
    window.scrollTo(0, 0);
  }, [root, enabled]);
}

/** Шаги входа и регистрации: общий Stepper (components) с подписями раздела auth. */
export function Stepper({ items, current }: { items: readonly string[]; current: number }) {
  const { t } = useTranslation();
  return (
    <BaseStepper items={items} current={current} label={t('auth.steps.label')} doneLabel={t('auth.steps.done')} />
  );
}

export function AuthHead({ eyebrow, title, sub }: { eyebrow?: string; title: string; sub?: ReactNode }) {
  return (
    <div className="login-head">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1 className="login-title" id={AUTH_TITLE_ID}>
        {title}
      </h1>
      {sub && <p className="login-sub">{sub}</p>}
    </div>
  );
}

/** «Входите как …» с кнопкой «Не вы?» — на шагах после пароля. */
export function AccountRow({ email, onNotYou }: { email: string; onNotYou: () => void }) {
  const { t } = useTranslation();
  const mail = email.trim();
  return (
    <div className="login-acct">
      <span className="avatar" aria-hidden="true">
        {mail.charAt(0).toUpperCase()}
      </span>
      <div className="login-acct-body">
        <div className="xsmall muted">{t('auth.common.signingAs')}</div>
        <div className="login-acct-addr" title={mail}>
          {mail}
        </div>
      </div>
      <button type="button" className="login-link" onClick={onNotYou}>
        {t('auth.common.notYou')}
      </button>
    </div>
  );
}

export function Note({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <p className="login-note">
      <Icon name={icon} />
      <span>{children}</span>
    </p>
  );
}

/** Строка мелким текстом с командой терминала для администратора (Р6). */
export function CliLine({ lead, command }: { lead: string; command: string }) {
  return (
    <p className="login-cmd">
      <Icon name="terminal" />
      <span>
        {lead} <code>{terminalCommand(command)}</code>
      </span>
    </p>
  );
}

/** Звездочка обязательного поля: смысл передает подпись «— обязательно для регистрации». */
export function RequiredMark() {
  return (
    <span className="login-req" aria-hidden="true">
      *
    </span>
  );
}

interface ConsentProps {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  error?: string | null;
  required?: boolean;
}

/** Флажок согласия с ошибкой под ним. */
export function Consent({ id, label, hint, checked, onChange, error, required }: ConsentProps) {
  return (
    <div className="field">
      <Checkbox
        id={id}
        className={cx('login-check', error && 'invalid')}
        label={label}
        hint={hint}
        checked={checked}
        onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
      />
      {error && (
        <div className="field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

interface PasswordFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: 'current-password' | 'new-password';
  error?: string | null;
  /** Поле подсвечено без своего текста ошибки (ошибка входа — в плашке над формой). */
  invalid?: boolean;
  describedBy?: string;
  /** Справа от подписи: «Забыли пароль?». */
  aside?: ReactNode;
  /** Под полем: надежность, совпадение паролей. */
  after?: ReactNode;
  autoFocus?: boolean;
}

/** Пароль с кнопкой «Показать», подсказкой о Caps Lock и местом под ошибку. */
export function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  error,
  invalid,
  describedBy,
  aside,
  after,
  autoFocus,
}: PasswordFieldProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  const [caps, setCaps] = useState(false);
  const errorId = `${id}-error`;
  const bad = Boolean(error) || Boolean(invalid);
  const checkCaps = (event: KeyboardEvent<HTMLInputElement>) => {
    if (typeof event.getModifierState === 'function') setCaps(event.getModifierState('CapsLock'));
  };
  const toggleLabel = visible ? t('common.hidePassword') : t('common.showPassword');
  return (
    <div className="field">
      <div className="login-label-row">
        <label className="field-label" htmlFor={id}>
          {label}
        </label>
        {aside}
      </div>
      <div className="login-pw">
        <input
          className={cx('input', bad && 'invalid')}
          type={visible ? 'text' : 'password'}
          id={id}
          name={id}
          value={value}
          autoComplete={autoComplete}
          spellCheck={false}
          autoCapitalize="off"
          aria-invalid={bad || undefined}
          aria-describedby={error ? errorId : describedBy}
          data-autofocus={autoFocus || undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={checkCaps}
          onKeyUp={checkCaps}
          onBlur={() => setCaps(false)}
        />
        <button
          type="button"
          className="login-eye"
          aria-label={toggleLabel}
          title={toggleLabel}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} />
        </button>
      </div>
      {caps && (
        <div className="login-caps">
          <Icon name="alert" />
          {t('auth.common.capsLock')}
        </div>
      )}
      {error && (
        <div className="field-error" id={errorId} role="alert">
          {error}
        </div>
      )}
      {after}
    </div>
  );
}

interface CodeFieldProps {
  prefix: CodePrefix;
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  autoFocus?: boolean;
}

/** Поле кода с маской PFX-XXXX-XXXX: при вводе в конце строки код сразу в нужном виде. */
export function CodeField({ prefix, id, label, value, onChange, hint, error, autoFocus }: CodeFieldProps) {
  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const native = event.nativeEvent as InputEvent;
    const deleting = typeof native.inputType === 'string' && native.inputType.startsWith('delete');
    const atEnd = input.selectionStart === input.value.length;
    onChange(atEnd && !deleting ? maskCode(prefix, input.value) : input.value);
  }
  return (
    <FieldShell id={id} label={label} hint={hint} error={error}>
      <input
        className={cx('input', 'mono', error && 'invalid')}
        id={id}
        name={id}
        value={value}
        placeholder={`${prefix}-XXXX-XXXX`}
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        aria-invalid={error ? true : undefined}
        aria-describedby={describedById(id, hint, error)}
        data-autofocus={autoFocus || undefined}
        onChange={handleChange}
        onBlur={() => {
          const masked = maskCode(prefix, value);
          if (masked !== value) onChange(masked);
        }}
      />
    </FieldShell>
  );
}

const LEVEL_VIEW: Record<PasswordLevel, { chip: ChipKind; icon: IconName; meter?: 'bad' | 'warn' | 'good' }> = {
  empty: { chip: 'outline', icon: 'info' },
  weak: { chip: 'bad', icon: 'alert', meter: 'bad' },
  medium: { chip: 'warn', icon: 'alert', meter: 'warn' },
  good: { chip: 'accent', icon: 'check' },
  strong: { chip: 'good', icon: 'shield', meter: 'good' },
};

type RuleState = 'ok' | 'bad' | 'todo';

function Rule({ state, pending, children }: { state: RuleState; pending?: boolean; children: ReactNode }) {
  const { t } = useTranslation();
  let sr = t('auth.password.ruleTodo');
  if (state === 'ok') sr = t('auth.password.ruleOk');
  else if (pending) sr = t('auth.password.rulePending');
  return (
    <li className={cx('login-rule', state)}>
      {state === 'ok' && <Icon name="check" />}
      {state === 'bad' && <Icon name="alert" />}
      {state === 'todo' && <span className="pend" aria-hidden="true" />}
      <span>{children}</span>
      <span className="sr-only">{sr}</span>
    </li>
  );
}

/**
 * Надежность пароля и правила (макет: шкала, метка, три правила, пояснение про HIBP).
 * Утечку проверяет сервер: до его ответа правило «Не встречался в утечках» ждет проверки.
 */
export function PasswordStrength({ password, leaked }: { password: string; leaked: boolean }) {
  const { t } = useTranslation();
  const check = checkPassword(password, leaked);
  const view = LEVEL_VIEW[check.level];
  const levelText = t(`auth.password.levels.${check.level}`);
  const length = [...password].length;
  let lengthState: RuleState = check.long ? 'ok' : 'todo';
  if (check.tooLong) lengthState = 'bad';
  return (
    <div className="login-strength">
      <div className="row-between">
        <span className="small soft">{t('auth.password.strength')}</span>
        <Chip kind={view.chip} icon={view.icon}>
          {levelText}
        </Chip>
      </div>
      <Meter
        value={check.score}
        max={4}
        label={t('auth.password.strength')}
        valueText={levelText}
        kind={view.meter === 'good' ? undefined : view.meter}
        className={view.meter === 'good' ? 'login-good' : undefined}
      />
      <ul className="login-rules" aria-label={t('auth.password.rules')}>
        <Rule state={lengthState}>
          {check.tooLong
            ? t('auth.password.tooLong')
            : password
              ? t('auth.password.lengthNow', { count: length })
              : t('auth.password.length')}
        </Rule>
        <Rule state={check.mix ? 'ok' : 'todo'}>{t('auth.password.mix')}</Rule>
        <Rule state={check.leaked ? 'bad' : 'todo'} pending={Boolean(password) && !check.leaked}>
          {check.leaked ? t('auth.password.leaked') : t('auth.password.leaks')}
        </Rule>
      </ul>
      <div className="field-hint">{t('auth.password.hibp')}</div>
    </div>
  );
}

/** «Пароли совпадают» под полем повтора. */
export function PasswordMatch({ password, repeat }: { password: string; repeat: string }) {
  const { t } = useTranslation();
  return (
    <div className="login-match">
      {repeat && (
        <ul className="login-rules">
          {repeat === password ? (
            <Rule state="ok">{t('auth.password.match')}</Rule>
          ) : (
            <Rule state="todo">{t('auth.password.noMatch')}</Rule>
          )}
        </ul>
      )}
    </div>
  );
}

