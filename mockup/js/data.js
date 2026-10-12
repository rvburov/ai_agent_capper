/* Демо-данные макета AI Capper. Все вымышлено и детерминировано (сид-генератор),
   цифры согласованы между экранами: банк, ставки, калибровка, расходы ИИ выводятся из одного списка ставок. */
(function () {
  'use strict';
  let seed = 5555;
  const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const pick = a => a[Math.floor(rnd() * a.length)];
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  const iso = d => d.toISOString().slice(0, 10);
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return iso(d); };

  const TODAY = '2026-10-07';

  const surfaces = {
    hard: { label: 'Хард', color: 'var(--hard)' },
    clay: { label: 'Грунт', color: 'var(--clay)' },
    grass: { label: 'Трава', color: 'var(--grass)' },
    indoor: { label: 'Крытый хард', color: 'var(--indoor)' },
  };

  const players = [
    { id: 'sinner', name: 'Янник Синнер', short: 'Синнер', country: 'ITA', age: 25, rank: 1, points: 11830, hand: 'правая', backhand: 'двуручный', elo: { all: 2236, hard: 2262, clay: 2148, grass: 2171 }, form: 'WWWLWWWWWL', fresh: 'fresh', updated: '2026-10-07T04:10', style: 'Агрессивный игрок задней линии', serve: { first: 62, firstWon: 76, secondWon: 57, aces: 7.4, df: 2.1, speed: 205 }, ret: { firstRet: 34, secondRet: 56, bpConv: 44 }, wlSurface: { hard: [48, 6], clay: [14, 4], grass: [11, 2] } },
    { id: 'alcaraz', name: 'Карлос Алькарас', short: 'Алькарас', country: 'ESP', age: 23, rank: 2, points: 10950, hand: 'правая', backhand: 'двуручный', elo: { all: 2228, hard: 2205, clay: 2241, grass: 2236 }, form: 'WWLWWWWLWW', fresh: 'fresh', updated: '2026-10-07T03:55', style: 'Универсал, укороченные и выходы к сетке', serve: { first: 65, firstWon: 74, secondWon: 56, aces: 5.8, df: 2.6, speed: 201 }, ret: { firstRet: 33, secondRet: 55, bpConv: 43 }, wlSurface: { hard: [39, 9], clay: [22, 3], grass: [12, 1] } },
    { id: 'zverev', name: 'Александр Зверев', short: 'Зверев', country: 'GER', age: 29, rank: 3, points: 6820, hand: 'правая', backhand: 'двуручный', elo: { all: 2087, hard: 2079, clay: 2104, grass: 2011 }, form: 'WWLWLWWLWW', fresh: 'fresh', updated: '2026-10-06T22:40', style: 'Мощная подача, игра с задней линии', serve: { first: 68, firstWon: 78, secondWon: 53, aces: 9.1, df: 3.4, speed: 214 }, ret: { firstRet: 29, secondRet: 51, bpConv: 40 }, wlSurface: { hard: [35, 14], clay: [24, 8], grass: [8, 5] } },
    { id: 'fritz', name: 'Тейлор Фриц', short: 'Фриц', country: 'USA', age: 28, rank: 4, points: 5410, hand: 'правая', backhand: 'двуручный', elo: { all: 2041, hard: 2066, clay: 1921, grass: 2048 }, form: 'WWLWLWWWLW', fresh: 'stale', updated: '2026-10-04T18:20', style: 'Подача + первый удар', serve: { first: 66, firstWon: 80, secondWon: 54, aces: 11.2, df: 2.4, speed: 218 }, ret: { firstRet: 27, secondRet: 49, bpConv: 38 }, wlSurface: { hard: [37, 13], clay: [6, 6], grass: [12, 3] } },
    { id: 'djokovic', name: 'Новак Джокович', short: 'Джокович', country: 'SRB', age: 39, rank: 5, points: 5130, hand: 'правая', backhand: 'двуручный', elo: { all: 2154, hard: 2168, clay: 2101, grass: 2163 }, form: 'WWWLWWLWWW', fresh: 'fresh', updated: '2026-10-07T02:30', style: 'Контратакующий, лучший прием в туре', serve: { first: 64, firstWon: 75, secondWon: 56, aces: 6.0, df: 2.0, speed: 199 }, ret: { firstRet: 35, secondRet: 57, bpConv: 45 }, wlSurface: { hard: [26, 5], clay: [10, 4], grass: [9, 1] } },
    { id: 'draper', name: 'Джек Дрейпер', short: 'Дрейпер', country: 'GBR', age: 24, rank: 6, points: 4890, hand: 'левая', backhand: 'двуручный', elo: { all: 2032, hard: 2049, clay: 1979, grass: 2013 }, form: 'WLWWWLWLWW', fresh: 'fresh', updated: '2026-10-06T23:15', style: 'Левша, тяжелый топспин', serve: { first: 61, firstWon: 77, secondWon: 52, aces: 8.6, df: 3.0, speed: 210 }, ret: { firstRet: 30, secondRet: 51, bpConv: 41 }, wlSurface: { hard: [31, 11], clay: [11, 6], grass: [7, 3] } },
    { id: 'medvedev', name: 'Даниил Медведев', short: 'Медведев', country: 'RUS', age: 30, rank: 11, points: 3410, hand: 'правая', backhand: 'двуручный', elo: { all: 2013, hard: 2051, clay: 1868, grass: 1949 }, form: 'LWWLWLWWLW', fresh: 'stale', updated: '2026-10-03T11:05', style: 'Оборонительный, длинные розыгрыши', serve: { first: 63, firstWon: 74, secondWon: 51, aces: 8.0, df: 3.3, speed: 207 }, ret: { firstRet: 31, secondRet: 52, bpConv: 40 }, wlSurface: { hard: [33, 15], clay: [7, 7], grass: [6, 4] } },
    { id: 'rune', name: 'Хольгер Руне', short: 'Руне', country: 'DEN', age: 23, rank: 12, points: 3320, hand: 'правая', backhand: 'двуручный', elo: { all: 1968, hard: 1971, clay: 1966, grass: 1903 }, form: 'WWLWLLWWLL', fresh: 'missing', updated: null, style: 'Эмоциональный атакующий', serve: { first: 60, firstWon: 73, secondWon: 50, aces: 6.1, df: 3.8, speed: 206 }, ret: { firstRet: 30, secondRet: 50, bpConv: 39 }, wlSurface: { hard: [24, 13], clay: [13, 7], grass: [4, 3] } },
    { id: 'deminaur', name: 'Алекс де Минор', short: 'де Минор', country: 'AUS', age: 27, rank: 8, points: 3950, hand: 'правая', backhand: 'двуручный', elo: { all: 1995, hard: 2021, clay: 1902, grass: 1985 }, form: 'WWLWWLWWWL', fresh: 'fresh', updated: '2026-10-06T20:00', style: 'Скорость, плоские удары', serve: { first: 64, firstWon: 71, secondWon: 53, aces: 4.2, df: 2.0, speed: 196 }, ret: { firstRet: 32, secondRet: 54, bpConv: 42 }, wlSurface: { hard: [36, 13], clay: [9, 7], grass: [9, 3] } },
    { id: 'shelton', name: 'Бен Шелтон', short: 'Шелтон', country: 'USA', age: 24, rank: 7, points: 4120, hand: 'левая', backhand: 'двуручный', elo: { all: 2002, hard: 2029, clay: 1925, grass: 1962 }, form: 'WWLWLWWWLW', fresh: 'fresh', updated: '2026-10-07T01:40', style: 'Пушечная подача левши', serve: { first: 61, firstWon: 81, secondWon: 52, aces: 12.4, df: 3.9, speed: 222 }, ret: { firstRet: 26, secondRet: 48, bpConv: 37 }, wlSurface: { hard: [30, 12], clay: [8, 6], grass: [6, 3] } },
    { id: 'musetti', name: 'Лоренцо Музетти', short: 'Музетти', country: 'ITA', age: 24, rank: 9, points: 3880, hand: 'правая', backhand: 'одноручный', elo: { all: 1984, hard: 1950, clay: 2041, grass: 1977 }, form: 'WWLLWWLWWW', fresh: 'stale', updated: '2026-10-05T09:30', style: 'Вариативный, одноручный бэкхенд', serve: { first: 62, firstWon: 72, secondWon: 52, aces: 4.8, df: 2.7, speed: 200 }, ret: { firstRet: 31, secondRet: 52, bpConv: 41 }, wlSurface: { hard: [22, 12], clay: [21, 7], grass: [8, 3] } },
    { id: 'rublev', name: 'Андрей Рублев', short: 'Рублев', country: 'RUS', age: 28, rank: 14, points: 2980, hand: 'правая', backhand: 'двуручный', elo: { all: 1941, hard: 1952, clay: 1938, grass: 1880 }, form: 'WWLLWLWLWL', fresh: 'fresh', updated: '2026-10-06T21:50', style: 'Силовой форхенд', serve: { first: 60, firstWon: 74, secondWon: 51, aces: 6.7, df: 2.9, speed: 208 }, ret: { firstRet: 29, secondRet: 50, bpConv: 39 }, wlSurface: { hard: [27, 15], clay: [15, 8], grass: [5, 4] } },
  ];
  players.forEach(p => { p.form = p.form.split(''); }); // form[0] — последний матч
  // Рейтинга ATP в базе нет: место по Эло среди игроков с матчами за 52 недели считает код (в макете — среди демо-игроков)
  players.slice().sort((a, b) => b.elo.all - a.elo.all).forEach((p, i) => { p.eloPlace = i + 1; });
  const P = Object.fromEntries(players.map(p => [p.id, p]));

  // Календарь туров (июль–октябрь 2026)
  // На турнирах Большого шлема матч до трех побед в сетах (best_of = 5), на остальных — до двух
  const calendar = [
    { from: '2026-07-01', to: '2026-07-12', name: 'Уимблдон', cat: 'Grand Slam', surface: 'grass' },
    { from: '2026-07-13', to: '2026-07-26', name: 'Гамбург / Умаг', cat: 'ATP 500', surface: 'clay' },
    { from: '2026-07-27', to: '2026-08-02', name: 'Вашингтон', cat: 'ATP 500', surface: 'hard' },
    { from: '2026-08-03', to: '2026-08-13', name: 'Торонто', cat: 'Masters 1000', surface: 'hard' },
    { from: '2026-08-14', to: '2026-08-23', name: 'Цинциннати', cat: 'Masters 1000', surface: 'hard' },
    { from: '2026-08-24', to: '2026-09-13', name: 'US Open', cat: 'Grand Slam', surface: 'hard' },
    { from: '2026-09-14', to: '2026-09-23', name: 'Чэнду / Ханчжоу', cat: 'ATP 250', surface: 'hard' },
    { from: '2026-09-24', to: '2026-10-01', name: 'Пекин / Токио', cat: 'ATP 500', surface: 'hard' },
    { from: '2026-10-02', to: '2026-10-12', name: 'Шанхай', cat: 'Masters 1000', surface: 'hard' },
  ];
  const tourAt = d => calendar.find(t => d >= t.from && d <= t.to) || calendar[calendar.length - 1];

  // Генерация истории ставок
  // Шесть исходов, как в коде (ml/sets.py): победа и фора ±1.5 по сетам на каждого игрока
  const markets = [
    { id: 'p1', label: 'П1' }, { id: 'p2', label: 'П2' }, { id: 'h1m', label: 'Ф1(−1.5)' }, { id: 'h2m', label: 'Ф2(−1.5)' }, { id: 'h1p', label: 'Ф1(+1.5)' }, { id: 'h2p', label: 'Ф2(+1.5)' },
  ];
  // Доля банка по таблице стратегии (Т20): диапазоны итогового кэфа 1.28–1.70, 1.71–2.20, 2.21–3.24
  const stakePct = k => k <= 1.70 ? 2.75 : k <= 2.20 ? 2.25 : 1.75;
  const TOTAL_MIN = 1.28; // ниже первого диапазона таблицы ставку стратегия не предлагает
  // Второе событие для ординара с низким кэфом: фаворит по Эло на покрытии, кэф 1.30–1.42, событие сыграло
  function extraLeg(t, used, id) {
    const free = players.filter(p => !used.has(p.id));
    const a = free[id % free.length], b = free[(id * 3 + 1) % free.length] === a ? free[(id + 1) % free.length] : free[(id * 3 + 1) % free.length];
    used.add(a.id); used.add(b.id);
    const fav = a.elo[t.surface] >= b.elo[t.surface] ? a : b, dog = fav === a ? b : a;
    const odds = round(1.30 + (id * 7 % 13) / 100, 2);
    return { p1: fav.id, p2: dog.id, market: 'p1', marketLabel: 'П1', odds, closing: round(odds * (1 - (id % 3) / 100), 2), p: round(Math.min(0.94, 1 / odds * 1.05 + 0.03), 3), result: 'win', surface: t.surface, tournament: t.name, bestOf: t.cat === 'Grand Slam' ? 5 : 3 };
  }
  const bets = [];
  let bank = 40000;
  const bankHistory = [{ date: '2026-07-01', bank }];
  let date = '2026-07-02', id = 1;
  const allLegs = [];
  while (date < TODAY) {
    if (rnd() < 0.72) {
      const t = tourAt(date);
      const nLegs = rnd() < 0.3 ? 1 : rnd() < 0.65 ? 2 : 3;
      const legs = [];
      const used = new Set();
      for (let k = 0; k < nLegs; k++) {
        let a, b; do { a = pick(players); b = pick(players); } while (a === b || used.has(a.id) || used.has(b.id));
        used.add(a.id); used.add(b.id);
        const fav = a.elo[t.surface] >= b.elo[t.surface] ? a : b, dog = fav === a ? b : a;
        const mk = rnd() < 0.55 ? 'p1' : rnd() < 0.5 ? 'h1m' : rnd() < 0.6 ? 'h2p' : 'p2';
        let odds = mk === 'p1' ? 1.15 + rnd() * 0.55 : mk === 'h1m' ? 1.45 + rnd() * 0.35 : mk === 'h2p' ? 1.18 + rnd() * 0.4 : 1.55 + rnd() * 0.25;
        odds = round(odds, 2);
        const implied = 1 / odds;
        const edge = 0.02 + rnd() * 0.09;
        const p = Math.min(0.94, implied * 1.05 + edge * 0.5);
        const trueP = Math.min(0.95, implied * 1.055 + (rnd() - 0.5) * 0.04);
        const won = rnd() < trueP;
        const closing = round(odds * (1 - (rnd() * 0.05 - 0.012)), 2);
        const p1 = mk === 'h2p' || mk === 'p2' ? dog : fav, p2 = p1 === fav ? dog : fav;
        const leg = { p1: p1.id, p2: p2.id, market: mk, marketLabel: markets.find(m => m.id === mk).label, odds, closing, p: round(p, 3), result: won ? 'win' : 'loss', surface: t.surface, tournament: t.name, bestOf: t.cat === 'Grand Slam' ? 5 : 3 };
        legs.push(leg);
      }
      while (legs.length > 1 && legs.reduce((a, l) => a * l.odds, 1) > 3.24) legs.pop();
      // Ординар с кэфом ниже 1.28 стратегия не ставит (такого диапазона в таблице нет): добавляем второе событие.
      // Без случайных чисел — так остальные ставки и исходы не меняются
      if (legs.length === 1 && legs[0].odds < TOTAL_MIN) legs.push(extraLeg(t, used, id));
      legs.forEach(leg => allLegs.push(Object.assign({ date, betId: id }, leg)));
      let total = round(legs.reduce((a, l) => a * l.odds, 1), 2);
      const voided = rnd() < 0.03;
      const bookmaker = pick(['bet365', 'Unibet', 'Pinnacle', 'bet365']);
      const won = legs.every(l => l.result === 'win');
      const stake = Math.round(bank * stakePct(total) / 100 / 10) * 10;
      const status = voided ? 'void' : won ? 'win' : 'loss';
      const profit = status === 'win' ? Math.round(stake * total - stake) : status === 'loss' ? -stake : 0;
      bank += profit;
      // CLV экспресса — из неокругленных произведений кэфов, как при вводе результата на экране «Ставки»
      const clv = round((legs.reduce((a, l) => a * l.odds, 1) / legs.reduce((a, l) => a * l.closing, 1) - 1) * 100, 1);
      bets.push({ id, date, tournament: t.name, surface: t.surface, legs, total, stake, status, profit, bankAfter: bank, clv, bookmaker });
      bankHistory.push({ date, bank });
      id++;
    }
    date = addDays(date, 1);
  }
  // Неделя Шанхая (с 2 окт): игроки сегодняшних 1/8 в истории только побеждают и не встречаются между собой.
  // Меняем только имена; рынок, кэфы, вероятности и исходы остаются прежними, поэтому вся статистика не меняется.
  const TODAY_IDS = ['sinner', 'rune', 'djokovic', 'rublev', 'zverev', 'musetti', 'alcaraz', 'shelton', 'fritz', 'deminaur'];
  const OTHERS = ['medvedev', 'draper', 'Хачанов', 'Бублик', 'Умбер', 'Махач', 'Коболли', 'Попырин', 'Табило', 'Мунар', 'Нисиока', 'Шан Цзюньчэн'];
  const winnerSide = l => l.market === 'p1' || l.market === 'h1m' ? (l.result === 'win' ? 'p1' : 'p2')
    : l.market === 'p2' ? (l.result === 'win' ? 'p2' : 'p1')
    : l.result === 'loss' ? (l.market === 'h2p' ? 'p1' : 'p2') : null; // фора +1.5 сыграла — победитель матча неизвестен
  const weekUsed = new Set(); // кроме сегодняшних победителей, каждый игрок встречается на неделе один раз
  const nextOther = () => OTHERS.find(n => !weekUsed.has(n));
  bets.filter(b => b.date >= '2026-10-02').forEach(b => {
    const usedToday = new Set();
    b.legs.forEach(l => {
      const w = winnerSide(l);
      ['p1', 'p2'].forEach(side => {
        const name = l[side], isToday = TODAY_IDS.includes(name);
        if (isToday && side === w && !usedToday.has(name)) { usedToday.add(name); return; }
        if (!isToday && !weekUsed.has(name)) { weekUsed.add(name); return; }
        const n = nextOther(); weekUsed.add(n); l[side] = n;
      });
      const twin = allLegs.find(a => a.betId === b.id && a.market === l.market && a.odds === l.odds && a.result === l.result);
      if (twin) { twin.p1 = l.p1; twin.p2 = l.p2; }
    });
  });

  // Открытая ставка на сегодня: экспресс по матчам вне демо-анализа #A-0142 (его экспресс создается на экране «Анализ»)
  const openLegs = [
    [{ p1: 'zverev', p2: 'musetti', market: 'p1', marketLabel: 'П1', odds: 1.48, p: 0.71, surface: 'hard', tournament: 'Шанхай', bestOf: 3 }, { p1: 'alcaraz', p2: 'shelton', market: 'p1', marketLabel: 'П1', odds: 1.30, p: 0.82, surface: 'hard', tournament: 'Шанхай', bestOf: 3 }],
  ];
  openLegs.forEach((legs, k) => {
    const total = round(legs.reduce((a, l) => a * l.odds, 1), 2);
    const stake = Math.round(bank * stakePct(total) / 100 / 10) * 10;
    bets.push({ id, date: TODAY, tournament: 'Шанхай', surface: 'hard', legs: legs.map(l => Object.assign({ closing: null, result: 'open' }, l)), total, stake, status: 'open', profit: 0, bankAfter: null, clv: null, bookmaker: 'bet365' });
    id++;
  });

  // ---------- Поля этапа 4 (решения В1, В2, В5, Т3, Т9, Т10, Т13): считаются из истории без генератора, ----------
  // поэтому ставки, банк и исходы не меняются.
  // Вероятность рынка без маржи — степенной метод, как ml/market.py: ищем k, при котором (1/o1)^k + (1/o2)^k = 1
  const devig = (o1, o2) => {
    const a = 1 / o1, b = 1 / o2;
    let lo = 0.2, hi = 5;
    for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (a ** k + b ** k > 1) lo = k; else hi = k; }
    return a ** ((lo + hi) / 2);
  };
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  // В5: история до 1 августа перенесена из старого Telegram-бота. Такие ставки идут в банк и ROI, но не в CLV,
  // Brier против рынка и калибровку p_final: у бота есть только оценка Claude и кэф (Т10)
  const BOT_UNTIL = '2026-08-01';
  const betById = Object.fromEntries(bets.map(b => [b.id, b]));
  function enrichLeg(l, b, i) {
    const bot = b.date < BOT_UNTIL;
    // кэф противоположного исхода у вашего букмекера в момент прогноза (маржа ≈ 5,5%) → рынок при прогнозе без маржи (В2)
    l.oddsOpp = round(1 / (1.055 - 1 / l.odds), 2);
    l.q = bot ? null : round(devig(l.odds, l.oddsOpp), 3);
    // p — итоговая вероятность (p_final); в таблице калибровки рядом — базовая модель (p_base) и после поправки Claude (p_claude)
    const s = b.id * 7 + i * 5;
    l.pb = bot ? null : round(clamp(l.p - 0.025 + (s % 9 - 4) / 100, 0.45, 0.95), 3);
    l.pc = bot ? l.p : round(clamp(l.p + ((b.id * 3 + i * 7) % 7 - 3) / 200, 0.45, 0.96), 3);
    l.pKind = bot ? 'claude' : 'final';
    // старый бот закрывающих кэфов не записывал — у его ставок CLV нет (В5, LLM_LEARNING 2.4)
    if (bot) l.closing = null;
    // у части ставок приложения закрывающий кэф последнего события не внесен — CLV ставки не считается (В1)
    if (!bot && b.status !== 'open' && b.id % 11 === 0 && i === b.legs.length - 1) l.closing = null;
    if (l.closing) {
      // В1: чей закрывающий кэф внес участник — эталон по Р17 (Pinnacle → Betfair → средний) или свой букмекер
      l.closingBy = (b.id + i) % 5 === 0 ? b.bookmaker : (b.id + i) % 7 === 0 ? 'Betfair' : 'Pinnacle';
      // вторую сторону закрытия вносят по желанию — тогда есть рынок закрытия без маржи и «CLV без маржи» (Т13)
      if (!bot && (b.id + i) % 3 === 0) { l.closingOpp = round(1 / (1.03 - 1 / l.closing), 2); l.qClose = round(devig(l.closing, l.closingOpp), 3); }
    }
    // Т10: у проигранных экспрессов бота исходы ног не записаны
    if (bot && b.status === 'loss' && b.legs.length > 1) l.noResult = true;
  }
  bets.forEach(b => {
    b.source = b.date < BOT_UNTIL ? 'bot' : 'app';
    b.legs.forEach((l, i) => enrichLeg(l, b, i));
    const live = b.legs.filter(l => l.result !== 'open');
    if (live.length && live.some(l => !l.closing)) b.clv = null;
  });
  // allLegs — копии ног с датой и номером ставки: те же поля по тому же номеру ноги
  const legIndex = {};
  allLegs.forEach(l => {
    const b = betById[l.betId], i = legIndex[l.betId] = (legIndex[l.betId] == null ? 0 : legIndex[l.betId] + 1);
    l.source = b.source;
    enrichLeg(l, b, i);
  });

  const settled = bets.filter(b => b.status !== 'open');
  const wins = settled.filter(b => b.status === 'win').length;
  const losses = settled.filter(b => b.status === 'loss').length;
  const voids = settled.filter(b => b.status === 'void').length;
  const turnover = settled.reduce((a, b) => a + b.stake, 0);
  const profit = settled.reduce((a, b) => a + b.profit, 0);
  let streak = 0, streakType = settled[settled.length - 1].status;
  for (let i = settled.length - 1; i >= 0 && settled[i].status === streakType; i--) streak++;
  // Brier модели и рынка — по рынку при прогнозе без маржи (В2, степенной метод), только ставки приложения (В5)
  const appLegs = allLegs.filter(l => l.q != null);
  const brier = appLegs.reduce((a, l) => a + (l.p - (l.result === 'win' ? 1 : 0)) ** 2, 0) / appLegs.length;
  const brierMarket = appLegs.reduce((a, l) => a + (l.q - (l.result === 'win' ? 1 : 0)) ** 2, 0) / appLegs.length;
  const clvBets = settled.filter(b => b.clv != null && b.source !== 'bot');
  const clvAvg = clvBets.reduce((a, b) => a + b.clv, 0) / clvBets.length;

  // Калибровка по событиям (ногам экспрессов) — только ставки приложения с итоговой вероятностью (В5), как в «Аналитике»
  const calibration = [];
  for (let lo = 0.5; lo < 0.95; lo += 0.05) {
    const hi = lo + 0.05;
    const inBin = appLegs.filter(l => l.p >= lo && l.p < hi);
    if (!inBin.length) continue;
    calibration.push({ lo: round(lo, 2), hi: round(hi, 2), p: round(inBin.reduce((a, l) => a + l.p, 0) / inBin.length, 3), actual: round(inBin.filter(l => l.result === 'win').length / inBin.length, 3), n: inBin.length });
  }
  // Скользящий Brier (окно 30 событий) — модель против рынка
  const brierRolling = [];
  for (let i = 29; i < appLegs.length; i += 3) {
    const w = appLegs.slice(i - 29, i + 1);
    brierRolling.push({ date: w[w.length - 1].date, model: round(w.reduce((a, l) => a + (l.p - (l.result === 'win' ? 1 : 0)) ** 2, 0) / 30, 3), market: round(w.reduce((a, l) => a + (l.q - (l.result === 'win' ? 1 : 0)) ** 2, 0) / 30, 3) });
  }
  // ROI по срезам (события как одиночные ставки с равной суммой)
  const roiBy = (key, labelOf) => {
    const groups = {};
    allLegs.forEach(l => { const k = key(l); (groups[k] = groups[k] || []).push(l); });
    return Object.entries(groups).map(([k, ls]) => ({ key: k, label: labelOf ? labelOf(k) : k, n: ls.length, roi: round(ls.reduce((a, l) => a + (l.result === 'win' ? l.odds - 1 : -1), 0) / ls.length * 100, 1), winrate: round(ls.filter(l => l.result === 'win').length / ls.length * 100, 1) }));
  };
  const roiBySurface = roiBy(l => l.surface, k => surfaces[k].label);
  const roiByMarket = roiBy(l => l.marketLabel);
  const oddsBucket = o => o < 1.3 ? '1.13–1.29' : o < 1.5 ? '1.30–1.49' : o < 1.65 ? '1.50–1.64' : '1.65–1.80';
  const roiByOdds = roiBy(l => oddsBucket(l.odds)).sort((a, b) => a.key.localeCompare(b.key));
  // ROI по итоговому кэфу экспресса (реальные ставки)
  // четвертый диапазон 3.25–4.10 — только экспресс из 3 событий (Т20)
  const totalBucket = k => k < 1.71 ? '1.28–1.70' : k < 2.21 ? '1.71–2.20' : k < 3.25 ? '2.21–3.24' : '3.25–4.10';
  const roiByTotal = Object.entries(settled.reduce((g, b) => { const k = totalBucket(b.total); (g[k] = g[k] || []).push(b); return g; }, {})).map(([k, bs]) => ({ key: k, label: k, n: bs.length, roi: round(bs.reduce((a, b) => a + b.profit, 0) / bs.reduce((a, b) => a + b.stake, 0) * 100, 1) })).sort((a, b) => a.key.localeCompare(b.key));

  // Матчи сегодня (Шанхай, 1/8 финала): матчи, которые участники ввели в анализы (matches.scheduled_at), с примером кэфов.
  // Расписания и линии в программе нет (Р10): на главной — только «Мои матчи сегодня» из своих ставок и анализов (В6).
  const matchesToday = [
    { id: 'm1', p1: 'sinner', p2: 'rune', time: '10:30', round: '1/8 финала', court: 'Stadium Court', odds: { p1: 1.17, p2: 5.10, h1m: 1.62, h2p: 2.30 } },
    { id: 'm2', p1: 'djokovic', p2: 'rublev', time: '12:00', round: '1/8 финала', court: 'Grand Stand', odds: { p1: 1.34, p2: 3.35, h1m: 2.05, h2p: 1.72 } },
    { id: 'm3', p1: 'zverev', p2: 'musetti', time: '13:30', round: '1/8 финала', court: 'Court 3', odds: { p1: 1.48, p2: 2.70, h1m: 2.45, h2p: 1.52 } },
    { id: 'm4', p1: 'alcaraz', p2: 'shelton', time: '15:00', round: '1/8 финала', court: 'Stadium Court', odds: { p1: 1.30, p2: 3.60, h1m: 1.98, h2p: 1.80 } },
    { id: 'm5', p1: 'fritz', p2: 'deminaur', time: '16:30', round: '1/8 финала', court: 'Grand Stand', odds: { p1: 1.72, p2: 2.12, h1m: 3.10, h2p: 1.38 } },
  ].map(m => Object.assign({ tournament: 'Шанхай', category: 'Masters 1000', surface: 'hard', date: TODAY }, m));

  // Последние анализы (экран «Новый анализ» → «Последние анализы»): после ухода со страницы анализ открывается по номеру.
  // В приложении — GET /analyses (свои, последние 20); статусы: done, failed, cancelled, идет
  // demo: true — анализ с теми же матчами, что демо-пример экрана «Анализ»; остальные в макете открываются на нем же
  const recentAnalyses = [
    // newsCached — новости, которые анализ взял из кэша (моложе 12 ч): когда их нашли в анализах других участников
    { id: 'A-0141', at: '2026-10-07T09:12', matches: [{ p1: 'sinner', p2: 'rune' }, { p1: 'djokovic', p2: 'rublev' }], status: 'done', decision: 'bet', cost: 0.17, demo: true,
      newsCached: { sinner: '2026-10-07T04:10', djokovic: '2026-10-07T02:30', rublev: '2026-10-06T21:50' } },
    { id: 'A-0140', at: '2026-10-06T18:40', matches: [{ p1: 'fritz', p2: 'deminaur' }, { p1: 'draper', p2: 'medvedev' }], status: 'failed', note: 'шаг 8 из 9: Claude перегружен', cost: 0.13 },
    { id: 'A-0139', at: '2026-10-06T10:15', matches: [{ p1: 'sinner', p2: 'medvedev' }, { p1: 'djokovic', p2: 'shelton' }, { p1: 'alcaraz', p2: 'rune' }], status: 'done', decision: 'skip', cost: 0.24 },
    { id: 'A-0138', at: '2026-10-05T19:30', matches: [{ p1: 'zverev', p2: 'rublev' }, { p1: 'fritz', p2: 'musetti' }], status: 'cancelled', cost: 0.05 },
    { id: 'A-0137', at: '2026-10-05T09:50', matches: [{ p1: 'sinner', p2: 'draper' }, { p1: 'alcaraz', p2: 'deminaur' }], status: 'done', decision: 'bet', cost: 0.16 },
  ];

  // Расходы ИИ (октябрь). Строка — вызов Claude (agent_runs), как в коде этапа 3 (Т17, Т19):
  // разбор текста — Haiku 5.5; новости перед анализом — Sonnet 5.5 с веб-поиском (2 поиска на матч, кэш 12 часов);
  // оценка матча — Opus 5.5, один вызов на матч: первый пишет общий префикс в кэш, следующие его читают.
  // Разбора ставки и ночного обновления профилей нет (этап 5). Генератор детерминированный, без сида:
  // расход сходится с «Последними анализами» и бюджетом ключа.
  const runTypes = [
    { id: 'analysis', label: 'Оценка матча', model: 'Opus 5.5', effort: 'medium', what: 'Оценка матча: один вызов на матч' },
    { id: 'news', label: 'Новости перед анализом', model: 'Sonnet 5.5', effort: 'low', what: 'Веб-поиск: 2 поиска на матч, кэш 12 часов' },
    { id: 'parse', label: 'Разбор текста событий', model: 'Haiku 5.5', effort: 'low', what: 'Вставленный текст → список событий' },
  ];
  // $ за 1 млн токенов: вход, выход, чтение кэша; запись в кэш — вход × 1,25 (docs/TOKEN_ECONOMY.md)
  const PRICE_M = { 'Opus 5.5': [4, 20, 0.2], 'Sonnet 5.5': [2, 10, 0.1], 'Haiku 5.5': [0.1, 0.5, 0.01] };
  const SEARCH_USD = 0.01;
  // n — матчей, news — матчей с поиском новостей (у остальных новости свежее 12 часов), parse — ввод текстом;
  // cancelled — отменен после шага новостей; failedAt — номер вызова Opus, который не прошел (Claude перегружен)
  const analysesSpec = [
    { id: 'A-0131', at: '2026-10-01T09:20', n: 2, news: 0, parse: true },
    { id: 'A-0132', at: '2026-10-01T15:03', n: 2, news: 0, parse: false },
    { id: 'A-0133', at: '2026-10-02T12:31', n: 2, news: 1, parse: true },
    { id: 'A-0134', at: '2026-10-02T14:55', n: 3, news: 0, parse: false },
    { id: 'A-0135', at: '2026-10-03T12:06', n: 3, news: 1, parse: true },
    { id: 'A-0136', at: '2026-10-04T11:38', n: 2, news: 0, parse: true },
    { id: 'A-0137', at: '2026-10-05T09:50', n: 2, news: 1, parse: true },
    { id: 'A-0138', at: '2026-10-05T19:30', n: 2, news: 1, parse: true, cancelled: true },
    { id: 'A-0139', at: '2026-10-06T10:15', n: 3, news: 0, parse: false },
    { id: 'A-0140', at: '2026-10-06T18:40', n: 2, news: 1, parse: true, failedAt: 1 },
    { id: 'A-0141', at: '2026-10-07T09:12', n: 2, news: 1, parse: true },
  ];
  const addMin = (iso, m) => { const d = new Date(iso + ':00Z'); d.setUTCMinutes(d.getUTCMinutes() + m); return d.toISOString().slice(0, 16); };
  function makeRun(o) {
    const t = runTypes.find(x => x.id === o.type), p = PRICE_M[t.model];
    const cost = (o.fresh * p[0] + o.written * p[0] * 1.25 + o.read * p[2] + o.output * p[1]) / 1e6 + o.searches * SEARCH_USD;
    return Object.assign({ typeLabel: t.label, model: t.model, effort: t.effort, batch: false, status: 'ok' }, o, {
      input: o.fresh + o.written + o.read, cached: o.read, cost: round(cost, o.type === 'parse' ? 5 : 3),
    });
  }
  const aiRuns = [];
  analysesSpec.forEach((a, ai) => {
    let at = a.at, step = 0, k = 0;
    const push = o => { aiRuns.push(makeRun(Object.assign({ id: 'run-' + a.id.slice(2) + '-' + (k++), at, analysis: a.id, step: step }, o))); };
    if (a.parse) { step = 1; push({ type: 'parse', fresh: 1900 + (ai * 137) % 700, written: 0, read: 0, output: 420 + (ai * 53) % 160, searches: 0, duration: 9 + ai % 6 }); at = addMin(at, 1); }
    step = 3;
    for (let m = 0; m < a.news; m++) {
      push({ type: 'news', match: m, fresh: 262 + (ai * 31) % 120, written: 30200 + (ai * 977 + m * 431) % 3600, read: 4100 + (ai * 211) % 900, output: 980 + (ai * 67 + m * 41) % 260, searches: 2, duration: 34 + (ai * 7 + m * 5) % 22 });
      at = addMin(at, 1);
    }
    if (a.cancelled) return;
    step = 6;
    for (let m = 0; m < a.n; m++) {
      const first = m === 0;
      if (a.failedAt === m) { push({ type: 'analysis', match: m, fresh: 0, written: 0, read: 0, output: 0, searches: 0, duration: 31, status: 'error', error: 'Claude перегружен (529), повтор не помог' }); return; }
      push({ type: 'analysis', match: m, fresh: 3800 + (ai * 173 + m * 97) % 700, written: first ? 6100 : 0, read: first ? 0 : 6100, output: 1500 + (ai * 89 + m * 61) % 320, searches: 0, duration: 48 + (ai * 11 + m * 7) % 40 });
      at = addMin(at, 1);
    }
  });
  // Общие фоновые задачи: вызовы на ключе администратора без участника — сейчас это приемка этапа (agent-smoke).
  // В лимит участника они не входят, в общий бюджет ключа — входят.
  [
    { type: 'news', fresh: 262, written: 32444, read: 4498, output: 1076, searches: 2, duration: 41 },
    { type: 'analysis', fresh: 4100, written: 6100, read: 0, output: 1620, searches: 0, duration: 63 },
  ].forEach((o, k) => aiRuns.push(makeRun(Object.assign({ id: 'run-smoke-' + k, at: addMin('2026-10-02T21:10', k), shared: true, tag: 'Приемка (agent-smoke)', step: 0 }, o))));
  aiRuns.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // Проверки (eval) — свой бюджет на ключе администратора, $25 в месяц: ни в лимит участника, ни в общий бюджет не входят
  const evalRuns = [
    { at: '2026-10-04T10:02', what: 'smoke-eval: 40 сыгранных матчей, Opus 5.5 через Batch', cost: 0.58 },
    { at: '2026-10-04T10:41', what: 'parse-eval: 30 текстов, Haiku 5.5', cost: 0.02 },
  ];
  const evalBudget = { monthly: 25, spent: round(evalRuns.reduce((a, r) => a + r.cost, 0), 2), runs: evalRuns };
  const aiSpent = round(aiRuns.reduce((a, r) => a + r.cost, 0), 2);

  const lessons = [
    { id: 'L-014', text: 'Фора −1.5 на фаворита против левши с подачей 210+ км/ч сыграла хуже ожиданий: тай-брейки срезают «сухую» победу.', status: 'confirmed', evidence: 23, effect: '+0,018 к лог-лоссу без урока', scope: 'Фора −1.5 · хард', inPrompt: true, created: '2026-09-12' },
    { id: 'L-017', text: 'После пятисетового матча за 48 часов до игры вероятность фаворита завышалась в среднем на 6 п.п.', status: 'confirmed', evidence: 21, effect: '+0,006 к Brier без урока', scope: 'Усталость · все покрытия', inPrompt: true, created: '2026-09-21' },
    { id: 'L-019', text: 'Новости о «легкой травме» из соцсетей без подтверждения турнира не дают предсказательной силы.', status: 'confirmed', evidence: 11, effect: 'нейтрально, экономит 2 поиска', scope: 'Сбор новостей', inPrompt: true, created: '2026-09-28' },
    { id: 'L-021', text: 'Возможно, на ночных сессиях в Азии аутсайдеры берут сет чаще.', status: 'hypothesis', evidence: 6, effect: 'нужно ≥ 20 случаев', scope: 'Ф(+1.5) · Азия', inPrompt: false, created: '2026-10-03' },
    { id: 'L-012', text: 'Перевес в личных встречах на другом покрытии переносится на хард.', status: 'rejected', evidence: 19, effect: 'ухудшал калибровку', scope: 'Личные встречи', inPrompt: false, created: '2026-08-30' },
  ];

  const strategyVersions = [
    { id: 'v1', name: 'v1 · исходная', date: '2026-07-01', logloss: 0.612, brier: 0.214, roi: -2.1, clv: 0.4, n: 220, status: 'archived' },
    { id: 'v2', name: 'v2 · + Эло по покрытиям', date: '2026-08-05', logloss: 0.596, brier: 0.207, roi: 1.8, clv: 1.2, n: 220, status: 'archived' },
    { id: 'v3', name: 'v3 · + уроки L-014, L-017', date: '2026-09-22', logloss: 0.583, brier: 0.201, roi: 4.9, clv: 2.0, n: 220, status: 'active' },
    { id: 'v4', name: 'v4 · промпт на английском, сжатое досье', date: '2026-10-05', logloss: 0.581, brier: 0.200, roi: 5.2, clv: 2.1, n: 220, status: 'candidate' },
  ];


  // ---------- Участники, доступ и уведомления (решения Р1–Р20 в docs/PLAN.md) ----------
  // Демо-вход под двумя ролями: администратор (владелец) и участник. Ставки, банк и запуски ИИ
  // у обоих демо-пользователей одни и те же: в макете показываем вид интерфейса, а не разные истории.
  const sumCost = rs => round(rs.reduce((a, r) => a + r.cost, 0), 2);
  const personalSpent = sumCost(aiRuns.filter(r => !r.shared)); // анализы: разбор текста, новости, оценка матчей
  const sharedSpent = sumCost(aiRuns.filter(r => r.shared));  // общие фоновые задачи без участника, платит администратор
  // Анализ — запуск из нескольких вызовов: считаем анализы, а не вызовы
  const analysesN = analysesSpec.length;
  const analysesToday = analysesSpec.filter(a => a.at.startsWith(TODAY)).length;
  // Цена анализа в «Последних анализах» — сумма его вызовов
  recentAnalyses.forEach(x => { x.cost = sumCost(aiRuns.filter(r => r.analysis === x.id)); });
  const personas = {
    admin: { id: 'u1', name: 'Роман Буров', first: 'Роман', email: 'roman@example.com', initials: 'РБ', tz: 'Europe/Helsinki', role: 'admin', roleLabel: 'Администратор', since: '2026-06-28', aiMode: 'admin', bookmakers: ['bet365', 'Unibet', 'Pinnacle'] },
    member: { id: 'u2', name: 'Ольга Лехтинен', first: 'Ольга', email: 'olga@example.com', initials: 'ОЛ', tz: 'Europe/Helsinki', role: 'member', roleLabel: 'Участник', since: '2026-06-30', aiMode: 'admin', bookmakers: ['bet365', 'Unibet', 'Pinnacle'] },
  };
  // Лимиты на ключе администратора (Р13: по умолчанию $10 в месяц, 3 анализа в день, не больше $1 за анализ)
  const LIMIT_DEFAULT = { monthly: 10, daily: 3, perAnalysis: 1 };
  const users = [
    { id: 'u1', name: 'Роман Буров', email: 'roman@example.com', role: 'admin', status: 'active', aiMode: 'admin', limit: null, spent: personalSpent, analyses: analysesN, todayAnalyses: analysesToday, lastLogin: '2026-10-07T08:41', twoFa: true, since: '2026-06-28', you: true, consent: true },
    { id: 'u2', name: 'Ольга Лехтинен', email: 'olga@example.com', role: 'member', status: 'active', aiMode: 'admin', limit: Object.assign({}, LIMIT_DEFAULT), spent: personalSpent, analyses: analysesN, todayAnalyses: analysesToday, lastLogin: '2026-10-07T07:55', twoFa: true, since: '2026-06-30', consent: true },
    { id: 'u3', name: 'Алексей Ковалев', email: 'alexey@example.com', role: 'member', status: 'active', aiMode: 'admin', limit: { monthly: 8, daily: 5, perAnalysis: 1 }, spent: 7.28, analyses: 33, todayAnalyses: 4, lastLogin: '2026-10-07T09:12', twoFa: true, since: '2026-07-15', consent: true },
    { id: 'u4', name: 'Дмитрий Шульц', email: 'dmitry@example.com', role: 'member', status: 'active', aiMode: 'own', ownKey: { last4: '7Qx2', verified: '2026-09-02T18:30' }, ownCap: 1, limit: null, spent: 3.40, ownSpent: 3.40, analyses: 15, todayAnalyses: 0, lastLogin: '2026-10-05T20:03', twoFa: true, since: '2026-08-20', consent: false, returnRequested: '2026-10-06T21:15' },
    { id: 'u5', name: 'Игорь Нестеров', email: 'igor@example.com', role: 'member', status: 'blocked', aiMode: 'admin', limit: Object.assign({}, LIMIT_DEFAULT), spent: 0, analyses: 0, todayAnalyses: 0, lastLogin: '2026-09-18T12:40', twoFa: false, since: '2026-09-10', blockedAt: '2026-09-20T10:05', consent: false },
  ];
  const adminKeyUsers = users.filter(u => u.aiMode === 'admin' && u.status !== 'deleted');
  const admin = {
    key: { last4: 'm9Tq', verified: '2026-10-01T10:12', status: 'ok' },
    budget: { monthly: 60, spent: round(adminKeyUsers.reduce((a, u) => a + u.spent, 0) + sharedSpent, 2), shared: sharedSpent, alertAt: 80 },
    defaults: Object.assign({}, LIMIT_DEFAULT),
    invites: [
      { code: 'CAP-K7QM-2XPA', email: 'maria@example.com', role: 'member', aiMode: 'admin', limit: 10, created: '2026-10-06T19:40', expires: '2026-10-13T19:40', status: 'active' },
      { code: 'CAP-R4TD-9WEK', email: 'dmitry@example.com', role: 'member', aiMode: 'own', limit: null, created: '2026-08-18T11:02', expires: '2026-08-25T11:02', status: 'used', usedAt: '2026-08-20T09:14' },
      { code: 'CAP-H2NB-6YLC', email: 'alexey@example.com', role: 'member', aiMode: 'admin', limit: 10, created: '2026-07-14T16:20', expires: '2026-07-21T16:20', status: 'used', usedAt: '2026-07-15T08:01' },
      { code: 'CAP-P8VF-3JSA', email: 'sergey@example.com', role: 'member', aiMode: 'admin', limit: 10, created: '2026-09-01T12:00', expires: '2026-09-08T12:00', status: 'expired' },
    ],
    resetCodes: [
      { code: 'RST-Z5HC-8MRT', user: 'u3', created: '2026-10-07T09:20', expires: '2026-10-08T09:20', status: 'active' },
    ],
    // Журнал действий администратора и команд терминала (admin_audit_log)
    audit: [
      { at: '2026-10-07T09:20', actor: 'Роман Буров', action: 'reset_code', target: 'Алексей Ковалев', details: 'Код сброса пароля, 24 часа', ip: '95.216.•.•' },
      { at: '2026-10-07T08:00', actor: 'Роман Буров', action: 'message', target: 'Все участники', details: 'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.', ip: '95.216.•.•' },
      { at: '2026-10-06T19:40', actor: 'Роман Буров', action: 'invite', target: 'maria@example.com', details: 'Участник, ключ администратора, $10 в месяц', ip: '95.216.•.•' },
      { at: '2026-10-01T10:12', actor: 'Роман Буров', action: 'key_change', target: null, details: 'Ключ администратора заменен: sk-ant-…m9Tq, проверен', ip: '95.216.•.•' },
      { at: '2026-09-20T10:05', actor: 'Роман Буров', action: 'block', target: 'Игорь Нестеров', details: 'Заблокирован, сеансы завершены', ip: '95.216.•.•' },
      { at: '2026-09-02T18:30', actor: 'Дмитрий Шульц', action: 'ai_mode', target: 'Дмитрий Шульц', details: 'Перешел на свой ключ sk-ant-…7Qx2', ip: '84.146.•.•' },
      { at: '2026-08-01T12:31', actor: 'Роман Буров', action: 'limit_change', target: 'Алексей Ковалев', details: 'Лимит $10 → $8 в месяц, анализов в день 3 → 5', ip: '95.216.•.•' },
      { at: '2026-07-14T16:20', actor: 'Роман Буров', action: 'invite', target: 'alexey@example.com', details: 'Участник, ключ администратора, $10 в месяц', ip: '95.216.•.•' },
      { at: '2026-06-29T09:02', actor: 'Роман Буров', action: 'set_currency', target: null, details: 'Валюта программы: рубли', ip: '95.216.•.•' },
      { at: '2026-06-28T21:47', actor: 'терминал', action: 'create_admin', target: 'Роман Буров', details: 'python -m app.admin.cli create-admin', ip: 'сервер' },
    ],
  };
  // Центр уведомлений: у каждой роли свой список. Суммы в тексте подставляются при показе (валюта программы).
  // data_stale — архив матчей не обновлялся больше 3 дней, только администраторам (PLAN, раздел 6);
  // ai_alert — оповещение о расходе ИИ по правилам TOKEN_ECONOMY, раздел 6 (одно на правило в сутки, администраторам);
  // bet_settled — для авторасчета этапа 5 (при ручном расчете уведомления нет, только баннер), ссылка ведет на ставку.
  const lastSettled = settled[settled.length - 1];
  // Последняя успешная загрузка архива матчей (ночное обновление в 05:25 UTC); больше 3 дней — data_stale
  const archive = { lastLoad: '2026-10-03T05:31', source: 'tennis-data.co.uk', staleDays: 3, nightly: '05:25 UTC' };
  const recent10 = analysesSpec.slice(-10).map(a => a.id);
  const cache10 = (() => { const rs = aiRuns.filter(r => recent10.includes(r.analysis)); return Math.round(rs.reduce((a, r) => a + r.cached, 0) / rs.reduce((a, r) => a + r.input, 0) * 100); })();
  const notifications = {
    admin: [
      { id: 'n1', kind: 'limit_80', icon: 'coins', tone: 'warn', title: 'Алексей Ковалев израсходовал 91% лимита', body: '$7,28 из $8 за октябрь. На 100% его анализы на вашем ключе остановятся.', at: '2026-10-07T09:31', link: '#admin-limits', read: false },
      { id: 'n2', kind: 'ai_mode_request', icon: 'key', tone: 'info', title: 'Дмитрий Шульц просит вернуть ключ администратора', body: 'Сейчас работает на своем ключе. Вернуть можно только с вашего разрешения.', at: '2026-10-06T21:15', link: '#admin', read: false },
      { id: 'n6', kind: 'ai_alert', icon: 'alert', tone: 'warn', title: 'Расход ИИ: доля кэша ' + cache10 + '%', body: 'По последним 10 анализам из кэша читается ' + cache10 + '% входа, правило — не меньше 50%. Больше всего входа пишут в кэш новости. Проверьте журнал запусков.', at: '2026-10-07T08:00', link: '#costs', read: false },
      { id: 'n3', kind: 'data_stale', icon: 'database', tone: 'warn', title: 'Архив матчей не обновлялся 4 дня', body: 'Последняя загрузка ' + archive.source + ' — 3 октября. Эло и форма игроков — без матчей после этой даты. Ночное обновление идет в ' + archive.nightly + '.', at: '2026-10-07T05:40', read: false },
      { id: 'n4', kind: 'bet_settled', icon: 'ticket', tone: lastSettled.status === 'win' ? 'good' : 'bad', title: 'Ставка №' + lastSettled.id + ' рассчитана', bet: lastSettled.id, at: lastSettled.date + 'T21:40', link: '#bets-' + lastSettled.id, read: true },
      { id: 'n5', kind: 'new_device', icon: 'device', tone: 'info', title: 'Вход с нового устройства', body: 'Safari, iPhone · Хельсинки. Если это не вы — завершите сеанс в личном кабинете.', at: '2026-10-05T19:12', link: '#profile-security', read: true },
    ],
    member: [
      { id: 'n1', kind: 'admin_message', icon: 'megaphone', tone: 'info', title: 'Сообщение администратора', body: 'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.', at: '2026-10-07T08:00', read: false },
      { id: 'n4', kind: 'bet_settled', icon: 'ticket', tone: lastSettled.status === 'win' ? 'good' : 'bad', title: 'Ставка №' + lastSettled.id + ' рассчитана', bet: lastSettled.id, at: lastSettled.date + 'T21:40', link: '#bets-' + lastSettled.id, read: true },
      { id: 'n5', kind: 'new_device', icon: 'device', tone: 'info', title: 'Вход с нового устройства', body: 'Chrome, Windows · Хельсинки. Если это не вы — завершите сеанс в личном кабинете.', at: '2026-10-03T18:02', link: '#profile-security', read: true },
    ],
  };

  // ---------- Расход ИИ, бюджет ключа администратора и лимиты: один расчет для всех экранов ----------
  // u.spent — расход участника за месяц на всех ключах, u.ownSpent — из него на своем ключе (вне бюджета администратора).
  const MONTH_DAYS = 31, DAY = +TODAY.slice(8, 10);
  const pace = v => v / DAY * MONTH_DAYS; // прогноз на месяц по темпу 1–7 октября
  const people = () => users.filter(u => u.status !== 'deleted');
  const keySpent = u => Math.max(0, round(u.spent - (u.ownSpent || 0), 2));
  const usdL = n => UI.fmt.usd(n, Number.isInteger(n) ? 0 : 2); // $10, $1, но $1,50
  const ownSpent = u => round(u.ownSpent || 0, 2);
  // удаленный участник остается в бюджете месяца: его расход уже был
  const keyUsers = () => users.filter(u => (u.status !== 'deleted' && u.aiMode === 'admin') || keySpent(u) > 0);
  const limitOf = u => (u.aiMode === 'admin' && u.role !== 'admin') ? (u.limit || Object.assign({}, admin.defaults)) : null;
  // Прогноз расхода человека на месяц: на 100% личного лимита анализы останавливаются, на паузе расход не растет
  const forecastOf = u => {
    const v = u.aiMode === 'own' ? ownSpent(u) : keySpent(u), L = limitOf(u);
    return round(L && L.paused ? v : L ? Math.min(L.monthly, pace(v)) : pace(v), 2);
  };
  function budget() {
    const monthly = admin.budget.monthly, shared = sharedSpent;
    const spent = round(keyUsers().reduce((a, u) => a + keySpent(u), 0) + shared, 2);
    const forecast = round(keyUsers().reduce((a, u) => a + (u.aiMode !== 'admin' || u.status !== 'active' ? keySpent(u) : forecastOf(u)), 0) + pace(shared), 2);
    return { monthly, shared, spent, forecast, left: round(Math.max(0, monthly - spent), 2), daysLeft: MONTH_DAYS - DAY, share: spent / monthly, fShare: forecast / monthly, alertAt: admin.budget.alertAt };
  }
  Object.defineProperty(admin.budget, 'spent', { enumerable: true, get: () => budget().spent });
  // Демо-состояние для согласования: ?adminkey=missing — ключ администратора еще не задан (новая установка)
  try { if (new URLSearchParams(location.search).get('adminkey') === 'missing') Object.assign(admin.key, { last4: null, verified: null, status: 'missing' }); } catch (e) { /* без адреса — ключ задан */ }
  // Можно ли запустить анализ стоимостью cost: null — можно, иначе причина для человека.
  // opts.kind = 'review' — разбор (не анализ): дневной счетчик анализов не проверяется.
  function access(u, cost, opts) {
    cost = cost || 0;
    const review = !!(opts && opts.kind === 'review');
    if (u.status === 'blocked') return 'Аккаунт заблокирован администратором';
    if (u.aiMode === 'own') {
      if (!u.ownKey) return 'Нет ключа Claude: добавьте свой ключ в личном кабинете';
      const cap = u.ownCap != null ? u.ownCap : admin.defaults.perAnalysis;
      if (cost > cap) return 'Анализ дороже вашего потолка ' + usdL(cap) + ' на один анализ';
      return null;
    }
    const L = limitOf(u);
    if (L) {
      if (L.paused) return 'Анализы на паузе — решение администратора';
      if (!review && u.todayAnalyses >= L.daily) return 'На сегодня анализы закончились: ' + L.daily + ' в день';
      if (cost > L.perAnalysis) return 'Анализ дороже потолка ' + usdL(L.perAnalysis) + ' на один анализ';
      if (keySpent(u) + cost > L.monthly) return 'Лимита на месяц не хватает на анализ';
    }
    // Нет ключа и общий бюджет администратор решает сам — ему текст со ссылкой на «Ключ и бюджет»
    const self = u.role === 'admin';
    if (budget().spent + cost > admin.budget.monthly) return 'Общего бюджета ключа администратора на месяц не хватает на анализ' + (self ? '. Поднимите его в «Администрирование → Ключ и бюджет»' : '');
    if (admin.key.status === 'missing') return 'Ключ Claude администратора не задан. ' + (self ? 'Задайте его в «Администрирование → Ключ и бюджет»' : 'Напишите администратору');
    return null;
  }
  // Расход ИИ без счетчика анализов (разбор ставки, разбор в «Аналитике»)
  function recordSpend(u, cost) {
    u.spent = round(u.spent + cost, 2);
    if (u.aiMode === 'own') u.ownSpent = round((u.ownSpent || 0) + cost, 2);
  }
  // Анализ завершен: расход и число анализов
  function recordRun(u, cost) {
    recordSpend(u, cost);
    u.analyses += 1; u.todayAnalyses += 1;
  }
  // Что ждет решения администратора: просьбы вернуть ключ и участники у лимита (значок в меню, главная, обзор кабинета)
  function decisions() {
    const out = [];
    people().forEach(u => { if (u.returnRequested && u.aiMode === 'own') out.push({ kind: 'return', user: u, at: u.returnRequested }); });
    people().forEach(u => {
      const L = limitOf(u);
      if (L && u.status === 'active' && keySpent(u) / L.monthly >= admin.budget.alertAt / 100) out.push({ kind: 'limit', user: u, ratio: keySpent(u) / L.monthly });
    });
    return out;
  }
  // Часовые пояса участников (США, Финляндия, Германия); смещения — на октябрь, с летним временем
  const timezones = [
    { value: 'Europe/Helsinki', label: 'Хельсинки (UTC+3)', city: 'Хельсинки' },
    { value: 'Europe/Berlin', label: 'Берлин (UTC+2)', city: 'Берлин' },
    { value: 'America/New_York', label: 'Нью-Йорк (UTC−4)', city: 'Нью-Йорку' },
    { value: 'America/Chicago', label: 'Чикаго (UTC−5)', city: 'Чикаго' },
    { value: 'America/Denver', label: 'Денвер (UTC−6)', city: 'Денверу' },
    { value: 'America/Los_Angeles', label: 'Лос-Анджелес (UTC−7)', city: 'Лос-Анджелесу' },
  ];

  window.DATA = {
    today: TODAY,
    demo: true,
    personas, users, admin, notifications, LIMIT_DEFAULT, timezones, marketRef: 'Pinnacle', archive,
    // Эталон рынка по Р17: первый, у кого есть кэфы обеих сторон. marketRef — первый в порядке (для старых подписей)
    marketRefRule: 'Pinnacle → Betfair → средний по рынку',
    // tzCity: «время по Хельсинки» — город в дательном падеже
    tzCity: tz => (timezones.find(t => t.value === tz) || timezones[0]).city,
    surfaces, players, P, calendar, markets,
    bets, bankHistory,
    stats: {
      bank, start: 40000, profit, turnover, roi: round(profit / turnover * 100, 1), settled: settled.length, wins, losses, voids,
      winrate: round(wins / (wins + losses) * 100, 1), open: bets.filter(b => b.status === 'open').length,
      streak: { type: streakType, n: streak }, brier: round(brier, 3), brierMarket: round(brierMarket, 3), clvAvg: round(clvAvg, 1), legs: allLegs.length,
      peak: Math.max(...bankHistory.map(b => b.bank)),
    },
    allLegs, calibration, brierRolling, roiBySurface, roiByMarket, roiByOdds, roiByTotal,
    matchesToday, recentAnalyses,
    ai: { runs: aiRuns, spent: aiSpent, personalSpent, sharedSpent, keySpent, ownSpent, keyUsers, limitOf, budget, forecastOf, access, recordRun, recordSpend, decisions, budgetHint: 15, month: 'октябрь', cacheShare: round(aiRuns.reduce((a, r) => a + r.cached, 0) / aiRuns.reduce((a, r) => a + r.input, 0) * 100, 0), runTypes,
      // общие фоновые задачи — вызовы без участника (r.shared); проверки (eval) — отдельный бюджет; анализы — запуски из вызовов
      isShared: r => !!r.shared, eval: evalBudget, analyses: analysesSpec, searchUsd: SEARCH_USD },
    lessons, strategyVersions,
    // Стратегия по коду этапа 3 (ml/strategy.py, Т20): 4 диапазона с одним процентом, четвертый — экспресс из 3 событий.
    // adapt — правила адаптации суммы (Р22) и включены ли они по умолчанию: рост и прибыльная неделя выключены (В7)
    strategy: {
      minProb: 65, oddsMin: 1.13, oddsMax: 1.80, maxLegs: 3, totalMax: 3.24,
      stakeTable: [{ range: '1.28–1.70', pct: '2,75%', pctNum: 2.75 }, { range: '1.71–2.20', pct: '2,25%', pctNum: 2.25 }, { range: '2.21–3.24', pct: '1,75%', pctNum: 1.75 }, { range: '3.25–4.10', pct: '1,75%', pctNum: 1.75, triple: true }],
      triple: { minProb: 70, legOddsMax: 1.60, totalMin: 1.44, totalMax: 4.10 }, coverMinProb: 55, formMinWins: 3,
      adapt: [
        { key: 'dd10', label: 'Просадка от пика −10%', effect: 'ставка не больше 2,5% банка', on: true },
        { key: 'dd20', label: 'Просадка от пика −20%', effect: 'защитный режим: 1,5% банка, только 2 события с кэфами до 1.50', on: true },
        { key: 'week_loss', label: 'Итог 7 дней −5% и хуже', effect: 'ставка не больше 2% банка', on: true },
        { key: 'up15', label: 'Банк +15% к вложенному и винрейт от 60%', effect: 'потолок ставки 4% вместо 3%', on: false },
        { key: 'week_win', label: 'Итог 7 дней +10% и лучше', effect: 'ставка +0,5 п.п.', on: false },
      ],
    },
    playerName: id => (P[id] ? P[id].short : id),
    match: (l) => (P[l.p1] ? P[l.p1].short : l.p1) + ' — ' + (P[l.p2] ? P[l.p2].short : l.p2),
  };
  // Текущий пользователь зависит от демо-роли (UI.auth.role задает app.js)
  const role = () => (window.UI && UI.auth && UI.auth.role) || 'admin';
  Object.defineProperty(window.DATA, 'user', { enumerable: true, get: () => personas[role()] });
  try { JSON.parse(localStorage.getItem('capper.currencyLog') || '[]').forEach(e => admin.audit.unshift(e)); } catch (e) { /* хранилище недоступно */ }
  admin.audit.sort((a, b) => (a.at < b.at ? 1 : -1));
  Object.defineProperty(window.DATA, 'me', { enumerable: true, get: () => users.find(u => u.id === personas[role()].id) });
})();
