import { useTranslation } from 'react-i18next';

import { Button, Callout, Card, Spinner } from '../../components';
import { cx } from '../../lib/cx';

/** Пока проверяется сеанс (или грузится экран без оболочки): на месте приложения — индикатор. */
export function FullPageLoading({ label }: { label?: string }) {
  const { t } = useTranslation();
  return (
    <div className="full-state">
      <Spinner size="lg" label={label ?? t('shell.checkingSession')} />
    </div>
  );
}

/**
 * Файл экрана еще грузится (ленивая загрузка, src/app/lazyPage.ts): индикатор на месте
 * экрана; full — на весь экран (вход и регистрация, без оболочки). Появляется с задержкой —
 * на быстрой сети его не видно. При переходе между экранами переход роутера идет в
 * startTransition и прежний экран остается на месте; если новый грузится дольше 300 мс,
 * оболочка показывает индикатор сама (usePendingNavigation) — immediate: без второй задержки.
 */
export function PageLoading({ full = false, immediate = false }: { full?: boolean; immediate?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={cx(full && 'full-state', 'page-loading', immediate && 'now')}>
      <Spinner size="lg" label={t('shell.loadingScreen')} />
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
