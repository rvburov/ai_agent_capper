import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { betsSummary } from '../../features/bets/testData';
import { strategyV3 } from '../../test/factories';
import { json, ME_ADMIN, ME_MEMBER, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { LearningPage } from './LearningPage';

// «Обучение модели» волны 1 этапа 5: каркас по макету (learning.js) — шапка, плитки, цикл,
// вкладки-адреса с пустыми состояниями (#learning-empty). Часы зафиксированы: дата следующего
// отчета (понедельник 07:00 по поясу участника) зависит от «сейчас».

// четверг, 15 окт 2026, 13:00 в Хельсинки — следующий отчет в понедельник 19 окт
const NOW = new Date('2026-10-15T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function api(settled = 0, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/bets/summary': () => json(betsSummary({ settled })),
    'GET /api/strategy/active': () => json(strategyV3()),
    ...extra,
  };
}

function renderLearning(url = '/learning', options: { me?: typeof ME_MEMBER | typeof ME_ADMIN; settled?: number; width?: number } = {}) {
  return renderPage(<LearningPage />, {
    path: '/learning/:tab?',
    url,
    me: options.me ?? ME_MEMBER,
    api: api(options.settled ?? 0),
    stubs: { '/profile/:tab?': 'Личный кабинет' },
    ...(options.width ? { width: options.width } : {}),
  });
}

const tiles = () => within(screen.getByRole('group', { name: 'Что учится сейчас' })).getAllByRole('link');

