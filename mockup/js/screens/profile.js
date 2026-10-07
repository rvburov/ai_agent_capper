/* Личный кабинет: профиль; безопасность (пароль, 2FA, резервные коды, ключи доступа, сеансы, журнал входов);
   банк и стратегия (букмекеры, правила, ставки по кэфу, адаптации, ответственная игра); интеграции и ключи;
   уведомления; данные (экспорт, перенос из бота, удаление аккаунта).
   Вкладки — подмаршруты #profile-<вкладка>: security, bank, integrations, notifications, data.
   Состояние живёт в памяти модуля, цифры банка и стратегии — из window.DATA. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, U = DATA.user, TODAY = DATA.today;

  // ---------- утилиты ----------
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const parts = iso => iso.slice(0, 10).split('-').map(Number);
  const dateLong = iso => { const [y, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1] + ' ' + y; };
  const dateDay = iso => { const [, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1]; };
  const addDays = (s, n) => { const d = new Date(s.slice(0, 10) + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((Date.parse(b.slice(0, 10) + 'T12:00:00Z') - Date.parse(a.slice(0, 10) + 'T12:00:00Z')) / 864e5);
  const when = iso => { const d = iso.slice(0, 10), t = iso.slice(11, 16); return (d === TODAY ? 'Сегодня' : d === addDays(TODAY, -1) ? 'Вчера' : fmt.date(iso)) + ', ' + t; };
  const lower1 = s => s.charAt(0).toLowerCase() + s.slice(1);
  const num = v => parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  const dec = n => String(Math.round(n * 100) / 100).replace('.', ',');
  const round10 = n => Math.round(n / 10) * 10;
  const pl = fmt.plural;
  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('') || U.initials;

  // ---------- производные данные ----------
  // Ставки в игре считаются при каждой отрисовке: ставка, сохранённая в «Анализе» или рассчитанная в «Ставках», видна сразу
  const openBets = () => D.bets.filter(b => b.status === 'open');
  const inPlay = () => openBets().reduce((a, b) => a + b.stake, 0);
  const todayBets = () => D.bets.filter(b => b.date === TODAY);
  const staleN = D.players.filter(p => p.fresh === 'stale').length;
  const missingN = D.players.filter(p => p.fresh === 'missing').length;
  const profiledN = D.players.length - missingN;
  const lastRun = D.ai.runs.reduce((a, r) => (r.at > a ? r.at : a), '');
  const refreshSearches = D.ai.runs.filter(r => r.type === 'refresh').map(r => r.searches);
  const activeVersion = D.strategyVersions.find(v => v.status === 'active');
  const streakText = (() => {
    const n = S.streak.n;
    return S.streak.type === 'win' ? n + ' ' + pl(n, 'выигрыш', 'выигрыша', 'выигрышей') : S.streak.type === 'loss' ? n + ' ' + pl(n, 'проигрыш', 'проигрыша', 'проигрышей') : n + ' ' + pl(n, 'возврат', 'возврата', 'возвратов');
  })();
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

  const BOOK_COUNT = name => D.bets.filter(b => b.bookmaker === name).length;
  const BOOK_INPLAY = name => openBets().filter(b => b.bookmaker === name).reduce((a, b) => a + b.stake, 0);
  // Сверенный баланс (base) уже включает все ставки, рассчитанные до открытия макета. Результат ставок,
  // рассчитанных в этой сессии на экране «Ставки», добавляем к балансу их букмекера — сверка продолжает сходиться.
  const SETTLED_AT_LOAD = new Set(D.bets.filter(b => b.status !== 'open').map(b => b.id));
  const sessionProfit = name => D.bets.filter(b => b.bookmaker === name && b.status !== 'open' && !SETTLED_AT_LOAD.has(b.id)).reduce((a, b) => a + b.profit, 0);
  const books0 = [
    { id: 'fonbet', name: 'Fonbet', mark: 'FB', base: 21480, checked: '2026-10-06' },
    { id: 'winline', name: 'Winline', mark: 'WL', base: 16800, checked: '2026-10-06' },
    { id: 'liga', name: 'Лига Ставок', mark: 'ЛС', base: S.bank - 21480 - 16800, checked: '2026-10-03' },
  ];
  function syncBooks() {
    st.books.forEach(b => Object.assign(b, { bets: BOOK_COUNT(b.name), inPlay: BOOK_INPLAY(b.name), balance: b.base + sessionProfit(b.name) }));
  }

  const LOG = [
    { at: '2026-10-07T08:12', device: 'iPhone 15 · Safari', ip: '95.165.xx.xx', city: 'Москва', result: 'ok' },
    { at: '2026-10-06T23:41', device: 'MacBook Air · Chrome', ip: '95.165.xx.xx', city: 'Москва', result: 'ok' },
    { at: '2026-10-06T23:40', device: 'MacBook Air · Chrome', ip: '95.165.xx.xx', city: 'Москва', result: 'badpass' },
    { at: '2026-10-04T03:17', device: 'Windows · Firefox', ip: '185.220.xx.xx', city: 'Франкфурт, Германия', result: '2fa' },
    { at: '2026-10-02T09:05', device: 'iPhone 15 · Safari', ip: '176.59.xx.xx', city: 'Москва', result: 'ok' },
    { at: '2026-09-29T19:22', device: 'MacBook Air · Chrome', ip: '95.165.xx.xx', city: 'Москва', result: 'ok' },
    { at: '2026-09-21T11:48', device: 'iPhone 15 · Safari', ip: '94.25.xx.xx', city: 'Санкт-Петербург', result: 'ok' },
    { at: '2026-09-21T11:47', device: 'iPhone 15 · Safari', ip: '94.25.xx.xx', city: 'Санкт-Петербург', result: 'badpass' },
  ];
  const RESULT = { ok: ['Успешно', 'good', 'check'], badpass: ['Неверный пароль', 'warn', 'alert'], '2fa': ['2FA не пройдена', 'bad', 'x'] };
  const resultChip = r => chip(RESULT[r][0], RESULT[r][1], RESULT[r][2]);

  const TABS = [
    { id: 'profile', label: 'Профиль', short: 'Профиль', icon: 'user' },
    { id: 'security', label: 'Безопасность', short: 'Безопасность', icon: 'shield' },
    { id: 'bank', label: 'Банк и стратегия', short: 'Банк', icon: 'wallet' },
    { id: 'integrations', label: 'Интеграции и ключи', short: 'Интеграции', icon: 'link' },
    { id: 'notifications', label: 'Уведомления', short: 'Уведомления', icon: 'bell' },
    { id: 'data', label: 'Данные', short: 'Данные', icon: 'database' },
  ];

  const TZ = [
    { value: 'Europe/Kaliningrad', label: 'Калининград (UTC+2)' },
    { value: 'Europe/Moscow', label: 'Москва (UTC+3)' },
    { value: 'Europe/Samara', label: 'Самара (UTC+4)' },
    { value: 'Asia/Yekaterinburg', label: 'Екатеринбург (UTC+5)' },
    { value: 'Asia/Novosibirsk', label: 'Новосибирск (UTC+7)' },
    { value: 'Asia/Shanghai', label: 'Шанхай (UTC+8)' },
    { value: 'Asia/Vladivostok', label: 'Владивосток (UTC+10)' },
  ];
  const CUR = [{ value: 'RUB', label: '₽ — рубль' }, { value: 'USD', label: '$ — доллар США' }, { value: 'EUR', label: '€ — евро' }];
  const LANG = [{ value: 'ru', label: 'Русский' }, { value: 'en', label: 'English' }];

  const VALUE_ADJ = [
    { t: 'Сильный', d: 'перевес от 15%', v: '+0,5%' },
    { t: 'Хороший', d: '10–14%', v: '+0,25%' },
    { t: 'Небольшой', d: '5–9%', v: 'без поправки' },
    { t: 'Нет', d: 'меньше 5%', v: '−0,25%' },
  ];
  // Итог недели: банк сейчас к банку на конец дня неделю назад
  const weekBase = D.bankHistory.filter(x => x.date <= addDays(TODAY, -7)).pop() || D.bankHistory[0];
  const weekPct = (S.bank - weekBase.bank) / weekBase.bank * 100;

  const NOTIF = [
    { id: 'results', t: 'Результаты матчей и расчёт ставок', d: 'Счёт, исход экспресса и новый банк — сразу после матча' },
    { id: 'stale', t: 'Устаревшие данные игроков', d: 'Если профиль игрока из анализа старше 24 часов. Сейчас: ' + staleN + ' ' + pl(staleN, 'профиль устарел', 'профиля устарели', 'профилей устарели') + ', ' + missingN + ' ' + pl(missingN, 'игрока', 'игроков', 'игроков') + ' нет в базе' },
    { id: 'budget', t: 'Превышение лимита расходов на ИИ', d: 'При 80% и 100% месячного бюджета ($' + D.ai.budget + ')' },
    { id: 'login', t: 'Вход с нового устройства', d: 'Город, браузер и время входа. Хотя бы один канал обязателен', guard: true },
    { id: 'weekly', t: 'Еженедельный отчёт', d: 'По понедельникам в 09:00: ROI, CLV, калибровка, расходы ИИ' },
    { id: 'lessons', t: 'Новые уроки и версии стратегии', d: 'Модель предлагает урок или кандидата в стратегию — решение за вами' },
  ];

  // ---------- состояние ----------
  const st = {
    tab: 'profile',
    name: U.name, email: U.email, pendingEmail: null,
    tz: 'Europe/Moscow', currency: 'RUB', lang: 'ru',
    invites: [],
    pwdChanged: U.since,
    codeSeed: 7, codes: makeCodes(7), codesLeft: 8, codesCreated: U.since,
    passkeys: [],
    sessions: [
      { id: 's-iphone', ic: 'device', name: 'iPhone 15 · Safari', short: 'iPhone', where: 'Москва', ip: '95.165.xx.xx', seen: 'активен сейчас', current: true },
      { id: 's-mac', ic: 'laptop', name: 'MacBook Air · Chrome', short: 'MacBook', where: 'Москва', ip: '95.165.xx.xx', seen: 'вчера, 23:52' },
    ],
    logFilter: 'all',
    suspicious: true,
    books: books0, bankAdj: 0,
    ruleEdits: [],
    rules: { minProb: D.strategy.minProb, oddsMin: D.strategy.oddsMin, oddsMax: D.strategy.oddsMax, maxLegs: D.strategy.maxLegs, totalMax: D.strategy.totalMax },
    stakes: D.strategy.stakeTable.map(r => { const [a, b] = r.pct.split('–'); return { range: r.range, min: num(a), max: num(b) }; }),
    adapt: { lose3: true, win3: true, dd10: true, dd20: true, up15: true, weekLoss: true, weekWin: true },
    limits: { count: 3, amount: 4000 }, limitsPending: null,
    pauseDays: '7', pauseConfirm: false, pause: null,
    key: { last: '4f2a', checked: lastRun },
    provider: null,
    tg: { linked: true, code: null, confirmUnlink: false },
    notif: { results: { tg: true, mail: false }, stale: { tg: true, mail: false }, budget: { tg: true, mail: true }, login: { tg: true, mail: true }, weekly: { tg: false, mail: true }, lessons: { tg: true, mail: false } },
    quiet: { on: true, from: '00:00', to: '08:00' },
    exportFmt: 'json', exportState: 'idle',
    deletion: null,
  };
  const bankNow = () => S.bank + st.bankAdj;
  const allSessions = () => st.sessions.concat(st.tg.linked ? [{ id: 's-tg', ic: 'telegram', name: 'Telegram-бот @capper_bot', short: 'Telegram-бот', where: 'чат «Роман Б.»', ip: null, seen: 'сегодня, 07:58', bot: true }] : []);

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

    .profile-secret { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; flex-wrap: wrap; }
    .profile-secret > svg { width: 18px; height: 18px; color: var(--fg-3); flex: none; }
    .profile-secret code { font-family: var(--font-mono); font-size: var(--fs-md); color: var(--fg); }
    .profile-secret .xsmall { margin-left: auto; }
    .profile-otp { font-family: var(--font-mono); font-size: var(--fs-xl); letter-spacing: .12em; font-weight: 500; }
    .profile-bullets { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); }
    .profile-bullets li { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
    .profile-bullets svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--accent-ink); }
    .profile-bullets.lock svg { color: var(--fg-3); }

    .profile-notif-head, .profile-notif-row { display: grid; grid-template-columns: minmax(0, 1fr) 76px 76px; gap: 8px; align-items: center; }
    .profile-notif-head { font-size: var(--fs-xs); font-weight: 600; color: var(--fg-3); text-transform: uppercase; letter-spacing: .05em; padding-bottom: 8px; border-bottom: 1px solid var(--line); }
    .profile-notif-head span:not(:first-child) { text-align: center; }
    .profile-notif-row { padding: 12px 0; border-bottom: 1px solid var(--line); }
    .profile-notif-row:last-child { border-bottom: 0; padding-bottom: 0; }
    .profile-notif-t { font-weight: 500; }
    .profile-notif-cell { display: flex; justify-content: center; }
    .profile-time { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }

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
      .profile-notif-head, .profile-notif-row { grid-template-columns: minmax(0, 1fr) 62px 62px; gap: 6px; }
      .profile-usage { grid-template-columns: minmax(0, 1fr); }
      .profile-stake { padding: 10px; gap: 8px; }
      .profile-stake-inputs .input-wrap { width: 68px; }
      .profile-value { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .profile-rule-groups { gap: 0; }
      .profile-rule-group { border: 0; border-radius: 0; padding: 0; }
      .profile-rule-group + .profile-rule-group { border-top: 1px solid var(--line-strong); margin-top: 14px; padding-top: 14px; }
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
      input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby');
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

  function item(o) { // {ic, mark, icKind, title, titleExtra, meta, side, wrap}
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

  function mailIcon() {
    return h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, h('path', { d: 'M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zM3.5 7.5l8.5 6 8.5-6' }));
  }

  function scrollToId(id, focusSel) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focusSel) { const f = el.querySelector(focusSel); if (f) setTimeout(() => f.focus({ preventScroll: true }), 350); }
  }

  // ---------- шапка кабинета ----------
  function securityChecks() {
    const pk = st.passkeys.length;
    return [
      { ok: true, t: 'Надёжный пароль', d: 'изменён ' + (st.pwdChanged === TODAY ? 'сегодня' : dateLong(st.pwdChanged)) },
      { ok: true, t: 'Код 2FA при входе', d: 'приложение-аутентификатор (TOTP)' },
      { ok: st.codesLeft >= 4, t: 'Резервные коды сохранены', d: st.codesLeft + ' из 8 не использованы' },
      { ok: pk > 0, t: 'Ключ доступа (passkey)', d: pk ? pk + ' ' + pl(pk, 'ключ', 'ключа', 'ключей') + ' · вход по Face ID' : 'не добавлен — вход по Face ID без пароля',
        action: pk ? null : button('Добавить', { kind: 'secondary', size: 'sm', icon: 'plus', onClick: () => switchTab('security', () => { scrollToId('profile-2fa'); passkeyModal(); }) }) },
    ];
  }

  function heroCard() {
    const mobile = UI.isMobile();
    const checks = securityChecks();
    const done = checks.filter(c => c.ok).length;
    const sessions = allSessions();
    const meter = UI.meter(done, checks.length);
    meter.setAttribute('aria-label', 'Защита аккаунта: ' + done + ' из ' + checks.length);
    const shown = mobile ? checks.filter(c => !c.ok) : checks;
    const daysIn = daysBetween(U.since, TODAY);
    return h('section', { class: 'card profile-hero', 'aria-label': 'Сводка аккаунта' },
      h('div', { class: 'profile-hero-main' },
        h('div', { class: 'profile-id' },
          h('div', { class: 'profile-avatar', 'aria-hidden': 'true' }, initials(st.name)),
          h('div', { class: 'profile-id-text' },
            h('h2', { class: 'profile-name' }, st.name),
            h('div', { class: 'profile-email' }, st.email),
            h('div', { class: 'row profile-chips' },
              chip(U.role, 'accent', 'user'),
              chip('2FA включена', 'good', 'shield'),
              st.pause && chip('Пауза до ' + dateDay(st.pause.until), 'warn', 'pause'),
              st.deletion && chip('Удаление ' + dateDay(st.deletion.until), 'bad', 'trash'))),
          !mobile && button('Выйти', { kind: 'ghost', size: 'sm', icon: 'logout', onClick: () => UI.auth.logout() })),
        h('dl', { class: 'profile-facts' },
          h('div', null, h('dt', null, 'В AI Capper'), h('dd', null, 'с ' + dateLong(U.since), h('small', null, daysIn + ' ' + pl(daysIn, 'день', 'дня', 'дней') + ' · ' + S.settled + ' ' + pl(S.settled, 'ставка', 'ставки', 'ставок') + ' рассчитано'))),
          h('div', null, h('dt', null, 'Последний вход'), h('dd', null, 'Сегодня, 08:12', h('small', null, 'iPhone · Москва'))),
          h('div', null, h('dt', null, 'Активные сеансы'), h('dd', null, String(sessions.length), h('small', null, sessions.map(s => s.short).join(', '))))),
        !mobile && h('div', { class: 'profile-quick' }, h('span', { class: 'eyebrow' }, 'Часто нужно'), h('div', { class: 'row' },
          button('Сменить пароль', { kind: 'secondary', size: 'sm', icon: 'lock', onClick: () => switchTab('security', () => scrollToId('profile-password', '#profile-pass-cur')) }),
          button('Лимиты и пауза', { kind: 'secondary', size: 'sm', icon: 'pause', onClick: () => switchTab('bank', () => scrollToId('profile-rg')) }),
          button('Экспорт данных', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => switchTab('data', () => scrollToId('profile-export')) })))),
      h('div', { class: 'profile-guard' },
        h('div', { class: 'row-between' }, h('h3', null, 'Защита аккаунта'), chip(done + ' из ' + checks.length, done === checks.length ? 'good' : 'outline', done === checks.length ? 'check' : null)),
        meter,
        mobile && !shown.length ? h('div', { class: 'small soft' }, 'Пароль, 2FA, резервные коды и ключ доступа — всё включено.') : null,
        mobile && shown.length ? h('div', { class: 'xsmall muted' }, (checks.length - shown.length) + ' из ' + checks.length + ' мер включены. Что ещё можно усилить:') : null,
        shown.length ? h('ul', { class: 'profile-guard-list' }, shown.map(c => h('li', null,
          h('span', { class: ['profile-guard-ic', c.ok ? 'ok' : 'todo'] }, icon(c.ok ? 'check' : 'plus')),
          h('div', { class: 'profile-guard-text' }, h('div', null, c.t, h('span', { class: 'sr-only' }, c.ok ? ' — готово' : ' — не сделано')), h('div', { class: 'xsmall muted' }, c.d)),
          c.action))) : null,
        st.suspicious && h('div', { class: 'profile-guard-alert', role: 'note' }, icon('alert'),
          h('div', { style: 'min-width:0' }, '4 окт, 03:17 — вход из Франкфурта остановлен на 2FA'),
          button('Проверить', { kind: 'ghost', size: 'sm', onClick: () => switchTab('security', () => scrollToId('profile-log')) }))));
  }
  function drawHero() { if (heroSlot) UI.clear(heroSlot).appendChild(heroCard()); }

  // ---------- вкладки ----------
  function drawTabs() {
    const mobile = UI.isMobile();
    const dot = id => id === 'security' && st.suspicious ? [h('span', { class: 'profile-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, ' (есть что проверить)')] : null;
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
    const fn = { profile: panelProfile, security: panelSecurity, bank: panelBank, integrations: panelIntegrations, notifications: panelNotifications, data: panelData }[st.tab];
    UI.clear(panelEl);
    panelEl.setAttribute('aria-label', TABS.find(t => t.id === st.tab).label);
    UI.append(panelEl, [fn()]);
  }
  function switchTab(id, after, fromTabs) {
    const hadFocus = fromTabs || (document.activeElement && document.activeElement.getAttribute('role') === 'tab');
    st.tab = id;
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#profile' + (id === 'profile' ? '' : '-' + id)); } catch (e) { /* в песочнице адрес может быть недоступен — не страшно */ }
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
      h('div', { class: 'col-5 profile-col' }, appearanceCard(), regionCard()));
  }

  function personalCard() {
    const nameF = UI.field({ label: 'Имя и фамилия', id: 'profile-name', value: st.name, autocomplete: 'name', hint: 'Так к вам обращается бот, этим именем подписаны отчёты' });
    const emailF = UI.field({ label: 'Email для входа', id: 'profile-email', type: 'email', value: st.email, attrs: { readonly: true }, labelAside: chip('Подтверждён', 'good', 'check'), hint: 'Сменить можно только с текущим паролем и подтверждением по ссылке из письма' });
    const save = button('Сохранить', { kind: 'primary', type: 'submit', icon: 'check', disabled: true });
    const status = h('span', { class: 'profile-status', 'aria-live': 'polite' });
    const nameInput = nameF.querySelector('input');
    const pending = st.pendingEmail && UI.callout('info', 'send',
      h('div', { class: 'stack', style: 'gap:8px' },
        h('div', null, h('b', null, 'Ждём подтверждения: ' + st.pendingEmail + '. '), 'Ссылка в письме действует 24 часа. До перехода по ней вход работает со старым адресом.'),
        h('div', { class: 'row' },
          button('Отправить ещё раз', { kind: 'secondary', size: 'sm', icon: 'send', onClick: () => UI.toast('Письмо отправлено повторно на ' + st.pendingEmail, 'send') }),
          button('Отменить смену', { kind: 'ghost', size: 'sm', onClick: () => { st.pendingEmail = null; drawPanel(); UI.toast('Смена email отменена, ссылка из письма больше не действует', 'x'); } }))));
    return formCard({
      id: 'profile-personal', title: 'Личные данные', subtitle: 'Аккаунт создан ' + dateLong(U.since),
      body: [nameF, emailF, pending || h('div', { class: 'row' }, button('Изменить email', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: emailModal }))],
      foot: [save, status],
      onInput: () => { const dirty = nameInput.value.trim() !== st.name; save.disabled = !dirty; status.textContent = dirty ? 'Есть несохранённые изменения' : ''; setFieldError(nameF, null); },
      onSubmit: () => {
        const v = nameInput.value.trim();
        if (v.length < 2) return setFieldError(nameF, 'Укажите имя — хотя бы 2 буквы');
        st.name = v; save.disabled = true; status.textContent = 'Сохранено';
        drawHero();
        UI.toast('Имя сохранено. Бот будет обращаться: ' + v.split(/\s+/)[0], 'check');
      },
    });
  }

  function emailModal() {
    const f1 = UI.field({ label: 'Новый email', id: 'profile-new-email', type: 'email', autocomplete: 'email', placeholder: 'name@example.com' });
    const f2 = UI.field({ label: 'Текущий пароль', id: 'profile-email-pass', type: 'password', autocomplete: 'current-password', hint: 'В макете подойдёт любой, кроме «wrong»' });
    const m = UI.modal({
      title: 'Смена email',
      body: h('form', { id: 'profile-email-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        h('p', { class: 'small soft' }, 'Отправим письмо со ссылкой на новый адрес. Пока вы не перейдёте по ней, вход работает со старым — ' + st.email + '.'),
        f1, f2),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Отправить письмо', { kind: 'primary', type: 'submit', icon: 'send', attrs: { form: 'profile-email-form' } })],
    });
    function submit() {
      const v = valOf(f1).trim(), p = valOf(f2);
      setFieldError(f1, null); setFieldError(f2, null);
      let ok = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) ok = setFieldError(f1, 'Проверьте адрес: нужен вид name@example.com');
      else if (v.toLowerCase() === st.email.toLowerCase()) ok = setFieldError(f1, 'Это ваш текущий адрес');
      if (!p) ok = setFieldError(f2, 'Введите текущий пароль');
      else if (p === 'wrong') ok = setFieldError(f2, 'Пароль не подходит');
      if (!ok) return;
      st.pendingEmail = v; m.close(); drawPanel();
      UI.toast('Письмо со ссылкой отправлено на ' + v, 'send');
    }
  }

  function regionCard() {
    const tzF = UI.field({ label: 'Часовой пояс', id: 'profile-tz', value: st.tz, options: TZ, hint: 'По нему показываем время матчей, считаем лимиты «в день» и тихие часы' });
    const curF = UI.field({ label: 'Валюта банка', id: 'profile-cur', value: st.currency, options: CUR });
    const langF = UI.field({ label: 'Язык интерфейса и отчётов', id: 'profile-lang', value: st.lang, options: LANG });
    const note = h('div', { 'aria-live': 'polite' });
    const save = button('Сохранить', { kind: 'primary', type: 'submit', icon: 'check', disabled: true });
    const status = h('span', { class: 'profile-status' });
    return formCard({
      id: 'profile-region', title: 'Регион и язык', subtitle: 'Время, деньги и язык ответов ИИ',
      body: [
        h('div', { class: 'profile-fields collapse' }, h('div', { class: 'span-2' }, tzF), curF, langF),
        h('p', { class: 'xsmall muted' }, 'Перевод служебных инструкций на английский (вместе со сжатым досье −31% токенов) — кандидат v4, решение за вами в ', h('a', { href: '#learning' }, 'Обучении модели'), '. Анализы и отчёты ИИ пишет на выбранном языке.'),
        note,
      ],
      foot: [save, status],
      onInput: () => {
        const dirty = valOf(tzF) !== st.tz || valOf(curF) !== st.currency || valOf(langF) !== st.lang;
        save.disabled = !dirty; status.textContent = dirty ? 'Есть несохранённые изменения' : '';
        UI.clear(note);
        if (valOf(curF) !== 'RUB') note.appendChild(UI.callout('warn', 'alert', 'История ставок и банк останутся в рублях — пересчёта по курсу нет. Новая валюта применится к новым ставкам; графики разделятся на два периода.'));
      },
      onSubmit: () => {
        st.tz = valOf(tzF); st.currency = valOf(curF); st.lang = valOf(langF);
        save.disabled = true; status.textContent = 'Сохранено';
        UI.toast('Настройки региона сохранены', 'globe');
      },
    });
  }

  function appearanceCard() {
    const theme = document.documentElement.dataset.theme || 'system';
    const items = [{ id: 'system', label: 'Как в системе' }, { id: 'light', label: 'Светлая' }, { id: 'dark', label: 'Тёмная' }];
    return card({
      title: 'Внешний вид', subtitle: 'Тема сохраняется на этом устройстве',
      body: [
        UI.segmented({ label: 'Тема оформления', items, active: theme, onChange: id => {
          if (id === 'system') { delete document.documentElement.dataset.theme; try { localStorage.removeItem('capper.theme'); } catch (e) { /* ок */ } }
          else { document.documentElement.dataset.theme = id; try { localStorage.setItem('capper.theme', id); } catch (e) { /* ок */ } }
          UI.rerender();
          UI.toast('Тема: ' + items.find(i => i.id === id).label.toLowerCase(), id === 'dark' ? 'moon' : 'sun');
        } }),
        h('p', { class: 'xsmall muted' }, 'Кэфы везде показываем в десятичном формате (1.62), суммы — в валюте банка.'),
      ],
    });
  }

  function accessCard() {
    return card({
      title: 'Доступ к аккаунту', subtitle: 'Регистрация только по приглашению владельца',
      body: [
        UI.kv([['Ваша роль', U.role], ['Вход', 'email + пароль + код 2FA'], ['Другие пользователи', st.invites.length ? st.invites.length + ' ' + pl(st.invites.length, 'приглашение', 'приглашения', 'приглашений') : 'нет']]),
        st.invites.length ? h('div', { class: 'profile-list' }, st.invites.map(inv => item({
          ic: 'send', title: inv.email, meta: (inv.role === 'view' ? 'Только просмотр' : 'Полный доступ') + ' · ждёт регистрации до ' + dateDay(addDays(TODAY, 2)), wrap: true,
          side: button('Отозвать', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => { st.invites = st.invites.filter(x => x !== inv); drawPanel(); UI.toast('Приглашение для ' + inv.email + ' отозвано', 'x'); } }),
        }))) : null,
        h('p', { class: 'xsmall muted' }, 'Анализы приглашённых расходуют ваш бюджет на ИИ и видны в разделе «ИИ и расходы».'),
      ],
      foot: [button('Пригласить пользователя', { kind: 'secondary', icon: 'plus', onClick: inviteModal })],
    });
  }

  function inviteModal() {
    const ef = UI.field({ label: 'Email', id: 'profile-inv-email', type: 'email', autocomplete: 'off', placeholder: 'name@example.com' });
    const rf = UI.field({ label: 'Права', id: 'profile-inv-role', value: 'view', options: [{ value: 'view', label: 'Только просмотр — ставки и аналитика' }, { value: 'full', label: 'Полный доступ — может запускать анализ' }] });
    const m = UI.modal({
      title: 'Пригласить пользователя',
      body: h('form', { id: 'profile-inv-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        ef, rf, UI.callout('', 'shield', 'Ссылка действует 48 часов. При регистрации обязательно настроить 2FA; банк, ключи и стратегию меняет только владелец.')),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Отправить приглашение', { kind: 'primary', type: 'submit', icon: 'send', attrs: { form: 'profile-inv-form' } })],
    });
    function submit() {
      const v = valOf(ef).trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return setFieldError(ef, 'Проверьте адрес: нужен вид name@example.com');
      st.invites.push({ email: v, role: valOf(rf) }); m.close(); drawPanel();
      UI.toast('Приглашение отправлено на ' + v, 'send');
    }
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
    if (/[a-zа-яё]/.test(p) && /[A-ZА-ЯЁ]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^A-Za-zА-Яа-яЁё0-9]/.test(p)) s++;
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
      const lvl = !p ? null : s <= 1 ? ['Слабый', 'bad', 'alert'] : s <= 3 ? ['Средний', 'warn', 'info'] : ['Надёжный', 'good', 'check'];
      const reqs = [
        [p.length >= 12, 'Не короче 12 символов'],
        [/[A-Za-zА-Яа-яЁё]/.test(p) && /\d/.test(p), 'Буквы и цифры'],
        [!!p && p !== c, 'Не совпадает с текущим'],
      ];
      const m = UI.meter(p ? Math.max(s, 0.4) : 0, 5, lvl ? (lvl[1] === 'good' ? null : lvl[1]) : null);
      m.setAttribute('aria-label', 'Надёжность пароля');
      UI.clear(strength);
      UI.append(strength, [
        h('div', { class: 'row-between' }, h('span', null, 'Надёжность'), lvl ? chip(lvl[0], lvl[1], lvl[2]) : h('span', { class: 'xsmall muted' }, 'введите новый пароль')),
        m,
        h('ul', { class: 'profile-reqs', 'aria-label': 'Требования к паролю' }, reqs.map(([ok, t]) => h('li', { class: ok ? 'ok' : null }, icon(ok ? 'check' : 'x'), t, h('span', { class: 'sr-only' }, ok ? ' — выполнено' : ' — не выполнено')))),
      ]);
    }
    drawStrength();
    const days = daysBetween(st.pwdChanged, TODAY);
    return formCard({
      id: 'profile-password', title: 'Пароль',
      subtitle: st.pwdChanged === TODAY ? 'Изменён сегодня' : 'Изменён ' + dateLong(st.pwdChanged) + ' · ' + days + ' ' + pl(days, 'день', 'дня', 'дней') + ' назад',
      body: [cur, nw, strength, cf, show,
        others.length ? h('label', { class: 'check small', for: 'profile-pass-kill' }, kill, h('span', null, 'Завершить другие сеансы', h('span', { class: 'field-hint', style: 'display:block' }, others.map(s => s.short).join(', ') + ' — войти заново. Telegram-бот останется подключён'))) : null],
      foot: [button('Сменить пароль', { kind: 'primary', type: 'submit', icon: 'lock' })],
      onInput: e => { if (e && e.target && e.target.id !== 'profile-pass-kill' && e.target.id !== 'profile-pass-show') { drawStrength(); [cur, nw, cf].forEach(f => { if (f.contains(e.target)) setFieldError(f, null); }); } },
      onSubmit: () => {
        const c = valOf(cur), n = valOf(nw), r = valOf(cf);
        let ok = true;
        if (!c) ok = setFieldError(cur, 'Введите текущий пароль');
        else if (c === 'wrong') ok = setFieldError(cur, 'Текущий пароль не подходит');
        if (n.length < 12) ok = setFieldError(nw, 'Нужно не меньше 12 символов');
        else if (!(/[A-Za-zА-Яа-яЁё]/.test(n) && /\d/.test(n))) ok = setFieldError(nw, 'Добавьте и буквы, и цифры');
        else if (n === c) ok = setFieldError(nw, 'Новый пароль совпадает с текущим');
        if (n && r !== n) ok = setFieldError(cf, 'Пароли не совпадают');
        if (!ok) return;
        const killed = others.length && kill.checked;
        st.pwdChanged = TODAY;
        if (killed) st.sessions = st.sessions.filter(s => s.current);
        drawHero(); drawPanel();
        UI.toast(killed ? 'Пароль изменён. Другие сеансы завершены' : 'Пароль изменён', 'lock');
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
          item({ ic: 'shield', icKind: 'good', title: 'Приложение-аутентификатор (TOTP)', meta: 'Настроено ' + dateLong(U.since) + ' · Google Authenticator, Яндекс Ключ или 1Password', below: true,
            side: button('Перенести на другой телефон', { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => UI.toast('Откроется мастер с новым QR-кодом — как при регистрации. Старое приложение перестанет работать', 'refresh') }) }),
          item({ ic: 'key', title: 'Резервные коды', titleExtra: st.codesLeft < 4 ? chip('Осталось мало', 'warn', 'alert') : null, meta: st.codesLeft + ' из 8 не использованы · созданы ' + dateLong(st.codesCreated), below: true,
            side: button('Показать резервные коды', { kind: 'secondary', size: 'sm', icon: 'eye', onClick: codesModal }) })),
        h('hr', { class: 'divider' }),
        h('div', { class: 'stack', style: 'gap:10px' },
          h('div', { class: 'profile-section-title' }, h('h4', null, 'Ключи доступа (passkey)'), pk.length ? chip(pk.length + ' ' + pl(pk.length, 'ключ', 'ключа', 'ключей'), 'good', 'check') : chip('Не добавлены', 'outline')),
          h('p', { class: 'small soft' }, 'Вход по Face ID, Touch ID или PIN-коду устройства — без пароля и кода. Ключ не украсть поддельной страницей: он привязан к адресу сайта.'),
          pk.length ? h('div', { class: 'profile-list' }, pk.map(k => item({ ic: 'key', title: k.name, meta: 'Добавлен ' + (k.added === TODAY ? 'сегодня' : dateLong(k.added)) + ' · ещё не использовался',
            side: button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Удалить ключ «' + k.name + '»', onClick: () => { st.passkeys = st.passkeys.filter(x => x !== k); drawHero(); drawPanel(); UI.toast('Ключ доступа «' + k.name + '» удалён', 'trash'); } }) }))) : null,
          h('div', { class: 'row' }, button('Добавить ключ доступа', { kind: 'secondary', icon: 'plus', onClick: passkeyModal }))),
        UI.callout('', 'lock', 'Для владельца 2FA обязательна — отключить её нельзя. Потеряли телефон и коды: сброс только из консоли сервера.'),
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
        const pf = UI.field({ label: 'Пароль от аккаунта', id: 'profile-codes-pass', type: 'password', autocomplete: 'current-password', hint: 'В макете подойдёт любой, кроме «wrong»' });
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
          h('p', { class: 'small soft' }, 'Создавайте новые коды, если старые могли попасть к кому-то ещё или почти закончились.'),
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
    const nf = UI.field({ label: 'Название ключа', id: 'profile-pk-name', value: 'iPhone 15 — Face ID', hint: 'Чтобы потом отличать ключи друг от друга' });
    const m = UI.modal({
      title: 'Новый ключ доступа',
      body: h('form', { id: 'profile-pk-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        h('p', { class: 'small soft' }, 'Браузер попросит подтвердить Face ID, Touch ID или PIN-код устройства. Секретная часть ключа остаётся на устройстве — сервер хранит только публичную.'),
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
    const list = allSessions();
    const others = list.filter(s => !s.current);
    const confirmBox = h('div', { class: 'profile-confirm', hidden: true });
    const endBtn = others.length ? button('Выйти на всех других устройствах', { kind: 'secondary', icon: 'logout', onClick: () => { endBtn.hidden = true; confirmBox.hidden = false; const b = confirmBox.querySelector('.btn.danger'); if (b) b.focus(); } }) : null;
    function endSession(s) {
      if (s.bot) { st.tg.linked = false; st.tg.code = null; }
      else st.sessions = st.sessions.filter(x => x !== s);
      drawHero(); drawPanel();
      UI.toast(s.bot ? 'Бот отвязан. Привязать заново — во вкладке «Интеграции и ключи»' : 'Сеанс на ' + s.short + ' завершён', 'logout');
    }
    if (others.length) {
      UI.append(confirmBox, [
        UI.callout('warn', 'alert', 'Завершим ' + others.length + ' ' + pl(others.length, 'сеанс', 'сеанса', 'сеансов') + ': ' + others.map(s => s.short).join(', ') + '. Останется только этот — ' + list.find(s => s.current).name + '.' + (st.tg.linked ? ' Боту понадобится новая привязка.' : '')),
        h('div', { class: 'row' },
          button('Да, завершить', { kind: 'danger', icon: 'logout', onClick: () => { st.sessions = st.sessions.filter(s => s.current); st.tg.linked = false; st.tg.code = null; drawHero(); drawPanel(); UI.toast('Все другие сеансы завершены', 'logout'); } }),
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
    const rows = st.logFilter === 'fail' ? LOG.filter(r => r.result !== 'ok') : LOG;
    const alert = st.suspicious && UI.callout('warn', 'alert', h('div', { class: 'stack', style: 'gap:8px' },
      h('div', null, h('b', null, '4 октября в 03:17 кто-то ввёл верный пароль, но не прошёл 2FA.'), ' Windows · Firefox, Франкфурт (185.220.xx.xx). Вход не состоялся. Если это были не вы — пароль, скорее всего, утёк: смените его.'),
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
      foot: [h('span', { class: 'xsmall muted' }, 'Храним 90 дней. IP показываем частично. О входе с нового устройства пишем в Telegram и на почту.')],
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
    if (mobile) return h('div', { class: 'profile-panel' }, tiles, responsibleCard(), strategyCard(), adaptCard(dd, growth), booksCard(), historyCard());
    return h('div', { class: 'profile-panel' }, tiles,
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
      const upd = () => { const a = num(lo.el.value), c = num(hi.el.value); UI.clear(money); UI.append(money, isFinite(a) && isFinite(c) ? ['Сейчас это ', h('span', { style: 'white-space:nowrap' }, fmt.int(round10(b * a / 100)) + '–' + fmt.money(round10(b * c / 100)))] : 'Введите проценты'); };
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
      if (why.length) risk.appendChild(UI.callout('warn', 'alert', h('b', null, 'Правила стали рискованнее: '), why.join(', ') + '. ', 'Модель проверена на истории с правилами ' + activeVersion.name.split(' · ')[0] + ' — на новых её оценка ROI менее надёжна. Сначала прогоните их на истории в разделе ', h('a', { href: '#learning' }, 'Обучение модели'), '.'));
    }
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
          h('p', { class: 'xsmall muted' }, 'Чем выше итоговый кэф, тем меньше ставка. Внутри диапазона берётся середина, затем поправка на валуй и адаптации ниже; суммы округляются до 10 ₽.')),
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
      { id: 'streak', title: 'Серии', doubt: true, rules: [
        { id: 'lose3', t: '3 проигрыша подряд → ставка −40%', d: 'До первого выигрыша', active: S.streak.type === 'loss' && S.streak.n >= 3, now: 'Сейчас серия: ' + streakText },
        { id: 'win3', t: '3 выигрыша подряд → ставка +20%', d: 'Но не больше 3% банка', active: S.streak.type === 'win' && S.streak.n >= 3, now: 'Сейчас серия: ' + streakText },
      ] },
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
    const ruleChip = r => !st.adapt[r.id] ? chip('Выключено', 'outline', 'pause') : r.active ? chip('Действует сейчас', 'warn', 'bolt') : chip('Ждёт условия', 'outline', 'clock');
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
    const streakOn = st.adapt.lose3 || st.adapt.win3;
    return card({
      id: 'profile-adapt', class: 'profile-anchor', title: 'Адаптации ставки', subtitle: 'Меняют размер ставки по сериям, просадке и итогу недели · правила из бота',
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
            : 'Серия — ' + streakText + ', просадка ' + fmt.signedPct(dd) + ', за 7 дней ' + fmt.signedPct(weekPct) + ': ни одно правило сейчас не действует.')),
        h('div', { class: 'profile-rule-groups' }, GROUPS.map(g => h('div', { class: 'profile-rule-group', role: 'group', 'aria-labelledby': 'profile-rg-' + g.id },
          h('div', { class: 'profile-rule-group-head' }, h('h4', { id: 'profile-rg-' + g.id }, g.title), g.doubt && chip('Под вопросом', 'outline', 'alert')),
          g.rules.map(ruleRow),
          g.doubt && UI.callout('info', 'info', h('div', { class: 'stack', style: 'gap:8px' },
            h('div', null, 'Перенесено из бота. При честных вероятностях серии случайны — предлагаем выключить и оставить лимиты просадки (LLM_LEARNING.md §3.5).'),
            streakOn && h('div', { class: 'row' }, button('Выключить оба правила серий', { kind: 'secondary', size: 'sm', icon: 'pause', onClick: () => {
              st.adapt.lose3 = false; st.adapt.win3 = false; drawPanel();
              requestAnimationFrame(() => { const el = document.getElementById('profile-rule-lose3'); if (el) el.focus(); });
              UI.toast('Правила серий выключены. Остаются лимиты просадки и итог недели', 'pause');
            } }))))))),
      ],
    });
  }

  function responsibleCard() {
    // лимиты дня считают все ставки, сделанные сегодня, — и в игре, и уже рассчитанные
    const todayN = todayBets().length, todaySum = todayBets().reduce((a, x) => a + x.stake, 0);
    const L = st.limits;
    const cF = UI.field({ label: 'Ставок в день, не больше', id: 'profile-lim-count', value: String(L.count), inputmode: 'numeric', autocomplete: 'off' });
    const aF = UI.field({ label: 'Сумма ставок в день', id: 'profile-lim-amount', value: fmt.int(L.amount), suffix: '₽', inputmode: 'numeric', autocomplete: 'off' });
    const usage = (label, val, max, text) => {
      const m = UI.meter(val, max, val >= max ? 'bad' : val / max >= 0.75 ? 'warn' : null);
      m.setAttribute('aria-label', label);
      return h('div', null, h('div', { class: 'row-between', style: 'gap:6px' }, h('span', null, label), h('b', null, text)), m);
    };
    const end = addDays(TODAY, +st.pauseDays);
    const confirmBox = st.pauseConfirm && h('div', { class: 'profile-confirm' },
      UI.callout('warn', 'alert', h('b', null, 'Пауза до ' + dateLong(end) + ' включительно. '), 'Отменить её досрочно будет нельзя — ни вам, ни через поддержку.'),
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
          usage('Сумма сегодня', todaySum, L.amount, fmt.int(todaySum) + ' из ' + fmt.money(L.amount))),
        h('div', { class: 'profile-fields bottom' }, cF, aF),
        h('p', { class: 'xsmall muted' }, 'При достижении лимита кнопка «Сохранить ставку» блокируется до полуночи по вашему времени. Понизить лимит можно сразу, повысить — через 24 часа после запроса.'),
        P && UI.callout('info', 'clock', h('div', { class: 'stack', style: 'gap:8px' },
          h('div', null, 'Запрошено повышение: ' + [P.count && 'до ' + P.count + ' ' + pl(P.count, 'ставки', 'ставок', 'ставок'), P.amount && 'до ' + fmt.money(P.amount)].filter(Boolean).join(' и ') + ' в день. Вступит в силу ' + dateDay(addDays(TODAY, 1)) + ', через 24 часа.'),
          h('div', { class: 'row' }, button('Отменить запрос', { kind: 'ghost', size: 'sm', onClick: () => { st.limitsPending = null; drawPanel(); UI.toast('Запрос на повышение лимита отменён', 'x'); } })))),
        h('hr', { class: 'divider' }),
        h('h4', null, 'Пауза от ставок'),
        pauseBlock,
      ],
      foot: [button('Сохранить лимиты', { kind: 'secondary', type: 'submit', icon: 'check' })],
      onInput: e => { if (e && e.target && (e.target.id === 'profile-lim-count' || e.target.id === 'profile-lim-amount')) { setFieldError(cF, null); setFieldError(aF, null); } },
      onSubmit: () => {
        const c = num(valOf(cF)), a = num(valOf(aF));
        let ok = true;
        if (!(Number.isInteger(c) && c >= 1 && c <= 20)) ok = setFieldError(cF, 'Целое число от 1 до 20');
        if (!(a >= 100)) ok = setFieldError(aF, 'Не меньше 100 ₽');
        if (!ok) return;
        const pending = {}, down = [];
        if (c < L.count) { L.count = c; down.push('ставок'); } else if (c > L.count) pending.count = c;
        if (a < L.amount) { L.amount = a; down.push('суммы'); } else if (a > L.amount) pending.amount = a;
        st.limitsPending = Object.keys(pending).length ? pending : null;
        drawPanel();
        if (st.limitsPending) UI.toast('Повышение лимита вступит в силу через 24 часа' + (down.length ? '; снижение уже действует' : ''), 'clock');
        else if (down.length) UI.toast('Лимит снижен и уже действует', 'shield');
        else UI.toast('Лимиты не изменились', 'info');
      },
    });
  }

  function booksCard() {
    syncBooks();
    const sum = st.books.reduce((a, b) => a + b.balance, 0);
    const diff = sum - bankNow();
    return card({
      id: 'profile-books', class: 'profile-anchor', title: 'Букмекеры', subtitle: 'Где лежит банк · сверяйте раз в неделю',
      body: [
        h('div', { class: 'profile-list' }, st.books.map(b => item({
          mark: b.mark, title: b.name,
          meta: b.bets + ' ' + pl(b.bets, 'ставка', 'ставки', 'ставок') + (b.inPlay ? ' · в игре ' + fmt.money(b.inPlay) : '') + ' · сверено\u00a0' + (b.checked === TODAY ? 'сегодня' : dateDay(b.checked).replace(' ', '\u00a0')),
          side: [h('span', { class: 'profile-money' }, fmt.money(b.balance)), button('', { kind: 'ghost', size: 'sm', icon: 'edit', title: 'Изменить баланс ' + b.name, onClick: () => bookModal(b) })],
        }))),
        h('div', { class: 'row-between', style: 'padding-top:10px;border-top:1px solid var(--line)' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'small soft' }, 'Сумма балансов'), h('div', { class: 'profile-money', style: 'font-size:var(--fs-lg)' }, fmt.money(sum))),
          diff === 0 ? chip('Сходится с учётом', 'good', 'check') : chip('Расхождение ' + fmt.signedMoney(diff), 'warn', 'alert')),
        diff !== 0 && UI.callout('warn', 'info', h('div', { class: 'stack', style: 'gap:8px' },
          h('div', null, 'Балансы у букмекеров на ' + fmt.money(Math.abs(diff)) + (diff > 0 ? ' больше' : ' меньше') + ', чем банк в учёте (' + fmt.money(bankNow()) + '). Это ' + (diff > 0 ? 'пополнение' : 'вывод') + ' или ставка мимо приложения?'),
          h('div', { class: 'row' }, button('Учесть как ' + (diff > 0 ? 'пополнение' : 'вывод'), { kind: 'secondary', size: 'sm', onClick: () => { st.bankAdj += diff; drawPanel(); UI.toast((diff > 0 ? 'Пополнение ' : 'Вывод ') + fmt.signedMoney(diff) + ' записан в историю банка. В ROI не входит', 'wallet'); } })))),
      ],
      foot: [button('Добавить букмекера', { kind: 'secondary', icon: 'plus', onClick: () => bookModal(null) })],
    });
  }

  function bookModal(b) {
    const isNew = !b;
    const nameF = isNew && UI.field({ label: 'Букмекер', id: 'profile-bk-name', placeholder: 'Например, Пари', autocomplete: 'off' });
    const balF = UI.field({ label: isNew ? 'Баланс сейчас' : 'Баланс в ' + b.name, id: 'profile-bk-bal', value: isNew ? '' : fmt.int(b.balance), suffix: '₽', inputmode: 'numeric', autocomplete: 'off',
      hint: isNew ? 'Сумма на счёте, включая нерассчитанные ставки' : 'Сверьте с личным кабинетом букмекера. Включая ставки в игре' + (b.inPlay ? ': ' + fmt.money(b.inPlay) : '') });
    const m = UI.modal({
      title: isNew ? 'Новый букмекер' : 'Сверка баланса',
      body: h('form', { id: 'profile-bk-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } }, nameF, balF),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button(isNew ? 'Добавить' : 'Сохранить баланс', { kind: 'primary', type: 'submit', icon: 'check', attrs: { form: 'profile-bk-form' } })],
    });
    function submit() {
      let ok = true;
      const v = num(valOf(balF));
      const name = isNew ? valOf(nameF).trim() : b.name;
      if (isNew && !name) ok = setFieldError(nameF, 'Укажите название');
      if (!(v >= 0)) ok = setFieldError(balF, 'Введите сумму в рублях');
      if (!ok) return;
      if (isNew) st.books.push({ id: 'bk-' + st.books.length, name, mark: name.replace(/[^A-Za-zА-Яа-яЁё]/g, '').slice(0, 2).toUpperCase(), base: Math.round(v) - sessionProfit(name), balance: Math.round(v), checked: TODAY, bets: 0, inPlay: 0 });
      else { b.base = Math.round(v) - sessionProfit(b.name); b.balance = Math.round(v); b.checked = TODAY; }
      m.close(); drawPanel();
      UI.toast(isNew ? name + ' добавлен' : 'Баланс ' + name + ' сверен: ' + fmt.money(v), 'wallet');
    }
  }

  // =====================================================================
  // 4. ИНТЕГРАЦИИ И КЛЮЧИ
  // =====================================================================
  function panelIntegrations() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-6 profile-col' }, anthropicCard(), providerCard()),
      h('div', { class: 'col-6 profile-col' }, telegramCard(), storageCard()));
  }

  function anthropicCard() {
    const checkBtn = button('Проверить', { kind: 'ghost', icon: 'check', onClick: () => busy(checkBtn, 'Проверяем…', 700, () => {
      st.key.checked = 'now'; drawPanel();
      UI.toast('Ключ работает: доступны Opus 5.5, Sonnet 5.5 и Haiku 4.5', 'check');
    }) });
    const spentPct = D.ai.spent / D.ai.budget * 100;
    return card({
      id: 'profile-key', class: 'profile-anchor', title: 'Claude API (Anthropic)', subtitle: 'Ключ для анализа матчей, разборов ставок и обновления профилей',
      actions: [chip('Работает', 'good', 'check')],
      body: [
        h('div', { class: 'profile-secret' }, icon('key'), h('code', { 'aria-label': 'Ключ, последние символы ' + st.key.last.split('').join(' ') }, 'sk-ant-…' + st.key.last), h('span', { class: 'xsmall muted' }, 'проверен ' + (st.key.checked === 'now' ? 'только что' : lower1(when(st.key.checked))))),
        h('p', { class: 'small soft' }, 'Хранится зашифрованным, виден только последний фрагмент. Ключ использует только сервер — в браузер и в Telegram он не передаётся.'),
        UI.kv(modelsByUse),
        h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Расход за ' + D.ai.month), h('b', { class: 'num' }, fmt.usd(D.ai.spent) + ' из ' + fmt.usd(D.ai.budget, 0))),
          (() => { const m = UI.meter(D.ai.spent, D.ai.budget, spentPct >= 100 ? 'bad' : spentPct >= 80 ? 'warn' : null); m.setAttribute('aria-label', 'Расход бюджета на ИИ'); return m; })(),
          h('a', { href: '#costs', class: 'small' }, 'Подробнее в разделе «ИИ и расходы»')),
      ],
      foot: [button('Заменить ключ', { kind: 'secondary', icon: 'refresh', onClick: keyModal }), checkBtn],
    });
  }

  function keyModal() {
    const kf = UI.field({ label: 'Новый ключ', id: 'profile-key-new', type: 'password', autocomplete: 'off', placeholder: 'sk-ant-api03-…', hint: 'В макете подойдёт любая строка, начинающаяся с sk-ant-' });
    const m = UI.modal({
      title: 'Замена ключа Claude API',
      body: h('form', { id: 'profile-key-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        h('ol', { class: 'small soft', style: 'margin:0;padding-left:20px;display:flex;flex-direction:column;gap:4px' },
          h('li', null, 'Создайте новый ключ в консоли Anthropic.'),
          h('li', null, 'Вставьте его сюда — проверим пробным запросом к самой дешёвой модели.'),
          h('li', null, 'Старый ключ удалим с сервера. Отзовите его в консоли Anthropic — отсюда это сделать нельзя.')),
        kf),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Проверить и сохранить', { kind: 'primary', type: 'submit', icon: 'key', attrs: { form: 'profile-key-form', id: 'profile-key-submit' } })],
    });
    function submit() {
      const v = valOf(kf).trim();
      if (!v.startsWith('sk-ant-') || v.length < 12) return setFieldError(kf, 'Ключ должен начинаться с sk-ant- и быть длиннее — проверьте, что скопирован целиком');
      const b = document.getElementById('profile-key-submit');
      if (!b || b.disabled) return;
      busy(b, 'Проверяем ключ…', 800, () => {
        st.key = { last: v.slice(-4), checked: 'now' }; m.close(); drawPanel();
        UI.toast('Ключ заменён и проверен. Не забудьте отозвать старый в консоли Anthropic', 'key');
      });
    }
  }

  function providerCard() {
    const p = st.provider;
    const lo = Math.min(...refreshSearches), hi = Math.max(...refreshSearches);
    const searches = lo === hi ? String(lo) : lo + '–' + hi;
    if (p) {
      return card({
        id: 'profile-provider', class: 'profile-anchor', title: 'Данные матчей и кэфы', subtitle: 'Расписание, результаты, линия букмекеров',
        actions: [chip('Подключено', 'good', 'check')],
        body: [
          UI.kv([['Источник', p.label], ['Ключ', h('span', { class: 'mono' }, '…' + p.last)], ['Синхронизация', 'только что · каждые 15 минут']]),
          UI.callout('info', 'info', 'Пример подключения: конкретного провайдера выберем на этапе разработки — сравним покрытие ATP/WTA, цену и лимиты запросов.'),
        ],
        foot: [
          button('Синхронизировать', { kind: 'secondary', icon: 'refresh', onClick: () => UI.toast('Синхронизация запущена: расписание Шанхая и линия на 5 матчей', 'refresh') }),
          button('Отключить', { kind: 'ghost', icon: 'x', onClick: () => { st.provider = null; drawPanel(); UI.toast('Провайдер отключён. Кэфы и результаты — снова вручную', 'x'); } }),
        ],
      });
    }
    return card({
      id: 'profile-provider', class: 'profile-anchor', title: 'Данные матчей и кэфы', subtitle: 'Расписание, результаты, линия букмекеров',
      actions: [chip('Не подключено', 'warn', 'alert')],
      body: [
        h('p', { class: 'small soft' }, 'Сейчас статистику игроков ИИ собирает веб-поиском, а кэфы и результаты вы вводите сами. Провайдер данных даст:'),
        h('ul', { class: 'profile-bullets' },
          h('li', null, icon('check'), h('span', null, 'Результаты матчей автоматически — ставки рассчитаются без ручного ввода')),
          h('li', null, icon('check'), h('span', null, 'Закрывающие кэфы для CLV — без копирования из линии')),
          h('li', null, icon('check'), h('span', null, 'Меньше веб-поисков при обновлении профилей: сейчас ' + searches + ' на запуск'))),
      ],
      foot: [button('Подключить', { kind: 'primary', icon: 'link', onClick: providerModal })],
    });
  }

  function providerModal() {
    const OPTS = [{ value: 'both', label: 'Статистика и линия' }, { value: 'stats', label: 'Только статистика и расписание ATP/WTA' }, { value: 'odds', label: 'Только линия и кэфы букмекеров' }];
    const tf = UI.field({ label: 'Что подключить', id: 'profile-prov-type', value: 'both', options: OPTS });
    const kf = UI.field({ label: 'API-ключ провайдера', id: 'profile-prov-key', type: 'password', autocomplete: 'off', hint: 'Хранится так же, как ключ Claude: зашифрованным, только на сервере' });
    const m = UI.modal({
      title: 'Подключить данные матчей',
      body: h('form', { id: 'profile-prov-form', class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); submit(); } } },
        tf, kf, UI.callout('info', 'info', 'Конкретного провайдера выберем на этапе разработки. В макете подойдёт любой ключ.')),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Подключить', { kind: 'primary', type: 'submit', icon: 'link', attrs: { form: 'profile-prov-form', id: 'profile-prov-submit' } })],
    });
    function submit() {
      const k = valOf(kf).trim();
      if (k.length < 4) return setFieldError(kf, 'Вставьте ключ целиком');
      const b = document.getElementById('profile-prov-submit');
      if (!b || b.disabled) return;
      busy(b, 'Проверяем доступ…', 800, () => {
        st.provider = { label: OPTS.find(o => o.value === valOf(tf)).label, last: k.slice(-4) }; m.close(); drawPanel();
        UI.toast('Источник данных подключён. Первая синхронизация — через минуту', 'link');
      });
    }
  }

  function telegramCard() {
    const t = st.tg;
    const codeBlock = t.code && h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: 'profile-secret' }, h('span', { class: 'profile-otp', 'aria-label': 'Код ' + t.code.split('').join(' ') }, t.code.slice(0, 3) + ' ' + t.code.slice(3)),
        button('', { kind: 'ghost', size: 'sm', icon: 'copy', title: 'Скопировать команду', onClick: () => UI.toast('Скопировано: /link ' + t.code, 'copy') }),
        h('span', { class: 'xsmall muted' }, 'действует 10 минут')),
      h('p', { class: 'small soft' }, 'Откройте @capper_bot и отправьте: ', h('span', { class: 'mono' }, '/link ' + t.code), '. Привязать можно только один чат.'));
    if (!t.linked) {
      return card({
        id: 'profile-tg', class: 'profile-anchor', title: 'Telegram-бот', subtitle: 'Ввод событий текстом, уведомления, подтверждение входа',
        actions: [chip('Не подключён', 'outline', 'x')],
        body: [
          h('p', { class: 'small soft' }, 'Без бота не придут уведомления о результатах и о входе с нового устройства — только на почту.'),
          codeBlock,
        ],
        foot: [button(t.code ? 'Я отправил код — проверить' : 'Получить код привязки', { kind: 'primary', icon: 'telegram', onClick: () => {
          if (!t.code) { t.code = '482917'; drawPanel(); return; }
          t.linked = true; t.code = null; drawHero(); drawPanel(); UI.toast('Бот привязан к чату «Роман Б.»', 'telegram');
        } })],
      });
    }
    const unlinkBox = t.confirmUnlink && h('div', { class: 'profile-confirm' },
      UI.callout('warn', 'alert', 'Бот перестанет принимать события и присылать уведомления. Уведомления о входе останутся только на почте.'),
      h('div', { class: 'row' },
        button('Отвязать бота', { kind: 'danger', icon: 'x', onClick: () => { t.linked = false; t.confirmUnlink = false; t.code = null; drawHero(); drawPanel(); UI.toast('Бот отвязан', 'x'); } }),
        button('Отмена', { kind: 'ghost', onClick: () => { t.confirmUnlink = false; drawPanel(); } })));
    return card({
      id: 'profile-tg', class: 'profile-anchor', title: 'Telegram-бот', subtitle: 'Ввод событий текстом, уведомления, подтверждение входа',
      actions: [chip('Подключён', 'good', 'check')],
      body: [
        UI.kv([['Бот', '@capper_bot'], ['Чат', 'Роман Б. (личный)'], ['Привязан', dateLong('2026-06-30')], ['Последняя команда', 'сегодня, 07:58']]),
        h('ul', { class: 'profile-bullets' },
          h('li', null, icon('check'), h('span', null, 'Принимает события текстом, как раньше: ', h('span', { class: 'mono' }, 'Синнер — Руне, Ф1(−1.5) 1.62'))),
          h('li', null, icon('check'), h('span', null, 'Присылает экспресс дня, результаты и предупреждения')),
          h('li', null, icon('check'), h('span', null, 'Сообщает о входе с нового устройства'))),
        codeBlock,
        unlinkBox,
      ],
      foot: unlinkBox ? null : [
        button('Уведомления', { kind: 'secondary', icon: 'bell', onClick: () => switchTab('notifications', () => scrollToId('profile-notif')) }),
        button(t.code ? 'Новый код' : 'Код привязки', { kind: 'ghost', icon: 'link', onClick: () => { t.code = t.code === '482917' ? '730254' : '482917'; drawPanel(); } }),
        button('Отвязать', { kind: 'ghost', icon: 'x', onClick: () => { t.confirmUnlink = true; drawPanel(); } }),
      ],
    });
  }

  function storageCard() {
    return card({
      title: 'Как хранятся ключи', subtitle: 'Одинаково для Claude API, провайдера данных и бота',
      body: h('ul', { class: 'profile-bullets lock' },
        h('li', null, icon('lock'), h('span', null, 'Ключи шифруются на сервере, ключ шифрования хранится отдельно от базы данных.')),
        h('li', null, icon('eyeOff'), h('span', null, 'Браузер и Telegram получают только последние 4 символа — целиком ключ не показываем даже вам.')),
        h('li', null, icon('history'), h('span', null, 'Каждый запрос с ключом пишется в журнал запусков: модель, токены, стоимость.')),
        h('li', null, icon('alert'), h('span', null, 'Если ключ мог утечь — замените его здесь и отзовите старый у провайдера.'))),
    });
  }

  // =====================================================================
  // 5. УВЕДОМЛЕНИЯ
  // =====================================================================
  function panelNotifications() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-8 profile-col' }, notifCard()),
      h('div', { class: 'col-4 profile-col' }, channelsCard(), quietCard()));
  }

  function notifCard() {
    const tgOff = !st.tg.linked;
    const row = n => {
      const v = st.notif[n.id];
      const err = h('div', { class: 'field-error', 'aria-live': 'polite' });
      const sw = (ch, label) => switchInput('profile-n-' + n.id + '-' + ch, v[ch], label + ': ' + n.t, (val, input) => {
        v[ch] = val;
        if (n.guard && !(v.tg && st.tg.linked) && !v.mail) { v[ch] = true; input.checked = true; err.textContent = 'Оставьте хотя бы один канал — это защита аккаунта'; return; }
        err.textContent = '';
        UI.toast((val ? 'Включено' : 'Выключено') + ' в ' + (ch === 'tg' ? 'Telegram' : 'почте') + ': ' + lower1(n.t), val ? 'bell' : 'x');
      }, ch === 'tg' && tgOff);
      return h('div', { class: 'profile-notif-row' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'profile-notif-t' }, n.t), h('div', { class: 'field-hint' }, n.d), err),
        h('div', { class: 'profile-notif-cell' }, sw('tg', 'Telegram')),
        h('div', { class: 'profile-notif-cell' }, sw('mail', 'Почта')));
    };
    return card({
      id: 'profile-notif', class: 'profile-anchor', title: 'О чём сообщать', subtitle: 'Изменения сохраняются сразу',
      body: [
        tgOff && UI.callout('warn', 'telegram', 'Telegram-бот не подключён — уведомления придут только на почту. ', h('a', { href: '#profile-integrations', on: { click: e => { e.preventDefault(); switchTab('integrations', () => scrollToId('profile-tg')); } } }, 'Подключить бота')),
        h('div', null,
          h('div', { class: 'profile-notif-head', 'aria-hidden': 'true' }, h('span', null, 'Событие'), h('span', null, 'Telegram'), h('span', null, 'Почта')),
          NOTIF.map(row)),
      ],
    });
  }

  function channelsCard() {
    const tgBtn = button('Отправить тест', { kind: 'secondary', size: 'sm', icon: 'send', onClick: () => busy(tgBtn, 'Отправляем…', 600, () => UI.toast(st.tg.linked ? 'Тестовое сообщение отправлено в Telegram' : 'Тестовое письмо отправлено на ' + st.email, 'send')) });
    return card({
      title: 'Каналы', subtitle: 'Куда приходят уведомления',
      body: h('div', { class: 'profile-list' },
        item({ ic: 'telegram', title: 'Telegram', titleExtra: st.tg.linked ? chip('Подключён', 'good', 'check') : chip('Не подключён', 'outline', 'x'), meta: st.tg.linked ? '@capper_bot · чат «Роман Б.»' : 'привяжите во вкладке «Интеграции»' }),
        item({ mark: mailIcon(), title: 'Почта', titleExtra: chip('Подтверждена', 'good', 'check'), meta: st.email })),
      foot: [tgBtn],
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
      id: 'profile-quiet', title: 'Тихие часы', subtitle: 'Без звука по вашему часовому поясу',
      body: [
        UI.toggle({ id: 'profile-quiet-on', label: 'Не беспокоить ночью', hint: 'Кроме входа с нового устройства и превышения бюджета', checked: q.on, onChange: v => { times.hidden = !v; } }),
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
  // 6. ДАННЫЕ
  // =====================================================================
  function panelData() {
    return h('div', { class: 'grid' },
      h('div', { class: 'col-7 profile-col' }, exportCard()),
      h('div', { class: 'col-5 profile-col' }, importCard()),
      h('div', { class: 'col-12 profile-col' }, dangerCard()));
  }

  function exportCard() {
    const openLegs = openBets().reduce((a, b) => a + b.legs.length, 0);
    const file = 'capper-export-' + TODAY + (st.exportFmt === 'json' ? '.json' : '.zip');
    const prepBtn = button('Подготовить архив', { kind: 'primary', icon: 'download', onClick: () => busy(prepBtn, 'Собираем данные…', 1100, () => { st.exportState = 'ready'; drawPanel(); UI.toast('Архив готов. Ссылка также отправлена на почту', 'check'); }) });
    return card({
      id: 'profile-export', class: 'profile-anchor', title: 'Экспорт всех данных', subtitle: 'Ваши данные — ваши: заберите их в любой момент',
      body: [
        UI.kv([
          ['Ставки и экспрессы', D.bets.length + ' · из них ' + openBets().length + ' в игре'],
          ['События в экспрессах', String(D.allLegs.length + openLegs)],
          ['Профили игроков', profiledN + ' + ' + missingN + ' без профиля'],
          ['Уроки модели и версии стратегии', D.lessons.length + ' и ' + D.strategyVersions.length],
          ['Запуски ИИ: токены и стоимость', String(D.ai.runs.length)],
          ['Настройки', 'без паролей и ключей'],
        ]),
        h('div', { class: 'stack', style: 'gap:6px' },
          h('span', { class: 'field-label', id: 'profile-exp-fmt' }, 'Формат'),
          UI.segmented({ label: 'Формат экспорта', items: [{ id: 'json', label: 'JSON — один файл' }, { id: 'csv', label: 'CSV — архив таблиц' }], active: st.exportFmt, onChange: id => { st.exportFmt = id; st.exportState = 'idle'; drawPanel(); } })),
        h('p', { class: 'xsmall muted' }, 'В JSON у каждого события есть вероятность модели, кэф, закрывающая линия и результат — готовый датасет для своих экспериментов с обучением. См. ', h('a', { href: '#learning' }, 'Обучение модели'), '.'),
        st.exportState === 'ready' && h('div', { class: 'profile-list' }, item({
          ic: 'download', icKind: 'good', title: file, meta: (st.exportFmt === 'json' ? '≈ 420 КБ' : '≈ 310 КБ, 7 таблиц') + ' · ссылка действует 24 часа, копия отправлена на ' + st.email, wrap: true,
          side: button('Скачать', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => UI.toast('В рабочей версии начнётся скачивание. В макете файлов нет', 'info') }),
        })),
      ],
      foot: st.exportState === 'ready' ? [button('Собрать заново', { kind: 'ghost', icon: 'refresh', onClick: () => { st.exportState = 'idle'; drawPanel(); } })] : [prepBtn],
    });
  }

  function importCard() {
    return card({
      title: 'Перенос из Telegram-бота', subtitle: 'Из JSON-файлов и инструкций текущего бота',
      body: [
        h('p', { class: 'small soft' }, 'Текущий бот хранит данные в JSON-файлах, а правила — в markdown-инструкциях. Загрузите их: перенесём ставки, игроков и правила стратегии, дубликаты отбросим.'),
        UI.kv([['Последний перенос', dateLong(U.since)], ['Профили игроков', String(profiledN)], ['Правила стратегии', 'стали версией ' + D.strategyVersions[0].id]]),
      ],
      foot: [button('Выбрать файлы', { kind: 'secondary', icon: 'upload', onClick: importModal })],
    });
  }

  function importModal() {
    const files = [
      { name: 'bets.json', what: 'Ставки', res: 'новых нет — все ' + D.bets.filter(b => b.status !== 'open').length + ' уже в базе', ok: true },
      { name: 'players.json', what: 'Игроки', res: '3 профиля новее, чем в базе — обновим', ok: true },
      { name: 'Tennis-Analytics/strategy.md', what: 'Правила стратегии', res: 'совпадают с текущими (' + activeVersion.name.split(' · ')[0] + ')', ok: true },
    ];
    UI.modal({
      title: 'Проверка файлов',
      body: [
        UI.callout('info', 'info', 'Пример разбора. В рабочей версии здесь будут ваши файлы — ничего не переносится, пока вы не нажмёте «Перенести».'),
        h('div', { class: 'profile-list' }, files.map(f => item({ ic: 'database', title: f.name, titleExtra: chip(f.what, 'outline'), meta: f.res }))),
      ],
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Перенести', { kind: 'primary', icon: 'upload', onClick: () => { close(); UI.toast('Перенесено: 3 профиля игроков обновлены', 'check'); } })],
    });
  }

  function dangerCard() {
    if (st.deletion) {
      return card({
        id: 'profile-delete', class: 'profile-anchor profile-danger', eyebrow: 'Опасная зона', title: 'Удаление аккаунта запланировано',
        body: [
          UI.callout('bad', 'trash', h('b', null, 'Аккаунт и все данные будут удалены ' + dateLong(st.deletion.until) + '. '), 'Письмо с подробностями — на ' + st.email + '. До этой даты можно передумать: вход и данные сохраняются, ИИ не запускается.'),
        ],
        foot: [
          button('Отменить удаление', { kind: 'primary', icon: 'refresh', onClick: () => { st.deletion = null; drawHero(); drawPanel(); UI.toast('Удаление отменено. Аккаунт работает как раньше', 'check'); } }),
          button('Скачать экспорт', { kind: 'ghost', icon: 'download', onClick: () => scrollToId('profile-export') }),
        ],
      });
    }
    const inp = h('input', { class: 'input', id: 'profile-del-email', type: 'email', autocomplete: 'off', spellcheck: 'false', placeholder: 'Ваш email', 'aria-describedby': 'profile-del-hint' });
    const del = button('Удалить аккаунт', { kind: 'danger', icon: 'trash', disabled: true, onClick: () => {
      st.deletion = { until: addDays(TODAY, 7) }; drawHero(); drawPanel();
      UI.toast('Удаление запланировано на ' + dateDay(st.deletion.until) + '. Письмо отправлено', 'trash');
    } });
    inp.addEventListener('input', () => { del.disabled = inp.value.trim().toLowerCase() !== st.email.toLowerCase(); });
    return card({
      id: 'profile-delete', class: 'profile-anchor profile-danger', eyebrow: 'Опасная зона', title: 'Удалить аккаунт',
      subtitle: 'Удалятся ставки (' + D.bets.length + '), профили игроков, уроки модели, ключи API и привязка Telegram',
      body: [
        h('p', { class: 'small soft' }, 'После подтверждения у вас будет 7 дней, чтобы передумать. Потом данные удаляются безвозвратно, восстановить их не сможем. Сначала сделайте экспорт.'),
        h('div', { class: 'field', style: 'max-width:420px' },
          h('label', { class: 'field-label', for: 'profile-del-email' }, h('span', null, 'Введите ', h('b', { class: 'mono' }, st.email), ', чтобы подтвердить')),
          inp,
          h('div', { class: 'field-hint', id: 'profile-del-hint' }, 'Кнопка станет активной, когда адрес совпадёт')),
      ],
      foot: [del],
    });
  }

  // ---------- экран ----------
  UI.register('profile', {
    title: 'Личный кабинет',
    render(root, param) {
      st.tab = TABS.some(t => t.id === param) ? param : 'profile';
      heroSlot = h('div', { style: 'min-width:0' });
      tabsSlot = h('div', { style: 'min-width:0' });
      panelEl = h('div', { class: 'profile-panel', id: 'profile-panel', role: 'tabpanel', tabindex: '-1' });
      drawHero(); drawTabs(); drawPanel();
      UI.append(root, [heroSlot, tabsSlot, panelEl]);
    },
  });
})();
