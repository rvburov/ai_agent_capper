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
  const D_match = l => (P[l.p1] ? P[l.p1].short : l.p1) + ' — ' + (P[l.p2] ? P[l.p2].short : l.p2);

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
  // Шесть исходов, как в коде (ml/sets.py): победа и фора ±1.5 по сетам на каждого игрока.
  // Р28 — новые рынки, по семейству на строку: фора по сетам ±2.5 (только до 3 побед), тотал сетов, фора и тотал геймов
  const markets = [
    { id: 'p1', label: 'П1' }, { id: 'p2', label: 'П2' }, { id: 'h1m', label: 'Ф1(−1.5)' }, { id: 'h2m', label: 'Ф2(−1.5)' }, { id: 'h1p', label: 'Ф1(+1.5)' }, { id: 'h2p', label: 'Ф2(+1.5)' },
    { id: 'shcp', label: 'Фора по сетам ±2.5', fresh: true }, { id: 'stot', label: 'Тотал сетов', fresh: true },
    { id: 'ghcp', label: 'Фора по геймам', fresh: true }, { id: 'gtot', label: 'Тотал геймов', fresh: true },
  ];
  // Р28: код нового рынка — семейство (market), сторона (sel) и линия (line) со стороны выбранного исхода.
  // У фор sel — игрок (1 или 2) и линия его форы, у тоталов sel 1 — больше, 2 — меньше. Линии половинные (22.5)
  // и целые (22, при «ровно» — возврат); четвертных (22.25) нет. Победа и фора ±1.5 по сетам — прежние коды.
  const FAMILY = {
    shcp: { label: 'Фора по сетам', unit: 'sets', hcp: true },
    stot: { label: 'Тотал сетов', unit: 'sets' },
    ghcp: { label: 'Фора по геймам', unit: 'games', hcp: true },
    gtot: { label: 'Тотал геймов', unit: 'games' },
  };
  const lineText = (x, signed) => (signed ? (x > 0 ? '+' : x < 0 ? '−' : '') : '') + String(Math.abs(x));
  const shortName = id => (P[id] ? P[id].short : id);
  // «Фора по геймам Синнер −3.5», «Тотал геймов больше 21.5», «Тотал сетов меньше 2.5»
  function legLabel(l) {
    const f = FAMILY[l.market];
    if (!f) return (markets.find(m => m.id === l.market) || { label: l.market }).label;
    return f.hcp ? f.label + ' ' + shortName(l.sel === 2 ? l.p2 : l.p1) + ' ' + lineText(l.line, true)
      : f.label + ' ' + (l.sel === 1 ? 'больше' : 'меньше') + ' ' + lineText(l.line);
  }
  // Что сейчас можно брать в экспресс (Р28): победа — да; фора ±1.5 — временно нет (модель сетов исправляется);
  // новые рынки — «для сравнения», пока по рынку не наберется 150–200 событий и CLV не покажет перевес.
  // Счетчик общий по всем участникам: событие — исход рынка с кэфом, введенным в анализ, и известным итогом матча.
  // ROI — как ординары на равную сумму по кэфам из ввода, CLV — по закрытию, которое внесли сами (в архиве его нет)
  const marketStatus = [
    { id: 'ml', label: 'Победа в матче', lines: 'П1 и П2', status: 'express', n: 412, roi: 3.1, clv: 1.4 },
    { id: 'h15', label: 'Фора по сетам ±1.5', lines: 'Ф1 и Ф2, −1.5 и +1.5', status: 'paused', n: 238, roi: 1.2, clv: 0.6,
      why: 'По ориентировочной проверке на 2023–2025 модель сетов завышает вероятность решающего сета примерно на 9 п.п. — тогда валуй на ±1.5, особенно Ф(+1.5) фаворита, завышен. Пока это проверяют на модели проекта, фору в экспресс и варианты не берем; вернем, когда модель исправят' },
    { id: 'shcp', label: 'Фора по сетам ±2.5', lines: 'только матчи до 3 побед', status: 'compare', n: 3, need: 150, roi: null, clv: null, clvN: 0 },
    { id: 'stot', label: 'Тотал сетов', lines: '2.5; до 3 побед — 3.5 и 4.5', status: 'compare', n: 21, need: 150, roi: -3.1, roiCi: [-38.0, 31.7], clv: 0.4, clvCi: [-2.2, 3.0], clvN: 9 },
    { id: 'ghcp', label: 'Фора по геймам', lines: 'например −3.5, +4.5, −3', status: 'compare', n: 47, need: 150, roi: 4.2, roiCi: [-11.8, 20.3], clv: 1.2, clvCi: [-0.9, 3.3], clvN: 18 },
    { id: 'gtot', label: 'Тотал геймов', lines: 'например 21.5, 22.5, 22', status: 'compare', n: 38, need: 150, roi: -6.5, roiCi: [-24.9, 12.0], clv: -0.6, clvCi: [-2.8, 1.6], clvN: 14 },
  ];
  const statusKey = l => (l.market === 'p1' || l.market === 'p2' ? 'ml' : FAMILY[l.market] ? l.market : 'h15');
  const marketStatusOf = l => marketStatus.find(m => m.id === statusKey(l));
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
  // В7 этапа 5: пополнение внутри истории — на «Банке по дням» пунктир «вложено» поднимается ступенькой.
  // Проверка стоит до генератора случайных чисел: ставки и исходы те же, меняются только суммы после пополнения
  const DEPOSIT = { date: '2026-09-14', amount: 20000, note: 'Пополнение счета bet365' };
  let date = '2026-07-02', id = 1;
  const allLegs = [];
  while (date < TODAY) {
    if (date === DEPOSIT.date) { bank += DEPOSIT.amount; bankHistory.push({ date, bank, flow: DEPOSIT.amount }); }
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

  // Р28: новые рынки стратегия пока не предлагает, но участник может поставить их сам. В истории две такие ноги:
  // меняем только рынок (кэф, вероятность и исход те же), поэтому банк и статистика не меняются.
  // Счет по геймам нужен для расчета: по нему считается и ручной расчет, и авторасчет по архиву
  const relabel = (b, l, o) => {
    const twin = allLegs.find(a => a.betId === b.id && a.market === l.market && a.odds === l.odds && a.result === l.result);
    Object.assign(l, o); l.marketLabel = legLabel(l);
    if (twin) Object.assign(twin, o, { marketLabel: l.marketLabel });
  };
  const freshPick = manual => bets.filter(b => b.date >= '2026-08-01' && b.date <= '2026-09-27' && b.id !== 70 && (b.id % 4 === 2) === manual && b.status === 'win' && b.legs.length > 1)
    .map(b => ({ b, l: b.legs.find(l => l.market === 'p1' && l.bestOf === 3 && P[l.p1] && P[l.p2]) })).filter(x => x.l).pop();
  const fa = freshPick(false), fm = freshPick(true);
  // Р29: такие ставки участник собирает сам — это «своя ставка» (own), стратегия ее не предлагала и сумму не считала
  if (fa) { relabel(fa.b, fa.l, { market: 'ghcp', sel: 1, line: -3.5, score: '6:4 6:3', fresh: true }); fa.b.own = true; } // авторасчет по архиву: 12–7, +5 > 3.5
  if (fm) { relabel(fm.b, fm.l, { market: 'stot', sel: 2, line: 2.5, score: '2:0', fresh: true }); fm.b.own = true; }     // внесено вами: два сета

  // Этап 5: ставка вчерашнего дня ждет результата — в загруженном файле tennis-data матчи только по 4 окт.
  // Новости перед анализом уже нашли исходы (player_news, вид «результат») — это подсказка в окне расчета, не расчет (В1)
  // Открытая ставка на сегодня: экспресс по матчам вне демо-анализа #A-0142 (его экспресс создается на экране «Анализ»)
  const openLegs = [
    { date: '2026-10-06', bookmaker: 'Unibet', own: true, legs: [
      // Р28: рынок «для сравнения», участник поставил его сам; целая линия 23 — при 23 геймах возврат
      { p1: 'fritz', p2: 'Лехечка', market: 'gtot', sel: 2, line: 23, fresh: true, odds: 1.85, p: 0.52, pPush: 0.07, surface: 'hard', tournament: 'Шанхай', bestOf: 3, news: { text: 'Фриц выиграл 6:4 7:6(5)', score: '6:4 7:6', source: 'atptour.com', at: '2026-10-06T19:40' } },
      { p1: 'deminaur', p2: 'Бергс', market: 'p1', marketLabel: 'П1', odds: 1.42, p: 0.76, surface: 'hard', tournament: 'Шанхай', bestOf: 3, news: { text: 'де Минор выиграл 6:3 3:6 6:4', score: '2:1', source: 'tennis.com', at: '2026-10-06T21:15' } }] },
    { date: TODAY, bookmaker: 'bet365', legs: [
      { p1: 'zverev', p2: 'musetti', market: 'p1', marketLabel: 'П1', odds: 1.48, p: 0.71, surface: 'hard', tournament: 'Шанхай', bestOf: 3 }, { p1: 'alcaraz', p2: 'shelton', market: 'p1', marketLabel: 'П1', odds: 1.30, p: 0.82, surface: 'hard', tournament: 'Шанхай', bestOf: 3 }] },
  ];
  openLegs.forEach(o => {
    const legs = o.legs;
    legs.forEach(l => { if (!l.marketLabel) l.marketLabel = legLabel(l); });
    const total = round(legs.reduce((a, l) => a * l.odds, 1), 2);
    const stake = Math.round(bank * stakePct(total) / 100 / 10) * 10;
    bets.push({ id, date: o.date, tournament: 'Шанхай', surface: 'hard', legs: legs.map(l => Object.assign({ closing: null, result: 'open' }, l)), total, stake, status: 'open', profit: 0, bankAfter: null, clv: null, bookmaker: o.bookmaker, awaiting: o.date < TODAY, own: !!o.own });
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
    // Р29: одиночная ставка приложения — ординар из вариантов анализа (настоящая ставка, сумма по таблице ординаров)
    if (b.source === 'app' && b.legs.length === 1) b.single = true;
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

  // ---------- Этап 5: авторасчет по архиву tennis-data (В1), закрытие из архива (Т1) ----------
  // Владелец раз в неделю, по понедельникам, скачивает 2026.xlsx с tennis-data.co.uk и загружает его на сайте:
  // файл понедельника содержит матчи по прошедшее воскресенье. Последний файл — 5 окт, матчи по 4 окт.
  const ARCHIVE_TO = '2026-10-04';
  const UPLOAD_LAST = '2026-10-05';
  // Понедельник после дня матча — день, когда матч попал в загруженный файл
  const uploadAfter = d => { let x = addDays(d, 1); while (new Date(x + 'T12:00:00Z').getUTCDay() !== 1) x = addDays(x, 1); return x; };
  // Часть ставок участник рассчитал сам, не дожидаясь файла: ручной расчет главнее авторасчета (Т3)
  const MANUAL = b => b.id % 4 === 2 || b.date > ARCHIVE_TO;
  bets.forEach(b => {
    if (b.status === 'open') return;
    if (b.source === 'bot') { b.settledBy = 'legacy'; return; }
    const up = uploadAfter(b.date);
    if (!MANUAL(b) && up <= UPLOAD_LAST) { b.settledBy = 'auto'; b.settledAt = up + 'T08:14'; b.archiveFile = up; }
    else { b.settledBy = 'manual'; b.settledAt = b.date + 'T22:30'; }
    b.legs.forEach(l => {
      if (!l.closing) return;
      // в архиве только кэфы П1/П2 пяти букмекеров, момент снятия не проверен — у фор закрытие вносит участник
      l.closingSource = b.settledBy === 'auto' && (l.market === 'p1' || l.market === 'p2') ? 'archive' : 'user';
      if (l.closingSource === 'archive') l.closingBy = 'Pinnacle';
    });
  });
  // Т3: архив разошелся с ручным расчетом — уведомление, деньги не меняются
  const conflictBet = bets.find(b => b.id === 70);
  if (conflictBet) conflictBet.conflict = { at: UPLOAD_LAST + 'T08:14', score: '2:1', leg: 0, archiveResult: 'loss' };
  // Закрытие из архива у ног П1/П2 для «Аналитики»: эталон Pinnacle → Betfair → средний, вероятность без маржи
  allLegs.forEach(l => {
    const b = betById[l.betId];
    if (!b || l.source !== 'app' || l.date > ARCHIVE_TO || (l.market !== 'p1' && l.market !== 'p2')) return;
    const c = l.closing || round(l.odds * (1 - ((l.betId * 3) % 5 - 1) / 100), 2);
    l.qArch = round(devig(c, round(1 / (1.03 - 1 / c), 2)), 3);
  });
  // Прогнозы без ставки (В3 этапа 4 → этап 5): матчи из анализов, на которые участник не ставил, с исходом из архива.
  // Свой генератор — основной сид и ставки не меняются
  let pseed = 42;
  const prnd = () => { pseed = (pseed * 1103515245 + 12345) % 2147483648; return pseed / 2147483648; };
  const predictions = [];
  for (let d = '2026-08-02'; d <= ARCHIVE_TO; d = addDays(d, 1)) {
    const n = prnd() < 0.45 ? 2 : prnd() < 0.5 ? 1 : 0;
    for (let k = 0; k < n; k++) {
      const p = round(0.52 + prnd() * 0.4, 3), q = round(clamp(p - 0.03 + (prnd() - 0.5) * 0.06, 0.4, 0.95), 3);
      const won = prnd() < p - 0.015;
      const mk = prnd() < 0.7 ? 'p1' : 'h1m';
      predictions.push({ pKind: 'final', date: d, p, pb: round(clamp(p - 0.02 + (prnd() - 0.5) * 0.04, 0.4, 0.95), 3), pc: p, q, qArch: mk === 'p1' ? round(clamp(q + (prnd() - 0.5) * 0.03, 0.4, 0.96), 3) : null, result: won ? 'win' : 'loss', market: mk, surface: tourAt(d).surface, source: 'app', noBet: true });
    }
  }
  // Пик банка: пополнение сдвигает пик в той же доле, что и капитал (Р22) — просадка считается только от ставок
  let peakAdj = 0;
  bankHistory.forEach(x => { if (x.flow) { const before = x.bank - x.flow; peakAdj = before > 0 ? peakAdj * x.bank / before : x.bank; } peakAdj = Math.max(peakAdj, x.bank); });
  // Движение банка: стартовый банк и пополнения (журнал в «Банке и стратегии»), «вложено» на любой день
  const bankFlows = [
    { at: '2026-07-01T09:00', kind: 'deposit', amount: 40000, start: true, note: 'Стартовый банк' },
    { at: DEPOSIT.date + 'T10:05', kind: 'deposit', amount: DEPOSIT.amount, note: DEPOSIT.note },
  ];
  const investedAt = d => bankFlows.filter(f => f.at.slice(0, 10) <= d).reduce((a, f) => a + (f.kind === 'withdrawal' ? -f.amount : f.amount), 0);

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
    { id: 'm1', p1: 'sinner', p2: 'rune', time: '10:30', round: '1/8 финала', court: 'Stadium Court', odds: { p1: 1.22, p2: 4.40, h1m: 1.62, h2p: 2.30 } },
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
  // Этап 5: разбор рассчитанной ставки — Sonnet 5.5 через Batch (−50%), один на матч, общая задача на ключе
  // администратора (В3). Ночного обновления профилей нет (В11 этапа 4). Генератор детерминированный, без сида:
  // расход сходится с «Последними анализами» и бюджетом ключа.
  const runTypes = [
    { id: 'analysis', label: 'Оценка матча', model: 'Opus 5.5', effort: 'medium', what: 'Оценка матча: один вызов на матч' },
    { id: 'news', label: 'Новости перед анализом', model: 'Sonnet 5.5', effort: 'low', what: 'Веб-поиск: 2 поиска на матч, кэш 12 часов' },
    { id: 'parse', label: 'Разбор текста событий', model: 'Haiku 5.5', effort: 'low', what: 'Вставленный текст → список событий' },
    { id: 'postmortem', label: 'Разбор ставки', model: 'Sonnet 5.5', effort: 'low', what: 'Разбор рассчитанной ставки: один на матч, Batch', batch: true },
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
    const cost = ((o.fresh * p[0] + o.written * p[0] * 1.25 + o.read * p[2] + o.output * p[1]) / 1e6) * (t.batch ? 0.5 : 1) + o.searches * SEARCH_USD;
    return Object.assign({ typeLabel: t.label, model: t.model, effort: t.effort, batch: !!t.batch, status: 'ok' }, o, {
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
  // Разборы рассчитанных ставок (этап 5, В3): по одному на матч, результат пакета — в течение нескольких часов после расчета.
  // Свои матчи демо-пользователя плюс матчи других участников — общая задача, в лимит участника не входит
  const pmMatches = [];
  bets.filter(b => b.source === 'app' && b.status !== 'open' && b.status !== 'void' && b.date >= '2026-10-01')
    .forEach(b => b.legs.forEach((l, i) => pmMatches.push({ at: addMin(b.settledAt, 50 + i), bet: b.id, match: D_match(l) })));
  ['Рублев — Коболли', 'Шелтон — Попырин', 'Медведев — Хачанов', 'Дрейпер — Умбер', 'Музетти — Бублик']
    .forEach((m, k) => pmMatches.push({ at: addMin('2026-10-0' + (2 + k % 4) + 'T08:14', 52 + k), match: m, other: true }));
  pmMatches.forEach((x, k) => aiRuns.push(makeRun({ id: 'run-pm-' + k, at: x.at, type: 'postmortem', shared: true, tag: 'Разбор ставки', step: 0, match: null, matchLabel: x.match, bet: x.other ? null : x.bet,
    fresh: 5100 + (k * 137) % 600, written: 0, read: 0, output: 900 + (k * 53) % 220, searches: 0, duration: 9 + k % 5, batchWait: 1800 + (k * 173) % 1500 })));
  aiRuns.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  // Проверки (eval) — свой бюджет на ключе администратора: ни в лимит участника, ни в общий бюджет не входят.
  // В2 этапа 5: $30 в первый месяц (замер разброса и первая версия), дальше $25. Прогон версии на замороженном наборе
  // идет пакетами по 100 событий, чтобы худший случай помещался в бюджет (Т8): ≈ $0,11 на событие при 8 тыс. токенов
  const evalRuns = [
    { at: '2026-10-03T02:10', kind: 'eval', version: 'v3', repeat: 1, events: 250, batches: 3, what: 'v3 · прогон 1 на наборе eval-2026-08, 250 событий, 3 пакета', cost: 3.62, worst: 27.5 },
    { at: '2026-10-04T02:05', kind: 'eval', version: 'v3', repeat: 2, events: 250, batches: 3, what: 'v3 · прогон 2 — порог шума', cost: 3.55, worst: 27.5 },
    { at: '2026-10-04T10:02', kind: 'smoke', events: 40, what: 'smoke-eval: 40 сыгранных матчей, Opus 5.5 через Batch', cost: 0.58, worst: 4.4 },
    { at: '2026-10-04T10:41', kind: 'parse', events: 30, what: 'parse-eval: 30 текстов, Haiku 5.5', cost: 0.02, worst: 0.05 },
    { at: '2026-10-06T02:20', kind: 'eval', version: 'v4', repeat: 1, events: 250, batches: 3, what: 'v4 · прогон 1 на наборе eval-2026-08', cost: 2.48, worst: 27.5 },
  ];
  const evalBudget = { monthly: 30, next: 25, firstMonth: true, spent: round(evalRuns.reduce((a, r) => a + r.cost, 0), 2), runs: evalRuns, perEventWorst: 0.11, batchSize: 100, quickCheck: 0.6 };
  const aiSpent = round(aiRuns.reduce((a, r) => a + r.cost, 0), 2);

  // ---------- Этап 5: петля обучения ----------
  // В5: уроки и версии инструкций анализа общие для всех участников, их ведет администратор и проверяет на общем
  // наборе матчей. Основание урока — матчи и прогнозы; свои ставки-источники видит только их владелец (Т21).
  // Условие урока — из словаря признаков (Т7): SQL собирает код, а не Claude. Числа (эффект, ДИ, усадка) считает сервер.
  // status: hypothesis — копит случаи; ready — подтвержден на истории, ждет решения администратора (В4);
  // confirmed — в инструкциях (inPrompt) или выключен; rejected — на истории хуже; retired — списан при перепроверке
  const lessons = [
    { id: 'L-017', kind: 'numeric', status: 'confirmed', inPrompt: true, created: '2026-09-12', decided: '2026-09-22', rechecked: '2026-10-01',
      text: 'Если фаворит за 48 часов до матча сыграл пять сетов, его вероятность завышается — снижай на 4 п.п.',
      scope: 'Усталость · все покрытия', cond: [['роль', 'фаворит по модели'], ['сетов за 48 часов', '≥ 5']],
      own: 21, hist: 412, raw: 6, bias: [2, 10], metric: 'Brier', with: 0.196, without: 0.202, ci: [0.002, 0.010], holdout: '+0,005 на матчах 2026 г. — подтвердился', ownBets: [41, 53, 63] },
    { id: 'L-019', kind: 'process', status: 'confirmed', inPrompt: true, created: '2026-09-24', decided: '2026-09-28', rechecked: '2026-10-01',
      text: 'Не ищи и не учитывай новости о травмах из соцсетей без подтверждения турнира или ATP.',
      scope: 'Новости перед анализом', cond: [['шаг', 'новости'], ['источник', 'соцсети без подтверждения']],
      own: 11, hist: null, metric: 'Brier', with: 0.199, without: 0.198, saving: '2 поиска на матч, ≈ $0,02', ownBets: [64, 65, 67] },
    { id: 'L-022', kind: 'numeric', status: 'ready', inPrompt: false, created: '2026-09-27', readyAt: '2026-10-06T03:10',
      text: 'Фора −1.5 на фаворита на харде при разнице Эло на покрытии меньше 120: победа 2:0 случается реже, чем дает модель — снижай ее вероятность на 4–5 п.п.',
      scope: 'Фора −1.5 · хард · близкие по Эло', cond: [['рынок', 'Ф1(−1.5) или Ф2(−1.5)'], ['покрытие', 'хард, крытый хард'], ['разница Эло на покрытии', '< 120']],
      own: 23, hist: 1860, raw: 5, bias: [2, 8], metric: 'Лог-лосс', with: 0.574, without: 0.589, ci: [0.006, 0.024], holdout: '+0,013 на отложенных матчах 2026 г.', ownBets: [55, 57, 69] },
    { id: 'L-023', kind: 'numeric', status: 'hypothesis', inPrompt: false, created: '2026-10-01',
      text: 'После перерыва 30+ дней без матчей вероятность игрока завышается.',
      scope: 'Перерыв · все покрытия', cond: [['дней с последнего матча', '≥ 30']], own: 9, ownBets: [72] },
    { id: 'L-025', kind: 'numeric', status: 'hypothesis', inPrompt: false, created: '2026-10-05',
      text: 'На грунте аутсайдер с кэфом 2.60+ берет хотя бы сет чаще, чем дает модель.',
      scope: 'Фора +1.5 · грунт', cond: [['рынок', 'Ф1(+1.5) или Ф2(+1.5)'], ['покрытие', 'грунт'], ['кэф аутсайдера на победу', '≥ 2.60']], own: 4, ownBets: [] },
    { id: 'L-012', kind: 'numeric', status: 'rejected', inPrompt: false, created: '2026-08-30', decided: '2026-09-02',
      text: 'Перевес в личных встречах на другом покрытии переносится на хард.',
      scope: 'Личные встречи', cond: [['личных встреч на другом покрытии', '≥ 3'], ['покрытие матча', 'хард']],
      own: 19, hist: 1240, metric: 'Лог-лосс', with: 0.604, without: 0.597, ci: [-0.012, -0.002], ownBets: [] },
    { id: 'L-009', kind: 'numeric', status: 'retired', inPrompt: false, created: '2026-08-10', decided: '2026-08-24', retired: '2026-10-01',
      text: 'Игрок, выигравший турнир на прошлой неделе, переоценивается в первом круге следующего.',
      scope: 'Первый круг после титула', cond: [['титул на прошлой неделе', 'да'], ['круг', 'первый']],
      own: 22, hist: 640, metric: 'Лог-лосс', with: 0.590, without: 0.592, ci: [-0.004, 0.007], ownBets: [] },
  ];
  const LESSONS_MAX = 15, LESSON_MIN = 20, LESSON_MIN_PROC = 10, SHRINK_K = 200;

  // Версии инструкций анализа — общая линия (В5), ведет администратор. Проверка — на замороженном наборе
  // eval-2026-08: 250 событий после 1 августа 2026 (позже среза знаний модели), 38 трудных, без новостей
  const evalSet = { code: 'eval-2026-08', frozenAt: '2026-10-02T21:30', n: 250, since: '2026-08-01', to: '2026-09-27', hard: 38, sha: '3f9a07…c21e', marketLL: 0.588 };
  const strategyVersions = [
    { id: 'v1', name: 'v1 · инструкции бота', date: '2026-07-01', status: 'archived', changes: ['Инструкции перенесены из старого бота без изменений'] },
    { id: 'v2', name: 'v2 · + Эло по покрытиям', date: '2026-08-05', status: 'archived', changes: ['В досье — Эло по покрытиям', 'Вероятность базовой модели передается Claude как второе мнение'] },
    { id: 'v3', name: 'v3 · + уроки L-017, L-019', date: '2026-09-22', status: 'active', tokens: 49, changes: ['В инструкциях — уроки L-017 и L-019, числовой — с усадкой к нулю'],
      eval: { runs: 2, logloss: 0.583, brier: 0.201, ece: 2.9, fmtErr: 1, noise: 0.003, toMarket: [-0.021, 0.011] } },
    { id: 'v4', name: 'v4 · сжатое досье', date: '2026-10-05', status: 'candidate', goal: 'saving', parent: 'v3', tokens: 34,
      changes: ['Инструкции на английском, ответ — по-русски', 'Сжатое досье: 18 ключевых цифр на игрока', 'Уроки и правила те же, что в v3'],
      eval: { runs: 1, logloss: 0.581, brier: 0.200, ece: 3.1, fmtErr: 0, toMarket: [-0.023, 0.009] },
      cmp: { base: 'v3', rule: 'non_inferior', dLL: [-0.002, -0.009, 0.005], dBrier: [-0.001, -0.004, 0.002], dEce: [0.2, -0.7, 1.1], tokens: -31, passed: true, at: '2026-10-06T11:40' } },
  ];
  // Правила суммы ставки — у каждого участника свои (В5): правка — новой версией, кандидат включается кнопкой
  const ruleVersions = [
    { id: 'r1', name: 'r1 · правила этапа 3', date: '2026-07-01', status: 'archived', changes: ['4 диапазона итогового кэфа', 'Все пять адаптаций включены'] },
    { id: 'r2', name: 'r2 · рост ставки выключен', date: '2026-10-01', status: 'active', changes: ['Выключены «Банк +15% и винрейт от 60%» и «Итог 7 дней +10%» (В7 этапа 4)'] },
  ];
  // Базовая модель: Эло по покрытиям + калибровка Платта (Т17). Перекалибровка — по понедельникам после загрузки
  // файла; включается сама, если на проверке не хуже прежней (В6): Brier не хуже +0,005, лог-лосс не хуже +0,01
  const mlModels = [
    { id: 'elo-v1@2026-10-05', at: '2026-10-05T09:02', status: 'active', auto: true, brier: 0.1942, logloss: 0.571, ece: 2.1, matches: 412, prev: 'elo-v1@2026-09-28' },
    { id: 'elo-v1@2026-09-28', at: '2026-09-28T09:20', status: 'archived', auto: true, brier: 0.1951, logloss: 0.573, ece: 2.3, matches: 398 },
    { id: 'elo-v1@2026-09-21', at: '2026-09-21T09:35', status: 'rejected', auto: true, brier: 0.2013, logloss: 0.586, ece: 3.4, matches: 377, why: 'хуже прежней на 0,006 по Brier — не включена' },
    { id: 'elo-v1@2026-09-14', at: '2026-09-14T09:10', status: 'archived', auto: true, brier: 0.1953, logloss: 0.574, ece: 2.4, matches: 361 },
  ];
  // Проверка по месяцам (walk-forward): рынок — по кэфам архива tennis-data, момент снятия не проверен (Т1)
  const walkForward = [
    { m: 'апр', full: 'Апрель 2026', n: 214, model: 0.204, market: 0.193 },
    { m: 'май', full: 'Май 2026', n: 248, model: 0.199, market: 0.192 },
    { m: 'июн', full: 'Июнь 2026', n: 236, model: 0.201, market: 0.195 },
    { m: 'июл', full: 'Июль 2026', n: 252, model: 0.197, market: 0.193 },
    { m: 'авг', full: 'Август 2026', n: 241, model: 0.196, market: 0.194 },
    { m: 'сен', full: 'Сентябрь 2026', n: 187, model: 0.194, market: 0.192 },
  ];
  // Калибровка базовой модели после Платта на матчах 2026 г. (основной тур)
  const mlCalibration = [
    { lo: 0.5, hi: 0.6, p: 0.553, actual: 0.541, n: 312 }, { lo: 0.6, hi: 0.7, p: 0.651, actual: 0.664, n: 288 },
    { lo: 0.7, hi: 0.8, p: 0.748, actual: 0.735, n: 241 }, { lo: 0.8, hi: 0.9, p: 0.846, actual: 0.858, n: 163 }, { lo: 0.9, hi: 1, p: 0.928, actual: 0.917, n: 72 },
  ];

  // Разбор ставки ИИ (postmortem): один на матч, Sonnet 5.5 через Batch, ≈ $0,01. Ответ по схеме проверяет код.
  // verdict: luck — невезение (рынок был согласен), model_error — ошибка модели, data_gap — не хватило данных,
  // fine — выигрыш по делу, lucky — выиграли, хотя рынок был против
  const VERDICTS = { luck: 'Невезение', model_error: 'Ошибка модели', data_gap: 'Не хватило данных', fine: 'Прогноз подтвердился', lucky: 'Повезло' };
  function postmortemOf(b) {
    if (!b || b.source !== 'app' || b.status === 'open' || b.status === 'void') return null;
    const clvOf = l => (l.closing ? (l.odds / l.closing - 1) * 100 : null);
    const lost = b.legs.filter(l => l.result === 'loss');
    const leg = lost[0] || b.legs[0];
    const clv = clvOf(leg);
    let verdict, lesson = null;
    if (b.status === 'win') verdict = b.clv != null && b.clv < 0 ? 'lucky' : 'fine';
    else if ((leg.market === 'h1m' || leg.market === 'h2m') && leg.surface === 'hard') { verdict = 'model_error'; lesson = 'L-022'; }
    else if (clv != null && clv < 0) { verdict = 'model_error'; lesson = b.id % 2 ? 'L-023' : null; }
    else if (b.id % 5 === 1) { verdict = 'data_gap'; }
    else verdict = 'luck';
    const m = D_match(leg), pp = Math.round((leg.p - (leg.q || 1 / leg.odds)) * 100);
    const what = b.status === 'win'
      ? 'Все события сыграли. ' + m + ', ' + leg.marketLabel + ': модель ' + Math.round(leg.p * 100) + '%, рынок без маржи ' + Math.round((leg.q || 1 / leg.odds) * 100) + '%.'
      : m + ', ' + leg.marketLabel + ' не сыграла. Модель давала ' + Math.round(leg.p * 100) + '%, рынок без маржи ' + Math.round((leg.q || 1 / leg.odds) * 100) + '% (перевес ' + (pp >= 0 ? '+' : '−') + Math.abs(pp) + ' п.п.).';
    const why = {
      fine: 'Перевес был, линия к старту пошла в нашу сторону — рынок согласился с оценкой.',
      lucky: 'Ставка выиграла, но к старту линия ушла против нас: на дистанции такие ставки убыточны.',
      luck: 'К старту рынок с ценой согласился (CLV не ниже нуля), признаков ошибки в досье нет — исход в пределах случайности.',
      model_error: lesson === 'L-022' ? 'Соперники близки по Эло на харде, а модель заложила уверенную победу 2:0. Такой же промах был в похожих матчах.' : 'Линия к старту ушла против нас: рынок оценил шансы ниже. В досье был перерыв игрока больше месяца — модель его не учла.',
      data_gap: 'Новость о травме игрока вышла за 2 часа до матча — анализ шел раньше и ее не видел.',
    }[verdict];
    const done = b.settledAt ? b.settledAt.slice(0, 11) + String(Math.min(23, +b.settledAt.slice(11, 13) + 1)).padStart(2, '0') + b.settledAt.slice(13) : b.date + 'T23:30';
    return { verdict, label: VERDICTS[verdict], what, why, lesson, at: done, cost: 0.01, shared: true };
  }

  // Еженедельный отчет (В8): неделя пн–вс по поясу участника, приходит в понедельник в 07:00 в центр уведомлений
  function weekReport(from) {
    const to = addDays(from, 6);
    const inWeek = bets.filter(b => b.status !== 'open' && b.date >= from && b.date <= to);
    const legs = allLegs.filter(l => l.date >= from && l.date <= to && l.q != null);
    const turnover = inWeek.reduce((a, b) => a + b.stake, 0), prof = inWeek.reduce((a, b) => a + b.profit, 0);
    const clvB = inWeek.filter(b => b.clv != null && b.source !== 'bot');
    const y = l => (l.result === 'win' ? 1 : 0);
    const sentAt = addDays(from, 7) + 'T07:00';
    return {
      from, to, sentAt, n: inWeek.length, auto: inWeek.filter(b => b.settledBy === 'auto').length, manual: inWeek.filter(b => b.settledBy === 'manual').length,
      profit: prof, turnover, roi: turnover ? prof / turnover * 100 : null, clv: clvB.length ? clvB.reduce((a, b) => a + b.clv, 0) / clvB.length : null, clvN: clvB.length,
      legs: legs.length, brier: legs.length ? legs.reduce((a, l) => a + (l.p - y(l)) ** 2, 0) / legs.length : null, brierMarket: legs.length ? legs.reduce((a, l) => a + (l.q - y(l)) ** 2, 0) / legs.length : null,
      reviews: inWeek.filter(b => b.source === 'app' && b.status !== 'void').reduce((a, b) => a + b.legs.length, 0),
      lessonsNew: lessons.filter(l => l.created >= from && l.created <= to).map(l => l.id),
      evalSpent: round(evalRuns.filter(r => r.at.slice(0, 10) >= addDays(from, 1) && r.at.slice(0, 10) <= addDays(to, 1)).reduce((a, r) => a + r.cost, 0), 2),
    };
  }
  const reportWeeks = ['2026-09-28', '2026-09-21', '2026-09-14', '2026-09-07'];

  // Загрузки файла tennis-data (В1): администратор скачивает 2026.xlsx в браузере и загружает на сайте.
  // Отчет загрузки: новые матчи, рассчитанные ставки всех участников (только число: суммы отчету не нужны), непривязанные матчи
  const lastUpload = bets.filter(b => b.settledAt && b.settledAt.startsWith(UPLOAD_LAST + 'T08'));
  const archive = {
    source: 'tennis-data.co.uk', file: '2026.xlsx', lastLoad: UPLOAD_LAST + 'T08:12', by: 'Роман Буров', matchesTo: ARCHIVE_TO, next: '2026-10-12',
    staleDays: 7, sackmannTo: '2026-05-31', nightly: '05:25 UTC',
    uploads: [
      { at: UPLOAD_LAST + 'T08:12', size: '1,9 МБ', rows: 2412, newMatches: 71, to: ARCHIVE_TO, settled: lastUpload.length + 6, people: 3, legs: lastUpload.reduce((a, b) => a + b.legs.length, 0) + 11,
        closing: lastUpload.reduce((a, b) => a + b.legs.filter(l => l.closingSource === 'archive').length, 0) + 7, linked: 14, unlinked: 2, conflicts: 1, retired: 1 },
      { at: '2026-09-28T08:40', size: '1,8 МБ', rows: 2341, newMatches: 88, to: '2026-09-27', settled: 11, people: 3, legs: 24, closing: 13, linked: 17, unlinked: 1, conflicts: 0, retired: 0 },
      { at: '2026-09-21T09:05', size: '1,8 МБ', rows: 2253, newMatches: 64, to: '2026-09-20', settled: 9, people: 3, legs: 19, closing: 11, linked: 13, unlinked: 0, conflicts: 0, retired: 1 },
    ],
    unlinked: [
      { match: 'Мунар — Табило', date: '2026-10-02', why: 'в файле два матча этой пары за 3 дня (квалификация и основа) — нужен выбор' },
      { match: 'Шан Цзюньчэн — Нисиока', date: '2026-10-03', why: 'в файле нет: турнир вне основного тура (челленджер)' },
    ],
  };


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
  // pushDevices — устройства с включенным push (таблица push_subscriptions): администратор видит только их число
  const users = [
    { id: 'u1', name: 'Роман Буров', email: 'roman@example.com', role: 'admin', status: 'active', aiMode: 'admin', limit: null, spent: personalSpent, analyses: analysesN, todayAnalyses: analysesToday, lastLogin: '2026-10-07T08:41', twoFa: true, since: '2026-06-28', you: true, consent: true, pushDevices: [] },
    { id: 'u2', name: 'Ольга Лехтинен', email: 'olga@example.com', role: 'member', status: 'active', aiMode: 'admin', limit: Object.assign({}, LIMIT_DEFAULT), spent: personalSpent, analyses: analysesN, todayAnalyses: analysesToday, lastLogin: '2026-10-07T07:55', twoFa: true, since: '2026-06-30', consent: true, pushDevices: [] },
    { id: 'u3', name: 'Алексей Ковалев', email: 'alexey@example.com', role: 'member', status: 'active', aiMode: 'admin', limit: { monthly: 8, daily: 5, perAnalysis: 1 }, spent: 7.28, analyses: 33, todayAnalyses: 4, lastLogin: '2026-10-07T09:12', twoFa: true, since: '2026-07-15', consent: true, pushDevices: [{ key: 'u3-galaxy', name: 'Galaxy S23 · Chrome', ic: 'device', at: '2026-10-03' }] },
    { id: 'u4', name: 'Дмитрий Шульц', email: 'dmitry@example.com', role: 'member', status: 'active', aiMode: 'own', ownKey: { last4: '7Qx2', verified: '2026-09-02T18:30' }, ownCap: 1, limit: null, spent: 3.40, ownSpent: 3.40, analyses: 15, todayAnalyses: 0, lastLogin: '2026-10-05T20:03', twoFa: true, since: '2026-08-20', consent: false, returnRequested: '2026-10-06T21:15', pushDevices: [] },
    { id: 'u5', name: 'Игорь Нестеров', email: 'igor@example.com', role: 'member', status: 'blocked', aiMode: 'admin', limit: Object.assign({}, LIMIT_DEFAULT), spent: 0, analyses: 0, todayAnalyses: 0, lastLogin: '2026-09-18T12:40', twoFa: false, since: '2026-09-10', blockedAt: '2026-09-20T10:05', consent: false, pushDevices: [] },
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
      // Р27: каждый просмотр чужих данных администратором — запись журнала (кто, когда, чьи данные, какой экран)
      { at: '2026-10-06T20:41', actor: 'Роман Буров', action: 'data_view', target: 'Алексей Ковалев', details: 'Ставки · только просмотр', ip: '95.216.•.•' },
      { at: '2026-10-06T20:40', actor: 'Роман Буров', action: 'data_view', target: 'Алексей Ковалев', details: 'Главная · только просмотр', ip: '95.216.•.•' },
      { at: '2026-10-06T19:15', actor: 'Роман Буров', action: 'data_view', target: 'Ольга Лехтинен', details: 'Банк и стратегия · только просмотр', ip: '95.216.•.•' },
      { at: '2026-10-05T10:02', actor: 'Роман Буров', action: 'data_view', target: 'Все участники', details: 'Сводка за 30 дней · только просмотр', ip: '95.216.•.•' },
      { at: '2026-10-07T08:00', actor: 'Роман Буров', action: 'message', target: 'Все участники', details: 'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.', ip: '95.216.•.•' },
      { at: '2026-10-06T02:00', actor: 'Роман Буров', action: 'eval_run', target: null, details: 'Прогон v4 на наборе eval-2026-08: 250 событий, 3 пакета по ≤ 100, худший случай $27,50 — факт $2,48', ip: '95.216.•.•' },
      { at: '2026-10-05T08:12', actor: 'Роман Буров', action: 'data_upload', target: null, details: '2026.xlsx, 1,9 МБ: 71 новый матч по 4 окт, рассчитано ставок — 9, не привязано матчей — 2', ip: '95.216.•.•' },
      { at: '2026-10-02T21:30', actor: 'Роман Буров', action: 'eval_set', target: null, details: 'Заморожен набор eval-2026-08: 250 событий после 1 авг, 38 трудных, sha256 3f9a07…c21e', ip: '95.216.•.•' },
      { at: '2026-09-28T08:40', actor: 'Роман Буров', action: 'data_upload', target: null, details: '2026.xlsx, 1,8 МБ: 88 новых матчей по 27 сен, рассчитано ставок — 11, не привязано матчей — 1', ip: '95.216.•.•' },
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
  // data_stale — понедельник: пора загрузить свежий файл tennis-data, только администраторам (В1 этапа 5);
  // ai_alert — оповещение о расходе ИИ по правилам TOKEN_ECONOMY, раздел 6 (одно на правило в сутки, администраторам);
  // bet_settled — авторасчет по архиву (при ручном расчете уведомления нет, только баннер), ссылка ведет на ставку;
  // bet_needs_result — через 3 дня после матча исхода в архиве нет; settle_conflict — архив разошелся с ручным расчетом;
  // weekly_report — понедельник 07:00 по поясу участника (В8); learning — урок готов, кандидат проверен, модель перекалибрована
  const autoLast = lastUpload[lastUpload.length - 1];
  const fmt0 = n => new Intl.NumberFormat('ru-RU').format(n);
  const recent10 = analysesSpec.slice(-10).map(a => a.id);
  const cache10 = (() => { const rs = aiRuns.filter(r => recent10.includes(r.analysis)); return Math.round(rs.reduce((a, r) => a + r.cached, 0) / rs.reduce((a, r) => a + r.input, 0) * 100); })();
  const notifications = {
    admin: [
      { id: 'n1', kind: 'limit_80', icon: 'coins', tone: 'warn', title: 'Алексей Ковалев израсходовал 91% лимита', body: '$7,28 из $8 за октябрь. На 100% его анализы на вашем ключе остановятся.', at: '2026-10-07T09:31', link: '#admin-limits', read: false },
      { id: 'n2', kind: 'ai_mode_request', icon: 'key', tone: 'info', title: 'Дмитрий Шульц просит вернуть ключ администратора', body: 'Сейчас работает на своем ключе. Вернуть можно только с вашего разрешения.', at: '2026-10-06T21:15', link: '#admin', read: false },
      { id: 'n6', kind: 'ai_alert', icon: 'alert', tone: 'warn', title: 'Расход ИИ: доля кэша ' + cache10 + '%', body: 'По последним 10 анализам из кэша читается ' + cache10 + '% входа, правило — не меньше 50%. Больше всего входа пишут в кэш новости. Проверьте журнал запусков.', at: '2026-10-07T08:00', link: '#costs', read: false },
      { id: 'n9', kind: 'learning', icon: 'layers', tone: 'info', title: 'Кандидат v4 проверен: не хуже v3 и дешевле на 31%', body: 'Правило экономии выполнено на наборе ' + evalSet.code + '. Включить v4 или оставить v3 — решаете вы.', at: '2026-10-06T11:40', link: '#learning-versions', read: false },
      { id: 'n8', kind: 'learning', icon: 'book', tone: 'info', title: 'Урок L-022 готов к решению', body: 'Подтвержден на ' + fmt0(23) + ' своих случаях и ' + fmt0(1860) + ' из истории. В анализ — после быстрой проверки (≈ $0,60) и вашего подтверждения.', at: '2026-10-06T03:10', link: '#learning-lessons', read: false },
      { id: 'n10', kind: 'weekly_report', icon: 'calendar', tone: 'info', title: 'Отчет за неделю 28 сен – 4 окт', week: '2026-09-28', at: '2026-10-05T07:00', link: '#learning-reports', read: false },
      { id: 'n11', kind: 'learning', icon: 'chart', tone: 'good', title: 'Базовая модель перекалибрована', body: 'Brier на проверке 0,1942 (было 0,1951) — не хуже прежней, включена сама. Вернуть прежнюю — в «Обучении модели».', at: '2026-10-05T09:02', link: '#learning-ml', read: true },
      { id: 'n4', kind: 'bet_settled', icon: 'ticket', tone: autoLast.status === 'win' ? 'good' : 'bad', title: 'Ставка №' + autoLast.id + ' рассчитана автоматически', bet: autoLast.id, at: autoLast.settledAt, link: '#bets-' + autoLast.id, read: true },
      { id: 'n12', kind: 'settle_conflict', icon: 'alert', tone: 'warn', title: 'Архив показывает другой исход ставки №70', body: 'В файле tennis-data счет 2:1 — по нему Ф(−1.5) не сыграла, а вы внесли выигрыш. Банк не меняли: проверьте и при необходимости исправьте результат.', at: '2026-10-05T08:14', link: '#bets-70', read: true },
      { id: 'n3', kind: 'data_stale', icon: 'database', tone: 'warn', title: 'Пора загрузить файл tennis-data', body: 'Понедельник: в архиве матчи по 27 сен. Скачайте 2026.xlsx на tennis-data.co.uk и загрузите в «Администрирование → Данные» — ставки рассчитаются сами.', at: '2026-10-05T07:00', link: '#admin-data', read: true },
      { id: 'n13', kind: 'bet_needs_result', icon: 'clock', tone: 'warn', title: 'Ставка №66 ждет результата', body: 'Матч 22 сен, исхода в архиве нет 3 дня. Внесите результат сами — или он появится после загрузки файла.', at: '2026-09-25T09:00', link: '#bets-66', read: true },
      { id: 'n5', kind: 'new_device', icon: 'device', tone: 'info', title: 'Вход с нового устройства', body: 'Safari, iPhone · Хельсинки. Если это не вы — завершите сеанс в личном кабинете.', at: '2026-10-05T19:12', link: '#profile-security', read: true },
    ],
    member: [
      // Р27: тем, кто зарегистрировался до нового правила, — одно уведомление со ссылкой на «Кто видит мои данные»
      { id: 'n20', kind: 'rules_change', icon: 'eye', tone: 'info', title: 'Изменились правила: администратор видит ваши ставки и банк', body: 'Только просмотр: изменить он ничего не может, каждый просмотр записывается в журнал. Пароль, коды 2FA и ключ Claude не видит никто. Подробнее — «Кто видит мои данные».', at: '2026-10-05T09:00', link: '#profile-data-who', read: false },
      { id: 'n1', kind: 'admin_message', icon: 'megaphone', tone: 'info', title: 'Сообщение администратора', body: 'В субботу с 10:00 до 10:30 (Хельсинки) сервер обновляется, анализы будут недоступны.', at: '2026-10-07T08:00', read: false },
      { id: 'n10', kind: 'weekly_report', icon: 'calendar', tone: 'info', title: 'Отчет за неделю 28 сен – 4 окт', week: '2026-09-28', at: '2026-10-05T07:00', link: '#learning-reports', read: false },
      { id: 'n4', kind: 'bet_settled', icon: 'ticket', tone: autoLast.status === 'win' ? 'good' : 'bad', title: 'Ставка №' + autoLast.id + ' рассчитана автоматически', bet: autoLast.id, at: autoLast.settledAt, link: '#bets-' + autoLast.id, read: true },
      { id: 'n12', kind: 'settle_conflict', icon: 'alert', tone: 'warn', title: 'Архив показывает другой исход ставки №70', body: 'В файле tennis-data счет 2:1 — по нему Ф(−1.5) не сыграла, а вы внесли выигрыш. Банк не меняли: проверьте и при необходимости исправьте результат.', at: '2026-10-05T08:14', link: '#bets-70', read: true },
      { id: 'n13', kind: 'bet_needs_result', icon: 'clock', tone: 'warn', title: 'Ставка №66 ждет результата', body: 'Матч 22 сен, исхода в архиве нет 3 дня. Внесите результат сами — или он появится после загрузки файла.', at: '2026-09-25T09:00', link: '#bets-66', read: true },
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

  // ---------- Р27: данные участников для режима просмотра администратором ----------
  // Администратор видит ставки, банк, стратегию и анализы каждого участника — только просмотр. В макете у каждого
  // участника своя история: часть общих демо-ставок приложения (без старого бота) со своим стартовым банком,
  // своими суммами по той же таблице стратегии и своими букмекерами. Показатели — теми же формулами, что выше.
  // В приложении это обычные ответы сервера (GET /dashboard, /bets, /analytics, /analyses) по участнику.
  const sumBy = (a, f) => a.reduce((s, x) => s + f(x), 0);
  const yOf = l => (l.result === 'win' ? 1 : 0);
  function bookStats(bk) {
    const st = bk.bets.filter(b => b.status !== 'open');
    const w = st.filter(b => b.status === 'win').length, lo = st.filter(b => b.status === 'loss').length, vo = st.filter(b => b.status === 'void').length;
    const turn = sumBy(st, b => b.stake), prof = sumBy(st, b => b.profit);
    let sN = 0; const sT = st.length ? st[st.length - 1].status : null;
    for (let i = st.length - 1; i >= 0 && st[i].status === sT; i--) sN++;
    const app = bk.allLegs.filter(l => l.q != null);
    const br = app.length ? sumBy(app, l => (l.p - yOf(l)) ** 2) / app.length : null;
    const brM = app.length ? sumBy(app, l => (l.q - yOf(l)) ** 2) / app.length : null;
    const cb = st.filter(b => b.clv != null && b.source !== 'bot');
    const calib = [];
    for (let c = 0.5; c < 0.95; c += 0.05) {
      const inBin = app.filter(l => l.p >= c && l.p < c + 0.05);
      if (inBin.length) calib.push({ lo: round(c, 2), hi: round(c + 0.05, 2), p: round(sumBy(inBin, l => l.p) / inBin.length, 3), actual: round(inBin.filter(l => l.result === 'win').length / inBin.length, 3), n: inBin.length });
    }
    const rolling = [];
    for (let i = 29; i < app.length; i += 3) {
      const win = app.slice(i - 29, i + 1);
      rolling.push({ date: win[win.length - 1].date, model: round(sumBy(win, l => (l.p - yOf(l)) ** 2) / 30, 3), market: round(sumBy(win, l => (l.q - yOf(l)) ** 2) / 30, 3) });
    }
    const by = (key, labelOf) => {
      const g = {};
      bk.allLegs.forEach(l => { const k = key(l); (g[k] = g[k] || []).push(l); });
      return Object.entries(g).map(([k, ls]) => ({ key: k, label: labelOf ? labelOf(k) : k, n: ls.length, roi: round(sumBy(ls, l => (l.result === 'win' ? l.odds - 1 : -1)) / ls.length * 100, 1), winrate: round(ls.filter(l => l.result === 'win').length / ls.length * 100, 1) }));
    };
    let pk = 0;
    bk.bankHistory.forEach(x => { if (x.flow) { const before = x.bank - x.flow; pk = before > 0 ? pk * x.bank / before : x.bank; } pk = Math.max(pk, x.bank); });
    return {
      calibration: calib, brierRolling: rolling,
      roiBySurface: by(l => l.surface, k => surfaces[k].label), roiByMarket: by(l => l.marketLabel),
      roiByOdds: by(l => oddsBucket(l.odds)).sort((a, b) => a.key.localeCompare(b.key)),
      roiByTotal: Object.entries(st.reduce((g, b) => { const k = totalBucket(b.total); (g[k] = g[k] || []).push(b); return g; }, {})).map(([k, bs]) => ({ key: k, label: k, n: bs.length, roi: round(sumBy(bs, b => b.profit) / sumBy(bs, b => b.stake) * 100, 1) })).sort((a, b) => a.key.localeCompare(b.key)),
      stats: {
        bank: bk.bank, start: bk.start, profit: prof, turnover: turn, roi: turn ? round(prof / turn * 100, 1) : 0, settled: st.length, wins: w, losses: lo, voids: vo,
        winrate: w + lo ? round(w / (w + lo) * 100, 1) : 0, open: bk.bets.filter(b => b.status === 'open').length,
        streak: { type: sT, n: sN }, brier: br == null ? null : round(br, 3), brierMarket: brM == null ? null : round(brM, 3), clvAvg: cb.length ? round(sumBy(cb, b => b.clv) / cb.length, 1) : null, legs: bk.allLegs.length,
        peak: Math.round(pk), invested: sumBy(bk.bankFlows.filter(f => f.at.slice(0, 10) <= TODAY), f => (f.kind === 'withdrawal' ? -f.amount : f.amount)),
      },
    };
  }
  // since — первый день книги (регистрация или начало ставок приложения), keep — какие общие ставки у него были,
  // open — какие открытые ставки, deposit — пополнение внутри истории, books — его букмекеры
  const MEMBER_BOOKS = {
    u2: { since: '2026-08-01', start: 30000, keep: b => b.id % 3 !== 1, open: () => true, deposit: { date: '2026-09-07', amount: 10000, note: 'Пополнение счета Unibet' }, books: ['bet365', 'Unibet', 'Pinnacle'],
      analyses: [
        { id: 'A-0130', at: '2026-10-06T19:05', matches: [{ p1: 'fritz', p2: 'deminaur' }, { p1: 'zverev', p2: 'musetti' }], status: 'done', decision: 'bet', cost: 0.18 },
        { id: 'A-0128', at: '2026-10-05T11:20', matches: [{ p1: 'sinner', p2: 'draper' }], status: 'done', decision: 'skip', cost: 0.11 },
        { id: 'A-0126', at: '2026-10-04T18:45', matches: [{ p1: 'alcaraz', p2: 'rublev' }, { p1: 'djokovic', p2: 'shelton' }], status: 'failed', note: 'шаг 8 из 9: Claude перегружен', cost: 0.14 },
        { id: 'A-0124', at: '2026-10-03T10:10', matches: [{ p1: 'medvedev', p2: 'rune' }, { p1: 'sinner', p2: 'musetti' }], status: 'done', decision: 'bet', cost: 0.17 },
      ] },
    u3: { since: '2026-08-01', start: 80000, keep: b => b.id % 3 !== 0 && b.id % 5 !== 2, open: b => b.date === TODAY, books: ['Pinnacle', 'bet365'],
      analyses: [
        { id: 'A-0129', at: '2026-10-07T08:55', matches: [{ p1: 'sinner', p2: 'rune' }, { p1: 'djokovic', p2: 'rublev' }], status: 'done', decision: 'skip', cost: 0.19 },
        { id: 'A-0127', at: '2026-10-07T08:20', matches: [{ p1: 'alcaraz', p2: 'shelton' }], status: 'cancelled', cost: 0.04 },
        { id: 'A-0125', at: '2026-10-06T09:40', matches: [{ p1: 'zverev', p2: 'draper' }, { p1: 'fritz', p2: 'medvedev' }, { p1: 'musetti', p2: 'rune' }], status: 'done', decision: 'bet', cost: 0.21 },
        { id: 'A-0123', at: '2026-10-05T09:15', matches: [{ p1: 'deminaur', p2: 'rublev' }, { p1: 'shelton', p2: 'draper' }], status: 'done', decision: 'bet', cost: 0.16 },
      ] },
    u4: { since: '2026-08-20', start: 20000, keep: b => (b.id * 9) % 10 < 7, open: () => false, books: ['Unibet'],
      analyses: [
        { id: 'A-0122', at: '2026-10-05T20:03', matches: [{ p1: 'sinner', p2: 'medvedev' }, { p1: 'alcaraz', p2: 'deminaur' }], status: 'done', decision: 'bet', cost: 0.22 },
        { id: 'A-0119', at: '2026-10-02T21:30', matches: [{ p1: 'djokovic', p2: 'zverev' }], status: 'done', decision: 'skip', cost: 0.2 },
      ] },
  };
  function deriveBook(o) {
    let bk = o.start, nid = 1, dep = o.deposit || null;
    const hist = [{ date: o.since, bank: bk }], out = [], legs = [];
    const flows = [{ at: o.since + 'T09:00', kind: 'deposit', amount: o.start, start: true, note: 'Стартовый банк' }];
    bets.filter(b => b.source === 'app' && b.date >= o.since && (b.status === 'open' ? o.open(b) : o.keep(b))).forEach(b0 => {
      if (dep && b0.date >= dep.date) { bk += dep.amount; hist.push({ date: dep.date, bank: bk, flow: dep.amount }); flows.push({ at: dep.date + 'T10:05', kind: 'deposit', amount: dep.amount, note: dep.note }); dep = null; }
      const stake = Math.round(bk * stakePct(b0.total) / 100 / 10) * 10;
      const profit = b0.status === 'win' ? Math.round(stake * b0.total - stake) : b0.status === 'loss' ? -stake : 0;
      if (b0.status !== 'open') bk += profit;
      const b = Object.assign({}, b0, { id: nid++, srcId: b0.id, stake, profit, bankAfter: b0.status === 'open' ? null : bk, bookmaker: o.books[b0.id % o.books.length], legs: b0.legs.map(l => Object.assign({}, l)) });
      out.push(b);
      if (b0.status !== 'open') {
        hist.push({ date: b0.date, bank: bk });
        allLegs.filter(l => l.betId === b0.id).forEach(l => legs.push(Object.assign({}, l, { betId: b.id })));
      }
    });
    const book = { bets: out, allLegs: legs, bankHistory: hist, bankFlows: flows, start: o.start, bank: bk, recentAnalyses: o.analyses.map(a => Object.assign({}, a)) };
    return Object.assign(book, bookStats(book));
  }
  const books = {};
  Object.keys(MEMBER_BOOKS).forEach(uid => { books[uid] = deriveBook(MEMBER_BOOKS[uid]); });
  // Чьи данные сейчас на экранах: base — свои (демо-пользователя), иначе id участника. Подмена — на месте:
  // экраны держат ссылки на массивы и DATA.stats, поэтому меняется содержимое, а не сами объекты.
  const BOOK_KEYS = ['bets', 'allLegs', 'bankHistory', 'bankFlows', 'recentAnalyses', 'calibration', 'brierRolling', 'roiBySurface', 'roiByMarket', 'roiByOdds', 'roiByTotal'];
  let curBook = 'base', baseSnap = null;
  const snapBase = () => { const s = {}; BOOK_KEYS.forEach(k => { s[k] = window.DATA[k].slice(); }); s.stats = Object.assign({}, window.DATA.stats); return s; };
  function applyBook(src) {
    BOOK_KEYS.forEach(k => { const a = window.DATA[k]; a.splice(0, a.length, ...src[k]); });
    const S = window.DATA.stats;
    Object.keys(S).forEach(k => { delete S[k]; });
    Object.assign(S, src.stats);
  }
  function useBook(uid) {
    const want = books[uid] ? uid : 'base';
    if (want === curBook) return;
    if (curBook === 'base') baseSnap = snapBase();
    applyBook(want === 'base' ? baseSnap : books[want]);
    curBook = want;
  }
  // Книга человека без подмены экранов: для «Сводки» и карточки участника. Своя (u1 у администратора) — живая
  const bookOf = uid => {
    if (books[uid]) return books[uid];
    if (uid !== personas.admin.id) return null;
    return curBook === 'base' ? window.DATA : Object.assign({ stats: baseSnap.stats }, baseSnap);
  };
  // Итоги человека за период: days — 7, 30, 90 или null (все время)
  function bookSummary(uid, days) {
    const bk = bookOf(uid);
    if (!bk) return null;
    const from = days ? addDays(TODAY, -days) : '0000';
    const st = bk.bets.filter(b => b.status !== 'open' && b.date > from && b.date <= TODAY);
    const legs = bk.allLegs.filter(l => l.date > from && l.q != null);
    const turnover = sumBy(st, b => b.stake), profit = sumBy(st, b => b.profit);
    const cb = st.filter(b => b.clv != null && b.source !== 'bot');
    const open = bk.bets.filter(b => b.status === 'open');
    return {
      n: st.length, turnover, profit, roi: turnover ? profit / turnover * 100 : null,
      clv: cb.length ? sumBy(cb, b => b.clv) / cb.length : null, clvN: cb.length,
      brier: legs.length ? sumBy(legs, l => (l.p - yOf(l)) ** 2) / legs.length : null,
      brierMarket: legs.length ? sumBy(legs, l => (l.q - yOf(l)) ** 2) / legs.length : null, legsN: legs.length,
      bank: bk.stats.bank, invested: bk.stats.invested, open: open.length, inPlay: sumBy(open, b => b.stake),
      last: bk.bets.slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id)).slice(0, 5),
      analyses: bk.recentAnalyses || [],
    };
  }
  // Участник глазами администратора: его профиль для экранов (имя, пояс, букмекеры), как personas
  const memberPersonas = {};
  function personaOf(uid) {
    if (uid === personas.admin.id) return personas.admin;
    if (uid === personas.member.id) return personas.member;
    if (!memberPersonas[uid]) {
      const u = users.find(x => x.id === uid);
      if (!u) return null;
      const TZ = { u3: 'Europe/Berlin', u4: 'America/New_York' };
      memberPersonas[uid] = { id: u.id, name: u.name, first: u.name.split(' ')[0], email: u.email, initials: u.name.split(' ').map(w => w[0]).join('').slice(0, 2), tz: TZ[uid] || 'Europe/Helsinki', role: u.role, roleLabel: u.role === 'admin' ? 'Администратор' : 'Участник', since: u.since, aiMode: u.aiMode, bookmakers: (MEMBER_BOOKS[uid] || { books: ['bet365'] }).books.slice() };
    }
    return memberPersonas[uid];
  }

  window.DATA = {
    today: TODAY,
    demo: true,
    personas, users, admin, notifications, LIMIT_DEFAULT, timezones, marketRef: 'Pinnacle', archive,
    // Эталон рынка по Р17: первый, у кого есть кэфы обеих сторон. marketRef — первый в порядке (для старых подписей)
    marketRefRule: 'Pinnacle → Betfair → средний по рынку',
    // tzCity: «время по Хельсинки» — город в дательном падеже
    tzCity: tz => (timezones.find(t => t.value === tz) || timezones[0]).city,
    surfaces, players, P, calendar, markets,
    // Р28: новые рынки — подписи, статус рынка (в экспрессе, временно нет, «для сравнения») и счетчик событий
    fresh: { FAMILY, lineText, legLabel, status: marketStatus, statusOf: marketStatusOf, NEED: 150, NEED_MAX: 200 },
    // Р29: вид ставки — экспресс стратегии, ординар из вариантов анализа или своя ставка
    betKind: b => (b.own ? 'own' : b.single ? 'single' : 'strategy'),
    bets, bankHistory,
    stats: {
      bank, start: 40000, profit, turnover, roi: round(profit / turnover * 100, 1), settled: settled.length, wins, losses, voids,
      winrate: round(wins / (wins + losses) * 100, 1), open: bets.filter(b => b.status === 'open').length,
      streak: { type: streakType, n: streak }, brier: round(brier, 3), brierMarket: round(brierMarket, 3), clvAvg: round(clvAvg, 1), legs: allLegs.length,
      peak: Math.round(peakAdj), invested: investedAt(TODAY),
    },
    bankFlows, investedAt, predictions,
    allLegs, calibration, brierRolling, roiBySurface, roiByMarket, roiByOdds, roiByTotal,
    matchesToday, recentAnalyses,
    ai: { runs: aiRuns, spent: aiSpent, personalSpent, sharedSpent, keySpent, ownSpent, keyUsers, limitOf, budget, forecastOf, access, recordRun, recordSpend, decisions, budgetHint: 15, month: 'октябрь', cacheShare: round(aiRuns.reduce((a, r) => a + r.cached, 0) / aiRuns.reduce((a, r) => a + r.input, 0) * 100, 0), runTypes,
      // общие фоновые задачи — вызовы без участника (r.shared); проверки (eval) — отдельный бюджет; анализы — запуски из вызовов
      isShared: r => !!r.shared, eval: evalBudget, analyses: analysesSpec, searchUsd: SEARCH_USD },
    lessons, strategyVersions,
    // Этап 5: петля обучения — общие данные экранов «Обучение модели», «Главная», «Ставки», «ИИ и расходы»
    learning: {
      lessons, LESSONS_MAX, LESSON_MIN, LESSON_MIN_PROC, SHRINK_K, evalSet, versions: strategyVersions, ruleVersions, mlModels, walkForward, mlCalibration,
      postmortemOf, VERDICTS, weekReport, reportWeeks, ARCHIVE_TO, nextReport: '2026-10-12T07:00',
      // события с исходом для калибровки и c: ноги ставок приложения + прогнозы без ставки
      eventsWithOutcome: () => allLegs.filter(l => l.source === 'app').length + predictions.length, C_MIN: 300,
    },
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
    // Р27: режим просмотра данных участника администратором (js/view.js): своя книга у каждого участника
    useBook, bookSummary, personaOf, hasBook: uid => !!bookOf(uid),
    playerName: id => (P[id] ? P[id].short : id),
    match: (l) => (P[l.p1] ? P[l.p1].short : l.p1) + ' — ' + (P[l.p2] ? P[l.p2].short : l.p2),
  };
  // Текущий пользователь зависит от демо-роли (UI.auth.role задает app.js)
  const role = () => (window.UI && UI.auth && UI.auth.role) || 'admin';
  // В режиме просмотра (Р27) экраны видят участника, чьи данные открыты: его имя, пояс, букмекеров, лимит
  const viewing = () => (window.UI && UI.view && UI.view.uid) || null;
  Object.defineProperty(window.DATA, 'user', { enumerable: true, get: () => (viewing() && personaOf(viewing())) || personas[role()] });
  try { JSON.parse(localStorage.getItem('capper.currencyLog') || '[]').forEach(e => admin.audit.unshift(e)); } catch (e) { /* хранилище недоступно */ }
  admin.audit.sort((a, b) => (a.at < b.at ? 1 : -1));
  Object.defineProperty(window.DATA, 'me', { enumerable: true, get: () => users.find(u => u.id === (viewing() || personas[role()].id)) });
})();
