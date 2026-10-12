import { useTranslation } from 'react-i18next';

import { Chip } from './Chip';

export type Freshness = 'fresh' | 'stale' | 'unconfirmed' | 'missing';

/**
 * Свежесть новостей игрока перед анализом (freshChip в mockup/js/screens/new-analysis.js):
 * свежие (моложе 12 ч), поищем перед анализом, имя не подтверждено, анализ с ним не запустим.
 */
export function FreshnessChip({ state }: { state: Freshness }) {
  const { t } = useTranslation();
  switch (state) {
    case 'fresh':
      return (
        <Chip kind="good" icon="check">
          {t('new.fresh.fresh')}
        </Chip>
      );
    case 'stale':
      return (
        <Chip kind="warn" icon="clock">
          {t('new.fresh.stale')}
        </Chip>
      );
    case 'unconfirmed':
      return (
        <Chip kind="warn" icon="alert">
          {t('new.fresh.unconfirmed')}
        </Chip>
      );
    default:
      return (
        <Chip kind="bad" icon="alert">
          {t('new.fresh.missing')}
        </Chip>
      );
  }
}
