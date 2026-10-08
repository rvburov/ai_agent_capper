/* Главная: банк и показатели за выбранный период, открытые ставки, матчи дня,
   «требует внимания», как учится модель, расходы ИИ. Все цифры — из window.DATA. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, TODAY = DATA.today;

  // ---------- утилиты ----------
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const signedDec = (n, d) => (n > 0 ? '+' : '') + fmt.dec(n, d);
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const firstDate = D.bankHistory[0].date;
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const PERIODS = [
    { id: '7', label: '7 дней', days: 7, ctx: 'за 7 дней', prev: 'к пред. 7 дням' },
    { id: '30', label: '30 дней', days: 30, ctx: 'за 30 дней', prev: 'к пред. 30 дням' },
    { id: '90', label: '3 месяца', days: 90, ctx: 'за 3 месяца', prev: 'к пред. 3 месяцам' },
    { id: 'all', label: 'Все', days: null, ctx: 'с ' + fmt.date(firstDate), prev: null },
  ];
  let periodId = '30';
  try { const s = sessionStorage.getItem('capper.dash.period'); if (s && PERIODS.some(p => p.id === s)) periodId = s; } catch (e) { /* ок */ }

  // Банк на конец дня d
  function bankAt(d) { let v = S.start; for (const p of D.bankHistory) { if (p.date <= d) v = p.bank; else break; } return v; }

  function summarize(bets) {
    const wins = bets.filter(b => b.status === 'win').length;
    const losses = bets.filter(b => b.status === 'loss').length;
    const voids = bets.filter(b => b.status === 'void').length;
    const turnover = sum(bets, b => b.stake), profit = sum(bets, b => b.profit);
    return {
      n: bets.length, wins, losses, voids, turnover, profit,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: bets.length ? sum(bets, b => b.clv) / bets.length : null,
      clvPos: bets.filter(b => b.clv > 0).length,
    };
  }
  const marketQ = l => Math.min(0.97, 1 / l.closing * 0.955); // как в data.js: вероятность рынка по закрытию без маржи
  function brier(legs) {
    if (!legs.length) return { model: null, market: null, n: 0 };
    const y = l => (l.result === 'win' ? 1 : 0);
    return { model: sum(legs, l => (l.p - y(l)) ** 2) / legs.length, market: sum(legs, l => (marketQ(l) - y(l)) ** 2) / legs.length, n: legs.length };
  }

  function periodStats(p) {
    const anchor = p.days ? addDays(TODAY, -p.days) : firstDate; // банк на конец этого дня = старт периода
    const settled = D.bets.filter(b => b.status !== 'open' && b.date > anchor && b.date <= TODAY);
    const cur = summarize(settled);
    const legs = D.allLegs.filter(l => l.date > anchor);
    const startBank = bankAt(anchor);
    const dates = [], values = [];
    for (let d = anchor; d <= TODAY; d = addDays(d, 1)) { dates.push(d); values.push(bankAt(d)); }
    let peak = startBank, maxDD = 0;
    values.forEach(v => { peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak * 100); });
    let prev = null;
    if (p.days) {
      const prevAnchor = addDays(anchor, -p.days);
      if (prevAnchor >= firstDate) prev = summarize(D.bets.filter(b => b.status !== 'open' && b.date > prevAnchor && b.date <= anchor));
    }
    return { p, anchor, settled, cur, prev, brier: brier(legs), startBank, dates, values, maxDD };
  }

  const openBets = () => D.bets.filter(b => b.status === 'open');
  const matchOf = leg => D.matchesToday.find(m => (m.p1 === leg.p1 && m.p2 === leg.p2) || (m.p1 === leg.p2 && m.p2 === leg.p1));
  function betOfMatch(m) {
    for (const b of openBets()) for (const l of b.legs) if (matchOf(l) === m) return { bet: b, leg: l };
    return null;
  }
  function playerLink(id) {
    const pl = D.P[id];
    return h('a', { class: 'dashboard-player', href: '#player-' + id, title: pl ? pl.name : id }, pl ? pl.short : id);
  }
  function deltaEl(text, trend, goodUp) {
    const goodDir = goodUp === false ? 'down' : 'up';
    const cls = trend === 'flat' ? 'flat' : trend + '-' + (trend === goodDir ? 'good' : 'bad');
    return h('span', { class: ['delta', cls] }, trend !== 'flat' && icon(trend === 'up' ? 'arrowUp' : 'arrowDown', { width: 14, height: 14 }), text);
  }
  const trendOf = n => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
  // Валюта программы одна на всех (Р17): подпись «в рублях / в долларах / в евро» берем из UI.currency
  const CUR_IN = { RUB: 'в рублях', USD: 'в долларах', EUR: 'в евро' };
  const curIn = () => CUR_IN[UI.currency.code] || 'в валюте программы';
  // Время показываем в поясе пользователя (DATA.user.tz)
  const TZ_CITY = { 'Europe/Helsinki': 'Хельсинки', 'Europe/Berlin': 'Берлину', 'Europe/Moscow': 'Москве', 'America/New_York': 'Нью-Йорку', 'America/Chicago': 'Чикаго', 'America/Los_Angeles': 'Лос-Анджелесу' };
  const tzLabel = () => { const tz = (D.user && D.user.tz) || ''; return TZ_CITY[tz] ? 'время по ' + TZ_CITY[tz] : 'ваше время'; };
  // «3–5 окт» или «28 сен – 2 окт»
  function dateRange(isos) {
    const ds = isos.map(x => x.slice(0, 10)).sort();
    const a = ds[0], b = ds[ds.length - 1];
    if (a === b) return fmt.date(a);
    return a.slice(0, 7) === b.slice(0, 7) ? +a.slice(8, 10) + '–' + fmt.date(b) : fmt.date(a) + ' – ' + fmt.date(b);
  }

  // ---------- стили экрана ----------
  UI.css('dashboard', `
    .dashboard-head h2 { font-size: var(--fs-2xl); }
    .dashboard-top { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; }
    .dashboard-tiles > div > .card { height: 100%; }
    .dashboard-main { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .dashboard-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1180px) {
      .dashboard-top { grid-template-columns: minmax(0, 1fr); }
      .dashboard-main { display: flex; flex-direction: column; align-items: stretch; gap: 16px; }
      .dashboard-col { display: contents; }
      .dashboard-o-1 { order: 1; } .dashboard-o-2 { order: 2; } .dashboard-o-3 { order: 3; }
      .dashboard-o-4 { order: 4; } .dashboard-o-5 { order: 5; } .dashboard-o-6 { order: 6; }
    }

    .dashboard-hero { height: 100%; padding: 18px; gap: 16px; justify-content: space-between; }
    .dashboard-hero .stat-label { font-size: var(--fs-sm); color: var(--fg-2); display: flex; align-items: center; gap: 6px; }
    .dashboard-hero .stat-value { white-space: nowrap; }
    .dashboard-hero-top { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .dashboard-hero-spark svg { display: block; width: 100%; height: auto; }
    .dashboard-hero-kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding-top: 14px; border-top: 1px solid var(--line); }
    .dashboard-hero-kv > div { min-width: 0; }
    .dashboard-hero-kv dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .dashboard-hero-kv dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dashboard-hero-kv dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }

    .dashboard-card .card-head { flex-wrap: nowrap; }
    .dashboard-card .card-head > div:first-child { flex: 1 1 auto; }
    .dashboard-card .card-head > .row { flex: none; flex-wrap: nowrap; }
    .dashboard-section-label { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: -4px; }

    .dashboard-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .dashboard-strip > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .dashboard-strip dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .dashboard-strip dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .dashboard-strip { margin: 0; }
    @media (max-width: 720px) { .dashboard-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .dashboard-howto { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; }
    .dashboard-howto svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }

    .dashboard-player { color: var(--fg); font-weight: 600; text-decoration: none; }
    .dashboard-player:hover { color: var(--accent-ink); text-decoration: underline; }

    .dashboard-betlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .dashboard-betlist li + li { border-top: 1px solid var(--line); }
    .dashboard-betlist-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 10px 12px; color: var(--fg); text-decoration: none; }
    .dashboard-betlist-row:hover { background: var(--surface-2); }

    /* открытые ставки */
    .dashboard-bet { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); min-width: 0; }
    .dashboard-bet-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
    .dashboard-bet-head > div { min-width: 0; }
    .dashboard-legs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .dashboard-leg { display: grid; grid-template-columns: 44px minmax(0, 1fr) auto; gap: 2px 10px; align-items: start; padding: 8px 0; border-top: 1px dashed var(--line); }
    .dashboard-leg:first-child { border-top: 0; padding-top: 0; }
    .dashboard-leg-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--fg-2); padding-top: 1px; }
    .dashboard-leg-match { font-size: var(--fs-md); line-height: 1.35; min-width: 0; }
    .dashboard-leg-meta { grid-column: 2 / -1; display: flex; flex-wrap: wrap; column-gap: 8px; row-gap: 0; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .dashboard-leg-meta > span { white-space: nowrap; }
    .dashboard-leg-meta b { color: var(--fg-2); font-weight: 600; }
    .dashboard-leg .odds { font-size: var(--fs-md); padding-top: 1px; }
    .dashboard-bet-sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--r-sm); background: var(--surface-2); }
    .dashboard-bet-sum > div { min-width: 0; }
    .dashboard-bet-sum dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .dashboard-bet-sum dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }

    /* матчи дня — раскладка зависит от ширины карточки */
    .dashboard-matches-card { container-type: inline-size; }
    .dashboard-match { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto auto; grid-template-areas: "time players odds action"; gap: 8px 18px; align-items: center; padding: 14px 18px; border-top: 1px solid var(--line); }
    .dashboard-match:first-child { border-top: 0; }
    .dashboard-match-time { grid-area: time; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .dashboard-match-time .mono { font-weight: 600; font-size: var(--fs-md); color: var(--fg); }
    .dashboard-match-time .xsmall { color: var(--fg-3); line-height: 1.25; }
    .dashboard-match-players { grid-area: players; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 10px; align-items: center; min-width: 0; }
    .dashboard-match-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dashboard-match-name .rank { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .dashboard-match-players > .chip { justify-self: start; }
    .dashboard-match-extra { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: 6px; }
    .dashboard-match-odds { grid-area: odds; display: flex; gap: 6px; }
    .dashboard-match-action { grid-area: action; display: flex; justify-content: flex-end; }
    .dashboard-match-sep { display: none; }
    @container (max-width: 600px) {
      .dashboard-match { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "time time" "players players" "odds action"; padding: 14px; gap: 10px 12px; }
      .dashboard-match-time { flex-direction: row; align-items: baseline; gap: 6px; flex-wrap: wrap; }
      .dashboard-match-sep { display: inline; color: var(--fg-3); }
    }

    /* требует внимания */
    .dashboard-alerts { display: flex; flex-direction: column; }
    .dashboard-alert { display: grid; grid-template-columns: 34px minmax(0, 1fr); gap: 12px; padding: 14px 0; border-top: 1px solid var(--line); }
    .dashboard-alert:first-child { border-top: 0; padding-top: 2px; }
    .dashboard-alert:last-child { padding-bottom: 0; }
    .dashboard-alert-ic { width: 34px; height: 34px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .dashboard-alert-ic svg { width: 18px; height: 18px; }
    .dashboard-alert-ic.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .dashboard-alert-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .dashboard-alert-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .dashboard-alert-ic.accent { background: var(--accent-soft); color: var(--accent-ink); }
    .dashboard-alert-body { min-width: 0; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
    .dashboard-alert-title { font-weight: 600; line-height: 1.3; }
    .dashboard-alert-text { font-size: var(--fs-sm); color: var(--fg-2); }
    .dashboard-alert-body > :last-child { margin-top: auto; }
    .dashboard-attn-card { container-type: inline-size; }
    @container (min-width: 560px) {
      .dashboard-alerts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .dashboard-alert, .dashboard-alert:first-child, .dashboard-alert:last-child { border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px; }
    }

    /* обучение */
    .dashboard-lesson { margin: 0; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); border-left: 3px solid var(--accent); display: flex; flex-direction: column; gap: 8px; }
    .dashboard-lesson p { font-size: var(--fs-md); line-height: 1.5; }
    .dashboard-mini-stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; }
    .dashboard-mini-stats > div { min-width: 0; padding: 8px 10px; border: 1px solid var(--line); border-radius: var(--r-sm); }
    .dashboard-mini-stats dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .dashboard-mini-stats dd { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }

    /* расходы */
    .dashboard-cost-value { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
  `);

  // ---------- блоки ----------
  function headBlock(onPeriod) {
    const d = new Date(TODAY + 'T12:00:00Z');
    const weekday = d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'UTC' });
    const dateStr = d.getUTCDate() + ' ' + MONTHS_GEN[d.getUTCMonth()] + ', ' + weekday;
    const nM = D.matchesToday.length, nO = openBets().length;
    return h('div', { class: 'page-head dashboard-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Добрый день, ' + D.user.first),
        h('p', { class: 'lead' }, dateStr + ' · в Шанхае ' + nM + ' ' + fmt.plural(nM, 'матч', 'матча', 'матчей') + ' 1/8 финала, ' + nO + ' ' + fmt.plural(nO, 'ставка', 'ставки', 'ставок') + ' в игре')),
      UI.segmented({ label: 'Период для показателей', items: PERIODS.map(p => ({ id: p.id, label: p.label })), active: periodId, onChange: onPeriod }));
  }

  function heroCard(st) {
    const delta = S.bank - st.startBank;
    const pct = st.startBank ? delta / st.startBank * 100 : 0;
    const open = openBets();
    const inPlay = sum(open, b => b.stake);
    const fromPeak = (S.bank - S.peak) / S.peak * 100;
    return h('section', { class: 'card stat dashboard-hero', 'aria-label': 'Банк' },
      h('div', { class: 'dashboard-hero-top' },
        h('div', { class: 'stat-label' }, icon('wallet', { width: 16, height: 16 }), 'Банк'),
        h('div', { class: 'stat-value hero' }, fmt.money(S.bank)),
        h('div', { class: 'row', style: 'gap:8px' }, deltaEl(fmt.signedMoney(delta) + ' · ' + fmt.signedPct(pct), trendOf(delta)), h('span', { class: 'stat-hint' }, st.p.ctx))),
      h('div', { class: 'dashboard-hero-spark', title: 'Банк по дням ' + st.p.ctx }, UI.sparkline(st.values, { color: 'var(--s1)', width: 320, height: 52 })),
      h('dl', { class: 'dashboard-hero-kv' },
        h('div', null, h('dt', null, 'Старт периода'), h('dd', null, fmt.money(st.startBank), h('small', null, fmt.date(st.anchor)))),
        h('div', null, h('dt', null, 'Сейчас в игре'), h('dd', null, fmt.money(inPlay), h('small', null, open.length + ' ' + fmt.plural(open.length, 'ставка', 'ставки', 'ставок')))),
        h('div', { title: 'Пик банка — ' + fmt.money(S.peak) }, h('dt', null, 'От пика'), h('dd', null, fmt.signedPct(fromPeak), h('small', null, 'пик ' + fmt.money(S.peak))))));
  }

  function tiles(st) {
    const c = st.cur, pv = st.prev;
    const roiTile = { label: 'ROI', icon: 'coins', value: c.roi == null ? '—' : fmt.signedPct(c.roi) };
    if (pv && pv.roi != null && c.roi != null) Object.assign(roiTile, { delta: signedDec(c.roi - pv.roi, 1) + ' п.п.', trend: trendOf(c.roi - pv.roi), hint: st.p.prev });
    else roiTile.hint = 'оборот ' + fmt.money(c.turnover);

    const wrTile = { label: 'Винрейт', icon: 'trophy', value: c.winrate == null ? '—' : fmt.pct(c.winrate),
      hint: c.wins + ' В · ' + c.losses + ' П' + (c.voids ? ' · ' + c.voids + ' возвр.' : '') };

    const clvTile = { label: 'Средний CLV', icon: 'bolt', value: c.clv == null ? '—' : fmt.signedPct(Math.round(c.clv * 10) / 10),
      hint: c.n ? 'лучше закрытия в ' + c.clvPos + ' из ' + c.n : 'нет ставок' };

    const b = st.brier;
    const brTile = { label: 'Brier модели', icon: 'target', value: b.model == null ? '—' : fmt.dec(b.model, 3) };
    if (b.model != null) {
      const diff = b.model - b.market;
      Object.assign(brTile, { delta: signedDec(diff, 3) + ' к рынку', trend: trendOf(Math.round(diff * 1000)), good: false, hint: 'рынок ' + fmt.dec(b.market, 3) + ' · ниже — лучше' });
    }
    return [roiTile, wrTile, clvTile, brTile].map(t => h('div', { class: 'col-6 half-mobile' }, UI.stat(t)));
  }

  function smallSampleNote(st) {
    if (st.cur.n >= 15) return null;
    return UI.callout('warn', 'info', h('span', null, h('b', null, PERIODS.find(p => p.id === st.p.id).ctx[0].toUpperCase() + st.p.ctx.slice(1) + ' — всего ' + st.cur.n + ' ' + fmt.plural(st.cur.n, 'ставка', 'ставки', 'ставок') + '. '), 'На такой выборке ROI, винрейт и Brier сильно скачут — для выводов смотрите 30 дней и больше.'));
  }

  const betKind = b => (b.legs.length > 1 ? 'Экспресс × ' + b.legs.length : 'Ординар');
  const profitCls = b => (b.profit > 0 ? 'good-text' : b.profit < 0 ? 'bad-text' : 'muted');
  function betsTable(st, mobile) {
    const rows = st.settled.slice().reverse();
    if (mobile) {
      // Телефон: компактный список вместо широкой таблицы
      const shown = rows.slice(0, 10);
      return h('div', { class: 'stack', style: 'gap:8px' },
        h('ul', { class: 'dashboard-betlist' }, shown.map(b => h('li', null,
          h('a', { href: '#bets', class: 'dashboard-betlist-row' },
            h('div', { style: 'min-width:0' },
              h('div', { class: 'small', style: 'font-weight:600' }, fmt.date(b.date) + ' · ' + betKind(b)),
              h('div', { class: 'row', style: 'gap:6px;margin-top:4px' }, UI.statusChip(b.status), h('span', { class: 'odds small' }, fmt.odds(b.total)))),
            h('div', { style: 'text-align:right;min-width:0' },
              h('div', { class: profitCls(b), style: 'font-weight:600;white-space:nowrap' }, fmt.signedMoney(b.profit)),
              h('div', { class: 'xsmall muted', style: 'white-space:nowrap' }, 'банк ' + fmt.money(b.bankAfter))))))),
        rows.length > shown.length && button('Все ' + rows.length + ' ' + fmt.plural(rows.length, 'ставка', 'ставки', 'ставок') + ' за период', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#bets', attrs: { class: 'btn ghost sm', style: 'align-self:flex-start' } }));
    }
    const shown = rows.slice(0, 12);
    const tbl = UI.table({
      columns: [
        { key: 'date', label: 'Дата', render: b => h('span', { style: 'white-space:nowrap' }, fmt.date(b.date)) },
        { key: 'legs', label: 'Ставка', render: b => h('span', { style: 'white-space:nowrap' }, betKind(b)) },
        { key: 'total', label: 'Кэф', align: 'r', render: b => h('span', { class: 'odds' }, fmt.odds(b.total)) },
        { key: 'status', label: 'Итог', render: b => UI.statusChip(b.status) },
        { key: 'profit', label: 'Результат', align: 'r', render: b => h('span', { class: profitCls(b), style: 'white-space:nowrap;font-weight:600' }, fmt.signedMoney(b.profit)) },
        { key: 'bank', label: 'Банк после', align: 'r', render: b => h('span', { style: 'white-space:nowrap' }, fmt.money(b.bankAfter)) },
      ],
      rows: shown, onRowClick: () => UI.go('bets'), empty: 'За период ставок нет',
    });
    return h('div', { class: 'stack', style: 'gap:8px' }, tbl,
      rows.length > shown.length && button('Все ' + rows.length + ' ' + fmt.plural(rows.length, 'ставка', 'ставки', 'ставок') + ' за период', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#bets', attrs: { class: 'btn ghost sm', style: 'align-self:flex-start' } }));
  }

  function chartCard(st, mobile) {
    const c = st.cur;
    // Значения графика — в валюте программы (демо-данные в рублях): круглые деления оси без копеек, банк на день — с копейками
    const yFormat = v => (Number.isInteger(v) || UI.currency.code === 'RUB' ? fmt.int(v) : fmt.dec(v, 2));
    const chart = UI.lineChart({
      labels: st.dates,
      series: [{ name: 'Банк, ' + fmt.cur(), color: 'var(--s1)', values: st.values.map(fmt.moneyNum) }],
      area: true, endLabel: true, height: mobile ? 200 : 250,
      refLines: [{ value: fmt.moneyNum(st.startBank) }],
      yFormat, xFormat: d => fmt.date(d), tipTitle: d => fmt.dateFull(d),
      ariaLabel: 'Банк по дням ' + st.p.ctx + ': с ' + fmt.money(st.startBank) + ' до ' + fmt.money(S.bank),
    });
    return card({
      class: 'dashboard-card',
      title: 'Динамика банка',
      subtitle: st.p.ctx[0].toUpperCase() + st.p.ctx.slice(1) + ', ' + curIn(),
      actions: [chip(fmt.signedMoney(c.profit), c.profit > 0 ? 'good' : c.profit < 0 ? 'bad' : 'outline', c.profit > 0 ? 'arrowUp' : c.profit < 0 ? 'arrowDown' : null)],
      body: [
        UI.legend([{ name: 'Банк на конец дня', color: 'var(--s1)' }, { name: 'Банк на начало периода · ' + fmt.money(st.startBank), type: 'dash' }]),
        UI.withTable(chart, () => betsTable(st, mobile)),
        h('div', { class: 'dashboard-howto' }, icon('info'), 'Как читать: линия выше пунктира — вы в плюсе за период. ' + (mobile ? 'Коснитесь графика' : 'Наведите на график') + ', чтобы увидеть банк на любой день.'),
        h('dl', { class: 'dashboard-strip' },
          h('div', null, h('dt', null, 'Прибыль'), h('dd', { class: c.profit > 0 ? 'good-text' : c.profit < 0 ? 'bad-text' : null }, fmt.signedMoney(c.profit))),
          h('div', null, h('dt', null, 'Ставок рассчитано'), h('dd', null, String(c.n))),
          h('div', null, h('dt', null, 'Оборот'), h('dd', null, fmt.money(c.turnover))),
          h('div', null, h('dt', null, 'Макс. просадка'), h('dd', null, st.maxDD < 0 ? fmt.signedPct(st.maxDD) : '0%'))),
      ],
    });
  }

  function openBetsCard() {
    const open = openBets();
    const inPlay = sum(open, b => b.stake);
    const body = open.length ? open.map(b => {
      const payout = Math.round(b.stake * b.total);
      return h('article', { class: 'dashboard-bet', 'aria-label': 'Ставка №' + b.id },
        h('div', { class: 'dashboard-bet-head' },
          h('div', null, h('strong', null, b.legs.length > 1 ? 'Экспресс из ' + b.legs.length + ' ' + fmt.plural(b.legs.length, 'события', 'событий', 'событий') : 'Ординар'), h('div', { class: 'xsmall muted' }, '№' + b.id + ' · ' + b.bookmaker + ' · ' + b.tournament)),
          UI.statusChip('open')),
        h('ul', { class: 'dashboard-legs' }, b.legs.map(l => {
          const m = matchOf(l);
          const implied = 1 / l.odds;
          return h('li', { class: 'dashboard-leg' },
            h('span', { class: 'dashboard-leg-time' }, m ? m.time : '—'),
            h('div', { class: 'dashboard-leg-match' }, playerLink(l.p1), ' — ', playerLink(l.p2)),
            h('span', { class: 'odds', 'aria-label': 'Кэф ' + fmt.odds(l.odds) }, fmt.odds(l.odds)),
            h('div', { class: 'dashboard-leg-meta', title: 'Вероятность исхода: оценка модели и 1/кэф букмекера (с его маржой)' }, h('b', null, l.marketLabel), h('span', null, 'модель ' + fmt.prob(l.p) + ' · по кэфу ' + fmt.prob(implied))));
        })),
        h('dl', { class: 'dashboard-bet-sum' },
          h('div', null, h('dt', null, 'Кэф'), h('dd', { class: 'odds' }, fmt.odds(b.total))),
          h('div', null, h('dt', null, 'Ставка'), h('dd', null, fmt.money(b.stake))),
          h('div', null, h('dt', null, 'Выплата'), h('dd', null, fmt.money(payout)))),
        button('Внести результат', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#bets-' + b.id, block: true, ariaLabel: 'Внести результат ставки №' + b.id }));
    }) : UI.empty('Открытых ставок нет. Запустите анализ матчей дня — ИИ предложит экспресс.');
    return card({
      class: 'dashboard-card',
      title: 'Открытые ставки',
      subtitle: open.length + ' ' + fmt.plural(open.length, 'ставка', 'ставки', 'ставок') + ' · в игре ' + fmt.money(inPlay),
      actions: [button('Все ставки', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#bets' })],
      body,
    });
  }

  function matchesCard() {
    const rows = D.matchesToday.map(m => {
      const inBet = betOfMatch(m);
      const pl = id => [
        h('div', { class: 'dashboard-match-name' }, playerLink(id), D.P[id] && h('span', { class: 'rank', title: 'Место в рейтинге ATP' }, '№' + D.P[id].rank)),
        UI.freshnessChip(D.P[id] ? D.P[id].fresh : 'missing'),
      ];
      return h('article', { class: 'dashboard-match', 'aria-label': DATA.match(m) + ', ' + m.time },
        h('div', { class: 'dashboard-match-time' }, h('span', { class: 'mono' }, m.time), h('span', { class: 'dashboard-match-sep', 'aria-hidden': 'true' }, '·'), h('span', { class: 'xsmall' }, m.court)),
        h('div', { class: 'dashboard-match-players' }, pl(m.p1), pl(m.p2),
          inBet && h('div', { class: 'dashboard-match-extra' }, chip('В ставке №' + inBet.bet.id + ' · ' + inBet.leg.marketLabel + ' ' + fmt.odds(inBet.leg.odds), 'accent', 'ticket'))),
        h('div', { class: 'dashboard-match-odds' },
          UI.oddsBox('П1', m.odds.p1, inBet && inBet.leg.market === 'p1'),
          UI.oddsBox('П2', m.odds.p2, inBet && inBet.leg.market === 'p2')),
        h('div', { class: 'dashboard-match-action' }, button('Анализировать', { kind: 'secondary', size: 'sm', icon: 'spark', href: '#new-' + m.id, ariaLabel: 'Анализировать матч ' + DATA.match(m) })));
    });
    return card({
      class: 'dashboard-matches-card dashboard-card',
      title: 'Матчи сегодня · Шанхай, Masters 1000',
      subtitle: '1/8 финала · ' + tzLabel() + ' · кэфы — пример',
      actions: [UI.surfaceChip('hard')],
      flush: true,
      body: h('div', null, rows),
      foot: [
        button('Собрать экспресс из матчей дня', { kind: 'primary', size: 'sm', icon: 'spark', href: '#new-today' }),
        h('span', { class: 'xsmall muted', style: 'min-width:0;flex:1 1 220px' }, 'Перед анализом ИИ обновит устаревшие профили и соберет недостающие. Это общая фоновая задача: ее оплачивает ключ администратора' + (UI.auth.isAdmin ? '.' : ', в ваш лимит она не входит.')),
      ],
    });
  }

  // Дела администратора (Р8): просьбы вернуть ключ администратора и участники у лимита.
  // Тот же отбор, что у счетчика у пункта меню «Администрирование».
  function adminTodo() {
    const alert = D.admin.budget.alertAt / 100;
    const asks = [], limits = [];
    D.users.forEach(u => {
      if (u.returnRequested) asks.push(u.name + ' просит вернуть ключ администратора.');
      else if (u.limit && u.status === 'active' && u.spent / u.limit.monthly >= alert) limits.push(u.name + ' — уже ' + fmt.pct(u.spent / u.limit.monthly * 100, 0) + ' месячного лимита (' + fmt.usd(u.spent) + ' из ' + fmt.usd(u.limit.monthly, 0) + ').');
    });
    return asks.concat(limits);
  }

  // Состояние кнопок в «Требует внимания» — сохраняется между перерисовками периода
  const queued = { rune: false, stale: false };
  function attentionCard() {
    const list = h('div', { class: 'dashboard-alerts' });
    const missing = D.players.filter(p => p.fresh === 'missing');
    const stale = D.players.filter(p => p.fresh === 'stale');
    const playsToday = id => D.matchesToday.find(m => m.p1 === id || m.p2 === id);
    const staleToday = stale.filter(p => playsToday(p.id));
    const cand = D.strategyVersions.find(v => v.status === 'candidate');
    const act = D.strategyVersions.find(v => v.status === 'active');
    const isAdmin = UI.auth.isAdmin;

    function draw() {
      UI.clear(list);
      const items = [];
      missing.forEach(p => {
        const m = playsToday(p.id);
        const opp = m ? D.P[m.p1 === p.id ? m.p2 : m.p1] : null;
        items.push({
          tone: 'bad', ic: 'database', sr: 'Важно',
          title: h('span', null, 'Нет в базе: ', playerLink(p.id)),
          text: (m ? 'Играет сегодня в ' + m.time + (opp ? ', соперник — ' + opp.short + '. ' : '. ') : '') + 'Профиль соберется сам при анализе матча (≈ 1–2 мин, несколько веб-поисков).',
          action: queued.rune
            ? chip('Сбор профиля в очереди', 'info', 'clock')
            : button('Собрать сейчас', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => { queued.rune = true; draw(); UI.toast('Сбор профиля ' + p.short + ' запущен — около 1–2 минут', 'refresh'); } }),
        });
      });
      if (stale.length) {
        items.push({
          tone: 'warn', ic: 'clock', sr: 'Предупреждение',
          title: h('span', null, 'Данные устарели: ', stale.map((p, i) => [i ? ', ' : '', playerLink(p.id)])),
          text: 'Обновлены ' + dateRange(stale.map(p => p.updated)) + '. ' + (staleToday.length ? staleToday.map(p => p.short).join(' и ') + (staleToday.length > 1 ? ' играют' : ' играет') + ' сегодня. ' : '') + 'Пакетное обновление в фоне — вдвое дешевле.',
          action: queued.stale
            ? chip('Обновление в очереди · пакетом', 'info', 'clock')
            : button('Обновить ' + stale.length + ' ' + fmt.plural(stale.length, 'профиль', 'профиля', 'профилей'), { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => { queued.stale = true; draw(); UI.toast('Обновление ' + stale.length + ' профилей поставлено в пакетную очередь (−50% к цене)', 'refresh'); } }),
        });
      }
      if (isAdmin) {
        const todo = adminTodo();
        if (todo.length) items.push({
          tone: 'info', ic: 'admin', sr: 'Нужно решение',
          title: 'Администрирование: ' + todo.length + ' ' + fmt.plural(todo.length, 'дело', 'дела', 'дел'),
          text: todo.join(' '),
          action: button('Открыть Администрирование', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#admin' }),
        });
      }
      if (cand && act) {
        items.push({
          tone: 'accent', ic: 'flask', sr: 'Нужно решение',
          title: 'Нужно решение: кандидат стратегии ' + cand.id,
          text: 'Промпт на английском и сжатое досье — примерно на 30% меньше токенов на анализ. На тех же ' + cand.n + ' событиях Brier ' + fmt.dec(cand.brier, 3) + ' против ' + fmt.dec(act.brier, 3) + ' у ' + act.id + ' — разница в пределах шума, то есть качество не хуже. Включать ли ради экономии — решаете вы.',
          action: button('Сравнить ' + act.id + ' и ' + cand.id, { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#learning' }),
        });
      }
      // Адаптации размера ставки — те же правила, что в «Профиль → Банк и стратегия»; статус считается из DATA.stats
      const sk = S.streak, fromPeak = (S.bank - S.peak) / S.peak * 100;
      const streakText = sk.n + ' ' + (sk.type === 'win' ? fmt.plural(sk.n, 'выигрыш', 'выигрыша', 'выигрышей') : sk.type === 'loss' ? fmt.plural(sk.n, 'проигрыш', 'проигрыша', 'проигрышей') : fmt.plural(sk.n, 'возврат', 'возврата', 'возвратов'));
      const activeRules = [
        sk.type === 'loss' && sk.n >= 3 && 'после ' + streakText + ' подряд сумма −40%',
        sk.type === 'win' && sk.n >= 3 && 'после ' + streakText + ' подряд сумма +20% (не больше 3% банка)',
        fromPeak <= -10 && 'при просадке ' + fmt.signedPct(fromPeak) + ' ставка не больше 2,5% банка',
      ].filter(Boolean);
      items.push({
        tone: activeRules.length ? 'warn' : 'info', ic: 'shield', sr: activeRules.length ? 'Предупреждение' : 'Информация',
        title: activeRules.length ? 'Размер ставки изменен правилом адаптации' : 'Размер ставки: адаптации не действуют',
        text: 'Серия — ' + streakText + ', ' + (fromPeak < 0 ? 'банк ' + fmt.signedPct(fromPeak) + ' от пика' : 'банк на пике') + '. ' + (activeRules.length
          ? 'Сейчас ' + activeRules.join('; ') + '. Новые анализы предложат суммы с учетом этого.'
          : 'Ставка снизится на 40% после 3 проигрышей подряд и не превысит 2,5% банка при просадке от −10%. Сегодня суммы — по таблице.'),
        action: button('Правила ставок', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#profile-bank' }),
      });
      items.forEach(it => list.appendChild(h('div', { class: 'dashboard-alert' },
        h('div', { class: ['dashboard-alert-ic', it.tone] }, icon(it.ic)),
        h('div', { class: 'dashboard-alert-body' },
          h('div', { class: 'dashboard-alert-title' }, h('span', { class: 'sr-only' }, it.sr + '. '), it.title),
          h('div', { class: 'dashboard-alert-text' }, it.text),
          it.action))));
    }
    draw();
    const n = list.children.length;
    return card({ class: 'dashboard-card dashboard-attn-card', title: 'Требует внимания', subtitle: n + ' ' + fmt.plural(n, 'пункт', 'пункта', 'пунктов') + ' · ' + (isAdmin ? 'данные, стратегия и администрирование' : 'данные и стратегия'), body: list });
  }

  // Уроки о сборе данных (не о вероятностях) принимаются по правилу «не хуже на ≥ 10 случаях»
  const isProcessLesson = l => /сбор/i.test(l.scope || '');
  function learningCard() {
    const confirmed = D.lessons.filter(l => l.status === 'confirmed').sort((a, b) => b.created.localeCompare(a.created));
    const latest = confirmed[0];
    const hyp = D.lessons.find(l => l.status === 'hypothesis');
    const need = hyp ? +((hyp.effect.match(/\d+/) || [20])[0]) : 20;
    const count = st => D.lessons.filter(l => l.status === st).length;
    const act = D.strategyVersions.find(v => v.status === 'active');
    return card({
      class: 'dashboard-card',
      title: 'Модель учится',
      subtitle: 'Последний принятый урок',
      actions: [button('Все уроки', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#learning' })],
      body: [
        latest && h('figure', { class: 'dashboard-lesson' },
          h('div', { class: 'row', style: 'gap:6px' }, chip(latest.id, 'outline'), chip('Подтвержден', 'good', 'check'), latest.inPrompt && chip('В инструкциях анализа', 'accent', 'book')),
          h('p', null, latest.text),
          h('figcaption', { class: 'xsmall muted' }, latest.evidence + ' ' + fmt.plural(latest.evidence, 'случай', 'случая', 'случаев') + ' · ' + latest.effect + ' · ' + latest.scope + ' · с ' + fmt.date(latest.created)),
          isProcessLesson(latest) && h('div', { class: 'dashboard-howto' }, icon('info'), 'Урок про сбор данных: вероятности не меняет, убирает лишние поиски. Такие принимаются, если качество не хуже на 10+ случаях; уроки о вероятностях — от 20 своих случаев.')),
        hyp && h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row-between small' }, h('span', { class: 'soft', style: 'min-width:0' }, 'Проверяется гипотеза ', h('b', null, hyp.id), ': ', hyp.scope), h('span', { class: 'num', style: 'font-weight:600' }, hyp.evidence + ' из ' + need + ' случаев')),
          UI.meter(hyp.evidence, need)),
        h('dl', { class: 'dashboard-mini-stats' },
          h('div', null, h('dt', null, 'Принято'), h('dd', null, String(count('confirmed')))),
          h('div', null, h('dt', null, 'Гипотез'), h('dd', null, String(count('hypothesis')))),
          h('div', null, h('dt', null, 'Стратегия'), h('dd', null, act ? act.id : '—'))),
        h('div', { class: 'dashboard-howto' }, icon('info'), 'Веса нейросети не меняются: ИИ разбирает каждую рассчитанную ставку, а вывод попадает в инструкции анализа только после проверки на истории ставок.'),
      ],
    });
  }

  // Расходы ИИ (Р7, Р9, Р13). Участник на ключе администратора видит свой лимит, администратор — бюджет ключа.
  // Общие фоновые задачи (обновление профилей) оплачивает ключ администратора: в лимит участника они не входят.
  // Прогноз — по темпу 1–7 окт, как на экране «ИИ и расходы»; для бюджета ключа — с учетом личных лимитов.
  const SHARED_TYPES = ['refresh'];
  function costsCard() {
    const A = D.ai, me = D.me || {}, isAdmin = UI.auth.isAdmin;
    const day = +TODAY.slice(8, 10);
    const pace = v => v / day * 31;
    const runs = isAdmin ? A.runs : A.runs.filter(r => !SHARED_TYPES.includes(r.type));
    const todayRuns = runs.filter(r => r.at.slice(0, 10) === TODAY);
    const spentRuns = sum(runs, r => r.cost);
    const byType = {};
    runs.forEach(r => { byType[r.type] = (byType[r.type] || 0) + r.cost; });
    const top = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
    const topLabel = top ? (A.runTypes.find(t => t.id === top[0]) || { label: top[0] }).label : '—';
    const cacheShare = sum(runs, r => r.cached) / sum(runs, r => r.input) * 100;
    const kindOf = share => share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : 'good';
    const howto = text => h('div', { class: 'dashboard-howto' }, icon('info'), text);
    const valueRow = (spent, max, tail, share, what) => [
      h('div', { class: 'row-between', style: 'align-items:flex-end' },
        h('div', { style: 'min-width:0' }, h('span', { class: 'dashboard-cost-value' }, fmt.usd(spent)), h('span', { class: 'muted' }, ' из ' + fmt.usd(max, 0) + tail)),
        chip(fmt.pct(share * 100, 0) + ' ' + what, kindOf(share), share > 0.7 ? 'alert' : 'check')),
      (() => { const m = UI.meter(spent, max, share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : null); m.setAttribute('aria-label', 'Израсходовано ' + fmt.usd(spent) + ' из ' + fmt.usd(max, 0)); return m; })(),
    ];
    const title = 'Расходы ИИ в ' + (A.month === 'октябрь' ? 'октябре' : A.month);
    const more = button('Подробнее', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#costs' });

    if (isAdmin) {
      // Бюджет ключа администратора: все, кто на нем, и общие фоновые задачи
      const B = D.admin.budget;
      const onKey = D.users.filter(u => u.aiMode === 'admin' && u.status !== 'deleted');
      const forecast = sum(onKey, u => u.status !== 'active' ? u.spent : u.limit ? Math.min(u.limit.monthly, pace(u.spent)) : pace(u.spent)) + pace(B.shared);
      const others = onKey.filter(u => !u.you);
      return card({
        title, class: 'dashboard-card', subtitle: 'Бюджет ключа администратора', actions: [more],
        body: [
          ...valueRow(B.spent, B.monthly, '', B.spent / B.monthly, 'бюджета'),
          UI.kv([
            ['Вы', fmt.usd(me.spent || 0)],
            ['Участники на вашем ключе', fmt.usd(sum(others, u => u.spent))],
            ['Общие фоновые задачи', fmt.usd(B.shared)],
            ['Прогноз на месяц', '≈ ' + fmt.usd(forecast)],
          ]),
          howto('Прогноз учитывает личные лимиты участников. Ставки и банк участников вам не видны — только расход на ИИ.'),
        ],
        foot: [button('Администрирование', { kind: 'ghost', size: 'sm', icon: 'admin', iconRight: 'chevronRight', href: '#admin-usage', title: 'Расход ИИ по людям — в Администрировании' })],
      });
    }

    if (me.aiMode === 'own') {
      // Участник на своем ключе: расход с его счета, лимит администратора не действует
      return card({
        title, class: 'dashboard-card', subtitle: 'Свой ключ · расход с вашего счета Anthropic', actions: [more],
        body: [
          h('div', null, h('span', { class: 'dashboard-cost-value' }, fmt.usd(me.spent || 0)), h('span', { class: 'muted' }, ' за ' + (A.month === 'октябрь' ? 'октябрь' : A.month))),
          UI.kv([
            ['Прогноз на месяц', '≈ ' + fmt.usd(pace(me.spent || 0))],
            ['Из кэша', fmt.pct(cacheShare, 0) + ' входных токенов'],
            ['Сегодня', todayRuns.length + ' ' + fmt.plural(todayRuns.length, 'запуск', 'запуска', 'запусков') + ' · ' + fmt.usd(sum(todayRuns, r => r.cost))],
          ]),
          howto('Лимит трат на свой ключ вы ставите сами в консоли Anthropic.'),
        ],
      });
    }

    // Участник на ключе администратора: личный лимит
    const L = me.limit || D.LIMIT_DEFAULT;
    const spent = me.spent != null ? me.spent : spentRuns;
    const left = Math.max(0, L.monthly - spent);
    return card({
      title, class: 'dashboard-card', subtitle: 'Ваш лимит на ключе администратора', actions: [more],
      body: [
        ...valueRow(spent, L.monthly, ' · осталось ' + fmt.usd(left), spent / L.monthly, 'лимита'),
        UI.kv([
          ['Анализов сегодня', (me.todayAnalyses || 0) + ' из ' + L.daily],
          ['Прогноз на месяц', '≈ ' + fmt.usd(pace(spent))],
          ['Из кэша', fmt.pct(cacheShare, 0) + ' входных токенов'],
          ['Дороже всего', topLabel + ' · ' + fmt.pct(top ? top[1] / spentRuns * 100 : 0, 0)],
        ]),
        howto('Лимит меняет администратор. Общие фоновые задачи (обновление профилей) он оплачивает сам — в ваш лимит они не входят.'),
      ],
    });
  }

  const ord = (el, n) => { el.classList.add('dashboard-o-' + n); return el; };

  // ---------- экран ----------
  UI.register('dashboard', {
    title: 'Главная',
    render(root) {
      const mobile = UI.isMobile();
      const heroSlot = h('div', { style: 'min-width:0' });
      const tilesGrid = h('div', { class: 'grid dashboard-tiles' });
      const tilesLabel = h('span', { class: 'eyebrow' });
      const chartSlot = h('div', { style: 'min-width:0' });
      const noteSlot = h('div', { style: 'min-width:0', 'aria-live': 'polite' });

      function drawPeriod() {
        const p = PERIODS.find(x => x.id === periodId) || PERIODS[1];
        const st = periodStats(p);
        UI.clear(heroSlot).appendChild(heroCard(st));
        UI.append(UI.clear(tilesGrid), tiles(st));
        tilesLabel.textContent = 'Показатели ' + p.ctx;
        UI.clear(chartSlot).appendChild(chartCard(st, mobile));
        const note = smallSampleNote(st);
        UI.clear(noteSlot); noteSlot.hidden = !note; if (note) noteSlot.appendChild(note);
      }
      const head = headBlock(id => {
        periodId = id;
        try { sessionStorage.setItem('capper.dash.period', id); } catch (e) { /* ок */ }
        drawPeriod();
      });
      drawPeriod();

      if (mobile) {
        // Телефон: одна колонка, самое важное сверху — банк, открытые ставки, матчи дня
        UI.append(root, [
          head, noteSlot, heroSlot,
          openBetsCard(),
          matchesCard(),
          h('section', { class: 'stack', style: 'gap:10px', 'aria-label': 'Показатели за период' }, h('div', { class: 'dashboard-section-label' }, tilesLabel), tilesGrid),
          attentionCard(),
          chartSlot,
          learningCard(),
          costsCard(),
        ]);
        return;
      }
      UI.append(root, [
        head, noteSlot,
        h('div', { class: 'dashboard-top' }, heroSlot, tilesGrid),
        // Слева — что требует действий и матчи дня, затем история; справа — открытые ставки и состояние модели.
        // На ширине ≤1180 колонки «растворяются» и блоки встают по порядку важности (классы dashboard-o-N).
        h('div', { class: 'dashboard-main' },
          h('div', { class: 'dashboard-col' }, ord(attentionCard(), 2), ord(matchesCard(), 3), ord(chartSlot, 4)),
          h('div', { class: 'dashboard-col dashboard-side' }, ord(openBetsCard(), 1), ord(learningCard(), 5), ord(costsCard(), 6))),
      ]);
    },
  });
})();
