/* Оболочка макета: навигация (боковая на десктопе, нижняя на телефоне), роутер по #hash, вход, тема. */
(function () {
  'use strict';
  const { h, icon, clear, fmt, button } = UI;

  const NAV = [
    { group: 'Работа', items: [
      { id: 'dashboard', label: 'Главная', icon: 'home' },
      { id: 'new', label: 'Новый анализ', icon: 'plus' },
      { id: 'bets', label: 'Ставки', icon: 'ticket', badge: () => DATA.stats.open },
      { id: 'players', label: 'Игроки', icon: 'users' },
    ] },
    { group: 'Модель', items: [
      { id: 'analytics', label: 'Аналитика', icon: 'chart' },
      { id: 'learning', label: 'Обучение модели', icon: 'brain' },
      { id: 'costs', label: 'ИИ и расходы', icon: 'coins' },
    ] },
  ];
  const TABS = [
    { id: 'dashboard', label: 'Главная', icon: 'home' },
    { id: 'bets', label: 'Ставки', icon: 'ticket' },
    { id: 'new', label: 'Анализ', icon: 'plus', primary: true },
    { id: 'analytics', label: 'Аналитика', icon: 'chart' },
    { id: 'more', label: 'Ещё', icon: 'menu' },
  ];

  // ---- состояние ----
  const store = {
    get(k) { try { return sessionStorage.getItem('capper.' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem('capper.' + k) : sessionStorage.setItem('capper.' + k, v); } catch (e) { /* хранилище недоступно — работаем в памяти */ } },
  };
  const state = { authed: store.get('authed') === '1' };
  // Прямая ссылка на экран (#bets и т.п.) открывает его без входа — удобно для согласования макета.
  const initial = location.hash.slice(1);
  if (initial && initial !== 'login' && !state.authed) state.authed = true;

  UI.auth = {
    login() { state.authed = true; store.set('authed', '1'); UI.go('dashboard'); },
    logout() { state.authed = false; store.set('authed', null); UI.go('login'); UI.toast('Вы вышли из аккаунта', 'logout'); },
    get authed() { return state.authed; },
  };

  // ---- тема ----
  function currentTheme() { return document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  function toggleTheme() {
    const next = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('capper.theme', next); } catch (e) { /* ок */ }
    render();
  }
  try { const t = localStorage.getItem('capper.theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) { /* ок */ }
  UI.toggleTheme = toggleTheme;

  // ---- бренд ----
  function brandMark() {
    // Корт сверху: линии одиночной разметки + мяч
    return h('svg', { class: 'brand-mark', viewBox: '0 0 36 36', 'aria-hidden': 'true' },
      h('rect', { x: 1, y: 1, width: 34, height: 34, rx: 9, fill: 'var(--accent)' }),
      h('path', { d: 'M9 7v22M27 7v22M9 13h18M9 23h18M18 13v10', stroke: 'var(--accent-fg)', 'stroke-width': 1.6, fill: 'none', opacity: '.85' }),
      h('circle', { cx: 23.5, cy: 18, r: 3.2, fill: '#e6f05a', stroke: 'var(--accent)', 'stroke-width': 1 }));
  }
  UI.brandMark = brandMark;

  // ---- шапка экрана ----
  let headerSlot = null;
  // Экран может переопределить заголовок/действия: UI.setHeader({title, crumbs, actions:[nodes]})
  UI.setHeader = function (o) {
    if (!headerSlot) return;
    const t = headerSlot.querySelector('.topbar-title');
    clear(t);
    if (o.crumbs) t.appendChild(h('div', { class: 'crumbs' }, o.crumbs));
    t.appendChild(h('h1', null, o.title));
    const extra = headerSlot.querySelector('.topbar-extra');
    clear(extra);
    if (o.actions) UI.append(extra, [o.actions]);
  };

  function moreSheet() {
    const items = [
      { id: 'players', label: 'Игроки', icon: 'users' },
      { id: 'learning', label: 'Обучение модели', icon: 'brain' },
      { id: 'costs', label: 'ИИ и расходы', icon: 'coins' },
      { id: 'profile', label: 'Личный кабинет', icon: 'user' },
    ];
    UI.modal({
      title: 'Ещё',
      body: close => h('nav', { class: 'list', 'aria-label': 'Дополнительные разделы' },
        items.map(it => h('a', { class: 'nav-link', href: '#' + it.id, on: { click: close } }, icon(it.icon), it.label)),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%', on: { click: () => { close(); toggleTheme(); } } }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'), currentTheme() === 'dark' ? 'Светлая тема' : 'Тёмная тема'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;color:var(--bad-ink)', on: { click: () => { close(); UI.auth.logout(); } } }, icon('logout'), 'Выйти')),
    });
  }

  function shell(navId) {
    const S = DATA.stats;
    const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Основная навигация' },
      h('a', { class: 'brand', href: '#dashboard' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'теннисная аналитика'))),
      NAV.map(g => [
        h('div', { class: 'eyebrow nav-group-label' }, g.group),
        g.items.map(it => {
          const b = it.badge && it.badge();
          return h('a', { class: 'nav-link', href: '#' + it.id, 'aria-current': navId === it.id ? 'page' : null }, icon(it.icon), it.label, b ? h('span', { class: 'chip info nav-badge' }, String(b)) : null);
        }),
      ]),
      h('div', { class: 'sidebar-foot' },
        h('a', { class: 'nav-link', href: '#profile', 'aria-current': navId === 'profile' ? 'page' : null }, icon('user'), 'Личный кабинет'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;text-align:left', on: { click: toggleTheme } }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'), currentTheme() === 'dark' ? 'Светлая тема' : 'Тёмная тема'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;text-align:left', on: { click: () => UI.auth.logout() } }, icon('logout'), 'Выйти')));

    const topbar = h('header', { class: 'topbar' },
      h('a', { class: 'hide-desktop', href: '#dashboard', 'aria-label': 'На главную', style: 'display:flex' }, brandMark()),
      h('div', { class: 'topbar-title' }),
      h('div', { class: 'topbar-actions' },
        h('span', { class: 'demo-pill hide-mobile', title: 'Все цифры в макете вымышлены' }, 'Макет · демо-данные'),
        h('div', { class: 'topbar-extra row' }),
        h('span', { class: 'bank-pill', title: 'Текущий банк' }, h('span', { class: 'muted hide-mobile' }, 'Банк'), h('b', null, fmt.money(S.bank))),
        button('Новый анализ', { kind: 'primary', icon: 'plus', href: '#new', attrs: { class: 'btn primary hide-mobile' } }),
        h('a', { class: 'avatar', href: '#profile', title: 'Личный кабинет', 'aria-label': 'Личный кабинет' }, DATA.user.initials)));
    headerSlot = topbar;

    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Нижняя навигация' }, TABS.map(t => {
      if (t.id === 'more') return h('button', { class: 'tab', type: 'button', 'aria-current': ['players', 'learning', 'costs', 'profile'].includes(navId) ? 'page' : null, on: { click: moreSheet } }, icon(t.icon), t.label);
      if (t.primary) return h('a', { class: 'tab tab-primary', href: '#' + t.id, 'aria-current': navId === t.id ? 'page' : null }, h('span', { class: 'tab-plus' }, icon(t.icon)), t.label);
      return h('a', { class: 'tab', href: '#' + t.id, 'aria-current': navId === t.id ? 'page' : null }, icon(t.icon), t.label);
    }));

    const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
    const root = h('div', { class: 'shell' }, h('div', { class: 'sidebar-col' }, sidebar), h('div', { class: 'main' }, topbar, view), tabbar);
    return { root, view };
  }

  function parse() {
    const raw = location.hash.slice(1);
    const fallback = state.authed ? 'dashboard' : 'login';
    if (!raw) return { id: fallback, param: null };
    const dash = raw.indexOf('-');
    const id = dash > 0 ? raw.slice(0, dash) : raw;
    const param = dash > 0 ? raw.slice(dash + 1) : null;
    return { id: UI.screens[id] ? id : fallback, param };
  }

  function render() {
    UI.hideTip();
    document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
    const app = document.getElementById('app');
    let { id, param } = parse();
    if (!state.authed && id !== 'login') id = 'login';
    const def = UI.screens[id];
    clear(app);
    if (!def) { app.appendChild(h('div', { class: 'empty' }, 'Экран не найден')); return; }
    document.title = (def.title ? def.title + ' · ' : '') + 'AI Capper';
    if (def.shell === false) {
      headerSlot = null;
      const holder = h('div', { style: 'min-height:100%' });
      app.appendChild(holder);
      def.render(holder, param);
      return;
    }
    const { root, view } = shell(def.nav || id);
    app.appendChild(root);
    UI.setHeader({ title: def.title, crumbs: def.crumbs });
    try { def.render(view, param); }
    catch (err) { console.error(err); view.appendChild(UI.callout('bad', 'alert', 'Ошибка отрисовки экрана: ' + err.message)); }
    window.scrollTo(0, 0);
  }
  UI.rerender = render;

  window.addEventListener('hashchange', render);
  let lastMobile = UI.isMobile();
  window.addEventListener('resize', () => { const m = UI.isMobile(); if (m !== lastMobile) { lastMobile = m; render(); } });
  render();
})();
