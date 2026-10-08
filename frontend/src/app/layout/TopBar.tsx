import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { Button, IconButton, useToast } from '../../components';
import { paths } from '../paths';
import { useTheme } from '../theme/themeContext';
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
  const toast = useToast();
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
        {/* Центр уведомлений — этап 4; пока кнопка только сообщает об этом */}
        <IconButton
          icon="bell"
          label={t('shell.notifications')}
          className="bell-btn"
          onClick={() => toast.show(t('shell.notificationsSoon'), { icon: 'bell' })}
        />
        <UserMenu me={me} onLogout={onLogout} />
      </div>
    </header>
  );
}
