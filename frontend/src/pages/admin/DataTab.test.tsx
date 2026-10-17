import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import { adminAttention } from '../../features/dashboard/testData';
import { adminUser, auditEntry, dataUpload, dataUploads, uploadReport } from '../../features/admin/testData';
import { auditDetails } from '../../features/admin/audit';
import type { DataUpload } from '../../features/admin/dataUploads';
import { fixClock } from '../../test/clock';
import { apiError, json, ME_ADMIN, type Handler } from '../../test/fetchMock';
import { renderPage } from '../../test/renderPage';
import { AdminPage } from './AdminPage';

// «Администрирование → Данные» (admin.js макета, #admin-data, этап 5, В1): статус архива,
// загрузка 2026.xlsx (тело — файл, ?filename=), ход по опросу, ошибки 413/422, отчет, история.

fixClock('2026-10-13T12:00:00Z');

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function adminApi(over: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'GET /api/admin/users': () => json([adminUser({ id: 1, display_name: 'Роман Буров', email: 'owner@example.com', role: 'admin', limit: null })]),
    'GET /api/admin/invites': () => json([]),
    'GET /api/admin/attention': () => json(adminAttention({ archive: null, return_requests: [], limits: [] })),
    'GET /api/admin/data/uploads': () => json(dataUploads()),
    ...over,
  };
}

function renderData(api: Record<string, Handler> = adminApi()) {
  return renderPage(<AdminPage />, { path: '/admin/:tab?', url: '/admin/data', me: ME_ADMIN, api });
}

function xlsxFile(name = '2026.xlsx', size = 2_000): File {
  return new File([new Uint8Array(size).fill(80)], name, { type: XLSX });
}

async function uploadCard(): Promise<HTMLElement> {
  const title = await screen.findByRole('heading', { name: 'Результаты матчей: файл tennis-data' });
  return title.closest('section') as HTMLElement;
}

