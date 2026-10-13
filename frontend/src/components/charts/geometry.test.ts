import { describe, expect, it } from 'vitest';

import {
  allIntegers,
  areaPath,
  bandIndex,
  bubbleRadius,
  calibrationDomain,
  calibrationTicks,
  columnPath,
  columnWidth,
  columnYDomain,
  hbarDomain,
  hbarGeometry,
  linePath,
  lineYDomain,
  linearScale,
  nearestIndex,
  niceScale,
  niceTicks,
  outsideDomain,
  pickAxisLabels,
  px,
  sparkGeometry,
  textWidth,
  tooltipPosition,
} from './geometry';

describe('niceTicks: круглые деления', () => {
  it('шаг 2, 5 или 10 × 10ⁿ, концы накрывают данные', () => {
    expect(niceTicks(0, 100, 4)).toEqual([0, 50, 100]);
    expect(niceTicks(47_200, 51_900, 4)).toEqual([46_000, 48_000, 50_000, 52_000]);
    expect(niceTicks(0.18, 0.26, 4)).toEqual([0.15, 0.2, 0.25, 0.3]);
    expect(niceTicks(-3, 7, 3)).toEqual([-5, 0, 5, 10]);
  });

  it('делений не больше count + 2 и первое не выше min, последнее не ниже max', () => {
    for (const [lo, hi, count] of [
      [1, 9, 4],
      [-120, 35, 3],
      [0.001, 0.0042, 4],
      [10_000, 1_000_000, 4],
    ] as const) {
      const ticks = niceTicks(lo, hi, count);
      expect(ticks.length).toBeLessThanOrEqual(count + 2);
      expect(ticks[0]).toBeLessThanOrEqual(lo);
      expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(hi);
      // шаг одинаковый, без хвостов вроде 0.30000000000000004
      const steps = ticks.slice(1).map((t, i) => Number((t - ticks[i]!).toFixed(10)));
      expect(new Set(steps).size).toBe(1);
      for (const t of ticks) expect(String(t)).not.toMatch(/\d{9,}/);
    }
    // count + 2 бывает: шаг не мельче (max − min) / count, концы округлены наружу (как в макете)
    expect(niceTicks(1.9, 8.1, 4)).toEqual([0, 2, 4, 6, 8, 10]);
  });

  it('minStep: у счетчиков деления целые', () => {
    expect(niceScale(0, 1, 3)).toEqual({ ticks: [0, 0.5, 1], step: 0.5 });
    expect(niceScale(0, 1, 3, { minStep: 1 })).toEqual({ ticks: [0, 1], step: 1 });
    expect(niceScale(0, 7, 3, { minStep: 1 })).toEqual({ ticks: [0, 5, 10], step: 5 });
    // ровный ряд счетчиков: 5, 5 — деления 4, 5, 6
    expect(niceTicks(5, 5, 3, { minStep: 1 })).toEqual([4, 5, 6]);
    expect(allIntegers([1, 0, 3])).toBe(true);
    expect(allIntegers([1, 0.5])).toBe(false);
    expect(allIntegers([])).toBe(false);
  });

  it('шаг без хвостов: 0,3 / 0,1 не дает лишнего деления снизу', () => {
    expect(niceScale(0.3, 0.6, 4)).toEqual({ ticks: [0.3, 0.4, 0.5, 0.6], step: 0.1 });
  });

  it('крайние случаи: ровный ряд, перепутанные концы, не числа', () => {
    const flat = niceTicks(5, 5, 4);
    expect(flat[0]).toBeLessThan(5);
    expect(flat[flat.length - 1]).toBeGreaterThan(5);
    expect(niceTicks(0, 0, 4)).toEqual([-1, 0, 1]);
    expect(niceTicks(100, 0, 4)).toEqual(niceTicks(0, 100, 4));
    expect(niceTicks(Number.NaN, Number.NaN, 4)).toEqual([0, 0.5, 1]);
    // ноль без «-0»
    expect(Object.is(niceTicks(-1, 1, 2)[1], -0)).toBe(false);
  });
});

