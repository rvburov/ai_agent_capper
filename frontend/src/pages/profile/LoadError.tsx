import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { Button, Callout } from '../../components';

/** Данные карточки не загрузились: текст ошибки сервера и «Повторить». */
export function LoadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="profile-load-error">
      <Callout kind="bad" role="alert">
        {t('profile.loadFailed', { message: errorMessage(error) })}
      </Callout>
      <Button size="sm" icon="refresh" onClick={onRetry}>
        {t('common.retry')}
      </Button>
    </div>
  );
}
