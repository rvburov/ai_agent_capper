import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { BudgetBar, budgetBarParts } from './BudgetBar';
import { LimitBar, limitBarParts, spendTone } from './LimitBar';

describe('полосы расхода', () => {
  it('цвет: с порога уведомления — желтый, со 100% — красный; порог задает администратор', () => {
    expect(spendTone(7.9, 10, 80)).toBeNull();
    expect(spendTone(8, 10, 80)).toBe('warn');
    expect(spendTone(7, 10, 70)).toBe('warn');
    expect(spendTone(10, 10, 90)).toBe('bad');
    expect(spendTone(12, 10, 80)).toBe('bad');
    expect(spendTone(5, 0, 80)).toBeNull();
  });

  it('лимит: заливка не больше 100%, отметка порога на месте', () => {
    expect(limitBarParts(1.93, 10, 80)).toEqual({ fill: 19.3, mark: 80, tone: null });
    expect(limitBarParts(12, 10, 50)).toEqual({ fill: 100, mark: 50, tone: 'bad' });
    expect(limitBarParts(0, 0, 80)).toEqual({ fill: 0, mark: 80, tone: null });
  });

  it('бюджет: потрачено и прогноз в процентах полосы, прогноз выше бюджета — до края', () => {
    expect(budgetBarParts(41.2, 66, 60, 80)).toEqual({ spent: (41.2 / 60) * 100, forecast: 100, mark: 80, tone: null });
    expect(budgetBarParts(50, 55, 60, 80).tone).toBe('warn');
    expect(budgetBarParts(60, 60, 60, 80)).toMatchObject({ spent: 100, tone: 'bad' });
  });

  it('разметка: meter с подписью и значением, отметка порога и шкала', () => {
    const { container } = render(
      <LimitBar spent={8.5} max={10} alertPct={80} label="Расход лимита" valueText="$8,50 из $10" scale={['$0', '80% · $8', '$10']} />,
    );
    const meter = screen.getByRole('meter', { name: 'Расход лимита' });
    expect(meter).toHaveAttribute('aria-valuetext', '$8,50 из $10');
    expect(meter).toHaveAttribute('aria-valuemax', '10');
    expect(container.querySelector('.limit-bar-fill')).toHaveClass('warn');
    expect(container.querySelector('.limit-bar-fill')).toHaveStyle({ width: '85%' });
    expect(container.querySelector('.limit-bar-mark')).toHaveStyle({ left: '80%' });
    expect(screen.getByText('80% · $8')).toHaveClass('mid');
  });

  it('подпись порога наезжает на подпись лимита (90%, $5 000 на 375 px) — уходит второй строкой', () => {
    // места подписей на телефоне 375 px из проверки в браузере: «90% · $4 500» до 313 px, «$5 000» с 304 px
    const boxes: Record<string, [number, number]> = { mid: [232, 313], end: [304, 344] };
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = boxes[this.classList.contains('mid') ? 'mid' : this.classList.contains('end') ? 'end' : ''];
      const [left, right] = box ?? [0, 0];
      return { left, right, width: right - left, top: 0, bottom: 16, height: 16, x: left, y: 0, toJSON: () => ({}) };
    });
    const bar = (end: string) => (
      <LimitBar spent={100} max={5000} alertPct={90} label="Расход" valueText="$100 из $5 000" scale={['$0', '90% · $4 500', end]} />
    );
    const { container, rerender } = render(bar('$5 000'));
    expect(container.querySelector('.limit-bar-scale')).toHaveClass('tight');
    // места хватает (широкий экран) — подписи в одну строку
    boxes.end = [330, 370];
    rerender(bar('$5 000 '));
    expect(container.querySelector('.limit-bar-scale')).not.toHaveClass('tight');
    rect.mockRestore();
  });

  it('полоса бюджета: штриховка прогноза, легенда и подсказка у порога', () => {
    const { container } = render(
      <BudgetBar
        spent={30}
        forecast={45}
        budget={60}
        alertPct={80}
        label="Потрачено $30 из $60"
        markTitle="Уведомление при 80%"
        legend={['Потрачено за 1–7 окт', 'Прогноз на 31 окт', 'Уведомление при 80%']}
      />,
    );
    expect(screen.getByRole('meter', { name: 'Потрачено $30 из $60' })).toHaveAttribute('aria-valuenow', '30');
    expect(container.querySelector('.budget-bar .proj')).toHaveStyle({ width: '75%' });
    expect(container.querySelector('.budget-bar .spent')).toHaveStyle({ width: '50%' });
    expect(container.querySelector('.budget-bar .mark')).toHaveAttribute('title', 'Уведомление при 80%');
    expect(screen.getByText('Прогноз на 31 окт')).toBeInTheDocument();
  });
});
