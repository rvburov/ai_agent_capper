// Тема до первой отрисовки: выбор пользователя из localStorage (ключ capper.theme),
// иначе — как в системе. Отдельный файл, а не встроенный скрипт: CSP разрешает только script-src 'self'.
(function () {
  try {
    var theme = window.localStorage.getItem('capper.theme');
    if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    // хранилище недоступно: тема как в системе
  }
})();
