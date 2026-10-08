import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './Button';
import { Field } from './Field';
import { Modal } from './Modal';

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Открыть</Button>
      <Modal
        open={open}
        title="Новый код"
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
        footer={<Button kind="primary">Создать</Button>}
      >
        <Field label="Email" type="email" />
      </Modal>
    </>
  );
}

describe('Modal', () => {
  it('открывается с фокусом на поле, Esc закрывает и возвращает фокус', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByRole('button', { name: 'Открыть' });
    await user.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Новый код' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('Email')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('Tab не уходит из окна', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    const email = screen.getByLabelText('Email');
    const create = screen.getByRole('button', { name: 'Создать' });
    const close = screen.getByRole('button', { name: 'Закрыть' });
    expect(email).toHaveFocus();
    await user.tab();
    expect(create).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.tab({ shift: true });
    expect(create).toHaveFocus();
  });

  it('с последнего элемента Tab ведет на первый, Shift+Tab с первого — на последний', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    const close = screen.getByRole('button', { name: 'Закрыть' });
    const create = screen.getByRole('button', { name: 'Создать' });
    close.focus();
    await user.tab({ shift: true });
    expect(create).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
  });

  it('кнопка «Закрыть» и клик по фону закрывают окно, клик внутри — нет', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    await user.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Закрыть' }));
    expect(onClose).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Открыть' }));
    const backdrop = document.querySelector('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as Element);
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it('Esc закрывает только верхнее из двух окон', async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    function Nested() {
      const [confirm, setConfirm] = useState(false);
      return (
        <Modal open title="Внешнее" onClose={outer}>
          <Button onClick={() => setConfirm(true)}>Удалить</Button>
          <Modal open={confirm} title="Точно удалить?" onClose={() => setConfirm(false)}>
            <p>Действие не отменить.</p>
          </Modal>
        </Modal>
      );
    }
    render(<Nested />);
    await user.click(screen.getByRole('button', { name: 'Удалить' }));
    expect(screen.getByRole('dialog', { name: 'Точно удалить?' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Точно удалить?' })).not.toBeInTheDocument();
    expect(outer).not.toHaveBeenCalled();
    // фокус вернулся на кнопку во внешнем окне, следующий Esc закрывает его
    expect(screen.getByRole('button', { name: 'Удалить' })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(outer).toHaveBeenCalledTimes(1);
  });
});
