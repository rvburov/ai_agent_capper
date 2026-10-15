import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { DataTable } from '../DataTable';
import { formatMoney, formatMoneyCompact, formatNumber, formatPercent } from '../../lib/format';
import {
  CalibrationChart,
  ChartLegend,
  ChartWithTable,
  ColumnChart,
  HBars,
  LineChart,
  Sparkline,
  type CalibrationBin,
} from './index';
import { textWidth } from './geometry';

// Компоненты графиков в jsdom: размеров у элементов нет, поэтому ширина задается явно,
// а значения проверяются через подписи, подсказку, живую область и таблицу-двойник.

const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
const BANK = [48_000, 48_600, null, 47_900, 51_200];
// Тексты на экране testing-library сравнивает со схлопнутыми пробелами (и неразрывными тоже)
const norm = (text: string) => text.replace(/\s+/g, ' ');
const rub = (v: number) => norm(formatMoney(v, 'RUB'));
const num = (v: number, digits = 0) => norm(formatNumber(v, digits));

function bankChart(width = 640) {
  return (
    <LineChart
      labels={DAYS}
      series={[{ key: 'bank', name: 'Банк', color: 'var(--s1)', values: BANK }]}
      ariaLabel="Банк по дням: с 48 000 ₽ до 51 200 ₽"
      yFormat={(v) => formatNumber(v)}
      xFormat={(d) => d.slice(8)}
      tipTitle={(d) => `День ${d.slice(8)}`}
      area
      endLabel
      refLines={[{ value: 48_000 }]}
      width={width}
    />
  );
}

