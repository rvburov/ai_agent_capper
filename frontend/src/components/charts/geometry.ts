// Геометрия графиков без React и DOM: шкалы, деления, пути SVG, прореживание подписей,
// место подсказки. Все считается числами — так это проверяется в тестах без браузера.
// Алгоритмы — как в макете (mockup/js/ui.js: niceTicks, lineChart, columnChart, hbars,
// calibrationChart, sparkline), плюс крайние случаи: пустой ряд, одна точка, ровная линия.

export type Point = readonly [number, number];

/** Подпись деления оси: шаг делений, чтобы формат различал соседние подписи. */
export interface AxisTick {
  step: number;
}

/**
 * Формат значения графика. Для подписей оси вызывается со вторым аргументом: формат должен
 * различать соседние деления — formatNumber(v, stepDigits(axis.step)),
 * formatMoneyCompact(v, currency, { step: axis?.step }). Без него — значение целиком
 * (подсказка, конечная метка).
 */
export type ValueFormat = (value: number, axis?: AxisTick) => string;

/** Отступы области построения от краев SVG, px. */
export interface Margins {
  t: number;
  r: number;
  b: number;
  l: number;
}

// Ширина знаков подписи шрифтом графиков (Golos Text 11 px, жирность до 600), px — с небольшим
// запасом, замерено в Chromium. Средней ширины на знак мало: «%», «+», цифры и «₽» шире,
// и подпись «+100,0%» уезжала за левый край рисунка.
const GLYPH_WIDTHS: Readonly<Record<string, number>> = {
  ',': 3.5,
  '.': 3.5,
  ':': 3.5,
  ' ': 2.8,
  '\u00a0': 2.8,
  '\u202f': 1.4,
  '%': 9.3,
  '+': 6.3,
  '\u2212': 6.3,
  '±': 6.3,
  '≥': 6.3,
  '≤': 6.3,
  '-': 4.2,
  '(': 4.2,
  ')': 4.2,
  '/': 5.3,
  '–': 5.9,
  '—': 8.1,
  '…': 10.7,
  '→': 11,
  $: 7.3,
  '€': 7.6,
  '₽': 7.8,
};
const DIGIT_WIDTH = 7.05;
const LOWER_WIDTH = 6.8;
const UPPER_WIDTH = 8.6;
// широкие буквы: «ш», «ю», «м», «W»
const WIDE_LOWER = new Set('шщыюжфмmw');
const WIDE_UPPER = new Set('ЮЩШЖЫМФWM');

function glyphWidth(ch: string): number {
  const known = GLYPH_WIDTHS[ch];
  if (known !== undefined) return known;
  if (ch >= '0' && ch <= '9') return DIGIT_WIDTH;
  if (WIDE_LOWER.has(ch)) return 9.4;
  if (WIDE_UPPER.has(ch)) return 12.5;
  return ch !== ch.toLowerCase() ? UPPER_WIDTH : LOWER_WIDTH;
}

/** Ширина подписи шрифтом 11 px: по знакам, с запасом (места под подписи хватает всегда). */
export function textWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += glyphWidth(ch);
  return width;
}

/** Координата для атрибута SVG: одна цифра после точки, без «-0». */
export function px(value: number): number {
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

export interface NiceScale {
  ticks: number[];
  /** Шаг делений: по нему подписи оси берут число знаков (stepDigits в lib/format). */
  step: number;
}

/**
 * Круглые деления оси: шаг 2, 5 или 10 × 10ⁿ (как niceTicks в макете), первое деление не выше
 * min, последнее не ниже max. Делений от 2 до count + 2: шаг не меньше (max − min) / count, а
 * концы округляются наружу до шага (1,9…8,1 при count 4 — 0, 2, …, 10). minStep — шаг
 * не мельче (1 у счетчиков: «0, 1, 2», а не «0, 0,5, 1»). Ровный ряд (min = max)
 * раздвигается на 10% вокруг значения.
 */
export function niceScale(
  min: number,
  max: number,
  count = 4,
  { minStep = 0 }: { minStep?: number } = {},
): NiceScale {
  let lo = Number.isFinite(min) ? min : 0;
  let hi = Number.isFinite(max) ? max : lo + 1;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (hi - lo === 0) {
    const pad = Math.abs(lo) * 0.1 || 1;
    lo -= pad;
    hi += pad;
  }
  const step0 = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(step0));
  const norm = step0 / mag;
  let step = (norm >= 5 ? 10 : norm >= 2 ? 5 : 2) * mag;
  // minStep — тоже круглый (1, 2, 5 × 10ⁿ), поэтому шаг остается круглым
  if (step < minStep) step = minStep;
  step = Number(step.toPrecision(12));
  const first = Math.floor(lo / step + 1e-9) * step;
  const last = Math.ceil(hi / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = first; v <= last + step / 2; v += step) ticks.push(Number(v.toFixed(10)) || 0);
  return { ticks, step };
}

