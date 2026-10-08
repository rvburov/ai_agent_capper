import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Spinner } from '../../components';

/** Пока проверяется сеанс: на месте приложения — индикатор. */
export function FullPageLoading() {
  const { t } = useTranslation();
  return (
    <div className="full-state">
      <Spinner size="lg" label={t('shell.checkingSession')} />
    </div>
  );
}

/** Приложение не открылось (сервер недоступен): текст ошибки и «Повторить». */
export function FullPageError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="full-state">
      <Card title={t('shell.loadFailedTitle')}>
        <Callout kind="bad" role="alert">
          {message}
        </Callout>
        <div className="row">
          <Button kind="primary" icon="refresh" onClick={onRetry}>
            {t('common.retry')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
