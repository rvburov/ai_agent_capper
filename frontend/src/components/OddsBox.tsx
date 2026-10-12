import type { CSSProperties } from 'react';

import { formatOdds, type Amount } from '../lib/format';
import { cx } from '../lib/cx';
import { Icon } from './Icon';
import './OddsBox.css';

/** Кэф в рамке с подписью сверху (UI.oddsBox в макете): ноги экспресса. */
export function OddsBox({ label, value, picked = false }: { label: string; value: Amount; picked?: boolean }) {
  return (
    <span className={cx('odds-box', picked && 'picked')}>
      <small>{label}</small>
      <span className="odds">{formatOdds(value)}</span>
    </span>
  );
}

export interface OddsCell {
  key: string;
  /** Подпись: «П1», «Ф1(−1.5)». */
  label: string;
  value: string;
  /** Подпись поля для читалки: «Кэф П1» или «Кэф Ф1(−1.5), необязательно». */
  ariaLabel: string;
  invalid?: boolean;
  /** Кэф в коридоре стратегии: зеленая черта и галочка. */
  inCorridor?: boolean;
  /** Подсказка при наведении: «Фора по сетам». */
  title?: string;
}

export interface OddsGridProps {
  cells: readonly OddsCell[];
  onChange: (key: string, value: string) => void;
  /** Уход из поля: кэф приводится к виду «1.62». */
  onBlur?: (key: string) => void;
  /** Подпись группы: «Кэфы: Синнер — Руне». */
  label: string;
  /** Подсказка у галочки коридора. */
  corridorTitle: string;
  idPrefix: string;
  className?: string;
}

/** Поля кэфов события сеткой (new-odds в макете): П1 и П2, форы — по желанию. */
export function OddsGrid({ cells, onChange, onBlur, label, corridorTitle, idPrefix, className }: OddsGridProps) {
  const count = cells.length;
  const style = { '--n': String(count) } as CSSProperties;
  return (
    <div
      className={cx('odds-grid', count > 4 && 'many', count === 4 && 'four', className)}
      style={style}
      role="group"
      aria-label={label}
    >
      {cells.map((cell) => {
        const id = `${idPrefix}-${cell.key}`;
        return (
          <label
            key={cell.key}
            htmlFor={id}
            title={cell.title}
            className={cx('odds-cell', cell.invalid && 'invalid', cell.inCorridor && 'in')}
          >
            <small>
              {cell.label}
              <span className="odds-cell-tick" title={corridorTitle}>
                <Icon name="check" />
              </span>
            </small>
            <input
              id={id}
              type="text"
              inputMode="decimal"
              autoComplete="off"
              maxLength={6}
              placeholder="—"
              value={cell.value}
              aria-label={cell.ariaLabel}
              aria-invalid={cell.invalid || undefined}
              onChange={(event) => onChange(cell.key, event.target.value)}
              onBlur={() => onBlur?.(cell.key)}
            />
          </label>
        );
      })}
    </div>
  );
}
