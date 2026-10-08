import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setViewportWidth } from '../test/setup';
import { Dropdown, type DropdownOption } from './Dropdown';
import { Modal } from './Modal';

const SURFACES: DropdownOption[] = [
  { value: 'hard', label: 'Хард' },
  { value: 'clay', label: 'Грунт' },
  { value: 'grass', label: 'Трава', disabled: true },
  { value: 'indoor', label: 'Крытый' },
];

function Harness({
  initial = null,
  options = SURFACES,
  onChange,
}: {
  initial?: string | null;
  options?: DropdownOption[];
  onChange?: (value: string) => void;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <Dropdown
      label="Покрытие"
      options={options}
      value={value}
      placeholder="Любое"
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

const trigger = () => screen.getByRole('button', { name: /^Покрытие:/ });

describe('Dropdown', () => {
  it('кнопка показывает выбранное значение или подсказку', () => {
    const { unmount } = render(<Harness />);
    expect(trigger()).toHaveAccessibleName('Покрытие: не выбрано');
    expect(trigger().querySelector('.is-current')).toHaveTextContent('Любое');
    unmount();
    render(<Harness initial="clay" />);
    expect(trigger()).toHaveAccessibleName('Покрытие: Грунт');
  });

  it('открывается кликом, выбор мышью закрывает список и возвращает фокус', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    const list = screen.getByRole('listbox', { name: 'Покрытие' });
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
    expect(list).toHaveFocus();
    await user.click(within(list).getByRole('option', { name: /Грунт/ }));
    expect(onChange).toHaveBeenCalledWith('clay');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
    expect(trigger()).toHaveAccessibleName('Покрытие: Грунт');
  });

  it('клавиатура: стрелки пропускают недоступный вариант, Enter выбирает', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial="clay" onChange={onChange} />);
    trigger().focus();
    await user.keyboard('{ArrowDown}');
    const list = screen.getByRole('listbox');
    // открылся на выбранном варианте
    expect(list).toHaveAttribute('aria-activedescendant', within(list).getByRole('option', { name: /Грунт/ }).id);
    await user.keyboard('{ArrowDown}');
    // «Трава» недоступна — активна «Крытый»
    const indoor = within(list).getByRole('option', { name: /Крытый/ });
    expect(list).toHaveAttribute('aria-activedescendant', indoor.id);
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('indoor');
    expect(trigger()).toHaveFocus();
  });

  it('Home, End и переход по первой букве', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    trigger().focus();
    await user.keyboard('{Enter}');
    const list = screen.getByRole('listbox');
    const id = (name: RegExp) => within(list).getByRole('option', { name }).id;
    await user.keyboard('{End}');
    expect(list).toHaveAttribute('aria-activedescendant', id(/Крытый/));
    await user.keyboard('{Home}');
    expect(list).toHaveAttribute('aria-activedescendant', id(/Хард/));
    await user.keyboard('г');
    expect(list).toHaveAttribute('aria-activedescendant', id(/Грунт/));
    await user.keyboard(' ');
    expect(trigger()).toHaveAccessibleName('Покрытие: Грунт');
  });

  it('закрывается, когда кнопка при прокрутке уходит из поля зрения', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    expect(screen.getByRole('listbox')).toHaveFocus();
    // прокрутка на месте: список остается открытым
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    // кнопка ушла за верх экрана
    const offscreen = { top: -300, bottom: -258, left: 0, right: 200, width: 200, height: 42 };
    vi.spyOn(trigger(), 'getBoundingClientRect').mockReturnValue({
      ...offscreen,
      x: 0,
      y: -300,
      toJSON: () => offscreen,
    });
    act(() => window.dispatchEvent(new Event('scroll')));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(trigger()).toHaveAttribute('aria-expanded', 'false');
    // фокус не теряется на body, а возвращается на кнопку
    expect(trigger()).toHaveFocus();
  });

  it('Esc закрывает без выбора и возвращает фокус на кнопку', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(trigger());
    await user.keyboard('{ArrowDown}{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger()).toHaveFocus();
  });

  it('Esc в списке внутри окна закрывает только список', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Modal open title="Фильтр" onClose={onClose}>
        <Harness />
      </Modal>,
    );
    await user.click(trigger());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Фильтр' })).toBeInTheDocument();
  });

  it('клик вне списка закрывает его', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Harness />
        <p>снаружи</p>
      </>,
    );
    await user.click(trigger());
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByText('снаружи'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('длинный список: поле поиска фильтрует варианты, е и е с точками не различаются', async () => {
    const user = userEvent.setup();
    const players: DropdownOption[] = Array.from({ length: 14 }, (_, i) => ({
      value: `p${i}`,
      label: `Игрок ${i}`,
    }));
    players.push({ value: 'federer', label: 'Федерер' }, { value: 'medvedev', label: 'Медведев' });
    const onChange = vi.fn();
    render(<Harness options={players} onChange={onChange} />);
    await user.click(trigger());
    const search = screen.getByRole('combobox', { name: 'Поиск' });
    expect(search).toHaveFocus();
    // «е с точками» во вводе пишем кодом (CLAUDE.md)
    await user.type(search, 'м\u0451дв');
    const list = screen.getByRole('listbox');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    expect(within(list).getByRole('option')).toHaveTextContent('Медведев');
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('medvedev');
  });

  it('ничего не найдено — текст вместо вариантов', async () => {
    const user = userEvent.setup();
    render(
      <Dropdown label="Покрытие" options={SURFACES} value={null} onChange={() => undefined} searchable />,
    );
    await user.click(trigger());
    await user.type(screen.getByRole('combobox'), 'песок');
    expect(screen.getByText('Ничего не найдено')).toBeInTheDocument();
  });

  it('на телефоне список выезжает шторкой с заголовком и кнопкой «Закрыть»', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(trigger());
    const sheet = screen.getByRole('dialog', { name: 'Покрытие' });
    expect(sheet).toHaveClass('dd-sheet');
    await user.click(within(sheet).getByRole('button', { name: 'Закрыть' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('недоступный список не открывается', async () => {
    const user = userEvent.setup();
    render(<Dropdown label="Покрытие" options={SURFACES} value={null} onChange={() => undefined} disabled />);
    await user.click(trigger());
    await act(async () => undefined);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
