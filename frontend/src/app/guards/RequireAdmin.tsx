import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useMe } from '../../api/hooks/useMe';
import { Button, Card } from '../../components';
import { paths } from '../paths';

/**
 * Раздел только для роли admin. Участнику — объяснение вместо раздела, как в макете.
 * Это удобство интерфейса, а не защита: данные /api/admin/* сервер участнику не отдает (403).
 */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { data: me } = useMe();
  if (me?.role !== 'admin') return <AdminOnly />;
  return children;
}

function AdminOnly() {
  const { t } = useTranslation();
  return (
    <Card title={t('admin.onlyTitle')}>
      <p className="soft">{t('admin.onlyText')}</p>
      <div className="row">
        <Button kind="primary" to={paths.home}>
          {t('nav.toHome')}
        </Button>
      </div>
    </Card>
  );
}
