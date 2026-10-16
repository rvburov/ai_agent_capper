import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Icon, Modal, Spinner } from '../../components';
import { useInstallTitle } from './InstallModal';
import { visibleMoreItems, type NavId } from './nav';
import { ThemeNavButton } from './ThemeNavButton';

interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  navId: NavId | undefined;
  isAdmin: boolean;
  onLogout: () => void;
  /** Идет выход (отзыв push и /auth/logout): кнопка «Выйти» неактивна, с индикатором. */
  loggingOut?: boolean;
  /** «Установить на телефон» — окно установки. */
  onInstall: () => void;
}

/** Шторка «Еще» на телефоне: остальные разделы, установка на телефон, тема и выход. */
export function MoreSheet({ open, onClose, navId, isAdmin, onLogout, loggingOut = false, onInstall }: MoreSheetProps) {
  const { t } = useTranslation();
  const installTitle = useInstallTitle();
  return (
    <Modal open={open} onClose={onClose} title={t('nav.more')}>
      <nav className="list" aria-label={t('nav.moreLabel')}>
        {visibleMoreItems(isAdmin).map((item) => (
          <Link
            key={item.id}
            className="nav-link"
            to={item.to}
            aria-current={navId === item.id ? 'page' : undefined}
            onClick={onClose}
          >
            <Icon name={item.icon} />
            {t(`nav.${item.id}`)}
          </Link>
        ))}
        <button
          type="button"
          className="nav-link"
          onClick={() => {
            onClose();
            onInstall();
          }}
        >
          <Icon name="download" />
          {installTitle}
        </button>
        <ThemeNavButton onDone={onClose} />
        <button
          type="button"
          className="nav-link danger"
          disabled={loggingOut}
          aria-busy={loggingOut || undefined}
          onClick={() => {
            onClose();
            onLogout();
          }}
        >
          {loggingOut ? <Spinner size="sm" decorative /> : <Icon name="logout" />}
          {t('nav.logout')}
        </button>
      </nav>
    </Modal>
  );
}
