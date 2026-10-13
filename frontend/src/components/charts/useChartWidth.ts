import { useLayoutEffect, useRef, useState } from 'react';

/** Ширина, пока контейнер не размечен (тесты без браузера, первый кадр). */
export const FALLBACK_CHART_WIDTH = 640;

/**
 * Ширина контейнера графика: график рисуется под нее заново (как responsive в макете),
 * поэтому подписи и толщина линий не масштабируются вместе с картинкой. fixed — ширина
 * задана снаружи (тесты, мини-графики), без наблюдения.
 */
export function useChartWidth<T extends HTMLElement = HTMLDivElement>(fixed?: number) {
  const ref = useRef<T>(null);
  const [measured, setMeasured] = useState(0);

  useLayoutEffect(() => {
    if (fixed !== undefined) return;
    const box = ref.current;
    if (!box) return;
    const measure = () => setMeasured(Math.floor(box.clientWidth));
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, [fixed]);

  return { ref, width: fixed ?? (measured > 0 ? measured : FALLBACK_CHART_WIDTH) };
}