describe('LineChart', () => {
  it('картинка с подписью, подсказка про клавиатуру, сетка, опорная линия, конечная метка', () => {
    const { container } = render(bankChart());
    const img = screen.getByRole('img', { name: 'Банк по дням: с 48 000 ₽ до 51 200 ₽' });
    expect(img).toHaveAttribute('tabindex', '0');
    expect(img).toHaveAccessibleDescription(/Стрелки влево и вправо/);
    expect(container.querySelectorAll('.grid-line').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelectorAll('.ref-line line')).toHaveLength(1);
    expect(container.querySelector('.area')).not.toBeNull();
    // разрыв ряда (null) — два куска линии
    expect(container.querySelector('.line')?.getAttribute('d')?.match(/M/g)).toHaveLength(2);
    expect(container.querySelector('.end-label')).toHaveTextContent(num(51_200));
    // подписи X: все пять дней, по центру своей точки (у краев место есть)
    const xs = [...container.querySelectorAll('.x-label')];
    expect(xs.map((x) => x.textContent)).toEqual(['01', '02', '03', '04', '05']);
    expect(xs.map((x) => x.getAttribute('text-anchor'))).toEqual(Array(5).fill('middle'));
  });

  it('ступенька «вложено» и отметка пополнения: пунктир, полая точка, подпись, строка подсказки', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <LineChart
        labels={DAYS}
        series={[
          { key: 'bank', name: 'Банк', color: 'var(--s1)', values: [40_000, 40_500, 60_400, 61_000, 60_800] },
          { key: 'invested', name: 'Вложено', color: 'var(--fg-3)', values: [40_000, 40_000, 60_000, 60_000, 60_000], dashed: true, step: true, thin: true, noEnd: true },
        ]}
        marks={[
          { index: 2, label: '+20 000 ₽ · пополнение, 03 окт', tip: { name: 'Пополнение', value: '+20 000 ₽' } },
          // день вне ряда не рисуется
          { index: 9, label: 'вне ряда' },
        ]}
        ariaLabel="Банк"
        yFormat={(v) => formatNumber(v)}
        xFormat={(d) => d.slice(8)}
        endLabel
        width={640}
      />,
    );
    const lines = [...container.querySelectorAll('.line')];
    // ступенька: только горизонтальные и вертикальные отрезки, тонкая
    expect(lines[1]?.getAttribute('d')).toMatch(/^M[\d.]+ [\d.]+(H[\d.]+V[\d.]+)+$/);
    expect(lines[1]).toHaveClass('thin');
    expect(lines[1]).toHaveAttribute('stroke-dasharray', '5 4');
    // у вспомогательного ряда нет точки и конечной метки: одна метка — у банка
    expect(container.querySelectorAll('.series .dot')).toHaveLength(1);
    expect(container.querySelectorAll('.end-label')).toHaveLength(1);
    expect(container.querySelector('.end-label')).toHaveTextContent(num(60_800));
    // отметка: пунктир на третий день, полая точка на линии банка, подпись справа (левая часть)
    expect(container.querySelectorAll('.mark')).toHaveLength(1);
    const markLine = container.querySelector('.mark-line')!;
    const dot = container.querySelector('.mark-dot')!;
    expect(markLine.getAttribute('x1')).toBe(dot.getAttribute('cx'));
    expect(dot).toHaveAttribute('stroke', 'var(--s1)');
    const label = container.querySelector('.mark-label')!;
    expect(label).toHaveTextContent('+20 000 ₽ · пополнение, 03 окт');
    expect(label).toHaveAttribute('text-anchor', 'start');
    expect(Number(label.getAttribute('x'))).toBeGreaterThan(Number(markLine.getAttribute('x1')));
    // в подсказке дня пополнения — строка события
    screen.getByRole('img').focus();
    await user.keyboard('{Home}{ArrowRight}{ArrowRight}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Пополнение+20 000 ₽');
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tooltip')).not.toHaveTextContent('Пополнение');
  });

  // Случай проверки волны 1: пополнения в соседние дни у середины, вывод и корректировка
  // в один день справа, банк после пополнения у верха шкалы, конечная метка справа
  it.each([
    [313, '₽ · пополнение', ''],
    [682, '₽ · пополнение', ', 1 окт'],
    [1366, '₽ · пополнение', ', 1 окт'],
  ])('подписи отметок на %i px: в полосе над графиком, в пределах рисунка, не задевают линию, конечную метку и чужой пунктир', (width, kind, date) => {
    const days = Array.from({ length: 31 }, (_, i) => new Date(Date.UTC(2026, 8, 15 + i)).toISOString().slice(0, 10));
    const bank = days.map((_, i) => (i < 16 ? 48_800 : i === 16 ? 68_800 : i < 27 ? 75_200 : i === 27 ? 72_350 : 72_035));
    const invested = days.map((_, i) => (i < 16 ? 48_800 : i < 27 ? 73_800 : 70_950));
    const { container } = render(
      <LineChart
        labels={days}
        series={[
          { key: 'bank', name: 'Банк', color: 'var(--s1)', values: bank },
          { key: 'invested', name: 'Вложено', color: 'var(--fg-3)', values: invested, dashed: true, step: true, thin: true, noEnd: true },
        ]}
        marks={[
          { index: 16, label: `+20 000 ${kind}${date}` },
          { index: 17, label: `+5 000 ${kind}${date && ', 2 окт'}` },
          { index: 27, label: `+150 ₽ · корректировка${date && ', 12 окт'}` },
          { index: 27, label: `−3 000 ₽ · вывод${date && ', 12 окт'}` },
        ]}
        ariaLabel="Банк"
        yFormat={(v) => formatNumber(v)}
        endLabel
        area
        width={width}
      />,
    );
    const attr = (el: Element, name: string) => Number(el.getAttribute(name));
    const plotTop = Math.min(...[...container.querySelectorAll('.grid-line')].map((line) => attr(line, 'y1')));
    const dashes = [...container.querySelectorAll('.mark-line')].map((line) => ({ x: attr(line, 'x1'), top: attr(line, 'y1') }));
    // пунктир дня один: вывод и корректировка 12 окт — на одной линии
    expect(dashes).toHaveLength(3);
    const labels = [...container.querySelectorAll('.mark')].flatMap((mark) => {
      const text = mark.querySelector('.mark-label');
      if (!text) return [];
      const w = textWidth(text.textContent ?? '');
      const x = attr(text, 'x');
      const x0 = text.getAttribute('text-anchor') === 'end' ? x - w : x;
      const y = attr(text, 'y');
      const own = attr(mark.querySelector('.mark-dot')!, 'cx');
      return [{ own, dash: dashes.find((dash) => dash.x === own)?.top ?? Infinity, x0, x1: x0 + w, top: y - 9, bottom: y + 3 }];
    });
    // у пополнений соседних дней подписи есть: одна слева, другая справа от своих пунктиров
    expect(labels.length).toBeGreaterThanOrEqual(2);
    expect(labels.find((label) => label.own === dashes[0]!.x)?.x1).toBeLessThan(dashes[0]!.x);
    expect(labels.find((label) => label.own === dashes[1]!.x)?.x0).toBeGreaterThan(dashes[1]!.x);
    const end = container.querySelector('.end-label')!;
    const endBox = { x0: attr(end, 'x'), x1: attr(end, 'x') + textWidth(end.textContent ?? ''), top: attr(end, 'y') - 9 };
    // линия банка и заливка — только в области построения, ниже полосы подписей
    const ys = [...container.querySelectorAll('.series path')].flatMap((path) =>
      [...(path.getAttribute('d') ?? '').matchAll(/[ML][\d.]+ ([\d.]+)|V([\d.]+)/g)].map((m) => Number(m[1] ?? m[2])),
    );
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(plotTop - 0.1);
    for (const label of labels) {
      // в пределах рисунка
      expect(label.x0).toBeGreaterThanOrEqual(0);
      expect(label.x1).toBeLessThanOrEqual(width);
      // над областью построения: ни линия, ни деления, ни конечная метка сюда не заходят
      expect(label.bottom).toBeLessThan(plotTop - 4);
      expect(label.bottom).toBeLessThan(endBox.top);
      // пунктир другого дня через подпись не проходит; свой пунктир доходит до подписи
      for (const dash of dashes) {
        if (Math.abs(dash.x - label.own) > 0.5 && dash.top < label.bottom) expect(dash.x < label.x0 - 2 || dash.x > label.x1 + 2).toBe(true);
      }
      expect(label.dash).toBeLessThanOrEqual(label.top + 1);
      // подписи одного ряда не налезают друг на друга
      for (const other of labels) {
        if (other === label || other.top !== label.top) continue;
        expect(other.x1 <= label.x0 || other.x0 >= label.x1).toBe(true);
      }
    }
  });

  it('отметка на телефоне: подпись, которой нет места, не рисуется — пунктир и точка остаются', () => {
    const { container } = render(
      <LineChart
        labels={DAYS}
        series={[{ key: 'bank', name: 'Банк', color: 'var(--s1)', values: [1, 2, 3, 4, 5] }]}
        marks={[{ index: 2, label: '+20 000 000 ₽ · пополнение, 14 сентября 2026 года' }]}
        ariaLabel="Банк"
        width={200}
      />,
    );
    expect(container.querySelector('.mark-line')).not.toBeNull();
    expect(container.querySelector('.mark-dot')).not.toBeNull();
    expect(container.querySelector('.mark-label')).toBeNull();
  });

  it('клавиатура: стрелки, Home, End, Esc — подсказка и текст для читалки', async () => {
    const user = userEvent.setup();
    render(bankChart());
    const img = screen.getByRole('img');
    await user.tab();
    expect(img).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('День 01');
    expect(tip).toHaveTextContent(`Банк${num(48_000)}`);
    expect(screen.getByText(`День 01. Банк: ${num(48_000)}`)).toBeInTheDocument();
    await user.keyboard('{ArrowRight}{ArrowRight}');
    // нет значения в этот день — прочерк, точка не рисуется
    expect(screen.getByRole('tooltip')).toHaveTextContent('День 03Банк—');
    await user.keyboard('{End}');
    expect(screen.getByRole('tooltip')).toHaveTextContent(`День 05Банк${num(51_200)}`);
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('День 05');
    await user.keyboard('{Home}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('День 01');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('указатель: перекрестие на ближайшем дне, уход — подсказка скрыта', () => {
    const { container } = render(bankChart(640));
    const img = screen.getByRole('img');
    // в jsdom svg стоит в (0, 0): ближе всего к правому краю — последний день
    fireEvent.pointerMove(img, { clientX: 630, clientY: 50 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('День 05');
    expect(container.querySelector('.crosshair')).not.toBeNull();
    // для указателя текст читалке не дублируется
    expect(screen.queryByText(/^День 05\. Банк/)).toBeNull();
    fireEvent.pointerLeave(img);
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(container.querySelector('.crosshair')).toBeNull();
  });

  it('касание: подсказка остается после того, как палец убран, прокрутка ее прячет', () => {
    render(bankChart(640));
    const img = screen.getByRole('img');
    fireEvent.pointerDown(img, { clientX: 10, clientY: 50, pointerType: 'touch' });
    fireEvent.pointerLeave(img, { pointerType: 'touch' });
    expect(screen.getByRole('tooltip')).toHaveTextContent('День 01');
    fireEvent.scroll(window);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('несколько рядов: в подсказке все ряды с цветной меткой, текст без цвета', async () => {
    const user = userEvent.setup();
    render(
      <LineChart
        labels={['a', 'b']}
        series={[
          { key: 'model', name: 'Модель', color: 'var(--s1)', values: [0.21, 0.2] },
          { key: 'market', name: 'Рынок', color: 'var(--s2)', values: [0.22, 0.215] },
        ]}
        ariaLabel="Brier"
        yFormat={(v) => formatNumber(v, 3)}
        width={360}
      />,
    );
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    const tip = screen.getByRole('tooltip');
    expect(tip).toHaveTextContent('bМодель0,200Рынок0,215');
    const keys = tip.querySelectorAll('.tip-key i');
    expect([...keys].map((k) => (k as HTMLElement).style.background)).toEqual(['var(--s1)', 'var(--s2)']);
    expect(tip.querySelector('b')).not.toHaveAttribute('style');
  });

  it('360 px: рисунок по ширине, подписи внутри, ось Y по круглым делениям', () => {
    const { container } = render(bankChart(360));
    const svg = container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '360');
    for (const text of container.querySelectorAll('text')) {
      const x = Number(text.getAttribute('x'));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(360);
    }
    const yTicks = [...container.querySelectorAll('text[text-anchor="end"]:not(.x-label)')].map((t) => t.textContent);
    expect(yTicks.length).toBeGreaterThanOrEqual(2);
  });

  it('пустой ряд не ломает график и не ловит фокус', () => {
    render(<LineChart labels={[]} series={[]} ariaLabel="Пусто" width={360} />);
    expect(screen.getByRole('img', { name: 'Пусто' })).not.toHaveAttribute('tabindex');
  });

  it('подписи оси Y попарно различны: кэфы по умолчанию, банк около миллиона сокращенно', () => {
    const days = Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
    const { container, unmount } = render(
      <LineChart
        labels={days}
        series={[{ key: 'o', name: 'Кэф', color: 'var(--s1)', values: [1.8, 1.85, 1.9, 2, 2.1, 1.95, 1.9, 1.88, 1.92, 2.05] }]}
        ariaLabel="Кэф"
        width={360}
      />,
    );
    expect(yLabels(container)).toEqual(['1,7', '1,8', '1,9', '2,0', '2,1', '2,2']);
    unmount();
    const bank = render(
      <LineChart
        labels={days}
        series={[{ key: 'b', name: 'Банк', color: 'var(--s1)', values: days.map((_, i) => 999_000 + i * 3_000) }]}
        ariaLabel="Банк"
        endLabel
        yFormat={(v, axis) => formatMoneyCompact(v, 'RUB', { step: axis?.step })}
        width={360}
      />,
    );
    const labels = yLabels(bank.container);
    expect(new Set(labels).size).toBe(labels.length);
    expect(labels.map(norm)).toContain('1,01 млн ₽');
    // конечная метка — значение целиком, без шага делений
    expect(bank.container.querySelector('.end-label')).toHaveTextContent(norm(formatMoneyCompact(1_026_000, 'RUB')));
  });

  it('длинная конечная метка не вылезает за рисунок: места справа по ее ширине или над точкой', () => {
    const big = (width: number) =>
      render(
        <LineChart
          labels={['a', 'b', 'c']}
          series={[{ key: 'b', name: 'Банк', color: 'var(--s1)', values: [1_250_000.5, 1_270_000.2, 1_280_746.89] }]}
          ariaLabel="Банк"
          endLabel
          yFormat={(v) => formatMoney(v, 'USD')}
          width={width}
        />,
      ).container.querySelector('.end-label')!;
    // 298 px: метка справа от точки, и места под нее хватает (раньше места было не больше 80 px)
    const right = big(298);
    expect(right).not.toHaveAttribute('text-anchor');
    expect(Number(right.getAttribute('x')) + textWidth(right.textContent ?? '')).toBeLessThanOrEqual(298);
    // 240 px: справа места нет — метка над точкой, правым краем к ней
    const inside = big(240);
    expect(inside).toHaveAttribute('text-anchor', 'end');
    expect(Number(inside.getAttribute('x'))).toBeLessThanOrEqual(240);
    expect(Number(inside.getAttribute('x')) - textWidth(inside.textContent ?? '')).toBeGreaterThanOrEqual(0);
  });
});

// Подписи оси Y (без подписей X и конечной метки)
function yLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('text[text-anchor="end"]:not(.x-label):not(.end-label)')].map(
    (t) => t.textContent ?? '',
  );
}

