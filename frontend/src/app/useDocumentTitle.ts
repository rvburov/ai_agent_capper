import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';

/** Заголовок вкладки браузера: «Ставки · AI Capper». */
export function useDocumentTitle(title: string | undefined): void {
  const { t } = useTranslation();
  const app = t('app.name');
  useEffect(() => {
    document.title = title ? `${title} · ${app}` : app;
  }, [title, app]);
}
