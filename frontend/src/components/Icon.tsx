import { ICON_PATHS, type IconName } from './icons';

export type { IconName } from './icons';

export interface IconProps {
  name: IconName;
  /** Размер в px; без него размер задает CSS родителя (.btn svg, .nav-link svg и т.п.). */
  size?: number;
  className?: string;
}

/** Иконка макета. Декоративная: смысл передает подпись рядом или aria-label кнопки. */
export function Icon({ name, size, className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  );
}
