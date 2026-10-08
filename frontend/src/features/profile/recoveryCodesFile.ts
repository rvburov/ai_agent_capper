/** Текст файла с резервными кодами: заголовок, аккаунт, дата и коды по одному в строке. */
export function recoveryCodesText(lines: {
  title: string;
  account: string;
  created: string;
  note: string;
  codes: readonly string[];
}): string {
  return [lines.title, lines.account, lines.created, '', ...lines.codes, '', lines.note, ''].join(
    '\n',
  );
}

/** Скачать текст файлом .txt (ссылка на Blob, без сервера). */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Ссылку освобождаем после того, как браузер начал скачивание
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
