import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { api } from '../../api/client';
import { Button, Icon, IconButton, useToast } from '../../components';
import { COURT_PATH } from '../../pwa/build';
import { BrandMark } from '../layout/BrandMark';
import { useTheme } from '../theme/themeContext';
import './offline.css';

/** Есть ли связь с сервером: GET /api/health без кэша. */
export async function serverReachable(): Promise<boolean> {
  try {
    const { response } = await api.GET('/api/health', { cache: 'no-store' });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * «Нет связи с интернетом» (mockup/js/screens/offline.js, В7): ставки и банк на устройстве не
 * хранятся, поэтому без связи — эта страница, а не старые цифры. «Повторить» проверяет связь с
 * сервером; когда браузер сообщает, что связь вернулась, экран уходит сам (onBack). Без меню и
 * данных: тексты и стили — в начальной загрузке. Та же разметка — в offline.html (src/pwa/build.ts).
 */
export function OfflineScreen({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const { resolved, toggle } = useTheme();
  const [checking, setChecking] = useState(false);
  const [status, setStatus] = useState('');
  const onBackRef = useRef(onBack);
  useLayoutEffect(() => {
    onBackRef.current = onBack;
  });
  const title = `${t('pwa.offline.pageTitle')} · ${t('app.name')}`;

  // Заголовок вкладки — «Нет связи»; экран ушел — прежний заголовок экрана
  useEffect(() => {
    const previous = document.title;
    document.title = title;
    return () => {
      document.title = previous;
    };
  }, [title]);

  useEffect(() => {
    const back = () => onBackRef.current();
    window.addEventListener('online', back);
    return () => window.removeEventListener('online', back);
  }, []);

  async function retry() {
    if (checking) return;
    setChecking(true);
    setStatus(t('pwa.offline.checking'));
    const ok = await serverReachable();
    setChecking(false);
    if (!ok) {
      setStatus(t('pwa.offline.still'));
      return;
    }
    setStatus('');
    toast.show(t('pwa.offline.back'), { icon: 'check' });
    onBackRef.current();
  }

  const dark = resolved === 'dark';
  return (
    <div className="off-page">
      <main className="off-card" aria-labelledby="off-title">
        <div className="off-court" aria-hidden="true">
          <svg viewBox="0 0 400 132" preserveAspectRatio="none">
            <path className="ln" d={COURT_PATH} />
          </svg>
        </div>
        <div className="off-top">
          <div className="off-brand">
            <BrandMark />
            <span className="brand-name">{t('app.name')}</span>
          </div>
          <IconButton icon={dark ? 'sun' : 'moon'} label={dark ? t('shell.themeLight') : t('shell.themeDark')} onClick={toggle} />
        </div>
        <div className="off-ic" aria-hidden="true">
          <Icon name="wifiOff" />
        </div>
        <h1 id="off-title">{t('pwa.offline.title')}</h1>
        <p className="off-lead">{t('pwa.offline.lead')}</p>
        <ul className="off-list">
          {(['tip1', 'tip2', 'tip3'] as const).map((key) => (
            <li key={key}>
              <Icon name="check" />
              <span>{t(`pwa.offline.${key}`)}</span>
            </li>
          ))}
        </ul>
        <Button kind="primary" size="lg" block icon="refresh" loading={checking} disabled={checking} onClick={() => void retry()}>
          {t('pwa.offline.retry')}
        </Button>
        <div className="off-status" role="status" aria-live="polite">
          {status}
        </div>
        <p className="off-foot">{t('pwa.offline.foot')}</p>
      </main>
    </div>
  );
}
