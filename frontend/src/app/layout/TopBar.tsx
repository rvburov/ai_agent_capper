import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { Button, IconButton } from '../../components';
import { paths } from '../paths';
import { useTheme } from '../theme/themeContext';
import { NotificationsBell } from './NotificationsBell';
import { UserMenu } from './UserMenu';

interface TopBarProps {
  title: string;
  crumbs?: string;
  me: Me;
  onLogout: () => void;
}

/**
 * Шапка: заголовок раздела, «Новый анализ», тема, колокольчик и меню пользователя.
 * Знака AI Capper здесь нет: на компьютере он в боковой панели, а на телефоне заголовку раздела
 * нужна вся ширина (в макете знак в шапке скрыт до 960 px).
 */
export function TopBar({ title, crumbs, me, onLogout }: TopBarProps) {
  const { t } = useTranslation();
  const { resolved, toggle } = useTheme();
  const dark = resolved === 'dark';
  return (
    <header className="topbar">
      <div className="topbar-title">
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
      </div>
      <div className="topbar-actions">
        <Button kind="primary" icon="plus" to={paths.newAnalysis} className="hide-mobile">
          {t('nav.new')}
        </Button>
        <IconButton
          icon={dark ? 'sun' : 'moon'}
          label={dark ? t('shell.themeLight') : t('shell.themeDark')}
          className="hide-mobile"
          onClick={toggle}
        />
        <NotificationsBell />
        <UserMenu me={me} onLogout={onLogout} />
      </div>
    </header>
  );
}