describe('Администрирование → Данные', () => {
  it('вкладка в разделе; статус архива: матчи по, когда и кто загрузил, следующая загрузка', async () => {
    renderData();
    expect(await screen.findByRole('tab', { name: 'Данные' })).toHaveAttribute('aria-selected', 'true');
    const card = await uploadCard();
    expect(await within(card).findByText('Загружен 12 окт')).toBeInTheDocument();
    expect(within(card).getByText('по 11 окт')).toBeInTheDocument();
    expect(within(card).getByText(/^файл загружен 12 окт, \d\d:14$/)).toBeInTheDocument();
    expect(within(card).getByText('Роман Буров')).toBeInTheDocument();
    expect(within(card).getByText('пн 19 окт')).toBeInTheDocument();
    expect(within(card).getByText(/2026\.xlsx\. Программе сайт файл не отдает \(403\)/)).toBeInTheDocument();
    expect(within(card).getByText(/Только \.xlsx до 10 МБ/)).toBeInTheDocument();
    expect(within(card).getByText('Выбрать файл .xlsx')).toBeInTheDocument();
  });

  it('следующая загрузка — день с сервера, браузер его не считает: понедельник после загрузки прошел — ближайший', async () => {
    // загрузка во вторник 6 окт, сегодня вторник 13 окт: понедельник 12 окт прошел, сервер говорит 19 окт
    renderData(adminApi({ 'GET /api/admin/data/uploads': () => json(dataUploads([dataUpload()], { last_load: '2026-10-06T08:14:00Z', next_upload: '2026-10-19' })) }));
    const card = await uploadCard();
    expect(await within(card).findByText('пн 19 окт')).toBeInTheDocument();
    expect(within(card).queryByText('пн 12 окт')).toBeNull();
  });

  it('архив устарел — «Пора загрузить», следующая загрузка — сейчас; файла не было — «Еще не загружали»', async () => {
    renderData(adminApi({ 'GET /api/admin/data/uploads': () => json(dataUploads([dataUpload()], { stale: true })) }));
    const card = await uploadCard();
    expect(await within(card).findByText('Пора загрузить')).toBeInTheDocument();
    expect(within(card).getByText('сейчас')).toBeInTheDocument();
  });

  it('файла еще не было: пустой отчет и история', async () => {
    renderData(adminApi({ 'GET /api/admin/data/uploads': () => json(dataUploads([], { last_load: null, matches_to: null, stale: true })) }));
    const card = await uploadCard();
    expect(await within(card).findByText('Еще не загружали')).toBeInTheDocument();
    expect(within(card).getByText('файл еще не загружали')).toBeInTheDocument();
    expect(screen.getByText('Загрузок еще не было — отчет появится после первого файла.')).toBeInTheDocument();
    expect(screen.getByText('Файл еще не загружали.')).toBeInTheDocument();
  });

  it('отчет загрузки: числа без сумм и имен участников, непривязанные с причиной, «нет в архиве» — числом', async () => {
    renderData();
    const title = await screen.findByRole('heading', { name: /^Отчет загрузки 12 окт, \d\d:14$/ });
    const report = title.closest('section') as HTMLElement;
    expect(within(report).getByText('2026.xlsx · 1,9 МБ · 2 712 строк в файле')).toBeInTheDocument();
    expect(within(report).getByText('Новых матчей').nextElementSibling).toHaveTextContent('71по 11 окт');
    expect(within(report).getByText('Рассчитано ставок').nextElementSibling).toHaveTextContent('9у 3 участников, 14 событий');
    expect(within(report).getByText('Закрытие из архива').nextElementSibling).toHaveTextContent('11событий П1/П2 · у фор — вносят сами');
    expect(within(report).getByText('Привязано матчей').nextElementSibling).toHaveTextContent('14ждет следующего файла: 1');
    expect(within(report).getByText('Не привязано матчей: 3')).toBeInTheDocument();
    expect(within(report).getByText('Синнер — Руне · 9 окт')).toBeInTheDocument();
    expect(within(report).getByText(/^В архиве несколько похожих матчей/)).toBeInTheDocument();
    expect(within(report).getByText(/^Матч в архиве расходится с введенным/)).toBeInTheDocument();
    expect(within(report).getByText(/^Нет в архиве: 1 —/)).toBeInTheDocument();
    expect(within(report).getByText('Расхождений с ручным расчетом: 1.')).toBeInTheDocument();
    expect(within(report).getByText('Исход вносит участник: 2.')).toBeInTheDocument();
    expect(within(report).getByText(/Сами ставки и суммы участников — в «Сводке» и в карточке участника, только просмотр/)).toBeInTheDocument();
    // Р14: ни сумм, ни валюты
    expect(report.textContent).not.toMatch(/₽|\$/);
  });

  it('история загрузок: новые сверху, ошибка — с текстом', async () => {
    const failed = dataUpload({ id: 13, created_at: '2026-10-13T08:00:00Z', status: 'failed', report: null, error: 'Файл не подходит: нет строки заголовков' });
    renderData(adminApi({ 'GET /api/admin/data/uploads': () => json(dataUploads([failed, dataUpload()])) }));
    const title = await screen.findByRole('heading', { name: 'История загрузок' });
    const card = title.closest('section') as HTMLElement;
    expect(within(card).getByText('Последние 2 · полный список — в журнале')).toBeInTheDocument();
    expect(within(card).getByText('Ошибка')).toBeInTheDocument();
    expect(within(card).getByText('2026.xlsx · Файл не подходит: нет строки заголовков')).toBeInTheDocument();
    expect(within(card).getByText('2026.xlsx · матчи по 11 окт · новых 71 · рассчитано ставок 9 · не привязано 3')).toBeInTheDocument();
  });

  it('одна загрузка, маленький файл, ни одной рассчитанной ставки: склонение, КБ и «ставок не рассчитано»', async () => {
    const small = dataUpload({ size_bytes: 5_781, report: uploadReport({ new_matches: 4, settled_bets: 0, people: 0, legs: 0, unlinked: 0, unlinked_matches: [], not_found: 0 }) });
    renderData(adminApi({ 'GET /api/admin/data/uploads': () => json(dataUploads([small])) }));
    const history = (await screen.findByRole('heading', { name: 'История загрузок' })).closest('section') as HTMLElement;
    expect(within(history).getByText('Последняя загрузка · полный список — в журнале')).toBeInTheDocument();
    expect(within(history).getByText('6 КБ')).toBeInTheDocument();
    expect(within(history).getByText('2026.xlsx · матчи по 11 окт · новых 4 · ставок не рассчитано')).toBeInTheDocument();
    const report = (await screen.findByRole('heading', { name: /^Отчет загрузки/ })).closest('section') as HTMLElement;
    expect(within(report).getByText(/^2026\.xlsx · 6 КБ · /)).toBeInTheDocument();
    expect(report.textContent).not.toMatch(/0,0 МБ|у 0 участников/);
    expect(within(report).getByText('Рассчитано ставок').nextElementSibling).toHaveTextContent(/^0$/);
  });

  it('загрузка без рассчитанных ставок — «ставок не рассчитано» в итоге и в сообщении', async () => {
    const created = dataUpload({ id: 16, status: 'queued', report: null, finished_at: null });
    const done = dataUpload({ id: 16, report: uploadReport({ new_matches: 4, settled_bets: 0, people: 0, legs: 0 }) });
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => json(created, 202),
        'GET /api/admin/data/uploads/16': () => json(done),
      }),
    );
    const card = await uploadCard();
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    expect(await within(card).findByText('4 новых матча, ставок не рассчитано. Отчет — ниже.', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(await screen.findByText('Файл загружен: 4 новых матча, ставок не рассчитано')).toBeInTheDocument();
  });

  it('загрузка: тело — файл, имя — в ?filename=; ход по шагам опросом; итог и отчет', async () => {
    let polls = 0;
    let finished = false;
    const created = dataUpload({ id: 13, created_at: '2026-10-13T11:59:00Z', status: 'queued', step: null, started_at: null, finished_at: null, report: null });
    const done = dataUpload({ ...created, status: 'done', finished_at: '2026-10-13T12:01:00Z', report: uploadReport({ new_matches: 5, settled_bets: 3, people: 2, unlinked: 0, not_found: 0, unlinked_matches: [] }) });
    const { user, calls } = renderData(
      adminApi({
        'GET /api/admin/data/uploads': () => json(dataUploads(finished ? [done, dataUpload()] : [dataUpload()])),
        'POST /api/admin/data/tennis-data': () => json(created, 202),
        'GET /api/admin/data/uploads/13': () => {
          polls += 1;
          if (polls === 1) return json({ ...created, status: 'running', step: 'elo', started_at: '2026-10-13T11:59:30Z' });
          finished = true;
          return json(done);
        },
      }),
    );
    const card = await uploadCard();
    await within(card).findByText('Загружен 12 окт');
    const file = xlsxFile('2026.xlsx', 3_000);
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), file);

    const post = calls.find((r) => r.method === 'POST');
    expect(post).toBeDefined();
    expect(new URL((post as Request).url).searchParams.get('filename')).toBe('2026.xlsx');
    expect((post as Request).headers.get('Content-Type')).toBe('application/octet-stream');
    expect((post as Request).headers.get('X-CSRF-Token')).toBeTruthy();
    expect((await (post as Request).clone().arrayBuffer()).byteLength).toBe(3_000);

    // ход: шаги воркера, текущий — «Пересчитываем Эло»
    const steps = await within(card).findByRole('list', { name: 'Ход обработки файла' }, { timeout: 4_000 });
    await waitFor(() => expect(within(steps).getByText('Пересчитываем Эло').parentElement).toHaveClass('run'), { timeout: 4_000 });
    expect(within(steps).getByText('Сопоставляем игроков').parentElement).toHaveClass('done');
    expect(within(steps).getByText(/^Привязываем матчи из анализов/).parentElement).toHaveClass('wait');
    expect(within(card).getByText('Файл обрабатывается…')).toBeInTheDocument();

    expect(await within(card).findByText('Файл загружен.', {}, { timeout: 5_000 })).toBeInTheDocument();
    expect(within(card).getByText(/5 новых матчей, рассчитано 3 ставки у 2 участников/)).toBeInTheDocument();
    expect(await screen.findByText('Файл загружен: 5 новых матчей, рассчитано 3 ставки')).toBeInTheDocument();
    // отчет и история — новая загрузка
    expect(await screen.findByRole('heading', { name: /^Отчет загрузки 13 окт/ })).toBeInTheDocument();
    expect(within(card).getByText('Выбрать файл .xlsx')).toBeInTheDocument();
  }, 15_000);

  it('тот же файл: «новых матчей нет — tennis-data еще не обновил файл»', async () => {
    const created = dataUpload({ id: 14, status: 'queued', report: null, finished_at: null });
    const same = dataUpload({ id: 14, report: uploadReport({ unchanged: true, new_matches: 0, settled_bets: 0, people: 0 }) });
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => json(created, 202),
        'GET /api/admin/data/uploads/14': () => json(same),
      }),
    );
    const card = await uploadCard();
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    expect(await within(card).findByText('Новых матчей нет.', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(within(card).getByText(/В файле матчи по 11 окт — tennis-data еще не обновил его/)).toBeInTheDocument();
  });

  it('новых матчей нет, но ставка рассчиталась по матчу из архива — не «ставки и банк не менялись»', async () => {
    const created = dataUpload({ id: 17, status: 'queued', report: null, finished_at: null });
    const done = dataUpload({ id: 17, report: uploadReport({ new_matches: 0, settled_bets: 1, people: 1, legs: 2 }) });
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => json(created, 202),
        'GET /api/admin/data/uploads/17': () => json(done),
      }),
    );
    const card = await uploadCard();
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    expect(await within(card).findByText('Файл загружен.', {}, { timeout: 4_000 })).toBeInTheDocument();
    expect(within(card).getByText(/0 новых матчей, рассчитано 1 ставка у 1 участника/)).toBeInTheDocument();
    expect(within(card).queryByText(/Ставки и банк не менялись/)).toBeNull();
  });

  it('обработка не удалась — текст ошибки воркера', async () => {
    const created = dataUpload({ id: 15, status: 'queued', report: null });
    const failed = dataUpload({ id: 15, status: 'failed', report: null, error: 'Обработка файла прервалась: воркер перезапустился' });
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => json(created, 202),
        'GET /api/admin/data/uploads/15': () => json(failed),
      }),
    );
    const card = await uploadCard();
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    const alert = await within(card).findByRole('alert', {}, { timeout: 4_000 });
    expect(alert).toHaveTextContent('Файл не обработан. Обработка файла прервалась: воркер перезапустился');
  });

  it('413 от прокси (не JSON) — понятный текст про размер, а не «неизвестная ошибка»', async () => {
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => new Response('<html><body>413 Request Entity Too Large</body></html>', { status: 413, headers: { 'Content-Type': 'text/html' } }),
      }),
    );
    const card = await uploadCard();
    await within(card).findByText('Загружен 12 окт');
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    expect(await within(card).findByRole('alert')).toHaveTextContent('Файл больше 10 МБ. Нужен файл года с tennis-data.co.uk, например 2026.xlsx (около 2 МБ)');
  });

  it('422 — текст сервера', async () => {
    const { user } = renderData(
      adminApi({
        'POST /api/admin/data/tennis-data': () => apiError(422, 'upload.bad_file', 'Файл не подходит: это страница сайта, а не таблица'),
      }),
    );
    const card = await uploadCard();
    await user.upload(within(card).getByLabelText('Выбрать файл .xlsx'), xlsxFile());
    expect(await within(card).findByRole('alert')).toHaveTextContent('Файл не подходит: это страница сайта, а не таблица');
  });

  it('не .xlsx и больше предела — сразу, без отправки', async () => {
    const { calls } = renderData();
    const user = userEvent.setup({ applyAccept: false });
    const card = await uploadCard();
    await within(card).findByText('Загружен 12 окт');
    const input = within(card).getByLabelText('Выбрать файл .xlsx');
    await user.upload(input, new File(['a,b'], '2026.csv', { type: 'text/csv' }));
    expect(await within(card).findByRole('alert')).toHaveTextContent('Нужен файл .xlsx с tennis-data.co.uk, например 2026.xlsx');
    await user.upload(input, xlsxFile('2026.xlsx', 10 * 1024 * 1024 + 1));
    await waitFor(() => expect(within(card).getByRole('alert')).toHaveTextContent('Файл больше 10 МБ'));
    expect(calls.some((r) => r.method === 'POST')).toBe(false);
  });

  it('загрузка идет (страницу открыли заново) — ход виден без новой отправки', async () => {
    const running: DataUpload = dataUpload({ id: 16, status: 'running', step: 'tennis_data', report: null, finished_at: null });
    renderData(
      adminApi({
        'GET /api/admin/data/uploads': () => json(dataUploads([running, dataUpload()])),
        'GET /api/admin/data/uploads/16': () => json(running),
      }),
    );
    const card = await uploadCard();
    const steps = await within(card).findByRole('list', { name: 'Ход обработки файла' });
    expect(within(steps).getByText(/^Читаем файл/).parentElement).toHaveClass('run');
  });

  it('журнал: у загрузки файла — имя и размер', () => {
    const entry = auditEntry({ action: 'data_upload', details: { upload_id: 3, filename: '2026.xlsx', size_bytes: 1_992_294, year: 2026 } });
    expect(auditDetails(entry)).toBe('2026.xlsx, 1,9 МБ');
  });

  it('ошибка списка — «Повторить»', async () => {
    let fail = true;
    const { user } = renderData(adminApi({ 'GET /api/admin/data/uploads': () => (fail ? apiError(500, 'internal', 'Сбой сервера') : json(dataUploads())) }));
    expect(await screen.findByText(/Сбой сервера/)).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Повторить' }));
    expect(await uploadCard()).toBeInTheDocument();
  });
});
