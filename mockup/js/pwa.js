/* PWA и push-уведомления: значок приложения, установка на телефон и компьютер, имитация системных окон браузера,
   вид push на экране блокировки и состояние push на этом устройстве (Р3).
   Общий модуль (window.UI.pwa): им пользуются «Личный кабинет» (Профиль и Уведомления), меню «Еще» и боковая панель
   (установка), «Администрирование → Сообщение» (число участников с push) и экран #offline.
   «Это устройство» в макете зависит от ширины окна: на телефоне — телефон демо-пользователя, на компьютере — его ноутбук.
   Устройства с push лежат в DATA.users[].pushDevices (как push_subscriptions): их видит и кабинет администратора. */
(function () {
  'use strict';
  const { h, icon, button, chip } = UI;
  const D = DATA, TODAY = DATA.today;

  UI.css('pwa', `
    /* значок приложения не меняется с темой: это картинка на экране «Домой» */
    :root { --app-icon-bg: #14684a; --app-icon-fg: #ffffff; --app-icon-ball: #e6f05a; }
    .pwa-icon { display: block; flex: none; }

    /* «Только в макете»: переключатели состояний, которых в приложении нет */
    .pwa-demo { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 12px; border: 1px dashed var(--warn); border-radius: var(--r-md); background: color-mix(in srgb, var(--warn-soft) 45%, var(--surface)); min-width: 0; }
    .pwa-demo .field { flex: 1 1 220px; min-width: 0; margin: 0; }
    .pwa-demo .field-label { font-size: var(--fs-xs); }
    .pwa-demo .demo-pill { align-self: flex-start; }
    @media (max-width: 720px) { .pwa-demo { flex-direction: column; align-items: stretch; } .pwa-demo .field { flex: none; } }

    /* push на экране блокировки */
    .pwa-lock {
      margin: 0; width: 100%; max-width: 340px; align-self: center; border-radius: 28px; padding: 18px 10px 14px;
      border: 1px solid var(--line-strong); color: var(--fg); display: flex; flex-direction: column; gap: 8px;
      background:
        radial-gradient(90% 60% at 15% 0%, color-mix(in srgb, var(--accent) 34%, transparent), transparent 70%),
        radial-gradient(80% 60% at 100% 100%, color-mix(in srgb, var(--s7) 26%, transparent), transparent 70%),
        var(--surface-2);
    }
    .pwa-lock-time { font-family: var(--font-display); font-weight: 600; font-size: 2.75rem; line-height: 1; text-align: center; letter-spacing: -.02em; }
    .pwa-lock-date { text-align: center; font-size: var(--fs-sm); color: var(--fg-2); margin-bottom: 6px; }
    .pwa-lock-list { display: flex; flex-direction: column; gap: 6px; }
    .pwa-push {
      display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 10px; align-items: start; padding: 10px 12px; border-radius: 16px;
      background: color-mix(in srgb, var(--surface) 80%, transparent); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
      box-shadow: 0 1px 2px rgba(0,0,0,.08); min-width: 0; text-align: left;
    }
    .pwa-push.solo { background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow); }
    .pwa-push .pwa-icon { width: 34px; height: 34px; }
    .pwa-push-text { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .pwa-push-top { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--fg-3); }
    .pwa-push-app { text-transform: uppercase; letter-spacing: .05em; font-weight: 600; color: var(--fg-2); }
    .pwa-push-title { font-weight: 600; font-size: var(--fs-sm); line-height: 1.3; overflow-wrap: anywhere; }
    .pwa-push-body { font-size: var(--fs-sm); color: var(--fg-2); line-height: 1.35; overflow-wrap: anywhere; }

    /* тестовый push: баннер сверху экрана, как присылает телефон */
    .pwa-banner {
      position: fixed; z-index: 130; left: 50%; top: calc(10px + env(safe-area-inset-top, 0px)); transform: translateX(-50%);
      width: min(380px, calc(100vw - 24px)); border: 0; padding: 0; background: none; cursor: pointer; font: inherit; color: inherit;
      animation: pwa-drop .25s ease-out;
    }
    .pwa-banner .pwa-push { background: var(--surface); border: 1px solid var(--line); box-shadow: var(--dd-shadow); }
    @keyframes pwa-drop { from { transform: translate(-50%, -24px); opacity: 0; } }

    /* системные окна браузера (в макете — имитация) */
    .pwa-sys-back { position: fixed; inset: 0; z-index: 120; background: var(--overlay); display: grid; place-items: center; padding: 16px; animation: fade .15s ease-out; }
    .pwa-sys {
      width: min(340px, 100%); background: var(--surface); color: var(--fg); border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--dd-shadow);
      padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 8px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    .pwa-sys:focus { outline: none; }
    .pwa-sys .demo-pill { align-self: flex-start; }
    .pwa-sys-head { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .pwa-sys-head .pwa-icon { width: 44px; height: 44px; }
    .pwa-sys-origin { font-size: var(--fs-xs); color: var(--fg-3); overflow-wrap: anywhere; }
    .pwa-sys-title { font-weight: 600; font-size: 1rem; line-height: 1.3; }
    .pwa-sys-text { font-size: .875rem; color: var(--fg-2); line-height: 1.4; }
    .pwa-sys-text svg { width: 16px; height: 16px; vertical-align: -3px; margin-right: 4px; }
    .pwa-sys-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
    .pwa-sys-btn { min-height: 40px; padding: 0 16px; border-radius: 20px; border: 0; background: none; color: var(--focus); font: inherit; font-weight: 600; cursor: pointer; }
    .pwa-sys-btn:hover { background: var(--surface-2); }
    .pwa-sys-btn.primary { background: var(--focus); color: var(--surface); }
    .pwa-sys.ios { width: min(280px, 100%); padding: 16px 0 0; text-align: center; gap: 6px; }
    .pwa-sys.ios .demo-pill { align-self: center; }
    .pwa-sys.ios .pwa-sys-title, .pwa-sys.ios .pwa-sys-text { padding: 0 16px; }
    .pwa-sys.ios .pwa-sys-acts { gap: 0; margin: 8px 0 0; border-top: 1px solid var(--line); }
    .pwa-sys.ios .pwa-sys-btn { flex: 1; border-radius: 0; min-height: 46px; background: none; color: var(--focus); font-weight: 500; }
    .pwa-sys.ios .pwa-sys-btn + .pwa-sys-btn { border-left: 1px solid var(--line); }
    .pwa-sys.ios .pwa-sys-btn.primary { font-weight: 700; }

    /* окно установки */
    .pwa-app { display: flex; align-items: center; gap: 14px; min-width: 0; }
    .pwa-app .pwa-icon { width: 56px; height: 56px; }
    .pwa-app-name { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-lg); }
    .pwa-pros { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); }
    .pwa-pros li { display: flex; gap: 8px; align-items: flex-start; }
    .pwa-pros svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent-ink); }
    .pwa-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; counter-reset: pwa; }
    .pwa-steps li { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 10px; align-items: start; counter-increment: pwa; font-size: var(--fs-sm); }
    .pwa-steps li::before { content: counter(pwa); width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; font-size: var(--fs-xs); }
    .pwa-steps li > div { padding-top: 4px; min-width: 0; }
    .pwa-key { display: inline-flex; align-items: center; gap: 4px; padding: 1px 7px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface-2); font-weight: 600; white-space: nowrap; }
    .pwa-key svg { width: 14px; height: 14px; }
    .pwa-install-card .profile-item-ic, .pwa-install-card .pwa-icon { width: 40px; height: 40px; }
    .pwa-foot { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; width: 100%; }
    .pwa-foot .btn { white-space: normal; height: auto; min-height: 40px; padding-block: 8px; text-align: center; }
    .pwa-links { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--fs-sm); }
    @media (max-width: 960px) { .pwa-links a { display: inline-flex; align-items: center; min-height: 40px; } }
  `);

  // ---------- значок приложения ----------
  // Тот же корт с мячом, что в шапке. Файлы для манифеста — mockup/icons/*.svg (обычный и maskable).
  function appIcon(size) {
    return h('svg', { class: 'pwa-icon', viewBox: '0 0 48 48', width: size || 48, height: size || 48, 'aria-hidden': 'true' },
      h('rect', { width: 48, height: 48, rx: 11, fill: 'var(--app-icon-bg)' }),
      h('path', { d: 'M12 9.5v29M36 9.5v29M12 17.5h24M12 30.5h24M24 17.5v13', stroke: 'var(--app-icon-fg)', 'stroke-width': 2.1, fill: 'none', 'stroke-linecap': 'round', opacity: '.88' }),
      h('circle', { cx: 31.3, cy: 24, r: 4.3, fill: 'var(--app-icon-ball)', stroke: 'var(--app-icon-bg)', 'stroke-width': 1.3 }));
  }

  // ---------- это устройство и состояние push ----------
  const DEVICES = {
    u1: { phone: { key: 'iphone', os: 'ios', name: 'iPhone 15 · Safari', appName: 'iPhone 15 · приложение AI Capper', ic: 'device' },
          desk: { key: 'mac', os: 'desktop', name: 'MacBook Air · Chrome', ic: 'laptop' } },
    u2: { phone: { key: 'pixel', os: 'android', name: 'Pixel 8 · Chrome', ic: 'device' },
          desk: { key: 'win', os: 'desktop', name: 'Windows · Chrome', ic: 'laptop' } },
  };
  // Состояние push на устройстве: off — не включен, on — включен, denied — запрещен в браузере,
  // ios — iPhone, сайт не установлен на экран «Домой», unsupported — браузер не умеет push
  const STATES = [
    { value: 'off', label: 'Не включен' },
    { value: 'on', label: 'Включен' },
    { value: 'denied', label: 'Запрещен в браузере' },
    { value: 'ios', label: 'iPhone: не установлен на экран «Домой»' },
    { value: 'unsupported', label: 'Браузер не поддерживает push' },
  ];
  const per = {};
  function S() {
    const id = D.user.id;
    // на iPhone сайт сначала открыт в Safari: push появится после установки на экран «Домой»
    if (!per[id]) per[id] = { push: { iphone: 'ios', pixel: 'off', mac: 'off', win: 'off' }, installed: { iphone: false, pixel: false, mac: false, win: false } };
    return per[id];
  }
  function device() { const d = DEVICES[D.user.id] || DEVICES.u2; return UI.isMobile() ? d.phone : d.desk; }
  const isInstalled = dev => !!S().installed[(dev || device()).key];
  const deviceLabel = dev => { dev = dev || device(); return dev.os === 'ios' && isInstalled(dev) ? dev.appName : dev.name; };
  const devices = () => D.me.pushDevices || (D.me.pushDevices = []);
  const pushState = () => S().push[device().key] || 'off';
  // Push настроен хотя бы на одном устройстве: тогда работают столбец «Push» и тихие часы (настройки общие на аккаунт)
  const hasPush = () => devices().length > 0;
  function setPush(state) {
    const s = S(), dev = device();
    s.push[dev.key] = state;
    if (dev.os === 'ios') s.installed[dev.key] = state !== 'ios' && state !== 'unsupported' ? true : state === 'ios' ? false : s.installed[dev.key];
    const list = devices(), i = list.findIndex(d => d.key === dev.key);
    if (state === 'on' && i < 0) list.unshift({ key: dev.key, name: deviceLabel(dev), ic: dev.ic, at: TODAY });
    if (state !== 'on' && i >= 0) list.splice(i, 1);
    if (UI.notifications && UI.notifications.refresh) UI.notifications.refresh();
  }
  // Отключить push на устройстве из списка; если это текущее — его состояние «не включен»
  function removeDevice(key) {
    const list = devices(), i = list.findIndex(d => d.key === key);
    if (i >= 0) list.splice(i, 1);
    const s = S();
    if (s.push[key] === 'on') s.push[key] = 'off';
    if (UI.notifications && UI.notifications.refresh) UI.notifications.refresh();
  }
  // Сколько из списка людей получат push (у кого есть хотя бы одно устройство)
  const withPush = people => people.filter(u => (u.pushDevices || []).length > 0).length;

  // ---------- системные окна (имитация) ----------
  function sysDialog(o) {
    const prev = document.activeElement;
    const back = h('div', { class: 'pwa-sys-back' });
    const done = fn => { back.remove(); document.removeEventListener('keydown', onKey, true); if (prev && prev.isConnected && prev.focus) prev.focus(); if (fn) fn(); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); done(o.onCancel); } };
    const box = h('div', { class: ['pwa-sys', o.ios && 'ios'], role: 'alertdialog', 'aria-modal': 'true', 'aria-label': o.title, tabindex: '-1' },
      h('span', { class: 'demo-pill' }, 'Окно браузера · в макете имитация'),
      o.head || null,
      h('div', { class: 'pwa-sys-title' }, o.title),
      o.text ? h('div', { class: 'pwa-sys-text' }, o.text) : null,
      h('div', { class: 'pwa-sys-acts' },
        h('button', { class: 'pwa-sys-btn', type: 'button', on: { click: () => done(o.onCancel) } }, o.cancel),
        h('button', { class: 'pwa-sys-btn primary', type: 'button', on: { click: () => done(o.onOk) } }, o.ok)));
    back.appendChild(box);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey, true);
    setTimeout(() => box.focus({ preventScroll: true }), 30);
  }
  window.addEventListener('hashchange', () => document.querySelectorAll('.pwa-sys-back, .pwa-banner').forEach(n => n.remove()));

  const ORIGIN = 'сайт AI Capper';
  // Запрос разрешения на уведомления — так, как его показывает браузер этого устройства
  function askPermission(onAnswer) {
    const dev = device();
    if (dev.os === 'ios') {
      sysDialog({ ios: true, title: '«AI Capper» запрашивает разрешение на отправку уведомлений',
        text: 'Уведомления могут содержать предупреждения, звуки и наклейки. Их можно настроить в «Настройках».',
        cancel: 'Не разрешать', ok: 'Разрешить', onOk: () => onAnswer(true), onCancel: () => onAnswer(false) });
      return;
    }
    sysDialog({ title: ORIGIN + ' запрашивает разрешение',
      text: [icon('bell'), 'Показывать уведомления'],
      cancel: 'Блокировать', ok: 'Разрешить', onOk: () => onAnswer(true), onCancel: () => onAnswer(false) });
  }

  // ---------- вид push ----------
  // В push — только событие, без сумм банка, ставки и прибыли: его видно на заблокированном экране
  const SAMPLES = [
    { title: 'Ставка №75 рассчитана', body: 'Откройте, чтобы посмотреть результат', when: 'сейчас' },
    { title: 'Вход с нового устройства', body: 'Chrome, Windows · Хельсинки. Если это не вы, завершите сеанс в приложении', when: '12 мин назад' },
    { title: 'Отчет за неделю готов', body: '28 сен – 4 окт: итоги, точность модели и новые гипотезы', when: 'пн, 07:00' },
  ];
  function pushItem(n) {
    return h('div', { class: ['pwa-push', n.solo && 'solo'] },
      appIcon(34),
      h('div', { class: 'pwa-push-text' },
        h('div', { class: 'pwa-push-top' }, h('span', { class: 'pwa-push-app' }, 'AI Capper'), h('span', null, n.when || 'сейчас')),
        h('div', { class: 'pwa-push-title' }, n.title),
        n.body ? h('div', { class: 'pwa-push-body' }, n.body) : null));
  }
  const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  function lockScreen(items, label) {
    const d = new Date(TODAY + 'T12:00:00Z');
    return h('figure', { class: 'pwa-lock', 'aria-label': label || 'Пример: push на экране блокировки телефона' },
      h('div', { class: 'pwa-lock-time', 'aria-hidden': 'true' }, '9:41'),
      h('div', { class: 'pwa-lock-date', 'aria-hidden': 'true' }, WEEKDAYS[d.getUTCDay()] + ', ' + d.getUTCDate() + ' ' + MONTHS_GEN[d.getUTCMonth()]),
      h('div', { class: 'pwa-lock-list' }, (items || SAMPLES).map(pushItem)));
  }
  // Карточка «Как выглядит push» для «Личный кабинет → Уведомления»
  function previewCard() {
    return UI.card({
      id: 'profile-push-look', title: 'Как выглядит push', subtitle: 'Экран блокировки телефона',
      body: [
        lockScreen(SAMPLES),
        h('p', { class: 'profile-note' }, icon('eyeOff'), h('span', null,
          h('b', null, 'В push нет сумм. '), 'Пишем только событие: «Ставка №75 рассчитана — откройте, чтобы посмотреть». Банк, суммы ставок и прибыль — только внутри приложения: push видно на заблокированном экране, его может прочитать кто угодно рядом.')),
      ],
    });
  }
  // Тестовый push: баннер сверху экрана на 6 секунд
  function banner(n) {
    document.querySelectorAll('.pwa-banner').forEach(x => x.remove());
    const b = h('button', { class: 'pwa-banner', type: 'button', role: 'status', 'aria-label': 'Push: ' + n.title + '. ' + (n.body || ''), on: { click: () => b.remove() } }, pushItem(n));
    document.body.appendChild(b);
    setTimeout(() => b.remove(), 6000);
  }

  // ---------- установка ----------
  const VARIANTS = [
    { value: 'android', label: 'Android · Chrome' },
    { value: 'ios', label: 'iPhone · Safari' },
    { value: 'desktop', label: 'Компьютер · Chrome или Edge' },
    { value: 'installed', label: 'Уже установлено' },
  ];
  const installTitle = () => (UI.isMobile() ? 'Установить на телефон' : 'Установить приложение');
  function pros() {
    return h('ul', { class: 'pwa-pros' },
      h('li', null, icon('check'), 'Открывается с иконки на весь экран, без адресной строки'),
      h('li', null, icon('check'), 'Push о расчете ставок, лимите и входе с нового устройства'),
      h('li', null, icon('check'), 'Ставки и банк на телефоне не хранятся: без связи покажем «Нет связи», а не старые цифры'));
  }
  const key = (ic, text) => h('span', { class: 'pwa-key' }, ic ? icon(ic) : null, text);
  function markInstalled(dev) {
    const s = S();
    s.installed[dev.key] = true;
    if (dev.os === 'ios' && s.push[dev.key] === 'ios') s.push[dev.key] = 'off'; // из установленного приложения push на iPhone доступен
  }
  // Окно установки. variant: android | ios | desktop | installed; по умолчанию — по этому устройству
  function installModal(variant) {
    const dev = device();
    let view = variant || (isInstalled(dev) ? 'installed' : dev.os);
    let closeM = () => {};
    const body = h('div', { class: 'stack', style: 'gap:14px' });
    let changed = false;
    // Отметка «установлено» — только для варианта этого устройства; другие варианты в макете только показываются
    function install() { if (view === dev.os) { markInstalled(dev); changed = true; } }
    function promptInstall() {
      sysDialog({ title: 'Установить приложение?',
        head: h('div', { class: 'pwa-sys-head' }, appIcon(44), h('div', { style: 'min-width:0' }, h('div', { style: 'font-weight:600' }, 'AI Capper'), h('div', { class: 'pwa-sys-origin' }, ORIGIN))),
        cancel: 'Отмена', ok: 'Установить',
        onOk: () => {
          const desk = view === 'desktop';
          install(); view = 'installed'; draw();
          UI.toast(desk ? 'AI Capper установлен: отдельное окно и значок в Dock или «Пуске»' : 'AI Capper на главном экране', 'check');
        } });
    }
    function draw() {
      UI.clear(body);
      const demo = UI.field({ id: 'pwa-install-demo', label: 'Устройство', value: view, options: VARIANTS });
      demo.querySelector('select').addEventListener('change', e => { view = e.target.value; draw(); const t = body.querySelector('#pwa-install-demo + .dd-trigger'); if (t) t.focus(); });
      const parts = [
        h('div', { class: 'pwa-demo', role: 'region', 'aria-label': 'Только в макете' }, h('span', { class: 'demo-pill' }, 'Только в макете'), demo),
        h('div', { class: 'pwa-app' }, appIcon(56), h('div', { style: 'min-width:0' }, h('div', { class: 'pwa-app-name' }, 'AI Capper'), h('div', { class: 'small soft' }, 'теннисная аналитика · приложение с этого сайта, без магазина приложений'))),
      ];
      if (view === 'installed') {
        parts.push(
          h('div', { class: 'row' }, chip('Приложение установлено', 'good', 'check')),
          h('p', { class: 'small soft' }, 'AI Capper открывается с иконки на экране «Домой» (на компьютере — отдельным окном). Новые версии приходят сами, ничего скачивать не нужно.'),
          h('p', { class: 'xsmall muted' }, 'Удалить можно как обычное приложение: долгое нажатие на иконку → «Удалить». Ваши данные останутся на сервере.'));
      } else if (view === 'ios') {
        parts.push(pros(),
          h('ol', { class: 'pwa-steps', 'aria-label': 'Как установить на iPhone' },
            h('li', null, h('div', null, 'Откройте этот сайт в ', h('b', null, 'Safari'), '.')),
            h('li', null, h('div', null, 'Нажмите ', key('share', 'Поделиться'), ' внизу экрана (на iPad — вверху).')),
            h('li', null, h('div', null, 'Прокрутите список вниз и выберите ', key('plusSquare', 'На экран «Домой»'), '.')),
            h('li', null, h('div', null, 'Нажмите ', key(null, 'Добавить'), ' в правом верхнем углу.')),
            h('li', null, h('div', null, 'Откройте AI Capper с экрана «Домой» и включите push в «Личный кабинет → Уведомления».'))),
          UI.callout('info', 'info', 'На iPhone push приходит только в установленное приложение, iOS 16.4 и новее. Версия iOS — в «Настройки → Основные → Об этом устройстве».'));
      } else if (view === 'android') {
        parts.push(pros(),
          h('p', { class: 'small soft' }, 'Нажмите «Установить» и подтвердите в окне Chrome — значок AI Capper появится на главном экране.'),
          h('p', { class: 'xsmall muted' }, 'Если кнопки нет (другой браузер): меню ', key('more', ''), ' → «Установить приложение» или «Добавить на главный экран».'));
      } else {
        parts.push(pros(),
          h('p', { class: 'small soft' }, 'В Chrome и Edge: кнопка «Установить» ниже или значок установки справа в адресной строке. Приложение откроется отдельным окном и появится в Dock или меню «Пуск».'),
          h('p', { class: 'xsmall muted' }, 'Safari на Mac: «Файл» → «Добавить в Dock». Firefox сайты не устанавливает — работайте во вкладке, push в Firefox приходит и так. На телефон: откройте этот сайт на телефоне → «Еще» → «Установить на телефон».'));
      }
      UI.append(body, parts);
      UI.clear(foot);
      const close = button('Закрыть', { kind: 'ghost', onClick: () => closeM() });
      if (view === 'android' || view === 'desktop') UI.append(foot, [close, button('Установить', { kind: 'primary', icon: 'download', onClick: promptInstall })]);
      else if (view === 'ios' && dev.os === 'ios') UI.append(foot, [close, button('Только в макете: открыть с экрана «Домой»', { kind: 'secondary', icon: 'device', onClick: () => { install(); closeM(); UI.toast('Открыто с экрана «Домой»: теперь можно включить push', 'check'); } })]);
      else UI.append(foot, [button(view === 'ios' ? 'Понятно' : 'Готово', { kind: 'primary', onClick: () => closeM() })]);
    }
    const foot = h('div', { class: 'pwa-foot' });
    UI.modal({ title: installTitle(), body: close => { closeM = close; return body; }, actions: [foot], onClose: () => { if (changed) refreshProfile(); } });
    draw();
  }
  // Кабинет перерисовывается, если открыт: статус установки и push видны сразу
  function refreshProfile() { if (location.hash.indexOf('#profile') === 0 && UI.rerender) { const y = window.scrollY; UI.rerender(); window.scrollTo(0, y); } }

  // Карточка «Приложение на телефоне» для вкладки «Профиль»
  function installCard() {
    const dev = device(), inst = isInstalled(dev);
    return UI.card({
      id: 'profile-install', class: 'profile-anchor pwa-install-card', title: 'Приложение на телефоне', subtitle: 'Иконка на экране «Домой» и push',
      body: [
        h('div', { class: 'profile-list' },
          h('div', { class: 'profile-item' },
            h('span', { class: 'profile-item-ic', 'aria-hidden': 'true', style: 'background:none' }, appIcon(40)),
            h('div', { style: 'min-width:0' },
              h('div', { class: 'profile-item-title' }, 'AI Capper', inst ? chip('Установлено', 'good', 'check') : chip('Не установлено', 'outline')),
              h('div', { class: 'profile-item-meta' }, 'Это устройство: ' + deviceLabel(dev))),
            h('span'))),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Приложение — этот же сайт: магазин приложений не нужен, обновляется само. ', dev.os === 'ios' && !inst ? 'На iPhone push работает только после установки.' : ''),
        h('div', { class: 'pwa-links' }, h('a', { href: '#offline' }, 'Как приложение выглядит без связи')),
      ],
      foot: [inst ? button('Подробнее', { kind: 'secondary', icon: 'check', onClick: () => installModal() }) : button(installTitle(), { kind: 'primary', icon: 'download', onClick: () => installModal() })],
    });
  }

  UI.pwa = { appIcon, device, deviceLabel, devices, pushState, setPush, removeDevice, hasPush, withPush, isInstalled, STATES,
    askPermission, pushItem, lockScreen, previewCard, banner, installModal, installCard, installTitle, SAMPLES };
})();
