import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { EMPTY_OTP, OtpInput, otpValue, type OtpDigits } from './OtpInput';

function Harness({ onComplete }: { onComplete: (code: string) => void }) {
  const [value, setValue] = useState<OtpDigits>(EMPTY_OTP);
  return (
    <>
      <span id="otp-label">Код</span>
      <OtpInput id="otp" labelledBy="otp-label" value={value} onChange={setValue} onComplete={onComplete} />
      <output>{otpValue(value)}</output>
    </>
  );
}

const box = (n: number) => screen.getByRole('textbox', { name: `Цифра ${n} из 6` });

describe('шесть клеток кода', () => {
  it('цифры по клеткам с автопереходом, буквы не принимаются, на шестой — onComplete', async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    const user = userEvent.setup();
    await user.click(box(1));
    await user.keyboard('12a3');
    expect(screen.getByRole('status')).toHaveTextContent('123');
    expect(box(4)).toHaveFocus();
    await user.keyboard('456');
    expect(onComplete).toHaveBeenCalledWith('123456');
  });

  it('Backspace в пустой клетке стирает предыдущую, стрелки двигают фокус', async () => {
    render(<Harness onComplete={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(box(1));
    await user.keyboard('12');
    expect(box(3)).toHaveFocus();
    await user.keyboard('{Backspace}');
    expect(box(2)).toHaveFocus();
    expect(box(2)).toHaveValue('');
    await user.keyboard('{ArrowLeft}');
    expect(box(1)).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(box(2)).toHaveFocus();
  });

  it('вставка всего кода из буфера заполняет клетки с первой', async () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    const user = userEvent.setup();
    await user.click(box(3));
    await user.paste('Код: 987 654');
    expect(onComplete).toHaveBeenCalledWith('987654');
  });

  it('подстановка кода телефоном: весь код одним вводом в первую клетку', () => {
    const onComplete = vi.fn();
    render(<Harness onComplete={onComplete} />);
    fireEvent.change(box(1), { target: { value: '135790' } });
    expect(onComplete).toHaveBeenCalledWith('135790');
    expect(box(6)).toHaveValue('0');
  });
});
