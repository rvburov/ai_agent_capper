/* Личный кабинет: профиль и доступ; безопасность (пароль, 2FA, резервные коды, ключи доступа, сеансы, журнал входов);
   банк и стратегия (валюта программы, мои букмекеры, правила, ставки по кэфу, адаптации, ответственная игра);
   ключ Claude (ключ администратора или свой, со встроенной инструкцией); уведомления (на сайте и push);
   данные (экспорт, согласие на обезличенные прогнозы, импорт из старого бота, удаление аккаунта).
   Вкладки — подмаршруты #profile-<вкладка>: security, bank, key, notifications, data (старый #profile-integrations ведет на key).
   Пользователь — DATA.user (зависит от демо-роли), его строка в списке пользователей — DATA.me. Состояние кабинета
   хранится отдельно для каждого пользователя и создается при первом показе. Режим ключа, свой ключ, просьба вернуть
   ключ администратора, потолок на анализ (ownCap) и согласие пишутся прямо в DATA.me, часовой пояс и список букмекеров —
   в DATA.user: их видят главная, «ИИ и расходы», «Новый анализ» и кабинет администратора. Расход и лимиты считает
   общий DATA.ai (keySpent, ownSpent, limitOf, budget, access) — своих копий расчета здесь нет. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, TODAY = DATA.today;
  const user = () => D.user, me = () => D.me;
  const isAdmin = () => user().role === 'admin';

  // ---------- утилиты ----------
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const parts = iso => iso.slice(0, 10).split('-').map(Number);
  const dateLong = iso => { const [y, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1] + ' ' + y; };
  const dateDay = iso => { const [, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1]; };
  const addDays = (s, n) => { const d = new Date(s.slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10) + 'T12:00:00Z') - Date.parse(a.slice(0, 10) + 'T12:00:00Z')) / 864e5);
  const when = iso => { const d = iso.slice(0, 10), t = iso.slice(11, 16); return (d === TODAY ? 'Сегодня' : d === addDays(TODAY, -1) ? 'Вчера' : fmt.date(iso)) + ', ' + t; };
  const nowIso = () => TODAY + 'T' + new Date().toTimeString().slice(0, 5); // в макете «сегодня» — день демо-данных
  const lower1 = s => s.charAt(0).toLowerCase() + s.slice(1);
  const num = v => parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  const dec = n => String(Math.round(n * 100) / 100).replace('.', ',');
  const pl = fmt.plural;
  const usd = fmt.usd;
  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || user().initials;
  const ext = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const mono = t => h('span', { class: 'mono' }, t);

  // ---------- деньги в валюте программы (демо-данные в рублях, показ — через UI.fmt) ----------
  const isRub = () => UI.currency.code === 'RUB';
  const moneyBare = n => { const s = fmt.money(n), sym = ' ' + fmt.cur(); return s.endsWith(sym) ? s.slice(0, -sym.length) : s; };
  const moneyInput = n => (isRub() ? fmt.int(fmt.moneyNum(n)) : fmt.dec(fmt.moneyNum(n), 2)); // значение для поля ввода
  // Ставка округляется в валюте программы: рубли — до 10, доллары и евро — до целых
  const roundStake = rub => { const v = fmt.moneyNum(rub); return fmt.fromMoney(isRub() ? Math.round(v / 10) * 10 : Math.round(v)); };
  const currencyName = () => UI.currency.label + ' (' + UI.currency.sym + ')';

  // ---------- производные данные ----------
  // Ставки в игре считаются при каждой отрисовке: ставка, сохраненная в «Анализе» или рассчитанная в «Ставках», видна сразу
  const openBets = () => D.bets.filter(b => b.status === 'open');
  const inPlay = () => openBets().reduce((a, b) => a + b.stake, 0);
  const todayBets = () => D.bets.filter(b => b.date === TODAY);
  const settledBets = D.bets.filter(b => b.status !== 'open');
  const staleN = D.players.filter(p => p.fresh === 'stale').length;
  const missingN = D.players.filter(p => p.fresh === 'missing').length;
  const refreshSearches = D.ai.runs.filter(r => r.type === 'refresh').map(r => r.searches);
  const analysisRuns = D.ai.runs.filter(r => r.type === 'analysis');
  const avgAnalysis = analysisRuns.reduce((a, r) => a + r.cost, 0) / Math.max(1, analysisRuns.length);
  // Запуски ИИ самого пользователя: без общих фоновых задач (их оплачивает администратор), как в «ИИ и расходы»
  const myRunsN = D.ai.runs.filter(r => r.type !== 'refresh').length;
  const activeVersion = D.strategyVersions.find(v => v.status === 'active');
  const modelsByUse = (() => {
    const g = {};
    D.ai.runTypes.forEach(t => { (g[t.model] = g[t.model] || []).push(t.label.replace(' (Batch)', '')); });
    return Object.entries(g).map(([model, uses]) => [uses.map((u, i) => (i ? lower1(u) : u)).join(', '), model]);
  })();

  function makeCodes(seed) {
    const A = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let s = seed * 7919 + 17;
    const r = () => { s = (s * 1103515245 + 12345) % 2147483648; return Math.floor(s / 65536) % A.length; };
    return Array.from({ length: 8 }, () => { let c = ''; for (let i = 0; i < 8; i++) c += A[r()]; return c.slice(0, 4) + '-' + c.slice(4); });
  }

  // ---------- мои букмекеры ----------
  const BOOK_COUNT = name => D.bets.filter(b => b.bookmaker === name).length;
  const BOOK_OPEN = name => openBets().filter(b => b.bookmaker === name);
  const BOOK_INPLAY = name => BOOK_OPEN(name).reduce((a, b) => a + b.stake, 0);
  // Сверенный баланс (base) уже включает все ставки, рассчитанные до открытия макета. Результат ставок,
  // рассчитанных в этой сессии на экране «Ставки», добавляем к балансу их букмекера — сверка продолжает сходиться.
  const SETTLED_AT_LOAD = new Set(settledBets.map(b => b.id));
  const sessionProfit = name => D.bets.filter(b => b.bookmaker === name && b.status !== 'open' && !SETTLED_AT_LOAD.has(b.id)).reduce((a, b) => a + b.profit, 0);
  const BENCHMARK = D.marketRef; // эталон рынка для CLV (Р17)
  // Сам список — DATA.user.bookmakers (его же показывает «Новый анализ»); здесь — сверенные балансы по названию
  const BOOKS0 = {
    bet365: { mark: 'B3', base: 21480, checked: '2026-10-06' },
    Unibet: { mark: 'UB', base: 16800, checked: '2026-10-06' },
    Pinnacle: { mark: 'PN', base: S.bank - 21480 - 16800, checked: '2026-10-03' },
  };
  const bookMark = name => name.replace(/[^A-Za-zА-Яа-яЕе0-9]/g, '').slice(0, 2).toUpperCase() || '?';
  const myBooks = () => { const U = user(); if (!Array.isArray(U.bookmakers)) U.bookmakers = []; return U.bookmakers; };
  // Карточки букмекеров в порядке списка пользователя: баланс = сверенный + результат ставок, рассчитанных в этой сессии
  function books() {
    return myBooks().map(name => {
      const info = st.bookInfo[name] || (st.bookInfo[name] = Object.assign({ mark: bookMark(name), base: 0, checked: null }, BOOKS0[name] || {}));
      return { name, mark: info.mark, checked: info.checked, bets: BOOK_COUNT(name), inPlay: BOOK_INPLAY(name), balance: info.base + sessionProfit(name) };
    });
  }

  // ---------- устройства и входы демо-пользователей ----------
  // Первая запись журнала — последний вход из DATA.users (lastLogin), он же текущий сеанс.
  const PEOPLE = {
    u1: {
      sessions: [
        { id: 's-iphone', ic: 'device', name: 'iPhone 15 · Safari', short: 'iPhone', where: 'Хельсинки', ip: '91.155.xx.xx', seen: 'активен сейчас', current: true },
        { id: 's-mac', ic: 'laptop', name: 'MacBook Air · Chrome', short: 'MacBook', where: 'Хельсинки', ip: '84.250.xx.xx', seen: 'вчера, 23:52' },
      ],
      log: [
        { device: 'iPhone 15 · Safari', ip: '91.155.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-10-06T23:41', device: 'MacBook Air · Chrome', ip: '84.250.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-10-06T23:40', device: 'MacBook Air · Chrome', ip: '84.250.xx.xx', city: 'Хельсинки', result: 'badpass' },
        { at: '2026-10-05T19:12', device: 'iPhone 15 · Safari', ip: '91.155.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-10-04T03:17', device: 'Windows · Firefox', ip: '185.220.xx.xx', city: 'Амстердам, Нидерланды', result: '2fa' },
        { at: '2026-09-29T19:22', device: 'MacBook Air · Chrome', ip: '84.250.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-09-21T11:48', device: 'MacBook Air · Chrome', ip: '93.106.xx.xx', city: 'Берлин, Германия', result: 'ok' },
        { at: '2026-09-21T11:47', device: 'MacBook Air · Chrome', ip: '93.106.xx.xx', city: 'Берлин, Германия', result: 'badpass' },
      ],
      suspicious: { at: '2026-10-04T03:17', device: 'Windows · Firefox', from: 'из Амстердама', place: 'Амстердам, Нидерланды', ip: '185.220.xx.xx' },
      push: true, passkeyName: 'iPhone 15 — Face ID', unlock: 'Face ID',
    },
    u2: {
      sessions: [
        { id: 's-pixel', ic: 'device', name: 'Pixel 8 · Chrome', short: 'Pixel', where: 'Хельсинки', ip: '88.193.xx.xx', seen: 'активен сейчас', current: true },
        { id: 's-win', ic: 'laptop', name: 'Windows · Chrome', short: 'Windows', where: 'Хельсинки', ip: '62.78.xx.xx', seen: '5 окт, 20:31' },
      ],
      log: [
        { device: 'Pixel 8 · Chrome', ip: '88.193.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-10-05T20:14', device: 'Windows · Chrome', ip: '62.78.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-10-03T18:02', device: 'Windows · Chrome', ip: '62.78.xx.xx', city: 'Хельсинки', result: 'ok' },
        { at: '2026-09-30T08:20', device: 'Pixel 8 · Chrome', ip: '88.193.xx.xx', city: 'Эспоо', result: 'ok' },
        { at: '2026-09-30T08:19', device: 'Pixel 8 · Chrome', ip: '88.193.xx.xx', city: 'Эспоо', result: 'badpass' },
        { at: '2026-09-24T19:41', device: 'Pixel 8 · Chrome', ip: '88.193.xx.xx', city: 'Хельсинки', result: 'ok' },
      ],
      suspicious: null,
      push: false, passkeyName: 'Pixel 8 — отпечаток пальца', unlock: 'отпечатку пальца',
    },
  };
  const RESULT = { ok: ['Успешно', 'good', 'check'], badpass: ['Неверный пароль', 'warn', 'alert'], '2fa': ['2FA не пройдена', 'bad', 'x'] };
  const resultChip = r => chip(RESULT[r][0], RESULT[r][1], RESULT[r][2]);

  const TABS = [
    { id: 'profile', label: 'Профиль', short: 'Профиль', icon: 'user' },
    { id: 'security', label: 'Безопасность', short: 'Безопасность', icon: 'shield' },
    { id: 'bank', label: 'Банк и стратегия', short: 'Банк', icon: 'wallet' },
    { id: 'key', label: 'Ключ Claude', short: 'Ключ Claude', icon: 'key' },
    { id: 'notifications', label: 'Уведомления', short: 'Уведомления', icon: 'bell' },
    { id: 'data', label: 'Данные', short: 'Данные', icon: 'database' },
  ];
  const TAB_ALIAS = { integrations: 'key' }; // старые ссылки на «Интеграции и ключи»

  // Часовые пояса — общий список DATA.timezones (США, Финляндия, Германия); пояс пользователя — DATA.user.tz
  const myTz = () => user().tz || D.timezones[0].value;
  const tzOptions = () => { const tz = myTz(), list = D.timezones.map(t => ({ value: t.value, label: t.label })); return list.some(t => t.value === tz) ? list : [{ value: tz, label: tz }].concat(list); };
  const tzName = tz => { const t = D.timezones.find(x => x.value === tz); return t ? t.label.replace(/\s*\(.*$/, '') : tz; }; // «Нью-Йорк»
  const tzTime = () => 'время по ' + D.tzCity(myTz()); // «время по Нью-Йорку», как на главной

  const VALUE_ADJ = [
    { t: 'Сильный', d: 'перевес от 15%', v: '+0,5%' },
    { t: 'Хороший', d: '10–14%', v: '+0,25%' },
    { t: 'Небольшой', d: '5–9%', v: 'без поправки' },
    { t: 'Нет', d: 'меньше 5%', v: '−0,25%' },
  ];
  // Итог недели: банк сейчас к банку на конец дня неделю назад
  const weekBase = D.bankHistory.filter(x => x.date <= addDays(TODAY, -7)).pop() || D.bankHistory[0];
  const weekPct = (S.bank - weekBase.bank) / weekBase.bank * 100;

  // ---------- состояние (отдельное для каждого пользователя) ----------
  const states = {};
  let st = null;
  function makeState() {
    const U = user(), M = me(), P = PEOPLE[U.id] || PEOPLE.u2;
    const log = P.log.map((r, i) => Object.assign({}, r, i === 0 ? { at: M.lastLogin } : null));
    const mode = M.aiMode === 'own' ? 'own' : 'admin';
    return {
      uid: U.id, tab: 'profile',
      name: U.name, email: U.email,
      pwdChanged: U.since,
      codeSeed: U.id === 'u1' ? 7 : 11, codes: makeCodes(U.id === 'u1' ? 7 : 11), codesLeft: 8, codesCreated: U.since,
      passkeys: [],
      sessions: P.sessions.map(s => Object.assign({}, s)),
      log, susp: P.suspicious, suspicious: !!P.suspicious, logFilter: 'all',
      bookInfo: {}, bankAdj: 0,
      ruleEdits: [],
      rules: { minProb: D.strategy.minProb, oddsMin: D.strategy.oddsMin, oddsMax: D.strategy.oddsMax, maxLegs: D.strategy.maxLegs, totalMax: D.strategy.totalMax },
      stakes: D.strategy.stakeTable.map(r => { const [a, b] = r.pct.split('–'); return { range: r.range, min: num(a), max: num(b) }; }),
      // Р22: правил серий нет — только просадка, рост банка и итог недели
      adapt: { dd10: true, dd20: true, up15: true, weekLoss: true, weekWin: true },
      limits: { count: 3, amount: 4000 }, limitsPending: null,
      pauseDays: '7', pauseConfirm: false, pause: null,
      // ключ Claude: keyView — какая карточка режима выбрана на экране; сам режим — в DATA.me.aiMode
      keyView: mode, seenMode: mode, keyDraft: '', keyShow: false, keyErr: null, keyReplace: false, keyDelConfirm: false,
      push: { on: P.push, device: P.push ? P.sessions.find(s => s.current).name : null },
      notif: { bet: { site: true, push: true }, stale: { site: true, push: false }, ai: { site: true, push: true }, login: { site: true, push: true }, msg: { site: true, push: true }, requests: { site: true, push: true }, users: { site: true, push: false } },
      quiet: { on: true, from: '23:00', to: '08:00' },
      exportFmt: 'json', exportState: 'idle',
      deletion: null,
    };
  }
  function useState() {
    const id = user().id;
    if (!states[id]) states[id] = makeState();
    st = states[id];
    // режим могли поменять в другом месте (например, администратор вернул ключ) — показываем действующий
    const mode = keyMode();
    if (mode !== st.seenMode) { st.seenMode = mode; st.keyView = mode; st.keyReplace = false; st.keyDelConfirm = false; }
  }
  const bankNow = () => S.bank + st.bankAdj;
  const currentSession = () => st.sessions.find(s => s.current) || st.sessions[0];

  // ---------- ключ Claude: режим и расход ----------
  const keyMode = () => (me().aiMode === 'own' ? 'own' : 'admin');
  const ownKey = () => me().ownKey || null;
  const consent = () => me().consent !== false;
  function setMode(mode) { me().aiMode = mode; user().aiMode = mode; st.seenMode = mode; }
  // Расход и лимиты — только из общего расчета DATA.ai: те же цифры на главной, в «ИИ и расходы» и у администратора
  const ownSpent = () => D.ai.ownSpent(me()); // на своем ключе в этом месяце
  const keySpent = () => D.ai.keySpent(me()); // на ключе администратора в этом месяце (у перешедшего — до перехода)
  // Лимит на ключе администратора; на своем ключе — тот, что будет после возврата (личный или по умолчанию)
  const memberLimit = () => D.ai.limitOf(me()) || me().limit || D.admin.defaults;
  const ownCap = () => (me().ownCap != null ? me().ownCap : D.admin.defaults.perAnalysis); // свой потолок на анализ
  function limitState() { // для участника на ключе администратора
    const L = memberLimit(), spent = keySpent();
    const pct = spent / L.monthly * 100, alertAt = D.ai.budget().alertAt;
    return { L, spent, left: Math.max(0, Math.round((L.monthly - spent) * 100) / 100), pct, alertAt, warned: pct >= alertAt, stopped: pct >= 100, paused: !!L.paused };
  }
  const reqNotifId = () => 'req-' + user().id;

  // ---------- стили ----------
  UI.css('profile', `
    .profile-anchor { scroll-margin-top: calc(var(--topbar-h) + 16px); }
    .card.profile-hero { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 20px; padding: 20px; }
    .profile-hero-main { display: flex; flex-direction: column; gap: 18px; min-width: 0; }
    .profile-id { display: flex; align-items: center; gap: 16px; min-width: 0; }
    .profile-id > .btn { align-self: flex-start; }
    .profile-id-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; flex: 1; }
    .profile-avatar { width: 72px; height: 72px; border-radius: 50%; flex: none; display: grid; place-items: center; background: var(--accent); color: var(--accent-fg); font-family: var(--font-display); font-weight: 600; font-size: 1.625rem; letter-spacing: .02em; box-shadow: 0 0 0 4px var(--accent-soft); }
    .profile-name { font-size: var(--fs-2xl); overflow-wrap: anywhere; }
    .profile-email { color: var(--fg-2); overflow-wrap: anywhere; }
    .profile-chips { gap: 6px; margin-top: 4px; }
    .profile-facts { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .profile-facts > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .profile-facts dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .profile-facts dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .profile-facts dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .profile-quick { display: flex; flex-direction: column; gap: 8px; }
    @media (min-width: 961px) { .profile-hero-main { justify-content: space-between; } }
    .profile-guard { background: var(--surface-2); border-radius: var(--r-md); padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .profile-guard h3 { font-size: var(--fs-md); }
    .profile-guard-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 9px; }
    .profile-guard-list li { display: flex; align-items: center; gap: 10px; font-size: var(--fs-sm); min-width: 0; }
    .profile-guard-text { min-width: 0; flex: 1; }
    .profile-guard-ic { width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; flex: none; }
    .profile-guard-ic svg { width: 13px; height: 13px; }
    .profile-guard-ic.ok { background: var(--good-soft); color: var(--good-ink); }
    .profile-guard-ic.todo { background: var(--warn-soft); color: var(--warn-ink); }
    .profile-guard-alert { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-sm); background: var(--warn-soft); color: var(--warn-ink); font-size: var(--fs-sm); }
    .profile-guard-alert > svg { width: 16px; height: 16px; flex: none; }
    .profile-guard-alert .btn.ghost { margin-left: auto; color: var(--warn-ink); flex: none; }

    .tabs.profile-tabs button { display: inline-flex; align-items: center; gap: 7px; }
    .tabs.profile-tabs button svg { width: 16px; height: 16px; flex: none; }
    .profile-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex: none; }
    .profile-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; outline: none; }
    .profile-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .profile-tiles > div > .card { height: 100%; }
    .profile-form { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .profile-form > .card-foot { margin-top: auto; }
    .profile-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; align-items: start; }
    .profile-fields.bottom { align-items: end; }
    .profile-fields .span-2 { grid-column: span 2; }
    .profile-panel .input[readonly] { background: var(--surface-2); color: var(--fg-2); }
    .profile-section-title { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .profile-status { font-size: var(--fs-sm); color: var(--fg-3); }

    .profile-list { display: flex; flex-direction: column; min-width: 0; }
    .profile-item { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); min-width: 0; }
    .profile-item:first-child { padding-top: 2px; }
    .profile-item:last-child { border-bottom: 0; padding-bottom: 2px; }
    .profile-item-ic { width: 40px; height: 40px; border-radius: var(--r-md); background: var(--surface-2); color: var(--fg-2); display: grid; place-items: center; font-family: var(--font-display); font-weight: 700; font-size: var(--fs-sm); }
    .profile-item-ic svg { width: 20px; height: 20px; }
    .profile-item-ic.good { background: var(--good-soft); color: var(--good-ink); }
    .profile-item-ic.accent { background: var(--accent-soft); color: var(--accent-ink); }
    .profile-item-title { font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; overflow-wrap: anywhere; }
    .profile-item-meta { font-size: var(--fs-sm); color: var(--fg-3); overflow-wrap: anywhere; }
    .profile-item-side { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; min-width: 0; }
    .profile-item.below { grid-template-columns: 40px minmax(0, 1fr); align-items: start; }
    .profile-item.below .profile-item-side { grid-column: 2; justify-content: flex-start; }
    .profile-sessions { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .profile-sessions .profile-item { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; }
    .profile-sessions .profile-item:first-child, .profile-sessions .profile-item:last-child { padding: 12px; border-bottom: 1px solid var(--line); }
    .profile-money { font-family: var(--font-mono); font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }

    .profile-confirm { display: flex; flex-direction: column; gap: 10px; }
    .profile-strength { display: flex; flex-direction: column; gap: 6px; }
    .profile-strength .row-between { font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-reqs { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--fs-xs); color: var(--fg-3); }
    .profile-reqs li { display: inline-flex; align-items: center; gap: 4px; }
    .profile-reqs li.ok { color: var(--good-ink); }
    .profile-reqs svg { width: 13px; height: 13px; flex: none; }

    .profile-codes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 0; list-style: none; }
    .profile-codes li { font-family: var(--font-mono); font-size: var(--fs-lg); padding: 10px 12px; border-radius: var(--r-sm); background: var(--surface-2); text-align: center; letter-spacing: .06em; }

    .profile-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .profile-log li { display: flex; flex-direction: column; gap: 2px; padding: 11px 0; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); min-width: 0; }
    .profile-log li:first-child { padding-top: 0; }
    .profile-log li:last-child { border-bottom: 0; padding-bottom: 0; }
    .profile-log-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .profile-log-when { font-weight: 600; font-variant-numeric: tabular-nums; }
    .profile-ip { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); }

    .profile-cur { display: flex; align-items: center; gap: 6px 10px; flex-wrap: wrap; padding: 10px 14px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); font-size: var(--fs-sm); color: var(--fg-2); min-width: 0; }
    .profile-cur > svg { width: 18px; height: 18px; color: var(--accent-ink); flex: none; }
    .profile-cur-text { flex: 1 1 260px; min-width: 0; }
    .profile-cur-text b { color: var(--fg); font-weight: 600; }
    .profile-cur a { font-weight: 500; }

    .profile-stakes { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); }
    .profile-stake { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    .profile-stake:last-child { border-bottom: 0; }
    .profile-stake-range { font-family: var(--font-mono); font-weight: 500; }
    .profile-stake-inputs { display: flex; align-items: center; gap: 6px; color: var(--fg-3); }
    .profile-stake-inputs .input-wrap { width: 76px; }
    .profile-stake-inputs .input-wrap .input.has-suffix { height: 36px; text-align: right; padding: 0 26px 0 8px; }
    .profile-stake-inputs .input-suffix { right: 9px; }

    .profile-value { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .profile-value > div { background: var(--surface); padding: 8px 12px; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .profile-value dt { font-weight: 600; font-size: var(--fs-sm); }
    .profile-value dt small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .profile-value dd { margin: 0; font-family: var(--font-mono); font-weight: 500; font-size: var(--fs-sm); color: var(--fg); white-space: nowrap; }
    .profile-rule-groups { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 12px; }
    .profile-rule-group { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; min-width: 0; display: flex; flex-direction: column; }
    .profile-rule-group-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-height: 26px; }
    .profile-rule-group-head h4 { font-size: var(--fs-sm); text-transform: uppercase; letter-spacing: .05em; color: var(--fg-3); }
    .profile-rule-group .callout { margin-top: 10px; }
    .profile-rule { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; padding: 12px 0; border-bottom: 1px solid var(--line); align-items: start; }
    .profile-rule:last-child { border-bottom: 0; padding-bottom: 0; }
    .profile-rule-text { display: flex; flex-direction: column; gap: 2px; cursor: pointer; min-width: 0; }
    .profile-rule-title { font-weight: 600; }
    .profile-rule-hint { font-size: var(--fs-sm); color: var(--fg-3); }
    .profile-rule-status { grid-column: 1 / -1; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .profile-dd { display: flex; flex-direction: column; gap: 6px; padding: 12px; border-radius: var(--r-md); background: var(--surface-2); }
    .profile-dd-track { position: relative; height: 8px; border-radius: 999px; background: var(--surface-3); }
    .profile-dd-fill { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--accent); }
    .profile-dd-fill.warn { background: var(--warn); }
    .profile-dd-fill.bad { background: var(--bad); }
    .profile-dd-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; margin-left: -1px; background: var(--fg-3); border-radius: 1px; }
    .profile-dd-scale { position: relative; height: 16px; font-size: var(--fs-xs); color: var(--fg-3); }
    .profile-dd-scale span { position: absolute; top: 0; transform: translateX(-50%); white-space: nowrap; }
    .profile-dd-scale span:first-child { transform: none; }

    .profile-usage { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .profile-usage > div { display: flex; flex-direction: column; gap: 6px; min-width: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-usage b { color: var(--fg); font-variant-numeric: tabular-nums; }
    .card.profile-rg { border-color: color-mix(in srgb, var(--accent) 35%, var(--line)); }

    .profile-secret { display: flex; align-items: center; gap: 6px 10px; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-secret > svg { width: 18px; height: 18px; color: var(--fg-3); flex: none; }
    .profile-secret code { font-family: var(--font-mono); font-size: var(--fs-md); color: var(--fg); }
    .profile-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-bullets li { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
    .profile-bullets li > span { min-width: 0; }
    .profile-bullets svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent-ink); }
    .profile-bullets.lock svg { color: var(--fg-3); }
    .profile-bullets.warnlist svg { color: var(--warn-ink); }
    .profile-bullets.badlist svg { color: var(--bad-ink); }
    .profile-bullets b { color: var(--fg); font-weight: 600; }

    /* ключ Claude */
    .profile-modes { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .profile-mode { position: relative; display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 12px; align-items: start; padding: 14px 16px; border: 1px solid var(--line-strong); border-radius: var(--r-md); background: var(--surface); cursor: pointer; min-width: 0; transition: border-color .15s, background .15s; }
    .profile-mode:hover { border-color: var(--accent); }
    .profile-mode.is-on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: color-mix(in srgb, var(--accent-soft) 50%, var(--surface)); }
    .profile-mode-input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; pointer-events: none; }
    .profile-mode-dot { width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--line-strong); margin-top: 1px; display: grid; place-items: center; background: var(--surface); }
    .profile-mode.is-on .profile-mode-dot { border-color: var(--accent); }
    .profile-mode.is-on .profile-mode-dot::after { content: ""; width: 10px; height: 10px; border-radius: 50%; background: var(--accent); }
    .profile-mode-input:focus-visible + .profile-mode-dot { outline: 2px solid var(--focus); outline-offset: 3px; }
    .profile-mode-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .profile-mode-title { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; font-weight: 600; font-size: var(--fs-md); color: var(--fg); }
    .profile-mode-text { font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-note { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-sm); color: var(--fg-2); margin: 0; }
    .profile-note > svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--fg-3); }
    .profile-keyline { margin: 0; font-size: var(--fs-md); line-height: 1.55; color: var(--fg-2); }
    .profile-keyline b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .profile-keyline code { font-family: var(--font-mono); color: var(--fg); white-space: nowrap; }
    .profile-lim { display: flex; flex-direction: column; gap: 6px; }
    .profile-lim-scale { position: relative; height: 16px; font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .profile-lim-scale span { position: absolute; top: 0; white-space: nowrap; }
    .profile-lim-scale .mid { transform: translateX(-100%); padding-right: 6px; }
    .profile-lim-scale .end { right: 0; }
    .profile-kfacts { margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .profile-kfacts > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .profile-kfacts dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .profile-kfacts dd { margin: 2px 0 0; font-weight: 600; font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    .profile-kfacts dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .profile-thr { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .profile-thr li { display: grid; grid-template-columns: 52px minmax(0, 1fr); gap: 12px; align-items: start; font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-thr b { color: var(--fg); font-weight: 600; }
    .profile-thr-badge { display: grid; place-items: center; height: 24px; border-radius: var(--r-sm); font-family: var(--font-mono); font-weight: 600; font-size: var(--fs-sm); }
    .profile-thr-badge.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .profile-thr-badge.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .profile-keyinput { display: flex; gap: 8px; align-items: center; min-width: 0; }
    .profile-keyinput .input { flex: 1; font-family: var(--font-mono); font-size: var(--fs-sm); }
    .profile-keyinput .btn { flex: none; width: 42px; height: 42px; }
    .profile-cap { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .profile-cap .input { width: 120px; flex: none; font-variant-numeric: tabular-nums; }
    .profile-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; counter-reset: pstep; }
    .profile-steps > li { display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; align-items: start; font-size: var(--fs-sm); color: var(--fg-2); counter-increment: pstep; overflow-wrap: anywhere; }
    .profile-steps > li::before { content: counter(pstep); width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; font-weight: 600; font-family: var(--font-display); font-size: var(--fs-sm); }
    .profile-steps > li > div { padding-top: 3px; min-width: 0; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
    .profile-steps b { color: var(--fg); font-weight: 600; }
    .profile-details { border: 1px solid var(--line); border-radius: var(--r-md); min-width: 0; }
    .profile-details > summary { list-style: none; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 14px; cursor: pointer; font-weight: 600; border-radius: var(--r-md); }
    .profile-details > summary::-webkit-details-marker { display: none; }
    .profile-details > summary > svg { width: 18px; height: 18px; flex: none; color: var(--accent-ink); }
    .profile-details > summary > .chev { margin-left: auto; color: var(--fg-3); transition: transform .15s; }
    .profile-details[open] > summary > .chev { transform: rotate(180deg); }
    .profile-details > summary:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
    .profile-details-body { padding: 2px 14px 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .profile-faq { margin: 0; display: flex; flex-direction: column; gap: 10px; font-size: var(--fs-sm); }
    .profile-faq dt { font-weight: 600; color: var(--fg); }
    .profile-faq dd { margin: 2px 0 0; color: var(--fg-2); }

    .profile-notif-head, .profile-notif-row { display: grid; grid-template-columns: minmax(0, 1fr) 76px 76px; gap: 8px; align-items: center; }
    .profile-notif-head { font-size: var(--fs-xs); font-weight: 600; color: var(--fg-3); text-transform: uppercase; letter-spacing: .05em; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .profile-notif-head span:not(:first-child) { text-align: center; }
    .profile-notif-row { padding: 12px 0; border-bottom: 1px solid var(--line); }
    .profile-notif-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .profile-notif-t { font-weight: 500; }
    .profile-notif-cell { display: flex; justify-content: center; }
    .profile-notif-lock { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 24px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-ink); }
    .profile-notif-lock svg { width: 14px; height: 14px; }
    .profile-group-label { font-size: var(--fs-xs); font-weight: 600; color: var(--fg-3); text-transform: uppercase; letter-spacing: .05em; padding: 14px 0 0; }
    .profile-time { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .profile-how { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); }

    .profile-del-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    .profile-del-grid h4 { margin-bottom: 8px; }
    .card.profile-danger { border-color: color-mix(in srgb, var(--bad) 45%, var(--line)); }
    .profile-danger .eyebrow { color: var(--bad-ink); }

    @media (max-width: 960px) {
      .card.profile-hero { grid-template-columns: minmax(0, 1fr); padding: 16px; gap: 16px; }
      .profile-avatar { width: 56px; height: 56px; font-size: 1.25rem; box-shadow: 0 0 0 3px var(--accent-soft); }
      .profile-name { font-size: var(--fs-xl); }
      .tabs.profile-tabs { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; border-bottom: 0; overflow: visible; }
      .tabs.profile-tabs button { justify-content: center; padding: 9px 4px; border: 1px solid var(--line); border-radius: var(--r-md); margin: 0; background: var(--surface); color: var(--fg-2); font-size: var(--fs-sm); white-space: normal; text-align: center; min-width: 0; }
      .tabs.profile-tabs button[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent); }
    }
    @media (max-width: 720px) {
      .profile-facts { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .profile-facts > div:first-child { grid-column: span 2; }
      .profile-fields.collapse { grid-template-columns: minmax(0, 1fr); }
      .profile-fields.collapse .span-2 { grid-column: auto; }
      .profile-item.wrap-mobile { grid-template-columns: 40px minmax(0, 1fr); }
      .profile-item.wrap-mobile .profile-item-side { grid-column: 2; justify-content: flex-start; }
      .profile-notif-head, .profile-notif-row { grid-template-columns: minmax(0, 1fr) 58px 50px; gap: 6px; }
      .profile-notif-head { letter-spacing: .02em; }
      .profile-usage { grid-template-columns: minmax(0, 1fr); }
      .profile-stake { padding: 10px; gap: 8px; }
      .profile-stake-inputs .input-wrap { width: 68px; }
      .profile-value { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .profile-rule-groups { gap: 0; }
      .profile-rule-group { border: 0; border-radius: 0; padding: 0; }
      .profile-rule-group + .profile-rule-group { border-top: 1px solid var(--line-strong); margin-top: 14px; padding-top: 14px; }
      .profile-modes { grid-template-columns: minmax(0, 1fr); gap: 8px; }
      .profile-mode { padding: 12px 14px; }
      .profile-kfacts > div { padding: 8px 10px; }
      .profile-kfacts dd { font-size: var(--fs-md); }
      .profile-del-grid { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    }
  `);

  // ---------- общие кусочки ----------
  let heroSlot = null, tabsSlot = null, panelEl = null;

  function setFieldError(fieldEl, msg) {
    const input = fieldEl.querySelector('input, select, textarea');
    let err = fieldEl.querySelector('.field-error');
    const hint = fieldEl.querySelector('.field-hint');
    if (!msg) {
      if (err) err.remove();
      if (hint) hint.hidden = false;
      input.classList.remove('invalid'); input.removeAttribute('aria-invalid');
      if (hint && hint.id) input.setAttribute('aria-describedby', hint.id); else input.removeAttribute('aria-describedby');
      return false;
    }
    if (!err) { err = h('div', { class: 'field-error', role: 'alert', id: input.id + '-err' }); fieldEl.appendChild(err); }
    err.textContent = msg;
    if (hint) hint.hidden = true;
    input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id);
    return false;
  }
  const valOf = f => f.querySelector('input, select, textarea').value;

  function busy(btn, text, ms, done) {
    const label = btn.querySelector('span');
    const old = label ? label.textContent : '';
    btn.disabled = true; if (label) label.textContent = text;
    setTimeout(() => { if (btn.isConnected) { btn.disabled = false; if (label) label.textContent = old; } done(); }, ms);
  }

  function item(o) { // {ic, mark, icKind, title, titleExtra, meta, side, wrap, below}
    return h('div', { class: ['profile-item', o.wrap && 'wrap-mobile', o.below && 'below'] },
      h('span', { class: ['profile-item-ic', o.icKind], 'aria-hidden': 'true' }, o.mark || icon(o.ic)),
      h('div', { style: 'min-width:0' }, h('div', { class: 'profile-item-title' }, o.title, o.titleExtra), o.meta && h('div', { class: 'profile-item-meta' }, o.meta)),
      o.side ? h('div', { class: 'profile-item-side' }, o.side) : h('span'));
  }

  function formCard(o) {
    const form = h('form', { class: 'profile-form', novalidate: true, 'aria-labelledby': o.id + '-title', on: {
      submit: e => { e.preventDefault(); o.onSubmit && o.onSubmit(); },
      input: e => o.onInput && o.onInput(e),
      change: e => o.onInput && o.onInput(e),
    } }, h('div', { class: 'card-body' }, o.body), o.foot && h('div', { class: 'card-foot' }, o.foot));
    return h('section', { class: ['card', 'profile-anchor', o.class], id: o.id },
      h('div', { class: 'card-head' },
        h('div', { style: 'min-width:0' }, o.eyebrow && h('div', { class: 'eyebrow' }, o.eyebrow), h('h3', { id: o.id + '-title' }, o.title), o.subtitle && h('div', { class: 'card-sub' }, o.subtitle)),
        o.actions && h('div', { class: 'row' }, o.actions)),
      form);
  }

  function switchInput(id, checked, label, onChange, disabled) {
    return h('span', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', id, checked: !!checked, disabled: !!disabled, 'aria-label': label, on: { change: e => onChange(e.target.checked, e.target) } }), h('span'));
  }

  function scrollToId(id, focusSel) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusSel) { const f = el.querySelector(focusSel); if (f) setTimeout(() => f.focus({ preventScroll: true }), 350); }
  }

  function details(title, ic, open, body, id) {
    return h('details', { class: 'profile-details', open: !!open, id },
      h('summary', null, icon(ic), h('span', null, title), icon('chevronDown', { class: 'chev' })),
      h('div', { class: 'profile-details-body' }, body));
  }

  // Шкала расхода: заливка, отметка порога предупреждения и подписи 0 / порог / лимит
  function limitBar(spent, max, alertAt, label) {
    const pct = spent / max * 100;
    return h('div', { class: 'profile-lim' },
      h('div', { class: 'profile-dd-track', role: 'meter', 'aria-label': label, 'aria-valuenow': String(Math.round(spent * 100) / 100), 'aria-valuemin': '0', 'aria-valuemax': String(max), 'aria-valuetext': usd(spent) + ' из ' + usd(max, 0) },
        h('i', { class: ['profile-dd-fill', pct >= 100 ? 'bad' : pct >= alertAt ? 'warn' : null], style: { width: Math.min(100, pct) + '%' } }),
        h('span', { class: 'profile-dd-mark', style: { left: alertAt + '%' } })),
      h('div', { class: 'profile-lim-scale', 'aria-hidden': 'true' },
        h('span', { style: 'left:0' }, usd(0, 0)),
        h('span', { class: 'mid', style: { left: alertAt + '%' } }, alertAt + '% · ' + usd(max * alertAt / 100, 0)),
        h('span', { class: 'end' }, usd(max, 0))));
  }

  function currencyNote() {
    return h('div', { class: 'profile-cur', role: 'note' }, icon('currency'),
      h('div', { class: 'profile-cur-text' }, h('b', null, 'Валюта программы: ' + currencyName()), ' — задает администратор, одна на всех. Расходы на ИИ всегда в долларах.'),
      isAdmin() && h('a', { href: '#admin-settings' }, 'Изменить в настройках программы'));
  }

  // ---------- шапка кабинета ----------
  // Чем открывается ключ доступа на текущем телефоне: Face ID на iPhone, отпечаток на Pixel
  const unlockWord = () => ((PEOPLE[st.uid] || {}).unlock || 'отпечатку пальца или Face ID');
  function securityChecks() {
    const pk = st.passkeys.length;
    return [
      { ok: true, t: 'Надежный пароль', d: 'изменен ' + (st.pwdChanged === TODAY ? 'сегодня' : dateLong(st.pwdChanged)) },
      { ok: true, t: 'Код 2FA при входе', d: 'приложение-аутентификатор (TOTP)' },
      { ok: st.codesLeft >= 4, t: 'Резервные коды сохранены', d: st.codesLeft + ' из 8 не использованы' },
      { ok: pk > 0, t: 'Ключ доступа (passkey)', d: pk ? pk + ' ' + pl(pk, 'ключ', 'ключа', 'ключей') + ' · вход по ' + unlockWord() : 'не добавлен — вход по ' + unlockWord() + ' без пароля',
        action: pk ? null : button('Добавить', { kind: 'secondary', size: 'sm', icon: 'plus', onClick: () => switchTab('security', () => { scrollToId('profile-2fa'); passkeyModal(); }) }) },
    ];
  }

  function heroCard() {
    const mobile = UI.isMobile();
    const U = user();
    const checks = securityChecks();
    const done = checks.filter(c => c.ok).length;
    const sessions = st.sessions;
    const meter = UI.meter(done, checks.length);
    meter.setAttribute('aria-label', 'Защита аккаунта: ' + done + ' из ' + checks.length);
    const shown = mobile ? checks.filter(c => !c.ok) : checks;
    const daysIn = daysBetween(U.since, TODAY);
    const last = st.log[0], cur = currentSession();
    return h('section', { class: 'card profile-hero', 'aria-label': 'Сводка аккаунта' },
      h('div', { class: 'profile-hero-main' },
        h('div', { class: 'profile-id' },
          h('div', { class: 'profile-avatar', 'aria-hidden': 'true' }, initials(st.name)),
          h('div', { class: 'profile-id-text' },
            h('h2', { class: 'profile-name' }, st.name),
            h('div', { class: 'profile-email' }, st.email),
            h('div', { class: 'row profile-chips' },
              chip(U.roleLabel, 'accent', isAdmin() ? 'admin' : 'user'),
              chip('2FA включена', 'good', 'shield'),
              st.pause && chip('Пауза до ' + dateDay(st.pause.until), 'warn', 'pause'),
              st.deletion && chip('Удаление ' + dateDay(st.deletion.until), 'bad', 'trash'))),
          !mobile && button('Выйти', { kind: 'ghost', size: 'sm', icon: 'logout', onClick: () => UI.auth.logout() })),
        h('dl', { class: 'profile-facts' },
          h('div', null, h('dt', null, 'В AI Capper'), h('dd', null, 'с ' + dateLong(U.since), h('small', null, daysIn + ' ' + pl(daysIn, 'день', 'дня', 'дней') + ' · ' + S.settled + ' ' + pl(S.settled, 'ставка', 'ставки', 'ставок') + ' рассчитано'))),
          h('div', null, h('dt', null, 'Последний вход'), h('dd', null, when(last.at), h('small', null, cur.short + ' · ' + last.city))),
          h('div', null, h('dt', null, 'Активные сеансы'), h('dd', null, String(sessions.length), h('small', null, sessions.map(s => s.short).join(', '))))),
        !mobile && h('div', { class: 'profile-quick' }, h('span', { class: 'eyebrow' }, 'Часто нужно'), h('div', { class: 'row' },
          button('Сменить пароль', { kind: 'secondary', size: 'sm', icon: 'lock', onClick: () => switchTab('security', () => scrollToId('profile-password', '#profile-pass-cur')) }),
          button('Ключ Claude', { kind: 'secondary', size: 'sm', icon: 'key', onClick: () => switchTab('key') }),
          button('Лимиты и пауза', { kind: 'secondary', size: 'sm', icon: 'pause', onClick: () => switchTab('bank', () => scrollToId('profile-rg')) }),
          button('Экспорт данных', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => switchTab('data', () => scrollToId('profile-export')) })))),
      h('div', { class: 'profile-guard' },
        h('div', { class: 'row-between' }, h('h3', null, 'Защита аккаунта'), chip(done + ' из ' + checks.length, done === checks.length ? 'good' : 'outline', done === checks.length ? 'check' : null)),
        meter,
        mobile && !shown.length ? h('div', { class: 'small soft' }, 'Пароль, 2FA, резервные коды и ключ доступа — все включено.') : null,
        mobile && shown.length ? h('div', { class: 'xsmall muted' }, (checks.length - shown.length) + ' из ' + checks.length + ' мер включены. Что еще можно усилить:') : null,
        shown.length ? h('ul', { class: 'profile-guard-list' }, shown.map(c => h('li', null,
          h('span', { class: ['profile-guard-ic', c.ok ? 'ok' : 'todo'] }, icon(c.ok ? 'check' : 'plus')),
          h('div', { class: 'profile-guard-text' }, h('div', null, c.t, h('span', { class: 'sr-only' }, c.ok ? ' — готово' : ' — не сделано')), h('div', { class: 'xsmall muted' }, c.d)),
          c.action))) : null,
        st.suspicious && h('div', { class: 'profile-guard-alert', role: 'note' }, icon('alert'),
          h('div', { style: 'min-width:0' }, fmt.datetime(st.susp.at) + ' — вход ' + st.susp.from + ' остановлен на 2FA'),
          button('Проверить', { kind: 'ghost', size: 'sm', onClick: () => switchTab('security', () => scrollToId('profile-log')) }))));
  }
  function drawHero() { if (heroSlot) UI.clear(heroSlot).appendChild(heroCard()); }

  // ---------- вкладки ----------
  function tabAttention(id) {
    if (id === 'security') return st.suspicious;
    if (id === 'key') return (keyMode() === 'own' && !ownKey()) || (keyMode() === 'admin' && !isAdmin() && (limitState().warned || limitState().paused));
    return false;
  }
  function drawTabs() {
    const mobile = UI.isMobile();
    const dot = id => tabAttention(id) ? [h('span', { class: 'profile-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, ' (есть что проверить)')] : null;
    const t = UI.tabs({
      items: TABS.map(x => ({ id: x.id, label: mobile ? [x.short, dot(x.id)] : [icon(x.icon), x.label, dot(x.id)] })),
      active: st.tab,
      onChange: id => switchTab(id, null, true),
    });
    t.classList.add('profile-tabs');
    t.setAttribute('aria-label', 'Разделы личного кабинета');
    t.querySelectorAll('button').forEach(b => b.setAttribute('aria-controls', 'profile-panel'));
    UI.clear(tabsSlot).appendChild(t);
  }
  function drawPanel() {
    const fn = { profile: panelProfile, security: panelSecurity, bank: panelBank, key: panelKey, notifications: panelNotifications, data: panelData }[st.tab];
    UI.clear(panelEl);
    panelEl.setAttribute('aria-label', TABS.find(t => t.id === st.tab).label);
    UI.append(panelEl, [fn()]);
  }
  function setHash(id) {
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#profile' + (id === 'profile' ? '' : '-' + id)); } catch (e) { /* в песочнице адрес может быть недоступен — не страшно */ }
  }
  function switchTab(id, after, fromTabs) {
    const hadFocus = fromTabs || (document.activeElement && document.activeElement.getAttribute('role') === 'tab');
    st.tab = id;
    setHash(id);
    drawTabs(); drawPanel();
    if (hadFocus) { const b = tabsSlot.querySelector('[aria-selected="true"]'); if (b) b.focus(); }
    if (after) requestAnimationFrame(after);
  }

  // =====================================================================
  // 1. ПРОФИЛЬ
  // =====================================================================
  function panelProfile() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-7 profile-col' }, personalCard(), accessCard()),
      h('div', { class: 'col-5 profile-col' }, regionCard(), appearanceCard()));
  }

  function personalCard() {
    const nameF = UI.field({ label: 'Имя и фамилия', id: 'profile-name', value: st.name, autocomplete: 'name',
      hint: isAdmin() ? 'Так вас видят участники: этим именем подписаны ваши сообщения и записи в журнале действий' : 'Так вас видит администратор в списке участников' });
    const emailF = UI.field({ label: 'Email для входа', id: 'profile-email', type: 'email', value: st.email, attrs: { readonly: true }, hint: 'Это ваш логин. Писем не отправляем: смену подтверждаете паролем и кодом 2FA' });
    const save = button('Сохранить', { kind: 'primary', type: 'submit', icon: 'check', disabled: true });
    const status = h('span', { class: 'profile-status', 'aria-live': 'polite' });
    const nameInput = nameF.querySelector('input');
    return formCard({
      id: 'profile-personal', title: 'Личные данные', subtitle: 'Аккаунт создан ' + dateLong(user().since),
      body: [nameF, emailF, h('div', { class: 'row' }, button('Изменить email', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: emailModal }))],
      foot: [save, status],
      onInput: () => { const dirty = nameInput.value.trim() !== st.name; save.disabled = !dirty; status.textContent = dirty ? 'Есть несохраненные изменения' : ''; setFieldError(nameF, null); },
      onSubmit: () => {
        const v = nameInput.value.trim();
        if (v.length < 2) return setFieldError(nameF, 'Укажите имя — хотя бы 2 буквы');
        st.name = v; save.disabled = true; status.textContent = 'Сохранено';
        drawHero();
        UI.toast('Имя сохранено: ' + v, 'check');
      },
    });
  }

  function emailModal() {
    const f1 = UI.field({ label: 'Новый email', id: 'profile-new-email', type: 'email', autocomplete: 'email', placeholder: 'name@example.com' });
    const f2 = UI.field({ label: 'Текущий пароль', id: 'profile-email-pass', type: 'password', autocomplete: 'current-password', hint: 'В макете подойдет любой, кроме «wrong»' });
    const f3 = UI.field({ label: 'Код 2FA', id: 'profile-email-otp', inputmode: 'numeric', autocomplete: 'one-time-code', placeholder: '123456', hint: '6 цифр из приложения-аутентификатора' });
    const m = UI.modal({
      title: 'Смена email',
      body: h('form', { id: 'profile-email-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        h('p', { class: 'small soft' }, 'Email — это ваш логин. Писем мы не отправляем, поэтому смену подтверждаете паролем и кодом 2FA. Старый адрес ' + st.email + ' перестанет работать сразу.'),
        f1, f2, f3),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Сменить email', { kind: 'primary', type: 'submit', icon: 'check', attrs: { form: 'profile-email-form' } })],
    });
    function submit() {
      const v = valOf(f1).trim(), p = valOf(f2), c = valOf(f3).replace(/\s/g, '');
      setFieldError(f1, null); setFieldError(f2, null); setFieldError(f3, null);
      let ok = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) ok = setFieldError(f1, 'Проверьте адрес: нужен вид name@example.com');
      else if (v.toLowerCase() === st.email.toLowerCase()) ok = setFieldError(f1, 'Это ваш текущий адрес');
      if (!p) ok = setFieldError(f2, 'Введите текущий пароль');
      else if (p === 'wrong') ok = setFieldError(f2, 'Пароль не подходит');
      if (!/^\d{6}$/.test(c)) ok = setFieldError(f3, 'Нужно 6 цифр из приложения');
      if (!ok) return;
      st.email = v; m.close(); drawHero(); drawPanel();
      UI.toast('Email для входа изменен: ' + v, 'check');
    }
  }

  function regionCard() {
    const tzF = UI.field({ label: 'Часовой пояс', id: 'profile-tz', value: myTz(), options: tzOptions(), hint: 'По нему показываем время матчей, считаем лимиты «в день» и тихие часы. Летнее и зимнее время учитываем сами' });
    const save = button('Сохранить', { kind: 'primary', type: 'submit', icon: 'check', disabled: true });
    const status = h('span', { class: 'profile-status' });
    return formCard({
      id: 'profile-region', title: 'Регион и язык', subtitle: 'Время, валюта и язык интерфейса',
      body: [
        tzF,
        UI.kv([
          ['Валюта программы', currencyName()],
          ['Язык интерфейса и анализов', 'Русский'],
        ]),
        h('p', { class: 'xsmall muted' }, 'Валюту задает администратор, она одна на всех' + (isAdmin() ? ' — ' : '. '), isAdmin() ? [h('a', { href: '#admin-settings' }, 'изменить в настройках программы'), '. '] : null,
          'Другие языки интерфейса добавим позже. Служебные инструкции модели на английском (вместе со сжатым досье −31% токенов) — кандидат v4, решение в ', h('a', { href: '#learning' }, 'Обучении модели'), '.'),
      ],
      foot: [save, status],
      onInput: () => { const dirty = valOf(tzF) !== myTz(); save.disabled = !dirty; status.textContent = dirty ? 'Есть несохраненные изменения' : ''; },
      onSubmit: () => {
        user().tz = valOf(tzF); // DATA.user.tz: по нему главная пишет «время по …»
        save.disabled = true; status.textContent = 'Сохранено';
        UI.toast('Часовой пояс: ' + tzName(myTz()) + '. Время матчей теперь по ' + D.tzCity(myTz()), 'globe');
      },
    });
  }

  function appearanceCard() {
    const theme = document.documentElement.dataset.theme || 'system';
    const items = [{ id: 'system', label: 'Как в системе' }, { id: 'light', label: 'Светлая' }, { id: 'dark', label: 'Темная' }];
    return card({
      title: 'Внешний вид', subtitle: 'Тема сохраняется на этом устройстве',
      body: [
        UI.segmented({ label: 'Тема оформления', items, active: theme, onChange: id => {
          if (id === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('capper.theme'); } catch (e) { /* ок */ } }
          else { document.documentElement.dataset.theme = id; try { localStorage.setItem('capper.theme', id); } catch (e) { /* ок */ } }
          UI.rerender();
          UI.toast('Тема: ' + items.find(i => i.id === id).label.toLowerCase(), id === 'dark' ? 'moon' : 'sun');
        } }),
        h('p', { class: 'xsmall muted' }, 'Кэфы везде показываем в десятичном формате (1.62), суммы — в валюте программы, расходы на ИИ — в долларах.'),
      ],
    });
  }

  function accessCard() {
    const adm = isAdmin();
    const others = D.users.filter(u => u.id !== me().id && u.status !== 'deleted');
    const waiting = D.admin.invites.filter(i => i.status === 'active').length;
    return card({
      title: 'Доступ к аккаунту', subtitle: 'Закрытый круг: регистрация только по коду приглашения от администратора',
      body: [
        UI.kv([
          ['Ваша роль', adm ? user().roleLabel : user().roleLabel + ' · назначает администратор'],
          ['Вход', 'email + пароль + код 2FA'],
          adm
            ? ['Участники', h('a', { href: '#admin-users' }, others.length + ' ' + pl(others.length, 'человек', 'человека', 'человек') + (waiting ? ' · ' + waiting + ' ' + pl(waiting, 'приглашение ждет', 'приглашения ждут', 'приглашений ждут') : ''))]
            : ['Другие участники', 'закрытый круг · приглашает администратор'],
        ]),
        h('p', { class: 'xsmall muted' }, adm
          ? 'Участников, приглашения, ключ и бюджет вы ведете в «Администрировании». Администраторов может быть несколько: следующих назначаете вы.'
          : 'Администратор видит только ваш расход на ИИ и активность — входы и число анализов. Ставки, банк и стратегия видны только вам.'),
      ],
      foot: adm ? [button('Администрирование', { kind: 'secondary', icon: 'admin', href: '#admin-users' }), button('Пригласить участника', { kind: 'ghost', icon: 'userPlus', href: '#admin-invites' })] : null,
    });
  }

  // =====================================================================
  // 2. БЕЗОПАСНОСТЬ
  // =====================================================================
  function panelSecurity() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-6 profile-col' }, passwordCard()),
      h('div', { class: 'col-6 profile-col' }, twofaCard()),
      h('div', { class: 'col-12 profile-col' }, sessionsCard()),
      h('div', { class: 'col-12 profile-col' }, logCard()));
  }

  function strengthOf(p) {
    let s = 0;
    if (p.length >= 12) s++;
    if (p.length >= 16) s++;
    if (/[a-zа-яе]/.test(p) && /[A-ZА-ЯЕ]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-zА-Яа-яЕе0-9]/.test(p)) s++;
    if (p.length < 8) s = Math.min(s, 1);
    return s;
  }

  function passwordCard() {
    const cur = UI.field({ label: 'Текущий пароль', id: 'profile-pass-cur', type: 'password', autocomplete: 'current-password' });
    const nw = UI.field({ label: 'Новый пароль', id: 'profile-pass-new', type: 'password', autocomplete: 'new-password' });
    const cf = UI.field({ label: 'Повторите новый пароль', id: 'profile-pass-confirm', type: 'password', autocomplete: 'new-password' });
    const strength = h('div', { class: 'profile-strength' });
    const kill = h('input', { type: 'checkbox', id: 'profile-pass-kill', checked: true });
    const show = h('label', { class: 'check small', for: 'profile-pass-show' }, h('input', { type: 'checkbox', id: 'profile-pass-show', on: { change: e => [cur, nw, cf].forEach(f => { f.querySelector('input').type = e.target.checked ? 'text' : 'password'; }) } }), h('span', null, 'Показать пароли'));
    const others = st.sessions.filter(s => !s.current);
    function drawStrength() {
      const p = valOf(nw), c = valOf(cur);
      const s = strengthOf(p);
      const lvl = !p ? null : s <= 1 ? ['Слабый', 'bad', 'alert'] : s <= 3 ? ['Средний', 'warn', 'info'] : ['Надежный', 'good', 'check'];
      const reqs = [
        [p.length >= 12, 'Не короче 12 символов'],
        [/[A-Za-zА-Яа-яЕе]/.test(p) && /\d/.test(p), 'Буквы и цифры'],
        [!!p && p !== c, 'Не совпадает с текущим'],
      ];
      const m = UI.meter(p ? Math.max(s, 0.4) : 0, 5, lvl ? (lvl[1] === 'good' ? null : lvl[1]) : null);
      m.setAttribute('aria-label', 'Надежность пароля');
      UI.clear(strength);
      UI.append(strength, [
        h('div', { class: 'row-between' }, h('span', null, 'Надежность'), lvl ? chip(lvl[0], lvl[1], lvl[2]) : h('span', { class: 'xsmall muted' }, 'введите новый пароль')),
        m,
        h('ul', { class: 'profile-reqs', 'aria-label': 'Требования к паролю' }, reqs.map(([ok, t]) => h('li', { class: ok ? 'ok' : null }, icon(ok ? 'check' : 'x'), t, h('span', { class: 'sr-only' }, ok ? ' — выполнено' : ' — не выполнено')))),
      ]);
    }
    drawStrength();
    const days = daysBetween(st.pwdChanged, TODAY);
    const forgot = isAdmin()
      ? h('p', { class: 'profile-note' }, icon('terminal'), h('span', null, 'Забыли пароль администратора? Код сброса выдает только сервер: команда ', mono('reset-code'), ' в терминале.'))
      : h('p', { class: 'profile-note' }, icon('info'), h('span', null, 'Забыли пароль? Попросите администратора выдать код сброса — он действует 24 часа. Код вводится на экране входа в «Забыли пароль?».'));
    return formCard({
      id: 'profile-password', title: 'Пароль',
      subtitle: st.pwdChanged === TODAY ? 'Изменен сегодня' : 'Изменен ' + dateLong(st.pwdChanged) + ' · ' + days + ' ' + pl(days, 'день', 'дня', 'дней') + ' назад',
      body: [cur, nw, strength, cf, show,
        others.length ? h('label', { class: 'check small', for: 'profile-pass-kill' }, kill, h('span', null, 'Завершить другие сеансы', h('span', { class: 'field-hint', style: 'display:block' }, others.map(s => s.short).join(', ') + ' — войти заново'))) : null,
        forgot],
      foot: [button('Сменить пароль', { kind: 'primary', type: 'submit', icon: 'lock' })],
      onInput: e => { if (e && e.target && e.target.id !== 'profile-pass-kill' && e.target.id !== 'profile-pass-show') { drawStrength(); [cur, nw, cf].forEach(f => { if (f.contains(e.target)) setFieldError(f, null); }); } },
      onSubmit: () => {
        const c = valOf(cur), n = valOf(nw), r = valOf(cf);
        let ok = true;
        if (!c) ok = setFieldError(cur, 'Введите текущий пароль');
        else if (c === 'wrong') ok = setFieldError(cur, 'Текущий пароль не подходит');
        if (n.length < 12) ok = setFieldError(nw, 'Нужно не меньше 12 символов');
        else if (!(/[A-Za-zА-Яа-яЕе]/.test(n) && /\d/.test(n))) ok = setFieldError(nw, 'Добавьте и буквы, и цифры');
        else if (n === c) ok = setFieldError(nw, 'Новый пароль совпадает с текущим');
        if (n && r !== n) ok = setFieldError(cf, 'Пароли не совпадают');
        if (!ok) return;
        const killed = others.length && kill.checked;
        st.pwdChanged = TODAY;
        if (killed) st.sessions = st.sessions.filter(s => s.current);
        drawHero(); drawPanel();
        UI.toast(killed ? 'Пароль изменен. Другие сеансы завершены' : 'Пароль изменен', 'lock');
      },
    });
  }

  function twofaCard() {
    const pk = st.passkeys;
    return card({
      id: 'profile-2fa', class: 'profile-anchor', title: 'Двухфакторная аутентификация',
      subtitle: 'Код из приложения при входе; доверенное устройство — раз в 30 дней',
      actions: [chip('Включена', 'good', 'shield')],
      body: [
        h('div', { class: 'profile-list' },
          item({ ic: 'shield', icKind: 'good', title: 'Приложение-аутентификатор (TOTP)', meta: 'Настроено ' + dateLong(user().since) + ' · Google Authenticator, Microsoft Authenticator или 1Password', below: true,
            side: button('Перенести на другой телефон', { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => UI.toast('Откроется мастер с новым QR-кодом — как при регистрации. Старое приложение перестанет работать', 'refresh') }) }),
          item({ ic: 'key', title: 'Резервные коды', titleExtra: st.codesLeft < 4 ? chip('Осталось мало', 'warn', 'alert') : null, meta: st.codesLeft + ' из 8 не использованы · созданы ' + dateLong(st.codesCreated), below: true,
            side: button('Показать резервные коды', { kind: 'secondary', size: 'sm', icon: 'eye', onClick: codesModal }) })),
        h('hr', { class: 'divider' }),
        h('div', { class: 'stack', style: 'gap:10px' },
          h('div', { class: 'profile-section-title' }, h('h4', null, 'Ключи доступа (passkey)'), pk.length ? chip(pk.length + ' ' + pl(pk.length, 'ключ', 'ключа', 'ключей'), 'good', 'check') : chip('Не добавлены', 'outline')),
          h('p', { class: 'small soft' }, 'Вход по отпечатку пальца, Face ID или PIN-коду устройства — без пароля и кода. Ключ не украсть поддельной страницей: он привязан к адресу сайта.'),
          pk.length ? h('div', { class: 'profile-list' }, pk.map(k => item({ ic: 'key', title: k.name, meta: 'Добавлен ' + (k.added === TODAY ? 'сегодня' : dateLong(k.added)) + ' · еще не использовался',
            side: button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Удалить ключ «' + k.name + '»', onClick: () => { st.passkeys = st.passkeys.filter(x => x !== k); drawHero(); drawPanel(); UI.toast('Ключ доступа «' + k.name + '» удален', 'trash'); } }) }))) : null,
          h('div', { class: 'row' }, button('Добавить ключ доступа', { kind: 'secondary', icon: 'plus', onClick: passkeyModal }))),
        isAdmin()
          ? UI.callout('', 'lock', 'Для администратора 2FA обязательна, отключить ее нельзя. Потеряли телефон и резервные коды — сброс только командой ', mono('reset-2fa'), ' в терминале сервера.')
          : UI.callout('', 'lock', '2FA обязательна для всех. Потеряли телефон и резервные коды — напишите администратору: он сбросит 2FA, и вы настроите ее заново при следующем входе.'),
      ],
    });
  }

  function codesModal() {
    let step = 'confirm', note = null;
    const body = h('div', { class: 'stack' });
    const foot = h('div', { style: 'display:contents' });
    const m = UI.modal({ title: 'Резервные коды', body, actions: foot });
    function focusFirst() { setTimeout(() => { const i = body.querySelector('input') || foot.querySelector('.btn.primary'); if (i) i.focus(); }, 40); }
    function draw() {
      UI.clear(body); UI.clear(foot);
      if (step === 'confirm') {
        const pf = UI.field({ label: 'Пароль от аккаунта', id: 'profile-codes-pass', type: 'password', autocomplete: 'current-password', hint: 'В макете подойдет любой, кроме «wrong»' });
        UI.append(body, [
          h('p', { class: 'small soft' }, 'Коды открывают вход без телефона, поэтому сначала подтвердите, что это вы.'),
          h('form', { id: 'profile-codes-form', novalidate: true, on: { submit: e => {
            e.preventDefault();
            const v = valOf(pf);
            if (!v) return setFieldError(pf, 'Введите пароль');
            if (v === 'wrong') return setFieldError(pf, 'Пароль не подходит');
            step = 'codes'; draw();
          } } }, pf),
        ]);
        UI.append(foot, [button('Отмена', { kind: 'ghost', onClick: m.close }), button('Показать коды', { kind: 'primary', type: 'submit', icon: 'eye', attrs: { form: 'profile-codes-form' } })]);
      } else if (step === 'regen') {
        UI.append(body, [
          UI.callout('warn', 'alert', h('b', null, 'Старые 8 кодов перестанут работать сразу.'), ' Если они сохранены в менеджере паролей или на бумаге — замените их новыми.'),
          h('p', { class: 'small soft' }, 'Создавайте новые коды, если старые могли попасть к кому-то еще или почти закончились.'),
        ]);
        UI.append(foot, [button('Отмена', { kind: 'ghost', onClick: () => { step = 'codes'; draw(); } }), button('Создать новые коды', { kind: 'primary', icon: 'refresh', onClick: () => {
          st.codeSeed += 1; st.codes = makeCodes(st.codeSeed); st.codesLeft = 8; st.codesCreated = TODAY;
          note = 'Новые коды созданы. Старые больше не действуют.';
          step = 'codes'; draw(); drawHero(); if (st.tab === 'security') drawPanel();
          UI.toast('Созданы новые резервные коды', 'refresh');
        } })]);
      } else {
        UI.append(body, [
          note && UI.callout('good', 'check', note),
          h('p', { class: 'small soft' }, 'Каждый код срабатывает один раз. Храните их отдельно от телефона — в менеджере паролей или на бумаге.'),
          h('ol', { class: 'profile-codes', 'aria-label': 'Резервные коды' }, st.codes.map(c => h('li', null, c))),
          h('div', { class: 'xsmall muted' }, 'Созданы ' + (st.codesCreated === TODAY ? 'сегодня' : dateLong(st.codesCreated)) + ' · использовано ' + (8 - st.codesLeft) + ' из 8'),
        ]);
        UI.append(foot, [
          button('Сгенерировать заново', { kind: 'secondary', icon: 'refresh', onClick: () => { step = 'regen'; note = null; draw(); } }),
          button('Скопировать', { kind: 'ghost', icon: 'copy', onClick: () => { try { navigator.clipboard && navigator.clipboard.writeText(st.codes.join('\n')).catch(() => {}); } catch (e) { /* ок */ } UI.toast('8 кодов скопированы — вставьте их в менеджер паролей', 'copy'); } }),
          button('Готово', { kind: 'primary', onClick: m.close }),
        ]);
      }
      focusFirst();
    }
    draw();
  }

  function passkeyModal() {
    const nf = UI.field({ label: 'Название ключа', id: 'profile-pk-name', value: (PEOPLE[st.uid] || PEOPLE.u2).passkeyName, hint: 'Чтобы потом отличать ключи друг от друга' });
    const m = UI.modal({
      title: 'Новый ключ доступа',
      body: h('form', { id: 'profile-pk-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        h('p', { class: 'small soft' }, 'Браузер попросит подтвердить вход отпечатком пальца, Face ID или PIN-кодом устройства. Секретная часть ключа остается на устройстве — сервер хранит только публичную.'),
        nf),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Создать ключ', { kind: 'primary', type: 'submit', icon: 'key', attrs: { form: 'profile-pk-form', id: 'profile-pk-submit' } })],
    });
    function submit() {
      const v = valOf(nf).trim();
      if (!v) return setFieldError(nf, 'Дайте ключу название');
      const b = document.getElementById('profile-pk-submit');
      if (!b || b.disabled) return;
      busy(b, 'Подтвердите на устройстве…', 900, () => {
        st.passkeys.push({ name: v, added: TODAY }); m.close(); drawHero();
        if (st.tab === 'security') drawPanel();
        UI.toast('Ключ доступа «' + v + '» добавлен. Защита аккаунта: 4 из 4', 'key');
      });
    }
  }

  function sessionsCard() {
    const mobile = UI.isMobile();
    const list = st.sessions;
    const others = list.filter(s => !s.current);
    const confirmBox = h('div', { class: 'profile-confirm', hidden: true });
    const endBtn = others.length ? button('Выйти на всех других устройствах', { kind: 'secondary', icon: 'logout', onClick: () => { endBtn.hidden = true; confirmBox.hidden = false; const b = confirmBox.querySelector('.btn.danger'); if (b) b.focus(); } }) : null;
    function endSession(s) {
      st.sessions = st.sessions.filter(x => x !== s);
      drawHero(); drawPanel();
      UI.toast('Сеанс на ' + s.short + ' завершен', 'logout');
    }
    if (others.length) {
      UI.append(confirmBox, [
        UI.callout('warn', 'alert', 'Завершим ' + others.length + ' ' + pl(others.length, 'сеанс', 'сеанса', 'сеансов') + ': ' + others.map(s => s.short).join(', ') + '. Останется только этот — ' + currentSession().name + '.'),
        h('div', { class: 'row' },
          button('Да, завершить', { kind: 'danger', icon: 'logout', onClick: () => { st.sessions = st.sessions.filter(s => s.current); drawHero(); drawPanel(); UI.toast('Все другие сеансы завершены', 'logout'); } }),
          button('Отмена', { kind: 'ghost', onClick: () => { confirmBox.hidden = true; endBtn.hidden = false; endBtn.focus(); } })),
      ]);
    }
    return card({
      id: 'profile-sessions', class: 'profile-anchor', title: 'Активные сеансы', subtitle: 'Где сейчас открыт ваш аккаунт',
      body: h('div', { class: mobile ? 'profile-list' : 'profile-sessions' }, list.map(s => item({ below: !mobile,
        ic: s.ic, icKind: s.current ? 'good' : null, title: s.name, titleExtra: s.current ? chip('Этот сеанс', 'accent', 'check') : null,
        meta: [s.where, s.ip && h('span', { class: 'profile-ip' }, s.ip), s.seen].filter(Boolean).reduce((a, x, i) => a.concat(i ? [' · ', x] : [x]), []),
        side: s.current ? null : button('Завершить', { kind: mobile ? 'ghost' : 'secondary', size: 'sm', onClick: () => endSession(s), ariaLabel: 'Завершить сеанс: ' + s.name }),
      }))),
      foot: others.length ? [endBtn, confirmBox] : [h('span', { class: 'small muted' }, 'Других активных сеансов нет.')],
    });
  }

  function logCard() {
    const mobile = UI.isMobile();
    const rows = st.logFilter === 'fail' ? st.log.filter(r => r.result !== 'ok') : st.log;
    const sp = st.susp;
    const alert = st.suspicious && UI.callout('warn', 'alert', h('div', { class: 'stack', style: 'gap:8px' },
      h('div', null, h('b', null, dateDay(sp.at) + ' в ' + sp.at.slice(11, 16) + ' кто-то ввел верный пароль, но не прошел 2FA.'), ' ' + sp.device + ', ' + sp.place + ' (' + sp.ip + '). Вход не состоялся. Если это были не вы — пароль, скорее всего, утек: смените его.'),
      h('div', { class: 'row' },
        button('Сменить пароль', { kind: 'primary', size: 'sm', icon: 'lock', onClick: () => scrollToId('profile-password', '#profile-pass-cur') }),
        button('Это был я', { kind: 'ghost', size: 'sm', onClick: () => { st.suspicious = false; drawHero(); drawTabs(); drawPanel(); UI.toast('Отметили как ваш вход. Предупреждение скрыто', 'check'); } }))));
    const body = mobile
      ? h('ul', { class: 'profile-log', 'aria-label': 'Журнал входов' }, rows.map(r => h('li', null,
          h('div', { class: 'profile-log-top' }, h('span', { class: 'profile-log-when' }, when(r.at)), resultChip(r.result)),
          h('div', null, r.device),
          h('div', { class: 'muted' }, r.city, ' · ', h('span', { class: 'profile-ip' }, r.ip)))))
      : UI.table({
          columns: [
            { key: 'at', label: 'Время', render: r => h('span', { style: 'white-space:nowrap' }, when(r.at)) },
            { key: 'device', label: 'Устройство', render: r => h('span', { style: 'white-space:nowrap' }, r.device) },
            { key: 'ip', label: 'IP-адрес', render: r => h('span', { class: 'profile-ip' }, r.ip) },
            { key: 'city', label: 'Город', render: r => r.city },
            { key: 'result', label: 'Результат', render: r => resultChip(r.result) },
          ],
          rows, empty: 'Неудачных попыток нет',
        });
    return card({
      id: 'profile-log', class: 'profile-anchor', title: 'Журнал входов', subtitle: 'Последние 30 дней · пример записей',
      actions: [UI.segmented({ label: 'Какие входы показать', items: [{ id: 'all', label: 'Все' }, { id: 'fail', label: 'Неудачные' }], active: st.logFilter, onChange: id => { st.logFilter = id; drawPanel(); } })],
      body: [alert, h('div', { style: mobile ? null : 'margin: 0 -18px' }, body)],
      foot: [h('span', { class: 'xsmall muted' }, 'Храним 90 дней. IP показываем частично. О входе с нового устройства сообщаем на сайте и push.')],
    });
  }

  // =====================================================================
  // 3. БАНК И СТРАТЕГИЯ
  // =====================================================================
  function panelBank() {
    const mobile = UI.isMobile();
    const b = bankNow();
    const growth = (b - S.start) / S.start * 100;
    const dd = Math.min(0, (b - S.peak) / S.peak * 100);
    const tiles = h('div', { class: 'grid profile-tiles' },
      h('div', { class: 'col-3 half-mobile' }, UI.stat({ label: 'Стартовый банк', icon: 'wallet', value: fmt.money(S.start), hint: 'с ' + dateLong(D.bankHistory[0].date) })),
      h('div', { class: 'col-3 half-mobile' }, UI.stat({ label: 'Текущий банк', icon: 'coins', value: fmt.money(b), delta: fmt.signedPct(growth), trend: growth >= 0 ? 'up' : 'down', hint: 'к старту' })),
      h('div', { class: 'col-3 half-mobile' }, UI.stat({ label: 'В игре', icon: 'clock', value: fmt.money(inPlay()), hint: openBets().length + ' ' + pl(openBets().length, 'ставка', 'ставки', 'ставок') + ' · ' + fmt.pct(inPlay() / b * 100) + ' банка' })),
      h('div', { class: 'col-3 half-mobile' }, UI.stat({ label: 'От пика банка', icon: 'arrowDown', value: dd ? fmt.signedPct(dd) : '0%', hint: 'пик ' + fmt.money(S.peak) })));
    if (mobile) return h('div', { class: 'profile-panel' }, currencyNote(), tiles, responsibleCard(), booksCard(), strategyCard(), adaptCard(dd, growth), historyCard());
    return h('div', { class: 'profile-panel' }, currencyNote(), tiles,
      h('div', { class: 'grid' },
        h('div', { class: 'col-7 profile-col' }, strategyCard(), historyCard()),
        h('div', { class: 'col-5 profile-col' }, responsibleCard(), booksCard())),
      adaptCard(dd, growth));
  }

  function strategyCard() {
    const r = st.rules;
    const nf = (id, label, value, o = {}) => UI.field(Object.assign({ label, id: 'profile-r-' + id, value, inputmode: 'decimal', autocomplete: 'off' }, o));
    const F = {
      minProb: nf('prob', 'Мин. вероятность события', String(r.minProb), { suffix: '%' }),
      maxLegs: nf('legs', 'Событий в экспрессе, не больше', String(r.maxLegs), { inputmode: 'numeric' }),
      oddsMin: nf('omin', 'Кэф события от', fmt.odds(r.oddsMin)),
      oddsMax: nf('omax', 'Кэф события до', fmt.odds(r.oddsMax)),
      totalMax: nf('total', 'Итоговый кэф экспресса, не выше', fmt.odds(r.totalMax), { class: 'span-2', hint: 'При ' + r.maxLegs + ' событиях по ' + fmt.odds(r.oddsMax) + ' вышло бы ' + fmt.odds(Math.pow(r.oddsMax, r.maxLegs)) + ' — такие экспрессы ИИ урезает до меньшего числа событий' }),
    };
    const b = bankNow();
    const stakeRows = st.stakes.map((s, i) => {
      const money = h('div', { class: 'xsmall muted' });
      const inp = (key, label) => {
        const el = h('input', { class: 'input has-suffix', id: 'profile-stake-' + i + '-' + key, value: dec(s[key]), inputmode: 'decimal', autocomplete: 'off', 'aria-label': label + ', % банка, итоговый кэф ' + s.range });
        return { el, wrap: h('div', { class: 'input-wrap' }, el, h('span', { class: 'input-suffix', 'aria-hidden': 'true' }, '%')) };
      };
      const lo = inp('min', 'От'), hi = inp('max', 'До');
      const upd = () => { const a = num(lo.el.value), c = num(hi.el.value); UI.clear(money); UI.append(money, isFinite(a) && isFinite(c) ? ['Сейчас это ', h('span', { style: 'white-space:nowrap' }, moneyBare(roundStake(b * a / 100)) + '–' + fmt.money(roundStake(b * c / 100)))] : 'Введите проценты'); };
      upd();
      [lo.el, hi.el].forEach(el => el.addEventListener('input', upd));
      return { row: h('div', { class: 'profile-stake' }, h('div', { style: 'min-width:0' }, h('div', { class: 'profile-stake-range' }, s.range), money), h('div', { class: 'profile-stake-inputs' }, lo.wrap, h('span', { 'aria-hidden': 'true' }, '–'), hi.wrap)), lo, hi };
    });
    const risk = h('div', { 'aria-live': 'polite' });
    const save = button('Сохранить правила', { kind: 'primary', type: 'submit', icon: 'check', disabled: true });
    const reset = button('Вернуть как было', { kind: 'ghost', attrs: { hidden: true }, onClick: () => { drawPanel(); UI.toast('Изменения отменены', 'refresh'); } });
    function read() {
      return {
        minProb: num(valOf(F.minProb)), maxLegs: num(valOf(F.maxLegs)), oddsMin: num(valOf(F.oddsMin)), oddsMax: num(valOf(F.oddsMax)), totalMax: num(valOf(F.totalMax)),
        stakes: stakeRows.map((x, i) => ({ range: st.stakes[i].range, min: num(x.lo.el.value), max: num(x.hi.el.value) })),
      };
    }
    function checkRisk() {
      const v = read(), why = [];
      if (v.minProb < 60) why.push('порог вероятности ниже 60%');
      if (v.maxLegs > 3) why.push('больше 3 событий в экспрессе');
      if (v.totalMax > 3.5) why.push('итоговый кэф выше 3.50');
      if (v.oddsMax > 2) why.push('кэф события выше 2.00');
      if (v.stakes.some(s => s.max > 3)) why.push('ставка больше 3% банка');
      UI.clear(risk);
      if (why.length) risk.appendChild(UI.callout('warn', 'alert', h('b', null, 'Правила стали рискованнее: '), why.join(', ') + '. ', 'Модель проверена на истории с правилами ' + activeVersion.name.split(' · ')[0] + ' — на новых ее оценка ROI менее надежна. Сначала прогоните их на истории в разделе ', h('a', { href: '#learning' }, 'Обучение модели'), '.'));
    }
    const roundText = 'до ' + fmt.money(fmt.fromMoney(isRub() ? 10 : 1));
    return formCard({
      id: 'profile-strategy', title: 'Правила стратегии',
      subtitle: h('span', null, 'Действует ', h('a', { href: '#learning' }, activeVersion.name), ' · ИИ не предложит событие вне этих рамок'),
      body: [
        h('div', { class: 'profile-fields bottom' }, F.minProb, F.maxLegs, F.oddsMin, F.oddsMax, F.totalMax),
        h('hr', { class: 'divider' }),
        h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'profile-section-title' }, h('h4', null, 'Ставка по итоговому кэфу'), h('span', { class: 'xsmall muted' }, '% от банка ' + fmt.money(b))),
          h('div', { class: 'profile-stakes' }, stakeRows.map(x => x.row)),
          h('div', { class: 'profile-section-title', style: 'margin-top:6px' }, h('h4', null, 'Поправка на валуй'), h('span', { class: 'xsmall muted' }, 'средний перевес ног экспресса')),
          h('dl', { class: 'profile-value', 'aria-label': 'Поправка ставки на валуй, в процентах банка' }, VALUE_ADJ.map(x => h('div', null, h('dt', null, x.t, h('small', null, x.d)), h('dd', null, x.v)))),
          h('p', { class: 'xsmall muted' }, 'Чем выше итоговый кэф, тем меньше ставка. Внутри диапазона берется середина, затем поправка на валуй и адаптации ниже; суммы округляются ' + roundText + '.')),
        risk,
      ],
      foot: [save, reset],
      onInput: () => { save.disabled = false; reset.hidden = false; checkRisk(); [F.minProb, F.maxLegs, F.oddsMin, F.oddsMax, F.totalMax].forEach(f => setFieldError(f, null)); },
      onSubmit: () => {
        const v = read();
        let ok = true;
        if (!(v.minProb >= 50 && v.minProb <= 95)) ok = setFieldError(F.minProb, 'От 50 до 95%');
        if (!(Number.isInteger(v.maxLegs) && v.maxLegs >= 1 && v.maxLegs <= 5)) ok = setFieldError(F.maxLegs, 'Целое число от 1 до 5');
        if (!(v.oddsMin >= 1.01)) ok = setFieldError(F.oddsMin, 'Кэф не меньше 1.01');
        if (!(v.oddsMax > v.oddsMin)) ok = setFieldError(F.oddsMax, 'Должен быть больше нижней границы');
        if (!(v.totalMax >= v.oddsMin)) ok = setFieldError(F.totalMax, 'Не меньше кэфа события');
        const badStake = v.stakes.findIndex(s => !(s.min > 0 && s.max >= s.min && s.max <= 5));
        if (badStake >= 0) { ok = false; UI.toast('Проверьте ставку для кэфа ' + v.stakes[badStake].range + ': от 0 до 5%, «от» не больше «до»', 'alert'); }
        if (!ok) return;
        const was = st.rules, diff = [];
        if (v.minProb !== was.minProb) diff.push('мин. вероятность ' + was.minProb + '% → ' + v.minProb + '%');
        if (v.maxLegs !== was.maxLegs) diff.push('событий до ' + v.maxLegs);
        if (v.oddsMin !== was.oddsMin || v.oddsMax !== was.oddsMax) diff.push('кэф события ' + fmt.odds(v.oddsMin) + '–' + fmt.odds(v.oddsMax));
        if (v.totalMax !== was.totalMax) diff.push('итоговый кэф до ' + fmt.odds(v.totalMax));
        if (v.stakes.some((x, i) => x.min !== st.stakes[i].min || x.max !== st.stakes[i].max)) diff.push('таблица ставок');
        st.ruleEdits.unshift({ at: new Date().toTimeString().slice(0, 5), what: diff.length ? diff.join(', ') : 'без изменений в цифрах' });
        st.rules = { minProb: v.minProb, maxLegs: v.maxLegs, oddsMin: v.oddsMin, oddsMax: v.oddsMax, totalMax: v.totalMax };
        st.stakes = v.stakes;
        drawPanel();
        UI.toast('Правила сохранены и записаны в историю стратегии. ИИ применит их со следующего анализа', 'check');
      },
    });
  }

  function historyCard() {
    const VST = { active: ['Действует', 'good', 'check'], candidate: ['Кандидат', 'info', 'flask'], archived: ['Архив', 'outline', null] };
    const versions = D.strategyVersions.slice().reverse();
    return card({
      id: 'profile-history', class: 'profile-anchor', title: 'История стратегии',
      subtitle: 'Каждая правка правил и инструкций сохраняется — можно сравнить и откатить',
      body: h('div', { class: 'profile-list' },
        st.ruleEdits.map(e => item({ ic: 'edit', icKind: 'good', title: 'Правила изменены вами', titleExtra: chip('Не проверено на истории', 'warn', 'alert'), meta: 'Сегодня, ' + e.at + ' · ' + e.what, below: true })),
        versions.map(v => item({
          mark: v.id, title: (s => s.charAt(0).toUpperCase() + s.slice(1))(v.name.split(' · ')[1] || v.name), titleExtra: chip(VST[v.status][0], VST[v.status][1], VST[v.status][2]),
          meta: dateLong(v.date) + ' · лог-лосс ' + fmt.dec(v.logloss, 3) + ' · Brier ' + fmt.dec(v.brier, 3) + ' на ' + v.n + ' событиях',
          icKind: v.status === 'active' ? 'good' : null,
        }))),
      foot: [button('Сравнить версии', { kind: 'secondary', icon: 'layers', href: '#learning' }), h('span', { class: 'xsmall muted' }, 'Кандидата принимаете вы, после проверки на истории')],
    });
  }

  function adaptCard(dd, growth) {
    const ddAbs = Math.abs(dd), max = 25;
    const GROUPS = [
      { id: 'bank', title: 'Банк', rules: [
        { id: 'dd10', t: 'Банк −10% от пика → ставка не больше 2,5%', d: 'Пока банк не поднимется выше этой отметки', active: dd <= -10, now: 'Сейчас ' + fmt.signedPct(dd) + ' от пика' },
        { id: 'dd20', t: 'Банк −20% от пика → защитный режим', d: 'Только 2 события, кэф события ≤ 1.50, ставка 1,5% банка', active: dd <= -20, now: 'Сейчас ' + fmt.signedPct(dd) + ' от пика' },
        { id: 'up15', t: 'Банк +15% к старту и винрейт ≥ 60% → ставка до 4%', d: 'Потолок поднимается с 3% до 4%, пока выполнены оба условия', active: growth >= 15 && S.winrate >= 60, now: 'Сейчас банк ' + fmt.signedPct(growth) + ', винрейт ' + fmt.pct(S.winrate) },
      ] },
      { id: 'week', title: 'Итог недели', rules: [
        { id: 'weekLoss', t: 'Убыточная неделя (−5% и больше) → ставка не больше 2%', d: 'Считаем по банку за последние 7 дней', active: weekPct <= -5, now: 'За 7 дней ' + fmt.signedPct(weekPct) },
        { id: 'weekWin', t: 'Прибыльная неделя (+10% и больше) → ставка +0,5%', d: 'К проценту из таблицы, но не выше потолка', active: weekPct >= 10, now: 'За 7 дней ' + fmt.signedPct(weekPct) },
      ] },
    ];
    const RULES = GROUPS.reduce((a, g) => a.concat(g.rules), []);
    const ruleChip = r => !st.adapt[r.id] ? chip('Выключено', 'outline', 'pause') : r.active ? chip('Действует сейчас', 'warn', 'bolt') : chip('Ждет условия', 'outline', 'clock');
    const anyActive = RULES.some(r => r.active && st.adapt[r.id]);
    const ruleRow = r => {
      const id = 'profile-rule-' + r.id;
      const chipSlot = h('span', null, ruleChip(r));
      return h('div', { class: 'profile-rule' },
        h('label', { class: 'profile-rule-text', for: id }, h('span', { class: 'profile-rule-title' }, r.t), h('span', { class: 'profile-rule-hint' }, r.d)),
        switchInput(id, st.adapt[r.id], r.t, v => {
          st.adapt[r.id] = v; UI.clear(chipSlot).appendChild(ruleChip(r));
          UI.toast((v ? 'Правило включено: ' : 'Правило выключено: ') + r.t, v ? 'check' : 'pause');
        }),
        h('div', { class: 'profile-rule-status' }, chipSlot, h('span', { class: 'xsmall muted' }, r.now)));
    };
    return card({
      id: 'profile-adapt', class: 'profile-anchor', title: 'Адаптации ставки', subtitle: 'Меняют размер ставки по просадке от пика, росту банка и итогу недели · правил серий нет (Р22)',
      body: [
        h('div', { class: 'profile-dd' },
          h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Просадка от пика ' + fmt.money(S.peak)), h('b', { class: 'num' }, fmt.signedPct(dd))),
          h('div', { class: 'profile-dd-track', role: 'meter', 'aria-label': 'Просадка от пика банка', 'aria-valuenow': ddAbs.toFixed(1), 'aria-valuemin': 0, 'aria-valuemax': max },
            h('i', { class: ['profile-dd-fill', ddAbs >= 20 ? 'bad' : ddAbs >= 10 ? 'warn' : null], style: { width: Math.min(100, ddAbs / max * 100) + '%' } }),
            h('span', { class: 'profile-dd-mark', style: { left: (10 / max * 100) + '%' } }),
            h('span', { class: 'profile-dd-mark', style: { left: (20 / max * 100) + '%' } })),
          h('div', { class: 'profile-dd-scale', 'aria-hidden': 'true' }, h('span', { style: 'left:0' }, '0%'), h('span', { style: { left: (10 / max * 100) + '%' } }, '−10%'), h('span', { style: { left: (20 / max * 100) + '%' } }, '−20%')),
          h('div', { class: 'xsmall muted' }, anyActive
            ? 'Сейчас действует хотя бы одно правило — ставки в новых анализах изменены.'
            : 'Просадка ' + fmt.signedPct(dd) + ', банк ' + fmt.signedPct(growth) + ' к старту, за 7 дней ' + fmt.signedPct(weekPct) + ': ни одно правило сейчас не действует.')),
        h('div', { class: 'profile-rule-groups' }, GROUPS.map(g => h('div', { class: 'profile-rule-group', role: 'group', 'aria-labelledby': 'profile-rg-' + g.id },
          h('div', { class: 'profile-rule-group-head' }, h('h4', { id: 'profile-rg-' + g.id }, g.title)),
          g.rules.map(ruleRow)))),
      ],
    });
  }

  function responsibleCard() {
    // лимиты дня считают все ставки, сделанные сегодня, — и в игре, и уже рассчитанные
    const todayN = todayBets().length, todaySum = todayBets().reduce((a, x) => a + x.stake, 0);
    const L = st.limits;
    const cF = UI.field({ label: 'Ставок в день, не больше', id: 'profile-lim-count', value: String(L.count), inputmode: 'numeric', autocomplete: 'off' });
    const aF = UI.field({ label: 'Сумма ставок в день', id: 'profile-lim-amount', value: moneyInput(L.amount), suffix: fmt.cur(), inputmode: 'decimal', autocomplete: 'off' });
    const usage = (label, val, max, text) => {
      const m = UI.meter(val, max, val >= max ? 'bad' : val / max >= 0.75 ? 'warn' : null);
      m.setAttribute('aria-label', label);
      return h('div', null, h('div', { class: 'row-between', style: 'gap:6px' }, h('span', null, label), h('b', null, text)), m);
    };
    const end = addDays(TODAY, +st.pauseDays);
    const confirmBox = st.pauseConfirm && h('div', { class: 'profile-confirm' },
      UI.callout('warn', 'alert', h('b', null, 'Пауза до ' + dateLong(end) + ' включительно. '), 'Отменить ее досрочно будет нельзя — ни вам, ни администратору.'),
      h('div', { class: 'row' },
        button('Да, взять паузу', { kind: 'primary', icon: 'pause', onClick: () => { st.pause = { days: +st.pauseDays, until: end }; st.pauseConfirm = false; drawHero(); drawPanel(); UI.toast('Пауза до ' + dateDay(end) + '. Новые анализы и ставки недоступны', 'pause'); } }),
        button('Отмена', { kind: 'ghost', onClick: () => { st.pauseConfirm = false; drawPanel(); } })));
    const pauseBlock = st.pause
      ? h('div', { class: 'stack', style: 'gap:10px' },
          UI.callout('accent', 'pause', h('b', null, 'Пауза до ' + dateLong(st.pause.until) + '. '), 'ИИ не формирует экспрессы, «Новый анализ» и ставки недоступны, уведомления о матчах выключены. Результаты уже открытых ставок придут как обычно.'),
          h('div', { class: 'row' }, button('Снять паузу (только в макете)', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => { st.pause = null; drawHero(); drawPanel(); UI.toast('Пауза снята — в рабочей версии так сделать нельзя', 'info'); } })))
      : h('div', { class: 'stack', style: 'gap:10px' },
          h('p', { class: 'small soft' }, 'На время паузы ИИ не формирует экспрессы, новый анализ недоступен, уведомления о матчах выключены. Досрочно не отменяется.'),
          UI.segmented({ label: 'Длительность паузы', items: [{ id: '1', label: '1 день' }, { id: '7', label: '7 дней' }, { id: '30', label: '30 дней' }, { id: '90', label: '90 дней' }], active: st.pauseDays, onChange: id => { st.pauseDays = id; st.pauseConfirm = false; drawPanel(); } }),
          confirmBox || h('div', { class: 'row' }, button('Взять паузу на ' + st.pauseDays + ' ' + pl(+st.pauseDays, 'день', 'дня', 'дней'), { kind: 'secondary', icon: 'pause', onClick: () => { st.pauseConfirm = true; drawPanel(); setTimeout(() => { const b = document.querySelector('#profile-rg .profile-confirm .btn.primary'); if (b) b.focus(); }, 30); } })));
    const P = st.limitsPending;
    return formCard({
      id: 'profile-rg', class: 'profile-rg', eyebrow: 'Важно', title: 'Ответственная игра',
      subtitle: 'Ограничения, которые не обходятся ни в азарте, ни по совету ИИ',
      actions: [st.pause ? chip('Пауза', 'warn', 'pause') : chip('Лимиты включены', 'good', 'shield')],
      body: [
        h('div', { class: 'profile-usage' },
          usage('Ставок сегодня', todayN, L.count, todayN + ' из ' + L.count),
          usage('Сумма сегодня', todaySum, L.amount, moneyBare(todaySum) + ' из ' + fmt.money(L.amount))),
        h('div', { class: 'profile-fields bottom' }, cF, aF),
        h('p', { class: 'xsmall muted' }, 'При достижении лимита кнопка «Сохранить ставку» блокируется до полуночи по вашему времени. Понизить лимит можно сразу, повысить — через 24 часа после запроса.'),
        P && UI.callout('info', 'clock', h('div', { class: 'stack', style: 'gap:8px' },
          h('div', null, 'Запрошено повышение: ' + [P.count && 'до ' + P.count + ' ' + pl(P.count, 'ставки', 'ставок', 'ставок'), P.amount && 'до ' + fmt.money(P.amount)].filter(Boolean).join(' и ') + ' в день. Вступит в силу ' + dateDay(addDays(TODAY, 1)) + ', через 24 часа.'),
          h('div', { class: 'row' }, button('Отменить запрос', { kind: 'ghost', size: 'sm', onClick: () => { st.limitsPending = null; drawPanel(); UI.toast('Запрос на повышение лимита отменен', 'x'); } })))),
        h('hr', { class: 'divider' }),
        h('h4', null, 'Пауза от ставок'),
        pauseBlock,
      ],
      foot: [button('Сохранить лимиты', { kind: 'secondary', type: 'submit', icon: 'check' })],
      onInput: e => { if (e && e.target && (e.target.id === 'profile-lim-count' || e.target.id === 'profile-lim-amount')) { setFieldError(cF, null); setFieldError(aF, null); } },
      onSubmit: () => {
        const c = num(valOf(cF)), a = num(valOf(aF)); // a — в валюте программы
        let ok = true;
        if (!(Number.isInteger(c) && c >= 1 && c <= 20)) ok = setFieldError(cF, 'Целое число от 1 до 20');
        if (!(a > 0)) ok = setFieldError(aF, 'Введите сумму больше нуля');
        if (!ok) return;
        const pending = {}, down = [];
        const aNow = fmt.moneyNum(L.amount); // сравниваем в валюте программы, чтобы округление не меняло лимит
        if (c < L.count) { L.count = c; down.push('ставок'); } else if (c > L.count) pending.count = c;
        if (a < aNow) { L.amount = fmt.fromMoney(a); down.push('суммы'); } else if (a > aNow) pending.amount = fmt.fromMoney(a);
        st.limitsPending = Object.keys(pending).length ? pending : null;
        drawPanel();
        if (st.limitsPending) UI.toast('Повышение лимита вступит в силу через 24 часа' + (down.length ? '; снижение уже действует' : ''), 'clock');
        else if (down.length) UI.toast('Лимит снижен и уже действует', 'shield');
        else UI.toast('Лимиты не изменились', 'info');
      },
    });
  }

  function booksCard() {
    const list = books();
    const sum = list.reduce((a, b) => a + b.balance, 0);
    const diff = sum - bankNow();
    const same = fmt.moneyNum(diff) === 0;
    return card({
      id: 'profile-books', class: 'profile-anchor', title: 'Мои букмекеры', subtitle: 'Список ведете вы сами · балансы сверяйте раз в неделю',
      body: [
        list.length ? h('div', { class: 'profile-list' }, list.map(b => item({
          mark: b.mark, title: b.name, wrap: true,
          titleExtra: b.name === BENCHMARK ? chip('Эталон для CLV', 'info', 'target') : null,
          meta: b.bets + ' ' + pl(b.bets, 'ставка', 'ставки', 'ставок') + (b.inPlay ? ' · в игре ' + fmt.money(b.inPlay) : '') + ' · ' + (!b.checked ? 'баланс не сверен' : 'сверено ' + (b.checked === TODAY ? 'сегодня' : dateDay(b.checked).replace(' ', ' '))),
          side: [h('span', { class: 'profile-money' }, fmt.money(b.balance)),
            button('', { kind: 'ghost', size: 'sm', icon: 'edit', title: 'Сверить баланс ' + b.name, onClick: () => bookModal(b) }),
            button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Удалить ' + b.name + ' из списка', onClick: () => bookDeleteModal(b) })],
        }))) : UI.empty('Список пуст. Добавьте букмекеров, у которых лежит банк.'),
        h('div', { class: 'row-between', style: 'padding-top:10px;border-top:1px solid var(--line)' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'small soft' }, 'Сумма балансов'), h('div', { class: 'profile-money', style: 'font-size:var(--fs-lg)' }, fmt.money(sum))),
          same ? chip('Сходится с учетом', 'good', 'check') : chip('Расхождение ' + fmt.signedMoney(diff), 'warn', 'alert')),
        !same && UI.callout('warn', 'info', h('div', { class: 'stack', style: 'gap:8px' },
          h('div', null, 'Балансы у букмекеров на ' + fmt.money(Math.abs(diff)) + (diff > 0 ? ' больше' : ' меньше') + ', чем банк в учете (' + fmt.money(bankNow()) + '). Это ' + (diff > 0 ? 'пополнение' : 'вывод') + ' или ставка мимо приложения?'),
          h('div', { class: 'row' }, button('Учесть как ' + (diff > 0 ? 'пополнение' : 'вывод'), { kind: 'secondary', size: 'sm', onClick: () => { st.bankAdj += diff; drawPanel(); UI.toast((diff > 0 ? 'Пополнение ' : 'Вывод ') + fmt.signedMoney(diff) + ' записан в историю банка. В ROI не входит', 'wallet'); } })))),
        h('p', { class: 'profile-note' }, icon('target'), h('span', null, 'Эталон рынка для CLV — кэф ' + BENCHMARK + ': с его закрывающей линией сравниваем ваши кэфы, даже если вы там не ставите. Этот же список — в выборе букмекера в «Новом анализе» и при сохранении ставки.')),
      ],
      foot: [button('Добавить букмекера', { kind: 'secondary', icon: 'plus', onClick: () => bookModal(null) })],
    });
  }

  function bookModal(b) {
    const isNew = !b;
    const nameF = isNew && UI.field({ label: 'Букмекер', id: 'profile-bk-name', placeholder: 'Например, Betfair', autocomplete: 'off' });
    const balF = UI.field({ label: isNew ? 'Баланс сейчас' : 'Баланс в ' + b.name, id: 'profile-bk-bal', value: isNew ? '' : moneyInput(b.balance), suffix: fmt.cur(), inputmode: 'decimal', autocomplete: 'off',
      hint: isNew ? 'Сумма на счете, включая нерассчитанные ставки' : 'Сверьте с личным кабинетом букмекера. Включая ставки в игре' + (b.inPlay ? ': ' + fmt.money(b.inPlay) : '') });
    const m = UI.modal({
      title: isNew ? 'Новый букмекер' : 'Сверка баланса',
      body: h('form', { id: 'profile-bk-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } }, nameF, balF),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button(isNew ? 'Добавить' : 'Сохранить баланс', { kind: 'primary', type: 'submit', icon: 'check', attrs: { form: 'profile-bk-form' } })],
    });
    function submit() {
      let ok = true;
      const v = num(valOf(balF)); // в валюте программы
      const name = isNew ? valOf(nameF).trim() : b.name;
      if (isNew && !name) ok = setFieldError(nameF, 'Укажите название');
      else if (isNew && /^другой$/i.test(name)) ok = setFieldError(nameF, '«Другой» уже есть в выборе при анализе — укажите название букмекера');
      else if (isNew && myBooks().some(x => x.toLowerCase() === name.toLowerCase())) ok = setFieldError(nameF, name + ' уже есть в списке');
      if (!(v >= 0)) ok = setFieldError(balF, 'Введите сумму числом, например 250');
      if (!ok) return;
      const rub = Math.round(fmt.fromMoney(v));
      st.bookInfo[name] = Object.assign(st.bookInfo[name] || { mark: bookMark(name) }, { base: rub - sessionProfit(name), checked: TODAY });
      if (isNew) myBooks().push(name); // DATA.user.bookmakers — его читает «Новый анализ»
      m.close(); drawPanel();
      UI.toast(isNew ? name + ' добавлен' : 'Баланс ' + name + ' сверен: ' + fmt.money(rub), 'wallet');
    }
  }

  function bookDeleteModal(b) {
    const open = BOOK_OPEN(b.name).length;
    if (open) {
      UI.modal({
        title: 'Пока нельзя удалить ' + b.name,
        body: h('p', { class: 'small soft' }, 'В игре ' + open + ' ' + pl(open, 'ставка', 'ставки', 'ставок') + ' у ' + b.name + ' на ' + fmt.money(b.inPlay) + '. Удалить букмекера из списка можно после расчета.'),
        actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
      });
      return;
    }
    UI.modal({
      title: 'Удалить ' + b.name + ' из списка?',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small soft' }, 'Букмекер пропадет из списка и из выбора в «Новом анализе» и при сохранении ставки. История ставок у него (' + b.bets + ') останется.'),
        b.balance ? UI.callout('warn', 'alert', 'Баланс ' + fmt.money(b.balance) + ' перестанет учитываться в сверке. Если деньги выведены, учтите это как вывод.') : null,
        b.name === BENCHMARK ? UI.callout('info', 'target', 'Эталоном для CLV кэф ' + BENCHMARK + ' останется: для него счет у букмекера не нужен.') : null),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Удалить', { kind: 'danger', icon: 'trash', onClick: () => { const L = myBooks(), i = L.indexOf(b.name); if (i >= 0) L.splice(i, 1); delete st.bookInfo[b.name]; close(); drawPanel(); UI.toast(b.name + ' удален из списка. История ставок осталась', 'trash'); } })],
    });
  }

  // =====================================================================
  // 4. КЛЮЧ CLAUDE (решения Р7, Р12, Р13; docs/CLAUDE_API_KEY.md)
  // =====================================================================
  function panelKey() {
    const view = st.keyView, mode = keyMode(), k = ownKey();
    let main;
    if (view === 'admin') main = mode === 'admin' ? (isAdmin() ? adminOwnerCard() : adminKeyCard()) : returnCard();
    else main = mode === 'own' && k && !st.keyReplace ? ownKeyCard() : ownSetupCard();
    return h('div', { class: 'profile-panel' },
      isAdmin() && UI.callout('accent', 'admin', h('div', { class: 'row-between', style: 'gap:6px 12px' },
        h('span', { style: 'min-width:0;flex:1 1 280px' }, h('b', null, 'Вы администратор: '), 'ваш ключ — это ключ администратора, им управляют в «Администрирование → Ключ и бюджет».'),
        h('a', { href: '#admin-key', style: 'font-weight:600' }, 'Открыть'))),
      modeCard(),
      h('div', { class: 'grid' },
        h('div', { class: 'col-7 profile-col' }, main),
        h('div', { class: 'col-5 profile-col' }, guideCard(), storageCard())));
  }

  function modeCard() {
    const actual = keyMode(), adm = isAdmin(), req = me().returnRequested;
    const opts = [
      { id: 'admin', title: 'Ключ администратора', text: adm
        ? 'Ключ программы. Ваши анализы идут в общий бюджет ' + usd(D.ai.budget().monthly, 0) + ' в месяц, личного лимита нет.'
        : 'Ничего вводить не нужно. Платит администратор, у вас лимит ' + usd(memberLimit().monthly, 0) + ' в месяц.' },
      { id: 'own', title: 'Свой ключ', text: adm
        ? 'Администратору свой ключ не нужен: его анализы всегда идут на ключе администратора.'
        : 'Ваш ключ Anthropic. Расход — с вашего счета, лимит трат ставите сами в консоли Anthropic.' },
    ];
    const group = h('div', { class: 'profile-modes', role: 'radiogroup', 'aria-label': 'Чей ключ Claude использовать' }, opts.map(o => {
      const on = st.keyView === o.id;
      // Этап 3: администратор всегда на ключе администратора (свой ключ — только у участников)
      const locked = adm && o.id === 'own' && actual !== 'own';
      const inp = h('input', { type: 'radio', name: 'profile-key-mode', id: 'profile-mode-' + o.id, value: o.id, checked: on, disabled: locked, class: 'profile-mode-input', on: { change: () => {
        st.keyView = o.id; st.keyErr = null; st.keyDelConfirm = false; if (o.id === 'admin') st.keyReplace = false;
        drawPanel();
        requestAnimationFrame(() => { const el = document.getElementById('profile-mode-' + o.id); if (el) el.focus({ preventScroll: true }); });
      } } });
      return h('label', { class: ['profile-mode', on && 'is-on', locked && 'is-locked'], for: inp.id, style: locked ? 'opacity:.6;cursor:not-allowed' : null }, inp,
        h('span', { class: 'profile-mode-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'profile-mode-body' },
          h('span', { class: 'profile-mode-title' }, o.title,
            actual === o.id && chip('Действует', 'good', 'check'),
            o.id === 'admin' && actual === 'own' && req && chip('Запрос отправлен', 'info', 'clock')),
          h('span', { class: 'profile-mode-text' }, o.text)));
    }));
    return card({
      id: 'profile-key-mode', class: 'profile-anchor', title: 'Чей ключ Claude использовать',
      subtitle: 'Ключ нужен для анализов, разборов ставок и обновления ваших данных',
      body: [group,
        h('p', { class: 'profile-note' }, icon('info'), h('span', null, adm
          ? 'Вы администратор: ваши анализы идут на ключе администратора, без личного лимита — только в рамках общего бюджета.'
          : 'На свой ключ можно перейти в любой момент. Вернуться на ключ администратора — только с его разрешения.'))],
    });
  }

  function fact(label, value, sub) { return h('div', null, h('dt', null, label), h('dd', null, value, sub && h('small', null, sub))); }

  // Участник на ключе администратора: лимит, расход, что будет на 80% и 100%
  function adminKeyCard() {
    const s = limitState(), L = s.L, today = me().todayAnalyses || 0;
    const why = D.ai.access(me()); // та же причина, что в «Новом анализе»: пауза, анализы на сегодня, лимит, общий бюджет
    const chipNow = s.paused ? chip('Анализы на паузе — решение администратора', 'warn', 'pause')
      : s.stopped ? chip('Анализы остановлены', 'bad', 'pause') : s.warned ? chip('Больше ' + s.alertAt + '% лимита', 'warn', 'alert') : chip('Подключено', 'good', 'check');
    return card({
      id: 'profile-key-admin', class: 'profile-anchor', title: 'Ключ администратора', subtitle: 'Расход за ' + D.ai.month + ' · обновляется после каждого запуска',
      actions: [chipNow],
      body: [
        h('p', { class: 'profile-keyline' }, 'Подключено к ключу администратора · ваш лимит ', h('b', null, usd(L.monthly, 0) + ' в месяц'), ' · израсходовано ', h('b', null, usd(s.spent)), ' · осталось ', h('b', null, usd(s.left))),
        limitBar(s.spent, L.monthly, s.alertAt, 'Расход лимита на ИИ за ' + D.ai.month),
        s.paused ? UI.callout('warn', 'pause', h('b', null, 'Новые анализы на ключе администратора не запускаются, пока он не снимет паузу. '), 'Расход за ' + D.ai.month + ' сохраняется. Можно перейти на свой ключ — это сразу.')
          : s.stopped ? UI.callout('bad', 'pause', h('b', null, 'Лимит исчерпан — анализы остановлены до решения администратора. '), 'Он может поднять лимит. Или перейдите на свой ключ — это можно сразу.')
          : why ? UI.callout('warn', 'alert', h('b', null, why + '. '), /^На сегодня/.test(why) ? 'Новые — после полуночи по вашему времени.' : 'Решение за администратором. Или перейдите на свой ключ — это сразу.') : null,
        h('dl', { class: 'profile-kfacts' },
          fact('Анализов сегодня', today + ' из ' + L.daily, 'счет с полуночи'),
          fact('Потолок на анализ', usd(L.perAnalysis, 0), 'дороже — остановится'),
          fact('Средний анализ', '≈ ' + usd(avgAnalysis), 'за ' + D.ai.month)),
        h('div', { class: 'stack', style: 'gap:10px' },
          h('h4', null, 'Что будет при 80% и 100%'),
          h('ul', { class: 'profile-thr' },
            h('li', null, h('span', { class: 'profile-thr-badge warn' }, s.alertAt + '%'), h('span', null, h('b', null, usd(L.monthly * s.alertAt / 100, 0) + ' — уведомление'), ' вам и администратору, на сайте и push. Анализы работают как обычно.')),
            h('li', null, h('span', { class: 'profile-thr-badge bad' }, '100%'), h('span', null, h('b', null, usd(L.monthly, 0) + ' — анализы останавливаются'), ' до решения администратора: он может поднять лимит. Или перейдите на свой ключ.')))),
        h('p', { class: 'profile-note' }, icon('lock'), h('span', null, 'Лимит меняет администратор. С 1 ноября расход начнется заново.')),
      ],
      foot: [button('Подробнее в «ИИ и расходы»', { kind: 'secondary', icon: 'coins', href: '#costs' })],
    });
  }

  // Администратор на своем ключе программы: общий бюджет и свой расход
  function adminOwnerCard() {
    const A = D.admin, B = D.ai.budget();
    return card({
      id: 'profile-key-admin', class: 'profile-anchor', title: 'Ключ администратора', subtitle: 'Ваши анализы идут на нем без личного лимита',
      actions: [A.key.status === 'ok' ? chip('Работает', 'good', 'check') : chip('Нужна проверка', 'warn', 'alert')],
      body: [
        h('div', { class: 'profile-secret' }, icon('key'), h('code', { 'aria-label': 'Ключ, последние символы ' + A.key.last4.split('').join(' ') }, 'sk-ant-…' + A.key.last4), h('span', { class: 'xsmall muted' }, 'проверен ' + lower1(when(A.key.verified)))),
        h('p', { class: 'profile-keyline' }, 'Общий бюджет ключа ', h('b', null, usd(B.monthly, 0) + ' в месяц'), ' · израсходовано ', h('b', null, usd(B.spent)), ' · осталось ', h('b', null, usd(B.left))),
        limitBar(B.spent, B.monthly, B.alertAt, 'Расход общего бюджета ключа за ' + D.ai.month),
        h('dl', { class: 'profile-kfacts' },
          fact('Ваш расход', usd(keySpent()), 'за ' + D.ai.month),
          fact('Анализов сегодня', String(me().todayAnalyses || 0), 'без ограничения'),
          fact('Средний анализ', '≈ ' + usd(avgAnalysis), 'за ' + D.ai.month)),
        h('p', { class: 'xsmall muted' }, 'В общий бюджет входят участники на ключе администратора и общие фоновые задачи (' + usd(B.shared) + ' за ' + D.ai.month + '). Участники на своем ключе платят сами.'),
      ],
      foot: [button('ИИ и расходы', { kind: 'secondary', icon: 'coins', href: '#costs' })],
    });
  }

  function gotoKeyInput() {
    st.keyView = 'own';
    if (keyMode() === 'own' && ownKey()) st.keyReplace = true;
    drawPanel();
    requestAnimationFrame(() => scrollToId('profile-key-own', '#profile-key-input'));
  }

  function ownSetupCard() {
    const mode = keyMode(), k = ownKey(), replacing = mode === 'own' && k && st.keyReplace;
    const inp = h('input', { class: ['input', st.keyErr && 'invalid'], id: 'profile-key-input', type: st.keyShow ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'off', placeholder: 'sk-ant-api03-…', value: st.keyDraft,
      'aria-invalid': st.keyErr ? 'true' : null, 'aria-describedby': st.keyErr ? 'profile-key-err' : 'profile-key-hint',
      on: { input: e => { st.keyDraft = e.target.value; if (st.keyErr) { st.keyErr = null; inp.classList.remove('invalid'); inp.removeAttribute('aria-invalid'); inp.setAttribute('aria-describedby', 'profile-key-hint'); const er = document.getElementById('profile-key-err'); if (er) er.remove(); hint.hidden = false; } } } });
    const eye = button('', { kind: 'secondary', icon: st.keyShow ? 'eyeOff' : 'eye', title: st.keyShow ? 'Скрыть ключ' : 'Показать ключ', attrs: { 'aria-pressed': String(st.keyShow), 'aria-controls': 'profile-key-input' }, onClick: () => {
      st.keyShow = !st.keyShow;
      inp.type = st.keyShow ? 'text' : 'password';
      const t = st.keyShow ? 'Скрыть ключ' : 'Показать ключ';
      eye.title = t; eye.setAttribute('aria-label', t); eye.setAttribute('aria-pressed', String(st.keyShow));
      eye.replaceChild(icon(st.keyShow ? 'eyeOff' : 'eye'), eye.firstChild);
    } });
    const hint = h('div', { class: 'field-hint', id: 'profile-key-hint', hidden: !!st.keyErr }, 'Начинается с sk-ant-. После сохранения увидите только последние 4 символа. В макете подойдет, например, sk-ant-api03-demo-7Kp2');
    const field = h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'profile-key-input' }, h('span', null, 'Ваш ключ')),
      h('div', { class: 'profile-keyinput' }, inp, eye),
      hint,
      st.keyErr && h('div', { class: 'field-error', role: 'alert', id: 'profile-key-err' }, st.keyErr));
    const lead = mode === 'admin'
      ? UI.callout('info', 'info', 'Пока анализы идут на ключе администратора. Режим сменится сразу, как только ключ пройдет проверку.')
      : !k ? UI.callout('bad', 'alert', h('b', { class: 'profile-why' }, D.ai.access(me()) + '.'), ' Пока ключа нет, анализы не запускаются' + (isAdmin() ? '.' : ' — сохраните ключ ниже или попросите администратора вернуть ключ администратора.'))
      : UI.callout('', 'refresh', 'Сейчас работает ключ sk-ant-…' + k.last4 + '. Новый заменит его после проверки, старый отзовите в консоли Anthropic.');
    const submitBtn = button('Проверить и сохранить', { kind: 'primary', type: 'submit', icon: 'key', attrs: { id: 'profile-key-save' } });
    return formCard({
      id: 'profile-key-own', title: replacing ? 'Замена своего ключа' : 'Свой ключ Claude API', subtitle: 'Ключ Anthropic, расход — с вашего счета',
      body: [
        lead,
        field,
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Нет ключа? ', h('a', { href: '#profile-key', on: { click: e => { e.preventDefault(); const d = document.getElementById('profile-key-steps'); if (d) d.open = true; scrollToId('profile-key-guide'); } } }, 'Как получить свой ключ'), ' — 7 шагов в консоли Anthropic.'),
        UI.callout('warn', 'lock', h('b', null, 'Никому не пересылайте ключ'), ' — ни в чате, ни по почте, ни администратору. Ключ вводится только в это поле.'),
      ],
      foot: [submitBtn, replacing && button('Отмена', { kind: 'ghost', onClick: () => { st.keyReplace = false; st.keyDraft = ''; st.keyErr = null; drawPanel(); } })],
      onSubmit: () => {
        const v = inp.value.trim();
        const fail = msg => { st.keyErr = msg; st.keyDraft = v; drawPanel(); requestAnimationFrame(() => { const el = document.getElementById('profile-key-input'); if (el) el.focus(); }); };
        if (!v) return fail('Вставьте ключ — скопируйте его в консоли Anthropic');
        if (!v.startsWith('sk-ant-')) return fail('Ключ Claude начинается с sk-ant-. Проверьте, что скопировали его целиком');
        if (v.length < 16) return fail('Ключ слишком короткий — скопируйте его целиком');
        if (submitBtn.disabled) return;
        busy(submitBtn, 'Проверяем ключ…', 900, () => {
          if (/wrong/i.test(v)) return fail('Anthropic не принял ключ: он отозван или скопирован не полностью. Создайте новый в консоли и вставьте еще раз');
          const wasAdmin = keyMode() === 'admin';
          me().ownKey = { last4: v.slice(-4), verified: nowIso() };
          if (me().ownCap == null) me().ownCap = D.admin.defaults.perAnalysis; // свой потолок на анализ, меняется ниже
          setMode('own');
          Object.assign(st, { keyDraft: '', keyShow: false, keyErr: null, keyReplace: false, keyDelConfirm: false, keyView: 'own' });
          drawTabs(); drawPanel();
          UI.toast(wasAdmin ? 'Ключ проверен и сохранен. Анализы теперь идут с вашего счета' : 'Ключ проверен и сохранен. Старый отзовите в консоли Anthropic', 'key');
        });
      },
    });
  }

  function ownKeyCard() {
    const k = ownKey(), adm = isAdmin();
    const checkBtn = button('Проверить', { kind: 'secondary', icon: 'check', onClick: () => busy(checkBtn, 'Проверяем…', 700, () => {
      k.verified = nowIso(); drawPanel();
      UI.toast('Ключ работает: доступны Opus 5.5, Sonnet 5.5 и Haiku 5.5', 'check');
    }) });
    const capInput = h('input', { class: 'input', id: 'profile-key-cap', value: fmt.dec(ownCap(), 2), inputmode: 'decimal', autocomplete: 'off', 'aria-describedby': 'profile-key-cap-hint' });
    const capF = h('div', { class: 'field' },
      h('label', { class: 'field-label', for: 'profile-key-cap' }, h('span', null, 'Свой потолок на один анализ, $')),
      h('div', { class: 'profile-cap' }, capInput, button('Сохранить', { kind: 'secondary', icon: 'check', type: 'submit' })),
      h('div', { class: 'field-hint', id: 'profile-key-cap-hint' }, 'Анализ, который выйдет дороже, остановится до формирования ставки. Средний анализ сейчас ≈ ' + usd(avgAnalysis) + '.'));
    const capForm = h('form', { novalidate: true, on: {
      input: () => setFieldError(capF, null),
      submit: e => {
        e.preventDefault();
        const v = num(capInput.value);
        if (!(v >= 0.1 && v <= 20)) return setFieldError(capF, 'От $0,10 до $20');
        me().ownCap = Math.round(v * 100) / 100; drawPanel(); // DATA.me.ownCap: по нему DATA.ai.access пропускает анализ
        UI.toast('Потолок на анализ: ' + usd(ownCap()), 'check');
      } } }, capF);
    const before = keySpent(); // потрачено на ключе администратора в этом месяце, до перехода
    const confirm = st.keyDelConfirm && h('div', { class: 'profile-confirm' },
      UI.callout('warn', 'alert', adm
        ? 'Ключ удалим с сервера, ваши анализы вернутся на ключ администратора. Отозвать ключ в консоли Anthropic отсюда нельзя — сделайте это сами.'
        : 'Ключ удалим с сервера. Без ключа анализы не запустятся, пока вы не сохраните новый или администратор не вернет вас на свой ключ. Отозвать ключ в консоли Anthropic отсюда нельзя — сделайте это сами.'),
      h('div', { class: 'row' },
        button('Удалить ключ', { kind: 'danger', icon: 'trash', onClick: () => {
          me().ownKey = null; st.keyDelConfirm = false;
          if (adm) { setMode('admin'); st.keyView = 'admin'; }
          drawTabs(); drawPanel();
          UI.toast(adm ? 'Ключ удален. Ваши анализы снова идут на ключе администратора' : 'Ключ удален с сервера. Отзовите его в консоли Anthropic', 'trash');
        } }),
        button('Отмена', { kind: 'ghost', onClick: () => { st.keyDelConfirm = false; drawPanel(); } })));
    return card({
      id: 'profile-key-own', class: 'profile-anchor', title: 'Свой ключ', subtitle: 'Ключ Anthropic, расход — с вашего счета',
      actions: [chip('Работает', 'good', 'check')],
      body: [
        h('p', { class: 'profile-keyline' }, 'Ваш ключ ', h('code', { 'aria-label': 'sk-ant, последние символы ' + k.last4.split('').join(' ') }, 'sk-ant-…' + k.last4), ' · проверен ' + lower1(when(k.verified)) + ' · израсходовано ', h('b', null, usd(ownSpent())), ' в этом месяце'),
        UI.kv([
          ['Кто платит', 'вы, со своего счета'],
          ['Лимит трат', 'ставите в консоли Anthropic'],
          before > 0 ? ['До перехода', usd(before) + ' на ключе администратора'] : null,
        ].filter(Boolean)),
        capForm,
        UI.callout('warn', 'lock', h('b', null, 'Никому не пересылайте ключ'), ' — ни в чате, ни по почте, ни администратору. Если ключ мог утечь, удалите его в консоли Anthropic и замените здесь.'),
        confirm,
      ],
      foot: confirm ? null : [
        checkBtn,
        button('Заменить ключ', { kind: 'secondary', icon: 'refresh', onClick: gotoKeyInput }),
        button('Удалить ключ', { kind: 'ghost', icon: 'trash', onClick: () => { st.keyDelConfirm = true; drawPanel(); requestAnimationFrame(() => { const b = document.querySelector('#profile-key-own .profile-confirm .btn.danger'); if (b) b.focus(); }); } }),
        h('a', { href: '#costs', class: 'small', style: 'margin-left:auto' }, 'ИИ и расходы'),
      ],
    });
  }

  function sendReturnRequest() {
    const at = nowIso();
    me().returnRequested = at;
    const list = D.notifications.admin, id = reqNotifId();
    if (!list.some(n => n.id === id)) list.unshift({ id, kind: 'ai_mode_request', icon: 'key', tone: 'info', title: user().name + ' просит вернуть ключ администратора', body: 'Сейчас работает на своем ключе. Вернуть можно только с вашего разрешения.', at, link: '#admin', read: false });
    drawTabs(); drawPanel();
    UI.toast('Просьба отправлена администратору', 'send');
  }
  function cancelReturnRequest() {
    me().returnRequested = null;
    const list = D.notifications.admin, i = list.findIndex(n => n.id === reqNotifId());
    if (i >= 0) list.splice(i, 1);
    drawPanel();
    UI.toast('Просьба отменена', 'x');
  }

  // Участник на своем ключе хочет обратно (Р12): только с разрешения администратора. Администратор — сразу.
  function returnCard() {
    const k = ownKey();
    if (isAdmin()) {
      return card({
        id: 'profile-key-return', class: 'profile-anchor', title: 'Вернуться на ключ администратора', subtitle: 'Вы администратор — переключение сразу',
        body: [h('p', { class: 'small soft', style: 'margin:0' }, 'Ваши анализы снова пойдут на ключе администратора, в общий бюджет. Свой ключ удалим с сервера — отзовите его в консоли Anthropic, если он больше не нужен.')],
        foot: [button('Вернуться на ключ администратора', { kind: 'primary', icon: 'refresh', onClick: () => {
          me().ownKey = null; setMode('admin'); st.keyView = 'admin'; drawTabs(); drawPanel();
          UI.toast('Готово: ваши анализы снова идут на ключе администратора', 'check');
        } })],
      });
    }
    const req = me().returnRequested;
    const D0 = D.admin.defaults; // лимиты по умолчанию задает администратор
    return card({
      id: 'profile-key-return', class: 'profile-anchor', title: 'Вернуться на ключ администратора', subtitle: 'Только с разрешения администратора',
      actions: req ? [chip('Ждет решения', 'info', 'clock')] : null,
      body: req ? [
        UI.callout('info', 'clock', h('b', null, 'Запрос отправлен ' + lower1(when(req)) + ', ждем решения администратора. '), 'Ответ придет уведомлением на сайте' + (st.push.on ? ' и push' : '') + '. ' + (k ? 'Пока анализы идут на вашем ключе.' : 'Пока ключа нет, анализы не запускаются.')),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'В макете: переключитесь на администратора — просьба появится у него в колокольчике и в «Администрировании».'),
      ] : [
        !k && UI.callout('bad', 'alert', h('b', { class: 'profile-why' }, D.ai.access(me()) + '.'), ' Анализы не запускаются, пока администратор не вернет ключ или вы не сохраните новый.'),
        h('p', { class: 'small soft', style: 'margin:0' }, 'За ключ администратора платит он, поэтому вернуться можно только с его разрешения. Отправим ему просьбу — ответ придет уведомлением.'),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Лимит после возврата задаст администратор. По умолчанию — ' + usd(D0.monthly, 0) + ' в месяц, ' + D0.daily + ' ' + pl(D0.daily, 'анализ', 'анализа', 'анализов') + ' в день, не больше ' + usd(D0.perAnalysis, 0) + ' за анализ.'),
      ],
      foot: req
        ? [button('Отменить запрос', { kind: 'ghost', icon: 'x', onClick: cancelReturnRequest })]
        : [button('Попросить администратора вернуть ключ', { kind: 'primary', icon: 'send', onClick: sendReturnRequest })],
    });
  }

  // Встроенная инструкция «Как получить свой ключ» — по docs/CLAUDE_API_KEY.md
  function guideCard() {
    const needKey = st.keyView === 'own' && !(keyMode() === 'own' && ownKey() && !st.keyReplace);
    const b = t => h('b', null, t);
    const steps = [
      ['Откройте ', ext('https://platform.claude.com/', 'platform.claude.com'), ' и создайте аккаунт или войдите в существующий.'],
      [b('Пополните баланс'), ' в разделе Settings → Billing: API оплачивается за использованные токены.'],
      ['Поставьте месячный ', b('лимит трат'), ' там же (Billing или Limits). Это ваша страховка: дороже лимита запросы не пройдут.'],
      ['Откройте ', b('Settings → API keys'), ' (', ext('https://platform.claude.com/settings/keys', 'прямая ссылка'), ') и нажмите ', b('Create key'), '.'],
      ['Задайте имя, например ', mono('AI Capper'), ', и срок действия. Если консоль предлагает тип ключа, выберите личный (personal key).'],
      [b('Скопируйте ключ сразу.'), ' Он начинается с ', mono('sk-ant-'), ' и показывается только один раз. Не успели — удалите его и создайте новый.'],
      ['Здесь выберите ', b('«Свой ключ»'), ', вставьте ключ в поле «Ваш ключ» и нажмите ', b('«Проверить и сохранить»'), '. Приложение отправит легкий проверочный запрос.'],
    ];
    return card({
      id: 'profile-key-guide', class: 'profile-anchor', title: 'Как получить свой ключ', subtitle: 'Около 5 минут в консоли Anthropic',
      body: [
        h('div', { class: 'stack', style: 'gap:8px' },
          h('h4', null, 'Сначала проверьте'),
          h('ul', { class: 'profile-bullets warnlist' },
            h('li', null, icon('alert'), h('span', null, b('Подписка Claude Pro или Max — не API.'), ' Она дает чат на claude.ai, но не ключ. Нужен отдельный аккаунт в Claude Console, токены там оплачиваются отдельно, по факту.')),
            h('li', null, icon('globe'), h('span', null, b('Страна.'), ' Claude API работает только в ', ext('https://www.anthropic.com/supported-countries', 'поддерживаемых странах'), ' — США, Финляндия и Германия в списке. Не обходите ограничение через VPN: это нарушает условия Anthropic.')))),
        details('Шаги 1–7', 'list', needKey, [
          h('ol', { class: 'profile-steps' }, steps.map((s, i) => h('li', null, h('div', null, h('span', null, s),
            i === 6 && !needKey ? button('К полю ключа', { kind: 'secondary', size: 'sm', icon: 'arrowRight', onClick: gotoKeyInput }) : null)))),
        ], 'profile-key-steps'),
        details('Как это работает дальше', 'info', false, [
          h('ul', { class: 'profile-bullets' },
            h('li', null, icon('coins'), h('span', null, 'Ваши анализы, разборы ставок и обновления ваших данных оплачиваются с вашего баланса. Лимиты администратора на вас не действуют, кроме потолка на один анализ.')),
            h('li', null, icon('chart'), h('span', null, 'Расход видно в «ИИ и расходы» и в консоли Anthropic. Цифры могут немного расходиться: консоль обновляется с задержкой.')),
            h('li', null, icon('users'), h('span', null, 'Общие фоновые задачи — ночное обновление базы игроков и новостей для всех — оплачивает администратор.')),
            h('li', null, icon('alert'), h('span', null, 'Если на балансе закончились деньги или ключ отозван, анализ остановится с понятной ошибкой, а вы получите уведомление.')),
            h('li', null, icon('refresh'), h('span', null, 'Вернуться на ключ администратора можно в этом же разделе, если администратор разрешит.'))),
        ]),
        details('Частые вопросы', 'book', false, [
          h('dl', { class: 'profile-faq' },
            h('div', null, h('dt', null, 'Сколько это стоит?'), h('dd', null, 'Средний анализ в ' + (D.ai.month === 'октябрь' ? 'октябре' : D.ai.month) + ' — около ' + usd(avgAnalysis) + '. При 1–2 анализах в день выйдет примерно ' + usd(avgAnalysis * 30, 0) + '–' + usd(avgAnalysis * 60, 0) + ' в месяц.')),
            h('div', null, h('dt', null, 'Подойдет ли подписка Claude Pro или Max?'), h('dd', null, 'Нет. У подписки нет ключа API, нужен аккаунт в Claude Console.')),
            h('div', null, h('dt', null, 'Можно ли одним ключом пользоваться вдвоем?'), h('dd', null, 'Не стоит: за все, что происходит под ключом, отвечает владелец аккаунта, а расходы смешаются.'))),
        ]),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Сверено с документацией Anthropic 7 октября 2026. Если кнопки в консоли называются иначе, ориентируйтесь на смысл шагов.'),
      ],
    });
  }

  function storageCard() {
    return card({
      title: 'Как хранится ключ', subtitle: 'Одинаково для ключа администратора и вашего',
      body: [
        h('ul', { class: 'profile-bullets lock' },
          h('li', null, icon('lock'), h('span', null, 'Ключ шифруется на сервере, ключ шифрования хранится отдельно от базы данных.')),
          h('li', null, icon('eyeOff'), h('span', null, 'В браузер ключ не возвращается: после сохранения видны только последние 4 символа — даже вам.')),
          h('li', null, icon('history'), h('span', null, 'Каждый запрос пишется в журнал запусков: модель, токены, стоимость. Сам ключ в журналы не попадает.'))),
        h('hr', { class: 'divider' }),
        h('div', { class: 'stack', style: 'gap:8px' }, h('h4', null, 'Какие модели работают на ключе'), UI.kv(modelsByUse)),
      ],
    });
  }

  // =====================================================================
  // 5. УВЕДОМЛЕНИЯ (Р3: на сайте и push, почты нет)
  // =====================================================================
  function panelNotifications() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-8 profile-col' }, notifCard()),
      h('div', { class: 'col-4 profile-col' }, channelsCard(), quietCard()));
  }

  function notifEvents() {
    const adm = isAdmin(), own = keyMode() === 'own', B = D.ai.budget();
    const dec = D.ai.decisions(); // то же, что значок у «Администрирования» и «дела» на главной
    const near = dec.filter(d => d.kind === 'limit').map(d => d.user);
    const asks = dec.filter(d => d.kind === 'return').length;
    let ai;
    if (adm) ai = { id: 'ai', t: 'Бюджет ключа: 80% и 100%', d: 'Общий бюджет ключа администратора — ' + usd(B.monthly, 0) + ' в месяц. На 100% анализы участников на вашем ключе остановятся' };
    else if (own) ai = { id: 'ai', t: 'Ключ Claude и расходы', d: 'Анализ дороже вашего потолка или ключ перестал работать: отозван, закончились деньги' };
    else { const L = memberLimit(); ai = { id: 'ai', t: 'Лимит ИИ: 80% и 100%', d: 'На 80% (' + usd(L.monthly * B.alertAt / 100, 0) + ' из ' + usd(L.monthly, 0) + ') — предупреждение, на 100% анализы останавливаются до решения администратора' }; }
    const list = [
      { id: 'bet', t: 'Ставка рассчитана', d: 'Счет, исход экспресса и новый банк — сразу после матча' },
      { id: 'stale', t: 'Данные игрока устарели', d: 'Профиль игрока из анализа старше 24 часов. Сейчас: ' + staleN + ' ' + pl(staleN, 'профиль устарел', 'профиля устарели', 'профилей устарели') + ', ' + missingN + ' ' + pl(missingN, 'игрока', 'игроков', 'игроков') + ' нет в базе' },
      ai,
      { id: 'login', t: 'Вход с нового устройства', d: 'Устройство, город и время входа', lockSite: true },
      { id: 'msg', t: 'Сообщение администратора', d: adm ? 'От других администраторов: работы на сервере, изменения в программе' : 'Работы на сервере, изменения в программе', lockSite: true },
    ];
    if (adm) list.push(
      { id: 'requests', t: 'Просьбы участников', d: 'Вернуть ключ администратора и другие вопросы, которые ждут вашего решения. Сейчас ждут: ' + asks, admin: true },
      { id: 'users', t: 'Лимиты участников', d: 'Участник израсходовал 80% или 100% своего лимита' + (near.length ? '. Сейчас у порога: ' + near.map(u => u.name).join(', ') : ''), admin: true });
    return list;
  }

  function notifCard() {
    const pushOn = st.push.on;
    const row = n => {
      const v = st.notif[n.id];
      const site = n.lockSite
        ? h('span', { class: 'profile-notif-lock', title: 'На сайте приходит всегда' }, icon('lock'), h('span', { class: 'sr-only' }, n.t + ': на сайте всегда включено'))
        : switchInput('profile-n-' + n.id + '-site', v.site, 'На сайте: ' + n.t, val => { v.site = val; UI.toast((val ? 'Включено на сайте: ' : 'Выключено на сайте: ') + lower1(n.t), val ? 'bell' : 'x'); });
      const push = switchInput('profile-n-' + n.id + '-push', pushOn && v.push, 'Push: ' + n.t, val => { v.push = val; UI.toast((val ? 'Push включен: ' : 'Push выключен: ') + lower1(n.t), val ? 'bell' : 'x'); }, !pushOn);
      return h('div', { class: 'profile-notif-row' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'profile-notif-t' }, n.t), h('div', { class: 'field-hint' }, n.d)),
        h('div', { class: 'profile-notif-cell' }, site),
        h('div', { class: 'profile-notif-cell' }, push));
    };
    const events = notifEvents();
    const common = events.filter(e => !e.admin), forAdmin = events.filter(e => e.admin);
    return card({
      id: 'profile-notif', class: 'profile-anchor', title: 'О чем сообщать', subtitle: 'Изменения сохраняются сразу',
      body: [
        !pushOn && UI.callout('info', 'device', 'Push выключен — столбец «Push» заработает, когда вы его разрешите. ', h('a', { href: '#profile-notifications', on: { click: e => { e.preventDefault(); scrollToId('profile-channels', '.card-foot .btn.primary'); } } }, 'Как включить')),
        h('div', null,
          h('div', { class: 'profile-notif-head', 'aria-hidden': 'true' }, h('span', null, 'Событие'), h('span', null, 'На сайте'), h('span', null, 'Push')),
          common.map(row),
          forAdmin.length ? [h('div', { class: 'profile-group-label' }, 'Для администратора'), forAdmin.map(row)] : null),
        h('p', { class: 'profile-note' }, icon('lock'), h('span', null, 'Вход с нового устройства и сообщения администратора на сайте приходят всегда: это защита аккаунта и важные новости.')),
      ],
    });
  }

  function channelsCard() {
    const p = st.push;
    const testBtn = button('Отправить тест', { kind: 'secondary', size: 'sm', icon: 'send', onClick: () => busy(testBtn, 'Отправляем…', 600, () => UI.toast('Тестовое push-уведомление отправлено: ' + p.device, 'send')) });
    const allowBtn = button('Разрешить push', { kind: 'primary', icon: 'bell', onClick: () => busy(allowBtn, 'Ждем ответа браузера…', 900, () => {
      p.on = true; p.device = currentSession().name; drawPanel();
      UI.toast('Push разрешен: ' + p.device + '. Пришлем короткое тестовое уведомление', 'bell');
    }) });
    return card({
      id: 'profile-channels', class: 'profile-anchor', title: 'Каналы', subtitle: 'Куда приходят уведомления',
      body: [
        h('div', { class: 'profile-list' },
          item({ ic: 'bell', icKind: 'good', title: 'На сайте', titleExtra: chip('Всегда включено', 'good', 'check'), meta: 'Колокольчик в шапке и центр уведомлений', below: true }),
          item({ ic: 'device', icKind: p.on ? 'good' : null, title: 'Push на телефон и в браузере', titleExtra: p.on ? chip('Включено', 'good', 'check') : chip('Выключено', 'outline'), meta: p.on ? p.device + ' · установлено как приложение' : 'Нужно разрешение браузера', below: true })),
        !p.on && h('div', { class: 'profile-how' },
          h('h4', null, 'Как включить push'),
          h('ol', { class: 'profile-steps' },
            h('li', null, h('div', null, h('span', null, 'Откройте сайт на телефоне и установите как приложение: в Safari — «Поделиться → На экран „Домой“», в Chrome — меню → «Установить приложение».'))),
            h('li', null, h('div', null, h('span', null, 'Откройте AI Capper с экрана «Домой» и нажмите «Разрешить push».')))),
          h('p', { class: 'xsmall muted', style: 'margin:0' }, 'На компьютере push работает в браузере и без установки.')),
      ],
      foot: p.on
        ? [testBtn, button('Отключить push', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => { p.on = false; drawPanel(); UI.toast('Push выключен. Уведомления остаются на сайте', 'x'); } })]
        : [allowBtn],
    });
  }

  function quietCard() {
    const q = st.quiet;
    const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0') + ':00');
    const fromF = UI.field({ label: 'С', id: 'profile-quiet-from', value: q.from, options: HOURS, attrs: { 'aria-label': 'Тихие часы — с' } });
    const toF = UI.field({ label: 'До', id: 'profile-quiet-to', value: q.to, options: HOURS, attrs: { 'aria-label': 'Тихие часы — до' } });
    const times = h('div', { class: 'profile-time', hidden: !q.on }, fromF, toF);
    const save = button('Сохранить', { kind: 'secondary', type: 'submit', icon: 'check', disabled: true });
    return formCard({
      id: 'profile-quiet', title: 'Тихие часы', subtitle: 'Push без звука · ' + tzTime(),
      body: [
        UI.toggle({ id: 'profile-quiet-on', label: 'Не беспокоить ночью', hint: 'На сайте уведомления копятся как обычно. Вход с нового устройства — со звуком всегда', checked: q.on, onChange: v => { times.hidden = !v; } }),
        times,
      ],
      foot: [save],
      onInput: () => { save.disabled = false; },
      onSubmit: () => {
        q.on = document.getElementById('profile-quiet-on').checked; q.from = valOf(fromF) || q.from; q.to = valOf(toF) || q.to;
        save.disabled = true;
        UI.toast(q.on ? 'Тихие часы: ' + q.from + '–' + q.to : 'Тихие часы выключены', 'moon');
      },
    });
  }

  // =====================================================================
  // 6. ДАННЫЕ (GDPR: экспорт и удаление, Р15)
  // =====================================================================
  function panelData() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-7 profile-col' }, exportCard(), sourcesCard()),
      h('div', { class: 'col-5 profile-col' }, consentCard(), isAdmin() && importCard()),
      h('div', { class: 'col-12 profile-col' }, dangerCard()));
  }

  function exportCard() {
    const openLegs = openBets().reduce((a, b) => a + b.legs.length, 0);
    const file = 'capper-export-' + TODAY + (st.exportFmt === 'json' ? '.json' : '.zip');
    const nBank = D.bankHistory.length, nBooks = myBooks().length;
    const prepBtn = button('Подготовить архив', { kind: 'primary', icon: 'download', onClick: () => busy(prepBtn, 'Собираем данные…', 1100, () => { st.exportState = 'ready'; drawPanel(); UI.toast('Архив готов', 'check'); }) });
    return card({
      id: 'profile-export', class: 'profile-anchor', title: 'Экспорт всех данных', subtitle: 'Ваши данные — ваши: заберите их в любой момент (GDPR)',
      body: [
        UI.kv([
          ['Ставки и экспрессы', D.bets.length + ' · из них ' + openBets().length + ' в игре'],
          ['События в экспрессах', String(D.allLegs.length + openLegs)],
          ['Банк и мои букмекеры', nBank + ' ' + pl(nBank, 'запись', 'записи', 'записей') + ' · ' + nBooks + ' ' + pl(nBooks, 'букмекер', 'букмекера', 'букмекеров')],
          ['Версии стратегии и уроки модели', D.strategyVersions.length + ' и ' + D.lessons.length],
          ['Ваши запуски ИИ', myRunsN + ' · токены и стоимость'],
          ['Журнал входов', 'за 90 дней'],
          ['Настройки', 'без паролей и ключей'],
        ]),
        h('div', { class: 'stack', style: 'gap:6px' },
          h('span', { class: 'field-label', id: 'profile-exp-fmt' }, 'Формат'),
          UI.segmented({ label: 'Формат экспорта', items: [{ id: 'json', label: 'JSON — один файл' }, { id: 'csv', label: 'CSV — архив таблиц' }], active: st.exportFmt, onChange: id => { st.exportFmt = id; st.exportState = 'idle'; drawPanel(); } })),
        h('p', { class: 'xsmall muted' }, 'В JSON у каждого события есть вероятность модели, кэф, закрывающая линия и результат — готовый датасет для своих экспериментов, см. ', h('a', { href: '#learning' }, 'Обучение модели'), '. Общая база игроков и матчей и общие фоновые задачи ИИ (обновление профилей) в архив не входят: они общие для всех.'),
        st.exportState === 'ready' && h('div', { class: 'profile-list' }, item({
          ic: 'download', icKind: 'good', title: file, meta: (st.exportFmt === 'json' ? '≈ 420 КБ' : '≈ 310 КБ, 7 таблиц') + ' · ссылка действует 24 часа', wrap: true,
          side: button('Скачать', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => UI.toast('В рабочей версии начнется скачивание. В макете файлов нет', 'info') }),
        })),
      ],
      foot: st.exportState === 'ready' ? [button('Собрать заново', { kind: 'ghost', icon: 'refresh', onClick: () => { st.exportState = 'idle'; drawPanel(); } })] : [prepBtn],
    });
  }

  // Откуда берутся данные о матчах (Р10) — бывший блок «Данные матчей и кэфы» из интеграций
  function sourcesCard() {
    const lo = Math.min(...refreshSearches), hi = Math.max(...refreshSearches);
    const searches = lo === hi ? String(lo) : lo + '–' + hi;
    return card({
      title: 'Откуда берутся данные о матчах', subtitle: 'База игроков, матчей и новостей общая для всех участников',
      body: h('ul', { class: 'profile-bullets' },
        h('li', null, icon('database'), h('span', null, 'Архивы матчей Сакманна и tennis-data.co.uk — история и статистика игроков.')),
        h('li', null, icon('globe'), h('span', null, 'Свежие результаты и новости — веб-поиском модели при обновлении профилей: сейчас ' + searches + ' поисков на запуск.')),
        h('li', null, icon('edit'), h('span', null, 'Кэфы вводите вы при анализе; закрывающий кэф Pinnacle нужен для CLV.')),
        h('li', null, icon('clock'), h('span', null, 'Платный источник матчей и кэфов подключим позже, когда CLV на 100–200 ставках покажет перевес.'))),
    });
  }

  function consentCard() {
    const on = consent();
    return card({
      id: 'profile-consent', class: 'profile-anchor', title: 'Прогнозы для общей модели', subtitle: 'Необязательное согласие · можно отозвать в любой момент',
      body: [
        UI.toggle({ id: 'profile-consent-on', label: 'Разрешаю обезличенно использовать мои прогнозы для обучения общей модели', hint: 'Без имени, email и сумм: только вероятности модели, кэфы и исходы событий', checked: on, onChange: v => {
          me().consent = v; drawPanel();
          requestAnimationFrame(() => { const el = document.getElementById('profile-consent-on'); if (el) el.focus({ preventScroll: true }); });
          UI.toast(v ? 'Согласие дано: обезличенные прогнозы помогут общей модели' : 'Согласие отозвано: ваши прогнозы в общую модель не попадут', v ? 'check' : 'x');
        } }),
        h('p', { class: 'profile-note' }, icon(on ? 'check' : 'info'), h('span', null, on
          ? 'Если удалите аккаунт, обезличенные прогнозы останутся в общей модели — без связи с вами.'
          : 'Согласия нет: при удалении аккаунта прогнозы удалятся вместе с ним.')),
      ],
    });
  }

  // Одноразовый импорт истории старого бота — только у администратора
  function importCard() {
    const first = settledBets[0], last = settledBets[settledBets.length - 1];
    return card({
      id: 'profile-import', class: 'profile-anchor', title: 'Импорт истории из старого бота', subtitle: 'Один раз · файл История-ставок.json',
      actions: [chip('Выполнен', 'good', 'check')],
      body: [
        h('p', { class: 'small soft', style: 'margin:0' }, 'Старый бот выключен. Его история ставок перенесена в ваш аккаунт: ставки, кэфы, закрывающие линии и результаты.'),
        UI.kv([
          ['Перенесено', settledBets.length + ' ' + pl(settledBets.length, 'ставка', 'ставки', 'ставок')],
          ['Период', dateDay(first.date) + ' — ' + dateDay(last.date)],
          ['Кто видит', 'только вы'],
        ]),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Повторы отбрасываем, поэтому повторная загрузка того же файла ничего не испортит.'),
      ],
      foot: [button('Проверить файл еще раз', { kind: 'secondary', icon: 'upload', onClick: importModal })],
    });
  }

  function importModal() {
    const n = settledBets.length;
    UI.modal({
      title: 'Проверка файла',
      body: [
        UI.callout('info', 'info', 'Пример разбора. В рабочей версии здесь будет ваш файл — ничего не переносится, пока вы не нажмете «Перенести».'),
        h('div', { class: 'profile-list' },
          item({ ic: 'database', title: 'История-ставок.json', titleExtra: chip('Ставки', 'outline'), meta: n + ' ' + pl(n, 'ставка', 'ставки', 'ставок') + ' в файле — все уже в базе, новых нет' }),
          item({ ic: 'wallet', title: 'Банк по ставкам', titleExtra: chip('Сходится', 'good', 'check'), meta: 'После последней ставки — ' + fmt.money(settledBets[n - 1].bankAfter) })),
      ],
      actions: close => [button('Закрыть', { kind: 'ghost', onClick: close }), button('Перенести', { kind: 'primary', icon: 'upload', disabled: true, title: 'Новых ставок нет' })],
    });
  }

  function dangerCard() {
    const adm = isAdmin();
    const adminsLeft = D.users.filter(u => u.role === 'admin' && u.status === 'active' && u.id !== me().id).length;
    const lists = h('div', { class: 'profile-del-grid' },
      h('div', null, h('h4', null, 'Удалится'),
        h('ul', { class: 'profile-bullets badlist' },
          h('li', null, icon('trash'), h('span', null, 'Ставки и экспрессы (' + D.bets.length + ')')),
          h('li', null, icon('trash'), h('span', null, 'Банк, его история и мои букмекеры')),
          h('li', null, icon('trash'), h('span', null, 'Стратегия, ее версии и уроки модели')),
          h('li', null, icon('trash'), h('span', null, 'Ключ Claude (если свой) и настройки')),
          h('li', null, icon('trash'), h('span', null, 'Сеансы, доверенные устройства и журнал входов')))),
      h('div', null, h('h4', null, 'Останется'),
        h('ul', { class: 'profile-bullets lock' },
          consent()
            ? h('li', null, icon('shield'), h('span', null, 'Обезличенные прогнозы — без имени и email, для обучения общей модели. Вы дали согласие (', h('a', { href: '#profile-consent', on: { click: e => { e.preventDefault(); scrollToId('profile-consent'); } } }, 'изменить'), ')'))
            : h('li', null, icon('x'), h('span', null, 'Прогнозы не останутся: согласия на обезличенное использование нет')),
          h('li', null, icon('history'), h('span', null, 'Запись в журнале администратора, что аккаунт удален — без ваших данных')))));
    if (st.deletion) {
      return card({
        id: 'profile-delete', class: 'profile-anchor profile-danger', eyebrow: 'Опасная зона', title: 'Удаление аккаунта запланировано',
        body: [
          UI.callout('bad', 'trash', h('b', null, 'Аккаунт и данные будут удалены ' + dateLong(st.deletion.until) + '. '), 'До этой даты можно передумать: вход и данные сохраняются, ИИ не запускается.'),
          lists,
        ],
        foot: [
          button('Отменить удаление', { kind: 'primary', icon: 'refresh', onClick: () => { st.deletion = null; drawHero(); drawPanel(); UI.toast('Удаление отменено. Аккаунт работает как раньше', 'check'); } }),
          button('Скачать экспорт', { kind: 'ghost', icon: 'download', onClick: () => scrollToId('profile-export') }),
        ],
      });
    }
    if (adm && !adminsLeft) {
      return card({
        id: 'profile-delete', class: 'profile-anchor profile-danger', eyebrow: 'Опасная зона', title: 'Удалить аккаунт',
        subtitle: 'Удалятся ставки, банк, стратегия, уроки, ключ и сеансы',
        body: [
          UI.callout('info', 'admin', h('b', null, 'Вы единственный администратор. '), 'Сначала назначьте другого администратора в «Администрирование → Участники» — без администратора программой некому управлять.'),
          lists,
        ],
        foot: [button('Удалить аккаунт', { kind: 'danger', icon: 'trash', disabled: true }), button('Участники', { kind: 'secondary', icon: 'users', href: '#admin-users' })],
      });
    }
    const inp = h('input', { class: 'input', id: 'profile-del-email', type: 'email', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ваш email', 'aria-describedby': 'profile-del-hint' });
    const del = button('Удалить аккаунт', { kind: 'danger', icon: 'trash', disabled: true, onClick: () => {
      st.deletion = { until: addDays(TODAY, 7) }; drawHero(); drawPanel();
      UI.toast('Удаление запланировано на ' + dateDay(st.deletion.until), 'trash');
    } });
    inp.addEventListener('input', () => { del.disabled = inp.value.trim().toLowerCase() !== st.email.toLowerCase(); });
    return card({
      id: 'profile-delete', class: 'profile-anchor profile-danger', eyebrow: 'Опасная зона', title: 'Удалить аккаунт',
      subtitle: 'Удалятся ставки, банк, стратегия, уроки, ключ и сеансы',
      body: [
        lists,
        h('p', { class: 'small soft', style: 'margin:0' }, 'После подтверждения у вас будет 7 дней, чтобы передумать. Потом данные удаляются безвозвратно, восстановить их не сможем. Сначала сделайте экспорт.'),
        h('div', { class: 'field', style: 'max-width:420px' },
          h('label', { class: 'field-label', for: 'profile-del-email' }, h('span', null, 'Введите ', h('b', { class: 'mono' }, st.email), ', чтобы подтвердить')),
          inp,
          h('div', { class: 'field-hint', id: 'profile-del-hint' }, 'Кнопка станет активной, когда адрес совпадет')),
      ],
      foot: [del],
    });
  }

  // ---------- экран ----------
  UI.register('profile', {
    title: 'Личный кабинет',
    render(root, param) {
      useState();
      const tab = TAB_ALIAS[param] || param;
      st.tab = TABS.some(t => t.id === tab) ? tab : 'profile';
      if (TAB_ALIAS[param]) setHash(st.tab);
      heroSlot = h('div', { style: 'min-width:0' });
      tabsSlot = h('div', { style: 'min-width:0' });
      panelEl = h('div', { class: 'profile-panel', id: 'profile-panel', role: 'tabpanel', tabindex: '-1' });
      drawHero(); drawTabs(); drawPanel();
      UI.append(root, [heroSlot, tabsSlot, panelEl]);
    },
  });
})();
