import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouteError } from 'react-router';

import { Button, Callout, Card } from '../components';
import { FullPageLoading } from './layout/FullPageState';
import { chunkReloadedRecently, claimChunkReload, isChunkLoadError } from './lazyPage';
import { paths } from './paths';
import { reloadPage } from './reloadPage';

/**
 * Экран упал при отрисовке: вместо белой страницы — объяснение и выход. Файл экрана не
 * загрузился (вышла новая версия, пропала связь) — страница один раз перезагружается сама.
 * Если ошибка повторилась сразу после этого, новая версия уже загружена — значит, сбой:
 * «Экран не загрузился» и «Обновить страницу», без цикла. Текст про новую версию — только
 * когда сама страница не перезагружалась (браузер запретил sessionStorage).
 */
export function RouteError() {
  const { t } = useTranslation();
  const error = useRouteError();
  const chunk = isChunkLoadError(error);
  const [reloading, setReloading] = useState(false);

  useEffect(() => {
    console.error(error);
    if (chunk && claimChunkReload()) {
      setReloading(true);
      reloadPage();
    }
  }, [error, chunk]);

  if (reloading) return <FullPageLoading label={t('errors.chunkReloading')} />;

  const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
  let title = t('errors.renderTitle');
  let text = t('errors.render');
  if (chunk && offline) {
    title = t('errors.chunkOfflineTitle');
    text = t('errors.chunkOffline');
  } else if (chunk && chunkReloadedRecently()) {
    title = t('errors.chunkRepeatTitle');
    text = t('errors.chunkRepeat');
  } else if (chunk) {
    title = t('errors.chunkTitle');
    text = t('errors.chunk');
  }
  return (
    <div className="full-state">
      <Card title={title}>
        <Callout kind={chunk ? 'warn' : 'bad'} role="alert">
          {text}
        </Callout>
        <div className="row">
          <Button kind="primary" icon="refresh" onClick={reloadPage}>
            {t('common.reload')}
          </Button>
          <Button href={paths.home}>{t('nav.toHome')}</Button>
        </div>
      </Card>
    </div>
  );
}
