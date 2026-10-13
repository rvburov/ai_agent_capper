import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { cx } from '../../lib/cx';
import { formatInterval } from '../../lib/format';
import { defaultValueFormat } from './defaultFormat';
import { hbarDomain, hbarGeometry } from './geometry';
import './charts.css';

export interface HBarItem {
  key: string;
  label: string;
  value: number;
  /** Текст значения справа; по умолчанию — valueFormat(value). */
  valueText?: string;
  /** Мелкая строка под значением: «24 события», «12%». */
  note?: ReactNode;
  /** Цвет полосы (токен); по умолчанию — цвет графика. */
  color?: string;
  /** 95% доверительный интервал: тонкая линия с засечками поверх полосы. */
  ci?: readonly [number, number] | null;
  /** Цветной квадрат перед подписью (покрытие, рынок). По умолчанию есть. */
  dot?: boolean;
  /** Своя подпись вместо label (метка «мало данных», выделение выбранного). */
  labelNode?: ReactNode;
  /** Приглушить полосу: выбрано другое значение фильтра. */
  dim?: boolean;
}

export interface HBarsProps {
  items: readonly HBarItem[];
  /** Подпись списка для читалки экрана: «ROI по покрытиям». */
  ariaLabel: string;
  /** Цвет полос (токен), по умолчанию 'var(--s1)'. */
  color?: string;
  valueFormat?: (value: number) => string;
  /** Границы шкалы; по умолчанию от min(0, значений и ДИ) до max(0, …). */
  domain?: readonly [number, number];
  className?: string;
}

/**
 * Горизонтальные полосы (hbars макета): подпись, полоса от нуля (вправо или влево), значение
 * текстом справа. Значение всегда видно числом — подсказка не нужна; ДИ — и линией, и в тексте
 * для читалки экрана. Столбец значений общий для всех строк (subgrid) и по ширине самого
 * длинного значения: полосы остаются в одной шкале, длинная сумма не вылезает за карточку.
 */
export function HBars({ items, ariaLabel, color = 'var(--s1)', valueFormat = defaultValueFormat, domain, className }: HBarsProps) {
  const { t } = useTranslation();
  const range = hbarDomain(items, domain);
  return (
    <ul className={cx('hbars', className)} aria-label={ariaLabel}>
      {items.map((item) => {
        const g = hbarGeometry(item.value, range, item.ci);
        const fill = item.color ?? color;
        const valueText = item.valueText ?? valueFormat(item.value);
        const ciText = item.ci ? formatInterval(item.ci[0], item.ci[1], valueFormat) : null;
        return (
          <li
            key={item.key}
            className={cx('hbar', item.dim && 'dim')}
            title={ciText ? `${item.label}: ${valueText}, ${t('charts.ci')} ${ciText}` : `${item.label}: ${valueText}`}
          >
            <span className="hbar-label">
              {item.labelNode ?? (
                <>
                  {item.dot !== false && <i className="hbar-dot" style={{ background: fill }} aria-hidden="true" />}
                  <span className="hbar-name">{item.label}</span>
                </>
              )}
            </span>
            <span className="hbar-track" aria-hidden="true">
              {g.zero !== null && <i className="hbar-zero" style={{ left: `${g.zero}%` }} />}
              <i
                className={cx('hbar-fill', g.negative ? 'neg' : 'pos')}
                style={{ left: `${g.left}%`, width: `${g.width}%`, background: fill }}
              />
              {g.ci && <i className="hbar-ci" style={{ left: `${g.ci.left}%`, width: `${g.ci.width}%` }} />}
            </span>
            <span className="hbar-value">
              {valueText}
              {item.note !== undefined && item.note !== null && <small>{item.note}</small>}
              {ciText && <span className="sr-only">{t('charts.ciText', { range: ciText })}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
