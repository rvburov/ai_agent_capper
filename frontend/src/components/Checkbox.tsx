import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface CheckboxProps
  extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'checked' | 'onChange' | 'children' | 'className'> {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

/** Флажок с подписью (.check): согласия, выбор нескольких вариантов. */
export function Checkbox({ label, hint, checked, onChange, className, id, ...rest }: CheckboxProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint !== undefined ? `${inputId}-hint` : undefined;
  return (
    <label className={cx('check', className)} htmlFor={inputId}>
      <input
        {...rest}
        type="checkbox"
        id={inputId}
        checked={checked}
        aria-describedby={hintId}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="check-text">
        <span>{label}</span>
        {hint !== undefined && (
          <span className="field-hint" id={hintId}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
