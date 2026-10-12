/* Новый анализ — окно ввода событий. Два способа: свободным текстом — матчи и кэфы (разбор имитирует Claude Haiku 5.5),
   или формой. Справа — «Перед запуском»: игроки и свежесть их новостей, режим анализа, цена и время, правила
   стратегии, последние анализы. Состояние живет в замыкании — черновик не теряется при переходах.
   Этап 3: линии кэфов нет (Р10) — «Матчи сегодня» и скриншот купона убраны; игрока нет в базе — анализ с ним
   не запускается (сбора профиля нет); досье считает код, перед анализом ищутся только устаревшие новости. */
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
    { id: 'eco', label: 'Экономный', model: 'Haiku 5.5 + кэш', perEvent: 0.02, secs: 20, note: 'Черновая оценка по сохраненным досье, чтобы отсеять лишнее. Не для решения о ставке.' },
  ];
  // Этап 3: работает только «Точный». Два других режима показаны выключенными до проверки на истории (вопрос владельцу);
  // чтобы вернуть режим, добавьте его id в этот список.
  const MODES_ON = ['precise'];
  const modeOn = m => MODES_ON.includes(m.id);
  // Новости перед анализом: один запрос Sonnet 5.5 с поиском на матч, если новости хотя бы одного игрока старше 12 ч.
  // Цена — по живой проверке (2 поиска, ≈ 37 тыс. токенов входа). Поисков на анализ не больше 6, по 2 на запрос:
  // новости ищутся у первых трех таких матчей, у остальных шаг пропускается (лимит поисков)
  const NEWS = { cost: 0.11, secs: 25, maxMatches: 3 };
  const PARSE_COST = '≈$' + fmt.dec(0.001, 3);
  // Дата последнего матча игрока в базе (архив ATP и tennis-data): в макете — одна для всех игроков сегодняшних матчей
  const LAST_MATCH = '2026-10-05';
  // Букмекеры: свой список у каждого (Р17), меняется в «Личном кабинете → Букмекеры» — поэтому читаем его при отрисовке.
  // По умолчанию — первый из списка; эталон рынка для CLV — DATA.marketRef.
  const OTHER_BK = 'Другой';
  const bookmakers = () => [...new Set((D.user.bookmakers || []).concat(OTHER_BK))];
  const defaultBk = () => bookmakers()[0];
  const ROUNDS = ['1/64 финала', '1/32 финала', '1/16 финала', '1/8 финала', '1/4 финала', '1/2 финала', 'Финал'];
  const SURF_WORDS = [[/крыт|indoor|зал/i, 'indoor'], [/хард|hard/i, 'hard'], [/грунт|clay/i, 'clay'], [/трав|grass/i, 'grass']];
  const TOURS = [...new Set(D.calendar.flatMap(c => c.name.split(' / ')))];
  const LESSONS_ON = D.lessons.filter(l => l.inPrompt).length;
  const LEGS = '2–' + ST.maxLegs; // экспресс из 2–3 событий, ординаров стратегия не допускает

  // ---------- валюта программы (Р17) ----------
  // Суммы в DATA — рубли демо-данных; на экране и в полях ввода — валюта программы через UI.fmt.
  const curDec = () => (UI.currency.list[UI.currency.code] || { dec: 0 }).dec;
  const amountText = rub => (curDec() ? fmt.dec(fmt.moneyNum(rub), 2) : fmt.int(fmt.moneyNum(rub))); // число для поля ввода, без символа
  const sameMoney = (a, b) => fmt.moneyNum(a) === fmt.moneyNum(b);
  const curName = () => UI.currency.label.charAt(0).toLowerCase() + UI.currency.label.slice(1); // «евро», «доллары США»
  // \b в регулярных выражениях JS не видит границ кириллических слов — для «руб», «евро» он не нужен
  const CUR_WORDS = [
    ['RUB', /\u20BD|руб|\brub\b|\d\s*р\.?\s*$/i], // \u20BD — знак рубля
    ['USD', /\$|\busd\b|доллар/i],
    ['EUR', /€|\beuro?\b|евро/i],
  ];
  // «48 000 руб», «477,14 €», «$519.48», «520 usd» → { value, code }; без валюты — валюта программы
  function parseAmount(str) {
    const raw = String(str || '');
    const hit = CUR_WORDS.find(([, re]) => re.test(raw));
    let t = raw.replace(/[^\d.,]/g, '');
    if (!/\d/.test(t)) return null;
    const lastC = t.lastIndexOf(','), lastD = t.lastIndexOf('.');
    if (lastC >= 0 && lastD >= 0) { const dp = Math.max(lastC, lastD); t = t.slice(0, dp).replace(/[.,]/g, '') + '.' + t.slice(dp + 1); }
    else {
      const sep = lastC >= 0 ? ',' : lastD >= 0 ? '.' : null;
      if (sep) {
        const parts = t.split(sep);
        // одна запятая или точка и 1–2 цифры после нее — дробная часть; иначе разделитель тысяч
        t = parts.length === 2 && parts[1].length <= 2 ? parts[0] + '.' + parts[1] : parts.join('');
      }
    }
    const value = parseFloat(t);
    if (!(value > 0)) return null;
    return { value, code: hit ? hit[0] : UI.currency.code };
  }
  // сумма из текста → рубли демо-данных; чужая валюта пересчитывается по курсу программы
  const amountToRub = a => a.value / UI.currency.list[a.code].rate;

  // Образец текста: банк — в валюте программы, букмекер — из списка участника
  const example = () => [
    'Текущий банк: ' + fmt.money(S.bank),
    'Букмекер: ' + defaultBk(),
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
  const template = () => [
    'Текущий банк: ' + fmt.money(S.bank),
    'Букмекер: ' + defaultBk(),
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
    tab: 'text', text: '', auto: null, parsedText: null, parsing: false, parse: null,
    bank: S.bank, bookmaker: null, events: [], editing: new Set(), mode: 'precise',
  };
  const curBk = () => state.bookmaker || defaultBk(); // null — букмекер по умолчанию из кабинета
  // Свежесть новостей игрока: fresh — моложе 12 ч, stale — старше или новостей еще нет (поищем перед анализом).
  // Статистику и досье код считает по архиву в базе — их «обновлять» не нужно.
  const newsOf = p => (p.fresh === 'fresh' ? 'fresh' : 'stale');
  function resolve(name) {
    const n = String(name || '').trim(); if (!n) return null;
    const m = matchPlayer(n);
    if (m && m.conf >= 0.7) return { name: n, p: m.p, conf: m.conf, sure: m.conf >= 0.9, fresh: newsOf(m.p) };
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
    const res = { bank: null, bankRaw: null, bookmaker: null, events: [], unknown: [] };
    let cur = null;
    text.split(/\r?\n/).forEach((raw, i) => {
      const line = raw.trim(); if (!line) return;
      let m;
      if ((m = line.match(/^(?:текущий\s+)?банк\s*[:=-]?\s*(.+)$/i))) {
        const a = parseAmount(m[1]);
        if (a) { res.bank = amountToRub(a); res.bankRaw = a; } else res.unknown.push({ n: i + 1, text: line });
        return;
      }
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
    // банк из текста совпал с учетом с точностью до копейки или цента — берем точное значение из учета;
    // нет банка или букмекера в тексте — берем из кабинета, а не из прошлого разбора
    state.bank = res.bank && !sameMoney(res.bank, S.bank) ? res.bank : S.bank;
    // букмекер из текста сверяем со списком без учета регистра: «BET365» — это bet365 из кабинета
    const known = res.bookmaker && bookmakers().find(b => b.toLowerCase() === res.bookmaker.toLowerCase());
    state.bookmaker = known || res.bookmaker || null;
    state.parse = { bank: res.bank ? state.bank : null, bankRaw: res.bankRaw, bookmaker: res.bookmaker, unknown: res.unknown };
    state.parsedText = state.text;
  }
  // Текст, который подставили мы (пример или матч из расписания), пересобирается, если сменилась валюта программы
  // или банк в учете: суммы в нем всегда в текущей валюте. Текст, который правил пользователь, не трогаем.
  // Букмекер по умолчанию тоже входит в ключ: список меняется в личном кабинете.
  const autoKey = () => UI.currency.code + '|' + S.bank + '|' + defaultBk();
  function setAutoText(build) { state.text = build(); state.auto = { build, text: state.text, key: autoKey(), bank: S.bank, bk: defaultBk() }; }
  function syncAutoText() {
    const a = state.auto;
    if (!a || state.text !== a.text || a.key === autoKey()) return;
    const wasParsed = state.parsedText === state.text;
    if (state.bank === a.bank) state.bank = S.bank;
    if (state.parse && state.parse.bank === a.bank) state.parse.bank = S.bank;
    if (state.bookmaker === a.bk) state.bookmaker = null;
    setAutoText(a.build);
    if (wasParsed) state.parsedText = state.text;
  }
  setAutoText(example);
  applyParse(parseText(state.text)); // открываемся в рабочем состоянии: пример уже разобран

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
    const missing = players.filter(p => !p.p);                     // нет в базе — анализ не запустится
    const stale = players.filter(p => p.p && p.sure && p.fresh === 'stale'); // новости устарели — поищем
    // новости ищутся одним запросом на матч: считаем матчи, где новости устарели хотя бы у одного игрока, —
    // не больше NEWS.maxMatches (лимит поисков на анализ), по порядку событий
    const staleOf = name => { const r = resolve(name); return r && r.p && r.sure && r.fresh === 'stale' ? r.p.id : null; };
    const newsEvs = evs.filter(ev => [ev.n1, ev.n2].some(staleOf)).slice(0, NEWS.maxMatches);
    const newsMatches = newsEvs.length;
    const searched = stale.filter(p => newsEvs.some(ev => [ev.n1, ev.n2].some(name => staleOf(name) === p.p.id)));
    const mode = MODES.find(m => m.id === state.mode);
    const items = [{ label: 'Анализ · ' + mode.model.replace(' + кэш', '') + ' · ' + evWord(n), cost: n * mode.perEvent }];
    const newsCount = searched.length < stale.length
      ? searched.length + ' из ' + stale.length + ' ' + fmt.plural(stale.length, 'игрока', 'игроков', 'игроков')
      : stale.length + ' ' + fmt.plural(stale.length, 'игрок', 'игрока', 'игроков');
    const newsLimit = searched.length < stale.length ? ' — лимит поисков на анализ' : '';
    if (stale.length && mode.id === 'precise') items.push({ label: 'Новости: ' + newsCount + ' (' + searched.map(p => p.p.short).join(', ') + ')' + newsLimit, cost: newsMatches * NEWS.cost });
    const extraCost = mode.id === 'precise' ? newsMatches * NEWS.cost : 0;
    const extraSecs = mode.id === 'precise' ? newsMatches * NEWS.secs : 0;
    const cost = n * mode.perEvent + extraCost, secs = n * mode.secs + extraSecs;

    // Можно ли запускать, решает общий расчет DATA.ai.access. Сначала — то, что не зависит от событий (пауза, нет ключа,
    // анализы на сегодня закончились), чтобы не набирать события зря; потом ошибки ввода; потом цена этого анализа.
    const inputReason = () => {
      if (state.tab === 'text' && state.parsing) return 'Дождитесь окончания разбора';
      if (state.tab === 'text' && !state.text.trim()) return 'Вставьте текст с событиями';
      if (state.tab === 'text' && isDirty()) return 'Текст изменен — нажмите «Разобрать»';
      if (!n) return 'Добавьте хотя бы одно событие';
      const i = evs.findIndex(ev => check(ev).errors.length);
      if (i >= 0) { const e = check(evs[i]).errors[0]; return 'Событие ' + (i + 1) + ': ' + e.charAt(0).toLowerCase() + e.slice(1); }
      const gone = players.find(p => !p.p);
      if (gone) return '«' + gone.name + '» нет в базе ATP — анализ с ним не запустим. Исправьте имя или уберите событие';
      const u = players.find(p => p.p && !p.sure);
      return u ? 'Подтвердите игрока «' + u.name + '»' : null;
    };
    const blocked = D.ai.access(D.me, 0);
    const reason = blocked || inputReason() || D.ai.access(D.me, cost);
    return { evs, n, players, missing, stale, newsMatches, mode, items, cost, secs, extraCost, extraSecs, reason, blocked };
  }

  // ---------- лимиты ИИ (Р7, Р9, Р13) ----------
  // Только для показа: можно ли запускать, решает DATA.ai.access. Участник на ключе администратора видит свой лимит,
  // администратор — бюджет своего ключа. На своем ключе действует только потолок на один анализ (DATA.me.ownCap).
  const usdL = n => fmt.usd(n, Number.isInteger(n) ? 0 : 2); // $10 и $1, но $1,50
  function aiLimit() {
    const me = D.me;
    if (me.aiMode === 'own') return { own: true, last4: me.ownKey ? me.ownKey.last4 : null, cap: me.ownCap != null ? me.ownCap : D.admin.defaults.perAnalysis };
    const L = D.ai.limitOf(me);
    if (L) return { personal: true, spent: D.ai.keySpent(me), cap: L.monthly, daily: L.daily, today: me.todayAnalyses, perAnalysis: L.perAnalysis, paused: !!L.paused };
    const B = D.ai.budget();
    return { spent: B.spent, cap: B.monthly };
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
    .new-mode.off { cursor: not-allowed; background: var(--surface-2); border-style: dashed; }
    .new-mode-off { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); font-weight: 600; color: var(--fg-2); }
    .new-mode-off svg { width: 13px; height: 13px; flex: none; }
    .new-mode.off .new-mode-main, .new-mode.off .new-mode-cost { opacity: .6; }
    .new-mode.off:hover { border-color: var(--line); }
    .new-recent { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .new-recent li { border-top: 1px solid var(--line); }
    .new-recent li:first-child { border-top: 0; }
    .new-recent a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 10px; align-items: center; padding: 9px 0; min-height: 44px; color: var(--fg); text-decoration: none; }
    .new-recent a:hover .new-recent-m { color: var(--accent-ink); text-decoration: underline; }
    .new-recent-m { font-weight: 500; min-width: 0; overflow-wrap: anywhere; }
    .new-recent-s { grid-column: 1; font-size: var(--fs-xs); color: var(--fg-3); }
    .new-recent .chip { grid-row: 1 / span 2; grid-column: 2; }
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
  // k — какой игрок неверный: фокус сразу в его поле (1 или 2)
  function startEdit(ev, k) { snapshots.set(ev.id, JSON.stringify(ev)); state.editing.add(ev.id); renderPanel(); focusLater('#' + ev.id + '-n' + (k === 2 ? 2 : 1)); }
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
  function addBlank() {
    const ev = blankEvent();
    state.events.push(ev);
    if (state.tab === 'text') { snapshots.set(ev.id, JSON.stringify(ev)); state.editing.add(ev.id); }
    renderPanel(); renderSide();
    focusLater('#' + ev.id + '-n1');
  }
  function onNamesChanged(ev) {
    const before = ev.todayId;
    const m = attachToday(ev);
    if ((m && m.id !== before) || (before && !m)) { renderPanel(); renderSide(); return; }
    refreshEvent(ev);
  }
  function launch() {
    const a = summary();
    if (a.reason) { UI.toast(a.reason, 'alert'); return; }
    D.pendingAnalysis = {
      createdAt: D.today, mode: a.mode.id, model: a.mode.model, bank: state.bank, bookmaker: curBk(),
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
        h('p', { class: 'soft' }, 'Свободный текст: матчи и кэфы, по строке на событие. Порядок важен: сначала строка с игроками, под ней — кэфы этого матча.'),
        h('pre', { class: 'new-pre mono', style: 'margin:0;padding:12px 14px;border-radius:var(--r-md);background:var(--surface-2);font-size:var(--fs-sm);white-space:pre-wrap;overflow-wrap:anywhere' }, template()),
        h('ul', { class: 'stack', style: 'gap:8px;margin:0;padding-left:18px;font-size:var(--fs-sm);color:var(--fg-2)' },
          h('li', null, h('b', null, 'Игроки: '), '«Синнер vs Руне», «Синнер — Руне» или «Sinner vs Rune». Достаточно фамилии.'),
          h('li', null, h('b', null, 'После игроков через запятую: '), 'турнир, покрытие и, если знаете, раунд — «Шанхай, хард, 1/8».'),
          h('li', null, h('b', null, 'Кэфы: '), 'П1 и П2 обязательны. Форы по сетам — П1(-1.5), П1(+1.5), П2(-1.5), П2(+1.5).'),
          h('li', null, 'Дробную часть можно писать через точку или запятую: 1.62 или 1,62.'),
          h('li', null, 'Банк и букмекер необязательны — по умолчанию возьмем из кабинета.'),
          h('li', null, 'Банк — в валюте программы (' + curName() + '). Сумму в другой валюте (' + Object.values(UI.currency.list).map(c => c.sym).join(', ') + ', «руб», «usd», «eur») пересчитаем по курсу программы.'),
          h('li', null, 'Строки, которые не удалось понять, покажем отдельно — ничего не пропадет молча.')),
        UI.callout('info', 'info', 'Разбор делает самая дешевая модель (Claude Haiku 5.5, ' + PARSE_COST + ' за текст). Если имя не совпало с базой, вы увидите это до запуска анализа.'),
      ],
      actions: close => [
        button('Вставить шаблон', { kind: 'secondary', icon: 'copy', onClick: () => { close(); state.tab = 'text'; state.text = template(); renderPanel(); renderSide(); focusLater('#new-text'); } }),
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
    if (!r.p) return chip('Нет в базе ATP', 'bad', 'x');
    if (conf >= 0.9) return h('span', { class: 'chip good', title: 'Насколько уверенно имя из текста сопоставлено с игроком' }, icon('check'), 'Совпало ' + fmt.prob(Math.min(conf, 1)));
    return chip('Проверьте · ' + fmt.prob(conf), 'warn', 'alert');
  }
  function freshChip(r) {
    if (r.p && !r.sure) return chip('Имя не подтверждено', 'warn', 'alert');
    if (!r.p) return chip('Анализ не запустим', 'bad', 'alert');
    return r.fresh === 'fresh' ? chip('Новости свежие', 'good', 'check') : chip('Поищем новости', 'warn', 'clock');
  }
  // новости игрока: когда искали в последний раз (кэш новостей — 12 ч)
  function newsWhen(p) {
    const u = p.updated;
    if (!u) return 'новостей еще нет';
    return 'новости ' + (u.slice(0, 10) === D.today ? 'сегодня, ' + u.slice(11, 16) : fmt.datetime(u));
  }
  function updatedText(r) {
    if (!r.p) return 'нет в базе ATP — проверьте имя';
    if (!r.sure) return 'похоже на ' + r.p.name;
    return 'последний матч в базе ' + fmt.date(LAST_MATCH) + ' · ' + newsWhen(r.p) + (r.fresh === 'stale' ? ' — поищем перед анализом' : '');
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
        r.p && h('span', { class: 'new-pl-sub' }, r.sure ? r.p.country + ' · №' + r.p.eloPlace + ' по Эло' : 'похоже на ' + r.p.name)),
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
    if (!r.p) { node.append(chip('Нет в базе ATP', 'bad', 'x'), h('span', null, 'анализ с ним не запустим — проверьте имя')); return; }
    node.append(freshChip(r), h('span', null, '№' + r.p.eloPlace + ' по Эло · ' + r.p.country));
  }

  function fillWarn(node, ev) {
    clear(node);
    const seen = new Set();
    [1, 2].forEach(k => {
      const r = resolve(ev['n' + k]); if (!r) return;
      const key = r.p ? r.p.id : r.name; if (seen.has(key)) return; seen.add(key);
      const fix = button('Исправить имя', { kind: 'ghost', size: 'sm', icon: 'edit', onClick: () => startEdit(ev, k) });
      if (r.p && !r.sure) {
        node.appendChild(UI.callout('warn', 'alert',
          h('div', null, h('b', null, '«' + r.name + '» — это ' + r.p.name + '?'), ' Совпадение с базой ' + fmt.prob(r.conf) + ', без подтверждения анализ не запустим.'),
          h('div', { class: 'row new-callout-actions' }, button('Да, это ' + r.p.short, { kind: 'secondary', size: 'sm', icon: 'check', onClick: () => confirmPlayer(ev, k, r.p) }), state.editing.has(ev.id) ? null : fix)));
      } else if (!r.p) {
        // Сбора профиля на этапе 3 нет: игрок должен быть в базе (архив ATP), иначе анализ не запускается
        node.appendChild(UI.callout('bad', 'alert',
          h('div', null, h('b', null, '«' + r.name + '» нет в базе ATP'), ' — анализ с ним не запустим.'),
          h('div', { class: 'xsmall', style: 'margin-top:2px' }, 'Проверьте написание: фамилии достаточно, можно латиницей. Или уберите событие.'),
          h('div', { class: 'row new-callout-actions' }, state.editing.has(ev.id) ? null : fix)));
      } else if (r.fresh === 'stale') {
        node.appendChild(UI.callout('', 'clock', h('b', null, r.p.short + ': ' + newsWhen(r.p)), ' — перед анализом поищем свежие новости о травмах и снятиях, ≈' + fmt.usd(NEWS.cost) + ' на матч.'));
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
    return [UI.surfaceChip(ev.surface), h('span', { style: 'min-width:0' }, parts.join(' · '))];
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
      h('div', { class: 'new-ev-meta' }, inline ? 'Исправление · изменения применяются сразу' : 'Заполните игроков и кэфы'),
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
    const bankDiff = pr.bank && !sameMoney(pr.bank, S.bank);
    const foreign = pr.bank && pr.bankRaw && pr.bankRaw.code !== UI.currency.code; // банк в тексте в другой валюте
    wrap.appendChild(h('div', { class: 'new-result-head' },
      h('div', { style: 'min-width:0' },
        h('h3', null, 'Что распознано'),
        h('div', { class: 'row' },
          chip(evWord(n), n ? 'accent' : 'bad', n ? 'check' : 'alert'),
          chip('Банк ' + fmt.money(state.bank), bankDiff || foreign ? 'warn' : 'outline', bankDiff || foreign ? 'alert' : 'wallet'),
          chip(curBk(), 'outline'))),
      h('span', { class: 'xsmall muted', style: 'padding-top:4px' }, 'Haiku 5.5 · ' + PARSE_COST)));
    if (bankDiff || foreign) {
      const IN = { RUB: 'рублях', USD: 'долларах', EUR: 'евро' };
      const raw = foreign && (UI.currency.list[pr.bankRaw.code].dec ? fmt.dec(pr.bankRaw.value, 2) : fmt.int(pr.bankRaw.value)) + ' ' + UI.currency.list[pr.bankRaw.code].sym;
      wrap.appendChild(UI.callout('warn', 'wallet',
        foreign ? 'Банк в тексте указан в ' + IN[pr.bankRaw.code] + ' (' + raw + '), а суммы в программе ведутся в ' + IN[UI.currency.code] + ': по курсу программы это ' + fmt.money(pr.bank) + '. ' : '',
        bankDiff ? (foreign ? 'Он отличается' : 'Банк в тексте (' + fmt.money(pr.bank) + ') отличается') + ' от учета ставок (' + fmt.money(S.bank) + '). Сумму ставки посчитаем от банка из текста.' : ''));
    }
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
            button('Пример', { kind: 'ghost', size: 'sm', icon: 'copy', onClick: () => { setText(example(), 'Вставлен пример текста'); state.auto = { build: example, text: state.text, key: autoKey(), bank: S.bank }; } }),
            button('Очистить', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => setText('') }))),
        ta,
        h('div', { class: 'new-ta-actions' },
          h('div', { class: 'new-ta-status' }, status,
            h('span', { class: 'xsmall muted', id: 'new-text-hint' }, 'Матчи и кэфы, по строке на событие. Разбирает Claude Haiku 5.5, ' + PARSE_COST + ' за текст', UI.isMobile() ? '.' : [' · ', h('kbd', { class: 'new-kbd' }, 'Ctrl'), '+', h('kbd', { class: 'new-kbd' }, 'Enter')])),
          parseBtn)),
      resultSection());
  }

  // ---------- вкладка «Заполнить форму» ----------
  function formPanel() {
    // Банк вводится в валюте программы, в черновик уходит в рублях демо-данных (UI.fmt.fromMoney)
    const bank = UI.field({ label: 'Банк', id: 'new-bank', value: amountText(state.bank), suffix: fmt.cur(), inputmode: curDec() ? 'decimal' : 'numeric', autocomplete: 'off', hint: 'По учету ставок на ' + fmt.date(D.today) + '. Сумма ставки — % от банка', attrs: { 'data-fk': 'bank', 'aria-label': 'Банк, ' + curName() } });
    const bankIn = bank.querySelector('input');
    bankIn.addEventListener('input', () => {
      const a = parseAmount(bankIn.value);
      const rub = a ? (a.code === UI.currency.code ? fmt.fromMoney(a.value) : amountToRub(a)) : 0;
      state.bank = rub && sameMoney(rub, S.bank) ? S.bank : rub;
      renderSide();
    });
    bankIn.addEventListener('blur', () => { if (state.bank > 0) bankIn.value = amountText(state.bank); });
    const list = bookmakers(), bkNow = curBk();
    const opts = list.includes(bkNow) ? list : [bkNow].concat(list); // букмекер из текста, которого нет в списке, тоже показываем
    const bk = UI.field({ label: 'Букмекер', id: 'new-bk', value: bkNow, options: opts, hint: 'Список — ваши букмекеры из личного кабинета. CLV считаем по закрывающему кэфу ' + D.marketRef + ' — эталону рынка', attrs: { 'data-fk': 'bk' } });
    bk.querySelector('select').addEventListener('change', e => { state.bookmaker = e.target.value; renderSide(); });
    const fromText = state.events.some(e => e.raw1 || e.raw2);
    return h('div', { class: 'stack', style: 'gap:16px' },
      h('div', { class: 'new-form-top' }, bank, bk),
      fromText && UI.callout('info', 'info', 'Здесь события из разобранного текста — правьте их в форме. Сам текст во вкладке «Вставить текстом» при этом не меняется.'),
      state.events.length
        ? h('div', { class: 'new-list' }, state.events.map((ev, i) => editorBlock(ev, i, false)))
        : h('div', { class: 'card', style: 'border-style:dashed' }, UI.empty('Событий пока нет. Добавьте событие — игроков подскажем из базы, кэфы впишите из своей линии.')),
      button('Добавить событие', { kind: 'secondary', icon: 'plus', block: true, onClick: addBlank, attrs: { class: 'btn secondary block new-add', 'data-fk': 'add' } }));
  }

  // ---------- правая колонка ----------
  function launchCard(a) {
    const strip = h('dl', { class: 'new-strip' },
      h('div', null, h('dt', null, 'События'), h('dd', null, String(a.n))),
      h('div', null, h('dt', null, 'Игроки'), h('dd', null, String(a.players.length))),
      h('div', { title: 'Новости старше 12 часов: поищем перед анализом' }, h('dt', null, 'Новости'), h('dd', { class: a.stale.length ? 'warn-text' : null }, String(a.stale.length))));
    const plist = h('div', { class: 'new-sub' },
      h('div', { class: 'eyebrow' }, 'Игроки и их новости'),
      a.players.length
        ? h('ul', { class: 'new-plist' }, a.players.map(p => h('li', null,
          h('div', { class: 'new-plist-name' }, p.p && p.sure ? h('a', { href: '#player-' + p.p.id }, p.p.short) : h('span', null, p.name), h('span', { class: 'new-plist-sub' }, updatedText(p))),
          freshChip(p))))
        : h('p', { class: 'small muted' }, 'Игроки появятся после разбора текста или заполнения формы.'));
    const modes = h('fieldset', { class: 'new-modes' },
      h('legend', { class: 'eyebrow' }, 'Режим анализа'),
      MODES.map(m => {
        const on = m.id === state.mode, off = !modeOn(m);
        return h('label', { class: ['new-mode', on && 'on', off && 'off'], title: off ? 'Режим включим после проверки на истории' : null },
          h('input', { type: 'radio', name: 'new-mode', value: m.id, checked: on, disabled: off, 'data-fk': 'mode-' + m.id, on: { change: () => { state.mode = m.id; renderSide(); } } }),
          h('span', { class: 'new-mode-main' }, h('span', { class: 'new-mode-title' }, m.label, h('span', { class: 'new-mode-model' }, m.model), !off && m.flag && chip(m.flag, 'warn', 'flask')), off && h('span', { class: 'new-mode-off' }, icon('flask'), 'после проверки на истории'), h('span', { class: 'new-mode-note' }, m.note)),
          h('span', { class: 'new-mode-cost' }, h('b', null, usd(Math.max(1, a.n) * m.perEvent)), h('small', null, fmtTime(Math.max(1, a.n) * m.secs))));
      }),
      a.n ? null : h('span', { class: 'xsmall muted' }, 'Цена указана за одно событие.'));
    const costs = h('div', { class: 'new-costs' },
      UI.kv(a.items.map(it => [it.label, usd(it.cost)])),
      h('div', { class: 'new-total', 'aria-live': 'polite' }, h('span', null, 'Итого'), h('span', null, h('b', null, usd(a.cost)), h('span', { class: 'muted' }, ' · ' + fmtTime(a.secs)))));
    const L = aiLimit(), cacheNote = 'Инструкции и правила стратегии берутся из кэша промпта — в ' + D.ai.month.replace(/ь$/, 'е') + ' так пришло ' + D.ai.cacheShare + '% входных токенов.';
    let bud;
    if (L.own && !L.last4) {
      bud = h('div', { class: 'new-sub', style: 'gap:6px' },
        h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Свой ключ Claude'), h('span', { class: 'warn-text' }, 'не добавлен')),
        h('div', { class: 'xsmall muted' }, 'Без ключа анализ не запустится. ', h('a', { href: '#profile-key' }, 'Добавить ключ в личном кабинете')));
    } else if (L.own) {
      bud = h('div', { class: 'new-sub', style: 'gap:6px' },
        h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Свой ключ Claude'), h('span', { class: 'mono' }, 'sk-ant-…' + L.last4)),
        h('div', { class: 'xsmall muted' }, 'Анализ ≈ ' + fmt.usd(a.cost) + ' спишется с вашего счета Anthropic. На своем ключе действует только ваш потолок — ' + usdL(L.cap) + ' на один анализ, он меняется в ', h('a', { href: '#profile-key' }, 'личном кабинете'), '. ' + cacheNote));
    } else {
      // пока запуск невозможен при любых событиях (пауза, анализы на сегодня закончились) — «после запуска» не показываем
      const after = L.spent + (a.blocked ? 0 : a.cost);
      const today = L.personal ? 'анализов сегодня ' + L.today + ' из ' + L.daily + ' · до ' + usdL(L.perAnalysis) + ' за анализ. ' : '';
      bud = h('div', { class: 'new-sub', style: 'gap:6px' },
        h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, (L.personal ? 'Ваш лимит ИИ на ' : 'Ключ администратора на ') + D.ai.month), h('span', { class: 'num' }, h('b', null, fmt.usd(L.spent)), ' из ' + usdL(L.cap))),
        UI.meter(after, L.cap, after / L.cap > 0.9 ? 'bad' : after / L.cap > 0.7 ? 'warn' : null),
        h('div', { class: 'xsmall muted' }, (a.blocked
          ? (today ? today.charAt(0).toUpperCase() + today.slice(1) : '')
          : 'После запуска ≈ ' + fmt.usd(after) + (L.personal ? ' · ' + today : ' — общий бюджет на всех, кто работает на вашем ключе. ')) + cacheNote));
    }
    const launchBtn = button('Запустить анализ', { kind: 'primary', size: 'lg', icon: 'spark', block: true, disabled: !!a.reason, onClick: launch, attrs: { id: 'new-launch', 'data-fk': 'launch' } });
    return UI.card({
      class: 'new-launch-card', title: 'Перед запуском', subtitle: 'Что уйдет в анализ и сколько это стоит',
      body: [strip, plist, h('hr', { class: 'divider' }), modes, costs, bud, launchBtn,
        a.reason
          ? h('p', { class: 'new-reason', role: 'status' }, icon('alert'), a.reason)
          : h('p', { class: 'xsmall muted' }, 'Займет ' + fmtTime(a.secs) + '. Ставку ИИ не делает: экспресс и сумму вы подтверждаете сами.'),
        // нет ключа или бюджета: администратор решает сам — сразу ссылка туда (участнику — «напишите администратору»)
        a.reason && D.me.role === 'admin' && /«Администрирование → Ключ и бюджет»/.test(a.reason)
          ? button('Открыть «Ключ и бюджет»', { size: 'sm', icon: 'key', href: '#admin-key' }) : null,
        h('a', { class: 'new-link', href: '#costs' }, 'Цена и качество режимов — «ИИ и расходы»', icon('arrowRight'))],
    });
  }

  function flowCard(a) {
    const names = arr => arr.map(p => p.p ? p.p.short : p.name).join(', ');
    const steps = [];
    if (a.stale.length && a.mode.id === 'precise') steps.push(['globe', 'warn', 'Поищем свежие новости', 'Травмы, снятия, мотивация: ' + names(a.stale) + '. Новости остальных игроков моложе 12 часов — возьмем из кэша.']);
    else steps.push(['database', 'accent', 'Новости свежие', 'Новости всех игроков моложе 12 часов — повторный поиск не нужен.']);
    steps.push(['database', '', 'Соберем досье', 'Эло на покрытии, форма, подача и прием за 52 недели, личные встречи и нагрузка — код считает по архиву матчей, без ИИ.']);
    steps.push(['brain', '', 'Оценим вероятности исходов', 'Claude получает досье каждого матча' + (a.mode.id === 'precise' ? ' со свежими новостями' : '') + ' и ' + LESSONS_ON + ' ' + fmt.plural(LESSONS_ON, 'подтвержденный урок', 'подтвержденных урока', 'подтвержденных уроков') + ' и поправляет вероятность модели не больше чем на 10 п.п. — с объяснением.']);
    steps.push(['target', '', 'Сравним с рынком', 'Уберем маржу букмекера и отметим исходы, где оценка модели выше рынка.']);
    steps.push(['ticket', '', 'Соберем экспресс', LEGS + ' ' + fmt.plural(ST.maxLegs, 'событие', 'события', 'событий') + ' с итоговым кэфом ≤ ' + fmt.odds(ST.totalMax) + ' (ординары стратегия не допускает) и сумму по таблице ставок от банка ' + fmt.money(state.bank) + '.']);
    steps.push(['check', '', 'Решение за вами', 'ИИ может ошибаться и сам ставки не делает. Результат вы внесете после матча — на нем модель учится.']);
    return UI.card({
      title: 'Что произойдет после запуска',
      body: h('ol', { class: 'new-flow' }, steps.map(([ic, kind, t, d]) => h('li', null, h('span', { class: ['new-flow-ic', kind] }, icon(ic)), h('div', { class: 'new-flow-body' }, h('b', null, t), h('span', null, d))))),
    });
  }

  // Последние анализы: открыть анализ по номеру после ухода со страницы (в приложении — GET /analyses)
  const RECENT_STATUS = { done: ['Готов', 'good', 'check'], failed: ['Остановлен', 'bad', 'alert'], cancelled: ['Отменен', 'outline', 'x'], running: ['Идет', 'info', 'clock'] };
  function recentCard() {
    const list = (D.recentAnalyses || []).slice(0, 5);
    const when = iso => (iso.slice(0, 10) === D.today ? 'сегодня, ' : fmt.date(iso) + ', ') + iso.slice(11, 16);
    return UI.card({
      class: 'new-recent-card', title: 'Последние анализы', subtitle: 'Откроются с того места, где вы ушли',
      body: list.length
        ? h('ul', { class: 'new-recent' }, list.map(x => {
          const [t, k, i] = RECENT_STATUS[x.status] || RECENT_STATUS.done;
          const sub = '#' + x.id + ' · ' + when(x.at) + (x.status === 'done' ? (x.decision === 'bet' ? ' · ставка сохранена' : ' · без ставки') : x.note ? ' · ' + x.note : '') + ' · ' + fmt.usd(x.cost);
          return h('li', null, h('a', { href: '#analysis-' + x.id, 'aria-label': 'Анализ #' + x.id + ': ' + x.matches.map(D.match).join(', ') + ', ' + t.toLowerCase() },
            h('span', { class: 'new-recent-m' }, x.matches.map(D.match).join(', ')),
            h('span', { class: 'new-recent-s' }, sub),
            chip(t, k, i)));
        }))
        : h('p', { class: 'small muted' }, 'Анализов пока нет.'),
      foot: list.some(x => !x.demo) ? [h('span', { class: 'xsmall muted' }, 'В макете анализы, кроме #' + (list.find(x => x.demo) || { id: '—' }).id + ', открываются на демо-примере.')] : null,
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
    // в правой колонке «Правила стратегии» стоят перед «Последними анализами»
    if (toMain !== inMain) { if (toMain) main.appendChild(rules); else side.insertBefore(rules, side.querySelector('.new-recent-card')); }
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
    keepFocus(refs.side, () => { clear(refs.side); refs.side.append(launchCard(a), flowCard(a)); (rulesInMain ? refs.main : refs.side).appendChild(refs.rules); refs.side.appendChild(recentCard()); });
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
  // #new-m3 — черновик с одним матчем из расписания (кнопка «Анализировать» на главной и в карточке игрока): игроки,
  // турнир и раунд; кэфы участник вписывает сам — линии кэфов нет (Р10). #new-today — так же все матчи дня
  // (кнопка «Все матчи дня в анализ» на главной). Без параметра черновик не трогаем.
  function applyParam(param) {
    if (!param) return;
    const one = D.matchesToday.find(x => x.id === param);
    const ms = one ? [one] : param === 'today' ? D.matchesToday : [];
    if (ms.length) {
      state.tab = 'form'; state.editing.clear(); snapshots.clear();
      state.events = ms.map(m => Object.assign(eventFromToday(m), { odds: {} }));
      // во вкладке «Вставить текстом» — те же матчи текстом, чтобы вкладки не расходились
      setAutoText(() => [
        'Текущий банк: ' + fmt.money(state.bank), 'Букмекер: ' + curBk(), '', 'События:',
      ].concat(ms.map(m => P[m.p1].short + ' vs ' + P[m.p2].short + ', ' + m.tournament + ', ' + (D.surfaces[m.surface] ? D.surfaces[m.surface].label.toLowerCase() : 'хард') + ', ' + m.round.replace(' финала', ''))).join('\n'));
      state.parsedText = state.text;
      state.parse = { bank: null, bankRaw: null, bookmaker: null, unknown: [] };
      UI.toast(one ? 'Добавлен матч ' + P[one.p1].short + ' — ' + P[one.p2].short + ': впишите кэфы своей линии' : 'Добавлены матчи дня (' + ms.length + '): впишите кэфы своей линии', 'calendar');
    }
    // адрес без параметра: повторный заход на экран не сбросит черновик еще раз
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#new'); } catch (e) { /* в песочнице адрес может быть недоступен */ }
  }

  // ---------- экран ----------
  function render(root, param) {
    applyParam(param);
    syncAutoText();
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
          h('p', { class: 'lead' }, 'Вставьте матчи и кэфы свободным текстом или заполните форму. До запуска видно, что понял ИИ, чьи данные устарели и сколько стоит анализ.')),
        steps),
      layout,
      bar,
      h('div', { class: 'new-bar-spacer', 'aria-hidden': 'true' })));
    renderPanel();
    renderSide();
    requestAnimationFrame(() => { const tb = document.querySelector('.tabbar'); if (tb && tb.offsetHeight) bar.style.setProperty('--new-tabbar', tb.offsetHeight + 'px'); });
  }

  UI.register('new', { title: 'Новый анализ', nav: 'new', render });
})();
