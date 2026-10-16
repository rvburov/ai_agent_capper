/* Офлайн-заглушка (#offline): страница, которую service worker показывает без связи.
   Экранов со ставками и банком не кэшируем: без сети — только сообщение и «Повторить», чтобы не показывать старые цифры.
   Страница самостоятельная (без меню и данных), в фирменном стиле, в светлой и темной темах. */
(function () {
  'use strict';
  const { h, icon, button } = UI;

  UI.css('offline', `
    .off-page { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 16px; padding: 24px var(--gutter) calc(24px + env(safe-area-inset-bottom, 0px)); background: var(--bg); }
    .off-card {
      width: min(440px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; box-shadow: var(--shadow);
      padding: 22px 22px 20px; display: flex; flex-direction: column; gap: 16px; position: relative; overflow: hidden; isolation: isolate;
    }
    .off-court { position: absolute; inset: 0 0 auto 0; height: 132px; width: 100%; z-index: -1; pointer-events: none;
      background: radial-gradient(120% 100% at 100% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 70%), var(--accent-soft); }
    .off-court svg { width: 100%; height: 100%; display: block; }
    .off-court .ln { stroke: var(--accent); stroke-opacity: .22; fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
    .off-top { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .off-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .off-ic { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--surface); color: var(--accent-ink); box-shadow: 0 0 0 6px color-mix(in srgb, var(--surface) 60%, transparent); margin-top: 18px; }
    .off-ic svg { width: 30px; height: 30px; }
    .off-card h1 { font-size: var(--fs-2xl); }
    .off-lead { color: var(--fg-2); }
    .off-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); }
    .off-list li { display: flex; gap: 8px; align-items: flex-start; }
    .off-list svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent-ink); }
    .off-status { font-size: var(--fs-sm); color: var(--fg-3); min-height: 1.5em; text-align: center; }
    .off-foot { font-size: var(--fs-xs); color: var(--fg-3); }
    .off-demo { width: min(440px, 100%); display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; padding: 10px 12px; border: 1px dashed var(--warn); border-radius: var(--r-md); background: color-mix(in srgb, var(--warn-soft) 45%, var(--surface)); font-size: var(--fs-sm); color: var(--fg-2); }
    .off-demo span:not(.demo-pill) { flex: 1 1 200px; min-width: 0; }
  `);

  function court() {
    return h('div', { class: 'off-court', 'aria-hidden': 'true' },
      h('svg', { viewBox: '0 0 400 132', preserveAspectRatio: 'none' },
        h('path', { class: 'ln', d: 'M30 10h340v112H30zM70 10v112M330 10v112M70 44h260M70 88h260M200 44v44' })));
  }

  UI.register('offline', {
    title: 'Нет связи',
    shell: false,
    render(root) {
      const status = h('div', { class: 'off-status', role: 'status', 'aria-live': 'polite' });
      let checking = false;
      const retry = button('Повторить', { kind: 'primary', size: 'lg', icon: 'refresh', block: true, onClick: () => {
        if (checking) return;
        checking = true; retry.disabled = true; status.textContent = 'Проверяем связь…';
        // В приложении — запрос к серверу; в макете связь есть всегда, поэтому возвращаемся на главную
        setTimeout(() => {
          checking = false; retry.disabled = false;
          if (navigator.onLine === false) { status.textContent = 'Связи по-прежнему нет. Попробуйте еще раз через минуту'; return; }
          status.textContent = '';
          UI.toast('Связь восстановлена', 'check');
          UI.go('dashboard');
        }, 900);
      } });
      const themeBtn = button('', { kind: 'ghost', icon: document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'sun' : 'moon', title: 'Сменить тему', onClick: () => UI.toggleTheme() });
      root.appendChild(h('div', { class: 'off-page' },
        h('main', { class: 'off-card', 'aria-labelledby': 'off-title' },
          court(),
          h('div', { class: 'off-top' },
            h('div', { class: 'off-brand' }, UI.brandMark(), h('span', { class: 'brand-name' }, 'AI Capper')),
            themeBtn),
          h('div', { class: 'off-ic', 'aria-hidden': 'true' }, icon('wifiOff')),
          h('h1', { id: 'off-title' }, 'Нет связи с интернетом'),
          h('p', { class: 'off-lead' }, 'Ставки, банк и анализы хранятся на сервере, на телефоне мы их не сохраняем. Без связи показываем эту страницу, а не старые цифры.'),
          h('ul', { class: 'off-list' },
            h('li', null, icon('check'), 'Проверьте Wi-Fi или мобильный интернет'),
            h('li', null, icon('check'), 'Выключите режим «В самолете»'),
            h('li', null, icon('check'), 'Страница обновится сама, когда связь вернется')),
          retry,
          status,
          h('p', { class: 'off-foot' }, 'Если связь пропала, когда вы сохраняли ставку или запускали анализ, проверьте их в «Ставках» и «Новом анализе» после возвращения связи.')),
        h('div', { class: 'off-demo', role: 'note' }, h('span', { class: 'demo-pill' }, 'Только в макете'), h('span', null, 'Так выглядит приложение без связи. «Повторить» вернет на главную.'))));
      // В приложении страница сама уходит назад, когда браузер сообщает, что связь вернулась
      const back = () => { window.removeEventListener('online', back); if (location.hash === '#offline') UI.go('dashboard'); };
      window.addEventListener('online', back);
    },
  });
})();
