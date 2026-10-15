import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { learningSummary, lessonsList } from '../../features/learning/testData';
import type { LearningSummary } from '../../features/learning/types';
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

function api(summary: Partial<LearningSummary> = {}, extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/learning': () => json(learningSummary(summary)),
    'GET /api/strategy/active': () => json(strategyV3()),
    'GET /api/lessons': () => json(lessonsList()),
    ...extra,
  };
}

function renderLearning(url = '/learning', options: { me?: typeof ME_MEMBER | typeof ME_ADMIN; summary?: Partial<LearningSummary>; width?: number } = {}) {
  return renderPage(<LearningPage />, {
    path: '/learning/:tab?',
    url,
    me: options.me ?? ME_MEMBER,
    api: api(options.summary ?? {}),
    stubs: { '/profile/:tab?': 'Личный кабинет' },
    ...(options.width ? { width: options.width } : {}),
  });
}

const tiles = () => within(screen.getByRole('group', { name: 'Что учится сейчас' })).getAllByRole('link');

describe('Обучение модели: каркас и пустые состояния', () => {
  it('шапка, четыре плитки, цикл из шести шагов, вкладка «Уроки» — пусто', async () => {
    renderLearning();
    expect(screen.getByRole('heading', { level: 2, name: 'Как модель учится на ставках' })).toBeInTheDocument();
    expect(await screen.findByText(/^Рассчитанных ставок пока нет/)).toBeInTheDocument();

    const [lessons, versions, model, report] = tiles();
    expect(tiles()).toHaveLength(4);
    // уроки в анализе, предел, версия, отчет — сводка сервера (GET /api/learning)
    await waitFor(() => expect(lessons).toHaveTextContent('Уроки в анализе0из 15гипотез пока нет'));
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
    expect(await within(cycle).findByText(/^С 20 своих случаев/)).toBeInTheDocument();
    // пороги и цены — из настроек сервера
    expect(within(cycle).getByText('Быстрая проверка на 40 матчах (≈ $0,60) и решение. Раз в месяц — перепроверка')).toBeInTheDocument();
    expect(screen.getByText(/после 300 событий с исходами/)).toBeInTheDocument();

    const tablist = screen.getByRole('tablist', { name: 'Разделы обучения' });
    expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Уроки', 'Версии стратегии', 'Базовая модель', 'Отчеты']);
    expect(within(tablist).getByRole('tab', { name: 'Уроки' })).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Уроки' });
    expect(await within(panel).findByText(/^Уроков пока нет\. .* с 20 своих случаев/)).toBeInTheDocument();
    expect(within(panel).getByText('Общие для всех участников, ведет администратор. В анализ попадают только подтвержденные — не больше 15, сейчас 0.')).toBeInTheDocument();
    // участник уроки не ведет
    expect(within(panel).getByText('Ведет администратор')).toBeInTheDocument();
    const filter = within(panel).getByRole('group', { name: 'Какие уроки показать' });
    expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual(['Все · 0', 'Подтверждены · 0', 'Ждут решения · 0', 'Гипотезы · 0', 'Отклонены · 0']);
    // заглушки этапа больше нет
    expect(screen.queryByText(/появится на этапе/i)).toBeNull();
  });

  it('рассчитанные ставки — сколько, событий, сколько по архиву; плитки модели, кандидата и отчета', async () => {
    renderLearning('/learning', {
      summary: {
        settled: 12,
        settled_auto: 9,
        settled_legs: 21,
        lessons: { in_prompt: 2, max_active: 15, total: 6, hypotheses: 3, ready: 1, confirmed: 2, rejected: 0, retired: 0, ready_codes: ['L-004'], last: null },
        versions: {
          ...learningSummary().versions,
          candidate: { id: 2, code: 'v4', name: 'v4', status: 'candidate', activated_at: null, checked: true, passed: true, rule: 'non_inferior' },
        },
        model: { id: 'cal-2026-10-12', brier: 0.2114, log_loss: 0.61, activated_at: '2026-10-12T06:00:00Z', auto: true, recalibrated_at: '2026-10-12T06:00:00Z' },
        last_report: '2026-10-05',
      },
    });
    expect(
      await screen.findByText(/^Рассчитано ставок приложения: 12 \(21 событие\), из них по архиву tennis-data — 9, остальные — вами\./),
    ).toBeInTheDocument();
    const [lessons, versions, model, report] = tiles();
    expect(lessons).toHaveTextContent('Уроки в анализе2из 151 ждет решения · 3 гипотезы');
    expect(versions).toHaveTextContent('Инструкции анализаv3активнакандидат v4 ждет решения');
    expect(model).toHaveTextContent('Базовая модель0,211Brierперекалибрована сама 12 окт');
    expect(report).toHaveTextContent('Отчет недели5 октследующий — пн 19 окт, 07:00');
  });

  it('плитка модели: «перекалибрована сама» — только у версии перекалибровки; elo-v1 — «включена»', async () => {
    renderLearning('/learning', {
      summary: {
        // перекалибровок еще не было: «сама» не пишем, даже если сервер пометил auto
        model: { id: 'elo-v1', brier: 0.2114, log_loss: 0.61, activated_at: '2026-10-12T06:00:00Z', auto: true, recalibrated_at: null },
      },
    });
    await waitFor(() => expect(tiles()[2]).toHaveTextContent('Базовая модель0,211Brierвключена 12 окт'));
  });

  it('плитка модели: перекалибровка позже, но не лучше — ее дата рядом', async () => {
    renderLearning('/learning', {
      summary: {
        model: { id: 'elo-v1', brier: 0.2114, log_loss: 0.61, activated_at: '2026-10-05T06:00:00Z', auto: false, recalibrated_at: '2026-10-12T06:00:00Z' },
      },
    });
    await waitFor(() => expect(tiles()[2]).toHaveTextContent('включена 5 окт · перекалибровка 12 окт не лучше'));
  });

  it('итоги не загрузились — шапка без чисел', async () => {
    renderPage(<LearningPage />, {
      path: '/learning/:tab?',
      url: '/learning',
      api: api({}, { 'GET /api/learning': () => json({ error: { code: 'x', message: 'x' } }, 500) }),
    });
    expect(await screen.findByText(/^Каждая рассчитанная ставка получает разбор ИИ/)).toBeInTheDocument();
    // пороги и цены не пришли — тексты без чисел
    expect(screen.getByText('Sonnet 5.5 · Batch')).toBeInTheDocument();
    expect(screen.getByText(/^С порога своих случаев/)).toBeInTheDocument();
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
      api: api({}, { 'GET /api/strategy/active': () => json(strategy) }),
    });
    expect(await screen.findByText(/предел поправки Claude \(сейчас ±7,5 п\.п\.\)/)).toBeInTheDocument();
  });

  it('«Базовая модель»: стратегия не пришла — текст без числа', async () => {
    renderPage(<LearningPage />, {
      path: '/learning/:tab?',
      url: '/learning/model',
      me: ME_MEMBER,
      api: api({}, { 'GET /api/strategy/active': () => json({ detail: 'error' }, 500) }),
    });
    expect(await screen.findByText(/предел поправки Claude — только решением администратора/)).toBeInTheDocument();
    expect(screen.queryByText(/±10/)).toBeNull();
  });

  it('«Отчеты»: понедельник, 07:00 по времени Хельсинки, первый — день с сервера', async () => {
    renderLearning('/learning/reports', { summary: { next_report: '2026-10-26' } });
    const panel = screen.getByRole('tabpanel', { name: 'Отчеты' });
    expect(within(panel).getByText('Понедельник, 07:00 по времени Хельсинки · в центре уведомлений')).toBeInTheDocument();
    expect(await within(panel).findByText(/^Отчетов пока нет\. Первый придет в понедельник 26 окт в 07:00/)).toBeInTheDocument();
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
