import { useTranslation } from 'react-i18next';

import { Chip } from '../../components';
import { openBetsText, useOpenBetsCount } from './useOpenBets';

/**
 * Счетчик открытых ставок у «Ставок»: в боковом меню — метка-чип (nav-badge), в нижнем меню
 * телефона — кружок над иконкой (tab-badge). Читалке — «открытых ставок: N». Ставок в игре
 * нет — ничего.
 */
export function OpenBetsBadge({ place }: { place: 'sidebar' | 'tabbar' }) {
  const { t } = useTranslation();
  const count = useOpenBetsCount();
  if (count <= 0) return null;
  const text = openBetsText(count);
  return (
    <>
      {place === 'sidebar' ? (
        <Chip kind="info" className="nav-badge">
          <span aria-hidden="true">{text}</span>
        </Chip>
      ) : (
        <span className="tab-badge" aria-hidden="true">
          {text}
        </span>
      )}
      <span className="sr-only">{t('nav.openBets', { count })}</span>
    </>
  );
}
