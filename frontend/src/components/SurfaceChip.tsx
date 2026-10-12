import { useTranslation } from 'react-i18next';

import { Chip } from './Chip';
import './Indicators.css';

export type Surface = 'hard' | 'clay' | 'grass' | 'carpet';

// Цвет покрытия — токен из tokens.css; ковер — цвет крытых кортов
const COLORS: Record<Surface, string> = {
  hard: 'var(--hard)',
  clay: 'var(--clay)',
  grass: 'var(--grass)',
  carpet: 'var(--indoor)',
};

export function isSurface(value: unknown): value is Surface {
  return typeof value === 'string' && value in COLORS;
}

/** Метка покрытия корта с цветной точкой (UI.surfaceChip в макете). */
export function SurfaceChip({ surface }: { surface: string | null | undefined }) {
  const { t } = useTranslation();
  if (!isSurface(surface)) return <Chip kind="outline">{t('analysis.surface.unknown')}</Chip>;
  return (
    <Chip kind="outline" dot={COLORS[surface]} className="surface-chip">
      {t(`analysis.surface.${surface}`)}
    </Chip>
  );
}

/** Цвет покрытия для своих меток (сегменты выбора покрытия). */
export function surfaceColor(surface: Surface): string {
  return COLORS[surface];
}
