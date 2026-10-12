import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { setViewportWidth } from '../test/setup';
import { Disclosure } from './Disclosure';
import { FormDots } from './FormDots';
import { FreshnessChip } from './FreshnessChip';
import { OddsBox, OddsGrid } from './OddsBox';
import { ProgressBar } from './ProgressBar';
import { StepTimeline, type TimelineState } from './StepTimeline';
import { Stepper } from './Stepper';
import { StickyActionBar } from './StickyActionBar';
import { SurfaceChip } from './SurfaceChip';

const STATES: Record<TimelineState, string> = {
  pending: 'ожидает',
  active: 'выполняется',
  done: 'готово',
  failed: 'не выполнен',
  warn: 'с предупреждением',
  skipped: 'не выполнялся',
};

describe('шаги и ход', () => {
  it('Stepper: выполненные шаги, текущий и короткие подписи', () => {
    render(
      <Stepper
        items={[{ label: 'Ввод событий', short: 'Ввод' }, 'Проверка', 'Анализ']}
        current={1}
        label="Шаги анализа"
        doneLabel="готово"
        variant="pills"
      />,
    );
    const list = screen.getByRole('list', { name: 'Шаги анализа' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveClass('done');
    expect(items[0]).toHaveTextContent('Ввод событийВводготово');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[2]).not.toHaveClass('done');
  });

  it('StepTimeline: состояния для читалки, сбой и подробности', () => {
    render(
      <StepTimeline
        label="Шаги анализа"
        stateLabels={STATES}
        steps={[
          { key: 'parse', title: 'Разбор текста', state: 'done', detail: '2 события', meta: '1 с' },
          { key: 'claude', title: 'Claude: Синнер — Руне', state: 'failed', message: 'Claude перегружен' },
          { key: 'compose', title: 'Экспресс', state: 'pending', meta: 'ожидает' },
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Шаги анализа' })).getAllByRole('listitem');
    expect(items[0]).toHaveClass('is-done');
    expect(items[0]).toHaveTextContent('Разбор текстаготово2 события1 с');
    expect(items[1]).toHaveClass('is-failed');
    expect(items[1]).toHaveTextContent('Claude перегружен');
    expect(items[2]).toHaveTextContent('3');
    expect(items[2]).toHaveTextContent('ожидает');
  });

  it('ProgressBar: значение в границах', () => {
    render(<ProgressBar value={12} max={9} label="Ход анализа" valueText="Шаг 9 из 9" />);
    const bar = screen.getByRole('progressbar', { name: 'Ход анализа' });
    expect(bar).toHaveAttribute('aria-valuetext', 'Шаг 9 из 9');
    expect(bar.querySelector('i')).toHaveStyle({ width: '100%' });
  });
});

describe('Disclosure', () => {
  it('свое состояние: подпись от состояния, тело скрыто до клика', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure summary={(open) => (open ? 'Скрыть шаги' : 'Показать шаги')}>
        <p>Шаги</p>
      </Disclosure>,
    );
    const button = screen.getByRole('button', { name: 'Показать шаги' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Шаги')).not.toBeVisible();
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Скрыть шаги' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Шаги')).toBeVisible();
  });

  it('управляемое состояние: только сообщает о клике', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(
      <Disclosure summary="Как посчитана сумма" open={false} onToggle={onToggle} variant="header">
        <p>Расчет</p>
      </Disclosure>,
    );
    await user.click(screen.getByRole('button', { name: 'Как посчитана сумма' }));
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(screen.getByText('Расчет')).not.toBeVisible();
  });
});

describe('метки', () => {
  it('покрытие, свежесть новостей, форма', () => {
    render(
      <>
        <SurfaceChip surface="clay" />
        <SurfaceChip surface="ice" />
        <FreshnessChip state="stale" />
        <FreshnessChip state="missing" />
        <FormDots results={['W', 'L', 'W']} />
      </>,
    );
    expect(screen.getByText('Грунт')).toBeInTheDocument();
    expect(screen.getByText('Покрытие не указано')).toBeInTheDocument();
    expect(screen.getByText('Поищем новости')).toBeInTheDocument();
    expect(screen.getByText('Анализ не запустим')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Форма: победа, поражение, победа' })).toBeInTheDocument();
  });

  it('кэфы: рамка и сетка полей', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onBlur = vi.fn();
    render(
      <>
        <OddsBox label="П1" value="1.3" picked />
        <OddsGrid
          label="Кэфы: Синнер — Руне"
          corridorTitle="В коридоре стратегии"
          idPrefix="ev1"
          onChange={onChange}
          onBlur={onBlur}
          cells={[
            { key: 'ml1', label: 'П1', value: '1.30', ariaLabel: 'Кэф П1', inCorridor: true },
            { key: 'ml2', label: 'П2', value: '0.5', ariaLabel: 'Кэф П2', invalid: true },
          ]}
        />
      </>,
    );
    expect(screen.getByText('1.30').closest('.odds-box')).toHaveClass('picked');
    const group = screen.getByRole('group', { name: 'Кэфы: Синнер — Руне' });
    expect(within(group).getByLabelText('Кэф П2')).toHaveAttribute('aria-invalid', 'true');
    await user.type(within(group).getByLabelText('Кэф П1'), '5');
    expect(onChange).toHaveBeenCalledWith('ml1', '1.305');
    await user.tab();
    expect(onBlur).toHaveBeenCalledWith('ml1');
  });
});

describe('StickyActionBar', () => {
  function Page() {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button ref={ref} type="button">
          Запустить анализ
        </button>
        <StickyActionBar label="Запуск анализа" watch={ref}>
          <span>2 события</span>
        </StickyActionBar>
      </>
    );
  }

  it('только на телефоне', () => {
    const { unmount } = render(<Page />);
    expect(screen.queryByRole('region', { name: 'Запуск анализа' })).not.toBeInTheDocument();
    unmount();
    setViewportWidth(375);
    render(<Page />);
    expect(screen.getByRole('region', { name: 'Запуск анализа' })).toHaveTextContent('2 события');
  });
});
