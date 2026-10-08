import { useTranslation } from 'react-i18next';

import { formatMoney } from '../../lib/format';

export function HomePage() {
  const { t } = useTranslation();
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 'var(--gutter)' }}>
      <h1 style={{ fontFamily: 'var(--font-display)' }}>{t('app.name')}</h1>
      <p>{t('home.status')}</p>
      <p style={{ color: 'var(--fg-2)' }}>
        {t('home.currencyExample', {
          rub: formatMoney(48133, 'RUB'),
          usd: formatMoney(520.5, 'USD'),
          eur: formatMoney(480, 'EUR'),
        })}
      </p>
    </main>
  );
}