/** Деления оси без шага (см. niceScale). */
export function niceTicks(min: number, max: number, count = 4, options: { minStep?: number } = {}): number[] {
  return niceScale(min, max, count, options).ticks;
}

/** Все значения целые (счетчики ставок, событий): тогда деления оси тоже целые. */
export function allIntegers(values: readonly number[]): boolean {
  const finite = values.filter(Number.isFinite);
  return finite.length > 0 && finite.every(Number.isInteger);
}

/** Линейная шкала: значение из domain → координата из range (обе стороны могут убывать). */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]) {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0 || 1;
  return (value: number) => r0 + ((value - d0) / span) * (r1 - r0);
}

export interface YDomain {
  lo: number;
  hi: number;
  ticks: number[];
  step: number;
}

/**
 * Ось Y линейного графика: по значениям и опорным линиям, с запасом 8% снизу и 6% сверху
 * (если границы не заданы), затем до круглых делений. Пустой ряд — от 0 до 1.
 * integer — деления целые (шаг не меньше 1).
 */
export function lineYDomain(
  values: readonly number[],
  {
    min,
    max,
    tickCount = 4,
    integer = false,
  }: { min?: number; max?: number; tickCount?: number; integer?: boolean } = {},
): YDomain {
  const finite = values.filter(Number.isFinite);
  let lo = min ?? (finite.length ? Math.min(...finite) : 0);
  let hi = max ?? (finite.length ? Math.max(...finite) : 1);
  if (lo > hi) [lo, hi] = [hi, lo];
  const span = hi - lo;
  if (min === undefined) lo -= span * 0.08;
  if (max === undefined) hi += span * 0.06;
  const { ticks, step } = niceScale(lo, hi, tickCount, { minStep: integer ? 1 : 0 });
  return {
    lo: Math.min(lo, ticks[0] ?? lo),
    hi: Math.max(hi, ticks[ticks.length - 1] ?? hi),
    ticks,
    step,
  };
}

/**
 * Ось Y столбцов: от нуля вверх и вниз до круглых делений; ноль — всегда деление. Только
 * отрицательные значения — ось кончается нулем сверху; все нули или пусто — от 0 до 1.
 * integer — деления целые (столбцы-счетчики).
 */
export function columnYDomain(
  values: readonly number[],
  tickCount = 3,
  { integer = false }: { integer?: boolean } = {},
): YDomain {
  const finite = values.filter(Number.isFinite);
  const hi0 = Math.max(0, ...finite);
  const lo0 = Math.min(0, ...finite);
  const { ticks, step } = niceScale(lo0, lo0 === 0 && hi0 === 0 ? 1 : hi0, tickCount, {
    minStep: integer ? 1 : 0,
  });
  return { lo: ticks[0] ?? 0, hi: ticks[ticks.length - 1] ?? 1, ticks, step };
}

