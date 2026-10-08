/* Раздел «Администрирование» — кабинет администратора (docs/PLAN.md, раздел 7 «Кабинет администратора»; решения Р4–Р9, Р12–Р17).
   Вкладки — подмаршруты #admin-<вкладка>: users, invites, access, key, usage, settings, audit, message.
   #admin-limits — вкладка «Ключ и бюджет» с прокруткой к лимитам участников (туда ведет уведомление о 80% лимита).
   Действия имитируются: состояние меняется в памяти (DATA.users, DATA.admin), каждое действие пишется в журнал
   DATA.admin.audit. Об участнике администратор видит только расход на ИИ и активность — ставок, банка и стратегии
   здесь нет (Р14). Удаленный участник помечается status: 'deleted', как в остальных экранах. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, A = DATA.admin, TODAY = DATA.today;

  // ---------- даты и часы макета ----------
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const parts = iso => iso.slice(0, 10).split('-').map(Number);
  const dateDay = iso => { const [, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1]; };
  const dateLong = iso => { const [y, m, d] = parts(iso); return d + ' ' + MONTHS_GEN[m - 1] + ' ' + y; };
  const toMin = iso => Date.parse((iso.length > 10 ? iso.slice(0, 16) : iso + 'T00:00') + ':00Z') / 60000;
  const fromMin = m => new Date(m * 60000).toISOString().slice(0, 16);
  const addHours = (iso, n) => fromMin(toMin(iso) + n * 60);
  const dayShift = n => fromMin(toMin(TODAY) + n * 1440).slice(0, 10);
  function when(iso) {
    if (!iso) return '—';
    const d = iso.slice(0, 10), t = iso.slice(11, 16);
    const day = d === TODAY ? 'Сегодня' : d === dayShift(-1) ? 'Вчера' : d === dayShift(1) ? 'Завтра'
      : fmt.date(iso) + (d.slice(0, 4) !== TODAY.slice(0, 4) ? ' ' + d.slice(0, 4) : '');
    return t ? day + ', ' + t : day;
  }
  const lc = s => s.charAt(0).toLowerCase() + s.slice(1);
  // «Сейчас» в макете — утро 7 октября; каждое действие сдвигает часы на минуту, чтобы порядок в журнале был виден.
  // Запись о смене валюты переживает перезагрузку — часы идут после нее.
  let clock = Math.max(toMin(TODAY + 'T09:41'), ...DATA.admin.audit.map(e => toMin(e.at) + 1));
  const now = () => fromMin(clock);
  const tick = () => fromMin(clock++);
  function left(expires) {
    const m = toMin(expires) - clock;
    if (m <= 0) return 'срок вышел';
    if (m < 60) return 'осталось ' + m + ' мин';
    if (m < 48 * 60) { const hh = Math.floor(m / 60); return 'осталось ' + hh + ' ' + fmt.plural(hh, 'час', 'часа', 'часов'); }
    const dd = Math.floor(m / 1440);
    return 'еще ' + dd + ' ' + fmt.plural(dd, 'день', 'дня', 'дней');
  }

  // ---------- числа ----------
  const usd = n => fmt.usd(n);
  const usdL = n => fmt.usd(n, Number.isInteger(n) ? 0 : 2); // лимиты: $10, $1, но $1,50
  const pctOf = (a, b, d = 0) => fmt.pct(b ? a / b * 100 : 0, d);
  const num = v => parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  const dec = n => String(Math.round(n * 100) / 100).replace('.', ',');
  const pl = (n, a, b, c) => n + '\u00a0' + fmt.plural(n, a, b, c); // неразрывный пробел: число не отрывается от слова
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const limitText = L => usdL(L.monthly) + ' в месяц · ' + pl(L.daily, 'анализ', 'анализа', 'анализов') + ' в день · ' + usdL(L.perAnalysis) + ' на анализ';

  // ---------- участники ----------
  const ROLE = { admin: 'Администратор', member: 'Участник' };
  const people = () => D.users.filter(u => u.status !== 'deleted');
  const isMe = u => u.id === D.user.id;
  const initials = name => name.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('');
  const userById = id => D.users.find(u => u.id === id);
  const onAdminKey = () => people().filter(u => u.aiMode === 'admin');
  const recipients = () => people().filter(u => u.status === 'active' && !isMe(u));
  const alertShare = () => A.budget.alertAt / 100;
  // Бюджет ключа администратора, расход на ключе и на своем ключе, лимиты и дела администратора считает
  // DATA.ai — один расчет для всех экранов (главная, «ИИ и расходы», личный кабинет, этот раздел).
  const AI = D.ai;
  const ratio = u => { const L = AI.limitOf(u); return L && L.monthly ? AI.keySpent(u) / L.monthly : null; };
  const toneOf = r => r == null ? null : r >= 1 ? 'bad' : r >= alertShare() ? 'warn' : null;
  // Потолок на один анализ для своего ключа задает сам участник (личный кабинет), администратор только видит
  const ownCap = u => u.ownCap != null ? u.ownCap : A.defaults.perAnalysis;
  const maskCode = c => c.slice(0, 4) + '••••-' + c.slice(-4);
  // Средняя цена анализа — по всем запускам «Анализ матчей», как на экране «ИИ и расходы»
  const avgAnalysis = () => { const rs = AI.runs.filter(r => r.type === 'analysis'); return rs.length ? sum(rs, r => r.cost) / rs.length : 0; };
  // День месяца в макете (для подписей «за 1–7 окт»); конец месяца — по daysLeft из DATA.ai.budget()
  const DAY = parts(TODAY)[2];
  const monthEnd = b => DAY + b.daysLeft;

  // Расход по задачам. В демо-данных запуски (DATA.ai.runs) есть только у одного человека, поэтому личный
  // расход каждого делим по задачам в тех же долях; общие фоновые задачи — как есть. Сумма сходится с бюджетом.
  function taskBreakdown() {
    const runs = AI.runs, personal = runs.filter(r => r.type !== 'refresh');
    const pCost = sum(personal, r => r.cost) || 1;
    const b = AI.budget(), membersSpent = b.spent - b.shared;
    const SHORT = { analysis: 'Анализ матчей', refresh: 'Профили', postmortem: 'Разбор ставок', parse: 'Разбор текста' };
    return AI.runTypes.map(t => {
      const rs = runs.filter(r => r.type === t.id);
      const input = sum(rs, r => r.input), cached = sum(rs, r => r.cached);
      const shared = t.id === 'refresh';
      return {
        id: t.id, label: shared ? 'Обновление профилей (общая задача, пакетом)' : t.label, short: SHORT[t.id] || t.label, model: t.model, shared,
        cost: shared ? b.shared : sum(rs, r => r.cost) / pCost * membersSpent, cache: input ? cached / input : 0,
      };
    }).sort((a, b) => b.cost - a.cost);
  }

  // ---------- журнал ----------
  const ACTIONS = {
    invite: ['Создано приглашение', 'userPlus'],
    invite_revoke: ['Приглашение отозвано', 'x'],
    reset_code: ['Выдан код сброса пароля', 'lock'],
    reset_code_revoke: ['Код сброса отозван', 'x'],
    reset_2fa: ['Сброшена 2FA', 'shield'],
    sessions_revoke: ['Завершены все сеансы', 'logout'],
    block: ['Заблокирован', 'ban'],
    unblock: ['Разблокирован', 'check'],
    delete: ['Удален участник', 'trash'],
    role_change: ['Изменена роль', 'admin'],
    create_admin: ['Создан администратор', 'admin'],
    limit_change: ['Изменен лимит', 'sliders'],
    budget_change: ['Изменен общий бюджет', 'coins'],
    key_change: ['Заменен ключ администратора', 'key'],
    ai_mode: ['Режим ключа Claude', 'key'],
    set_currency: ['Изменена валюта программы', 'currency'],
    settings: ['Изменены настройки программы', 'sliders'],
    message: ['Сообщение участникам', 'megaphone'],
  };
  const actionOf = e => ACTIONS[e.action] || [e.action, 'info'];
  const inGroup = list => e => list.includes(e.action);
  const AUDIT_GROUPS = [
    { id: 'all', label: 'Все действия', test: () => true },
    { id: 'invite', label: 'Приглашения', test: inGroup(['invite', 'invite_revoke']) },
    { id: 'access', label: 'Пароли, 2FA и сеансы', test: inGroup(['reset_code', 'reset_code_revoke', 'reset_2fa', 'sessions_revoke']) },
    { id: 'people', label: 'Блокировка, роли, удаление', test: inGroup(['block', 'unblock', 'delete', 'role_change', 'create_admin']) },
    { id: 'money', label: 'Ключ, бюджет и лимиты', test: inGroup(['key_change', 'limit_change', 'budget_change', 'ai_mode']) },
    { id: 'settings', label: 'Валюта, настройки, сообщения', test: inGroup(['set_currency', 'settings', 'message']) },
    { id: 'terminal', label: 'Команды терминала', test: e => e.actor === 'терминал' },
  ];
  const entry = (action, target, details) => ({ at: tick(), actor: D.user.name, action, target: target || null, details, ip: '95.216.•.•' });
  function log(action, target, details, e) {
    e = e || entry(action, target, details);
    A.audit.unshift(Object.assign({}, e, { fresh: true }));
    return e;
  }

  // ---------- состояние экрана ----------
  const TABS = [
    { id: 'overview', label: 'Обзор', short: 'Обзор', icon: 'layers' },
    { id: 'users', label: 'Участники', short: 'Участники', icon: 'users' },
    { id: 'invites', label: 'Приглашения', short: 'Приглашения', icon: 'userPlus' },
    { id: 'access', label: 'Сброс доступа', short: 'Сброс доступа', icon: 'lock' },
    { id: 'key', label: 'Ключ и бюджет', short: 'Ключ и бюджет', icon: 'key' },
    { id: 'usage', label: 'Расход ИИ', short: 'Расход ИИ', icon: 'coins' },
    { id: 'settings', label: 'Настройки', short: 'Настройки', icon: 'sliders' },
    { id: 'audit', label: 'Журнал', short: 'Журнал', icon: 'history' },
    { id: 'message', label: 'Сообщение', short: 'Сообщение', icon: 'megaphone' },
  ];
  const st = {
    tab: 'overview',
    userFilter: 'all',
    auditFilter: 'all',
    keyForm: false,
    resetUser: '', resetShown: null, // выданный код показывается один раз: до ухода с вкладки или «Скрыть»
    twofaUser: '',
    tz: 'Europe/Helsinki',
    msg: { to: 'all', user: '', text: '' },
  };
  const TZ = D.timezones.map(t => ({ value: t.value, label: t.label }));
  const tzLabel = v => (TZ.find(t => t.value === v) || { label: v }).label.replace(/ \(.*\)$/, '');
  const CLI = 'docker compose exec api python -m app.admin.cli';

  // ---------- стили ----------
  UI.css('admin', `
    .adm-anchor { scroll-margin-top: calc(var(--topbar-h) + 16px); }
    .adm-head h2 { font-size: var(--fs-2xl); }
    .adm-head .eyebrow { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
    .adm-head .eyebrow svg { width: 14px; height: 14px; flex: none; }
    .adm-private { display: inline-flex; align-items: center; gap: 6px; margin-top: 10px; padding: 4px 10px; border-radius: 999px; background: var(--surface-2); color: var(--fg-2); font-size: var(--fs-sm); }
    .adm-private svg { width: 15px; height: 15px; flex: none; }
    .adm-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    /* 9 вкладок: на широком экране — строка (с иконками от 1521px), уже — сетка кнопок, как в личном кабинете на телефоне */
    .tabs.adm-tabs button { display: inline-flex; align-items: center; gap: 7px; padding: 10px 11px; }
    .tabs.adm-tabs button svg { width: 16px; height: 16px; flex: none; display: none; }
    @media (min-width: 1521px) { .tabs.adm-tabs button svg { display: block; } }
    .adm-tab-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); flex: none; }
    @media (max-width: 1280px) {
      .tabs.adm-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 6px; border-bottom: 0; overflow: visible; }
      .tabs.adm-tabs button { justify-content: center; padding: 8px 4px; min-height: 42px; border: 1px solid var(--line); border-radius: var(--r-md); margin: 0; background: var(--surface); color: var(--fg-2); font-size: var(--fs-sm); line-height: 1.25; white-space: normal; text-align: center; min-width: 0; }
      .tabs.adm-tabs button:hover { color: var(--fg); border-color: var(--line-strong); }
      .tabs.adm-tabs button[aria-selected="true"] { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent); }
    }
    @media (max-width: 960px) { .tabs.adm-tabs { grid-template-columns: repeat(3, minmax(0, 1fr)); } }

    .adm-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; outline: none; }
    .adm-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .adm-col > .card.adm-fill { flex: 1 1 auto; }
    .card.adm-fill > .card-body { flex: 1 1 auto; }
    .card.adm-nowrap-head > .card-head { flex-wrap: nowrap; }
    .card.adm-nowrap-head > .card-head > div:first-child { flex: 1 1 auto; }
    .card.adm-nowrap-head > .card-head > .row { flex: none; }
    .adm-bleed { margin: 0 -18px; }
    @media (max-width: 720px) { .adm-bleed { margin: 0 -14px; } }
    .adm-main { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
    @media (max-width: 1180px) { .adm-main { grid-template-columns: minmax(0, 1fr); } }
    .adm-third { grid-column: span 4; min-width: 0; display: flex; flex-direction: column; }
    .adm-third > .card { flex: 1; }
    @media (max-width: 720px) { .grid > .adm-third { grid-column: span 12; } }
    .adm-narrow-only { display: none; }
    @media (max-width: 1280px) { .adm-wide-only { display: none !important; } .adm-narrow-only { display: flex; } }
    .adm-howto { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; }
    .adm-howto svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
    .adm-toolbar { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .card-head .chip { align-self: center; }

    /* плитки обзора */
    .card.adm-tile { padding: 16px 18px; gap: 6px; }
    .adm-tile-value { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .adm-tile-value code { font-family: var(--font-mono); font-size: var(--fs-xl); font-weight: 500; letter-spacing: 0; overflow-wrap: anywhere; }
    .adm-of { color: var(--fg-3); font-size: var(--fs-lg); font-weight: 500; font-family: var(--font-body); letter-spacing: 0; white-space: nowrap; }
    .adm-tile-sub { font-size: var(--fs-sm); color: var(--fg-2); }
    .adm-tile-foot { margin-top: auto; padding-top: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
    .adm-tile-foot .btn.ghost { margin-right: -10px; }
    @media (max-width: 720px) { .card.adm-tile { padding: 14px; } .adm-tile-value { font-size: var(--fs-xl); } }

    /* что требует внимания */
    .adm-att-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .adm-att { display: grid; grid-template-columns: 36px minmax(0, 1fr); gap: 8px 12px; align-items: start; padding: 12px 0; border-bottom: 1px solid var(--line); }
    .adm-att:first-child { padding-top: 2px; }
    .adm-att:last-child { border-bottom: 0; padding-bottom: 0; }
    .adm-att-ic { width: 36px; height: 36px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .adm-att-ic svg { width: 18px; height: 18px; }
    .adm-att-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .adm-att-ic.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .adm-att-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .adm-att-ic.good { background: var(--good-soft); color: var(--good-ink); }
    .adm-att-title { font-weight: 600; }
    .adm-att-meta { font-size: var(--fs-sm); color: var(--fg-2); margin-top: 2px; }
    .adm-att-actions { grid-column: 2; display: flex; gap: 8px; flex-wrap: wrap; }

    /* бюджет */
    .adm-big { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .adm-big .chip { margin-left: auto; align-self: center; }
    .adm-bar-wrap { display: flex; flex-direction: column; gap: 8px; }
    .adm-bar { position: relative; height: 12px; border-radius: 999px; background: var(--surface-3); }
    .adm-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
    .adm-bar .proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 42%, transparent) 0 3px, color-mix(in srgb, var(--accent) 16%, transparent) 3px 7px); }
    .adm-bar .spent { background: var(--accent); }
    .adm-bar .spent.warn { background: var(--warn); }
    .adm-bar .spent.bad { background: var(--bad); }
    .adm-bar .mark { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; border-radius: 1px; background: var(--fg-2); }
    .adm-legend { display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: var(--fs-xs); color: var(--fg-2); }
    .adm-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .adm-legend i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .adm-legend i.spent { background: var(--accent); }
    .adm-legend i.proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 50%, transparent) 0 2px, color-mix(in srgb, var(--accent) 18%, transparent) 2px 4px); }
    .adm-legend i.mark { width: 2px; height: 12px; border-radius: 1px; background: var(--fg-2); }
    .adm-kv3 { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding-top: 12px; border-top: 1px solid var(--line); }
    .adm-kv3 > div { min-width: 0; }
    .adm-kv3 dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .adm-kv3 dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .adm-kv3 dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }

    /* люди */
    .adm-ava { width: 36px; height: 36px; border-radius: 50%; flex: none; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); font-family: var(--font-display); font-weight: 600; font-size: var(--fs-sm); }
    .adm-ava.me { background: var(--accent); color: var(--accent-fg); }
    .adm-person { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .adm-person > div { min-width: 0; }
    .adm-person-name { font-weight: 600; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .adm-person-mail { font-size: var(--fs-xs); color: var(--fg-3); overflow-wrap: anywhere; }
    .adm-person-box { padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); }
    .adm-person-box .adm-ava { background: var(--surface); }
    .adm-cell2 { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
    .adm-sub { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .adm-nowrap { white-space: nowrap; }
    .adm-spend { display: flex; flex-direction: column; gap: 5px; min-width: 130px; }
    .adm-spend-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; font-size: var(--fs-sm); white-space: nowrap; }
    .adm-spend-top b { font-weight: 600; font-variant-numeric: tabular-nums; }
    .adm-spend .meter { height: 6px; }
    .adm-users-table tr.is-blocked .adm-person, .adm-users-table tr.is-blocked .adm-spend { opacity: .6; }
    .adm-users-table td:last-child { width: 1%; }
    .adm-users-wrap { border-top: 1px solid var(--line); }
    .btn.adm-more svg { stroke-width: 3.2; width: 20px; height: 20px; }
    .btn.adm-more { color: var(--fg-2); }
    .adm-users-table .adm-person { min-width: 230px; }
    .adm-ucards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 720px) { .adm-ucards { grid-template-columns: minmax(0, 1fr); } }
    .card.adm-ucard { padding: 14px; gap: 12px; }
    .adm-ucard-head { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; gap: 10px; align-items: center; }
    .adm-ucard-head .adm-ava { width: 40px; height: 40px; }
    .adm-ucard.is-blocked .adm-ava, .adm-ucard.is-blocked .adm-spend { opacity: .6; }
    .adm-chips { gap: 6px; }
    .adm-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .adm-facts.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .adm-facts > div { background: var(--surface); padding: 8px 10px; min-width: 0; }
    .adm-facts dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .adm-facts dd { margin: 2px 0 0; font-weight: 600; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }

    /* списки */
    .adm-list { display: flex; flex-direction: column; min-width: 0; }
    .adm-item { display: grid; grid-template-columns: 40px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--line); min-width: 0; }
    .adm-item:first-child { padding-top: 2px; }
    .adm-item:last-child { border-bottom: 0; padding-bottom: 2px; }
    .adm-item-ic { width: 40px; height: 40px; border-radius: var(--r-md); background: var(--surface-2); color: var(--fg-2); display: grid; place-items: center; }
    .adm-item-ic svg { width: 20px; height: 20px; }
    .adm-item-ic.good { background: var(--good-soft); color: var(--good-ink); }
    .adm-item-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .adm-item-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .adm-item-title { font-weight: 600; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; min-width: 0; overflow-wrap: anywhere; }
    .adm-item-meta { font-size: var(--fs-sm); color: var(--fg-3); overflow-wrap: anywhere; }
    .adm-item-side { display: flex; align-items: center; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
    .adm-item.is-old { opacity: .75; }
    @media (max-width: 720px) { .adm-item { grid-template-columns: 40px minmax(0, 1fr); align-items: start; } .adm-item-side { grid-column: 2; justify-content: flex-start; } .adm-item-side:empty { display: none; } }
    .adm-group { display: flex; flex-direction: column; gap: 4px; }
    .adm-group + .adm-group { border-top: 1px solid var(--line-strong); padding-top: 14px; }
    .adm-group-title { display: flex; align-items: center; gap: 8px; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); font-weight: 600; margin-bottom: 6px; }
    .adm-empty { font-size: var(--fs-sm); color: var(--fg-3); padding: 2px 0 4px; }

    /* меню строки */
    .adm-menu { position: fixed; z-index: 70; min-width: 260px; max-width: min(340px, calc(100vw - 24px)); background: var(--dd-bg); color: var(--fg); border: 1px solid var(--dd-border); border-radius: var(--r-lg); box-shadow: var(--dd-shadow); padding: 6px; animation: dd-in .14s ease-out; }
    .adm-menu-head { padding: 6px 10px 8px; font-size: var(--fs-xs); color: var(--fg-3); font-weight: 600; }
    .adm-menu-item { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 10px; border: 0; background: none; border-radius: var(--r-sm); color: var(--fg); text-align: left; cursor: pointer; font: inherit; font-size: var(--fs-md); line-height: 1.3; }
    .adm-menu-item svg { width: 18px; height: 18px; flex: none; margin-top: 1px; color: var(--fg-2); }
    .adm-menu-item:hover:not([disabled]), .adm-menu-item:focus-visible { background: var(--dd-active); outline: none; }
    .adm-menu-item.danger, .adm-menu-item.danger svg { color: var(--bad-ink); }
    .adm-menu-item[disabled] { cursor: not-allowed; color: var(--fg-3); }
    .adm-menu-item[disabled] svg { color: var(--fg-3); opacity: .7; }
    .adm-menu-item small { display: block; font-size: var(--fs-xs); color: var(--fg-3); margin-top: 1px; }
    .adm-menu-sep { height: 1px; background: var(--line); margin: 4px 6px; }
    .adm-sheet { display: flex; flex-direction: column; margin: -6px -8px; }
    .adm-sheet .adm-menu-item { min-height: 48px; padding: 12px; align-items: center; }
    .adm-sheet .adm-menu-item small { margin-top: 2px; }

    /* формы */
    .adm-fields { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; align-items: end; }
    .adm-fields.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 480px) { .adm-fields { gap: 8px; } .adm-fields .field-label { font-size: var(--fs-xs); } }
    .adm-presets { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: var(--fs-xs); color: var(--fg-3); }
    .adm-pill { border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg-2); border-radius: 999px; padding: 4px 12px; min-height: 32px; font: inherit; font-size: var(--fs-sm); font-weight: 600; cursor: pointer; font-variant-numeric: tabular-nums; }
    .adm-pill:hover { background: var(--surface-2); }
    .adm-pill[aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-ink); border-color: var(--accent); }
    @media (max-width: 960px) { .adm-pill { min-height: 40px; padding: 4px 14px; } }
    .adm-choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin: 0; padding: 0; border: 0; min-width: 0; }
    .adm-choices.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .adm-choices legend { font-size: var(--fs-sm); font-weight: 500; color: var(--fg-2); padding: 0; margin-bottom: -4px; float: left; width: 100%; grid-column: 1 / -1; }
    .adm-choice { position: relative; display: flex; gap: 10px; align-items: flex-start; padding: 12px; border: 1px solid var(--line-strong); border-radius: var(--r-md); cursor: pointer; background: var(--surface); color: var(--fg); font: inherit; text-align: left; min-width: 0; }
    .adm-choice input { margin: 3px 0 0; accent-color: var(--accent); width: 16px; height: 16px; flex: none; }
    .adm-choice:has(input:checked), .adm-choice[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
    .adm-choice:hover { border-color: var(--fg-3); }
    .adm-choice b { display: block; font-weight: 600; }
    .adm-choice small { display: block; color: var(--fg-2); font-size: var(--fs-xs); margin-top: 2px; line-height: 1.4; }
    .adm-choice-sym { font-family: var(--font-display); font-weight: 700; font-size: var(--fs-xl); width: 28px; line-height: 1.1; text-align: center; flex: none; color: var(--accent-ink); }
    @media (max-width: 720px) { .adm-choices, .adm-choices.three { grid-template-columns: minmax(0, 1fr); } }
    .input.adm-otp { font-family: var(--font-mono); font-size: var(--fs-lg); letter-spacing: .3em; max-width: 220px; }
    .adm-check { display: flex; align-items: flex-start; gap: 10px; font-size: var(--fs-sm); cursor: pointer; color: var(--fg-2); }
    .adm-check input { width: 18px; height: 18px; margin: 1px 0 0; accent-color: var(--accent); flex: none; }

    /* коды и секреты */
    .adm-code { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 16px; border-radius: var(--r-md); background: var(--surface-2); border: 1px dashed var(--line-strong); flex-wrap: wrap; }
    .adm-code code { font-family: var(--font-mono); font-size: 1.5rem; letter-spacing: .06em; font-weight: 500; color: var(--fg); }
    .adm-secret { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; flex-wrap: wrap; }
    .adm-secret > svg { width: 18px; height: 18px; color: var(--fg-3); flex: none; }
    .adm-secret code { font-family: var(--font-mono); font-size: var(--fs-lg); color: var(--fg); }
    .adm-secret .chip { margin-left: auto; }
    .adm-ext { display: flex; flex-direction: column; gap: 4px; padding-top: 12px; border-top: 1px solid var(--line); }
    .adm-link { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; min-height: 32px; align-self: flex-start; }
    .adm-link svg { width: 16px; height: 16px; flex: none; }
    .adm-form { display: flex; flex-direction: column; gap: 12px; padding: 14px; border: 1px solid var(--line); border-radius: var(--r-md); }
    .adm-steps { list-style: none; counter-reset: s; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .adm-steps li { counter-increment: s; display: grid; grid-template-columns: 26px minmax(0, 1fr); gap: 10px; font-size: var(--fs-sm); color: var(--fg-2); align-items: start; }
    .adm-steps li::before { content: counter(s); width: 26px; height: 26px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; font-weight: 700; font-size: var(--fs-xs); }
    .adm-steps b { color: var(--fg); font-weight: 600; }
    .adm-bul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; font-size: var(--fs-sm); color: var(--fg-2); }
    .adm-bul li { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
    .adm-bul svg { width: 16px; height: 16px; flex: none; margin-top: 2px; }
    .adm-bul.gone svg { color: var(--bad-ink); }
    .adm-bul.stay svg { color: var(--good-ink); }
    .adm-two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .adm-box { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .adm-box h4 { font-size: var(--fs-sm); }
    @media (max-width: 720px) { .adm-two { grid-template-columns: minmax(0, 1fr); } }

    /* команды терминала */
    .adm-cmds { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 16px; }
    @media (max-width: 1180px) { .adm-cmds { grid-template-columns: minmax(0, 1fr); } }
    .adm-cmds li { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .adm-cmd-desc { font-size: var(--fs-sm); color: var(--fg-2); }
    .adm-cmd-desc b { font-family: var(--font-mono); font-weight: 500; color: var(--fg); }
    .adm-pre { display: flex; align-items: flex-start; gap: 6px; padding: 8px 6px 8px 12px; border-radius: var(--r-md); background: var(--surface-2); border: 1px solid var(--line); }
    .adm-pre code { flex: 1; min-width: 0; padding-top: 6px; font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
    .adm-pre .btn { flex: none; }

    /* ключ и лимиты */
    .adm-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .adm-rule { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); color: var(--fg-2); align-items: start; }
    .adm-rule:first-child { padding-top: 0; }
    .adm-rule:last-child { border-bottom: 0; padding-bottom: 0; }
    .adm-rule-k { font-weight: 600; color: var(--fg); display: flex; align-items: flex-start; gap: 8px; }
    .adm-rule-k i { width: 8px; height: 8px; border-radius: 50%; flex: none; margin-top: 6px; background: var(--fg-3); }
    .adm-rule-k i.warn { background: var(--warn); }
    .adm-rule-k i.bad { background: var(--bad); }
    @media (max-width: 480px) { .adm-rule { grid-template-columns: minmax(0, 1fr); gap: 2px; } }
    .adm-limits-table td { vertical-align: middle; }
    .adm-limits-table .switch { display: inline-block; vertical-align: middle; }
    .adm-defaults { display: flex; align-items: center; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; padding: 10px 14px; border-radius: var(--r-md); background: var(--surface-2); }
    .adm-defaults-v { font-weight: 600; font-variant-numeric: tabular-nums; }
    .adm-rules.cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 12px; }
    .adm-rules.cols .adm-rule { display: flex; flex-direction: column; gap: 4px; padding: 12px; border: 1px solid var(--line); border-radius: var(--r-md); }
    @media (max-width: 720px) { .adm-rules.cols { display: flex; flex-direction: column; gap: 0; } .adm-rules.cols .adm-rule { border: 0; border-bottom: 1px solid var(--line); border-radius: 0; padding: 10px 0; } .adm-rules.cols .adm-rule:last-child { border-bottom: 0; } }
    .adm-limits-table .adm-muted-cell { color: var(--fg-3); }
    .adm-limits-table td:last-child { width: 1%; white-space: nowrap; }
    .adm-lcards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 720px) { .adm-lcards { grid-template-columns: minmax(0, 1fr); } }
    .adm-lcard { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .adm-lcard-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    @keyframes adm-flash { 0%, 55% { background: var(--warn-soft); } 100% { background: transparent; } }
    tr.adm-flash > td, .adm-lcard.adm-flash { animation: adm-flash 2.8s ease-out; }

    /* расход по людям */
    .adm-stack { display: flex; height: 16px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .adm-stack > i { height: 100%; flex: none; }
    .adm-stack > i + i { box-shadow: inset 2px 0 0 var(--surface); }
    .adm-urows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .adm-urow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 11px 0; border-bottom: 1px solid var(--line); align-items: center; }
    .adm-urow:first-child { padding-top: 2px; }
    .adm-urow:last-child { border-bottom: 0; padding-bottom: 0; }
    .adm-urow-name { font-weight: 600; display: flex; align-items: center; gap: 8px; min-width: 0; flex-wrap: wrap; }
    .adm-sw { width: 10px; height: 10px; border-radius: 3px; flex: none; }
    .adm-urow-meta { grid-column: 1; font-size: var(--fs-xs); color: var(--fg-3); }
    .adm-urow-val { grid-column: 2; grid-row: 1 / 3; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .adm-urow-val b { display: block; font-weight: 600; }
    .adm-urow-val small { display: block; font-size: var(--fs-xs); color: var(--fg-3); }
    .adm-urow-bar { grid-column: 1 / -1; height: 6px; border-radius: 999px; background: var(--surface-2); margin-top: 6px; position: relative; overflow: hidden; }
    .adm-urow-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
    .adm-urows.compact .adm-urow { padding: 8px 0; }
    .adm-urows.compact .adm-urow:first-child { padding-top: 0; }
    .adm-urows.compact .adm-urow-bar { height: 4px; margin-top: 4px; }
    .adm-urow.adm-total { border-top: 1px solid var(--line-strong); margin-top: -1px; }
    .adm-urow.adm-total .adm-urow-name { font-weight: 700; }
    .adm-urows .adm-urow.adm-total:last-child { padding-top: 11px; }
    .adm-urows.compact .adm-urow.adm-total:last-child { padding-top: 8px; }

    /* обзор: последние действия, журнал */
    .adm-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .adm-recent li { display: grid; grid-template-columns: 32px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-bottom: 1px solid var(--line); }
    .adm-recent li:first-child { padding-top: 0; }
    .adm-recent li:last-child { border-bottom: 0; padding-bottom: 0; }
    .adm-recent-ic { width: 32px; height: 32px; border-radius: 50%; background: var(--surface-2); color: var(--fg-2); display: grid; place-items: center; }
    .adm-recent-ic svg { width: 16px; height: 16px; }
    .adm-recent-text { min-width: 0; font-size: var(--fs-sm); overflow-wrap: anywhere; }
    .adm-recent-text .muted { font-size: var(--fs-xs); }
    .adm-actor { display: inline-flex; align-items: center; gap: 6px; }
    .adm-actor svg { width: 14px; height: 14px; flex: none; }
    .adm-ip { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .adm-audit-table td { vertical-align: top; }
    .adm-audit-table tr.is-fresh td { background: color-mix(in srgb, var(--accent-soft) 55%, transparent); }
    .adm-log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; width: 100%; }
    .adm-log li { display: flex; flex-direction: column; gap: 3px; padding: 12px 0; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); min-width: 0; }
    .adm-log li:first-child { padding-top: 0; }
    .adm-log li:last-child { border-bottom: 0; padding-bottom: 0; }
    .adm-log-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .adm-log-top b { font-weight: 600; color: var(--fg); min-width: 0; }
    .adm-log-when { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .adm-log-det { color: var(--fg-2); overflow-wrap: anywhere; }
    .adm-log-who { color: var(--fg-3); font-size: var(--fs-xs); display: flex; flex-wrap: wrap; gap: 4px 10px; align-items: center; }

    /* настройки */
    .adm-cur-now { display: flex; align-items: center; gap: 14px; }
    .adm-cur-sym { width: 56px; height: 56px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; font-family: var(--font-display); font-weight: 700; font-size: 1.6rem; flex: none; }
    .adm-cur-name { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-xl); }
    .adm-swap { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-weight: 600; font-size: var(--fs-lg); flex-wrap: wrap; }
    .adm-swap svg { width: 18px; height: 18px; color: var(--fg-3); }
    .adm-preview { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); color: var(--fg-2); }
    .adm-preview b { color: var(--fg); font-variant-numeric: tabular-nums; }

    /* сообщение */
    .adm-notif { border: 1px solid var(--line); border-radius: var(--r-lg); background: var(--dd-bg); overflow: hidden; }
    .adm-notif .notif-head { padding: 10px 14px 8px; }
    .adm-notif .notif-list { padding: 6px; }
    .adm-notif .notif-item { cursor: default; }
    .adm-notif .notif-item:hover { background: none; }
    .adm-notif .notif-body { white-space: pre-wrap; overflow-wrap: anywhere; }
    .adm-count { font-variant-numeric: tabular-nums; color: var(--fg-3); font-weight: 400; }
    .adm-count.warn { color: var(--warn-ink); font-weight: 600; }
  `);

  // ---------- общие кусочки ----------
  let headSlot = null, tabsSlot = null, panelEl = null;
  const howto = text => h('div', { class: 'adm-howto' }, icon('info'), h('span', null, text));
  const valOf = f => f.querySelector('input, select, textarea').value;

  function setErr(fieldEl, msg) {
    const input = fieldEl.querySelector('input, select, textarea');
    let err = fieldEl.querySelector('.field-error');
    const hint = fieldEl.querySelector('.field-hint');
    if (!msg) {
      if (err) err.remove();
      if (hint) hint.hidden = false;
      input.classList.remove('invalid'); input.removeAttribute('aria-invalid');
      return true;
    }
    if (!err) { err = h('div', { class: 'field-error', role: 'alert', id: input.id + '-err' }); fieldEl.appendChild(err); }
    err.textContent = msg;
    if (hint) hint.hidden = true;
    input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', err.id);
    return false;
  }

  function busy(btn, text, ms, done) {
    const label = btn.querySelector('span');
    const old = label ? label.textContent : '';
    btn.disabled = true; if (label) label.textContent = text;
    setTimeout(() => { if (btn.isConnected) { btn.disabled = false; if (label) label.textContent = old; } done(); }, ms);
  }

  function copy(text, msg) {
    const done = () => UI.toast(msg || 'Скопировано', 'copy');
    try { navigator.clipboard.writeText(text).then(done, done); } catch (e) { done(); }
  }

  const ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function genCode(prefix) {
    const part = () => Array.from({ length: 4 }, () => ALPH[Math.floor(Math.random() * ALPH.length)]).join('');
    return prefix + '-' + part() + '-' + part();
  }

  function avatar(u) { return h('span', { class: ['adm-ava', isMe(u) && 'me'], 'aria-hidden': 'true' }, initials(u.name)); }
  function personRow(u, boxed) {
    return h('div', { class: ['adm-person', boxed && 'adm-person-box'] }, avatar(u),
      h('div', null, h('div', { class: 'adm-person-name' }, u.name, isMe(u) && chip('вы', 'accent')), h('div', { class: 'adm-person-mail' }, u.email)));
  }
  const roleChip = u => u.role === 'admin' ? chip('Администратор', 'accent', 'admin') : chip('Участник', 'outline');
  const statusChip = u => u.status === 'blocked' ? chip('Заблокирован', 'bad', 'ban') : chip('Активен', 'good');
  const twoFaChip = u => u.twoFa ? chip('2FA включена', 'good', 'shield') : u.twoFaReset ? chip('2FA сброшена', 'warn', 'shield') : chip('2FA не настроена', 'warn', 'alert');
  function keyChip(u) {
    return u.aiMode === 'own' ? chip('Свой ключ …' + (u.ownKey ? u.ownKey.last4 : '••••'), 'info', 'key') : chip('Ключ администратора', 'outline', 'key');
  }
  function keyCell(u) {
    if (u.aiMode === 'own') return h('div', { class: 'adm-cell2' }, h('span', { class: 'adm-nowrap' }, 'Свой ключ'), h('span', { class: 'adm-sub mono' }, 'sk-ant-…' + (u.ownKey ? u.ownKey.last4 : '••••')), u.returnRequested && chip('просит вернуть', 'warn', 'key'));
    const L = AI.limitOf(u);
    return h('div', { class: 'adm-cell2' }, h('span', { class: 'adm-nowrap' }, 'Ключ администратора'), h('span', { class: 'adm-sub' }, L ? limitShort(L) : 'без личного лимита'));
  }
  const limitShort = L => usdL(L.monthly) + ' · ' + L.daily + ' в день · ' + usdL(L.perAnalysis);

  function spendBlock(u) {
    const own = AI.ownSpent(u), onKey = AI.keySpent(u);
    if (u.aiMode === 'own') {
      return h('div', { class: 'adm-spend' },
        h('div', { class: 'adm-spend-top' }, h('span', null, h('b', null, usd(own)), ' · свой счет'), h('span', { class: 'muted' }, 'вне бюджета')),
        onKey > 0 ? h('span', { class: 'adm-sub' }, '+ ' + usd(onKey) + ' на вашем ключе до перехода') : null);
    }
    const L = AI.limitOf(u);
    if (!L) {
      return h('div', { class: 'adm-spend' },
        h('div', { class: 'adm-spend-top' }, h('span', null, h('b', null, usd(onKey))), h('span', { class: 'muted' }, 'в общем бюджете')),
        own > 0 ? h('span', { class: 'adm-sub' }, '+ ' + usd(own) + ' на своем ключе, вне бюджета') : null);
    }
    const r = ratio(u), t = toneOf(r);
    const m = UI.meter(onKey, L.monthly, t);
    m.setAttribute('aria-label', 'Израсходовано ' + usd(onKey) + ' из ' + usdL(L.monthly));
    return h('div', { class: 'adm-spend' },
      h('div', { class: 'adm-spend-top' }, h('span', null, h('b', null, usd(onKey)), ' из ' + usdL(L.monthly)), h('span', { class: t ? t + '-text' : 'muted' }, fmt.pct(r * 100, 0))),
      m,
      own > 0 ? h('span', { class: 'adm-sub' }, '+ ' + usd(own) + ' на своем ключе, вне бюджета') : null,
      L.paused ? chip('Анализы на паузе', 'warn', 'pause') : null);
  }
  function analysesCell(u) {
    const L = AI.limitOf(u), lim = L ? L.daily : null;
    return h('div', { class: 'adm-cell2', style: 'align-items:flex-end' },
      h('span', { class: 'mono' }, u.todayAnalyses + ' / ' + u.analyses),
      h('span', { class: 'adm-sub' }, lim ? 'сегодня из ' + lim : 'сегодня / месяц'));
  }

  function tile(o) {
    return h('section', { class: 'card adm-tile', 'aria-label': o.label },
      h('div', { class: 'stat-label' }, icon(o.icon, { width: 16, height: 16 }), o.label),
      h('div', { class: 'adm-tile-value' }, o.value),
      o.sub && h('div', { class: 'adm-tile-sub' }, o.sub),
      h('div', { class: 'adm-tile-foot' }, o.foot));
  }

  function item(o) { // {ic, icKind, title, titleExtra, meta, side, old}
    return h('div', { class: ['adm-item', o.old && 'is-old'] },
      h('span', { class: ['adm-item-ic', o.icKind], 'aria-hidden': 'true' }, icon(o.ic)),
      h('div', { style: 'min-width:0' }, h('div', { class: 'adm-item-title' }, o.title, o.titleExtra), o.meta && h('div', { class: 'adm-item-meta' }, o.meta)),
      h('div', { class: 'adm-item-side' }, o.side));
  }

  function codeBox(code, label) {
    return h('div', { class: 'adm-code' },
      h('code', { 'aria-label': label + ': ' + code.split('').join(' ') }, code),
      button('Скопировать', { kind: 'secondary', size: 'sm', icon: 'copy', onClick: () => copy(code, 'Код скопирован') }));
  }

  function switchInput(id, checked, label, onChange) {
    return h('span', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', id, checked: !!checked, 'aria-label': label, on: { change: e => onChange(e.target.checked) } }), h('span'));
  }

  // Поле для кода 2FA администратора: опасные действия требуют свежий код (раздел 7 плана)
  function otpField(id) {
    const input = h('input', { class: 'input adm-otp', id, type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', placeholder: '000000', 'aria-describedby': id + '-hint' });
    const node = h('div', { class: 'field' },
      h('label', { class: 'field-label', for: id }, h('span', null, 'Код 2FA из вашего приложения')),
      input,
      h('div', { class: 'field-hint', id: id + '-hint' }, 'Для опасных действий нужен свежий код, даже если вы уже вошли. В макете подойдут любые 6 цифр.'));
    let cb = () => {};
    input.addEventListener('input', () => { const v = input.value.replace(/\D/g, '').slice(0, 6); if (v !== input.value) input.value = v; cb(v.length === 6); });
    return { node, input, onValid: f => { cb = f; }, valid: () => input.value.length === 6 };
  }

  function confirmModal(o) {
    UI.modal({
      title: o.title,
      body: h('div', { class: 'stack' }, o.body),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button(o.confirmLabel, { kind: o.danger ? 'danger' : 'primary', icon: o.icon, onClick: () => { close(); o.onConfirm(); } }),
      ],
    });
  }

  function confirm2fa(o) {
    const otp = otpField(o.id || 'adm-otp');
    let go = null;
    UI.modal({
      title: o.title,
      body: h('div', { class: 'stack' }, o.body, otp.node),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        go = button(o.confirmLabel, { kind: o.danger ? 'danger' : 'primary', icon: o.icon, disabled: true, onClick: () => { if (!otp.valid()) return; close(); o.onConfirm(); } }),
      ],
    });
    otp.onValid(ok => { go.disabled = !ok; });
  }

  // Три поля лимита: в месяц, анализов в день, потолок на один анализ
  function limitFields(L, prefix) {
    const fm = UI.field({ id: prefix + '-m', label: 'В месяц, $', value: dec(L.monthly), inputmode: 'decimal', autocomplete: 'off' });
    const fd = UI.field({ id: prefix + '-d', label: 'Анализов в день', value: String(L.daily), inputmode: 'numeric', autocomplete: 'off' });
    const fp = UI.field({ id: prefix + '-p', label: 'На один анализ, $', value: dec(L.perAnalysis), inputmode: 'decimal', autocomplete: 'off' });
    const node = h('div', { class: 'adm-fields' }, fm, fd, fp);
    function read() {
      const m = num(valOf(fm)), d = Number(valOf(fd).trim()), p = num(valOf(fp));
      let ok = setErr(fm, m >= 1 && m <= 500 ? null : 'От $1 до $500');
      ok = setErr(fd, Number.isInteger(d) && d >= 1 && d <= 30 ? null : 'Целое число от 1 до 30') && ok;
      ok = setErr(fp, p >= 0.1 && p <= (m >= 1 ? m : 500) ? null : 'От $0,10 до месячного лимита') && ok;
      return ok ? { monthly: Math.round(m * 100) / 100, daily: d, perAnalysis: Math.round(p * 100) / 100 } : null;
    }
    return { node, read, month: fm };
  }
  function limitDiff(a, b) {
    const out = [];
    if (!a) return [limitText(b)];
    if (a.monthly !== b.monthly) out.push('в месяц ' + usdL(a.monthly) + ' → ' + usdL(b.monthly));
    if (a.daily !== b.daily) out.push('анализов в день ' + a.daily + ' → ' + b.daily);
    if (a.perAnalysis !== b.perAnalysis) out.push('на анализ ' + usdL(a.perAnalysis) + ' → ' + usdL(b.perAnalysis));
    return out;
  }

  // ---------- навигация ----------
  function markNotif(kind, u) {
    if (!UI.notifications) return;
    (D.notifications.admin || []).filter(n => n.kind === kind && n.title.indexOf(u.name) === 0).forEach(n => UI.notifications.markRead(n.id));
  }
  // Просьба вернуть ключ решена: уведомление 'req-<id>' (его кладет «Личный кабинет») убираем, демо-уведомления отмечаем прочитанными
  function dropRequest(u) {
    const list = D.notifications.admin || [];
    for (let i = list.length - 1; i >= 0; i--) if (list[i].id === 'req-' + u.id) list.splice(i, 1);
    markNotif('ai_mode_request', u);
  }
  // После действия перерисовываем весь экран вместе с оболочкой: счетчик в меню и колокольчик считает app.js.
  // Вкладка сохраняется (она в адресе), позиция прокрутки — тоже.
  function refresh() {
    const y = window.scrollY;
    if (location.hash === '#admin-limits') { try { history.replaceState(history.state, '', location.href.split('#')[0] + '#admin-key'); } catch (e) { /* не страшно */ } }
    if (UI.rerender) UI.rerender(); else { drawHead(); drawTabs(); drawPanel(); }
    window.scrollTo(0, y);
  }
  function redrawPanel() { const y = window.scrollY; drawPanel(); window.scrollTo(0, y); }
  function toTabs() {
    if (!tabsSlot) return;
    const r = tabsSlot.getBoundingClientRect();
    if (r.top < 0) tabsSlot.scrollIntoView({ block: 'start' });
  }
  function scrollToId(id, focusSel) {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    if (focusSel) { const f = el.querySelector(focusSel); if (f) f.focus({ preventScroll: true }); }
  }
  function switchTab(id, after, fromTabs) {
    const hadFocus = fromTabs || (document.activeElement && document.activeElement.getAttribute('role') === 'tab');
    if (st.tab !== id) st.resetShown = null;
    st.tab = id;
    closeMenu(false);
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#admin' + (id === 'overview' ? '' : '-' + id)); } catch (e) { /* в песочнице адрес может быть недоступен */ }
    drawTabs(); drawPanel();
    if (hadFocus) { const b = tabsSlot.querySelector('[aria-selected="true"]'); if (b) b.focus({ preventScroll: true }); }
    requestAnimationFrame(after || toTabs);
  }

  // ---------- меню строки участника ----------
  let menu = null;
  function closeMenu(focusBack) {
    if (!menu) return;
    const m = menu; menu = null;
    m.el.remove();
    document.removeEventListener('pointerdown', m.onDown, true);
    document.removeEventListener('keydown', m.onKey, true);
    window.removeEventListener('scroll', m.onAway, true);
    window.removeEventListener('resize', m.onAway);
    window.removeEventListener('hashchange', m.onAway);
    m.anchor.setAttribute('aria-expanded', 'false');
    if (focusBack && m.anchor.isConnected) m.anchor.focus();
  }
  function menuItem(it, onPick) {
    return h('button', { type: 'button', role: 'menuitem', class: ['adm-menu-item', it.danger && 'danger'], disabled: !!it.disabled, on: { click: onPick } },
      icon(it.icon), h('span', null, it.label, it.hint && h('small', null, it.hint)));
  }
  function openMenu(anchor, title, items) {
    if (menu && menu.anchor === anchor) { closeMenu(true); return; }
    closeMenu(false);
    if (window.matchMedia('(max-width: 720px)').matches) { // телефон: шторка снизу
      UI.modal({ title, body: close => h('div', { class: 'adm-sheet', role: 'menu', 'aria-label': title }, items.map(it => it === 'sep' ? h('div', { class: 'adm-menu-sep', role: 'separator' }) : menuItem(it, () => { close(); it.onClick(); }))) });
      return;
    }
    const el = h('div', { class: 'adm-menu', role: 'menu', 'aria-label': title },
      h('div', { class: 'adm-menu-head', 'aria-hidden': 'true' }, title),
      items.map(it => it === 'sep' ? h('div', { class: 'adm-menu-sep', role: 'separator' }) : menuItem(it, () => { closeMenu(false); it.onClick(); })));
    document.body.appendChild(el);
    const r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    let top = r.bottom + 6;
    if (top + hh > vh - 12) top = r.top - hh - 6 >= 12 ? r.top - hh - 6 : Math.max(12, vh - hh - 12);
    el.style.left = Math.max(12, Math.min(vw - w - 12, r.right - w)) + 'px';
    el.style.top = top + 'px';
    const btns = () => Array.from(el.querySelectorAll('.adm-menu-item:not([disabled])'));
    const m = {
      el, anchor,
      onDown: e => { if (!el.contains(e.target) && !anchor.contains(e.target)) closeMenu(false); },
      onKey: e => {
        const list = btns(), i = list.indexOf(document.activeElement);
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); (list[i + 1] || list[0]).focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); (list[i - 1] || list[list.length - 1]).focus(); }
        else if (e.key === 'Home') { e.preventDefault(); list[0].focus(); }
        else if (e.key === 'End') { e.preventDefault(); list[list.length - 1].focus(); }
        else if (e.key === 'Tab') closeMenu(false);
      },
      onAway: () => closeMenu(false),
    };
    menu = m;
    anchor.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', m.onDown, true);
    document.addEventListener('keydown', m.onKey, true);
    window.addEventListener('scroll', m.onAway, true);
    window.addEventListener('resize', m.onAway);
    window.addEventListener('hashchange', m.onAway);
    const first = btns()[0];
    if (first) first.focus({ preventScroll: true });
  }
  function menuButton(u) {
    return button('', { kind: 'ghost', size: 'sm', icon: 'more', ariaLabel: 'Действия: ' + u.name, attrs: { class: 'btn ghost sm icon-only adm-more', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'data-user': u.id },
      onClick: e => openMenu(e.currentTarget, u.name + (isMe(u) ? ' (вы)' : ''), userMenu(u)) });
  }
  function userMenu(u) {
    const me = isMe(u), blocked = u.status === 'blocked';
    const items = [];
    if (me) items.push({ icon: 'user', label: 'Личный кабинет', hint: 'пароль, 2FA и ваши сеансы', onClick: () => UI.go('profile-security') });
    if (u.returnRequested && u.aiMode === 'own') {
      items.push({ icon: 'key', label: 'Разрешить вернуть ключ администратора', onClick: () => approveReturn(u) });
      items.push({ icon: 'x', label: 'Отклонить просьбу', hint: 'останется на своем ключе', onClick: () => rejectReturn(u) });
    }
    if (!me && AI.limitOf(u)) items.push({ icon: 'sliders', label: 'Изменить лимит', hint: 'лимит, пауза анализов', onClick: () => limitModal(u) });
    if (!me && u.aiMode === 'own') items.push({ icon: 'sliders', label: 'Потолок ' + usdL(ownCap(u)) + ' на анализ', disabled: true, hint: 'потолок задает участник, лимит трат — в его консоли Anthropic', onClick: () => {} });
    items.push('sep');
    items.push({ icon: 'lock', label: 'Выдать код сброса пароля', disabled: me, hint: me ? 'свой пароль — только командой в терминале' : 'код на 24 часа', onClick: () => resetCodeModal(u) });
    items.push({ icon: 'shield', label: 'Сбросить 2FA', disabled: me || !u.twoFa, hint: me ? 'свою 2FA — только командой в терминале' : !u.twoFa ? '2FA сейчас не настроена' : 'нужен ваш код 2FA', onClick: () => reset2fa(u) });
    items.push({ icon: 'logout', label: 'Завершить все сеансы', disabled: me, hint: me ? 'свои сеансы — в личном кабинете' : null, onClick: () => endSessions(u) });
    items.push({ icon: 'admin', label: u.role === 'admin' ? 'Сделать участником' : 'Сделать администратором', disabled: me, hint: me ? 'свою роль меняет другой администратор' : 'нужен ваш код 2FA', onClick: () => changeRole(u) });
    items.push('sep');
    if (blocked) items.push({ icon: 'check', label: 'Разблокировать', onClick: () => unblockUser(u) });
    else items.push({ icon: 'ban', label: 'Заблокировать', danger: !me, disabled: me, hint: me ? 'себя заблокировать нельзя' : null, onClick: () => blockUser(u) });
    items.push({ icon: 'trash', label: 'Удалить…', danger: !me, disabled: me, hint: me ? 'себя удалить нельзя' : 'нужен ваш код 2FA', onClick: () => deleteModal(u) });
    return items;
  }

  // =====================================================================
  // ДЕЙСТВИЯ
  // =====================================================================
  // Лимит участника на ключе администратора (на своем ключе лимиты и потолок задает сам участник)
  function limitModal(u) {
    const L0 = AI.limitOf(u);
    if (!L0) return;
    const lf = limitFields(L0, 'adm-lim');
    const info = h('div', { class: 'adm-preview', 'aria-live': 'polite' });
    let paused = !!L0.paused;
    const presetVals = [8, 10, 12, 15, 20];
    const presets = h('div', { class: 'adm-presets' }, h('span', null, 'Быстро:'));
    const monthInput = lf.month.querySelector('input');
    function drawPresets() {
      UI.clear(presets).appendChild(h('span', null, 'В месяц:'));
      presetVals.forEach(v => presets.appendChild(h('button', { type: 'button', class: 'adm-pill', 'aria-pressed': String(num(monthInput.value) === v), on: { click: () => { monthInput.value = String(v); drawInfo(); drawPresets(); } } }, '$' + v)));
    }
    function drawInfo() {
      const m = num(monthInput.value);
      const others = sum(people().filter(x => x.id !== u.id && AI.limitOf(x)), x => AI.limitOf(x).monthly);
      UI.clear(info);
      if (!(m > 0)) { info.appendChild(h('span', null, 'Введите лимит в долларах')); return; }
      const r = AI.keySpent(u) / m;
      info.appendChild(h('span', null, 'Израсходовано в октябре ', h('b', null, usd(AI.keySpent(u))), ' — это ', h('b', { class: r >= 1 ? 'bad-text' : r >= alertShare() ? 'warn-text' : null }, fmt.pct(r * 100, 0)), ' нового лимита.'));
      if (r >= 1) info.appendChild(h('span', { class: 'bad-text' }, 'Лимит меньше уже потраченного: анализы остановятся сразу.'));
      info.appendChild(h('span', null, 'Сумма личных лимитов станет ', h('b', null, usdL(Math.round((others + m) * 100) / 100)), ' при общем бюджете ', h('b', null, usdL(A.budget.monthly)), '.'));
    }
    monthInput.addEventListener('input', () => { drawInfo(); drawPresets(); });
    drawInfo(); drawPresets();
    UI.modal({
      title: 'Лимит на ключе администратора',
      body: h('div', { class: 'stack' },
        personRow(u, true),
        h('p', { class: 'small soft' }, 'Сегодня ' + pl(u.todayAnalyses, 'анализ', 'анализа', 'анализов') + ', за октябрь — ' + u.analyses + '. Лимит обнуляется 1-го числа.'),
        lf.node, presets, info,
        UI.toggle({ id: 'adm-lim-pause', label: 'Пауза', hint: 'Анализы на вашем ключе остановлены, пока вы не снимете паузу', checked: paused, onChange: v => { paused = v; } })),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Сохранить', { kind: 'primary', icon: 'check', onClick: () => {
          const L = lf.read();
          if (!L) return;
          L.paused = paused;
          const diff = limitDiff(L0, L);
          if (!!L0.paused !== paused) diff.push(paused ? 'анализы на паузе' : 'пауза снята');
          close();
          if (!diff.length) { UI.toast('Лимит не изменился', 'info'); return; }
          u.limit = L;
          log('limit_change', u.name, diff.join(', '));
          if (ratio(u) < alertShare()) markNotif('limit_80', u);
          UI.toast(u.name + ': ' + limitText(L), 'sliders');
          refresh();
        } }),
      ],
    });
  }

  function approveReturn(u) {
    const lf = limitFields(u.limit || A.defaults, 'adm-ret');
    UI.modal({
      title: 'Вернуть на ключ администратора',
      body: h('div', { class: 'stack' },
        personRow(u, true),
        h('p', { class: 'small soft' }, 'Просьба пришла ' + lc(when(u.returnRequested)) + '. Анализы участника снова пойдут с вашего ключа и будут считаться в общем бюджете. Его ключ sk-ant-…' + (u.ownKey ? u.ownKey.last4 : '••••') + ' отключится; расход на нем за октябрь (' + usd(AI.ownSpent(u)) + ') в ваш бюджет не войдет.'),
        h('div', { class: 'field-label' }, h('span', null, 'Лимит на вашем ключе')),
        lf.node,
        howto('По умолчанию для новых участников: ' + limitText(A.defaults) + '.')),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Разрешить', { kind: 'primary', icon: 'check', onClick: () => {
          const L = lf.read();
          if (!L) return;
          close();
          // u.ownSpent не трогаем: потраченное на своем ключе остается вне бюджета администратора
          u.aiMode = 'admin'; u.limit = L; u.returnRequested = null; u.ownKey = null;
          log('ai_mode', u.name, 'Разрешен возврат на ключ администратора: ' + limitText(L));
          dropRequest(u);
          UI.toast(u.name + ' снова на ключе администратора. Он увидит уведомление', 'key');
          refresh();
        } }),
      ],
    });
  }
  function rejectReturn(u) {
    confirmModal({
      title: 'Отклонить просьбу',
      body: [personRow(u, true), h('p', { class: 'small soft' }, 'Участник останется на своем ключе и платит сам. Он увидит уведомление, что просьба отклонена, и сможет попросить снова позже.')],
      confirmLabel: 'Отклонить',
      onConfirm: () => {
        u.returnRequested = null;
        log('ai_mode', u.name, 'Просьба вернуть ключ администратора отклонена');
        dropRequest(u);
        UI.toast('Просьба отклонена. ' + u.name + ' остается на своем ключе', 'x');
        refresh();
      },
    });
  }

  // Код сброса пароля (Р5): одноразовый, 24 часа, показывается один раз
  function issueResetCode(u) {
    const prev = A.resetCodes.filter(c => c.user === u.id && c.status === 'active');
    prev.forEach(c => { c.status = 'revoked'; });
    const code = genCode('RST'), at = now();
    A.resetCodes.unshift({ code, user: u.id, created: at, expires: addHours(at, 24), status: 'active', fresh: true });
    log('reset_code', u.name, 'Код сброса пароля, 24 часа' + (prev.length ? '; прежний код отозван' : ''));
    return { code, expires: addHours(at, 24), replaced: prev.length > 0 };
  }
  function resetInstructions(u) {
    return h('ol', { class: 'adm-steps' },
      h('li', null, h('span', null, h('b', null, 'Экран входа → «Забыли пароль?»'))),
      h('li', null, h('span', null, 'Ввести email ', h('b', null, u.email), ', этот код и новый пароль (не короче 12 символов)')),
      h('li', null, h('span', null, 'Войти с новым паролем и кодом 2FA. Все прежние сеансы участника завершатся')));
  }
  function resetCodeModal(u) {
    const r = issueResetCode(u);
    UI.modal({
      title: 'Код сброса пароля',
      body: h('div', { class: 'stack' },
        personRow(u, true),
        codeBox(r.code, 'Код сброса'),
        UI.callout('warn', 'clock', 'Код действует 24 часа — до ' + lc(when(r.expires)) + '. Передайте его участнику сами: почты и Telegram в программе нет. Код показывается один раз.' + (r.replaced ? ' Прежний код перестал действовать.' : '')),
        h('div', { class: 'eyebrow' }, 'Что делать участнику'),
        resetInstructions(u)),
      actions: close => [button('Готово', { kind: 'primary', onClick: close })],
      onClose: refresh,
    });
  }

  function reset2fa(u) {
    confirm2fa({
      id: 'adm-2fa-otp',
      title: 'Сбросить 2FA',
      body: [personRow(u, true),
        h('p', { class: 'small soft' }, 'Используйте, если участник потерял телефон с приложением-аутентификатором и резервные коды.'),
        h('ul', { class: 'adm-bul gone' },
          h('li', null, icon('x'), 'Секрет 2FA и резервные коды удалятся'),
          h('li', null, icon('x'), 'Все сеансы участника завершатся'),
          h('li', null, icon('check'), 'При следующем входе по паролю он настроит 2FA заново'))],
      confirmLabel: 'Сбросить 2FA', danger: true, icon: 'shield',
      onConfirm: () => {
        u.twoFa = false; u.twoFaReset = true;
        log('reset_2fa', u.name, '2FA и резервные коды сброшены, сеансы завершены');
        UI.toast('2FA сброшена: ' + u.name + ' настроит ее при следующем входе', 'shield');
        refresh();
      },
    });
  }
  function endSessions(u) {
    confirmModal({
      title: 'Завершить все сеансы',
      body: [personRow(u, true), h('p', { class: 'small soft' }, 'Участник выйдет на всех устройствах и войдет заново с паролем и кодом 2FA. Пароль и данные не меняются.')],
      confirmLabel: 'Завершить сеансы', icon: 'logout',
      onConfirm: () => {
        log('sessions_revoke', u.name, 'Все сеансы завершены');
        UI.toast('Сеансы завершены: ' + u.name + ' войдет заново', 'logout');
        refresh();
      },
    });
  }
  function changeRole(u) {
    const toAdmin = u.role !== 'admin';
    confirm2fa({
      id: 'adm-role-otp',
      title: toAdmin ? 'Сделать администратором' : 'Сделать участником',
      body: [personRow(u, true), h('p', { class: 'small soft' }, toAdmin
        ? 'Он увидит раздел «Администрирование»: участников, приглашения, ключ Claude, бюджет и журнал — и сможет делать все то же, что и вы. Ставки, банк и стратегию участников не видит никто из администраторов.'
        : 'Он перестанет видеть раздел «Администрирование». Его ставки, банк, стратегия и лимит на ИИ не изменятся.')],
      confirmLabel: toAdmin ? 'Сделать администратором' : 'Сделать участником', icon: 'admin',
      onConfirm: () => {
        const from = ROLE[u.role];
        u.role = toAdmin ? 'admin' : 'member';
        log('role_change', u.name, from + ' → ' + lc(ROLE[u.role]));
        UI.toast(u.name + ' — ' + lc(ROLE[u.role]), 'admin');
        refresh();
      },
    });
  }
  function blockUser(u) {
    confirmModal({
      title: 'Заблокировать',
      body: [personRow(u, true), h('p', { class: 'small soft' }, 'Участник не сможет войти, все его сеансы завершатся, анализы остановятся. Данные сохранятся — разблокировать можно в любой момент.')],
      confirmLabel: 'Заблокировать', danger: true, icon: 'ban',
      onConfirm: () => {
        u.status = 'blocked'; u.blockedAt = now();
        A.resetCodes.filter(c => c.user === u.id && c.status === 'active').forEach(c => { c.status = 'revoked'; });
        log('block', u.name, 'Заблокирован, сеансы завершены');
        UI.toast(u.name + ' заблокирован', 'ban');
        refresh();
      },
    });
  }
  function unblockUser(u) {
    u.status = 'active'; u.blockedAt = null;
    log('unblock', u.name, 'Разблокирован');
    UI.toast(u.name + ' разблокирован и может снова войти', 'check');
    refresh();
  }

  // Удаление (Р15): подтверждение вводом email и кодом 2FA администратора
  function deleteModal(u) {
    const email = h('input', { class: 'input', id: 'adm-del-email', type: 'email', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'adm-del-hint' });
    const otp = otpField('adm-del-otp');
    let del = null;
    const check = () => { if (del) del.disabled = !(email.value.trim().toLowerCase() === u.email && otp.valid()); };
    email.addEventListener('input', check);
    otp.onValid(check);
    const key = u.aiMode === 'own' ? 'Свой ключ Claude (sk-ant-…' + (u.ownKey ? u.ownKey.last4 : '••••') + ')' : 'Лимит на вашем ключе';
    const gone = ['Ставки и история банка', 'Банк и стратегия', 'Уроки модели', key, 'Сеансы, доверенные устройства, 2FA и резервные коды', 'Уведомления и коды сброса'];
    if (!u.consent) gone.push('Прогнозы — согласия на обезличенное использование нет');
    const stay = [];
    if (u.consent) stay.push('Прогнозы без имени и email — для обучения общей модели. Участник дал согласие при регистрации');
    stay.push('Запись в журнале: кто, когда и кого удалил');
    if (AI.keySpent(u) > 0) stay.push('Расход на вашем ключе за октябрь (' + usd(AI.keySpent(u)) + ') остается в общем бюджете: деньги уже потрачены');
    UI.modal({
      title: 'Удалить участника', wide: true,
      body: h('div', { class: 'stack' },
        personRow(u, true),
        h('div', { class: 'adm-two' },
          h('div', { class: 'adm-box' }, h('h4', { class: 'bad-text' }, 'Удалится навсегда'), h('ul', { class: 'adm-bul gone' }, gone.map(t => h('li', null, icon('x'), t)))),
          h('div', { class: 'adm-box' }, h('h4', { class: 'good-text' }, 'Останется'), h('ul', { class: 'adm-bul stay' }, stay.map(t => h('li', null, icon('check'), t))))),
        UI.callout('warn', 'alert', 'Восстановить нельзя. Вы не видите ставки и банк участника и не сможете выгрузить их за него — если данные ему нужны, попросите сделать экспорт в личном кабинете. Если нужно только закрыть доступ, заблокируйте: данные сохранятся.'),
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'adm-del-email' }, h('span', null, 'Введите email участника: ', h('b', { class: 'mono' }, u.email))),
          email,
          h('div', { class: 'field-hint', id: 'adm-del-hint' }, 'Кнопка станет активной, когда email совпадет и будет введен код 2FA')),
        otp.node),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        del = button('Удалить навсегда', { kind: 'danger', icon: 'trash', disabled: true, attrs: { id: 'adm-del-go' }, onClick: () => {
          if (del.disabled) return;
          close();
          u.status = 'deleted'; u.returnRequested = null;
          A.resetCodes.filter(c => c.user === u.id && c.status === 'active').forEach(c => { c.status = 'revoked'; });
          log('delete', u.name + ' (' + u.email + ')', u.consent
            ? 'Удалены ставки, банк, стратегия, уроки, ключ и сеансы. Обезличенные прогнозы сохранены: согласие при регистрации'
            : 'Удалены ставки, банк, стратегия, уроки, ключ, сеансы и прогнозы: согласия на обезличенное использование нет');
          UI.toast(u.name + ' удален. Запись — в журнале', 'trash');
          refresh();
        } }),
      ],
    });
  }

  // Приглашение (Р4): email, роль, режим ключа и стартовый лимит; код CAP-XXXX-XXXX на 7 дней, показывается один раз
  function inviteModal() {
    const draft = { role: 'member', aiMode: 'admin' };
    const body = h('div', { class: 'stack' }), foot = h('div', { style: 'display:contents' });
    let closeFn = () => {};
    const fEmail = UI.field({ id: 'adm-inv-email', label: 'Email', type: 'email', placeholder: 'name@example.com', autocomplete: 'off', hint: 'Код сработает только с этим email', attrs: { spellcheck: 'false' } });
    const fRole = UI.field({ id: 'adm-inv-role', label: 'Роль', options: [{ value: 'member', label: 'Участник' }, { value: 'admin', label: 'Администратор' }], value: 'member', hint: 'Свой банк, ставки и аналитика. Раздел «Администрирование» не видит' });
    fRole.querySelector('select').addEventListener('change', e => {
      draft.role = e.target.value;
      fRole.querySelector('.field-hint').textContent = draft.role === 'admin' ? 'Увидит раздел «Администрирование» и сможет управлять участниками' : 'Свой банк, ставки и аналитика. Раздел «Администрирование» не видит';
    });
    const limSlot = h('div', { class: 'stack', style: 'gap:8px' });
    let lf = null;
    const choice = (value, title, text) => h('label', { class: 'adm-choice' },
      h('input', { type: 'radio', name: 'adm-inv-mode', value, checked: draft.aiMode === value, on: { change: () => { draft.aiMode = value; drawLimits(); } } }),
      h('span', null, h('b', null, title), h('small', null, text)));
    const modes = h('fieldset', { class: 'adm-choices' }, h('legend', null, 'Ключ Claude'),
      choice('admin', 'Ключ администратора', 'Расход с вашего счета, в рамках лимита. Человеку ничего вводить не нужно'),
      choice('own', 'Свой ключ', 'Вставит свой ключ Anthropic после регистрации и платит сам. Инструкция встроена в приложение'));
    function drawLimits() {
      UI.clear(limSlot);
      if (draft.aiMode === 'admin') {
        lf = limitFields(A.defaults, 'adm-inv-lim');
        UI.append(limSlot, [h('div', { class: 'field-label' }, h('span', null, 'Стартовый лимит')), lf.node, howto('По умолчанию для новых участников: ' + limitText(A.defaults) + '. Меняется на вкладке «Ключ и бюджет».')]);
      } else {
        lf = null;
        limSlot.appendChild(howto('Лимиты человек задает сам: потолок на один анализ — в личном кабинете (по умолчанию ' + usdL(A.defaults.perAnalysis) + '), лимит трат — в своей консоли Anthropic.'));
      }
    }
    function drawForm() {
      drawLimits();
      UI.clear(body);
      UI.append(body, [
        h('p', { class: 'small soft' }, 'Регистрация в AI Capper — только по приглашению. Код одноразовый и действует 7 дней.'),
        fEmail, fRole, modes, limSlot]);
      UI.clear(foot);
      UI.append(foot, [
        button('Отмена', { kind: 'secondary', onClick: () => closeFn() }),
        button('Создать код', { kind: 'primary', icon: 'userPlus', attrs: { id: 'adm-inv-create' }, onClick: create })]);
    }
    function create() {
      const email = valOf(fEmail).trim().toLowerCase();
      let ok = true;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) ok = setErr(fEmail, 'Похоже, в адресе опечатка: нужен вид name@example.com');
      else if (people().some(u => u.email === email)) ok = setErr(fEmail, 'Этот email уже есть среди участников');
      else if (A.invites.some(i => i.email === email && i.status === 'active')) ok = setErr(fEmail, 'Для этого email уже есть активное приглашение — отзовите его или дождитесь регистрации');
      else setErr(fEmail, null);
      let L = null;
      if (lf) { L = lf.read(); if (!L) ok = false; }
      if (!ok) { const bad = body.querySelector('.invalid'); if (bad) bad.focus(); return; }
      const code = genCode('CAP'), at = now();
      const inv = { code, email, role: draft.role, aiMode: draft.aiMode, limit: L ? L.monthly : null, limits: L, created: at, expires: addHours(at, 24 * 7), status: 'active', fresh: true };
      A.invites.unshift(inv);
      log('invite', email, ROLE[inv.role] + ', ' + (L ? 'ключ администратора, ' + limitText(L) : 'свой ключ'));
      drawDone(inv);
    }
    function drawDone(inv) {
      UI.clear(body);
      UI.append(body, [
        h('p', { class: 'small soft' }, 'Приглашение для ', h('b', null, inv.email), ' создано. Код:'),
        codeBox(inv.code, 'Код приглашения'),
        UI.callout('warn', 'clock', h('b', null, 'Код действует 7 дней — до ' + lc(when(inv.expires)) + '. '), 'Передайте его человеку сами: почты и Telegram в программе нет. Код показывается один раз — потом в списке будет видна только его концовка.'),
        UI.kv([['Роль', ROLE[inv.role]], ['Ключ Claude', inv.aiMode === 'admin' ? 'ключ администратора' : 'свой ключ'], inv.limits ? ['Лимит', limitText(inv.limits)] : ['Лимиты', 'задает сам']]),
        h('div', { class: 'eyebrow' }, 'Что делать человеку'),
        h('ol', { class: 'adm-steps' },
          h('li', null, h('span', null, 'Открыть AI Capper → ', h('b', null, '«Регистрация только по приглашению»'))),
          h('li', null, h('span', null, 'Ввести код, email ', h('b', null, inv.email), ' и пароль')),
          h('li', null, h('span', null, 'Настроить 2FA в приложении-аутентификаторе — и можно работать'))),
      ]);
      UI.clear(foot);
      UI.append(foot, [button('Готово', { kind: 'primary', icon: 'check', attrs: { id: 'adm-inv-done' }, onClick: () => closeFn() })]);
      UI.toast('Приглашение создано: ' + inv.email, 'userPlus');
    }
    drawForm();
    UI.modal({ title: 'Пригласить в AI Capper', body: () => body, actions: close => { closeFn = close; return foot; }, onClose: refresh });
  }

  function revokeInvite(i) {
    confirmModal({
      title: 'Отозвать приглашение',
      body: h('p', { class: 'small soft' }, 'Код ' + maskCode(i.code) + ' для ' + i.email + ' перестанет работать. Если человек как раз регистрируется, он увидит «Код недействителен». Новое приглашение можно создать в любой момент.'),
      confirmLabel: 'Отозвать', danger: true, icon: 'x',
      onConfirm: () => {
        i.status = 'revoked'; i.revokedAt = now();
        log('invite_revoke', i.email, 'Код ' + maskCode(i.code) + ' отозван');
        UI.toast('Приглашение для ' + i.email + ' отозвано', 'x');
        refresh();
      },
    });
  }
  function revokeReset(c) {
    const u = userById(c.user);
    confirmModal({
      title: 'Отозвать код сброса',
      body: h('p', { class: 'small soft' }, 'Код ' + maskCode(c.code) + (u ? ' для ' + u.name : '') + ' перестанет работать. Если участник еще не сменил пароль, понадобится новый код.'),
      confirmLabel: 'Отозвать', danger: true, icon: 'x',
      onConfirm: () => {
        c.status = 'revoked';
        if (st.resetShown && st.resetShown.code === c.code) st.resetShown = null;
        log('reset_code_revoke', u ? u.name : null, 'Код ' + maskCode(c.code) + ' отозван');
        UI.toast('Код сброса отозван', 'x');
        refresh();
      },
    });
  }

  // =====================================================================
  // ШАПКА И ВКЛАДКИ
  // =====================================================================
  // Дела администратора — ровно DATA.ai.decisions(): то же число у пункта меню и на главной.
  // Коды сброса и приглашения решения не ждут — они в блоке «Действует сейчас».
  const decisions = () => AI.decisions();
  const pending = () => A.resetCodes.filter(c => c.status === 'active').map(c => ({ kind: 'reset', c }))
    .concat(A.invites.filter(i => i.status === 'active').map(i => ({ kind: 'invite', i })));

  function headBlock() {
    const all = people(), active = all.filter(u => u.status === 'active').length, blocked = all.length - active;
    const admins = all.filter(u => u.role === 'admin').length;
    const inv = A.invites.filter(i => i.status === 'active').length;
    const facts = [pl(active, 'активен', 'активны', 'активны')];
    if (blocked) facts.push(pl(blocked, 'заблокирован', 'заблокированы', 'заблокированы'));
    facts.push(pl(admins, 'администратор', 'администратора', 'администраторов'));
    return h('div', { class: 'page-head adm-head' },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'eyebrow' }, icon('admin'), 'Вы — администратор · ' + D.user.name),
        h('h2', null, 'Участники, доступ и расходы на ИИ'),
        h('p', { class: 'lead' }, 'В программе ' + pl(all.length, 'человек', 'человека', 'человек') + ': ' + facts.join(', ') + '.' + (inv ? ' ' + pl(inv, 'приглашение ждет', 'приглашения ждут', 'приглашений ждут') + ' регистрации.' : '')),
        h('div', { class: 'adm-private' }, icon('eyeOff'), 'Участники не видят этот раздел — ни в меню, ни по прямой ссылке')),
      h('div', { class: 'adm-head-actions' },
        button('Пригласить', { kind: 'primary', icon: 'userPlus', attrs: { id: 'adm-invite-btn' }, onClick: inviteModal })));
  }
  function drawHead() { UI.clear(headSlot).appendChild(headBlock()); }

  function drawTabs() {
    const mobile = UI.isMobile();
    const att = decisions().length;
    const dot = id => id === 'overview' && att ? [h('span', { class: 'adm-tab-dot', 'aria-hidden': 'true' }), h('span', { class: 'sr-only' }, ' (нужно решение: ' + att + ')')] : null;
    const t = UI.tabs({
      items: TABS.map(x => ({ id: x.id, label: mobile ? [x.short, dot(x.id)] : [icon(x.icon), x.label, dot(x.id)] })),
      active: st.tab,
      onChange: id => switchTab(id, null, true),
    });
    t.classList.add('adm-tabs');
    t.setAttribute('aria-label', 'Вкладки раздела «Администрирование»');
    t.querySelectorAll('button').forEach((b, i) => { b.setAttribute('aria-controls', 'adm-panel'); b.dataset.tab = TABS[i].id; });
    UI.clear(tabsSlot).appendChild(t);
  }
  const PANELS = {};
  function drawPanel() {
    closeMenu(false);
    UI.clear(panelEl);
    panelEl.setAttribute('aria-label', TABS.find(t => t.id === st.tab).label);
    UI.append(panelEl, [PANELS[st.tab]()]);
  }

  // =====================================================================
  // 1. ОБЗОР
  // =====================================================================
  function attRow(o) {
    return h('li', { class: 'adm-att' },
      h('span', { class: ['adm-att-ic', o.tone], 'aria-hidden': 'true' }, icon(o.ic)),
      h('div', { style: 'min-width:0' }, h('div', { class: 'adm-att-title' }, o.title), h('div', { class: 'adm-att-meta' }, o.meta)),
      h('div', { class: 'adm-att-actions' }, o.actions));
  }
  function decisionRow(d) {
    const u = d.user;
    if (d.kind === 'return') {
      return attRow({ tone: 'info', ic: 'key', title: u.name + ' просит вернуть ключ администратора',
        meta: 'Сейчас работает на своем ключе sk-ant-…' + (u.ownKey ? u.ownKey.last4 : '••••') + ', просьба — ' + lc(when(d.at)) + '. Вернуть можно только с вашего разрешения.',
        actions: [button('Разрешить', { kind: 'primary', size: 'sm', icon: 'check', attrs: { id: 'adm-att-allow', 'data-user': u.id }, onClick: () => approveReturn(u) }), button('Отклонить', { kind: 'secondary', size: 'sm', attrs: { 'data-user': u.id, 'data-act': 'reject' }, onClick: () => rejectReturn(u) })] });
    }
    const L = AI.limitOf(u), v = AI.keySpent(u), r = d.ratio;
    const perDay = v / DAY, rest = L.monthly - v;
    const capDay = perDay > 0 && rest > 0 ? dayShift(Math.max(1, Math.ceil(rest / perDay))) : null;
    return attRow({ tone: r >= 1 ? 'bad' : 'warn', ic: 'coins', title: u.name + ' — ' + fmt.pct(r * 100, 0) + ' лимита',
      meta: usd(v) + ' из ' + usdL(L.monthly) + ' за октябрь, сегодня ' + u.todayAnalyses + ' из ' + L.daily + ' анализов. ' + (L.paused ? 'Анализы на паузе.' : r >= 1 ? 'Анализы на вашем ключе остановлены.' : capDay ? 'При таком темпе лимит закончится ' + lc(when(capDay)) + ', и анализы на вашем ключе остановятся.' : ''),
      actions: [button('Поднять лимит', { kind: 'primary', size: 'sm', icon: 'arrowUp', attrs: { 'data-user': u.id }, onClick: () => limitModal(u) })] });
  }
  function decisionsCard() {
    const items = decisions();
    return card({
      title: 'Нужно решение', class: 'adm-nowrap-head', id: 'adm-decisions',
      subtitle: items.length ? 'Просьбы вернуть ключ администратора и участники у лимита' : 'Просьб и предупреждений нет',
      actions: items.length ? [chip(String(items.length), 'warn')] : [chip('Все спокойно', 'good', 'check')],
      body: items.length ? h('ul', { class: 'adm-att-list' }, items.map(decisionRow)) : h('p', { class: 'small soft' }, 'Когда участник попросит вернуть ключ администратора или подойдет к ' + A.budget.alertAt + '% лимита, это появится здесь и у пункта меню.'),
    });
  }
  function pendingRow(it) {
    if (it.kind === 'reset') {
      const c = it.c, u = userById(c.user);
      return attRow({ tone: 'info', ic: 'lock', title: 'Код сброса пароля' + (u ? ': ' + u.name : ''),
        meta: maskCode(c.code) + ' выдан ' + lc(when(c.created)) + ', ' + left(c.expires) + '. Участник вводит его на экране «Забыли пароль?».',
        actions: [button('Отозвать', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => revokeReset(c) }), button('Сброс доступа', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => switchTab('access') })] });
    }
    const i = it.i;
    return attRow({ tone: 'info', ic: 'userPlus', title: 'Приглашение ждет регистрации: ' + i.email,
      meta: 'Код ' + maskCode(i.code) + ' действует до ' + lc(when(i.expires)) + ' — ' + left(i.expires) + '. Если человек не успеет, создайте новое.',
      actions: [button('Отозвать', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => revokeInvite(i) }), button('Приглашения', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => switchTab('invites') })] });
  }
  function pendingCard() {
    const items = pending();
    return card({
      title: 'Действует сейчас', class: 'adm-nowrap-head adm-fill', id: 'adm-pending',
      subtitle: items.length ? 'Выданные коды сброса и приглашения. Решения не ждут — сгорят сами' : 'Действующих кодов и приглашений нет',
      actions: [chip(String(items.length), 'outline')],
      body: items.length ? h('ul', { class: 'adm-att-list' }, items.map(pendingRow)) : h('p', { class: 'small soft' }, 'Здесь видно коды сброса пароля и приглашения, пока они действуют.'),
    });
  }

  function budgetBar(b) {
    const tone = b.share >= 1 ? 'bad' : b.share >= alertShare() ? 'warn' : null;
    return h('div', { class: 'adm-bar-wrap' },
      h('div', { class: 'adm-bar', role: 'meter', 'aria-label': 'Потрачено ' + usd(b.spent) + ' из ' + usdL(b.monthly) + ', прогноз ' + usd(b.forecast), 'aria-valuenow': b.spent, 'aria-valuemin': 0, 'aria-valuemax': b.monthly },
        h('i', { class: 'proj', style: { width: Math.min(100, b.fShare * 100) + '%' } }),
        h('i', { class: ['spent', tone], style: { width: Math.min(100, b.share * 100) + '%' } }),
        h('span', { class: 'mark', style: { left: b.alertAt + '%' }, title: 'Уведомление при ' + b.alertAt + '%' })),
      h('div', { class: 'adm-legend' },
        h('span', null, h('i', { class: 'spent' }), 'Потрачено за 1–' + DAY + ' окт'),
        h('span', null, h('i', { class: 'proj' }), 'Прогноз на ' + monthEnd(b) + ' окт'),
        h('span', null, h('i', { class: 'mark' }), 'Уведомление при ' + b.alertAt + '%')));
  }
  function budgetBody(b) {
    return [
      h('div', { class: 'adm-big' },
        h('span', { class: 'stat-value' }, usd(b.spent)), h('span', { class: 'adm-of' }, 'из ' + usdL(b.monthly)),
        chip(pctOf(b.spent, b.monthly) + ' бюджета', b.share >= 1 ? 'bad' : b.share >= alertShare() ? 'warn' : 'good', b.share >= alertShare() ? 'alert' : 'check')),
      budgetBar(b),
      h('dl', { class: 'adm-kv3' },
        h('div', null, h('dt', null, 'Осталось'), h('dd', null, usd(b.left), h('small', null, 'до ' + monthEnd(b) + ' окт'))),
        h('div', null, h('dt', null, 'До конца месяца'), h('dd', null, pl(b.daysLeft, 'день', 'дня', 'дней'), h('small', null, 'сегодня ' + fmt.date(TODAY)))),
        h('div', null, h('dt', null, 'Прогноз'), h('dd', null, '≈ ' + usd(b.forecast), h('small', null, pctOf(b.forecast, b.monthly) + ' бюджета')))),
    ];
  }
  // Строка «Итого» под списком расхода: та же сумма, что «Потрачено» в бюджете (DATA.ai.budget().spent)
  function totalRow(b) {
    return h('li', { class: 'adm-urow adm-total' },
      h('div', { class: 'adm-urow-name' }, 'Итого с вашего ключа'),
      h('div', { class: 'adm-urow-val' }, h('b', null, usd(b.spent)), h('small', null, pctOf(b.spent, b.monthly, 1) + ' бюджета')),
      h('div', { class: 'adm-urow-meta' }, 'за 1–' + DAY + ' октября'));
  }
  // Кто тратит ключ администратора: все с расходом на нем; если людей много — первые трое и «остальные»
  function spendersList(b) {
    const list = AI.keyUsers().filter(u => AI.keySpent(u) > 0).sort((x, y) => AI.keySpent(y) - AI.keySpent(x));
    const top = list.length > 4 ? list.slice(0, 3) : list, rest = list.slice(top.length);
    const noteOf = u => { const L = AI.limitOf(u); return u.aiMode === 'own' ? 'до перехода на свой ключ' : L ? 'лимит ' + usdL(L.monthly) : 'без личного лимита'; };
    const rows = top.map(u => ({ name: u.name, me: isMe(u), gone: u.status === 'deleted', spent: AI.keySpent(u), r: ratio(u), note: noteOf(u) }))
      .concat(rest.length ? [{ name: 'Остальные: ' + rest.length, spent: Math.round(sum(rest, AI.keySpent) * 100) / 100, note: rest.map(u => u.name.split(' ')[0]).join(', ') }] : [])
      .concat([{ name: 'Общие фоновые задачи', spent: b.shared, note: 'обновление профилей игроков', shared: true }]);
    const max = Math.max(...rows.map(x => x.spent)) || 1;
    return h('ul', { class: 'adm-urows compact', 'aria-label': 'Кто тратит' }, rows.map(x => h('li', { class: 'adm-urow' },
      h('div', { class: 'adm-urow-name' }, x.name, x.me && chip('вы', 'accent'), x.gone && chip('удален', 'outline')),
      h('div', { class: 'adm-urow-val' }, h('b', null, usd(x.spent)), h('small', null, pctOf(x.spent, b.monthly, 1) + ' бюджета')),
      h('div', { class: 'adm-urow-meta' }, x.note + (x.r != null ? ' · израсходовано ' + fmt.pct(x.r * 100, 0) : '')),
      h('div', { class: 'adm-urow-bar', 'aria-hidden': 'true' }, h('i', { style: { width: (x.spent / max * 100) + '%', background: x.shared ? 'var(--fg-3)' : toneOf(x.r) === 'bad' ? 'var(--bad)' : toneOf(x.r) === 'warn' ? 'var(--warn)' : 'var(--accent)' } })))),
      totalRow(b));
  }
  function budgetCard() {
    const b = AI.budget();
    return card({
      title: 'Бюджет ключа администратора', subtitle: 'Октябрь · расходы на Claude всегда в долларах', class: 'adm-fill',
      body: [...budgetBody(b), howto(b.fShare >= 1 ? 'Прогноз выше бюджета: поднимите бюджет или снизьте лимиты участников.' : 'Прогноз учитывает личные лимиты и паузы: на 100% лимита анализы участника останавливаются.'),
        h('div', { class: 'eyebrow', style: 'margin-top:4px' }, 'Кто тратит'), spendersList(b)],
      foot: [button('Расход ИИ', { kind: 'ghost', size: 'sm', icon: 'coins', onClick: () => switchTab('usage') }), button('Ключ и бюджет', { kind: 'ghost', size: 'sm', icon: 'key', onClick: () => switchTab('key') })],
    });
  }
  // Аккаунты: администраторы и участники вместе (на вкладке «Сообщение» считаются только получатели — без вас)
  function peopleTile() {
    const all = people(), active = all.filter(u => u.status === 'active'), blocked = all.length - active.length;
    const onKey = active.filter(u => u.aiMode === 'admin').length, own = active.filter(u => u.aiMode === 'own').length;
    const today = all.filter(u => u.lastLogin && u.lastLogin.slice(0, 10) === TODAY).length;
    return tile({ icon: 'users', label: 'Активных аккаунтов',
      value: [String(active.length), h('span', { class: 'adm-of' }, 'из ' + all.length)],
      sub: onKey + ' на ключе администратора · ' + own + ' на своем ключе' + (blocked ? ' · ' + blocked + ' ' + fmt.plural(blocked, 'заблокирован', 'заблокированы', 'заблокированы') : ''),
      foot: [h('span', { class: 'stat-hint' }, 'Сегодня заходили: ' + today), button('Участники', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => switchTab('users') })] });
  }
  function keyTile() {
    return tile({ icon: 'key', label: 'Ключ администратора',
      value: [h('code', null, 'sk-ant-…' + A.key.last4), chip('Работает', 'good', 'check')],
      sub: 'Проверен ' + lc(when(A.key.verified)) + ' тестовым запросом. Сам ключ не показывается никому',
      foot: [h('span', { class: 'stat-hint' }, 'Хранится на сервере, зашифрован'), button('Заменить', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => { st.keyForm = true; switchTab('key', () => scrollToId('adm-key', '#adm-key-new')); } })] });
  }
  function currencyTile() {
    const c = UI.currency;
    return tile({ icon: 'currency', label: 'Валюта программы',
      value: [c.sym, h('span', { class: 'adm-of' }, c.label)],
      sub: 'Банки, ставки и прибыль у всех участников. Расходы на Claude — всегда в долларах',
      foot: [h('span', { class: 'stat-hint' }, 'Одна на всю программу'), button('Изменить', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => switchTab('settings') })] });
  }
  function actorNode(e) {
    if (e.actor === 'терминал') return h('span', { class: 'adm-actor' }, icon('terminal'), 'терминал');
    const u = D.users.find(x => x.name === e.actor);
    return h('span', { class: 'adm-actor' }, e.actor + (u && u.role !== 'admin' ? ' (участник)' : ''));
  }
  function actorText(e) {
    if (e.actor === 'терминал') return 'терминал на сервере';
    const u = D.users.find(x => x.name === e.actor);
    return e.actor + (u && u.role !== 'admin' ? ' (участник)' : '');
  }
  function recentCard() {
    const list = A.audit.slice(0, 5);
    return card({
      title: 'Последние действия', subtitle: 'Из журнала действий', class: 'adm-nowrap-head',
      actions: [button('Весь журнал', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => switchTab('audit') })],
      body: h('ul', { class: 'adm-recent' }, list.map(e => h('li', null,
        h('span', { class: 'adm-recent-ic', 'aria-hidden': 'true' }, icon(actionOf(e)[1])),
        h('div', { class: 'adm-recent-text' },
          h('div', null, h('b', null, actionOf(e)[0]), e.target ? ': ' + e.target : ''),
          h('div', { class: 'muted' }, when(e.at) + ' · ' + actorText(e))),
        e.fresh ? chip('новое', 'accent') : h('span')))),
    });
  }
  PANELS.overview = () => [
    h('div', { class: 'grid' },
      h('div', { class: 'col-7 adm-col' }, decisionsCard(), pendingCard()),
      h('div', { class: 'col-5 adm-col' }, budgetCard())),
    h('div', { class: 'grid' },
      h('div', { class: 'adm-third' }, peopleTile()),
      h('div', { class: 'adm-third' }, keyTile()),
      h('div', { class: 'adm-third' }, currencyTile())),
    recentCard(),
  ];

  // =====================================================================
  // 2. УЧАСТНИКИ
  // =====================================================================
  const USER_FILTERS = [
    { id: 'all', label: 'Все', test: () => true },
    { id: 'active', label: 'Активные', test: u => u.status === 'active' },
    { id: 'blocked', label: 'Заблокированные', test: u => u.status === 'blocked' },
  ];
  function usersTable(rows) {
    const t = UI.table({
      columns: [
        { label: 'Участник · роль и статус', render: u => h('div', { class: 'adm-person' }, avatar(u), h('div', null,
          h('div', { class: 'adm-person-name' }, h('span', { class: 'adm-nowrap' }, u.name), isMe(u) && chip('вы', 'accent')),
          h('div', { class: 'adm-person-mail adm-nowrap' }, u.email),
          h('div', { class: 'row adm-chips', style: 'margin-top:6px' }, roleChip(u), statusChip(u)))) },
        { label: 'Ключ Claude', render: keyCell },
        { label: 'Расход ИИ за октябрь', render: spendBlock },
        { label: 'Анализы', align: 'r', render: analysesCell },
        { label: 'Вход и 2FA', render: u => h('div', { class: 'adm-cell2' }, h('span', { class: 'adm-nowrap' }, when(u.lastLogin)), h('span', { class: ['adm-sub', !u.twoFa && 'warn-text'] }, u.twoFa ? '2FA включена' : u.twoFaReset ? '2FA сброшена' : '2FA не настроена')) },
        { label: h('span', { class: 'sr-only' }, 'Действия'), align: 'r', render: menuButton },
      ],
      rows, empty: 'Никого нет',
    });
    t.querySelector('table').classList.add('adm-users-table');
    t.querySelectorAll('tbody tr').forEach((tr, i) => { if (rows[i] && rows[i].status === 'blocked') tr.classList.add('is-blocked'); });
    return t;
  }
  function userCard(u) {
    return h('section', { class: ['card', 'adm-ucard', u.status === 'blocked' && 'is-blocked'], 'aria-label': u.name },
      h('div', { class: 'adm-ucard-head' }, avatar(u),
        h('div', { style: 'min-width:0' }, h('div', { class: 'adm-person-name' }, u.name, isMe(u) && chip('вы', 'accent')), h('div', { class: 'adm-person-mail' }, u.email)),
        menuButton(u)),
      h('div', { class: 'row adm-chips' }, roleChip(u), statusChip(u), keyChip(u), u.returnRequested && chip('просит вернуть ключ', 'warn')),
      spendBlock(u),
      h('dl', { class: 'adm-facts two' },
        h('div', null, h('dt', null, 'Анализов сегодня'), h('dd', null, u.todayAnalyses + (AI.limitOf(u) ? ' из ' + AI.limitOf(u).daily : ''))),
        h('div', null, h('dt', null, 'За октябрь'), h('dd', null, pl(u.analyses, 'анализ', 'анализа', 'анализов')))),
      h('div', { class: 'row', style: 'gap:6px 10px' }, twoFaChip(u), h('span', { class: 'xsmall muted' }, 'Вход: ' + lc(when(u.lastLogin)))));
  }
  PANELS.users = () => {
    const all = people();
    const f = USER_FILTERS.find(x => x.id === st.userFilter) || USER_FILTERS[0];
    const rows = all.filter(f.test).sort((a, b) => (isMe(b) - isMe(a)) || (a.status === 'blocked') - (b.status === 'blocked') || b.spent - a.spent);
    const seg = UI.segmented({ label: 'Показать', items: USER_FILTERS.map(x => ({ id: x.id, label: x.label + ' · ' + all.filter(x.test).length })), active: f.id, onChange: id => { st.userFilter = id; redrawPanel(); } });
    const privacy = UI.callout('info', 'eyeOff', h('b', null, 'Здесь только расход на ИИ и активность: '), 'входы и число анализов. Ставки, банк и стратегию участника не видит никто, кроме него самого — администратор тоже.');
    return [
      (() => {
        const c = card({
          title: 'Участники', subtitle: pl(all.length, 'человек', 'человека', 'человек') + ' · расход ИИ за октябрь в долларах', class: 'adm-wide-only',
          body: [h('div', { class: 'adm-toolbar' }, seg), privacy],
        });
        c.appendChild(h('div', { class: 'adm-users-wrap' }, usersTable(rows)));
        return c;
      })(),
      h('div', { class: 'adm-narrow-only stack' },
        h('div', { class: 'adm-toolbar' }, UI.segmented({ label: 'Показать', items: USER_FILTERS.map(x => ({ id: x.id, label: x.label + ' · ' + all.filter(x.test).length })), active: f.id, onChange: id => { st.userFilter = id; redrawPanel(); } })),
        privacy.cloneNode(true),
        rows.length ? h('div', { class: 'adm-ucards' }, rows.map(userCard)) : UI.empty('Никого нет')),
    ];
  };

  // =====================================================================
  // 3. ПРИГЛАШЕНИЯ
  // =====================================================================
  function inviteItem(i) {
    const keyText = i.aiMode === 'admin' ? 'ключ администратора' + (i.limit ? ', ' + usdL(i.limit) + ' в месяц' : '') : 'свой ключ';
    const base = [ROLE[i.role] + ' · ' + keyText + ' · код ', h('span', { class: 'adm-nowrap mono' }, maskCode(i.code))];
    if (i.status === 'active') {
      return item({ ic: 'mail', icKind: 'info', title: i.email, titleExtra: [chip('Ждет', 'info', 'clock'), i.fresh && chip('новое', 'accent')],
        meta: [h('div', null, base), h('div', null, 'Создано ' + lc(when(i.created)) + ' · действует до ' + lc(when(i.expires)) + ' (' + left(i.expires) + ')')],
        side: button('Отозвать', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => revokeInvite(i) }) });
    }
    if (i.status === 'used') {
      const u = people().find(x => x.email === i.email);
      return item({ ic: 'check', icKind: 'good', title: i.email, titleExtra: chip('Использовано', 'good'),
        meta: [h('div', null, base), h('div', null, 'Зарегистрировался ' + lc(when(i.usedAt)) + (u ? ' — ' + u.name : ''))] });
    }
    return item({ ic: i.status === 'revoked' ? 'x' : 'clock', title: i.email, titleExtra: chip(i.status === 'revoked' ? 'Отозвано' : 'Истекло', 'outline'), old: true,
      meta: [h('div', null, base), h('div', null, i.status === 'revoked' ? 'Отозвано ' + lc(when(i.revokedAt || i.created)) : 'Истекло ' + lc(when(i.expires)) + ', не использовано')] });
  }
  PANELS.invites = () => {
    const groups = [
      { title: 'Активные', list: A.invites.filter(i => i.status === 'active'), empty: 'Активных приглашений нет' },
      { title: 'Использованные', list: A.invites.filter(i => i.status === 'used'), empty: 'Пока никто не зарегистрировался по приглашению' },
      { title: 'Истекшие и отозванные', list: A.invites.filter(i => i.status === 'expired' || i.status === 'revoked'), empty: 'Нет' },
    ];
    const listCard = card({
      title: 'Приглашения', subtitle: 'Код одноразовый, действует 7 дней и привязан к email',
      actions: [button('Пригласить', { kind: 'primary', size: 'sm', icon: 'userPlus', onClick: inviteModal })],
      body: groups.map(g => h('div', { class: 'adm-group' },
        h('div', { class: 'adm-group-title' }, g.title, chip(String(g.list.length), 'outline')),
        g.list.length ? h('div', { class: 'adm-list' }, g.list.map(inviteItem)) : h('div', { class: 'adm-empty' }, g.empty))),
    });
    const howCard = card({
      title: 'Как работает приглашение', subtitle: 'Открытой регистрации нет',
      body: [
        h('ol', { class: 'adm-steps' },
          h('li', null, h('span', null, h('b', null, 'Вы создаете код'), ' — email, роль, режим ключа Claude и стартовый лимит на вашем ключе.')),
          h('li', null, h('span', null, h('b', null, 'Передаете его сами'), ' — лично или в мессенджере. Почты и Telegram в программе нет.')),
          h('li', null, h('span', null, h('b', null, 'Человек регистрируется'), ': экран входа → «Регистрация только по приглашению», код, тот же email, пароль и 2FA.')),
          h('li', null, h('span', null, h('b', null, 'Код сгорает'), ' после регистрации или через 7 дней. Код в базе хранится только в виде отпечатка, поэтому в списке видна лишь его концовка.'))),
        howto('При регистрации человек отдельной галочкой решает, можно ли после удаления аккаунта оставить его прогнозы без имени для обучения общей модели.'),
      ],
    });
    return h('div', { class: 'adm-main' }, listCard, howCard);
  };

  // =====================================================================
  // 4. СБРОС ДОСТУПА
  // =====================================================================
  function resetCard() {
    const cand = people().filter(u => !isMe(u));
    const sel = UI.field({ id: 'adm-reset-user', label: 'Участник', options: [{ value: '', label: 'Выберите участника' }].concat(cand.map(u => ({ value: u.id, label: u.name + ' · ' + u.email }))), value: st.resetUser });
    const go = button('Выдать код', { kind: 'primary', icon: 'lock', disabled: !st.resetUser, attrs: { id: 'adm-reset-go' }, onClick: () => {
      const u = userById(st.resetUser);
      if (!u) return;
      const r = issueResetCode(u);
      st.resetShown = { code: r.code, user: u.id, expires: r.expires, replaced: r.replaced };
      UI.toast('Код сброса выдан: ' + u.name, 'lock');
      refresh();
    } });
    const hint = h('div', { class: 'field-hint' });
    const drawHint = () => {
      const u = userById(st.resetUser);
      const has = u && A.resetCodes.some(c => c.user === u.id && c.status === 'active');
      hint.textContent = !u ? 'Участник пишет вам, что забыл пароль — выберите его' : has ? 'У участника уже есть действующий код: новый заменит его' : u.status === 'blocked' ? 'Участник заблокирован: войти он сможет только после разблокировки' : 'Код действует 24 часа и показывается один раз';
    };
    sel.querySelector('select').addEventListener('change', e => { st.resetUser = e.target.value; go.disabled = !st.resetUser; drawHint(); });
    drawHint();
    sel.appendChild(hint);
    const shown = st.resetShown && userById(st.resetShown.user);
    return card({
      title: 'Код сброса пароля', subtitle: 'Если участник забыл пароль. Почты нет — код передаете вы', id: 'adm-reset', class: ['adm-anchor', 'adm-fill'].join(' '),
      body: shown ? [
        personRow(shown, true),
        codeBox(st.resetShown.code, 'Код сброса'),
        UI.callout('warn', 'clock', 'Действует 24 часа — до ' + lc(when(st.resetShown.expires)) + '. Код показывается один раз: скопируйте его и передайте участнику.' + (st.resetShown.replaced ? ' Прежний код перестал действовать.' : '')),
        h('div', { class: 'eyebrow' }, 'Что делать участнику'),
        resetInstructions(shown),
        h('div', { class: 'row' }, button('Готово, скрыть код', { kind: 'secondary', size: 'sm', icon: 'eyeOff', onClick: () => { st.resetShown = null; redrawPanel(); } })),
      ] : [sel, h('div', { class: 'row' }, go)],
    });
  }
  function twofaCard() {
    const cand = people().filter(u => !isMe(u) && u.twoFa);
    if (st.twofaUser && !cand.some(u => u.id === st.twofaUser)) st.twofaUser = '';
    const sel = UI.field({ id: 'adm-2fa-user', label: 'Участник', options: [{ value: '', label: 'Выберите участника' }].concat(cand.map(u => ({ value: u.id, label: u.name + ' · ' + u.email }))), value: st.twofaUser, hint: 'В списке — те, у кого 2FA включена' });
    const go = button('Сбросить 2FA', { kind: 'danger', icon: 'shield', disabled: !st.twofaUser, onClick: () => { const u = userById(st.twofaUser); if (u) reset2fa(u); } });
    sel.querySelector('select').addEventListener('change', e => { st.twofaUser = e.target.value; go.disabled = !st.twofaUser; });
    return card({
      title: 'Сбросить 2FA', subtitle: 'Если участник потерял телефон и резервные коды', class: 'adm-fill',
      body: [
        h('ul', { class: 'adm-bul' },
          h('li', null, icon('shield'), 'Секрет 2FA и резервные коды удаляются, все сеансы завершаются'),
          h('li', null, icon('refresh'), 'При следующем входе по паролю участник настраивает 2FA заново'),
          h('li', null, icon('lock'), 'Нужен ваш код 2FA. Свою 2FA администратор сбрасывает только командой в терминале')),
        sel, h('div', { class: 'row' }, go)],
    });
  }
  function codesCard() {
    const active = A.resetCodes.filter(c => c.status === 'active');
    return card({
      title: 'Действующие коды сброса', subtitle: 'Использованные и отозванные — в журнале',
      actions: [chip(String(active.length), active.length ? 'info' : 'outline')],
      body: active.length ? h('div', { class: 'adm-list' }, active.map(c => {
        const u = userById(c.user);
        return item({ ic: 'lock', icKind: 'info', title: u ? u.name : 'Участник', titleExtra: c.fresh && chip('новый', 'accent'),
          meta: maskCode(c.code) + ' · выдан ' + lc(when(c.created)) + ' · до ' + lc(when(c.expires)) + ' (' + left(c.expires) + ')',
          side: button('Отозвать', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => revokeReset(c) }) });
      })) : h('p', { class: 'small soft' }, 'Сейчас действующих кодов нет.'),
    });
  }
  function terminalCard() {
    const me = D.user.email;
    const CMDS = [
      { cmd: 'reset-code --email ' + me, name: 'reset-code', text: 'печатает одноразовый код сброса пароля на 24 часа. Дальше — экран «Забыли пароль?», как у участника' },
      { cmd: 'reset-2fa --email ' + me, name: 'reset-2fa', text: 'сбрасывает 2FA и резервные коды, завершает все сеансы' },
      { cmd: 'create-admin --email admin2@example.com', name: 'create-admin', text: 'создает администратора. Пароль вводится в терминале без отображения, 2FA — при первом входе' },
      { cmd: 'set-role --email olga@example.com --role admin', name: 'set-role', text: 'меняет роль: admin или member' },
      { cmd: 'unblock --email ' + me, name: 'unblock', text: 'разблокирует, если администратора заблокировали' },
      { cmd: 'set-admin-key', name: 'set-admin-key', text: 'принимает ключ Anthropic из ввода терминала, проверяет и сохраняет зашифрованным' },
    ];
    return card({
      title: 'Если забыл пароль администратор', subtitle: 'Только с сервера, где установлено приложение — как createsuperuser в Django', id: 'adm-terminal', class: 'adm-anchor',
      body: [
        h('p', { class: 'small soft' }, 'Здесь нельзя выдать код сброса администратору: так доступ не перехватит никто, кроме владельца сервера. Подключитесь к серверу по SSH и выполните команду в папке приложения. Каждая команда пишется в журнал с пометкой «терминал».'),
        h('ul', { class: 'adm-cmds' }, CMDS.map(c => h('li', null,
          h('div', { class: 'adm-cmd-desc' }, h('b', null, c.name), ' — ' + c.text),
          h('div', { class: 'adm-pre' }, h('code', null, CLI + ' ' + c.cmd),
            button('', { kind: 'ghost', size: 'sm', icon: 'copy', ariaLabel: 'Скопировать команду ' + c.name, title: 'Скопировать', onClick: () => copy(CLI + ' ' + c.cmd, 'Команда скопирована') }))))),
      ],
    });
  }
  PANELS.access = () => [
    h('div', { class: 'grid' },
      h('div', { class: 'col-6 adm-col' }, resetCard()),
      h('div', { class: 'col-6 adm-col' }, twofaCard())),
    codesCard(),
    terminalCard(),
  ];

  // =====================================================================
  // 5. КЛЮЧ И БЮДЖЕТ
  // =====================================================================
  function keyForm() {
    const f = UI.field({ id: 'adm-key-new', label: 'Новый ключ', type: 'password', placeholder: 'sk-ant-api03-…', autocomplete: 'off', hint: 'Скопируйте ключ в консоли Anthropic: Settings → API keys. После сохранения его не увидит никто, даже вы: останутся последние 4 символа', attrs: { spellcheck: 'false' } });
    let save = null;
    const onSave = () => {
      const v = valOf(f).trim();
      if (!setErr(f, /^sk-ant-[A-Za-z0-9_-]{16,}$/.test(v) ? null : 'Ключ начинается с sk-ant- и длиннее 20 символов — скопируйте его целиком')) return;
      confirm2fa({
        id: 'adm-key-otp',
        title: 'Заменить ключ администратора',
        body: [h('p', { class: 'small soft' }, 'Новый ключ проверим легким запросом к Claude API. Старый sk-ant-…' + A.key.last4 + ' перестанет использоваться сразу; анализы, которые идут сейчас, доработают на нем.')],
        confirmLabel: 'Проверить и сохранить', icon: 'key',
        onConfirm: () => busy(save, 'Проверяем ключ…', 1100, () => {
          if (/wrong|bad/i.test(v)) { setErr(f, 'Anthropic не принял ключ: проверьте, что он скопирован целиком и не отозван'); return; }
          Object.assign(A.key, { last4: v.slice(-4), verified: now(), status: 'ok' });
          log('key_change', null, 'Ключ администратора заменен: sk-ant-…' + A.key.last4 + ', проверен');
          st.keyForm = false;
          UI.toast('Ключ проверен и сохранен: sk-ant-…' + A.key.last4, 'key');
          refresh();
        }),
      });
    };
    save = button('Проверить и сохранить', { kind: 'primary', icon: 'check', attrs: { id: 'adm-key-save' }, onClick: onSave });
    f.querySelector('input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); onSave(); } });
    return h('div', { class: 'adm-form' }, f, h('div', { class: 'row' }, save, button('Отмена', { kind: 'ghost', onClick: () => { st.keyForm = false; redrawPanel(); } })));
  }
  function keyCard() {
    const users = onAdminKey().filter(u => u.status === 'active').length;
    return card({
      title: 'Ключ администратора', subtitle: 'Им оплачиваются анализы участников на вашем ключе и общие фоновые задачи', id: 'adm-key', class: 'adm-anchor adm-fill adm-nowrap-head',
      actions: st.keyForm ? null : [button('Заменить ключ', { kind: 'secondary', size: 'sm', icon: 'refresh', attrs: { id: 'adm-key-replace' }, onClick: () => { st.keyForm = true; redrawPanel(); const i = document.getElementById('adm-key-new'); if (i) i.focus(); } })],
      body: [
        h('div', { class: 'adm-secret' }, icon('key'), h('code', null, 'sk-ant-…' + A.key.last4), chip('Работает', 'good', 'check')),
        UI.kv([
          ['Проверен', when(A.key.verified) + ' · тестовым запросом'],
          ['Кто на нем', pl(users, 'человек', 'человека', 'человек') + ' и общие задачи'],
          ['Где хранится', 'на сервере, зашифрован'],
        ]),
        st.keyForm ? keyForm() : null,
        h('div', { class: 'adm-ext' },
          h('a', { class: 'adm-link', href: 'https://platform.claude.com/settings/limits', target: '_blank', rel: 'noopener noreferrer' }, 'Лимит трат в консоли Anthropic', icon('arrowRight')),
          h('div', { class: 'xsmall muted' }, 'Вторая страховка: даже если в программе что-то пойдет не так, Anthropic не даст потратить больше. Поставьте лимит чуть выше общего бюджета — например, ' + usdL(A.budget.monthly + 10) + ' в месяц.')),
      ],
    });
  }
  function budgetEditCard() {
    const b = AI.budget();
    const fM = UI.field({ id: 'adm-budget', label: 'Бюджет в месяц, $', value: dec(A.budget.monthly), inputmode: 'decimal', autocomplete: 'off' });
    const fA = UI.field({ id: 'adm-alert', label: 'Уведомить при', options: [50, 70, 80, 90].map(v => ({ value: String(v), label: v + '%' })), value: String(A.budget.alertAt) });
    const limited = people().filter(u => AI.limitOf(u));
    const limitsSum = sum(limited, u => AI.limitOf(u).monthly);
    let save = null;
    const changed = () => num(valOf(fM)) !== A.budget.monthly || Number(valOf(fA)) !== A.budget.alertAt;
    const sync = () => { save.disabled = !changed(); };
    save = button('Сохранить', { kind: 'primary', icon: 'check', disabled: true, onClick: () => {
      const m = num(valOf(fM)), a = Number(valOf(fA));
      if (!setErr(fM, !(m >= 1 && m <= 5000) ? 'От $1 до $5000' : m < AI.budget().spent ? 'Меньше уже потраченного (' + usd(AI.budget().spent) + '): анализы на вашем ключе остановятся сразу' : null)) return;
      const diff = [];
      if (m !== A.budget.monthly) diff.push('Общий бюджет ' + usdL(A.budget.monthly) + ' → ' + usdL(m) + ' в месяц');
      if (a !== A.budget.alertAt) diff.push('уведомление при ' + A.budget.alertAt + '% → ' + a + '%');
      A.budget.monthly = Math.round(m * 100) / 100; A.budget.alertAt = a;
      log('budget_change', null, diff.join(', '));
      UI.toast('Бюджет: ' + usdL(A.budget.monthly) + ' в месяц, уведомление при ' + a + '%', 'coins');
      refresh();
    } });
    fM.querySelector('input').addEventListener('input', sync);
    fA.querySelector('select').addEventListener('change', sync);
    return card({
      title: 'Общий бюджет на месяц', subtitle: 'Все расходы на вашем ключе: анализы участников и фоновые задачи', class: 'adm-fill',
      body: [
        ...budgetBody(b),
        h('div', { class: 'adm-fields two' }, fM, fA),
        howto('Сумма личных лимитов — ' + usdL(limitsSum) + ' (' + limited.map(u => u.name.split(' ')[0] + ' ' + usdL(AI.limitOf(u).monthly)).join(', ') + '). Ваши анализы и общие задачи идут без личного лимита, только в рамках бюджета.'),
      ],
      foot: [save],
    });
  }
  // Лимиты по умолчанию для новых участников (Р13): правка в окне, как и лимит участника
  function defaultsModal() {
    const lf = limitFields(A.defaults, 'adm-def');
    const inputs = () => Array.from(lf.node.querySelectorAll('input'));
    UI.modal({
      title: 'Лимиты по умолчанию',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small soft' }, 'Новый участник на ключе администратора получает эти лимиты, в приглашении их можно поменять. Тем, кто уже зарегистрирован, лимит не меняется.'),
        lf.node,
        h('div', { class: 'adm-presets' }, h('span', null, 'Как решено: ' + limitText(D.LIMIT_DEFAULT)),
          h('button', { type: 'button', class: 'adm-pill', on: { click: () => { const [m, d, pp] = inputs(); m.value = dec(D.LIMIT_DEFAULT.monthly); d.value = String(D.LIMIT_DEFAULT.daily); pp.value = dec(D.LIMIT_DEFAULT.perAnalysis); } } }, 'Подставить'))),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Сохранить', { kind: 'primary', icon: 'check', onClick: () => {
          const L = lf.read();
          if (!L) return;
          close();
          const diff = limitDiff(A.defaults, L);
          if (!diff.length) { UI.toast('Лимиты по умолчанию не изменились', 'info'); return; }
          Object.assign(A.defaults, L);
          log('limit_change', 'Новые участники', 'Лимиты по умолчанию: ' + diff.join(', '));
          UI.toast('Лимиты по умолчанию: ' + limitText(A.defaults), 'sliders');
          refresh();
        } }),
      ],
    });
  }
  function thresholdsCard() {
    const rule = (k, tone, text) => h('li', { class: 'adm-rule' }, h('div', { class: 'adm-rule-k' }, h('i', { class: tone }), k), h('div', null, text));
    return card({
      title: 'Что происходит на 80% и 100%', subtitle: 'Уведомления приходят на сайт и push на телефон',
      body: h('ul', { class: 'adm-rules cols' },
        rule('80% лимита участника', 'warn', 'Уведомление участнику и вам. Анализы продолжаются.'),
        rule('100% лимита участника', 'bad', 'Его анализы на вашем ключе останавливаются до вашего решения: поднять лимит или дождаться 1-го числа. Участник видит, почему анализ не запускается.'),
        rule(A.budget.alertAt + '% общего бюджета', 'warn', 'Уведомление вам.'),
        rule('100% общего бюджета', 'bad', 'Останавливаются все анализы на вашем ключе и фоновые задачи. Участники на своем ключе работают как обычно.'),
        rule('Потолок на анализ', null, 'Анализ, который выходит дороже, останавливается, участник видит понятную ошибку. На своем ключе потолок задает сам участник.')),
    });
  }
  // Пауза анализов участника на ключе администратора: DATA.ai.access учитывает limit.paused
  function setPause(u, v) {
    if (!u.limit) u.limit = Object.assign({}, A.defaults);
    u.limit.paused = v;
    log('limit_change', u.name, v ? 'Анализы на вашем ключе на паузе' : 'Пауза снята');
    UI.toast(v ? u.name + ': анализы на паузе' : u.name + ': пауза снята', v ? 'pause' : 'play');
    refresh();
  }
  function limitsCard() {
    const rows = people().slice().sort((a, b) => (isMe(b) - isMe(a)) || (a.aiMode === 'own') - (b.aiMode === 'own'));
    const editBtn = u => isMe(u) || !AI.limitOf(u) ? null : button('Изменить', { kind: 'secondary', size: 'sm', icon: 'edit', ariaLabel: 'Изменить лимит: ' + u.name, onClick: () => limitModal(u) });
    const flash = u => toneOf(ratio(u)) ? 'true' : null;
    const keyLine = u => u.aiMode === 'own' ? 'свой ключ …' + (u.ownKey ? u.ownKey.last4 : '••••') : 'ключ администратора';
    const nameCell = u => h('div', { class: 'adm-cell2' },
      h('span', { class: 'adm-person-name' }, h('span', { class: 'adm-nowrap' }, u.name), isMe(u) && chip('вы', 'accent'), u.role === 'admin' && !isMe(u) && chip('администратор', 'outline'), u.status === 'blocked' && chip('заблокирован', 'bad')),
      h('span', { class: 'adm-sub' }, keyLine(u)));
    const NO_LIMIT = 'Без личного лимита — только общий бюджет';
    const OWN = 'Лимит трат — в его консоли Anthropic';
    const capCell = u => h('div', { class: 'adm-cell2', style: 'align-items:flex-end' }, h('span', { class: 'mono' }, usdL(ownCap(u))), h('span', { class: 'adm-sub' }, 'задает участник'));
    const table = h('div', { class: 'table-wrap' }, h('table', { class: 'table adm-limits-table' },
      h('thead', null, h('tr', null, ['Участник', 'В месяц', 'Анализов в день', 'На анализ', 'Израсходовано', 'Пауза', ''].map((l, i) => h('th', { class: (i >= 1 && i <= 3) || i === 6 ? 'r' : null }, l || h('span', { class: 'sr-only' }, 'Действия'))))),
      h('tbody', null, rows.map(u => {
        const L = AI.limitOf(u);
        if (u.aiMode === 'own') return h('tr', null, h('td', null, nameCell(u)), h('td', { colspan: 2, class: 'adm-muted-cell' }, OWN), h('td', { class: 'r' }, capCell(u)), h('td', null, spendBlock(u)), h('td', { class: 'adm-muted-cell' }, '—'), h('td'));
        if (!L) return h('tr', null, h('td', null, nameCell(u)), h('td', { colspan: 3, class: 'adm-muted-cell' }, NO_LIMIT), h('td', null, spendBlock(u)), h('td', { class: 'adm-muted-cell' }, '—'), h('td'));
        return h('tr', { 'data-flash': flash(u) }, h('td', null, nameCell(u)), h('td', { class: 'r mono' }, usdL(L.monthly)), h('td', { class: 'r mono' }, String(L.daily)), h('td', { class: 'r mono' }, usdL(L.perAnalysis)), h('td', null, spendBlock(u)),
          h('td', null, switchInput('adm-pause-' + u.id, L.paused, 'Пауза: ' + u.name, v => setPause(u, v))), h('td', { class: 'r' }, editBtn(u)));
      }))));
    const cards = h('div', { class: 'adm-lcards' }, rows.map(u => {
      const L = AI.limitOf(u);
      const head = h('div', { class: 'adm-lcard-head' }, nameCell(u), editBtn(u));
      if (u.aiMode === 'own') return h('div', { class: 'adm-lcard' }, head, h('div', { class: 'small soft' }, OWN + '. Потолок на анализ — ' + usdL(ownCap(u)) + ', его задает участник'), spendBlock(u));
      if (!L) return h('div', { class: 'adm-lcard' }, head, h('div', { class: 'small soft' }, NO_LIMIT), spendBlock(u));
      return h('div', { class: 'adm-lcard', 'data-flash': flash(u) }, head,
        h('dl', { class: 'adm-facts' },
          h('div', null, h('dt', null, 'В месяц'), h('dd', null, usdL(L.monthly))),
          h('div', null, h('dt', null, 'В день'), h('dd', null, pl(L.daily, 'анализ', 'анализа', 'анализов'))),
          h('div', null, h('dt', null, 'На анализ'), h('dd', null, usdL(L.perAnalysis)))),
        spendBlock(u),
        h('label', { class: 'row-between', style: 'cursor:pointer;flex-wrap:nowrap', for: 'adm-pause-' + u.id + '-m' }, h('span', { class: 'small', style: 'min-width:0' }, h('b', null, 'Пауза'), h('span', { class: 'muted' }, ' — остановить анализы на вашем ключе')),
          switchInput('adm-pause-' + u.id + '-m', L.paused, 'Пауза: ' + u.name, v => setPause(u, v))));
    }));
    return card({
      title: 'Лимиты участников', subtitle: 'Расход за октябрь · лимит обнуляется 1-го числа', id: 'adm-limits', class: 'adm-anchor',
      body: [
        h('div', { class: 'adm-defaults' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Новым участникам по умолчанию'), h('div', { class: 'adm-defaults-v' }, limitText(A.defaults))),
          button('Изменить', { kind: 'secondary', size: 'sm', icon: 'edit', attrs: { id: 'adm-def-edit' }, ariaLabel: 'Изменить лимиты по умолчанию', onClick: defaultsModal })),
        h('div', { class: 'adm-wide-only adm-bleed' }, table),
        h('div', { class: 'adm-narrow-only', style: 'flex-direction:column' }, cards),
        howto('На своем ключе участник платит сам: лимит трат ставит в консоли Anthropic, потолок на один анализ — в личном кабинете. Здесь его можно только посмотреть.')],
    });
  }
  PANELS.key = () => [
    h('div', { class: 'grid' },
      h('div', { class: 'col-6 adm-col' }, keyCard()),
      h('div', { class: 'col-6 adm-col' }, budgetEditCard())),
    limitsCard(),
    thresholdsCard(),
  ];

  // =====================================================================
  // 6. РАСХОД ИИ
  // =====================================================================
  const PERSON_COLORS = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--s7)', 'var(--s5)', 'var(--s2)'];
  PANELS.usage = () => {
    const b = AI.budget();
    const onKey = AI.keyUsers().sort((x, y) => AI.keySpent(y) - AI.keySpent(x));
    const ownUsers = people().filter(u => u.aiMode === 'own' || AI.ownSpent(u) > 0);
    // анализы на вашем ключе: у тех, кто на нем весь месяц (сделанные на своем ключе в бюджет не входят)
    const analyses = sum(onKey, u => u.aiMode === 'admin' && !AI.ownSpent(u) ? u.analyses : 0);
    const ownTotal = sum(ownUsers, AI.ownSpent);
    const colored = onKey.map((u, i) => ({ u, color: PERSON_COLORS[i % PERSON_COLORS.length] }));
    const segs = colored.filter(x => AI.keySpent(x.u) > 0).map(x => ({ label: x.u.name.split(' ')[0], value: AI.keySpent(x.u), color: x.color }))
      .concat([{ label: 'Общие задачи', value: b.shared, color: 'var(--fg-3)' }]);
    const total = sum(segs, s => s.value) || 1;
    const max = Math.max(...colored.map(x => AI.keySpent(x.u)), b.shared) || 1;
    const metaOf = u => {
      const L = AI.limitOf(u), own = AI.ownSpent(u);
      if (u.aiMode === 'own') return 'до перехода на свой ключ';
      return (own ? 'вернулся со своего ключа · ' : '') + pl(u.analyses, 'анализ', 'анализа', 'анализов') + ' за октябрь · ' + (L ? 'лимит ' + usdL(L.monthly) + (L.paused ? ', пауза' : '') : 'без личного лимита');
    };

    const tiles = h('div', { class: 'grid' },
      UI.stat({ class: 'col-3 half-mobile', icon: 'coins', label: 'С вашего ключа', value: usd(b.spent), hint: pctOf(b.spent, b.monthly) + ' бюджета ' + usdL(b.monthly) }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'spark', label: 'Анализов на вашем ключе', value: String(analyses), hint: '≈ ' + usd(avgAnalysis()) + ' за анализ' }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'database', label: 'Вход из кэша', value: fmt.pct(AI.cacheShare, 0), hint: 'по всем задачам за октябрь' }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'key', label: 'На своих ключах', value: usd(ownTotal), hint: 'в ваш бюджет не входит' }));

    const peopleCard = card({
      title: 'По людям', subtitle: 'Октябрь, 1–' + DAY + ' · из чего складываются ' + usd(b.spent), id: 'adm-usage-people',
      body: [
        h('div', { class: 'adm-stack', role: 'img', 'aria-label': 'Состав расхода: ' + segs.map(s => s.label + ' ' + usd(s.value)).join(', ') },
          segs.map(s => h('i', { style: { width: (s.value / total * 100) + '%', background: s.color }, title: s.label + ': ' + usd(s.value) }))),
        h('div', { class: 'adm-legend' }, segs.map(s => h('span', null, h('i', { style: { background: s.color } }), s.label + ' ' + pctOf(s.value, total)))),
        h('ul', { class: 'adm-urows' },
          colored.map(({ u, color }) => h('li', { class: 'adm-urow' },
            h('div', { class: 'adm-urow-name' }, h('i', { class: 'adm-sw', style: { background: color } }), u.name, isMe(u) && chip('вы', 'accent'), u.status === 'blocked' && chip('заблокирован', 'bad'), u.status === 'deleted' && chip('удален', 'outline')),
            h('div', { class: 'adm-urow-val' }, h('b', null, usd(AI.keySpent(u))), h('small', null, pctOf(AI.keySpent(u), b.monthly, 1) + ' бюджета')),
            h('div', { class: 'adm-urow-meta' }, metaOf(u)),
            h('div', { class: 'adm-urow-bar', 'aria-hidden': 'true' }, h('i', { style: { width: (AI.keySpent(u) / max * 100) + '%', background: color } })))),
          h('li', { class: 'adm-urow' },
            h('div', { class: 'adm-urow-name' }, h('i', { class: 'adm-sw', style: { background: 'var(--fg-3)' } }), 'Общие фоновые задачи'),
            h('div', { class: 'adm-urow-val' }, h('b', null, usd(b.shared)), h('small', null, pctOf(b.shared, b.monthly, 1) + ' бюджета')),
            h('div', { class: 'adm-urow-meta' }, 'Обновление профилей игроков ночью пакетом — для всех сразу'),
            h('div', { class: 'adm-urow-bar', 'aria-hidden': 'true' }, h('i', { style: { width: (b.shared / max * 100) + '%', background: 'var(--fg-3)' } }))),
          totalRow(b)),
        howto('Длина полосы — расход, справа — доля месячного бюджета ' + usdL(b.monthly) + '. Ставки и банк участников здесь не показываются.'),
      ],
    });

    const tasks = taskBreakdown();
    const tasksCard = card({
      title: 'По задачам', subtitle: 'Те же ' + usd(b.spent) + ' по типам запусков · справа — доля бюджета',
      body: [
        UI.hbars({ items: tasks.map(t => ({ label: t.short, value: t.cost, note: pctOf(t.cost, b.monthly, 1), color: t.shared ? 'var(--fg-3)' : 'var(--s1)', dot: false })), valueFormat: v => usd(v) }),
        h('div', { class: 'adm-bleed' }, UI.table({
          columns: [
            { label: 'Задача', render: t => t.label },
            { label: 'Модель', render: t => h('span', { class: 'adm-nowrap' }, t.model) },
            { label: 'Кэш', align: 'r', render: t => t.cache ? fmt.pct(t.cache * 100, 0) : 'нет' },
          ],
          rows: tasks,
        })),
        howto('Кэш — какая часть входных токенов читается из кэша: это в 10–20 раз дешевле обычного входа. Разбор текста короткий, его не кэшируем.'),
      ],
    });

    const ownCard = card({
      title: 'На своем ключе', subtitle: 'Платят сами, в ваш бюджет не входит',
      body: ownUsers.length ? [
        h('div', { class: 'adm-list' }, ownUsers.map(u => item({ ic: 'key', icKind: 'info', title: u.name,
          meta: u.aiMode === 'own'
            ? pl(u.analyses, 'анализ', 'анализа', 'анализов') + ' · ключ sk-ant-…' + (u.ownKey ? u.ownKey.last4 : '••••') + (u.ownKey && u.ownKey.verified ? ', проверен ' + dateDay(u.ownKey.verified) : '')
            : 'До ' + dateDay(TODAY) + ' работал на своем ключе, теперь — на вашем',
          side: h('b', { class: 'mono' }, usd(AI.ownSpent(u))) }))),
        howto('Лимит трат такие участники ставят в своей консоли Anthropic, потолок на один анализ — сами в личном кабинете.'),
      ] : h('p', { class: 'small soft' }, 'Сейчас все участники на вашем ключе.'),
    });

    return [
      h('div', { class: 'row-between' }, h('div', { class: 'small soft' }, 'Октябрь, 1–' + DAY + ' · все суммы в долларах, как считает Anthropic'), button('Ключ и бюджет', { kind: 'ghost', size: 'sm', icon: 'key', onClick: () => switchTab('key') })),
      tiles,
      h('div', { class: 'adm-main' }, peopleCard, h('div', { class: 'adm-col' }, tasksCard, ownCard)),
    ];
  };

  // =====================================================================
  // 7. НАСТРОЙКИ ПРОГРАММЫ
  // =====================================================================
  function curFmt(x, code) {
    const L = UI.currency.list[code];
    return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: L.dec, maximumFractionDigits: L.dec }).format(x) + ' ' + L.sym;
  }
  // Курс ЕЦБ евро к доллару на 7 октября (в макете — константа; рубль ЕЦБ не публикует с марта 2022 года)
  const ECB_EUR_USD = 1.0887;
  const rateStr = (x, d) => x.toFixed(d).replace('.', ',');
  function currencyModal(to) {
    const from = UI.currency.code, L = UI.currency.list;
    const viaRub = from === 'RUB' || to === 'RUB';
    const base = viaRub ? (to === 'RUB' ? from : to) : 'EUR';
    const quote = viaRub ? 'RUB' : 'USD';
    const current = L[quote].rate / L[base].rate; // сейчас программа считает 1 base = current quote
    const digits = quote === 'RUB' ? 2 : 4;
    const fRate = UI.field({ id: 'adm-rate', label: 'Курс: 1 ' + L[base].sym + ' =', value: rateStr(current, digits), inputmode: 'decimal', autocomplete: 'off', suffix: L[quote].sym,
      hint: viaRub ? 'ЕЦБ не публикует курс рубля с марта 2022 года — проверьте курс и при необходимости введите свой, например курс вашего банка на сегодня' : 'Курс ЕЦБ на ' + dateDay(TODAY) + ': 1 € = ' + rateStr(ECB_EUR_USD, 4) + ' $' });
    const rateInput = fRate.querySelector('input');
    const preview = h('div', { class: 'adm-preview', 'aria-live': 'polite' });
    const bankFrom = D.stats.bank * L[from].rate; // банк администратора в текущей валюте
    const stakeFrom = 1500 * L[from].rate;
    // Множитель: сумма в новой валюте = сумма в текущей × f (по введенному курсу)
    const factor = r => base === to ? 1 / r : r;
    function drawPreview() {
      const r = num(rateInput.value);
      UI.clear(preview);
      if (!(r > 0)) { preview.appendChild(h('span', null, 'Введите курс больше нуля')); return; }
      const f = factor(r);
      preview.appendChild(h('span', null, 'Ваш банк: ', h('b', null, curFmt(bankFrom, from)), ' → ', h('b', null, curFmt(bankFrom * f, to))));
      preview.appendChild(h('span', null, 'Ставка: ', h('b', null, curFmt(stakeFrom, from)), ' → ', h('b', null, curFmt(stakeFrom * f, to))));
    }
    rateInput.addEventListener('input', drawPreview);
    drawPreview();
    const ack = h('input', { type: 'checkbox', id: 'adm-cur-ack' });
    let go = null;
    ack.addEventListener('change', () => { go.disabled = !ack.checked; });
    UI.modal({
      title: 'Сменить валюту программы',
      body: h('div', { class: 'stack' },
        h('div', { class: 'adm-swap' }, L[from].sym + ' ' + L[from].label, icon('arrowRight'), L[to].sym + ' ' + L[to].label),
        fRate,
        viaRub ? null : h('div', { class: 'row' }, button('Подставить курс ЕЦБ', { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { rateInput.value = rateStr(ECB_EUR_USD, 4); drawPreview(); } })),
        preview,
        UI.callout('warn', 'alert', h('b', null, 'Все суммы у всех участников будут пересчитаны по этому курсу: '), 'банки, ставки, прибыль, лимиты на ставки. ROI, CLV и Brier не изменятся. Расходы на Claude остаются в долларах. Курс, дата и кто менял запишутся в журнал.'),
        h('label', { class: 'adm-check', for: 'adm-cur-ack' }, ack, h('span', null, 'Понимаю: суммы пересчитаются у всех участников'))),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        go = button('Пересчитать и сменить', { kind: 'primary', icon: 'currency', disabled: true, attrs: { id: 'adm-cur-go' }, onClick: () => {
          const r = num(rateInput.value);
          if (!setErr(fRate, r > 0 ? null : 'Введите курс больше нуля')) return;
          close();
          // Новый курс валюты к рублям демо-данных: пересчет идет ровно по введенному курсу
          const newRate = L[from].rate * factor(r);
          const e = entry('set_currency', null, 'Валюта программы: ' + lc(L[from].label) + ' → ' + lc(L[to].label) + ', курс 1 ' + L[base].sym + ' = ' + String(r).replace('.', ',') + ' ' + L[quote].sym);
          UI.currency.set(to, newRate, e);
          log(null, null, null, e);
          UI.rerender();
          UI.toast('Валюта программы — ' + lc(L[to].label) + '. Суммы пересчитаны у всех участников', 'currency');
        } }),
      ],
    });
  }
  // Последняя смена валюты из журнала: «с какой даты», кто менял и по какому курсу
  function lastCurrencyChange() {
    const list = A.audit.filter(e => e.action === 'set_currency').sort((a, b) => (a.at < b.at ? 1 : -1));
    const e = list[0];
    if (!e) return null;
    const m = e.details.match(/(?:→|:)\s*([^,→]+?)\s*(?:,|$)/g);
    const toLabel = m ? m[m.length - 1].replace(/^(?:→|:)\s*/, '').replace(/,$/, '').trim() : '';
    if (toLabel !== lc(UI.currency.label)) return null; // запись не о текущей валюте
    const rate = (e.details.match(/курс (.+)$/) || [])[1];
    return { e, rate };
  }
  function currencyCard() {
    const c = UI.currency, L = c.list;
    const last = lastCurrencyChange();
    return card({
      title: 'Валюта программы', subtitle: 'Одна на всех участников', class: 'adm-fill',
      body: [
        h('div', { class: 'adm-cur-now' }, h('span', { class: 'adm-cur-sym', 'aria-hidden': 'true' }, c.sym),
          h('div', null, h('div', { class: 'adm-cur-name' }, c.label),
            last && h('div', { class: 'xsmall muted', id: 'adm-cur-since' }, 'с ' + dateLong(last.e.at) + ' · ' + actorText(last.e) + (last.rate ? ' · курс ' + last.rate : '')))),
        h('p', { class: 'small soft' }, 'В ней ведутся банки, суммы ставок, прибыль и аналитика у всех участников. Расходы на Claude всегда в долларах — так считает Anthropic.'),
        h('div', { class: 'adm-choices three', role: 'group', 'aria-label': 'Валюта программы' }, Object.keys(L).map(code => h('button', {
          type: 'button', class: 'adm-choice', 'aria-pressed': String(code === c.code), 'data-cur': code,
          on: { click: () => { if (code !== c.code) currencyModal(code); } },
        }, h('span', { class: 'adm-choice-sym', 'aria-hidden': 'true' }, L[code].sym), h('span', null, h('b', null, L[code].label), h('small', null, code === c.code ? 'сейчас' : code === 'RUB' || c.code === 'RUB' ? 'курс вводится вручную' : 'подсказка — курс ЕЦБ'))))),
        UI.kv([['Букмекеры', 'список каждый участник ведет сам'], ['Эталон рынка', 'кэф ' + D.marketRef]]),
      ],
    });
  }
  function tzCard() {
    const f = UI.field({ id: 'adm-tz', label: 'Часовой пояс', options: TZ, value: st.tz, hint: 'Смещение от UTC — на октябрь. Каждый участник может выбрать свой пояс в личном кабинете' });
    let save = null;
    save = button('Сохранить', { kind: 'primary', size: 'sm', icon: 'check', disabled: true, onClick: () => {
      const v = valOf(f);
      log('settings', null, 'Часовой пояс для новых участников: ' + tzLabel(st.tz) + ' → ' + tzLabel(v));
      st.tz = v;
      UI.toast('Часовой пояс для новых участников: ' + tzLabel(v), 'clock');
      refresh();
    } });
    f.querySelector('select').addEventListener('change', e => { save.disabled = e.target.value === st.tz; });
    return card({ title: 'Часовой пояс по умолчанию', subtitle: 'Для новых участников: время матчей и уведомлений', body: [f], foot: [save] });
  }
  function serverCard() {
    return card({
      title: 'Сервер', subtitle: 'Для информации, здесь не меняется',
      body: [
        UI.kv([['Где', 'Финляндия, Хельсинки'], ['Бэкапы', 'там же, в ЕС'], ['Время на сервере', 'UTC'], ['Язык интерфейса', 'русский']]),
        howto('Данные участников из Финляндии и Германии не покидают ЕС; наружу уходят только запросы к Claude API.'),
      ],
    });
  }
  PANELS.settings = () => h('div', { class: 'adm-main' },
    h('div', { class: 'adm-col' }, currencyCard()),
    h('div', { class: 'adm-col' }, tzCard(), serverCard()));

  // =====================================================================
  // 8. ЖУРНАЛ
  // =====================================================================
  PANELS.audit = () => {
    const g = AUDIT_GROUPS.find(x => x.id === st.auditFilter) || AUDIT_GROUPS[0];
    const list = A.audit.filter(g.test);
    const sel = UI.field({ id: 'adm-audit-filter', label: 'Тип действия', options: AUDIT_GROUPS.map(x => ({ value: x.id, label: x.label + ' · ' + A.audit.filter(x.test).length })), value: g.id, style: 'max-width:340px;width:100%' });
    sel.querySelector('select').addEventListener('change', e => { st.auditFilter = e.target.value; redrawPanel(); });
    const whoCell = e => h('div', { class: 'adm-cell2' }, actorNode(e), h('span', { class: 'adm-ip' }, e.ip));
    const table = UI.table({
      columns: [
        { label: 'Когда', render: e => h('span', { class: 'adm-nowrap' }, when(e.at)) },
        { label: 'Кто', render: whoCell },
        { label: 'Действие', render: e => h('div', { class: 'adm-cell2' }, h('b', null, actionOf(e)[0]), e.fresh && chip('новое', 'accent')) },
        { label: 'Кого касается', render: e => e.target || h('span', { class: 'muted' }, 'вся программа') },
        { label: 'Подробности', render: e => h('span', { class: 'soft' }, e.details) },
      ],
      rows: list, empty: 'Таких действий в журнале нет',
    });
    table.querySelector('table').classList.add('adm-audit-table');
    table.querySelectorAll('tbody tr').forEach((tr, i) => { if (list[i] && list[i].fresh) tr.classList.add('is-fresh'); });
    const mobileList = list.length ? h('ul', { class: 'adm-log' }, list.map(e => h('li', null,
      h('div', { class: 'adm-log-top' }, h('b', null, actionOf(e)[0], e.target ? ': ' + e.target : ''), h('span', { class: 'adm-log-when' }, when(e.at))),
      h('div', { class: 'adm-log-det' }, e.details),
      h('div', { class: 'adm-log-who' }, actorNode(e), h('span', { class: 'adm-ip' }, e.ip), e.fresh && chip('новое', 'accent'))))) : UI.empty('Таких действий в журнале нет');
    return card({
      title: 'Журнал действий', subtitle: 'Кто, что и когда сделал: администраторы, участники с ключом Claude и команды терминала', flush: true,
      body: [
        h('div', { style: 'padding:0 18px 4px', class: 'adm-toolbar' }, sel, h('span', { class: 'small muted' }, pl(list.length, 'запись', 'записи', 'записей') + ' · записи нельзя изменить или удалить')),
        h('div', { class: 'adm-wide-only' }, table),
        h('div', { class: 'adm-narrow-only', style: 'padding:4px 14px 14px' }, mobileList),
      ],
    });
  };

  // =====================================================================
  // 9. СООБЩЕНИЕ УЧАСТНИКАМ
  // =====================================================================
  PANELS.message = () => {
    const rec = recipients();
    if (st.msg.user && !rec.some(u => u.id === st.msg.user)) st.msg.user = '';
    if (!st.msg.user && rec.length) st.msg.user = rec[0].id;
    const MAX = 280;
    const TEMPLATES = [
      { label: 'Работы на сервере', text: 'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.' },
      { label: 'Лимиты', text: 'Напоминаю: на моем ключе лимит — ' + limitText(A.defaults) + '. Если нужно больше, напишите мне.' },
      { label: 'Push на телефон', text: 'Установите AI Capper на телефон («Поделиться» → «На экран Домой») и разрешите уведомления, чтобы не пропускать расчет ставок.' },
    ];
    const ta = h('textarea', { class: 'textarea', id: 'adm-msg-text', rows: 4, maxlength: String(MAX), placeholder: 'Например: в субботу с 10:00 до 10:30 сервер обновляется', 'aria-describedby': 'adm-msg-hint' });
    ta.value = st.msg.text;
    const counter = h('span', { class: 'adm-count', 'aria-live': 'polite' });
    const pBody = h('span', { class: 'notif-body' });
    let send = null;
    const toWhom = () => st.msg.to === 'all' ? rec : rec.filter(u => u.id === st.msg.user);
    function sync() {
      st.msg.text = ta.value;
      const n = ta.value.length;
      counter.textContent = n + ' / ' + MAX;
      counter.classList.toggle('warn', n > MAX - 30);
      pBody.textContent = ta.value.trim() || 'Текст сообщения появится здесь';
      pBody.classList.toggle('muted', !ta.value.trim());
      if (send) send.disabled = !ta.value.trim() || !toWhom().length;
    }
    ta.addEventListener('input', sync);
    const userSel = UI.field({ id: 'adm-msg-user', label: 'Получатель', options: rec.map(u => ({ value: u.id, label: u.name })), value: st.msg.user });
    userSel.querySelector('select').addEventListener('change', e => { st.msg.user = e.target.value; });
    userSel.style.display = st.msg.to === 'one' ? '' : 'none';
    const seg = UI.segmented({ label: 'Кому', items: [{ id: 'all', label: 'Всем участникам · ' + rec.length }, { id: 'one', label: 'Одному' }], active: st.msg.to, onChange: id => { st.msg.to = id; userSel.style.display = id === 'one' ? '' : 'none'; sync(); } });
    send = button('Отправить', { kind: 'primary', icon: 'send', attrs: { id: 'adm-msg-send' }, onClick: () => {
      const text = ta.value.trim(), to = toWhom();
      if (!text || !to.length) return;
      const n = to.length, at = now();
      const target = st.msg.to === 'all' ? 'Все участники (' + n + ')' : to[0].name;
      log('message', target, text);
      // участница из демо-роли увидит сообщение в колокольчике, если переключить макет на нее
      if (to.some(u => u.id === D.personas.member.id)) D.notifications.member.unshift({ id: 'adm-' + D.notifications.member.length + '-' + clock, kind: 'admin_message', icon: 'megaphone', tone: 'info', title: 'Сообщение администратора', body: text, at, read: false });
      st.msg.text = '';
      UI.toast('Отправлено ' + n + ' ' + fmt.plural(n, 'участнику', 'участникам', 'участникам') + ': на сайте и push', 'send');
      refresh();
    } });
    const form = card({
      title: 'Сообщение участникам', subtitle: 'Короткое уведомление: о работах на сервере, новых лимитах и т. п.', class: 'adm-fill',
      body: [
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, h('span', null, 'Кому')), seg),
        userSel,
        h('div', { class: 'field' },
          h('label', { class: 'field-label', for: 'adm-msg-text' }, h('span', null, 'Текст'), counter),
          ta,
          h('div', { class: 'field-hint', id: 'adm-msg-hint' }, 'До ' + MAX + ' символов. Придет в центр уведомлений на сайте и push на телефон тем, кто установил приложение и разрешил уведомления. Заблокированным не приходит.')),
        h('div', { class: 'adm-presets' }, h('span', null, 'Шаблоны:'), TEMPLATES.map(t => h('button', { type: 'button', class: 'adm-pill', on: { click: () => { ta.value = t.text.slice(0, MAX); sync(); ta.focus(); } } }, t.label))),
      ],
      foot: [send],
    });
    const preview = card({
      title: 'Так увидят участники', subtitle: 'Центр уведомлений (колокольчик)',
      body: h('div', { class: 'adm-notif' },
        h('div', { class: 'notif-head' }, h('div', { class: 'notif-head-title' }, 'Уведомления')),
        h('div', { class: 'notif-list' }, h('div', { class: 'notif-item unread' },
          h('span', { class: 'notif-ic info' }, icon('megaphone')),
          h('span', { class: 'notif-text' }, h('span', { class: 'notif-title' }, 'Сообщение администратора'), pBody, h('span', { class: 'notif-time' }, 'Сейчас')),
          h('span', { class: 'notif-dot', 'aria-hidden': 'true' })))),
    });
    // Отправленные — те же записи «Сообщение участникам», что в журнале
    const history = A.audit.filter(e => e.action === 'message');
    const historyCard = card({
      title: 'Отправленные', subtitle: 'Последние сообщения · они же в журнале', id: 'adm-msg-sent',
      body: history.length ? h('div', { class: 'adm-list' }, history.slice(0, 5).map(e => item({ ic: 'megaphone', title: when(e.at) + ' · ' + (e.target || 'Все участники'), titleExtra: e.fresh && chip('новое', 'accent'), meta: [e.details, h('div', { class: 'xsmall muted' }, 'Отправил ' + actorText(e))] }))) : h('p', { class: 'small soft' }, 'Сообщений еще не было.'),
    });
    sync();
    return h('div', { class: 'adm-main' }, form, h('div', { class: 'adm-col' }, preview, historyCard));
  };

  // ---------- экран ----------
  UI.register('admin', {
    title: 'Администрирование',
    nav: 'admin',
    crumbs: 'Управление',
    adminOnly: true,
    render(root, param) {
      const p = param || '';
      const tab = p === 'limits' ? 'key' : TABS.some(t => t.id === p) ? p : 'overview';
      if (tab !== st.tab) st.resetShown = null;
      st.tab = tab;
      headSlot = h('div', { style: 'min-width:0' });
      tabsSlot = h('div', { class: 'adm-anchor', style: 'min-width:0' });
      panelEl = h('div', { class: 'adm-panel', id: 'adm-panel', role: 'tabpanel', tabindex: '-1' });
      drawHead(); drawTabs(); drawPanel();
      UI.append(root, [headSlot, tabsSlot, panelEl]);
      if (p === 'limits') {
        // из уведомления «израсходовал 80%»: прокрутить к лимитам и подсветить тех, кто у порога
        setTimeout(() => {
          const el = document.getElementById('adm-limits');
          if (!el) return;
          el.scrollIntoView({ block: 'start' });
          el.querySelectorAll('[data-flash]').forEach(r => r.classList.add('adm-flash'));
        }, 60);
      }
    },
  });
})();
