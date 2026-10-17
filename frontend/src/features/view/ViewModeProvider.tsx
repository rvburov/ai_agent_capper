import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { ReadOnlyContext, useToast, type ReadOnlyState } from '../../components';
import { ViewModeContext, type ViewMode } from './context';
import {
  isViewablePath,
  parseViewParam,
  switchTarget,
  VIEW_PREFIX,
  viewTo,
  withViewSearch,
} from './viewMode';

interface Tracked {
  /** ?as= из адреса при прошлой отрисовке: новое значение в адресе — новый выбор. */
  urlAs: number | null;
  pathname: string;
  /** Чьи данные открыты: переживает переход по ссылке без ?as= между экранами режима. */
  chosen: number | null;
}

/**
 * Режим просмотра данных участника (Р27, mockup/js/view.js). Источник — адрес (?as=<id>); выбор
 * держится и при переходе по ссылке без параметра между экранами режима (меню, «Все ставки»):
 * параметр дописывается в адрес сам. Экран вне режима (игроки, кабинет, администрирование)
 * возвращает к своим данным. ?as= принимается только у администратора; у участника экран
 * показывает ошибку (denied), а сервер на такой запрос ответил бы 403.
 */
export function ViewModeProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const urlAs = parseViewParam(location.search);
  const viewable = isViewablePath(location.pathname);

  const [tracked, setTracked] = useState<Tracked>(() => ({
    urlAs,
    pathname: location.pathname,
    chosen: viewable ? urlAs : null,
  }));
  // Сверка с адресом во время отрисовки (а не в эффекте): первый же кадр нового экрана
  // запрашивает данные того, кого нужно, без мелькания своих
  let chosen = tracked.chosen;
  if (tracked.urlAs !== urlAs || tracked.pathname !== location.pathname) {
    if (urlAs !== tracked.urlAs && urlAs !== null) chosen = urlAs;
    if (!viewable) chosen = null;
    setTracked({ urlAs, pathname: location.pathname, chosen });
  }

  const ownId = me?.id ?? null;
  const asUser = isAdmin && viewable && chosen !== null && chosen !== ownId ? chosen : null;
  const denied = me !== undefined && !isAdmin && urlAs !== null && urlAs !== ownId;

  // В адресе нет ?as= (перешли по ссылке) — дописываем; свой id в ?as= — убираем
  useEffect(() => {
    if (asUser !== null && urlAs !== asUser) {
      void navigate(
        { pathname: location.pathname, search: withViewSearch(location.search, asUser), hash: location.hash },
        { replace: true, state: location.state as unknown },
      );
    } else if (isAdmin && urlAs !== null && urlAs === ownId) {
      void navigate(
        { pathname: location.pathname, search: withViewSearch(location.search, null), hash: location.hash },
        { replace: true, state: location.state as unknown },
      );
    }
  }, [asUser, urlAs, ownId, isAdmin, navigate, location]);

  // Выход из режима (кнопкой или переходом на другой экран): подсказка и чужие данные — из кэша
  const previous = useRef(asUser);
  useEffect(() => {
    const was = previous.current;
    previous.current = asUser;
    if (was !== null && was !== asUser) {
      client.removeQueries({ queryKey: [VIEW_PREFIX, was] });
      if (asUser === null) toast.show(t('view.backToOwn'), { icon: 'user' });
    }
  }, [asUser, client, toast, t]);

  const open = useCallback(
    (id: number, to?: string) => {
      setTracked((prev) => ({ ...prev, chosen: id }));
      void navigate(viewTo(to ?? switchTarget(location.pathname), id));
    },
    [navigate, location.pathname],
  );
  const exit = useCallback(() => {
    setTracked((prev) => ({ ...prev, chosen: null }));
    void navigate({ pathname: switchTarget(location.pathname), search: '' });
  }, [navigate, location.pathname]);

  const value = useMemo<ViewMode>(
    () => ({ asUser, denied, canPick: isAdmin && viewable, open, exit }),
    [asUser, denied, isAdmin, viewable, open, exit],
  );
  const readOnly = useMemo<ReadOnlyState | null>(
    () =>
      asUser === null
        ? null
        : { hint: t('view.roHint'), onBlocked: (hint) => toast.show(hint, { icon: 'lock' }) },
    [asUser, t, toast],
  );

  return (
    <ViewModeContext.Provider value={value}>
      <ReadOnlyContext.Provider value={readOnly}>{children}</ReadOnlyContext.Provider>
    </ViewModeContext.Provider>
  );
}
