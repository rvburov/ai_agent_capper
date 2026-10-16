import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { learningSummary, lessonsList, mlModel, mlVersion, strategyVersions, weeklyBrief, weeklyReport, weeklyReports } from '../../features/learning/testData';
import { strategyV3 } from '../../test/factories';
import { apiError, json, ME_ADMIN, ME_MEMBER, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { LearningPage } from './LearningPage';

// Вкладки «Базовая модель» (mlPanel макета, В6) и «Отчеты» (reportsPanel, В8): числа модели,
// проверка по месяцам, калибровка, версии с «Вернуть» и «Перекалибровать»; отчет недели —
// последний крупно, прошлые списком и окном, отчет из ссылки уведомления, пустая неделя,
// общее у администратора. Часы зафиксированы.

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function render(url: string, { admin = false, api = {}, width }: { admin?: boolean; api?: Record<string, Handler>; width?: number } = {}) {
  return renderPage(<LearningPage />, {
    path: '/learning/:tab?',
    url,
    me: admin ? ME_ADMIN : ME_MEMBER,
    ...(width ? { width } : {}),
    api: {
      'GET /api/learning': () => json(learningSummary()),
      'GET /api/lessons': () => json(lessonsList()),
      'GET /api/strategy/active': () => json(strategyV3()),
      'GET /api/strategy/versions': () => json(strategyVersions()),
      'GET /api/ml/model': () => json(mlModel()),
      'GET /api/learning/reports': () => json(weeklyReports()),
      'GET /api/learning/reports/7': () => json(weeklyReport()),
      'GET /api/learning/reports/6': () => json(weeklyReport({ id: 6, week_start: '2026-09-28', week_end: '2026-10-04', empty: true, bets: { ...weeklyReport().bets, settled: 0, auto: 0, manual: 0, placed: 0, open: 0, profit: '0', roi: null } })),
      ...api,
    },
    stubs: { '/profile/:tab?': 'Личный кабинет' },
  });
}

describe('«Базовая модель»', () => {
  it('участник: полоса чисел активной версии, проверка по месяцам, калибровка, версии без «Вернуть»', async () => {
    render('/learning/model');
    const strip = (await screen.findByText('Активная версия')).closest('dl')!;
    expect(strip).toHaveTextContent('Активная версия12 окт, 09:12перекалибрована и включена сама');
    expect(strip).toHaveTextContent('Brier на проверке0,1942прежняя 0,1951');
    expect(strip).toHaveTextContent('Калибровка, ECE2,1%');
    expect(strip).toHaveTextContent('Перекалибровкапо понедельникамследующая — 19 окт');
    expect(strip).toHaveTextContent('Поправка Claude числом21 из 300');
    expect(screen.getByText('Активна elo-v1@2026-10-12')).toBeInTheDocument();
    expect(screen.getByText('Ведет администратор')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Перекалибровать' })).toBeNull();
    // допуски перекалибровки — с сервера (rule)
    expect(screen.getByText(/Brier не хуже прежнего \+0,005 и лог-лосс не хуже \+0,01/)).toBeInTheDocument();
    const wf = screen.getByRole('heading', { name: 'Проверка по месяцам' }).closest('section')!;
    // месяц посреди фразы — со строчной, разница — со знаком
    expect(within(wf).getByText(/Разница модели с рынком: \+0,014 \(апрель 2026\) → \+0,005 \(сентябрь 2026\); при 380–520 матчах/)).toBeInTheDocument();
    // ось графика — месяц в именительном падеже («май», а не «мая» из дат)
    expect(within(wf).getByText('май')).toBeInTheDocument();
    expect(within(wf).queryByText('мая')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Калибровка модели' })).toBeInTheDocument();
    const versions = screen.getByRole('heading', { name: 'Версии модели' }).closest('section')!;
    expect(within(versions).getByText('elo-v1@2026-09-28').parentElement).toHaveTextContent('Brier 0,2013 · лог-лосс 0,586 · на отложенных матчах Brier хуже прежней больше допуска — не включена');
    expect(within(versions).getByText('Не включена')).toBeInTheDocument();
    expect(within(versions).queryByRole('button', { name: /^Вернуть/ })).toBeNull();
    // выгрузка для учебного трека — только администратору
    expect(screen.queryByRole('heading', { name: 'Набор для учебного трека' })).toBeNull();
  });

  it('администратор: «Вернуть» прежнюю версию и «Перекалибровать» — решение сервера словами', async () => {
    let recal = 0;
    const { user } = render('/learning/model', {
      admin: true,
      api: {
        // id версии с «@» — в адресе закодирован
        'POST /api/admin/ml/models/elo-v1%402026-10-05/rollback': () => json(mlModel()),
        'POST /api/admin/ml/recalibrate': () => {
          recal += 1;
          return recal === 1
            ? json({ decision: 'rejected', reason: 'ml.worse_brier', version: mlVersion({ status: 'rejected', reason: 'ml.worse_brier' }) })
            : json({ decision: 'activated', reason: null, version: mlVersion({ id: 'elo-v1@2026-10-15', brier: 0.1939, prev_brier: 0.1942 }) });
        },
      },
    });
    const versions = (await screen.findByRole('heading', { name: 'Версии модели' })).closest('section')!;
    // у каждой «Вернуть» — имя с версией: кнопки различимы для чтения с экрана
    await user.click(within(versions).getByRole('button', { name: 'Вернуть elo-v1@2026-10-05' }));
    expect(await screen.findByText('Вернули модель elo-v1@2026-10-05 · Brier 0,1951')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Перекалибровать' }));
    expect(await screen.findByText('Перекалибровка не включена: на отложенных матчах Brier хуже прежней больше допуска — не включена')).toBeInTheDocument();
    // кнопка была недоступна, пока шел запрос: фокус вернулся на нее
    await waitFor(() => expect(screen.getByRole('button', { name: 'Перекалибровать' })).toHaveFocus());
    await user.click(screen.getByRole('button', { name: 'Перекалибровать' }));
    expect(await screen.findByText('Перекалибрована: Brier 0,1939 (было 0,1942) — не хуже, включена. Вернуть прежнюю — в списке версий')).toBeInTheDocument();
  });

  it('администратор: «Выгрузить JSONL» — файл с сервера скачивается; у участника карточки нет', async () => {
    const files: Blob[] = [];
    const urls = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
    URL.createObjectURL = (blob: Blob) => {
      files.push(blob);
      return 'blob:snapshots';
    };
    URL.revokeObjectURL = () => undefined;
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      const { user } = render('/learning/model', {
        admin: true,
        api: {
          'GET /api/admin/ml/export.jsonl': () =>
            new Response('{"match_id": 1}\n', { status: 200, headers: { 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="snapshots.jsonl"' } }),
        },
      });
      const card = (await screen.findByRole('heading', { name: 'Набор для учебного трека' })).closest('section')!;
      await user.click(within(card).getByRole('button', { name: 'Выгрузить JSONL' }));
      expect(await screen.findByText('Файл snapshots.jsonl скачан')).toBeInTheDocument();
      expect(await files[0]?.text()).toBe('{"match_id": 1}\n');
    } finally {
      Object.assign(URL, { createObjectURL: urls.create, revokeObjectURL: urls.revoke });
      click.mockRestore();
    }
  });

  it('модели еще нет — пустое состояние; модель не загрузилась — текст ошибки', async () => {
    render('/learning/model', { api: { 'GET /api/ml/model': () => apiError(500, 'common.internal', 'Сбой сервера') } });
    expect(await screen.findByText(/^Сбой сервера/)).toBeInTheDocument();
    expect(screen.getByText(/^Версий модели еще нет/)).toBeInTheDocument();
  });
});

describe('«Отчеты»', () => {
  it('последний отчет недели — сетка чисел; прошлые недели списком, окно отчета', async () => {
    const { user, router } = render('/learning/reports');
    const last = (await screen.findByRole('heading', { name: 'Неделя 5–11 окт' })).closest('section')!;
    expect(within(last).getByText('Последний отчет')).toBeInTheDocument();
    expect(within(last).getByText('Пришел 12 окт, 07:00 по времени Хельсинки · следующий — пн 19 окт, 07:00')).toBeInTheDocument();
    const grid = await within(last).findByText('Рассчитано ставок');
    const cells = grid.closest('dl')!;
    expect(cells).toHaveTextContent('Рассчитано ставок64 по архиву, 2 вами');
    expect(cells).toHaveTextContent(/Прибыль ставок\+1\s240 ₽ROI \+13,8%/);
    expect(cells).toHaveTextContent('Средний CLV+2,1%5 ставок с закрытием, в плюсе 4');
    expect(cells).toHaveTextContent('Brier: модель / рынок0,198 против 0,20313 событий · на неделе это шум');
    expect(cells).toHaveTextContent('Разборы ИИ6по матчам, $0,06 · ждут 1');
    expect(cells).toHaveTextContent('Новые гипотезыL-021подтверждены: нет · включены: L-004 · в анализе 3');
    expect(cells).toHaveTextContent('Проверки (eval)$0,61за месяц $4,20 из $30');
    expect(cells).toHaveTextContent('Калибровкапрогноз 71%, сбылось 69%');
    expect(within(last).getByText('Базовая модель elo-v1@2026-10-05 · Brier 0,194 — перекалибрована 5 окт и включена.')).toBeInTheDocument();
    // у участника общего по программе нет (Р14)
    expect(within(last).queryByText(/Общее по программе/)).toBeNull();

    const older = screen.getByRole('heading', { name: 'Прошлые недели' }).closest('section')!;
    const row = within(older).getByRole('button', { name: /28 сен – 4 окт/ });
    expect(row).toHaveTextContent('4 ставки · ROI −9,0% · CLV −0,4%−560 ₽');
    await user.click(row);
    await waitFor(() => expect(router.state.location.search).toBe('?report=6'));
    const dialog = await screen.findByRole('dialog', { name: 'Отчет: 28 сен – 4 окт' });
    expect(await within(dialog).findByText('Ставок на неделе не было — ниже расход и состояние модели.')).toBeInTheDocument();
    await user.click(within(dialog).getAllByRole('button', { name: 'Закрыть' }).at(-1)!);
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await user.click(within(last).getByRole('link', { name: 'Настроить' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/profile/notifications'));
  });

  it('ссылка из уведомления (?report=6) открывает отчет той недели; чужой — текст сервера', async () => {
    render('/learning/reports?report=6');
    expect(await screen.findByRole('dialog', { name: 'Отчет: 28 сен – 4 окт' })).toBeInTheDocument();
  });

  it('чужой или удаленный отчет из ссылки — понятное сообщение; после закрытия фокус на вкладке', async () => {
    const { user, router } = render('/learning/reports?report=99', { api: { 'GET /api/learning/reports/99': () => apiError(404, 'common.not_found', 'Не найдено') } });
    const dialog = await screen.findByRole('dialog', { name: 'Отчет недели' });
    expect(await within(dialog).findByText('Отчет по ссылке не найден: он чужой или удален. Ваши отчеты — на этой вкладке.')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await waitFor(() => expect(document.activeElement).toHaveClass('learning-panel'));
  });

  it('отчет из ссылки уведомления: после Esc фокус — на строке этой недели в «Прошлых неделях»', async () => {
    const { user } = render('/learning/reports?report=6');
    await screen.findByRole('dialog', { name: 'Отчет: 28 сен – 4 окт' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.getByRole('button', { name: /28 сен – 4 окт/ })).toHaveFocus());
  });

  it('рассчитанных ставок нет, но есть поставленные и ждущие результата — так и написано', async () => {
    render('/learning/reports?report=5', {
      api: { 'GET /api/learning/reports/5': () => json(weeklyReport({ id: 5, empty: true, bets: { ...weeklyReport().bets, settled: 0, auto: 0, manual: 0, placed: 3, open: 2, profit: '0', roi: null } })) },
    });
    const dialog = await screen.findByRole('dialog', { name: /^Отчет: / });
    expect(await within(dialog).findByText('Рассчитанных ставок на неделе не было: поставлено 3, ждут результата 2. Ниже — расход и состояние модели.')).toBeInTheDocument();
  });

  it('неверный номер отчета в ссылке (422 или не число) — то же «не найден»', async () => {
    const first = render('/learning/reports?report=12', { api: { 'GET /api/learning/reports/12': () => apiError(422, 'common.validation', 'Проверьте данные') } });
    const dialog = await screen.findByRole('dialog', { name: 'Отчет недели' });
    expect(await within(dialog).findByText(/^Отчет по ссылке не найден/)).toBeInTheDocument();
    first.unmount();
    render('/learning/reports?report=abc');
    const again = await screen.findByRole('dialog', { name: 'Отчет недели' });
    expect(within(again).getByText(/^Отчет по ссылке не найден/)).toBeInTheDocument();
  });

  it('администратор: общее по программе — без ставок и сумм участников', async () => {
    render('/learning/reports', {
      admin: true,
      api: {
        'GET /api/learning/reports': () => json(weeklyReports({ items: [weeklyBrief()] })),
        'GET /api/learning/reports/7': () => json(weeklyReport({ shared: { members: 3, settled: 14, auto: 11, reviews: 12, reviews_usd: 0.13, analyses: 40, ai_usd: 12.4 } })),
      },
    });
    const shared = (await screen.findByText('Общее по программе — без ставок и сумм участников')).parentElement!;
    expect(shared).toHaveTextContent('Участников со ставками3');
    expect(shared).toHaveTextContent('Рассчитано ставок1411 по архиву');
    expect(shared).toHaveTextContent('Расход ключа администратора$12,4040 анализов, без проверок');
    expect(screen.queryByRole('heading', { name: 'Прошлые недели' })).toBeNull();
  });

  it('отчеты не загрузились — текст ошибки и «Повторить»', async () => {
    render('/learning/reports', { api: { 'GET /api/learning/reports': () => apiError(500, 'common.internal', 'Сбой сервера') } });
    expect(await screen.findByText(/^Сбой сервера/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Повторить' })).toBeInTheDocument();
  });

  it('375 px: сетка отчета и список недель помещаются', async () => {
    render('/learning/reports', { width: 375 });
    expect(await screen.findByRole('heading', { name: 'Неделя 5–11 окт' })).toBeInTheDocument();
    expect(await screen.findByText('Рассчитано ставок')).toBeInTheDocument();
  });
});
