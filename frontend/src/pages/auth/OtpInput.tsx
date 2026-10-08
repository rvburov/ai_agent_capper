import {
  useImperativeHandle,
  useRef,
  type ClipboardEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { useTranslation } from 'react-i18next';

import { OTP_LENGTH } from '../../features/auth/codes';
import { cx } from '../../lib/cx';

export type OtpDigits = readonly string[];

export const EMPTY_OTP: OtpDigits = Array.from({ length: OTP_LENGTH }, () => '');

export function otpValue(digits: OtpDigits): string {
  return digits.join('');
}

export interface OtpHandle {
  /** Фокус на первую пустую клетку (или на первую, если все заполнены). */
  focus: () => void;
}

interface OtpInputProps {
  id: string;
  labelledBy: string;
  value: OtpDigits;
  onChange: (value: OtpDigits) => void;
  /** Набраны все 6 цифр: шаг входа отправляет код сам. */
  onComplete?: (code: string) => void;
  invalid?: boolean;
  describedBy?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  ref?: Ref<OtpHandle>;
}

/**
 * Шесть клеток для кода из приложения (как в макете): автопереход, Backspace назад, стрелки,
 * вставка всего кода. Первая клетка — autocomplete="one-time-code": телефон подставит код сам,
 * весь сразу, и он разложится по клеткам.
 */
export function OtpInput({
  id,
  labelledBy,
  value,
  onChange,
  onComplete,
  invalid,
  describedBy,
  readOnly,
  autoFocus,
  ref,
}: OtpInputProps) {
  const { t } = useTranslation();
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  const focusBox = (index: number) => {
    const box = boxes.current[Math.max(0, Math.min(OTP_LENGTH - 1, index))];
    box?.focus();
    box?.select();
  };

  useImperativeHandle(ref, () => ({
    focus: () => {
      const empty = value.findIndex((d) => !d);
      focusBox(empty < 0 ? 0 : empty);
    },
  }));

  function emit(next: string[]) {
    onChange(next);
    const code = next.join('');
    if (code.length === OTP_LENGTH && /^\d+$/.test(code)) onComplete?.(code);
  }

  function fill(start: number, digits: string[]) {
    const next = [...value];
    let i = start;
    for (const d of digits) {
      if (i >= OTP_LENGTH) break;
      next[i] = d;
      i += 1;
    }
    focusBox(i);
    emit(next);
  }

  function handleInput(index: number, raw: string) {
    let digits = raw.replace(/\D/g, '');
    const prev = value[index] ?? '';
    const next = [...value];
    if (!digits) {
      next[index] = '';
      emit(next);
      return;
    }
    // Ввод поверх цифры без выделения: в поле две цифры, оставляем новую
    if (digits.length === 2 && prev && digits.includes(prev)) {
      digits = digits[0] === prev ? digits.slice(1) : digits.slice(0, 1);
    }
    if (digits.length > 1) {
      fill(index, digits.split(''));
      return;
    }
    next[index] = digits;
    if (index < OTP_LENGTH - 1) focusBox(index + 1);
    emit(next);
  }

  function handleKeyDown(index: number, event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Backspace' && !value[index] && index > 0) {
      event.preventDefault();
      const next = [...value];
      next[index - 1] = '';
      focusBox(index - 1);
      onChange(next);
    } else if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      focusBox(index - 1);
    } else if (event.key === 'ArrowRight' && index < OTP_LENGTH - 1) {
      event.preventDefault();
      focusBox(index + 1);
    }
  }

  function handlePaste(index: number, event: ClipboardEvent<HTMLInputElement>) {
    const digits = event.clipboardData.getData('text').replace(/\D/g, '');
    if (!digits) return;
    event.preventDefault();
    fill(digits.length >= OTP_LENGTH ? 0 : index, digits.split(''));
  }

  const cells = value.map((digit, i) => (
    <input
      // клетки не переставляются: номер клетки — устойчивый ключ
      key={i}
      ref={(el) => {
        boxes.current[i] = el;
      }}
      className={cx('login-otp-box', digit && 'filled')}
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      id={i === 0 ? id : undefined}
      autoComplete={i === 0 ? 'one-time-code' : 'off'}
      aria-label={t('auth.twoFactor.digit', { n: i + 1 })}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      data-autofocus={(i === 0 && autoFocus) || undefined}
      value={digit}
      readOnly={readOnly}
      onChange={(event) => handleInput(i, event.target.value)}
      onKeyDown={(event) => handleKeyDown(i, event)}
      onPaste={(event) => handlePaste(i, event)}
      onFocus={(event) => event.target.select()}
    />
  ));

  return (
    <div className={cx('login-otp', invalid && 'invalid')} role="group" aria-labelledby={labelledBy}>
      {cells.slice(0, 3)}
      <span className="login-otp-sep" aria-hidden="true" />
      {cells.slice(3)}
    </div>
  );
}
