/* Новый анализ — окно ввода событий. Два способа: текстом в формате Telegram-бота (разбор имитирует Claude Haiku)
   или формой с подстановкой матчей дня. Справа — «Перед запуском»: свежесть данных игроков, режим анализа,
   цена и время, правила стратегии. Состояние живет в замыкании — черновик не теряется при переходах. */
(function () {
  'use strict';
  const { h, fmt, icon, button, chip, clear } = UI;
  const D = DATA, S = DATA.stats, ST = DATA.strategy, P = DATA.P;

  // ---------- справочники ----------
  const MK = [
    { key: 'p1', label: 'П1', main: true },
    { key: 'p2', label: 'П2', main: true },
    { key: 'h1m', label: 'Ф1(−1.5)' },
    { key: 'h1p', label: 'Ф1(+1.5)' },
    { key: 'h2m', label: 'Ф2(−1.5)' },
    { key: 'h2p', label: 'Ф2(+1.5)' },
  ];
  const MODES = [
    { id: 'precise', label: 'Точный', model: 'Opus 5.5', perEvent: 0.09, secs: 45, note: 'Свежие новости о травмах и снятиях ищет Sonnet 5.5, вероятности считает Opus 5.5. Для решения о ставке.' },
    { id: 'balanced', label: 'Сбалансированный', model: 'Sonnet 5.5', perEvent: 0.045, secs: 30, flag: 'не проверен', note: 'Та же схема без поиска новостей. Качество на eval-наборе еще не проверено — для решения о ставке выбирайте «Точный».' },
    { id: 'eco', label: 'Экономный', model: 'Haiku 4.5 + кэш', perEvent: 0.02, secs: 20, note: 'Черновая оценка по сохраненным профилям, чтобы отсеять лишнее. Не для решения о ставке.' },
  ];
  const COLLECT = { cost: 0.05, secs: 40 };   // сбор профиля игрока, которого нет в базе
  const REFRESH = { cost: 0.01, secs: 15 };   // обновление устаревшего профиля
  const PARSE_COST = '≈$' + fmt.dec(0.004, 3);
  const BOOKMAKERS = ['Fonbet', 'Winline', 'Лига Ставок', 'BetBoom', 'PARI', 'Другой'];
  const ROUNDS = ['1/64 финала', '1/32 финала', '1/16 финала', '1/8 финала', '1/4 финала', '1/2 финала', 'Финал'];
  const SURF_WORDS = [[/крыт|indoor|зал/i, 'indoor'], [/хард|hard/i, 'hard'], [/грунт|clay/i, 'clay'], [/трав|grass/i, 'grass']];
  const TOURS = [...new Set(D.calendar.flatMap(c => c.name.split(' / ')))];
  const LESSONS_ON = D.lessons.filter(l => l.inPrompt).length;
  const LEGS = '2–' + ST.maxLegs; // экспресс из 2–3 событий, ординаров стратегия не допускает

  const EXAMPLE = [
    'Текущий банк: ' + fmt.int(S.bank) + ' ₽',
    'Букмекер: Fonbet',
    '',
    'События:',
    'Синнер vs Руне, Шанхай, хард',
    'Кэфы: П1 = 1.17, П2 = 5.10',
    'Фора по сетам: П1(-1.5) = 1.62, П2(+1.5) = 2.30',
    '',
    'Джокович vs Рублев, Шанхай, хард',
    'Кэфы: П1 = 1.34, П2 = 3.35',
    'Фора по сетам: П1(-1.5) = 2.05, П2(+1.5) = 1.72',
  ].join('\n');
  const TEMPLATE = [
    'Текущий банк: ' + fmt.int(S.bank) + ' ₽',
    'Букмекер: Fonbet',
    '',
    'События:',
    'Игрок 1 vs Игрок 2, турнир, покрытие, раунд',
    'Кэфы: П1 = 1.00, П2 = 1.00',
    'Фора по сетам: П1(-1.5) = 1.00, П2(+1.5) = 1.00',
  ].join('\n');

  // ---------- утилиты ----------
  const num = v => (v == null || v === '' ? NaN : parseFloat(String(v).replace(',', '.').replace(/\s/g, '')));
  const validOdd = v => { const n = num(v); return n >= 1.01 && n <= 50; };
  const inCorridor = v => { const n = num(v); return n >= ST.oddsMin && n <= ST.oddsMax; };
  const norm = s => String(s || '').toLowerCase().replace(/е/g, 'е').replace(/[^a-zа-я\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  const evWord = n => n + ' ' + fmt.plural(n, 'событие', 'события', 'событий');
  const usd = n => '≈' + fmt.usd(n);
  function fmtTime(secs) {
    if (secs < 60) return '~' + Math.max(5, Math.round(secs / 5) * 5) + ' с';
    const m = Math.round(secs / 6) / 10;
    return '~' + (Number.isInteger(m) ? m : fmt.dec(m, 1)) + ' мин';
  }
  function margin(a, b) { const x = num(a), y = num(b); if (!(x >= 1.01 && y >= 1.01)) return null; return 1 / x + 1 / y - 1; }
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  let seq = 0;
  const uid = () => 'nev' + (++seq);

  // Сопоставление имени с базой: полное имя → фамилия → латиница → часть имени → опечатка
  function matchPlayer(text) {
    const t = norm(text); if (t.length < 2) return null;
    let best = null;
    for (const p of D.players) {
      const full = norm(p.name), short = norm(p.short), last = full.split(' ').slice(1).join(' ');
      let conf = 0;
      if (t === full) conf = 1;
      else if (t === short || t === last) conf = 0.99;
      else if (t.replace(/[\s-]/g, '') === p.id) conf = 0.97;
      else if (t.length >= 4 && (full.includes(t) || t.includes(short))) conf = 0.95;
      else { const d = Math.min(lev(t, short), lev(t, full)); if (d === 1) conf = 0.86; else if (d === 2 && short.length >= 5) conf = 0.74; }
      if (conf > (best ? best.conf : 0)) best = { p, conf };
    }
    return best;
  }

  // ---------- состояние (черновик) ----------
  const state = {
    tab: 'text', text: EXAMPLE, parsedText: null, parsing: false, parse: null,
    bank: S.bank, bookmaker: 'Fonbet', events: [], editing: new Set(), mode: 'precise',
    collecting: new Set(), collected: new Set(),
  };
  const freshOf = p => (state.collecting.has(p.id) ? 'collecting' : state.collected.has(p.id) ? 'fresh' : p.fresh);
  function resolve(name) {
    const n = String(name || '').trim(); if (!n) return null;
    const m = matchPlayer(n);
    if (m && m.conf >= 0.7) return { name: n, p: m.p, conf: m.conf, sure: m.conf >= 0.9, fresh: freshOf(m.p) };
    return { name: n, p: null, conf: 0, sure: false, fresh: 'missing' };
  }
  const shortOf = (n, fallback) => { const r = resolve(n); return r ? (r.p && r.sure ? r.p.short : r.name) : fallback; };
  const titleOf = ev => shortOf(ev.n1, 'Игрок 1') + ' — ' + shortOf(ev.n2, 'Игрок 2');
  const isDirty = () => state.parsedText !== state.text;

  function blankEvent() {
    return { id: uid(), raw1: '', raw2: '', conf1: null, conf2: null, n1: '', n2: '', tournament: 'Шанхай', category: 'Masters 1000', surface: 'hard', round: '', time: '', court: '', odds: {}, todayId: null, blank: true };
  }
  function attachToday(ev) {
    const a = resolve(ev.n1), b = resolve(ev.n2);
    const m = a && b && a.sure && b.sure ? D.matchesToday.find(t => (t.p1 === a.p.id && t.p2 === b.p.id) || (t.p1 === b.p.id && t.p2 === a.p.id)) : null;
    ev.todayId = m ? m.id : null;
    if (m) { ev.time = m.time; ev.court = m.court; if (!ev.round) ev.round = m.round; if (!ev.tournament) ev.tournament = m.tournament; if (!ev.category) ev.category = m.category; }
    return m;
  }
  function setTournament(ev, name) {
    ev.tournament = name;
    const t = name ? D.calendar.find(c => norm(c.name).includes(norm(name))) : null;
    ev.category = t ? t.cat : '';
    return t;
  }
  function eventFromToday(m) {
    const ev = Object.assign(blankEvent(), { n1: P[m.p1].name, n2: P[m.p2].name, conf1: 1, conf2: 1, tournament: m.tournament, category: m.category, surface: m.surface, round: m.round, blank: false });
    ev.odds = { p1: fmt.odds(m.odds.p1), p2: fmt.odds(m.odds.p2), h1m: fmt.odds(m.odds.h1m), h2p: fmt.odds(m.odds.h2p) };
    attachToday(ev);
    return ev;
  }

  // ---------- разбор текста (в продукте — Claude Haiku со строгой JSON-схемой) ----------
  function oddsInto(str, odds) {
    const re = /([ПФ])\s*([12])\s*(?:\(\s*([+\-−–])\s*1[.,]5\s*\))?\s*[=:]\s*(\d+(?:[.,]\d+)?)/gi;
    let m, found = 0;
    while ((m = re.exec(str))) {
      const key = m[3] ? 'h' + m[2] + (m[3] === '+' ? 'p' : 'm') : 'p' + m[2];
      odds[key] = m[4].replace(',', '.'); found++;
    }
    return found;
  }
  function roundOf(s) {
    let m;
    if ((m = s.match(/1\s*\/\s*(64|32|16|8|4|2)/))) return '1/' + m[1] + ' финала';
    if (/четвертьфинал/i.test(s)) return '1/4 финала';
    if (/полуфинал/i.test(s)) return '1/2 финала';
    if (/^финал$/i.test(s.trim())) return 'Финал';
    return '';
  }
  function parseText(text) {
    const res = { bank: null, bookmaker: null, events: [], unknown: [] };
    let cur = null;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim(); if (!line) return;
      let m;
      if ((m = line.match(/^(?:текущий\s+)?банк\s*[:=-]?\s*([\d\s .,]+)/i))) { const v = parseInt(m[1].replace(/[^\d]/g, ''), 10); if (v) res.bank = v; return; }
      if ((m = line.match(/^(?:букмекер|бк|контора)\s*[:=-]\s*(.+)$/i))) { res.bookmaker = m[1].trim(); return; }
      if (/^события\s*:?\s*$/i.test(line)) return;
      if (/^(кэфы?|коэффициенты|исходы?|фора[^:]*)\s*:/i.test(line)) {
        if (cur && oddsInto(line.slice(line.indexOf(':') + 1), cur.odds)) return;
        res.unknown.push({ n: i + 1, text: line }); return;
      }
      if ((m = line.match(/^(.+?)\s+(?:vs\.?|против|—|–|-)\s+(.+)$/i))) {
        const parts = m[2].split(',').map(s => s.trim()).filter(Boolean);
        const ev = blankEvent();
        ev.blank = false; ev.tournament = ''; ev.category = ''; ev.surface = null;
        ev.raw1 = m[1].trim(); ev.raw2 = parts.shift() || '';
        parts.forEach(pt => {
          const s = SURF_WORDS.find(([re]) => re.test(pt));
          if (s && !ev.surface) { ev.surface = s[1]; return; }
          const r = roundOf(pt); if (r && !ev.round) { ev.round = r; return; }
          if (!ev.tournament) ev.tournament = pt;
        });
        [1, 2].forEach(k => { const mm = matchPlayer(ev['raw' + k]); ev['conf' + k] = mm ? mm.conf : 0; ev['n' + k] = mm && mm.conf >= 0.9 ? mm.p.name : ev['raw' + k]; });
        const t = setTournament(ev, ev.tournament);
        if (!ev.surface) ev.surface = t ? t.surface : 'hard';
        attachToday(ev);
        cur = ev; res.events.push(ev); return;
      }
      res.unknown.push({ n: i + 1, text: line });
    });
    return res;
  }
  function applyParse(res) {
    state.events = res.events; state.editing.clear();
    if (res.bank) state.bank = res.bank;
    if (res.bookmaker) state.bookmaker = res.bookmaker;
    state.parse = { bank: res.bank, bookmaker: res.bookmaker, unknown: res.unknown };
    state.parsedText = state.text;
  }
  applyParse(parseText(EXAMPLE)); // открываемся в рабочем состоянии: пример уже разобран

  function check(ev) {
    const errors = [], bad = new Set();
    const r1 = resolve(ev.n1), r2 = resolve(ev.n2);
    if (!r1 || !r2) errors.push('Укажите обоих игроков');
    else if (r1.p && r2.p && r1.p === r2.p) errors.push('Игрок 1 и игрок 2 совпадают');
    MK.forEach(mk => { const v = ev.odds[mk.key]; if (v != null && v !== '' && !validOdd(v)) bad.add(mk.key); });
    if (bad.size) errors.push('Кэф ' + [...bad].map(k => MK.find(m => m.key === k).label).join(', ') + ' — допустимо от 1.01 до 50');
    if (!ev.odds.p1 || !ev.odds.p2) errors.push('Нужны кэфы П1 и П2');
    return { errors, bad };
  }

  // ---------- сводка «Перед запуском» ----------
  function summary() {
    const evs = state.events, n = evs.length;
    const players = [];
    evs.forEach(ev => [ev.n1, ev.n2].forEach(name => {
      const r = resolve(name); if (!r) return;
      const key = r.p ? r.p.id : norm(r.name);
      if (!players.some(x => x.key === key)) players.push(Object.assign({ key }, r));
    }));
    const missing = players.filter(p => !p.p || (p.sure && p.fresh === 'missing'));
    const stale = players.filter(p => p.p && p.sure && p.fresh === 'stale');
    const mode = MODES.find(m => m.id === state.mode);
    const items = [{ label: 'Анализ · ' + mode.model.replace(' + кэш', '') + ' · ' + evWord(n), cost: n * mode.perEvent }];
    if (missing.length) items.push({ label: 'Сбор профиля: ' + missing.map(p => p.p ? p.p.short : p.name).join(', '), cost: missing.length * COLLECT.cost });
    if (stale.length) items.push({ label: 'Обновление: ' + stale.map(p => p.p.short).join(', '), cost: stale.length * REFRESH.cost });
    const extraCost = missing.length * COLLECT.cost + stale.length * REFRESH.cost;
    const extraSecs = missing.length * COLLECT.secs + stale.length * REFRESH.secs;
    const cost = n * mode.perEvent + extraCost, secs = n * mode.secs + extraSecs;

    let reason = null;
    if (state.tab === 'text' && state.parsing) reason = 'Дождитесь окончания разбора';
    else if (state.tab === 'text' && !state.text.trim()) reason = 'Вставьте текст с событиями';
    else if (state.tab === 'text' && isDirty()) reason = 'Текст изменен — нажмите «Разобрать»';
    else if (!n) reason = 'Добавьте хотя бы одно событие';
    else {
      const i = evs.findIndex(ev => check(ev).errors.length);
      if (i >= 0) { const e = check(evs[i]).errors[0]; reason = 'Событие ' + (i + 1) + ': ' + e.charAt(0).toLowerCase() + e.slice(1); }
      else { const u = players.find(p => p.p && !p.sure); if (u) reason = 'Подтвердите игрока «' + u.name + '»'; }
    }
    return { evs, n, players, missing, stale, mode, items, cost, secs, extraCost, extraSecs, reason };
  }

  // ---------- стили ----------
  UI.css('new', `
    .new-root { display: flex; flex-direction: column; gap: 20px; min-width: 0; }
    .new-head h2 { font-size: var(--fs-2xl); }
    .new-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 22px; }
    .new-step { position: relative; display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px 4px 4px; border-radius: 999px; border: 1px solid var(--line); background: var(--surface); font-size: var(--fs-sm); color: var(--fg-3); white-space: nowrap; }
    .new-step + .new-step::before { content: ""; position: absolute; left: -18px; top: 50%; width: 14px; height: 1px; background: var(--line-strong); }
    .new-step-n { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); font-weight: 600; font-size: var(--fs-xs); flex: none; }
    .new-step-n svg { width: 14px; height: 14px; }
    .new-step.done { color: var(--fg-2); }
    .new-step.done .new-step-n { background: var(--accent-soft); color: var(--accent-ink); }
    .new-step.current { color: var(--fg); border-color: var(--accent); font-weight: 600; }
    .new-step.current .new-step-n { background: var(--accent); color: var(--accent-fg); }
    .new-step-short { display: none; }

    .new-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 380px); gap: 16px; align-items: start; }
    .new-main, .new-side { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1100px) { .new-layout { grid-template-columns: minmax(0, 1fr); } }

    .tabs.new-tabs { padding: 0 18px; }
    .tabs.new-tabs button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 14px 10px; font-size: var(--fs-md); }
    .tabs.new-tabs button svg { width: 17px; height: 17px; flex: none; }
    .new-panel { padding: 18px; display: flex; flex-direction: column; gap: 16px; min-width: 0; }

    .new-tools { display: flex; align-items: center; justify-content: space-between; gap: 4px 8px; flex-wrap: wrap; }
    .new-tools .field-label { font-size: var(--fs-md); color: var(--fg); font-weight: 600; }
    .new-tools .row { gap: 2px; }
    .new-textarea { font-family: var(--font-mono); font-size: var(--fs-sm); line-height: 1.65; min-height: 270px; }
    .new-ta-actions { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .new-ta-status { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; min-width: 0; flex: 1 1 240px; }
    .new-kbd { font-family: var(--font-mono); font-size: 11px; padding: 1px 5px; border: 1px solid var(--line-strong); border-radius: 4px; color: var(--fg-2); background: var(--surface-2); }

    .new-drop { position: relative; display: flex; align-items: center; gap: 12px; padding: 12px 14px; border: 1.5px dashed var(--line-strong); border-radius: var(--r-md); background: var(--surface); cursor: pointer; min-width: 0; transition: border-color .15s, background .15s; }
    .new-drop:hover, .new-drop.drag { border-color: var(--accent); background: var(--accent-soft); }
    .new-drop:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
    .new-drop input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
    .new-drop-ic { width: 40px; height: 40px; border-radius: 10px; display: grid; place-items: center; flex: none; background: var(--surface-2); color: var(--fg-2); }
    .new-drop-ic svg { width: 20px; height: 20px; }
    .new-drop-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .new-drop-title { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-weight: 600; }

    .new-result { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding-top: 16px; border-top: 1px solid var(--line); }
    .new-result-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
    .new-result-head h3 { font-size: var(--fs-lg); }
    .new-result-head .row { margin-top: 6px; gap: 6px; }
    .new-list { display: flex; flex-direction: column; gap: 12px; min-width: 0; container-type: inline-size; }
    .new-skel { height: 150px; border-radius: var(--r-md); background: linear-gradient(90deg, var(--surface-2) 0%, var(--surface-3) 50%, var(--surface-2) 100%); background-size: 200% 100%; animation: new-shimmer 1.1s linear infinite; }
    .new-skel.short { height: 96px; }
    @keyframes new-shimmer { to { background-position: -200% 0; } }
    .new-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line-strong); border-top-color: var(--accent); animation: new-rot .8s linear infinite; flex: none; }
    @keyframes new-rot { to { transform: rotate(360deg); } }

    .new-ev { border: 1px solid var(--line); border-radius: var(--r-md); padding: 14px; display: flex; flex-direction: column; gap: 12px; min-width: 0; background: var(--surface); }
    .new-ev.editing { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent); }
    .new-ev-head { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; grid-template-areas: "num title actions" ". meta meta"; align-items: start; gap: 6px 10px; min-width: 0; }
    .new-ev-num { grid-area: num; }
    .new-ev-title { grid-area: title; align-self: center; }
    .new-ev-meta { grid-area: meta; }
    .new-ev-actions { grid-area: actions; }
    .new-ev-num { width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; flex: none; background: var(--surface-2); color: var(--fg-2); font-weight: 600; font-family: var(--font-display); font-size: var(--fs-sm); }
    .new-ev.editing .new-ev-num { background: var(--accent); color: var(--accent-fg); }
        .new-ev-title { font-size: var(--fs-lg); line-height: 1.3; overflow-wrap: anywhere; }
    .new-ev-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: var(--fs-sm); color: var(--fg-2); min-width: 0; }
    .new-ev-actions { display: flex; gap: 2px; flex: none; }
    @container (max-width: 460px) { .new-ev-actions .btn:not(.icon-only):not(.primary) { width: 32px; padding: 0; } .new-ev-actions .btn:not(.icon-only):not(.primary) span { display: none; } }

    .new-ev-players { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
    .new-pl { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; border-radius: var(--r-sm); background: var(--surface-2); min-width: 0; }
    .new-pl-src { font-size: var(--fs-xs); color: var(--fg-3); overflow-wrap: anywhere; }
    .new-pl-name { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; min-width: 0; font-weight: 600; }
    .new-pl-name a { color: var(--fg); text-decoration: none; }
    .new-pl-name a:hover { color: var(--accent-ink); text-decoration: underline; }
    .new-pl-sub { font-size: var(--fs-xs); color: var(--fg-3); font-weight: 400; }
    .new-pl .row { gap: 4px; margin-top: 2px; }
    .new-pl .chip.outline, .new-pl .chip:not([class*=" good"]):not([class*=" warn"]):not([class*=" bad"]):not([class*=" info"]) { background: var(--surface); }

    .new-odds { display: grid; grid-template-columns: repeat(var(--n, 4), minmax(0, 1fr)); gap: 8px; }
    @container (max-width: 560px) { .new-odds.many { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
    @container (max-width: 400px) { .new-odds.four { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .new-odd { position: relative; display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 6px 8px 4px; border-radius: var(--r-sm); background: var(--surface-2); border: 1px solid transparent; cursor: text; min-width: 0; transition: border-color .15s, background .15s; }
    .new-odd small { display: inline-flex; align-items: center; gap: 3px; font-size: 10px; color: var(--fg-3); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; white-space: nowrap; }
    .new-odd-tick { display: none; color: var(--accent-ink); }
    .new-odd-tick svg { width: 11px; height: 11px; stroke-width: 2.6; }
    .new-odd.in { box-shadow: inset 0 -2px 0 var(--accent); }
    .new-odd.in .new-odd-tick { display: inline-flex; }
    .new-odd input { width: 100%; min-width: 0; border: 0; background: transparent; text-align: center; font-family: var(--font-mono); font-weight: 500; font-size: var(--fs-lg); padding: 1px 0; color: var(--fg); font-variant-numeric: tabular-nums; }
    .new-odd input:focus { outline: none; }
    .new-odd input::placeholder { color: var(--fg-3); }
    .new-odd:hover { border-color: var(--line-strong); }
    .new-odd:focus-within { border-color: var(--focus); background: var(--surface); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 22%, transparent); }
    .new-odd.invalid { border-color: var(--bad); background: var(--bad-soft); }
    .new-odd.invalid input, .new-odd.invalid small { color: var(--bad-ink); }

    .new-ev-foot { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .new-foot-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; font-size: var(--fs-sm); color: var(--fg-2); }
    .new-novig b { font-weight: 600; color: var(--fg); font-variant-numeric: tabular-nums; white-space: nowrap; }
    .new-corr { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-xs); color: var(--fg-2); }
    .new-corr svg { width: 14px; height: 14px; flex: none; margin-top: 1px; color: var(--accent-ink); }
    .new-corr.out svg { color: var(--warn-ink); }
    .new-ev-msg:empty, .new-ev-warn:empty { display: none; }
    .new-ev-warn { display: flex; flex-direction: column; gap: 8px; }
    .new-callout-actions { margin-top: 8px; gap: 6px; }
    .callout .new-callout-actions .btn.ghost { color: inherit; }

    .new-edit-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .new-edit-grid .full { grid-column: 1 / -1; }
    .new-pstat { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; font-size: var(--fs-xs); color: var(--fg-3); min-height: 24px; }
    .new-pstat button.chip { cursor: pointer; border: 1px solid var(--warn); }
    .segmented.new-surface { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); width: 100%; }
    .segmented.new-surface button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px 6px; min-width: 0; }
    .new-sdot { width: 9px; height: 9px; border-radius: 2px; flex: none; display: inline-block; }
    .new-odds-hint { font-size: var(--fs-xs); color: var(--fg-3); }
    .new-edit-foot { display: flex; gap: 8px; flex-wrap: wrap; padding-top: 12px; border-top: 1px solid var(--line); }
    @container (max-width: 460px) { .new-edit-foot .btn { flex: 1 1 0; } }
    @container (max-width: 520px) {
      .new-edit-grid, .new-ev-players { grid-template-columns: minmax(0, 1fr); }
      .segmented.new-surface { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }

    .new-form-top { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .new-today { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; scroll-margin-top: calc(var(--topbar-h) + 16px); }
    .new-today-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .new-today-head > div { min-width: 0; }
    .new-today-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 8px; }
    .new-today-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; padding: 10px 12px; border-radius: var(--r-md); border: 1px solid var(--line); background: var(--surface); color: var(--fg); text-align: left; cursor: pointer; min-width: 0; }
    .new-today-btn:hover { border-color: var(--line-strong); }
    .new-today-btn[aria-pressed="true"] { border-color: var(--accent); background: var(--accent-soft); }
    .new-today-top { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; width: 100%; gap: 2px 6px; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .new-today-top .mono { color: var(--fg-2); font-weight: 500; }
    .new-today-state { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
    .new-today-state svg { width: 12px; height: 12px; }
    .new-today-btn[aria-pressed="true"] .new-today-state { color: var(--accent-ink); font-weight: 600; }
    .new-today-name { font-weight: 600; line-height: 1.3; }
    .new-today-odds { display: flex; flex-wrap: wrap; gap: 0 10px; font-size: var(--fs-xs); color: var(--fg-3); }
    .new-today-odds span { white-space: nowrap; }
    .new-add.btn { border-style: dashed; height: 46px; }

    .new-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .new-strip > div { background: var(--surface); padding: 8px 12px; min-width: 0; }
    .new-strip dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .new-strip dd { margin: 0; font-family: var(--font-display); font-weight: 600; font-size: var(--fs-xl); font-variant-numeric: tabular-nums; }
    .new-sub { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .new-plist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .new-plist li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 0; border-top: 1px solid var(--line); min-width: 0; }
    .new-plist li:first-child { border-top: 0; padding-top: 0; }
    .new-plist-name { display: flex; flex-direction: column; min-width: 0; }
    .new-plist-name > :first-child { font-weight: 600; color: var(--fg); text-decoration: none; }
    .new-plist-name a:hover { color: var(--accent-ink); text-decoration: underline; }
    .new-plist-sub { font-size: var(--fs-xs); color: var(--fg-3); }
    .new-modes { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .new-modes legend { padding: 0; margin-bottom: 8px; }
    .new-mode { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); cursor: pointer; background: var(--surface); }
    .new-mode:hover { border-color: var(--line-strong); }
    .new-mode.on { border-color: var(--accent); background: var(--accent-soft); }
    .new-mode:focus-within { outline: 2px solid var(--focus); outline-offset: 2px; }
    .new-mode input { width: 18px; height: 18px; margin: 2px 0 0; accent-color: var(--accent); }
    .new-mode input:focus-visible { outline: none; }
    .new-mode-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .new-mode-title { font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 6px; }
    .new-mode-model { font-size: var(--fs-xs); color: var(--fg-3); font-weight: 500; }
    .new-mode-title .chip { font-weight: 500; }
    .new-mode.on .new-mode-model { color: var(--accent-ink); }
    .new-mode-note { font-size: var(--fs-xs); color: var(--fg-2); }
    .new-mode-cost { display: flex; flex-direction: column; align-items: flex-end; text-align: right; white-space: nowrap; }
    .new-mode-cost b { font-variant-numeric: tabular-nums; font-weight: 600; }
    .new-mode-cost small { font-size: var(--fs-xs); color: var(--fg-3); }
    .new-costs { display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: var(--r-md); background: var(--surface-2); }
    .new-costs .kv dd { white-space: nowrap; }
    .new-total { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; padding-top: 8px; border-top: 1px solid var(--line-strong); font-weight: 600; flex-wrap: wrap; }
    .new-total b { font-family: var(--font-display); font-size: var(--fs-xl); font-variant-numeric: tabular-nums; }
    .new-total .muted { font-weight: 500; }
    .new-reason { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-sm); color: var(--warn-ink); font-weight: 500; }
    .new-reason svg { width: 16px; height: 16px; flex: none; margin-top: 2px; }
    .new-link { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 500; }
    .new-link svg { width: 14px; height: 14px; flex: none; }

    .new-flow { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .new-flow li { position: relative; display: grid; grid-template-columns: 30px minmax(0, 1fr); gap: 12px; padding-bottom: 14px; }
    .new-flow li:last-child { padding-bottom: 0; }
    .new-flow li::before { content: ""; position: absolute; left: 14.5px; top: 32px; bottom: 2px; width: 1px; background: var(--line-strong); }
    .new-flow li:last-child::before { display: none; }
    .new-flow-ic { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .new-flow-ic svg { width: 16px; height: 16px; }
    .new-flow-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .new-flow-ic.accent { background: var(--accent-soft); color: var(--accent-ink); }
    .new-flow-body { min-width: 0; padding-top: 4px; }
    .new-flow-body b { display: block; font-weight: 600; line-height: 1.3; }
    .new-flow-body span { display: block; font-size: var(--fs-sm); color: var(--fg-2); margin-top: 2px; }
    .new-rules .kv dd { font-family: var(--font-mono); font-weight: 500; }

    .new-bar, .new-bar-spacer { display: none; }
    @media (max-width: 960px) {
      .new-root { gap: 16px; }
      .new-bar { display: flex; align-items: center; gap: 12px; position: fixed; z-index: 25; left: 12px; right: 12px; bottom: calc(var(--new-tabbar, var(--tabbar-h)) + 10px); padding: 10px 10px 10px 14px; background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--r-lg); box-shadow: var(--shadow); transition: transform .2s ease, opacity .2s ease, visibility .2s; }
      .new-bar.off { transform: translateY(12px); opacity: 0; visibility: hidden; pointer-events: none; }
      .new-bar-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; line-height: 1.3; }
      .new-bar-text b { font-size: var(--fs-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .new-bar-sub { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .new-bar-sub.warn { color: var(--warn-ink); font-weight: 500; }
      .new-bar .btn { flex: none; height: 44px; }
      .new-bar-spacer { display: block; height: 64px; }
      .new-root .input, .new-root .select, .new-root .textarea, .new-odd input { font-size: 16px; }
      .new-root .input, .new-root .select { height: 46px; }
    }
    @media (max-width: 720px) {
      .tabs.new-tabs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); padding: 0 6px; }
      .new-panel { padding: 14px; }
      .new-ta-actions .btn { width: 100%; height: 48px; }
      .new-form-top { grid-template-columns: minmax(0, 1fr); }
      .new-head .lead { font-size: var(--fs-sm); }
    }
    @media (max-width: 480px) {
      .tabs.new-tabs button svg { display: none; }
      .tabs.new-tabs button { font-size: var(--fs-sm); padding: 13px 6px; }
      .new-step-full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
      .new-step-short { display: inline; }
      .new-step { padding-right: 10px; gap: 6px; }
      .new-steps { gap: 6px 18px; }
      .new-step + .new-step::before { left: -15px; width: 12px; }
    }
  `);

  // ---------- ссылки на живые узлы текущей отрисовки ----------
  let refs = {};
  const slots = new Map(); // ev.id → узлы, которые обновляются без перерисовки (чтобы не терять фокус при вводе)
  let io = null;

  function keepFocus(container, fn) {
    const ae = document.activeElement;
    const key = ae && container.contains(ae) && ae.dataset ? ae.dataset.fk : null;
    let sel = null;
    try { if (key && typeof ae.selectionStart === 'number') sel = [ae.selectionStart, ae.selectionEnd]; } catch (e) { /* не текстовое поле */ }
    fn();
    if (!key) return;
    const el = container.querySelector('[data-fk="' + key + '"]');
    if (el) { el.focus({ preventScroll: true }); if (sel) try { el.setSelectionRange(sel[0], sel[1]); } catch (e) { /* ок */ } }
  }
  const focusLater = sel => requestAnimationFrame(() => { const el = document.querySelector(sel); if (el) el.focus(); });

  // ---------- действия ----------
  function doParse() {
    if (state.parsing) return;
    if (!state.text.trim()) { UI.toast('Вставьте текст с событиями или нажмите «Пример»', 'info'); focusLater('#new-text'); return; }
    state.parsing = true;
    renderPanel(); renderSide();
    setTimeout(() => {
      const res = parseText(state.text);
      state.parsing = false;
      applyParse(res);
      renderPanel(); renderSide();
      const n = res.events.length;
      UI.toast(n ? 'Разобрано: ' + evWord(n) + (res.unknown.length ? ', ' + res.unknown.length + ' ' + fmt.plural(res.unknown.length, 'строку', 'строки', 'строк') + ' не понял' : '') : 'Не нашел событий — проверьте формат', n ? 'check' : 'alert');
    }, 650);
  }
  function removeEvent(ev) {
    const t = titleOf(ev);
    state.events = state.events.filter(e => e !== ev); state.editing.delete(ev.id);
    renderPanel(); renderSide();
    UI.toast('Событие «' + t + '» убрано', 'trash');
  }
  const snapshots = new Map(); // ev.id → копия события до «Исправить», чтобы можно было отменить
  function startEdit(ev) { snapshots.set(ev.id, JSON.stringify(ev)); state.editing.add(ev.id); renderPanel(); focusLater('#' + ev.id + '-n1'); }
  function cancelEdit(ev) {
    const snap = snapshots.get(ev.id); snapshots.delete(ev.id); state.editing.delete(ev.id);
    if (!snap || JSON.parse(snap).blank) state.events = state.events.filter(e => e !== ev);
    else Object.assign(ev, JSON.parse(snap));
    renderPanel(); renderSide();
    UI.toast('Изменения отменены', 'refresh');
  }
  function finishEdit(ev) {
    attachToday(ev); state.editing.delete(ev.id); snapshots.delete(ev.id); ev.blank = false;
    renderPanel(); renderSide();
    focusLater('[data-fk="fix-' + ev.id + '"]');
  }
  function confirmPlayer(ev, k, p) {
    ev['n' + k] = p.name; ev['conf' + k] = 1; ev['man' + k] = true;
    attachToday(ev); renderPanel(); renderSide();
    UI.toast('Записал: «' + (ev['raw' + k] || p.short) + '» — это ' + p.name, 'check');
  }
  function collectNow(p) {
    if (state.collecting.has(p.id) || state.collected.has(p.id)) return;
    state.collecting.add(p.id); refreshAll();
    UI.toast('Собираем профиль ' + p.short + ': статистика, форма, личные встречи…', 'database');
    setTimeout(() => {
      state.collecting.delete(p.id); state.collected.add(p.id); refreshAll();
      UI.toast('Профиль ' + p.short + ' собран (демо) — потрачено ' + usd(COLLECT.cost), 'check');
    }, 1600);
  }
  function addBlank() {
    const ev = blankEvent();
    state.events.push(ev);
    if (state.tab === 'text') { snapshots.set(ev.id, JSON.stringify(ev)); state.editing.add(ev.id); }
    renderPanel(); renderSide();
    focusLater('#' + ev.id + '-n1');
  }
  function toggleToday(m) {
    const ex = state.events.find(e => e.todayId === m.id);
    if (ex) { state.events = state.events.filter(e => e !== ex); UI.toast('Убрано: ' + P[m.p1].short + ' — ' + P[m.p2].short, 'x'); }
    else { state.events.push(eventFromToday(m)); UI.toast('Добавлено с кэфами из линии: ' + P[m.p1].short + ' — ' + P[m.p2].short, 'check'); }
    renderPanel(); renderSide();
  }
  function onNamesChanged(ev) {
    const before = ev.todayId;
    const m = attachToday(ev);
    if (m && m.id !== before) {
      if (!ev.odds.p1 && !ev.odds.p2) {
        ev.odds = { p1: fmt.odds(m.odds.p1), p2: fmt.odds(m.odds.p2), h1m: fmt.odds(m.odds.h1m), h2p: fmt.odds(m.odds.h2p) };
        UI.toast('Матч есть в расписании на сегодня — подставил кэфы из линии', 'calendar');
      }
      renderPanel(); renderSide(); return;
    }
    if (before && !m) { renderPanel(); renderSide(); return; }
    refreshEvent(ev);
  }
  function launch() {
    const a = summary();
    if (a.reason) { UI.toast(a.reason, 'alert'); return; }
    D.pendingAnalysis = {
      createdAt: D.today, mode: a.mode.id, model: a.mode.model, bank: state.bank, bookmaker: state.bookmaker,
      estimate: { cost: Math.round(a.cost * 100) / 100, secs: a.secs },
      events: state.events.map(ev => {
        const r1 = resolve(ev.n1), r2 = resolve(ev.n2);
        return { p1: r1.p ? r1.p.id : r1.name, p2: r2.p ? r2.p.id : r2.name, tournament: ev.tournament, surface: ev.surface, round: ev.round,
          odds: Object.fromEntries(MK.filter(mk => validOdd(ev.odds[mk.key])).map(mk => [mk.key, num(ev.odds[mk.key])])) };
      }),
    };
    UI.toast('Анализ запущен: ' + evWord(a.n) + ', режим «' + a.mode.label + '»', 'spark');
    UI.go('analysis');
  }

  function formatModal() {
    UI.modal({
      title: 'Формат текста', wide: true,
      body: [
        h('p', { class: 'soft' }, 'Тот же формат, что в Telegram-боте. Порядок важен: сначала строка с игроками, под ней — кэфы этого матча.'),
        h('pre', { class: 'new-pre mono', style: 'margin:0;padding:12px 14px;border-radius:var(--r-md);background:var(--surface-2);font-size:var(--fs-sm);white-space:pre-wrap;overflow-wrap:anywhere' }, TEMPLATE),
        h('ul', { class: 'stack', style: 'gap:8px;margin:0;padding-left:18px;font-size:var(--fs-sm);color:var(--fg-2)' },
          h('li', null, h('b', null, 'Игроки: '), '«Синнер vs Руне», «Синнер — Руне» или «Sinner vs Rune». Достаточно фамилии.'),
          h('li', null, h('b', null, 'После игроков через запятую: '), 'турнир, покрытие и, если знаете, раунд — «Шанхай, хард, 1/8».'),
          h('li', null, h('b', null, 'Кэфы: '), 'П1 и П2 обязательны. Форы по сетам — П1(-1.5), П1(+1.5), П2(-1.5), П2(+1.5).'),
          h('li', null, 'Дробную часть можно писать через точку или запятую: 1.62 или 1,62.'),
          h('li', null, 'Банк и букмекер необязательны — по умолчанию возьмем из кабинета.'),
          h('li', null, 'Строки, которые не удалось понять, покажем отдельно — ничего не пропадет молча.')),
        UI.callout('info', 'info', 'Разбор делает самая дешевая модель (Claude Haiku 4.5, ' + PARSE_COST + ' за текст). Если имя не совпало с базой, вы увидите это до запуска анализа.'),
      ],
      actions: close => [
        button('Вставить шаблон', { kind: 'secondary', icon: 'copy', onClick: () => { close(); state.tab = 'text'; state.text = TEMPLATE; renderPanel(); renderSide(); focusLater('#new-text'); } }),
        button('Понятно', { kind: 'primary', onClick: close }),
      ],
    });
  }

  // ---------- карточки событий ----------
  function newSlots(ev) {
    const s = { title: h('span'), warn: h('div', { class: 'new-ev-warn' }), foot: h('div', { class: 'new-ev-foot' }), msg: h('div', { class: 'new-ev-msg', 'aria-live': 'polite' }), odds: new Map() };
    slots.set(ev.id, s);
    return s;
  }

  function confChip(conf, r) {
    if (!r.p) return chip('Не найден в списке ATP', 'bad', 'x');
    if (conf >= 0.9) return h('span', { class: 'chip good', title: 'Насколько уверенно имя из текста сопоставлено с игроком' }, icon('check'), 'Совпало ' + fmt.prob(Math.min(conf, 1)));
    return chip('Проверьте · ' + fmt.prob(conf), 'warn', 'alert');
  }
  function freshChip(r) {
    if (r.p && !r.sure) return chip('Имя не подтверждено', 'warn', 'alert');
    if (r.fresh === 'collecting') return chip('Собираем профиль…', 'info', 'clock');
    return UI.freshnessChip(r.fresh);
  }
  function updatedText(r) {
    if (!r.p) return 'нет в списке ATP — проверьте имя';
    if (!r.sure) return 'похоже на ' + r.p.name;
    if (state.collected.has(r.p.id)) return 'профиль собран только что';
    if (r.fresh === 'collecting') return 'собираем профиль…';
    if (r.fresh === 'missing') return 'есть в списке ATP, профиля нет';
    const u = r.p.updated;
    const when = u.slice(0, 10) === D.today ? 'сегодня, ' + u.slice(11, 16) : fmt.datetime(u);
    return (r.fresh === 'stale' ? 'обновлено ' + when + ' — освежим' : 'обновлено ' + when);
  }

  function fillPlayer(node, ev, k) {
    clear(node);
    const raw = ev['raw' + k], r = resolve(ev['n' + k]);
    if (!r) { node.append(h('div', { class: 'new-pl-src' }, 'Игрок ' + k), h('div', { class: 'new-pl-name' }, '—')); return; }
    const conf = raw && ev['conf' + k] != null ? ev['conf' + k] : r.conf;
    node.append(
      h('div', { class: 'new-pl-src' }, raw ? 'в тексте: «' + raw + '»' : 'Игрок ' + k),
      h('div', { class: 'new-pl-name' },
        r.p && r.sure ? h('a', { href: '#player-' + r.p.id }, r.p.name) : h('span', null, r.name),
        r.p && h('span', { class: 'new-pl-sub' }, r.sure ? r.p.country + ' · №' + r.p.rank + ' ATP' : 'похоже на ' + r.p.name)),
      h('div', { class: 'row' }, raw && ev['man' + k] ? chip('Подтверждено вами', 'good', 'check') : confChip(conf, r), freshChip(r)));
  }

  function fillStatus(node, ev, k) {
    clear(node);
    const r = resolve(ev['n' + k]);
    if (!r) { node.append(h('span', null, 'Фамилии достаточно — сверим с базой')); return; }
    if (r.p && !r.sure) {
      node.append(h('button', { type: 'button', class: 'chip warn', on: { click: () => confirmPlayer(ev, k, r.p) } }, icon('alert'), 'Это ' + r.p.name + '?'), h('span', null, 'нажмите, чтобы подтвердить'));
      return;
    }
    if (!r.p) { node.append(UI.freshnessChip('missing'), h('span', null, 'соберем профиль по имени, +' + usd(COLLECT.cost))); return; }
    node.append(freshChip(r), h('span', null, '№' + r.p.rank + ' ATP · ' + r.p.country));
  }

  function fillWarn(node, ev) {
    clear(node);
    const seen = new Set();
    [1, 2].forEach(k => {
      const r = resolve(ev['n' + k]); if (!r) return;
      const key = r.p ? r.p.id : r.name; if (seen.has(key)) return; seen.add(key);
      const fix = button('Исправить имя', { kind: 'ghost', size: 'sm', icon: 'edit', onClick: () => startEdit(ev) });
      if (r.p && !r.sure) {
        node.appendChild(UI.callout('warn', 'alert',
          h('div', null, h('b', null, '«' + r.name + '» — это ' + r.p.name + '?'), ' Совпадение с базой ' + fmt.prob(r.conf) + ', без подтверждения анализ не запустим.'),
          h('div', { class: 'row new-callout-actions' }, button('Да, это ' + r.p.short, { kind: 'secondary', size: 'sm', icon: 'check', onClick: () => confirmPlayer(ev, k, r.p) }), state.editing.has(ev.id) ? null : fix)));
      } else if (r.fresh === 'missing') {
        node.appendChild(UI.callout('warn', 'database',
          h('div', null, h('b', null, (r.p ? r.p.short : '«' + r.name + '»') + ' нет в базе'), ' — профиль будет собран перед анализом, +' + usd(COLLECT.cost) + ' и ~' + COLLECT.secs + ' с.'),
          h('div', { class: 'xsmall', style: 'margin-top:2px' }, r.p ? 'Соберем статистику за 52 недели, форму, личные встречи, подачу и прием из открытых источников.' : 'Игрока нет и в списке ATP — проверьте написание, иначе профиль соберем по имени.'),
          h('div', { class: 'row new-callout-actions' }, r.p && button('Собрать сейчас', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => collectNow(r.p) }), state.editing.has(ev.id) ? null : fix)));
      } else if (r.fresh === 'collecting') {
        node.appendChild(UI.callout('info', 'clock', h('b', null, 'Собираем профиль ' + r.p.short + '…'), ' Обычно это занимает до минуты, можно продолжать заполнение.'));
      } else if (r.fresh === 'stale') {
        node.appendChild(UI.callout('', 'clock', h('b', null, r.p.short + ': данные от ' + fmt.date(r.p.updated)), ' — обновим перед анализом, +' + usd(REFRESH.cost) + '.'));
      }
    });
  }

  function fillFoot(node, ev) {
    clear(node);
    const o = ev.odds;
    const m = margin(o.p1, o.p2);
    if (m == null) { node.append(h('div', { class: 'new-corr' }, icon('info'), 'Введите П1 и П2 — посчитаем маржу букмекера и вероятности рынка без маржи.')); return; }
    const mh = margin(o.h1m, o.h2p) != null ? margin(o.h1m, o.h2p) : margin(o.h1p, o.h2m);
    const kind = m < 0 ? 'bad' : m > 0.08 ? 'warn' : 'outline';
    const text = m < 0 ? 'Маржа меньше нуля — проверьте кэфы' : 'Маржа БК ' + fmt.pct(m * 100) + (mh != null && mh >= 0 ? ' · фора ' + fmt.pct(mh * 100) : '');
    const i1 = 1 / num(o.p1), i2 = 1 / num(o.p2), q1 = i1 / (i1 + i2);
    const corr = MK.filter(mk => validOdd(o[mk.key]) && inCorridor(o[mk.key]));
    node.append(
      h('div', { class: 'new-foot-row' },
        h('span', { title: 'Маржа = 1/П1 + 1/П2 − 1' }, chip(text, kind, kind === 'outline' ? 'info' : 'alert')),
        h('span', { class: 'new-novig' }, 'Рынок без маржи: ', h('b', null, shortOf(ev.n1, 'П1') + ' ' + fmt.prob(q1)), ' · ', h('b', null, shortOf(ev.n2, 'П2') + ' ' + fmt.prob(1 - q1)))),
      corr.length
        ? h('div', { class: 'new-corr' }, icon('check'), 'В коридоре стратегии ' + fmt.odds(ST.oddsMin) + '–' + fmt.odds(ST.oddsMax) + ': ' + corr.map(mk => mk.label + ' ' + fmt.odds(num(o[mk.key]))).join(', '))
        : h('div', { class: 'new-corr out' }, icon('alert'), 'Ни один кэф не попадает в коридор ' + fmt.odds(ST.oddsMin) + '–' + fmt.odds(ST.oddsMax) + ' — в экспресс событие, скорее всего, не войдет.'));
  }

  function refreshEvent(ev, side = true) {
    const s = slots.get(ev.id);
    if (s) {
      s.title.textContent = titleOf(ev);
      if (s.pl1) { fillPlayer(s.pl1, ev, 1); fillPlayer(s.pl2, ev, 2); }
      if (s.st1) { fillStatus(s.st1, ev, 1); fillStatus(s.st2, ev, 2); }
      fillWarn(s.warn, ev);
      fillFoot(s.foot, ev);
      const c = check(ev);
      s.odds.forEach((box, key) => { box.classList.toggle('invalid', c.bad.has(key)); box.classList.toggle('in', validOdd(ev.odds[key]) && inCorridor(ev.odds[key])); box.querySelector('input').setAttribute('aria-invalid', String(c.bad.has(key))); });
      clear(s.msg);
      if (c.errors.length && !ev.blank) s.msg.appendChild(h('div', { class: 'field-error' }, c.errors.join('. ') + '.'));
    }
    if (side) renderSide();
  }
  function refreshAll() { state.events.forEach(ev => refreshEvent(ev, false)); renderSide(); }

  function oddsGrid(ev, list) {
    const s = slots.get(ev.id);
    const cls = ['new-odds', list.length > 4 && 'many', list.length === 4 && 'four'];
    return h('div', { class: cls, style: { '--n': String(list.length) }, role: 'group', 'aria-label': 'Кэфы: ' + titleOf(ev) }, list.map(mk => {
      const id = ev.id + '-' + mk.key;
      const inp = h('input', { type: 'text', id, inputmode: 'decimal', autocomplete: 'off', maxlength: '6', placeholder: '—', value: ev.odds[mk.key] || '', 'data-fk': id, 'aria-label': 'Кэф ' + mk.label + (mk.main ? '' : ', необязательно') });
      inp.addEventListener('input', () => { ev.odds[mk.key] = inp.value.trim(); ev.blank = false; refreshEvent(ev); });
      inp.addEventListener('blur', () => { if (validOdd(inp.value)) { inp.value = num(inp.value).toFixed(2); ev.odds[mk.key] = inp.value; } });
      const box = h('label', { class: 'new-odd', for: id, title: mk.main ? null : 'Фора по сетам' },
        h('small', null, mk.label, h('span', { class: 'new-odd-tick', title: 'В коридоре стратегии' }, icon('check'))), inp);
      s.odds.set(mk.key, box);
      return box;
    }));
  }

  function metaNodes(ev) {
    const parts = [ev.tournament || 'турнир не указан', ev.category, ev.round, ev.time && (ev.time + (ev.court ? ', ' + ev.court : ''))].filter(Boolean);
    return [UI.surfaceChip(ev.surface), h('span', { style: 'min-width:0' }, parts.join(' · ')), ev.todayId && chip('Сверено с расписанием', 'accent', 'calendar')];
  }

  function reviewCard(ev, i) {
    const s = newSlots(ev);
    s.pl1 = h('div', { class: 'new-pl' }); s.pl2 = h('div', { class: 'new-pl' });
    const list = MK.filter(mk => mk.main || (ev.odds[mk.key] != null && ev.odds[mk.key] !== ''));
    const el = h('article', { class: 'new-ev', 'aria-labelledby': ev.id + '-t' },
      h('div', { class: 'new-ev-head' },
        h('span', { class: 'new-ev-num', 'aria-hidden': 'true' }, String(i + 1)),
        h('h4', { class: 'new-ev-title', id: ev.id + '-t' }, s.title),
        h('div', { class: 'new-ev-meta' }, metaNodes(ev)),
        h('div', { class: 'new-ev-actions' },
          button('Исправить', { kind: 'ghost', size: 'sm', icon: 'edit', onClick: () => startEdit(ev), attrs: { 'data-fk': 'fix-' + ev.id, 'aria-label': 'Исправить событие ' + (i + 1), title: 'Исправить игроков, турнир, покрытие' } }),
          button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Убрать событие ' + (i + 1), onClick: () => removeEvent(ev) }))),
      h('div', { class: 'new-ev-players' }, s.pl1, s.pl2),
      s.warn,
      oddsGrid(ev, list),
      s.foot, s.msg);
    refreshEvent(ev, false);
    return el;
  }

  function editorBlock(ev, i, inline) {
    const s = newSlots(ev);
    s.st1 = h('div', { class: 'new-pstat', 'aria-live': 'polite' }); s.st2 = h('div', { class: 'new-pstat', 'aria-live': 'polite' });
    const nameField = k => {
      const f = UI.field({ label: 'Игрок ' + k, id: ev.id + '-n' + k, value: ev['n' + k], placeholder: k === 1 ? 'Например, Синнер' : 'Например, Руне', autocomplete: 'off', attrs: { list: 'new-players', spellcheck: 'false', 'data-fk': ev.id + '-n' + k } });
      const inp = f.querySelector('input');
      inp.addEventListener('input', () => { ev['n' + k] = inp.value; ev['raw' + k] = ''; ev['conf' + k] = null; ev.blank = false; refreshEvent(ev); });
      inp.addEventListener('change', () => {
        const m = matchPlayer(inp.value);
        if (m && m.conf >= 0.9 && inp.value !== m.p.name) { inp.value = m.p.name; ev['n' + k] = m.p.name; }
        onNamesChanged(ev);
      });
      f.appendChild(s['st' + k]);
      return f;
    };
    const tour = UI.field({ label: 'Турнир', id: ev.id + '-tour', value: ev.tournament, placeholder: 'Например, Шанхай', autocomplete: 'off', attrs: { list: 'new-tours', 'data-fk': ev.id + '-tour' } });
    tour.querySelector('input').addEventListener('input', e => { setTournament(ev, e.target.value.trim()); refreshEvent(ev); });
    const round = UI.field({ label: 'Раунд', id: ev.id + '-round', value: ev.round, options: [{ value: '', label: 'Не указан' }].concat(ROUNDS), attrs: { 'data-fk': ev.id + '-round' } });
    round.querySelector('select').addEventListener('change', e => { ev.round = e.target.value; refreshEvent(ev); });
    const seg = UI.segmented({ label: 'Покрытие', items: Object.entries(D.surfaces).map(([k, sf]) => ({ id: k, label: [h('i', { class: 'new-sdot', style: { background: sf.color } }), sf.label] })), active: ev.surface, onChange: id => { ev.surface = id; refreshEvent(ev); } });
    seg.classList.add('new-surface');

    const head = h('div', { class: 'new-ev-head' },
      h('span', { class: 'new-ev-num', 'aria-hidden': 'true' }, String(i + 1)),
      h('h4', { class: 'new-ev-title', id: ev.id + '-t' }, s.title),
      h('div', { class: 'new-ev-meta' }, inline ? 'Исправление · изменения применяются сразу' : (ev.todayId ? [chip('Из расписания на сегодня', 'accent', 'calendar'), h('span', null, ev.time + ', ' + ev.court)] : 'Заполните игроков и кэфы')),
      h('div', { class: 'new-ev-actions' },
        button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Убрать событие ' + (i + 1), onClick: () => removeEvent(ev) })));

    const el = h('article', { class: ['new-ev', inline && 'editing'], 'aria-labelledby': ev.id + '-t' },
      head,
      h('div', { class: 'new-edit-grid' }, nameField(1), nameField(2), tour, round,
        h('div', { class: 'field full' }, h('span', { class: 'field-label' }, 'Покрытие'), seg)),
      s.warn,
      h('div', { class: 'field' }, h('span', { class: 'field-label' }, h('span', null, 'Кэфы'), h('span', { class: 'new-odds-hint' }, 'П1 и П2 обязательны, форы — если есть в линии')), oddsGrid(ev, MK)),
      s.foot, s.msg,
      inline && h('div', { class: 'new-edit-foot' },
        button('Готово', { kind: 'primary', icon: 'check', onClick: () => finishEdit(ev), attrs: { 'data-fk': 'done-' + ev.id } }),
        button('Отменить', { kind: 'ghost', onClick: () => cancelEdit(ev) })));
    refreshEvent(ev, false);
    return el;
  }

  // ---------- вкладка «Вставить текстом» ----------
  function dropzone() {
    const input = h('input', { type: 'file', id: 'new-shot', accept: 'image/png,image/jpeg,image/webp', 'aria-describedby': 'new-shot-hint' });
    const toastShot = name => UI.toast('«' + name + '» получен. Распознавание купона через Claude vision в разработке — пока вставьте текст', 'image');
    const z = h('label', { class: 'new-drop', for: 'new-shot' }, input,
      h('span', { class: 'new-drop-ic' }, icon('image')),
      h('span', { class: 'new-drop-text' },
        h('span', { class: 'new-drop-title' }, 'Загрузить скриншот купона', chip('в разработке', 'warn', 'flask')),
        h('span', { class: 'xsmall muted', id: 'new-shot-hint' }, 'PNG или JPG из приложения букмекера. Распознавать будет Claude по изображению, пока надежнее вставить текст.')));
    input.addEventListener('change', () => { const f = input.files && input.files[0]; if (f) toastShot(f.name); input.value = ''; });
    z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('drag'); });
    z.addEventListener('dragleave', () => z.classList.remove('drag'));
    z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('drag'); const f = e.dataTransfer && e.dataTransfer.files[0]; toastShot(f ? f.name : 'скриншот'); });
    return z;
  }

  function resultSection() {
    const wrap = h('section', { class: 'new-result', 'aria-label': 'Что распознано', 'aria-busy': String(state.parsing) });
    if (state.parsing) {
      wrap.append(
        h('div', { class: 'row', role: 'status' }, h('span', { class: 'new-spin', 'aria-hidden': 'true' }), h('span', { class: 'soft' }, 'Claude Haiku разбирает текст и сверяет игроков с базой…')),
        h('div', { class: 'new-skel' }), h('div', { class: 'new-skel short' }));
      return wrap;
    }
    if (!state.parse) { wrap.appendChild(UI.empty('Нажмите «Разобрать» — здесь появятся события, игроки и кэфы.')); return wrap; }
    const n = state.events.length, pr = state.parse;
    const bankDiff = pr.bank && pr.bank !== S.bank;
    wrap.appendChild(h('div', { class: 'new-result-head' },
      h('div', { style: 'min-width:0' },
        h('h3', null, 'Что распознано'),
        h('div', { class: 'row' },
          chip(evWord(n), n ? 'accent' : 'bad', n ? 'check' : 'alert'),
          chip('Банк ' + fmt.money(state.bank), bankDiff ? 'warn' : 'outline', bankDiff ? 'alert' : 'wallet'),
          chip(state.bookmaker, 'outline'))),
      h('span', { class: 'xsmall muted', style: 'padding-top:4px' }, 'Haiku 4.5 · ' + PARSE_COST)));
    if (bankDiff) wrap.appendChild(UI.callout('warn', 'wallet', 'Банк в тексте (' + fmt.money(pr.bank) + ') отличается от учета ставок (' + fmt.money(S.bank) + '). Сумму ставки посчитаем от банка из текста.'));
    if (pr.unknown.length) {
      wrap.appendChild(UI.callout('bad', 'alert',
        h('div', null, h('b', null, 'Не понял ' + pr.unknown.length + ' ' + fmt.plural(pr.unknown.length, 'строку', 'строки', 'строк') + ':')),
        h('ul', { style: 'margin:4px 0 0;padding-left:18px' }, pr.unknown.slice(0, 4).map(u => h('li', null, 'строка ' + u.n + ': «' + u.text + '»'))),
        h('div', { class: 'row new-callout-actions' }, button('Формат текста', { kind: 'ghost', size: 'sm', icon: 'book', onClick: formatModal }))));
    }
    if (!n) {
      wrap.appendChild(UI.callout('', 'info', 'Ни одного события. Строка с игроками должна выглядеть так: «Синнер vs Руне, Шанхай, хард».'));
    } else {
      wrap.appendChild(h('div', { class: 'new-list' }, state.events.map((ev, i) => state.editing.has(ev.id) ? editorBlock(ev, i, true) : reviewCard(ev, i))));
    }
    wrap.appendChild(h('div', null, button('Добавить событие вручную', { kind: 'ghost', icon: 'plus', onClick: addBlank, attrs: { 'data-fk': 'add-manual' } })));
    return wrap;
  }

  function textPanel() {
    const ta = h('textarea', { class: 'textarea new-textarea', id: 'new-text', rows: 12, spellcheck: 'false', 'data-fk': 'text', 'aria-describedby': 'new-text-hint', placeholder: 'Синнер vs Руне, Шанхай, хард\nКэфы: П1 = 1.17, П2 = 5.10' });
    ta.value = state.text;
    const status = h('div', { 'aria-live': 'polite' });
    const btnLabel = h('span');
    const parseBtn = h('button', { type: 'button', class: 'btn primary', 'data-fk': 'parse', on: { click: doParse } }, icon('spark'), btnLabel);
    const sync = () => {
      const dirty = isDirty(), empty = !state.text.trim();
      clear(status);
      if (state.parsing) status.appendChild(chip('Разбираем…', 'info', 'clock'));
      else if (empty) status.appendChild(chip('Поле пустое', 'outline', 'info'));
      else if (dirty) status.appendChild(chip(state.parse ? 'Текст изменен — разберите заново' : 'Еще не разобрано', 'warn', 'alert'));
      else status.appendChild(chip('Разобрано · ' + evWord(state.events.length), 'good', 'check'));
      const again = !dirty && !state.parsing && state.parse;
      parseBtn.className = 'btn ' + (again ? 'secondary' : 'primary');
      btnLabel.textContent = state.parsing ? 'Разбираем…' : again ? 'Разобрать заново' : 'Разобрать';
      parseBtn.disabled = state.parsing;
    };
    ta.addEventListener('input', () => { state.text = ta.value; sync(); renderSide(); });
    ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doParse(); } });
    sync();
    const setText = (t, msg) => { state.text = t; ta.value = t; sync(); renderSide(); ta.focus(); if (msg) UI.toast(msg, 'copy'); };
    return h('div', { class: 'stack', style: 'gap:16px' },
      h('div', { class: 'stack', style: 'gap:8px' },
        h('div', { class: 'new-tools' },
          h('label', { class: 'field-label', for: 'new-text' }, 'Текст событий'),
          h('div', { class: 'row' },
            button('Формат', { kind: 'ghost', size: 'sm', icon: 'book', onClick: formatModal, title: 'Как писать текст' }),
            button('Пример', { kind: 'ghost', size: 'sm', icon: 'copy', onClick: () => setText(EXAMPLE, 'Вставлен пример в формате бота') }),
            button('Очистить', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => setText('') }))),
        ta,
        h('div', { class: 'new-ta-actions' },
          h('div', { class: 'new-ta-status' }, status,
            h('span', { class: 'xsmall muted', id: 'new-text-hint' }, 'Формат как в Telegram-боте. Разбирает Claude Haiku 4.5, ' + PARSE_COST + ' за текст', UI.isMobile() ? '.' : [' · ', h('kbd', { class: 'new-kbd' }, 'Ctrl'), '+', h('kbd', { class: 'new-kbd' }, 'Enter')])),
          parseBtn)),
      dropzone(),
      resultSection());
  }

  // ---------- вкладка «Заполнить форму» ----------
  function todayPicker() {
    const t = D.matchesToday[0];
    return h('section', { class: 'new-today', 'aria-labelledby': 'new-today-t' },
      h('div', { class: 'new-today-head' },
        h('div', null, h('h4', { id: 'new-today-t' }, 'Матчи сегодня'), h('div', { class: 'xsmall muted' }, t.tournament + ', ' + t.category + ', ' + t.round + '. Нажмите — подставим игроков и кэфы из линии (пример линии).')),
        UI.surfaceChip(t.surface)),
      h('div', { class: 'new-today-grid' }, D.matchesToday.map(m => {
        const added = state.events.some(e => e.todayId === m.id);
        return h('button', { type: 'button', class: 'new-today-btn', 'aria-pressed': String(added), 'data-fk': 'today-' + m.id, on: { click: () => toggleToday(m) } },
          h('span', { class: 'new-today-top' }, h('span', { class: 'mono' }, m.time), h('span', { class: 'new-today-state' }, icon(added ? 'check' : 'plus'), added ? 'добавлен' : 'добавить')),
          h('span', { class: 'new-today-name' }, P[m.p1].short + ' — ' + P[m.p2].short),
          h('span', { class: 'new-today-odds mono' }, h('span', null, 'П1 ' + fmt.odds(m.odds.p1)), h('span', null, 'П2 ' + fmt.odds(m.odds.p2))));
      })));
  }

  function formPanel() {
    const bank = UI.field({ label: 'Банк', id: 'new-bank', value: fmt.int(state.bank), suffix: '₽', inputmode: 'numeric', autocomplete: 'off', hint: 'По учету ставок на ' + fmt.date(D.today) + '. Сумма ставки — % от банка', attrs: { 'data-fk': 'bank' } });
    bank.querySelector('input').addEventListener('input', e => { state.bank = parseInt(e.target.value.replace(/[^\d]/g, ''), 10) || 0; renderSide(); });
    const opts = BOOKMAKERS.includes(state.bookmaker) ? BOOKMAKERS : [state.bookmaker].concat(BOOKMAKERS);
    const bk = UI.field({ label: 'Букмекер', id: 'new-bk', value: state.bookmaker, options: opts, hint: 'Нужен, чтобы потом сверять закрывающую линию (CLV)', attrs: { 'data-fk': 'bk' } });
    bk.querySelector('select').addEventListener('change', e => { state.bookmaker = e.target.value; renderSide(); });
    const fromText = state.events.some(e => e.raw1 || e.raw2);
    return h('div', { class: 'stack', style: 'gap:16px' },
      h('div', { class: 'new-form-top' }, bank, bk),
      todayPicker(),
      fromText && UI.callout('info', 'info', 'Здесь события из разобранного текста — правьте их в форме. Сам текст во вкладке «Вставить текстом» при этом не меняется.'),
      state.events.length
        ? h('div', { class: 'new-list' }, state.events.map((ev, i) => editorBlock(ev, i, false)))
        : h('div', { class: 'card', style: 'border-style:dashed' }, UI.empty('Событий пока нет. Выберите матч выше или добавьте событие вручную.')),
      button('Добавить событие', { kind: 'secondary', icon: 'plus', block: true, onClick: addBlank, attrs: { class: 'btn secondary block new-add', 'data-fk': 'add' } }));
  }

  // ---------- правая колонка ----------
  function launchCard(a) {
    const strip = h('dl', { class: 'new-strip' },
      h('div', null, h('dt', null, 'События'), h('dd', null, String(a.n))),
      h('div', null, h('dt', null, 'Игроки'), h('dd', null, String(a.players.length))),
      h('div', { title: 'Нет профиля или данные устарели' }, h('dt', null, 'Обновить'), h('dd', { class: a.missing.length + a.stale.length ? 'warn-text' : null }, String(a.missing.length + a.stale.length))));
    const plist = h('div', { class: 'new-sub' },
      h('div', { class: 'eyebrow' }, 'Данные игроков'),
      a.players.length
        ? h('ul', { class: 'new-plist' }, a.players.map(p => h('li', null,
          h('div', { class: 'new-plist-name' }, p.p && p.sure ? h('a', { href: '#player-' + p.p.id }, p.p.short) : h('span', null, p.name), h('span', { class: 'new-plist-sub' }, updatedText(p))),
          freshChip(p))))
        : h('p', { class: 'small muted' }, 'Игроки появятся после разбора текста или заполнения формы.'));
    const modes = h('fieldset', { class: 'new-modes' },
      h('legend', { class: 'eyebrow' }, 'Режим анализа'),
      MODES.map(m => {
        const on = m.id === state.mode;
        return h('label', { class: ['new-mode', on && 'on'] },
          h('input', { type: 'radio', name: 'new-mode', value: m.id, checked: on, 'data-fk': 'mode-' + m.id, on: { change: () => { state.mode = m.id; renderSide(); } } }),
          h('span', { class: 'new-mode-main' }, h('span', { class: 'new-mode-title' }, m.label, h('span', { class: 'new-mode-model' }, m.model), m.flag && chip(m.flag, 'warn', 'flask')), h('span', { class: 'new-mode-note' }, m.note)),
          h('span', { class: 'new-mode-cost' }, h('b', null, usd(Math.max(1, a.n) * m.perEvent)), h('small', null, fmtTime(Math.max(1, a.n) * m.secs))));
      }),
      a.n ? null : h('span', { class: 'xsmall muted' }, 'Цена указана за одно событие.'));
    const costs = h('div', { class: 'new-costs' },
      UI.kv(a.items.map(it => [it.label, usd(it.cost)])),
      h('div', { class: 'new-total', 'aria-live': 'polite' }, h('span', null, 'Итого'), h('span', null, h('b', null, usd(a.cost)), h('span', { class: 'muted' }, ' · ' + fmtTime(a.secs)))));
    const spent = D.ai.spent, budget = D.ai.budget, after = spent + a.cost;
    const bud = h('div', { class: 'new-sub', style: 'gap:6px' },
      h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Бюджет ИИ на ' + D.ai.month), h('span', { class: 'num' }, h('b', null, fmt.usd(spent)), ' из ' + fmt.usd(budget, 0))),
      UI.meter(after, budget, after / budget > 0.9 ? 'bad' : after / budget > 0.7 ? 'warn' : null),
      h('div', { class: 'xsmall muted' }, 'После запуска ≈ ' + fmt.usd(after) + '. Профили и правила стратегии берутся из кэша промпта — в ' + D.ai.month.replace(/ь$/, 'е') + ' так пришло ' + D.ai.cacheShare + '% входных токенов.'));
    const launchBtn = button('Запустить анализ', { kind: 'primary', size: 'lg', icon: 'spark', block: true, disabled: !!a.reason, onClick: launch, attrs: { id: 'new-launch', 'data-fk': 'launch' } });
    return UI.card({
      class: 'new-launch-card', title: 'Перед запуском', subtitle: 'Что уйдет в анализ и сколько это стоит',
      body: [strip, plist, h('hr', { class: 'divider' }), modes, costs, bud, launchBtn,
        a.reason
          ? h('p', { class: 'new-reason', role: 'status' }, icon('alert'), a.reason)
          : h('p', { class: 'xsmall muted' }, 'Займет ' + fmtTime(a.secs) + '. Ставку ИИ не делает: экспресс и сумму вы подтверждаете сами.'),
        h('a', { class: 'new-link', href: '#costs' }, 'Цена и качество режимов — «ИИ и расходы»', icon('arrowRight'))],
    });
  }

  function flowCard(a) {
    const names = arr => arr.map(p => p.p ? p.p.short : p.name).join(', ');
    const steps = [];
    if (a.missing.length || a.stale.length) steps.push(['database', 'warn', 'Соберем недостающие данные', [a.missing.length && 'Профиль с нуля: ' + names(a.missing) + '.', a.stale.length && 'Обновим: ' + names(a.stale) + '.'].filter(Boolean).join(' ')]);
    else steps.push(['database', 'accent', 'Данные игроков свежие', 'Обновлять ничего не нужно — профили берем из базы.']);
    steps.push(['brain', '', 'Оценим вероятности исходов', 'Форма, Эло на покрытии, подача и прием, личные встречи, усталость' + (a.mode.id === 'precise' ? ', свежие новости о травмах и снятиях' : '') + ' и ' + LESSONS_ON + ' ' + fmt.plural(LESSONS_ON, 'подтвержденный урок', 'подтвержденных урока', 'подтвержденных уроков') + ' из прошлых ставок.']);
    steps.push(['target', '', 'Сравним с рынком', 'Уберем маржу букмекера и отметим исходы, где оценка модели выше рынка.']);
    steps.push(['ticket', '', 'Соберем экспресс', LEGS + ' ' + fmt.plural(ST.maxLegs, 'событие', 'события', 'событий') + ' с итоговым кэфом ≤ ' + fmt.odds(ST.totalMax) + ' (ординары стратегия не допускает) и сумму по таблице ставок от банка ' + fmt.money(state.bank) + '.']);
    steps.push(['check', '', 'Решение за вами', 'ИИ может ошибаться и сам ставки не делает. Результат вы внесете после матча — на нем модель учится.']);
    return UI.card({
      title: 'Что произойдет после запуска',
      body: h('ol', { class: 'new-flow' }, steps.map(([ic, kind, t, d]) => h('li', null, h('span', { class: ['new-flow-ic', kind] }, icon(ic)), h('div', { class: 'new-flow-body' }, h('b', null, t), h('span', null, d))))),
    });
  }

  function rulesCard(a) {
    const v = D.strategyVersions.find(s => s.status === 'active');
    return UI.card({
      class: 'new-rules', title: 'Правила стратегии', subtitle: 'Активная версия ' + v.name.split(' · ')[0],
      actions: [button('Изменить', { kind: 'ghost', size: 'sm', icon: 'edit', href: '#profile-bank', title: 'Правила стратегии — в личном кабинете, вкладка «Банк и стратегия»' })],
      body: [
        UI.kv([
          ['Вероятность события', '≥ ' + ST.minProb + '%'],
          ['Кэф события', fmt.odds(ST.oddsMin) + '–' + fmt.odds(ST.oddsMax)],
          ['Событий в экспрессе', LEGS],
          ['Итоговый кэф', '≤ ' + fmt.odds(ST.totalMax)],
        ]),
        a.n > ST.maxLegs
          ? UI.callout('info', 'info', 'Событий больше ' + ST.maxLegs + ' — в экспресс попадут не больше ' + ST.maxLegs + ' лучших, остальные получат отдельную оценку.')
          : a.n === 1
            ? UI.callout('warn', 'alert', 'Одно событие — экспресс из него не собрать, а ординары стратегия не допускает. Оценку покажем, ставку не предложим. Добавьте еще одно событие.')
            : h('p', { class: 'xsmall muted' }, 'События, которые не проходят эти правила, ИИ в экспресс не включит, даже если вы их ввели, — но оценку по ним покажет.'),
      ],
    });
  }

  function renderSteps(a) {
    const s = refs.steps; if (!s) return;
    clear(s);
    const inputDone = a.n > 0 && !(state.tab === 'text' && (isDirty() || state.parsing));
    // На телефоне видны короткие подписи, полная подпись остается для экранного диктора
    [['Ввод событий', 'Ввод', inputDone ? 'done' : 'current'], ['Проверка', 'Проверка', inputDone ? 'current' : ''], ['Анализ', 'Анализ', '']].forEach(([label, short, st], i) =>
      s.appendChild(h('li', { class: ['new-step', st], 'aria-current': st === 'current' ? 'step' : null },
        h('span', { class: 'new-step-n' }, st === 'done' ? [icon('check'), h('span', { class: 'sr-only' }, 'готово:')] : String(i + 1)),
        h('span', { class: 'new-step-label' }, h('span', { class: 'new-step-full' }, label), h('span', { class: 'new-step-short', 'aria-hidden': 'true' }, short)))));
  }

  function renderBar(a) {
    const bar = refs.bar; if (!bar) return;
    clear(bar);
    bar.append(
      h('div', { class: 'new-bar-text' },
        h('b', null, evWord(a.n) + ' · ' + a.mode.label),
        h('span', { class: ['new-bar-sub', a.reason && 'warn'] }, a.reason || usd(a.cost) + ' · ' + fmtTime(a.secs))),
      button('Запустить', { kind: 'primary', icon: 'spark', disabled: !!a.reason, onClick: launch }));
  }

  // На широком экране карточка «Правила стратегии» встает в ту колонку, которая короче:
  // так под полем ввода не остается пустого места. Порог в 120px не дает ей прыгать при наборе текста.
  let rulesInMain = false;
  function balance() {
    const { main, side, rules, layout } = refs;
    if (!rules || !layout || !layout.isConnected) return;
    const twoCols = !UI.isMobile() && getComputedStyle(layout).gridTemplateColumns.trim().split(/\s+/).length > 1;
    const inMain = rules.parentNode === main;
    let toMain = inMain;
    if (!twoCols) toMain = false;
    else {
      const R = rules.offsetHeight + 16;
      const hm = main.offsetHeight - (inMain ? R : 0), hs = side.offsetHeight - (inMain ? 0 : R);
      const dSide = Math.abs(hm - (hs + R)), dMain = Math.abs(hm + R - hs);
      if (!inMain && dMain < dSide - 120) toMain = true;
      else if (inMain && dSide < dMain - 120) toMain = false;
    }
    rulesInMain = toMain;
    if (toMain !== inMain) (toMain ? main : side).appendChild(rules);
  }
  let balanceQueued = false;
  window.addEventListener('resize', () => {
    if (balanceQueued) return;
    balanceQueued = true;
    requestAnimationFrame(() => { balanceQueued = false; if (refs.layout && refs.layout.isConnected) balance(); });
  });

  function renderSide() {
    if (!refs.side || !refs.side.isConnected) return;
    const a = summary();
    renderSteps(a);
    if (refs.rules) refs.rules.remove();
    refs.rules = rulesCard(a);
    keepFocus(refs.side, () => { clear(refs.side); refs.side.append(launchCard(a), flowCard(a)); (rulesInMain ? refs.main : refs.side).appendChild(refs.rules); });
    balance();
    renderBar(a);
    // На телефоне нижняя панель прячется, когда основная кнопка запуска видна на экране
    if (io) { io.disconnect(); io = null; }
    const btn = refs.side.querySelector('#new-launch');
    if (btn && typeof IntersectionObserver !== 'undefined' && UI.isMobile()) {
      io = new IntersectionObserver(entries => entries.forEach(en => refs.bar && refs.bar.classList.toggle('off', en.isIntersecting)), { rootMargin: '0px 0px -150px 0px' });
      io.observe(btn);
    }
  }

  function renderPanel() {
    const panel = refs.panel; if (!panel || !panel.isConnected) return;
    keepFocus(panel, () => { clear(panel); slots.clear(); panel.appendChild(state.tab === 'text' ? textPanel() : formPanel()); });
    balance();
  }

  // ---------- вход с параметром ----------
  // #new-m3 — черновик с одним матчем из расписания (кнопка «Анализировать» на главной и в карточке игрока),
  // #new-today — форма с выбором из матчей дня. Без параметра черновик не трогаем.
  let revealToday = false;
  function applyParam(param) {
    if (!param) return;
    const m = D.matchesToday.find(x => x.id === param);
    if (m) {
      state.tab = 'form'; state.editing.clear(); snapshots.clear();
      state.events = [eventFromToday(m)];
      // во вкладке «Вставить текстом» — тот же матч в формате бота, чтобы вкладки не расходились
      state.text = [
        'Текущий банк: ' + fmt.int(state.bank) + ' ₽', 'Букмекер: ' + state.bookmaker, '', 'События:',
        P[m.p1].short + ' vs ' + P[m.p2].short + ', ' + m.tournament + ', ' + (D.surfaces[m.surface] ? D.surfaces[m.surface].label.toLowerCase() : 'хард') + ', ' + m.round.replace(' финала', ''),
        'Кэфы: П1 = ' + fmt.odds(m.odds.p1) + ', П2 = ' + fmt.odds(m.odds.p2),
        'Фора по сетам: П1(-1.5) = ' + fmt.odds(m.odds.h1m) + ', П2(+1.5) = ' + fmt.odds(m.odds.h2p),
      ].join('\n');
      state.parsedText = state.text;
      state.parse = { bank: null, bookmaker: null, unknown: [] };
      UI.toast('Добавлен матч ' + P[m.p1].short + ' — ' + P[m.p2].short + ' из расписания', 'calendar');
    } else if (param === 'today') {
      state.tab = 'form';
      revealToday = true;
    }
    // адрес без параметра: повторный заход на экран не сбросит черновик еще раз
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#new'); } catch (e) { /* в песочнице адрес может быть недоступен */ }
  }

  // ---------- экран ----------
  function render(root, param) {
    applyParam(param);
    if (io) { io.disconnect(); io = null; }
    slots.clear();
    const panel = h('div', { class: 'new-panel', role: 'tabpanel', id: 'new-panel', 'aria-label': state.tab === 'text' ? 'Вставить текстом' : 'Заполнить форму' });
    const side = h('aside', { class: 'new-side', 'aria-label': 'Перед запуском' });
    const steps = h('ol', { class: 'new-steps', 'aria-label': 'Шаги' });
    const bar = h('div', { class: 'new-bar', role: 'region', 'aria-label': 'Запуск анализа' });
    const main = h('div', { class: 'new-main' });
    const layout = h('div', { class: 'new-layout' }, main, side);
    refs = { panel, side, steps, bar, main, layout, rules: null };
    const tabsEl = UI.tabs({
      items: [{ id: 'text', label: [icon('list'), 'Вставить текстом'] }, { id: 'form', label: [icon('edit'), 'Заполнить форму'] }],
      active: state.tab,
      onChange: id => { state.tab = id; panel.setAttribute('aria-label', id === 'text' ? 'Вставить текстом' : 'Заполнить форму'); renderPanel(); renderSide(); },
    });
    tabsEl.classList.add('new-tabs');
    tabsEl.setAttribute('aria-label', 'Способ ввода');
    main.appendChild(h('section', { class: 'card new-input-card', 'aria-label': 'Ввод событий' }, tabsEl, panel));

    root.appendChild(h('div', { class: 'new-root' },
      h('datalist', { id: 'new-players' }, D.players.map(p => h('option', { value: p.name }))),
      h('datalist', { id: 'new-tours' }, TOURS.map(t => h('option', { value: t }))),
      h('div', { class: 'page-head new-head' },
        h('div', { style: 'min-width:0' },
          h('h2', null, 'Что разбираем сегодня?'),
          h('p', { class: 'lead' }, 'Вставьте события так же, как писали боту в Telegram, или заполните форму. До запуска видно, что понял ИИ, чьи данные устарели и сколько стоит анализ.')),
        steps),
      layout,
      bar,
      h('div', { class: 'new-bar-spacer', 'aria-hidden': 'true' })));
    renderPanel();
    renderSide();
    requestAnimationFrame(() => { const tb = document.querySelector('.tabbar'); if (tb && tb.offsetHeight) bar.style.setProperty('--new-tabbar', tb.offsetHeight + 'px'); });
    if (revealToday) {
      revealToday = false;
      // после общего window.scrollTo(0, 0) в роутере — показываем «Матчи сегодня»
      setTimeout(() => {
        const sec = root.querySelector('.new-today'); if (!sec) return;
        sec.scrollIntoView({ block: 'start', behavior: 'smooth' });
        const b = sec.querySelector('.new-today-btn[aria-pressed="false"]') || sec.querySelector('.new-today-btn');
        if (b) b.focus({ preventScroll: true });
      }, 80);
    }
  }

  UI.register('new', { title: 'Новый анализ', nav: 'new', render });
})();
