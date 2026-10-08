import { useId, useState, type ComponentPropsWithRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import { Icon } from './Icon';

interface FieldShellProps {
  /** id элемента управления: к нему привязана подпись. */
  id: string;
  label?: ReactNode;
  /** Текст справа от подписи («Забыли пароль?»). */
  labelAside?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** id подсказки или ошибки для aria-describedby элемента управления. */
export function describedById(id: string, hint: ReactNode, error: ReactNode): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

/** Рамка поля: подпись, элемент управления, подсказка или ошибка. Для своих элементов (Dropdown). */
export function FieldShell({ id, label, labelAside, hint, error, className, children }: FieldShellProps) {
  return (
    <div className={cx('field', className)}>
      {label !== undefined && (
        <label className="field-label" htmlFor={id}>
          <span>{label}</span>
          {labelAside}
        </label>
      )}
      {children}
      {error ? (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      ) : (
        hint && (
          <div className="field-hint" id={`${id}-hint`}>
            {hint}
          </div>
        )
      )}
    </div>
  );
}

interface FieldOwnProps {
  label?: ReactNode;
  labelAside?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  /** Единица справа в поле: «₽», «%». */
  suffix?: ReactNode;
  className?: string;
}

type InputFieldProps = FieldOwnProps &
  Omit<ComponentPropsWithRef<'input'>, 'className' | 'children'> & { multiline?: false };
type TextareaFieldProps = FieldOwnProps &
  Omit<ComponentPropsWithRef<'textarea'>, 'className' | 'children'> & { multiline: true };

export type FieldProps = InputFieldProps | TextareaFieldProps;

/** Поле ввода с подписью: строка, многострочное (multiline) или пароль с кнопкой «Показать». */
export function Field(props: FieldProps) {
  const autoId = useId();
  const id = props.id ?? autoId;
  const { label, labelAside, hint, error, className } = props;
  const describedBy = describedById(id, hint, error);
  const invalid = Boolean(error);

  let control: ReactNode;
  if (props.multiline) {
    const { label: _l, labelAside: _a, hint: _h, error: _e, suffix: _s, className: _c, multiline: _m, ...rest } =
      props;
    control = (
      <textarea
        rows={4}
        {...rest}
        id={id}
        className={cx('textarea', invalid && 'invalid')}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
      />
    );
  } else {
    const { label: _l, labelAside: _a, hint: _h, error: _e, suffix, className: _c, multiline: _m, ...rest } =
      props;
    control =
      rest.type === 'password' ? (
        <PasswordInput {...rest} id={id} invalid={invalid} describedBy={describedBy} />
      ) : (
        <TextInput {...rest} id={id} invalid={invalid} describedBy={describedBy} suffix={suffix} />
      );
  }
  return (
    <FieldShell id={id} label={label} labelAside={labelAside} hint={hint} error={error} className={className}>
      {control}
    </FieldShell>
  );
}

interface ControlProps extends Omit<ComponentPropsWithRef<'input'>, 'className' | 'children' | 'id'> {
  id: string;
  invalid: boolean;
  describedBy: string | undefined;
}

function TextInput({ id, invalid, describedBy, suffix, ...rest }: ControlProps & { suffix?: ReactNode }) {
  const input = (
    <input
      type="text"
      {...rest}
      id={id}
      className={cx('input', suffix !== undefined && 'has-suffix', invalid && 'invalid')}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
    />
  );
  if (suffix === undefined) return input;
  return (
    <div className="input-wrap">
      {input}
      <span className="input-suffix">{suffix}</span>
    </div>
  );
}

function PasswordInput({ id, invalid, describedBy, ...rest }: ControlProps) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <div className="input-wrap">
      <input
        {...rest}
        type={visible ? 'text' : 'password'}
        id={id}
        className={cx('input', 'has-action', invalid && 'invalid')}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoCapitalize="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="input-action"
        aria-label={visible ? t('common.hidePassword') : t('common.showPassword')}
        aria-pressed={visible}
        aria-controls={id}
        onClick={() => setVisible((v) => !v)}
      >
        <Icon name={visible ? 'eyeOff' : 'eye'} />
      </button>
    </div>
  );
}
