import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Combobox, type ComboOption } from './Dropdown';

const PLAYERS: ComboOption[] = [
  { value: '1', label: 'Янник Синнер', hint: 'ITA · №1' },
  { value: '6', label: 'Хольгер Руне', hint: 'DEN · №6' },
  { value: '5', label: 'Андрей Рублев' },
];

function Harness({
  options = PLAYERS,
  loading = false,
  minChars,
  onPick,
}: {
  options?: ComboOption[];
  loading?: boolean;
  minChars?: number;
  onPick?: (option: ComboOption) => void;
}) {
  const [text, setText] = useState('');
  const shown = options.filter((o) => o.label.toLowerCase().includes(text.trim().toLowerCase()));
  return (
    <Combobox
      label="Игрок 1"
      value={text}
      onChange={setText}
      options={shown}
      loading={loading}
      minChars={minChars}
      onPick={(option) => {
        setText(option.label);
        onPick?.(option);
      }}
    />
  );
}

describe('Combobox', () => {
  it('подсказки с двух букв; клик ставит игрока, фокус остается в поле', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'р');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(input, 'у');
    const list = screen.getByRole('listbox', { name: 'Игрок 1' });
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Хольгер РунеDEN · №6',
      'Андрей Рублев',
    ]);
    expect(input).toHaveAttribute('aria-expanded', 'true');
    await user.click(within(list).getByRole('option', { name: /Хольгер Руне/ }));
    expect(onPick).toHaveBeenCalledWith(PLAYERS[1]);
    expect(input).toHaveValue('Хольгер Руне');
    expect(input).toHaveFocus();
  });

  it('стрелки и Enter; Enter без выбора ничего не подставляет; Esc закрывает', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    render(<Harness onPick={onPick} minChars={1} />);
    const input = screen.getByRole('combobox');
    await user.type(input, 'н');
    await user.keyboard('{Enter}');
    expect(onPick).not.toHaveBeenCalled();
    await user.keyboard('{ArrowDown}{ArrowDown}');
    const active = input.getAttribute('aria-activedescendant');
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)).toHaveTextContent('Хольгер Руне');
    await user.keyboard('{ArrowUp}{Enter}');
    expect(onPick).toHaveBeenCalledWith(PLAYERS[0]);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await user.clear(input);
    await user.type(input, 'ан');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('пока грузится — «Ищем…», потом «Ничего не найдено»', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Harness options={[]} loading />);
    await user.type(screen.getByRole('combobox'), 'зверев');
    expect(screen.getByRole('listbox')).toHaveTextContent('Ищем…');
    rerender(<Harness options={[]} />);
    expect(screen.getByRole('listbox')).toHaveTextContent('Ничего не найдено');
  });
});
