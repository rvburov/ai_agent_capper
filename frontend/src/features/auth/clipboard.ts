// Копирование секрета и резервных кодов и сохранение кодов в файл.

/** Выделяет текст элемента: если буфер обмена недоступен, человек скопирует сам. */
export function selectContents(node: Node | null): void {
  if (!node) return;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  } catch {
    // без выделения
  }
}

/** true — скопировано; false — браузер не дал (http без localhost, запрет) — текст выделен. */
export async function copyText(text: string, fallbackNode?: Node | null): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ниже — выделение
  }
  selectContents(fallbackNode ?? null);
  return false;
}

/** Скачивание текстового файла: резервные коды остаются у человека, на сервере их нет. */
export function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