describe('шкалы и оси', () => {
  it('linearScale: прямая и перевернутая (ось Y сверху вниз)', () => {
    const y = linearScale([0, 100], [200, 0]);
    expect(y(0)).toBe(200);
    expect(y(100)).toBe(0);
    expect(y(25)).toBe(150);
    // нулевой домен не делит на ноль
    expect(Number.isFinite(linearScale([5, 5], [0, 10])(5))).toBe(true);
  });

  it('lineYDomain: запас 8% снизу и 6% сверху, до круглых делений', () => {
    const d = lineYDomain([48_000, 51_200]);
    expect(d.lo).toBeLessThanOrEqual(48_000 - 3_200 * 0.08);
    expect(d.hi).toBeGreaterThanOrEqual(51_200 + 3_200 * 0.06);
    expect(d.ticks[0]).toBe(d.lo);
    expect(d.ticks[d.ticks.length - 1]).toBe(d.hi);
  });

  it('lineYDomain: заданные границы без запаса, пустой ряд', () => {
    const fixed = lineYDomain([0.3, 0.7], { min: 0, max: 1 });
    expect(fixed.lo).toBe(0);
    expect(fixed.hi).toBe(1);
    const empty = lineYDomain([]);
    expect(empty.lo).toBeLessThanOrEqual(0);
    expect(empty.hi).toBeGreaterThanOrEqual(1);
    expect(lineYDomain([Number.NaN, 3]).ticks.every(Number.isFinite)).toBe(true);
  });

  it('columnYDomain: всегда от нуля; отрицательные — ниже нуля', () => {
    expect(columnYDomain([3, 9, 4])).toEqual({ lo: 0, hi: 10, ticks: [0, 5, 10], step: 5 });
    const neg = columnYDomain([-3, 6]);
    expect(neg.lo).toBeLessThan(0);
    expect(neg.ticks).toContain(0);
    expect(columnYDomain([])).toEqual({ lo: 0, hi: 1, ticks: [0, 0.5, 1], step: 0.5 });
    expect(columnYDomain([0, 0]).hi).toBeGreaterThan(0);
  });

  it('columnYDomain: только отрицательные — ось кончается нулем, пустой области сверху нет', () => {
    expect(columnYDomain([-0.02, -0.01])).toEqual({ lo: -0.02, hi: 0, ticks: [-0.02, -0.01, 0], step: 0.01 });
    expect(columnYDomain([-500, -200]).ticks).toEqual([-600, -400, -200, 0]);
    for (const values of [[-3], [-0.5, -0.1], [-1200, -40]]) {
      const d = columnYDomain(values);
      expect(d.ticks[d.ticks.length - 1]).toBe(0);
      expect(d.hi).toBe(0);
    }
  });

  it('columnYDomain integer: счетчики 0 и 1 — деления 0 и 1, без «0,5»', () => {
    expect(columnYDomain([1, 0, 1, 1, 0], 3, { integer: true })).toEqual({ lo: 0, hi: 1, ticks: [0, 1], step: 1 });
    expect(columnYDomain([0, 0], 3, { integer: true }).ticks).toEqual([0, 1]);
    expect(columnYDomain([2, 7, 3], 3, { integer: true }).ticks.every(Number.isInteger)).toBe(true);
  });

  it('lineYDomain integer и шаг делений', () => {
    expect(lineYDomain([1, 2], { integer: true }).ticks.every(Number.isInteger)).toBe(true);
    expect(lineYDomain([1.8, 2.1]).step).toBe(0.1);
  });
});

