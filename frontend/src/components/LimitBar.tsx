import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import { cx } from '../lib/cx';
import './LimitBar.css';

export type SpendTone = 'warn' | 'bad' | null;

/**
 * Цвет расхода: с порога уведомления (alertPct, 50–90%) — желтый, с 100% — красный. Порог
 * берется из настроек администратора (app_settings.budget_alert_pct), а не из кода.
 */
export function spendTone(spent: number, max: number, alertPct: number): SpendTone {
  if (!(max > 0)) return null;
  const share = spent / max;
  if (share >= 1) return 'bad';
  return share * 100 >= alertPct ? 'warn' : null;
}

// Наименьший зазор между подписью порога и подписью лимита на шкале, px
const LABEL_GAP = 4;

function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

/** Заливка полосы лимита и место отметки порога, в процентах ширины. */
export function limitBarParts(spent: number, max: number, alertPct: number) {
  return {
    fill: max > 0 ? clampPct((spent / max) * 100) : 0,
    mark: clampPct(alertPct),
    tone: spendTone(spent, max, alertPct),
  };
}

export interface LimitBarProps {
  spent: number;
  max: number;
  /** Порог уведомления, % лимита. */
  alertPct: number;
  /** Подпись для читалки экрана: «Расход лимита на ИИ за октябрь». */
  label: string;
  /** Значение для читалки: «$7,20 из $10». */
  valueText: string;
  /** Подписи шкалы: начало, порог («80% · $8»), лимит. */
  scale: readonly [ReactNode, ReactNode, ReactNode];
  className?: string;
}

/**
 * Подпись порога наезжает на подпись лимита (порог 90% и длинные суммы на узком экране):
 * тогда подпись порога уходит второй строкой под шкалу. Пока подписи не размечены (нет
 * ширины, как в тестах без браузера), считаем, что места хватает.
 */
function useTightScale() {
  const ref = useRef<HTMLDivElement>(null);
  const [tight, setTight] = useState(false);
  const measure = useCallback(() => {
    const mid = ref.current?.querySelector('.mid')?.getBoundingClientRect();
    const end = ref.current?.querySelector('.end')?.getBoundingClientRect();
    setTight(Boolean(mid && end && mid.width && end.width && mid.right + LABEL_GAP > end.left));
  }, []);

  // подписи меняются с данными: проверяем после каждой отрисовки (без изменений — без перерисовки)
  useLayoutEffect(measure);
  useLayoutEffect(() => {
    const scale = ref.current;
    if (!scale) return;
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(scale);
    return () => observer.disconnect();
  }, [measure]);

  return { ref, tight };
}

/**
 * Шкала расхода лимита (limitBar макета, mockup/js/screens/profile.js): заливка, отметка
 * порога уведомления и подписи 0 / порог / лимит.
 */
export function LimitBar({ spent, max, alertPct, label, valueText, scale, className }: LimitBarProps) {
  const { fill, mark, tone } = limitBarParts(spent, max, alertPct);
  const labels = useTightScale();
  return (
    <div className={cx('limit-bar', className)}>
      <div
        className="limit-bar-track"
        role="meter"
        aria-label={label}
        aria-valuenow={Math.round(spent * 100) / 100}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuetext={valueText}
      >
        <i className={cx('limit-bar-fill', tone)} style={{ width: `${fill}%` }} />
        <span className="limit-bar-mark" style={{ left: `${mark}%` }} />
      </div>
      <div ref={labels.ref} className={cx('limit-bar-scale', labels.tight && 'tight')} aria-hidden="true">
        <span style={{ left: 0 }}>{scale[0]}</span>
        <span className="mid" style={{ left: `${mark}%` }}>
          {scale[1]}
        </span>
        <span className="end">{scale[2]}</span>
      </div>
    </div>
  );
}
