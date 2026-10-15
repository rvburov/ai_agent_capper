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
    { group: 'Управление', adminOnly: true, items: [
      { id: 'admin', label: 'Администрирование', icon: 'admin', badge: () => adminAttention() },
    ] },
  ];
  // Сколько дел ждет администратора: просьбы вернуть ключ и участники у лимита
  function adminAttention() { return DATA.ai.decisions().length; }
  const TABS = [
    { id: 'dashboard', label: 'Главная', icon: 'home' },
    { id: 'bets', label: 'Ставки', icon: 'ticket' },
    { id: 'new', label: 'Анализ', icon: 'plus', primary: true },
    { id: 'analytics', label: 'Аналитика', icon: 'chart' },
    { id: 'more', label: 'Еще', icon: 'menu' },
  ];

  // ---- состояние ----
  const store = {
    get(k) { try { return sessionStorage.getItem('capper.' + k); } catch (e) { return null; } },
    set(k, v) { try { v == null ? sessionStorage.removeItem('capper.' + k) : sessionStorage.setItem('capper.' + k, v); } catch (e) { /* хранилище недоступно — работаем в памяти */ } },
  };
  // Демо-роль: администратор (владелец) или участник. ?role=member в адресе открывает макет под участником.
  const qRole = new URLSearchParams(location.search).get('role');
  const state = { authed: store.get('authed') === '1', role: qRole === 'member' || qRole === 'admin' ? qRole : store.get('role') || 'admin' };
  // Прямая ссылка на экран (#bets и т.п.) открывает его без входа — удобно для согласования макета.
  const initial = location.hash.slice(1);
  if (initial && initial !== 'login' && !state.authed) state.authed = true;

  UI.auth = {
    login(role) {
      if (role === 'admin' || role === 'member') { state.role = role; store.set('role', role); }
      state.authed = true; store.set('authed', '1'); UI.go('dashboard');
    },
    logout() { state.authed = false; store.set('authed', null); UI.go('login'); UI.toast('Вы вышли из аккаунта', 'logout'); },
    get authed() { return state.authed; },
    get role() { return state.role; },
    get isAdmin() { return state.role === 'admin'; },
    // Только для макета: посмотреть интерфейс глазами другой роли
    setRole(role) {
      if (role === state.role) return;
      state.role = role; store.set('role', role);
      render();
      UI.toast(role === 'admin' ? 'Вы смотрите макет как администратор' : 'Вы смотрите макет как участник', 'user');
    },
  };

  // ---- уведомления (центр уведомлений, решение Р3) ----
  const readState = { admin: new Set(), member: new Set() };
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  function whenShort(iso) {
    const d = iso.slice(0, 10), t = iso.slice(11, 16);
    const y = new Date(DATA.today + 'T12:00:00Z'); y.setUTCDate(y.getUTCDate() - 1);
    if (d === DATA.today) return 'Сегодня, ' + t;
    if (d === y.toISOString().slice(0, 10)) return 'Вчера, ' + t;
    return +d.slice(8, 10) + ' ' + MONTHS[+d.slice(5, 7) - 1] + ', ' + t;
  }
  // Что присылать на сайт (Личный кабинет → Уведомления): выключенные виды в центр не попадают.
  // Обязательные виды (вход с нового устройства, сообщение администратора) приходят всегда — это решает UI.notifPrefs.
  const allowed = n => !UI.notifPrefs || UI.notifPrefs.allowed(n.kind);
  UI.notifications = {
    list() {
      return (DATA.notifications[state.role] || []).filter(allowed).map(n => {
        let body = n.body, link = n.link;
        // ставка рассчитана — ссылка на саму ставку (#bets-<id>), а не на список
        if (n.kind === 'bet_settled' && n.bet && (!link || link === '#bets')) link = '#bets-' + n.bet;
        if (n.kind === 'bet_settled') {
          const b = DATA.bets.find(x => x.id === n.bet);
          body = (b.status === 'win' ? 'Выигрыш ' : b.status === 'loss' ? 'Проигрыш ' : 'Возврат ') + fmt.signedMoney(b.profit) + (b.settledBy === 'auto' ? ' по архиву tennis-data' : '') + '. Банк ' + fmt.money(b.bankAfter) + '. Разбор ИИ — в деталях ставки.';
        }
        // Еженедельный отчет (В8): суммы — в валюте программы, поэтому текст собирается при показе
        if (n.kind === 'weekly_report' && DATA.learning) {
          const r = DATA.learning.weekReport(n.week);
          body = r.n + ' ' + fmt.plural(r.n, 'ставка', 'ставки', 'ставок') + ' (' + r.auto + ' по архиву) · ' + fmt.signedMoney(r.profit) + (r.roi != null ? ', ROI ' + fmt.signedPct(r.roi) : '') + (r.clv != null ? ' · CLV ' + fmt.signedPct(r.clv) : '') + (r.brier != null ? ' · Brier ' + fmt.dec(r.brier, 3) + ' против ' + fmt.dec(r.brierMarket, 3) + ' у рынка' : '') + '.';
        }
        return Object.assign({}, n, { body, link, read: n.read || readState[state.role].has(n.id) });
      }).sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)); // сначала новые
    },
    // сколько уведомлений скрыто настройками «Что присылать»
    hidden() { return (DATA.notifications[state.role] || []).filter(n => !allowed(n)).length; },
    unread() { return this.list().filter(n => !n.read).length; },
    refresh() { updateBell(); },
    markRead(id) { readState[state.role].add(id); updateBell(); },
    markAll() { this.list().forEach(n => readState[state.role].add(n.id)); updateBell(); },
  };
  let bellBtn = null;
  function updateBell() {
    if (!bellBtn) return;
    const n = UI.notifications.unread();
    const badge = bellBtn.querySelector('.bell-badge');
    badge.textContent = n ? String(n) : '';
    badge.hidden = !n;
    bellBtn.setAttribute('aria-label', n ? 'Уведомления: непрочитанных ' + n : 'Уведомления');
  }
  function closeNotif(focusBell) {
    const pop = document.querySelector('.notif-pop'), back = document.querySelector('.notif-back');
    if (pop) pop.remove();
    if (back) back.remove();
    document.removeEventListener('pointerdown', outsideNotif, true);
    document.removeEventListener('keydown', escNotif, true);
    if (bellBtn) bellBtn.setAttribute('aria-expanded', 'false');
    if (focusBell && bellBtn) bellBtn.focus();
  }
  function outsideNotif(e) {
    const pop = document.querySelector('.notif-pop');
    if (pop && !pop.contains(e.target) && !(bellBtn && bellBtn.contains(e.target))) closeNotif(false);
  }
  function escNotif(e) { if (e.key === 'Escape') { e.stopPropagation(); closeNotif(true); } }
  function openNotif() {
    if (document.querySelector('.notif-pop')) { closeNotif(true); return; }
    UI.closeDropdown && UI.closeDropdown();
    const sheet = window.matchMedia('(max-width: 720px)').matches;
    const listEl = h('div', { class: 'notif-list', role: 'list' });
    function draw() {
      clear(listEl);
      const items = UI.notifications.list();
      if (!items.length) { listEl.appendChild(h('div', { class: 'empty' }, 'Уведомлений нет')); return; }
      items.forEach(n => {
        const go = () => { UI.notifications.markRead(n.id); closeNotif(false); if (n.link) UI.go(n.link.slice(1)); else draw(); };
        listEl.appendChild(h('button', { class: ['notif-item', n.read ? null : 'unread'], type: 'button', role: 'listitem', on: { click: go } },
          h('span', { class: ['notif-ic', n.tone] }, icon(n.icon)),
          h('span', { class: 'notif-text' },
            h('span', { class: 'notif-title' }, n.title),
            n.body ? h('span', { class: 'notif-body' }, n.body) : null,
            h('span', { class: 'notif-time' }, whenShort(n.at))),
          n.read ? null : h('span', { class: 'notif-dot', 'aria-label': 'Не прочитано' })));
      });
    }
    draw();
    const readAll = button('Прочитать все', { kind: 'ghost', size: 'sm', onClick: () => { UI.notifications.markAll(); draw(); } });
    const pop = h('div', { class: ['notif-pop', sheet ? 'sheet' : null], role: 'dialog', 'aria-label': 'Уведомления', tabindex: '-1' },
      sheet ? h('div', { class: 'dd-sheet-grip', 'aria-hidden': 'true' }) : null,
      h('div', { class: 'notif-head' }, h('div', { class: 'notif-head-title' }, 'Уведомления'), readAll),
      listEl,
      h('div', { class: 'notif-foot' },
        h('a', { href: '#profile-notifications', on: { click: () => closeNotif(false) } }, icon('sliders'), 'Что присылать'),
        h('span', { class: 'xsmall muted' }, UI.notifications.hidden() ? 'Часть видов выключена в настройках' : 'На сайте · push — на этапе 6')));
    if (sheet) document.body.appendChild(h('div', { class: 'notif-back', on: { click: () => closeNotif(true) } }));
    document.body.appendChild(pop);
    if (!sheet) {
      const r = bellBtn.getBoundingClientRect();
      pop.style.top = Math.round(r.bottom + 8) + 'px';
      pop.style.right = Math.max(12, Math.round(window.innerWidth - r.right - 8)) + 'px';
    }
    bellBtn.setAttribute('aria-expanded', 'true');
    pop.focus({ preventScroll: true });
    setTimeout(() => document.addEventListener('pointerdown', outsideNotif, true), 0);
    document.addEventListener('keydown', escNotif, true);
  }

  // ---- демо-роль ----
  function roleSwitchModal() {
    const opt = (role, title, who, text) => h('button', { class: ['role-opt', state.role === role ? 'is-current' : null], type: 'button', 'aria-pressed': state.role === role ? 'true' : 'false', on: { click: () => { closeM(); UI.auth.setRole(role); } } },
      h('span', { class: 'role-opt-ic' }, icon(role === 'admin' ? 'admin' : 'user')),
      h('span', { class: 'role-opt-text' }, h('b', null, title), h('span', { class: 'small soft' }, who), h('span', { class: 'small' }, text)),
      state.role === role ? h('span', { class: 'chip accent' }, 'сейчас') : null);
    let closeM = () => {};
    UI.modal({
      title: 'Смотреть макет как',
      body: close => { closeM = close; return h('div', { class: 'stack', style: 'gap:10px' },
        opt('admin', 'Администратор', DATA.personas.admin.name, 'Видит раздел «Администрирование»: участники, приглашения, ключ Claude, бюджет и лимиты, журнал.'),
        opt('member', 'Участник', DATA.personas.member.name, 'Свой банк и ставки, свой лимит на ИИ или свой ключ Claude. Кабинета администратора нет.'),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'В настоящем приложении роль задает администратор. Переключатель есть только в макете.')); },
    });
  }
  function roleLabel() { return state.role === 'admin' ? 'администратор' : 'участник'; }

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

  function moreSheet(navId) {
    const items = [
      { id: 'players', label: 'Игроки', icon: 'users' },
      { id: 'learning', label: 'Обучение модели', icon: 'brain' },
      { id: 'costs', label: 'ИИ и расходы', icon: 'coins' },
      { id: 'profile', label: 'Личный кабинет', icon: 'user' },
    ];
    if (state.role === 'admin') items.push({ id: 'admin', label: 'Администрирование', icon: 'admin' });
    UI.modal({
      title: 'Еще',
      body: close => h('nav', { class: 'list', 'aria-label': 'Дополнительные разделы' },
        h('div', { class: 'demo-pill', role: 'note', style: 'align-self:flex-start;margin-bottom:8px' }, 'Макет · все цифры вымышлены'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%', on: { click: () => { close(); roleSwitchModal(); } } }, icon('users'), 'Демо: смотреть как ' + (state.role === 'admin' ? 'участник' : 'администратор')),
        items.map(it => h('a', { class: 'nav-link', href: '#' + it.id, 'aria-current': navId === it.id ? 'page' : null, on: { click: close } }, icon(it.icon), it.label)),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%', on: { click: () => { close(); toggleTheme(); } } }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'), currentTheme() === 'dark' ? 'Светлая тема' : 'Темная тема'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;color:var(--bad-ink)', on: { click: () => { close(); UI.auth.logout(); } } }, icon('logout'), 'Выйти')),
    });
  }

  UI.css('app-tab-badge', '.tab-badge { position: absolute; top: 4px; left: calc(50% + 6px); min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px; background: var(--info-soft); color: var(--info-ink); font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }');
  function shell(navId) {
    const S = DATA.stats;
    const sidebar = h('aside', { class: 'sidebar', 'aria-label': 'Основная навигация' },
      h('a', { class: 'brand', href: '#dashboard' }, brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'теннисная аналитика'))),
      NAV.filter(g => !g.adminOnly || state.role === 'admin').map(g => [
        h('div', { class: 'eyebrow nav-group-label' }, g.group),
        g.items.map(it => {
          const b = it.badge && it.badge();
          return h('a', { class: 'nav-link', href: '#' + it.id, 'aria-current': navId === it.id ? 'page' : null }, icon(it.icon), it.label, b ? h('span', { class: 'chip info nav-badge' }, String(b)) : null);
        }),
      ]),
      h('div', { class: 'sidebar-foot' },
        h('a', { class: 'nav-link', href: '#profile', 'aria-current': navId === 'profile' ? 'page' : null }, icon('user'), 'Личный кабинет'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;text-align:left', on: { click: toggleTheme } }, icon(currentTheme() === 'dark' ? 'sun' : 'moon'), currentTheme() === 'dark' ? 'Светлая тема' : 'Темная тема'),
        h('button', { class: 'nav-link', type: 'button', style: 'border:0;background:none;cursor:pointer;width:100%;text-align:left', on: { click: () => UI.auth.logout() } }, icon('logout'), 'Выйти')));

    const topbar = h('header', { class: 'topbar' },
      h('a', { class: 'hide-desktop topbar-home', href: '#dashboard', 'aria-label': 'На главную', style: 'display:flex' }, brandMark()),
      h('div', { class: 'topbar-title' }),
      h('div', { class: 'topbar-actions' },
        h('button', { class: 'demo-pill demo-role hide-mobile', type: 'button', title: 'Все цифры в макете вымышлены. Нажмите, чтобы посмотреть интерфейс другой роли', on: { click: roleSwitchModal } }, 'Макет · ' + roleLabel(), icon('chevronDown')),
        h('div', { class: 'topbar-extra row' }),
        h('span', { class: 'bank-pill', title: 'Текущий банк' }, h('span', { class: 'muted hide-mobile' }, 'Банк'), h('b', null, fmt.money(S.bank))),
        button('Новый анализ', { kind: 'primary', icon: 'plus', href: '#new', attrs: { class: 'btn primary hide-mobile' } }),
        bellBtn = h('button', { class: 'btn ghost icon-only bell-btn', type: 'button', 'aria-haspopup': 'dialog', 'aria-expanded': 'false', title: 'Уведомления', on: { click: openNotif } }, icon('bell'), h('span', { class: 'bell-badge', 'aria-hidden': 'true' })),
        h('a', { class: 'avatar', href: '#profile', title: 'Личный кабинет · ' + DATA.user.name, 'aria-label': 'Личный кабинет' }, DATA.user.initials)));
    headerSlot = topbar;
    updateBell();

    const tabbar = h('nav', { class: 'tabbar', 'aria-label': 'Нижняя навигация' }, TABS.map(t => {
      if (t.id === 'more') return h('button', { class: 'tab', type: 'button', 'aria-current': ['players', 'learning', 'costs', 'profile', 'admin'].includes(navId) ? 'page' : null, on: { click: () => moreSheet(navId) } }, icon(t.icon), t.label);
      if (t.primary) return h('a', { class: 'tab tab-primary', href: '#' + t.id, 'aria-current': navId === t.id ? 'page' : null }, h('span', { class: 'tab-plus' }, icon(t.icon)), t.label);
      // счетчик открытых ставок у «Ставок» — и на телефоне (этап 5, хвост этапа 4)
      const badge = t.id === 'bets' && DATA.stats.open ? h('span', { class: 'tab-badge', 'aria-label': 'открытых ставок: ' + DATA.stats.open }, String(DATA.stats.open)) : null;
      return h('a', { class: 'tab', href: '#' + t.id, 'aria-current': navId === t.id ? 'page' : null, style: badge ? 'position:relative' : null }, icon(t.icon), t.label, badge);
    }));

    const view = h('main', { class: 'view', id: 'view', tabindex: '-1' });
    // на телефоне плашка «демо» скрыта в шапке — показываем ее над содержимым
    const demoNote = UI.isMobile() ? h('button', { class: 'demo-pill demo-role', type: 'button', style: 'align-self:flex-start;margin:10px var(--gutter) 0', on: { click: roleSwitchModal } }, 'Макет · цифры вымышлены · ' + roleLabel(), icon('chevronDown')) : null;
    const root = h('div', { class: 'shell' }, h('div', { class: 'sidebar-col' }, sidebar), h('div', { class: 'main' }, topbar, demoNote, view), tabbar);
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
    closeNotif(false);
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
    if (def.adminOnly && state.role !== 'admin') {
      // Сервер на такой запрос отвечает 403; в макете показываем, что видит участник
      view.appendChild(UI.card({ title: 'Раздел только для администратора', body: [
        h('p', { class: 'soft' }, 'Участник не видит раздел «Администрирование»: ни в меню, ни по прямой ссылке.'),
        h('div', { class: 'row' }, button('На главную', { kind: 'primary', href: '#dashboard' }), button('Демо: смотреть как администратор', { kind: 'secondary', onClick: () => UI.auth.setRole('admin') })),
      ] }));
      return;
    }
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
