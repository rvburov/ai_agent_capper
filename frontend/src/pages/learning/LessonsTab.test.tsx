import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QUICK_POLL_MS } from '../../features/learning/lessons';
import { learningSummary, lesson, lessonDictionary, lessonHistory, lessonQuick, lessonsList, quickCheck, readyLesson } from '../../features/learning/testData';
import type { Lesson, LessonsList } from '../../features/learning/types';
import { strategyV3 } from '../../test/factories';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../test/fetchMock';
import { bodyOf, renderPage } from '../../test/renderPage';
import { LearningPage } from './LearningPage';

// Вкладка «Уроки» (этап 5, волна 3): все состояния уроков у участника и администратора, фильтр,
// «Подробнее», «Сообщить, когда наберется», окно «Урок … в анализ» с быстрой проверкой (цена,
// худший случай, ход, итог, включение), отказ бюджета 409, выключение, «Предложить урок».
// Часы зафиксированы (дата следующего отчета и подписи дат зависят от «сейчас»); в сценарии
// с опросом хода проверки подменяются и таймеры.

const NOW = new Date('2026-10-15T10:00:00Z');

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const HYPOTHESIS = lesson({ id: 1, code: 'L-001', watching: false });
const READY = readyLesson({ id: 2, code: 'L-002', text: 'В полуфиналах модель завышает фаворита по Эло', created_at: '2026-10-10T09:00:00Z' });
const ON = readyLesson({
  id: 3,
  code: 'L-003',
  status: 'confirmed',
  in_prompt: true,
  decided_at: '2026-10-13T09:00:00Z',
  text: 'После 5+ сетов за двое суток модель завышает уставшего',
  quick: lessonQuick(),
  own_bets: [12, 15],
  rechecked_at: '2026-10-01T06:48:00Z',
});
const OFF = readyLesson({ id: 4, code: 'L-004', status: 'confirmed', in_prompt: false, text: 'На траве аутсайдер берет сет чаще' });
const REJECTED = lesson({
  id: 5,
  code: 'L-005',
  status: 'rejected',
  n_cases: 20,
  n_hist: 250,
  origin: 'manual',
  text: 'Аутсайдер на грунте проигрывает чаще, чем дает модель',
  history: lessonHistory({ status: 'rejected', reason: 'no_gain', log_loss_with: 0.641, log_loss_without: 0.638 }),
});
const RETIRED = lesson({
  id: 6,
  code: 'L-006',
  status: 'retired',
  n_cases: 22,
  n_hist: 300,
  retired_at: '2026-10-01T06:48:00Z',
  text: 'Фаворит после долгого отдыха',
  history: lessonHistory({ status: 'rejected', reason: 'no_gain', gain: { value: 0.001, low: -0.004, high: 0.007, n: 300 } }),
});
const ALL = [READY, ON, OFF, HYPOTHESIS, REJECTED, RETIRED];

interface Options {
  me?: typeof ME_MEMBER | typeof ME_ADMIN;
  list?: LessonsList;
  extra?: Record<string, Handler>;
  url?: string;
}

// Порядок сервера (STATUS_ORDER волны 2): гипотезы раньше подтвержденных; экран — как макет
const SERVER_ORDER = [READY, HYPOTHESIS, ON, OFF, REJECTED, RETIRED];

function renderLessons({ me = ME_MEMBER, list = lessonsList(SERVER_ORDER), extra = {}, url = '/learning' }: Options = {}) {
  return renderPage(<LearningPage />, {
    path: '/learning/:tab?',
    url,
    me,
    api: {
      // сводка экрана: в анализе 1 из 15, 1 ждет решения, 1 гипотеза (как список ниже)
      'GET /api/learning': () =>
        json(
          learningSummary({
            settled: 4,
            settled_legs: 6,
            lessons: { in_prompt: 1, max_active: 15, total: 6, hypotheses: 1, ready: 1, confirmed: 2, rejected: 1, retired: 1, ready_codes: ['L-002'], last: null },
          }),
        ),
      'GET /api/strategy/active': () => json(strategyV3()),
      'GET /api/lessons': () => json(list),
      ...extra,
    },
  });
}

