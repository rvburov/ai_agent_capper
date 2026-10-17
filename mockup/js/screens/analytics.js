/* Аналитика: прибыльность по срезам (покрытия, рынки, кэфы) с доверительными интервалами, экспрессы против тех же
   событий ординарами (Р21), калибровка, Brier против рынка при прогнозе, CLV с ДИ, выводы кодом.
   Фильтры сверху пересчитывают все блоки из DATA.allLegs / DATA.bets теми же формулами, что и data.js,
   поэтому без фильтров цифры совпадают с DATA.stats и с главной. В приложении все числа и ДИ считает сервер
   (Т4, один GET /api/analytics), фронтенд только рисует; здесь — демо-расчет в браузере. */
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
  // Первый день истории — по данным на экране: у участника в режиме просмотра (Р27) он свой
  const firstDate = () => D.bankHistory[0].date;
  // Считаются при каждой отрисовке: ставка, рассчитанная на экране «Ставки», сразу попадает в выборку
  const settled = () => D.bets.filter(b => b.status !== 'open');
  const openN = () => D.bets.filter(b => b.status === 'open').length;
  const SMALL = 20; // меньше — помечаем «мало данных»
  // Калибровка: диапазон с 8+ событиями, где прогноз расходится с фактом на 4 п.п. и больше (в любую сторону), — плохой
  const CALIB_N = 8, CALIB_GAP = 0.04;
  // Т10: старый бот записывал исходы событий только у выигранных экспрессов (у проигранных — нет). Если брать события
  // его экспрессов, останутся почти одни выигрыши. Поэтому у бота по событиям считаются только ординары
  const betLegsN = id => { const b = D.bets.find(x => x.id === id); return b ? b.legs.length : 1; };
  const botParlayLeg = l => l.source === 'bot' && betLegsN(l.betId) > 1;
  const botParlay = b => b.source === 'bot' && b.legs.length > 1;

  const PERIODS = [
    { id: '30', label: '30 дней', days: 30, ctx: 'за 30 дней', prev: 'к пред. 30 дням' },
    { id: '90', label: '3 месяца', days: 90, ctx: 'за 3 месяца', prev: 'к пред. 3 месяцам' },
    { id: 'all', label: 'Все время', days: null, ctx: 'за все время', prev: null },
  ];
  // Описания рынков для матча до 2 побед; в скобках — для матча до 3 побед (Большой шлем, Т21)
  const MARKET_SHORT = { p1: 'победа игрока 1', p2: 'победа игрока 2', h1m: 'игрок 1 — 2:0 (3:0, 3:1)', h2m: 'игрок 2 — 2:0 (3:0, 3:1)', h1p: 'игрок 1 — хотя бы сет (два)', h2p: 'игрок 2 — хотя бы сет (два)',
    // Р28: новые рынки — для сравнения, ставки по ним — свои
    shcp: 'только матчи до 3 побед · для сравнения', stot: 'число сетов против линии · для сравнения', ghcp: 'разница геймов с форой · для сравнения', gtot: 'сумма геймов против линии · для сравнения' };
  const MARKETS = D.markets.filter(m => D.allLegs.some(l => l.market === m.id));
  const mLabel = id => (D.markets.find(m => m.id === id) || { label: id }).label;
  const SURF_KEYS = Object.keys(D.surfaces);

  // ---------- состояние фильтров (живет между перерисовками) ----------
  // source — источник ставок (В5): приложение, старый бот или все; ставки бота входят в банк и ROI,
  // но не в CLV, Brier против рынка и калибровку p_final (под фильтром «бот» калибровка — по p_claude бота)
  const SOURCES = [{ value: 'all', label: 'Все источники' }, { value: 'app', label: 'Приложение' }, { value: 'bot', label: 'Старый бот' }];
  // Р29: вид ставки — экспресс стратегии, ординар из вариантов анализа, своя ставка. По умолчанию все: так сходится банк.
  // Версии стратегии в «Обучении модели» сравниваются только по экспрессам стратегии
  const KINDS = [{ value: 'all', label: 'Все ставки' }, { value: 'strategy', label: 'Стратегия' }, { value: 'single', label: 'Ординары' }, { value: 'own', label: 'Свои' }];
  const DEFAULTS = { period: 'all', market: 'all', surface: 'all', source: 'all', kind: 'all' };
  const state = Object.assign({}, DEFAULTS);
  try {
    const saved = JSON.parse(sessionStorage.getItem('capper.analytics') || 'null');
    if (saved) {
      if (PERIODS.some(p => p.id === saved.period)) state.period = saved.period;
      if (saved.market === 'all' || MARKETS.some(m => m.id === saved.market)) state.market = saved.market;
      if (saved.surface === 'all' || SURF_KEYS.includes(saved.surface)) state.surface = saved.surface;
      if (SOURCES.some(x => x.value === saved.source)) state.source = saved.source;
      if (KINDS.some(x => x.value === saved.kind)) state.kind = saved.kind;
    }
  } catch (e) { /* хранилище недоступно — работаем в памяти */ }
  const save = () => { try { sessionStorage.setItem('capper.analytics', JSON.stringify(state)); } catch (e) { /* ок */ } };
  const isDefault = () => state.period === DEFAULTS.period && state.market === 'all' && state.surface === 'all' && state.source === 'all' && state.kind === 'all';

  // ---------- расчеты (формулы как в data.js) ----------
  const won = l => (l.result === 'win' ? 1 : 0);
  // Рынок при прогнозе без маржи (В2): кэфы обеих сторон у вашего букмекера, степенной метод (Т3, ml/market.py)
  // Этап 5: рынок закрытия — две стороны, внесенные вами (q_close), или кэфы П1/П2 из архива tennis-data (q_arch, Т1)
  const closeQ = l => (l.qClose != null ? l.qClose : l.qArch != null ? l.qArch : null);
  const mq = (l, ref) => (ref === 'close' ? closeQ(l) : l.q);
  const marketQ = l => l.q;
  const legClv = l => (l.closing ? (l.odds / l.closing - 1) * 100 : null);
  // «CLV без маржи» = кэф × q_close − 1 — только у событий с двумя сторонами закрытия (В1)
  const fairClv = l => (l.qClose != null ? (l.odds * l.qClose - 1) * 100 : null);
  // События для Brier против рынка — ноги ставок приложения с итоговой вероятностью p_final и рынком при прогнозе
  const withMarket = (legs, ref) => legs.filter(l => mq(l, ref) != null && l.pKind === 'final');
  // Калибровка и Brier (этап 5, В3 этапа 4): по умолчанию — все мои прогнозы с исходом, не только ноги ставок
  let sample = 'all', brierRef = null;
  try { const v = sessionStorage.getItem('capper.analytics.sample'); if (v === 'legs' || v === 'all') sample = v; } catch (e) { /* ок */ }

  // 95% доверительный интервал бутстрэпом с фиксированным сидом (как в коде: B = 10 000, здесь 1 000 — макету хватает)
  function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function boot(n, stat, B = 1000) {
    if (n < 2) return null;
    const rnd = rng(20261007), vals = [], idx = new Array(n);
    for (let b = 0; b < B; b++) { for (let i = 0; i < n; i++) idx[i] = Math.floor(rnd() * n); vals.push(stat(idx)); }
    vals.sort((a, b) => a - b);
    return [vals[Math.floor(B * 0.025)], vals[Math.ceil(B * 0.975) - 1]];
  }
  const meanCi = xs => boot(xs.length, idx => idx.reduce((a, i) => a + xs[i], 0) / idx.length);
  const roiCiBets = bs => boot(bs.length, idx => { let p = 0, st = 0; idx.forEach(i => { p += bs[i].profit; st += bs[i].stake; }); return st ? p / st * 100 : 0; });
  const roiCiLegs = ls => meanCi(ls.map(l => (won(l) ? l.odds - 1 : -1) * 100));

  function brier(legs, ref) {
    legs = withMarket(legs, ref);
    if (!legs.length) return { model: null, market: null, n: 0, ci: null };
    const d = legs.map(l => (l.p - won(l)) ** 2 - (mq(l, ref) - won(l)) ** 2);
    return { model: sum(legs, l => (l.p - won(l)) ** 2) / legs.length, market: sum(legs, l => (mq(l, ref) - won(l)) ** 2) / legs.length, n: legs.length, ci: meanCi(d) };
  }
  function summarize(bets) {
    const wins = bets.filter(b => b.status === 'win').length;
    const losses = bets.filter(b => b.status === 'loss').length;
    const voids = bets.filter(b => b.status === 'void').length;
    const turnover = sum(bets, b => b.stake), profit = sum(bets, b => b.profit);
    // без закрывающего кэфа CLV не посчитать; ставки старого бота в CLV не входят (В5)
    const withClv = bets.filter(b => b.clv != null && b.source !== 'bot');
    return {
      n: bets.length, wins, losses, voids, turnover, profit,
      singles: bets.filter(b => b.legs.length === 1).length,
      bot: bets.filter(b => b.source === 'bot').length,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: withClv.length ? sum(withClv, b => b.clv) / withClv.length : null,
      clvPos: withClv.filter(b => b.clv > 0).length,
      clvN: withClv.length,
      clvs: withClv.map(b => b.clv),
    };
  }
  // ДИ считаются отдельно (бутстрэп дорогой) и только для текущей выборки
  function withCi(sm, bets) { return Object.assign(sm, { roiCi: roiCiBets(bets.filter(b => b.status !== 'void')), clvCi: meanCi(sm.clvs) }); }
  // ROI по срезу (Р21): каждое событие — как виртуальный ординар на равную сумму; у срезов — 95% ДИ
  function groupLegs(legs, keyFn, labelFn) {
    const g = {};
    legs.forEach(l => { const k = keyFn(l); (g[k] = g[k] || []).push(l); });
    return Object.entries(g).map(([k, ls]) => {
      const cl = ls.filter(l => l.closing);
      return {
        key: k, label: labelFn ? labelFn(k) : k, n: ls.length,
        roi: Math.round(sum(ls, l => (won(l) ? l.odds - 1 : -1)) / ls.length * 1000) / 10,
        ci: roiCiLegs(ls),
        winrate: Math.round(ls.filter(won).length / ls.length * 1000) / 10,
        avgOdds: sum(ls, l => l.odds) / ls.length,
        clv: cl.length ? sum(cl, legClv) / cl.length : null,
      };
    });
  }
  const oddsBucket = o => (o < 1.3 ? '1.13–1.29' : o < 1.5 ? '1.30–1.49' : o < 1.65 ? '1.50–1.64' : '1.65–1.80');
  // Диапазоны итогового кэфа — как в таблице ставок стратегии (Т20): четвертый, 3.25–4.10, — экспресс из 3 событий
  const TOTAL_BUCKETS = D.strategy.stakeTable.map(r => r.range);
  const totalBucket = k => (k < 1.71 ? TOTAL_BUCKETS[0] : k < 2.21 ? TOTAL_BUCKETS[1] : k < 3.25 ? TOTAL_BUCKETS[2] : TOTAL_BUCKETS[3]);
  function groupTotals(bets) {
    const g = {};
    TOTAL_BUCKETS.forEach(k => { g[k] = []; });
    bets.forEach(b => { const k = totalBucket(b.total); g[k].push(b); });
    return Object.entries(g).map(([k, bs]) => {
      const st = sum(bs, b => b.stake), pr = sum(bs, b => b.profit);
      return { key: k, label: k, n: bs.length, stake: st, profit: pr, roi: st ? Math.round(pr / st * 1000) / 10 : 0, ci: roiCiBets(bs.filter(b => b.status !== 'void')) };
    });
  }
  // Калибровка: p — итоговая вероятность (p_final), в таблице рядом p_base и p_claude (Т9). Под фильтром «бот» — p_claude бота
  function calibration(legs) {
    const out = [];
    for (let lo = 0.5; lo < 0.95; lo += 0.05) {
      const hi = lo + 0.05;
      const bin = legs.filter(l => l.p >= lo && l.p < hi);
      if (!bin.length) continue;
      const avg = f => { const xs = bin.filter(l => f(l) != null); return xs.length ? sum(xs, f) / xs.length : null; };
      out.push({ lo: Math.round(lo * 100) / 100, hi: Math.round(hi * 100) / 100, p: sum(bin, l => l.p) / bin.length, pb: avg(l => l.pb), pc: avg(l => l.pc), actual: bin.filter(won).length / bin.length, n: bin.length });
    }
    return out;
  }
  // Диапазон, где прогноз дальше всего от факта в любую сторону
  const calibWorst = bins => bins.reduce((w, b) => (!w || Math.abs(b.p - b.actual) > Math.abs(w.p - w.actual) ? b : w), null);
  function rolling(legs, ref) {
    legs = withMarket(legs, ref);
    const out = [];
    for (let i = 29; i < legs.length; i += 3) {
      const w = legs.slice(i - 29, i + 1);
      out.push({ date: w[w.length - 1].date, model: sum(w, l => (l.p - won(l)) ** 2) / 30, market: sum(w, l => (mq(l, ref) - won(l)) ** 2) / 30 });
    }
    return out;
  }
  // Р21: реальные экспрессы против тех же событий ординарами на равную сумму. Парный бутстрэп по ставкам:
  // разница ROI считается на одной и той же выборке. Экспрессы старого бота не входят целиком — ни в экспрессы,
  // ни в ординары: исходы событий у него известны только у выигранных (Т10), и любая их часть завысила бы результат
  function parlayVsSingles(bets) {
    const all = bets.filter(b => b.legs.length > 1 && b.status !== 'void');
    const ex = all.filter(b => !botParlay(b));
    const botN = all.length - ex.length;
    const legsOf = b => b.legs.filter(l => l.result === 'win' || l.result === 'loss');
    if (!ex.length) return botN ? { n: 0, botN } : null;
    const exRoi = idx => { let p = 0, st = 0; idx.forEach(i => { p += ex[i].profit; st += ex[i].stake; }); return st ? p / st * 100 : 0; };
    const sgRoi = idx => { let r = 0, n = 0; idx.forEach(i => legsOf(ex[i]).forEach(l => { r += won(l) ? l.odds - 1 : -1; n++; })); return n ? r / n * 100 : 0; };
    const idxAll = ex.map((_, i) => i);
    const legsN = sum(ex, b => legsOf(b).length);
    return {
      n: ex.length, legsN, botN,
      exRoi: exRoi(idxAll), exCi: boot(ex.length, exRoi), exProfit: sum(ex, b => b.profit),
      sgRoi: sgRoi(idxAll), sgCi: boot(ex.length, sgRoi),
      diff: exRoi(idxAll) - sgRoi(idxAll), diffCi: boot(ex.length, idx => exRoi(idx) - sgRoi(idx)),
    };
  }
  function bankAt(d) { let v = D.bankHistory[0].bank; for (const p of D.bankHistory) { if (p.date <= d) v = p.bank; else break; } return v; }

  function compute() {
    const p = PERIODS.find(x => x.id === state.period) || PERIODS[2];
    const anchor = p.days ? addDays(TODAY, -p.days) : firstDate(); // начало периода (не включительно)
    const betOf = id => D.bets.find(b => b.id === id);
    const srcOk = x => (state.source === 'all' || x.source === state.source)
      && (state.kind === 'all' || D.betKind(x.legs ? x : betOf(x.betId) || {}) === state.kind);
    // события экспрессов старого бота в разрезы не входят — ни без исхода, ни выигранные (Т10, см. botParlayLeg)
    const legOk = (l, from, to, ignore) => l.date > from && l.date <= to && srcOk(l) && !botParlayLeg(l)
      && (ignore === 'market' || state.market === 'all' || l.market === state.market)
      && (ignore === 'surface' || state.surface === 'all' || l.surface === state.surface);
    const betOk = (b, from, to) => b.date > from && b.date <= to && srcOk(b)
      && (state.surface === 'all' || b.surface === state.surface)
      && (state.market === 'all' || b.legs.some(l => l.market === state.market));
    const legs = D.allLegs.filter(l => legOk(l, anchor, TODAY));
    const SETTLED = settled();
    const bets = SETTLED.filter(b => betOk(b, anchor, TODAY));
    let prev = null;
    if (p.days) {
      const pa = addDays(anchor, -p.days);
      if (pa >= firstDate()) prev = summarize(SETTLED.filter(b => betOk(b, pa, anchor)));
    }
    // Калибровка (В3): ноги рассчитанных ставок; p_final — только у ставок приложения, у бота — p_claude его ординаров
    // Прогнозы без ставки (матчи из анализов с исходом из архива) — только у приложения
    const preds = state.source === 'bot' || state.kind !== 'all' ? [] : (D.predictions || []).filter(l => l.date > anchor && l.date <= TODAY
      && (state.market === 'all' || l.market === state.market) && (state.surface === 'all' || l.surface === state.surface));
    const own = state.source === 'bot' ? legs : legs.filter(l => l.pKind === 'final');
    const calibLegs = sample === 'all' && state.source !== 'bot' ? own.concat(preds) : own;
    const evLegs = (sample === 'all' ? legs.concat(preds) : legs).slice().sort((a, b) => a.date.localeCompare(b.date));
    return {
      p, anchor, legs, bets, prev, calibLegs, preds, evLegs,
      // события экспрессов бота за период, которые не считаются по отдельности (с исходом и без)
      botParlayLegs: D.allLegs.filter(l => botParlayLeg(l) && l.date > anchor && srcOk(l)).length,
      // Разрез по измерению не сужается фильтром этого же измерения — выбранное значение подсвечивается
      legsAllMarkets: D.allLegs.filter(l => legOk(l, anchor, TODAY, 'market')),
      legsAllSurfaces: D.allLegs.filter(l => legOk(l, anchor, TODAY, 'surface')),
      sum: withCi(summarize(bets), bets), brier: brier(legs), r21: parlayVsSingles(bets),
      filtered: state.market !== 'all' || state.surface !== 'all' || state.source !== 'all',
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
    @media (max-width: 960px) { .analytics-chip-btn { height: 40px; padding: 0 12px; } }
    @media (max-width: 720px) {
      .analytics-filters { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 12px; gap: 12px; }
      .analytics-filter-period { grid-column: 1 / -1; }
      .analytics-filter-period .segmented { display: flex; width: 100%; }
      .analytics-filter-period .segmented button { flex: 1 1 0; padding: 6px 4px; }
      .analytics-filters .field { width: auto; }
      .analytics-filter-reset { grid-column: 1 / -1; justify-self: start; }
      .analytics-scope { grid-column: 1 / -1; padding-top: 10px; }
    }
    /* узкий телефон: фильтры в одну колонку, чтобы значения («Все рынки», «Старый бот») не обрезались */
    @media (max-width: 420px) { .analytics-filters { grid-template-columns: minmax(0, 1fr); } }

    .analytics-fresh-prog { display: flex; flex-direction: column; gap: 4px; min-width: 110px; }
    .analytics-fresh-val { display: inline-flex; flex-direction: column; align-items: flex-end; }
    .analytics-fresh-list { display: none; list-style: none; margin: 0; padding: 0; flex-direction: column; gap: 10px; }
    .analytics-fresh-list li { display: flex; flex-direction: column; gap: 6px; padding: 10px 0; border-top: 1px solid var(--line); }
    .analytics-fresh-list li:first-child { border-top: 0; padding-top: 0; }
    .analytics-fresh-nums { display: flex; gap: 16px; font-size: var(--fs-sm); }
    @media (max-width: 720px) { .analytics-fresh-table { display: none; } .analytics-fresh-list { display: flex; } }
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
    .analytics-mdesc { font-size: var(--fs-xs); color: var(--fg-3); }
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
    .analytics-check { display: flex; flex-direction: column; gap: 4px; }
    .analytics-check .check { min-height: 40px; align-items: center; }
    .analytics-strip.analytics-strip-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .analytics-strip-2 dd { white-space: normal; }
    .analytics-sample { align-self: flex-start; max-width: 100%; }
    @media (max-width: 720px) {
      .analytics-sample { align-self: stretch; display: flex; }
      .analytics-sample button { flex: 1 1 auto; padding-inline: 8px; }
    }
    .analytics-sample button:disabled { opacity: .55; cursor: not-allowed; }
    /* Р21: экспрессы против тех же событий ординарами */
    .analytics-r21-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .analytics-r21-side { background: var(--surface); padding: 12px 14px; min-width: 0; display: flex; flex-direction: column; gap: 3px; align-items: flex-start; }
    .analytics-r21-l { font-size: var(--fs-xs); color: var(--fg-2); }
    .analytics-r21-v { font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.02em; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .analytics-r21-s { font-size: var(--fs-xs); color: var(--fg-3); }
    .analytics-r21-side .chip { margin-top: 4px; }
    @media (max-width: 720px) { .analytics-r21-grid { grid-template-columns: minmax(0, 1fr); } }
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
  // 95% ДИ: «−8…+16%»; интервал задевает ноль — разница в пределах шума
  const sgn0 = v => { const r = Math.round(v); return (r > 0 ? '+' : r < 0 ? '−' : '') + Math.abs(r); };
  const ciPct = ci => (ci ? sgn0(ci[0]) + '…' + sgn0(ci[1]) + '%' : '—');
  const ciPct1 = ci => (ci ? fmt.signedPct(ci[0]) + '…' + fmt.signedPct(ci[1]) : '—');
  const ciDec3 = ci => (ci ? signedDec(ci[0], 3) + '…' + signedDec(ci[1], 3) : '—');
  const noisy = ci => !ci || (ci[0] <= 0 && ci[1] >= 0);
  const ciCell = ci => h('span', { class: 'analytics-nowrap muted', title: '95% доверительный интервал' }, ciPct(ci));
  const roiCiCell = g => h('span', { style: 'display:inline-flex;flex-direction:column;align-items:flex-end;gap:2px' },
    roiText(g.roi), h('span', { class: 'analytics-nowrap muted xsmall', title: '95% доверительный интервал' }, ciPct(g.ci)));

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
          label: g.label, value: g.roi, color, note: nEv(g.n), ci: g.ci,
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
    const sourceField = UI.field({
      id: 'analytics-source', label: 'Источник', value: state.source, options: SOURCES,
      attrs: { on: { change: e => { state.source = e.target.value; onChange(); } } },
    });
    const kindField = UI.field({
      id: 'analytics-kind', label: 'Вид ставки', value: state.kind, options: KINDS,
      attrs: { on: { change: e => { state.kind = e.target.value; onChange(); } } },
    });
    const reset = button('Сбросить фильтры', { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { Object.assign(state, DEFAULTS); onChange(true); }, attrs: { class: 'btn ghost sm analytics-filter-reset' } });
    const scope = h('div', { class: 'analytics-scope', 'aria-live': 'polite' });
    const el = h('section', { class: 'analytics-filters', 'aria-label': 'Фильтры: применяются ко всем блокам ниже' },
      periodBox, h('div', { class: 'analytics-filter' }, marketField), h('div', { class: 'analytics-filter' }, surfaceField), h('div', { class: 'analytics-filter' }, sourceField), h('div', { class: 'analytics-filter' }, kindField), reset, scope);

    function sync(s, periodChanged) {
      marketField.querySelector('select').value = state.market;
      surfaceField.querySelector('select').value = state.surface;
      sourceField.querySelector('select').value = state.source;
      kindField.querySelector('select').value = state.kind;
      if (periodChanged) drawPeriod();
      reset.hidden = isDefault();
      UI.clear(scope);
      const dates = s.bets.map(b => b.date).sort();
      const range = dates.length ? ' · ' + (dates[0] === dates[dates.length - 1] ? fmt.date(dates[0]) : fmt.date(dates[0]) + ' – ' + fmt.date(dates[dates.length - 1])) : '';
      const chips = [];
      if (state.market !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по рынку', on: { click: () => { state.market = 'all'; onChange(); } } }, 'Рынок: ' + mLabel(state.market), icon('x')));
      if (state.surface !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по покрытию', on: { click: () => { state.surface = 'all'; onChange(); } } }, 'Покрытие: ' + D.surfaces[state.surface].label, icon('x')));
      if (state.kind !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по виду ставки', on: { click: () => { state.kind = 'all'; onChange(); } } }, 'Вид: ' + KINDS.find(x => x.value === state.kind).label, icon('x')));
      if (state.source !== 'all') chips.push(h('button', { type: 'button', class: 'chip accent analytics-chip-btn', title: 'Убрать фильтр по источнику', on: { click: () => { state.source = 'all'; onChange(); } } }, 'Источник: ' + SOURCES.find(x => x.value === state.source).label, icon('x')));
      UI.append(scope, [
        h('span', null, 'В выборке ', h('b', null, nBets(s.sum.n)), ' и ', h('b', null, nEv(s.legs.length)), range),
        chips,
        s.sum.bot > 0 && state.source === 'all' && h('span', { class: 'muted xsmall' }, 'из них ' + nBets(s.sum.bot) + ' старого бота — в банке и ROI, но не в CLV, Brier и калибровке'),
        s.botParlayLegs > 0 && h('span', { class: 'muted xsmall' }, nEv(s.botParlayLegs) + ' из экспрессов старого бота не считаются по отдельности: бот записывал их исходы только у выигранных экспрессов'),
        state.kind === 'all' && h('span', { class: 'muted xsmall' }, 'ординары и свои ставки — в банке, калибровке и CLV; версии стратегии сравниваются только по ее экспрессам (фильтр «Стратегия»)'),
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
    // 95% ДИ у ROI и CLV (бутстрэп по ставкам): на сотне ставок ROI гуляет на ±20 п.п.
    const roi = { label: 'ROI', icon: 'coins', value: c.roi == null ? '—' : fmt.signedPct(c.roi), hint: 'ДИ ' + ciPct(c.roiCi) };
    if (pv && pv.roi != null && c.roi != null) Object.assign(roi, { delta: deltaPP(c.roi - pv.roi), trend: trendOf(Math.round((c.roi - pv.roi) * 10)), hint: 'ДИ ' + ciPct(c.roiCi) + ' · ' + s.p.prev });
    const wr = { label: 'Винрейт', icon: 'trophy', value: c.winrate == null ? '—' : fmt.pct(c.winrate), hint: c.wins + ' В · ' + c.losses + ' П' + (c.voids ? ' · ' + c.voids + ' возвр.' : '') };
    const clv = { label: 'Средний CLV', icon: 'bolt', value: c.clv == null ? '—' : fmt.signedPct(Math.round(c.clv * 10) / 10), hint: c.clvN ? 'ДИ ' + ciPct1(c.clvCi) + ' · лучше закрытия в ' + c.clvPos + ' из ' + c.clvN : c.n && c.bot === c.n ? 'у старого бота не считается' : 'нет закрывающих кэфов' };
    if (pv && pv.clv != null && c.clv != null) Object.assign(clv, { delta: deltaPP(c.clv - pv.clv), trend: trendOf(Math.round((c.clv - pv.clv) * 10)) });
    const b = s.brier;
    const br = { label: 'Brier модели', icon: 'target', value: b.model == null ? '—' : fmt.dec(b.model, 3), hint: b.model == null ? 'нет событий с рынком при прогнозе' : null };
    if (b.model != null) {
      const diff = b.model - b.market;
      Object.assign(br, { delta: (Math.round(diff * 1000) === 0 ? '0,000' : signedDec(diff, 3)) + ' к рынку', trend: trendOf(Math.round(diff * 1000)), good: false, hint: 'рынок при прогнозе ' + fmt.dec(b.market, 3) + (noisy(b.ci) ? ' · в пределах шума' : '') });
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
    let values, base, invested = null;
    // В7 этапа 5: старт периода — капитал на начало периода (за все время — первое пополнение); пунктир «вложено» —
    // ступенькой: старт плюс пополнения минус выводы внутри периода
    const flows = isBank ? D.bankFlows.filter(f => !f.start && f.at.slice(0, 10) > s.anchor && f.at.slice(0, 10) <= TODAY) : [];
    if (isBank) { values = dates.map(bankAt); base = bankAt(s.anchor); const i0 = D.investedAt(s.anchor); invested = dates.map(d => base + D.investedAt(d) - i0); }
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
    values.forEach((v, i) => {
      // пополнение сдвигает пик в той же доле, что и банк: просадка — только от ставок (Р22)
      const flow = isBank && i ? invested[i] - invested[i - 1] : 0;
      if (flow) { const before = v - flow; peak = before > 0 ? peak * v / before : v; }
      peak = Math.max(peak, v); if (isBank) maxDD = Math.min(maxDD, (v - peak) / peak * 100); hi = Math.max(hi, v); lo = Math.min(lo, v);
    });
    const flowSum = flows.reduce((a, f) => a + (f.kind === 'withdrawal' ? -f.amount : f.amount), 0);
    const flowLabel = (f, short) => fmt.signedMoney(f.kind === 'withdrawal' ? -f.amount : f.amount) + ' · ' + (f.kind === 'withdrawal' ? 'вывод' : 'пополнение') + (short ? '' : ', ' + fmt.date(f.at));
    const c = s.sum;
    const chart = declutterX(UI.lineChart({
      labels: dates,
      series: [{ name: isBank ? 'Банк' : 'Результат', color: 'var(--s1)', values: values.map(fmt.moneyNum) }]
        .concat(isBank ? [{ name: 'Вложено', color: 'var(--fg-3)', values: invested.map(fmt.moneyNum), dashed: true, step: true, width: 1.5, noEnd: true }] : []),
      area: true, areaBase: isBank ? null : 0, endLabel: true, height: mobile ? 210 : 270,
      marks: flows.map(f => ({ i: dates.indexOf(f.at.slice(0, 10)), label: flowLabel(f, mobile), series: 0 })),
      refLines: isBank ? [] : [{ value: 0 }], yFormat: yf, xFormat: d => fmt.date(d), tipTitle: d => fmt.dateFull(d),
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
      ? [['Старт периода', fmt.money(base), fmt.date(s.anchor) + (s.p.id === 'all' ? ' · первое пополнение' : '')], ['Пополнения', flowSum ? fmt.signedMoney(flowSum) : 'нет', flows.length ? flows.map(f => fmt.date(f.at)).join(', ') : 'за период'], ['Макс. просадка', maxDD < 0 ? fmt.signedPct(maxDD) : '0%', 'от пика, без пополнений'], ['Оборот', fmt.money(c.turnover), nBets(c.n)]]
      : [['Лучшая точка', fmt.signedMoney(hi), null], ['Худшая точка', fmt.signedMoney(Math.min(0, lo)), null], ['Оборот', fmt.money(c.turnover), nBets(c.n)], ['ROI', c.roi == null ? '—' : fmt.signedPct(c.roi), null]];
    return card({
      class: 'analytics-card',
      title: isBank ? 'Банк по дням' : 'Результат отобранных ставок',
      subtitle: isBank ? s.p.ctx[0].toUpperCase() + s.p.ctx.slice(1) + ', ' + fmt.cur() + ' на конец дня' : 'Нарастающим итогом, ' + fmt.cur() + ' · банк целиком виден без фильтров рынка и покрытия',
      actions: [chip(fmt.signedMoney(c.profit), c.profit > 0 ? 'good' : c.profit < 0 ? 'bad' : 'outline', c.profit > 0 ? 'arrowUp' : c.profit < 0 ? 'arrowDown' : null)],
      body: [
        UI.legend(isBank
          ? [{ name: 'Банк на конец дня', color: 'var(--s1)' }, { name: 'Вложено: старт ' + fmt.money(base) + (flowSum ? ' и пополнения' : ''), type: 'dash' }]
          : [{ name: 'Прибыль нарастающим итогом', color: 'var(--s1)' }, { name: 'Ноль', type: 'dash' }]),
        UI.withTable(chart, tableFactory),
        h('dl', { class: 'analytics-strip' }, strip.map(([k, v, sub]) => h('div', null, h('dt', null, k), h('dd', null, v, sub && h('small', null, sub))))),
        howto(h('b', null, 'Как читать: '), isBank ? 'линия банка выше пунктира «вложено» — ставки в плюсе на любом участке; пополнение поднимает пунктир ступенькой и в прибыль не входит. Главное число периода — прибыль ставок (вверху справа), а не рост банка. ' : 'выше нуля — отобранные ставки в плюсе. ', hover() + (UI.isMobile() ? ' графика' : ' график') + ', чтобы увидеть значение на любой день.'),
      ],
    });
  }

  // ---------- выводы (считает код, до трех) ----------
  function insightList(s) {
    const out = [];
    // 1. Калибровка: диапазон с достаточной выборкой, где прогноз дальше всего от факта (переоценка или недооценка)
    const bins = calibration(s.calibLegs).filter(b => b.n >= CALIB_N);
    const worst = calibWorst(bins);
    if (worst && Math.abs(worst.p - worst.actual) >= CALIB_GAP) {
      const over = worst.p > worst.actual, gap = Math.round(Math.abs(worst.p - worst.actual) * 100);
      const range = pctRange(worst.lo, worst.hi);
      out.push({ id: 'calib-' + range, tone: 'warn', ic: 'target', title: [over ? 'Переоценка фаворитов в диапазоне ' : 'Недооценка в диапазоне ', nowrap(range)],
        text: 'Модель давала в среднем ' + fmt.prob(worst.p) + ', а сыграло ' + fmt.prob(worst.actual) + ' — на ' + gap + ' п.п. ' + (over ? 'меньше. Валуй в этом диапазоне, вероятно, завышен.' : 'больше. Модель здесь занижает шансы — часть выгодных ставок, вероятно, отсеивается.'),
        basis: nEv(worst.n), action: 'calib' });
    } else if (bins.length) {
      out.push({ id: 'calib-ok', tone: 'good', ic: 'check', title: 'Калибровка в норме',
        text: 'Ни в одном диапазоне с ' + CALIB_N + '+ событиями прогноз не расходится с фактом на ' + Math.round(CALIB_GAP * 100) + ' п.п. и больше — ни вверх, ни вниз.', basis: nEv(sum(bins, b => b.n)) });
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
    // 4. Модель против рынка при прогнозе (В2): с ДИ разницы; задевает ноль — «в пределах шума»
    if (s.brier.n >= 20) {
      const diff = s.brier.model - s.brier.market, noise = noisy(s.brier.ci);
      out.push({ id: 'brier', tone: 'accent', ic: 'bolt', title: noise ? 'Модель на уровне рынка' : diff < 0 ? 'Модель точнее рынка' : 'Рынок пока точнее модели',
        text: 'Brier ' + fmt.dec(s.brier.model, 3) + ' против ' + fmt.dec(s.brier.market, 3) + ' у рынка при прогнозе, 95% ДИ разницы ' + ciDec3(s.brier.ci) + (noise ? ' — в пределах шума.' : '.') + (s.sum.clvN ? ' Надежнее смотреть на CLV: ' + fmt.signedPct(Math.round(s.sum.clv * 10) / 10) + ' в среднем, лучше закрытия в ' + s.sum.clvPos + ' из ' + s.sum.clvN + '.' : ''),
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

  function explainModal() {
    UI.modal({
      title: 'Brier и CLV простыми словами',
      body: [
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'Brier — точность вероятностей'),
          h('p', { class: 'small soft' }, 'Для каждого события берется (прогноз − исход)², где исход — 1 или 0, и усредняется. Прогноз 80% на сыгравшее событие дает 0,04, на не сыгравшее — 0,64. 0 — идеально, 0,25 — как всегда ставить 50%. Ниже — лучше.')),
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'С каким рынком сравниваем'),
          h('p', { class: 'small soft' }, 'С рынком в момент прогноза: кэфы обеих сторон у вашего букмекера, маржа снята степенным методом. Это честное сравнение — модель и рынок знали одно и то же. Где внесены обе стороны закрывающего кэфа, ниже показан и рынок закрытия. Разница в тысячные доли на сотне событий — шум: смотрите на доверительный интервал разницы.')),
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'CLV — качество цены'),
          h('p', { class: 'small soft' }, 'CLV = ваш кэф ÷ закрывающий − 1. Закрывающий кэф вносите вы: эталона (' + D.marketRefRule + ') или своего букмекера. Взяли 1.62, к началу матча стало 1.55 — CLV +4,5%. Так CLV немного завышен: в закрывающем кэфе есть маржа, честный кэф выше. Точнее — CLV без маржи: ваш кэф × вероятность рынка закрытия − 1, если внесена и вторая сторона закрытия. Результат одной ставки — случайность, а стабильно положительный CLV — устойчивый признак преимущества. Его видно уже через 50–100 ставок, ROI — через сотни.')),
        h('div', { class: 'stack', style: 'gap:6px' }, h('h4', null, 'Доверительный интервал'),
          h('p', { class: 'small soft' }, '95% ДИ — где с высокой вероятностью лежит настоящее значение. Если интервал ROI или разницы с рынком задевает ноль, преимущество пока не доказано: это может быть везение.')),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  function insightsCard(s) {
    const list = insightList(s);
    const TONE_LABEL = { warn: 'Внимание', bad: 'Риск', info: 'Мало данных', accent: 'Наблюдение', good: 'В норме' };
    const actionOf = ins => {
      if (ins.action === 'calib') return button('К калибровке', { kind: 'secondary', size: 'sm', icon: 'target', onClick: () => { const el = document.getElementById('analytics-calib'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
      if (ins.action === 'bets') return button('Открыть ставки', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#bets' });
      if (ins.action === 'filter') return button('Показать только ' + ins.label, { kind: 'secondary', size: 'sm', icon: 'filter', onClick: () => { state[ins.dim] = ins.key; update(); scrollToFilters(); UI.toast('Фильтр: ' + ins.label, 'filter'); } });
      if (ins.action === 'widen') return button('Показать за все время', { kind: 'secondary', size: 'sm', icon: 'calendar', onClick: () => { state.period = 'all'; update(true); } });
      if (ins.action === 'clear') return button('Снять фильтры', { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => { state.market = 'all'; state.surface = 'all'; state.source = 'all'; update(); } });
      if (ins.action === 'explain') return button('Что это значит', { kind: 'secondary', size: 'sm', icon: 'book', onClick: explainModal });
      return null;
    };
    return card({
      class: 'analytics-card analytics-ins-card',
      title: 'Выводы',
      subtitle: 'Считает код по рассчитанным ставкам ' + s.p.ctx + ', без запроса к ИИ',
      actions: [chip('Обновлено ' + fmt.date(settled().map(b => b.date).sort().pop()), 'outline', 'clock')],
      body: list.length
        ? h('ol', { class: 'analytics-ins', 'aria-label': 'Выводы', style: { '--ins-n': String(list.length) } }, list.map(ins => h('li', null,
          h('span', { class: ['analytics-ins-ic', ins.tone], 'aria-hidden': 'true' }, icon(ins.ic)),
          h('div', { class: 'analytics-ins-body' },
            h('span', { class: 'sr-only' }, TONE_LABEL[ins.tone] + ': '),
            h('div', { class: 'analytics-ins-title' }, ins.title),
            h('div', { class: 'analytics-ins-text' }, ins.text),
            h('div', { class: 'analytics-ins-foot' }, chip('Основание: ' + ins.basis, 'outline'), actionOf(ins))))))
        : UI.empty('Слишком мало событий для выводов — нужно хотя бы 20.'),
      foot: [
        h('span', { class: 'xsmall muted', style: 'min-width:0;flex:1 1 200px' }, 'Это наблюдения по истории, а не гарантии. Гипотезы из разборов ставок и их проверка на архиве — в «Обучении модели».'),
      ],
    });
  }

  // ---------- ROI по срезам ----------
  function surfaceCard(s) {
    const groups = groupLegs(s.legsAllSurfaces, l => l.surface, k => D.surfaces[k].label).sort((a, b) => SURF_KEYS.indexOf(a.key) - SURF_KEYS.indexOf(b.key));
    const missing = SURF_KEYS.filter(k => !groups.some(g => g.key === k));
    return card({
      class: 'analytics-card', title: 'ROI по покрытиям', subtitle: 'События как ординары на равную сумму · линия — 95% ДИ',
      actions: [chip(nEv(sum(groups, g => g.n)), 'outline')],
      body: [
        groups.length ? UI.withTable(roiBars(groups, { colorOf: k => D.surfaces[k].color, selected: state.surface }), () => tableBox(mtable({
          columns: [
            // На телефоне, как в приложении: число событий — под покрытием, ДИ — второй строкой
            // под ROI, а не отдельными колонками (иначе таблица не помещается в 360 px)
            { key: 'label', label: 'Покрытие', render: g => UI.isMobile()
              ? h('span', { style: 'display:inline-flex;flex-direction:column;align-items:flex-start;gap:2px' }, UI.surfaceChip(g.key), h('span', { class: 'muted xsmall' }, nEv(g.n)))
              : UI.surfaceChip(g.key) },
            { key: 'n', label: 'Событий', align: 'r', hideMobile: true },
            { key: 'winrate', label: 'Винрейт', align: 'r', render: g => fmt.pct(g.winrate) },
            { key: 'avgOdds', label: nowrap('Ср. кэф'), align: 'r', hideMobile: true, render: g => h('span', { class: 'odds' }, fmt.odds(g.avgOdds)) },
            { key: 'roi', label: UI.isMobile() ? 'ROI · 95% ДИ' : 'ROI', align: 'r', render: g => UI.isMobile() ? roiCiCell(g) : roiText(g.roi) },
            { key: 'ci', label: '95% ДИ', align: 'r', hideMobile: true, render: g => ciCell(g.ci) },
          ], rows: groups,
        }))) : UI.empty('Нет событий за период'),
        (groups.some(g => g.n < SMALL) || missing.length) && h('div', { class: 'stack', style: 'gap:4px' },
          groups.some(g => g.n < SMALL) && smallNote(),
          missing.length && h('div', { class: 'analytics-foot-note', style: 'padding-left:19px' }, h('span', null, missing.map(k => D.surfaces[k].label).join(', ') + ': событий за период нет'))),
        howto(h('b', null, 'Как читать: '), 'каждое событие считается отдельной ставкой одного размера — так видно, где прогнозы точнее, без влияния размера ставки. Полоса вправо — плюс, влево — минус. Линия с засечками — 95% доверительный интервал: если он задевает ноль, плюс может быть везением.'),
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
        howto(h('b', null, 'Как читать: '), 'Ф1(−1.5) — игрок 1 выигрывает 2:0 по сетам (в матче до трех побед — 3:0 или 3:1), Ф2(+1.5) — игрок 2 берет хотя бы сет (до трех побед — два). Линия — 95% ДИ. Подробности и фильтр — в таблице «Сводка по рынкам» ниже.'),
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
            { key: 'ci', label: '95% ДИ', align: 'r', hideMobile: true, render: g => ciCell(g.ci) },
          ], rows: groups,
        }))) : UI.empty('Нет событий за период'),
        groups.some(g => g.n < SMALL) && smallNote(),
        howto(h('b', null, 'Как читать: '), 'высокий винрейт на низких кэфах еще не прибыль: при кэфе 1.25 нужно угадывать 80% только чтобы выйти в ноль. Сравните винрейт с колонкой «Для нуля» в таблице.'),
      ],
    });
  }

  function totalCard(s) {
    const groups = groupTotals(s.bets);
    const row = k => D.strategy.stakeTable.find(x => x.range === k) || {};
    const stakeOf = k => row(k).pct || '—';
    return card({
      class: 'analytics-card', title: 'ROI по итоговому кэфу', subtitle: 'Реальные ставки: прибыль к сумме ставок · диапазоны стратегии',
      actions: [chip(nBets(s.sum.n), 'outline')],
      body: [
        s.bets.length ? UI.withTable(UI.hbars({
          valueFormat: v => fmt.signedPct(v),
          items: groups.map(g => ({ label: g.label, value: g.roi, valueText: g.n ? null : '—', color: 'var(--s1)', note: g.n ? nBets(g.n) : 'ставок нет', ci: g.ci,
            labelNode: [h('i', { style: { width: '8px', height: '8px', borderRadius: '2px', background: 'var(--s1)', flex: 'none' } }), h('span', { style: g.n ? null : 'color:var(--fg-3)' }, g.label), g.n > 0 && g.n < SMALL && smallMark()] })),
        }), () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'Кэф', render: g => h('span', { class: 'odds analytics-nowrap', title: row(g.key).triple ? 'Только экспресс из 3 событий' : null }, g.label) },
            { key: 'n', label: 'Ставок', align: 'r' },
            { key: 'pct', label: 'Ставка', align: 'r', hideMobile: true, render: g => h('span', { class: 'analytics-nowrap', title: 'Размер ставки по таблице стратегии, % банка' }, stakeOf(g.key)) },
            { key: 'profit', label: 'Прибыль', align: 'r', render: g => h('span', { class: roiCls(g.profit), style: 'white-space:nowrap;font-weight:600' }, fmt.signedMoney(g.profit)) },
            { key: 'roi', label: 'ROI', align: 'r', render: g => (g.n ? roiText(g.roi) : '—') },
            { key: 'ci', label: '95% ДИ', align: 'r', hideMobile: true, render: g => ciCell(g.ci) },
          ], rows: groups,
        }))) : UI.empty('Нет ставок за период'),
        groups.some(g => g.n > 0 && g.n < SMALL) && footNote('меньше ' + SMALL + ' ставок — ROI может быть случайным'),
        howto(h('b', null, 'Как читать: '), 'здесь считаются деньги, а не отдельные события. Диапазон 3.25–4.10 — только экспресс из 3 событий. На экспрессы до 1.70 по таблице стратегии идет самая крупная ставка (', stakeOf(TOTAL_BUCKETS[0]), ' банка), поэтому их ROI сильнее всего влияет на банк.'),
      ],
    });
  }

  // Р21: экспрессы против тех же событий ординарами — показывает, помогает ли объединение событий в экспресс
  function parlayCard(s) {
    const r = s.r21;
    const head = { class: 'analytics-card analytics-r21', title: 'Экспрессы и те же события ординарами', subtitle: 'Реальные экспрессы против ординаров на равную сумму по их же событиям' };
    if (!r) return card(Object.assign(head, { body: UI.empty('Экспрессов за период нет.') }));
    const botText = n => n + ' ' + fmt.plural(n, 'экспресс', 'экспресса', 'экспрессов') + ' старого бота ' + fmt.plural(n, 'не входит', 'не входят', 'не входят') + ' в сравнение';
    if (!r.n) return card(Object.assign(head, { body: UI.empty(botText(r.botN) + ': исходы событий бот записывал только у выигранных экспрессов, поэтому честно разложить их на ординары нельзя.') }));
    const side = (label, sub, roi, ci, extra) => h('div', { class: 'analytics-r21-side' },
      h('div', { class: 'analytics-r21-l' }, label), h('div', { class: ['analytics-r21-v', roiCls(roi)] }, fmt.signedPct(roi)),
      h('div', { class: 'analytics-r21-s' }, '95% ДИ ' + ciPct(ci)), h('div', { class: 'analytics-r21-s' }, sub), extra);
    const noise = noisy(r.diffCi);
    return card(Object.assign(head, {
      actions: [chip(r.n + ' ' + fmt.plural(r.n, 'экспресс', 'экспресса', 'экспрессов') + ' · ' + nEv(r.legsN), 'outline')],
      body: [
        h('div', { class: 'analytics-r21-grid' },
          side('Экспрессы', 'реальные деньги: ' + fmt.signedMoney(r.exProfit), r.exRoi, r.exCi),
          side('Те же события ординарами', 'виртуально, каждое на равную сумму', r.sgRoi, r.sgCi),
          h('div', { class: 'analytics-r21-side' },
            h('div', { class: 'analytics-r21-l' }, 'Разница'), h('div', { class: ['analytics-r21-v', noise ? null : roiCls(r.diff)] }, deltaPP(r.diff)),
            h('div', { class: 'analytics-r21-s' }, '95% ДИ ' + ciPct(r.diffCi).replace('%', ' п.п.')),
            chip(noise ? 'В пределах шума' : r.diff > 0 ? 'Экспрессы лучше' : 'Ординары лучше', noise ? 'outline' : r.diff > 0 ? 'good' : 'warn', noise ? 'info' : 'check'))),
        r.botN > 0 && footNote(botText(r.botN) + ' — ни в экспрессы, ни в ординары: исходы событий бот записывал только у выигранных экспрессов, а без проигранных результат был бы завышен.'),
        howto(h('b', null, 'Как читать: '), 'ставим только экспрессы, а ординары по тем же прогнозам считаются виртуально, для сравнения — так видно, сколько съедает маржа в экспрессе. Экспресс выигрывает, только если сыграли все события, ординары приносят деньги по отдельности. Если интервал разницы задевает ноль, данных пока мало, чтобы сказать, что лучше.'),
      ],
    }));
  }

  // ---------- точность ----------
  // Калибровка (В3): по умолчанию все мои прогнозы с исходом из архива (этап 5), переключатель — только ноги ставок.
  // На графике — итоговая вероятность p_final, в таблице рядом базовая модель p_base и после поправки Claude p_claude (Т9)
  function calibrationCard(s, mobile) {
    const bot = state.source === 'bot';
    const legs = s.calibLegs;
    const bins = calibration(legs);
    const setSample = v => { sample = v; try { sessionStorage.setItem('capper.analytics.sample', v); } catch (e) { /* ок */ } if (UI.rerender) { const y = window.scrollY; UI.rerender(); window.scrollTo(0, y); } };
    const sampleSeg = bot ? h('div', { class: 'segmented analytics-sample', role: 'group', 'aria-label': 'Выборка калибровки' }, h('button', { type: 'button', 'aria-pressed': 'true' }, 'Ноги ставок'))
      : UI.segmented({ label: 'Выборка калибровки', items: [{ id: 'all', label: 'Все мои прогнозы · ' + (s.calibLegs.length) }, { id: 'legs', label: 'Только ноги ставок' }], active: sample, onChange: setSample });
    if (!bot) sampleSeg.classList.add('analytics-sample');
    const head = { class: 'analytics-card', id: 'analytics-calib', title: 'Калибровка прогнозов', subtitle: bot ? 'Старый бот: оценка Claude против доли сыгравших событий' : sample === 'all' ? 'Все ваши прогнозы с исходом: ноги ставок и матчи из анализов без ставки (' + s.preds.length + '), исход — из архива tennis-data' : 'Итоговая вероятность модели против доли сыгравших событий' };
    // у бота по событиям считаются только ординары; на паре событий график калибровки ничего не говорит
    if (bot && legs.length < SMALL) return card(Object.assign(head, { actions: [chip(nEv(legs.length), 'outline')], body: [sampleSeg, UI.empty('У старого бота по событиям считаются только ординары — за период их ' + legs.length + '. Для калибровки нужно хотя бы ' + SMALL + ' событий. События его экспрессов не считаются: исходы бот записывал только у выигранных экспрессов, и остались бы почти одни выигрыши.')] }));
    if (!bins.length) return card(Object.assign(head, { body: [sampleSeg, UI.empty('Нет событий за период')] }));
    const vals = bins.flatMap(b => [b.p, b.actual]);
    const d0 = Math.max(0.2, Math.min(0.6, Math.floor(Math.min(...vals) * 10) / 10));
    const chart = UI.calibrationChart({ bins, domain: [d0, 1], height: mobile ? 250 : 280 });
    const big = bins.filter(b => b.n >= CALIB_N);
    const worst = calibWorst(big);
    const gapPP = b => Math.round(Math.abs(b.p - b.actual) * 100);
    // самый заметный диапазон с обратным знаком — чтобы сказать и о нем
    const other = worst && big.filter(b => (b.p > b.actual) !== (worst.p > worst.actual) && Math.abs(b.p - b.actual) >= CALIB_GAP)
      .reduce((w, b) => (!w || Math.abs(b.p - b.actual) > Math.abs(w.p - w.actual) ? b : w), null);
    const dirText = b => (b.p > b.actual ? 'переоценивает фаворитов' : 'недооценивает');
    let insight;
    if (!big.length) {
      insight = UI.callout('', 'info', 'Ни в одном диапазоне нет ' + CALIB_N + '+ событий — по калибровке пока рано делать выводы.');
    } else if (Math.abs(worst.p - worst.actual) >= CALIB_GAP) {
      insight = UI.callout('warn', 'alert', h('b', null, 'Диапазон ' + pctRange(worst.lo, worst.hi) + ': '), 'прогноз ' + fmt.prob(worst.p) + ', сбылось ' + fmt.prob(worst.actual) + ' (' + nEv(worst.n) + '). Модель ' + dirText(worst) + ' на ' + gapPP(worst) + ' п.п.'
        + (other ? ' А в диапазоне ' + pctRange(other.lo, other.hi) + ' — наоборот, ' + dirText(other) + ': ' + fmt.prob(other.p) + ' против ' + fmt.prob(other.actual) + '.' : ''));
    } else {
      insight = UI.callout('good', 'check', 'Во всех диапазонах с ' + CALIB_N + '+ событиями прогноз расходится с фактом меньше чем на ' + Math.round(CALIB_GAP * 100) + ' п.п. — и вверх, и вниз.');
    }
    const probCell = v => (v == null ? '—' : fmt.prob(v));
    return card(Object.assign(head, {
      actions: [chip(nEv(legs.length), 'outline')],
      body: [
        sampleSeg,
        UI.legend([{ name: (bot ? 'Оценка Claude' : 'Модель') + ' · размер точки — число событий', color: 'var(--s1)' }, { name: 'Идеальная калибровка', type: 'dash' }]),
        UI.withTable(chart, () => tableBox(mtable({
          columns: [
            { key: 'r', label: 'Диапазон', render: b => nowrap(pctRange(b.lo, b.hi)) },
            { key: 'n', label: 'Событий', align: 'r', hideMobile: true },
            { key: 'p', label: bot ? 'Claude' : 'Итог', align: 'r', render: b => fmt.prob(b.p) },
            { key: 'pb', label: 'База', align: 'r', hideMobile: true, render: b => (bot ? '—' : probCell(b.pb)) },
            { key: 'pc', label: 'Claude', align: 'r', hideMobile: true, render: b => (bot ? '—' : probCell(b.pc)) },
            { key: 'a', label: 'Факт', align: 'r', render: b => fmt.prob(b.actual) },
            { key: 'd', label: 'Разница, п.п.', align: 'r', render: b => { const d = Math.round((b.actual - b.p) * 100), far = Math.abs(d) >= CALIB_GAP * 100; return h('span', { class: far ? (d < 0 ? 'bad-text' : 'warn-text') : null, style: 'white-space:nowrap', title: far ? (d < 0 ? 'Модель переоценивает этот диапазон' : 'Модель недооценивает этот диапазон') : null }, (d > 0 ? '+' : d < 0 ? '−' : '') + Math.abs(d)); } },
          ], rows: bins,
        }))),
        insight,
        legs.length < 60 && footNote('Меньше 60 событий: точки калибровки сильно скачут, выводы преждевременны.'),
        howto(h('b', null, 'Как читать: '), 'если модель говорит 70%, такие события должны сыграть примерно в 7 из 10 случаев. Точки ниже диагонали — модель переоценивает фаворитов, выше — недооценивает. ',
          bot ? 'У старого бота есть только оценка Claude — ее и показываем, и только по его ординарам: исходы событий в экспрессах бот записывал лишь у выигранных.' : 'В таблице рядом с итоговой вероятностью — базовая модель (Эло и признаки) и оценка после поправки Claude. Ставки старого бота сюда не входят.'),
      ],
    }));
  }

  // Brier модели против рынка (В2): главный ряд — рынок при прогнозе без маржи; закрытие — отдельной строкой там,
  // где внесены обе стороны закрывающего кэфа. Разница — с 95% ДИ; задевает ноль — «в пределах шума»
  function brierCard(s, mobile) {
    // Главный ряд — рынок закрытия, когда событий с закрытием больше, чем с рынком при прогнозе (В2 этапа 4)
    const ev = s.evLegs;
    const nClose = withMarket(ev, 'close').length, nPred = withMarket(ev, 'pred').length;
    const main = nClose > nPred ? 'close' : 'pred';
    const ref = brierRef || main;
    const refName = ref === 'close' ? 'Рынок закрытия' : 'Рынок при прогнозе';
    const pts = rolling(ev, ref);
    const refSeg = UI.segmented({ label: 'С каким рынком сравнивать', items: [{ id: 'pred', label: 'При прогнозе · ' + nPred }, { id: 'close', label: 'Закрытие · ' + nClose }], active: ref,
      onChange: id => { brierRef = id; if (UI.rerender) { const y = window.scrollY; UI.rerender(); window.scrollTo(0, y); } } });
    const head = { class: 'analytics-card', title: 'Brier: модель против рынка', subtitle: (ref === 'close' ? 'Рынок закрытия без маржи: ваши две стороны или кэфы П1/П2 архива tennis-data (момент снятия не проверен)' : 'Рынок при прогнозе, без маржи') + ' · скользящие 30 событий · ниже — лучше' };
    const n = withMarket(ev, ref).length;
    if (state.source === 'bot') return card(Object.assign(head, { body: [UI.empty('У ставок старого бота нет итоговой вероятности модели и рынка в момент прогноза — Brier против рынка по ним не считается.')] }));
    if (pts.length < 2) {
      return card(Object.assign(head, { body: [UI.empty('Для скользящего окна нужно хотя бы 33 события с рынком при прогнозе — сейчас ' + n + '. Расширьте период или снимите фильтры.'), howto(h('b', null, 'Как читать: '), 'Brier — средняя квадратичная ошибка прогноза: 0 — идеально, 0,25 — как всегда ставить 50%.')] }));
    }
    const last = pts[pts.length - 1];
    const better = pts.filter(p => p.model < p.market).length;
    const b = brier(ev, ref), diff = b.model - b.market, noise = noisy(b.ci);
    const verdict = noise
      ? UI.callout('', 'info', h('b', null, 'За период: '), 'модель ' + fmt.dec(b.model, 3) + ', рынок ' + fmt.dec(b.market, 3) + ' — разница ' + signedDec(diff, 3) + ', 95% ДИ ' + ciDec3(b.ci) + ': в пределах шума на ' + onEv(b.n) + '.')
      : diff < 0
        ? UI.callout('good', 'check', h('b', null, 'За период: '), 'модель ' + fmt.dec(b.model, 3) + ' против ' + fmt.dec(b.market, 3) + ' у рынка (' + nEv(b.n) + '), 95% ДИ разницы ' + ciDec3(b.ci) + ' — целиком ниже нуля. Проверьте, держится ли это на новых событиях.')
        : UI.callout('warn', 'alert', h('b', null, 'За период: '), 'рынок точнее: ' + fmt.dec(b.market, 3) + ' против ' + fmt.dec(b.model, 3) + ' у модели (' + nEv(b.n) + '), 95% ДИ разницы ' + ciDec3(b.ci) + '.');
    // Закрытие: только события, где внесены обе стороны закрывающего кэфа (Т13)
    const other = ref === 'close' ? 'pred' : 'close', ob = brier(ev, other);
    const chart = declutterX(UI.lineChart({
      labels: pts.map(p => p.date),
      series: [{ name: 'Модель', color: 'var(--s1)', values: pts.map(p => p.model) }, { name: refName, color: 'var(--s2)', values: pts.map(p => p.market) }],
      height: mobile ? 210 : 280, yFormat: v => fmt.dec(v, 3), xFormat: d => fmt.date(d), tipTitle: d => '30 событий по ' + fmt.date(d),
      ariaLabel: 'Скользящий Brier: модель ' + fmt.dec(last.model, 3) + ', ' + refName.toLowerCase() + ' ' + fmt.dec(last.market, 3),
    }));
    return card(Object.assign(head, {
      actions: [h('span', { class: ['chip', better * 2 >= pts.length ? 'good' : 'warn'], title: 'В скольких окнах по 30 событий Brier модели ниже рыночного' }, icon(better * 2 >= pts.length ? 'check' : 'alert'), 'Точнее рынка: ' + better + ' из ' + pts.length)],
      body: [
        refSeg,
        UI.legend([{ name: 'Модель · сейчас ' + fmt.dec(last.model, 3), color: 'var(--s1)' }, { name: refName + ' · ' + fmt.dec(last.market, 3), color: 'var(--s2)' }]),
        UI.withTable(chart, () => h('div', { class: 'analytics-scroll' }, mtable({
          columns: [
            { key: 'date', label: 'Окно по', render: p => h('span', { style: 'white-space:nowrap' }, fmt.date(p.date)) },
            { key: 'model', label: 'Модель', align: 'r', render: p => fmt.dec(p.model, 3) },
            { key: 'market', label: 'Рынок', align: 'r', render: p => fmt.dec(p.market, 3) },
            { key: 'd', label: 'Разница', align: 'r', render: p => h('span', { class: p.model < p.market ? 'good-text' : p.model > p.market ? 'bad-text' : null }, signedDec(p.model - p.market, 3)) },
          ], rows: pts.slice().reverse(),
        }))),
        verdict,
        // «главный ряд» — у ряда по правилу В2 (main), а не у выбранного переключателем;
        // закрытию, пока оно не главное, — «станет главным, когда закрытий будет больше»
        h('dl', { class: 'analytics-strip analytics-strip-2' },
          h('div', null, h('dt', null, refName + (ref === main ? ' · главный ряд' : '')), h('dd', null, fmt.dec(b.market, 3), h('small', null, 'модель ' + fmt.dec(b.model, 3) + ' · ' + nEv(b.n) + (ref === 'close' && main !== 'close' ? ' · станет главным, когда закрытий будет больше' : '')))),
          h('div', null, h('dt', null, (other === 'close' ? 'Рынок закрытия' : 'Рынок при прогнозе') + (other === main ? ' · главный ряд' : '')), h('dd', null, ob.market == null ? '—' : fmt.dec(ob.market, 3), h('small', null, ob.n ? 'модель ' + fmt.dec(ob.model, 3) + ' · ' + nEv(ob.n) + (other === 'close' && main !== 'close' ? ' · станет главным, когда закрытий будет больше' : '') : 'нет событий')))),
        howto(h('b', null, 'Как читать: '), 'Brier — средняя квадратичная ошибка прогноза: 0 — идеально, 0,25 — как всегда ставить 50%. Рынок — вероятность по кэфам обеих сторон у вашего букмекера в момент прогноза, маржа снята степенным методом. Каждая точка — последние 30 событий. Ставки старого бота не входят.'),
        button('Brier и CLV простыми словами', { kind: 'ghost', size: 'sm', icon: 'book', onClick: explainModal, attrs: { class: 'btn ghost sm', style: 'align-self:flex-start' } }),
      ],
    }));
  }

  // ---------- CLV ----------
  // CLV (В1): кэф ÷ закрывающий − 1 по закрытию, которое внес участник; среднее — с 95% ДИ. Где внесены обе стороны
  // закрытия — еще «CLV без маржи» по событиям. Ставки старого бота не входят (В5)
  function clvCard(s, mobile) {
    const clvs = s.sum.clvs; // ставки без закрывающего кэфа и ставки бота в распределение не попадают
    if (!clvs.length) return card({ class: 'analytics-card', title: 'Распределение CLV', body: UI.empty(state.source === 'bot' ? 'У ставок старого бота CLV не считается.' : 'Нет ставок с закрывающими кэфами за период') });
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
    const fair = s.legs.filter(l => l.qClose != null && l.pKind === 'final').map(fairClv);
    const fairAvg = fair.length ? sum(fair, v => v) / fair.length : null;
    const chart = UI.columnChart({ items, height: mobile ? 190 : 220, valueFormat: v => fmt.int(v), seriesName: 'Ставок', ariaLabel: 'Распределение CLV по ставкам: средний ' + fmt.signedPct(avg) });
    return card({
      class: 'analytics-card', title: 'Распределение CLV', subtitle: 'Ваш кэф против закрывающего, по ставкам',
      actions: [chip('Средний ' + fmt.signedPct(Math.round(avg * 10) / 10), noisy(s.sum.clvCi) ? 'outline' : avg > 0 ? 'good' : 'bad', avg > 0 ? 'arrowUp' : 'arrowDown')],
      body: [
        UI.legend([{ name: 'Кэф не хуже закрытия · ' + (clvs.length - neg), color: 'var(--s1)', type: 'box' }, { name: 'Линия ушла против вас · ' + neg, color: 'var(--fg-3)', type: 'box' }]),
        UI.withTable(chart, () => tableBox(mtable({
          columns: [
            { key: 'label', label: 'CLV', render: it => h('span', { style: 'white-space:nowrap' }, it.label) },
            { key: 'value', label: 'Ставок', align: 'r' },
            { key: 'share', label: 'Доля', align: 'r', render: it => fmt.pct(it.value / clvs.length * 100, 0) },
          ], rows: items,
        }))),
        h('dl', { class: 'analytics-strip analytics-strip-2' },
          h('div', null, h('dt', null, 'Средний CLV · 95% ДИ'), h('dd', { class: roiCls(avg) }, fmt.signedPct(Math.round(avg * 10) / 10), h('small', null, ciPct1(s.sum.clvCi) + (noisy(s.sum.clvCi) ? ' · в пределах шума' : '') + ' · ' + nBets(clvs.length)))),
          h('div', null, h('dt', null, 'CLV без маржи'), h('dd', { class: fairAvg == null ? null : roiCls(fairAvg) }, fairAvg == null ? '—' : fmt.signedPct(Math.round(fairAvg * 10) / 10), h('small', null, fair.length ? nEv(fair.length) + ' с двумя сторонами закрытия' : 'внесите обе стороны закрытия')))),
        howto(h('b', null, 'Как читать: '), 'CLV = ваш кэф ÷ закрывающий − 1; закрывающий кэф вы вносите сами — эталона (' + D.marketRefRule + ') или своего букмекера. Так CLV немного завышен: в закрывающем кэфе есть маржа, честный кэф выше. Точнее — CLV без маржи: ваш кэф × вероятность рынка закрытия − 1, если внесены обе стороны. Столбцы правее нуля — вы взяли цену лучше рыночного итога. Стабильно положительный CLV — главный признак, что преимущество не случайно. Ставки старого бота не входят.'),
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

  // ---------- Р28: новые рынки «для сравнения» ----------
  // Счетчик и цифры общие по всем участникам (модель общая): событие — исход рынка с кэфом из ввода и известным итогом.
  // В экспресс рынок пойдет, когда наберется 150–200 событий и CLV покажет перевес (нижняя граница 95% ДИ выше нуля)
  function freshCard() {
    const F = D.fresh, list = F.status;
    const stChip = m => (m.status === 'express' ? chip('в экспрессе', 'good', 'ticket') : m.status === 'paused' ? chip('на проверке', 'warn', 'flask') : chip('для сравнения', 'info', 'flask'));
    const prog = m => (m.status !== 'compare' ? h('span', { class: 'muted xsmall' }, nEv(m.n)) : h('div', { class: 'analytics-fresh-prog' },
      h('span', { class: 'xsmall' }, h('b', null, String(m.n)), ' из ' + F.NEED + ' событий'), UI.meter(m.n, F.NEED, m.n / F.NEED >= 1 ? 'good' : null)));
    const ciOf = c => (c ? h('span', { class: 'muted xsmall analytics-nowrap' }, ciPct(c)) : null);
    const val = (v, c, small) => (v == null ? h('span', { class: 'muted' }, '—') : h('span', { class: 'analytics-fresh-val' }, roiText(v), small ? null : ciOf(c)));
    const tbl = mtable({
      columns: [
        { key: 'label', label: 'Рынок', render: m => h('div', { style: 'min-width:0' }, h('div', { class: 'analytics-mname' }, m.label), h('div', { class: 'analytics-mdesc' }, m.lines || 'П1 и П2')) },
        { key: 'st', label: 'Статус', render: stChip },
        { key: 'n', label: 'События', render: prog },
        { key: 'roi', label: 'ROI', align: 'r', render: m => val(m.roi, m.roiCi) },
        { key: 'clv', label: 'CLV', align: 'r', render: m => h('div', null, val(m.clv, m.clvCi), m.clvN != null ? h('div', { class: 'muted xsmall' }, 'с закрытием: ' + m.clvN) : null) },
      ], rows: list,
    });
    const items = h('ul', { class: 'analytics-fresh-list' }, list.map(m => h('li', null,
      h('div', { class: 'row-between', style: 'gap:8px;align-items:flex-start' }, h('div', { style: 'min-width:0' }, h('div', { class: 'analytics-mname' }, m.label), h('div', { class: 'analytics-mdesc' }, m.lines || 'П1 и П2')), stChip(m)),
      prog(m),
      h('div', { class: 'analytics-fresh-nums' }, h('span', null, 'ROI ', m.roi == null ? '—' : roiText(m.roi)), h('span', null, 'CLV ', m.clv == null ? '—' : roiText(m.clv))),
      m.why && h('div', { class: 'muted xsmall' }, m.why))));
    return card({
      class: 'analytics-card analytics-fresh', title: 'Рынки: в экспрессе, на проверке, для сравнения',
      subtitle: 'Общий счетчик по всем участникам · ординары на равную сумму по вашим кэфам',
      body: [
        h('div', { class: 'analytics-fresh-table analytics-tablebox' }, tbl), items,
        howto(h('b', null, 'Как читать: '), 'кэфов тоталов и фор в бесплатных архивах нет, поэтому проверить модель против рынка можно только на своих событиях. Рынок «для сравнения» идет в экспресс, когда наберется ' + F.NEED + '–' + F.NEED_MAX + ' событий и CLV покажет перевес: нижняя граница 95% ДИ выше нуля. Фора ±1.5 на проверке: модель сетов, похоже, завышает третий сет. CLV — только по закрытию, которое внесли сами.'),
      ],
    });
  }

  // ---------- экспорт ----------
  // В13: в этапе 4 — только CSV (ставки, события, калибровка и Brier); Excel и PDF — не сейчас
  function exportModal(s) {
    UI.modal({
      title: 'Выгрузить аналитику в CSV',
      body: [
        h('p', { class: 'small soft', style: 'margin:0' }, 'CSV открывается в Excel, Numbers и Google Таблицах. Каждый выбранный набор — отдельный файл в одном архиве.'),
        h('fieldset', { class: 'analytics-check', style: 'border:0;padding:0;margin:0' },
          h('legend', { class: 'field-label', style: 'margin-bottom:8px' }, 'Что включить'),
          [['analytics-ex-bets', 'Ставки с суммами и результатом', true], ['analytics-ex-legs', 'События экспрессов (кэф, закрытие, прогноз модели)', true], ['analytics-ex-calib', 'Калибровку и Brier по окнам', false]].map(([id, text, on]) =>
            h('label', { class: 'check', for: id }, h('input', { type: 'checkbox', id, checked: on }), h('span', null, text)))),
        UI.callout('', 'filter', 'Будут выгружены данные под текущими фильтрами: ' + s.p.ctx + ', ' + nBets(s.sum.n) + ', ' + nEv(s.legs.length) + '.'),
      ],
      actions: close => [
        button('Отмена', { kind: 'ghost', onClick: close }),
        button('Скачать CSV', { kind: 'primary', icon: 'download', onClick: () => { close(); UI.toast('В рабочей версии скачается analytics_' + TODAY + '.zip с CSV-файлами. В макете файл не скачивается', 'download'); } }),
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
    // Есть ли такие ставки за все время — тогда предлагаем расширить период, а не сбрасывать фильтры
    const ever = settled().filter(b => (state.surface === 'all' || b.surface === state.surface) && (state.market === 'all' || b.legs.some(l => l.market === state.market)) && (state.source === 'all' || b.source === state.source));
    const canWiden = state.period !== 'all' && ever.length > 0;
    const reset = () => { Object.assign(state, DEFAULTS); update(true); };
    return h('section', { class: 'card analytics-empty' },
      h('span', { class: 'analytics-empty-ic' }, icon('filter')),
      h('h3', null, 'Под фильтр не попало ни одной ставки'),
      h('p', null, canWiden
          ? s.p.ctx[0].toUpperCase() + s.p.ctx.slice(1) + ' таких ставок нет. Последняя была ' + fmt.date(ever[ever.length - 1].date) + ', всего за сезон — ' + nBets(ever.length) + '.'
          : 'Нет рассчитанных ставок с таким рынком, покрытием и источником. Снимите один из фильтров.'),
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
      section('Где стратегия зарабатывает', 'ROI по срезам с 95% доверительными интервалами. В разрезах по покрытию и рынку все значения видны всегда, выбранное в фильтре подсвечено.'),
      parlayCard(s),
      h('div', { class: 'analytics-grid' }, surfaceCard(s), marketCard(s), oddsCard(s), totalCard(s)),
      section('Точность прогнозов', 'Насколько вероятности модели совпадают с реальностью и с рынком в момент прогноза.'),
      h('div', { class: 'analytics-grid' }, calibrationCard(s, mobile), brierCard(s, mobile)),
      section('Цена и рынки', 'Качество взятых кэфов и итог по типам ставок.'),
      h('div', { class: 'analytics-grid' }, clvCard(s, mobile), marketTableCard(s)),
      freshCard(),
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
          button('Выгрузить CSV', { kind: 'secondary', size: UI.isMobile() ? 'sm' : null, icon: 'download', onClick: () => exportModal(compute()), ro: 'Только просмотр: выгрузить аналитику может только сам участник' })));
      filters = filterBar(reset => update(reset));
      contentEl = h('div', { class: 'stack', style: 'gap:inherit' });
      UI.append(root, [head, filters.el, contentEl]);
      drawContent();
    },
  });
})();
