/* Главная: банк и показатели за выбранный период, открытые ставки, мои матчи сегодня (из своих ставок и анализов),
   «требует внимания» (ставки ждут результата, кандидат и урок ждут решения), «Модель учится», расходы ИИ.
   «Банк по дням» по В7 этапа 5: пунктир «вложено» ступенькой, отметка пополнения, главное число — прибыль ставок.
   Все цифры — из window.DATA. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, TODAY = DATA.today;

  // ---------- утилиты ----------
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const signedDec = (n, d) => (n > 0 ? '+' : '') + fmt.dec(n, d);
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  // Первый день истории — по данным на экране: у участника в режиме просмотра (Р27) он свой
  const firstDate = () => D.bankHistory[0].date;
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  const PERIODS = [
    { id: '7', label: '7 дней', days: 7, ctx: 'за 7 дней', prev: 'к пред. 7 дням' },
    { id: '30', label: '30 дней', days: 30, ctx: 'за 30 дней', prev: 'к пред. 30 дням' },
    { id: '90', label: '3 месяца', days: 90, ctx: 'за 3 месяца', prev: 'к пред. 3 месяцам' },
    { id: 'all', label: 'Все', days: null, get ctx() { return 'с ' + fmt.date(firstDate()); }, prev: null },
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
    // CLV — только ставки с внесенным закрывающим кэфом; ставки старого бота в CLV не входят (В5)
    const clvBets = bets.filter(b => b.clv != null && b.source !== 'bot');
    return {
      n: bets.length, wins, losses, voids, turnover, profit,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: clvBets.length ? sum(clvBets, b => b.clv) / clvBets.length : null,
      clvPos: clvBets.filter(b => b.clv > 0).length, clvN: clvBets.length,
    };
  }
  // Рынок при прогнозе без маржи (В2, степенной метод — Т3); у ног старого бота его нет — они в Brier не входят (В5)
  const marketQ = l => l.q;
  function brier(legs) {
    legs = legs.filter(l => l.q != null);
    if (!legs.length) return { model: null, market: null, n: 0 };
    const y = l => (l.result === 'win' ? 1 : 0);
    return { model: sum(legs, l => (l.p - y(l)) ** 2) / legs.length, market: sum(legs, l => (marketQ(l) - y(l)) ** 2) / legs.length, n: legs.length };
  }

  function periodStats(p) {
    const anchor = p.days ? addDays(TODAY, -p.days) : firstDate(); // банк на конец этого дня = старт периода
    const settled = D.bets.filter(b => b.status !== 'open' && b.date > anchor && b.date <= TODAY);
    const cur = summarize(settled);
    const legs = D.allLegs.filter(l => l.date > anchor);
    const startBank = bankAt(anchor);
    // В7: «вложено» — капитал на начало периода плюс пополнения и минус выводы внутри периода (ступенька)
    const invested0 = D.investedAt(anchor);
    const flows = D.bankFlows.filter(f => !f.start && f.at.slice(0, 10) > anchor && f.at.slice(0, 10) <= TODAY);
    const dates = [], values = [], invested = [];
    for (let d = anchor; d <= TODAY; d = addDays(d, 1)) { dates.push(d); values.push(bankAt(d)); invested.push(startBank + D.investedAt(d) - invested0); }
    // Просадка — только от ставок: пополнение сдвигает пик в той же доле, что и банк (Р22)
    let peak = startBank, maxDD = 0;
    values.forEach((v, i) => {
      const flow = i ? invested[i] - invested[i - 1] : 0;
      if (flow) { const before = v - flow; peak = before > 0 ? peak * v / before : v; }
      peak = Math.max(peak, v); maxDD = Math.min(maxDD, (v - peak) / peak * 100);
    });
    let prev = null;
    if (p.days) {
      const prevAnchor = addDays(anchor, -p.days);
      if (prevAnchor >= firstDate()) prev = summarize(D.bets.filter(b => b.status !== 'open' && b.date > prevAnchor && b.date <= anchor));
    }
    const flowSum = flows.reduce((a, f) => a + (f.kind === 'withdrawal' ? -f.amount : f.amount), 0);
    return { p, anchor, settled, cur, prev, brier: brier(legs), startBank, dates, values, invested, flows, flowSum, maxDD };
  }

  const openBets = () => D.bets.filter(b => b.status === 'open');
  const matchOf = leg => D.matchesToday.find(m => (m.p1 === leg.p1 && m.p2 === leg.p2) || (m.p1 === leg.p2 && m.p2 === leg.p1));
  const pairKey = (a, b) => [a, b].sort().join('|');
  // Мои матчи сегодня (В6): расписания в программе нет (Р10), поэтому только матчи с сегодняшней датой
  // из ног открытых ставок и из сегодняшних анализов. Время — из матча, который ввел участник (matches.scheduled_at).
  function myMatches() {
    const out = new Map();
    const add = (p1, p2) => {
      const k = pairKey(p1, p2);
      if (!out.has(k)) { const m = matchOf({ p1, p2 }); out.set(k, { p1, p2, time: m ? m.time : null, round: m ? m.round : null, tournament: m ? m.tournament : null, bets: [], analyses: [] }); }
      return out.get(k);
    };
    openBets().forEach(b => b.legs.forEach(l => { const m = matchOf(l); if (m && m.date === TODAY) add(l.p1, l.p2).bets.push({ bet: b, leg: l }); }));
    (D.recentAnalyses || []).filter(a => a.at.slice(0, 10) === TODAY).forEach(a => a.matches.forEach(x => {
      const m = matchOf(x); if (m && m.date === TODAY) add(x.p1, x.p2).analyses.push(a);
    }));
    return [...out.values()].sort((a, b) => (a.time || '99:99').localeCompare(b.time || '99:99'));
  }
  // «Сейчас» в макете — утро 7 октября по времени пользователя (как часы «Администрирования»).
  // Приветствие — по времени суток в поясе пользователя: 5–12 утро, 12–17 день, 17–23 вечер, иначе ночь
  const NOW = TODAY + 'T09:41';
  function greeting(iso) {
    const hh = +iso.slice(11, 13);
    return hh >= 5 && hh < 12 ? 'Доброе утро' : hh >= 12 && hh < 17 ? 'Добрый день' : hh >= 17 && hh < 23 ? 'Добрый вечер' : 'Доброй ночи';
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
  // Выплата — как на экране «Ставки» (payCur в bets.js): сумма ставки в валюте программы, округленная
  // до ее точности (рубль или цент), × кэф и снова до точности; обратно в рубли демо-данных для fmt.money
  const curDec = () => (UI.currency.list[UI.currency.code] || { dec: 0 }).dec;
  const roundCur = x => { const k = 10 ** curDec(); return Math.round(x * k) / k; };
  const payoutOf = (stake, k) => fmt.fromMoney(roundCur(fmt.moneyNum(stake) * k));
  // Время показываем в поясе пользователя: «время по Хельсинки» (город — из DATA.tzCity)
  const tzLabel = () => 'время по ' + D.tzCity(D.user.tz);
  // Лимиты и потолки: $10, $8, но $1,50 — как на остальных экранах
  const usdL = n => fmt.usd(n, Number.isInteger(n) ? 0 : 2);
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
    .dashboard-hero-kv dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); white-space: normal; }

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
    /* на телефоне зона нажатия имени — 40px в высоту, строка при этом не растет */
    @media (max-width: 960px) { .dashboard-player { display: inline-block; padding: 9px 0; margin: -9px 0; } }

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
    .dashboard-match { display: grid; grid-template-columns: 64px minmax(0, 1fr) auto; grid-template-areas: "time players action"; gap: 8px 18px; align-items: center; padding: 14px 18px; border-top: 1px solid var(--line); }
    .dashboard-match:first-child { border-top: 0; }
    .dashboard-match-time { grid-area: time; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .dashboard-match-time .mono { font-weight: 600; font-size: var(--fs-md); color: var(--fg); }
    .dashboard-match-time .xsmall { color: var(--fg-3); line-height: 1.25; }
    .dashboard-match-players { grid-area: players; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .dashboard-match-pair { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; min-width: 0; }
    .dashboard-match-name { display: flex; align-items: baseline; gap: 6px; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .dashboard-match-name .rank { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .dashboard-match-extra { display: flex; flex-wrap: wrap; gap: 6px; }
    .dashboard-match-action { grid-area: action; display: flex; justify-content: flex-end; }
    @container (max-width: 600px) {
      .dashboard-match { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "time action" "players players"; padding: 14px; gap: 10px 12px; }
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
    .dashboard-alert-text > span { display: block; }
    /* правила адаптации: название с действием и статус */
    .dashboard-rules { list-style: none; margin: 8px 0 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
    .dashboard-rules li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 10px; border-radius: var(--r-sm); background: var(--surface-2); min-width: 0; }
    .dashboard-rule-name { min-width: 0; color: var(--fg); font-weight: 500; }
    .dashboard-rule-name small { display: block; color: var(--fg-3); font-weight: 400; font-size: var(--fs-xs); }
    .dashboard-rules .chip { flex: none; }
    .dashboard-rule-note { display: flex !important; gap: 6px; align-items: flex-start; margin-top: 8px; font-size: var(--fs-xs); color: var(--fg-2); }
    .dashboard-rule-note svg { width: 14px; height: 14px; flex: none; margin-top: 2px; color: var(--fg-3); }
    @container (min-width: 560px) {
      .dashboard-alerts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
      .dashboard-alert, .dashboard-alert:first-child, .dashboard-alert:last-child { border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px; }
      .dashboard-alert.is-wide { grid-column: 1 / -1; }
    }

    /* «Модель учится» */
    .dashboard-learn { display: flex; flex-direction: column; margin: -4px 0; }
    .dashboard-learn-row { display: grid; grid-template-columns: 32px minmax(0, 1fr) 16px; gap: 10px; align-items: center; padding: 8px 0; min-height: 44px; color: var(--fg); text-decoration: none; border-top: 1px solid var(--line); }
    .dashboard-learn-row:first-child { border-top: 0; }
    .dashboard-learn-row:hover b { color: var(--accent-ink); }
    .dashboard-learn-row > svg { color: var(--fg-3); }
    .dashboard-learn-row b { display: block; font-weight: 600; font-size: var(--fs-sm); }
    .dashboard-learn-row small { display: block; font-size: var(--fs-xs); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dashboard-learn-ic { width: 32px; height: 32px; border-radius: 8px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); }
    .dashboard-learn-ic svg { width: 16px; height: 16px; }

    /* расходы */
    .dashboard-cost-value { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
  `);

  // ---------- блоки ----------
  function headBlock(onPeriod) {
    const d = new Date(TODAY + 'T12:00:00Z');
    const weekday = d.toLocaleDateString('ru-RU', { weekday: 'long', timeZone: 'UTC' });
    const dateStr = d.getUTCDate() + ' ' + MONTHS_GEN[d.getUTCMonth()] + ', ' + weekday;
    const nM = myMatches().length, nO = openBets().length;
    return h('div', { class: 'page-head dashboard-head' },
      h('div', { style: 'min-width:0' },
        h('h2', { title: 'Приветствие зависит от времени суток в вашем поясе' }, greeting(NOW) + ', ' + D.user.first),
        h('p', { class: 'lead' }, dateStr + ' · ' + nO + ' ' + fmt.plural(nO, 'ставка', 'ставки', 'ставок') + ' в игре' + (nM ? ', ' + nM + ' ' + fmt.plural(nM, 'мой матч', 'моих матча', 'моих матчей') + ' сегодня' : ''))),
      UI.segmented({ label: 'Период для показателей', items: PERIODS.map(p => ({ id: p.id, label: p.label })), active: periodId, onChange: onPeriod }));
  }

  // Короткая подпись пополнения или вывода: «+20 000 ₽ · пополнение, 14 сен»
  const flowLabel = (f, short) => fmt.signedMoney(f.kind === 'withdrawal' ? -f.amount : f.amount) + ' · ' + (f.kind === 'withdrawal' ? 'вывод' : 'пополнение') + (short ? '' : ', ' + fmt.date(f.at));
  function heroCard(st) {
    // В7: главное число периода — прибыль ставок и ROI, а не рост капитала (он смешивает прибыль с пополнением)
    const c = st.cur;
    const open = openBets();
    const inPlay = sum(open, b => b.stake);
    const fromPeak = (S.bank - S.peak) / S.peak * 100;
    return h('section', { class: 'card stat dashboard-hero', 'aria-label': 'Банк' },
      h('div', { class: 'dashboard-hero-top' },
        h('div', { class: 'stat-label' }, icon('wallet', { width: 16, height: 16 }), 'Банк', h('span', { class: 'xsmall muted', style: 'font-weight:400' }, '· с учетом ставок в игре')),
        h('div', { class: 'stat-value hero' }, fmt.money(S.bank)),
        h('div', { class: 'row', style: 'gap:8px' }, deltaEl(fmt.signedMoney(c.profit) + (c.roi != null ? ' · ROI ' + fmt.signedPct(c.roi) : ''), trendOf(c.profit)), h('span', { class: 'stat-hint' }, 'прибыль ставок ' + st.p.ctx))),
      h('div', { class: 'dashboard-hero-spark', title: 'Банк по дням ' + st.p.ctx }, UI.sparkline(st.values, { color: 'var(--s1)', width: 320, height: 52 })),
      h('dl', { class: 'dashboard-hero-kv' },
        h('div', { title: st.flows.length ? 'Внутри периода: ' + st.flows.map(f => flowLabel(f)).join('; ') : null }, h('dt', null, 'Старт периода'), h('dd', null, fmt.money(st.startBank), h('small', null, fmt.date(st.anchor) + (st.flowSum ? ' · ' + fmt.signedMoney(st.flowSum) + ' пополнение' : '')))),
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

    // CLV = ваш кэф ÷ закрывающий − 1 по закрытию, которое вы внесли (В1)
    const clvTile = { label: 'Средний CLV', icon: 'bolt', value: c.clv == null ? '—' : fmt.signedPct(Math.round(c.clv * 10) / 10),
      hint: c.clvN ? 'лучше закрытия в ' + c.clvPos + ' из ' + c.clvN : 'нет закрывающих кэфов' };

    // Brier рынка — рынок при прогнозе без маржи (В2)
    const b = st.brier;
    const brTile = { label: 'Brier модели', icon: 'target', value: b.model == null ? '—' : fmt.dec(b.model, 3) };
    if (b.model != null) {
      const diff = b.model - b.market;
      Object.assign(brTile, { delta: (Math.round(diff * 1000) === 0 ? '0,000' : signedDec(diff, 3)) + ' к рынку', trend: trendOf(Math.round(diff * 1000)), good: false, hint: 'рынок при прогнозе ' + fmt.dec(b.market, 3) + ' · ниже — лучше' });
    }
    return [roiTile, wrTile, clvTile, brTile].map(t => h('div', { class: 'col-6 half-mobile' }, UI.stat(t)))
      .concat(h('div', { class: 'col-12' }, h('div', { class: 'dashboard-howto' }, icon('info'),
        h('span', null, 'CLV — ваш кэф ÷ закрывающий − 1; закрывающий кэф вы вносите сами: эталона (' + D.marketRefRule + ') или своего букмекера. Brier рынка — по рынку в момент прогноза без маржи. Ставки старого бота входят в банк и ROI, но не в CLV и Brier.'))));
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
    // В7: пунктир «вложено» — ступенькой (старт периода и пополнения), в день пополнения — отметка с подписью
    const marks = st.flows.map(f => ({ i: st.dates.indexOf(f.at.slice(0, 10)), label: flowLabel(f, mobile), series: 0 }));
    const chart = UI.lineChart({
      labels: st.dates,
      series: [
        { name: 'Банк, ' + fmt.cur(), color: 'var(--s1)', values: st.values.map(fmt.moneyNum) },
        { name: 'Вложено', color: 'var(--fg-3)', values: st.invested.map(fmt.moneyNum), dashed: true, step: true, width: 1.5, noEnd: true },
      ],
      area: true, endLabel: true, height: mobile ? 200 : 250, marks,
      yFormat, xFormat: d => fmt.date(d), tipTitle: d => fmt.dateFull(d),
      ariaLabel: 'Банк по дням ' + st.p.ctx + ': с ' + fmt.money(st.startBank) + ' до ' + fmt.money(S.bank) + (st.flows.length ? '; ' + st.flows.map(f => flowLabel(f)).join('; ') : ''),
    });
    return card({
      class: 'dashboard-card',
      title: 'Динамика банка',
      subtitle: st.p.ctx[0].toUpperCase() + st.p.ctx.slice(1) + ', ' + curIn(),
      actions: [chip(fmt.signedMoney(c.profit), c.profit > 0 ? 'good' : c.profit < 0 ? 'bad' : 'outline', c.profit > 0 ? 'arrowUp' : c.profit < 0 ? 'arrowDown' : null)],
      body: [
        UI.legend([{ name: 'Банк на конец дня', color: 'var(--s1)' }, { name: 'Вложено: старт ' + fmt.money(st.startBank) + (st.flowSum ? ' и пополнения' : ''), type: 'dash' }]),
        UI.withTable(chart, () => betsTable(st, mobile)),
        h('div', { class: 'dashboard-howto' }, icon('info'), 'Как читать: линия банка выше пунктира «вложено» — ставки в плюсе на любом участке. Пополнение поднимает пунктир ступенькой и в прибыль не входит. ' + (mobile ? 'Коснитесь графика' : 'Наведите на график') + ', чтобы увидеть банк на любой день.'),
        h('dl', { class: 'dashboard-strip' },
          h('div', null, h('dt', null, 'Прибыль ставок'), h('dd', { class: c.profit > 0 ? 'good-text' : c.profit < 0 ? 'bad-text' : null }, fmt.signedMoney(c.profit))),
          h('div', null, h('dt', null, 'Пополнения'), h('dd', null, st.flowSum ? fmt.signedMoney(st.flowSum) : 'нет')),
          h('div', null, h('dt', null, 'Оборот'), h('dd', null, fmt.money(c.turnover))),
          h('div', null, h('dt', null, 'Макс. просадка'), h('dd', null, st.maxDD < 0 ? fmt.signedPct(st.maxDD) : '0%'))),
      ],
    });
  }

  function openBetsCard() {
    const open = openBets();
    const inPlay = sum(open, b => b.stake);
    const body = open.length ? open.map(b => {
      const payout = payoutOf(b.stake, b.total);
      return h('article', { class: 'dashboard-bet', 'aria-label': 'Ставка №' + b.id },
        h('div', { class: 'dashboard-bet-head' },
          h('div', null, h('strong', null, b.legs.length > 1 ? 'Экспресс из ' + b.legs.length + ' ' + fmt.plural(b.legs.length, 'события', 'событий', 'событий') : 'Ординар'), h('div', { class: 'xsmall muted' }, '№' + b.id + ' · ' + b.bookmaker + ' · ' + b.tournament + (b.awaiting ? ', ' + fmt.date(b.date) : ''))),
          b.awaiting ? chip('Ждет результата', 'warn', 'clock') : UI.statusChip('open')),
        h('ul', { class: 'dashboard-legs' }, b.legs.map(l => {
          const m = matchOf(l);
          const implied = 1 / l.odds;
          return h('li', { class: 'dashboard-leg' },
            h('span', { class: 'dashboard-leg-time' }, m ? m.time : b.awaiting ? fmt.date(b.date) : '—'),
            h('div', { class: 'dashboard-leg-match' }, playerLink(l.p1), ' — ', playerLink(l.p2)),
            h('span', { class: 'odds', 'aria-label': 'Кэф ' + fmt.odds(l.odds) }, fmt.odds(l.odds)),
            h('div', { class: 'dashboard-leg-meta', title: 'Вероятность исхода: оценка модели и 1/кэф букмекера (с его маржой)' }, h('b', null, l.marketLabel), h('span', null, 'модель ' + fmt.prob(l.p) + ' · по кэфу ' + fmt.prob(implied))));
        })),
        h('dl', { class: 'dashboard-bet-sum' },
          h('div', null, h('dt', null, 'Кэф'), h('dd', { class: 'odds' }, fmt.odds(b.total))),
          h('div', null, h('dt', null, 'Ставка'), h('dd', null, fmt.money(b.stake))),
          h('div', null, h('dt', null, 'Выплата'), h('dd', null, fmt.money(payout)))),
        b.awaiting && h('div', { class: 'dashboard-howto' }, icon('database'), 'Матчи сыграны ' + fmt.date(b.date) + ', а в архиве tennis-data они появятся после загрузки файла ≈ ' + fmt.date(D.archive.next) + '. Можно не ждать и внести результат самим.'),
        button('Внести результат', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#bets-' + b.id, block: true, ariaLabel: 'Внести результат ставки №' + b.id, ro: true }));
    }) : UI.empty('Открытых ставок нет. Запустите анализ матчей дня — ИИ предложит экспресс.');
    return card({
      class: 'dashboard-card',
      title: 'Открытые ставки',
      subtitle: open.length + ' ' + fmt.plural(open.length, 'ставка', 'ставки', 'ставок') + ' · в игре ' + fmt.money(inPlay),
      actions: [button('Все ставки', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#bets' })],
      body,
    });
  }

  // Мои матчи сегодня (В6): ноги открытых ставок и матчи сегодняшних анализов. Кэфов-примеров и «Все матчи дня
  // в анализ» нет — линии и расписания в программе нет (Р10)
  function myMatchesCard() {
    const list = myMatches();
    const rows = list.map(x => {
      const pl = id => h('div', { class: 'dashboard-match-name' }, playerLink(id), D.P[id] && h('span', { class: 'rank', title: 'Место по Эло среди игроков с матчами за 52 недели' }, '№' + D.P[id].eloPlace));
      const tags = [
        ...x.bets.map(({ bet, leg }) => chip('В ставке №' + bet.id + ' · ' + leg.marketLabel + ' ' + fmt.odds(leg.odds), 'accent', 'ticket')),
        ...x.analyses.map(a => chip('Анализ #' + a.id, 'outline', 'spark')),
      ];
      const action = x.bets.length
        ? button('Ставка №' + x.bets[0].bet.id, { kind: 'secondary', size: 'sm', icon: 'ticket', href: '#bets-' + x.bets[0].bet.id, ariaLabel: 'Открыть ставку №' + x.bets[0].bet.id })
        : button('Анализ', { kind: 'secondary', size: 'sm', icon: 'spark', href: '#analysis-' + x.analyses[0].id, ariaLabel: 'Открыть анализ #' + x.analyses[0].id });
      return h('article', { class: 'dashboard-match', 'aria-label': DATA.match(x) + (x.time ? ', ' + x.time : '') },
        h('div', { class: 'dashboard-match-time' }, h('span', { class: 'mono' }, x.time || '—'), h('span', { class: 'xsmall' }, [x.tournament, x.round].filter(Boolean).join(', '))),
        h('div', { class: 'dashboard-match-players' }, h('div', { class: 'dashboard-match-pair' }, pl(x.p1), h('span', { class: 'muted', 'aria-hidden': 'true' }, '—'), pl(x.p2)), h('div', { class: 'dashboard-match-extra' }, tags)),
        h('div', { class: 'dashboard-match-action' }, action));
    });
    const nb = list.filter(x => x.bets.length).length, na = list.length - nb;
    return card({
      class: 'dashboard-matches-card dashboard-card',
      title: 'Мои матчи сегодня',
      subtitle: list.length ? (nb ? nb + ' в ставках' : '') + (nb && na ? ' · ' : '') + (na ? na + ' в анализах' : '') + ' · ' + tzLabel() : 'Из ваших ставок и анализов',
      flush: true,
      body: list.length ? h('div', null, rows) : h('div', { style: 'padding:14px 18px' }, UI.empty('Сегодня в ваших ставках и анализах матчей нет.')),
      foot: [
        button('Новый анализ', { kind: 'primary', size: 'sm', icon: 'spark', href: '#new', ro: 'Только просмотр: анализ запускает сам участник' }),
        h('span', { class: 'xsmall muted', style: 'min-width:0;flex:1 1 220px' }, 'Здесь только матчи из ваших ставок и анализов: расписания и линии кэфов в программе нет. Матчи и кэфы своей линии вписываете в «Новом анализе».'),
      ],
    });
  }

  // Дела администратора (Р8): просьбы вернуть ключ администратора и участники у лимита.
  // DATA.ai.decisions() — тот же список, по которому считается значок у пункта меню «Администрирование».
  function adminTodo() {
    return D.ai.decisions().map(d => d.kind === 'return'
      ? d.user.name + ' просит вернуть ключ администратора.'
      : d.user.name + ' — уже ' + fmt.pct(d.ratio * 100, 0) + ' месячного лимита (' + fmt.usd(D.ai.keySpent(d.user)) + ' из ' + usdL(D.ai.limitOf(d.user).monthly) + ').');
  }

  // Файл tennis-data не загружали больше 7 дней (уведомление data_stale) — только администратору
  const daysSince = iso => Math.floor((Date.parse(NOW + ':00Z') - Date.parse(iso + ':00Z')) / 86400000);
  function attentionCard() {
    const list = h('div', { class: 'dashboard-alerts' });
    const isAdmin = UI.auth.isAdmin;
    const items = [];
    // Этап 5 (В1): ставки ждут результата, пока матчей нет в загруженном файле tennis-data — задержка до недели
    const waiting = openBets().filter(b => b.awaiting);
    if (waiting.length) items.push({
      tone: 'warn', ic: 'clock', sr: 'Ждет результата',
      title: waiting.length + ' ' + fmt.plural(waiting.length, 'ставка ждет', 'ставки ждут', 'ставок ждут') + ' результата',
      text: 'В архиве tennis-data матчи по ' + fmt.date(D.archive.matchesTo) + ', следующий файл ≈ ' + fmt.date(D.archive.next) + ' — тогда ставки рассчитаются сами. Можно внести результат и раньше: по новостям уже есть подсказка.',
      action: button('Внести результат', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#bets-' + waiting[0].id, ro: true }),
    });
    if (isAdmin && D.archive) {
      const days = daysSince(D.archive.lastLoad);
      if (days > D.archive.staleDays) items.push({
        tone: 'warn', ic: 'database', sr: 'Предупреждение',
        title: 'Файл tennis-data не загружали ' + days + ' ' + fmt.plural(days, 'день', 'дня', 'дней'),
        text: 'В архиве матчи по ' + fmt.date(D.archive.matchesTo) + '. Ставки после этой даты не рассчитаются сами, Эло — без новых матчей.',
        action: button('Загрузить файл', { kind: 'secondary', size: 'sm', icon: 'upload', href: '#admin-data' }),
      });
    }
    // Решения администратора по обучению (В4, В5): общий кандидат инструкций и урок, готовый к проверке
    const L = D.learning;
    const cand = L.versions.find(v => v.status === 'candidate'), ready = L.lessons.filter(x => x.status === 'ready');
    if (isAdmin && (cand || ready.length)) items.push({
      tone: 'accent', ic: 'brain', sr: 'Нужно решение',
      title: 'Обучение модели: ' + [cand && 'кандидат ' + cand.id + ' ждет решения', ready.length && 'урок ' + ready.map(x => x.id).join(', ') + ' готов к проверке'].filter(Boolean).join(', '),
      text: [cand && cand.cmp ? cand.id + ' прошел правило экономии: качество не хуже ' + cand.cmp.base + ', токенов ' + fmt.signedPct(cand.cmp.tokens, 0) + '.' : null, ready.length ? 'Урок подтвержден на истории; в анализ — после быстрой проверки ≈ ' + fmt.usd(D.ai.eval.quickCheck) + ' и вашего «да».' : null].filter(Boolean).join(' '),
      action: button('Обучение модели', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: cand ? '#learning-versions' : '#learning-lessons' }),
    });
    if (isAdmin) {
      const todo = adminTodo();
      if (todo.length) items.push({
        tone: 'info', ic: 'admin', sr: 'Нужно решение',
        title: 'Администрирование: ' + todo.length + ' ' + fmt.plural(todo.length, 'дело', 'дела', 'дел'),
        text: todo.join(' '),
        action: button('Открыть Администрирование', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#admin' }),
      });
    }
    // Адаптации размера ставки (Р22) — те же правила, что в «Профиль → Банк и стратегия».
    // В7: «рост банка» и «прибыльная неделя» по умолчанию выключены, статус остальных считается из DATA.stats
    const fromPeak = (S.bank - S.peak) / S.peak * 100, growth = (S.bank - S.invested) / S.invested * 100;
    const weekBase = D.bankHistory.filter(x => x.date <= addDays(D.today, -7)).pop() || D.bankHistory[0];
    const week = (S.bank - weekBase.bank) / weekBase.bank * 100;
    const cond = {
      dd10: fromPeak <= -10 && fromPeak > -20, dd20: fromPeak <= -20, week_loss: week <= -5,
      up15: growth >= 15 && S.winrate >= 60, week_win: week >= 10,
    };
    const rules = D.strategy.adapt.map(r => Object.assign({}, r, { met: cond[r.key], active: r.on && cond[r.key] }));
    const active = rules.filter(r => r.active);
    const off = rules.filter(r => !r.on);
    const STATUS = r => (!r.on ? chip('Выключено', 'outline', 'pause') : r.active ? chip('Действует', 'warn', 'alert') : chip('Ждет условия', 'info', 'clock'));
    items.push({
      tone: active.length ? 'warn' : 'info', ic: 'shield', sr: active.length ? 'Предупреждение' : 'Информация',
      title: active.length ? 'Размер ставки изменен правилом адаптации' : 'Размер ставки: адаптации не действуют',
      text: [
        h('span', null, (fromPeak < 0 ? 'Банк ' + fmt.signedPct(fromPeak) + ' от пика' : 'Банк на пике') + ', за 7 дней ' + fmt.signedPct(week) + ', к вложенному ' + fmt.signedPct(growth) + ', винрейт ' + fmt.pct(S.winrate) + '. '
          + (active.length ? 'Сейчас ' + active.map(r => r.effect).join('; ') + '.' : 'Сегодня суммы — по таблице стратегии.')),
        h('ul', { class: 'dashboard-rules', 'aria-label': 'Правила адаптации' }, rules.map(r => h('li', null,
          h('span', { class: 'dashboard-rule-name' }, r.label, h('small', null, r.effect)), STATUS(r)))),
        off.length ? h('span', { class: 'dashboard-rule-note' }, icon('info'), h('span', null, h('b', null, 'По умолчанию выключены: '), off.map(r => '«' + r.label.toLowerCase() + '»').join(' и ') + '. В утвержденных правилах суммы их нет, они опираются на короткие серии, то есть на шум. Включенные, они увеличили бы следующие ставки' + (off.some(r => r.met) ? ' — и сейчас бы сработали' : '; сейчас не сработали бы и включенными') + '.')) : null,
        // Правила суммы — свои у каждого и меняются новой версией (этап 5): рост ставки выключен версией r2
        off.length ? h('span', { class: 'dashboard-rule-note' }, icon('history'), h('span', null, 'Выключены версией правил r2. Изменить — «Предложить изменение» в «Правилах ставок»: новая версия сначала кандидат, потом вы ее включаете.')) : null,
      ],
      action: button('Правила ставок', { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', href: '#profile-bank' }),
      wide: true,
    });
    items.forEach(it => list.appendChild(h('div', { class: ['dashboard-alert', it.wide && 'is-wide'] },
      h('div', { class: ['dashboard-alert-ic', it.tone] }, icon(it.ic)),
      h('div', { class: 'dashboard-alert-body' },
        h('div', { class: 'dashboard-alert-title' }, h('span', { class: 'sr-only' }, it.sr + '. '), it.title),
        h('div', { class: 'dashboard-alert-text' }, it.text),
        it.action))));
    const n = items.length;
    return card({ class: 'dashboard-card dashboard-attn-card', title: 'Требует внимания', subtitle: n + ' ' + fmt.plural(n, 'пункт', 'пункта', 'пунктов') + ' · ' + (isAdmin ? 'стратегия, архив и администрирование' : 'стратегия'), body: list });
  }

  // «Модель учится» (этап 5): разборы рассчитанных ставок, последний урок, гипотезы, кандидат версии, отчет недели.
  // Уроки и инструкции общие (В5): участник видит, что учится, а решения принимает администратор
  function learningCard() {
    const L = D.learning, isAdmin = UI.auth.isAdmin;
    const inPrompt = L.lessons.filter(x => x.status === 'confirmed' && x.inPrompt);
    const hyp = L.lessons.filter(x => x.status === 'hypothesis');
    const ready = L.lessons.filter(x => x.status === 'ready');
    const cand = L.versions.find(v => v.status === 'candidate'), act = L.versions.find(v => v.status === 'active');
    const lastLesson = L.lessons.filter(x => x.status !== 'rejected' && x.status !== 'retired').slice().sort((a, b) => b.created.localeCompare(a.created))[0];
    const appSettled = D.bets.filter(b => b.source === 'app' && b.status !== 'open');
    const auto = appSettled.filter(b => b.settledBy === 'auto').length;
    const rep = L.weekReport(L.reportWeeks[0]);
    const row = (ic, title, meta, href) => h('a', { class: 'dashboard-learn-row', href }, h('span', { class: 'dashboard-learn-ic', 'aria-hidden': 'true' }, icon(ic)), h('span', { style: 'min-width:0' }, h('b', null, title), h('small', null, meta)), icon('chevronRight', { width: 16, height: 16 }));
    return card({
      class: 'dashboard-card',
      title: 'Модель учится',
      subtitle: 'Рассчитано ' + appSettled.length + ' ' + fmt.plural(appSettled.length, 'ставка', 'ставки', 'ставок') + ' приложения, ' + auto + ' — по архиву',
      body: [
        h('div', { class: 'dashboard-learn' },
          row('book', 'В анализе ' + inPrompt.length + ' ' + fmt.plural(inPrompt.length, 'урок', 'урока', 'уроков') + ' из ' + L.LESSONS_MAX, hyp.length + ' ' + fmt.plural(hyp.length, 'гипотеза копит', 'гипотезы копят', 'гипотез копят') + ' случаи' + (ready.length ? ' · ' + ready[0].id + ' готов к проверке' : ''), '#learning-lessons'),
          lastLesson && row('flask', 'Последний: ' + lastLesson.id, lastLesson.text, '#learning-lessons'),
          row('layers', 'Инструкции ' + (act ? act.id : '—') + (cand ? ' · кандидат ' + cand.id : ''), cand ? (isAdmin ? 'ждет вашего решения' : 'ждет решения администратора') + ': не хуже ' + (act ? act.id : '') + ', дешевле' : 'кандидатов нет', '#learning-versions'),
          row('calendar', 'Отчет за ' + fmt.date(rep.from) + ' – ' + fmt.date(rep.to), rep.n + ' ' + fmt.plural(rep.n, 'ставка', 'ставки', 'ставок') + ' · ' + fmt.signedMoney(rep.profit) + ' · следующий ' + fmt.date(L.nextReport) + ', 07:00', '#learning-reports')),
      ],
      foot: [button('Обучение модели', { kind: 'ghost', size: 'sm', icon: 'brain', iconRight: 'chevronRight', href: '#learning' })],
    });
  }

  // Расходы ИИ (Р7, Р9, Р13). Участник на ключе администратора видит свой лимит, администратор — бюджет ключа.
  // Бюджет ключа, расход по людям и лимиты — только общий расчет DATA.ai (budget, keySpent, ownSpent, keyUsers,
  // limitOf): те же цифры, что в «ИИ и расходах» и «Администрировании». Задачи — по коду этапа 3 (Т19): разбор текста,
  // новости перед анализом, оценка матча. Общие фоновые задачи (вызовы без участника — приемка) оплачивает
  // администратор, в лимит участника они не входят; проверки (eval) — отдельный бюджет и в общий не входят.
  const PAUSED = 'Анализы на паузе — решение администратора';
  function costsCard() {
    const A = D.ai, me = D.me || {}, isAdmin = UI.auth.isAdmin;
    const day = +TODAY.slice(8, 10);
    const pace = v => v / day * 31; // темп 1–7 окт на месяц — для личного прогноза, как в DATA.ai.budget()
    const runs = isAdmin ? A.runs : A.runs.filter(r => !A.isShared(r));
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
        h('div', { style: 'min-width:0' }, h('span', { class: 'dashboard-cost-value' }, fmt.usd(spent)), h('span', { class: 'muted' }, ' из ' + usdL(max) + tail)),
        chip(fmt.pct(share * 100, 0) + ' ' + what, kindOf(share), share > 0.7 ? 'alert' : 'check')),
      (() => { const m = UI.meter(spent, max, share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : null); m.setAttribute('aria-label', 'Израсходовано ' + fmt.usd(spent) + ' из ' + usdL(max)); return m; })(),
    ];
    const title = 'Расходы ИИ в ' + (A.month === 'октябрь' ? 'октябре' : A.month);
    const more = button('Подробнее', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#costs' });

    if (isAdmin) {
      // Бюджет ключа администратора: «Вы» + «Участники на вашем ключе» + «Общие фоновые задачи» = DATA.ai.budget().spent
      const B = A.budget();
      const others = A.keyUsers().filter(u => u !== me);
      return card({
        title, class: 'dashboard-card', subtitle: 'Бюджет ключа администратора', actions: [more],
        body: [
          ...valueRow(B.spent, B.monthly, '', B.share, 'бюджета'),
          UI.kv([
            ['Вы', fmt.usd(A.keySpent(me))],
            ['Участники на вашем ключе', fmt.usd(sum(others, A.keySpent))],
            ['Общие фоновые задачи', fmt.usd(B.shared)],
            ['Прогноз на месяц', '≈ ' + fmt.usd(B.forecast)],
            ['Проверки (eval), отдельно', fmt.usd(A.eval.spent) + ' из ' + usdL(A.eval.monthly) + (A.eval.firstMonth ? ' · с ноября ' + usdL(A.eval.next) : '')],
          ]),
          howto('Общие фоновые задачи — вызовы без участника: разборы рассчитанных ставок (Sonnet 5.5 через Batch, ≈ $0,01 за матч) и приемка этапа. Проверки идут из своего бюджета и в общий не входят. Прогноз учитывает личные лимиты участников. Ставки и банк участников — в «Администрирование → Сводка», только просмотр.'),
        ],
        foot: [button('Администрирование', { kind: 'ghost', size: 'sm', icon: 'admin', iconRight: 'chevronRight', href: '#admin-usage', title: 'Расход ИИ по людям — в Администрировании' })],
      });
    }

    if (me.aiMode === 'own') {
      // Участник на своем ключе: расход с его счета (DATA.ai.ownSpent), до перехода — на ключе администратора (DATA.ai.keySpent)
      const own = A.ownSpent(me), before = A.keySpent(me);
      const cap = me.ownCap != null ? me.ownCap : D.admin.defaults.perAnalysis;
      return card({
        title, class: 'dashboard-card', subtitle: 'Свой ключ · расход с вашего счета Anthropic', actions: [more],
        body: [
          h('div', null, h('span', { class: 'dashboard-cost-value' }, fmt.usd(own)), h('span', { class: 'muted' }, ' с вашего счета за ' + (A.month === 'октябрь' ? 'октябрь' : A.month))),
          UI.kv([
            before > 0 ? ['До перехода', fmt.usd(before)] : ['Прогноз на месяц', '≈ ' + fmt.usd(pace(own))],
            ['Потолок на анализ', 'до ' + usdL(cap)],
            ['Из кэша', fmt.pct(cacheShare, 0) + ' входных токенов'],
          ]),
          howto((before > 0 ? 'До перехода на свой ключ анализы шли на ключе администратора — эти ' + fmt.usd(before) + ' в его бюджете. ' : '') + 'Лимит трат на месяц вы ставите сами в консоли Anthropic, потолок на анализ — в личном кабинете.'),
        ],
        foot: [button('Ключ Claude', { kind: 'ghost', size: 'sm', icon: 'key', iconRight: 'chevronRight', href: '#profile-key' })],
      });
    }

    // Участник на ключе администратора: личный лимит (DATA.ai.limitOf) и расход на этом ключе (DATA.ai.keySpent)
    const L = A.limitOf(me) || Object.assign({}, D.admin.defaults);
    const spent = A.keySpent(me);
    const left = Math.max(0, L.monthly - spent);
    const forecast = L.paused ? spent : Math.min(L.monthly, pace(spent)); // на 100% лимита анализы останавливаются
    return card({
      title, class: 'dashboard-card', subtitle: 'Ваш лимит на ключе администратора', actions: [more],
      body: [
        ...valueRow(spent, L.monthly, ' · осталось ' + fmt.usd(left), spent / L.monthly, 'лимита'),
        L.paused ? UI.callout('warn', 'pause', h('b', null, PAUSED), '. Новые анализы не запускаются, пока администратор не снимет паузу.') : null,
        UI.kv([
          ['Анализов сегодня', (me.todayAnalyses || 0) + ' из ' + L.daily],
          ['Прогноз на месяц', '≈ ' + fmt.usd(forecast)],
          ['Из кэша', fmt.pct(cacheShare, 0) + ' входных токенов'],
          ['Дороже всего', topLabel + ' · ' + fmt.pct(top ? top[1] / spentRuns * 100 : 0, 0)],
        ]),
        howto('Лимит меняет администратор. В цену анализа входят разбор текста, новости перед анализом (Sonnet 5.5 с веб-поиском) и оценка матчей (Opus 5.5).'),
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
        // Телефон: одна колонка, самое важное сверху — банк, открытые ставки, мои матчи сегодня
        UI.append(root, [
          head, noteSlot, heroSlot,
          openBetsCard(),
          myMatchesCard(),
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
        // Слева — что требует действий и мои матчи сегодня, затем история; справа — открытые ставки, «Модель учится» и расходы.
        // На ширине ≤1180 колонки «растворяются» и блоки встают по порядку важности (классы dashboard-o-N).
        h('div', { class: 'dashboard-main' },
          h('div', { class: 'dashboard-col' }, ord(attentionCard(), 2), ord(myMatchesCard(), 3), ord(chartSlot, 4)),
          h('div', { class: 'dashboard-col dashboard-side' }, ord(openBetsCard(), 1), ord(learningCard(), 5), ord(costsCard(), 6))),
      ]);
    },
  });
})();
