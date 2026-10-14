import { describe, expect, it } from 'vitest';

import { attachmentName } from './api';

describe('экспорт данных', () => {
  it('имя файла — из Content-Disposition, иначе запасное', () => {
    expect(attachmentName('attachment; filename="capper-export-2026-10-14.zip"', 'x.zip')).toBe('capper-export-2026-10-14.zip');
    expect(attachmentName('attachment; filename=capper-export-2026-10-14.json', 'x.json')).toBe('capper-export-2026-10-14.json');
    expect(attachmentName(null, 'capper-export.json')).toBe('capper-export.json');
    // путь или чужие символы в имени — запасное имя
    expect(attachmentName('attachment; filename="../../etc/passwd"', 'capper-export.zip')).toBe('capper-export.zip');
  });
});