describe('пути SVG', () => {
  it('linePath: разрыв на null, координаты с одной цифрой после точки', () => {
    expect(linePath([[0, 10], [10.04, 20.06], null, [30, 5]])).toBe('M0 10L10 20.1M30 5');
    expect(linePath([])).toBe('');
    expect(linePath([null, null])).toBe('');
  });

  it('areaPath: замкнутый контур до базовой линии по каждому куску', () => {
    expect(areaPath([[0, 10], [10, 20]], 50)).toBe('M0 10L10 20L10 50L0 50Z');
    expect(areaPath([[0, 10], null, [20, 5], [30, 8]], 50)).toBe('M0 10L0 50L0 50ZM20 5L30 8L30 50L20 50Z');
  });

  it('columnPath: скругление только на конце данных', () => {
    // положительный: от основания 100 вверх до 40, ширина 20
    expect(columnPath(10, 20, 100, 40)).toBe('M10 100V44Q10 40 14 40H26Q30 40 30 44V100Z');
    // отрицательный: от нуля 100 вниз до 130 — скруглен низ
    expect(columnPath(10, 20, 100, 130)).toBe('M10 100V126Q10 130 14 130H26Q30 130 30 126V100Z');
    // ноль — полоска 1 px, радиус не больше высоты
    expect(columnPath(10, 20, 100, 100)).toBe('M10 100V100Q10 99 11 99H29Q30 99 30 100V100Z');
    // узкий столбец: радиус не больше половины ширины
    expect(columnPath(0, 4, 100, 50)).toBe('M0 100V52Q0 50 2 50H2Q4 50 4 52V100Z');
  });

  it('columnWidth: не толще 24 px и с зазором 2 px', () => {
    expect(columnWidth(100)).toBe(24);
    expect(columnWidth(12)).toBe(10);
    expect(columnWidth(2)).toBe(3);
  });

  it('sparkGeometry: ряд, ровный ряд, одна точка, пусто', () => {
    const g = sparkGeometry([1, 3, 2], 100, 20, 0)!;
    expect(g.line).toBe('M0 20L50 0L100 10');
    expect(g.end).toEqual({ x: 100, y: 10 });
    expect(sparkGeometry([5, 5], 100, 20)!.line).toBe('M3 10L97 10');
    expect(sparkGeometry([7], 100, 20)!.end).toEqual({ x: 50, y: 10 });
    expect(sparkGeometry([], 100, 20)).toBeNull();
  });
});

describe('подписи оси X', () => {
  it('редкие точки — подписаны все, по центру точки; у края рисунка — прижаты к нему', () => {
    const labels = pickAxisLabels([0, 100, 200], [30, 30, 30], { min: 0, max: 200 });
    expect(labels.map((l) => [l.index, l.anchor])).toEqual([
      [0, 'start'],
      [1, 'middle'],
      [2, 'end'],
    ]);
    // место есть (слева ось Y, справа конечная метка) — все по центру
    expect(pickAxisLabels([50, 100, 150], [30, 30, 30], { min: 0, max: 200 }).map((l) => l.anchor)).toEqual([
      'middle',
      'middle',
      'middle',
    ]);
  });

  it('30 дней на 300 px: подписи не налезают, последняя есть, шаг ровный', () => {
    const n = 30;
    const xs = Array.from({ length: n }, (_, i) => 40 + (i / (n - 1)) * 300);
    const widths = xs.map(() => textWidth('30 сен'));
    const labels = pickAxisLabels(xs, widths, { min: 0, max: 360 });
    expect(labels[0]?.index).toBe(0);
    expect(labels[labels.length - 1]?.index).toBe(n - 1);
    const spans = labels.map((l): [number, number] => {
      const w = widths[l.index]!;
      return l.anchor === 'start' ? [l.x, l.x + w] : l.anchor === 'end' ? [l.x - w, l.x] : [l.x - w / 2, l.x + w / 2];
    });
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] + 6);
    expect(labels.length).toBeGreaterThan(2);
  });

  it('шаг ровный: между подписями (кроме последней) одинаковое число точек', () => {
    const n = 30;
    const xs = Array.from({ length: n }, (_, i) => 50 + (i / (n - 1)) * 280);
    const labels = pickAxisLabels(xs, xs.map(() => textWidth('30 сен')), { min: 0, max: 340 });
    const steps = labels.slice(1, -1).map((l, i) => l.index - labels[i]!.index);
    expect(new Set(steps).size).toBe(1);
  });

  it('первая подпись прижата к левому краю — следующая не налезает на нее', () => {
    // первая точка у края: подпись занимает [10, 50], а не [−10, 30]; по шагу (через одну)
    // следующей была бы точка 70 с подписью [50, 90] — она налезла бы на первую
    const xs = [10, 40, 70, 100, 130, 160];
    const widths = xs.map(() => 40);
    const labels = pickAxisLabels(xs, widths, { min: 0 });
    expect(labels[0]).toEqual({ index: 0, x: 10, anchor: 'start' });
    expect(labels[labels.length - 1]?.index).toBe(5);
    const spans = labels.map((l): [number, number] =>
      l.anchor === 'start' ? [l.x, l.x + 40] : l.anchor === 'end' ? [l.x - 40, l.x] : [l.x - 20, l.x + 20],
    );
    for (let i = 1; i < spans.length; i++) expect(spans[i]![0]).toBeGreaterThanOrEqual(spans[i - 1]![1] + 6);
  });

  it('одна точка и пусто', () => {
    expect(pickAxisLabels([50], [20])).toEqual([{ index: 0, x: 50, anchor: 'middle' }]);
    expect(pickAxisLabels([], [])).toEqual([]);
  });
});

