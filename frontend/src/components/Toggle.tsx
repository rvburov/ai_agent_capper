import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import { cx } from '../lib/cx';

export interface ToggleProps
  extends Omit<ComponentPropsWithRef<'input'>, 'type' | 'checked' | 'onChange' | 'children' | 'className'> {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  className?: string;
}

/** Выключатель (.switch) с подписью слева: включает настройку сразу, без кнопки «Сохранить». */
export function Toggle({ label, hint, checked, onChange, className, id, ...rest }: ToggleProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const hintId = hint !== undefined ? `${inputId}-hint` : undefined;
  return (
    <label className={cx('toggle', className)} htmlFor={inputId}>
      <div className="toggle-text">
        <div className="toggle-label">{label}</div>
        {hint !== undefined && (
          <div className="field-hint" id={hintId}>
            {hint}
          </div>
        )}
      </div>
      <span className="switch">
        <input
          {...rest}
          type="checkbox"
          role="switch"
          id={inputId}
          checked={checked}
          aria-describedby={hintId}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span />
      </span>
    </label>
  );
}
