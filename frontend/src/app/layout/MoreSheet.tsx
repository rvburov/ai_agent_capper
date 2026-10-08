import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { Icon, Modal } from '../../components';
import { visibleMoreItems, type NavId } from './nav';
import { ThemeNavButton } from './ThemeNavButton';

interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  navId: NavId | undefined;
  isAdmin: boolean;
  onLogout: () => void;
}

/** Шторка «Еще» на телефоне: остальные разделы, тема и выход. */
export function MoreSheet({ open, onClose, navId, isAdmin, onLogout }: MoreSheetProps) {
  const { t } = useTranslation();
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
        <ThemeNavButton onDone={onClose} />
        <button
          type="button"
          className="nav-link danger"
          onClick={() => {
            onClose();
            onLogout();
          }}
        >
          <Icon name="logout" />
          {t('nav.logout')}
        </button>
      </nav>
    </Modal>
  );
}
