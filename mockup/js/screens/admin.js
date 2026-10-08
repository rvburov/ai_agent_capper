/* Кабинет администратора (заготовка, экран собирается). */
(function () {
  'use strict';
  UI.register('admin', { title: 'Кабинет администратора', nav: 'admin', adminOnly: true, render(root) { root.appendChild(UI.empty('Экран в работе')); } });
})();
