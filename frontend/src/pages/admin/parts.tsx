import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage, isApiError } from '../../api/errors';
import {
  Button,
  Callout,
  Chip,
  Field,
  Icon,
  Modal,
  useToast,
  type IconName,
} from '../../components';
import { initials } from '../../app/layout/initials';
import { copyText } from '../../features/auth/clipboard';
import { personName } from '../../features/admin/people';
import type { AdminUser } from '../../features/admin/types';
import { cx } from '../../lib/cx';

// Общие кусочки вкладок (как одноименные функции в mockup/js/screens/admin.js).

type Person = Pick<AdminUser, 'id' | 'display_name' | 'email'>;

export function Avatar({ user, meId, className }: { user: Person; meId: number; className?: string }) {
  return (
    <span className={cx('adm-ava', user.id === meId && 'me', className)} aria-hidden="true">
      {initials(user.display_name, user.email)}
    </span>
  );
}

/** Человек: кружок, имя (с меткой «вы») и email; boxed — на сером фоне в окнах. */
export function PersonRow({ user, meId, boxed }: { user: Person; meId: number; boxed?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cx('adm-person', boxed && 'adm-person-box')}>
      <Avatar user={user} meId={meId} />
      <div>
        <div className="adm-person-name">
          {personName(user)}
          {user.id === meId && <Chip kind="accent">{t('admin.you')}</Chip>}
        </div>
        <div className="adm-person-mail">{user.email}</div>
      </div>
    </div>
  );
}

export function RoleChip({ role }: { role: AdminUser['role'] }) {
  const { t } = useTranslation();
  return role === 'admin' ? (
    <Chip kind="accent" icon="admin">
      {t('admin.role.admin')}
    </Chip>
  ) : (
    <Chip kind="outline">{t('admin.role.member')}</Chip>
  );
}

export function StatusChip({ status }: { status: AdminUser['status'] }) {
  const { t } = useTranslation();
  if (status === 'blocked') {
    return (
      <Chip kind="bad" icon="ban">
        {t('admin.status.blocked')}
      </Chip>
    );
  }
  return <Chip kind={status === 'active' ? 'good' : 'outline'}>{t(`admin.status.${status}`)}</Chip>;
}

export function TwoFactorChip({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation();
  return enabled ? (
    <Chip kind="good" icon="shield">
      {t('admin.totpOn')}
    </Chip>
  ) : (
    <Chip kind="warn" icon="alert">
      {t('admin.totpOff')}
    </Chip>
  );
}

/** Мелкое пояснение с иконкой «i». */
export function HowTo({ children }: { children: ReactNode }) {
  return (
    <div className="adm-howto">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}

interface ItemProps {
  icon: IconName;
  iconKind?: 'good' | 'info' | 'warn' | 'bad';
  title: ReactNode;
  titleExtra?: ReactNode;
  meta?: ReactNode;
  side?: ReactNode;
  old?: boolean;
}

/** Строка списка: иконка, заголовок с метками, подпись и кнопки справа. */
export function Item({ icon, iconKind, title, titleExtra, meta, side, old }: ItemProps) {
  return (
    <div className={cx('adm-item', old && 'is-old')}>
      <span className={cx('adm-item-ic', iconKind)} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div style={{ minWidth: 0 }}>
        <div className="adm-item-title">
          {title}
          {titleExtra}
        </div>
        {meta !== undefined && <div className="adm-item-meta">{meta}</div>}
      </div>
      <div className="adm-item-side">{side}</div>
    </div>
  );
}

/** Код, который показывается один раз: крупно и с кнопкой «Скопировать». */
export function CodeBox({ code, label }: { code: string; label: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const codeRef = useRef<HTMLElement>(null);
  async function onCopy() {
    const ok = await copyText(code, codeRef.current);
    toast.show(ok ? t('admin.copied') : t('admin.copyFailed'), { icon: ok ? 'copy' : 'alert' });
  }
  return (
    <div className="adm-code">
      <code ref={codeRef} aria-label={`${label}: ${code.split('').join(' ')}`}>
        {code}
      </code>
      <Button size="sm" icon="copy" onClick={() => void onCopy()}>
        {t('admin.copy')}
      </Button>
    </div>
  );
}

interface OtpFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error?: ReactNode;
}

/** Код 2FA администратора для опасного действия: только 6 цифр. */
export function OtpField({ id, value, onChange, error }: OtpFieldProps) {
  const { t } = useTranslation();
  return (
    <Field
      id={id}
      className="adm-otp"
      label={t('admin.confirm.otpLabel')}
      hint={t('admin.confirm.otpHint')}
      error={error}
      value={value}
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder="000000"
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

// Ошибки кода 2FA показываем под полем кода, остальные — плашкой над кнопками
const OTP_ERRORS = new Set(['admin.totp_required', 'admin.totp_rate_limited']);

export function isOtpError(error: unknown): boolean {
  return isApiError(error) && OTP_ERRORS.has(error.code);
}

interface ConfirmDialogProps {
  title: ReactNode;
  children: ReactNode;
  confirmLabel: string;
  icon?: IconName;
  danger?: boolean;
  wide?: boolean;
  /** Нужен код 2FA администратора: поле под текстом, кнопка доступна после 6 цифр. */
  otp?: boolean;
  /** Дополнительное условие доступности кнопки (email при удалении). */
  ready?: boolean;
  /** Запрос к серверу; код 2FA — пустая строка, если otp не нужен. */
  run: (totpCode: string) => Promise<unknown>;
  /** Действие выполнено: окно закрывается, родитель показывает сообщение. */
  onDone: () => void;
  onClose: () => void;
}

/**
 * Окно подтверждения действия (confirmModal и confirm2fa макета). Пока идет запрос, кнопка
 * показывает индикатор; ошибка сервера остается в окне, а не теряется в сообщении внизу.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  icon,
  danger,
  wide,
  otp = false,
  ready = true,
  run,
  onDone,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const [code, setCode] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const canConfirm = ready && (!otp || /^\d{6}$/.test(code)) && !pending;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canConfirm) return;
    setPending(true);
    setError(null);
    try {
      await run(code);
      onDone();
    } catch (err) {
      setError(err);
      if (isOtpError(err)) setCode('');
      setPending(false);
    }
  }

  const otpError = error !== null && isOtpError(error) ? errorMessage(error) : undefined;
  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      wide={wide}
      footer={
        <>
          <Button onClick={onClose}>{t('admin.confirm.cancel')}</Button>
          <Button
            type="submit"
            form={formId}
            kind={danger ? 'danger' : 'primary'}
            icon={icon}
            disabled={!canConfirm && !pending}
            loading={pending}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" noValidate onSubmit={(e) => void onSubmit(e)}>
        {children}
        {otp && (
          <OtpField
            id={`${formId}-otp`}
            value={code}
            onChange={(value) => {
              setCode(value);
              if (otpError) setError(null);
            }}
            error={otpError}
          />
        )}
        {error !== null && !otpError && (
          <Callout kind="bad" role="alert">
            {errorMessage(error)}
          </Callout>
        )}
      </form>
    </Modal>
  );
}

/** Данные не загрузились: текст ошибки и «Повторить». */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="stack" style={{ alignItems: 'flex-start' }}>
      <Callout kind="bad" role="alert">
        {t('admin.loadFailed', { message: errorMessage(error) })}
      </Callout>
      <Button size="sm" icon="refresh" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
