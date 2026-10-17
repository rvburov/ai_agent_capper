import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { Button, IconButton } from '../../components';
import { useViewMode } from '../../features/view/context';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { paths } from '../paths';
import { useTheme } from '../theme/themeContext';
import { BankPill } from './BankPill';
import { NotificationsBell } from './NotificationsBell';
import { UserMenu } from './UserMenu';
import { ViewPicker } from './ViewBar';

interface TopBarProps {
  title: string;
  crumbs?: string;
  me: Me;
  onLogout: () => void;
  /** Идет выход (отзыв push и /auth/logout): кнопка «Выйти» неактивна, с индикатором. */
  loggingOut?: boolean;
}

/**
 * Шапка: заголовок раздела, плашка «Банк», «Новый анализ», тема, колокольчик и меню пользователя.
 * Знака AI Capper здесь нет: на компьютере он в боковой панели, а на телефоне заголовку раздела
 * нужна вся ширина (в макете знак в шапке скрыт до 960 px).
 */
export function TopBar({ title, crumbs, me, onLogout, loggingOut = false }: TopBarProps) {
  const { t } = useTranslation();
  const { resolved, toggle } = useTheme();
  const view = useViewMode();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const dark = resolved === 'dark';
  return (
    <header className="topbar">
      <div className="topbar-title">
        {crumbs && <div className="crumbs">{crumbs}</div>}
        <h1>{title}</h1>
      </div>
      <div className="topbar-actions">
        {/* Р27: выбор «Чьи данные смотреть» — у администратора на экранах с данными */}
        {!mobile && view.canPick && view.asUser === null && <ViewPicker me={me} />}
        <BankPill />
        {/* за участника анализ не запускают: в режиме просмотра кнопки нет */}
        {view.asUser === null && (
          <Button kind="primary" icon="plus" to={paths.newAnalysis} className="hide-mobile">
            {t('nav.new')}
          </Button>
        )}
        <IconButton
          icon={dark ? 'sun' : 'moon'}
          label={dark ? t('shell.themeLight') : t('shell.themeDark')}
          className="hide-mobile"
          onClick={toggle}
        />
        <NotificationsBell />
        <UserMenu me={me} onLogout={onLogout} loggingOut={loggingOut} />
      </div>
    </header>
  );
}
