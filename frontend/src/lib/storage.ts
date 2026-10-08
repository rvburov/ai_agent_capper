// localStorage только для удобств одного браузера (тема). В приватном окне или при
// запрете хранилища обращение бросает исключение — тогда работаем без него.

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // хранилище недоступно: выбор живет до перезагрузки
  }
}
