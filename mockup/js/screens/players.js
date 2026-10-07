/* Игроки: база игроков (свежесть данных, Эло, форма) и карточка игрока (#player-<id> или #player-<id>-<вкладка>).
   Рейтинг, Эло, форма и статистика — из DATA.players. Последние матчи, оценки 1–10, новости и журнал обновлений
   генерируются здесь детерминированно (сид от id игрока), чтобы карточки выглядели живыми и не расходились между заходами. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip, clear } = UI;
  const D = DATA;
  const NOW = D.today + 'T10:10'; // «сейчас» в демо: утро 7 октября, до первого матча дня
  const SURF = ['hard', 'clay', 'grass'];
  const COST = { batch: 0.015, now: 0.03, collect: 0.05 };

  const COUNTRY = { ITA: 'Италия', ESP: 'Испания', GER: 'Германия', USA: 'США', SRB: 'Сербия', GBR: 'Великобритания', RUS: 'Россия', DEN: 'Дания', AUS: 'Австралия', CZE: 'Чехия', FRA: 'Франция', BUL: 'Болгария', CHI: 'Чили', KAZ: 'Казахстан', NOR: 'Норвегия', GRE: 'Греция' };
  // Статика из шаблонов 01/02 (личные данные, игровой профиль)
  const EXTRA = {
    sinner: { height: 191, best: 1, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
    alcaraz: { height: 183, best: 1, kind: 'Универсальный', pos: 'Универсальная', serveType: 'Комбинированная' },
    zverev: { height: 198, best: 2, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Плоская' },
    fritz: { height: 196, best: 4, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Плоская' },
    djokovic: { height: 188, best: 1, kind: 'Контратакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
    draper: { height: 193, best: 4, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Крученая (кик)' },
    medvedev: { height: 198, best: 1, kind: 'Защитный', pos: 'Задняя линия', serveType: 'Плоская' },
    rune: { height: 188, best: 4, kind: 'Атакующий', pos: 'Универсальная', serveType: 'Комбинированная' },
    deminaur: { height: 183, best: 6, kind: 'Контратакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
    shelton: { height: 193, best: 6, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Плоская' },
    musetti: { height: 185, best: 7, kind: 'Универсальный', pos: 'Универсальная', serveType: 'Комбинированная' },
    rublev: { height: 188, best: 5, kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
  };
  // Средние по туру (топ-50, 52 недели) — для сравнения подачи и приёма
  const TOUR = { first: 62, firstWon: 74, secondWon: 52, aces: 6.6, df: 2.9, speed: 201, firstRet: 30, secondRet: 51, bpConv: 40, bpSaved: 62 };

  // ---------- утилиты ----------
  function rng(str) {
    let s = 0; for (const c of str) s = (Math.imul(s, 31) + c.charCodeAt(0)) | 0;
    return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ts = iso => Date.parse(iso.length === 10 ? iso + 'T12:00:00Z' : iso + ':00Z');
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const signed = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + (d ? fmt.dec(Math.abs(n), d) : fmt.int(Math.abs(n)));
  const initials = name => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  const winsOf = p => p.form.filter(x => x === 'W').length;
  const plural = (n, a, b, c) => n + ' ' + fmt.plural(n, a, b, c);
  const age = p => plural(p.age, 'год', 'года', 'лет');
  // $0,015 / $0,05 — fmt.usd знает только 0–2 знака
  const elo = v => String(Math.round(v)); // рейтинги Эло пишем без разделителя разрядов
  const usd = n => (n < 0.1 && Math.round(n * 1000) % 10 !== 0) ? '$' + fmt.dec(n, 3) : fmt.usd(n);

  function ago(iso) {
    if (!iso) return null;
    const min = Math.round((ts(NOW) - ts(iso)) / 60000);
    if (min < 2) return 'только что';
    if (min < 60) return min + ' мин назад';
    if (min < 23.5 * 60) return Math.round(min / 60) + ' ч назад';
    const d = Math.round(min / 1440);
    return plural(d, 'день', 'дня', 'дней') + ' назад';
  }
  const todayMatch = id => D.matchesToday.find(m => m.p1 === id || m.p2 === id) || null;
  // Подробный разбор в макете есть только для матчей примера (#analysis); для остальных — новый анализ с этим матчем
  const IN_EXAMPLE = ['m1', 'm2'];
  const openLeg = id => { for (const b of D.bets) if (b.status === 'open') for (const l of b.legs) if (l.p1 === id || l.p2 === id) return { bet: b, leg: l }; return null; };
  const eloProb = (a, b) => 1 / (1 + Math.pow(10, -(a - b) / 400));
  const eloRankAll = p => D.players.slice().sort((a, b) => b.elo.all - a.elo.all).indexOf(p) + 1;
  const bestSurface = p => SURF.slice().sort((a, b) => p.elo[b] - p.elo[a])[0];
  const kvWide = pairs => { const el = UI.kv(pairs); el.classList.add('players-kv'); return el; };

  // ---------- состояние модуля ----------
  const jobs = {};               // id → 'queued' (ночной пакет) | 'running' (обновляем сейчас)
  const doneNow = new Set();     // игроки, обновлённые в этой сессии макета
  let redraw = null;             // перерисовка текущего экрана при завершении задач
  const listState = { q: '', fresh: 'all', surface: 'hard', sort: 'rank' };
  const cardTabs = {};           // последняя открытая вкладка карточки по игроку

  function notify() { if (redraw) redraw(); }
  function queueBatch(ids) {
    ids.forEach(id => { if (jobs[id] !== 'running') jobs[id] = 'queued'; });
    UI.toast(ids.length === 1 ? 'Обновление поставлено в очередь (Batch API, −50%)' : plural(ids.length, 'профиль поставлен', 'профиля поставлены', 'профилей поставлены') + ' в очередь (Batch API, −50%)', 'clock');
    notify();
  }
  function runNow(ids, done) {
    let cost = 0;
    ids.forEach(id => { jobs[id] = 'running'; cost += D.P[id].fresh === 'missing' ? COST.collect : COST.now; });
    notify();
    ids.forEach((id, k) => setTimeout(() => {
      const p = D.P[id];
      p.fresh = 'fresh'; p.updated = NOW; delete jobs[id]; doneNow.add(id);
      if (k === ids.length - 1) {
        UI.toast(ids.length === 1 ? 'Профиль обновлён: ' + p.short + ' · ' + fmt.usd(cost) : 'Готово: ' + plural(ids.length, 'профиль обновлён', 'профиля обновлены', 'профилей обновлены') + ' · ' + fmt.usd(cost), 'check');
        done && done();
      }
      notify();
    }, 1300 + k * 900));
  }

  // ---------- генерация данных карточки ----------
  const R7 = ['1/64', '1/32', '1/16', '1/8', '1/4', '1/2', 'Финал'];
  const R5 = ['1/16', '1/8', '1/4', '1/2', 'Финал'];
  const EVENTS = [
    { name: 'Шанхай', cat: 'Masters 1000', surface: 'hard', live: true, rounds: R7, start: 1, dates: { '1/32': '2026-10-04', '1/16': '2026-10-05' } },
    { name: 'Пекин', alt: 'Токио', cat: 'ATP 500', surface: 'hard', from: '2026-09-24', to: '2026-10-01', rounds: R5, start: 0 },
    { name: 'US Open', cat: 'Grand Slam', surface: 'hard', from: '2026-08-24', to: '2026-09-13', rounds: R7, start: 0, bo5: true, must: true },
    { name: 'Цинциннати', cat: 'Masters 1000', surface: 'hard', from: '2026-08-14', to: '2026-08-23', rounds: R7, start: 1 },
    { name: 'Торонто', cat: 'Masters 1000', surface: 'hard', from: '2026-08-03', to: '2026-08-13', rounds: R7, start: 1 },
    { name: 'Вашингтон', cat: 'ATP 500', surface: 'hard', from: '2026-07-27', to: '2026-08-02', rounds: R5, start: 0 },
    { name: 'Гамбург', cat: 'ATP 500', surface: 'clay', from: '2026-07-19', to: '2026-07-26', rounds: R5, start: 0 },
    { name: 'Уимблдон', cat: 'Grand Slam', surface: 'grass', from: '2026-07-01', to: '2026-07-12', rounds: R7, start: 0, bo5: true, must: true },
  ];
  const OTHERS = [
    ['Рууд', 'NOR', 10], ['Пол', 'USA', 13], ['Умбер', 'FRA', 16], ['Тиафо', 'USA', 17], ['Бублик', 'KAZ', 18], ['Махач', 'CZE', 19], ['Хачанов', 'RUS', 20],
    ['Легечка', 'CZE', 22], ['Коболли', 'ITA', 23], ['Попырин', 'AUS', 24], ['Циципас', 'GRE', 26], ['Фис', 'FRA', 27], ['Мпетши Перрикар', 'FRA', 29],
    ['Корда', 'USA', 31], ['Харри', 'CHI', 33], ['Димитров', 'BUL', 35], ['Мунар', 'ESP', 38], ['Сонего', 'ITA', 41],
  ];
  const SCORES = {
    W3: ['6:4 6:3', '7:6(4) 6:4', '6:3 7:5', '4:6 6:3 6:4', '6:2 6:4', '7:5 6:7(5) 6:3', '6:3 6:2', '7:6(5) 7:6(3)'],
    L3: ['4:6 3:6', '6:7(4) 4:6', '6:4 3:6 5:7', '3:6 7:6(5) 4:6', '5:7 4:6', '6:7(6) 6:7(4)'],
    W5: ['6:4 6:2 6:3', '7:6(5) 6:4 6:4', '6:3 4:6 6:2 6:4', '6:4 6:7(3) 7:5 6:3', '6:2 6:3 6:1'],
    L5: ['4:6 6:7(4) 4:6', '6:3 4:6 6:7(5) 4:6', '7:6(2) 4:6 3:6 4:6', '3:6 6:4 6:4 3:6 4:6'],
  };

  // Соперники по неделям: в одну неделю один и тот же соперник не встречается у двух разных игроков базы
  // (иначе «оба обыграли Фиса в 1/32 4 октября»). Матчи всех игроков считаются разом и в фиксированном порядке,
  // поэтому карточка не зависит от того, какую открыли первой. Первыми идут игроки матчей из примера анализа —
  // их соперников (Тиафо и Мунар у Руне) называет экран «Анализ».
  const EXTRA_OTHERS = [['Хуркач', 'POL', 15], ['Меншик', 'CZE', 21], ['Давидович Фокина', 'ESP', 25], ['Шаповалов', 'CAN', 28], ['Фонсека', 'BRA', 30], ['Михельсен', 'USA', 32], ['Норри', 'GBR', 34], ['Табило', 'CHI', 36]];
  const OPP_POOL = OTHERS.concat(EXTRA_OTHERS);
  const WEEK_TAKEN = EVENTS.map(() => new Set());
  const GEN_ORDER = ['rune', 'sinner', 'djokovic', 'rublev'].concat(D.players.map(x => x.id)).filter((id, i, a) => a.indexOf(id) === i && D.P[id]);
  let matchesAll = null;
  function matchesOf(p) {
    if (!matchesAll) { matchesAll = {}; GEN_ORDER.forEach(id => { matchesAll[id] = genMatches(D.P[id]); }); }
    return matchesAll[p.id] || genMatches(p);
  }

  const cache = {};
  function info(p) {
    if (cache[p.id]) return cache[p.id];
    const o = { matches: matchesOf(p) };
    o.ratings = genRatings(p);
    o.psych = genPsych(p);
    o.state = genState(p, o.matches);
    o.news = genNews(p, o.matches);
    o.vs = genVs(p);
    o.staticAt = ['2026-09-28T04:05', '2026-09-21T04:05', '2026-09-14T04:05'][Math.floor(rng(p.id + ':s')() * 3)];
    return (cache[p.id] = o);
  }

  // Неделя Шанхая: исходы, известные по рассчитанным ставкам из DATA (кто кого обыграл и когда),
  // чтобы карточка игрока не спорила с историей ставок. Форы ±1.5 с неизвестным победителем пропускаем.
  function shanghaiFromBets(pid) {
    const out = [];
    D.bets.forEach(b => {
      if (b.date < '2026-10-02' || b.status === 'open') return;
      b.legs.forEach(l => {
        if (l.p1 !== pid && l.p2 !== pid) return;
        const win = l.market === 'p1' ? (l.result === 'win' ? 'p1' : 'p2') : l.market === 'p2' ? (l.result === 'win' ? 'p2' : 'p1')
          : l.market === 'h1m' && l.result === 'win' ? 'p1' : l.market === 'h2p' && l.result === 'loss' ? 'p1' : null;
        if (!win || l.result === 'void') return;
        const side = l.p1 === pid ? 'p1' : 'p2', o = l[side === 'p1' ? 'p2' : 'p1'];
        const P = D.P[o], x = OTHERS.find(y => y[0] === o);
        out.push({ date: b.date, res: win === side ? 'W' : 'L', straight: l.market !== 'p1' && l.market !== 'p2',
          opp: P ? { id: P.id, name: P.short, cc: P.country, rank: P.rank } : x ? { name: x[0], cc: x[1], rank: x[2] } : { name: o } });
      });
    });
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  // Все, кто играл в Шанхае по ставкам этой недели: случайным соперником в Шанхае их не ставим, чтобы сетка не спорила с историей ставок
  const SH_BET_NAMES = new Set(D.bets.filter(b => b.date >= '2026-10-02' && b.status !== 'open').flatMap(b => b.legs.flatMap(l => [l.p1, l.p2])));

  function genMatches(p) {
    const r = rng(p.id + ':m');
    const form = p.form, out = [], used = new Set();
    const known = shanghaiFromBets(p.id);
    known.forEach(k => { used.add(k.opp.id || k.opp.name); WEEK_TAKEN[0].add(k.opp.id || k.opp.name); });
    const plays = !!todayMatch(p.id);
    const tops = D.players.filter(x => x.id !== p.id);
    // Случайный выбор — как раньше (тот же расход генератора, чтобы остальные цифры карточки не менялись);
    // если соперник на этой неделе уже занят другим игроком базы — берём следующего свободного по списку.
    const pickOpp = (strong, live, week) => {
      const taken = WEEK_TAKEN[week] || new Set();
      for (let t = 0; t < 40; t++) {
        if (strong) {
          const k = Math.floor(r() * tops.length), x = tops[k];
          if (used.has(x.id) || (plays && todayMatch(x.id))) continue;
          used.add(x.id);
          let y = x;
          for (let s2 = 1; taken.has(y.id) && s2 < tops.length; s2++) { const c = tops[(k + s2) % tops.length]; if (!used.has(c.id) && !(plays && todayMatch(c.id)) && !taken.has(c.id)) y = c; }
          used.add(y.id); taken.add(y.id);
          return { id: y.id, name: y.short, cc: y.country, rank: y.rank };
        } else {
          const k = Math.floor(r() * OTHERS.length), x = OTHERS[k];
          if (used.has(x[0]) || (live && SH_BET_NAMES.has(x[0]))) continue;
          used.add(x[0]);
          let y = x;
          for (let s2 = 1; taken.has(y[0]) && s2 < OPP_POOL.length; s2++) { const c = OPP_POOL[(k + s2) % OPP_POOL.length]; if (!used.has(c[0]) && !(live && SH_BET_NAMES.has(c[0])) && !taken.has(c[0])) y = c; }
          used.add(y[0]); taken.add(y[0]);
          return { name: y[0], cc: y[1], rank: y[2] };
        }
      }
      return { name: OTHERS[0][0], cc: OTHERS[0][1], rank: OTHERS[0][2] };
    };
    let i = 0;
    for (let week = 0; week < EVENTS.length; week++) {
      const ev0 = EVENTS[week];
      if (i >= form.length) break;
      const ev = Object.assign({}, ev0);
      if (ev.alt && r() < 0.4) ev.name = ev.alt;
      if (!ev.live && !ev.must && r() < 0.22) continue;
      const max = ev.rounds.length - ev.start;
      const runW = from => { let w = 0; while (from + w < form.length && form[from + w] === 'W') w++; return w; };
      let k, wo = false;
      if (ev.live) {
        if (form[i] === 'W') { k = Math.min(2, runW(i)); if (plays && k === 1) wo = true; }
        else if (plays) continue; // в макете у такого игрока Шанхай не показываем
        else k = 1 + Math.min(1, runW(i + 1));
      } else if (form[i] === 'L') k = 1 + Math.min(max - 1, runW(i + 1));
      else k = Math.min(max, runW(i));
      for (let j = 0; j < k; j++) {
        const ri = ev.start + (k - 1 - j) + (wo ? 1 : 0);
        const round = ev.rounds[ri];
        const date = ev.live ? ev.dates[round] : addDays(ev.from, Math.round((ts(ev.to) - ts(ev.from)) / 864e5 * (ri + 1) / ev.rounds.length));
        const res = form[i + j];
        const strong = ri >= ev.rounds.length - 3 && !ev.live;
        // матч этой недели, известный по ставке: сначала по дате, а если в Шанхае у игрока один матч — по исходу
        const kn = ev.live ? (known.find(x => !x.taken && x.res === res && x.date === date) || (k === 1 ? known.find(x => !x.taken && x.res === res) : null)) : null;
        if (kn) kn.taken = true;
        const pool0 = SCORES[(res === 'W' ? 'W' : 'L') + (ev.bo5 ? 5 : 3)];
        const pool = kn && kn.straight ? pool0.filter(x => x.split(' ').length === 2) : pool0; // фора ±1.5 сыграла — значит, в двух сетах
        let score = pool[Math.floor(r() * pool.length)];
        if (out.length && out[out.length - 1].score === score) score = pool[(pool.indexOf(score) + 1) % pool.length];
        const aces = Math.max(0, Math.round(p.serve.aces * (ev.bo5 ? 1.4 : 1) + (r() - 0.5) * 6));
        const firstPct = Math.round(p.serve.first + (r() - 0.5) * 10);
        out.push({ date: kn ? kn.date : date, event: ev.name, cat: ev.cat, surface: ev.surface, round, res, opp: kn ? kn.opp : pickOpp(strong, ev.live, week), score, aces, firstPct, bo5: !!ev.bo5 });
      }
      if (wo) out.push({ date: '2026-10-04', event: ev.name, cat: ev.cat, surface: ev.surface, round: '1/32', wo: true, opp: pickOpp(false, true, week) });
      i += k;
    }
    return out;
  }

  const SINNER_RATINGS = {
    phys: [['Скорость', 9], ['Выносливость', 8], ['Взрывная сила', 9], ['Гибкость', 9], ['Реакция', 9]],
    tech: [['Сила подачи', 8], ['Точность подачи', 8], ['Второй мяч', 8], ['Форхенд', 9], ['Бэкхенд', 10], ['Задняя линия', 10], ['Игра у сетки', 7], ['Приём подачи', 9], ['Укороченный', 6]],
    strong: ['Бэкхенд по линии с любой позиции', 'Темп и глубина с задней линии', 'Приём второй подачи'],
    weak: ['Укороченные и игра у сетки — реже, чем у топ-5', 'Медленный старт первого сета против левшей'],
  };
  function genRatings(p) {
    if (p.id === 'sinner') return SINNER_RATINGS;
    const r = rng(p.id + ':r');
    const base = 5 + (p.elo.all - 1900) / 80;
    const j = (b, s = 1) => clamp(Math.round(b + (r() - 0.5) * 2 * s), 3, 10);
    const serveP = 5 + (p.serve.speed - 196) / 4 + (p.serve.aces - 6) / 2;
    const ret = 5 + (p.ret.firstRet - 28) * 0.7 + (p.ret.secondRet - 50) * 0.3;
    const o = {
      phys: [['Скорость', j(base + (p.id === 'deminaur' ? 3 : 0))], ['Выносливость', j(base + (p.id === 'medvedev' ? 1.5 : 0))], ['Взрывная сила', j(base)], ['Гибкость', j(base - 0.6)], ['Реакция', j(base)]],
      tech: [['Сила подачи', j(serveP, 0.4)], ['Точность подачи', j((serveP + base) / 2)], ['Второй мяч', j(5 + (p.serve.secondWon - 50) * 0.6, 0.5)], ['Форхенд', j(base + 0.4)], ['Бэкхенд', j(base - 0.2 + (p.backhand === 'одноручный' ? 0.8 : 0))],
        ['Задняя линия', j(base + 0.3)], ['Игра у сетки', j(base - 1.4 + (p.id === 'alcaraz' ? 2 : 0))], ['Приём подачи', j(ret, 0.4)], ['Укороченный', j(base - 1.6 + (['alcaraz', 'musetti'].includes(p.id) ? 3 : 0))]],
    };
    const tech = o.tech.slice().sort((a, b) => b[1] - a[1]);
    const PH = { 'Сила подачи': 'Мощная первая подача', 'Точность подачи': 'Точная подача в углы', 'Второй мяч': 'Надёжный второй мяч', 'Форхенд': 'Форхенд — главный удар', 'Бэкхенд': 'Стабильный бэкхенд', 'Задняя линия': 'Длинные розыгрыши с задней линии', 'Игра у сетки': 'Уверенная игра у сетки', 'Приём подачи': 'Сильный приём', 'Укороченный': 'Укороченные удары' };
    const WK = { 'Сила подачи': 'Подача без «бесплатных» очков', 'Точность подачи': 'Нестабильный процент первой подачи', 'Второй мяч': 'Атакуемая вторая подача', 'Форхенд': 'Форхенд ломается под давлением', 'Бэкхенд': 'Бэкхенд на высоких мячах', 'Задняя линия': 'Проигрывает длинные розыгрыши', 'Игра у сетки': 'Редко и неуверенно выходит к сетке', 'Приём подачи': 'Слабый приём против подающих', 'Укороченный': 'Почти не использует укороченные' };
    o.strong = tech.slice(0, 3).map(x => PH[x[0]]);
    o.weak = tech.slice(-2).map(x => WK[x[0]]);
    return o;
  }

  function genPsych(p) {
    const r = rng(p.id + ':p');
    const base = p.id === 'sinner' ? 9 : 5 + (p.elo.all - 1900) / 80;
    const hot = ['rune', 'rublev', 'medvedev'].includes(p.id) ? 2 : 0;
    const j = (b, s = 0.8) => clamp(Math.round(b + (r() - 0.5) * 2 * s), 2, 10);
    const type = hot ? (base >= 6.2 ? 'Умеренно стабильный' : 'Нестабильный') : base >= 7.8 ? 'Стабильный' : base >= 6 ? 'Умеренно стабильный' : 'Нестабильный';
    const ratings = [['Эмоциональная стабильность', j(base - hot)], ['Игра под давлением', j(base - hot / 2)], ['Концентрация в важных геймах', j(base)], ['Реакция на свои ошибки', j(base - 0.4 - hot)], ['Мотивация и самодисциплина', j(base + 0.6)], ['Реакция на трибуны', j(base - 0.3)]];
    if (p.id === 'sinner') { ratings.forEach((x, k) => { x[1] = [9, 9, 9, 8, 10, 8][k]; }); }
    const tbTotal = p.id === 'sinner' ? 30 : 18 + Math.floor(r() * 14);
    const tbW = p.id === 'sinner' ? 21 : Math.round(tbTotal * clamp(0.42 + (base - 5) * 0.05 + (r() - 0.5) * 0.08, 0.35, 0.72));
    const hold = p.id === 'sinner' ? 27 : clamp(Math.round(14 + (base - 5) * 3 + r() * 4), 10, 30);
    const setN = 8 + Math.floor(r() * 8), setW = p.id === 'sinner' ? 9 : Math.round(setN * clamp(0.22 + (base - 5) * 0.07, 0.15, 0.68));
    const setTotal = p.id === 'sinner' ? 14 : setN;
    const tbPct = Math.round(tbW / tbTotal * 100);
    const patterns = [
      { k: 'На тай-брейке', stat: tbW + '–' + (tbTotal - tbW) + ' за 52 недели (' + tbPct + '%)',
        text: tbPct >= 62 ? 'Играет первым номером, на своей подаче рискует вторым мячом. Тай-брейки — скорее плюс.' : tbPct >= 50 ? 'Ровно, без явного перекоса: тай-брейк для него почти лотерея.' : 'Отдаёт инициативу и чаще ошибается с задней линии. Против сильных подающих это минус.' },
      { k: 'При 0:40 на своей подаче', stat: 'отыгрывает гейм в ' + hold + '% (тур — 19%)',
        text: hold >= 24 ? 'Поднимает процент первой подачи и играет на счёт, а не на эффект.' : hold >= 17 ? 'Ведёт себя как средний игрок тура: без провалов, но и без «чудес».' : 'Часто торопится и отдаёт гейм двойной или невынужденной ошибкой.' },
      { k: 'После проигранного первого сета', stat: 'выиграл ' + setW + ' из ' + setTotal + ' матчей',
        text: setW / setTotal >= 0.5 ? 'Быстро перестраивается, во втором сете меняет направление ударов.' : 'Эмоционально «проседает»: второй сет часто проигрывает с брейком в начале.' },
      { k: 'Под давлением трибун и судьи', stat: type.toLowerCase(),
        text: hot ? 'Спорит с судьёй и ракеткой, после эмоциональных эпизодов бывает серия проигранных очков.' : 'Спокоен, на решения судьи почти не реагирует.' },
    ];
    return { type, ratings, patterns };
  }

  // Против топ-10, решающие сеты; личные встречи считаются от пары, чтобы обе карточки совпадали
  function genVs(p) {
    const r = rng(p.id + ':v');
    const base = p.id === 'sinner' ? 9.2 : 5 + (p.elo.all - 1900) / 80;
    const tN = 8 + Math.floor(r() * 10), dN = 8 + Math.floor(r() * 9);
    return {
      top10: p.id === 'sinner' ? [14, 4] : (w => [w, tN - w])(Math.round(tN * clamp(0.18 + (base - 5) * 0.11, 0.1, 0.8))),
      decider: p.id === 'sinner' ? [11, 3] : (w => [w, dN - w])(Math.round(dN * clamp(0.36 + (base - 5) * 0.06, 0.2, 0.8))),
    };
  }
  function h2h(a, b) {
    const [x, y] = [a, b].sort((u, v) => u.id.localeCompare(v.id));
    const r = rng('h2h:' + x.id + ':' + y.id);
    const n = 3 + Math.floor(r() * 5);
    const xw = clamp(Math.round(n * eloProb(x.elo.all, y.elo.all) + (r() - 0.5)), 0, n);
    const hn = Math.max(1, Math.round(n * 0.6)), hxw = clamp(Math.round(hn * eloProb(x.elo.hard, y.elo.hard)), 0, hn);
    const lastX = r() < eloProb(x.elo.hard, y.elo.hard);
    // последняя встреча — до окна списка матчей (июль–октябрь 2026), чтобы не спорить с вкладкой «Матчи»
    const last = ['Вена 2025, 1/2', 'Майами 2026, 1/4', 'Пекин 2025, 1/4', 'Индиан-Уэллс 2026, 1/8'][Math.floor(r() * 4)];
    const mine = a === x;
    return { w: mine ? xw : n - xw, l: mine ? n - xw : xw, hw: mine ? hxw : hn - hxw, hl: mine ? hn - hxw : hxw, last, lastWon: mine ? lastX : !lastX };
  }

  function genState(p, matches) {
    const played = matches.filter(m => !m.wo);
    const last = played[0];
    const m14 = played.filter(m => m.date >= addDays(D.today, -14)).length;
    const rest = last ? Math.round((ts(D.today) - ts(last.date)) / 864e5) - 1 : null;
    const fatigue = m14 >= 6 ? ['Высокая', 'bad'] : m14 >= 4 ? ['Умеренная', 'warn'] : ['Свежий', 'good'];
    const motivation = p.rank <= 2 ? 'Высокая · борьба за №1' : p.rank <= 10 ? 'Высокая · Итоговый турнир' : 'Средняя';
    return { last, m14, rest, fatigue, motivation, health: p.id === 'medvedev' ? ['Лёгкое недомогание', 'warn'] : ['Здоров', 'good'] };
  }

  function genNews(p, matches) {
    const last = matches.find(m => !m.wo);
    const s = p.short;
    if (p.id === 'sinner') return [
      { date: '2026-10-06', src: 'atptour.com', text: 'Синнер после 1/16: «Корт заметно быстрее, чем в Пекине, подача работает лучше». Оба матча в Шанхае — в двух сетах.', impact: true, why: 'Учтено: на быстром корте вес подачи выше, тай-брейки вероятнее', quote: '“The court is quicker than in Beijing, I can use my serve more,” Sinner said after his third-round win.' },
      { date: '2026-10-05', src: 'tennis.com', text: 'Статистика турнира: на центральных кортах Шанхая эйсов на 18% больше, чем в 2025 году.', impact: true, why: 'Учтено для всех матчей турнира', quote: 'Aces per service game are up 18% year-on-year on Stadium Court and Grand Stand.' },
      { date: '2026-10-04', src: 'x.com', text: 'Пост болельщика с видео тренировки: Синнер якобы держался за бедро после спринта. Официальных сообщений нет, на следующий день — полная тренировка.', impact: false, why: 'Нет подтверждения турнира или команды — по уроку L-019 не учитываем', quote: 'Fan video, 14 s. No statement from the player team or tournament doctor.' },
      { date: '2026-10-01', src: 'ubitennis.com', text: 'Синнер снялся с Пекина после первого круга, чтобы восстановиться к Шанхаю.', impact: true, why: 'Учтено в состоянии: 3 матча за 14 дней — свежий', quote: 'Sinner ha deciso di ritirarsi da Pechino dopo il primo turno per preparare Shanghai.' },
    ];
    const inShanghai = last && last.event === 'Шанхай' && last.res === 'W';
    const ru = p.country === 'RUS';
    return [
      inShanghai
        ? { date: last.date, src: 'atptour.com', text: s + ' вышел в 1/8 финала Шанхая (' + last.score + ', соперник — ' + last.opp.name + ').', impact: true, why: 'Учтено в форме и усталости', quote: s + ' advanced to the fourth round with a ' + last.score.replace(/:/g, '-') + ' win.' }
        : { date: last ? last.date : '2026-10-05', src: 'atptour.com', text: s + (last ? ' проиграл в ' + last.round + ' ' + (last.event === 'Шанхай' ? 'Шанхая' : 'турнира') + ' (' + last.score + ')' : ' не сыграл в Шанхае') + '. Следующий турнир — Вена, ATP 500, крытый хард, с 19 окт.', impact: false, why: 'Матчей в ближайшие дни нет', quote: 'Next: Erste Bank Open, Vienna (ATP 500, indoor hard).' },
      { date: '2026-10-05', src: 'tennis.com', text: 'Статистика турнира: на центральных кортах Шанхая эйсов на 18% больше, чем в 2025 году.', impact: true, why: 'Учтено для всех матчей турнира', quote: 'Aces per service game are up 18% year-on-year on Stadium Court and Grand Stand.' },
      { date: '2026-10-04', src: 'x.com', text: 'Пост болельщика: ' + s + ' якобы жаловался на плечо на тренировке. Официальных сообщений нет.', impact: false, why: 'Нет подтверждения турнира или команды — по уроку L-019 не учитываем', quote: 'Unverified fan post, no statement from the team.' },
      { date: '2026-09-30', src: ru ? 'sports.ru' : 'tennisworld.com', text: 'Интервью: ' + s + ' назвал цель осени — ' + (p.rank <= 10 ? 'отобраться в Итоговый турнир в Турине.' : 'вернуться в топ-10 к концу сезона.'), impact: p.rank <= 10, why: p.rank <= 10 ? 'Учтено слабо: мотивация «высокая»' : 'На конкретный матч не влияет', quote: 'Interview, ' + (ru ? 'на русском' : 'in English') + ', 6 min read.' },
    ];
  }

  // ---------- стили ----------
  UI.css('players', `
    .players-head h2 { font-size: var(--fs-2xl); }
    .players-link { color: var(--fg); font-weight: 600; text-decoration: none; }
    .players-link:hover { color: var(--accent-ink); text-decoration: underline; }
    .players-sub { font-size: var(--fs-xs); color: var(--fg-3); display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .players-cc { font-family: var(--font-mono); font-size: 11px; padding: 1px 5px; border-radius: 4px; background: var(--surface-2); color: var(--fg-2); line-height: 1.4; }
    .players-name { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .players-cell-2 { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .players-cell-2 small { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .players-form { display: inline-flex; align-items: center; gap: 8px; white-space: nowrap; }
    .players-today-tag { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-ink); font-weight: 600; white-space: nowrap; }
    .players-today-tag svg { width: 13px; height: 13px; }
    .players-count { margin-left: 6px; font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }

    .players-tiles > .card .stat-value { font-variant-numeric: tabular-nums; }
    .players-filters { display: flex; flex-wrap: wrap; gap: 12px 16px; align-items: flex-end; padding: 16px 18px; border-bottom: 1px solid var(--line); }
    .players-search { flex: 1 1 180px; max-width: 300px; min-width: 160px; }
    .players-search .input { padding-left: 38px; }
    .players-search-ic { position: absolute; left: 12px; width: 18px; height: 18px; color: var(--fg-3); pointer-events: none; }
    .players-fgroup { display: flex; flex-direction: column; gap: 6px; min-width: 0; max-width: 100%; }
    .players-flabel { font-size: var(--fs-sm); font-weight: 500; color: var(--fg-2); }
    .players-fgroup .segmented { height: 42px; align-items: stretch; }
    .players-fgroup .select { min-width: 176px; }
    .players-table td { vertical-align: middle; }
    .players-table .btn { white-space: nowrap; }
    .players-results-foot { display: flex; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; align-items: center; font-size: var(--fs-sm); color: var(--fg-3); }

    .players-item { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-bottom: 1px solid var(--line); cursor: pointer; min-width: 0; }
    .players-item:last-child { border-bottom: 0; }
    .players-item:hover { background: var(--surface-2); }
    .players-item-top, .players-item-bot { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
    .players-item-bot { align-items: center; }
    .players-item-mid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; gap: 10px; padding: 10px 12px; background: var(--surface-2); border-radius: var(--r-md); }
    .players-mini { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .players-mini-l { font-size: 11px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .players-mini-v { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .players-mini-v small { font-weight: 400; color: var(--fg-3); font-size: 11px; margin-left: 4px; }

    .players-sources { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 18px; }
    .players-source { display: flex; gap: 12px; min-width: 0; }
    .players-source-ic { width: 36px; height: 36px; border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; flex: none; }
    .players-source-ic svg { width: 18px; height: 18px; }
    .players-source h4 { font-size: var(--fs-sm); margin-bottom: 4px; }
    .players-source p { font-size: var(--fs-sm); color: var(--fg-2); }

    .players-hero-top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px 20px; align-items: center; padding: 20px; }
    .players-avatar { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); font-family: var(--font-display); font-weight: 700; font-size: 1.375rem; flex: none; }
    .players-hero-id { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .players-hero-id h2 { font-size: var(--fs-2xl); }
    .players-meta { color: var(--fg-2); font-size: var(--fs-sm); }
    .players-hero-status { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; text-align: right; min-width: 0; }
    .players-hero-status small { font-size: var(--fs-xs); color: var(--fg-3); }
    .players-hero-st { display: flex; flex-direction: column; gap: 4px; align-items: flex-end; min-width: 0; }
    .players-hero-stats { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); border-top: 1px solid var(--line); }
    .players-hero-stats > div { padding: 14px 20px; border-left: 1px solid var(--line); min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .players-hero-stats > div:first-child { border-left: 0; }
    .players-hs-l { font-size: var(--fs-xs); color: var(--fg-3); }
    .players-hs-v { font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.01em; font-variant-numeric: tabular-nums; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
    .players-hs-s { font-size: var(--fs-xs); color: var(--fg-2); }
    .players-today { display: flex; align-items: center; gap: 10px 14px; flex-wrap: wrap; padding: 12px 20px; border-top: 1px solid var(--line); background: var(--surface-2); border-radius: 0 0 var(--r-lg) var(--r-lg); font-size: var(--fs-sm); }
    .players-today > svg { width: 18px; height: 18px; color: var(--accent-ink); flex: none; }
    .players-today-text { flex: 1 1 280px; min-width: 0; }
    .players-today a.chip { text-decoration: none; }

    .tabs.players-tabs { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 2px; }
    .tabs.players-tabs button { min-width: 0; min-height: 44px; padding: 10px 2px; font-size: var(--fs-sm); text-align: center; overflow: hidden; text-overflow: ellipsis; }
    .players-tabpanel { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .players-hint { font-size: var(--fs-xs); color: var(--fg-3); }
    .players-kv { grid-template-columns: max-content minmax(0, 1fr); }
    .players-vs { display: flex; flex-direction: column; gap: 10px; padding: 14px 18px 18px; border-top: 1px solid var(--line); }
    .players-flush { margin: 0 -18px -18px; min-width: 0; }
    .players-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 4px 32px; }
    .players-metrics-col { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .players-metric { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; min-width: 0; }
    .players-metric-top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: var(--fs-sm); min-width: 0; }
    .players-metric-label { color: var(--fg-2); min-width: 0; }
    .players-metric-val { font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; display: inline-flex; align-items: baseline; gap: 8px; }
    .players-metric-delta { font-size: var(--fs-xs); font-weight: 600; display: inline-flex; align-items: center; gap: 2px; }
    .players-metric-delta svg { width: 12px; height: 12px; align-self: center; }
    .players-metric-delta.flat { color: var(--fg-3); font-weight: 500; }
    .players-bullet { position: relative; height: 8px; border-radius: 999px; background: var(--surface-3); }
    .players-bullet > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; background: var(--s1); }
    .players-bullet > b { position: absolute; top: -4px; bottom: -4px; width: 2px; margin-left: -1px; background: var(--fg); border-radius: 1px; }
    .players-tick-key { display: inline-block; width: 2px !important; height: 12px !important; background: var(--fg); border-radius: 1px; }

    .players-formbig { display: flex; gap: 5px; flex-wrap: wrap; }
    .players-formbig span { width: 26px; height: 26px; border-radius: 6px; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
    .players-formbig span.w { background: var(--good-soft); color: var(--good-ink); }
    .players-formbig span.l { background: var(--bad-soft); color: var(--bad-ink); }
    .players-formbig span:first-child { box-shadow: inset 0 0 0 1.5px currentColor; }
    .players-wl-meter { display: flex; align-items: center; gap: 10px; justify-content: flex-end; }
    .players-wl-meter .meter { width: 72px; flex: none; }

    .players-rate { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr) 2rem; gap: 12px; align-items: center; font-size: var(--fs-sm); padding: 3px 0; }
    .players-rate-l { color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .players-rate-v { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
    .players-meta-line { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); margin-top: auto; padding-top: 4px; }
    .players-meta-line svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .players-meta-line span { min-width: 0; }
    .players-fill > .card-body { flex: 1 1 auto; }
    .players-rate.stacked { grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; padding: 4px 0; }
    .players-rate.stacked .players-rate-l { white-space: normal; }
    .players-rate.stacked .meter { grid-column: 1 / -1; grid-row: 2; }
    .players-patterns { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .players-pattern { padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .players-pattern h4 { font-size: var(--fs-sm); }
    .players-pattern .mono { font-size: var(--fs-xs); color: var(--accent-ink); }
    .players-pattern p { font-size: var(--fs-sm); color: var(--fg-2); }
    .players-bullets { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); }
    .players-bullets li { display: flex; gap: 8px; align-items: flex-start; min-width: 0; }
    .players-bullets li svg { width: 16px; height: 16px; flex: none; margin-top: 2px; }

    .players-news-item { display: grid; grid-template-columns: 7rem minmax(0, 1fr) auto; gap: 6px 18px; padding: 14px 18px; border-top: 1px solid var(--line); align-items: start; }
    .players-news-when { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); min-width: 0; }
    .players-news-src { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); }
    .players-news-src svg { width: 12px; height: 12px; }
    .players-news-body { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .players-news-why { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--fg-2); }
    .players-quote { margin: 0; padding: 10px 14px; border-left: 3px solid var(--line-strong); background: var(--surface-2); border-radius: 0 var(--r-sm) var(--r-sm) 0; font-size: var(--fs-sm); color: var(--fg-2); font-style: italic; }

    .players-mrow { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-top: 1px solid var(--line); min-width: 0; }
    .players-mrow-line { display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0; font-size: var(--fs-sm); }
    .players-mrow-line > span:first-child { min-width: 0; }
    .players-wo td, .players-mrow.players-wo { color: var(--fg-3); }
    .players-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .players-strip > div { background: var(--surface); padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .players-strip b { font-family: var(--font-display); font-size: var(--fs-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .players-strip span { font-size: var(--fs-xs); color: var(--fg-3); }

    .players-collect { align-items: center; text-align: center; padding: 28px 20px; gap: 14px; }
    .players-collect-ic { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--warn-soft); color: var(--warn-ink); }
    .players-collect-ic svg { width: 26px; height: 26px; }
    .players-collect p { max-width: 62ch; color: var(--fg-2); }
    .players-steps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; width: 100%; text-align: left; }
    .players-step { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border: 1px solid var(--line); border-radius: var(--r-md); min-width: 0; }
    .players-step-ic { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-3); flex: none; }
    .players-step-ic svg { width: 15px; height: 15px; }
    .players-step.done .players-step-ic { background: var(--good-soft); color: var(--good-ink); }
    .players-step.run .players-step-ic { background: var(--info-soft); color: var(--info-ink); }
    .players-step.run .players-step-ic svg { animation: players-spin 1s linear infinite; }
    .players-step b { display: block; font-size: var(--fs-sm); }
    .players-step small { display: block; font-size: var(--fs-xs); color: var(--fg-3); }
    @keyframes players-spin { to { transform: rotate(360deg); } }
    .players-hist-src { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .players-hist-src svg { width: 14px; height: 14px; color: var(--fg-3); }
    .players-runs { display: flex; flex-direction: column; }
    .players-run { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--line); font-size: var(--fs-sm); min-width: 0; }
    .players-run:last-child { border-bottom: 0; }
    .players-run > div { min-width: 0; }
    .players-fieldset { border: 0; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
    .players-fieldset legend { padding: 0; margin-bottom: 8px; }
    .players-notfound { align-items: center; text-align: center; padding: 40px 20px; gap: 12px; }
    .players-notfound-ic { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-3); }
    .players-notfound-ic svg { width: 26px; height: 26px; }

    @media (max-width: 1180px) {
      .players-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .players-steps { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .players-head h2 { font-size: var(--fs-xl); }
      .players-flush { margin: 0 -14px -14px; }
      .players-vs { padding: 12px 14px 14px; }
      .players-filters { padding: 14px; gap: 12px; }
      .players-search { max-width: none; flex-basis: 100%; }
      .players-fgroup { flex: 1 1 100%; }
      .players-fgroup.players-half { flex: 1 1 0; }
      .players-fgroup .segmented { width: 100%; }
      .players-fgroup .segmented button { flex: 1 1 auto; padding: 6px 6px; }
      .players-count { margin-left: 3px; }
      .players-fgroup .select { min-width: 0; }
      .players-sources { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .players-hero-top { grid-template-columns: auto minmax(0, 1fr); padding: 16px 14px; gap: 14px; }
      .players-avatar { width: 52px; height: 52px; font-size: var(--fs-lg); }
      .players-hero-id h2 { font-size: var(--fs-xl); }
      .players-hero-status { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: center; justify-content: space-between; text-align: left; padding-top: 12px; border-top: 1px solid var(--line); }
      .players-hero-status .btn { flex: 1 1 100%; }
      .players-hero-st { align-items: flex-start; }
      .players-hero-top { align-items: start; }
      .players-hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .players-hero-stats > div { padding: 12px 14px; }
      .players-hero-stats > div:nth-child(odd) { border-left: 0; }
      .players-hero-stats > div:nth-child(n+3) { border-top: 1px solid var(--line); }
      .players-hs-v { font-size: var(--fs-lg); }
      .players-today { padding: 12px 14px; }
      .players-metrics { grid-template-columns: minmax(0, 1fr); }
      .players-patterns { grid-template-columns: minmax(0, 1fr); }
      .players-rate { grid-template-columns: minmax(0, 8.5rem) minmax(0, 1fr) 1.6rem; gap: 10px; }
      .players-news-item { grid-template-columns: minmax(0, 1fr); padding: 14px; }
      .players-news-when { flex-direction: row; gap: 10px; align-items: center; }
      .players-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .players-steps { grid-template-columns: minmax(0, 1fr); }
      .players-collect { padding: 22px 14px; }
      .players-collect .row { width: 100%; }
      .players-collect .row .btn { flex: 1 1 100%; }
    }
  `);

  // ---------- общие кусочки ----------
  function nameCell(p, opts = {}) {
    const m = todayMatch(p.id);
    return h('div', { class: 'players-name' },
      h('a', { class: 'players-link', href: '#player-' + p.id, on: { click: e => e.stopPropagation() } }, p.name),
      h('div', { class: 'players-sub' }, h('span', { class: 'players-cc', title: COUNTRY[p.country] || p.country }, p.country), opts.rank ? '№' + p.rank + ' ATP' : age(p),
        m && h('span', { class: 'players-today-tag', title: 'Матч сегодня: ' + D.match(m) }, icon('calendar'), 'сегодня ' + m.time)));
  }
  function statusChip(p) {
    if (jobs[p.id] === 'running') return chip(p.fresh === 'missing' ? 'Собираем…' : 'Обновляем…', 'info', 'refresh');
    if (jobs[p.id] === 'queued') return chip('В очереди', 'info', 'clock');
    return UI.freshnessChip(p.fresh);
  }
  function updatedText(p) {
    if (jobs[p.id] === 'running') return 'идёт обновление';
    if (p.fresh === 'missing') return jobs[p.id] === 'queued' ? 'сбор в ночном пакете' : 'профиль не собран';
    return 'обновлено ' + ago(p.updated) + (jobs[p.id] === 'queued' ? ' · в пакете' : '');
  }
  // Заметная кнопка — только там, где действие нужно (устарели / нет профиля); у свежих — тихая иконка
  function actionBtn(p) {
    if (jobs[p.id] === 'running') return button('Обновляем…', { kind: 'ghost', size: 'sm', icon: 'refresh', disabled: true, title: 'Обновляем' });
    if (jobs[p.id] === 'queued') return button('В очереди', { kind: 'ghost', size: 'sm', icon: 'clock', disabled: true, title: 'В очереди ночного пакета' });
    const onClick = e => { e.stopPropagation(); queueBatch([p.id]); };
    if (p.fresh === 'fresh') return button('', { kind: 'ghost', size: 'sm', icon: 'refresh', title: 'Данные свежие — обновлять не нужно', ariaLabel: 'Обновить профиль: ' + p.name, onClick });
    const missing = p.fresh === 'missing';
    return button(missing ? 'Собрать' : 'Обновить', { kind: 'secondary', size: 'sm', icon: missing ? 'database' : 'refresh', title: missing ? 'Собрать профиль: ' + p.short : 'Обновить данные: ' + p.short,
      ariaLabel: (missing ? 'Собрать профиль: ' : 'Обновить данные: ') + p.name, onClick });
  }

  // ---------- модалка «Добавить игрока» ----------
  function addPlayerModal(prefill) {
    UI.modal({
      title: 'Добавить игрока',
      body: close => {
        const name = UI.field({ label: 'Имя игрока', id: 'players-add-name', value: prefill || '', placeholder: 'Например, Иржи Легечка', autocomplete: 'off', hint: 'Как в рейтинге ATP. Если совпадений несколько, Claude уточнит.' });
        const form = h('form', { id: 'players-add-form', class: 'stack', style: 'gap:16px', novalidate: true, on: { submit: e => {
          e.preventDefault();
          const input = form.querySelector('#players-add-name');
          const v = input.value.trim();
          const old = form.querySelector('.field-error'); if (old) old.remove();
          if (v.length < 3) {
            input.classList.add('invalid'); input.setAttribute('aria-invalid', 'true');
            const hint = name.querySelector('.field-hint'); if (hint) hint.hidden = true;
            name.appendChild(h('div', { class: 'field-error', role: 'alert' }, 'Введите имя и фамилию игрока'));
            input.focus(); return;
          }
          const when = form.querySelector('input[name="players-when"]:checked').value;
          close();
          if (when === 'now') {
            UI.toast(v + ': собираем профиль, это 1–2 минуты', 'refresh');
            setTimeout(() => UI.toast(v + ' добавлен в базу · ' + fmt.usd(COST.collect), 'check'), 2600);
          } else UI.toast(v + ': сбор профиля в ночном пакете (Batch API, −50%)', 'clock');
        } } },
          name,
          h('fieldset', { class: 'players-fieldset' }, h('legend', { class: 'field-label' }, 'Когда собрать профиль'),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'players-when', value: 'now', checked: true }), h('span', null, h('b', null, 'Сейчас'), ' — ~', fmt.usd(COST.collect), ', 1–2 минуты')),
            h('label', { class: 'check' }, h('input', { type: 'radio', name: 'players-when', value: 'batch' }), h('span', null, h('b', null, 'Ночным пакетом'), ' — ~', usd(COST.collect / 2), ', готово к 05:00 (Batch API, −50%)'))),
          UI.callout('', 'database', 'Соберём то же, что и в Telegram-боте: личные данные, игровой профиль, физику и технику, психологию, текущее состояние и последние матчи. Статистика берётся из архива ATP, новости и оценки — веб-поиском Claude с источниками.'));
        return form;
      },
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Добавить', { kind: 'primary', type: 'submit', icon: 'plus', attrs: { form: 'players-add-form' } })],
    });
  }

  // =====================================================================
  // Список игроков
  // =====================================================================
  function renderList(root) {
    const st = listState;
    const refreshRuns = D.ai.runs.filter(r => r.type === 'refresh');
    const refreshCost = refreshRuns.reduce((a, r) => a + r.cost, 0);

    const head = h('div', { class: 'page-head players-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'База игроков'),
        h('p', { class: 'lead' }, 'По этим данным Claude считает вероятности. Перед каждым анализом проверяем свежесть: если данным больше 24 часов, игрок помечается «Нужно обновить».')),
      h('div', { class: 'row' }, button('Добавить игрока', { kind: 'secondary', icon: 'plus', onClick: () => addPlayerModal() })));

    const tiles = h('div', { class: 'grid players-tiles' });
    const todayHost = h('div', { class: 'stack' });

    // --- фильтры ---
    const counts = () => ({ all: D.players.length, fresh: D.players.filter(p => p.fresh === 'fresh').length, stale: D.players.filter(p => p.fresh === 'stale').length, missing: D.players.filter(p => p.fresh === 'missing').length });
    const searchInput = h('input', { class: 'input', id: 'players-q', type: 'search', placeholder: 'Имя или страна', autocomplete: 'off', value: st.q, on: { input: e => { st.q = e.target.value; drawResults(); } } });
    const freshSegHost = h('div');
    const drawFreshSeg = () => {
      const c = counts();
      clear(freshSegHost).appendChild(UI.segmented({ label: 'Свежесть данных', active: st.fresh, onChange: v => { st.fresh = v; drawResults(); }, items: [
        { id: 'all', label: ['Все', h('span', { class: 'players-count' }, c.all)] },
        { id: 'fresh', label: ['Свежие', h('span', { class: 'players-count' }, c.fresh)] },
        { id: 'stale', label: ['Устарели', h('span', { class: 'players-count' }, c.stale)] },
        { id: 'missing', label: ['Нет в базе', h('span', { class: 'players-count' }, c.missing)] },
      ] }));
    };
    drawFreshSeg();
    const sortField = UI.field({ id: 'players-sort', label: 'Сортировка', value: st.sort, options: [{ value: 'rank', label: 'Рейтинг ATP' }, { value: 'elo', label: 'Эло на покрытии' }, { value: 'fresh', label: 'Сначала устаревшие' }] });
    sortField.querySelector('select').addEventListener('change', e => { st.sort = e.target.value; drawResults(); });
    const filters = h('div', { class: 'players-filters', role: 'search' },
      h('div', { class: 'field players-search' }, h('label', { class: 'field-label', for: 'players-q' }, 'Поиск'), h('div', { class: 'input-wrap' }, icon('search', { class: 'players-search-ic' }), searchInput)),
      h('div', { class: 'players-fgroup' }, h('span', { class: 'players-flabel', id: 'players-fresh-l' }, 'Данные'), freshSegHost),
      h('div', { class: 'players-fgroup players-half' }, h('span', { class: 'players-flabel' }, 'Эло на покрытии'),
        UI.segmented({ label: 'Покрытие для Эло', active: st.surface, onChange: v => { st.surface = v; drawResults(); }, items: SURF.map(k => ({ id: k, label: D.surfaces[k].label })) })),
      h('div', { class: 'players-fgroup players-half' }, sortField));
    const results = h('div');
    const resultsFoot = h('div', { class: 'card-foot players-results-foot' });
    const listCard = h('section', { class: 'card', 'aria-label': 'Список игроков' }, filters, results, resultsFoot);

    const sources = card({
      title: 'Откуда берутся данные', subtitle: 'Каждая запись хранит источник и дату — можно проверить, на чём основан вывод модели',
      body: h('div', { class: 'players-sources' },
        source('database', 'Архив матчей ATP', 'Рейтинг, счёт, подача и приём. Структурированные данные без ИИ и без токенов — импорт каждую ночь. Эло считаем сами по этим матчам.'),
        source('globe', 'Веб-поиск Claude', 'Новости, травмы, усталость, мотивация. У каждой записи ссылка на источник. Неподтверждённые слухи помечаются и не влияют на расчёт.'),
        source('brain', 'Оценки Claude 1–10', 'Стиль, физика, техника, психология. Собираются из разборов матчей и интервью раз в 30 дней. Это мнение, а не измерение — вес в модели небольшой.'),
        source('coins', 'Сколько стоит', 'Обновление профиля ночным пакетом ≈ ' + usd(COST.batch) + ' (Batch API, −50%), сразу ≈ ' + fmt.usd(COST.now) + '. Сбор нового игрока ≈ ' + fmt.usd(COST.collect) + '.')),
    });
    function source(ic, title, text) { return h('div', { class: 'players-source' }, h('span', { class: 'players-source-ic' }, icon(ic)), h('div', { style: 'min-width:0' }, h('h4', null, title), h('p', null, text))); }

    root.append(head, tiles, todayHost, listCard, sources);

    function drawTiles() {
      clear(tiles);
      const c = counts();
      const queued = Object.keys(jobs).filter(id => jobs[id] === 'queued').length;
      tiles.append(
        UI.stat({ class: 'col-3 half-mobile', icon: 'users', label: 'Игроков в базе', value: String(c.all - c.missing), hint: c.missing ? 'ещё ' + c.missing + ' без профиля' : 'все профили собраны' }),
        UI.stat({ class: 'col-3 half-mobile', icon: 'check', label: 'Данные свежие', value: String(c.fresh), hint: 'обновлены за 24 ч' }),
        UI.stat({ class: 'col-3 half-mobile', icon: 'clock', label: 'Нужно обновить', value: String(c.stale), hint: queued ? queued + ' в очереди' : 'старше 24 ч' }),
        UI.stat({ class: 'col-3 half-mobile', icon: 'coins', label: 'Расход на данные', value: fmt.usd(refreshCost), hint: 'октябрь · Batch API −50%' }));
    }

    function drawToday() {
      clear(todayHost);
      const ids = D.matchesToday.flatMap(m => [m.p1, m.p2]);
      const need = ids.filter(id => D.P[id].fresh !== 'fresh' && jobs[id] !== 'running');
      const running = ids.filter(id => jobs[id] === 'running');
      const link = id => h('a', { href: '#player-' + id }, D.P[id].short);
      const list = arr => arr.map((id, k) => [k ? (k === arr.length - 1 ? ' и ' : ', ') : '', link(id)]);
      if (running.length) {
        todayHost.appendChild(UI.callout('info', 'refresh', h('b', null, 'Обновляем к матчам дня: '), list(running), '. Это займёт около минуты, можно продолжать работу.'));
      } else if (need.length) {
        const stale = need.filter(id => D.P[id].fresh === 'stale'), missing = need.filter(id => D.P[id].fresh === 'missing');
        const cost = stale.length * COST.now + missing.length * COST.collect;
        const first = D.matchesToday.find(m => need.includes(m.p1) || need.includes(m.p2));
        todayHost.appendChild(UI.callout('warn', 'alert', h('div', { class: 'stack', style: 'gap:10px' },
          h('div', null, h('b', null, 'К матчам Шанхая сегодня: '),
            stale.length ? ['устаревшие данные — ', list(stale)] : null,
            stale.length && missing.length ? '; ' : null,
            missing.length ? [missing.length === 1 ? 'профиль ' : 'профили ', list(missing), missing.length === 1 ? ' не собран' : ' не собраны'] : null,
            '. Анализ матчей с ними пойдёт с пометкой «неполные данные» и пониженной уверенностью.'),
          h('div', { class: 'row', style: 'gap:10px 14px' },
            button('Обновить сейчас · ~' + fmt.usd(cost), { kind: 'primary', size: 'sm', icon: 'refresh', onClick: () => runNow(need) }),
            first && h('span', { class: 'xsmall' }, 'Первый такой матч — в ' + first.time + ', ночной пакет не успеет')))));
      } else {
        todayHost.appendChild(UI.callout('good', 'check', h('b', null, 'Все ' + ids.length + ' игроков матчей дня с актуальными данными. '), 'Можно запускать ', h('a', { href: '#new' }, 'новый анализ'), '.'));
      }
    }

    function filtered() {
      const q = st.q.trim().toLowerCase();
      let arr = D.players.filter(p => (st.fresh === 'all' || p.fresh === st.fresh) &&
        (!q || [p.name, p.short, p.country, COUNTRY[p.country] || ''].some(s => s.toLowerCase().includes(q))));
      const fr = { missing: 0, stale: 1, fresh: 2 };
      if (st.sort === 'rank') arr.sort((a, b) => a.rank - b.rank);
      else if (st.sort === 'elo') arr.sort((a, b) => b.elo[st.surface] - a.elo[st.surface]);
      else arr.sort((a, b) => fr[a.fresh] - fr[b.fresh] || (a.updated || '').localeCompare(b.updated || ''));
      return arr;
    }

    function drawResults() {
      clear(results); clear(resultsFoot);
      const arr = filtered();
      const sk = st.surface, sl = D.surfaces[sk].label;
      if (!arr.length) {
        results.appendChild(h('div', { class: 'empty' }, h('div', { style: 'margin-bottom:10px' }, 'Никого не нашли по этим условиям.'),
          button('Сбросить фильтры', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => { st.q = ''; st.fresh = 'all'; searchInput.value = ''; drawFreshSeg(); drawResults(); } })));
      } else if (UI.isMobile()) {
        results.appendChild(h('div', { role: 'list' }, arr.map(p => {
          const d = p.elo[sk] - p.elo.all;
          return h('div', { class: 'players-item', role: 'listitem', on: { click: () => UI.go('player-' + p.id) } },
            h('div', { class: 'players-item-top' }, nameCell(p, { rank: true }), statusChip(p)),
            h('div', { class: 'players-item-mid' },
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Эло · ' + sl), h('span', { class: 'players-mini-v' }, elo(p.elo[sk]), h('small', null, signed(d)))),
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Эло общий'), h('span', { class: 'players-mini-v' }, elo(p.elo.all))),
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Форма, 10'), h('span', { class: 'players-mini-v players-form' }, UI.formDots(p.form)), h('small', { class: 'players-mini-l' }, winsOf(p) + '–' + (10 - winsOf(p))))),
            h('div', { class: 'players-item-bot' }, h('span', { class: 'xsmall muted' }, updatedText(p)), actionBtn(p)));
        })));
      } else {
        const tbl = UI.table({
          rows: arr, onRowClick: p => UI.go('player-' + p.id),
          columns: [
            { label: 'Игрок', render: p => nameCell(p) },
            { label: 'Рейтинг ATP', render: p => h('div', { class: 'players-cell-2' }, h('b', { class: 'num' }, '№' + p.rank), h('small', null, fmt.int(p.points) + ' очк.')) },
            { label: 'Эло общий', align: 'r', render: p => h('span', { class: 'mono' }, elo(p.elo.all)) },
            { label: 'Эло · ' + sl, align: 'r', render: p => { const d = p.elo[sk] - p.elo.all; return h('div', { class: 'players-cell-2', style: 'align-items:flex-end' }, h('span', { class: 'mono', style: 'font-weight:600' }, elo(p.elo[sk])), h('small', null, signed(d) + ' к общему')); } },
            { label: 'Форма, 10 матчей', render: p => h('span', { class: 'players-form' }, UI.formDots(p.form), h('span', { class: 'small soft num' }, winsOf(p) + '–' + (10 - winsOf(p)))) },
            { label: 'Данные', render: p => h('div', { class: 'players-cell-2', style: 'align-items:flex-start;gap:4px' }, statusChip(p), h('small', null, updatedText(p))) },
            { label: '', align: 'r', render: p => actionBtn(p) },
          ],
        });
        tbl.querySelector('table').classList.add('players-table');
        tbl.querySelectorAll('tbody tr').forEach((tr, k) => {
          tr.setAttribute('aria-label', 'Открыть карточку: ' + arr[k].name);
          tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) UI.go('player-' + arr[k].id); });
        });
        results.appendChild(tbl);
      }
      const stale = D.players.filter(p => p.fresh === 'stale' && !jobs[p.id]);
      resultsFoot.append(
        h('span', null, 'Показано ' + arr.length + ' из ' + D.players.length + ' · Эло пересчитывается каждую ночь после импорта архива'),
        stale.length ? button('Обновить устаревшие · ' + stale.length, { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => queueBatch(stale.map(p => p.id)) }) : h('span', { class: 'chip good' }, icon('check'), 'Устаревших нет'));
    }

    function drawAll() { drawTiles(); drawToday(); drawFreshSeg(); drawResults(); }
    drawTiles(); drawToday(); drawResults();
    redraw = () => { if (root.isConnected && listCard.isConnected) drawAll(); };
  }

  // =====================================================================
  // Карточка игрока
  // =====================================================================
  const TABS = [{ id: 'overview', label: 'Обзор' }, { id: 'matches', label: 'Матчи' }, { id: 'profile', label: 'Профиль' }, { id: 'news', label: 'Новости' }, { id: 'history', label: 'История данных', short: 'История' }];

  function renderPlayer(root, param) {
    const parts = String(param || '').split('-');
    const pid = parts[0];
    const p = D.P[pid];
    if (!p) return renderNotFound(root, pid);
    UI.setHeader({ title: p.short, crumbs: h('span', null, h('a', { href: '#players' }, 'Игроки'), ' / ', 'карточка игрока') });
    document.title = p.short + ' · Игроки · AI Capper';

    let hero = heroNode(p);
    root.appendChild(hero);

    if (p.fresh === 'missing') {
      renderMissing(root, p);
      redraw = () => { if (hero.isConnected) { const n = heroNode(p); hero.replaceWith(n); hero = n; } };
      return;
    }

    let tab = TABS.some(t => t.id === parts[1]) ? parts[1] : cardTabs[p.id] || 'overview';
    const panel = h('div', { class: 'players-tabpanel', role: 'tabpanel', id: 'players-panel' });
    const mobile = UI.isMobile();
    const tabsEl = UI.tabs({ items: TABS.map(t => ({ id: t.id, label: mobile && t.short ? t.short : t.label })), active: tab, onChange: t => {
      tab = t; cardTabs[p.id] = t; drawPanel(); revealTab(tabsEl);
      try { history.replaceState(null, '', '#player-' + p.id + (t === 'overview' ? '' : '-' + t)); } catch (e) { /* ок */ }
    } });
    tabsEl.setAttribute('aria-label', 'Разделы карточки игрока');
    if (mobile) tabsEl.classList.add('players-tabs'); // на телефоне все 5 вкладок в одну строку, без прокрутки
    root.append(tabsEl, panel);
    revealTab(tabsEl);

    function drawPanel() {
      clear(panel);
      const fn = { overview: tabOverview, matches: tabMatches, profile: tabProfile, news: tabNews, history: tabHistory }[tab];
      fn(panel, p);
    }
    drawPanel();
    redraw = () => {
      if (!hero.isConnected) return;
      const n = heroNode(p); hero.replaceWith(n); hero = n;
      if (tab === 'history' || tab === 'overview') drawPanel();
    };
  }

  // Если вкладки всё же не влезли (узкий экран, крупный шрифт) — держим выбранную в поле зрения
  function revealTab(el) {
    requestAnimationFrame(() => {
      const b = el.querySelector('[aria-selected="true"]');
      if (!b || el.scrollWidth <= el.clientWidth) return;
      const x = b.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      el.scrollLeft = Math.max(0, x - (el.clientWidth - b.offsetWidth) / 2);
    });
  }

  function heroNode(p) {
    const m = todayMatch(p.id);
    const missing = p.fresh === 'missing';
    const ex = EXTRA[p.id] || {};
    const surf = bestSurface(p);
    const W = winsOf(p);
    const busy = jobs[p.id] === 'running';
    const status = h('div', { class: 'players-hero-status' },
      h('div', { class: 'players-hero-st' }, statusChip(p),
        h('small', null, busy ? (missing ? 'собираем профиль, 1–2 мин' : 'идёт обновление…') : missing ? (jobs[p.id] === 'queued' ? 'сбор в ночном пакете, к 05:00' : 'есть только архив ATP') : 'обновлено ' + ago(p.updated) + ' · ' + fmt.datetime(p.updated))),
      missing
        ? button(busy ? 'Собираем…' : 'Как собираем', { kind: 'secondary', size: 'sm', icon: busy ? 'refresh' : null, iconRight: busy ? null : 'arrowDown', disabled: busy, title: 'К карточке сбора профиля ниже', onClick: () => {
            const c = document.querySelector('#players-collect-card'); if (!c) return;
            c.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const b = document.querySelector('#players-collect-btn'); if (b && !b.disabled) b.focus({ preventScroll: true });
          } })
        : button(busy ? 'Обновляем…' : 'Обновить сейчас', { kind: 'secondary', size: 'sm', icon: 'refresh', disabled: busy, title: 'Новости, состояние и статистика · ~' + fmt.usd(COST.now) + ' · около минуты', onClick: () => runNow([p.id]) }));

    const top = h('div', { class: 'players-hero-top' },
      h('div', { class: 'players-avatar', 'aria-hidden': 'true' }, initials(p.name)),
      h('div', { class: 'players-hero-id' },
        h('h2', null, p.name),
        h('div', { class: 'players-meta' }, h('span', { class: 'players-cc' }, p.country), ' ',
          [COUNTRY[p.country], age(p), ex.height && ex.height + ' см', (p.hand === 'левая' ? 'левша' : 'правша') + ', ' + p.backhand + ' бэкхенд'].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: 'gap:6px' }, chip(p.style, 'outline'), !missing && chip('Любит ' + D.surfaces[surf].label.toLowerCase(), 'outline'))),
      status);

    const stats = h('div', { class: 'players-hero-stats' },
      h('div', null, h('span', { class: 'players-hs-l' }, 'Рейтинг ATP'), h('span', { class: 'players-hs-v' }, '№' + p.rank), h('span', { class: 'players-hs-s' }, fmt.int(p.points) + ' очков' + (ex.best && ex.best < p.rank ? ' · лучший №' + ex.best : ''))),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Эло общий'), h('span', { class: 'players-hs-v' }, elo(p.elo.all)), h('span', { class: 'players-hs-s' }, missing ? eloRankAll(p) + '-й из ' + D.players.length + ' по Эло · архив ATP' : eloRankAll(p) + '-й в базе по Эло')),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Эло на харде'), h('span', { class: 'players-hs-v' }, elo(p.elo.hard)), h('span', { class: 'players-hs-s' }, signed(p.elo.hard - p.elo.all) + ' к общему')),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Форма, 10 матчей'), h('span', { class: 'players-hs-v' }, W + '–' + (10 - W), UI.formDots(p.form)), h('span', { class: 'players-hs-s' }, missing ? 'по архиву ATP' : 'слева — последний матч')));

    let foot = null;
    if (m) {
      const opp = D.P[m.p1 === p.id ? m.p2 : m.p1];
      const side = m.p1 === p.id ? 'p1' : 'p2';
      const ol = openLeg(p.id);
      foot = h('div', { class: 'players-today' }, icon('calendar'),
        h('div', { class: 'players-today-text' }, h('b', null, 'Сегодня, ' + m.time + ' · '), m.tournament + ', ' + m.round + ' · соперник — ', h('a', { href: '#player-' + opp.id }, opp.name), ' (№' + opp.rank + ') · ',
          h('span', { class: 'muted' }, (side === 'p1' ? 'П1' : 'П2') + ' '), h('span', { class: 'odds' }, fmt.odds(m.odds[side]))),
        ol && h('a', { class: 'chip info', href: '#bets-' + ol.bet.id, title: 'Ставка №' + ol.bet.id + ' — внести результат' }, icon('ticket'), 'В ставке №' + ol.bet.id + ': ' + D.match(ol.leg) + ' · ' + ol.leg.marketLabel + ' ' + fmt.odds(ol.leg.odds)),
        IN_EXAMPLE.includes(m.id)
          ? button('Разбор матча', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#analysis' })
          : button('Анализировать матч', { kind: 'ghost', size: 'sm', icon: 'spark', href: '#new-' + m.id }));
    }
    return h('section', { class: 'card players-hero', 'aria-label': 'Игрок ' + p.name }, top, stats, foot);
  }

  // ---------- вкладка «Обзор» ----------
  function eloBars(p) {
    const deltas = SURF.map(k => p.elo[k] - p.elo.all);
    const lim = Math.max(50, Math.ceil(Math.max(...deltas.map(Math.abs)) / 50) * 50);
    return UI.hbars({
      domain: [-lim, lim],
      valueFormat: v => elo(p.elo.all + v),
      items: SURF.map((k, i) => ({ label: D.surfaces[k].label, value: deltas[i], color: D.surfaces[k].color, note: signed(deltas[i]) })),
    });
  }

  function tabOverview(panel, p) {
    const I = info(p);
    const m = todayMatch(p.id);
    let eloNote = null;
    if (m) {
      const opp = D.P[m.p1 === p.id ? m.p2 : m.p1];
      const side = m.p1 === p.id ? 'p1' : 'p2', other = side === 'p1' ? 'p2' : 'p1';
      const pe = eloProb(p.elo.hard, opp.elo.hard);
      const mk = (1 / m.odds[side]) / (1 / m.odds[side] + 1 / m.odds[other]);
      const H = h2h(p, opp);
      eloNote = UI.callout('info', 'target', h('div', { class: 'stack', style: 'gap:4px' },
        h('b', null, 'Сегодня: ' + p.short + ' — ' + opp.short),
        h('div', null, 'Эло на харде: ' + elo(p.elo.hard) + ' против ' + elo(opp.elo.hard) + ' → ' + fmt.prob(pe) + ' на победу · рынок без маржи: ' + fmt.prob(mk)),
        h('div', null, 'Личные встречи: ' + H.w + '–' + H.l + ', на харде ' + H.hw + '–' + H.hl + ' · последняя — ' + H.last + ', ' + (H.lastWon ? 'победа' : 'поражение')),
        h('div', { class: 'xsmall', style: 'opacity:.85' }, 'Это входные точки модели, а не прогноз. Встречи на других покрытиях на хард не переносим (', h('a', { href: '#learning' }, 'урок L-012'), '). Итог — ', IN_EXAMPLE.includes(m.id) ? ['в ', h('a', { href: '#analysis' }, 'разборе матча')] : ['после ', h('a', { href: '#new-' + m.id }, 'анализа матча')], '.')));
    }
    const eloCard = card({
      class: 'col-7', title: 'Эло по покрытиям', subtitle: 'Общий ' + elo(p.elo.all) + ' · считаем сами по архиву матчей ATP',
      body: [
        UI.withTable(eloBars(p), () => UI.table({ rows: SURF, columns: [
          { label: 'Покрытие', render: k => UI.surfaceChip(k) },
          { label: 'Эло', align: 'r', render: k => h('span', { class: 'mono' }, elo(p.elo[k])) },
          { label: 'К общему', align: 'r', render: k => signed(p.elo[k] - p.elo.all) },
        ] })),
        h('p', { class: 'players-hint' }, 'Как читать: число — Эло на покрытии; полоса и подпись под числом — разница с общим Эло: вправо — здесь играет сильнее своего уровня, влево — слабее. Эло учитывает силу соперников; разница в 100 пунктов ≈ 64% на победу более сильного.'),
        eloNote,
      ],
    });

    const S = I.state;
    const formCard = card({
      class: 'col-5', title: 'Форма и состояние', subtitle: 'по данным на ' + fmt.datetime(p.updated),
      body: [
        h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'players-formbig', role: 'img', 'aria-label': 'Последние 10 матчей, начиная с последнего: ' + p.form.map(x => x === 'W' ? 'победа' : 'поражение').join(', ') },
            p.form.map(x => h('span', { class: x === 'W' ? 'w' : 'l', 'aria-hidden': 'true' }, x === 'W' ? 'В' : 'П'))),
          h('div', { class: 'players-hint' }, 'В — победа, П — поражение; слева последний матч (обведён). ' + winsOf(p) + ' побед из 10.')),
        kvWide([
          ['Последний матч', S.last ? fmt.date(S.last.date) + ' · ' + S.last.event + ', ' + S.last.round : '—'],
          ['Здоровье', chip(S.health[0], S.health[1], S.health[1] === 'good' ? 'check' : 'alert')],
          ['Усталость', chip(S.fatigue[0], S.fatigue[1], S.fatigue[1] === 'good' ? 'check' : 'clock')],
          ['Матчей за 14 дней', String(S.m14)],
          ['Отдых перед матчем', m && S.rest != null ? plural(S.rest, 'день', 'дня', 'дней') : 'нет матча'],
          ['Мотивация', S.motivation],
        ]),
      ],
    });

    const metric = (label, val, tour, max, unit, lowerBetter, d = 0) => {
      const diff = val - tour;
      const thr = unit === '%' ? 1 : 0.3;
      const good = lowerBetter ? diff < 0 : diff > 0;
      const deltaTxt = Math.abs(diff) < thr ? '≈ тур' : signed(diff, d) + (unit === '%' ? ' п.п.' : '');
      const cls = Math.abs(diff) < thr ? 'flat' : good ? 'good-text' : 'bad-text';
      const show = v => (d ? fmt.dec(v, d) : fmt.int(v)) + (unit === '%' ? '%' : unit ? ' ' + unit : '');
      return h('div', { class: 'players-metric' },
        h('div', { class: 'players-metric-top' }, h('span', { class: 'players-metric-label' }, label),
          h('span', { class: 'players-metric-val' }, show(val), h('span', { class: ['players-metric-delta', cls], title: 'Средний по туру: ' + show(tour) }, cls !== 'flat' && icon(diff > 0 ? 'arrowUp' : 'arrowDown'), deltaTxt))),
        h('div', { class: 'players-bullet', role: 'img', 'aria-label': label + ': ' + show(val) + ', средний по туру ' + show(tour) },
          h('i', { style: { width: clamp(val / max * 100, 0, 100) + '%' } }), h('b', { style: { left: clamp(tour / max * 100, 0, 100) + '%' } })));
    };
    const sv = p.serve, rt = p.ret;
    const bpSaved = clamp(Math.round(TOUR.bpSaved + (p.elo.all - 2000) / 30), 55, 72);
    const serveCard = card({
      class: 'col-7', title: 'Подача и приём', subtitle: '52 недели · против среднего по туру (топ-50)',
      actions: [h('div', { class: 'chart-legend' }, h('span', null, h('i', { class: 'box', style: { background: 'var(--s1)' } }), p.short), h('span', null, h('i', { class: 'players-tick-key' }), 'Средний по туру'))],
      body: [
        h('div', { class: 'players-metrics' },
          h('div', { class: 'players-metrics-col' }, h('div', { class: 'eyebrow' }, 'Подача'),
            metric('Попадание первой', sv.first, TOUR.first, 100, '%'),
            metric('Очки на первой', sv.firstWon, TOUR.firstWon, 100, '%'),
            metric('Очки на второй', sv.secondWon, TOUR.secondWon, 100, '%'),
            metric('Эйсов за матч', sv.aces, TOUR.aces, 15, '', false, 1),
            metric('Двойных за матч', sv.df, TOUR.df, 6, '', true, 1),
            metric('Скорость первой', sv.speed, TOUR.speed, 240, 'км/ч')),
          h('div', { class: 'players-metrics-col' }, h('div', { class: 'eyebrow' }, 'Приём и брейкпоинты'),
            metric('Очки на приёме первой', rt.firstRet, TOUR.firstRet, 100, '%'),
            metric('Очки на приёме второй', rt.secondRet, TOUR.secondRet, 100, '%'),
            metric('Реализация брейкпоинтов', rt.bpConv, TOUR.bpConv, 100, '%'),
            metric('Спасённые брейкпоинты', bpSaved, TOUR.bpSaved, 100, '%'))),
        h('p', { class: 'players-hint' }, 'Полоса — показатель игрока, вертикальная черта — средний по туру. Стрелка и цвет показывают, лучше или хуже среднего (для двойных ошибок лучше меньше).'),
      ],
    });

    const wl = SURF.filter(k => p.wlSurface[k]).map(k => ({ k, w: p.wlSurface[k][0], l: p.wlSurface[k][1] }));
    const tw = wl.reduce((a, x) => a + x.w, 0), tl = wl.reduce((a, x) => a + x.l, 0);
    wl.push({ k: 'total', w: tw, l: tl });
    const V = I.vs, P = I.psych;
    const tbM = P.patterns[0].stat.match(/^(\d+)–(\d+)/);
    const rec = (w, l) => h('span', { class: 'num' }, w + '–' + l, h('span', { class: 'muted' }, ' · ' + fmt.pct(w / (w + l) * 100, 0)));
    const wlCard = card({
      class: 'col-5', title: 'Результаты', subtitle: 'по покрытиям за 2 сезона · архив ATP', flush: true,
      body: [
        UI.table({ rows: wl, columns: [
          { label: 'Покрытие', render: x => x.k === 'total' ? h('b', null, 'Всего') : UI.surfaceChip(x.k) },
          { label: 'В–П', align: 'r', render: x => h('span', { class: 'mono' }, x.w + '–' + x.l) },
          { label: '% побед', align: 'r', render: x => h('span', { class: 'players-wl-meter' }, h('b', { class: 'num' }, fmt.pct(x.w / (x.w + x.l) * 100, 0)), UI.meter(x.w, x.w + x.l)) },
        ] }),
        h('div', { class: 'players-vs' }, h('div', { class: 'eyebrow' }, 'Ключевые матчи · 52 недели'),
          kvWide([['Против топ-10', rec(V.top10[0], V.top10[1])], ['Решающие сеты', rec(V.decider[0], V.decider[1])], ['Тай-брейки', rec(+tbM[1], +tbM[2])]])),
      ],
    });

    panel.appendChild(h('div', { class: 'grid' }, eloCard, formCard, serveCard, wlCard));
  }

  // ---------- вкладка «Матчи» ----------
  function tabMatches(panel, p) {
    const I = info(p);
    const ms = I.matches;
    const played = ms.filter(m => !m.wo);
    const wo = ms.filter(m => m.wo);
    const tb = played.reduce((a, m) => { (m.score.match(/\d:\d/g) || []).forEach(s => { if (s === '7:6') a[0]++; if (s === '6:7') a[1]++; }); return a; }, [0, 0]);
    const avg = f => played.reduce((a, m) => a + f(m), 0) / played.length;
    const W = played.filter(m => m.res === 'W').length;
    const resChip = m => m.wo ? chip('Без игры', 'outline', 'refresh') : m.res === 'W' ? chip('Победа', 'good', 'check') : chip('Поражение', 'bad', 'x');
    const oppNode = m => m.wo ? h('span', null, m.opp.name + ' снялся') : h('span', null, m.opp.id ? h('a', { class: 'players-link', href: '#player-' + m.opp.id }, m.opp.name) : m.opp.name, m.opp.rank ? [' ', h('span', { class: 'muted xsmall' }, '№' + m.opp.rank)] : null);
    const strip = h('div', { class: 'players-strip' },
      h('div', null, h('span', null, 'Победы'), h('b', null, W + ' из ' + played.length)),
      h('div', null, h('span', null, 'Эйсов за матч'), h('b', null, fmt.dec(avg(m => m.aces), 1))),
      h('div', null, h('span', null, '1-я подача'), h('b', null, fmt.pct(avg(m => m.firstPct), 0))),
      h('div', null, h('span', null, 'Тай-брейки'), h('b', null, tb[0] + '–' + tb[1])));
    let list;
    if (UI.isMobile()) {
      list = h('div', { role: 'list' }, ms.map(m => h('div', { class: ['players-mrow', m.wo && 'players-wo'], role: 'listitem' },
        h('div', { class: 'players-mrow-line' }, h('span', { class: 'small' }, h('b', null, m.event), ' · ' + m.round), h('span', { class: 'xsmall muted', style: 'white-space:nowrap' }, fmt.date(m.date))),
        h('div', { class: 'players-mrow-line' }, h('span', null, m.wo ? '' : 'соперник: ', oppNode(m)), resChip(m)),
        !m.wo && h('div', { class: 'players-mrow-line' }, h('span', { class: 'mono small' }, m.score), h('span', { class: 'xsmall muted', style: 'white-space:nowrap' }, 'эйсов ' + m.aces + ' · 1-я ' + m.firstPct + '%')))));
    } else {
      list = UI.table({ rows: ms, columns: [
        { label: 'Дата', render: m => h('span', { style: 'white-space:nowrap' }, fmt.date(m.date)) },
        { label: 'Турнир', render: m => h('div', { class: 'players-cell-2' }, h('span', { style: 'font-weight:500' }, m.event), h('small', null, m.cat)) },
        { label: 'Покрытие', render: m => UI.surfaceChip(m.surface) },
        { label: 'Раунд', render: m => m.round },
        { label: 'Соперник', render: m => oppNode(m) },
        { label: 'Счёт', render: m => m.wo ? h('span', { class: 'muted' }, 'W/O') : h('span', { class: 'mono', style: 'white-space:nowrap' }, m.score) },
        { label: 'Итог', render: resChip },
        { label: 'Эйсы', align: 'r', render: m => m.wo ? '—' : m.aces },
        { label: '1-я подача', align: 'r', render: m => m.wo ? '—' : m.firstPct + '%' },
      ] });
      list.querySelectorAll('tbody tr').forEach((tr, k) => { if (ms[k].wo) tr.classList.add('players-wo'); });
    }
    panel.appendChild(card({
      title: 'Последние ' + played.length + ' матчей', subtitle: 'Архив ATP · сверху последний' + (wo.length ? ' · неявка соперника в счёт не идёт' : ''),
      actions: [chip('Обновлено ' + fmt.datetime(p.updated), 'outline', 'database')],
      body: [strip, h('div', { class: 'players-flush' }, list)],
      foot: [h('span', { class: 'small muted', style: 'flex:1;min-width:0' }, 'Полная история — ' + Object.values(p.wlSurface).reduce((a, x) => a + x[0] + x[1], 0) + ' матчей за 2 сезона. Для анализа модель берёт сжатую сводку, а не весь список.'),
        button('Показать все', { kind: 'secondary', size: 'sm', icon: 'list', onClick: () => UI.toast('В макете показаны последние 10 матчей', 'info') })],
    }));
  }

  // ---------- вкладка «Профиль» ----------
  function tabProfile(panel, p) {
    const I = info(p), R = I.ratings, ex = EXTRA[p.id] || {};
    const at = doneNow.has(p.id) ? NOW : I.staticAt;
    const metaLine = (n) => h('div', { class: 'players-meta-line' }, icon('clock'), h('span', null, 'Оценено ' + fmt.dateFull(at) + ' · Claude (Sonnet 5.5) · ' + n + ' ' + fmt.plural(n, 'источник', 'источника', 'источников')));
    const avg = arr => arr.reduce((a, x) => a + x[1], 0) / arr.length;
    const rates = arr => h('div', { class: 'stack', style: 'gap:4px' }, arr.map(([k, v]) => h('div', { class: 'players-rate' },
      h('span', { class: 'players-rate-l', title: k }, k), UI.meter(v, 10, v <= 5 ? 'warn' : null), h('span', { class: 'players-rate-v' }, v))));

    const note = UI.callout('info', 'info', h('b', null, 'Качественные оценки собирает Claude из источников, с датой. '),
      'Это разборы матчей, интервью и статистика, а не измерения. В модели у них небольшой вес: вероятность в первую очередь определяют Эло, статистика и рынок. Шкала 1–10, как в шаблонах Telegram-бота: 6–7 — средний профессиональный уровень, 8–9 — элита, 10 — лучший в мире.');

    const profileCard = card({ class: 'col-4 players-fill', title: 'Игровой профиль', body: [UI.kv([
      ['Стиль игры', ex.kind || '—'], ['Позиция на корте', ex.pos || '—'], ['Тип подачи', ex.serveType || '—'],
      ['Любимое покрытие', D.surfaces[bestSurface(p)].label], ['Рабочая рука', p.hand === 'левая' ? 'Левша' : 'Правша'], ['Бэкхенд', p.backhand[0].toUpperCase() + p.backhand.slice(1)],
      ['Рост', ex.height ? ex.height + ' см' : '—'], ['Лучший рейтинг ATP', '№' + (ex.best || p.rank)],
    ]), metaLine(4)] });
    const physCard = card({ class: 'col-4 players-fill', title: 'Физика', subtitle: 'средняя ' + fmt.dec(avg(R.phys), 1) + ' из 10', body: [rates(R.phys), metaLine(3)] });
    const techCard = card({ class: 'col-4 players-fill', title: 'Техника', subtitle: 'средняя ' + fmt.dec(avg(R.tech), 1) + ' из 10', body: [rates(R.tech), metaLine(5)] });

    const P = I.psych;
    const typeKind = P.type === 'Стабильный' ? 'good' : P.type === 'Нестабильный' ? 'warn' : 'outline';
    const psychCard = card({
      class: 'col-8 players-fill', title: 'Психология', subtitle: 'поведение в решающие моменты',
      actions: [chip(P.type, typeKind, P.type === 'Стабильный' ? 'shield' : 'alert')],
      body: [
        h('div', { class: 'players-patterns' }, P.patterns.map(x => h('div', { class: 'players-pattern' }, h('h4', null, x.k), h('span', { class: 'mono' }, x.stat), h('p', null, x.text)))),
        h('div', { class: 'eyebrow', style: 'margin-top:4px' }, 'Оценки 1–10'),
        h('div', { class: 'players-patterns', style: 'gap:6px 28px' }, P.ratings.map(([k, v]) => h('div', { class: 'players-rate stacked' }, h('span', { class: 'players-rate-l' }, k), h('span', { class: 'players-rate-v' }, v + ' из 10'), UI.meter(v, 10, v <= 5 ? 'warn' : null)))),
        metaLine(6),
      ],
    });
    const swCard = card({ class: 'col-4', title: 'Сильные и слабые стороны', body: [
      h('div', { class: 'eyebrow' }, 'Сильные'),
      h('ul', { class: 'players-bullets' }, R.strong.map(s => h('li', null, h('span', { class: 'good-text', style: 'display:flex' }, icon('check')), s))),
      h('div', { class: 'eyebrow' }, 'Слабые'),
      h('ul', { class: 'players-bullets' }, R.weak.map(s => h('li', null, h('span', { class: 'bad-text', style: 'display:flex' }, icon('alert')), s))),
      button('Поправить оценку', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: () => disputeModal(p), attrs: { style: 'align-self:flex-start;margin-top:4px' } }),
    ] });
    panel.append(note, h('div', { class: 'grid' }, profileCard, physCard, techCard, psychCard, swCard));
  }

  function disputeModal(p) {
    UI.modal({
      title: 'Поправить оценку · ' + p.short,
      body: h('form', { id: 'players-dispute', class: 'stack', style: 'gap:14px', on: { submit: e => { e.preventDefault(); } } },
        UI.field({ id: 'players-d-what', label: 'Что не так', options: ['Оценка физики', 'Оценка техники', 'Психология', 'Сильные и слабые стороны'] }),
        UI.field({ id: 'players-d-text', label: 'Ваш комментарий', rows: 3, placeholder: 'Например: после смены тренера стал чаще выходить к сетке — «игра у сетки» скорее 8, а не 6.' }),
        UI.callout('', 'brain', 'Ваша правка сохранится рядом с оценкой Claude с пометкой «вручную». При следующем обновлении Claude проверит её по источникам и покажет, если они расходятся.')),
      actions: close => [button('Отмена', { kind: 'ghost', onClick: close }), button('Сохранить правку', { kind: 'primary', icon: 'check', onClick: () => { close(); UI.toast('Правка сохранена — учтём при следующем обновлении', 'check'); } })],
    });
  }

  // ---------- вкладка «Новости» ----------
  function tabNews(panel, p) {
    const I = info(p);
    const impactChip = n => n.impact ? chip('Влияет', 'accent', 'bolt') : chip('Не влияет', 'outline', 'x');
    const items = I.news.map(n => h('article', { class: 'players-news-item' },
      h('div', { class: 'players-news-when' }, h('b', null, fmt.date(n.date)), h('span', { class: 'players-news-src' }, icon('globe'), n.src)),
      h('div', { class: 'players-news-body' }, h('p', null, n.text), h('div', { class: 'players-news-why' }, impactChip(n), h('span', { style: 'min-width:0' }, n.why))),
      button('Выдержка', { kind: 'ghost', size: 'sm', icon: 'book', onClick: () => UI.modal({
        title: 'Источник · ' + n.src,
        body: [
          UI.kv([['Опубликовано', fmt.dateFull(n.date)], ['Найдено', 'веб-поиск Claude, ' + fmt.datetime(p.updated)], ['Влияние', n.impact ? 'учтено в анализе' : 'не учтено']]),
          h('blockquote', { class: 'players-quote' }, n.quote),
          h('p', { class: 'small soft' }, n.why + '.'),
          UI.callout('', 'link', 'Ссылка и выдержка хранятся вместе с выводом, чтобы потом проверить, на чём модель основала решение. В макете переход на внешний сайт отключён.'),
        ],
      }) })));
    const searches = p.id === 'sinner' ? 4 : 3;
    panel.appendChild(card({
      title: 'Новости и состояние', subtitle: 'Веб-поиск Claude · последний поиск ' + fmt.datetime(p.updated) + ' · ' + searches + ' запроса · примеры для макета',
      actions: [button('Искать сейчас', { kind: 'secondary', size: 'sm', icon: 'search', onClick: () => { UI.toast('Ищем свежие новости: ' + p.short + '… (~' + fmt.usd(0.02) + ')', 'search'); setTimeout(() => UI.toast('Новых новостей нет — последние уже учтены', 'check'), 2200); } })],
      body: h('div', { class: 'players-flush' }, items),
    }));
    panel.appendChild(UI.callout('', 'info', h('b', null, 'Как Claude решает, влияет ли новость. '), 'Учитываются только подтверждённые факты о здоровье, нагрузке, условиях турнира и мотивации. Слухи из соцсетей без подтверждения турнира или команды помечаются «не влияет» — так решили по итогам разбора ставок (урок ', h('a', { href: '#learning' }, 'L-019'), ').'));
  }

  // ---------- вкладка «История данных» ----------
  function tabHistory(panel, p) {
    const I = info(p);
    const upd = p.updated;
    const now = doneNow.has(p.id);
    const imp = upd;
    const plus2 = iso => { const d = new Date(ts(iso) + 2 * 60000); return d.toISOString().slice(0, 16); };
    const srcNode = (ic, t) => h('span', { class: 'players-hist-src' }, icon(ic), t);
    const rows = [
      { block: 'Рейтинг и очки ATP', at: imp, how: now ? 'Обновить сейчас' : 'Ночной импорт архива ATP', src: srcNode('database', 'архив ATP'), cost: 0 },
      { block: 'Матчи, подача и приём', at: imp, how: now ? 'Обновить сейчас' : 'Ночной импорт архива ATP', src: srcNode('database', 'архив ATP'), cost: 0 },
      { block: 'Эло по покрытиям', at: plus2(imp), how: 'Пересчёт после импорта', src: srcNode('chart', 'расчёт'), cost: 0 },
      { block: 'Новости и текущее состояние', at: upd, how: now ? 'Обновить сейчас · Sonnet 5.5' : 'Ночной пакет · Sonnet 5.5, Batch', src: srcNode('globe', 'веб-поиск, 3 запроса'), cost: now ? COST.now : COST.batch },
      { block: 'Игровой профиль, физика, техника', at: now ? NOW : I.staticAt, how: 'Полный сбор профиля · Sonnet 5.5', src: srcNode('brain', 'оценка Claude, 9 источников'), cost: now ? null : COST.collect },
      { block: 'Психология', at: now ? NOW : I.staticAt, how: 'Полный сбор профиля', src: srcNode('brain', 'оценка Claude, 6 источников'), cost: null },
      { block: 'Личные данные', at: '2026-07-02T12:30', how: 'Перенос из Telegram-бота (JSON)', src: srcNode('upload', 'импорт'), cost: 0 },
    ];
    const costTxt = c => c === null ? h('span', { class: 'muted' }, 'в сборе выше') : c === 0 ? h('span', { class: 'muted' }, 'без ИИ') : usd(c);
    let tbl;
    if (UI.isMobile()) {
      tbl = h('div', { role: 'list' }, rows.map(r => h('div', { class: 'players-mrow', role: 'listitem' },
        h('div', { class: 'players-mrow-line' }, h('b', { class: 'small' }, r.block), h('span', { class: 'small num' }, costTxt(r.cost))),
        h('div', { class: 'players-mrow-line' }, h('span', { class: 'xsmall muted' }, r.how), h('span', { class: 'xsmall', style: 'white-space:nowrap' }, ago(r.at))),
        h('div', { class: 'players-mrow-line' }, h('span', { class: 'xsmall' }, r.src), h('span', { class: 'xsmall muted', style: 'white-space:nowrap' }, fmt.datetime(r.at))))));
    } else {
      tbl = UI.table({ rows, columns: [
        { label: 'Блок данных', render: r => h('b', { style: 'font-weight:500' }, r.block) },
        { label: 'Обновлено', render: r => h('div', { class: 'players-cell-2' }, h('span', { style: 'white-space:nowrap' }, fmt.datetime(r.at)), h('small', null, ago(r.at))) },
        { label: 'Как и откуда', render: r => h('div', { class: 'players-cell-2', style: 'gap:4px' }, h('span', null, r.how), h('span', { class: 'xsmall muted' }, r.src)) },
        { label: 'Стоимость', align: 'r', render: r => h('span', { class: 'num' }, costTxt(r.cost)) },
      ] });
    }
    const blocks = card({ class: 'col-8', title: 'Когда и откуда обновлялся каждый блок', subtitle: 'Структура досье — как в шаблонах Telegram-бота', body: h('div', { class: 'players-flush' }, tbl) });

    // Запуски ИИ за 30 дней: доли пакетов из DATA.ai.runs + свои
    const refreshRuns = D.ai.runs.filter(r => r.type === 'refresh');
    const share = r => r.cost / 9;
    const runs = [
      now ? { at: NOW, title: 'Обновить сейчас', sub: 'Sonnet 5.5 · 3 поиска', cost: COST.now } : { at: upd, title: 'Ночной пакет', sub: 'Batch API · новости и состояние', cost: COST.batch },
      ...refreshRuns.slice().reverse().map(r => ({ at: r.at, title: 'Пакетное обновление', sub: r.id + ' · 9 игроков, доля 1/9', cost: share(r) })),
      { at: I.staticAt, title: 'Полный сбор профиля', sub: 'Sonnet 5.5 · 9 поисков', cost: COST.collect },
    ];
    const total = runs.reduce((a, r) => a + r.cost, 0);
    const runsCard = card({
      title: 'Запуски ИИ за 30 дней', subtitle: 'итого ' + fmt.usd(total) + ' на этого игрока',
      body: h('div', { class: 'players-runs' }, runs.map(r => h('div', { class: 'players-run' },
        h('div', null, h('div', { style: 'font-weight:500' }, r.title), h('div', { class: 'xsmall muted' }, fmt.datetime(r.at) + ' · ' + r.sub)),
        h('span', { class: 'num', style: 'white-space:nowrap' }, usd(r.cost))))),
      foot: [button('Все запуски', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#costs' })],
    });
    const rulesCard = card({
      title: 'Правила обновления', subtitle: 'чтобы не тратить токены зря',
      body: h('ul', { class: 'players-bullets' },
        h('li', null, h('span', { class: 'muted', style: 'display:flex' }, icon('database')), h('span', null, h('b', null, 'Рейтинг, матчи, Эло'), ' — каждую ночь из архива ATP, без ИИ.')),
        h('li', null, h('span', { class: 'muted', style: 'display:flex' }, icon('globe')), h('span', null, h('b', null, 'Новости и состояние'), ' — ночным пакетом, если у игрока скоро матч; перед анализом — если старше 24 ч.')),
        h('li', null, h('span', { class: 'muted', style: 'display:flex' }, icon('brain')), h('span', null, h('b', null, 'Профиль и психология'), ' — раз в 30 дней или после травмы и смены тренера.')),
        h('li', null, h('span', { class: 'muted', style: 'display:flex' }, icon('layers')), h('span', null, h('b', null, 'В анализ'), ' идёт сжатое досье ≈ 1,8K токенов вместо 12K сырого текста, и оно кэшируется.'))),
    });
    panel.appendChild(h('div', { class: 'grid' }, blocks, h('div', { class: 'col-4 stack', style: 'gap:16px' }, runsCard, rulesCard)));
  }

  // ---------- нет профиля ----------
  function renderMissing(root, p) {
    const STEPS = [
      ['user', 'Личные данные', 'рост, рука, хват · архив ATP'],
      ['target', 'Игровой профиль', 'стиль, позиция, подача · веб-поиск'],
      ['bolt', 'Физика и техника', 'оценки 1–10 · разборы матчей'],
      ['brain', 'Психология', 'тай-брейки, 0:40, давление'],
      ['alert', 'Текущее состояние', 'травмы, усталость, мотивация'],
      ['globe', 'Новости', 'за 14 дней, с источниками'],
    ];
    const stepsEl = h('div', { class: 'players-steps' });
    const drawSteps = (doneN, running) => {
      clear(stepsEl);
      STEPS.forEach(([ic, t, s], k) => {
        const state = k < doneN ? 'done' : running && k === doneN ? 'run' : '';
        stepsEl.appendChild(h('div', { class: ['players-step', state] },
          h('span', { class: 'players-step-ic' }, icon(state === 'done' ? 'check' : state === 'run' ? 'refresh' : ic)),
          h('div', { style: 'min-width:0' }, h('b', null, t), h('small', null, state === 'done' ? 'готово' : state === 'run' ? 'собираем…' : s))));
      });
    };
    drawSteps(0, false);
    const m = todayMatch(p.id);
    const opp = m && D.P[m.p1 === p.id ? m.p2 : m.p1];
    const collectBtn = button('Собрать профиль (~' + fmt.usd(COST.collect) + ', 1–2 мин)', { kind: 'primary', icon: 'database', attrs: { id: 'players-collect-btn' }, onClick: collect });
    const batchBtn = button(jobs[p.id] === 'queued' ? 'В ночном пакете' : 'В ночной пакет (−50%)', { kind: 'secondary', icon: 'clock', disabled: jobs[p.id] === 'queued', onClick: () => { queueBatch([p.id]); batchBtn.disabled = true; batchBtn.querySelector('span').textContent = 'В ночном пакете'; } });
    const status = h('p', { class: 'small soft', 'aria-live': 'polite' });
    function collect() {
      collectBtn.disabled = true; batchBtn.disabled = true;
      collectBtn.querySelector('span').textContent = 'Собираем профиль…';
      jobs[p.id] = 'running'; notify();
      let k = 0;
      drawSteps(0, true);
      const tick = () => {
        k++;
        drawSteps(k, k < STEPS.length);
        status.textContent = k < STEPS.length ? 'Готово ' + k + ' из ' + STEPS.length + '…' : '';
        if (k < STEPS.length) setTimeout(tick, 520);
        else setTimeout(() => {
          p.fresh = 'fresh'; p.updated = NOW; delete jobs[p.id]; doneNow.add(p.id);
          UI.toast('Профиль собран: ' + p.short + ' · ' + fmt.usd(COST.collect) + ' · 14 источников', 'check');
          if (location.hash.indexOf('#player-' + p.id) === 0) UI.rerender();
        }, 500);
      };
      setTimeout(tick, 520);
    }
    const collectCard = h('section', { class: 'card', id: 'players-collect-card', 'aria-label': 'Сбор профиля', style: 'scroll-margin-top: calc(var(--topbar-h) + 16px)' }, h('div', { class: 'card-body players-collect' },
      h('span', { class: 'players-collect-ic' }, icon('database')),
      h('h3', null, 'Профиль ещё не собран'),
      h('p', null, 'Из архива ATP уже есть рейтинг, Эло и результаты. Досье — стиль игры, физику и технику, психологию, новости и травмы — Claude ещё не собирал.',
        opp ? [' Без него анализ матча ', h('a', { href: IN_EXAMPLE.includes(m.id) ? '#analysis' : '#new-' + m.id }, opp.short + ' — ' + p.short), ' сегодня в ' + m.time + ' пройдёт с пометкой «неполные данные» и пониженной уверенностью.'] : null),
      h('div', { class: 'row', style: 'justify-content:center' }, collectBtn, batchBtn),
      status,
      stepsEl));

    const W = winsOf(p);
    const wl = SURF.filter(k => p.wlSurface[k]);
    const archive = h('div', { class: 'grid' },
      card({ class: 'col-7', title: 'Эло по покрытиям', subtitle: 'Общий ' + elo(p.elo.all) + ' · из архива ATP, без ИИ', body: [eloBars(p), h('p', { class: 'players-hint' }, 'Число — Эло на покрытии, полоса — разница с общим: вправо — здесь сильнее своего уровня, влево — слабее.')] }),
      card({ class: 'col-5', title: 'Что уже известно', subtitle: 'архив ATP · 2 сезона', body: [
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'players-formbig', role: 'img', 'aria-label': 'Последние 10 матчей: ' + W + ' побед' }, p.form.map(x => h('span', { class: x === 'W' ? 'w' : 'l', 'aria-hidden': 'true' }, x === 'W' ? 'В' : 'П'))), h('span', { class: 'players-hint' }, 'Форма за 10 матчей: ' + W + ' ' + fmt.plural(W, 'победа', 'победы', 'побед'))),
        UI.kv(wl.map(k => [D.surfaces[k].label, p.wlSurface[k][0] + '–' + p.wlSurface[k][1] + ' · ' + fmt.pct(p.wlSurface[k][0] / (p.wlSurface[k][0] + p.wlSurface[k][1]) * 100, 0)]).concat([['Эйсов за матч', fmt.dec(p.serve.aces, 1)], ['Очки на первой подаче', p.serve.firstWon + '%']])),
      ] }));
    root.append(collectCard, h('div', { class: 'eyebrow', style: 'margin-bottom:-6px' }, 'Уже есть из архива ATP'), archive);
  }

  // ---------- игрок не найден ----------
  function renderNotFound(root, pid) {
    UI.setHeader({ title: 'Игрок не найден', crumbs: h('span', null, h('a', { href: '#players' }, 'Игроки'), ' / ', 'карточка игрока') });
    redraw = null;
    const guess = pid ? pid.replace(/[^a-zа-яё]/gi, ' ').trim() : '';
    root.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-body players-notfound' },
      h('span', { class: 'players-notfound-ic' }, icon('users')),
      h('h3', null, 'Такого игрока нет в базе'),
      h('p', { class: 'soft', style: 'max-width:52ch' }, pid ? ['По адресу «', h('span', { class: 'mono' }, pid), '» никого не нашли. Возможно, ссылка устарела или игрок ещё не добавлен.'] : 'В адресе не указан игрок.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        button('К списку игроков', { kind: 'primary', icon: 'chevronLeft', href: '#players' }),
        button('Добавить игрока', { kind: 'secondary', icon: 'plus', onClick: () => addPlayerModal(guess && guess.length > 2 ? guess : '') })))));
  }

  // ---------- регистрация ----------
  UI.register('players', { title: 'Игроки', nav: 'players', render(root) { redraw = null; renderList(root); } });
  UI.register('player', { title: 'Игрок', nav: 'players', crumbs: 'Игроки', render(root, param) { redraw = null; renderPlayer(root, param); } });
})();
