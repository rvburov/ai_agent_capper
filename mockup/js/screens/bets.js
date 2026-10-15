/* Экран «Ставки»: итоги по фильтрам, открытые ставки с вводом результата и закрывающего кэфа,
   история (таблица с раскрытием на компьютере, карточки и нижний лист на телефоне), разбор ставки ИИ и вердикт кодом
   по CLV, исправление результата (сторно и повторный расчет). Этап 5: авторасчет по файлу tennis-data
   (settled_by = auto, «Исправить результат» остается), «ждет результата», закрытие П1/П2 из архива,
   подсказка исхода из новостей в окне расчета (подсказка, а не расчет — В1).
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
  // Т10: у проигранных экспрессов старого бота исходы ног не записаны
  const legRes = (b, l) => (b.status === 'void' ? 'void' : l.noResult ? 'unknown' : l.result);
  const toneCls = v => (v == null ? 'muted' : v > 0 ? 'good-text' : v < 0 ? 'bad-text' : 'muted');
  const clvText = v => (v == null ? '—' : fmt.signedPct(v, 1));
  const pctOrDash = v => (v == null ? '—' : fmt.signedPct(v, 1));
  const signedPP = v => { const n = Math.round(v); return (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n) + ' п.п.'; };
  const dateLabel = d => (d === TODAY ? 'сегодня' : fmt.date(d));
  const payoutOf = b => (b.status === 'open' ? null : b.stake + b.profit);
  // Валюта программы (Р17): в DATA суммы в рублях демо-данных, а выплату и прибыль считаем в валюте программы
  // с ее точностью (рубль или цент) — так сумма × кэф, прибыль и банк после расчета сходятся в любой валюте.
  const curDec = () => (UI.currency.list[UI.currency.code] || { dec: 0 }).dec;
  const roundCur = x => { const k = 10 ** curDec(); return Math.round(x * k) / k; };
  const inCur = rub => fmt.moneyNum(rub);                                 // рубли демо-данных → сумма как на экране
  const payCur = (stake, k) => roundCur(inCur(stake) * k);                 // выплата в валюте программы
  const payRub = (stake, k) => fmt.fromMoney(payCur(stake, k));           // она же в рублях демо-данных
  const nbspCur = t => t.split(' ' + fmt.cur()).join('\u00a0' + fmt.cur()); // символ валюты не отрывается от числа
  // В1: CLV ноги = кэф ÷ закрывающий − 1 по закрытию, которое внес участник; «без маржи» — кэф × q_close − 1,
  // если внесены обе стороны закрытия (q_close — степенной метод, как ml/market.py)
  const legClv = l => (l.closing ? (l.odds / l.closing - 1) * 100 : null);
  function devig(o1, o2) {
    const a = 1 / o1, b = 1 / o2;
    let lo = 0.2, hi = 5;
    for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (a ** k + b ** k > 1) lo = k; else hi = k; }
    return a ** ((lo + hi) / 2);
  }
  const fairClv = (odds, closing, opp) => (closing && opp ? (odds * devig(closing, opp) - 1) * 100 : null);
  const isBot = b => b.source === 'bot';
  // В5: старый бот закрывающих кэфов не записывал — CLV по его ставкам не считается, вместо числа прочерк с пояснением
  const BOT_CLV = 'Старый бот закрывающих кэфов не записывал — CLV не считается';
  const botDash = () => h('span', { class: 'muted', title: BOT_CLV }, '—');
  const bestOfText = l => (l.bestOf === 5 ? 'до трех побед в сетах' : 'до двух побед в сетах');
  const surfLabel = k => (D.surfaces[k] ? D.surfaces[k].label : k);

  function plink(id) {
    const p = D.P[id];
    // карточки в макете есть только у игроков из DATA.players; остальные соперники — просто имя
    if (!p) return h('span', null, pname(id));
    return h('a', { class: 'bets-plink', href: '#player-' + id, title: p ? p.name + ' — карточка игрока' : id, on: { click: e => e.stopPropagation() } }, pname(id));
  }

  const RES = { win: ['Зашло', 'check'], loss: ['Не зашло', 'x'], void: ['Возврат', 'refresh'], open: ['Еще не сыграно', 'clock'], unknown: ['Исход не записан старым ботом', 'info'] };
  function resIcon(r) {
    const [t, ic] = RES[r] || RES.open;
    return h('span', { class: 'bets-res ' + r, role: 'img', 'aria-label': t, title: t }, icon(ic));
  }
  const RES_CHIP = { win: ['Зашло', 'good', 'check'], loss: ['Не зашло', 'bad', 'x'], void: ['Возврат', 'outline', 'refresh'], open: ['Ждем матч', 'info', 'clock'], unknown: ['Не записан', 'outline', 'info'] };
  const resChip = r => { const [t, k, i] = RES_CHIP[r] || RES_CHIP.open; return chip(t, k, i); };

  // Счет по сетам для истории (в демо-данных его нет): согласован с рынком, исходом и форматом матча.
  // На турнирах Большого шлема матч до трех побед (best_of = 5): там Ф(−1.5) — это 3:0 и 3:1 (Т21)
  const SCORES = {
    3: {
      p1: { win: ['2:0', '2:1'], loss: ['1:2', '0:2'] },
      p2: { win: ['0:2', '1:2'], loss: ['2:0', '2:1'] },
      h1m: { win: ['2:0'], loss: ['2:1', '1:2', '0:2'] },
      h2m: { win: ['0:2'], loss: ['2:0', '2:1', '1:2'] },
      h1p: { win: ['2:1', '1:2', '2:0'], loss: ['0:2'] },
      h2p: { win: ['2:1', '1:2', '0:2'], loss: ['2:0'] },
    },
    5: {
      p1: { win: ['3:0', '3:1', '3:2'], loss: ['2:3', '1:3', '0:3'] },
      p2: { win: ['0:3', '1:3', '2:3'], loss: ['3:0', '3:1', '3:2'] },
      h1m: { win: ['3:0', '3:1'], loss: ['3:2', '2:3', '1:3', '0:3'] },
      h2m: { win: ['0:3', '1:3'], loss: ['3:0', '3:1', '3:2', '2:3'] },
      h1p: { win: ['3:0', '3:1', '3:2', '2:3'], loss: ['1:3', '0:3'] },
      h2p: { win: ['0:3', '1:3', '2:3', '3:2'], loss: ['3:0', '3:1'] },
    },
  };
  function legScore(b, l, i) {
    if (l.score) return l.score;
    if (b.status === 'void' || l.result === 'open' || l.noResult) return null;
    const set = SCORES[l.bestOf === 5 ? 5 : 3];
    const opts = (set[l.market] || set.p1)[l.result] || [];
    return opts.length ? opts[(b.id * 7 + i * 3) % opts.length] : null;
  }
  // «2:0», «3-1», «21» → [2, 0]; матч до двух побед в сетах (best_of = 3) или до трех (best_of = 5)
  function parseScore(s, bestOf) {
    const m = String(s).trim().match(/^(\d)\s*[:\-–.\s]?\s*(\d)$/);
    if (!m) return null;
    const a = +m[1], b = +m[2], need = bestOf === 5 ? 3 : 2;
    return (a === need && b < need) || (b === need && a < need) ? [a, b] : null;
  }
  const scoreExamples = bestOf => (bestOf === 5 ? '3:0, 3:1, 3:2, 2:3, 1:3 или 0:3' : '2:0, 2:1, 1:2 или 0:2');
  // Исход ноги по счету — для ML и форы ±1.5 при любом формате матча (как ml/sets.py)
  function resultFromScore(market, a, b) {
    switch (market) {
      case 'p1': return a > b ? 'win' : 'loss';
      case 'p2': return b > a ? 'win' : 'loss';
      case 'h1m': return a - b >= 2 ? 'win' : 'loss';
      case 'h2m': return b - a >= 2 ? 'win' : 'loss';
      case 'h1p': return b - a >= 2 ? 'loss' : 'win';
      case 'h2p': return a - b >= 2 ? 'loss' : 'win';
      default: return null;
    }
  }
  function parseOdds(s) {
    const v = parseFloat(String(s).replace(',', '.'));
    return isFinite(v) && v >= 1.01 && v <= 50 ? r2(v) : null;
  }

  // Вердикт считает код по закрывающей линии (CLV), без вызова Claude: отделяем дисперсию от возможной ошибки модели.
  // Разбор ставки ИИ (этап 5) — блок «Разбор ИИ» рядом, этот вердикт остается строкой в нем
  function verdict(b) {
    if (b.status === 'open') return null;
    if (isBot(b)) return { label: 'Без вердикта · старый бот', kind: 'outline', icon: 'info' };
    if (b.status === 'void') return { label: 'Возврат', kind: 'outline', icon: 'refresh' };
    if (b.status === 'win') {
      if (b.clv == null) return { label: 'Без закрытия', kind: 'outline', icon: 'info' };
      return b.clv < 0 ? { label: 'Выигрыш против рынка', kind: 'warn', icon: 'alert' } : { label: 'Перевес подтвержден', kind: 'good', icon: 'check' };
    }
    const lost = b.legs.filter(l => l.result === 'loss');
    if (lost.every(l => legClv(l) == null)) return { label: 'Без закрытия', kind: 'outline', icon: 'info' };
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
  // В5: ставки старого Telegram-бота перенесены в историю; по умолчанию показываются вместе со ставками приложения
  const SOURCE_OPTS = [{ value: 'all', label: 'Все источники' }, { value: 'app', label: 'Приложение' }, { value: 'bot', label: 'Старый бот' }];
  const SURF_KEYS = Object.keys(D.surfaces).filter(k => D.bets.some(b => b.surface === k));
  const blank = () => ({ period: 'all', status: 'all', market: 'all', source: 'all', surfaces: new Set(), q: '' });
  let F = blank();
  const PAGE = 20;
  let shown = PAGE;
  const expanded = new Set();
  let expandInit = false;
  let lastSettled = null; // {id} — ставка, рассчитанная в этой сессии
  let justSaved = null; // номер ставки, только что сохраненной на экране «Анализ»
  let ui = null;

  const norm = s => String(s).toLowerCase().replace(/\u0451/g, 'е');
  function matches(b, flt) {
    const p = PERIODS.find(x => x.id === flt.period);
    if (p && p.days && b.date <= addDays(TODAY, -p.days)) return false;
    if (flt.status !== 'all' && b.status !== flt.status) return false;
    if (flt.market !== 'all' && !b.legs.some(l => l.market === flt.market)) return false;
    if (flt.source !== 'all' && b.source !== flt.source) return false;
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
  const sheetActive = flt => (flt.status !== 'all' ? 1 : 0) + (flt.market !== 'all' ? 1 : 0) + (flt.source !== 'all' ? 1 : 0) + flt.surfaces.size;
  const anyActive = flt => sheetActive(flt) + (flt.period !== 'all' ? 1 : 0) + (flt.q ? 1 : 0);
  function describe(flt) {
    const parts = [];
    const p = PERIODS.find(x => x.id === flt.period);
    parts.push(p.days ? 'за ' + p.label : 'за все время');
    if (flt.status !== 'all') parts.push(STATUS_OPTS.find(o => o.value === flt.status).label.toLowerCase());
    if (flt.market !== 'all') parts.push(MARKET_OPTS.find(o => o.value === flt.market).label);
    if (flt.source !== 'all') parts.push(SOURCE_OPTS.find(o => o.value === flt.source).label.toLowerCase());
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
    .bets-mrow .btn { height: 40px; flex: none; }
    .bets-mrow .bets-search .input { height: 40px; }
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
    .bets-by { display: inline-flex; align-items: center; gap: 4px; margin-top: 4px; font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .bets-by svg { width: 12px; height: 12px; }
    .bets-by.auto { color: var(--accent-ink); }
    .bets-news { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 12px; align-items: center; padding: 10px 12px; border-radius: var(--r-sm); background: var(--info-soft); color: var(--info-ink); font-size: var(--fs-sm); }
    .bets-news b { color: var(--fg); }
    .bets-news small { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    @media (max-width: 720px) { .bets-news { grid-template-columns: minmax(0, 1fr); } .bets-news .btn { justify-self: start; } }
    .bets-review-v { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .bets-review-meta { font-size: var(--fs-xs); color: var(--fg-3); }
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
    .bets-dleg-grid dd small { display: block; margin-top: 1px; font-size: 11px; font-weight: 400; line-height: 1.3; color: var(--fg-3); white-space: normal; overflow-wrap: anywhere; }

    .bets-settle-intro { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: center; font-size: var(--fs-sm); color: var(--fg-2); }
    .bets-sleg { border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .bets-sleg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; min-width: 0; }
    .bets-sleg-head > div { min-width: 0; }
    .bets-sleg-match { font-weight: 600; }
    .bets-sleg-odds { font-size: var(--fs-lg); }
    .bets-sleg-grid { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); gap: 12px; align-items: start; }
    .bets-resseg { display: flex; padding: 3px; gap: 2px; background: var(--surface-2); border-radius: var(--r-md); min-width: 0; }
    .bets-resseg button { flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 5px; height: 36px; padding: 0 6px; border: 0; border-radius: 7px; background: transparent; color: var(--fg-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; white-space: nowrap; }
    .bets-resseg button svg { width: 15px; height: 15px; flex: none; }
    .bets-resseg button:hover { color: var(--fg); }
    .bets-resseg button[aria-pressed="true"] { background: var(--surface); color: var(--fg); box-shadow: inset 0 0 0 1px var(--line-strong); font-weight: 600; }
    .bets-resseg button.win[aria-pressed="true"] { background: var(--good-soft); color: var(--good-ink); box-shadow: inset 0 0 0 1px var(--good-ink); }
    .bets-resseg button.loss[aria-pressed="true"] { background: var(--bad-soft); color: var(--bad-ink); box-shadow: inset 0 0 0 1px var(--bad-ink); }
    .bets-sleg .input { height: 40px; }
    .bets-close { border: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .bets-close > legend { padding: 0; margin-bottom: 6px; }
    .bets-close-grid { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr) minmax(0, 1fr); gap: 12px; align-items: end; }
    .bets-close-grid .field-label { flex-wrap: wrap; justify-content: flex-start; column-gap: 4px; }
    .bets-opt { font-size: var(--fs-xs); color: var(--fg-3); font-weight: 400; }
    .bets-close-hint { margin-top: -2px; }
    .chip.bets-src { height: 20px; padding: 0 7px; margin-top: 4px; font-size: 11px; }
    .bets-res.unknown { background: var(--surface-3); color: var(--fg-3); }
    .bets-auto { color: var(--accent-ink); }
    .bets-auto.warn { color: var(--warn-ink); }
    .bets-ssum { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .bets-ssum > div { background: var(--surface-2); padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
    .bets-ssum dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .bets-ssum dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; min-height: 24px; display: flex; align-items: center; }
    .bets-ssum small { font-size: 11px; color: var(--fg-3); font-weight: 400; }
    @media (max-width: 960px) {
      /* на телефоне цели касания не меньше 40px */
      .bets-resseg button, .bets-chipbtn, .bets-active .bets-chipbtn, .bets-banner .row .btn { height: 40px; }
    }
    @media (max-width: 720px) {
      .bets-sleg { padding: 12px; }
      .bets-sleg-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .bets-close-grid { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .bets-close-grid > .field:first-child { grid-column: 1 / -1; }
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
        h('p', { class: 'lead' }, 'Каждая ставка, сделанная по анализу ИИ, и история старого бота. Внесите результат после матча: от него зависят банк, CLV и точность модели в «Аналитике».')),
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
      nativeSelect('Источник', SOURCE_OPTS, F.source, v => { F.source = v; shown = PAGE; refresh(); }),
      chips);
  }

  function mobileFilters() {
    const n = sheetActive(F);
    const fbtn = button('Фильтры', { kind: 'secondary', icon: 'filter', onClick: filterSheet, ariaLabel: n ? 'Фильтры, выбрано: ' + n : 'Фильтры' });
    if (n) fbtn.appendChild(h('span', { class: 'chip accent bets-fcount' }, String(n)));
    const active = [];
    if (F.status !== 'all') active.push([STATUS_OPTS.find(o => o.value === F.status).label, () => { F.status = 'all'; }]);
    if (F.market !== 'all') active.push([MARKET_OPTS.find(o => o.value === F.market).label, () => { F.market = 'all'; }]);
    if (F.source !== 'all') active.push([SOURCE_OPTS.find(o => o.value === F.source).label, () => { F.source = 'all'; }]);
    F.surfaces.forEach(k => active.push([surfLabel(k), () => { F.surfaces.delete(k); }]));
    return h('div', { class: 'bets-mfilters', role: 'region', 'aria-label': 'Фильтры ставок' },
      h('div', { class: 'bets-mrow' }, searchBox(), fbtn),
      periodSeg(),
      active.length ? h('div', { class: 'bets-active' },
        active.map(([t, drop]) => h('button', { type: 'button', class: 'bets-chipbtn', 'aria-pressed': 'true', 'aria-label': 'Убрать фильтр: ' + t, on: { click: () => { drop(); shown = PAGE; build(); } } }, t, icon('x'))),
        h('button', { type: 'button', class: 'bets-chipbtn', on: { click: resetFilters } }, 'Сбросить все')) : null);
  }

  function filterSheet() {
    const d = { status: F.status, market: F.market, source: F.source, surfaces: new Set(F.surfaces) };
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
    const sourceGroup = h('div', { class: 'bets-chipgroup', role: 'group', 'aria-label': 'Источник' });
    const drawSource = () => {
      UI.clear(sourceGroup);
      SOURCE_OPTS.forEach(o => sourceGroup.appendChild(h('button', { type: 'button', class: 'bets-chipbtn', 'aria-pressed': String(d.source === o.value), on: { click: () => { d.source = o.value; drawSource(); upd(); } } }, o.value === 'all' ? 'Все' : o.label)));
    };
    drawSource();
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
        h('div', { class: 'field' }, h('div', { class: 'field-label' }, 'Источник'), sourceGroup, h('div', { class: 'field-hint' }, 'Старый бот — история, перенесенная из Telegram-бота: в банке и ROI есть, в CLV — нет')),
      ],
      actions: close => [
        button('Сбросить', { kind: 'secondary', onClick: () => { close(); F = Object.assign(F, { status: 'all', market: 'all', source: 'all', surfaces: new Set() }); shown = PAGE; build(); } }),
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
    const clvs = st.filter(b => b.clv != null && !isBot(b)); // В5: ставки старого бота в CLV не входят
    const open = list.filter(b => b.status === 'open');
    return {
      n: st.length, wins, losses, voids, turnover, profit,
      roi: turnover ? profit / turnover * 100 : null,
      winrate: wins + losses ? wins / (wins + losses) * 100 : null,
      clv: clvs.length ? sum(clvs, b => b.clv) / clvs.length : null,
      clvPos: clvs.filter(b => b.clv > 0).length, clvN: clvs.length, botN: st.filter(isBot).length,
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
        cell('Средний CLV', pctOrDash(s.clv), s.clvN ? ['лучше закрытия: ', h('span', { class: 'bets-nw' }, s.clvPos + ' из ' + s.clvN)] : s.n && s.botN === s.n ? 'у старого бота не считается' : 'нет закрывающих кэфов', toneCls(s.clv))),
      h('div', { class: 'bets-sum-note' }, icon('info'),
        h('span', null, 'CLV = ваш кэф ÷ закрывающий − 1. Закрывающий кэф вы вносите сами: эталона (' + D.marketRefRule + ') или своего букмекера — в поле видно, чей. Внесете и вторую сторону — в «Аналитике» появится CLV без маржи. Ставки старого бота в CLV не входят. Если CLV стабильно в плюсе, модель находит перевес, даже когда отдельные ставки проигрывают.')));
  }

  // ---------- баннер после расчета ----------
  function banner() {
    if (!lastSettled) return null;
    const b = D.bets.find(x => x.id === lastSettled.id);
    if (!b) return null;
    const res = b.status === 'win' ? 'выигрыш ' + fmt.signedMoney(b.profit) : b.status === 'loss' ? 'проигрыш ' + fmt.signedMoney(b.profit) : 'возврат, сумма вернулась на счет';
    const v = verdict(b);
    return h('div', { class: 'callout accent bets-banner', role: 'status' }, icon('check'),
      h('div', { class: 'bets-banner-body' },
        h('div', null, h('b', null, 'Ставка №' + b.id + (lastSettled.corrected ? ' пересчитана: ' : ' рассчитана: ') + res + '. '), 'Банк — ' + fmt.money(S.bank) + '.' + (lastSettled.corrected ? ' ' + journalOnCorrect(b.correctedFrom) : '')),
        h('div', { class: 'row', style: 'gap:6px' }, h('span', null, 'Вердикт по CLV:'), v && chip(v.label, v.kind, v.icon), h('span', null, reviewNext(b))),
        h('div', { class: 'xsmall muted' }, 'При ручном расчете уведомление не приходит — только это сообщение. Разбор ИИ будет в течение часа (Sonnet 5.5 через Batch, ≈ $0,01 за матч) — в деталях ставки.'),
        h('div', { class: 'row' },
          button('Исправить результат', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: () => correctModal(b) }))),
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
    const stake = fmt.fromMoney(sum(open, b => inCur(b.stake))), pay = fmt.fromMoney(sum(open, b => payCur(b.stake, b.total)));
    return h('section', { class: 'stack', 'aria-label': 'Ставки в игре' },
      h('div', { class: 'bets-sec-head' }, h('h3', null, 'В игре'), chip(open.length + ' ' + betsWord(open.length), 'info', 'clock'),
        h('span', { class: 'small muted' }, 'на кону ' + fmt.money(stake) + ' · если все зайдет, выплата ' + fmt.money(pay))),
      h('div', { class: 'bets-open-grid' }, open.map(openCard)));
  }

  function openCard(b) {
    const pay = payRub(b.stake, b.total);
    return h('article', { class: ['card bets-open', justSaved === b.id && 'is-new'], 'aria-label': 'Открытая ставка №' + b.id, 'data-open-bet': String(b.id) },
      h('div', { class: 'bets-open-head' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'bets-open-title' }, betKindLong(b)),
          h('div', { class: 'xsmall muted' }, '№' + b.id + ' · ' + b.bookmaker + ' · ' + b.tournament + ', ' + dateLabel(b.date))),
        b.awaiting ? chip('Ждет результата', 'warn', 'clock') : UI.statusChip('open')),
      h('ul', { class: 'bets-olegs' }, b.legs.map(l => {
        const m = matchOf(l);
        return h('li', { class: 'bets-oleg' },
          h('span', { class: 'bets-oleg-time' }, m ? m.time : fmt.date(b.date)),
          h('div', { style: 'min-width:0' },
            h('div', { class: 'bets-oleg-match' }, plink(l.p1), ' — ', plink(l.p2)),
            h('div', { class: 'bets-oleg-meta', title: 'Вероятность исхода: оценка ИИ и вероятность по кэфу (1 / кэф)' }, h('b', null, l.marketLabel), ' · ', h('span', { class: 'bets-nw' }, 'ИИ ' + fmt.prob(l.p)), ' · ', h('span', { class: 'bets-nw' }, 'по кэфу ' + fmt.prob(1 / l.odds)))),
          h('span', { class: 'odds bets-oleg-odds' }, fmt.odds(l.odds)));
      })),
      h('dl', { class: 'bets-open-sum' },
        h('div', null, h('dt', null, 'Итоговый кэф'), h('dd', { class: 'odds' }, fmt.odds(b.total))),
        h('div', null, h('dt', null, 'Сумма'), h('dd', null, fmt.money(b.stake))),
        h('div', null, h('dt', null, 'Выплата'), h('dd', null, fmt.money(pay)))),
      b.awaiting && h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Матчи сыграны ' + fmt.date(b.date) + '. В архиве tennis-data матчи по ' + fmt.date(D.archive.matchesTo) + ': ставка рассчитается сама после загрузки файла ≈ ' + fmt.date(D.archive.next) + '. Не хотите ждать — внесите результат, в окне есть подсказка из новостей.'),
      h('div', { class: 'bets-open-actions' },
        button('Внести результат', { kind: 'primary', icon: 'edit', onClick: () => settleModal(b), attrs: { 'data-settle': String(b.id) } }),
        // экран «Анализ» показывает только последний анализ — ссылку даем, если ставка сделана по нему
        b.analysis && b.analysis === D.currentAnalysis
          ? button('Анализ', { kind: 'secondary', icon: 'spark', href: '#analysis', title: 'Открыть анализ #' + b.analysis + ', по которому сделана ставка' })
          : button('Почему эта ставка', { kind: 'secondary', icon: 'info', onClick: () => whyModal(b) })));
  }

  // Короткая выжимка анализа, по которому сделана ставка: оценка модели против кэфа по каждой ноге и правило суммы
  function whyModal(b) {
    // анализ дня, после которого сделана ставка (анализ — запуск из нескольких вызовов Claude)
    const run = ((D.ai && D.ai.analyses) || []).filter(a => a.at.slice(0, 10) === b.date).pop();
    const runId = run ? run.id : null;
    // 4 диапазона по коду (Т20): четвертый, 3.25–4.10, — только экспресс из 3 событий
    const T = D.strategy.stakeTable;
    const band = b.total <= 1.70 ? T[0] : b.total <= 2.20 ? T[1] : b.total <= 3.24 ? T[2] : T[3];
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
        h('div', { class: 'bets-sub' }, h('i', { class: 'bets-dot', style: { background: D.surfaces[b.surface].color } }), b.tournament + ' · ' + surfLabel(b.surface).toLowerCase()),
        isBot(b) && h('span', { class: 'chip outline bets-src', title: 'Перенесена из старого Telegram-бота' }, 'старый бот'),
        byTag(b)),
      h('td', null, b.legs.map(l => legLine(b, l))),
      h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(b.total))),
      h('td', { class: 'r' }, fmt.money(b.stake)),
      h('td', null, UI.statusChip(b.status)),
      h('td', { class: 'r' }, h('span', { class: ['bets-profit', toneCls(b.profit)] }, fmt.signedMoney(b.profit))),
      h('td', { class: 'r' }, isBot(b) ? botDash() : h('span', { class: toneCls(b.clv) }, clvText(b.clv))),
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
      h('thead', null, h('tr', null, th('Событие'), th('Счет', 'c'), th('Кэф', 'r'), th('Закрытие', 'r', 'Закрывающий кэф, который вы внесли, и чей он'), th('CLV', 'r'), th('ИИ', 'r', 'Вероятность исхода по оценке ИИ'), th('По кэфу', 'r', 'Вероятность по кэфу: 1 / кэф'), th('Разница', 'r', 'ИИ − по кэфу, п.п.'), th('Итог'))),
      h('tbody', null, b.legs.map((l, i) => {
        const implied = 1 / l.odds, edge = (l.p - implied) * 100, clv = legClv(l), sc = legScore(b, l, i);
        return h('tr', null,
          h('td', null, h('div', { style: 'white-space:nowrap;font-weight:500' }, plink(l.p1), ' — ', plink(l.p2)), h('div', { class: 'xsmall muted' }, l.marketLabel + ' · ' + surfLabel(l.surface).toLowerCase() + (l.bestOf === 5 ? ' · до 3 побед' : ''))),
          h('td', { class: 'c' }, h('span', { class: 'mono' }, sc || '—')),
          h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(l.odds))),
          h('td', { class: 'r' }, l.closing ? [h('span', { class: 'odds' }, fmt.odds(l.closing)), h('div', { class: 'xsmall muted', style: 'white-space:nowrap', title: l.closingSource === 'archive' ? ARCH_NOTE : null }, closingWho(l))] : isBot(b) ? botDash() : noClosing(b, l)),
          h('td', { class: 'r' }, isBot(b) ? botDash() : h('span', { class: toneCls(clv) }, clvText(clv))),
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
      ['CLV ставки', isBot(b) ? h('span', { class: 'muted' }, '— · старый бот') : h('span', { class: toneCls(b.clv) }, clvText(b.clv))],
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
      isBot(b) ? h('div', { title: BOT_CLV }, h('dt', null, 'CLV ставки'), h('dd', { class: 'muted' }, '— · старый бот')) : c('CLV ставки', clvText(b.clv), toneCls(b.clv)),
      c('Шанс: ИИ / кэф', fmt.prob(pModel) + ' / ' + fmt.prob(1 / b.total)));
  }

  function detailBlock(b) {
    return h('div', { class: 'bets-detail' },
      h('div', { class: 'bets-detail-main' },
        h('div', { class: 'bets-detail-cap' }, h('h4', null, 'События ставки'), h('span', { class: 'xsmall muted' }, 'Разница = вероятность ИИ − вероятность по кэфу, п.п. CLV = кэф ÷ закрывающий − 1.')),
        legsTable(b),
        b.status === 'void' && h('div', { class: 'bets-detail-note' }, UI.callout('', 'refresh', 'Букмекер рассчитал ставку возвратом — сумма вернулась на счет. В калибровке и CLV не учитывается.')),
        isBot(b) && h('div', { class: 'bets-detail-note' }, UI.callout('', 'info', botNote(b)))),
      h('div', { class: 'bets-detail-bottom' },
        h('div', { class: 'bets-detail-box' }, h('span', { class: 'eyebrow' }, 'Расчет'), kvGrid(b), h('p', { class: 'xsmall muted' }, settledNote(b)), b.corrected && h('p', { class: 'xsmall muted' }, correctedNote(b)), conflictNote(b)),
        h('div', { class: 'bets-detail-box' },
          reviewBlock(b),
          !isBot(b) && h('div', { class: 'row' },
            button(b.legs.some(l => !l.closing && legRes(b, l) !== 'void') ? 'Внести закрытие' : 'Закрывающие кэфы', { kind: 'secondary', size: 'sm', icon: 'bolt', onClick: () => closingModal(b) }),
            button('Исправить результат', { kind: 'ghost', size: 'sm', icon: 'edit', onClick: () => correctModal(b) })))));
  }
  const closingWho = l => (l.closingSource === 'archive' ? 'архив tennis-data · ' + l.closingBy : l.closingBy === D.marketRef || l.closingBy === 'Betfair' || l.closingBy === 'средний' ? 'эталон · ' + l.closingBy : 'свой · ' + l.closingBy);
  // Т1: в архиве tennis-data кэфы только на победу (П1/П2), момент снятия не проверен; у фор закрытие вносит участник
  const ARCH_NOTE = 'Кэф из архива tennis-data (эталон Pinnacle → Betfair → средний), момент снятия не проверен';
  const isMl = l => l.market === 'p1' || l.market === 'p2';
  const noClosing = (b, l) => (b.status !== 'open' && !isMl(l) && legRes(b, l) !== 'void'
    ? h('span', { class: 'xsmall muted', style: 'white-space:nowrap', title: 'В архиве tennis-data нет кэфов на форы — закрытие вносите сами' }, 'внесите сами')
    : h('span', { class: 'odds' }, '—'));
  // Кто рассчитал ставку: авторасчет по файлу tennis-data, вы или импорт старого бота
  function byTag(b) {
    if (b.status === 'open' || isBot(b) || !b.settledBy) return null;
    return b.settledBy === 'auto'
      ? h('span', { class: 'bets-by auto', title: 'Рассчитана автоматически по файлу tennis-data от ' + fmt.date(b.archiveFile) }, icon('database'), 'авто · архив ' + fmt.date(b.archiveFile))
      : h('span', { class: 'bets-by', title: 'Результат внесли вы' }, icon('user'), 'внесено вами');
  }
  function settledNote(b) {
    if (isBot(b)) return 'Перенесена из старого бота.';
    if (b.settledBy === 'auto') return 'Рассчитана автоматически ' + fmt.date(b.settledAt) + ', ' + b.settledAt.slice(11, 16) + ' по архиву tennis-data (файл от ' + fmt.date(b.archiveFile) + '). Ошибся архив — «Исправить результат», как при ручном расчете.';
    return 'Результат внесли вы' + (b.settledAt ? ' ' + fmt.date(b.settledAt) : '') + '. Ручной расчет главнее: архив его не меняет, а при расхождении приходит уведомление.';
  }
  // Т3: архив разошелся с ручным расчетом — деньги не трогаем, предлагаем проверить
  function conflictNote(b) {
    if (!b.conflict || b.status === 'open') return null;
    const l = b.legs[b.conflict.leg];
    return UI.callout('warn', 'alert', h('div', { class: 'stack', style: 'gap:6px' },
      h('span', null, h('b', null, 'Архив показывает другое. '), 'В файле tennis-data счет ' + b.conflict.score + ' — по нему ' + l.marketLabel + ' ' + (b.conflict.archiveResult === 'loss' ? 'не сыграла' : 'сыграла') + ', а вы внесли ' + (l.result === 'win' ? 'выигрыш' : 'проигрыш') + '. Банк не меняли.'),
      button('Исправить результат', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: () => correctModal(b) })));
  }
  // Разбор ставки ИИ (этап 5, В3): Sonnet 5.5 через Batch, один на матч; ответ по схеме проверяет код.
  // Рядом — вердикт кодом по CLV (без ИИ), как на этапе 4
  function reviewBlock(b) {
    const head = h('div', { class: 'row-between' }, h('span', { class: 'eyebrow' }, 'Разбор ИИ'));
    if (b.status === 'open') return [head, h('p', null, 'Разбор появится после расчета ставки.')];
    if (isBot(b)) return [head, h('p', null, 'Ставки старого бота не разбираются: у них нет досье и вероятностей модели на момент ставки.')];
    if (b.status === 'void') return [head, h('p', null, 'Возврат не разбирается: исхода нет.'), clvLine(b)];
    if (b.pmPending) return [head, h('p', null, 'Разбор готовится: запрос в пакете Batch, ответ — в течение часа, иногда до суток. Стоимость ≈ $0,01 за матч.'), clvLine(b)];
    const pm = D.learning.postmortemOf(b);
    if (!pm) return [head];
    const tone = { fine: 'good', lucky: 'warn', luck: 'info', model_error: 'serious', data_gap: 'warn' }[pm.verdict];
    const ls = pm.lesson && D.learning.lessons.find(x => x.id === pm.lesson);
    const lsState = ls ? { hypothesis: 'гипотеза, ' + ls.own + ' из ' + D.learning.LESSON_MIN + ' случаев', ready: 'подтвержден на истории, ждет решения', confirmed: ls.inPrompt ? 'в инструкциях анализа' : 'подтвержден, выключен', rejected: 'отклонен', retired: 'списан' }[ls.status] : null;
    return [
      h('div', { class: 'row-between' }, h('span', { class: 'eyebrow' }, 'Разбор ИИ'), chip(pm.label, tone, pm.verdict === 'fine' ? 'check' : pm.verdict === 'luck' ? 'info' : 'alert')),
      h('p', null, h('b', null, 'Что произошло. '), pm.what),
      h('p', null, h('b', null, 'Почему. '), pm.why),
      h('p', null, h('b', null, 'Гипотеза. '), ls ? [h('a', { href: '#learning-lessons' }, ls.id), ' — ' + lsState + '. ' + ls.text] : 'Новой гипотезы нет.'),
      clvLine(b),
      h('div', { class: 'bets-review-meta' }, 'Sonnet 5.5 · Batch · ≈ ' + fmt.usd(pm.cost) + ' за матч · ' + fmt.date(pm.at) + ', ' + pm.at.slice(11, 16) + ' · один разбор на матч, общий для всех, кто на него ставил'),
    ];
  }
  const clvLine = b => h('div', { class: 'bets-review-v' }, h('span', { class: 'small muted' }, 'По CLV, без ИИ:'), verdictChip(b), h('span', { class: 'small soft' }, reviewNext(b)));
  const botNote = b => 'Ставка перенесена из старого Telegram-бота: у нее есть сумма, кэф и итог, поэтому она входит в банк и ROI. Закрывающих кэфов, итоговой вероятности модели и рынка в момент прогноза бот не записывал, поэтому CLV, Brier против рынка и калибровка модели по ней не считаются.' + (b.legs.some(l => l.noResult) ? ' Исходы событий проигранного экспресса бот тоже не записывал.' : '');
  const correctedNote = b => (b.status === 'open' ? 'Расчет отменен ' : 'Результат исправлен ') + fmt.date(b.corrected) + '. ' + journalOnCorrect(b.correctedFrom)
    + (b.status === 'open' ? ' Внесите новый результат.' : b.status === 'loss' ? ' Новый проигрыш проводки не требует.' : ' Новая ' + (b.status === 'void' ? 'сумма возврата' : 'выплата') + ' записана отдельной проводкой.');

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
          h('div', { class: 'bets-sub' }, h('i', { class: 'bets-dot', style: { background: D.surfaces[b.surface].color } }), b.tournament + ' · ' + surfLabel(b.surface).toLowerCase() + ' · №' + b.id + (isBot(b) ? ' · старый бот' : ''))),
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
        return [
          h('div', { class: 'bets-dm-top' },
            h('div', null,
              h('div', { class: 'xsmall muted' }, fmt.dateFull(b.date) + ' · ' + betKind(b) + ' · ' + b.bookmaker),
              h('div', { class: ['bets-dm-profit', toneCls(b.profit)] }, b.status === 'open' ? fmt.money(b.stake) : fmt.signedMoney(b.profit))),
            UI.statusChip(b.status)),
          b.status !== 'open' && !isBot(b) && h('div', { class: 'bets-detail-box' }, reviewBlock(b)),
          b.status !== 'open' && h('p', { class: 'xsmall muted', style: 'margin:0' }, settledNote(b)),
          conflictNote(b),
          b.legs.map((l, i) => {
            const clv = legClv(l), sc = legScore(b, l, i);
            return h('div', { class: 'bets-dleg' },
              h('div', { class: 'bets-dleg-head' }, resIcon(legRes(b, l)),
                h('div', { style: 'min-width:0;flex:1' },
                  h('div', { class: 'bets-dleg-match' }, plink(l.p1), ' — ', plink(l.p2)),
                  h('div', { class: 'xsmall muted' }, l.marketLabel + ' · ' + l.tournament + (sc ? ' · счет ' + sc : '') + (l.bestOf === 5 ? ' · до 3 побед' : ''))),
                h('span', { class: 'odds' }, fmt.odds(l.odds))),
              h('dl', { class: 'bets-dleg-grid' },
                h('div', { title: isBot(b) ? BOT_CLV : null }, h('dt', null, 'Закрытие'), h('dd', null, h('span', { class: 'odds' }, l.closing ? fmt.odds(l.closing) : '—'), l.closing && h('small', null, closingWho(l)))),
                h('div', { title: isBot(b) ? BOT_CLV : null }, h('dt', null, 'CLV'), h('dd', { class: isBot(b) ? 'muted' : toneCls(clv) }, clvText(clv))),
                h('div', null, h('dt', null, 'ИИ'), h('dd', null, fmt.prob(l.p))),
                h('div', null, h('dt', null, 'По кэфу'), h('dd', null, fmt.prob(1 / l.odds)))));
          }),
          b.status === 'void' && UI.callout('', 'refresh', 'Букмекер рассчитал ставку возвратом — сумма вернулась на счет.'),
          isBot(b) && UI.callout('', 'info', botNote(b)),
          b.corrected && h('p', { class: 'xsmall muted', style: 'margin:0' }, correctedNote(b)),
          b.status === 'open'
            ? UI.kv([['Букмекер', b.bookmaker], ['Итоговый кэф', h('span', { class: 'odds' }, fmt.odds(b.total))], ['Выплата при выигрыше', fmt.money(payRub(b.stake, b.total))]])
            : betKv(b),
        ];
      },
      actions: close => b.status === 'open'
        ? [button('Закрыть', { kind: 'secondary', onClick: close }), button('Внести результат', { kind: 'primary', icon: 'edit', onClick: () => { close(); settleModal(b); } })]
        : [!isBot(b) && button('Исправить', { kind: 'secondary', icon: 'edit', onClick: () => { close(); correctModal(b); } }), !isBot(b) && button('Закрытие', { kind: 'secondary', icon: 'bolt', onClick: () => { close(); closingModal(b); } }), button('Закрыть', { kind: 'primary', onClick: close })].filter(Boolean),
    });
  }

  // Пояснение к вердикту кодом (без ИИ)
  function reviewNext(b) {
    const v = verdict(b);
    if (b.status === 'open') return 'Вердикт появится после внесения результата.';
    if (isBot(b)) return 'Ставка старого бота: CLV и вердикт по ней не считаются.';
    if (b.status === 'void') return 'Возврат не участвует в CLV и калибровке.';
    if (v.label === 'Без закрытия') return 'Закрывающий кэф не внесен — по CLV не отличить невезение от ошибки модели. Его можно внести и сейчас.';
    if (b.status === 'win') return v.kind === 'good' ? 'Ставка выиграла, и к старту линия ушла в вашу сторону: рынок согласился с оценкой.' : 'Ставка выиграла, но к старту линия ушла против вас (CLV ниже нуля). На дистанции такие ставки теряют деньги.';
    return v.kind === 'info' ? 'По закрывающим кэфам рынок был согласен с вашей ценой: проигрыш в пределах дисперсии.' : 'У проигравшего события линия к старту ушла против вас: рынок оценил шансы ниже модели. Если такое повторяется на одном рынке или покрытии, это будет видно в «Аналитике».';
  }

  // ---------- внесение результата ----------
  // В1: чей закрывающий кэф вносит участник — эталона по Р17 (по порядку Pinnacle → Betfair → средний по рынку)
  // или своего букмекера. Своя сторона нужна для CLV, вторая — по желанию: с ней есть рынок закрытия без маржи
  const CLOSE_WHO = b => [
    { value: 'Pinnacle', label: 'Pinnacle — эталон' },
    { value: 'Betfair', label: 'Betfair — эталон' },
    { value: 'средний', label: 'Средний по рынку — эталон' },
  ].concat(b.bookmaker && b.bookmaker !== 'Pinnacle' ? [{ value: b.bookmaker, label: b.bookmaker + ' — ваш букмекер' }] : []);
  const RES_OPTS = [{ id: 'win', label: 'Выиграл', icon: 'check' }, { id: 'loss', label: 'Проиграл', icon: 'x' }, { id: 'void', label: 'Возврат', icon: 'refresh' }];
  const RES_WORD = { win: 'выиграла', loss: 'проиграла', void: 'возврат' };

  // Поля закрывающего кэфа одной ноги: чей кэф, ваш исход, противоположный исход (по желанию) и подсказка с CLV
  function closingFields(b, l, id, s, onChange) {
    const whoF = UI.field({ id: id + '-who', label: 'Чей кэф', options: CLOSE_WHO(b), value: s.closingBy || 'Pinnacle' });
    const ownF = UI.field({ id: id + '-own', label: 'На ваш исход', placeholder: fmt.odds(l.odds), inputmode: 'decimal', value: s.closing ? fmt.odds(s.closing) : null, attrs: { autocomplete: 'off', maxlength: '5' } });
    const oppF = UI.field({ id: id + '-opp', label: 'На обратный исход', labelAside: h('span', { class: 'bets-opt' }, 'по желанию'), placeholder: fmt.odds(l.oddsOpp || 2), inputmode: 'decimal', value: s.closingOpp ? fmt.odds(s.closingOpp) : null, attrs: { autocomplete: 'off', maxlength: '5' } });
    const hint = h('div', { class: 'field-hint bets-close-hint', 'aria-live': 'polite' });
    const ownIn = ownF.querySelector('input'), oppIn = oppF.querySelector('input'), whoSel = whoF.querySelector('select');
    ownIn.classList.add('mono'); oppIn.classList.add('mono');
    const draw = () => {
      const rawO = ownIn.value.trim(), rawP = oppIn.value.trim();
      const o = parseOdds(rawO), q = parseOdds(rawP);
      const badO = !!rawO && !o && rawO.length >= 3, badP = !!rawP && !q && rawP.length >= 3;
      ownIn.classList.toggle('invalid', badO); oppIn.classList.toggle('invalid', badP);
      s.closing = o; s.closingOpp = o && q ? q : null; s.closingBy = whoSel.value;
      UI.clear(hint); hint.className = 'field-hint bets-close-hint';
      if (badO || badP) { hint.className = 'field-error bets-close-hint'; hint.textContent = 'Кэф от 1.01, например ' + fmt.odds(l.odds); }
      else if (o) {
        const clv = (l.odds / o - 1) * 100, fair = fairClv(l.odds, o, s.closingOpp);
        hint.append('Перед стартом · ', h('b', { class: [toneCls(clv), 'bets-nw'] }, 'CLV ' + fmt.signedPct(clv)),
          ...(fair != null ? [' · ', h('b', { class: [toneCls(fair), 'bets-nw'] }, 'без маржи ' + fmt.signedPct(fair))] : [' · вторая сторона даст CLV без маржи']));
      } else hint.textContent = 'Можно внести позже. Без закрывающего кэфа CLV не посчитать.';
      onChange && onChange();
    };
    ownIn.addEventListener('input', draw); oppIn.addEventListener('input', draw); whoSel.addEventListener('change', draw);
    draw();
    return h('fieldset', { class: 'bets-close', style: 'margin:0' },
      h('legend', { class: 'field-label' }, 'Закрывающий кэф'),
      h('div', { class: 'bets-close-grid' }, whoF, ownF, oppF), hint);
  }

  // prefill — прошлый расчет при исправлении результата
  function settleModal(b, prefill) {
    if (b.status !== 'open') { detailModal(b); return; }
    const st = b.legs.map((l, i) => Object.assign({ result: null, score: null, closing: null, closingOpp: null, closingBy: null, auto: false }, prefill ? prefill[i] : null));
    const sumHost = h('div', { class: 'stack', style: 'gap:8px', 'aria-live': 'polite' });
    const formId = 'bets-settle-' + b.id;
    let saveBtn = null;

    // считаем в валюте программы, в DATA уходит в рублях демо-данных
    const stakeCur = inCur(b.stake);
    const outcome = () => {
      if (st.some(s => s.result === 'loss')) return { status: 'loss', payout: 0, profit: fmt.fromMoney(-stakeCur), eff: null };
      if (st.some(s => !s.result)) return null;
      if (st.every(s => s.result === 'void')) return { status: 'void', payout: b.stake, profit: 0, eff: null };
      const eff = r2(b.legs.reduce((a, l, i) => a * (st[i].result === 'win' ? l.odds : 1), 1));
      const pc = payCur(b.stake, eff);
      return { status: 'win', payout: fmt.fromMoney(pc), profit: fmt.fromMoney(roundCur(pc - stakeCur)), eff };
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
      if (!complete) sumHost.appendChild(h('div', { class: 'field-hint' }, o ? 'Ставка уже проиграна, но отметьте исход и по остальным событиям — они нужны для калибровки.' : 'Отметьте исход по каждому событию, чтобы рассчитать ставку.'));
      else if (o.status === 'win' && st.some(s => s.result === 'void')) sumHost.appendChild(h('div', { class: 'field-hint' }, 'Событие с возвратом считается с кэфом 1,00 — так рассчитывают экспрессы букмекеры.'));
      if (saveBtn) saveBtn.disabled = !complete;
    };

    // В1-Г: шаг новостей перед анализом уже нашел исход матча — это подсказка, деньги считаются только по вашему нажатию
    function newsHint(l, i, apply) {
      if (!l.news) return null;
      const n = l.news;
      return h('div', { class: 'bets-news', role: 'note' },
        h('div', { style: 'min-width:0' }, h('span', null, 'Найдено в новостях: ', h('b', null, n.text)), h('small', null, n.source + ' · ' + fmt.date(n.at) + ', ' + n.at.slice(11, 16) + ' · подсказка, проверьте перед сохранением')),
        button('Подставить ' + n.score, { kind: 'secondary', size: 'sm', icon: 'check', onClick: () => apply(n.score) }));
    }
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
        const sc = s.score && parseScore(s.score, l.bestOf);
        const fromScore = sc ? resultFromScore(l.market, sc[0], sc[1]) : null;
        if (s.auto) { autoNote.hidden = false; autoNote.className = 'field-hint bets-auto'; autoNote.textContent = 'Отметили по счету — можно поправить'; }
        else if (fromScore && s.result && fromScore !== s.result) { autoNote.hidden = false; autoNote.className = 'field-hint bets-auto warn'; autoNote.textContent = 'По счету ставка ' + RES_WORD[fromScore] + ' — проверьте, что выбрано верно'; }
        else autoNote.hidden = true;
      };
      const seg = h('div', { class: 'bets-resseg', role: 'group', 'aria-label': 'Исход ставки на матч ' + D.match(l) },
        RES_OPTS.map(o => (btns[o.id] = h('button', { type: 'button', class: o.id, 'aria-pressed': String(s.result === o.id), on: { click: () => setRes(o.id, false) } }, icon(o.icon), o.label))));

      const scoreHintText = 'первым — ' + pname(l.p1) + ' · ' + (l.bestOf === 5 ? 'до 3 побед' : 'до 2 побед');
      const scoreF = UI.field({ id: formId + '-score-' + i, label: 'Счет по сетам', placeholder: l.bestOf === 5 ? '3:1' : '2:0', value: s.score, hint: scoreHintText, attrs: { autocomplete: 'off', maxlength: '5' } });
      const scoreIn = scoreF.querySelector('input'), scoreHint = scoreF.querySelector('.field-hint');
      scoreIn.classList.add('mono');
      scoreIn.addEventListener('input', () => {
        const v = scoreIn.value.trim();
        s.score = v || null;
        const sc = parseScore(v, l.bestOf);
        if (!v) {
          scoreIn.classList.remove('invalid'); scoreHint.className = 'field-hint'; scoreHint.textContent = scoreHintText;
          if (s.auto) setRes(null); else checkConflict();
          return;
        }
        if (!sc) {
          if (v.replace(/\D/g, '').length >= 2) { scoreIn.classList.add('invalid'); scoreHint.className = 'field-error'; scoreHint.textContent = 'Матч ' + bestOfText(l) + ': ' + scoreExamples(l.bestOf); }
          return;
        }
        scoreIn.classList.remove('invalid'); scoreHint.className = 'field-hint'; scoreHint.textContent = scoreHintText;
        const r = resultFromScore(l.market, sc[0], sc[1]);
        if (!s.result || s.auto) setRes(r, true); else checkConflict();
      });

      return h('fieldset', { class: 'bets-sleg', style: 'margin:0' },
        h('legend', { class: 'sr-only' }, 'Событие ' + (i + 1) + ': ' + D.match(l)),
        h('div', { class: 'bets-sleg-head' },
          h('div', null, h('div', { class: 'bets-sleg-match' }, D.match(l)),
            h('div', { class: 'xsmall muted' }, (m ? m.time + ' · ' + m.round + ' · ' : fmt.date(b.date) + ' · ' + l.tournament + ' · ') + l.marketLabel + ' · ИИ ' + fmt.prob(l.p) + ' · матч ' + bestOfText(l))),
          h('span', { class: 'odds bets-sleg-odds', 'aria-label': 'Кэф ' + fmt.odds(l.odds) }, fmt.odds(l.odds))),
        h('div', { class: 'bets-sleg-grid' },
          h('div', { class: 'field bets-sleg-res' }, h('div', { class: 'field-label' }, 'Исход ставки'), seg, autoNote),
          scoreF),
        newsHint(l, i, sc => { scoreIn.value = sc; scoreIn.dispatchEvent(new Event('input')); }),
        closingFields(b, l, formId + '-close-' + i, s));
    }

    const save = close => {
      const o = outcome();
      if (!o || !st.every(s => s.result)) { UI.toast('Отметьте исход по каждому событию', 'alert'); return; }
      applySettle(b, st, o, !!prefill);
      close();
      UI.rerender();
      UI.toast(nbspCur('Ставка №' + b.id + (prefill ? ' пересчитана: ' : ' рассчитана: ') + (o.status === 'void' ? 'возврат' : fmt.signedMoney(o.profit)) + ', банк ' + fmt.money(S.bank)), o.status === 'loss' ? 'x' : 'check');
    };

    UI.modal({
      title: (prefill ? 'Исправить результат №' : 'Результат ставки №') + b.id,
      wide: true,
      body: close => {
        const form = h('form', { id: formId, class: 'stack', novalidate: true, on: { submit: e => { e.preventDefault(); save(close); } } },
          h('div', { class: 'bets-settle-intro' }, b.awaiting ? chip('Ждет результата', 'warn', 'clock') : UI.statusChip('open'), h('span', null, betKindLong(b) + ' · ' + b.bookmaker + ' · сумма ' + fmt.money(b.stake) + ' · кэф ', h('span', { class: 'odds' }, fmt.odds(b.total)))),
          b.awaiting && !prefill && UI.callout('info', 'database', h('b', null, 'Матчи сыграны ' + fmt.date(b.date) + '. '), 'В архиве tennis-data матчи по ' + fmt.date(D.archive.matchesTo) + ' — ставка рассчитается сама после загрузки файла ≈ ' + fmt.date(D.archive.next) + ', с закрытием П1/П2 из архива. Внесете сейчас — ручной расчет главнее, архив его не изменит.'),
          prefill && UI.callout('warn', 'edit', h('b', null, b.correctedFrom === 'loss' ? 'Прошлый расчет уже отменен. ' : 'Прошлый расчет уже отменен сторно. '), 'Поля заполнены прежними значениями — исправьте неверное и сохраните. Если закрыть окно, ставка останется открытой.'),
          b.legs.map(legBlock),
          sumHost,
          UI.callout('', 'info', h('b', null, 'Снятие и отказ. '), 'Если игрок снялся или не вышел на матч, выберите исход по правилам вашего букмекера: у одних ставка проигрывает, у других — возврат. Счет можно не вносить.'));
        drawSum();
        return form;
      },
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        saveBtn = button(prefill ? 'Сохранить исправление' : 'Сохранить результат', { kind: 'primary', icon: 'check', type: 'submit', attrs: { form: formId } }),
      ],
    });
    drawSum();
  }

  // Исправить результат (Р22): ставка снова открыта, затем вносится новый результат. У выигрыша и возврата выплата
  // отменяется сторно (reversal к payout или refund); у проигрыша выплаты не было — в журнале новой проводки нет,
  // сумма ставки просто снова в игре. Задним числом меняются банк, пик и просадка, а значит и суммы следующих ставок
  const journalOnCorrect = from => (from === 'loss'
    ? 'Прошлый расчет отменен: при проигрыше выплаты не было, поэтому сторно в журнале банка нет.'
    : 'Прошлая выплата отменена сторно, оба движения — в журнале банка.');
  function correctModal(b) {
    if (b.status === 'open') { settleModal(b); return; }
    const loss = b.status === 'loss';
    const what = loss
      ? 'Ставка снова станет открытой: ' + fmt.money(b.stake) + ' опять в игре, банк с учетом ставок в игре станет ' + fmt.money(S.bank - b.profit) + '. В журнале банка проводки не будет — при проигрыше выплаты не было, сумма ставки списана еще при ее создании.'
      : 'Расчет отменится сторно: ' + (b.status === 'win' ? 'выплата ' + fmt.money(b.stake + b.profit) : 'возврат ' + fmt.money(b.stake)) + ' спишется обратной проводкой, и ставка снова станет открытой.';
    UI.modal({
      title: 'Исправить результат №' + b.id,
      body: [
        h('p', { class: 'small soft' }, nbspCur(what) + ' Сразу откроется окно результата с прежними значениями.'),
        UI.kv([['Сейчас', UI.statusChip(b.status)], ['Прибыль', h('span', { class: toneCls(b.profit) }, fmt.signedMoney(b.profit))], ['Банк сейчас', fmt.money(S.bank)], [loss ? 'Банк после отмены' : 'Банк после сторно', fmt.money(S.bank - b.profit)]]),
        UI.callout('warn', 'alert', 'Исправление меняет банк задним числом: пик и просадку, а значит и правила адаптации для следующих ставок.' + (loss ? '' : ' В журнале банка останутся обе проводки — исходная и сторно.')),
      ],
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Отменить расчет и исправить', { kind: 'primary', icon: 'edit', onClick: () => { close(); const prev = reverseSettle(b); UI.rerender(); setTimeout(() => settleModal(b, prev), 60); } }),
      ],
    });
  }

  function reverseSettle(b) {
    const prev = b.legs.map((l, i) => ({ result: l.noResult ? null : l.result, score: legScore(b, l, i), closing: l.closing || null, closingOpp: l.closingOpp || null, closingBy: l.closingBy || null }));
    S.bank -= b.profit;
    S.profit -= b.profit; S.turnover -= b.stake; S.settled--; S.open++;
    if (b.status === 'win') S.wins--; else if (b.status === 'loss') S.losses--; else S.voids--;
    S.roi = r1(S.profit / S.turnover * 100);
    S.winrate = r1(S.wins / (S.wins + S.losses) * 100);
    D.bankHistory.push({ date: TODAY, bank: S.bank });
    D.allLegs = D.allLegs.filter(x => x.betId !== b.id);
    b.correctedFrom = b.status;
    b.status = 'open'; b.profit = 0; b.bankAfter = null; b.clv = null; b.effTotal = null; b.conflict = null;
    b.legs.forEach(l => { l.result = 'open'; l.score = null; delete l.noResult; });
    b.corrected = TODAY;
    expanded.delete(b.id);
    lastSettled = null;
    return prev;
  }

  // Закрывающие кэфы рассчитанной ставки можно внести позже (PUT …/legs/{id}/closing): CLV пересчитывается
  function closingModal(b) {
    const st = b.legs.map(l => ({ closing: l.closing || null, closingOpp: l.closingOpp || null, closingBy: l.closingBy || null }));
    UI.modal({
      title: 'Закрывающие кэфы · №' + b.id,
      wide: true,
      body: [
        h('p', { class: 'small soft' }, 'Кэф перед началом матча — эталона (' + D.marketRefRule + ') или своего букмекера. CLV ставки считается, когда внесены кэфы всех событий, кроме возвратов.'),
        b.legs.map((l, i) => h('div', { class: 'bets-sleg' },
          h('div', { class: 'bets-sleg-head' }, h('div', null, h('div', { class: 'bets-sleg-match' }, D.match(l)), h('div', { class: 'xsmall muted' }, l.marketLabel + ' · ' + fmt.date(b.date))), h('span', { class: 'odds bets-sleg-odds' }, fmt.odds(l.odds))),
          legRes(b, l) === 'void' ? h('p', { class: 'xsmall muted' }, 'Возврат — для CLV не нужен') : closingFields(b, l, 'bets-cl-' + b.id + '-' + i, st[i]))),
      ],
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Сохранить', { kind: 'primary', icon: 'check', onClick: () => {
          b.legs.forEach((l, i) => { if (legRes(b, l) === 'void') return; applyClosing(l, st[i]); });
          b.clv = betClv(b);
          D.allLegs.filter(x => x.betId === b.id).forEach((x, i) => { const l = b.legs[i]; Object.assign(x, { closing: l.closing, closingOpp: l.closingOpp, closingBy: l.closingBy, qClose: l.qClose }); });
          close(); UI.rerender();
          UI.toast('Закрывающие кэфы сохранены' + (b.clv != null ? ': CLV ставки ' + fmt.signedPct(b.clv) : ''), 'bolt');
        } }),
      ],
    });
  }
  function applyClosing(l, s) {
    l.closing = s.closing || null;
    l.closingOpp = s.closing && s.closingOpp ? s.closingOpp : null;
    l.closingBy = s.closing ? (s.closingBy || 'Pinnacle') : null;
    l.qClose = l.closing && l.closingOpp ? Math.round(devig(l.closing, l.closingOpp) * 1000) / 1000 : null;
    if (!l.closingOpp) delete l.qClose;
  }
  // CLV экспресса: Π кэфов ÷ Π закрытий − 1 по не-возвратным событиям, только если внесены все (В1)
  function betClv(b) {
    const live = b.legs.filter(l => l.result !== 'void');
    return live.length && live.every(l => l.closing) ? r1((live.reduce((a, l) => a * l.odds, 1) / live.reduce((a, l) => a * l.closing, 1) - 1) * 100) : null;
  }

  function applySettle(b, st, o, corrected) {
    b.legs.forEach((l, i) => {
      l.result = st[i].result;
      const sc = st[i].score && parseScore(st[i].score, l.bestOf);
      l.score = sc ? sc[0] + ':' + sc[1] : null;
      applyClosing(l, st[i]);
    });
    b.status = o.status;
    b.profit = o.profit;
    b.effTotal = o.eff && o.eff !== b.total ? o.eff : null;
    b.clv = betClv(b);
    b.settledBy = 'manual'; b.settledAt = TODAY + 'T10:05'; b.pmPending = true; b.awaiting = false;
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
    // события с исходом идут в калибровку и Brier (рынок — при прогнозе, В2), с закрытием — еще и в CLV
    b.legs.forEach(l => { if (l.result === 'win' || l.result === 'loss') D.allLegs.push(Object.assign({ date: b.date, betId: b.id, source: b.source }, l)); });
    lastSettled = { id: b.id, corrected: !!corrected };
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