describe('ColumnChart', () => {
  const items = [
    { key: '1', label: '1 окт', value: 0.42 },
    { key: '2', label: '2 окт', value: 0 },
    { key: '3', label: '3 окт', value: 1.3 },
  ];

  it('столбцы от нуля, последний выделен, подсказка с подписью ряда', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ColumnChart
        items={items}
        ariaLabel="Расход по дням UTC"
        seriesName="Расход за день"
        valueFormat={(v) => `$${formatNumber(v, 2)}`}
        highlightLast
        width={360}
      />,
    );
    expect(screen.getByRole('img', { name: 'Расход по дням UTC' })).toBeInTheDocument();
    const columns = container.querySelectorAll('.column');
    expect(columns).toHaveLength(3);
    expect(columns[0]).toHaveClass('dim');
    expect(columns[2]).not.toHaveClass('dim');
    expect(container.querySelector('.axis-line')).not.toBeNull();
    await user.tab();
    await user.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('3 октРасход за день$1,30');
    expect(container.querySelectorAll('.column.on')).toHaveLength(1);
  });

  it('отрицательные значения уходят ниже нуля, свои строки подсказки', () => {
    const { container } = render(
      <ColumnChart
        items={[
          { key: 'a', label: 'до −1%', short: '−1', value: -2, tip: [{ key: 'n', name: 'Ставок', value: '2' }] },
          { key: 'b', label: 'от 0 до +1%', short: '0', value: 5 },
        ]}
        ariaLabel="Распределение CLV"
        width={360}
      />,
    );
    const [neg] = container.querySelectorAll('.column');
    const zero = container.querySelector('.axis-line')!;
    // путь отрицательного столбца начинается на нуле и уходит вниз
    const y0 = Number(zero.getAttribute('y1'));
    const d = neg!.getAttribute('d')!;
    expect(d.startsWith(`M`)).toBe(true);
    expect(Number(/^M[\d.]+ ([\d.]+)/.exec(d)?.[1])).toBe(y0);
    expect(Math.max(...[...d.matchAll(/[ VQ][\d.]+ ?([\d.]+)?/g)].map((m) => Number(m[1] ?? 0)))).toBeGreaterThan(y0);
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 60, clientY: 50 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('до −1%Ставок2');
  });

  it('счетчики (распределение CLV у нового участника): деления 0 и 1, а не «0, 1, 1»', () => {
    const { container } = render(
      <ColumnChart
        items={[-2, -1, 0, 1, 2].map((k, i) => ({ key: String(k), label: `от ${k}`, value: [1, 0, 1, 1, 0][i]! }))}
        ariaLabel="Распределение CLV"
        seriesName="Ставок"
        valueFormat={(v) => formatNumber(v)}
        width={360}
      />,
    );
    expect(yLabels(container)).toEqual(['0', '1']);
  });

  it('только отрицательные: ноль — верхнее деление, столбцы во всю высоту', () => {
    const { container } = render(
      <ColumnChart
        items={[-0.02, -0.01, -0.015, -0.03].map((value, i) => ({ key: String(i), label: `Неделя ${i + 1}`, value }))}
        ariaLabel="Результат по неделям"
        valueFormat={(v) => formatPercent(v, { signed: true })}
        width={360}
      />,
    );
    const labels = yLabels(container);
    expect(labels[labels.length - 1]).toBe('0,0%');
    expect(labels.some((label) => label.startsWith('+'))).toBe(false);
    // самый длинный столбец (−3%) доходит до нижнего деления
    const zero = container.querySelector('.axis-line')!;
    expect(Number(zero.getAttribute('y1'))).toBe(10);
  });
});

