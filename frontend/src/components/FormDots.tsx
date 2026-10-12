import { useTranslation } from 'react-i18next';

import { cx } from '../lib/cx';
import './Indicators.css';

/** Форма игрока точками: зеленая — победа, красная — поражение (UI.formDots в макете). */
export function FormDots({ results, className }: { results: readonly string[]; className?: string }) {
  const { t } = useTranslation();
  const words = results.map((r) => (r === 'W' ? t('analysis.form.win') : t('analysis.form.loss')));
  return (
    <span className={cx('form-dots', className)} role="img" aria-label={t('analysis.form.label', { list: words.join(', ') })}>
      {results.map((r, i) => (
        <i key={i} className={r === 'W' ? 'w' : 'l'} />
      ))}
    </span>
  );
}
