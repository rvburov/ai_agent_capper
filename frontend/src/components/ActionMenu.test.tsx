import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { setViewportWidth } from '../test/setup';
import { ActionMenu, type ActionMenuEntry } from './ActionMenu';

function items(onBlock: () => void): ActionMenuEntry[] {
  return [
    { id: 'card', icon: 'history', label: 'Активность и входы', onSelect: vi.fn() },
    'separator',
    { id: 'self', icon: 'trash', label: 'Удалить…', hint: 'себя удалить нельзя', disabled: true, onSelect: vi.fn() },
    { id: 'block', icon: 'ban', label: 'Заблокировать', danger: true, onSelect: onBlock },
  ];
}

describe('ActionMenu', () => {
  it('на компьютере: всплывающее меню, стрелки пропускают недоступные пункты, Esc возвращает фокус', async () => {
    const user = userEvent.setup();
    const onBlock = vi.fn();
    render(<ActionMenu title="Ольга" label="Действия: Ольга" items={items(onBlock)} />);
    const button = screen.getByRole('button', { name: 'Действия: Ольга' });
    expect(button).toHaveAttribute('aria-haspopup', 'menu');
    await user.click(button);
    const menu = screen.getByRole('menu', { name: 'Ольга' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(within(menu).getByRole('menuitem', { name: 'Активность и входы' })).toHaveFocus();
    expect(within(menu).getByRole('menuitem', { name: /Удалить…\s*себя удалить нельзя/ })).toBeDisabled();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Заблокировать' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(within(menu).getByRole('menuitem', { name: 'Активность и входы' })).toHaveFocus();
    await user.keyboard('{End}{Enter}');
    expect(onBlock).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();

    await user.click(button);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('клик вне меню закрывает его', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ActionMenu title="Ольга" label="Действия: Ольга" items={items(vi.fn())} />
        <p>снаружи</p>
      </>,
    );
    await user.click(screen.getByRole('button', { name: 'Действия: Ольга' }));
    await user.click(screen.getByText('снаружи'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('на телефоне: шторка с заголовком, выбор пункта закрывает ее', async () => {
    setViewportWidth(375);
    const user = userEvent.setup();
    const onBlock = vi.fn();
    render(<ActionMenu title="Ольга" label="Действия: Ольга" items={items(onBlock)} />);
    await user.click(screen.getByRole('button', { name: 'Действия: Ольга' }));
    const sheet = screen.getByRole('dialog', { name: 'Ольга' });
    await user.click(within(sheet).getByRole('menuitem', { name: 'Заблокировать' }));
    expect(onBlock).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
