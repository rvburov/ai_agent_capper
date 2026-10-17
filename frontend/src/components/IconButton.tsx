import type { ComponentPropsWithRef } from 'react';

import { Button, type ButtonKind } from './Button';
import type { IconName } from './Icon';

export interface IconButtonProps
  extends Omit<ComponentPropsWithRef<'button'>, 'children' | 'aria-label'> {
  icon: IconName;
  /** Подпись для читалки экрана и всплывающая подсказка: у кнопки без текста она обязательна. */
  label: string;
  kind?: ButtonKind;
  size?: 'sm' | 'md';
  /** Кнопка меняет данные: в режиме просмотра данных участника неактивна (Button, Р27). */
  ro?: boolean | string;
}

/** Квадратная кнопка с иконкой (.btn.icon-only); на телефоне зона нажатия 40 px. */
export function IconButton({ icon, label, kind = 'ghost', size = 'md', title, ...rest }: IconButtonProps) {
  return (
    <Button {...rest} kind={kind} size={size} icon={icon} aria-label={label} title={title ?? label} />
  );
}
