/* Аналитика: прибыльность по срезам (покрытия, рынки, кэфы), калибровка, Brier против рынка, CLV, выводы модели.
   Фильтры сверху пересчитывают все блоки из DATA.allLegs / DATA.bets теми же формулами, что и data.js,
   поэтому без фильтров цифры совпадают с DATA.stats и с главной. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, TODAY = DATA.today;

  // ---------- утилиты ----------
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const signedDec = (n, d) => (n > 0 ? '+' : '') + fmt.dec(n, d);
  const trendOf = n => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  const nEv = n => n + ' ' + fmt.plural(n, 'событие', 'события', 'событий');
  const nBets = n => n + ' ' + fmt.plural(n, 'ставка', 'ставки', 'ставок');
  const onEv = n => n + ' ' + fmt.plural(n, 'событии', 'событиях', 'событиях');
  const onBets = n => n + ' ' + fmt.plural(n, 'ставке', 'ставках', 'ставках');
  const pctRange = (lo, hi) => Math.round(lo * 100) + '–' + Math.round(hi * 100) + '%';
  const firstDate = D.bankHistory[0].date;
  // Считаются при каждой отрисовке: ставка, рассчитанная на экране «Ставки», сразу попадает в выборку
  const settled = () => D.bets.filter(b => b.status !== 'open');
  const openN = () => D.bets.filter(b => b.status === 'open').length;
  const SMALL = 20; // меньше — помечаем «мало данных»

  const PERIODS = [
    { id: '30', label: '30 дней', days: 30, ctx: 'за 30 дней', prev: 'к пред. 30 дням' },
    { id: '90', label: '3 месяца', days: 90, ctx: 'за 3 месяца', prev: 'к пред. 3 месяцам' },
    { id: 'all', label: 'Все время', days: null, ctx: 'за все время', prev: null },
  ];
  const MARKET_SHORT = { p1: 'победа игрока 1', p2: 'победа игрока 2', h1m: 'игрок 1 — 2:0 по сетам', h2p: 'игрок 2 — хотя бы сет', h1p: 'игрок 1 — хотя бы сет' };
  const MARKETS = D.markets.filter(m => D.allLegs.some(l => l.market === m.id));
  const mLabel = id => (D.markets.find(m => m.id === id) || { label: id }).label;
  const SURF_KEYS = Object.keys(D.surfaces);

  // ---------- состояние фильтров (живет между перерисовками) ----------
  const DEFAULTS = { period: 'all', market: 'all', surface: 'all' };
  const state = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(sessionStorage.getItem('capper.analytics') || 'null');
    if (saved) {
      if (PERIODS.some(p => p.id === saved.period)) state.period = saved.period;
      if (saved.market === 'all' || MARKETS.some(m => m.id === saved.market)) state.market = saved.market;
      if (saved.surface === 'all' || SURF_KEYS.includes(saved.surface)) state.surface = saved.surface;
    }
  } catch (e) { /* хранилище недоступно — работаем в памяти */ }
  const save = () => { try { sessionStorage.setItem('capper.analytics', JSON.stringify(state)); } catch (e) { /* ок */ } };
  const isDefault = () => state.period === DEFAULTS.period && state.market === 'all' && state.surface === 'all';
  const ui = { hypotheses: {}, deep: false };

  // ---------- расчеты (формулы как в data.js) ----------
  const won = l => (l.result === 'win' ? 1 : 0);
  const marketQ = l => Math.min(0.97, 1 / l.closing * 0.955); // вероятность рынка по закрытию без маржи
  const legClv = l => (l.odds / l.closing - 1) * 100;

  function brier(legs) {
    if (!legs.length) return { model: null, market: null, n: 0 };
    return { model: sum(legs, l => (l.p - won(l)) ** 2) / legs.length, market: sum(legs, l => (marketQ(l) - won(l)) ** 2) / legs.length, n: legs.length };
  }
  function summarize(bets) {
    const wins = bets.filter(b => b.status === 'win').length;
    const losses = bets.filter(b => b.status === 'loss').length;
    const voids = bets.filter(b => b.status === 'void').length;
    const turnover = sum(bets, b => b.stake), profit = sum(bets, b => b.profit);
    const withClv = bets.filter(b => b.clv != null); // без закрывающего кэфа CLV не посчитать — такие ставки не входят в среднее
    return {
      n: bets.length, wins, losses, voids, turnover, profit,
      singles: bets.filter(b => b.legs.length === 1).length,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: withClv.length ? sum(withClv, b => b.clv) / withClv.length : null,
      clvPos: withClv.filter(b => b.clv > 0).length,
      clvN: withClv.length,
    };
  }
  // ROI по срезу: каждое событие — как ординар на равную сумму
  function groupLegs(legs, keyFn, labelFn) {
    const g = {};
    legs.forEach(l => { const k = keyFn(l); (g[k] = g[k] || []).push(l); });
    return Object.entries(g).map(([k, ls]) => ({
      key: k, label: labelFn ? labelFn(k) : k, n: ls.length,
      roi: Math.round(sum(ls, l => (won(l) ? l.odds - 1 : -1)) / ls.length * 1000) / 10,
      winrate: Math.round(ls.filter(won).length / ls.length * 1000) / 10,
      avgOdds: sum(ls, l => l.odds) / ls.length,
      clv: sum(ls, legClv) / ls.length,
    }));
  }
  const oddsBucket = o => (o < 1.3 ? '1.13–1.29' : o < 1.5 ? '1.30–1.49' : o < 1.65 ? '1.50–1.64' : '1.65–1.80');
  const totalBucket = k => (k < 1.71 ? '1.28–1.70' : k < 2.21 ? '1.71–2.20' : '2.21–3.24');
  function groupTotals(bets) {
    const g = {};
    bets.forEach(b => { const k = totalBucket(b.total); (g[k] = g[k] || []).push(b); });
    return Object.entries(g).map(([k, bs]) => {
      const st = sum(bs, b => b.stake), pr = sum(bs, b => b.profit);
      return { key: k, label: k, n: bs.length, stake: st, profit: pr, roi: st ? Math.round(pr / st * 1000) / 10 : 0 };
    }).sort((a, b) => a.key.localeCompare(b.key));
  }
  function calibration(legs) {
    const out = [];
    for (let lo = 0.5; lo < 0.95; lo += 0.05) {
      const hi = lo + 0.05;
      const bin = legs.filter(l => l.p >= lo && l.p < hi);
      if (!bin.length) continue;
      out.push({ lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100, p: sum(bin, l => l.p) / bin.length, actual: bin.filter(won).length / bin.length, n: bin.length });
    }
    return out;
  }
  function rolling(legs) {
    const out = [];
    for (let i = 29; i < legs.length; i += 3) {
      const w = legs.slice(i - 29, i + 1);
      out.push({ date: w[w.length - 1].date, model: sum(w, l => (l.p - won(l)) ** 2) / 30, market: sum(w, l => (marketQ(l) - won(l)) ** 2) / 30 });
    }
    return out;
  }
  function bankAt(d) { let v = D.bankHistory[0].bank; for (const p of D.bankHistory) { if (p.date <= d) v = p.bank; else break; } return v; }

  function compute() {
    const p = PERIODS.find(x => x.id === state.period) || PERIODS[2];
    const anchor = p.days ? addDays(TODAY, -p.days) : firstDate; // начало периода (не включительно)
    const legOk = (l, from, to, ignore) => l.date > from && l.date <= to
      && (ignore === 'market' || state.market === 'all' || l.market === state.market)
      && (ignore === 'surface' || state.surface === 'all' || l.surface === state.surface);
    const betOk = (b, from, to) => b.date > from && b.date <= to
      && (state.surface === 'all' || b.surface === state.surface)
      && (state.market === 'all' || b.legs.some(l => l.market === state.market));
    const legs = D.allLegs.filter(l => legOk(l, anchor, TODAY));
    const SETTLED = settled();
    const bets = SETTLED.filter(b => betOk(b, anchor, TODAY));
    let prev = null;
    if (p.days) {
      const pa = addDays(anchor, -p.days);
      if (pa >= firstDate) prev = summarize(SETTLED.filter(b => betOk(b, pa, anchor)));
    }
    return {
      p, anchor, legs, bets, prev,
      // Разрез по измерению не сужается фильтром этого же измерения — выбранное значение подсвечивается
      legsAllMarkets: D.allLegs.filter(l => legOk(l, anchor, TODAY, 'market')),
      legsAllSurfaces: D.allLegs.filter(l => legOk(l, anchor, TODAY, 'surface')),
      sum: summarize(bets), brier: brier(legs),
      filtered: state.market !== 'all' || state.surface !== 'all',
    };
  }

  // ---------- стили экрана ----------
  UI.css('analytics', `
    .analytics-head h2 { font-size: var(--fs-2xl); }
    .analytics-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }

    .analytics-filters { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 12px 16px; padding: 14px 16px; background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); }
    .analytics-filters [hidden] { display: none !important; }
    .analytics-filter { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .analytics-filter-label { font-size: var(--fs-sm); font-weight: 500; color: var(--fg-2); }
    .analytics-filters .field { width: 200px; }
    .analytics-filters .select { height: 38px; }
    @media (max-width: 720px) { .analytics-filters .select { height: 42px; } }
    .analytics-filter-reset { align-self: flex-end; }
    .analytics-scope { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding-top: 12px; border-top: 1px solid var(--line); font-size: var(--fs-sm); color: var(--fg-2); min-width: 0; }
    .analytics-scope b { color: var(--fg); font-weight: 600; }
    .analytics-chip-btn { cursor: pointer; font: inherit; font-size: var(--fs-xs); font-weight: 600; }
    .analytics-chip-btn:hover { box-shadow: inset 0 0 0 1px var(--accent); }
    @media (max-width: 720px) {
      .analytics-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px; gap: 12px; }
      .analytics-filter-period { grid-column: 1 / -1; }
      .analytics-filter-period .segmented { display: flex; width: 100%; }
      .analytics-filter-period .segmented button { flex: 1 1 0; padding: 6px 4px; }
      .analytics-filters .field { width: auto; }
      .analytics-filter-reset { grid-column: 1 / -1; justify-self: start; }
      .analytics-scope { grid-column: 1 / -1; padding-top: 10px; }
    }

    .analytics-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 16px; }
    .analytics-kpis > .card { height: 100%; }
    .analytics-kpis .stat { padding: 14px 16px; }
    .analytics-kpis .stat-value { font-size: 1.5rem; white-space: nowrap; }
    .analytics-kpis .stat-value small { font-size: var(--fs-md); color: var(--fg-3); font-weight: 500; letter-spacing: 0; }
    .analytics-kpis .stat-foot { min-height: 0; }
    @media (max-width: 1280px) { .analytics-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 720px) {
      .analytics-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .analytics-kpis .stat { padding: 12px 14px; }
      .analytics-kpis .stat-value { font-size: var(--fs-xl); }
    }

    .analytics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    @media (max-width: 1180px) { .analytics-grid { grid-template-columns: minmax(0, 1fr); } }
    @media (max-width: 720px) { .analytics-grid { gap: 12px; } }
    .analytics-card .card-body { flex: 1 1 auto; }
    .analytics-card .card-head > div:first-child { flex: 1 1 220px; }

    .analytics-section { display: flex; align-items: flex-end; justify-content: space-between; gap: 4px 16px; flex-wrap: wrap; margin-top: 8px; min-width: 0; }
    .analytics-section h3 { font-size: var(--fs-lg); }
    .analytics-section p { font-size: var(--fs-sm); color: var(--fg-3); max-width: 70ch; margin-top: 2px; }

    .analytics-howto { margin-top: auto; font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; line-height: 1.45; }
    .analytics-howto svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
    .analytics-howto b { color: var(--fg-2); font-weight: 600; }
    .analytics-foot-note { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; line-height: 1.45; }
    .analytics-foot-note > span { min-width: 0; }
    .analytics-foot-note svg { width: 13px; height: 13px; flex: none; margin-top: 2px; color: var(--warn-ink); }
    .analytics-small { display: inline-flex; color: var(--warn-ink); flex: none; }
    .analytics-small svg { width: 13px; height: 13px; }

    .analytics-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .analytics-strip > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .analytics-strip dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .analytics-strip dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .analytics-strip dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    @media (max-width: 720px) { .analytics-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

    /* выводы модели */
    .analytics-ins-card { container-type: inline-size; }
    .analytics-ins { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .analytics-ins > li { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
    .analytics-ins > li:first-child { border-top: 0; padding-top: 2px; }
    .analytics-ins > li:last-child { padding-bottom: 0; }
    .analytics-ins-ic { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .analytics-ins-ic svg { width: 18px; height: 18px; }
    .analytics-ins-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .analytics-ins-ic.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .analytics-ins-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .analytics-ins-ic.accent { background: var(--accent-soft); color: var(--accent-ink); }
    .analytics-ins-ic.good { background: var(--good-soft); color: var(--good-ink); }
    .analytics-ins-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .analytics-ins-title { font-weight: 600; line-height: 1.3; }
    .analytics-ins-text { font-size: var(--fs-sm); color: var(--fg-2); }
    .analytics-ins-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 6px; }
    @container (min-width: 640px) {
      .analytics-ins { display: grid; grid-template-columns: repeat(var(--ins-n, 3), minmax(0, 1fr)); gap: 12px; }
      .analytics-ins > li, .analytics-ins > li:first-child, .analytics-ins > li:last-child { border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px; grid-template-columns: minmax(0, 1fr); grid-template-rows: auto 1fr; }
      .analytics-ins-foot { margin-top: auto; padding-top: 6px; }
    }

    /* сводка по рынкам */
    .analytics-mkt-card { container-type: inline-size; }
    .analytics-mtable .table td { cursor: pointer; }
    .analytics-mtable tr.is-active td { background: var(--accent-soft); }
    .analytics-mtable tr.is-total td { font-weight: 600; background: var(--surface-2); }
    .analytics-mname { font-weight: 600; white-space: nowrap; }
    .analytics-mdesc { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .analytics-mlist { list-style: none; margin: 0; padding: 0; display: none; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .analytics-mlist > li + li { border-top: 1px solid var(--line); }
    .analytics-mrow { width: 100%; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; padding: 10px 12px; background: var(--surface); border: 0; text-align: left; cursor: pointer; color: var(--fg); }
    .analytics-mrow:hover { background: var(--surface-2); }
    .analytics-mrow[aria-pressed="true"] { background: var(--accent-soft); }
    .analytics-mrow > span { min-width: 0; }
    .analytics-mrow-val { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .analytics-mrow-sub { font-size: var(--fs-xs); color: var(--fg-3); font-weight: 400; }
    @container (max-width: 500px) {
      .analytics-mtable { display: none; }
      .analytics-mlist { display: flex; }
    }

    .analytics-scroll { max-height: 300px; overflow-y: auto; border: 1px solid var(--line); border-radius: var(--r-md); }
    .analytics-scroll .table th { position: sticky; top: 0; background: var(--surface); }
    .analytics-tablebox { border: 1px solid var(--line); border-radius: var(--r-md); }
    /* компактные таблицы внутри карточек: без прокрутки вбок даже в узкой колонке */
    .analytics-tablebox .table th, .analytics-tablebox .table td, .analytics-scroll .table th, .analytics-scroll .table td { padding: 9px 8px; }
    .analytics-tablebox .table th, .analytics-scroll .table th { white-space: normal; letter-spacing: .03em; vertical-align: bottom; }
    .analytics-tablebox .table th:first-child, .analytics-tablebox .table td:first-child, .analytics-scroll .table th:first-child, .analytics-scroll .table td:first-child { padding-left: 14px; }
    .analytics-tablebox .table th:last-child, .analytics-tablebox .table td:last-child, .analytics-scroll .table th:last-child, .analytics-scroll .table td:last-child { padding-right: 14px; }
    @media (max-width: 720px) {
      .analytics-tablebox .table th, .analytics-tablebox .table td, .analytics-scroll .table th, .analytics-scroll .table td { padding: 9px 7px; }
      .analytics-tablebox .table th:first-child, .analytics-tablebox .table td:first-child, .analytics-scroll .table th:first-child, .analytics-scroll .table td:first-child { padding-left: 12px; }
      .analytics-tablebox .table th:last-child, .analytics-tablebox .table td:last-child, .analytics-scroll .table th:last-child, .analytics-scroll .table td:last-child { padding-right: 12px; }
    }
    .analytics-empty { display: flex; flex-direction: column; align-items: center; text-align: center; gap: 10px; padding: 40px 20px; }
    .analytics-empty-ic { width: 48px; height: 48px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-3); }
    .analytics-nowrap { white-space: nowrap; }
    .analytics-empty-ic svg { width: 24px; height: 24px; }
    .analytics-empty p { max-width: 52ch; color: var(--fg-2); font-size: var(--fs-sm); }
    .analytics-check { display: flex; flex-direction: column; gap: 10px; }
  `);

  // ---------- мелкие блоки ----------
  const howto = (...content) => h('div', { class: 'analytics-howto' }, icon('info'), h('span', null, content));
  const smallMark = () => h('span', { class: 'analytics-small', title: 'Меньше ' + SMALL + ' событий — ROI может быть случайным' }, icon('alert'), h('span', { class: 'sr-only' }, 'мало данных'));
  const footNote = text => h('div', { class: 'analytics-foot-note' }, icon('alert'), h('span', null, text));
  const smallNote = () => footNote('меньше ' + SMALL + ' событий — ROI может быть случайным');
  const nowrap = t => h('span', { class: 'analytics-nowrap' }, t);
  const deltaPP = d => { const r = Math.round(d * 10) / 10; return (r === 0 ? '0,0' : signedDec(r, 1)) + ' п.п.'; };
  const hover = () => (UI.isMobile() ? 'Коснитесь' : 'Наведите на');
  // Таблица с колонками hideMobile, которые на телефоне скрываются, чтобы не было прокрутки вбок
  const mtable = o => UI.table(Object.assign({}, o, { columns: UI.isMobile() ? o.columns.filter(c => !c.hideMobile) : o.columns }));
  const tableBox = node => h('div', { class: 'analytics-tablebox' }, node);
  const roiCls = v => (v > 0 ? 'good-text' : v < 0 ? 'bad-text' : null);
  const roiText = v => h('span', { class: roiCls(v), style: 'font-weight:600;white-space:nowrap' }, fmt.signedPct(v));

  // Подписи оси X у UI.lineChart: первая прижата к левому краю, а шаг рассчитан на центрированные подписи,
  // поэтому в узкой колонке первые две слипаются. После каждой отрисовки убираем подписи, которые налезают
  // на соседнюю (по реальной ширине шрифта); первая и последняя остаются.
  function declutterX(chart) {
    const fix = () => {
      const svg = chart.querySelector('svg');
      if (!svg || !svg.isConnected) return;
      const y = String(+svg.getAttribute('height') - 6);
      const labels = Array.from(svg.children).filter(t => t.tagName.toLowerCase() === 'text' && t.getAttribute('y') === y);
      if (labels.length < 3) return;
      const box = t => { const b = t.getBBox(); return [b.x, b.x + b.width]; };
      const gap = 6;
      let prev = labels[0];
      for (let i = 1; i < labels.length; i++) {
        const t = labels[i], last = i === labels.length - 1;
        if (box(t)[0] >= box(prev)[1] + gap) { prev = t; continue; }
        if (last && prev !== labels[0]) { prev.remove(); } else { t.remove(); }
      }
    };
    new MutationObserver(fix).observe(chart, { childList: true, subtree: true });
    return chart;
  }

  function section(title, text) {
    return h('div', { class: 'analytics-section' }, h('div', { style: 'min-width:0' }, h('h3', null, title), text && h('p', null, text)));
  }

  // Полосы ROI с подсветкой выбранного значения и пометкой малых выборок
  function roiBars(groups, o) {
    return UI.hbars({
      valueFormat: v => fmt.signedPct(v),
      items: groups.map(g => {
        const base = o.colorOf ? o.colorOf(g.key) : 'var(--s1)';
        const dim = o.selected && o.selected !== 'all' && o.selected !== g.key;
        const color = dim ? 'color-mix(in srgb, ' + base + ' 30%, var(--surface))' : base;
        return {
          label: g.label, value: g.roi, color, note: nEv(g.n),
          labelNode: [h('i', { style: { width: '8px', height: '8px', borderRadius: '2px', background: color, flex: 'none' } }),
            h('span', { style: dim ? 'color:var(--fg-3)' : (o.selected === g.key ? 'color:var(--fg);font-weight:600' : null) }, g.label),
            g.n < SMALL && smallMark()],
        };
      }),
    });
  }

  // ---------- фильтры ----------
  function filterBar(onChange) {
    const periodBox = h('div', { class: 'analytics-filter analytics-filter-period' });
    const drawPeriod = () => {
      UI.clear(periodBox);
      UI.append(periodBox, [
        h('span', { class: 'analytics-filter-label', id: 'analytics-period-label' }, 'Период'),
        UI.segmented({ label: 'Период', items: PERIODS.map(p => ({ id: p.id, label: p.label })), active: state.period, onChange: id => { state.period = id; onChange(); } }),
      ]);
    };
    drawPeriod();
    const marketField = UI.field({
      id: 'analytics-market', label: 'Рынок', value: state.market,
      options: [{ value: 'all', label: 'Все рынки' }].concat(MARKETS.map(m => ({ value: m.id, label: m.label }))),
      attrs: { on: { change: e => { state.market = e.target.value; onChange(); } } },
    });
    const surfaceField = UI.field({
      id: 'analytics-surface', label: 'Покрытие', value: state.surface,
      options: [{ value: 'all', label: 'Все покрытия' }].concat(SURF_KEYS.map(k => ({ value: k, label: D.surfaces[k].label }))),
      attrs: { on: { change: e => { state.surface = e.target.value; onChange(); } } },
    });
    const reset = button('Сбросить фильтры', { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { Object.assign(state, DEFAULTS); onChange(true); }, attrs: { class: 'btn ghost sm analytics-filter-reset' } });
    const scope = h('div', { class: 'analytics-scope', 'aria-live': 'polite' });
    const el = h('section', { class: 'analytics-filters', 'aria-label': 'Фильтры: применяются ко всем блокам ниже' },
      periodBox, h('div', { class: 'analytics-filter' }, marketField), h('div', { class: 'analytics-filter' }, surfaceField), reset, scope);

    function sync(s, periodChanged) {
      marketField.querySelector('select').value = state.market;
      surfaceField.querySelector('select').value = state.surface;
      if (periodChanged) drawPeriod();
      reset.hidden = isDefault();
      UI.clear(scope);
      const dates = s.bets.map(b => b.date).sort();
      const range = dates.length ? ' · ' + (dates[0] === dates[dates.length - 1] ? fmt.date(dates[0]) : fmt.date(dates[0]) + ' – ' + fmt.date(dates[dates.length - 1])) : '';
      const chips = [];
      if (state.market !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по рынку', on: { click: () => { state.market = 'all'; onChange(); } } }, 'Рынок: ' + mLabel(state.market), icon('x')));
      if (state.surface !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по покрытию', on: { click: () => { state.surface = 'all'; onChange(); } } }, 'Покрытие: ' + D.surfaces[state.surface].label, icon('x')));
      UI.append(scope, [
        h('span', null, 'В выборке ', h('b', null, nBets(s.sum.n)), ' и ', h('b', null, nEv(s.legs.length)), range),
        chips,
        openN() > 0 && h('span', { class: 'muted xsmall' }, openN() + ' ' + fmt.plural(openN(), 'ставка в игре не учитывается', 'ставки в игре не учитываются', 'ставок в игре не учитываются')),
      ]);
    }
    return { el, sync };
  }

  // ---------- KPI ----------
  function kpis(s) {
    const c = s.sum, pv = s.prev && s.prev.n ? s.prev : null;
    const profit = { label: 'Прибыль', icon: 'wallet', value: fmt.signedMoney(c.profit), hint: 'оборот ' + fmt.money(c.turnover) };
    if (pv) Object.assign(profit, { delta: fmt.signedMoney(c.profit - pv.profit), trend: trendOf(c.profit - pv.profit), hint: s.p.prev });
    const roi = { label: 'ROI', icon: 'coins', value: c.roi == null ? '—' : fmt.signedPct(c.roi), hint: 'к сумме ставок' };
    if (pv && pv.roi != null && c.roi != null) Object.assign(roi, { delta: deltaPP(c.roi - pv.roi), trend: trendOf(Math.round((c.roi - pv.roi) * 10)), hint: s.p.prev });
    const wr = { label: 'Винрейт', icon: 'trophy', value: c.winrate == null ? '—' : fmt.pct(c.winrate), hint: c.wins + ' В · ' + c.losses + ' П' + (c.voids ? ' · ' + c.voids + ' возвр.' : '') };
    const clv = { label: 'Средний CLV', icon: 'bolt', value: c.clv == null ? '—' : fmt.signedPct(Math.round(c.clv * 10) / 10), hint: 'лучше закрытия в ' + c.clvPos + ' из ' + c.clvN };
    if (pv && pv.clv != null && c.clv != null) Object.assign(clv, { delta: deltaPP(c.clv - pv.clv), trend: trendOf(Math.round((c.clv - pv.clv) * 10)) });
    const b = s.brier;
    const br = { label: 'Brier модели', icon: 'target', value: b.model == null ? '—' : fmt.dec(b.model, 3) };
    if (b.model != null) {
      const diff = b.model - b.market;
      Object.assign(br, { delta: signedDec(diff, 3) + ' к рынку', trend: trendOf(Math.round(diff * 1000)), good: false, hint: 'рынок ' + fmt.dec(b.market, 3) + ' · ниже — лучше' });
    }
    const exp = c.n - c.singles;
    const cnt = { label: 'Выборка', icon: 'ticket', value: h('span', { title: c.singles + ' ' + fmt.plural(c.singles, 'ординар', 'ординара', 'ординаров') + ', ' + exp + ' ' + fmt.plural(exp, 'экспресс', 'экспресса', 'экспрессов') }, String(c.n), h('small', null, ' / ' + s.legs.length)),
      hint: 'ставок / событий' };
    return h('section', { class: 'analytics-kpis', 'aria-label': 'Ключевые показатели ' + s.p.ctx }, [profit, roi, wr, clv, br, cnt].map(t => UI.stat(t)));
  }

  // ---------- банк ----------
  function bankCard(s, mobile) {
    const dates = [];
    for (let d = s.anchor; d <= TODAY; d = addDays(d, 1)) dates.push(d);
    const isBank = !s.filtered;
    let values, base;
    if (isBank) { values = dates.map(bankAt); base = bankAt(s.anchor); }
    else {
      const byDate = {};
      s.bets.forEach(b => { byDate[b.date] = (byDate[b.date] || 0) + b.profit; });
      let acc = 0; values = dates.map(d => (acc += byDate[d] || 0)); base = 0;
    }
    // График — в валюте программы (Р17): значения пересчитываем, шкала идет по круглым суммам в этой валюте.
    // Подписи без символа валюты, он есть в подзаголовке; копейки и центы — только там, где они есть.
    const dec = (UI.currency.list[UI.currency.code] || { dec: 0 }).dec;
    const num = v => (dec && Math.round(v * 100) % 100 !== 0 ? fmt.dec(v, 2) : fmt.int(v));
    const yf = isBank ? num : (v => (v > 0 ? '+' : '') + num(v));
    let peak = base, maxDD = 0, hi = -Infinity, lo = Infinity;
    values.forEach(v => { peak = Math.max(peak, v); if (isBank) maxDD = Math.min(maxDD, (v - peak) / peak * 100); hi = Math.max(hi, v); lo = Math.min(lo, v); });
    const c = s.sum;
    const chart = declutterX(UI.lineChart({
      labels: dates,
      series: [{ name: isBank ? 'Банк' : 'Результат', color: 'var(--s1)', values: values.map(fmt.moneyNum) }],
      area: true, areaBase: isBank ? null : 0, endLabel: true, height: mobile ? 210 : 270,
      refLines: [{ value: fmt.moneyNum(base) }], yFormat: yf, xFormat: d => fmt.date(d), tipTitle: d => fmt.dateFull(d),
      ariaLabel: isBank ? 'Банк по дням ' + s.p.ctx + ': с ' + fmt.money(base) + ' до ' + fmt.money(values[values.length - 1]) : 'Результат отобранных ставок нарастающим итогом: ' + fmt.signedMoney(values[values.length - 1]),
    }));

    // Таблица: по неделям для 30 дней, по месяцам для длинных периодов
    const tableFactory = () => {
      const byWeek = s.p.id === '30';
      const keyOf = d => {
        if (!byWeek) return d.slice(0, 7);
        const dt = new Date(d + 'T12:00:00Z'); const wd = (dt.getUTCDay() + 6) % 7; return addDays(d, -wd);
      };
      const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
      const groups = {};
      s.bets.forEach(b => { const k = keyOf(b.date); (groups[k] = groups[k] || []).push(b); });
      let cum = 0;
      const rows = Object.keys(groups).sort().map(k => {
        const bs = groups[k], sm = summarize(bs);
        cum += sm.profit;
        const end = byWeek ? addDays(k, 6) : k + '-31';
        return { label: byWeek ? fmt.date(k) + ' – ' + fmt.date(addDays(k, 6)) : MONTHS[+k.slice(5, 7) - 1] + (k.slice(5, 7) === TODAY.slice(5, 7) ? ' (по ' + fmt.date(TODAY) + ')' : ''), n: sm.n, profit: sm.profit, roi: sm.roi, end: isBank ? bankAt(end < TODAY ? end : TODAY) : cum };
      });
      return tableBox(mtable({
        columns: [
          { key: 'label', label: byWeek ? 'Неделя' : 'Месяц', render: r => h('span', { style: 'white-space:nowrap' }, r.label) },
          { key: 'n', label: 'Ставок', align: 'r', hideMobile: true },
          { key: 'profit', label: 'Прибыль', align: 'r', render: r => h('span', { class: roiCls(r.profit), style: 'white-space:nowrap;font-weight:600' }, fmt.signedMoney(r.profit)) },
          { key: 'roi', label: 'ROI', align: 'r', hideMobile: true, render: r => (r.roi == null ? '—' : roiText(r.roi)) },
          { key: 'end', label: isBank ? 'Банк на конец' : 'Итог нарастающим', align: 'r', render: r => h('span', { style: 'white-space:nowrap' }, isBank ? fmt.money(r.end) : fmt.signedMoney(r.end)) },
        ],
        rows, empty: 'Нет ставок за период',
      }));
    };
    const strip = isBank
      ? [['Старт периода', fmt.money(base), fmt.date(s.anchor)], ['Пик', fmt.money(peak), null], ['Макс. просадка', maxDD < 0 ? fmt.signedPct(maxDD) : '0%', 'от пика'], ['Оборот', fmt.money(c.turnover), nBets(c.n)]]
      : [['Лучшая точка', fmt.signedMoney(hi), null], ['Худшая точка', fmt.signedMoney(Math.min(0, lo)), null], ['Оборот', fmt.money(c.turnover), nBets(c.n)], ['ROI', c.roi == null ? '—' : fmt.signedPct(c.roi), null]];
    return card({
      class: 'analytics-card',
      title: isBank ? 'Банк по дням' : 'Результат отобранных ставок',
      subtitle: isBank ? s.p.ctx[0].toUpperCase() + s.p.ctx.slice(1) + ', ' + fmt.cur() + ' на конец дня' : 'Нарастающим итогом, ' + fmt.cur() + ' · банк целиком виден без фильтров рынка и покрытия',
      actions: [chip(fmt.signedMoney(c.profit), c.profit > 0 ? 'good' : c.profit < 0 ? 'bad' : 'outline', c.profit > 0 ? 'arrowUp' : c.profit < 0 ? 'arrowDown' : null)],
      body: [
        UI.legend(isBank
          ? [{ name: 'Банк на конец дня', color: 'var(--s1)' }, { name: 'Банк на начало периода · ' + fmt.money(base), type: 'dash' }]
          : [{ name: 'Прибыль нарастающим итогом', color: 'var(--s1)' }, { name: 'Ноль', type: 'dash' }]),
        UI.withTable(chart, tableFactory),
        h('dl', { class: 'analytics-strip' }, strip.map(([k, v, sub]) => h('div', null, h('dt', null, k), h('dd', null, v, sub && h('small', null, sub))))),
        howto(h('b', null, 'Как читать: '), isBank ? 'линия выше пунктира — вы в плюсе относительно начала периода. ' : 'выше нуля — отобранные ставки в плюсе. ', hover() + (UI.isMobile() ? ' графика' : ' график') + ', чтобы увидеть значение на любой день.'),
      ],
    });
  }

  // ---------- выводы модели ----------
  function insightList(s) {
    const out = [];
    // 1. Калибровка: самый переоцененный диапазон с достаточной выборкой
    const bins = calibration(s.legs).filter(b => b.n >= 8);
    const worst = bins.reduce((w, b) => (!w || b.p - b.actual > w.p - w.actual ? b : w), null);
    if (worst && worst.p - worst.actual >= 0.04) {
      const gap = Math.round((worst.p - worst.actual) * 100);
      const range = pctRange(worst.lo, worst.hi);
      out.push({ id: 'calib-' + range, tone: 'warn', ic: 'target', title: ['Переоценка фаворитов в диапазоне ', nowrap(range)],
        text: 'Модель давала в среднем ' + fmt.prob(worst.p) + ', а сыграло ' + fmt.prob(worst.actual) + ' — на ' + gap + ' п.п. меньше. Валуй в этом диапазоне, вероятно, завышен.',
        basis: nEv(worst.n), action: 'hypothesis', range, gap, n: worst.n });
    } else if (bins.length) {
      out.push({ id: 'calib-ok', tone: 'good', ic: 'check', title: 'Калибровка в норме',
        text: 'Ни в одном диапазоне с 8+ событиями прогноз не расходится с фактом больше чем на 4 п.п.', basis: nEv(sum(bins, b => b.n)) });
    }
    // 2. Убыточный диапазон итогового кэфа
    const tot = groupTotals(s.bets).filter(t => t.n >= 8).sort((a, b) => a.roi - b.roi)[0];
    if (tot && tot.roi < 0) {
      const st = D.strategy.stakeTable.find(x => x.range === tot.key);
      const biggest = D.strategy.stakeTable[0].range === tot.key;
      out.push({ id: 'total-' + tot.key, tone: 'bad', ic: 'alert', title: ['Экспрессы с итоговым кэфом ', nowrap(tot.label), ' в минусе'],
        text: 'ROI ' + fmt.signedPct(tot.roi) + ' на ' + onBets(tot.n) + ' (' + fmt.signedMoney(tot.profit) + '). ' + (st ? (biggest ? 'При этом по таблице стратегии на них идет самая крупная ставка — ' : 'Ставка по таблице стратегии — ') + st.pct + ' банка.' : ''),
        basis: nBets(tot.n), action: 'bets' });
    }
    // 3. Лучший срез на маленькой выборке
    const slices = groupLegs(s.legs, l => l.surface, k => D.surfaces[k].label).map(g => Object.assign(g, { dim: 'surface', kind: 'Покрытие' }))
      .concat(groupLegs(s.legs, l => l.market, mLabel).map(g => Object.assign(g, { dim: 'market', kind: 'Рынок' })))
      .filter(g => g.n >= 3 && state[g.dim] !== g.key);
    const best = slices.sort((a, b) => b.roi - a.roi)[0];
    if (best && best.n < 30 && best.roi > 0) {
      const after = (best.roi / 100 * best.n - 1) / (best.n + 1) * 100;
      out.push({ id: 'small-' + best.key, tone: 'info', ic: 'info', title: best.kind + ' ' + best.label + ': ROI ' + fmt.signedPct(best.roi) + ' — пока не закономерность',
        text: 'Выборка мала: ' + nEv(best.n) + '. Один следующий проигрыш опустит ROI до ' + fmt.signedPct(after) + '. Чтобы отличить преимущество от везения, нужно хотя бы 30 событий.',
        basis: nEv(best.n), action: 'filter', dim: best.dim, key: best.key, label: best.label });
    }
    // 4. Модель против рынка
    if (s.brier.n >= 20) {
      const diff = s.brier.model - s.brier.market;
      out.push({ id: 'brier', tone: 'accent', ic: 'bolt', title: Math.abs(diff) < 0.01 ? 'Модель на уровне закрывающей линии' : diff < 0 ? 'Модель точнее закрывающей линии' : 'Рынок пока точнее модели',
        text: 'Brier ' + fmt.dec(s.brier.model, 3) + ' против ' + fmt.dec(s.brier.market, 3) + ' у рынка' + (Math.abs(diff) < 0.01 ? ' — разница в пределах шума на ' + onEv(s.brier.n) + '.' : '.') + ' Надежнее смотреть на CLV: ' + fmt.signedPct(Math.round(s.sum.clv * 10) / 10) + ' в среднем, лучше закрытия в ' + s.sum.clvPos + ' из ' + s.sum.clvN + '.',
        basis: nEv(s.brier.n), action: 'explain' });
    }
    // 0. Общая оговорка, если данных мало — ставим первой
    if (s.legs.length < 30) {
      out.unshift({ id: 'sample', tone: 'info', ic: 'info', title: 'Выборка слишком мала для выводов',
        text: 'Под фильтром ' + nBets(s.sum.n) + ' и ' + nEv(s.legs.length) + '. На таком объеме ROI и калибровка почти целиком зависят от везения — опирайтесь на них не раньше 30 событий.',
        basis: nEv(s.legs.length), action: state.period !== 'all' ? 'widen' : s.filtered ? 'clear' : null });
    }
    return out.slice(0, 3);
  }

  function hypothesisModal(ins) {
    const num = 'L-0' + (22 + Object.keys(ui.hypotheses).length);
    UI.modal({
      title: 'Гипотеза для обучения модели',
      body: [
        h('p', { class: 'soft small' }, 'ИИ подготовил черновик урока по этому наблюдению. Урок не попадет в промпт анализа, пока не подтвердится на новых событиях и вы его не одобрите в разделе «Обучение модели».'),
        UI.field({ id: 'analytics-hyp-text', label: 'Формулировка', rows: 4, value: 'При прогнозе ' + ins.range + ' на фаворита модель завышает вероятность примерно на ' + ins.gap + ' п.п. Снижать оценку на ' + Math.max(2, Math.round(ins.gap / 2)) + ' п.п. перед расчетом валуя.' }),
        UI.field({ id: 'analytics-hyp-scope', label: 'Где проверять', value: 'all', options: [{ value: 'all', label: 'Все покрытия и рынки' }, { value: 'fav', label: 'Только П1 и Ф1(−1.5) — ставки на фаворита' }, { value: 'hard', label: 'Только хард' }] }),
        UI.kv([['Основание сейчас', nEv(ins.n)], ['Порог подтверждения', '≥ 20 новых событий'], ['Номер', num]]),
      ],
      actions: close => [
        button('Отмена', { kind: 'ghost', onClick: close }),
        button('Добавить в гипотезы', { kind: 'primary', icon: 'flask', onClick: () => { ui.hypotheses[ins.id] = num; close(); update(); UI.toast('Гипотеза ' + num + ' добавлена — проверим на следующих 20 событиях', 'flask'); } }),
      ],
    });
  }

  function explainModal() {
    UI.modal({
      title: 'Brier и CLV простыми словами',
      body: [
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'Brier — точность вероятностей'),
          h('p', { class: 'small soft' }, 'Для каждого события берется (прогноз − исход)², где исход — 1 или 0, и усредняется. Прогноз 80% на сыгравшее событие дает 0,04, на не сыгравшее — 0,64. 0 — идеально, 0,25 — как всегда ставить 50%. Ниже — лучше.')),
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'Почему сравниваем с рынком'),
          h('p', { class: 'small soft' }, 'Закрывающий кэф — самая точная публичная оценка. Эталон рынка у нас — кэф ' + D.marketRef + ': у него самая низкая маржа. Если Brier модели ниже рыночного, модель видит что-то, чего не учла линия. Разница в тысячные доли на сотне событий — пока шум.')),
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'CLV — качество цены'),
          h('p', { class: 'small soft' }, 'CLV = ваш кэф / закрывающий кэф ' + D.marketRef + ' − 1. Взяли 1.62, к началу матча у ' + D.marketRef + ' стало 1.55 — CLV +4,5%. Результат одной ставки — случайность, а стабильно положительный CLV — устойчивый признак преимущества. Его видно уже через 50–100 ставок, ROI — через сотни.')),
        UI.callout('info', 'flask', 'Эти же метрики используются при обучении. Новую версию стратегии включают, только если ее лог-лосс на отложенной выборке лучше текущего: 95% интервал разницы целиком ниже нуля. Версия ради экономии токенов проходит правило «не хуже с допуском». Brier и CLV — дополнительные проверки, а ROI на паре сотен событий — шум, по нему версии не выбирают.'),
      ],
      actions: close => [button('Открыть «Обучение модели»', { kind: 'secondary', iconRight: 'chevronRight', href: '#learning', attrs: { class: 'btn secondary', on: { click: close } } }), button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // Лимит ИИ по решениям Р7, Р9, Р13: участник на ключе администратора видит свой лимит, администратор — бюджет
  // своего ключа; на своем ключе действует только потолок на один анализ (DATA.me.ownCap). Расходы на Claude — в долларах.
  // Цифры — из общего расчета DATA.ai; можно ли запускать — решает DATA.ai.access.
  const usdL = n => fmt.usd(n, Number.isInteger(n) ? 0 : 2); // $10 и $1, но $1,50
  function aiLimitText() {
    const me = D.me, m = D.ai.month;
    if (me.aiMode === 'own') {
      if (!me.ownKey) return 'Вы работаете на своем ключе Claude, но ключ еще не добавлен — добавьте его в личном кабинете.';
      const cap = me.ownCap != null ? me.ownCap : D.admin.defaults.perAnalysis;
      return 'Разбор оплачивается с вашего ключа Claude (sk-ant-…' + me.ownKey.last4 + '). На своем ключе действует только ваш потолок — ' + usdL(cap) + ' на один запуск.';
    }
    const L = D.ai.limitOf(me);
    if (L) {
      const spent = D.ai.keySpent(me);
      return 'Ваш лимит ИИ на ' + m + ': израсходовано ' + fmt.usd(spent) + ' из ' + usdL(L.monthly) + ', осталось ' + fmt.usd(Math.max(0, L.monthly - spent)) + '. Ключ администратора.';
    }
    const B = D.ai.budget();
    return 'Ключ администратора на ' + m + ': израсходовано ' + fmt.usd(B.spent) + ' из ' + usdL(B.monthly) + ' — общий бюджет на всех, кто работает на этом ключе.';
  }

  function deepModal(s) {
    const fresh = 3000 + s.legs.length * 45, cached = 6200, out = 1600;
    const cost = (fresh * 2 + cached * 0.2 + out * 10) / 1e6; // цены Sonnet 5.5 из data.js, $ за 1M токенов
    const reason = D.ai.access(D.me, cost, { kind: 'review' }); // пауза, нет ключа, лимиты и бюджет — общий расчет
    UI.modal({
      title: 'Подробный разбор периода',
      body: [
        h('p', { class: 'soft small' }, 'ИИ получит сжатую таблицу событий и ставок под текущими фильтрами, правила стратегии и подтвержденные уроки. Вернет 5–7 наблюдений с указанием выборки и черновики гипотез. Сам по себе разбор ничего не меняет в стратегии.'),
        UI.kv([
          ['Модель', 'Sonnet 5.5'],
          ['Данные', nBets(s.sum.n) + ', ' + nEv(s.legs.length)],
          ['Токены на входе', '≈ ' + fmt.tokens(fresh + cached) + ' (' + fmt.tokens(cached) + ' из кэша)'],
          ['Ответ', '≈ ' + fmt.tokens(out) + ' токенов'],
          ['Стоимость', '≈ ' + fmt.usd(cost)],
          ['Время', '≈ 30 с'],
        ]),
        UI.callout('accent', 'coins', aiLimitText()),
        reason && UI.callout('warn', 'alert', h('b', null, 'Запустить нельзя. '), reason + '.'),
      ],
      actions: close => [
        button('Отмена', { kind: 'ghost', onClick: close }),
        button('Запустить разбор', { kind: 'primary', icon: 'spark', disabled: !!reason, onClick: () => { if (D.ai.access(D.me, cost, { kind: 'review' })) return; D.ai.recordSpend(D.me, cost); ui.deep = true; close(); update(); UI.toast('Разбор запущен — результат появится в «Обучении модели» через ~30 с', 'spark'); } }),
      ],
    });
  }

  function insightsCard(s) {
    const list = insightList(s);
    const TONE_LABEL = { warn: 'Внимание', bad: 'Риск', info: 'Мало данных', accent: 'Наблюдение', good: 'В норме' };
    const actionOf = ins => {
      if (ins.action === 'hypothesis') {
        return ui.hypotheses[ins.id]
          ? h('a', { href: '#learning', class: 'chip info', style: 'text-decoration:none' }, icon('flask'), 'В гипотезах · ' + ui.hypotheses[ins.id])
          : button('Создать гипотезу', { kind: 'secondary', size: 'sm', icon: 'flask', onClick: () => hypothesisModal(ins) });
      }
      if (ins.action === 'bets') return button('Открыть ставки', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#bets' });
      if (ins.action === 'filter') return button('Показать только ' + ins.label, { kind: 'secondary', size: 'sm', icon: 'filter', onClick: () => { state[ins.dim] = ins.key; update(); scrollToFilters(); UI.toast('Фильтр: ' + ins.label, 'filter'); } });
      if (ins.action === 'widen') return button('Показать за все время', { kind: 'secondary', size: 'sm', icon: 'calendar', onClick: () => { state.period = 'all'; update(true); } });
      if (ins.action === 'clear') return button('Снять фильтры', { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => { state.market = 'all'; state.surface = 'all'; update(); } });
      if (ins.action === 'explain') return button('Что это значит', { kind: 'secondary', size: 'sm', icon: 'book', onClick: explainModal });
      return null;
    };
    return card({
      class: 'analytics-card analytics-ins-card',
      title: 'Выводы модели',
      subtitle: 'Автоматически по рассчитанным ставкам ' + s.p.ctx,
      actions: [chip('Обновлено ' + fmt.date(settled().map(b => b.date).sort().pop()), 'outline', 'clock')],
      body: list.length
        ? h('ol', { class: 'analytics-ins', 'aria-label': 'Выводы модели', style: { '--ins-n': String(list.length) } }, list.map(ins => h('li', null,
          h('span', { class: ['analytics-ins-ic', ins.tone], 'aria-hidden': 'true' }, icon(ins.ic)),
          h('div', { class: 'analytics-ins-body' },
            h('span', { class: 'sr-only' }, TONE_LABEL[ins.tone] + ': '),
            h('div', { class: 'analytics-ins-title' }, ins.title),
            h('div', { class: 'analytics-ins-text' }, ins.text),
            h('div', { class: 'analytics-ins-foot' }, chip('Основание: ' + ins.basis, 'outline'), actionOf(ins))))))
        : UI.empty('Слишком мало событий для выводов — нужно хотя бы 20.'),
      foot: [
        ui.deep
          ? chip('Разбор запущен · смотрите «Обучение модели»', 'info', 'clock')
          : button('Разобрать подробнее с ИИ', { kind: 'ghost', size: 'sm', icon: 'spark', onClick: () => deepModal(s) }),
        h('span', { class: 'xsmall muted', style: 'min-width:0;flex:1 1 200px' }, 'Это наблюдения по истории, а не гарантии. В промпт попадают только уроки, которые вы подтвердили.'),
      ],
    });
  }

  // ---------- ROI по срезам ----------
  function surfaceCard(s) {
    const groups = groupLegs(s.legsAllSurfaces, l => l.surface, k => D.surfaces[k].label).sort((a, b) => SURF_KEYS.indexOf(a.key) - SURF_KEYS.indexOf(b.key));
    const missing = SURF_KEYS.filter(k => !groups.some(g => g.key === k));
    return card({
      class: 'analytics-card', title: 'ROI по покрытиям', subtitle: 'События экспрессов как ординары на равную сумму',
      actions: [chip(nEv(sum(groups, g => g.n)), 'outline')],
      body: [
        groups.length ? UI.withTable(roiBars(groups, { colorOf: k => D.surfaces[k].color, selected: state.surface }), () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'Покрытие', render: g => UI.surfaceChip(g.key) },
            { key: 'n', label: 'Событий', align: 'r' },
            { key: 'winrate', label: 'Винрейт', align: 'r', render: g => fmt.pct(g.winrate) },
            { key: 'avgOdds', label: nowrap('Ср. кэф'), align: 'r', hideMobile: true, render: g => h('span', { class: 'odds' }, fmt.odds(g.avgOdds)) },
            { key: 'roi', label: 'ROI', align: 'r', render: g => roiText(g.roi) },
          ], rows: groups,
        }))) : UI.empty('Нет событий за период'),
        (groups.some(g => g.n < SMALL) || missing.length) && h('div', { class: 'stack', style: 'gap:4px' },
          groups.some(g => g.n < SMALL) && smallNote(),
          missing.length && h('div', { class: 'analytics-foot-note', style: 'padding-left:19px' }, h('span', null, missing.map(k => D.surfaces[k].label).join(', ') + ': событий ' + (missing.includes('indoor') && missing.length === 1 ? 'пока нет — сезон в залах начнется после Шанхая' : 'за период нет')))),
        howto(h('b', null, 'Как читать: '), 'каждое событие считается отдельной ставкой одного размера — так видно, где прогнозы точнее, без влияния размера ставки. Полоса вправо — плюс, влево — минус.'),
      ],
    });
  }

  function marketCard(s) {
    const groups = groupLegs(s.legsAllMarkets, l => l.market, mLabel).sort((a, b) => MARKETS.findIndex(m => m.id === a.key) - MARKETS.findIndex(m => m.id === b.key));
    return card({
      class: 'analytics-card', title: 'ROI по рынкам', subtitle: 'Победа и фора по сетам · события как ординары',
      actions: [chip(nEv(sum(groups, g => g.n)), 'outline')],
      body: [
        groups.length ? roiBars(groups, { selected: state.market }) : UI.empty('Нет событий за период'),
        groups.some(g => g.n < SMALL) && smallNote(),
        howto(h('b', null, 'Как читать: '), 'Ф1(−1.5) — игрок 1 выигрывает 2:0 по сетам, Ф2(+1.5) — игрок 2 берет хотя бы сет. Подробности и фильтр — в таблице «Сводка по рынкам» ниже.'),
      ],
    });
  }

  function oddsCard(s) {
    const groups = groupLegs(s.legs, l => oddsBucket(l.odds)).sort((a, b) => a.key.localeCompare(b.key));
    return card({
      class: 'analytics-card', title: 'ROI по кэфу события', subtitle: 'Диапазоны кэфа отдельного события',
      actions: [chip(nEv(s.legs.length), 'outline')],
      body: [
        groups.length ? UI.withTable(roiBars(groups, {}), () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'Кэф', render: g => h('span', { class: 'odds analytics-nowrap' }, g.label) },
            { key: 'n', label: 'Событий', align: 'r', hideMobile: true },
            { key: 'winrate', label: 'Винрейт', align: 'r', render: g => fmt.pct(g.winrate) },
            { key: 'need', label: 'Для нуля', align: 'r', render: g => h('span', { class: 'muted' }, fmt.pct(100 / g.avgOdds)) },
            { key: 'roi', label: 'ROI', align: 'r', render: g => roiText(g.roi) },
          ], rows: groups,
        }))) : UI.empty('Нет событий за период'),
        groups.some(g => g.n < SMALL) && smallNote(),
        howto(h('b', null, 'Как читать: '), 'высокий винрейт на низких кэфах еще не прибыль: при кэфе 1.25 нужно угадывать 80% только чтобы выйти в ноль. Сравните винрейт с колонкой «Для нуля» в таблице.'),
      ],
    });
  }

  function totalCard(s) {
    const groups = groupTotals(s.bets);
    const stakeOf = k => (D.strategy.stakeTable.find(x => x.range === k) || {}).pct || '—';
    return card({
      class: 'analytics-card', title: 'ROI по итоговому кэфу экспресса', subtitle: 'Реальные ставки: прибыль к сумме ставок',
      actions: [chip(nBets(s.sum.n), 'outline')],
      body: [
        groups.length ? UI.withTable(UI.hbars({
          valueFormat: v => fmt.signedPct(v),
          items: groups.map(g => ({ label: g.label, value: g.roi, color: 'var(--s1)', note: nBets(g.n),
            labelNode: [h('i', { style: { width: '8px', height: '8px', borderRadius: '2px', background: 'var(--s1)', flex: 'none' } }), h('span', null, g.label), g.n < SMALL && smallMark()] })),
        }), () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'Кэф', render: g => h('span', { class: 'odds analytics-nowrap' }, g.label) },
            { key: 'n', label: 'Ставок', align: 'r' },
            { key: 'pct', label: 'Ставка', align: 'r', hideMobile: true, render: g => h('span', { class: 'analytics-nowrap', title: 'Размер ставки по таблице стратегии, % банка' }, stakeOf(g.key)) },
            { key: 'profit', label: 'Прибыль', align: 'r', render: g => h('span', { class: roiCls(g.profit), style: 'white-space:nowrap;font-weight:600' }, fmt.signedMoney(g.profit)) },
            { key: 'roi', label: 'ROI', align: 'r', render: g => roiText(g.roi) },
          ], rows: groups,
        }))) : UI.empty('Нет ставок за период'),
        groups.some(g => g.n < SMALL) && footNote('меньше ' + SMALL + ' ставок — ROI может быть случайным'),
        howto(h('b', null, 'Как читать: '), 'здесь считаются деньги, а не отдельные события. На экспрессы до 1.70 по таблице стратегии идет самая крупная ставка (', stakeOf('1.28–1.70'), ' банка), поэтому их ROI сильнее всего влияет на банк.'),
      ],
    });
  }

  // ---------- точность ----------
  function calibrationCard(s, mobile) {
    const bins = calibration(s.legs);
    if (!bins.length) return card({ class: 'analytics-card', title: 'Калибровка прогнозов', body: UI.empty('Нет событий за период') });
    const vals = bins.flatMap(b => [b.p, b.actual]);
    const d0 = Math.max(0.2, Math.min(0.6, Math.floor(Math.min(...vals) * 10) / 10));
    const chart = UI.calibrationChart({ bins, domain: [d0, 1], height: mobile ? 250 : 280 });
    const big = bins.filter(b => b.n >= 8);
    const worst = big.reduce((w, b) => (!w || b.p - b.actual > w.p - w.actual ? b : w), null);
    const under = big.reduce((w, b) => (!w || b.actual - b.p > w.actual - w.p ? b : w), null);
    let insight;
    if (!big.length) {
      insight = UI.callout('', 'info', 'Ни в одном диапазоне нет 8+ событий — по калибровке пока рано делать выводы.');
    } else if (worst && worst.p - worst.actual >= 0.03) {
      insight = UI.callout('warn', 'alert', h('b', null, 'Диапазон ' + pctRange(worst.lo, worst.hi) + ': '), 'прогноз ' + fmt.prob(worst.p) + ', сбылось ' + fmt.prob(worst.actual) + ' (' + nEv(worst.n) + '). Модель переоценивает фаворитов на ' + Math.round((worst.p - worst.actual) * 100) + ' п.п.' + (under && under.actual - under.p >= 0.02 ? ' А в диапазоне ' + pctRange(under.lo, under.hi) + ' — наоборот, недооценивает: ' + fmt.prob(under.p) + ' против ' + fmt.prob(under.actual) + '.' : ''));
    } else {
      insight = UI.callout('good', 'check', 'Во всех диапазонах с 8+ событиями прогноз расходится с фактом меньше чем на 3 п.п.');
    }
    return card({
      class: 'analytics-card', title: 'Калибровка прогнозов', subtitle: 'Прогноз модели против доли сыгравших событий',
      actions: [chip(nEv(s.legs.length), 'outline')],
      body: [
        UI.legend([{ name: 'Модель · размер точки — число событий', color: 'var(--s1)' }, { name: 'Идеальная калибровка', type: 'dash' }]),
        UI.withTable(chart, () => tableBox(mtable({
          columns: [
            { key: 'r', label: 'Диапазон', render: b => nowrap(pctRange(b.lo, b.hi)) },
            { key: 'n', label: 'Событий', align: 'r', hideMobile: true },
            { key: 'p', label: 'Модель', align: 'r', render: b => fmt.prob(b.p) },
            { key: 'a', label: 'Факт', align: 'r', render: b => fmt.prob(b.actual) },
            { key: 'd', label: 'Разница, п.п.', align: 'r', render: b => { const d = Math.round((b.actual - b.p) * 100); return h('span', { class: d <= -4 ? 'bad-text' : null, style: 'white-space:nowrap', title: d <= -4 ? 'Модель переоценивает этот диапазон' : null }, (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d)); } },
          ], rows: bins,
        }))),
        insight,
        s.legs.length < 60 && footNote('Меньше 60 событий: точки калибровки сильно скачут, выводы преждевременны.'),
        howto(h('b', null, 'Как читать: '), 'если модель говорит 70%, такие события должны сыграть примерно в 7 из 10 случаев. Точки ниже диагонали — модель переоценивает фаворитов, выше — недооценивает.'),
      ],
    });
  }

  function brierCard(s, mobile) {
    const pts = rolling(s.legs);
    const head = { class: 'analytics-card', title: 'Brier: модель против рынка', subtitle: 'Скользящие 30 событий · ниже — лучше' };
    if (pts.length < 2) {
      return card(Object.assign(head, { body: [UI.empty('Для скользящего окна нужно хотя бы 33 события — сейчас ' + s.legs.length + '. Расширьте период или снимите фильтры.'), howto(h('b', null, 'Как читать: '), 'Brier — средняя квадратичная ошибка прогноза: 0 — идеально, 0,25 — как всегда ставить 50%.')] }));
    }
    const last = pts[pts.length - 1];
    const better = pts.filter(p => p.model < p.market).length;
    const b = s.brier, diff = b.model - b.market;
    const verdict = Math.abs(diff) < 0.01
      ? UI.callout('', 'info', h('b', null, 'За период: '), 'модель ' + fmt.dec(b.model, 3) + ', рынок ' + fmt.dec(b.market, 3) + ' — разница ' + signedDec(diff, 3) + ', в пределах шума на ' + onEv(b.n) + '. Чтобы говорить о преимуществе над линией, нужен доверительный интервал на тысячах событий.')
      : diff < 0
        ? UI.callout('good', 'check', h('b', null, 'За период: '), 'модель ' + fmt.dec(b.model, 3) + ' против ' + fmt.dec(b.market, 3) + ' у рынка (' + nEv(b.n) + '). Разница заметная, но проверьте, держится ли она на новых событиях.')
        : UI.callout('warn', 'alert', h('b', null, 'За период: '), 'рынок точнее: ' + fmt.dec(b.market, 3) + ' против ' + fmt.dec(b.model, 3) + ' у модели (' + nEv(b.n) + '). Ставки, где модель расходится с линией, стоит пересмотреть.');
    const chart = declutterX(UI.lineChart({
      labels: pts.map(p => p.date),
      series: [{ name: 'Модель', color: 'var(--s1)', values: pts.map(p => p.model) }, { name: 'Рынок (закрытие)', color: 'var(--s2)', values: pts.map(p => p.market) }],
      height: mobile ? 210 : 280, yFormat: v => fmt.dec(v, 3), xFormat: d => fmt.date(d), tipTitle: d => '30 событий по ' + fmt.date(d),
      ariaLabel: 'Скользящий Brier: модель ' + fmt.dec(last.model, 3) + ', рынок ' + fmt.dec(last.market, 3),
    }));
    return card(Object.assign(head, {
      actions: [h('span', { class: ['chip', better * 2 >= pts.length ? 'good' : 'warn'], title: 'В скольких окнах по 30 событий Brier модели ниже рыночного' }, icon(better * 2 >= pts.length ? 'check' : 'alert'), 'Точнее рынка: ' + better + ' из ' + pts.length)],
      body: [
        UI.legend([{ name: 'Модель · сейчас ' + fmt.dec(last.model, 3), color: 'var(--s1)' }, { name: 'Рынок (закрытие) · ' + fmt.dec(last.market, 3), color: 'var(--s2)' }]),
        UI.withTable(chart, () => h('div', { class: 'analytics-scroll' }, mtable({
          columns: [
            { key: 'date', label: 'Окно по', render: p => h('span', { style: 'white-space:nowrap' }, fmt.date(p.date)) },
            { key: 'model', label: 'Модель', align: 'r', render: p => fmt.dec(p.model, 3) },
            { key: 'market', label: 'Рынок', align: 'r', render: p => fmt.dec(p.market, 3) },
            { key: 'd', label: 'Разница', align: 'r', render: p => h('span', { class: p.model < p.market ? 'good-text' : p.model > p.market ? 'bad-text' : null }, signedDec(p.model - p.market, 3)) },
          ], rows: pts.slice().reverse(),
        }))),
        verdict,
        howto(h('b', null, 'Как читать: '), 'Brier — средняя квадратичная ошибка прогноза: 0 — идеально, 0,25 — как всегда ставить 50%. Когда линия модели ниже линии рынка, модель точнее закрывающего кэфа. Каждая точка — последние 30 событий.'),
      ],
    }));
  }

  // ---------- CLV ----------
  function clvCard(s, mobile) {
    const clvs = s.bets.filter(b => b.clv != null).map(b => b.clv); // ставки без закрывающего кэфа в распределение не попадают
    if (!clvs.length) return card({ class: 'analytics-card', title: 'Распределение CLV', body: UI.empty('Нет ставок за период') });
    const lo = Math.max(-3, Math.floor(Math.min(...clvs))), top = Math.min(7, Math.max(lo + 3, Math.floor(Math.max(...clvs))));
    const bins = [];
    for (let k = lo; k <= top; k++) bins.push({ k, n: 0 });
    clvs.forEach(v => { const k = Math.max(lo, Math.min(top, Math.floor(v))); bins[k - lo].n++; });
    const sgn = k => (k > 0 ? '+' : k < 0 ? '−' : '') + Math.abs(k);
    const label = (b, i) => (i === 0 && Math.min(...clvs) < lo ? 'до ' + sgn(lo + 1) + '%' : i === bins.length - 1 && Math.max(...clvs) >= top + 1 ? 'от ' + sgn(b.k) + '%' : 'от ' + sgn(b.k) + ' до ' + sgn(b.k + 1) + '%');
    const items = bins.map((b, i) => ({
      label: label(b, i), short: (i === bins.length - 1 && Math.max(...clvs) >= top + 1 ? '≥ ' + sgn(b.k) : sgn(b.k)), value: b.n,
      color: b.k < 0 ? 'var(--fg-3)' : 'var(--s1)', tipTitle: 'CLV ' + label(b, i),
      tip: [{ name: 'Ставок', color: b.k < 0 ? 'var(--fg-3)' : 'var(--s1)', value: String(b.n) }, { name: 'Доля', value: fmt.pct(b.n / clvs.length * 100, 0) }],
    }));
    const avg = sum(clvs, v => v) / clvs.length;
    const neg = clvs.filter(v => v < 0).length;
    const chart = UI.columnChart({ items, height: mobile ? 190 : 220, valueFormat: v => fmt.int(v), seriesName: 'Ставок', ariaLabel: 'Распределение CLV по ставкам: средний ' + fmt.signedPct(avg) });
    return card({
      class: 'analytics-card', title: 'Распределение CLV', subtitle: 'Ваш кэф против закрывающего, по ставкам',
      actions: [chip('Средний ' + fmt.signedPct(Math.round(avg * 10) / 10), avg > 0 ? 'good' : 'bad', avg > 0 ? 'arrowUp' : 'arrowDown')],
      body: [
        UI.legend([{ name: 'Кэф не хуже закрытия · ' + (clvs.length - neg), color: 'var(--s1)', type: 'box' }, { name: 'Линия ушла против вас · ' + neg, color: 'var(--fg-3)', type: 'box' }]),
        UI.withTable(chart, () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'CLV', render: it => h('span', { style: 'white-space:nowrap' }, it.label) },
            { key: 'value', label: 'Ставок', align: 'r' },
            { key: 'share', label: 'Доля', align: 'r', render: it => fmt.pct(it.value / clvs.length * 100, 0) },
          ], rows: items,
        }))),
        howto(h('b', null, 'Как читать: '), 'CLV — на сколько ваш кэф выше закрывающего кэфа ' + D.marketRef + ' (последнего перед матчем). Столбцы правее нуля — вы взяли цену лучше рыночного итога. Стабильно положительный CLV — главный признак, что преимущество не случайно; исход одной ставки — нет.'),
      ],
    });
  }

  // ---------- сводка по рынкам ----------
  function marketTableCard(s) {
    const groups = groupLegs(s.legsAllMarkets, l => l.market, mLabel).sort((a, b) => MARKETS.findIndex(m => m.id === a.key) - MARKETS.findIndex(m => m.id === b.key));
    const all = s.legsAllMarkets;
    const total = all.length ? { key: 'all', label: 'Все рынки', n: all.length, winrate: all.filter(won).length / all.length * 100, roi: sum(all, l => (won(l) ? l.odds - 1 : -1)) / all.length * 100, avgOdds: sum(all, l => l.odds) / all.length, total: true } : null;
    const pick = key => {
      const next = key === 'all' || state.market === key ? 'all' : key;
      state.market = next; update(); scrollToFilters();
      UI.toast(next === 'all' ? 'Показаны все рынки' : 'Фильтр: ' + mLabel(next) + ' — пересчитаны все блоки', 'filter');
    };
    if (!groups.length) return card({ class: 'analytics-card', title: 'Сводка по рынкам', body: UI.empty('Нет событий за период') });
    const rows = groups.concat(total ? [total] : []);
    const tbl = UI.table({
      columns: [
        { key: 'label', label: 'Рынок', width: '40%', render: g => h('div', { style: 'min-width:0' }, h('div', { class: 'analytics-mname' }, g.label, g.n < SMALL && !g.total ? [' ', smallMark()] : null), !g.total && h('div', { class: 'analytics-mdesc' }, MARKET_SHORT[g.key])) },
        { key: 'n', label: 'Событий', align: 'r' },
        { key: 'winrate', label: 'Винрейт', align: 'r', render: g => fmt.pct(g.winrate) },
        { key: 'roi', label: 'ROI', align: 'r', render: g => roiText(Math.round(g.roi * 10) / 10) },
        { key: 'avgOdds', label: nowrap('Ср. кэф'), align: 'r', render: g => h('span', { class: 'odds' }, fmt.odds(g.avgOdds)) },
      ],
      rows, onRowClick: g => pick(g.key),
    });
    tbl.querySelectorAll('tbody tr').forEach((tr, i) => {
      const g = rows[i];
      if (g.total) tr.classList.add('is-total');
      if (g.key === state.market) tr.classList.add('is-active');
      tr.setAttribute('aria-label', g.label + (g.key === state.market ? ', выбран' : '') + '. Нажмите, чтобы ' + (g.total ? 'показать все рынки' : g.key === state.market ? 'снять фильтр' : 'отфильтровать страницу'));
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(g.key); } });
    });
    const list = h('ul', { class: 'analytics-mlist' }, rows.map(g => h('li', null,
      h('button', { type: 'button', class: 'analytics-mrow', 'aria-pressed': String(g.key === state.market), on: { click: () => pick(g.key) } },
        h('span', null, h('span', { class: 'analytics-mname' }, g.label, g.n < SMALL && !g.total ? [' ', smallMark()] : null), h('span', { class: 'analytics-mrow-sub', style: 'display:block' }, (g.total ? (state.market === 'all' ? 'итог без фильтра' : 'снять фильтр') : MARKET_SHORT[g.key]) + ' · ' + nEv(g.n))),
        h('span', { class: 'analytics-mrow-val' }, roiText(Math.round(g.roi * 10) / 10), h('span', { class: 'analytics-mrow-sub', style: 'display:block' }, fmt.pct(g.winrate, 0) + ' побед · кэф ' + fmt.odds(g.avgOdds)))))));
    return card({
      class: 'analytics-card analytics-mkt-card', title: 'Сводка по рынкам', subtitle: 'Нажмите на рынок, чтобы отфильтровать всю страницу',
      actions: state.market !== 'all' ? [chip('Выбран ' + mLabel(state.market), 'accent', 'filter')] : null,
      body: [
        h('div', { class: 'analytics-mtable analytics-tablebox' }, tbl),
        list,
        groups.some(g => g.n < SMALL) && smallNote(),
        howto(h('b', null, 'Как читать: '), 'винрейт и ROI считаются по отдельным событиям, как будто каждое — ординар на одинаковую сумму. Рынок с ROI около нуля — модель видит то же, что букмекер.'),
      ],
    });
  }

  // ---------- экспорт ----------
  function exportModal(s) {
    let format = 'csv';
    UI.modal({
      title: 'Выгрузить аналитику',
      body: [
        h('div', { class: 'field' }, h('span', { class: 'field-label' }, 'Формат'),
          UI.segmented({ label: 'Формат файла', items: [{ id: 'csv', label: 'CSV' }, { id: 'xlsx', label: 'Excel' }, { id: 'pdf', label: 'PDF-отчет' }], active: format, onChange: id => { format = id; } })),
        h('fieldset', { class: 'analytics-check', style: 'border:0;padding:0;margin:0' },
          h('legend', { class: 'field-label', style: 'margin-bottom:8px' }, 'Что включить'),
          [['analytics-ex-bets', 'Ставки с суммами и результатом', true], ['analytics-ex-legs', 'События экспрессов (кэф, закрытие, прогноз модели)', true], ['analytics-ex-calib', 'Калибровку и Brier по окнам', false]].map(([id, text, on]) =>
            h('label', { class: 'check', for: id }, h('input', { type: 'checkbox', id, checked: on }), h('span', null, text)))),
        UI.callout('', 'filter', 'Будут выгружены данные под текущими фильтрами: ' + s.p.ctx + ', ' + nBets(s.sum.n) + ', ' + nEv(s.legs.length) + '.'),
      ],
      actions: close => [
        button('Отмена', { kind: 'ghost', onClick: close }),
        button('Сформировать файл', { kind: 'primary', icon: 'download', onClick: () => { close(); UI.toast((format === 'pdf' ? 'PDF-отчет' : format === 'xlsx' ? 'Файл Excel' : 'CSV-файл') + ' сформирован. В макете он не скачивается', 'download'); } }),
      ],
    });
  }

  // ---------- сборка ----------
  let contentEl = null, filters = null, forcePeriod = false;
  function scrollToFilters() {
    if (!filters) return;
    const top = filters.el.getBoundingClientRect().top + window.scrollY - 76;
    if (window.scrollY > top) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }

  function emptyState(s) {
    const indoor = state.surface === 'indoor';
    // Есть ли такие ставки за все время — тогда предлагаем расширить период, а не сбрасывать фильтры
    const ever = settled().filter(b => (state.surface === 'all' || b.surface === state.surface) && (state.market === 'all' || b.legs.some(l => l.market === state.market)));
    const canWiden = state.period !== 'all' && ever.length > 0;
    const reset = () => { Object.assign(state, DEFAULTS); update(true); };
    return h('section', { class: 'card analytics-empty' },
      h('span', { class: 'analytics-empty-ic' }, icon('filter')),
      h('h3', null, 'Под фильтр не попало ни одной ставки'),
      h('p', null, indoor
        ? 'На крытом харде ставок пока не было: сезон в залах начнется после Шанхая. Первые события появятся здесь в конце октября.'
        : canWiden
          ? s.p.ctx[0].toUpperCase() + s.p.ctx.slice(1) + ' таких ставок нет. Последняя была ' + fmt.date(ever[ever.length - 1].date) + ', всего за сезон — ' + nBets(ever.length) + '.'
          : 'Нет рассчитанных ставок с таким рынком и покрытием. Снимите один из фильтров.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        canWiden && button('Показать за все время', { kind: 'primary', icon: 'calendar', onClick: () => { state.period = 'all'; update(true); } }),
        button('Сбросить фильтры', { kind: canWiden ? 'secondary' : 'primary', icon: 'refresh', onClick: reset })));
  }

  function drawContent() {
    const mobile = UI.isMobile();
    const s = compute();
    filters.sync(s, forcePeriod); // сегмент периода перерисовываем, только если период сменили не им самим
    forcePeriod = false;
    UI.clear(contentEl);
    if (!s.bets.length) { contentEl.appendChild(emptyState(s)); return; }
    UI.append(contentEl, [
      kpis(s),
      insightsCard(s),
      bankCard(s, mobile),
      section('Где стратегия зарабатывает', 'ROI по срезам. В разрезах по покрытию и рынку все значения видны всегда, выбранное в фильтре подсвечено.'),
      h('div', { class: 'analytics-grid' }, surfaceCard(s), marketCard(s), oddsCard(s), totalCard(s)),
      section('Точность прогнозов', 'Насколько вероятности модели совпадают с реальностью и с закрывающей линией.'),
      h('div', { class: 'analytics-grid' }, calibrationCard(s, mobile), brierCard(s, mobile)),
      section('Цена и рынки', 'Качество взятых кэфов и итог по типам ставок.'),
      h('div', { class: 'analytics-grid' }, clvCard(s, mobile), marketTableCard(s)),
    ]);
  }

  function update(resetPeriod) {
    save();
    forcePeriod = !!resetPeriod;
    drawContent();
  }

  UI.register('analytics', {
    title: 'Аналитика',
    nav: 'analytics',
    render(root) {
      const head = h('div', { class: 'page-head analytics-head' },
        h('div', { style: 'min-width:0' },
          h('h2', null, 'Прибыльность и точность'),
          h('p', { class: 'lead' }, 'Где стратегия приносит деньги и насколько точны вероятности модели. Фильтры ниже пересчитывают все блоки.')),
        h('div', { class: 'analytics-head-actions' },
          button('Выгрузить', { kind: 'secondary', size: UI.isMobile() ? 'sm' : null, icon: 'download', onClick: () => exportModal(compute()) })));
      filters = filterBar(reset => update(reset));
      contentEl = h('div', { class: 'stack', style: 'gap:inherit' });
      UI.append(root, [head, filters.el, contentEl]);
      drawContent();
    },
  });
})();
