// Страница «Нет связи» (offline.html, ее собирает npm run build): «Повторить» проверяет связь
// с сервером и возвращает в приложение; когда браузер сообщает, что связь вернулась, — сама.
// Отдельный файл, а не встроенный скрипт: CSP разрешает только script-src 'self'. Тексты — в
// data-атрибутах кнопки (из ru.json при сборке).
(function () {
  var button = document.getElementById('off-retry');
  var status = document.getElementById('off-status');
  var checking = false;

  function backToApp() {
    window.location.replace('/');
  }

  function retry() {
    if (checking || !button || !status) return;
    checking = true;
    button.disabled = true;
    status.textContent = button.getAttribute('data-checking') || '';
    fetch('/api/health', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error(String(response.status));
        backToApp();
      })
      .catch(function () {
        status.textContent = button.getAttribute('data-still') || '';
      })
      .then(function () {
        checking = false;
        button.disabled = false;
      });
  }

  if (button) button.addEventListener('click', retry);
  window.addEventListener('online', backToApp);
})();
