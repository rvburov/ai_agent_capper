import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import { AppIcon } from './AppIcon';
import './Pwa.css';

export interface PushNoticeProps {
  title: string;
  body?: string;
  /** Когда пришло: «сейчас», «12 мин назад». */
  when?: string;
  /** Отдельно, а не в списке экрана блокировки: своя рамка и тень. */
  solo?: boolean;
}

/** Push так, как его покажет телефон (pwa-push макета): значок, название приложения, текст. */
export function PushNotice({ title, body, when, solo = false }: PushNoticeProps) {
  const { t } = useTranslation();
  return (
    <div className={cx('push-notice', solo && 'solo')}>
      <AppIcon size={34} />
      <div className="push-notice-text">
        <div className="push-notice-top">
          <span className="push-notice-app">{t('app.name')}</span>
          <span>{when ?? t('pwa.push.now')}</span>
        </div>
        <div className="push-notice-title">{title}</div>
        {body && <div className="push-notice-body">{body}</div>}
      </div>
    </div>
  );
}
