import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouteError } from 'react-router';

import { Button, Callout, Card } from '../components';
import { paths } from './paths';

/** Экран упал при отрисовке: вместо белой страницы — объяснение и выход. */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <div className="full-state">
      <Card title={t('errors.renderTitle')}>
        <Callout kind="bad" role="alert">
          {t('errors.render')}
        </Callout>
        <div className="row">
          <Button kind="primary" icon="refresh" onClick={() => window.location.reload()}>
            {t('common.reload')}
          </Button>
          <Button href={paths.home}>{t('nav.toHome')}</Button>
        </div>
      </Card>
    </div>
  );
}
