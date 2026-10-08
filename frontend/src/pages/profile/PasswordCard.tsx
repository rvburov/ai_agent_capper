import { useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import { Button, Callout, Chip, Field, Icon, Meter, useToast, type ChipKind, type IconName } from '../../components';
import { deviceName } from '../../features/profile/devices';
import {
  passwordRequirements,
  passwordScore,
  strengthLevel,
  validatePasswordChange,
  type PasswordFormErrors,
  type StrengthLevel,
} from '../../features/profile/password';
import { useChangePassword } from '../../features/profile/useChangePassword';
import { useSessions } from '../../features/profile/useSessions';

const LEVEL_VIEW: Record<StrengthLevel, { kind: ChipKind; icon: IconName; meter?: 'warn' | 'bad' }> = {
  weak: { kind: 'bad', icon: 'alert', meter: 'bad' },
  medium: { kind: 'warn', icon: 'info', meter: 'warn' },
  strong: { kind: 'good', icon: 'check' },
};

type ServerErrors = Partial<Record<keyof PasswordFormErrors | 'form', string>>;

/** Код ошибки сервера — к какому полю ее показать. */
function serverErrorField(code: string): keyof ServerErrors {
  if (code === 'auth.current_password_invalid') return 'current';
  if (code.startsWith('auth.password_')) return 'next';
  return 'form';
}

/** «Пароль»: текущий, новый с надежностью и повтор. После смены другие сеансы завершены. */
export function PasswordCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const toast = useToast();
  const change = useChangePassword();
  const sessions = useSessions();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<PasswordFormErrors>({});
  const [server, setServer] = useState<ServerErrors>({});

  const unknown = t('profile.unknownDevice');
  const others = (sessions.data ?? []).filter((s) => !s.current);
  const level = strengthLevel(next);
  const reqs = passwordRequirements(current, next);
  const view = level ? LEVEL_VIEW[level] : null;

  function fieldError(field: keyof PasswordFormErrors): string | undefined {
    const key = errors[field];
    return key ? t(`profile.password.${key}`) : server[field];
  }

  function clear(field: keyof PasswordFormErrors) {
    setErrors((e) => ({ ...e, [field]: undefined }));
    setServer((e) => ({ ...e, [field]: undefined, form: undefined }));
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const found = validatePasswordChange(current, next, confirm);
    setErrors(found);
    setServer({});
    if (found.current || found.next || found.confirm) {
      const first = found.current ? 'profile-pass-cur' : found.next ? 'profile-pass-new' : 'profile-pass-confirm';
      document.getElementById(first)?.focus();
      return;
    }
    const hadOthers = others.length > 0;
    change.mutate(
      { current, next },
      {
        onSuccess: () => {
          setCurrent('');
          setNext('');
          setConfirm('');
          toast.show(hadOthers ? t('profile.password.toast') : t('profile.password.toastAlone'), {
            icon: 'lock',
          });
        },
        onError: (error) => {
          const field = isApiError(error) ? serverErrorField(error.code) : 'form';
          setServer({ [field]: errorMessage(error) });
        },
      },
    );
  }

  const strengthText = level ? t(`profile.password.levels.${level}`) : null;
  const reqItems = [
    { ok: reqs.length, text: t('profile.password.reqLength') },
    { ok: reqs.mix, text: t('profile.password.reqMix') },
    { ok: reqs.differs, text: t('profile.password.reqDiffer') },
  ];

  return (
    <section className="card profile-anchor" id="profile-password" aria-labelledby="profile-password-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="profile-password-title">{t('profile.password.title')}</h3>
        </div>
      </div>
      <form className="profile-form" noValidate onSubmit={onSubmit}>
        <div className="card-body">
          {/* Логин для менеджера паролей: он сохранит новый пароль к нужному аккаунту */}
          <input
            type="email"
            className="sr-only"
            autoComplete="username"
            value={me.email}
            readOnly
            tabIndex={-1}
            aria-hidden="true"
          />
          {server.form && (
            <Callout kind="bad" role="alert">
              {server.form}
            </Callout>
          )}
          <Field
            id="profile-pass-cur"
            type="password"
            label={t('profile.password.current')}
            autoComplete="current-password"
            value={current}
            error={fieldError('current')}
            onChange={(e) => {
              setCurrent(e.target.value);
              clear('current');
            }}
          />
          <Field
            id="profile-pass-new"
            type="password"
            label={t('profile.password.new')}
            autoComplete="new-password"
            value={next}
            error={fieldError('next')}
            onChange={(e) => {
              setNext(e.target.value);
              clear('next');
            }}
          />
          <div className="profile-strength">
            <div className="row-between">
              <span>{t('profile.password.strength')}</span>
              {view && strengthText ? (
                <Chip kind={view.kind} icon={view.icon}>
                  {strengthText}
                </Chip>
              ) : (
                <span className="xsmall muted">{t('profile.password.strengthEmpty')}</span>
              )}
            </div>
            <Meter
              value={next ? Math.max(passwordScore(next), 0.4) : 0}
              max={5}
              kind={view?.meter}
              label={t('profile.password.strengthLabel')}
              valueText={strengthText ?? t('profile.password.strengthEmpty')}
            />
            <ul className="profile-reqs" aria-label={t('profile.password.reqsLabel')}>
              {reqItems.map((req) => (
                <li key={req.text} className={req.ok ? 'ok' : undefined}>
                  <Icon name={req.ok ? 'check' : 'x'} />
                  {req.text}
                  <span className="sr-only">
                    {req.ok ? t('profile.password.reqOk') : t('profile.password.reqTodo')}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <Field
            id="profile-pass-confirm"
            type="password"
            label={t('profile.password.confirm')}
            autoComplete="new-password"
            value={confirm}
            error={fieldError('confirm')}
            onChange={(e) => {
              setConfirm(e.target.value);
              clear('confirm');
            }}
          />
          {others.length > 0 && (
            <p className="profile-note">
              <Icon name="logout" />
              <span>
                {t('profile.password.others', {
                  list: [...new Set(others.map((s) => deviceName(s.device_label, unknown)))].join(', '),
                })}
              </span>
            </p>
          )}
          <p className="profile-note">
            <Icon name={me.role === 'admin' ? 'terminal' : 'info'} />
            <span>
              {me.role === 'admin' ? (
                <Trans i18nKey="profile.password.forgotAdmin" components={{ code: <span className="mono" /> }} />
              ) : (
                t('profile.password.forgotMember')
              )}
            </span>
          </p>
        </div>
        <div className="card-foot">
          <Button kind="primary" type="submit" icon="lock" loading={change.isPending}>
            {t('profile.password.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