describe('наведение и подсказка', () => {
  it('nearestIndex: ближайшая точка, края зажаты', () => {
    expect(nearestIndex(40, 11, 40, 100)).toBe(0);
    expect(nearestIndex(94, 11, 40, 100)).toBe(5);
    // шаг 10 px: левее середины между соседями — левая точка, правее — правая
    expect(nearestIndex(44, 11, 40, 100)).toBe(0);
    expect(nearestIndex(46, 11, 40, 100)).toBe(1);
    expect(nearestIndex(134, 11, 40, 100)).toBe(9);
    expect(nearestIndex(136, 11, 40, 100)).toBe(10);
    expect(nearestIndex(500, 11, 40, 100)).toBe(10);
    expect(nearestIndex(-20, 11, 40, 100)).toBe(0);
    expect(nearestIndex(70, 1, 40, 100)).toBe(0);
  });

  it('bandIndex: полоса под указателем', () => {
    expect(bandIndex(45, 10, 40, 20)).toBe(0);
    expect(bandIndex(61, 10, 40, 20)).toBe(1);
    expect(bandIndex(1000, 10, 40, 20)).toBe(9);
    expect(bandIndex(0, 10, 40, 20)).toBe(0);
  });

  it('tooltipPosition: правее и выше; у правого края — левее; у верха — ниже', () => {
    expect(tooltipPosition(100, 200, 150, 60, 1366)).toEqual({ left: 114, top: 130 });
    expect(tooltipPosition(300, 200, 150, 60, 360)).toEqual({ left: 136, top: 130 });
    expect(tooltipPosition(100, 30, 150, 60, 1366)).toEqual({ left: 114, top: 46 });
    expect(tooltipPosition(20, 200, 300, 60, 320)).toEqual({ left: 8, top: 130 });
  });

  it('bubbleRadius: от 4 до 9 px по числу событий', () => {
    expect(bubbleRadius(40, 40)).toBe(9);
    expect(bubbleRadius(10, 40)).toBeCloseTo(6.5);
    expect(bubbleRadius(0, 40)).toBe(4);
    expect(bubbleRadius(5, 0)).toBe(4);
  });
});

