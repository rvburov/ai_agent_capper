import { useTranslation } from 'react-i18next';

import { Card, EmptyState } from '../../components';
import { BrandMark } from '../../app/layout/BrandMark';
import { useDocumentTitle } from '../../app/useDocumentTitle';

export type AuthScreen = 'login' | 'register' | 'reset';

/** Экраны без оболочки: вход, регистрация, сброс пароля. Формы на настоящем API — следующая сборка. */
export function AuthStubPage({ screen }: { screen: AuthScreen }) {
  const { t } = useTranslation();
  const title = t(`pages.${screen}`);
  useDocumentTitle(title);
  return (
    <main className="auth-page">
      <div className="auth-box">
        <div className="brand">
          <BrandMark />
          <div>
            <div className="brand-name">{t('app.name')}</div>
            <div className="brand-sub">{t('app.tagline')}</div>
          </div>
        </div>
        <Card>
          <EmptyState icon="lock" title={title} titleAs="h1" text={t('stub.auth')} />
        </Card>
      </div>
    </main>
  );
}
