/* Режим просмотра данных участника (решение Р27, 17 октября 2026; заменяет Р14).
   Администратор выбирает участника и видит его «Главную», «Ставки», «Аналитику», «Банк и стратегию» и анализы —
   так, как их видит сам участник, но только просмотр: кнопки изменения неактивны и объясняют почему.
   Сверху — плашка «Вы смотрите данные: … · только просмотр · Вернуться к своим». Каждый просмотр чужих данных —
   запись журнала администратора (действие data_view: кто, когда, чьи данные, какой экран).
   Пароли, коды 2FA, резервные коды и ключи Claude участников не видны никому — таких экранов в режиме просмотра нет.
   Данные участника в макете — его книга из DATA (DATA.useBook); в приложении — те же ответы сервера по участнику. */
(function () {
  'use strict';
  const { h, icon, button } = UI;
  const D = DATA;

  // Экраны, которые администратор видит глазами участника; остальные возвращают к своим данным
  const SCREENS = { dashboard: 'Главная', bets: 'Ставки', analytics: 'Аналитика', new: 'Анализы', analysis: 'Анализ', profile: 'Банк и стратегия' };
  const RO_HINT = 'Только просмотр: менять данные участника может только он сам';
  const KEY = 'capper.view';
  const store = {
    get() { try { return sessionStorage.getItem(KEY); } catch (e) { return null; } },
    set(v) { try { if (v) sessionStorage.setItem(KEY, v); else sessionStorage.removeItem(KEY); } catch (e) { /* хранилище недоступно — режим живет до перезагрузки */ } },
  };
  let uid = null, lastLogged = null;
  const isRealAdmin = () => !!(UI.auth && UI.auth.role === 'admin');
  const userOf = id => D.users.find(u => u.id === id);
  const adminId = () => D.personas.admin.id;
  // Чьи данные можно открыть: участники с историей ставок (у заблокированного без ставок открывать нечего)
  const people = () => D.users.filter(u => u.status !== 'deleted' && u.id !== adminId() && D.hasBook(u.id));

  // Время записи журнала: «сейчас» в макете — утро 7 октября, каждая запись на минуту позже предыдущей
  const toMin = iso => Date.parse(iso.slice(0, 16) + ':00Z') / 60000;
  const fromMin = m => new Date(m * 60000).toISOString().slice(0, 16);
  function nextAt() {
    const top = D.admin.audit.reduce((m, e) => Math.max(m, toMin(e.at)), toMin(D.today + 'T09:40'));
    return fromMin(top + 1);
  }
  function log(target, details) {
    D.admin.audit.unshift({ at: nextAt(), actor: D.personas.admin.name, action: 'data_view', target, details: details + ' · только просмотр', ip: '95.216.•.•', fresh: true });
  }
  function screenLabel(id, param) {
    if (id === 'analysis') return 'Анализ #' + (param || D.currentAnalysis || '');
    return SCREENS[id] || id;
  }

  // Общий выпадающий список «Чьи данные смотреть»: Мои данные / участники
  function picker(o) {
    o = o || {};
    const sel = h('select', { class: ['select', 'vw-select', o.cls], 'aria-label': 'Чьи данные смотреть', on: { change: e => {
      const v = e.target.value;
      if (v === 'me') UI.view.exit({ toast: true, rerender: true });
      else UI.view.open(v);
    } } },
    h('option', { value: 'me', selected: !uid }, 'Мои данные'),
    people().map(u => h('option', { value: u.id, selected: u.id === uid }, u.name + (u.status === 'blocked' ? ' · заблокирован' : ''))));
    return sel;
  }

  UI.css('view', `
    .vw-bar { position: sticky; top: var(--topbar-h); z-index: 15; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
      padding: 10px 28px; background: var(--warn-soft); color: var(--warn-ink); border-bottom: 1px solid color-mix(in srgb, var(--warn) 45%, transparent); }
    .vw-ic { width: 34px; height: 34px; border-radius: 50%; flex: none; display: grid; place-items: center; background: color-mix(in srgb, var(--warn) 22%, transparent); }
    .vw-ic svg { width: 18px; height: 18px; }
    .vw-text { flex: 1 1 260px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .vw-text b { color: var(--fg); font-weight: 600; }
    .vw-text small { font-size: var(--fs-xs); color: var(--warn-ink); }
    .vw-acts { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .vw-bar .vw-select { width: 230px; height: 40px; background: var(--surface); }
    .vw-bar .btn { background: var(--surface); }
    .vw-pick { display: inline-flex; align-items: center; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); white-space: nowrap; }
    .vw-pick svg { width: 18px; height: 18px; color: var(--fg-3); flex: none; }
    .vw-pick .vw-select { width: 190px; height: 36px; }
    .vw-row { display: flex; align-items: center; justify-content: flex-end; }
    .vw-row .vw-pick { width: 100%; }
    .vw-row .vw-select { flex: 1; width: auto; min-width: 0; height: 40px; }
    .bank-pill.vw-pill { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 45%, transparent); color: var(--warn-ink); align-items: center; }
    .bank-pill.vw-pill svg { width: 15px; height: 15px; flex: none; align-self: center; }
    .bank-pill.vw-pill b { color: var(--fg); }
    .btn.is-ro { opacity: .5; cursor: not-allowed; }
    .btn.is-ro:hover { filter: none; }
    .btn.primary.is-ro:hover { background: var(--accent); }
    .btn.secondary.is-ro:hover { background: var(--surface); }
    .btn.ghost.is-ro:hover { background: transparent; color: var(--fg-2); }
    .vw-note { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-sm); color: var(--fg-2); padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); }
    .vw-note svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--fg-3); }
    @media (max-width: 960px) {
      .vw-bar { top: 56px; padding: 8px var(--gutter); gap: 8px 10px; }
      .vw-ic { width: 30px; height: 30px; }
      .vw-text { flex-basis: calc(100% - 44px); }
      .vw-text small { display: none; }
      .vw-acts { width: 100%; flex-wrap: nowrap; }
      .vw-bar .vw-select { flex: 1; width: auto; min-width: 0; }
      .vw-bar .btn { flex: none; }
    }
  `);

  UI.view = {
    SCREENS, RO_HINT,
    get uid() { return uid; },
    get active() { return !!uid; },
    get user() { return uid ? userOf(uid) : null; },
    people,
    // Вызывается из app.js после входа: режим переживает перезагрузку вкладки (sessionStorage)
    init() {
      const saved = store.get();
      if (saved && isRealAdmin() && people().some(u => u.id === saved)) { uid = saved; D.useBook(uid); }
      else store.set(null);
    },
    // Экран открывается в режиме просмотра: «Банк и стратегия» — только вкладка bank, анализ — только участника
    allows(id, param) {
      if (id === 'profile') return param === 'bank';
      if (id === 'analysis') { const ids = (D.recentAnalyses || []).map(a => a.id); return param ? ids.includes(param) : ids.includes(D.currentAnalysis); }
      return Object.prototype.hasOwnProperty.call(SCREENS, id);
    },
    viewable: id => Object.prototype.hasOwnProperty.call(SCREENS, id) && id !== 'analysis' && id !== 'profile',
    set(id) {
      if (!isRealAdmin() || !people().some(u => u.id === id)) return false;
      uid = id; lastLogged = null;
      D.useBook(id); store.set(id);
      return true;
    },
    // Открыть данные участника: route — экран (по умолчанию тот же, анализ — список анализов участника)
    open(id, route) {
      if (!UI.view.set(id)) return;
      const cur = location.hash.slice(1);
      const base = cur.split('-')[0];
      const next = route || (base === 'analysis' ? 'new' : base === 'profile' ? 'profile-bank' : UI.view.viewable(base) ? cur.split('-')[0] : 'dashboard');
      UI.toast('Данные: ' + userOf(id).name + ' · только просмотр', 'eye');
      UI.go(next);
    },
    exit(o) {
      o = o || {};
      if (!uid) return;
      uid = null; lastLogged = null;
      D.useBook('base'); store.set(null);
      if (o.toast) UI.toast('Вы снова смотрите свои данные', 'user');
      if (o.rerender && UI.rerender) UI.rerender();
    },
    // Запись в журнал при каждом открытии экрана; перерисовка того же экрана (тема, ширина) новой записи не дает
    logView(id, param) {
      if (!uid) return;
      const label = screenLabel(id, param), key = uid + '|' + label;
      if (key === lastLogged) return;
      lastLogged = key;
      log(userOf(uid).name, label);
    },
    // Просмотр из «Администрирования» (карточка участника, «Сводка») — тоже в журнал
    logAdmin(target, label) { log(target, label); },
    // Плашка над экраном в режиме просмотра
    banner() {
      const u = userOf(uid);
      return h('div', { class: 'vw-bar', role: 'region', 'aria-label': 'Режим просмотра данных участника' },
        h('span', { class: 'vw-ic', 'aria-hidden': 'true' }, icon('eye')),
        h('div', { class: 'vw-text' },
          h('span', null, 'Вы смотрите данные: ', h('b', null, u.name), ' · только просмотр'),
          h('small', null, 'Изменить ничего нельзя. Каждый просмотр записывается в журнал администратора')),
        h('div', { class: 'vw-acts' },
          picker(),
          button(UI.isMobile() ? 'К своим' : 'Вернуться к своим', { kind: 'secondary', icon: 'user', onClick: () => UI.view.exit({ toast: true, rerender: true }), attrs: { class: 'btn secondary vw-back' } })));
    },
    // Выбор участника, пока режим выключен: в шапке на компьютере, строкой над экраном на телефоне
    picker(mobile) {
      const p = h('label', { class: 'vw-pick' }, icon('eye'), h('span', null, mobile ? 'Чьи данные смотреть' : 'Чьи данные'), picker());
      return mobile ? h('div', { class: 'vw-row' }, p) : p;
    },
    // Пояснение на экране вместо формы, которой в режиме просмотра нет
    note(text) { return h('div', { class: 'vw-note' }, icon('lock'), h('span', null, text || RO_HINT)); },
  };

  // Кнопки с ro: true (UI.button) в режиме просмотра неактивны: нажатие только объясняет почему
  document.addEventListener('click', e => {
    const el = e.target.closest && e.target.closest('[data-ro]');
    if (!el) return;
    e.preventDefault(); e.stopPropagation();
    UI.toast(el.getAttribute('data-ro') || RO_HINT, 'lock');
  }, true);
})();