describe('HBars', () => {
  it('список полос: подпись, значение, заметка, ДИ линией и текстом', () => {
    const fmt = (v: number) => formatPercent(v, { signed: true });
    const { container } = render(
      <HBars
        ariaLabel="ROI по покрытиям"
        valueFormat={fmt}
        items={[
          { key: 'hard', label: 'Хард', value: 0.084, color: 'var(--hard)', note: '42 события', ci: [-0.05, 0.21] },
          { key: 'clay', label: 'Грунт', value: -0.031, color: 'var(--clay)', dim: true },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'ROI по покрытиям' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Хард+8,4%42 события');
    expect(rows[0]).toHaveTextContent('95% доверительный интервал: −5,0%…+21,0%');
    expect(rows[0]).toHaveAttribute('title', 'Хард: +8,4%, 95% ДИ −5,0%…+21,0%');
    expect(rows[1]).toHaveClass('dim');
    expect(container.querySelector('.hbar-fill.neg')).not.toBeNull();
    // есть отрицательные — линия нуля на месте нуля
    expect(container.querySelectorAll('.hbar-zero')).toHaveLength(2);
    expect(container.querySelectorAll('.hbar-ci')).toHaveLength(1);
  });
});

describe('CalibrationChart', () => {
  const bins: CalibrationBin[] = [
    { key: '55', lo: 0.55, hi: 0.6, p: 0.57, actual: 0.6, n: 20, ci: [0.39, 0.78] },
    { key: '60', lo: 0.6, hi: 0.65, p: 0.62, actual: 0.55, n: 40 },
    { key: '65', lo: 0.65, hi: 0.7, p: 0.67, actual: 0.7, n: 0 },
  ];

  it('точки только с событиями, размер по числу событий, зона наведения от 24 px, ДИ', async () => {
    const user = userEvent.setup();
    const { container } = render(<CalibrationChart bins={bins} ariaLabel="Калибровка" width={360} diagonalLabel />);
    expect(screen.getByRole('img', { name: 'Калибровка' })).toBeInTheDocument();
    const dots = container.querySelectorAll('circle.dot');
    expect(dots).toHaveLength(2);
    expect(Number(dots[1]!.getAttribute('r'))).toBe(9);
    for (const hit of container.querySelectorAll('circle.hit')) expect(Number(hit.getAttribute('r'))).toBeGreaterThanOrEqual(12);
    // шкала по данным — от 30% (нижний конец ДИ 39%): ДИ целиком, засечки на обоих концах
    expect(container.querySelectorAll('.ci line')).toHaveLength(3);
    expect(container.querySelectorAll('.ci-arrow')).toHaveLength(0);
    expect(screen.getByText('идеальная калибровка')).toBeInTheDocument();
    expect(screen.getByText('прогноз модели →')).toBeInTheDocument();

    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Прогноз 55–60%Средний прогноз57%Сбылось60%95% ДИ39%…78%Событий20');
    fireEvent.pointerMove(container.querySelectorAll('circle.hit')[1]!, { clientX: 10, clientY: 10 });
    expect(screen.getByRole('tooltip')).toHaveTextContent('Прогноз 60–65%');
    fireEvent.pointerLeave(container.querySelectorAll('circle.hit')[1]!);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('шкала по умолчанию — по данным: доля 30% стоит на 30%, ДИ 7–69% целиком', () => {
    const { container } = render(
      <CalibrationChart
        bins={[{ key: 'x', lo: 0.5, hi: 0.55, p: 0.52, actual: 0.3, n: 4, ci: [0.07, 0.69] }]}
        ariaLabel="Калибровка"
        width={360}
      />,
    );
    const dot = container.querySelector('circle.dot')!;
    expect(dot).not.toHaveClass('off');
    expect(yLabels(container)[0]).toBe('0%');
    // точка — на линии сетки 30%, а не на краю шкалы
    const line30 = [...container.querySelectorAll('g')].find((g) => g.querySelector('text')?.textContent === '30%');
    expect(dot.getAttribute('cy')).toBe(line30?.querySelector('.grid-line')?.getAttribute('y1'));
    expect(container.querySelectorAll('.ci-arrow')).toHaveLength(0);
  });

  it('заданная шкала: доля и концы ДИ за ней помечены — полая точка, стрелка, текст', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <CalibrationChart
        bins={[
          { key: 'a', lo: 0.5, hi: 0.55, p: 0.52, actual: 0.3, n: 4, ci: [0.07, 0.69] },
          { key: 'b', lo: 0.6, hi: 0.65, p: 0.62, actual: 0.6, n: 30, ci: [0.43, 0.75] },
        ]}
        domain={[0.5, 1]}
        ariaLabel="Калибровка"
        width={360}
      />,
    );
    const [low, ok] = container.querySelectorAll('circle.dot');
    expect(low).toHaveClass('off');
    expect(low).toHaveAttribute('fill', 'var(--surface)');
    expect(ok).not.toHaveClass('off');
    // у обеих корзин нижний конец ДИ ниже 50% — две стрелки, верхние концы — засечки
    expect(container.querySelectorAll('.ci-arrow')).toHaveLength(2);
    await user.tab();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Сбылось30% · за пределами шкалы');
    expect(screen.getByRole('tooltip')).toHaveTextContent('95% ДИ7%…69% · за пределами шкалы');
    // текст для читалки — тот же
    expect(screen.getByText(/Сбылось: 30% · за пределами шкалы/)).toBeInTheDocument();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tooltip')).toHaveTextContent('Сбылось60%95% ДИ');
    expect(screen.getByRole('tooltip')).toHaveTextContent('43%…75% · за пределами шкалы');
  });

  it('шкала от 0% на 360 px: подписи оси X не налезают друг на друга', () => {
    const { container } = render(
      <CalibrationChart bins={[{ key: 'z', lo: 0.6, hi: 0.65, p: 0.62, actual: 0, n: 2 }]} ariaLabel="Калибровка" width={296} />,
    );
    const xs = [...container.querySelectorAll('text.x-label')].filter((t) => /%$/.test(t.textContent ?? ''));
    expect(xs[0]).toHaveTextContent('0%');
    expect(xs[xs.length - 1]).toHaveTextContent('100%');
    expect(xs.length).toBeLessThan(11);
  });
});

describe('Sparkline', () => {
  it('декоративный рядом с числом; с подписью — картинка; пустой — ничего', () => {
    const { container, rerender } = render(<Sparkline values={[1, 2, 3]} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    rerender(<Sparkline values={[1, 2, 3]} ariaLabel="Банк за 30 дней" />);
    expect(screen.getByRole('img', { name: 'Банк за 30 дней' })).toBeInTheDocument();
    rerender(<Sparkline values={[]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('ChartWithTable и легенда', () => {
  const rows = [
    { day: '1 окт', bank: 48_000 },
    { day: '5 окт', bank: 51_200 },
  ];

  it('«Показать таблицей»: таблица тех же данных строится при первом открытии', async () => {
    const user = userEvent.setup();
    const table = vi.fn(() => (
      <DataTable
        caption="Банк по дням"
        columns={[
          { key: 'day', label: 'День' },
          { key: 'bank', label: 'Банк', align: 'r', render: (r: (typeof rows)[number]) => rub(r.bank) },
        ]}
        rows={rows}
        rowKey={(r) => r.day}
      />
    ));
    render(
      <ChartWithTable
        table={table}
        legend={[
          { key: 'bank', name: 'Банк на конец дня', color: 'var(--s1)' },
          { key: 'start', name: 'Банк на начало периода', type: 'dash' },
        ]}
      >
        {bankChart(360)}
      </ChartWithTable>,
    );
    const legend = screen.getAllByRole('list')[0]!;
    expect(within(legend).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Банк на конец дня',
      'Банк на начало периода',
    ]);
    const toggle = screen.getByRole('button', { name: 'Показать таблицей' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(table).not.toHaveBeenCalled();
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAccessibleName('Скрыть таблицу');
    const grid = screen.getByRole('table', { name: 'Банк по дням' });
    expect(within(grid).getByText(rub(51_200))).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByRole('table')).toBeNull();
    await user.click(toggle);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(table.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('нет данных — пустое состояние без графика и кнопки', () => {
    render(
      <ChartWithTable table={() => null} empty="Нет ставок за период">
        {bankChart(360)}
      </ChartWithTable>,
    );
    expect(screen.getByText('Нет ставок за период')).toBeInTheDocument();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('перезапрос: прежний график на месте, блок занят', () => {
    const { container } = render(
      <ChartWithTable table={() => null} pending>
        {bankChart(360)}
      </ChartWithTable>,
    );
    expect(container.querySelector('.chart-block')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('легенда: метка ряда цветом, пунктир — без цвета', () => {
    const { container } = render(
      <ChartLegend
        items={[
          { key: 'a', name: 'Модель', color: 'var(--s1)' },
          { key: 'b', name: 'Ставок', color: 'var(--s2)', type: 'box' },
          { key: 'c', name: 'Ноль', type: 'dash' },
        ]}
      />,
    );
    const marks = [...container.querySelectorAll('i')] as HTMLElement[];
    expect(marks.map((m) => m.className)).toEqual(['', 'box', 'dash']);
    expect(marks[0]!.style.background).toBe('var(--s1)');
    expect(marks[2]!.style.background).toBe('');
  });
});

describe('ширина по контейнеру', () => {
  it('без ширины — запасная ширина, после изменения размера — новая', () => {
    let callback: ResizeObserverCallback = () => undefined;
    const observe = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(cb: ResizeObserverCallback) {
          callback = cb;
        }
        observe = observe;
        disconnect = vi.fn();
        unobserve = vi.fn();
      },
    );
    const chart = render(
      <LineChart labels={['a', 'b']} series={[{ key: 's', name: 'S', color: 'var(--s1)', values: [1, 2] }]} ariaLabel="Ряд" />,
    );
    const svg = chart.container.querySelector('svg')!;
    expect(svg).toHaveAttribute('width', '640');
    const box = chart.container.querySelector('.chart')!;
    Object.defineProperty(box, 'clientWidth', { configurable: true, value: 360 });
    act(() => callback([], {} as ResizeObserver));
    expect(chart.container.querySelector('svg')).toHaveAttribute('width', '360');
    expect(observe).toHaveBeenCalledWith(box);
  });
});
