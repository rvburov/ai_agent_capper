/** Перезагрузка страницы; отдельным модулем, чтобы тесты подменяли ее (в jsdom перехода нет). */
export function reloadPage(): void {
  window.location.reload();
}
