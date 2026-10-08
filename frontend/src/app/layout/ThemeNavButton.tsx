import { useTranslation } from 'react-i18next';

import { Icon } from '../../components';
import { useTheme } from '../theme/themeContext';

/** Пункт меню «Темная тема» / «Светлая тема» (боковая панель и шторка «Еще»). */
export function ThemeNavButton({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const { resolved, toggle } = useTheme();
  const dark = resolved === 'dark';
  return (
    <button
      type="button"
      className="nav-link"
      onClick={() => {
        onDone?.();
        toggle();
      }}
    >
      <Icon name={dark ? 'sun' : 'moon'} />
      {dark ? t('shell.themeLight') : t('shell.themeDark')}
    </button>
  );
}
