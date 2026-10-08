import { Fragment, type ReactNode } from 'react';

import { Icon, type IconName } from '../../components';
import { cx } from '../../lib/cx';

interface ProfileItemProps {
  icon: IconName;
  iconKind?: 'good' | 'accent';
  title: ReactNode;
  /** Метка рядом с заголовком: «Этот сеанс». */
  titleExtra?: ReactNode;
  meta?: ReactNode;
  /** Кнопки справа (или под текстом при below). */
  side?: ReactNode;
  /** Кнопки под текстом, а не справа. */
  below?: boolean;
  /** На телефоне кнопки переносятся под текст. */
  wrap?: boolean;
}

/** Строка списка кабинета (item() макета): иконка, заголовок, подпись и действия. */
export function ProfileItem({ icon, iconKind, title, titleExtra, meta, side, below, wrap }: ProfileItemProps) {
  return (
    <div className={cx('profile-item', below && 'below', wrap && 'wrap-mobile')}>
      <span className={cx('profile-item-ic', iconKind)} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="profile-item-body">
        <div className="profile-item-title">
          {title}
          {titleExtra}
        </div>
        {meta !== undefined && <div className="profile-item-meta">{meta}</div>}
      </div>
      {side !== undefined ? <div className="profile-item-side">{side}</div> : !below && <span />}
    </div>
  );
}

/** Подпись через « · »: пустые части пропускаются. */
export function MetaLine({ parts }: { parts: readonly ReactNode[] }) {
  const shown = parts.filter((part) => part !== null && part !== undefined && part !== false && part !== '');
  return (
    <>
      {shown.map((part, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          {part}
        </Fragment>
      ))}
    </>
  );
}
