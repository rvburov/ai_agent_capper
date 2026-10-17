/* ИИ и расходы: вверху — лимит участника на ключе администратора или бюджет ключа администратора (по роли),
   ниже — собственные вызовы Claude: токены и кэш, цена каждого вызова, расход по дням и задачам, цены моделей
   и настройки агента (только показ: их меняет команда agent-config, Р23).
   Задачи — по коду этапа 3 (Т19): разбор текста — Haiku 5.5, новости перед анализом — Sonnet 5.5 с веб-поиском,
   оценка матча — Opus 5.5, один вызов на матч. Строка журнала — вызов (agent_runs) с шагом и effort, со ссылкой
   на свой анализ (Т17). Бюджет ключа, расход по людям и лимиты — только из общего расчета DATA.ai (budget, keySpent,
   ownSpent, keyUsers, limitOf): так цифры совпадают с главной и «Администрированием». Вызовы — DATA.ai.runs. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, A = DATA.ai;

  // ---------- цены (прайс Anthropic за 1M токенов на 1 октября 2026; совпадают с model_prices и data.js) ----------
  // write — запись в кэш на 5 минут (вход × 1,25)
  const PRICE = {
    'Opus 5.5': { in: 4, out: 20, cache: 0.2, write: 5, id: 'claude-opus-5-5' },
    'Sonnet 5.5': { in: 2, out: 10, cache: 0.1, write: 2.5, id: 'claude-sonnet-5-5' },
    'Haiku 5.5': { in: 0.1, out: 0.5, cache: 0.01, write: 0.125, id: 'claude-haiku-5-5', note: 'весь вход запроса больше 100 тыс. токенов — все цены × 5' },
  };
  const SEARCH = A.searchUsd || 0.01; // $10 за 1000 веб-поисков

  // ---------- период: месяц расходов по UTC (PLAN, раздел 6), с 1-го по сегодня ----------
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const MONTHS_IN = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
  const Y = +D.today.slice(0, 4), M = +D.today.slice(5, 7), DAYS = +D.today.slice(8, 10);
  const MONTH_DAYS = new Date(Date.UTC(Y, M, 0)).getUTCDate();
  const PERIOD = (DAYS === 1 ? '1 ' : '1–' + DAYS + ' ') + MONTHS_GEN[M - 1];          // «1–7 октября»
  const PERIOD_SHORT = (DAYS === 1 ? '1 ' : '1–' + DAYS + ' ') + fmt.date(D.today).split(' ')[1]; // «1–7 окт»
  const MONTH_END = MONTH_DAYS + ' ' + fmt.date(D.today).split(' ')[1];               // «31 окт»
  const days = [];
  for (let d = 1; d <= DAYS; d++) days.push(D.today.slice(0, 8) + String(d).padStart(2, '0'));

  // ---------- задачи (Т19) и шаги анализа ----------
  // У шага одно имя на всем экране — short (заголовки, списки, окно вызова); bar и tiny — его сокращения для узких мест
  const EFFORT_LABEL = { low: 'низкий', medium: 'средний', high: 'высокий' };
  const TYPE_UI = {
    analysis: { short: 'Оценка матча', tiny: 'Оценка', bar: 'Оценка матча', prompt: 'analysis v1', per: 'один вызов на матч' },
    news: { short: 'Новости', tiny: 'Новости', bar: 'Новости', prompt: 'news v2', per: '2 поиска на матч' },
    parse: { short: 'Разбор текста', tiny: 'Текст', bar: 'Разбор текста', prompt: 'parse_input v1', per: 'один вызов на ввод' },
    postmortem: { short: 'Разбор ставки', tiny: 'Разбор', bar: 'Разбор ставки', prompt: 'postmortem v1', per: 'один на матч, Batch −50%' },
  };
  const TYPES = (A.runTypes || []).map(t => Object.assign({ short: t.label, tiny: t.label, bar: t.label, prompt: '—', per: '' }, t, TYPE_UI[t.id] || {}));
  const typeOf = id => TYPES.find(t => t.id === id) || { id, label: id, short: id, tiny: id, bar: id, model: '', effort: null, prompt: '—', per: '' };
  // Шаги анализа — как на экране «Анализ»: разбор, игроки, новости (по матчам), досье, модель, Claude (по матчам), экспресс
  const STEPS = { 1: 'разбор текста', 2: 'игроки', 3: 'новости', 4: 'досье', 5: 'модель', 6: 'оценка Claude', 7: 'экспресс' };
  const SPEC = Object.fromEntries((A.analyses || []).map(a => [a.id, a]));
  const RECENT = Object.fromEntries((D.recentAnalyses || []).map(a => [a.id, a]));
  const isShared = r => (A.isShared ? A.isShared(r) : !!r.shared);
  const isErr = r => r.status === 'error';
  // Матч вызова: по «Последним анализам», если анализ там есть, иначе — номер матча
  function matchOf(r) {
    if (r.matchLabel) return r.matchLabel + (r.bet ? ' · ставка №' + r.bet : ' · матч другого участника');
    if (r.match == null) return null;
    const ra = RECENT[r.analysis], m = ra && ra.matches && ra.matches[r.match];
    const n = SPEC[r.analysis] ? SPEC[r.analysis].n : null;
    return m ? D.match(m) : 'матч ' + (r.match + 1) + (n ? ' из ' + n : '');
  }
  const stepText = r => (r.step ? 'шаг ' + r.step + ' из 7 · ' + STEPS[r.step] : '');
  const analysisHref = id => (RECENT[id] && RECENT[id].demo ? '#analysis' : '#analysis-' + id);

  // ---------- форматтеры ----------
  const nfCache = {};
  const nf = d => nfCache[d] || (nfCache[d] = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usd = (n, d = 2) => (n < 0 ? '−' : '') + '$' + nf(d).format(Math.abs(n));
  const usdL = n => usd(n, Number.isInteger(n) ? 0 : 2); // лимиты и потолки: $10, $1, но $1,50
  const usdP = usdL;                                     // цены за 1M токенов: $4 / $20, но $0,10 / $0,50
  // цена одного вызова: разбор текста на Haiku 5.5 стоит доли цента — четыре знака, а не $0,000
  const usdRun = n => usd(n, n > 0 && n < 0.001 ? 4 : 3);
  // суммы и доли в сводках: копейки не превращаются в «$0,00 · 0%»
  const usdSum = n => (n > 0 && n < 0.01 ? '< $0,01' : usd(n));
  const pct = (x, d = 0) => nf(d).format(x * 100) + '%';
  const pctShare = x => (x > 0 && x < 0.005 ? '< 1%' : pct(x));
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const weekday = iso => WD[new Date(iso.slice(0, 10) + 'T12:00:00Z').getUTCDay()];
  const calls = n => n + ' ' + fmt.plural(n, 'вызов', 'вызова', 'вызовов');
  // Части цены вызова: новый вход, запись в кэш (× 1,25), чтение кэша, выход, поиски
  const partsOf = r => {
    const fresh = r.fresh != null ? r.fresh : r.input - r.cached, written = r.written || 0, read = r.read != null ? r.read : r.cached;
    return { fresh, written, read };
  };

  // ---------- кто смотрит и чьи вызовы считаем ----------
  // Р7, Р9, Р13: участник на ключе администратора видит свой лимит и только свои вызовы. Общие фоновые задачи
  // (вызовы без участника — сейчас прогоны приемки) идут на ключе администратора и в лимит участника не входят.
  // Администратор видит бюджет всего ключа, а ниже — свои вызовы и общие фоновые задачи (помечены «Приемка»).
  const monthPace = v => v / DAYS * MONTH_DAYS;
  function personalForecast(u, v) {
    const L = A.limitOf(u);
    if (L && L.paused) return v;
    return L ? Math.min(L.monthly, monthPace(v)) : monthPace(v);
  }
  const ownCapOf = u => (u.ownCap != null ? u.ownCap : D.admin.defaults.perAnalysis);
  let V, SCOPE_RUNS, RUNS, BASE, TOT, SPENT, CACHE_SHARE, byDay, cacheSavedWeek, SCOPE_TYPES, AN;
  let ALERT = 80;
  let runFilter = 'all', showAllRuns = false;
  function setScope() {
    const me = D.me || {};
    const admin = !!(UI.auth && UI.auth.isAdmin);
    const own = !admin && me.aiMode === 'own';
    const limit = A.limitOf(me) || Object.assign({}, D.admin.defaults);
    V = { admin, me, own, limit, cap: own ? ownCapOf(me) : limit.perAnalysis };
    ALERT = D.admin.budget.alertAt || 80;
    SCOPE_RUNS = admin ? A.runs : A.runs.filter(r => !isShared(r));
    RUNS = SCOPE_RUNS.slice().sort((a, b) => b.at.localeCompare(a.at));
    BASE = {};
    TYPES.forEach(t => {
      const rs = SCOPE_RUNS.filter(r => r.type === t.id && !isErr(r));
      const n = rs.length;
      const s = { n, input: sum(rs, r => r.input), cached: sum(rs, r => r.cached), written: sum(rs, r => partsOf(r).written), output: sum(rs, r => r.output), searches: sum(rs, r => r.searches), cost: sum(rs, r => r.cost) };
      BASE[t.id] = Object.assign(s, { avgIn: n ? s.input / n : 0, avgOut: n ? s.output / n : 0, avgCost: n ? s.cost / n : 0, cacheShare: s.input ? s.cached / s.input : 0 });
    });
    SCOPE_TYPES = TYPES.filter(t => BASE[t.id].n);
    TOT = { input: sum(SCOPE_RUNS, r => r.input), cached: sum(SCOPE_RUNS, r => r.cached), output: sum(SCOPE_RUNS, r => r.output), searches: sum(SCOPE_RUNS, r => r.searches), runs: SCOPE_RUNS.length };
    // Сумма уже округленных частей — своих вызовов и общих задач, как строки «Кто тратит» у администратора
    const r2 = v => Math.round(v * 100) / 100;
    SPENT = r2(r2(sum(SCOPE_RUNS.filter(r => !isShared(r)), r => r.cost)) + r2(sum(SCOPE_RUNS.filter(isShared), r => r.cost)));
    CACHE_SHARE = TOT.input ? TOT.cached / TOT.input : 0;
    byDay = days.map(day => {
      const rs = SCOPE_RUNS.filter(r => r.at.slice(0, 10) === day);
      return { day, runs: rs, cost: sum(rs, r => r.cost), tokens: sum(rs, r => r.input + r.output) };
    });
    // Анализ — запуск из нескольких вызовов: цена анализа — по анализам, а не по вызовам. Отмененные и сорвавшиеся
    // анализы в среднюю цену не входят (они дешевле), но их вызовы — в расход
    const ids = Array.from(new Set(SCOPE_RUNS.filter(r => r.analysis).map(r => r.analysis)));
    AN = ids.map(id => { const rs = SCOPE_RUNS.filter(r => r.analysis === id), s = SPEC[id] || {}; return { id, at: rs[0].at, runs: rs, cost: sum(rs, r => r.cost), done: !s.cancelled && s.failedAt == null && !rs.some(isErr) }; })
      .sort((a, b) => a.at.localeCompare(b.at));
    // Сколько сэкономило чтение кэша: те же токены по цене обычного входа минус фактическая цена чтения
    cacheSavedWeek = sum(SCOPE_RUNS, r => { const p = PRICE[r.model]; return p ? r.cached * (p.in - p.cache) / 1e6 : 0; });
    if (runFilter !== 'all' && runFilter !== 'shared' && !SCOPE_TYPES.some(t => t.id === runFilter)) runFilter = 'all';
    if (runFilter === 'shared' && !V.admin) runFilter = 'all';
  }
  const doneAn = () => AN.filter(a => a.done);
  const avgAnalysis = () => { const d = doneAn(); return d.length ? sum(d, a => a.cost) / d.length : 0; };
  const sharedSpent = () => A.budget().shared;
  const EVAL = A.eval || { monthly: 25, spent: 0, runs: [] };

  // ---------- стили экрана ----------
  UI.css('costs', `
    .costs-head h2 { font-size: var(--fs-2xl); }
    .costs-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .card.stat.costs-hero { padding: 18px; gap: 14px; height: 100%; justify-content: flex-start; }
    .costs-hero-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 2px; }
    .costs-hero-top { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .costs-hero-value { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .costs-hero-value .stat-value { white-space: nowrap; }
    .costs-hero-value .of { color: var(--fg-3); font-size: var(--fs-lg); white-space: nowrap; }
    .costs-hero-value .chip { margin-left: auto; }
    .costs-bar { position: relative; height: 12px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .costs-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
    .costs-bar .proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 42%, transparent) 0 3px, color-mix(in srgb, var(--accent) 16%, transparent) 3px 7px); }
    .costs-bar .spent { background: var(--accent); }
    .costs-bar.warn .spent { background: var(--warn); }
    .costs-bar.bad .spent { background: var(--bad); }
    .costs-bar-legend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 14px; font-size: var(--fs-xs); color: var(--fg-2); }
    .costs-bar-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .costs-bar-legend i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .costs-bar-legend i.spent { background: var(--accent); }
    .costs-bar-legend i.proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 50%, transparent) 0 2px, color-mix(in srgb, var(--accent) 18%, transparent) 2px 4px); }
    .costs-kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding-top: 14px; border-top: 1px solid var(--line); }
    .costs-kv > div { min-width: 0; }
    .costs-kv dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-kv dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .costs-kv dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); white-space: normal; }
    .costs-tiles > .card { height: 100%; }
    .costs-hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .costs-hero-sub { font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-hero-note { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.45; margin: 0; }
    .costs-hero-note svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .costs-hero-actions .costs-hero-note { font-size: var(--fs-sm); color: var(--fg-2); align-items: center; }
    .costs-bar .tick { left: 80%; width: 2px; margin-left: -1px; border-radius: 0; background: var(--fg-2); opacity: .55; }
    .costs-bar-legend i.tick { width: 2px; height: 12px; border-radius: 0; background: var(--fg-2); opacity: .55; }
    .costs-top > div > .card { height: 100%; }
    .costs-section { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 8px 0 -4px; }
    .costs-section h3 { font-size: var(--fs-lg); }
    .costs-who .t { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .costs-who li.total { border-top: 1px solid var(--line-strong); }
    .costs-who li.total .t, .costs-who li.total .v { font-weight: 700; }
    .costs-who li.aside .t, .costs-who li.aside .v { color: var(--fg-2); }
    .costs-who-name { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .costs-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .costs-rules li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: start; }
    .costs-rules li:first-child { border-top: 0; padding-top: 2px; }
    .costs-rules-ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .costs-rules-ic svg { width: 16px; height: 16px; }
    .costs-rules-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .costs-rules-ic.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .costs-rules-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .costs-rules-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-rules-body b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .costs-main { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
    .costs-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1180px) {
      .costs-main { display: flex; flex-direction: column; align-items: stretch; }
      .costs-col { display: contents; }
      .costs-o-1 { order: 1; } .costs-o-2 { order: 2; } .costs-o-3 { order: 3; } .costs-o-4 { order: 4; } .costs-o-5 { order: 5; }
    }
    .costs-tiles .stat-hint { line-height: 1.35; }
    .costs-kpi .stat { height: 100%; }
    .costs-kpi .stat-foot { margin-top: auto; }
    @media (min-width: 721px) {
      .costs-kpi .stat-foot { flex-wrap: nowrap; align-items: flex-end; }
      .costs-kpi .stat-foot > .row { flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }
      .costs-kpi .stat-foot > svg { flex: none; }
    }

    .costs-howto { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; }
    .costs-howto svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
    .costs-card .card-head { flex-wrap: nowrap; }
    .costs-card .card-head > div:first-child { flex: 1 1 auto; }
    .costs-card .card-head > .row { flex: none; }
    @media (max-width: 720px) { .costs-card .card-head { flex-wrap: wrap; } }

    .costs-types { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
    .costs-type { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; width: calc(100% + 16px); min-height: 44px; padding: 10px 8px; margin: 0 -8px; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--fg); text-align: left; cursor: pointer; border-radius: 0; font: inherit; }
    .costs-types li:last-child .costs-type { border-bottom: 0; }
    .costs-type:hover { background: var(--surface-2); }
    .costs-type-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; min-width: 0; }
    .costs-type-meta { grid-column: 1 / 2; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .costs-type-cost { grid-row: 1 / 3; grid-column: 2; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
    .costs-type-cost b { display: block; font-weight: 600; }
    .costs-type-cost small { display: block; font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-type-cost svg { width: 16px; height: 16px; color: var(--fg-3); }

    .costs-later { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .costs-later li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; align-items: start; font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-later li b { color: var(--fg); }
    .costs-later-ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-3); }
    .costs-later-ic svg { width: 16px; height: 16px; }

    .costs-nowrap { white-space: nowrap; }
    @media (max-width: 960px) {
      .segmented.costs-runs-filter { display: flex; width: 100%; }
      .segmented.costs-runs-filter button { flex: 1 1 auto; padding: 6px 6px; min-width: 40px; }
    }
    .costs-sub { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .costs-task { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 500; }
    .costs-table .table td { white-space: nowrap; }
    .costs-table .table td:nth-child(2) { white-space: normal; min-width: 180px; }
    .costs-table .table-wrap { position: relative; }
    .costs-table .table tr.is-error td { color: var(--fg-3); }
    @media (max-width: 1180px) {
      .costs-table .table th:nth-child(7), .costs-table .table td:nth-child(7),
      .costs-table .table th:nth-child(9), .costs-table .table td:nth-child(9) { display: none; }
    }
    .costs-table tbody tr:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
    .costs-runlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .costs-runlist li + li { border-top: 1px solid var(--line); }
    .costs-run { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; width: 100%; padding: 12px; margin: 0; text-align: left; background: none; border: 0; cursor: pointer; color: var(--fg); align-items: start; font: inherit; }
    .costs-run:hover { background: var(--surface-2); }
    .costs-run-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .costs-run-meta { font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-run-cost { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .costs-run-cost small { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--fg-3); }

    .costs-settings-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px 36px; }
    @media (max-width: 1080px) { .costs-settings-grid { grid-template-columns: minmax(0, 1fr); } }
    .costs-settings-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .costs-ver .table th, .costs-ver .table td { padding-left: 10px; padding-right: 10px; }
    .costs-ver .table th:first-child, .costs-ver .table td:first-child { padding-left: 0; }
    .costs-ver .table th:last-child, .costs-ver .table td:last-child { padding-right: 0; }
    .costs-ver .table td { white-space: nowrap; }
    .costs-ver .table td:first-child { white-space: normal; }
    .costs-ver-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; min-width: 0; }
    .costs-tablebox { border: 1px solid var(--line); border-radius: var(--r-md); }
    .costs-tablebox .table th, .costs-tablebox .table td { padding: 9px 8px; }
    .costs-tablebox .table th:first-child, .costs-tablebox .table td:first-child { padding-left: 12px; }
    .costs-tablebox .table th:last-child, .costs-tablebox .table td:last-child { padding-right: 12px; }
    .costs-tablebox .table td { white-space: nowrap; }

    .costs-split { display: flex; height: 14px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--surface); }
    .costs-split i { display: block; min-width: 3px; }
    .costs-formula { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); background: var(--surface-2); border-radius: var(--r-sm); padding: 10px 12px; line-height: 1.6; overflow-wrap: break-word; }
    .costs-modal-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .costs-price-model b { display: block; }
    .costs-price-model .mono { font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .costs-mlist li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: center; }
    .costs-mlist li:first-child { border-top: 0; padding-top: 2px; }
    .costs-mlist .t { font-weight: 500; min-width: 0; }
    .costs-mlist .s { grid-column: 1 / 2; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .costs-mlist .v { grid-row: 1 / 3; grid-column: 2; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .kv.costs-detail { grid-template-columns: 150px minmax(0, 1fr); }
    .kv.costs-detail dd { text-align: left; }
    @media (max-width: 720px) {
      .kv.costs-detail { grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .kv.costs-detail dt { font-size: var(--fs-xs); color: var(--fg-3); }
      .kv.costs-detail dd { text-align: left; margin-bottom: 8px; }
    }
  `);

  // ---------- мелкие элементы ----------
  const modelChip = m => chip(m, 'outline');
  const effortChip = e => (e ? chip('effort ' + e, 'outline') : null);
  const howto = text => h('div', { class: 'costs-howto' }, icon('info'), h('span', null, text));
  // Список для телефона вместо широкой таблицы: [{title, sub, value}]
  const mlist = items => h('ul', { class: 'costs-mlist' }, items.map(it => h('li', null, h('span', { class: 't' }, it.title), it.sub ? h('span', { class: 's' }, it.sub) : null, it.value != null ? h('span', { class: 'v' }, it.value) : null)));
  const budgetKind = share => share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : 'good';
  const anLink = (id, close) => h('a', { href: analysisHref(id), on: close ? { click: close } : { click: e => e.stopPropagation() } }, '#' + id);

  // ---------- окно: разбор цены вызова ----------
  function payer(r) {
    if (isShared(r)) return 'Ключ администратора — общая фоновая задача без участника, в лимиты участников не входит';
    if (V.admin) return 'Ваш ключ (ключ администратора) — ваш вызов, входит в бюджет ключа';
    if (V.own) {
      const since = V.me.ownKey && V.me.ownKey.verified;
      return since && r.at < since ? 'Ключ администратора — вызов до вашего перехода на свой ключ' : 'Ваш ключ — с вашего счета Anthropic';
    }
    return 'Ключ администратора — входит в ваш лимит (' + usdL(V.limit.monthly) + ' в месяц)';
  }
  const CACHE_WHAT = {
    analysis: 'Общий префикс: инструкции и стратегия. Его пишет в кэш первый матч анализа, следующие матчи читают — у Opus 5.5 чтение в 20 раз дешевле обычного входа',
    news: 'Инструкции шага новостей. Результаты поиска сервер сам пишет в кэш на продолжениях ответа — поэтому у новостей велика запись в кэш',
    parse: 'Не кэшируется: текст разбирается одним коротким вызовом, повторного чтения нет',
    postmortem: 'Не кэшируется: разборы идут пакетом Batch раз в час, скидка Batch −50% к входу и выходу',
  };
  function runModal(r) {
    const t = typeOf(r.type), p = PRICE[r.model] || PRICE['Opus 5.5'];
    const x = partsOf(r);
    const parts = [
      { name: 'Чтение из кэша', tokens: x.read, price: p.cache, cost: x.read * p.cache / 1e6, color: 'var(--s1)' },
      { name: 'Запись в кэш', tokens: x.written, price: p.write, cost: x.written * p.write / 1e6, color: 'var(--s5)' },
      { name: 'Новый вход', tokens: x.fresh, price: p.in, cost: x.fresh * p.in / 1e6, color: 'var(--s2)' },
      { name: 'Выход (с размышлениями)', tokens: r.output, price: p.out, cost: r.output * p.out / 1e6, color: 'var(--s3)' },
      { name: 'Веб-поиски', tokens: null, n: r.searches, cost: r.searches * SEARCH, color: 'var(--s4)' },
    ];
    if (r.batch) parts.forEach(z => { if (z.tokens != null) { z.cost /= 2; z.price /= 2; } });
    const total = sum(parts, z => z.cost);
    const shown = parts.filter(z => z.cost > 0);
    const n = v => nf(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9 ? 2 : 3).format(v);
    const formula = '(' + fmt.int(x.read) + ' × ' + n(p.cache) + ' + ' + fmt.int(x.written) + ' × ' + n(p.write) + ' + ' + fmt.int(x.fresh) + ' × ' + n(p.in) + ' + ' + fmt.int(r.output) + ' × ' + n(p.out) + ') / 1\u00a0000\u00a0000'
      + (r.searches ? ' + ' + r.searches + ' × 0,01' : '') + ' = ' + usdRun(total);
    const m = matchOf(r);
    UI.modal({
      title: t.short + ' · ' + fmt.datetime(r.at),
      wide: true,
      body: close => [
        h('div', { class: 'costs-modal-chips' }, modelChip(r.model), effortChip(r.effort), r.duration ? chip(fmt.duration(r.duration), null, 'clock') : null,
          isErr(r) ? chip('Ошибка', 'bad', 'x') : r.cached ? chip(pct(r.cached / r.input) + ' входа из кэша', 'good', 'database') : chip('Без чтения кэша', null, 'database'),
          r.tag ? chip(r.tag, 'info', r.type === 'postmortem' ? 'search' : 'flask') : null, r.batch ? chip('Batch · ответ через ' + Math.round((r.batchWait || 1800) / 60) + ' мин', null, 'clock') : null),
        isErr(r) ? UI.callout('bad', 'alert', h('b', null, 'Вызов не прошел: '), r.error + '. Неудачный вызов Anthropic не оплачивается; анализ можно перезапустить с этого шага — выполненные шаги повторно не оплачиваются.') : null,
        h('div', { class: 'row-between', style: 'align-items:flex-end' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Цена вызова'), h('div', { class: 'stat-value' }, usdRun(r.cost)))),
        total > 0 ? h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'costs-split', role: 'img', 'aria-label': 'Из чего сложилась цена: ' + shown.map(z => z.name + ' ' + usd(z.cost, 4)).join(', ') },
            shown.map(z => h('i', { style: { width: (z.cost / total * 100) + '%', background: z.color }, title: z.name + ': ' + usd(z.cost, 4) }))),
          UI.legend(shown.map(z => ({ name: z.name + ' · ' + pct(z.cost / total), color: z.color, type: 'box' })))) : null,
        total > 0 ? (UI.isMobile() ? mlist(parts.map(z => ({ title: z.name, sub: z.tokens != null ? fmt.int(z.tokens) + ' ток. × ' + '$' + n(z.price) + ' за 1M' : z.n + ' ' + fmt.plural(z.n, 'поиск', 'поиска', 'поисков') + ' × $0,01', value: usd(z.cost, 4) }))) : UI.table({
          columns: [
            { label: 'Статья', render: z => z.name },
            { label: 'Объем', align: 'r', render: z => z.tokens != null ? fmt.int(z.tokens) + ' ток.' : z.n + ' ' + fmt.plural(z.n, 'поиск', 'поиска', 'поисков') },
            { label: 'Цена', align: 'r', render: z => z.tokens != null ? '$' + n(z.price) + ' / 1M' : '$10 / 1000' },
            { label: 'Сумма', align: 'r', render: z => h('b', null, usd(z.cost, 4)) },
          ],
          rows: parts,
        })) : null,
        total > 0 ? h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Формула'), h('div', { class: 'costs-formula' }, formula)) : null,
        h('dl', { class: 'kv costs-detail' }, [
          ['Кто платит', payer(r)],
          [r.type === 'postmortem' ? 'Ставка' : 'Анализ', r.analysis ? [anLink(r.analysis, close), RECENT[r.analysis] ? '' : ' · пример журнала'] : r.bet ? h('a', { href: '#bets-' + r.bet, on: { click: close } }, 'Ставка №' + r.bet) : r.tag || '—'],
          ['Шаг', [stepText(r), m ? ' · ' + m : ''].join('') || '—'],
          ['Что делает', t.what || '—'],
          ['Effort', r.effort ? r.effort + ' — ' + EFFORT_LABEL[r.effort] + ' уровень размышлений' : '—'],
          ['Версия инструкций', h('span', { class: 'mono' }, t.prompt)],
          ['Кэш', CACHE_WHAT[r.type] || '—'],
          ['ID модели', h('span', { class: 'mono' }, p.id)],
        ].map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        howto('Цены — прайс Anthropic за 1M токенов на 1 октября 2026. Запись в кэш на 5 минут — ×1,25 к цене входа.'),
      ],
      actions: close => [
        button('Закрыть', { kind: 'secondary', onClick: close }),
        r.analysis ? button('К анализу #' + r.analysis, { kind: 'primary', iconRight: 'arrowRight', href: analysisHref(r.analysis), attrs: { on: { click: close } } }) : null,
      ],
    });
  }

  // ---------- окно: цены моделей ----------
  function pricesModal() {
    const used = model => TYPES.filter(t => t.model === model).map(t => t.short).join(', ') || 'проверки (eval)';
    UI.modal({
      title: 'Цены моделей',
      wide: true,
      body: [
        h('p', { class: 'soft' }, 'За 1 млн токенов, прайс Anthropic на 1 октября 2026' + (UI.isMobile() ? ' (справа — вход / выход)' : '') + '. В приложении цены берутся из таблицы model_prices, а не зашиты в код; модель без цены не запускается.'),
        UI.isMobile() ? mlist(Object.keys(PRICE).map(m => ({ title: m, sub: h('span', null, h('span', { class: 'mono' }, PRICE[m].id), h('br'), 'чтение кэша ' + usd(PRICE[m].cache) + ' · запись ' + usd(PRICE[m].write, 3) + ' · ' + used(m)), value: usdP(PRICE[m].in) + ' / ' + usdP(PRICE[m].out) }))) : UI.table({
          columns: [
            { label: 'Модель', render: m => h('div', { class: 'costs-price-model' }, h('b', null, m), h('span', { class: 'mono' }, PRICE[m].id)) },
            { label: 'Вход', align: 'r', render: m => usd(PRICE[m].in) },
            { label: 'Запись в кэш', align: 'r', render: m => usd(PRICE[m].write, 3) },
            { label: 'Чтение кэша', align: 'r', render: m => usd(PRICE[m].cache) },
            { label: 'Выход', align: 'r', render: m => usd(PRICE[m].out) },
            { label: 'Задачи', render: m => h('span', { class: 'small soft' }, used(m)) },
          ],
          rows: Object.keys(PRICE),
        }),
        UI.kv([
          ['Веб-поиск', '$10 за 1000 поисков'],
          ['Haiku 5.5', 'весь вход запроса больше 100 тыс. токенов — все цены × 5'],
          ['Batch API', '−50% на токены, поиск не дешевле; у проверок (eval) и разборов ставок, ответ — в течение нескольких часов'],
          ['Старый бот (Sonnet 4.6)', '$3 / $15'],
        ]),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // ---------- блоки экрана ----------
  const CONSOLE_LIMITS = 'https://platform.claude.com/settings/limits';
  const kvCell = (k, v, note) => h('div', null, h('dt', null, k), h('dd', null, v, note ? h('small', null, note) : null));
  const consoleBtn = (kind) => button('Лимит в консоли Anthropic', { kind: kind || 'ghost', size: 'sm', icon: 'shield', iconRight: 'link', href: CONSOLE_LIMITS, attrs: { target: '_blank', rel: 'noopener noreferrer' } });

  function headBlock() {
    const lead = V.admin
      ? 'Ваш ключ оплачивает анализы всех, кто на нем, и общие фоновые задачи. Вверху — бюджет ключа, ниже — ваши вызовы Claude за ' + PERIOD + ': сколько стоит анализ, на какие шаги уходят деньги и что берется из кэша.'
      : V.own
        ? 'Вы на своем ключе: расход идет с вашего счета Anthropic. Ниже — ваши вызовы Claude за ' + PERIOD + ': сколько стоит анализ и что берется из кэша.'
        : 'Анализы идут на ключе администратора: платит он, а у вас — личный лимит. Ниже — ваши вызовы Claude за ' + PERIOD + ': сколько стоит анализ и что берется из кэша.';
    return h('div', { class: 'page-head costs-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Расходы на Claude в ' + MONTHS_IN[M - 1]),
        h('p', { class: 'lead' }, lead)),
      h('div', { class: 'costs-head-actions' },
        button('Цены моделей', { kind: 'secondary', size: 'sm', icon: 'coins', onClick: pricesModal }),
        button('Как настроено', { kind: 'secondary', size: 'sm', icon: 'sliders', onClick: () => scrollToSettings() })));
  }

  // Полоса расхода: потрачено, прогноз на конец месяца и отметка, на которой приходит уведомление
  function budgetBar(spent, limit, forecast, what) {
    const share = spent / limit, fShare = forecast / limit;
    const kind = budgetKind(Math.max(share, fShare > 1 ? 0.95 : 0));
    return h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: ['costs-bar', kind !== 'good' && kind], role: 'meter', 'aria-label': what + ': ' + usd(spent) + ' из ' + usdL(limit) + ', прогноз на месяц ' + usd(forecast), 'aria-valuenow': spent, 'aria-valuemin': 0, 'aria-valuemax': limit },
        h('i', { class: 'proj', style: { width: Math.min(100, fShare * 100) + '%' } }),
        h('i', { class: 'spent', style: { width: Math.min(100, share * 100) + '%' } }),
        h('i', { class: 'tick', style: { left: ALERT + '%' }, title: ALERT + '% — уведомление' })),
      h('div', { class: 'costs-bar-legend' },
        h('span', null, h('i', { class: 'spent' }), 'Потрачено за ' + PERIOD_SHORT),
        h('span', null, h('i', { class: 'proj' }), 'Прогноз на ' + MONTH_END + ' ≈ ' + usd(forecast) + (fShare > 1 ? ' — выше лимита' : '')),
        h('span', null, h('i', { class: 'tick' }), ALERT + '% — уведомление')));
  }

  // Администратор: бюджет ключа администратора — общий расчет DATA.ai.budget(): все, кто тратит ключ, и общие фоновые задачи
  function adminHero() {
    const B = A.budget();
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Бюджет ключа администратора' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Бюджет ключа администратора · ' + D.ai.month),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(B.spent)),
          h('span', { class: 'of' }, 'из ' + usdL(B.monthly)),
          chip(pct(B.share) + ' бюджета', budgetKind(B.share), B.share > 0.7 ? 'alert' : 'check')),
        h('div', { class: 'costs-hero-sub' }, 'Все, кто на вашем ключе, и общие фоновые задачи. Проверки (eval) — отдельно')),
      budgetBar(B.spent, B.monthly, B.forecast, 'Бюджет ключа администратора'),
      h('dl', { class: 'costs-kv' },
        kvCell('Осталось', usd(B.left), 'до ' + MONTH_END),
        kvCell('В день', usd(B.spent / DAYS), 'в среднем'),
        kvCell('Можно в день', usd(B.left / B.daysLeft), 'чтобы уложиться')),
      h('p', { class: 'costs-hero-note' }, 'Прогноз учитывает личные лимиты: дойдя до своего, участник остановится. На ' + ALERT + '% бюджета (' + usdL(B.monthly * ALERT / 100) + ') придет уведомление; когда остатка не хватит на вызов Claude, анализы на ключе администратора остановятся до вашего решения.'),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          button('Лимиты участников', { kind: 'secondary', size: 'sm', icon: 'sliders', href: '#admin-limits' }),
          consoleBtn()),
        h('p', { class: 'costs-hero-note' }, icon('shield'), h('span', null, 'Вторая страховка — лимит трат в консоли Anthropic: он остановит расход по ключу, даже если приложение ошибется.'))));
  }

  // Администратор: кто тратит бюджет — коротко, подробно в «Администрировании».
  // Строки — DATA.ai.keySpent по DATA.ai.keyUsers() плюс общие задачи; их сумма равна «Итого» = DATA.ai.budget().spent.
  // Проверки (eval) — отдельный бюджет на том же ключе (PLAN, раздел 6): строкой под итогом, в итог не входят.
  function adminWhoCard() {
    const B = A.budget(), ks = A.keySpent;
    const spenders = A.keyUsers().filter(u => ks(u) > 0).sort((a, b) => ks(b) - ks(a));
    const top = spenders.slice(0, 3), rest = spenders.slice(3);
    const li = (title, sub, value, cls) => h('li', { class: cls }, h('span', { class: 't' }, title), sub ? h('span', { class: 's' }, sub) : null, h('span', { class: 'v' }, value));
    const userSub = u => {
      if (u.aiMode === 'own') return 'до перехода на свой ключ';
      const L = A.limitOf(u);
      if (!L) return 'без личного лимита';
      const s = ks(u) / L.monthly;
      const txt = 'лимит ' + usdL(L.monthly) + ' · израсходовано ' + pct(s) + (u.status === 'blocked' ? ' · заблокирован' : L.paused ? ' · на паузе' : '');
      return s >= ALERT / 100 || L.paused ? h('span', { class: 'warn-text' }, txt) : txt;
    };
    const rows = top.map(u => li(h('span', { class: 'costs-who-name' }, u.name, u === V.me ? chip('вы', 'outline') : null), userSub(u), usd(ks(u))));
    if (rest.length) rows.push(li('Еще ' + rest.length + ' ' + fmt.plural(rest.length, 'человек', 'человека', 'человек'), 'на ключе администратора', usd(sum(rest, ks))));
    rows.push(li('Общие фоновые задачи', 'вызовы без участника: разборы ставок (Sonnet 5.5, Batch, ≈ $0,01 за матч) и приемка этапа', usd(B.shared)));
    rows.push(li('Итого', null, usd(B.spent), 'total'));
    rows.push(li('Проверки качества (eval)', 'отдельный бюджет ' + usdL(EVAL.monthly) + (EVAL.firstMonth ? ' в первый месяц, с ноября ' + usdL(EVAL.next) : '') + ' на вашем ключе, в итог не входят', usd(EVAL.spent) + ' из ' + usdL(EVAL.monthly), 'aside'));
    const people = D.users.filter(u => u.status !== 'deleted');
    const onOwn = people.filter(u => u.aiMode === 'own');
    const back = people.filter(u => u.aiMode !== 'own' && A.ownSpent(u) > 0);
    const notes = [];
    if (onOwn.length) notes.push(onOwn.map(u => u.name).join(', ') + (onOwn.length > 1 ? ' — на своих ключах: этот расход оплачивают сами участники' : ' — на своем ключе: этот расход оплачивает сам участник') + ', в бюджет он не входит' + (onOwn.some(u => ks(u) > 0) ? '; потраченное до перехода осталось в бюджете.' : '.'));
    back.forEach(u => notes.push(u.name + ' — снова на вашем ключе: ' + usd(A.ownSpent(u)) + ', потраченные на своем ключе, в бюджет не входят.'));
    return card({
      class: 'costs-card costs-side',
      title: 'Кто тратит бюджет',
      subtitle: D.ai.month.charAt(0).toUpperCase() + D.ai.month.slice(1) + ', в долларах. Ставки и банк участников — в «Администрирование → Сводка», только просмотр.',
      body: [
        h('ul', { class: 'costs-mlist costs-who' }, rows),
        notes.length ? howto(notes.join(' ')) : null,
      ],
      foot: [button('Подробно — в Администрировании', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#admin-usage' })],
    });
  }

  const PAUSED = 'Анализы на паузе — решение администратора';

  // Участник на ключе администратора: личный лимит (Р7, Р13) — DATA.ai.limitOf и DATA.ai.keySpent
  function memberHero() {
    const me = V.me, L = V.limit, spent = A.keySpent(me);
    const share = spent / L.monthly, left = Math.max(0, L.monthly - spent);
    const avg = avgAnalysis(), enough = avg && !L.paused ? Math.floor(left / avg) : null;
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Ваш лимит на ключе администратора' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Ваш лимит на ключе администратора · ' + D.ai.month),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(spent)),
          h('span', { class: 'of' }, 'из ' + usdL(L.monthly)),
          chip(pct(share) + ' лимита', budgetKind(share), share > 0.7 ? 'alert' : 'check')),
        h('div', { class: 'costs-hero-sub' }, 'Платит администратор, вы ничего не вводите')),
      L.paused ? UI.callout('warn', 'pause', h('b', null, PAUSED), h('span', null, '. Новые анализы не запускаются, пока администратор не снимет паузу. Ставки и банк работают как обычно.')) : null,
      budgetBar(spent, L.monthly, personalForecast(me, spent), 'Ваш лимит'),
      h('dl', { class: 'costs-kv' },
        kvCell('Осталось', usd(left), 'до ' + MONTH_END),
        kvCell('Сегодня', me.todayAnalyses + ' из ' + L.daily, fmt.plural(L.daily, 'анализ', 'анализа', 'анализов') + ' в день'),
        kvCell('На один анализ', 'до ' + usdL(L.perAnalysis), 'потолок')),
      enough != null ? h('p', { class: 'costs-hero-note' }, icon('info'), h('span', null, 'Остатка хватит примерно на ' + enough + ' ' + fmt.plural(enough, 'анализ', 'анализа', 'анализов') + ' по средней цене ' + usd(avg) + ' (с новостями). ' + (L.daily ? 'Но не больше ' + L.daily + ' в день.' : ''))) : null,
      h('p', { class: 'costs-hero-note' }, icon('globe'), h('span', null, 'Новости перед анализом — часть анализа: они входят в его цену и в ваш лимит. Общие фоновые задачи и проверки качества (eval) оплачивает администратор.')),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          h('span', { class: 'costs-hero-note' }, icon('lock'), h('span', null, 'Лимит меняет администратор.')),
          button('Перейти на свой ключ', { kind: 'secondary', size: 'sm', icon: 'key', iconRight: 'arrowRight', href: '#profile-key' }))));
  }

  // Участник на своем ключе: расход с его счета (DATA.ai.ownSpent); потраченное до перехода — на ключе администратора
  function ownHero() {
    const me = V.me, k = me.ownKey || {};
    const own = A.ownSpent(me), before = A.keySpent(me);
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Свой ключ Claude' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Свой ключ Claude · ' + D.ai.month),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(own)),
          h('span', { class: 'of' }, 'с вашего счета'),
          chip('sk-ant-…' + (k.last4 || '••••'), 'outline', 'key')),
        h('div', { class: 'costs-hero-sub' }, 'Лимит администратора к вам не относится')),
      h('dl', { class: 'costs-kv' },
        before > 0
          ? kvCell('До перехода', usd(before), 'на ключе администратора')
          : kvCell('Прогноз', '≈ ' + usd(personalForecast(me, own)), 'на ' + MONTH_END),
        kvCell('Ключ проверен', k.verified ? fmt.date(k.verified) : '—', k.verified ? k.verified.slice(11, 16) : null),
        kvCell('На один анализ', 'до ' + usdL(V.cap), 'ваш потолок')),
      before > 0 ? h('p', { class: 'costs-hero-note' }, icon('info'), h('span', null, 'Потраченные до перехода ' + usd(before) + ' остались в бюджете ключа администратора. С вашего счета — только то, что после перехода.')) : null,
      h('p', { class: 'costs-hero-note' }, icon('globe'), h('span', null, 'Новости в ваших анализах тоже оплачивает ваш ключ; найденное попадает в общую базу новостей.')),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          consoleBtn('secondary'),
          button('Ключ и потолок в личном кабинете', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#profile-key' }))));
  }

  // Участник: что будет у лимита и что в него не входит
  function memberRulesCard() {
    const L = V.limit, me = V.me;
    const done = doneAn();
    const maxAn = done.length ? Math.max(...done.map(a => a.cost)) : 0;
    const shared = 'Общие фоновые задачи без участника и проверки качества (eval) оплачивает администратор — в ваш ' + (V.own ? 'счет' : 'лимит') + ' они не входят.';
    const items = V.own ? [
      { ic: 'shield', tone: 'info', t: 'Лимит на месяц — в консоли Anthropic', s: 'Ставите сами: так расход точно не выйдет за ваш предел.' },
      { ic: 'coins', tone: 'info', t: 'Не больше ' + usdL(V.cap) + ' за анализ', s: 'Ваш потолок: дороже — анализ остановится без ставки. Меняется в личном кабинете, «Ключ Claude».' },
      { ic: 'layers', tone: '', t: 'Что не входит', s: shared },
      { ic: 'key', tone: '', t: 'Обратно на ключ администратора', s: 'Только с разрешения администратора: просьба уйдет ему из личного кабинета.' },
    ] : [
      L.paused ? { ic: 'pause', tone: 'bad', t: PAUSED, s: 'Пока пауза не снята, новые анализы на ключе администратора не запускаются.' } : null,
      { ic: 'bell', tone: 'warn', t: ALERT + '% — ' + usdL(L.monthly * ALERT / 100), s: 'Уведомление вам и администратору.' },
      { ic: 'pause', tone: 'bad', t: 'Остатка не хватает на вызов Claude', s: 'Анализы на ключе администратора остановятся до его решения — обычно чуть раньше 100%.' },
      { ic: 'calendar', tone: 'info', t: L.daily + ' ' + fmt.plural(L.daily, 'анализ', 'анализа', 'анализов') + ' в день', s: 'Сегодня ' + me.todayAnalyses + ' из ' + L.daily + '. Счетчик обнуляется в полночь по вашему времени.' },
      { ic: 'coins', tone: 'info', t: 'Не больше ' + usdL(L.perAnalysis) + ' за анализ', s: 'Дороже — анализ остановится без ставки. Самый дорогой у вас в ' + MONTHS_IN[M - 1] + ' — ' + usd(maxAn) + '.' },
      { ic: 'layers', tone: '', t: 'Что не входит', s: shared },
    ].filter(Boolean);
    return card({
      class: 'costs-card costs-side',
      title: V.own ? 'Как работает свой ключ' : 'Как работает лимит',
      subtitle: V.own ? 'Расход — с вашего счета Anthropic' : 'Лимит ставит и меняет администратор',
      body: h('ul', { class: 'costs-rules' }, items.map(it => h('li', null,
        h('span', { class: ['costs-rules-ic', it.tone] }, icon(it.ic)),
        h('span', { class: 'costs-rules-body' }, h('b', null, it.t), h('span', null, it.s))))),
    });
  }

  // Заголовок над блоками о собственных вызовах зрителя
  function scopeHead() {
    const nA = AN.length;
    return h('div', { class: 'costs-section' },
      h('h3', null, V.admin ? 'Ваши вызовы и общие фоновые задачи' : 'Ваши вызовы'),
      h('span', { class: 'small soft' }, PERIOD + ' · ' + nA + ' ' + fmt.plural(nA, 'анализ', 'анализа', 'анализов') + ', ' + calls(TOT.runs) + ' · ' + usd(SPENT) + (V.admin ? '' : ' · общие фоновые задачи сюда не входят')));
  }

  function tiles(mobile) {
    const done = doneAn(), avg = avgAnalysis();
    const nAn = done.length + ' ' + fmt.plural(done.length, 'анализ', 'анализа', 'анализов');
    const cls = 'col-3 half-mobile costs-kpi';
    return [
      UI.stat({ class: cls, icon: 'spark', label: 'Цена анализа', value: usd(avg), hint: nAn + ', с новостями', spark: done.map(a => a.cost), sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'database', label: 'Вход из кэша', value: pct(CACHE_SHARE), hint: 'сэкономил ' + usd(cacheSavedWeek), spark: byDay.map(d => { const i = sum(d.runs, r => r.input); return i ? sum(d.runs, r => r.cached) / i : 0; }), sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'layers', label: 'Токенов за месяц', value: fmt.tokens(TOT.input + TOT.output), hint: 'вход ' + fmt.tokens(TOT.input) + ' · выход ' + fmt.tokens(TOT.output), spark: byDay.map(d => d.tokens), sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'globe', label: 'Веб-поисков', value: String(TOT.searches), hint: usd(TOT.searches * SEARCH) + ' · 2 на матч', spark: byDay.map(d => sum(d.runs, r => r.searches)), sparkColor: 'var(--s1)' }),
    ];
  }

  function dailyCard(mobile) {
    // Темп: у участника — под его лимит на ключе администратора, у администратора — под бюджет ключа
    // (DATA.ai.budget()); на своем ключе темпа нет — лимит участник ставит сам в консоли Anthropic
    const B = A.budget();
    const target = V.admin ? B.monthly : V.own ? null : V.limit.monthly;
    const budgetPace = target ? target / MONTH_DAYS : Infinity;
    const items = byDay.map(d => {
      const groups = TYPES.map(t => ({ t, rs: d.runs.filter(r => r.type === t.id) })).filter(g => g.rs.length);
      const today = d.day === D.today;
      return {
        label: fmt.date(d.day), short: fmt.date(d.day), value: d.cost,
        tipTitle: fmt.date(d.day) + ', ' + weekday(d.day) + (today && d.runs.length ? ' · сегодня, до ' + d.runs[d.runs.length - 1].at.slice(11, 16) + ' UTC' : '') + ' · ' + calls(d.runs.length),
        tip: [{ name: 'Всего', value: usd(d.cost, 3) }].concat(groups.map(g => ({ name: g.t.short + (g.rs.length > 1 ? ' ×' + g.rs.length : ''), value: usd(sum(g.rs, r => r.cost), 3) }))),
      };
    });
    const over = byDay.filter(d => d.cost > budgetPace).length;
    const paceText = V.admin
      ? ' Весь ключ администратора тратит в среднем ' + usd(B.spent / DAYS) + ' в день при темпе бюджета ' + usd(budgetPace) + '; из них ваши вызовы и общие задачи — ' + usd(SPENT / DAYS) + '.'
      : target ? (over ? ' Дней выше темпа под лимит: ' + over + '.' : ' Ни один день не превысил темп под лимит.') : '';
    const max = byDay.reduce((a, d) => d.cost > a.cost ? d : a, byDay[0]);
    const maxRuns = TYPES.map(t => ({ t, n: max.runs.filter(r => r.type === t.id).length })).filter(x => x.n);
    const chart = UI.columnChart({ items, height: mobile ? 180 : 210, valueFormat: v => usd(v), labelEvery: 1, seriesName: 'Расход за день', ariaLabel: 'Расходы Claude API по дням UTC, ' + PERIOD });
    return card({
      class: 'costs-card costs-o-1',
      title: 'Расходы по дням',
      subtitle: PERIOD + ', дни по UTC, в долларах' + (V.admin ? '' : ' · ваши вызовы'),
      actions: target ? [chip((V.admin ? 'Темп бюджета ключа — ' : 'Темп под лимит — ') + usd(budgetPace) + ' в день', 'outline')] : null,
      body: [
        UI.withTable(chart, () => h('div', { class: 'costs-tablebox' }, UI.table({
          columns: [
            { label: 'День (UTC)', render: d => fmt.date(d.day) + ', ' + weekday(d.day) },
            { label: 'Вызовов', align: 'r', render: d => d.runs.length },
            { label: 'Токенов', align: 'r', render: d => fmt.tokens(d.tokens) },
            { label: 'Расход', align: 'r', render: d => h('b', null, usd(d.cost, 3)) },
          ],
          rows: byDay,
        }))),
        howto('Как читать: столбец — сумма за день по всем задачам; наведите или нажмите, чтобы увидеть состав. Дни считаем по UTC, как месяц расходов, — поэтому сумма столбцов равна расходу месяца. Дороже всего ' + fmt.date(max.day) + ' (' + usd(max.cost) + '): ' + maxRuns.map(x => x.t.short.toLowerCase() + (x.n > 1 ? ' ×' + x.n : '')).join(', ') + '.' + paceText),
      ],
    });
  }

  function typesCard(onPick) {
    const rows = SCOPE_TYPES.map(t => ({ t, b: BASE[t.id] })).sort((a, b) => b.b.cost - a.b.cost);
    const perMatch = { news: 'на матч', analysis: 'на матч', parse: 'на ввод' };
    return card({
      class: 'costs-card costs-o-2',
      title: 'На что уходят деньги',
      subtitle: 'По шагам анализа, ' + PERIOD + ' · модель и effort каждого шага',
      body: [
        UI.hbars({ items: rows.map(x => ({ label: x.t.bar, value: x.b.cost, note: pctShare(x.b.cost / SPENT), color: 'var(--s1)', dot: false })), valueFormat: usdSum }),
        h('ul', { class: 'costs-types', 'aria-label': 'Шаги: модель, effort, токены, цена вызова' }, rows.map(x => h('li', null,
          h('button', { class: 'costs-type', type: 'button', title: 'Показать вызовы: ' + x.t.short, on: { click: () => onPick(x.t.id) } },
            h('span', { class: 'costs-type-name' }, x.t.short, modelChip(x.t.model), effortChip(x.t.effort)),
            h('span', { class: 'costs-type-meta' }, calls(x.b.n) + ' · ' + x.t.per + ' · в среднем ' + fmt.tokens(x.b.avgIn) + ' вход / ' + fmt.tokens(x.b.avgOut) + ' выход · ' + (x.b.cached ? 'из кэша ' + pct(x.b.cacheShare) : x.b.written ? 'пишет в кэш' : 'без кэша') + (x.b.searches ? ' · ' + x.b.searches + ' ' + fmt.plural(x.b.searches, 'поиск', 'поиска', 'поисков') : '')),
            h('span', { class: 'costs-type-cost' }, h('span', null, h('b', null, usdRun(x.b.avgCost)), h('small', null, perMatch[x.t.id] || 'за вызов')), icon('chevronRight')))))),
        howto('Длина полосы — сумма за ' + PERIOD_SHORT + ', справа — доля в расходах. Новости — самый дорогой вход: результаты поиска пишутся в кэш, а повторно читаются редко; если новостям игрока меньше 12 часов, шаг пропускается. Нажмите на шаг, чтобы увидеть его вызовы.'),
      ],
    });
  }

  // Этап 5: «Где экономим» — меры экономии и их статус. Мера включается, только если на замороженном наборе
  // качество не хуже с допуском (правило экономии TOKEN_ECONOMY 2.4); экономию считает код по логам вызовов
  const LV = () => D.learning.versions;
  function savingsCard() {
    const v4 = LV().find(v => v.id === 'v4'), v3 = LV().find(v => v.id === 'v3');
    const anPart = BASE.analysis ? BASE.analysis.cost : 0;
    const perMonth = x => monthPace(x);
    const v4Save = v4 && v4.cmp ? anPart * Math.abs(v4.cmp.tokens) / 100 : 0;
    const items = [
      { ic: 'layers', t: 'Сжатое досье — инструкции v4', d: v4 && v4.status === 'active' ? 'Включено. Токенов на анализ ' + fmt.signedPct(v4.cmp.tokens, 0) + ', качество не хуже на наборе ' + D.learning.evalSet.code + '.' : 'Токенов на анализ ' + fmt.signedPct(v4 ? v4.cmp.tokens : -31, 0) + ', качество не хуже на наборе ' + D.learning.evalSet.code + ' (ДИ лог-лосса ' + (v4 ? fmt.dec(v4.cmp.dLL[1], 3).replace('-', '−') + '…+' + fmt.dec(v4.cmp.dLL[2], 3) : '') + ').',
        save: '≈ ' + usd(perMonth(v4Save)) + ' в месяц', st: v4 && v4.status === 'active' ? chip('Включено', 'good', 'check') : chip(V.admin ? 'Ждет вашего решения' : 'Ждет решения', 'accent', 'clock'), href: V.admin && v4 && v4.status !== 'active' ? '#learning-compare' : null },
      { ic: 'clock', t: 'Разбор ставки через Batch', d: 'Sonnet 5.5 со скидкой −50%: ответ в течение нескольких часов, а не сразу. Один разбор на матч, общий для всех.', save: '≈ $0,01 вместо $0,02 за матч', st: chip('Включено', 'good', 'check') },
      { ic: 'book', t: 'Урок L-019: без «травм» из соцсетей', d: 'Шаг новостей не ищет неподтвержденные слухи — прогноз не хуже на 11 случаях.', save: '2 поиска на матч, ≈ $0,02', st: chip('Включено', 'good', 'check') },
      { ic: 'flask', t: 'Оценка матча на Sonnet 5.5', d: 'Режим «Сбалансированный» дешевле в ≈ 2 раза, но на наборе еще не проверен.', save: 'проверка ≈ $3 из бюджета проверок', st: chip('Не проверено', 'outline', 'flask') },
      { ic: 'sliders', t: 'Effort low для оценки матча', d: 'Меньше размышлений — короче ответ. Без проверки на наборе не включаем.', save: '—', st: chip('Не проверено', 'outline', 'flask') },
    ];
    return card({
      class: 'costs-card costs-o-3', title: 'Где экономим',
      subtitle: 'Мера включается, только если на замороженном наборе качество не хуже с допуском',
      body: [
        h('ul', { class: 'costs-later' }, items.map(it => h('li', null, h('span', { class: 'costs-later-ic' }, icon(it.ic)),
          h('span', { style: 'min-width:0' }, h('span', { class: 'row', style: 'gap:6px;margin-bottom:2px' }, h('b', null, it.t), it.st), h('span', null, it.d), h('span', { class: 'xsmall muted', style: 'display:block' }, 'Экономия: ' + it.save),
            it.href ? h('a', { class: 'small', href: it.href }, 'Сравнение v3 и v4') : null)))),
        howto('Экономию считает код по логам вызовов за ' + PERIOD_SHORT + ', качество — прогоном на наборе из бюджета проверок. Модель и effort меняются в настройках, а не в коде.'),
      ],
    });
  }
  // «До и после»: та же оценка матча до и после изменения инструкций. Со старым ботом не сравниваем — его логов нет
  function beforeAfterCard() {
    const v4 = LV().find(v => v.id === 'v4'), v3 = LV().find(v => v.id === 'v3');
    if (!v3 || !v4 || !v3.eval || !v4.eval) return null;
    const an = BASE.analysis ? BASE.analysis.avgCost : 0;
    const rows = [
      { k: 'Цена оценки матча', a: usdRun(an), b: '≈ ' + usdRun(an * (1 + v4.cmp.tokens / 100)) },
      { k: 'Токенов на анализ', a: '≈ ' + v3.tokens + ' тыс.', b: '≈ ' + v4.tokens + ' тыс.' },
      { k: 'Лог-лосс на наборе', a: fmt.dec(v3.eval.logloss, 3), b: fmt.dec(v4.eval.logloss, 3) },
      { k: 'Brier на наборе', a: fmt.dec(v3.eval.brier, 3), b: fmt.dec(v4.eval.brier, 3) },
      { k: 'Ошибок формата', a: String(v3.eval.fmtErr), b: String(v4.eval.fmtErr) },
    ];
    return card({
      class: 'costs-card costs-o-5', title: 'До и после', subtitle: 'v3 (сейчас) против v4 (кандидат) на одних и тех же ' + D.learning.evalSet.n + ' матчах',
      body: [
        h('div', { class: 'costs-ver' }, UI.table({ columns: [{ label: 'Показатель', render: r => r.k }, { label: 'До · v3', align: 'r', render: r => r.a }, { label: 'После · v4', align: 'r', render: r => h('b', null, r.b) }], rows })),
        howto('Ниже лог-лосс и Brier — лучше; разница v3 и v4 в пределах шума, зато v4 дешевле. Со старым ботом не сравниваем: его логов цены и качества нет.'),
      ],
    });
  }

  // Цена по версиям инструкций — факт за месяц, качество — прогон на замороженном наборе (этап 5)
  function versionsCard(mobile) {
    const rows = TYPES.filter(t => BASE[t.id] && BASE[t.id].n).map(t => ({ t, b: BASE[t.id] }));
    const v3 = LV().find(v => v.status === 'active');
    const Q = { analysis: v3 && v3.eval ? 'лог-лосс ' + fmt.dec(v3.eval.logloss, 3) : '—', parse: '0 ошибок из 30', news: 'с оценкой матча', postmortem: 'схема: 40 из 40' };
    const quality = r => h('span', { class: 'small' }, Q[r.t.id] || '—');
    const body = mobile
      ? mlist(rows.map(r => ({ title: h('span', { class: 'costs-ver-name' }, h('span', { class: 'mono' }, r.t.prompt), chip('действует', 'good', 'check')), sub: r.t.short + ' · ' + calls(r.b.n) + ' · ' + (Q[r.t.id] || '—'), value: usdRun(r.b.avgCost) })))
      : h('div', { class: 'costs-ver' }, UI.table({
        columns: [
          { label: 'Инструкции', render: r => h('span', { class: 'costs-ver-name' }, h('span', { class: 'mono' }, r.t.prompt), chip('действует', 'good', 'check')) },
          { label: 'Шаг', render: r => r.t.short },
          { label: 'Вызовов', align: 'r', render: r => r.b.n },
          { label: 'Цена вызова', align: 'r', render: r => h('b', null, usdRun(r.b.avgCost)) },
          { label: 'Качество', align: 'r', render: quality },
        ],
        rows,
      }));
    return card({
      class: 'costs-card costs-o-4',
      title: 'Версии инструкций: цена и качество',
      subtitle: 'Цена — факт за ' + PERIOD_SHORT + '. Качество оценки матча — лог-лосс на замороженном наборе ' + D.learning.evalSet.code + ' (' + D.learning.evalSet.n + ' матчей); экономию оцениваем только вместе с ним.',
      body: [
        body,
        howto('Опубликованную версию инструкций не правим, а выпускаем следующую: так цена и качество каждой версии сравнимы. Анализ целиком сейчас стоит в среднем ' + usd(avgAnalysis()) + '.'),
      ],
    });
  }

  function runsCard(mobile, redraw) {
    const hasShared = V.admin && SCOPE_RUNS.some(isShared);
    const filtered = RUNS.filter(r => runFilter === 'all' || (runFilter === 'shared' ? isShared(r) : r.type === runFilter));
    const LIMIT = mobile ? 6 : 10;
    const shown = showAllRuns ? filtered : filtered.slice(0, LIMIT);
    const filter = UI.segmented({
      label: 'Шаг',
      items: [{ id: 'all', label: 'Все' }].concat(SCOPE_TYPES.map(t => ({ id: t.id, label: mobile ? t.tiny : t.short }))).concat(hasShared ? [{ id: 'shared', label: 'Общие' }] : []),
      active: runFilter,
      onChange: id => { runFilter = id; showAllRuns = false; redraw('costs-runs'); },
    });
    filter.classList.add('costs-runs-filter');
    const taskNode = r => h('span', { class: 'costs-task' }, typeOf(r.type).short, r.tag && r.type !== 'postmortem' ? chip('Приемка', 'info', 'flask') : r.batch ? chip('Batch', null, 'clock') : null, isErr(r) ? chip('Ошибка', 'bad', 'x') : null);
    const stepLine = r => [stepText(r), matchOf(r)].filter(Boolean).join(' · ');
    let list;
    if (mobile) {
      list = h('ul', { class: 'costs-runlist' }, shown.map(r => h('li', null,
        h('button', { class: 'costs-run', type: 'button', on: { click: () => runModal(r) } },
          h('span', { class: 'costs-run-main' },
            taskNode(r),
            h('span', { class: 'costs-run-meta' }, fmt.datetime(r.at) + (r.analysis ? ' · #' + r.analysis : '') + ' · ' + r.model + (r.effort ? ', effort ' + r.effort : '')),
            stepLine(r) ? h('span', { class: 'costs-run-meta' }, stepLine(r)) : null,
            isErr(r) ? h('span', { class: 'costs-run-meta' }, r.error) : h('span', { class: 'costs-run-meta' }, 'Вход ' + fmt.tokens(r.input) + (r.cached ? ' (кэш ' + pct(r.cached / r.input) + ')' : '') + ' · выход ' + fmt.tokens(r.output) + (r.searches ? ' · ' + r.searches + ' ' + fmt.plural(r.searches, 'поиск', 'поиска', 'поисков') : ''))),
          h('span', { class: 'costs-run-cost' }, usdRun(r.cost), h('small', null, 'подробнее'))))));
    } else {
      list = h('div', { class: 'costs-table' }, UI.table({
        columns: [
          { label: 'Когда', render: r => fmt.datetime(r.at) },
          { label: 'Вызов', render: r => [taskNode(r), stepLine(r) ? h('div', { class: 'costs-sub', style: 'white-space:normal' }, stepLine(r)) : null] },
          { label: 'Анализ', render: r => r.analysis ? anLink(r.analysis) : h('span', { class: 'muted' }, '—') },
          { label: 'Модель · effort', render: r => [h('div', null, r.model), h('div', { class: 'costs-sub' }, r.effort ? 'effort ' + r.effort : '—')] },
          { label: 'Вход (кэш)', align: 'r', render: r => [h('div', null, fmt.tokens(r.input)), h('div', { class: 'costs-sub' }, r.cached ? 'из кэша ' + pct(r.cached / r.input) : partsOf(r).written ? 'запись в кэш' : isErr(r) ? '—' : 'без кэша')] },
          { label: 'Выход', align: 'r', render: r => fmt.tokens(r.output) },
          { label: 'Поиски', align: 'r', render: r => r.searches ? String(r.searches) : h('span', { class: 'muted' }, '—') },
          { label: 'Цена', align: 'r', render: r => h('b', null, usdRun(r.cost)) },
          { label: h('span', { class: 'sr-only' }, 'Подробнее'), render: () => icon('chevronRight', { width: 16, height: 16, style: 'color:var(--fg-3);display:block' }) },
        ],
        rows: shown,
        onRowClick: runModal,
      }));
      list.querySelectorAll('tbody tr.clickable').forEach((tr, i) => {
        if (isErr(shown[i])) tr.classList.add('is-error');
        tr.setAttribute('aria-label', 'Разбор цены: ' + typeOf(shown[i].type).short + ', ' + fmt.datetime(shown[i].at));
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runModal(shown[i]); } });
      });
    }
    const fCost = sum(filtered, r => r.cost);
    const label = runFilter === 'all' ? 'Всего' : runFilter === 'shared' ? 'Общие задачи' : typeOf(runFilter).short;
    return card({
      id: 'costs-runs',
      class: 'col-12 costs-card',
      title: 'Журнал вызовов',
      subtitle: (V.admin ? 'Каждый вызов Claude API от вашего имени и общие фоновые задачи' : 'Каждый ваш вызов Claude API') + ': шаг анализа, модель и effort, токены, кэш, поиски и цена. Нажмите на строку — откроется разбор цены.',
      actions: mobile ? null : [filter],
      flush: !mobile,
      body: mobile ? [h('div', { style: 'min-width:0' }, filter), list] : list,
      foot: [
        h('span', { class: 'small soft' }, label + ': ' + calls(filtered.length) + ' · ' + usd(fCost, 2) + (shown.length < filtered.length ? ' · показаны последние ' + shown.length : '')),
        filtered.length > LIMIT ? button(showAllRuns ? 'Свернуть' : 'Показать все ' + filtered.length, { kind: 'ghost', size: 'sm', icon: showAllRuns ? 'chevronDown' : 'list', attrs: { style: 'margin-left:auto' }, onClick: () => { showAllRuns = !showAllRuns; redraw('costs-runs'); } }) : null,
        h('span', { class: 'xsmall muted', style: 'flex-basis:100%' }, V.admin
          ? 'Разборы ставок и прогоны приемки — общие фоновые задачи (фильтр «Общие»), в ваш личный расход они не входят. Проверки качества (eval) идут из своего бюджета ' + usdL(EVAL.monthly) + ' и в журнал не попадают — они в «Администрирование → Расход ИИ».'
          : 'Общие фоновые задачи и проверки качества (eval) оплачивает администратор — в журнале их нет, в ваш ' + (V.own ? 'счет' : 'лимит') + ' они не входят.'),
        h('span', { class: 'xsmall muted', style: 'flex-basis:100%' }, 'Журнал — пример за ' + PERIOD_SHORT + '. Анализ #' + (D.currentAnalysis || 'A-0142') + ' с экрана «Анализ» — демонстрационный запуск макета; в приложении его вызовы появятся здесь сразу.'),
      ],
    });
  }

  // Настройки агента — только показ для всех (В12, Р23): их задает команда agent-config на сервере
  function settingsCard() {
    const L = V.limit;
    const per = id => (BASE[id] && BASE[id].n ? ' · ≈ ' + usdRun(BASE[id].avgCost) + ' за вызов' : '');
    const steps = [
      { title: typeOf('parse').short, sub: 'Haiku 5.5 · effort low · только если события вставлены текстом' + per('parse') },
      { title: typeOf('news').short, sub: 'Sonnet 5.5 · effort low · перед анализом, веб-поиск: 2 на матч, по одному на игрока' + per('news') },
      { title: typeOf('analysis').short, sub: 'Opus 5.5 · effort medium · один вызов на матч, до 3 матчей одновременно' + per('analysis') },
    ];
    const on = () => chip('Включено', 'good', 'check');
    const tricks = [
      { title: 'Кэш промпта', sub: 'первый матч анализа пишет общий префикс, следующие читают', value: on() },
      { title: 'Общий кэш новостей 12 ч', sub: 'новости игрока не ищутся заново 12 часов, для всех участников', value: on() },
      { title: 'Сжатое досье', sub: 'одно досье матча из базы вместо чтения файлов', value: on() },
      { title: 'Ответ JSON по схеме', sub: 'вероятности и факторы полями, без длинного текста', value: on() },
    ];
    const limits = [
      { title: 'Веб-поиски', sub: 'на матч / на анализ / в день на всю программу', value: '2 / 6 / 30' },
      { title: 'Новости за последние', value: '14 дней' },
      { title: 'Повтор оценки Claude без затрат', sub: 'если досье матча не изменилось', value: '6 ч' },
    ];
    if (V.own) limits.push({ title: 'Потолок на один анализ', sub: 'задаете сами в личном кабинете', value: usdL(V.cap) });
    else if (!V.admin) limits.push({ title: 'Ваш лимит', sub: 'в месяц · анализов в день · потолок на анализ', value: usdL(L.monthly) + ' · ' + L.daily + ' · ' + usdL(L.perAnalysis) });
    else limits.push({ title: 'Предупреждение о цене анализа', sub: 'мягкий порог; жесткий потолок программы — ' + usdL(1), value: 'от ' + usd(0.5) });
    return card({
      id: 'costs-settings',
      class: 'costs-card',
      title: 'Как настроено',
      subtitle: 'Модель, effort и лимиты каждого шага — одинаково для всех. Режим анализа пока один — «Точный» (Opus 5.5).',
      body: [
        h('div', { class: 'costs-settings-grid' },
          h('div', { class: 'costs-settings-col' }, h('div', { class: 'eyebrow' }, 'Шаги анализа'), mlist(steps),
            h('div', { class: 'eyebrow', style: 'margin-top:6px' }, 'Лимиты'), mlist(limits)),
          h('div', { class: 'costs-settings-col' }, h('div', { class: 'eyebrow' }, 'Приемы экономии — встроены'), mlist(tricks),
            howto('Новости ищем только на atptour.com, сайтах турниров Большого шлема, tennis.com, tennismajors.com и espn.com.'))),
        UI.callout('info', 'lock', V.admin
          ? ['Здесь настройки только показываются. Меняются они командой на сервере ', h('span', { class: 'mono' }, 'bash deploy/local.sh cli agent-config'), ' — с записью в журнал действий. Смена модели или effort из интерфейса — после проверки на eval-наборе (этап 5).']
          : 'Настройки общие для всех, их задает администратор. ' + (V.own ? 'Платите вы сами, но модели и лимиты поиска — общие.' : 'Свой ключ снимает лимит администратора: расход пойдет с вашего счета Anthropic.')),
      ],
    });
  }

  // ---------- навигация внутри экрана ----------
  function scrollToSettings() {
    const el = document.getElementById('costs-settings');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ---------- экран ----------
  UI.register('costs', {
    title: 'ИИ и расходы',
    crumbs: 'Модель · Claude API',
    render(root) {
      const mobile = UI.isMobile();
      // Перерисовка без потери позиции прокрутки; anchor — id блока, который нужно удержать на месте
      function redraw(anchor) {
        const a = anchor && document.getElementById(anchor);
        const top = a ? a.getBoundingClientRect().top : null;
        const y = window.scrollY;
        UI.clear(root);
        build();
        const b = anchor && document.getElementById(anchor);
        if (b && top != null) window.scrollTo(0, window.scrollY + b.getBoundingClientRect().top - top);
        else window.scrollTo(0, y);
      }
      function pickType(id) {
        runFilter = id; showAllRuns = false;
        redraw();
        const el = document.getElementById('costs-runs');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      function build() {
        setScope(); // роль и данные текущего пользователя читаем при каждой отрисовке
        const hero = V.admin ? adminHero() : V.own ? ownHero() : memberHero();
        const side = V.admin ? adminWhoCard() : memberRulesCard();
        UI.append(root, [
          headBlock(),
          h('div', { class: 'grid costs-top' },
            h('div', { class: 'col-7', style: 'min-width:0' }, hero),
            h('div', { class: 'col-5', style: 'min-width:0' }, side)),
          scopeHead(),
          h('div', { class: 'grid costs-tiles' }, tiles(mobile)),
          h('div', { class: 'costs-main' },
            h('div', { class: 'costs-col' }, dailyCard(mobile), versionsCard(mobile)),
            h('div', { class: 'costs-col' }, typesCard(pickType), savingsCard(), beforeAfterCard())),
          h('div', { class: 'grid' }, runsCard(mobile, redraw)),
          settingsCard(),
        ]);
      }
      build();
    },
  });
})();