describe('горизонтальные полосы', () => {
  it('домен от нуля, с учетом ДИ; заданный — как есть', () => {
    expect(hbarDomain([{ value: 0.1 }, { value: 0.3 }])).toEqual({ lo: 0, hi: 0.3 });
    expect(hbarDomain([{ value: 0.1, ci: [-0.2, 0.4] }])).toEqual({ lo: -0.2, hi: 0.4 });
    expect(hbarDomain([{ value: 5 }], [0, 25])).toEqual({ lo: 0, hi: 25 });
  });

  it('положительная полоса растет от нуля вправо, отрицательная — влево', () => {
    const d = { lo: -0.1, hi: 0.3 };
    const pos = hbarGeometry(0.2, d);
    expect(pos).toMatchObject({ negative: false, zero: 25 });
    expect(pos.left).toBeCloseTo(25);
    expect(pos.width).toBeCloseTo(50);
    const neg = hbarGeometry(-0.1, d);
    expect(neg.negative).toBe(true);
    expect(neg.left).toBeCloseTo(0);
    expect(neg.width).toBeCloseTo(25);
  });

  it('без отрицательных ноль у края и линии нуля нет; за доменом — до края; ноль виден', () => {
    const d = { lo: 0, hi: 10 };
    expect(hbarGeometry(5, d).zero).toBeNull();
    expect(hbarGeometry(50, d).width).toBe(100);
    expect(hbarGeometry(0, d).width).toBe(0.6);
  });

  it('ДИ: положение и ширина, концы за доменом прижаты', () => {
    const g = hbarGeometry(0.1, { lo: -0.2, hi: 0.2 }, [-0.1, 0.5]);
    expect(g.ci?.left).toBeCloseTo(25);
    expect(g.ci?.width).toBeCloseTo(75);
    expect(hbarGeometry(0.1, { lo: 0, hi: 1 }, [0.3, 0.2]).ci?.left).toBeCloseTo(20);
  });
});

describe('калибровка: шкала по данным и значения за ней', () => {
  it('шкала от круглой десятой ниже самого малого значения, не уже 60–100% и не ниже 0', () => {
    const bin = (p: number, actual: number, n = 5, ci?: [number, number]) => ({ p, actual, n, ci });
    expect(calibrationDomain([bin(0.57, 0.6), bin(0.62, 0.55)])).toEqual([0.5, 1]);
    expect(calibrationDomain([bin(0.52, 0.3)])).toEqual([0.3, 1]);
    // нижний конец ДИ тоже внутри шкалы
    expect(calibrationDomain([bin(0.52, 0.3, 4, [0.07, 0.69])])).toEqual([0, 1]);
    expect(calibrationDomain([bin(0.72, 0.7, 40, [0.55, 0.83])])).toEqual([0.5, 1]);
    // из двух не сыграло ни одно — шкала от нуля, а не прижатая к 20% точка
    expect(calibrationDomain([bin(0.62, 0, 2), bin(0.7, 0.8)])).toEqual([0, 1]);
    expect(calibrationDomain([bin(0.85, 0.9)])).toEqual([0.6, 1]);
    // корзины без событий не считаются, пусто — 50–100%
    expect(calibrationDomain([bin(0.1, 0.1, 0), bin(0.75, 0.8)])).toEqual([0.6, 1]);
    expect(calibrationDomain([])).toEqual([0.5, 1]);
  });

  it('деления через 10 п.п., значение за шкалой', () => {
    expect(calibrationTicks(0.3, 1)).toEqual([0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
    expect(outsideDomain(0.3, [0.5, 1])).toBe(true);
    expect(outsideDomain(0.5, [0.5, 1])).toBe(false);
    expect(outsideDomain(1, [0.5, 1])).toBe(false);
  });
});

describe('ширина подписи', () => {
  // замер в Chromium: Golos Text 11 px, жирность 600 (конечная метка), px
  const MEASURED: Record<string, number> = {
    '+100,0%': 47.03,
    '\u221212\u00a0345,67\u00a0$': 70.2,
    '1\u00a0280\u00a0746,89\u00a0$': 81.19,
    '990\u00a0тыс.\u00a0₽': 56.27,
    '1,01\u00a0млн\u00a0₽': 57.72,
    '30 сен': 32.67,
    '100%': 30.33,
    'прогноз модели →': 91.2,
    'Ж Щ Ш Ю': 55.67,
    'WWW mmm': 64.38,
  };

  it('не меньше настоящей ширины: подпись не уезжает за край рисунка', () => {
    for (const [text, width] of Object.entries(MEASURED)) {
      expect(textWidth(text)).toBeGreaterThanOrEqual(width);
      // и без большого запаса: место под ось не раздувается
      expect(textWidth(text)).toBeLessThanOrEqual(width * 1.25);
    }
  });
});

describe('px', () => {
  it('одна цифра после точки и без «-0»', () => {
    expect(px(10.04)).toBe(10);
    expect(px(10.06)).toBe(10.1);
    expect(Object.is(px(-0.01), -0)).toBe(false);
  });
});
