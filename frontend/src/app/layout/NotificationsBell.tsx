import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import { Button, Icon, Spinner } from '../../components';
import {
  badgeText,
  internalLink,
  notificationLook,
  type NotificationItem,
} from '../../features/notifications/notifications';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '../../features/notifications/useNotifications';
import { formatDateTime } from '../../lib/format';
import { cx } from '../../lib/cx';
import { matchesMedia, SHEET_QUERY } from '../../lib/useMediaQuery';
import { paths } from '../paths';
import './NotificationsBell.css';

/**
 * Колокольчик и центр уведомлений (Р3, mockup/js/app.js): счетчик непрочитанных, список
 * под кнопкой на компьютере и шторкой снизу на телефоне. Клик по уведомлению отмечает его
 * прочитанным и ведет по его ссылке; «Прочитать все»; «Что присылать» — настройки в кабинете.
 */
export function NotificationsBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const query = useNotifications();
  const markRead = useMarkNotificationRead();
  const markAll = useMarkAllNotificationsRead();
  const [open, setOpen] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const popId = useId();
  const titleId = useId();

  const unread = query.data?.unread ?? 0;
  const items = query.data?.items ?? [];

  function close(returnFocus: boolean) {
    setOpen(false);
    setStyle(null);
    if (returnFocus) buttonRef.current?.focus({ preventScroll: true });
  }

  function toggle() {
    if (open) {
      close(true);
      return;
    }
    setSheet(matchesMedia(SHEET_QUERY));
    setOpen(true);
    void query.refetch();
  }

  // На компьютере — под кнопкой по правому краю, как в макете
  useLayoutEffect(() => {
    if (!open || sheet) return;
    function place() {
      const r = buttonRef.current?.getBoundingClientRect();
      if (!r) return;
      setStyle({
        top: Math.round(r.bottom + 8),
        right: Math.max(12, Math.round(window.innerWidth - r.right - 8)),
      });
    }
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, sheet]);

  useEffect(() => {
    if (!open) return;
    popRef.current?.focus({ preventScroll: true });
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      Boolean(popRef.current?.contains(target) || buttonRef.current?.contains(target));
    function onPointerDown(event: PointerEvent) {
      if (!inside(event.target)) close(false);
    }
    // Фокус ушел на другой элемент страницы (Tab) — список закрывается, как меню пользователя
    function onFocusIn(event: FocusEvent) {
      if (!inside(event.target)) close(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      close(true);
    }
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  function openItem(item: NotificationItem) {
    if (!item.read_at) markRead.mutate(item.id);
    const link = internalLink(item.link);
    if (link) {
      close(false);
      void navigate(link);
    }
  }

  const label = unread ? t('notifications.unreadLabel', { count: unread }) : t('shell.notifications');

  let list;
  if (query.isPending) {
    list = (
      <div className="empty">
        <Spinner label={t('common.loading')} />
      </div>
    );
  } else if (query.isError && !items.length) {
    list = (
      <div className="empty" role="alert">
        {t('notifications.loadFailed')}
      </div>
    );
  } else if (!items.length) {
    list = <div className="empty">{t('notifications.empty')}</div>;
  } else {
    list = (
      <ul className="notif-list-items">
        {items.map((item) => {
          const look = notificationLook(item.kind);
          return (
            <li key={item.id}>
              <button
                type="button"
                className={cx('notif-item', !item.read_at && 'unread')}
                onClick={() => openItem(item)}
              >
                <span className={cx('notif-ic', look.tone)} aria-hidden="true">
                  <Icon name={look.icon} />
                </span>
                <span className="notif-text">
                  <span className="notif-title">{item.title}</span>
                  {item.body && <span className="notif-body">{item.body}</span>}
                  <span className="notif-time">{formatDateTime(item.created_at)}</span>
                </span>
                {!item.read_at && (
                  <>
                    <span className="notif-dot" aria-hidden="true" />
                    <span className="sr-only">{t('notifications.unread')}</span>
                  </>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="btn ghost icon-only bell-btn"
        aria-label={label}
        title={t('shell.notifications')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        onClick={toggle}
      >
        <Icon name="bell" />
        <span className="bell-badge" aria-hidden="true" hidden={!unread}>
          {unread ? badgeText(unread) : ''}
        </span>
      </button>
      {open &&
        createPortal(
          <>
            {sheet && <div className="notif-back" aria-hidden="true" />}
            <div
              ref={popRef}
              id={popId}
              className={cx('notif-pop', sheet && 'sheet')}
              role="dialog"
              aria-labelledby={titleId}
              tabIndex={-1}
              style={sheet ? undefined : { ...style, visibility: style ? undefined : 'hidden' }}
            >
              {sheet && <div className="dd-sheet-grip" aria-hidden="true" />}
              <div className="notif-head">
                <h2 className="notif-head-title" id={titleId}>
                  {t('notifications.title')}
                </h2>
                <Button kind="ghost" size="sm" onClick={() => markAll.mutate(undefined)}>
                  {t('notifications.readAll')}
                </Button>
              </div>
              <div className="notif-list">{list}</div>
              <div className="notif-foot">
                <Link to={paths.profile('notifications')} onClick={() => close(false)}>
                  <Icon name="sliders" />
                  {t('notifications.settings')}
                </Link>
                <span className="xsmall muted">{t('notifications.channels')}</span>
              </div>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
