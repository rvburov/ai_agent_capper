import type { ReactNode } from 'react';

import { Icon, type IconName } from './Icon';
import './Pwa.css';

/** Кнопка браузера или телефона в инструкции: «Поделиться», «На экран «Домой»» (pwa-key макета). */
export function KeyCap({ icon, children }: { icon?: IconName; children?: ReactNode }) {
  return (
    <span className="key-cap">
      {icon && <Icon name={icon} />}
      {children}
    </span>
  );
}