const card = (code: string) => screen.getByRole('article', { name: `Урок ${code}` });

describe('«Уроки»: карточки и фильтр', () => {
  it('участник: все состояния уроков, решения — у администратора', async () => {
    renderLessons();
    expect(await screen.findByRole('article', { name: 'Урок L-002' })).toBeInTheDocument();
    // порядок макета: ждут решения, подтвержденные, гипотезы, отклоненные, списанные
    expect(screen.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual(ALL.map((item) => `Урок ${item.code}`));
    // вкладка — с числом уроков, как в макете
    expect(screen.getByRole('tab', { name: 'Уроки · 6' })).toHaveAttribute('aria-selected', 'true');
    const tabs = screen.getByRole('group', { name: 'Что учится сейчас' });
    await waitFor(() => expect(within(tabs).getAllByRole('link')[0]).toHaveTextContent('Уроки в анализе1из 151 ждет решения · 1 гипотеза'));

    // гипотеза: свои случаи из порога, пока не влияет на прогнозы
    const hyp = card('L-001');
    expect(within(hyp).getByText('Гипотеза')).toBeInTheDocument();
    expect(within(hyp).getByText('3 из 20')).toBeInTheDocument();
    expect(within(hyp).getByRole('meter', { name: 'Своих случаев' })).toHaveAttribute('aria-valuenow', '3');
    expect(within(hyp).getByText('Пока не влияет на прогнозы')).toBeInTheDocument();
    // условие из словаря словами
    const cond = within(hyp).getByRole('list', { name: 'Условие урока' });
    expect(within(cond).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'модель завышает вероятность',
      'покрытие: грунт',
      'сторона: аутсайдер',
      'кэф на победу не меньше 2.60',
    ]);
    expect(within(hyp).queryByText(/Основание/)).toBeNull();

    // ждет решения: участнику — «ждет решения администратора», кнопки нет
    const ready = card('L-002');
    expect(within(ready).getByText('Ждет решения')).toBeInTheDocument();
    expect(within(ready).getByText('Ждет решения администратора')).toBeInTheDocument();
    expect(within(ready).queryByRole('button', { name: 'Использовать в анализе' })).toBeNull();
    expect(within(ready).getByText('Подтвержден на истории 12 окт. В анализ — после быстрой проверки и решения администратора.')).toBeInTheDocument();
    expect(within(ready).getByText('21 случай + 412 из архива')).toBeInTheDocument();
    expect(within(ready).getByText('лог-лосс 0,612 с уроком, 0,634 без · выигрыш +0,022, ДИ +0,012…+0,031')).toBeInTheDocument();
    expect(within(ready).getByText('−3,0 п.п. с усадкой (сырая −5,0 п.п.)')).toBeInTheDocument();

    // подтвержден: в анализе и выключенный
    expect(within(card('L-003')).getByText('В инструкциях анализа')).toBeInTheDocument();
    expect(within(card('L-004')).getByText('Выключен администратором')).toBeInTheDocument();
    expect(within(card('L-003')).queryByRole('switch')).toBeNull();

    // отклонен и списан
    const rejected = card('L-005');
    expect(within(rejected).getByText('Отклонен')).toBeInTheDocument();
    expect(within(rejected).getByText('Предложен вручную')).toBeInTheDocument();
    expect(within(rejected).getByText(/^С уроком прогноз не лучше: лог-лосс 0,641 против 0,638 без урока/)).toBeInTheDocument();
    expect(within(card('L-006')).getByText('Списан 1 окт при ежемесячной перепроверке: на новых матчах эффект пропал (ДИ −0,004…+0,007 задевает ноль).')).toBeInTheDocument();
    // предложить урок может каждый
    expect(screen.getAllByRole('button', { name: 'Предложить урок' })).toHaveLength(2);
    expect(screen.getByText('Ведет администратор')).toBeInTheDocument();
  });

  it('фильтр по статусу: счетчики и группы, «Отклонены» — и списанные', async () => {
    const { user } = renderLessons();
    const filter = await screen.findByRole('group', { name: 'Какие уроки показать' });
    await waitFor(() =>
      expect(within(filter).getAllByRole('button').map((b) => b.textContent)).toEqual(['Все · 6', 'Подтверждены · 2', 'Ждут решения · 1', 'Гипотезы · 1', 'Отклонены · 2']),
    );
    await user.click(within(filter).getByRole('button', { name: 'Отклонены · 2' }));
    expect(screen.getAllByRole('article').map((item) => item.getAttribute('aria-label'))).toEqual(['Урок L-005', 'Урок L-006']);
    await user.click(within(filter).getByRole('button', { name: 'Подтверждены · 2' }));
    expect(screen.getAllByRole('article')).toHaveLength(2);
  });

  it('пустая группа и нет уроков', async () => {
    const { user } = renderLessons({ list: lessonsList([HYPOTHESIS]) });
    await user.click(await screen.findByRole('button', { name: 'Ждут решения · 0' }));
    expect(screen.getByText('В этой группе уроков нет')).toBeInTheDocument();
  });

  it('уроки не загрузились — ошибка и «Повторить»', async () => {
    renderLessons({ extra: { 'GET /api/lessons': () => apiError(500, 'internal', 'Сервер недоступен') } });
    expect(await screen.findByText(/Сервер недоступен/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('«Подробнее»: основание, проверка на архиве, отложенная часть, поправка с усадкой, свои ставки', async () => {
    const { user } = renderLessons();
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-003' })).getByRole('button', { name: 'Подробнее' }));
    const dialog = screen.getByRole('dialog', { name: 'Урок L-003' });
    const fact = (label: string) => within(dialog).getByText(label).nextElementSibling?.textContent;
    expect(fact('Откуда')).toMatch(/^Разборы рассчитанных ставок/);
    expect(fact('Ваши ставки в основании')).toBe('№12, №15 — видны только вам');
    expect(fact('Основание')).toBe('21 случай + 412 из архива');
    expect(fact('Ошибка модели в условии')).toBe('−5,0 п.п. (факт минус прогноз), 95% ДИ −7,1…−2,9 п.п. на 309 матчах архива');
    expect(fact('Проверка на архиве')).toBe('лог-лосс с уроком 0,612, без урока 0,634 · выигрыш +0,022, 95% ДИ +0,012…+0,031');
    expect(fact('Отложенная часть')).toBe('выигрыш +0,009, 95% ДИ +0,001…+0,018 на 103 матчах с 1 апр 2025');
    // n усадки — случаи истории архива (n_shrink), у всех одно и то же: формула сходится с числами
    expect(fact('Поправка в анализе')).toBe('−3,0 п.п. — с усадкой к нулю: −5,0 п.п. × 309 / (309 + 200)');
    expect(fact('Быстрая проверка')).toBe('не хуже: 40 матчей, разница лог-лосса −0,004 (95% ДИ −0,012…+0,005), $0,61 · 14 окт');
    expect(fact('Перепроверка')).toBe('раз в месяц, последняя 1 окт — держится');
    expect(within(dialog).getByText('В инструкциях анализа')).toBeInTheDocument();
    expect(dialog.querySelector('pre')?.textContent).toBe('модель завышает вероятность\nпокрытие: грунт\nсторона: аутсайдер\nкэф на победу не меньше 2.60');
    await user.click(within(dialog).getAllByRole('button', { name: 'Закрыть' }).at(-1)!);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('участник: меньше 5 случаев — без числа и полосы, свои случаи отдельно', async () => {
    const few = lesson({ id: 1, code: 'L-001', n_cases: null, n_cases_few: true, own_cases: 2 });
    const ready = readyLesson({ id: 2, code: 'L-002', own_cases: 3 });
    renderLessons({ list: lessonsList([few, ready]) });
    const hyp = await screen.findByRole('article', { name: 'Урок L-001' });
    expect(within(hyp).getByText('меньше 5 из 20')).toBeInTheDocument();
    expect(within(hyp).queryByRole('meter')).toBeNull();
    expect(within(hyp).getByText('из них ваших: 2')).toBeInTheDocument();
    expect(within(card('L-002')).getByText('21 случай + 412 из архива · из них ваших 3')).toBeInTheDocument();
  });

  it('урок про сбор данных — без направления поправки; выключенный — «нужна новая проверка»', async () => {
    const process = readyLesson({
      id: 7,
      code: 'L-007',
      kind: 'process',
      status: 'confirmed',
      in_prompt: true,
      scope: { direction: 'lower', conditions: [{ feature: 'round', op: 'eq', values: ['SF'] }] },
    });
    // выключение урока сбрасывает passed при тех же числах «не хуже»
    const off = { ...OFF, quick: lessonQuick({ passed: false }) };
    const { user } = renderLessons({ list: lessonsList([process, off]) });
    const item = await screen.findByRole('article', { name: 'Урок L-007' });
    expect(within(within(item).getByRole('list', { name: 'Условие урока' })).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['круг: 1/2 финала']);
    await user.click(within(item).getByRole('button', { name: 'Подробнее' }));
    expect(screen.getByRole('dialog', { name: 'Урок L-007' }).querySelector('pre')?.textContent).toBe('круг: 1/2 финала');
    await user.keyboard('{Escape}');
    await user.click(within(card('L-004')).getByRole('button', { name: 'Подробнее' }));
    const dialog = screen.getByRole('dialog', { name: 'Урок L-004' });
    expect(within(dialog).getByText('Быстрая проверка').nextElementSibling?.textContent).toBe(
      'не хуже: 40 матчей, разница лог-лосса −0,004 (95% ДИ −0,012…+0,005), $0,61 · 14 окт; урок выключали — для включения нужна новая проверка',
    );
  });

  it('гипотеза: «Сообщить, когда наберется» — запрос и метка', async () => {
    const watched: Lesson = { ...HYPOTHESIS, watching: true };
    let list = lessonsList(SERVER_ORDER);
    const { user, calls } = renderLessons({
      extra: {
        'GET /api/lessons': () => json(list),
        'POST /api/lessons/1/notify-when-ready': () => {
          list = lessonsList(SERVER_ORDER.map((item) => (item.id === 1 ? watched : item)));
          return json(watched);
        },
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-001' })).getByRole('button', { name: 'Сообщить, когда наберется' }));
    expect(await within(card('L-001')).findByText('Сообщим при 20 случаях')).toBeInTheDocument();
    expect(calls.some((request) => request.method === 'POST' && request.url.endsWith('/api/lessons/1/notify-when-ready'))).toBe(true);
    expect(await screen.findByText(/^Сообщим в центре уведомлений, когда у L-001 будет 20 случаев/)).toBeInTheDocument();
  });
});

describe('«Уроки» у администратора: быстрая проверка и включение', () => {
  it('выключить урок из анализа — запрос и сообщение', async () => {
    const disabled = { ...ON, in_prompt: false };
    const { user, calls } = renderLessons({ me: ME_ADMIN, extra: { 'POST /api/lessons/3/disable': () => json(disabled) } });
    const toggle = within(await screen.findByRole('article', { name: 'Урок L-003' })).getByRole('switch', { name: /Использовать в анализе/ });
    expect(toggle).toBeChecked();
    expect(within(card('L-003')).getByText('В инструкциях с 13 окт')).toBeInTheDocument();
    await user.click(toggle);
    expect(await screen.findByText(/^Урок L-003 выключен — следующий анализ пройдет без него/)).toBeInTheDocument();
    expect(calls.filter((request) => request.method === 'POST').map((request) => new URL(request.url).pathname)).toEqual(['/api/lessons/3/disable']);
    // администратор уроки ведет сам: метки «Ведет администратор» нет
    expect(screen.queryByText('Ведет администратор')).toBeNull();
  });

  it('в анализе уже предел уроков — окно не открывается, сообщение', async () => {
    const { user } = renderLessons({ me: ME_ADMIN, list: lessonsList(ALL, { active: 15 }) });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    expect(await screen.findByText('В анализе уже 15 уроков — сначала выключите один')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('предел в один урок — «1 урок», а не «1 уроков»', async () => {
    const { user } = renderLessons({ me: ME_ADMIN, list: lessonsList(ALL, { active: 1, max_active: 1 }) });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    expect(await screen.findByText('В анализе уже 1 урок — сначала выключите его')).toBeInTheDocument();
  });

  it('цена до запуска; запуск — 409 бюджета: текст сервера, свежий остаток', async () => {
    let previews = 0;
    const { user } = renderLessons({
      me: ME_ADMIN,
      extra: {
        'GET /api/lessons/2': () => json(READY),
        'GET /api/lessons/2/quick-check': () => {
          previews += 1;
          return json(
            previews === 1
              ? quickCheck({ lesson_id: 2, reserved_usd: 1.5, left_usd: 25.3 })
              : quickCheck({ lesson_id: 2, left_usd: 2, can_run: false, reason: 'lesson.quick_check_budget' }),
          );
        },
        'POST /api/lessons/2/quick-check': () =>
          apiError(409, 'lesson.quick_check_budget', 'Худший случай проверки больше остатка бюджета проверок на месяц', { reason: 'lesson.quick_check_budget' }),
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog', { name: 'Урок L-002 в анализ' });
    expect(await within(dialog).findByText('$3,20 из $30, в резерве $1,50 · остаток $25,30')).toBeInTheDocument();
    expect(within(dialog).getByText('≈ $0,61')).toBeInTheDocument();
    expect(within(dialog).getByText('$4,40 — 40 запросов')).toBeInTheDocument();
    expect(within(dialog).getByText('2 из 15')).toBeInTheDocument();
    expect(within(dialog).getByText(/^Быстрая проверка: 40 матчей набора с уроком, Opus 5\.5 через Batch; ответы без урока — готовые из прошлых проверок \(40\)/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Запустить проверку · ≈ $0,61' }));
    // после отказа — свежая цена и остаток: запуск недоступен, причина словами — одна плашка
    // (ошибка сервера повторяла бы ее)
    await waitFor(() => expect(within(dialog).getByRole('button', { name: /Запустить проверку/ })).toBeDisabled());
    expect(within(dialog).getByText(/^Худший случай проверки больше остатка бюджета проверок на месяц\. Поднимите бюджет/)).toBeInTheDocument();
    expect(within(dialog).getByText('$3,20 из $30 · остаток $2,00')).toBeInTheDocument();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    expect(within(dialog).getAllByText(/^Худший случай проверки больше остатка/)).toHaveLength(1);
  });

  it('409 «проверка уже идет» (запустил другой администратор) — окно показывает ход, без повтора текста', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    let current: Lesson = READY;
    let running = false;
    const { user } = renderLessons({
      me: ME_ADMIN,
      extra: {
        'GET /api/lessons/2': () => json(current),
        'GET /api/lessons/2/quick-check': () =>
          json(
            running
              ? quickCheck({ lesson_id: 2, can_run: false, reason: 'lesson.quick_check_running', eval_run_id: 8, status: 'running' })
              : quickCheck({ lesson_id: 2 }),
          ),
        'POST /api/lessons/2/quick-check': () => {
          running = true;
          current = { ...READY, quick: lessonQuick({ eval_run_id: 8, status: 'running', finished_at: null, passed: null, diff: null, cost_usd: 0 }) };
          return apiError(409, 'lesson.quick_check_running', 'Быстрая проверка этого урока уже идет.', { reason: 'lesson.quick_check_running' });
        },
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog', { name: 'Урок L-002 в анализ' });
    await user.click(await within(dialog).findByRole('button', { name: 'Запустить проверку · ≈ $0,61' }));
    expect(await within(dialog).findByText('Пакет отправлен: 40 запросов, ждем ответ Batch…')).toBeInTheDocument();
    expect(within(dialog).queryByText('Быстрая проверка этого урока уже идет.')).toBeNull();
    expect(within(dialog).queryByRole('alert')).toBeNull();
    // ход — опросом урока: пакет собран, итог в окне
    current = { ...READY, quick: lessonQuick({ eval_run_id: 8, finished_at: '2026-10-15T10:15:00Z' }) };
    await act(() => vi.advanceTimersByTimeAsync(QUICK_POLL_MS + 100));
    expect(await within(dialog).findByText('Ждет вашего решения')).toBeInTheDocument();
  });

  it('проверку запустить нельзя: причина до запуска', async () => {
    const { user } = renderLessons({
      me: ME_ADMIN,
      extra: {
        'GET /api/lessons/2': () => json(READY),
        'GET /api/lessons/2/quick-check': () => json(quickCheck({ lesson_id: 2, events: 3, can_run: false, reason: 'lesson.quick_check_no_matches' })),
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/^Для быстрой проверки мало сыгранных матчей/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /Запустить проверку/ })).toBeDisabled();
  });

  it('прошлая проверка не удалась — причина и «Запустить снова»', async () => {
    const failed = { ...READY, quick: lessonQuick({ status: 'failed', passed: null, diff: null, error: 'not_sent', cost_usd: 0 }) };
    const { user } = renderLessons({
      me: ME_ADMIN,
      list: lessonsList([failed]),
      extra: {
        'GET /api/lessons/2': () => json(failed),
        'GET /api/lessons/2/quick-check': () => json(quickCheck({ lesson_id: 2 })),
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText('Пакет не ушел в Claude — деньги не потрачены.')).toBeInTheDocument();
    expect(await within(dialog).findByRole('button', { name: 'Запустить снова · ≈ $0,61' })).toBeEnabled();
  });

  it('с уроком хуже — включить нельзя', async () => {
    const worse = { ...READY, quick: lessonQuick({ passed: false, diff: { value: 0.021, low: 0.008, high: 0.034, n: 40 }, finished_at: '2026-10-14T10:12:00Z' }) };
    const { user } = renderLessons({
      me: ME_ADMIN,
      list: lessonsList([worse]),
      extra: {
        'GET /api/lessons/2': () => json(worse),
        'GET /api/lessons/2/quick-check': () => json(quickCheck({ lesson_id: 2 })),
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog');
    expect(await within(dialog).findByText(/лог-лосс с уроком \+0,021 к без урока \(95% ДИ \+0,008…\+0,034\), ошибок формата 0 — хуже/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^С уроком прогноз хуже или есть ошибки формата/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Включить в инструкции' })).toBeNull();
  });

  it('гипотеза → готов: запуск, ход опросом, «не хуже», «Включить в инструкции»', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
    let current: Lesson = READY;
    let list = lessonsList([READY, HYPOTHESIS], { active: 2 });
    const enabled: Lesson = { ...READY, status: 'confirmed', in_prompt: true, decided_at: '2026-10-15T10:20:00Z', quick: lessonQuick({ finished_at: '2026-10-15T10:15:00Z' }) };
    const { user, calls } = renderLessons({
      me: ME_ADMIN,
      extra: {
        'GET /api/lessons': () => json(list),
        'GET /api/lessons/2': () => json(current),
        'GET /api/lessons/2/quick-check': () => json(quickCheck({ lesson_id: 2 })),
        'POST /api/lessons/2/quick-check': () => {
          current = { ...READY, quick: lessonQuick({ status: 'running', finished_at: null, passed: null, diff: null, cost_usd: 0 }) };
          return json(quickCheck({ lesson_id: 2, can_run: false, reason: 'lesson.quick_check_running', eval_run_id: 7, status: 'pending' }), 202);
        },
        'POST /api/lessons/2/enable': () => {
          list = lessonsList([enabled, HYPOTHESIS], { active: 3 });
          return json(enabled);
        },
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    const dialog = screen.getByRole('dialog', { name: 'Урок L-002 в анализ' });
    await user.click(await within(dialog).findByRole('button', { name: 'Запустить проверку · ≈ $0,61' }));
    // ход: пакет отправлен, ждем ответ
    expect(await within(dialog).findByText('Пакет отправлен: 40 запросов, ждем ответ Batch…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Закрыть, ждать итога' })).toBeInTheDocument();
    // пакет собран — следующий опрос урока показывает итог
    current = { ...READY, quick: lessonQuick({ finished_at: '2026-10-15T10:15:00Z' }) };
    await act(() => vi.advanceTimersByTimeAsync(QUICK_POLL_MS + 100));
    expect(await within(dialog).findByText('Проверено на 40 матчах · потрачено $0,61 из бюджета проверок')).toBeInTheDocument();
    expect(within(dialog).getByText('лог-лосс с уроком −0,004 к без урока (95% ДИ −0,012…+0,005), ошибок формата 0 — не хуже')).toBeInTheDocument();
    expect(within(dialog).getByText('Ждет вашего решения')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Включить в инструкции' }));
    expect(await screen.findByText('Урок L-002 в инструкциях со следующего анализа — для всех участников · уроков в анализе 3 из 15')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    // карточка: подтвержден, выключатель включен; кнопка, открывшая окно, исчезла — фокус на выключателе
    await waitFor(() => expect(within(card('L-002')).getByRole('switch', { name: /Использовать в анализе/ })).toBeChecked());
    await waitFor(() => expect(within(card('L-002')).getByRole('switch', { name: /Использовать в анализе/ })).toHaveFocus());
    expect(within(card('L-002')).getByText('Подтвержден')).toBeInTheDocument();
    expect(calls.filter((request) => request.method === 'POST').map((request) => new URL(request.url).pathname)).toEqual([
      '/api/lessons/2/quick-check',
      '/api/lessons/2/enable',
    ]);
  });

  it('прошлая проверка «не хуже» и свежее проверки на истории — сразу решение', async () => {
    const checked = { ...READY, quick: lessonQuick({ finished_at: '2026-10-14T10:12:00Z' }) };
    const { user } = renderLessons({
      me: ME_ADMIN,
      list: lessonsList([checked]),
      extra: {
        'GET /api/lessons/2': () => json(checked),
        'GET /api/lessons/2/quick-check': () => json(quickCheck({ lesson_id: 2 })),
      },
    });
    await user.click(within(await screen.findByRole('article', { name: 'Урок L-002' })).getByRole('button', { name: 'Использовать в анализе' }));
    expect(await within(screen.getByRole('dialog')).findByRole('button', { name: 'Включить в инструкции' })).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Не включать' }));
    expect(await screen.findByText('Урок L-002 остается в «Ждут решения»')).toBeInTheDocument();
  });
});

describe('«Предложить урок»', () => {
  function proposeApi(onPost: (request: Request) => Response | Promise<Response>): Record<string, Handler> {
    return {
      'GET /api/lessons/dictionary': () => json(lessonDictionary()),
      'POST /api/lessons': onPost,
    };
  }

  it('форма по словарю: условие собирается из признаков, урок — гипотеза', async () => {
    const created = lesson({ id: 9, code: 'L-009', origin: 'manual', n_cases: 0 });
    const { user, calls } = renderLessons({ list: lessonsList([HYPOTHESIS]), extra: proposeApi(() => json(created, 201)) });
    await user.click((await screen.findAllByRole('button', { name: 'Предложить урок' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Предложить урок' });
    // текст короче 10 символов — ошибка у поля, запроса нет
    await user.type(within(dialog).getByLabelText('Что вы заметили'), 'Грунт');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    expect(within(dialog).getByText(/^Опишите наблюдение хотя бы одной фразой/)).toBeInTheDocument();
    expect(calls.some((request) => request.method === 'POST')).toBe(false);
    await user.type(within(dialog).getByLabelText('Что вы заметили'), ': аутсайдер с кэфом 2.60+ берет матч чаще');
    // процессный урок предлагает только администратор — выбора типа у участника нет
    expect(within(dialog).queryByRole('group', { name: 'Тип урока' })).toBeNull();
    // в списке «Рынок» — и новые рынки (Р28), семействами
    await user.click(within(dialog).getByRole('button', { name: /^Рынок:/ }));
    expect(screen.getByRole('option', { name: 'Тотал геймов' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Фора по геймам' })).toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: 'П1 / П2' }));
    await user.click(within(dialog).getByRole('button', { name: /^Что не так с прогнозом:/ }));
    await user.click(screen.getByRole('option', { name: 'Модель занижает вероятность' }));
    await user.click(within(dialog).getByRole('button', { name: /^Покрытие:/ }));
    await user.click(screen.getByRole('option', { name: 'грунт' }));
    await user.click(within(dialog).getByRole('button', { name: /^Признак из словаря:/ }));
    await user.click(screen.getByRole('option', { name: 'Кэф стороны на победу (архив)' }));
    // число вне диапазона словаря — ошибка у поля
    await user.type(within(dialog).getByLabelText('Значение'), '500');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    expect(within(dialog).getByText('Введите число от 1.01 до 100.00')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText('Значение'));
    await user.type(within(dialog).getByLabelText('Значение'), '2,6');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    expect(await screen.findByText(/^Урок L-009 добавлен как гипотеза/)).toBeInTheDocument();
    const post = calls.find((request) => request.method === 'POST' && new URL(request.url).pathname === '/api/lessons')!;
    expect(await bodyOf(post)).toEqual({
      text: 'Грунт: аутсайдер с кэфом 2.60+ берет матч чаще',
      kind: 'numeric',
      scope: {
        direction: 'raise',
        conditions: [
          { feature: 'surface', op: 'eq', values: ['clay'] },
          { feature: 'odds', op: 'ge', value: 2.6 },
        ],
      },
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('условие не из словаря или такой урок уже есть — текст сервера в окне', async () => {
    const { user } = renderLessons({
      list: lessonsList([HYPOTHESIS]),
      extra: proposeApi(() => apiError(422, 'lesson.scope_side', 'Условие на победу в матче должно говорить о стороне')),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Предложить урок' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Предложить урок' });
    await user.type(within(dialog).getByLabelText('Что вы заметили'), 'На траве матчи до трех побед в сетах');
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Условие на победу в матче должно говорить о стороне');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('администратор: тип урока «про сбор данных» и признак-перечень', async () => {
    const { user, calls } = renderLessons({
      me: ME_ADMIN,
      list: lessonsList([]),
      extra: proposeApi(() => json(lesson({ id: 10, code: 'L-010', kind: 'process' }), 201)),
    });
    await user.click((await screen.findAllByRole('button', { name: 'Предложить урок' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Предложить урок' });
    await user.type(within(dialog).getByLabelText('Что вы заметили'), 'Перед полуфиналом проверять новости о травмах');
    await user.click(within(dialog).getByRole('button', { name: 'про сбор данных' }));
    await user.click(within(dialog).getByRole('button', { name: /^Признак из словаря:/ }));
    await user.click(screen.getByRole('option', { name: 'Фаворит или аутсайдер по Эло' }));
    // значение не выбрано — ошибка
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    expect(within(dialog).getByText('Выберите значение признака')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: /^Значение:/ }));
    await user.click(screen.getByRole('option', { name: 'фаворит' }));
    await user.click(within(dialog).getByRole('button', { name: 'Добавить как гипотезу' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((request) => request.method === 'POST')!;
    expect(await bodyOf(post)).toMatchObject({ kind: 'process', scope: { direction: 'lower', conditions: [{ feature: 'role', op: 'eq', values: ['favorite'] }] } });
  });
});
