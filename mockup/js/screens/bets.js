/* Экран «Ставки»: итоги по фильтрам, открытые ставки с вводом результата и закрывающего кэфа,
   история (таблица с раскрытием на компьютере, карточки и нижний лист на телефоне), разбор ставки ИИ.
   Все цифры — из window.DATA; расчет ставки меняет DATA в памяти (банк, статистика, история банка). */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, TODAY = DATA.today;

  // ---------- утилиты ----------
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const r1 = n => Math.round(n * 10) / 10;
  const r2 = n => Math.round(n * 100) / 100;
  const plural = fmt.plural;
  const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
  const monthName = ym => MONTHS_NOM[+ym.slice(5, 7) - 1] + ' ' + ym.slice(0, 4);
  const pname = id => D.playerName(id);
  const betsWord = n => plural(n, 'ставка', 'ставки', 'ставок');
  const betKind = b => (b.legs.length > 1 ? 'Экспресс × ' + b.legs.length : 'Ординар');
  const betKindLong = b => (b.legs.length > 1 ? 'Экспресс из ' + b.legs.length + ' ' + plural(b.legs.length, 'события', 'событий', 'событий') : 'Ординар');
  const matchOf = l => D.matchesToday.find(m => m.p1 === l.p1 && m.p2 === l.p2);
  const legRes = (b, l) => (b.status === 'void' ? 'void' : l.result);
  const toneCls = v => (v == null ? 'muted' : v > 0 ? 'good-text' : v < 0 ? 'bad-text' : 'muted');
  const clvText = v => (v == null ? '—' : fmt.signedPct(v, 1));
  const pctOrDash = v => (v == null ? '—' : fmt.signedPct(v, 1));
  const signedPP = v => { const n = Math.round(v); return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' п.п.'; };
  const dateLabel = d => (d === TODAY ? 'сегодня' : fmt.date(d));
  const payoutOf = b => (b.status === 'open' ? null : b.stake + b.profit);
  const legClv = l => (l.closing ? (l.odds / l.closing - 1) * 100 : null);
  const surfLabel = k => (D.surfaces[k] ? D.surfaces[k].label : k);

  function plink(id) {
    const p = D.P[id];
    return h('a', { class: 'bets-plink', href: '#player-' + id, title: p ? p.name + ' — карточка игрока' : id, on: { click: e => e.stopPropagation() } }, pname(id));
  }

  const RES = { win: ['Зашло', 'check'], loss: ['Не зашло', 'x'], void: ['Возврат', 'refresh'], open: ['Еще не сыграно', 'clock'] };
  function resIcon(r) {
    const [t, ic] = RES[r] || RES.open;
    return h('span', { class: 'bets-res ' + r, role: 'img', 'aria-label': t, title: t }, icon(ic));
  }
  const RES_CHIP = { win: ['Зашло', 'good', 'check'], loss: ['Не зашло', 'bad', 'x'], void: ['Возврат', 'outline', 'refresh'], open: ['Ждем матч', 'info', 'clock'] };
  const resChip = r => { const [t, k, i] = RES_CHIP[r] || RES_CHIP.open; return chip(t, k, i); };

  // Счет по сетам для истории (в демо-данных его нет): согласован с рынком и исходом
  const SCORES = {
    p1: { win: ['2:0', '2:1'], loss: ['1:2', '0:2'] },
    p2: { win: ['0:2', '1:2'], loss: ['2:0', '2:1'] },
    h1m: { win: ['2:0'], loss: ['2:1', '1:2', '0:2'] },
    h2p: { win: ['2:1', '1:2', '0:2'], loss: ['2:0'] },
    h1p: { win: ['2:1', '1:2', '2:0'], loss: ['0:2'] },
  };
  function legScore(b, l, i) {
    if (l.score) return l.score;
    if (b.status === 'void' || l.result === 'open') return null;
    const opts = (SCORES[l.market] || SCORES.p1)[l.result] || [];
    return opts.length ? opts[(b.id * 7 + i * 3) % opts.length] : null;
  }
  // «2:0», «2-1», «21» → [2, 0]; матчи Masters — до двух выигранных сетов
  function parseScore(s) {
    const m = String(s).trim().match(/^(\d)\s*[:\-–.\s]?\s*(\d)$/);
    if (!m) return null;
    const a = +m[1], b = +m[2];
    return (a === 2 && b < 2) || (b === 2 && a < 2) ? [a, b] : null;
  }
  function resultFromScore(market, a, b) {
    switch (market) {
      case 'p1': return a > b ? 'win' : 'loss';
      case 'p2': return b > a ? 'win' : 'loss';
      case 'h1m': return a - b >= 2 ? 'win' : 'loss';
      case 'h2p': return a - b >= 2 ? 'loss' : 'win';
      case 'h1p': return b - a >= 2 ? 'loss' : 'win';
      default: return null;
    }
  }
  function parseOdds(s) {
    const v = parseFloat(String(s).replace(',', '.'));
    return isFinite(v) && v >= 1.01 && v <= 50 ? r2(v) : null;
  }

  // Вердикт разбора: отделяем дисперсию от возможной ошибки модели по закрывающей линии
  function verdict(b) {
    if (b.status === 'void') return { label: 'Без разбора', kind: 'outline', icon: 'refresh' };
    if (b.status === 'open') return null;
    if (b.status === 'win') return b.clv != null && b.clv < 0 ? { label: 'Выигрыш против рынка', kind: 'warn', icon: 'alert' } : { label: 'Перевес подтвержден', kind: 'good', icon: 'check' };
    const lost = b.legs.filter(l => l.result === 'loss');
    const against = lost.some(l => legClv(l) != null && legClv(l) < 0);
    return against ? { label: 'Возможна ошибка модели', kind: 'serious', icon: 'alert' } : { label: 'Дисперсия', kind: 'info', icon: 'info' };
  }
  const verdictChip = b => { const v = verdict(b); return v ? chip(v.label, v.kind, v.icon) : null; };

  // ---------- фильтры и состояние ----------
  const PERIODS = [
    { id: '7', label: '7 дней', days: 7 },
    { id: '30', label: '30 дней', days: 30 },
    { id: '90', label: '3 месяца', days: 90 },
    { id: 'all', label: 'Все время', days: null },
  ];
  const STATUS_OPTS = [
    { value: 'all', label: 'Все статусы' }, { value: 'open', label: 'В игре' }, { value: 'win', label: 'Выигрыш' },
    { value: 'loss', label: 'Проигрыш' }, { value: 'void', label: 'Возврат' },
  ];
  const MARKET_OPTS = [{ value: 'all', label: 'Все рынки' }].concat(D.markets.map(m => ({ value: m.id, label: m.label })));
  const SURF_KEYS = Object.keys(D.surfaces).filter(k => D.bets.some(b => b.surface === k));
  const blank = () => ({ period: 'all', status: 'all', market: 'all', surfaces: new Set(), q: '' });
  let F = blank();
  const PAGE = 20;
  let shown = PAGE;
  const expanded = new Set();
  let expandInit = false;
  let lastSettled = null; // {id} — ставка, рассчитанная в этой сессии
  let justSaved = null; // номер ставки, только что сохраненной на экране «Анализ»
  let ui = null;

  const norm = s => String(s).toLowerCase().replace(/е/g, 'е');
  function matches(b, flt) {
    const p = PERIODS.find(x => x.id === flt.period);
    if (p && p.days && b.date <= addDays(TODAY, -p.days)) return false;
    if (flt.status !== 'all' && b.status !== flt.status) return false;
    if (flt.market !== 'all' && !b.legs.some(l => l.market === flt.market)) return false;
    if (flt.surfaces.size && !flt.surfaces.has(b.surface)) return false;
    if (flt.q) {
      const q = norm(flt.q);
      const hay = b.legs.map(l => [l.p1, l.p2].map(id => (D.P[id] ? D.P[id].name : id)).join(' ')).join(' ') + ' ' + b.tournament + ' ' + b.bookmaker + ' №' + b.id;
      if (!norm(hay).includes(q)) return false;
    }
    return true;
  }
  const newestFirst = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id);
  const filtered = (flt = F) => D.bets.filter(b => matches(b, flt)).sort(newestFirst);
  const sheetActive = flt => (flt.status !== 'all' ? 1 : 0) + (flt.market !== 'all' ? 1 : 0) + flt.surfaces.size;
  const anyActive = flt => sheetActive(flt) + (flt.period !== 'all' ? 1 : 0) + (flt.q ? 1 : 0);
  function describe(flt) {
    const parts = [];
    const p = PERIODS.find(x => x.id === flt.period);
    parts.push(p.days ? 'за ' + p.label : 'за все время');
    if (flt.status !== 'all') parts.push(STATUS_OPTS.find(o => o.value === flt.status).label.toLowerCase());
    if (flt.market !== 'all') parts.push(MARKET_OPTS.find(o => o.value === flt.market).label);
    if (flt.surfaces.size) parts.push([...flt.surfaces].map(k => surfLabel(k).toLowerCase()).join(', '));
    if (flt.q) parts.push('«' + flt.q + '»');
    return parts.join(' · ');
  }
  function resetFilters() { F = blank(); shown = PAGE; build(); }

  // ---------- стили ----------
  const CSS = `
    .bets-why { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .bets-why li { display: flex; flex-direction: column; gap: 3px; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); min-width: 0; }
    .bets-why-top { display: flex; justify-content: space-between; align-items: baseline; gap: 4px 10px; flex-wrap: wrap; min-width: 0; }
    .bets-why-top .odds { white-space: nowrap; }
    .bets-head .lead { max-width: 70ch; }
    .bets-head h2 { font-size: var(--fs-2xl); }
    @media (max-width: 720px) { .bets-head h2 { font-size: var(--fs-xl); } }

    .bets-filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; min-width: 0; }
    .bets-search { position: relative; flex: 1 1 220px; min-width: 0; }
    .bets-search > svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 16px; height: 16px; color: var(--fg-3); pointer-events: none; }
    .bets-search .input { height: 38px; padding-left: 34px; }
    .bets-filters .bets-select { width: auto; height: 38px; flex: none; }
    .bets-chips { display: flex; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .bets-chipbtn { display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; white-space: nowrap; }
    .bets-chipbtn:hover { background: var(--surface-2); color: var(--fg); }
    .bets-chipbtn .bets-dot { width: 9px; height: 9px; }
    .bets-chipbtn svg { width: 14px; height: 14px; flex: none; }
    .bets-chipbtn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-ink); }
    .bets-nw { white-space: nowrap; }
    .bets-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; flex: none; }

    .bets-mfilters { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .bets-mrow { display: flex; gap: 8px; min-width: 0; }
    .bets-mrow .bets-search { flex: 1 1 auto; }
    .bets-mrow .btn { height: 38px; flex: none; }
    .chip.bets-fcount { height: 20px; padding: 0 7px; margin-left: -2px; }
    .bets-mfilters .segmented { display: flex; width: 100%; }
    .bets-mfilters .segmented button { flex: 1; padding-inline: 6px; }
    .bets-active { display: flex; gap: 6px; flex-wrap: wrap; }
    .bets-active .bets-chipbtn { height: 30px; padding: 0 10px; }

    .bets-sum { overflow: hidden; }
    .bets-sum-reset { margin: -6px -8px -6px auto; }
    .bets-sum-cap { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; padding: 12px 18px 10px; border-bottom: 1px solid var(--line); min-width: 0; }
    .bets-sum-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, .9fr) minmax(0, 1.05fr); gap: 1px; background: var(--line); }
    .bets-sum-cell { background: var(--surface); padding: 14px 18px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .bets-sum-l { font-size: var(--fs-xs); color: var(--fg-2); }
    .bets-l-short { display: none; }
    .bets-sum-v { font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .bets-sum-s { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-wlv { display: flex; gap: 2px; height: 6px; border-radius: 999px; overflow: hidden; margin: 2px 0 1px; }
    .bets-wlv i { display: block; min-width: 3px; }
    .bets-wlv i.win { background: var(--good); }
    .bets-wlv i.loss { background: var(--bad); }
    .bets-wlv i.void { background: var(--line-strong); }
    .bets-sum-note { display: flex; gap: 8px; align-items: flex-start; padding: 10px 18px; border-top: 1px solid var(--line); font-size: var(--fs-xs); color: var(--fg-2); }
    .bets-sum-note svg { width: 15px; height: 15px; flex: none; margin-top: 1px; color: var(--fg-3); }
    @media (max-width: 1180px) { .bets-sum-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @media (max-width: 720px) {
      .bets-sum-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .bets-sum-cell { padding: 12px 14px; }
      .bets-sum-cap, .bets-sum-note { padding-inline: 14px; }
      .bets-sum-v { font-size: var(--fs-lg); }
      .bets-l-full { display: none; } .bets-l-short { display: inline; }
    }

    .bets-banner { align-items: flex-start; }
    .bets-banner-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; flex: 1; }
    .bets-banner-body b { color: var(--fg); }
    .bets-banner .row .btn { height: 30px; }

    .bets-sec-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; min-width: 0; }
    .bets-sec-head h3 { font-size: var(--fs-lg); }
    .bets-open-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
    @media (max-width: 1100px) { .bets-open-grid { grid-template-columns: minmax(0, 1fr); } }
    .card.bets-open { padding: 16px 18px; gap: 12px; border-color: color-mix(in srgb, var(--info-ink) 35%, var(--line)); }
    .card.bets-open.is-new { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .bets-open-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
    .bets-open-title { font-weight: 600; font-family: var(--font-display); }
    .bets-olegs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .bets-oleg { display: grid; grid-template-columns: 3rem minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px dashed var(--line); }
    .bets-oleg:first-child { border-top: 0; padding-top: 0; }
    .bets-oleg-time { font-family: var(--font-mono); font-size: var(--fs-sm); color: var(--fg-2); }
    .bets-oleg-match { font-weight: 500; line-height: 1.35; }
    .bets-oleg-meta { font-size: var(--fs-xs); color: var(--fg-3); margin-top: 1px; }
    .bets-oleg-meta b { color: var(--fg-2); font-weight: 600; }
    .bets-oleg-odds { font-size: var(--fs-md); }
    .bets-open-sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); }
    .bets-open-sum > div { min-width: 0; }
    .bets-open-sum dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-open-sum dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bets-open-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; }
    .bets-open-actions .btn { flex: 1 1 auto; }
    .bets-open-actions .btn.primary { flex: 1 1 55%; }

    .bets-plink { color: inherit; text-decoration: none; }
    .bets-plink:hover { color: var(--accent-ink); text-decoration: underline; }

    .bets-res { display: inline-grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; flex: none; }
    .bets-res svg { width: 12px; height: 12px; stroke-width: 2.6; }
    .bets-res.win { background: var(--good-soft); color: var(--good-ink); }
    .bets-res.loss { background: var(--bad-soft); color: var(--bad-ink); }
    .bets-res.void { background: var(--surface-3); color: var(--fg-2); }
    .bets-res.open { background: var(--info-soft); color: var(--info-ink); }

    .bets-hist .card-head { align-items: center; }
    .bets-table th:last-child { position: relative; }
    .bets-table td { vertical-align: top; }
    .bets-table td.r { white-space: nowrap; }
    .bets-row { cursor: pointer; }
    .bets-row:hover > td { background: var(--surface-2); }
    .bets-row.is-expanded > td { background: var(--surface-2); border-bottom-color: transparent; }
    .bets-row.is-new > td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .bets-row td:nth-child(5) .chip { margin-top: -2px; }
    .bets-date { font-weight: 600; white-space: nowrap; }
    .bets-sub { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; margin-top: 2px; }
    .bets-legline { display: flex; align-items: center; gap: 7px; min-width: 0; line-height: 1.35; }
    .bets-legline + .bets-legline { margin-top: 5px; }
    .bets-legline-t { min-width: 0; }
    .bets-legline-m { color: var(--fg); white-space: nowrap; }
    @media (max-width: 1240px) { .bets-table .bets-sub { white-space: normal; align-items: flex-start; } .bets-table .bets-sub .bets-dot { margin-top: 4px; } }
    .bets-profit { font-weight: 600; }
    .bets-exp { margin: -6px 0; }
    .bets-exp svg { transition: transform .15s; }
    .bets-exp[aria-expanded="true"] svg { transform: rotate(180deg); }
    .bets-month > td { padding-top: 14px; padding-bottom: 8px; background: var(--surface); }
    .bets-month-in { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .bets-month-name { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-sm); }
    .bets-month-stats { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-month-stats b { font-weight: 600; }
    .bets-detail-row > td { background: var(--surface-2); padding-top: 2px; padding-bottom: 16px; }
    .bets-detail { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .bets-detail-main, .bets-detail-box { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-md); min-width: 0; }
    .bets-detail-cap { display: flex; align-items: baseline; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; padding: 12px 14px 4px; }
    .bets-detail-bottom { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr); gap: 12px; align-items: stretch; }
    .bets-detail-box { padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
    .bets-detail-box p { font-size: var(--fs-sm); color: var(--fg-2); white-space: normal; }
    .bets-detail-box .btn { align-self: flex-start; margin-top: auto; }
    .bets-kvgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px 16px; margin: 0; }
    .bets-kvgrid > div { min-width: 0; }
    .bets-kvgrid dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-kvgrid dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .bets-legtable th, .bets-legtable td { padding: 9px 10px; }
    .bets-legtable td { vertical-align: middle; }
    .bets-legtable th:first-child, .bets-legtable td:first-child { padding-left: 14px; }
    .bets-legtable th:last-child, .bets-legtable td:last-child { padding-right: 14px; }
    .bets-detail-note { padding: 0 14px 12px; }
    @media (max-width: 1240px) { .bets-detail-bottom { grid-template-columns: minmax(0, 1fr); } }

    .bets-more { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .bets-hist .card-foot { justify-content: space-between; }

    .bets-mlist { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .bets-mmonth { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; flex-wrap: wrap; padding: 8px 2px 0; }
    .bets-mcard { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; cursor: pointer; min-width: 0; text-align: left; }
    .bets-mcard:active { background: var(--surface-2); }
    .bets-mcard.is-new { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .bets-mcard-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
    .bets-mcard-top > div { min-width: 0; }
    .bets-mcard-date { font-weight: 600; font-size: var(--fs-sm); }
    .bets-mlegs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .bets-mlegs li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 8px; align-items: center; font-size: var(--fs-sm); min-width: 0; }
    .bets-mlegs .m { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .bets-mlegs .k { white-space: nowrap; color: var(--fg-3); }
    .bets-mlegs .k .odds { color: var(--fg); margin-left: 6px; }
    .bets-mcard-sum { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 0; padding-top: 10px; border-top: 1px solid var(--line); }
    .bets-mcard-sum > div { min-width: 0; }
    .bets-mcard-sum > div:last-child { text-align: right; }
    .bets-mcard-sum dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-mcard-sum dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: var(--fs-sm); }

    .bets-dm-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
    .bets-dm-top > div { min-width: 0; }
    .bets-dm-profit { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; margin-top: 2px; }
    .bets-dleg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .bets-dleg-head { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
    .bets-dleg-head .bets-res { margin-top: 2px; }
    .bets-dleg-match { font-weight: 600; line-height: 1.35; }
    .bets-dleg-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; padding: 8px 10px; border-radius: var(--r-sm); background: var(--surface-2); }
    .bets-dleg-grid > div { min-width: 0; }
    .bets-dleg-grid dt { font-size: 11px; color: var(--fg-3); white-space: nowrap; }
    .bets-dleg-grid dd { margin: 0; font-weight: 600; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; white-space: nowrap; }

    .bets-settle-intro { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: var(--fs-sm); color: var(--fg-2); }
    .bets-sleg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .bets-sleg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
    .bets-sleg-head > div { min-width: 0; }
    .bets-sleg-match { font-weight: 600; }
    .bets-sleg-odds { font-size: var(--fs-lg); }
    .bets-sleg-grid { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(0, .75fr) minmax(0, .9fr); gap: 12px; align-items: start; }
    .bets-resseg { display: flex; padding: 3px; gap: 2px; background: var(--surface-2); border-radius: var(--r-md); min-width: 0; }
    .bets-resseg button { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 36px; padding: 0 6px; border: 0; border-radius: 7px; background: transparent; color: var(--fg-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; white-space: nowrap; }
    .bets-resseg button svg { width: 15px; height: 15px; flex: none; }
    .bets-resseg button:hover { color: var(--fg); }
    .bets-resseg button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line-strong); font-weight: 600; }
    .bets-resseg button.win[aria-pressed="true"] { background: var(--good-soft); color: var(--good-ink); box-shadow: inset 0 0 0 1px var(--good-ink); }
    .bets-resseg button.loss[aria-pressed="true"] { background: var(--bad-soft); color: var(--bad-ink); box-shadow: inset 0 0 0 1px var(--bad-ink); }
    .bets-sleg .input { height: 40px; }
    .bets-auto { color: var(--accent-ink); }
    .bets-auto.warn { color: var(--warn-ink); }
    .bets-ssum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .bets-ssum > div { background: var(--surface-2); padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .bets-ssum dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-ssum dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; min-height: 24px; display: flex; align-items: center; }
    .bets-ssum small { font-size: 11px; color: var(--fg-3); font-weight: 400; }
    @media (max-width: 720px) {
      .bets-sleg { padding: 12px; }
      .bets-sleg-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .bets-sleg-grid > .bets-sleg-res { grid-column: 1 / -1; }
      .bets-ssum { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    .bets-review-legs { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .bets-review-legs li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; font-size: var(--fs-sm); color: var(--fg-2); }
    .bets-review-legs li b { color: var(--fg); }
    .bets-review-legs .bets-res { margin-top: 1px; }
    .bets-chipgroup { display: flex; flex-wrap: wrap; gap: 6px; }
  `;

  // ---------- шапка и фильтры ----------
  function pageHead(mobile) {
    return h('div', { class: 'page-head bets-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'История ставок'),
        h('p', { class: 'lead' }, 'Каждая ставка, сделанная по анализу ИИ. Внесите результат после матча: от него зависят банк, CLV и то, чему модель научится дальше.')),
      button('Экспорт CSV', { kind: 'secondary', size: mobile ? 'sm' : null, icon: 'download', onClick: exportCsv }));
  }
  function exportCsv() {
    const n = filtered().length;
    UI.toast('В рабочей версии скачается bets_' + TODAY + '.csv: ' + n + ' ' + betsWord(n) + ' по текущим фильтрам, по строке на событие', 'download');
  }

  function searchBox() {
    return h('div', { class: 'bets-search' }, icon('search'),
      h('input', { class: 'input', type: 'search', placeholder: 'Игрок, турнир или №', 'aria-label': 'Поиск ставок по игроку, турниру или номеру', value: F.q, autocomplete: 'off',
        on: { input: e => { F.q = e.target.value.trim(); shown = PAGE; refresh(); } } }));
  }
  function nativeSelect(label, opts, value, onChange) {
    return h('select', { class: 'select bets-select', 'aria-label': label, on: { change: e => onChange(e.target.value) } },
      opts.map(o => h('option', { value: o.value, selected: o.value === value }, o.label)));
  }
  function surfaceToggle(k, pressed, onClick) {
    const s = D.surfaces[k];
    return h('button', { type: 'button', class: 'bets-chipbtn', 'aria-pressed': String(pressed), on: { click: onClick } },
      pressed ? icon('check') : h('i', { class: 'bets-dot', style: { background: s.color } }), s.label);
  }
  function periodSeg() {
    return UI.segmented({ label: 'Период', items: PERIODS, active: F.period, onChange: id => { F.period = id; shown = PAGE; refresh(); } });
  }

  function desktopFilters() {
    const chips = h('div', { class: 'bets-chips', role: 'group', 'aria-label': 'Покрытие' });
    const drawChips = () => {
      UI.clear(chips);
      SURF_KEYS.forEach(k => chips.appendChild(surfaceToggle(k, F.surfaces.has(k), () => {
        F.surfaces.has(k) ? F.surfaces.delete(k) : F.surfaces.add(k); shown = PAGE; drawChips(); refresh();
      })));
    };
    drawChips();
    return h('div', { class: 'bets-filters', role: 'region', 'aria-label': 'Фильтры ставок' },
      searchBox(),
      periodSeg(),
      nativeSelect('Статус ставки', STATUS_OPTS, F.status, v => { F.status = v; shown = PAGE; refresh(); }),
      nativeSelect('Рынок', MARKET_OPTS, F.market, v => { F.market = v; shown = PAGE; refresh(); }),
      chips);
  }

  function mobileFilters() {
    const n = sheetActive(F);
    const fbtn = button('Фильтры', { kind: 'secondary', icon: 'filter', onClick: filterSheet, ariaLabel: n ? 'Фильтры, выбрано: ' + n : 'Фильтры' });
    if (n) fbtn.appendChild(h('span', { class: 'chip accent bets-fcount' }, String(n)));
    const active = [];
    if (F.status !== 'all') active.push([STATUS_OPTS.find(o => o.value === F.status).label, () => { F.status = 'all'; }]);
    if (F.market !== 'all') active.push([MARKET_OPTS.find(o => o.value === F.market).label, () => { F.market = 'all'; }]);
    F.surfaces.forEach(k => active.push([surfLabel(k), () => { F.surfaces.delete(k); }]));
    return h('div', { class: 'bets-mfilters', role: 'region', 'aria-label': 'Фильтры ставок' },
      h('div', { class: 'bets-mrow' }, searchBox(), fbtn),
      periodSeg(),
      active.length ? h('div', { class: 'bets-active' },
        active.map(([t, drop]) => h('button', { type: 'button', class: 'bets-chipbtn', 'aria-pressed': 'true', 'aria-label': 'Убрать фильтр: ' + t, on: { click: () => { drop(); shown = PAGE; build(); } } }, t, icon('x'))),
        h('button', { type: 'button', class: 'bets-chipbtn', on: { click: resetFilters } }, 'Сбросить все')) : null);
  }

  function filterSheet() {
    const d = { status: F.status, market: F.market, surfaces: new Set(F.surfaces) };
    let applyBtn = null;
    const upd = () => {
      if (!applyBtn) return;
      const n = filtered(Object.assign({}, F, d)).length;
      applyBtn.querySelector('span').textContent = n ? 'Показать ' + n + ' ' + plural(n, 'ставку', 'ставки', 'ставок') : 'Ничего не найдено';
      applyBtn.disabled = !n;
    };
    const statusGroup = h('div', { class: 'bets-chipgroup', role: 'group', 'aria-label': 'Статус ставки' });
    const drawStatus = () => {
      UI.clear(statusGroup);
      STATUS_OPTS.forEach(o => statusGroup.appendChild(h('button', { type: 'button', class: 'bets-chipbtn', 'aria-pressed': String(d.status === o.value), on: { click: () => { d.status = o.value; drawStatus(); upd(); } } }, o.value === 'all' ? 'Все' : o.label)));
    };
    drawStatus();
    const surfGroup = h('div', { class: 'bets-chipgroup', role: 'group', 'aria-label': 'Покрытие' });
    const drawSurf = () => {
      UI.clear(surfGroup);
      SURF_KEYS.forEach(k => surfGroup.appendChild(surfaceToggle(k, d.surfaces.has(k), () => { d.surfaces.has(k) ? d.surfaces.delete(k) : d.surfaces.add(k); drawSurf(); upd(); })));
    };
    drawSurf();
    UI.modal({
      title: 'Фильтры',
      body: [
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Статус'), statusGroup),
        UI.field({ id: 'bets-sheet-market', label: 'Рынок', options: MARKET_OPTS, value: d.market, hint: 'Ставка попадет в выборку, если рынок есть хотя бы в одном событии экспресса', attrs: { on: { change: e => { d.market = e.target.value; upd(); } } } }),
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Покрытие'), surfGroup, h('div', { class: 'field-hint' }, 'Можно выбрать несколько')),
      ],
      actions: close => [
        button('Сбросить', { kind: 'secondary', onClick: () => { close(); F = Object.assign(F, { status: 'all', market: 'all', surfaces: new Set() }); shown = PAGE; build(); } }),
        applyBtn = button('Показать', { kind: 'primary', onClick: () => { close(); F = Object.assign(F, d); shown = PAGE; build(); } }),
      ],
    });
    upd();
  }

  // ---------- итоги ----------
  function summarize(list) {
    const st = list.filter(b => b.status !== 'open');
    const wins = st.filter(b => b.status === 'win').length;
    const losses = st.filter(b => b.status === 'loss').length;
    const voids = st.filter(b => b.status === 'void').length;
    const turnover = sum(st, b => b.stake), profit = sum(st, b => b.profit);
    const clvs = st.filter(b => b.clv != null);
    const open = list.filter(b => b.status === 'open');
    return {
      n: st.length, wins, losses, voids, turnover, profit,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: clvs.length ? sum(clvs, b => b.clv) / clvs.length : null,
      clvPos: clvs.filter(b => b.clv > 0).length, clvN: clvs.length,
      avgStake: st.length ? turnover / st.length : null,
      open, openStake: sum(open, b => b.stake),
    };
  }

  function summaryCard(list) {
    const s = summarize(list);
    const cell = (label, value, sub, cls, extra) => h('div', { class: 'bets-sum-cell' },
      h('div', { class: 'bets-sum-l' }, label), h('div', { class: ['bets-sum-v', cls] }, value), extra, h('div', { class: 'bets-sum-s' }, sub));
    const wlv = s.n ? h('div', { class: 'bets-wlv', 'aria-hidden': 'true' },
      [['win', s.wins], ['loss', s.losses], ['void', s.voids]].filter(x => x[1]).map(([k, n]) => h('i', { class: k, style: { flexGrow: String(n) } }))) : null;
    return h('section', { class: 'card bets-sum', 'aria-label': 'Итоги по ставкам' },
      h('div', { class: 'bets-sum-cap' }, h('span', { class: 'eyebrow' }, 'Итоги'), h('span', { class: 'small muted', style: 'min-width:0' }, describe(F)),
        anyActive(F) && !UI.isMobile() ? button('Сбросить фильтры', { kind: 'ghost', size: 'sm', icon: 'x', onClick: resetFilters, attrs: { class: 'btn ghost sm bets-sum-reset' } }) : null),
      h('div', { class: 'bets-sum-grid' },
        cell('Рассчитано ставок', String(s.n), s.open.length ? ['и еще ' + s.open.length + ' в игре: ', h('span', { class: 'bets-nw' }, fmt.money(s.openStake))] : 'открытых нет'),
        cell([h('span', { class: 'bets-l-full' }, 'Выигрыш · проигрыш · возврат'), h('span', { class: 'bets-l-short' }, 'Выигр. · проигр. · возвр.')], s.wins + ' · ' + s.losses + ' · ' + s.voids, s.winrate == null ? 'нет рассчитанных' : 'винрейт ' + fmt.pct(s.winrate), null, wlv),
        cell('Оборот', fmt.money(s.turnover), s.avgStake ? ['в среднем ', h('span', { class: 'bets-nw' }, fmt.money(s.avgStake))] : '—'),
        cell('Прибыль', fmt.signedMoney(s.profit), anyActive(F) ? 'по выбранным ставкам' : ['банк сейчас ', h('span', { class: 'bets-nw' }, fmt.money(S.bank))], toneCls(s.profit)),
        cell('ROI', pctOrDash(s.roi), 'прибыль ÷ оборот', toneCls(s.roi)),
        cell('Средний CLV', pctOrDash(s.clv), s.clvN ? ['лучше закрытия: ', h('span', { class: 'bets-nw' }, s.clvPos + ' из ' + s.clvN)] : 'нет закрывающих кэфов', toneCls(s.clv))),
      h('div', { class: 'bets-sum-note' }, icon('info'),
        h('span', null, 'CLV — на сколько ваш кэф выше закрывающего, то есть кэфа перед началом матча. Если CLV стабильно в плюсе, модель находит перевес, даже когда отдельные ставки проигрывают.')));
  }

  // ---------- баннер после расчета ----------
  function banner() {
    if (!lastSettled) return null;
    const b = D.bets.find(x => x.id === lastSettled.id);
    if (!b) return null;
    const res = b.status === 'win' ? 'выигрыш ' + fmt.signedMoney(b.profit) : b.status === 'loss' ? 'проигрыш ' + fmt.signedMoney(b.profit) : 'возврат, сумма вернулась на счет';
    return h('div', { class: 'callout accent bets-banner', role: 'status' }, icon('brain'),
      h('div', { class: 'bets-banner-body' },
        h('div', null, h('b', null, 'Ставка №' + b.id + ' рассчитана: ' + res + '. '), 'Банк — ' + fmt.money(S.bank) + '.'),
        h('div', null, b.status === 'void'
          ? 'Возврат не участвует в обучении и калибровке, разбор не нужен.'
          : 'ИИ сравнит прогноз с исходом и закрывающей линией. Если ошибка повторяется, предложит урок — в промпт он попадет только после проверки на 20+ похожих случаях.'),
        h('div', { class: 'row' },
          b.status !== 'void' && button('Посмотреть разбор', { kind: 'secondary', size: 'sm', icon: 'spark', onClick: () => reviewModal(b) }),
          button('Обучение модели', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', href: '#learning' }))),
      button('', { kind: 'ghost', size: 'sm', icon: 'x', title: 'Скрыть', onClick: () => { lastSettled = null; refresh(); } }));
  }

  // ---------- открытые ставки ----------
  function openSection(list) {
    if (!(F.status === 'all' || F.status === 'open')) return null;
    const firstTime = b => Math.min(...b.legs.map(l => { const m = matchOf(l); return m ? +m.time.replace(':', '') : 9999; }));
    const open = list.filter(b => b.status === 'open').sort((a, b) => firstTime(a) - firstTime(b) || a.id - b.id);
    if (!open.length) {
      if (F.status !== 'open' && anyActive(F)) return null;
      return h('section', { class: 'stack', 'aria-label': 'Ставки в игре' },
        h('div', { class: 'bets-sec-head' }, h('h3', null, 'В игре')),
        card({ body: UI.empty(h('span', null, 'Открытых ставок нет. ', h('a', { href: '#new' }, 'Запустите анализ матчей дня'), ' — ИИ предложит экспресс.')) }));
    }
    const stake = sum(open, b => b.stake), pay = sum(open, b => Math.round(b.stake * b.total));
    return h('section', { class: 'stack', 'aria-label': 'Ставки в игре' },
      h('div', { class: 'bets-sec-head' }, h('h3', null, 'В игре'), chip(open.length + ' ' + betsWord(open.length), 'info', 'clock'),
        h('span', { class: 'small muted' }, 'на кону ' + fmt.money(stake) + ' · если все зайдет, выплата ' + fmt.money(pay))),
      h('div', { class: 'bets-open-grid' }, open.map(openCard)));
  }

  function openCard(b) {
    const pay = Math.round(b.stake * b.total);
    return h('article', { class: ['card bets-open', justSaved === b.id && 'is-new'], 'aria-label': 'Открытая ставка №' + b.id, 'data-open-bet': String(b.id) },
      h('div', { class: 'bets-open-head' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'bets-open-title' }, betKindLong(b)),
          h('div', { class: 'xsmall muted' }, '№' + b.id + ' · ' + b.bookmaker + ' · ' + b.tournament + ', ' + dateLabel(b.date))),
        UI.statusChip('open')),
      h('ul', { class: 'bets-olegs' }, b.legs.map(l => {
        const m = matchOf(l);
        return h('li', { class: 'bets-oleg' },
          h('span', { class: 'bets-oleg-time' }, m ? m.time : '—'),
          h('div', { style: 'min-width:0' },
            h('div', { class: 'bets-oleg-match' }, plink(l.p1), ' — ', plink(l.p2)),
            h('div', { class: 'bets-oleg-meta', title: 'Вероятность исхода: оценка ИИ и вероятность по кэфу (1 / кэф)' }, h('b', null, l.marketLabel), ' · ', h('span', { class: 'bets-nw' }, 'ИИ ' + fmt.prob(l.p)), ' · ', h('span', { class: 'bets-nw' }, 'по кэфу ' + fmt.prob(1 / l.odds)))),
          h('span', { class: 'odds bets-oleg-odds' }, fmt.odds(l.odds)));
      })),
      h('dl', { class: 'bets-open-sum' },
        h('div', null, h('dt', null, 'Итоговый кэф'), h('dd', { class: 'odds' }, fmt.odds(b.total))),
        h('div', null, h('dt', null, 'Сумма'), h('dd', null, fmt.money(b.stake))),
        h('div', null, h('dt', null, 'Выплата'), h('dd', null, fmt.money(pay)))),
      h('div', { class: 'bets-open-actions' },
        button('Внести результат', { kind: 'primary', icon: 'edit', onClick: () => settleModal(b), attrs: { 'data-settle': String(b.id) } }),
        // экран «Анализ» показывает только последний анализ — ссылку даем, если ставка сделана по нему
        b.analysis && b.analysis === D.currentAnalysis
          ? button('Анализ', { kind: 'secondary', icon: 'spark', href: '#analysis', title: 'Открыть анализ #' + b.analysis + ', по которому сделана ставка' })
          : button('Почему эта ставка', { kind: 'secondary', icon: 'info', onClick: () => whyModal(b) })));
  }

  // Короткая выжимка анализа, по которому сделана ставка: оценка модели против кэфа по каждой ноге и правило суммы
  function whyModal(b) {
    const an = (D.ai && D.ai.runs || []).filter(r => r.type === 'analysis');
    const run = an.filter(r => r.at.slice(0, 10) === b.date).pop();
    const runId = run ? 'A-' + String(131 + an.indexOf(run)).padStart(4, '0') : null;
    const T = D.strategy.stakeTable;
    const band = b.total <= 1.70 ? T[0] : b.total <= 2.20 ? T[1] : T[2];
    const bankAt = S.bank - (b.status === 'open' ? 0 : b.profit);
    UI.modal({
      title: 'Почему эта ставка · №' + b.id,
      body: [
        h('ul', { class: 'bets-why' }, b.legs.map(l => {
          const imp = 1 / l.odds, edge = (l.p - imp) * 100;
          return h('li', null,
            h('div', { class: 'bets-why-top' }, h('b', null, pname(l.p1) + ' — ' + pname(l.p2)), h('span', { class: 'odds' }, l.marketLabel + ' @' + fmt.odds(l.odds))),
            h('div', { class: 'small soft' }, 'Модель ' + fmt.prob(l.p) + ' против ' + fmt.prob(imp) + ' по кэфу → перевес ' + signedPP(edge) + ' · валуй ' + fmt.signedPct((l.p * l.odds - 1) * 100, 1)));
        })),
        UI.kv([
          ['Итоговый кэф', fmt.odds(b.total)],
          ['Вероятность экспресса по модели', '≈ ' + fmt.prob(b.legs.reduce((a, l) => a * l.p, 1))],
          ['Правило суммы', 'кэф ' + band.range + ' → ' + band.pct + ' банка'],
          ['Сумма', fmt.money(b.stake) + ' · ' + fmt.dec(b.stake / bankAt * 100, 2) + '% банка'],
        ]),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, (runId ? 'Анализ #' + runId + ' · ' + fmt.date(b.date) + ', ' + run.at.slice(11, 16) : 'Анализ ' + fmt.date(b.date)) + ' · пример данных. Полный разбор с факторами в макете есть только для примера Синнер — Руне и Джокович — Рублев.'),
      ],
      actions: close => [
        button('Закрыть', { kind: 'secondary', onClick: close }),
        b.status === 'open' && button('Внести результат', { kind: 'primary', icon: 'edit', onClick: () => { close(); settleModal(b); } }),
      ],
    });
  }

  // ---------- история ----------
  function monthAgg(settled) {
    const g = {};
    settled.forEach(b => { const k = b.date.slice(0, 7); const a = g[k] || (g[k] = { n: 0, profit: 0, stake: 0 }); a.n++; a.profit += b.profit; a.stake += b.stake; });
    return g;
  }
  const monthStats = a => [a.n + ' ' + betsWord(a.n) + ' · ', h('b', { class: toneCls(a.profit) }, fmt.signedMoney(a.profit)), ' · ROI ' + (a.stake ? fmt.signedPct(a.profit / a.stake * 100) : '—')];

  function historySection(list, mobile) {
    if (F.status === 'open') return null;
    const settled = list.filter(b => b.status !== 'open');
    if (!settled.length) {
      return card({ title: 'История', body: h('div', { class: 'stack', style: 'align-items:center' },
        UI.empty('По этим фильтрам ставок нет: ' + describe(F) + '.'),
        anyActive(F) ? button('Сбросить фильтры', { kind: 'secondary', size: 'sm', icon: 'x', onClick: resetFilters }) : null) });
    }
    const page = settled.slice(0, shown);
    const months = monthAgg(settled);
    const left = settled.length - page.length;
    const count = h('span', { class: 'small muted' }, 'Показано ' + page.length + ' из ' + settled.length);
    const more = left > 0 ? button('Показать еще ' + Math.min(PAGE, left), { kind: 'secondary', size: 'sm', icon: 'chevronDown', onClick: () => { shown += PAGE; refresh(); } }) : null;
    if (mobile) {
      return h('section', { class: 'stack', 'aria-label': 'История ставок' },
        h('div', { class: 'bets-sec-head' }, h('h3', null, 'История'), h('span', { class: 'small muted' }, settled.length + ' ' + plural(settled.length, 'рассчитанная ставка', 'рассчитанные ставки', 'рассчитанных ставок') + ' · сначала новые')),
        mobileList(page, months),
        h('div', { class: 'bets-more' }, count, more));
    }
    return card({
      class: 'bets-hist',
      title: 'История',
      subtitle: settled.length + ' ' + plural(settled.length, 'рассчитанная ставка', 'рассчитанные ставки', 'рассчитанных ставок') + ' · сначала новые',
      actions: [h('span', { class: 'xsmall muted' }, 'Нажмите на строку, чтобы открыть детали')],
      body: desktopTable(page, months),
      flush: true,
      foot: [count, more],
    });
  }

  const COLS = 8;
  function desktopTable(rows, months) {
    const tbody = h('tbody');
    let cur = null;
    rows.forEach(b => {
      const m = b.date.slice(0, 7);
      if (m !== cur) {
        cur = m;
        tbody.appendChild(h('tr', { class: 'bets-month' }, h('td', { colspan: COLS },
          h('div', { class: 'bets-month-in' }, h('span', { class: 'bets-month-name' }, monthName(m)), h('span', { class: 'bets-month-stats' }, monthStats(months[m]))))));
      }
      tbody.appendChild(rowEl(b));
      if (expanded.has(b.id)) tbody.appendChild(detailRow(b));
    });
    const th = (t, cls, style) => h('th', { class: cls, style }, t);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table bets-table' },
      h('thead', null, h('tr', null, th('Дата', null, 'width:120px'), th('События'), th('Кэф', 'r'), th('Сумма', 'r'), th('Статус'), th('Прибыль', 'r'), th('CLV', 'r'), h('th', { class: 'r', style: 'width:52px' }, h('span', { class: 'sr-only' }, 'Детали')))),
      tbody));
  }

  function legLine(b, l) {
    return h('div', { class: 'bets-legline' }, resIcon(legRes(b, l)),
      h('span', { class: 'bets-legline-t' }, h('span', { class: 'bets-legline-m' }, D.match(l)), h('span', { class: 'muted' }, ' · ' + l.marketLabel + ' @'), h('span', { class: 'odds muted' }, fmt.odds(l.odds))));
  }

  function rowEl(b) {
    const isExp = expanded.has(b.id);
    const tr = h('tr', { class: ['bets-row', isExp && 'is-expanded', lastSettled && lastSettled.id === b.id && 'is-new'], 'data-bet': String(b.id) },
      h('td', null, h('div', { class: 'bets-date' }, fmt.date(b.date)),
        h('div', { class: 'bets-sub' }, h('i', { class: 'bets-dot', style: { background: D.surfaces[b.surface].color } }), b.tournament + ' · ' + surfLabel(b.surface).toLowerCase())),
      h('td', null, b.legs.map(l => legLine(b, l))),
      h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(b.total))),
      h('td', { class: 'r' }, fmt.money(b.stake)),
      h('td', null, UI.statusChip(b.status)),
      h('td', { class: 'r' }, h('span', { class: ['bets-profit', toneCls(b.profit)] }, fmt.signedMoney(b.profit))),
      h('td', { class: 'r' }, h('span', { class: toneCls(b.clv) }, clvText(b.clv))),
      h('td', { class: 'r' }, h('button', { type: 'button', class: 'btn ghost sm icon-only bets-exp', 'aria-expanded': String(isExp), 'aria-label': 'Детали ставки №' + b.id }, icon('chevronDown'))));
    tr.addEventListener('click', () => toggleRow(tr, b));
    return tr;
  }
  function toggleRow(tr, b) {
    const nx = tr.nextElementSibling;
    if (expanded.has(b.id)) { expanded.delete(b.id); if (nx && nx.classList.contains('bets-detail-row')) nx.remove(); }
    else { expanded.add(b.id); tr.after(detailRow(b)); }
    const open = expanded.has(b.id);
    tr.classList.toggle('is-expanded', open);
    tr.querySelector('.bets-exp').setAttribute('aria-expanded', String(open));
  }
  function detailRow(b) { return h('tr', { class: 'bets-detail-row' }, h('td', { colspan: COLS }, detailBlock(b))); }

  function legsTable(b) {
    const th = (t, cls, title) => h('th', { class: cls, title }, t);
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table bets-legtable' },
      h('thead', null, h('tr', null, th('Событие'), th('Счет', 'c'), th('Кэф', 'r'), th('Закрытие', 'r', 'Кэф перед началом матча'), th('CLV', 'r'), th('ИИ', 'r', 'Вероятность исхода по оценке ИИ'), th('По кэфу', 'r', 'Вероятность по кэфу: 1 / кэф'), th('Разница', 'r', 'ИИ − по кэфу, п.п.'), th('Итог'))),
      h('tbody', null, b.legs.map((l, i) => {
        const implied = 1 / l.odds, edge = (l.p - implied) * 100, clv = legClv(l), sc = legScore(b, l, i);
        return h('tr', null,
          h('td', null, h('div', { style: 'white-space:nowrap;font-weight:500' }, plink(l.p1), ' — ', plink(l.p2)), h('div', { class: 'xsmall muted' }, l.marketLabel + ' · ' + surfLabel(l.surface).toLowerCase())),
          h('td', { class: 'c' }, h('span', { class: 'mono' }, sc || '—')),
          h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(l.odds))),
          h('td', { class: 'r' }, h('span', { class: 'odds' }, l.closing ? fmt.odds(l.closing) : '—')),
          h('td', { class: 'r' }, h('span', { class: toneCls(clv) }, clvText(clv))),
          h('td', { class: 'r' }, fmt.prob(l.p)),
          h('td', { class: 'r' }, fmt.prob(implied)),
          h('td', { class: 'r' }, h('span', { class: 'soft' }, signedPP(edge))),
          h('td', null, resChip(legRes(b, l))));
      }))));
  }

  function betKv(b) {
    const pModel = b.legs.reduce((a, l) => a * l.p, 1);
    return UI.kv([
      ['Букмекер', b.bookmaker],
      ['Сумма', fmt.money(b.stake)],
      ['Итоговый кэф', h('span', { class: 'odds' }, fmt.odds(b.effTotal || b.total))],
      ['Выплата', fmt.money(payoutOf(b))],
      ['Прибыль', h('span', { class: toneCls(b.profit) }, fmt.signedMoney(b.profit))],
      ['Банк после', fmt.money(b.bankAfter)],
      ['CLV ставки', h('span', { class: toneCls(b.clv) }, clvText(b.clv))],
      ['Шанс: ИИ / кэф', fmt.prob(pModel) + ' / ' + fmt.prob(1 / b.total)],
    ]);
  }

  function kvGrid(b) {
    const pModel = b.legs.reduce((a, l) => a * l.p, 1);
    const c = (k, v, cls) => h('div', null, h('dt', null, k), h('dd', { class: cls }, v));
    return h('dl', { class: 'bets-kvgrid' },
      c('Букмекер', b.bookmaker),
      c('Сумма', fmt.money(b.stake)),
      c('Итоговый кэф', h('span', { class: 'odds' }, fmt.odds(b.effTotal || b.total))),
      c('Выплата', fmt.money(payoutOf(b))),
      c('Прибыль', fmt.signedMoney(b.profit), toneCls(b.profit)),
      c('Банк после', fmt.money(b.bankAfter)),
      c('CLV ставки', clvText(b.clv), toneCls(b.clv)),
      c('Шанс: ИИ / кэф', fmt.prob(pModel) + ' / ' + fmt.prob(1 / b.total)));
  }

  function detailBlock(b) {
    return h('div', { class: 'bets-detail' },
      h('div', { class: 'bets-detail-main' },
        h('div', { class: 'bets-detail-cap' }, h('h4', null, 'События ставки'), h('span', { class: 'xsmall muted' }, 'Разница = вероятность ИИ − вероятность по кэфу, п.п. CLV = кэф ÷ закрывающий − 1.')),
        legsTable(b),
        b.status === 'void' && h('div', { class: 'bets-detail-note' }, UI.callout('', 'refresh', 'Букмекер рассчитал ставку возвратом — сумма вернулась на счет. В калибровке и обучении не учитывается.'))),
      h('div', { class: 'bets-detail-bottom' },
        h('div', { class: 'bets-detail-box' }, h('span', { class: 'eyebrow' }, 'Расчет'), kvGrid(b)),
        h('div', { class: 'bets-detail-box' },
          h('div', { class: 'row-between' }, h('span', { class: 'eyebrow' }, 'Разбор ИИ'), verdictChip(b)),
          h('p', null, reviewNext(b)),
          b.status !== 'void' && button('Открыть разбор', { kind: 'secondary', size: 'sm', icon: 'brain', onClick: () => reviewModal(b) }))));
  }

  function mobileList(rows, months) {
    const out = [];
    let cur = null;
    rows.forEach(b => {
      const m = b.date.slice(0, 7);
      if (m !== cur) {
        cur = m;
        out.push(h('div', { class: 'bets-mmonth' }, h('span', { class: 'bets-month-name' }, monthName(m)), h('span', { class: 'bets-month-stats' }, monthStats(months[m]))));
      }
      out.push(betCard(b));
    });
    return h('div', { class: 'bets-mlist' }, out);
  }

  function betCard(b) {
    const open = () => detailModal(b);
    return h('div', { class: ['bets-mcard', lastSettled && lastSettled.id === b.id && 'is-new'], role: 'button', tabindex: '0',
      'aria-label': 'Ставка №' + b.id + ', ' + fmt.date(b.date) + ', ' + UI.statusChip(b.status).textContent + ', ' + fmt.signedMoney(b.profit) + '. Открыть детали',
      on: { click: open, keydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } } } },
      h('div', { class: 'bets-mcard-top' },
        h('div', null, h('div', { class: 'bets-mcard-date' }, fmt.date(b.date) + ' · ' + betKind(b)),
          h('div', { class: 'bets-sub' }, h('i', { class: 'bets-dot', style: { background: D.surfaces[b.surface].color } }), b.tournament + ' · ' + surfLabel(b.surface).toLowerCase() + ' · №' + b.id)),
        UI.statusChip(b.status)),
      h('ul', { class: 'bets-mlegs' }, b.legs.map(l => h('li', null, resIcon(legRes(b, l)), h('span', { class: 'm' }, D.match(l)), h('span', { class: 'k' }, l.marketLabel, h('span', { class: 'odds' }, fmt.odds(l.odds)))))),
      h('dl', { class: 'bets-mcard-sum' },
        h('div', null, h('dt', null, 'Кэф'), h('dd', { class: 'odds' }, fmt.odds(b.total))),
        h('div', null, h('dt', null, 'Сумма'), h('dd', null, fmt.money(b.stake))),
        h('div', null, h('dt', null, 'Прибыль'), h('dd', { class: toneCls(b.profit) }, fmt.signedMoney(b.profit)))));
  }

  // ---------- детали в нижнем листе (телефон) ----------
  function detailModal(b) {
    UI.modal({
      title: 'Ставка №' + b.id,
      wide: true,
      body: () => {
        const v = verdictChip(b);
        return [
          h('div', { class: 'bets-dm-top' },
            h('div', null,
              h('div', { class: 'xsmall muted' }, fmt.dateFull(b.date) + ' · ' + betKind(b) + ' · ' + b.bookmaker),
              h('div', { class: ['bets-dm-profit', toneCls(b.profit)] }, b.status === 'open' ? fmt.money(b.stake) : fmt.signedMoney(b.profit))),
            UI.statusChip(b.status)),
          v && h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'Разбор ИИ:'), v),
          b.legs.map((l, i) => {
            const clv = legClv(l), sc = legScore(b, l, i);
            return h('div', { class: 'bets-dleg' },
              h('div', { class: 'bets-dleg-head' }, resIcon(legRes(b, l)),
                h('div', { style: 'min-width:0;flex:1' },
                  h('div', { class: 'bets-dleg-match' }, plink(l.p1), ' — ', plink(l.p2)),
                  h('div', { class: 'xsmall muted' }, l.marketLabel + ' · ' + l.tournament + (sc ? ' · счет ' + sc : ''))),
                h('span', { class: 'odds' }, fmt.odds(l.odds))),
              h('dl', { class: 'bets-dleg-grid' },
                h('div', null, h('dt', null, 'Закрытие'), h('dd', { class: 'odds' }, l.closing ? fmt.odds(l.closing) : '—')),
                h('div', null, h('dt', null, 'CLV'), h('dd', { class: toneCls(clv) }, clvText(clv))),
                h('div', null, h('dt', null, 'ИИ'), h('dd', null, fmt.prob(l.p))),
                h('div', null, h('dt', null, 'По кэфу'), h('dd', null, fmt.prob(1 / l.odds)))));
          }),
          b.status === 'void' && UI.callout('', 'refresh', 'Букмекер рассчитал ставку возвратом — сумма вернулась на счет.'),
          b.status === 'open'
            ? UI.kv([['Букмекер', b.bookmaker], ['Итоговый кэф', h('span', { class: 'odds' }, fmt.odds(b.total))], ['Выплата при выигрыше', fmt.money(Math.round(b.stake * b.total))]])
            : betKv(b),
        ];
      },
      actions: close => b.status === 'open'
        ? [button('Закрыть', { kind: 'secondary', onClick: close }), button('Внести результат', { kind: 'primary', icon: 'edit', onClick: () => { close(); settleModal(b); } })]
        : [b.status !== 'void' && button('Разбор ИИ', { kind: 'secondary', icon: 'brain', onClick: () => { close(); reviewModal(b); } }), button('Закрыть', { kind: 'primary', onClick: close })].filter(Boolean),
    });
  }

  function reviewNext(b) {
    const v = verdict(b);
    if (b.status === 'void') return 'Возврат не участвует в калибровке и обучении.';
    if (b.status === 'open') return 'Разбор появится после внесения результата.';
    if (b.status === 'win') return v.kind === 'good' ? 'Урок не нужен: перевес модели подтвердили и результат, и закрывающая линия.' : 'Выигрыш не засчитан как подтверждение: на дистанции ставки с отрицательным CLV теряют деньги. Рынок отмечен для наблюдения.';
    return v.kind === 'info' ? 'Урок не нужен: ошибки в оценке не найдено, проигрыш в пределах дисперсии. Ставка учтена в калибровке модели.' : 'Рынок не согласился с моделью. Предложена гипотеза для раздела «Обучение модели» — в промпт она попадет, только если подтвердится на 20 и более похожих случаях.';
  }

  // ---------- разбор ставки ИИ (пример) ----------
  function reviewModal(b) {
    const v = verdict(b);
    const items = b.legs.map((l, i) => {
      const clv = legClv(l), sc = legScore(b, l, i), r = legRes(b, l);
      const head = h('b', null, D.match(l) + ' · ' + l.marketLabel + ' @' + fmt.odds(l.odds));
      let text;
      if (r === 'win') {
        text = [' — зашло' + (sc ? ' (' + sc + ')' : '') + '. ИИ ' + fmt.prob(l.p) + ', по кэфу ' + fmt.prob(1 / l.odds) + '. ',
          clv == null ? 'Закрывающий кэф не внесен — CLV не посчитать.' : clv >= 0 ? 'Кэф к старту упал до ' + fmt.odds(l.closing) + ' (CLV ' + fmt.signedPct(clv) + ') — рынок согласился с оценкой.' : 'Кэф к старту вырос до ' + fmt.odds(l.closing) + ' (CLV ' + fmt.signedPct(clv) + '): рынок был против, выигрыш скорее удачный.'];
      } else if (r === 'loss') {
        text = [' — не зашло' + (sc ? ' (' + sc + ')' : '') + '. ИИ давал ' + fmt.prob(l.p) + ', по кэфу ' + fmt.prob(1 / l.odds) + '. ',
          clv == null ? 'Закрывающий кэф не внесен, поэтому отличить невезение от ошибки сложнее.'
            : clv >= 0 ? 'К старту кэф упал до ' + fmt.odds(l.closing) + ' — рынок согласился с нами. Такой исход ожидаем примерно в ' + fmt.prob(1 - l.p) + ' случаев: это дисперсия.'
              : 'К старту кэф вырос до ' + fmt.odds(l.closing) + ' — рынок оценил шансы ниже модели. Проверяю, что могло быть упущено: усталость после прошлого матча, новости, статистика на покрытии.',
          l.market === 'h1m' ? ' Похоже на урок L-014 (фора −1.5 срезается тай-брейками) — случай добавлен в его доказательную базу.' : ''];
      } else {
        text = [' — возврат, в обучении не участвует.'];
      }
      return h('li', null, resIcon(r), h('div', { style: 'min-width:0' }, head, text));
    });
    const next = reviewNext(b);
    UI.modal({
      title: 'Разбор ставки №' + b.id,
      wide: true,
      body: [
        UI.callout('info', 'info', 'Пример разбора. В рабочей версии его пишет Claude Sonnet 5.5 сразу после внесения результата, около $0,02 за ставку. Одна ставка не доказывает ошибку: невезение от систематического промаха отделяют только на дистанции.'),
        h('div', { class: 'row' }, h('span', { class: 'small muted' }, fmt.dateFull(b.date) + ' · ' + betKind(b) + ' @' + fmt.odds(b.total) + ' · CLV ' + clvText(b.clv)), v && chip(v.label, v.kind, v.icon)),
        h('h4', null, 'По событиям'),
        h('ul', { class: 'bets-review-legs' }, items),
        h('h4', null, 'Что дальше'),
        h('p', { class: 'small soft' }, next),
      ],
      actions: close => [button('Обучение модели', { kind: 'secondary', icon: 'brain', href: '#learning' }), button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // ---------- внесение результата ----------
  const RES_OPTS = [{ id: 'win', label: 'Выиграл', icon: 'check' }, { id: 'loss', label: 'Проиграл', icon: 'x' }, { id: 'void', label: 'Возврат', icon: 'refresh' }];
  const RES_WORD = { win: 'выиграла', loss: 'проиграла', void: 'возврат' };

  function settleModal(b) {
    if (b.status !== 'open') { detailModal(b); return; }
    const st = b.legs.map(() => ({ result: null, score: null, closing: null, auto: false }));
    const sumHost = h('div', { class: 'stack', style: 'gap:8px', 'aria-live': 'polite' });
    const formId = 'bets-settle-' + b.id;
    let saveBtn = null;

    const outcome = () => {
      if (st.some(s => s.result === 'loss')) return { status: 'loss', payout: 0, profit: -b.stake, eff: null };
      if (st.some(s => !s.result)) return null;
      if (st.every(s => s.result === 'void')) return { status: 'void', payout: b.stake, profit: 0, eff: null };
      const eff = r2(b.legs.reduce((a, l, i) => a * (st[i].result === 'win' ? l.odds : 1), 1));
      const payout = Math.round(b.stake * eff);
      return { status: 'win', payout, profit: payout - b.stake, eff };
    };
    const drawSum = () => {
      UI.clear(sumHost);
      const o = outcome();
      const complete = st.every(s => s.result);
      const cell = (label, value, note) => h('div', null, h('dt', null, label), h('dd', null, value), note && h('small', null, note));
      sumHost.appendChild(h('dl', { class: 'bets-ssum', style: 'margin:0' },
        cell('Итог ставки', o ? UI.statusChip(o.status) : h('span', { class: 'muted' }, 'ждем исходы')),
        cell('Выплата', o ? fmt.money(o.payout) : '—', o && o.eff && o.eff !== b.total ? 'кэф пересчитан: ' + fmt.odds(o.eff) : 'кэф ' + fmt.odds(b.total)),
        cell('Прибыль', o ? h('span', { class: toneCls(o.profit) }, fmt.signedMoney(o.profit)) : '—'),
        cell('Банк после', o ? fmt.money(S.bank + o.profit) : '—', 'сейчас ' + fmt.money(S.bank))));
      if (!complete) sumHost.appendChild(h('div', { class: 'field-hint' }, o ? 'Ставка уже проиграна, но отметьте исход и по остальным событиям — они нужны модели для калибровки.' : 'Отметьте исход по каждому событию, чтобы рассчитать ставку.'));
      else if (o.status === 'win' && st.some(s => s.result === 'void')) sumHost.appendChild(h('div', { class: 'field-hint' }, 'Событие с возвратом считается с кэфом 1,00 — так рассчитывают экспрессы букмекеры.'));
      if (saveBtn) saveBtn.disabled = !complete;
    };

    function legBlock(l, i) {
      const s = st[i];
      const m = matchOf(l);
      const btns = {};
      const autoNote = h('div', { class: 'field-hint bets-auto', hidden: true });
      const setRes = (r, auto) => {
        s.result = r; s.auto = !!(r && auto);
        Object.entries(btns).forEach(([k, el]) => el.setAttribute('aria-pressed', String(k === r)));
        checkConflict();
        drawSum();
      };
      const checkConflict = () => {
        const sc = s.score && parseScore(s.score);
        const fromScore = sc ? resultFromScore(l.market, sc[0], sc[1]) : null;
        if (s.auto) { autoNote.hidden = false; autoNote.className = 'field-hint bets-auto'; autoNote.textContent = 'Отметили по счету — можно поправить'; }
        else if (fromScore && s.result && fromScore !== s.result) { autoNote.hidden = false; autoNote.className = 'field-hint bets-auto warn'; autoNote.textContent = 'По счету ставка ' + RES_WORD[fromScore] + ' — проверьте, что выбрано верно'; }
        else autoNote.hidden = true;
      };
      const seg = h('div', { class: 'bets-resseg', role: 'group', 'aria-label': 'Исход ставки на матч ' + D.match(l) },
        RES_OPTS.map(o => (btns[o.id] = h('button', { type: 'button', class: o.id, 'aria-pressed': 'false', on: { click: () => setRes(o.id, false) } }, icon(o.icon), o.label))));

      const scoreF = UI.field({ id: formId + '-score-' + i, label: 'Счет по сетам', placeholder: '2:0', hint: 'первым — ' + pname(l.p1), attrs: { autocomplete: 'off', maxlength: '5' } });
      const scoreIn = scoreF.querySelector('input'), scoreHint = scoreF.querySelector('.field-hint');
      scoreIn.classList.add('mono');
      scoreIn.addEventListener('input', () => {
        const v = scoreIn.value.trim();
        s.score = v || null;
        const sc = parseScore(v);
        if (!v) {
          scoreIn.classList.remove('invalid'); scoreHint.className = 'field-hint'; scoreHint.textContent = 'первым — ' + pname(l.p1);
          if (s.auto) setRes(null); else checkConflict();
          return;
        }
        if (!sc) {
          if (v.replace(/\D/g, '').length >= 2) { scoreIn.classList.add('invalid'); scoreHint.className = 'field-error'; scoreHint.textContent = 'Матч до двух сетов: 2:0, 2:1, 1:2 или 0:2'; }
          return;
        }
        scoreIn.classList.remove('invalid'); scoreHint.className = 'field-hint'; scoreHint.textContent = 'первым — ' + pname(l.p1);
        const r = resultFromScore(l.market, sc[0], sc[1]);
        if (!s.result || s.auto) setRes(r, true); else checkConflict();
      });

      const closeF = UI.field({ id: formId + '-close-' + i, label: 'Закрывающий кэф', placeholder: fmt.odds(l.odds), inputmode: 'decimal', hint: 'кэф перед началом матча', attrs: { autocomplete: 'off', maxlength: '5' } });
      const closeIn = closeF.querySelector('input'), closeHint = closeF.querySelector('.field-hint');
      closeIn.classList.add('mono');
      closeIn.addEventListener('input', () => {
        const raw = closeIn.value.trim();
        const v = parseOdds(raw);
        s.closing = v;
        UI.clear(closeHint);
        closeIn.classList.toggle('invalid', !!raw && !v && raw.length >= 3);
        if (raw && !v && raw.length >= 3) { closeHint.className = 'field-error'; closeHint.textContent = 'Кэф от 1.01, например ' + fmt.odds(l.odds); return; }
        closeHint.className = 'field-hint';
        if (v) { const clv = (l.odds / v - 1) * 100; closeHint.append('перед стартом · ', h('b', { class: [toneCls(clv), 'bets-nw'] }, 'CLV ' + fmt.signedPct(clv))); }
        else closeHint.textContent = 'кэф перед началом матча';
      });

      return h('fieldset', { class: 'bets-sleg', style: 'margin:0' },
        h('legend', { class: 'sr-only' }, 'Событие ' + (i + 1) + ': ' + D.match(l)),
        h('div', { class: 'bets-sleg-head' },
          h('div', null, h('div', { class: 'bets-sleg-match' }, D.match(l)),
            h('div', { class: 'xsmall muted' }, (m ? m.time + ' · ' + m.round + ' · ' : '') + l.marketLabel + ' · ИИ ' + fmt.prob(l.p))),
          h('span', { class: 'odds bets-sleg-odds', 'aria-label': 'Кэф ' + fmt.odds(l.odds) }, fmt.odds(l.odds))),
        h('div', { class: 'bets-sleg-grid' },
          h('div', { class: 'field bets-sleg-res' }, h('div', { class: 'field-label' }, 'Исход ставки'), seg, autoNote),
          scoreF, closeF));
    }

    const save = close => {
      const o = outcome();
      if (!o || !st.every(s => s.result)) { UI.toast('Отметьте исход по каждому событию', 'alert'); return; }
      applySettle(b, st, o);
      close();
      UI.rerender();
      UI.toast(('Ставка №' + b.id + ' рассчитана: ' + (o.status === 'void' ? 'возврат' : fmt.signedMoney(o.profit)) + ', банк ' + fmt.money(S.bank)).replace(/ ₽/g, '\u00a0₽'), o.status === 'loss' ? 'x' : 'check');
    };

    UI.modal({
      title: 'Результат ставки №' + b.id,
      wide: true,
      body: close => {
        const form = h('form', { id: formId, class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); save(close); } } },
          h('div', { class: 'bets-settle-intro' }, UI.statusChip('open'), h('span', null, betKindLong(b) + ' · ' + b.bookmaker + ' · сумма ' + fmt.money(b.stake) + ' · кэф ', h('span', { class: 'odds' }, fmt.odds(b.total)))),
          b.legs.map(legBlock),
          sumHost,
          UI.callout('accent', 'brain', h('b', null, 'После расчета модель разберет ошибки и предложит урок. '), 'Она сравнит свою вероятность с исходом и закрывающей линией. Закрывающий кэф можно не вносить, но без него CLV не посчитать и отличить невезение от ошибки сложнее.'));
        drawSum();
        return form;
      },
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        saveBtn = button('Сохранить результат', { kind: 'primary', icon: 'check', type: 'submit', attrs: { form: formId } }),
      ],
    });
    drawSum();
  }

  function applySettle(b, st, o) {
    b.legs.forEach((l, i) => {
      l.result = st[i].result;
      const sc = st[i].score && parseScore(st[i].score);
      l.score = sc ? sc[0] + ':' + sc[1] : null;
      l.closing = st[i].closing || null;
    });
    b.status = o.status;
    b.profit = o.profit;
    b.effTotal = o.eff && o.eff !== b.total ? o.eff : null;
    const live = b.legs.filter(l => l.result !== 'void');
    b.clv = live.length && live.every(l => l.closing) ? r1((live.reduce((a, l) => a * l.odds, 1) / live.reduce((a, l) => a * l.closing, 1) - 1) * 100) : null;
    S.bank += o.profit;
    b.bankAfter = S.bank;
    S.profit += o.profit; S.turnover += b.stake; S.settled++; S.open = Math.max(0, S.open - 1);
    if (o.status === 'win') S.wins++; else if (o.status === 'loss') S.losses++; else S.voids++;
    S.roi = r1(S.profit / S.turnover * 100);
    S.winrate = r1(S.wins / (S.wins + S.losses) * 100);
    S.peak = Math.max(S.peak, S.bank);
    const clvs = D.bets.filter(x => x.status !== 'open' && x.clv != null);
    if (clvs.length) S.clvAvg = r1(sum(clvs, x => x.clv) / clvs.length);
    S.streak = S.streak.type === o.status ? { type: o.status, n: S.streak.n + 1 } : { type: o.status, n: 1 };
    D.bankHistory.push({ date: TODAY, bank: S.bank });
    b.legs.forEach(l => { if ((l.result === 'win' || l.result === 'loss') && l.closing) D.allLegs.push(Object.assign({ date: TODAY, betId: b.id }, l)); });
    lastSettled = { id: b.id };
    expanded.add(b.id);
  }

  // ---------- сборка экрана ----------
  function refresh() {
    if (!ui) return;
    const list = filtered();
    const mobile = UI.isMobile();
    const put = (host, node) => { UI.clear(host); if (node) host.appendChild(node); host.hidden = !node; };
    put(ui.bannerHost, banner());
    put(ui.summaryHost, summaryCard(list));
    put(ui.openHost, openSection(list));
    put(ui.listHost, historySection(list, mobile));
  }

  function build() {
    const root = ui.root;
    const mobile = UI.isMobile();
    UI.clear(root);
    if (!expandInit) {
      expandInit = true;
      const newest = D.bets.filter(b => b.status !== 'open').sort(newestFirst)[0];
      if (newest && !mobile) expanded.add(newest.id);
    }
    ui.bannerHost = h('div');
    ui.summaryHost = h('div');
    ui.openHost = h('div');
    ui.listHost = h('div');
    root.append(pageHead(mobile), ui.bannerHost, mobile ? mobileFilters() : desktopFilters(), ui.summaryHost, ui.openHost, ui.listHost);
    refresh();
  }

  // #bets-<номер>: открытая ставка → ввод результата, рассчитанная → детали
  function handleParam(param) {
    if (!param) return;
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#bets'); } catch (e) { /* окружение без history — не страшно */ }
    const b = D.bets.find(x => String(x.id) === String(param));
    if (!b) { UI.toast('Ставка №' + param + ' не найдена', 'alert'); return; }
    if (b.status === 'open') { setTimeout(() => settleModal(b), 60); return; }
    if (UI.isMobile()) { setTimeout(() => detailModal(b), 60); return; }
    if (!filtered().includes(b)) { F = blank(); build(); }
    const idx = filtered().filter(x => x.status !== 'open').indexOf(b);
    if (idx >= shown) shown = Math.ceil((idx + 1) / PAGE) * PAGE;
    expanded.add(b.id);
    refresh();
    setTimeout(() => { const tr = ui.root.querySelector('tr[data-bet="' + b.id + '"]'); if (tr) tr.scrollIntoView({ block: 'center' }); }, 80);
  }

  UI.register('bets', {
    title: 'Ставки',
    nav: 'bets',
    render(root, param) {
      UI.css('bets', CSS);
      ui = { root };
      // пришли с экрана «Анализ» после «Сохранить ставку» — подсвечиваем новую ставку и прокручиваем к ней
      const fresh = D.lastSavedBet;
      delete D.lastSavedBet; justSaved = fresh || null;
      build();
      handleParam(param);
      if (fresh && !param) setTimeout(() => { const el = root.querySelector('[data-open-bet="' + fresh + '"]'); if (el) el.scrollIntoView({ block: 'center' }); }, 80);
    },
  });
})();
