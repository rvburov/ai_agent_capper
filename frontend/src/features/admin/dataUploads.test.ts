import { describe, expect, it } from 'vitest';

import { ApiError } from '../../api/errors';
import { fileProblem, isActive, isTooLarge, latestReport, stepStates } from './dataUploads';
import { dataUpload, uploadReport } from './testData';

describe('загрузка файла tennis-data', () => {
  it('файл проверяется до отправки: расширение, пустой, больше предела', () => {
    expect(fileProblem({ name: '2026.xlsx', size: 2_000_000 }, 10)).toBeNull();
    expect(fileProblem({ name: 'tennis-data (1).XLSX', size: 1 }, 10)).toBeNull();
    expect(fileProblem({ name: '2026.csv', size: 10 }, 10)).toBe('not_xlsx');
    expect(fileProblem({ name: '2026.xlsx', size: 0 }, 10)).toBe('empty');
    expect(fileProblem({ name: '2026.xlsx', size: 10 * 1024 * 1024 }, 10)).toBeNull();
    expect(fileProblem({ name: '2026.xlsx', size: 10 * 1024 * 1024 + 1 }, 10)).toBe('too_large');
  });

  it('шаги: по текущему шагу, пока идет; по отчету, когда закончилась', () => {
    expect(stepStates({ status: 'queued', step: null, report: null })).toEqual({ tennis_data: 'wait', players_link: 'wait', elo: 'wait', settle: 'wait' });
    expect(stepStates({ status: 'running', step: 'elo', report: null })).toEqual({ tennis_data: 'done', players_link: 'done', elo: 'run', settle: 'wait' });
    const report = uploadReport({
      steps: [
        { step: 'tennis_data', status: 'ok', error: null },
        { step: 'players_link', status: 'skipped', error: null },
        { step: 'elo', status: 'ok', error: null },
        { step: 'settle', status: 'failed', error: 'сбой' },
      ],
    });
    expect(stepStates({ status: 'done', step: null, report })).toEqual({ tennis_data: 'done', players_link: 'skipped', elo: 'done', settle: 'failed' });
  });

  it('отчет — последней законченной загрузки; идущая и упавшая пропускаются', () => {
    const running = dataUpload({ id: 3, status: 'running', report: null });
    const failed = dataUpload({ id: 2, status: 'failed', report: null });
    const done = dataUpload({ id: 1 });
    expect(latestReport([running, failed, done])?.id).toBe(1);
    expect(latestReport([running])).toBeNull();
    expect(isActive(running)).toBe(true);
    expect(isActive(done)).toBe(false);
  });

  it('413 — «файл больше предела», в том числе не JSON от прокси', () => {
    expect(isTooLarge(new ApiError(413, 'unknown', 'Неизвестная ошибка'))).toBe(true);
    expect(isTooLarge(new ApiError(422, 'upload.bad_file', 'Файл не подходит'))).toBe(false);
  });
});
