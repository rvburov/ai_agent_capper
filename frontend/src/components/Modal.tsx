import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import { IconButton } from './IconButton';

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');


export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Кнопки внизу окна (.modal-foot). */
  footer?: ReactNode;
  wide?: boolean;
  className?: string;
}

/**
 * Модальное окно (.modal): на телефоне — шторка снизу. Esc и клик по фону закрывают,
 * Tab не выходит за пределы окна, после закрытия фокус возвращается туда, где был.
 */
export function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <ModalWindow {...props} />;
}

function ModalWindow({ onClose, title, children, footer, wide = false, className }: ModalProps) {
  const { t } = useTranslation();
  const titleId = useId();
  const backdropRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const pressedOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = boxRef.current;
    // фокус — на поле в теле окна, иначе на само окно: шторка на телефоне открывается с начала
    const field = box?.querySelector<HTMLElement>(
      '.modal-body input:not([disabled]):not([type="hidden"]), .modal-body textarea:not([disabled])',
    );
    (field ?? box)?.focus({ preventScroll: true });
    if (box) box.scrollTop = 0;

    // Esc закрывает только верхнее окно — последнее в документе (его и видно поверх)
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const backdrops = document.querySelectorAll('.modal-backdrop');
      if (backdrops[backdrops.length - 1] !== backdropRef.current) return;
      event.preventDefault();
      onCloseRef.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  function trapTab(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab') return;
    const box = boxRef.current;
    if (!box) return;
    const items = Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => !el.closest('[hidden], [inert]'),
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      box.focus();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === box)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !box.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  // Закрываем, только если и нажатие, и отпускание были на фоне: выделение текста мышью
  // из окна наружу окно не закрывает
  function onBackdropDown(event: MouseEvent<HTMLDivElement>) {
    pressedOnBackdrop.current = event.target === event.currentTarget;
  }
  function onBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (pressedOnBackdrop.current && event.target === event.currentTarget) onClose();
    pressedOnBackdrop.current = false;
  }

  return createPortal(
    <div
      ref={backdropRef}
      className="modal-backdrop"
      onMouseDown={onBackdropDown}
      onClick={onBackdropClick}
    >
      <div
        ref={boxRef}
        className={cx('modal', wide && 'wide', className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={trapTab}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <IconButton icon="x" label={t('common.close')} size="sm" onClick={onClose} />
        </div>
        <div className="modal-body">{children}</div>
        {footer !== undefined && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