/** Путь линии; null — разрыв (нет значения в этот день). */
export function linePath(points: readonly (Point | null)[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${px(p[0])} ${px(p[1])}`;
    pen = true;
  }
  return d;
}

/** Заливка под линией до baseY: по каждому непрерывному куску свой замкнутый контур. */
export function areaPath(points: readonly (Point | null)[], baseY: number): string {
  let d = '';
  let run: Point[] = [];
  const flush = () => {
    const first = run[0];
    const last = run[run.length - 1];
    if (first && last) {
      d += `${linePath(run)}L${px(last[0])} ${px(baseY)}L${px(first[0])} ${px(baseY)}Z`;
    }
    run = [];
  };
  for (const p of points) {
    if (p) run.push(p);
    else flush();
  }
  flush();
  return d;
}

/**
 * Линия ступенькой (пунктир «вложено», В7 этапа 5): от точки к точке сначала по горизонтали,
 * потом по вертикали — значение меняется ровно в день события (пополнения), а не плавно между
 * днями. Пропуск (null) — разрыв, как у обычной линии.
 */
export function stepPath(points: readonly (Point | null)[]): string {
  let d = '';
  let prev: Point | null = null;
  for (const p of points) {
    if (!p) {
      prev = null;
      continue;
    }
    d += prev ? `H${px(p[0])}V${px(p[1])}` : `M${px(p[0])} ${px(p[1])}`;
    prev = p;
  }
  return d;
}

/** Подпись отметки события над графиком: где начинается, как прижата и в каком ряду. */
export interface MarkLabelPlace {
  x: number;
  anchor: 'start' | 'end';
  /** Ряд подписей сверху вниз: 0 — у верхнего края области построения. */
  row: number;
}

/**
 * Где подписать отметки событий («+20 000 ₽ · пополнение, 14 сен»). Подписи стоят в своей полосе
 * над областью построения (рядами сверху вниз), поэтому линия данных, деления и конечная метка
 * их не задевают; полоса — во всю ширину [min, max]. Пунктир подписанной отметки доходит до
 * ряда своей подписи, пунктир неподписанной — только до области построения.
 *
 * Подпись стоит справа от отметки, а правее split (по умолчанию 55% от [min, max]; график
 * передает 55% области построения, как в макете) — слева от нее. Если на своей стороне она
 * налезает на соседнюю подпись, уходит во второй ряд с той же стороны; на другую сторону —
 * только если со своей не влезает в [min, max] или пересекла бы пунктир другого дня. Пунктир
 * чужой подписи не пересекается никогда (иначе подпись читается как подпись не к той дате);
 * сначала ищется место, где над подписью нет и неподписанных отметок. У отметок одного дня
 * пунктир общий. Не влезает нигде — подписи нет (null): событие остается отметкой на графике,
 * в подсказке и в тексте для читалки. Отметки — в любом порядке, ответ — в том же.
 */
export function placeMarkLabels(
  marks: readonly { x: number; width: number }[],
  {
    min,
    max,
    split = min + (max - min) * 0.55,
    gap = 8,
    offset = 6,
    rows = 2,
  }: { min: number; max: number; split?: number; gap?: number; offset?: number; rows?: number },
): (MarkLabelPlace | null)[] {
  const out: (MarkLabelPlace | null)[] = marks.map(() => null);
  const ends: number[] = [];
  const placed: { x: number; row: number; a: number; b: number }[] = [];
  const order = marks.map((_, i) => i).sort((a, b) => (marks[a]?.x ?? 0) - (marks[b]?.x ?? 0));
  // пунктир ближе 2 px к краю подписи — уже «под» ней; у отметок одного дня пунктир общий
  const under = (x: number, a: number, b: number) => x >= a - 2 && x <= b + 2;
  const other = (x: number, own: number) => Math.abs(x - own) > 0.5;
  const fits = (x: number, a: number, b: number, row: number, strict: boolean) =>
    (ends[row] ?? -Infinity) + gap <= a &&
    // пунктир подписанной отметки идет от ряда своей подписи вниз: не через эту подпись,
    // и пунктир этой отметки — не через подписи рядов ниже
    !placed.some((p) => other(p.x, x) && ((p.row <= row && under(p.x, a, b)) || (p.row >= row && under(x, p.a, p.b)))) &&
    !(strict && marks.some((m) => other(m.x, x) && under(m.x, a, b)));
  for (const i of order) {
    const mark = marks[i];
    if (!mark) continue;
    const spans: Record<'start' | 'end', [number, number]> = {
      start: [mark.x + offset, mark.x + offset + mark.width],
      end: [mark.x - offset - mark.width, mark.x - offset],
    };
    const sides: ('start' | 'end')[] = mark.x > split ? ['end', 'start'] : ['start', 'end'];
    let place: { anchor: 'start' | 'end'; row: number } | null = null;
    for (const strict of [true, false]) {
      for (const anchor of sides) {
        const [a, b] = spans[anchor];
        if (a < min || b > max) continue;
        const row = Array.from({ length: rows }, (_, r) => r).find((r) => fits(mark.x, a, b, r, strict));
        if (row !== undefined) {
          place = { anchor, row };
          break;
        }
      }
      if (place) break;
    }
    if (!place) continue;
    const [a, b] = spans[place.anchor];
    ends[place.row] = b;
    placed.push({ x: mark.x, row: place.row, a, b });
    out[i] = { x: place.anchor === 'start' ? a : b, anchor: place.anchor, row: place.row };
  }
  return out;
}

/**
 * Полоса подписей отметок над областью построения: базовая линия ряда row, верх ряда (до него
 * доходит пунктир отметки) и верхний отступ области построения при rows рядах (0 — полосы нет,
 * отступ обычный, 10 px).
 */
export const markBand = {
  baseline: (row: number) => 13 + row * 14,
  top: (row: number) => 4 + row * 14,
  plotTop: (rows: number) => (rows > 0 ? 12 + rows * 14 : 10),
};

/**
 * Столбец от базовой линии y0 до значения y1 шириной w: скругление 4 px только на конце
 * данных (сверху у положительного, снизу у отрицательного), у основания углы прямые.
 * Нулевое значение — полоска в 1 px, чтобы столбец было видно и на него можно было навести.
 */
export function columnPath(x: number, w: number, y0: number, y1: number, radius = 4): string {
  const h = Math.max(1, Math.abs(y1 - y0));
  const r = Math.max(0, Math.min(radius, h, w / 2));
  const [a, b] = [px(x), px(x + w)];
  if (y1 <= y0) {
    const t = y0 - h;
    return `M${a} ${px(y0)}V${px(t + r)}Q${a} ${px(t)} ${px(x + r)} ${px(t)}H${px(x + w - r)}Q${b} ${px(t)} ${b} ${px(t + r)}V${px(y0)}Z`;
  }
  const bottom = y0 + h;
  return `M${a} ${px(y0)}V${px(bottom - r)}Q${a} ${px(bottom)} ${px(x + r)} ${px(bottom)}H${px(x + w - r)}Q${b} ${px(bottom)} ${b} ${px(bottom - r)}V${px(y0)}Z`;
}

/** Толщина столбца: не больше 24 px и с зазором 2 px до соседа (не меньше 3 px). */
export function columnWidth(band: number): number {
  return Math.min(24, Math.max(3, band - 2));
}

export type Anchor = 'start' | 'middle' | 'end';

export interface AxisLabel {
  index: number;
  x: number;
  anchor: Anchor;
}

/**
 * Какие подписи оси X показать, чтобы они не налезали друг на друга (зазор 6 px).
 * Подпись стоит по центру своей точки, а если так выходит за край рисунка [min, max] —
 * прижимается к нему (первая — к левому, последняя — к правому). Берутся точки с равным
 * шагом; последняя подписывается всегда, если влезает: тогда уступает соседняя слева
 * (но не первая).
 */
export function pickAxisLabels(
  xs: readonly number[],
  widths: readonly number[],
  { gap = 6, min = -Infinity, max = Infinity }: { gap?: number; min?: number; max?: number } = {},
): AxisLabel[] {
  const n = xs.length;
  if (!n) return [];
  const anchorOf = (i: number): Anchor => {
    const x = xs[i] ?? 0;
    const half = (widths[i] ?? 0) / 2;
    if (x - half < min) return 'start';
    if (x + half > max) return 'end';
    return 'middle';
  };
  const span = (i: number): [number, number] => {
    const x = xs[i] ?? 0;
    const w = widths[i] ?? 0;
    const anchor = anchorOf(i);
    return anchor === 'start' ? [x, x + w] : anchor === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
  };
  // шаг в точках: расстояние между соседними подписями не меньше самой широкой подписи
  const widest = Math.max(...widths, 0) + gap;
  const spacing = n > 1 ? Math.abs((xs[n - 1] ?? 0) - (xs[0] ?? 0)) / (n - 1) : widest;
  const step = Math.max(1, Math.ceil(widest / (spacing || widest)));

  const picked: number[] = [];
  const fits = (i: number) => {
    const prev = picked[picked.length - 1];
    return prev === undefined || span(i)[0] >= span(prev)[1] + gap;
  };
  for (let i = 0; i < n; i += step) if (fits(i)) picked.push(i);
  const lastIndex = n - 1;
  if (n > 1 && picked[picked.length - 1] !== lastIndex) {
    if (!fits(lastIndex) && picked.length > 1) picked.pop();
    if (fits(lastIndex)) picked.push(lastIndex);
  }
  return picked.map((index) => ({ index, x: xs[index] ?? 0, anchor: anchorOf(index) }));
}

/** Ближайшая точка по X для перекрестия: координата px внутри [left, left + width]. */
export function nearestIndex(x: number, n: number, left: number, width: number): number {
  if (n <= 1 || width <= 0) return 0;
  return clamp(Math.round(((x - left) / width) * (n - 1)), 0, n - 1);
}

/** Номер полосы (столбца) под указателем. */
export function bandIndex(x: number, n: number, left: number, band: number): number {
  if (n <= 0 || band <= 0) return 0;
  return clamp(Math.floor((x - left) / band), 0, n - 1);
}

/**
 * Где показать подсказку (position: fixed): правее и выше указателя; у правого края —
 * левее, у верхнего — ниже. Не ближе 8 px к краям окна.
 */
export function tooltipPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  viewportWidth: number,
): { left: number; top: number } {
  let left = x + 14;
  let top = y - height - 10;
  if (left + width > viewportWidth - 8) left = x - width - 14;
  if (top < 8) top = y + 16;
  return { left: Math.max(8, left), top };
}

/** Радиус точки калибровки по числу событий: от 4 до 9 px (как в макете). */
export function bubbleRadius(n: number, maxN: number): number {
  if (!(maxN > 0) || !(n > 0)) return 4;
  return 4 + 5 * Math.sqrt(Math.min(1, n / maxN));
}

/**
 * Шкала калибровки по умолчанию (как в макете, analytics.js): от круглой десятой ниже самого
 * малого прогноза, доли сыгравших и нижнего конца ДИ до 100%, но не уже 60–100% и не ниже 0.
 * Так все внутри шкалы и ничего не прижато к краю (в макете низ шкалы не ниже 20%, и корзина,
 * где не сыграло ни одно событие, легла бы на 20%).
 */
export function calibrationDomain(
  bins: readonly { p: number; actual: number; n: number; ci?: readonly [number, number] | null }[],
): [number, number] {
  const values = bins
    .filter((b) => b.n > 0)
    .flatMap((b) => [b.p, b.actual, ...(b.ci ?? [])])
    .filter(Number.isFinite);
  if (!values.length) return [0.5, 1];
  const lo = Math.floor(Math.min(...values) * 10 + 1e-9) / 10;
  return [clamp(lo, 0, 0.6), 1];
}

/** Деления калибровки: каждые 10 п.п. от d0 до d1. */
export function calibrationTicks(d0: number, d1: number): number[] {
  const ticks: number[] = [];
  for (let v = d0; v <= d1 + 1e-9; v += 0.1) ticks.push(Number(v.toFixed(2)));
  return ticks;
}

/** Значение за пределами шкалы [d0, d1] — на графике оно прижато к краю и помечено. */
export function outsideDomain(value: number, [d0, d1]: readonly [number, number]): boolean {
  return value < d0 - 1e-9 || value > d1 + 1e-9;
}

export interface HBarDomain {
  lo: number;
  hi: number;
}

/** Домен горизонтальных полос: от min(0, значений и ДИ) до max(0, …), если не задан явно. */
export function hbarDomain(
  items: readonly { value: number; ci?: readonly [number, number] | null }[],
  domain?: readonly [number, number],
): HBarDomain {
  if (domain) return { lo: domain[0], hi: domain[1] };
  const values = items.flatMap((item) => (item.ci ? [item.value, item.ci[0], item.ci[1]] : [item.value]));
  const finite = values.filter(Number.isFinite);
  return { lo: Math.min(0, ...finite), hi: Math.max(0, ...finite) };
}

export interface HBarGeometry {
  /** Положение и ширина заливки, % ширины дорожки. */
  left: number;
  width: number;
  negative: boolean;
  /** Ноль на дорожке, %; null — ноль у левого края (отрицательных нет). */
  zero: number | null;
  /** 95% ДИ поверх полосы, % ширины дорожки. */
  ci: { left: number; width: number } | null;
}

/** Полоса со знаком: растет от нуля вправо или влево; значения за доменом — до края. */
export function hbarGeometry(
  value: number,
  { lo, hi }: HBarDomain,
  ci?: readonly [number, number] | null,
): HBarGeometry {
  const span = hi - lo || 1;
  const pos = (v: number) => ((clamp(v, lo, hi) - lo) / span) * 100;
  const zero = pos(0);
  const end = pos(value);
  const ciBox = ci
    ? { left: pos(Math.min(ci[0], ci[1])), width: Math.max(0.6, Math.abs(pos(ci[1]) - pos(ci[0]))) }
    : null;
  return {
    left: Math.min(zero, end),
    width: Math.max(0.6, Math.abs(end - zero)),
    negative: value < 0,
    zero: lo < 0 ? zero : null,
    ci: ciBox,
  };
}

/** Мини-график: путь линии и заливки в рамке width × height с отступом pad. */
export function sparkGeometry(values: readonly number[], width: number, height: number, pad = 3) {
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  if (!n) return null;
  const lo = Math.min(...finite);
  const hi = Math.max(...finite);
  const x = (i: number) => (n === 1 ? width / 2 : pad + (i / (n - 1)) * (width - pad * 2));
  // ровный ряд — линия посередине
  const y = (v: number) => (hi === lo ? height / 2 : height - pad - ((v - lo) / (hi - lo)) * (height - pad * 2));
  const points: Point[] = finite.map((v, i) => [x(i), y(v)]);
  const last = points[n - 1] ?? [0, 0];
  return {
    line: linePath(points),
    area: areaPath(points, height),
    end: { x: px(last[0]), y: px(last[1]) },
  };
}
