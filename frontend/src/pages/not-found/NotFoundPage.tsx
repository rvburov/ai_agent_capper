import { useTranslation } from 'react-i18next';

import { Button, Card, EmptyState } from '../../components';
import { paths } from '../../app/paths';

export function NotFoundPage() {
  const { t } = useTranslation();
  return (
    <Card>
      <EmptyState
        icon="search"
        title={t('notFound.title')}
        text={t('notFound.text')}
        action={
          <Button kind="primary" to={paths.home}>
            {t('nav.toHome')}
          </Button>
        }
      />
    </Card>
  );
}