describe('Обучение модели: каркас и пустые состояния', () => {
  it('шапка, четыре плитки, цикл из шести шагов, вкладка «Уроки» — пусто', async () => {
    const { calls } = renderLearning();
    expect(screen.getByRole('heading', { level: 2, name: 'Как модель учится на ставках' })).toBeInTheDocument();
    expect(await screen.findByText(/^Рассчитанных ставок пока нет/)).toBeInTheDocument();
    // итоги — только ставки приложения за все время
    const summary = calls.find((request) => new URL(request.url).pathname === '/api/bets/summary');
    expect(new URL(summary!.url).searchParams.get('source')).toBe('app');
    expect(new URL(summary!.url).searchParams.get('period')).toBe('all');

    const [lessons, versions, model, report] = tiles();
    expect(tiles()).toHaveLength(4);
    expect(lessons).toHaveTextContent('Уроки в анализе0из 15гипотез пока нет');
    expect(lessons).toHaveAttribute('aria-current', 'true');
    expect(lessons).toHaveAttribute('href', '/learning');
    await waitFor(() => expect(versions).toHaveTextContent('Инструкции анализаv3активнакандидатов нет'));
    expect(versions).toHaveAttribute('href', '/learning/versions');
    expect(model).toHaveTextContent('Базовая модель—BrierЭло по покрытиям + калибровка');
    expect(report).toHaveTextContent('Отчет недели—следующий — пн 19 окт, 07:00');

    const cycle = screen.getByRole('list', { name: 'Цикл обучения, 6 шагов' });
    expect(within(cycle).getAllByRole('listitem')).toHaveLength(6);
    expect(within(cycle).getByRole('heading', { name: /^Шаг 3\.\s?Разбор ставки$/ })).toBeInTheDocument();
    expect(within(cycle).getByText('Sonnet 5.5 · Batch · ≈ $0,01')).toBeInTheDocument();
    expect(within(cycle).getByText(/^С 20 своих случаев/)).toBeInTheDocument();
    expect(screen.getByText(/после 300 событий с исходами/)).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: 'Разделы обучения' });
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Уроки', 'Версии стратегии', 'Базовая модель', 'Отчеты']);
    expect(within(tablist).getByRole('tab', { name: 'Уроки' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Уроки' });
    expect(within(panel).getByText(/^Уроков пока нет\. .* с 20 своих случаев/)).toBeInTheDocument();
    expect(within(panel).getByText('Общие для всех участников, ведет администратор. В анализ попадают только подтвержденные — не больше 15, сейчас 0.')).toBeInTheDocument();
    // участник уроки не ведет
    expect(within(panel).getByText('Ведет администратор')).toBeInTheDocument();
    const filter = within(panel).getByRole('group', { name: 'Какие уроки показать' });
    expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual(['Все · 0', 'Подтверждены · 0', 'Ждут решения · 0', 'Гипотезы · 0', 'Отклонены · 0']);
    // заглушки этапа больше нет
    expect(screen.queryByText(/появится на этапе/i)).toBeNull();
  });

  it('рассчитанные ставки — число в шапке с правильным склонением', async () => {
    renderLearning('/learning', { settled: 3 });
    expect(await screen.findByText(/^Рассчитано 3 ставки приложения\./)).toBeInTheDocument();
  });

  it('итоги не загрузились — шапка без чисел', async () => {
    renderPage(<LearningPage />, {
      path: '/learning/:tab?',
      url: '/learning',
      api: api(0, { 'GET /api/bets/summary': () => json({ error: { code: 'x', message: 'x' } }, 500) }),
    });
    expect(await screen.findByText(/^Каждая рассчитанная ставка получает разбор ИИ/)).toBeInTheDocument();
  });

  it('плитка ведет на свою вкладку: адрес, выбранная вкладка и плитка', async () => {
    const { router, user } = renderLearning();
    await user.click(tiles()[3]!);
    await waitFor(() => expect(router.state.location.pathname).toBe('/learning/reports'));
    expect(screen.getByRole('tab', { name: 'Отчеты' })).toHaveAttribute('aria-selected', 'true');
    expect(tiles()[3]).toHaveAttribute('aria-current', 'true');
    expect(tiles()[0]).not.toHaveAttribute('aria-current');
  });

  it('«Версии стратегии» участника: набор не заморожен — это делает администратор; свои правила суммы ставки', async () => {
    const { user, router } = renderLearning('/learning/versions');
    const panel = screen.getByRole('tabpanel', { name: 'Версии стратегии' });
    expect(within(panel).getByText('Набор для проверки версий еще не заморожен.')).toBeInTheDocument();
    expect(within(panel).getByText(/Это делает администратор\.$/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Оценить на наборе' })).toBeNull();
    expect(await within(panel).findByText('Общие для всех участников. Пока одна версия — v3')).toBeInTheDocument();
    expect(within(panel).getByRole('heading', { name: 'Как принимается новая версия' })).toBeInTheDocument();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(4);
    const stake = within(panel).getByRole('heading', { name: 'Ваши правила суммы ставки' }).closest('section')!;
    expect(within(stake).getByText('Активная')).toBeInTheDocument();
    await user.click(within(stake).getByRole('link', { name: 'Банк и стратегия' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/profile/bank'));
  });

  it('«Версии стратегии» администратора: «Оценить на наборе» пока недоступна, подсказка — загрузить файл', async () => {
    renderLearning('/learning/versions', { me: ME_ADMIN });
    const panel = screen.getByRole('tabpanel', { name: 'Версии стратегии' });
    expect(within(panel).getByRole('button', { name: 'Оценить на наборе' })).toBeDisabled();
    expect(within(panel).getByText(/Загрузите свежий файл и заморозьте набор/)).toBeInTheDocument();
    expect(within(panel).queryByText('Ведет администратор')).toBeNull();
  });

  it('«Базовая модель» и «Отчеты» — пустые состояния; первый отчет — в понедельник по поясу участника', async () => {
    renderLearning('/learning/model');
    expect(screen.getByRole('heading', { name: 'Эло по покрытиям + калибровка' })).toBeInTheDocument();
    expect(screen.getByText(/^Версии модели, проверка по месяцам/)).toBeInTheDocument();
    // предел поправки — claude_max_shift стратегии (0,1)
    expect(await screen.findByText(/предел поправки Claude \(сейчас ±10 п\.п\.\)/)).toBeInTheDocument();
    expect(screen.getByText(/Включается сама, если не хуже/)).toBeInTheDocument();
  });

  it('«Базовая модель»: предел поправки Claude — из стратегии участника, а не из текста', async () => {
    const strategy = strategyV3();
    strategy.params.claude_max_shift = 0.075;
    renderPage(<LearningPage />, {
      path: '/learning/:tab?',
      url: '/learning/model',
      me: ME_MEMBER,
      api: api(0, { 'GET /api/strategy/active': () => json(strategy) }),
    });
    expect(await screen.findByText(/предел поправки Claude \(сейчас ±7,5 п\.п\.\)/)).toBeInTheDocument();
  });

  it('«Базовая модель»: стратегия не пришла — текст без числа', async () => {
    renderPage(<LearningPage />, {
      path: '/learning/:tab?',
      url: '/learning/model',
      me: ME_MEMBER,
      api: api(0, { 'GET /api/strategy/active': () => json({ detail: 'error' }, 500) }),
    });
    expect(await screen.findByText(/предел поправки Claude — только решением администратора/)).toBeInTheDocument();
    expect(screen.queryByText(/±10/)).toBeNull();
  });

  it('«Отчеты»: понедельник, 07:00 по времени Хельсинки, первый — 19 окт', () => {
    renderLearning('/learning/reports');
    const panel = screen.getByRole('tabpanel', { name: 'Отчеты' });
    expect(within(panel).getByText('Понедельник, 07:00 по времени Хельсинки · в центре уведомлений')).toBeInTheDocument();
    expect(within(panel).getByText(/^Отчетов пока нет\. Первый придет в понедельник 19 окт в 07:00/)).toBeInTheDocument();
  });

  it('неизвестная вкладка и «уроки» в адресе — на /learning', async () => {
    const { router } = renderLearning('/learning/lab');
    await waitFor(() => expect(router.state.location.pathname).toBe('/learning'));
    expect(screen.getByRole('tab', { name: 'Уроки' })).toHaveAttribute('aria-selected', 'true');
  });

  it('телефон: короткие подписи вкладок и плиток', () => {
    renderLearning('/learning', { width: 375 });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Уроки', 'Версии', 'Модель', 'Отчеты']);
    expect(tiles().map((tile) => tile.querySelector('.learning-tile-label')?.textContent)).toEqual(['Уроки', 'Инструкции', 'Модель', 'Отчеты']);
  });
});
