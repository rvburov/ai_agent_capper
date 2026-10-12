/* Игроки: база игроков (место и Эло, форма, последний матч в базе, свежесть новостей) и карточка игрока
   (#player-<id> или #player-<id>-<вкладка>: overview, matches, news, profile).
   Что есть в базе: игроки и матчи из архивов (Сакманн — с подачей и приемом до мая 2026, tennis-data.co.uk —
   результаты с датами и кэфы), Эло и место по Эло считает код, новости ищет Claude перед анализом (кэш 12 ч).
   Профили Claude не собираются и не обновляются: у части игроков есть только профиль, перенесенный из старого бота.
   Рейтинг, Эло, форма и статистика — из DATA.players. Последние матчи, новости и профиль из бота генерируются здесь
   детерминированно (сид от id игрока), чтобы карточки выглядели живыми и не расходились между заходами. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip, clear } = UI;
  const D = DATA;
  const NOW = D.today + 'T10:10'; // «сейчас» в демо: утро 7 октября, до первого матча дня
  const SURF = ['hard', 'clay', 'grass'];

  // ---------- что лежит в базе (Т22, В11) ----------
  // Последняя успешная загрузка архива (UTC) — общая с уведомлением data_stale администратору (DATA.archive).
  // В базе — результаты по день до загрузки; дольше staleDays без загрузки — архив устарел.
  const ARCH = D.archive || { lastLoad: D.today + 'T04:10', source: 'tennis-data.co.uk', staleDays: 3 };
  const ARCHIVE_AT = ARCH.lastLoad;
  const ARCHIVE_TO = new Date(Date.parse(ARCHIVE_AT.slice(0, 10) + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  const ARCHIVE_DAYS = Math.round((Date.parse(D.today + 'T12:00:00Z') - Date.parse(ARCHIVE_AT.slice(0, 10) + 'T12:00:00Z')) / 864e5);
  const ARCHIVE_STALE = ARCHIVE_DAYS > (ARCH.staleDays || 3);
  const SACKMANN_TO = '2026-05-25';      // копия архива Сакманна (подача и прием по матчам) — по Roland Garros 2026
  const NEWS_TTL_H = 12;                 // новости по игроку не ищутся заново 12 часов
  const BASE_ALL = 2790, BASE_ACTIVE = 412, PAGE = 50; // игроков в базе / с матчами за 52 недели; строк на странице
  const NEWS_SITES = 'atptour.com, сайты четырех турниров Большого шлема, tennis.com, tennismajors.com, espn.com';
  const ATTRIBUTION = 'Матчи и статистика подачи: Jeff Sackmann, tennis_atp (CC BY-NC-SA 4.0) · результаты и кэфы: tennis-data.co.uk';
  // Сегодняшние 1/8 Шанхая — факт архива (сетка турнира), от него зависят сгенерированные матчи недели
  const SHANGHAI_TODAY = ['sinner', 'rune', 'djokovic', 'rublev', 'zverev', 'musetti', 'alcaraz', 'shelton', 'fritz', 'deminaur'];

  const COUNTRY = { ITA: 'Италия', ESP: 'Испания', GER: 'Германия', USA: 'США', SRB: 'Сербия', GBR: 'Великобритания', RUS: 'Россия', DEN: 'Дания', AUS: 'Австралия', CZE: 'Чехия', FRA: 'Франция', BUL: 'Болгария', CHI: 'Чили', KAZ: 'Казахстан', NOR: 'Норвегия', GRE: 'Греция' };
  // Имена латиницей: поиск в приложении идет по обоим написаниям и прощает опечатки (pg_trgm)
  const LATIN = { sinner: 'Jannik Sinner', alcaraz: 'Carlos Alcaraz', zverev: 'Alexander Zverev', fritz: 'Taylor Fritz', djokovic: 'Novak Djokovic', draper: 'Jack Draper', medvedev: 'Daniil Medvedev', rune: 'Holger Rune', deminaur: 'Alex de Minaur', shelton: 'Ben Shelton', musetti: 'Lorenzo Musetti', rublev: 'Andrey Rublev' };
  // Профиль из старого бота (player_profiles, source = legacy_llm): есть не у всех. Модель бота заполняла его сама,
  // часто по памяти и без ссылок на источники. Показываем отдельной вкладкой с пометкой, в анализ он не идет.
  const LEGACY_AT = '2026-07-02T12:30';
  const LEGACY = {
    sinner: { kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
    alcaraz: { kind: 'Универсальный', pos: 'Универсальная', serveType: 'Комбинированная' },
    zverev: { kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Плоская' },
    fritz: { kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Плоская' },
    djokovic: { kind: 'Контратакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
    medvedev: { kind: 'Защитный', pos: 'Задняя линия', serveType: 'Плоская' },
    musetti: { kind: 'Универсальный', pos: 'Универсальная', serveType: 'Комбинированная' },
    rublev: { kind: 'Атакующий', pos: 'Задняя линия', serveType: 'Комбинированная' },
  };
  const hasLegacy = p => !!LEGACY[p.id];
  // Средние по туру (топ-50) за 52 недели до конца архива Сакманна — для сравнения подачи и приема
  const TOUR = { first: 62, firstWon: 74, secondWon: 52, aces: 6.6, df: 2.9, firstRet: 30, secondRet: 51, bpConv: 40, bpSaved: 62 };

  // ---------- утилиты ----------
  function rng(str) {
    let s = 0; for (const c of str) s = (Math.imul(s, 31) + c.charCodeAt(0)) | 0;
    return () => { s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ts = iso => Date.parse(iso.length === 10 ? iso + 'T12:00:00Z' : iso + ':00Z');
  const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const addMin = (iso, n) => new Date(ts(iso) + n * 60000).toISOString().slice(0, 16);
  const signed = (n, d = 0) => (n > 0 ? '+' : n < 0 ? '−' : '±') + (d ? fmt.dec(Math.abs(n), d) : fmt.int(Math.abs(n)));
  const initials = name => name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
  // Форма — 10 последних сыгранных матчей в базе (архив отстает: матчей после загрузки здесь еще нет)
  const formOf = p => info(p).matches.filter(m => !m.wo).slice(0, 10).map(m => m.res);
  const winsOf = p => formOf(p).filter(x => x === 'W').length;
  const plural = (n, a, b, c) => n + ' ' + fmt.plural(n, a, b, c);
  const age = p => plural(p.age, 'год', 'года', 'лет');
  const elo = v => String(Math.round(v)); // рейтинги Эло пишем без разделителя разрядов
  const norm = s => String(s).toLowerCase().replace(/\u0451/g, 'е');
  // Поиск: подстрока в имени (рус. или лат.) или стране; если ее нет — похожие слова: расстояние Левенштейна
  // до 1 (до 2 у слова запроса от 7 букв). В приложении то же делает pg_trgm: «синер» находит Синнера.
  function lev(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  }
  const near = (t, w) => t.length >= 4 && [w, w.slice(0, t.length), w.slice(0, t.length + 1)].some(x => lev(t, x) <= (t.length >= 7 ? 2 : 1));
  function searchMatch(p, q) {
    const hay = [p.name, p.short, LATIN[p.id] || '', p.country, COUNTRY[p.country] || ''].map(norm);
    if (hay.some(s => s.includes(q))) return 'exact';
    const words = hay.join(' ').split(/[\s-]+/).filter(Boolean);
    return q.split(/\s+/).filter(Boolean).every(t => words.some(w => w.includes(t) || near(t, w))) ? 'near' : null;
  }

  function ago(iso) {
    if (!iso) return null;
    const min = Math.round((ts(NOW) - ts(iso)) / 60000);
    if (min < 2) return 'только что';
    if (min < 60) return min + ' мин назад';
    if (min < 23.5 * 60) return Math.round(min / 60) + ' ч назад';
    const d = Math.round(min / 1440);
    return plural(d, 'день', 'дня', 'дней') + ' назад';
  }
  const when = iso => (iso.slice(0, 10) === D.today ? 'сегодня, ' + iso.slice(11, 16) : fmt.datetime(iso));
  const todayMatch = id => SHANGHAI_TODAY.includes(id); // играет ли сегодня (для генерации недели Шанхая)
  const eloProb = (a, b) => 1 / (1 + Math.pow(10, -(a - b) / 400));
  const eloRankAll = p => D.players.slice().sort((a, b) => b.elo.all - a.elo.all).indexOf(p) + 1;
  const bestSurface = p => SURF.slice().sort((a, b) => p.elo[b] - p.elo[a])[0];
  const kvWide = pairs => { const el = UI.kv(pairs); el.classList.add('players-kv'); return el; };

  // ---------- новости проверены (players.news_checked_at) ----------
  // Новости ищутся шагом «Новости» анализа, если по игроку им больше 12 часов. Время — по анализам из «Последних анализов»;
  // если анализ взял новости из кэша (newsCached), время — когда их нашли в анализе другого участника (общая база новостей).
  const NEWS_AT = {}, NEWS_BY = {};
  (D.recentAnalyses || []).slice().sort((a, b) => a.at.localeCompare(b.at)).forEach(a => (a.matches || []).forEach((m, k) => [m.p1, m.p2].forEach(id => {
    const cached = a.newsCached && a.newsCached[id];
    NEWS_AT[id] = cached || addMin(a.at, 1 + k); NEWS_BY[id] = cached ? null : a;
  })));
  const newsWhere = id => (NEWS_BY[id] ? 'анализ #' + NEWS_BY[id].id : 'общая база новостей');
  const newsFresh = id => !!NEWS_AT[id] && ts(NOW) - ts(NEWS_AT[id]) < NEWS_TTL_H * 3600000;
  const analysisHref = a => (a.demo ? '#analysis' : '#analysis-' + a.id);
  function newsChip(id) {
    if (!NEWS_AT[id]) return chip('Новости не искали', 'outline', 'globe');
    return newsFresh(id) ? chip('Новости свежие', 'good', 'check') : chip('Новости старше 12 ч', 'outline', 'clock');
  }
  const newsText = id => (!NEWS_AT[id] ? 'не искали' : ago(NEWS_AT[id]) + (newsFresh(id) ? '' : ' · обновятся перед анализом'));

  // ---------- «сегодня» — только из своих ставок и анализов ----------
  // Расписания матчей в программе нет (Р10): «сегодня» берется из открытых ставок и сегодняшних анализов участника.
  function myToday(id) {
    for (const b of D.bets) if (b.status === 'open') for (const l of b.legs) if (l.p1 === id || l.p2 === id) return { bet: b, leg: l, p1: l.p1, p2: l.p2 };
    const a = (D.recentAnalyses || []).find(x => x.at.slice(0, 10) === D.today && (x.matches || []).some(m => m.p1 === id || m.p2 === id));
    if (a) { const m = a.matches.find(x => x.p1 === id || x.p2 === id); return { analysis: a, p1: m.p1, p2: m.p2 }; }
    return null;
  }
  // Время матча — из ввода участника (в макете — из демо-матчей дня, если они есть)
  function timeOf(t) {
    const m = (D.matchesToday || []).find(x => (x.p1 === t.p1 && x.p2 === t.p2) || (x.p1 === t.p2 && x.p2 === t.p1));
    return m ? m.time : null;
  }
  function todayTag(p) {
    const t = myToday(p.id);
    if (!t) return null;
    const tm = timeOf(t);
    return h('span', { class: 'players-today-tag', title: t.bet ? 'Матч сегодня в вашей ставке №' + t.bet.id : 'Матч сегодня в вашем анализе #' + t.analysis.id },
      icon(t.bet ? 'ticket' : 'spark'), (t.bet ? 'в ставке №' + t.bet.id : 'в анализе') + (tm ? ' · ' + tm : ''));
  }

  // ---------- состояние модуля ----------
  const listState = { q: '', data: 'active', surface: 'hard', sort: 'rank' };
  const cardTabs = {};           // последняя открытая вкладка карточки по игроку
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
    // более старые недели нужны только второму проходу генератора (см. matchesOf)
    { name: 'Мальорка', alt: 'Истборн', cat: 'ATP 250', surface: 'grass', from: '2026-06-21', to: '2026-06-27', rounds: R5, start: 0 },
    { name: 'Халле', alt: 'Квинс', cat: 'ATP 500', surface: 'grass', from: '2026-06-15', to: '2026-06-21', rounds: R5, start: 0, must: true },
    { name: 'Штутгарт', alt: 'Хертогенбос', cat: 'ATP 250', surface: 'grass', from: '2026-06-08', to: '2026-06-14', rounds: R5, start: 0, must: true },
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
  // DATA.players.form — 10 последних матчей вместе с Шанхаем, которого в архиве еще нет. Чтобы и в базе
  // было 10 матчей, генератор идет в два прохода: сначала по form у всех игроков (как раньше, поэтому
  // уже показанные матчи и соперники не меняются), затем у каждого дописывает 4 более старых исхода.
  const olderForm = p => { const rx = rng(p.id + ':fx'), pw = clamp(0.45 + (p.elo.all - 1900) / 600, 0.35, 0.85); return [0, 1, 2, 3].map(() => (rx() < pw ? 'W' : 'L')); };
  let matchesAll = null;
  function matchesOf(p) {
    if (!matchesAll) {
      matchesAll = {};
      const gens = GEN_ORDER.map(id => { const g = genMatches(D.P[id]); g.run(); return g; });
      gens.forEach((g, k) => { g.extend(olderForm(D.P[GEN_ORDER[k]])); matchesAll[GEN_ORDER[k]] = g.out; });
    }
    if (matchesAll[p.id]) return matchesAll[p.id];
    const g = genMatches(p); g.run(); g.extend(olderForm(p));
    return g.out;
  }

  const cache = {};
  function info(p) {
    if (cache[p.id]) return cache[p.id];
    const all = matchesOf(p);
    // в базе — только то, что уже пришло из архивов; более свежие матчи появятся после загрузки tennis-data
    const o = { matches: all.filter(m => m.date <= ARCHIVE_TO) };
    o.ratings = genRatings(p);
    o.psych = genPsych(p);
    o.state = genState(o.matches);
    o.news = genNews(p, all); // новости знают и о матчах, которых в архиве еще нет
    o.vs = genVs(p);
    return (cache[p.id] = o);
  }
  const lastInBase = p => info(p).state.last;
  // Для других экранов (например, досье на «Анализе»): форма и последний матч — по матчам в базе, как здесь
  D.playerBase = { form: id => (D.P[id] ? formOf(D.P[id]) : []), last: id => (D.P[id] ? lastInBase(D.P[id]) : null), m14: id => (D.P[id] ? info(D.P[id]).state.m14 : 0), archiveTo: ARCHIVE_TO };

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
          opp: P ? { id: P.id, name: P.short, cc: P.country, rank: P.eloPlace } : x ? { name: x[0], cc: x[1], rank: null } : { name: o } });
      });
    });
    return out.sort((a, b) => b.date.localeCompare(a.date));
  }

  // Все, кто играл в Шанхае по ставкам этой недели: случайным соперником в Шанхае их не ставим, чтобы сетка не спорила с историей ставок
  const SH_BET_NAMES = new Set(D.bets.filter(b => b.date >= '2026-10-02' && b.status !== 'open').flatMap(b => b.legs.flatMap(l => [l.p1, l.p2])));

  // Генератор матчей игрока: run() — проход по form, extend(more) — продолжить с той же недели более старыми исходами
  function genMatches(p) {
    const r = rng(p.id + ':m');
    let form = p.form;
    const out = [], used = new Set();
    const known = shanghaiFromBets(p.id);
    known.forEach(k => { used.add(k.opp.id || k.opp.name); WEEK_TAKEN[0].add(k.opp.id || k.opp.name); });
    const plays = !!todayMatch(p.id);
    const tops = D.players.filter(x => x.id !== p.id);
    // Случайный выбор — как раньше (тот же расход генератора, чтобы остальные цифры карточки не менялись);
    // если соперник на этой неделе уже занят другим игроком базы — берем следующего свободного по списку.
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
          return { id: y.id, name: y.short, cc: y.country, rank: y.eloPlace };
        } else {
          const k = Math.floor(r() * OTHERS.length), x = OTHERS[k];
          if (used.has(x[0]) || (live && SH_BET_NAMES.has(x[0]))) continue;
          used.add(x[0]);
          let y = x;
          for (let s2 = 1; taken.has(y[0]) && s2 < OPP_POOL.length; s2++) { const c = OPP_POOL[(k + s2) % OPP_POOL.length]; if (!used.has(c[0]) && !(live && SH_BET_NAMES.has(c[0])) && !taken.has(c[0])) y = c; }
          used.add(y[0]); taken.add(y[0]);
          return { name: y[0], cc: y[1], rank: null };
        }
      }
      return { name: OTHERS[0][0], cc: OTHERS[0][1], rank: null };
    };
    let i = 0, week0 = 0;
    function run() {
      let week = week0;
      for (; week < EVENTS.length; week++) {
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
      week0 = week;
    }
    return { out, run, extend(more) { form = form.concat(more); run(); } };
  }

  const SINNER_RATINGS = {
    phys: [['Скорость', 9], ['Выносливость', 8], ['Взрывная сила', 9], ['Гибкость', 9], ['Реакция', 9]],
    tech: [['Сила подачи', 8], ['Точность подачи', 8], ['Второй мяч', 8], ['Форхенд', 9], ['Бэкхенд', 10], ['Задняя линия', 10], ['Игра у сетки', 7], ['Прием подачи', 9], ['Укороченный', 6]],
    strong: ['Бэкхенд по линии с любой позиции', 'Темп и глубина с задней линии', 'Прием второй подачи'],
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
        ['Задняя линия', j(base + 0.3)], ['Игра у сетки', j(base - 1.4 + (p.id === 'alcaraz' ? 2 : 0))], ['Прием подачи', j(ret, 0.4)], ['Укороченный', j(base - 1.6 + (['alcaraz', 'musetti'].includes(p.id) ? 3 : 0))]],
    };
    const tech = o.tech.slice().sort((a, b) => b[1] - a[1]);
    const PH = { 'Сила подачи': 'Мощная первая подача', 'Точность подачи': 'Точная подача в углы', 'Второй мяч': 'Надежный второй мяч', 'Форхенд': 'Форхенд — главный удар', 'Бэкхенд': 'Стабильный бэкхенд', 'Задняя линия': 'Длинные розыгрыши с задней линии', 'Игра у сетки': 'Уверенная игра у сетки', 'Прием подачи': 'Сильный прием', 'Укороченный': 'Укороченные удары' };
    const WK = { 'Сила подачи': 'Подача без «бесплатных» очков', 'Точность подачи': 'Нестабильный процент первой подачи', 'Второй мяч': 'Атакуемая вторая подача', 'Форхенд': 'Форхенд ломается под давлением', 'Бэкхенд': 'Бэкхенд на высоких мячах', 'Задняя линия': 'Проигрывает длинные розыгрыши', 'Игра у сетки': 'Редко и неуверенно выходит к сетке', 'Прием подачи': 'Слабый прием против подающих', 'Укороченный': 'Почти не использует укороченные' };
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
        text: tbPct >= 62 ? 'Играет первым номером, на своей подаче рискует вторым мячом. Тай-брейки — скорее плюс.' : tbPct >= 50 ? 'Ровно, без явного перекоса: тай-брейк для него почти лотерея.' : 'Отдает инициативу и чаще ошибается с задней линии. Против сильных подающих это минус.' },
      { k: 'При 0:40 на своей подаче', stat: 'отыгрывает гейм в ' + hold + '% (тур — 19%)',
        text: hold >= 24 ? 'Поднимает процент первой подачи и играет на счет, а не на эффект.' : hold >= 17 ? 'Ведет себя как средний игрок тура: без провалов, но и без «чудес».' : 'Часто торопится и отдает гейм двойной или невынужденной ошибкой.' },
      { k: 'После проигранного первого сета', stat: 'выиграл ' + setW + ' из ' + setTotal + ' матчей',
        text: setW / setTotal >= 0.5 ? 'Быстро перестраивается, во втором сете меняет направление ударов.' : 'Эмоционально «проседает»: второй сет часто проигрывает с брейком в начале.' },
      { k: 'Под давлением трибун и судьи', stat: type.toLowerCase(),
        text: hot ? 'Спорит с судьей и ракеткой, после эмоциональных эпизодов бывает серия проигранных очков.' : 'Спокоен, на решения судьи почти не реагирует.' },
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

  // Только то, что считается из матчей базы: последний матч, нагрузка за 14 дней, дни отдыха.
  // Здоровья, усталости и мотивации как полей в базе нет (В11) — об этом пишут новости.
  function genState(matches) {
    const played = matches.filter(m => !m.wo);
    const last = played[0] || null;
    const m14 = played.filter(m => m.date >= addDays(D.today, -14)).length;
    const rest = last ? Math.round((ts(D.today) - ts(last.date)) / 864e5) - 1 : null;
    return { last, m14, rest };
  }

  // Новости из шага «Новости» анализа (player_news): дата, вид, короткая сводка и ссылка на источник.
  // Источники — только сайты из списка (Р23); за 14 дней до поиска.
  const NEWS_KIND = { result: ['Результат', 'outline', 'trophy'], injury: ['Травма', 'warn', 'alert'], withdrawal: ['Снятие', 'warn', 'x'], motivation: ['Мотивация', 'info', 'target'], other: ['Другое', 'outline', 'info'] };
  function genNews(p, matches) {
    const at = NEWS_AT[p.id];
    if (!at) return [];
    const s = p.short, out = [];
    if (p.id === 'sinner') out.push(
      { date: '2026-10-05', src: 'atptour.com', kind: 'result', text: 'Синнер вышел в 1/8 финала Шанхая, оба матча — в двух сетах. После матча: «Корт заметно быстрее, чем в Пекине, подача работает лучше».' },
      { date: '2026-10-01', src: 'tennismajors.com', kind: 'withdrawal', text: 'Синнер снялся с Пекина после первого круга, чтобы восстановиться к Шанхаю. Травмы нет, по словам команды — плановый отдых.' });
    else {
      const last = matches.find(m => !m.wo);
      if (last && last.event === 'Шанхай') out.push(last.res === 'W'
        ? { date: last.date, src: 'atptour.com', kind: 'result', text: s + ' прошел ' + last.round + ' Шанхая: ' + last.score + ', соперник — ' + last.opp.name + '.' }
        : { date: last.date, src: 'atptour.com', kind: 'result', text: s + ' проиграл в ' + last.round + ' Шанхая (' + last.score + '). Следующий турнир — Вена, ATP 500, крытый хард, с 19 окт.' });
    }
    out.push({ date: '2026-10-04', src: 'tennis.com', kind: 'other', text: 'Статистика турнира: на центральных кортах Шанхая эйсов на 18% больше, чем в 2025 году.' });
    if (p.id === 'medvedev') out.push({ date: '2026-10-03', src: 'tennismajors.com', kind: 'injury', text: 'Медведев тренировался в Шанхае с тейпом на правом запястье. Сам игрок назвал это профилактикой, снятия не было.' });
    if (p.eloPlace <= 8 && p.id !== 'sinner') out.push({ date: '2026-09-30', src: 'espn.com', kind: 'motivation', text: s + ' борется за место в Итоговом турнире в Турине: до конца отбора три турнира.' });
    const from = addDays(at.slice(0, 10), -14);
    return out.filter(n => n.date <= at.slice(0, 10) && n.date >= from).sort((a, b) => b.date.localeCompare(a.date));
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
    .players-fgroup .select, .players-fgroup .dd-trigger { min-width: 176px; }
    .players-table td { vertical-align: middle; }
    .players-results-foot { display: flex; justify-content: space-between; gap: 8px 16px; flex-wrap: wrap; align-items: center; font-size: var(--fs-sm); color: var(--fg-3); }
    .players-results-foot > span { min-width: 0; }

    .players-item { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-bottom: 1px solid var(--line); cursor: pointer; min-width: 0; }
    .players-item:last-child { border-bottom: 0; }
    .players-item:hover { background: var(--surface-2); }
    .players-item-top, .players-item-bot { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; min-width: 0; }
    .players-item-bot { flex-direction: column; align-items: stretch; gap: 4px; font-size: var(--fs-xs); color: var(--fg-3); }
    .players-item-bot > span { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .players-item-bot svg { width: 13px; height: 13px; flex: none; }
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
    .players-attrib { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-xs); color: var(--fg-3); margin: 0; }
    .players-attrib svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }

    .players-hero-top { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 16px 20px; align-items: center; padding: 20px; }
    .players-avatar { width: 64px; height: 64px; border-radius: 50%; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); font-family: var(--font-display); font-weight: 700; font-size: 1.375rem; flex: none; }
    .players-hero-id { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .players-hero-id h2 { font-size: var(--fs-2xl); }
    .players-meta { color: var(--fg-2); font-size: var(--fs-sm); }
    .players-hero-status { display: flex; flex-direction: column; align-items: flex-end; gap: 10px; text-align: right; min-width: 0; }
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

    .tabs.players-tabs { display: grid; grid-template-columns: repeat(var(--players-tabs, 4), minmax(0, 1fr)); gap: 2px; }
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

    .players-news-item { display: grid; grid-template-columns: 7rem minmax(0, 1fr); gap: 6px 18px; padding: 14px 18px; border-top: 1px solid var(--line); align-items: start; }
    .players-news-when { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); min-width: 0; align-items: flex-start; }
    .players-news-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .players-news-src { display: inline-flex; align-items: center; gap: 4px; font-family: var(--font-mono); font-size: 11px; color: var(--fg-3); min-height: 24px; }
    .players-news-src svg { width: 12px; height: 12px; }
    .players-news-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 28px 18px; text-align: center; color: var(--fg-2); font-size: var(--fs-sm); }
    .players-news-empty svg { width: 26px; height: 26px; color: var(--fg-3); }

    .players-mrow { display: flex; flex-direction: column; gap: 6px; padding: 12px 14px; border-top: 1px solid var(--line); min-width: 0; }
    .players-mrow-line { display: flex; justify-content: space-between; align-items: center; gap: 10px; min-width: 0; font-size: var(--fs-sm); }
    .players-mrow-line > span:first-child { min-width: 0; }
    .players-wo td, .players-mrow.players-wo { color: var(--fg-3); }
    .players-strip { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .players-strip > div { background: var(--surface); padding: 10px 14px; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .players-strip b { font-family: var(--font-display); font-size: var(--fs-lg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .players-strip span { font-size: var(--fs-xs); color: var(--fg-3); }

    .players-notfound { align-items: center; text-align: center; padding: 40px 20px; gap: 12px; }
    .players-notfound-ic { width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-3); }
    .players-notfound-ic svg { width: 26px; height: 26px; }

    @media (max-width: 1180px) {
      .players-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    @media (max-width: 720px) {
      .players-head h2 { font-size: var(--fs-xl); }
      .players-flush { margin: 0 -14px -14px; }
      .players-vs { padding: 12px 14px 14px; }
      .players-filters { padding: 14px; gap: 12px; }
      .players-search { max-width: none; flex-basis: 100%; }
      .players-fgroup { flex: 1 1 100%; }
      .players-fgroup.players-half { flex: 1 1 100%; }
      .players-fgroup .segmented { width: 100%; }
      .players-fgroup .segmented button { flex: 1 1 auto; padding: 6px 6px; }
      .players-count { margin-left: 3px; }
      .players-fgroup .select, .players-fgroup .dd-trigger { min-width: 0; }
      .players-sources { grid-template-columns: minmax(0, 1fr); gap: 14px; }
      .players-hero-top { grid-template-columns: auto minmax(0, 1fr); padding: 16px 14px; gap: 14px; }
      .players-avatar { width: 52px; height: 52px; font-size: var(--fs-lg); }
      .players-hero-id h2 { font-size: var(--fs-xl); }
      .players-hero-status { grid-column: 1 / -1; flex-direction: row; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; text-align: left; padding-top: 12px; border-top: 1px solid var(--line); }
      .players-hero-st { align-items: flex-start; }
      .players-hero-top { align-items: start; }
      .players-hero-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .players-hero-stats > div { padding: 12px 14px; }
      .players-hero-stats > div:nth-child(odd) { border-left: 0; }
      .players-hero-stats > div:nth-child(n+3) { border-top: 1px solid var(--line); }
      .players-hs-v { font-size: var(--fs-lg); }
      .players-today { padding: 12px 14px; }
      .players-today .btn { flex: 1 1 100%; }
      .players-metrics { grid-template-columns: minmax(0, 1fr); }
      .players-patterns { grid-template-columns: minmax(0, 1fr); }
      .players-rate { grid-template-columns: minmax(0, 8.5rem) minmax(0, 1fr) 1.6rem; gap: 10px; }
      .players-news-item { grid-template-columns: minmax(0, 1fr); padding: 14px; }
      .players-news-when { flex-direction: row; gap: 10px; align-items: center; flex-wrap: wrap; }
      .players-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
  `);

  // ---------- общие кусочки ----------
  function nameCell(p, opts = {}) {
    return h('div', { class: 'players-name' },
      h('a', { class: 'players-link', href: '#player-' + p.id, on: { click: e => e.stopPropagation() } }, p.name),
      h('div', { class: 'players-sub' }, h('span', { class: 'players-cc', title: COUNTRY[p.country] || p.country }, p.country), opts.rank ? '№' + p.eloPlace + ' по Эло' : age(p), todayTag(p)));
  }
  function lastCell(p) {
    const m = lastInBase(p);
    return m ? h('div', { class: 'players-cell-2' }, h('span', { style: 'white-space:nowrap' }, fmt.date(m.date)), h('small', null, m.event + ', ' + m.round)) : h('span', { class: 'muted' }, '—');
  }
  const attribution = () => h('p', { class: 'players-attrib' }, icon('database'), h('span', null, ATTRIBUTION));

  // =====================================================================
  // Список игроков
  // =====================================================================
  function renderList(root) {
    const st = listState;
    const mobile = UI.isMobile();
    const freshN = D.players.filter(p => newsFresh(p.id)).length;

    const head = h('div', { class: 'page-head players-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'База игроков'),
        h('p', { class: 'lead' }, 'Игроки и матчи приходят из архивов ATP, Эло и место по Эло считаем сами. Сначала показаны игроки с матчами за 52 недели по месту по Эло, страницами по ' + PAGE + '; поиск идет по всей базе.')));

    const tiles = h('div', { class: 'grid players-tiles' },
      UI.stat({ class: 'col-3 half-mobile', icon: 'users', label: 'Игроков в базе', value: fmt.int(BASE_ALL), hint: 'из архивов Сакманна и tennis-data' }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'calendar', label: 'Играли за 52 недели', value: fmt.int(BASE_ACTIVE), hint: 'среди них считаем место по Эло' }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'database', label: 'Результаты в базе', value: 'по ' + fmt.date(ARCHIVE_TO), hint: 'загрузка ' + when(ARCHIVE_AT) + ' UTC' + (ARCHIVE_STALE ? ' · ' + plural(ARCHIVE_DAYS, 'день', 'дня', 'дней') + ' без обновления' : '') }),
      UI.stat({ class: 'col-3 half-mobile', icon: 'globe', label: 'Новости за 12 ч', value: String(freshN), hint: 'ищутся перед анализом, кэш 12 ч' }));

    // --- фильтры ---
    const searchInput = h('input', { class: 'input', id: 'players-q', type: 'search', placeholder: mobile ? 'Имя или страна' : 'Имя (рус. или лат.), страна', autocomplete: 'off', value: st.q, on: { input: e => { st.q = e.target.value; drawResults(); } } });
    const dataSeg = UI.segmented({ label: 'Какие игроки', active: st.data, onChange: v => { st.data = v; drawResults(); }, items: [
      { id: 'active', label: [mobile ? 'За 52 нед.' : 'Играли за 52 недели', h('span', { class: 'players-count' }, fmt.int(BASE_ACTIVE))] },
      { id: 'news', label: [mobile ? 'Новости' : 'Новости за 12 ч', h('span', { class: 'players-count' }, freshN)] },
      { id: 'all', label: [mobile ? 'Все' : 'Вся база', h('span', { class: 'players-count' }, fmt.int(BASE_ALL))] },
    ] });
    const sortField = UI.field({ id: 'players-sort', label: 'Сортировка', value: st.sort, options: [{ value: 'rank', label: 'Место по Эло' }, { value: 'elo', label: 'Эло на покрытии' }, { value: 'last', label: 'Последний матч в базе' }] });
    sortField.querySelector('select').addEventListener('change', e => { st.sort = e.target.value; drawResults(); });
    const filters = h('div', { class: 'players-filters', role: 'search' },
      h('div', { class: 'field players-search' }, h('label', { class: 'field-label', for: 'players-q' }, 'Поиск'), h('div', { class: 'input-wrap' }, icon('search', { class: 'players-search-ic' }), searchInput)),
      h('div', { class: 'players-fgroup' }, h('span', { class: 'players-flabel' }, 'Данные'), dataSeg),
      h('div', { class: 'players-fgroup players-half' }, h('span', { class: 'players-flabel' }, 'Эло на покрытии'),
        UI.segmented({ label: 'Покрытие для Эло', active: st.surface, onChange: v => { st.surface = v; drawResults(); }, items: SURF.map(k => ({ id: k, label: D.surfaces[k].label })) })),
      h('div', { class: 'players-fgroup players-half' }, sortField));
    const results = h('div');
    const resultsFoot = h('div', { class: 'card-foot players-results-foot' });
    const listCard = h('section', { class: 'card', 'aria-label': 'Список игроков' }, filters, results, resultsFoot);

    const sources = card({
      title: 'Откуда берутся данные', subtitle: 'База игроков, матчей и новостей общая для всех участников',
      body: [h('div', { class: 'players-sources' },
        source('database', 'Архивы матчей', 'Сакманн — матчи и статистика подачи и приема (копия архива, по май 2026). tennis-data.co.uk — результаты с датами и кэфы. Загрузка каждую ночь, без ИИ и токенов; Эло и место по Эло считаем сами.'),
        source('globe', 'Новости — перед анализом', 'Claude (Sonnet 5.5) ищет их шагом анализа, если по игроку им больше 12 часов: 2 поиска на матч, только ' + NEWS_SITES + '. Найденное общее для всех; стоит ≈ $0,11 на матч и входит в цену анализа.'),
        source('target', 'Кэфы для CLV и сравнения с рынком', 'CLV — по закрывающему кэфу, который вы вносите на «Ставках»: эталона (' + (D.marketRefRule || 'Pinnacle → Betfair → средний') + ') или своего букмекера. Сравнение модели с рынком в «Аналитике» — по кэфам вашего букмекера в момент прогноза, без маржи. Закрывающие кэфы из tennis-data — на этапе 5.'),
        source('history', 'Профили из старого бота', 'Есть только у части игроков: модель бота заполняла их сама, часто по памяти. Показываем отдельной вкладкой с пометкой, в анализ они не идут. Новых профилей программа не собирает.')),
        attribution()],
    });
    function source(ic, title, text) { return h('div', { class: 'players-source' }, h('span', { class: 'players-source-ic' }, icon(ic)), h('div', { style: 'min-width:0' }, h('h4', null, title), h('p', null, text))); }

    // Архив давно не обновлялся: те же сроки, что у уведомления data_stale администратору
    const stale = ARCHIVE_STALE ? UI.callout('warn', 'database', h('b', null, 'Архив матчей не обновлялся ' + plural(ARCHIVE_DAYS, 'день', 'дня', 'дней') + '. '),
      'В базе нет матчей после ' + fmt.date(ARCHIVE_TO) + ': Эло, форма и последний матч — на эту дату. ',
      D.user.role === 'admin' ? 'Причина — в журнале загрузок; обновить вручную: bash deploy/local.sh data.' : 'Администратор получил уведомление.') : null;
    UI.append(root, [head, tiles, stale, listCard, sources]);

    let fuzzyOnly = false;
    function filtered() {
      const q = norm(st.q.trim());
      let arr = D.players.filter(p => st.data !== 'news' || newsFresh(p.id));
      fuzzyOnly = false;
      if (q) {
        const exact = arr.filter(p => searchMatch(p, q) === 'exact');
        fuzzyOnly = !exact.length;
        arr = exact.length ? exact : arr.filter(p => searchMatch(p, q) === 'near');
      }
      if (st.sort === 'rank') arr.sort((a, b) => a.eloPlace - b.eloPlace);
      else if (st.sort === 'elo') arr.sort((a, b) => b.elo[st.surface] - a.elo[st.surface]);
      else arr.sort((a, b) => ((lastInBase(b) || {}).date || '').localeCompare((lastInBase(a) || {}).date || '') || a.eloPlace - b.eloPlace);
      return arr;
    }

    function drawResults() {
      clear(results); clear(resultsFoot);
      const arr = filtered();
      const sk = st.surface, sl = D.surfaces[sk].label;
      if (!arr.length) {
        results.appendChild(h('div', { class: 'empty' }, h('div', { style: 'margin-bottom:10px' }, st.q.trim() ? 'В базе нет игрока «' + st.q.trim() + '» даже с учетом опечаток. Проверьте написание: можно по-русски или латиницей.' : 'Никого не нашли по этим условиям.'),
          button('Сбросить фильтры', { kind: 'secondary', size: 'sm', icon: 'x', onClick: () => { st.q = ''; st.data = 'active'; UI.rerender(); } })));
      } else if (mobile) {
        results.appendChild(h('div', { role: 'list' }, arr.map(p => {
          const d = p.elo[sk] - p.elo.all, last = lastInBase(p);
          return h('div', { class: 'players-item', role: 'listitem', on: { click: () => UI.go('player-' + p.id) } },
            h('div', { class: 'players-item-top' }, nameCell(p, { rank: true })),
            h('div', { class: 'players-item-mid' },
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Эло · ' + sl), h('span', { class: 'players-mini-v' }, elo(p.elo[sk]), h('small', null, signed(d)))),
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Эло общий'), h('span', { class: 'players-mini-v' }, elo(p.elo.all))),
              h('div', { class: 'players-mini' }, h('span', { class: 'players-mini-l' }, 'Форма, 10'), h('span', { class: 'players-mini-v players-form' }, UI.formDots(formOf(p))), h('small', { class: 'players-mini-l' }, winsOf(p) + '–' + (formOf(p).length - winsOf(p))))),
            h('div', { class: 'players-item-bot' },
              h('span', null, icon('database'), 'Матч в базе: ' + (last ? fmt.date(last.date) + ' · ' + last.event : '—')),
              h('span', null, icon('globe'), 'Новости: ' + newsText(p.id))));
        })));
      } else {
        const tbl = UI.table({
          rows: arr, onRowClick: p => UI.go('player-' + p.id),
          columns: [
            { label: 'Игрок', render: p => nameCell(p) },
            // Рейтинга ATP в базе нет: место по Эло среди игроков с матчами за 52 недели считает код
            { label: 'Место по Эло', render: p => h('div', { class: 'players-cell-2' }, h('b', { class: 'num' }, '№' + p.eloPlace), h('small', null, 'за 52 недели')) },
            { label: 'Эло общий', align: 'r', render: p => h('span', { class: 'mono' }, elo(p.elo.all)) },
            { label: 'Эло · ' + sl, align: 'r', render: p => { const d = p.elo[sk] - p.elo.all; return h('div', { class: 'players-cell-2', style: 'align-items:flex-end' }, h('span', { class: 'mono', style: 'font-weight:600' }, elo(p.elo[sk])), h('small', null, signed(d) + ' к общему')); } },
            { label: 'Форма, 10 матчей', render: p => h('span', { class: 'players-form' }, UI.formDots(formOf(p)), h('span', { class: 'small soft num' }, winsOf(p) + '–' + (formOf(p).length - winsOf(p)))) },
            { label: 'Матч в базе', render: lastCell },
            { label: 'Новости', render: p => h('div', { class: 'players-cell-2', style: 'align-items:flex-start;gap:4px' }, newsFresh(p.id) ? chip('Свежие', 'good', 'check') : chip(NEWS_AT[p.id] ? 'Старше 12 ч' : 'Не искали', 'outline', NEWS_AT[p.id] ? 'clock' : 'globe'), h('small', null, NEWS_AT[p.id] ? ago(NEWS_AT[p.id]) : 'перед анализом')) },
          ],
        });
        tbl.querySelector('table').classList.add('players-table');
        tbl.querySelectorAll('tbody tr').forEach((tr, k) => {
          tr.setAttribute('aria-label', 'Открыть карточку: ' + arr[k].name);
          tr.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === tr) UI.go('player-' + arr[k].id); });
        });
        results.appendChild(tbl);
      }
      // Список — страницами с сервера: в макете 12 демо-игроков стоят на первой странице
      const q = st.q.trim();
      const total = q || st.data === 'news' ? arr.length : st.data === 'all' ? BASE_ALL : BASE_ACTIVE;
      UI.append(resultsFoot, [
        h('span', null, (q ? 'Найдено ' + arr.length + ' по всей базе' + (fuzzyOnly ? ', с учетом опечаток' : '') : 'Показано ' + arr.length + ' из ' + fmt.int(total)) + ' · по ' + PAGE + ' на странице · место по Эло — среди игроков с матчами за 52 недели'),
        total > arr.length ? button('Показать еще ' + PAGE, { kind: 'secondary', size: 'sm', icon: 'list', onClick: () => UI.toast('В макете ' + arr.length + ' демо-игроков. В приложении следующие ' + PAGE + ' придут с сервера', 'info') }) : null]);
    }
    drawResults();
  }

  // =====================================================================
  // Карточка игрока
  // =====================================================================
  function tabsFor(p) {
    const t = [{ id: 'overview', label: 'Обзор' }, { id: 'matches', label: 'Матчи' }, { id: 'news', label: 'Новости' }];
    if (hasLegacy(p)) t.push({ id: 'profile', label: 'Профиль из бота', short: 'Профиль' });
    return t;
  }

  function renderPlayer(root, param) {
    const parts = String(param || '').split('-');
    const pid = parts[0];
    const p = D.P[pid];
    if (!p) return renderNotFound(root, pid);
    UI.setHeader({ title: p.short, crumbs: h('span', null, h('a', { href: '#players' }, 'Игроки'), ' / ', 'карточка игрока') });
    document.title = p.short + ' · Игроки · AI Capper';

    root.appendChild(heroNode(p));
    const TABS = tabsFor(p);
    let tab = TABS.some(t => t.id === parts[1]) ? parts[1] : TABS.some(t => t.id === cardTabs[p.id]) ? cardTabs[p.id] : 'overview';
    const panel = h('div', { class: 'players-tabpanel', role: 'tabpanel', id: 'players-panel' });
    const mobile = UI.isMobile();
    const tabsEl = UI.tabs({ items: TABS.map(t => ({ id: t.id, label: mobile && t.short ? t.short : t.label })), active: tab, onChange: t => {
      tab = t; cardTabs[p.id] = t; drawPanel(); revealTab(tabsEl);
      try { history.replaceState(null, '', '#player-' + p.id + (t === 'overview' ? '' : '-' + t)); } catch (e) { /* ок */ }
    } });
    tabsEl.setAttribute('aria-label', 'Разделы карточки игрока');
    if (mobile) { tabsEl.classList.add('players-tabs'); tabsEl.style.setProperty('--players-tabs', TABS.length); } // на телефоне все вкладки в одну строку
    root.append(tabsEl, panel, attribution());
    revealTab(tabsEl);

    function drawPanel() {
      clear(panel);
      ({ overview: tabOverview, matches: tabMatches, profile: tabProfile, news: tabNews }[tab])(panel, p);
    }
    drawPanel();
  }

  // Если вкладки все же не влезли (узкий экран, крупный шрифт) — держим выбранную в поле зрения
  function revealTab(el) {
    requestAnimationFrame(() => {
      const b = el.querySelector('[aria-selected="true"]');
      if (!b || el.scrollWidth <= el.clientWidth) return;
      const x = b.getBoundingClientRect().left - el.getBoundingClientRect().left + el.scrollLeft;
      el.scrollLeft = Math.max(0, x - (el.clientWidth - b.offsetWidth) / 2);
    });
  }

  function heroNode(p) {
    const t = myToday(p.id);
    const last = lastInBase(p);
    const surf = bestSurface(p);
    const W = winsOf(p);
    // Две меры свежести (Т22): последний матч в базе (архив отстает) и когда проверены новости (кэш 12 ч)
    const status = h('div', { class: 'players-hero-status' },
      h('div', { class: 'players-hero-st' }, newsChip(p.id),
        h('small', null, NEWS_AT[p.id] ? 'проверены ' + when(NEWS_AT[p.id]) + ' · ' + newsWhere(p.id) + (newsFresh(p.id) ? '' : ' · обновятся перед анализом') : 'ищутся перед анализом матча с игроком')),
      h('div', { class: 'players-hero-st' }, chip('Матч в базе: ' + (last ? fmt.date(last.date) : '—'), 'outline', 'database'),
        h('small', null, (last ? last.event + ', ' + last.round + ' · ' : '') + 'архив загружен ' + when(ARCHIVE_AT) + ' UTC')));

    const top = h('div', { class: 'players-hero-top' },
      h('div', { class: 'players-avatar', 'aria-hidden': 'true' }, initials(p.name)),
      h('div', { class: 'players-hero-id' },
        h('h2', null, p.name),
        h('div', { class: 'players-meta' }, h('span', { class: 'players-cc' }, p.country), ' ',
          [COUNTRY[p.country], age(p), (p.hand === 'левая' ? 'левша' : 'правша') + ', ' + p.backhand + ' бэкхенд'].filter(Boolean).join(' · ')),
        h('div', { class: 'row', style: 'gap:6px' }, chip('Лучшее покрытие по Эло — ' + D.surfaces[surf].label.toLowerCase(), 'outline'), hasLegacy(p) && chip('Есть профиль из старого бота', 'outline', 'history'))),
      status);

    const stats = h('div', { class: 'players-hero-stats' },
      h('div', null, h('span', { class: 'players-hs-l' }, 'Место по Эло'), h('span', { class: 'players-hs-v' }, '№' + p.eloPlace), h('span', { class: 'players-hs-s' }, 'среди игроков с матчами за 52 недели')),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Эло общий'), h('span', { class: 'players-hs-v' }, elo(p.elo.all)), h('span', { class: 'players-hs-s' }, 'без учета покрытия')),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Эло на харде'), h('span', { class: 'players-hs-v' }, elo(p.elo.hard)), h('span', { class: 'players-hs-s' }, signed(p.elo.hard - p.elo.all) + ' к общему')),
      h('div', null, h('span', { class: 'players-hs-l' }, 'Форма, 10 матчей'), h('span', { class: 'players-hs-v' }, W + '–' + (formOf(p).length - W), UI.formDots(formOf(p))), h('span', { class: 'players-hs-s' }, 'в базе · слева — последний матч')));

    // «Сегодня» — только если игрок есть в вашей открытой ставке или в сегодняшнем анализе
    let foot = null;
    if (t) {
      const oppId = t.p1 === p.id ? t.p2 : t.p1, opp = D.P[oppId], tm = timeOf(t);
      foot = h('div', { class: 'players-today' }, icon(t.bet ? 'ticket' : 'spark'),
        h('div', { class: 'players-today-text' }, h('b', null, 'Сегодня' + (tm ? ', ' + tm : '') + ' · '), 'соперник — ',
          opp ? [h('a', { href: '#player-' + opp.id }, opp.name), ' (№' + opp.eloPlace + ' по Эло)'] : oppId, ' · ',
          t.bet ? ['в вашей ставке №' + t.bet.id + ': ' + D.match(t.leg) + ' · ', h('span', { class: 'muted' }, t.leg.marketLabel + ' '), h('span', { class: 'odds' }, fmt.odds(t.leg.odds))]
            : 'в вашем анализе #' + t.analysis.id + ' от ' + t.analysis.at.slice(11, 16)),
        t.bet ? button('Внести результат', { kind: 'ghost', size: 'sm', icon: 'ticket', href: '#bets-' + t.bet.id })
          : button('Открыть анализ', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: analysisHref(t.analysis) }));
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
    const t = myToday(p.id);
    let eloNote = null;
    const opp = t && D.P[t.p1 === p.id ? t.p2 : t.p1];
    if (opp) {
      const pe = eloProb(p.elo.hard, opp.elo.hard);
      const H = h2h(p, opp);
      // по кэфу ставки — только если это ставка на победу этого игрока; маржу по одной стороне не снять
      const own = t.bet && ((t.leg.market === 'p1' && t.leg.p1 === p.id) || (t.leg.market === 'p2' && t.leg.p2 === p.id));
      eloNote = UI.callout('info', 'target', h('div', { class: 'stack', style: 'gap:4px' },
        h('b', null, 'Сегодня: ' + p.short + ' — ' + opp.short),
        h('div', null, 'Эло на харде: ' + elo(p.elo.hard) + ' против ' + elo(opp.elo.hard) + ' → ' + fmt.prob(pe) + ' на победу' + (own ? ' · ваш кэф ' + fmt.odds(t.leg.odds) + ' → ' + fmt.prob(1 / t.leg.odds) + ' с маржой букмекера' : '')),
        h('div', null, 'Личные встречи: ' + H.w + '–' + H.l + ', на харде ' + H.hw + '–' + H.hl + ' · последняя — ' + H.last + ', ' + (H.lastWon ? 'победа' : 'поражение')),
        h('div', { class: 'xsmall', style: 'opacity:.85' }, 'Это входные точки модели, а не прогноз. Итог — в ', t.analysis ? h('a', { href: analysisHref(t.analysis) }, 'анализе #' + t.analysis.id) : 'анализе, по которому сделана ставка', '.')));
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
      class: 'col-5', title: 'Форма', subtitle: 'по матчам в базе, результаты по ' + fmt.date(ARCHIVE_TO),
      body: [
        h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'players-formbig', role: 'img', 'aria-label': 'Последние 10 матчей в базе, начиная с последнего: ' + formOf(p).map(x => x === 'W' ? 'победа' : 'поражение').join(', ') },
            formOf(p).map(x => h('span', { class: x === 'W' ? 'w' : 'l', 'aria-hidden': 'true' }, x === 'W' ? 'В' : 'П'))),
          h('div', { class: 'players-hint' }, 'В — победа, П — поражение; слева последний матч (обведен). ' + winsOf(p) + ' ' + fmt.plural(winsOf(p), 'победа', 'победы', 'побед') + ' из ' + formOf(p).length + '.')),
        kvWide([
          ['Последний матч в базе', S.last ? fmt.date(S.last.date) + ' · ' + S.last.event + ', ' + S.last.round : '—'],
          ['Матчей в базе за 14 дней', String(S.m14)],
          t && S.rest != null ? ['Дней без матчей в базе', String(S.rest)] : null,
          ['Новости проверены', NEWS_AT[p.id] ? when(NEWS_AT[p.id]) + (newsFresh(p.id) ? '' : ' · старше 12 ч') : 'не искали'],
        ].filter(Boolean)),
        h('p', { class: 'players-hint' }, 'Травмы, снятия и мотивацию отдельными полями не храним: о них пишут новости.'),
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
      class: 'col-7', title: 'Подача и прием', subtitle: 'по данным архива до мая 2026: 52 недели до ' + fmt.dateFull(SACKMANN_TO) + ' · против среднего по туру (топ-50)',
      actions: [h('div', { class: 'chart-legend' }, h('span', null, h('i', { class: 'box', style: { background: 'var(--s1)' } }), p.short), h('span', null, h('i', { class: 'players-tick-key' }), 'Средний по туру'))],
      body: [
        h('div', { class: 'players-metrics' },
          h('div', { class: 'players-metrics-col' }, h('div', { class: 'eyebrow' }, 'Подача'),
            metric('Попадание первой', sv.first, TOUR.first, 100, '%'),
            metric('Очки на первой', sv.firstWon, TOUR.firstWon, 100, '%'),
            metric('Очки на второй', sv.secondWon, TOUR.secondWon, 100, '%'),
            metric('Эйсов за матч', sv.aces, TOUR.aces, 15, '', false, 1),
            metric('Двойных за матч', sv.df, TOUR.df, 6, '', true, 1)),
          h('div', { class: 'players-metrics-col' }, h('div', { class: 'eyebrow' }, 'Прием и брейкпоинты'),
            metric('Очки на приеме первой', rt.firstRet, TOUR.firstRet, 100, '%'),
            metric('Очки на приеме второй', rt.secondRet, TOUR.secondRet, 100, '%'),
            metric('Реализация брейкпоинтов', rt.bpConv, TOUR.bpConv, 100, '%'),
            metric('Спасенные брейкпоинты', bpSaved, TOUR.bpSaved, 100, '%'))),
        h('p', { class: 'players-hint' }, 'Полоса — показатель игрока, вертикальная черта — средний по туру. Статистика подачи есть только в архиве Сакманна, его копия заканчивается Roland Garros 2026: у матчей позже — только счет из tennis-data.'),
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
          kvWide([['Против топ-10 по Эло', rec(V.top10[0], V.top10[1])], ['Решающие сеты', rec(V.decider[0], V.decider[1])], ['Тай-брейки', rec(+tbM[1], +tbM[2])]])),
      ],
    });

    panel.appendChild(h('div', { class: 'grid' }, eloCard, formCard, serveCard, wlCard));
  }

  // ---------- вкладка «Матчи» ----------
  function tabMatches(panel, p) {
    const I = info(p);
    const ms = I.matches;
    const played = ms.filter(m => !m.wo);
    const tb = played.reduce((a, m) => { (m.score.match(/\d:\d/g) || []).forEach(s => { if (s === '7:6') a[0]++; if (s === '6:7') a[1]++; }); return a; }, [0, 0]);
    // решающий сет: в матче до 2 побед — третий, до 3 побед — пятый
    const dec = played.filter(m => m.score.split(' ').length === (m.bo5 ? 5 : 3));
    const decW = dec.filter(m => m.res === 'W').length;
    const W = played.filter(m => m.res === 'W').length;
    const resChip = m => m.wo ? chip('Без игры', 'outline', 'refresh') : m.res === 'W' ? chip('Победа', 'good', 'check') : chip('Поражение', 'bad', 'x');
    const oppNode = m => m.wo ? h('span', null, m.opp.name + ' снялся') : h('span', null, m.opp.id ? h('a', { class: 'players-link', href: '#player-' + m.opp.id }, m.opp.name) : m.opp.name, m.opp.rank ? [' ', h('span', { class: 'muted xsmall', title: 'Место по Эло среди игроков с матчами за 52 недели' }, '№' + m.opp.rank + ' по Эло')] : null);
    const strip = h('div', { class: 'players-strip' },
      h('div', null, h('span', null, 'Победы'), h('b', null, W + ' из ' + played.length)),
      h('div', null, h('span', null, 'Тай-брейки'), h('b', null, tb[0] + '–' + tb[1])),
      h('div', null, h('span', null, 'Решающие сеты'), h('b', null, decW + '–' + (dec.length - decW))),
      h('div', null, h('span', null, 'Матчи до 3 побед'), h('b', null, String(played.filter(m => m.bo5).length))));
    let list;
    if (UI.isMobile()) {
      list = h('div', { role: 'list' }, ms.map(m => h('div', { class: ['players-mrow', m.wo && 'players-wo'], role: 'listitem' },
        h('div', { class: 'players-mrow-line' }, h('span', { class: 'small' }, h('b', null, m.event), ' · ' + m.round), h('span', { class: 'xsmall muted', style: 'white-space:nowrap' }, fmt.date(m.date))),
        h('div', { class: 'players-mrow-line' }, h('span', null, m.wo ? '' : 'соперник: ', oppNode(m)), resChip(m)),
        !m.wo && h('div', { class: 'players-mrow-line' }, h('span', { class: 'mono small' }, m.score), h('span', { class: 'xsmall muted' }, D.surfaces[m.surface].label)))));
    } else {
      list = UI.table({ rows: ms, columns: [
        { label: 'Дата', render: m => h('span', { style: 'white-space:nowrap' }, fmt.date(m.date)) },
        { label: 'Турнир', render: m => h('div', { class: 'players-cell-2' }, h('span', { style: 'font-weight:500' }, m.event), h('small', null, m.cat)) },
        { label: 'Покрытие', render: m => UI.surfaceChip(m.surface) },
        { label: 'Раунд', render: m => m.round },
        { label: 'Соперник', render: m => oppNode(m) },
        { label: 'Счет', render: m => m.wo ? h('span', { class: 'muted' }, 'W/O') : h('span', { class: 'mono', style: 'white-space:nowrap' }, m.score) },
        { label: 'Итог', render: resChip },
      ] });
      list.querySelectorAll('tbody tr').forEach((tr, k) => { if (ms[k].wo) tr.classList.add('players-wo'); });
    }
    panel.appendChild(card({
      title: 'Последние матчи в базе', subtitle: 'Архив ATP · сверху последний · результаты по ' + fmt.date(ARCHIVE_TO) + (ms.some(m => m.wo) ? ' · неявка соперника в счет не идет' : ''),
      actions: [chip('Архив загружен ' + when(ARCHIVE_AT) + ' UTC', ARCHIVE_STALE ? 'warn' : 'outline', 'database')],
      body: [strip, h('div', { class: 'players-flush' }, list)],
      foot: [h('span', { class: 'small muted', style: 'flex:1;min-width:0' }, 'Всего в базе ' + Object.values(p.wlSurface).reduce((a, x) => a + x[0] + x[1], 0) + ' матчей за 2 сезона; список приходит страницами. Подача и прием по матчам — только до мая 2026 (архив Сакманна).'),
        button('Показать еще', { kind: 'secondary', size: 'sm', icon: 'list', onClick: () => UI.toast('В макете показаны последние матчи; в приложении следующие придут с сервера', 'info') })],
    }));
  }

  // ---------- вкладка «Новости» ----------
  function tabNews(panel, p) {
    const I = info(p);
    const at = NEWS_AT[p.id];
    const kindChip = k => { const x = NEWS_KIND[k] || NEWS_KIND.other; return chip(x[0], x[1], x[2]); };
    let body;
    if (!at) body = h('div', { class: 'players-news-empty' }, icon('globe'), h('b', null, 'Новости по ' + p.short + ' еще не искали'), h('span', null, 'Их ищет шаг «Новости» анализа матча с этим игроком. Отдельной кнопки поиска нет.'));
    else if (!I.news.length) body = h('div', { class: 'players-news-empty' }, icon('check'), h('b', null, 'За 14 дней новостей нет'), h('span', null, 'Поиск ' + when(at) + ' ничего не нашел на сайтах из списка.'));
    else body = h('div', { class: 'players-flush' }, I.news.map(n => h('article', { class: 'players-news-item' },
      h('div', { class: 'players-news-when' }, h('b', null, fmt.date(n.date)), kindChip(n.kind)),
      h('div', { class: 'players-news-body' }, h('p', null, n.text),
        h('span', { class: 'players-news-src', title: 'Ссылка на статью хранится вместе с новостью. В макете переход на внешний сайт отключен' }, icon('link'), n.src)))));
    panel.appendChild(card({
      title: 'Новости', subtitle: at ? 'Проверены ' + when(at) + (NEWS_BY[p.id] ? ' при анализе #' + NEWS_BY[p.id].id : ' · из общей базы новостей') + ' · Sonnet 5.5, веб-поиск · за 14 дней' : 'Ищутся перед анализом матча с игроком',
      actions: at ? [newsFresh(p.id) ? chip('Свежие · до ' + addMin(at, NEWS_TTL_H * 60).slice(11, 16), 'good', 'check') : chip('Старше 12 ч', 'outline', 'clock')] : null,
      body,
    }));
    panel.appendChild(UI.callout('', 'info', h('b', null, 'Как ищем новости. '), 'Перед анализом матча Claude (Sonnet 5.5) делает 2 поиска — по одному на игрока — и записывает факты со ссылкой: травмы, снятия, результаты, мотивацию. Ищем только на ' + NEWS_SITES + '. Если новостям по игроку меньше 12 часов, поиск не повторяем. Как новость влияет на вероятность, решает оценка Claude в анализе — в пределах ±10 п.п. к модели.'));
  }

  // ---------- вкладка «Профиль из бота» ----------
  function tabProfile(panel, p) {
    const I = info(p), R = I.ratings, ex = LEGACY[p.id] || {};
    const metaLine = () => h('div', { class: 'players-meta-line' }, icon('history'), h('span', null, 'Из старого бота · перенесено ' + fmt.dateFull(LEGACY_AT) + ' · источник не указан'));
    const avg = arr => arr.reduce((a, x) => a + x[1], 0) / arr.length;
    const rates = arr => h('div', { class: 'stack', style: 'gap:4px' }, arr.map(([k, v]) => h('div', { class: 'players-rate' },
      h('span', { class: 'players-rate-l', title: k }, k), UI.meter(v, 10, v <= 5 ? 'warn' : null), h('span', { class: 'players-rate-v' }, v))));

    const note = UI.callout('warn', 'history', h('b', null, 'Профиль перенесен из старого бота ' + fmt.dateFull(LEGACY_AT) + '. '),
      'Его заполняла модель бота сама, часто по памяти и без ссылок на источники, поэтому оценки могут не совпадать с реальностью. Программа новых профилей не собирает, этот не обновляет и в анализ не передает: вероятность считается по Эло, матчам и новостям. Шкала 1–10, как в шаблонах бота.');

    const profileCard = card({ class: 'col-4 players-fill', title: 'Игровой профиль', body: [UI.kv([
      ['Стиль игры', ex.kind || '—'], ['Позиция на корте', ex.pos || '—'], ['Тип подачи', ex.serveType || '—'],
      ['Рабочая рука', p.hand === 'левая' ? 'Левша' : 'Правша'], ['Бэкхенд', p.backhand[0].toUpperCase() + p.backhand.slice(1)],
    ]), metaLine()] });
    const physCard = card({ class: 'col-4 players-fill', title: 'Физика', subtitle: 'средняя ' + fmt.dec(avg(R.phys), 1) + ' из 10', body: [rates(R.phys), metaLine()] });
    const techCard = card({ class: 'col-4 players-fill', title: 'Техника', subtitle: 'средняя ' + fmt.dec(avg(R.tech), 1) + ' из 10', body: [rates(R.tech), metaLine()] });

    const P = I.psych;
    const typeKind = P.type === 'Стабильный' ? 'good' : P.type === 'Нестабильный' ? 'warn' : 'outline';
    const psychCard = card({
      class: 'col-8 players-fill', title: 'Психология', subtitle: 'как бот описал поведение в решающие моменты',
      actions: [chip(P.type, typeKind, P.type === 'Стабильный' ? 'shield' : 'alert')],
      body: [
        h('div', { class: 'players-patterns' }, P.patterns.map(x => h('div', { class: 'players-pattern' }, h('h4', null, x.k), h('span', { class: 'mono' }, x.stat), h('p', null, x.text)))),
        h('div', { class: 'eyebrow', style: 'margin-top:4px' }, 'Оценки 1–10'),
        h('div', { class: 'players-patterns', style: 'gap:6px 28px' }, P.ratings.map(([k, v]) => h('div', { class: 'players-rate stacked' }, h('span', { class: 'players-rate-l' }, k), h('span', { class: 'players-rate-v' }, v + ' из 10'), UI.meter(v, 10, v <= 5 ? 'warn' : null)))),
        metaLine(),
      ],
    });
    const swCard = card({ class: 'col-4', title: 'Сильные и слабые стороны', body: [
      h('div', { class: 'eyebrow' }, 'Сильные'),
      h('ul', { class: 'players-bullets' }, R.strong.map(s => h('li', null, h('span', { class: 'good-text', style: 'display:flex' }, icon('check')), s))),
      h('div', { class: 'eyebrow' }, 'Слабые'),
      h('ul', { class: 'players-bullets' }, R.weak.map(s => h('li', null, h('span', { class: 'bad-text', style: 'display:flex' }, icon('alert')), s))),
      metaLine(),
    ] });
    panel.append(note, h('div', { class: 'grid' }, profileCard, physCard, techCard, psychCard, swCard));
  }

  // ---------- игрок не найден ----------
  function renderNotFound(root, pid) {
    try { pid = decodeURIComponent(pid || ''); } catch (e) { /* адрес с битой кодировкой — показываем как есть */ }
    UI.setHeader({ title: 'Игрок не найден', crumbs: h('span', null, h('a', { href: '#players' }, 'Игроки'), ' / ', 'карточка игрока') });
    root.appendChild(h('section', { class: 'card' }, h('div', { class: 'card-body players-notfound' },
      h('span', { class: 'players-notfound-ic' }, icon('users')),
      h('h3', null, 'Такого игрока нет в базе'),
      h('p', { class: 'soft', style: 'max-width:52ch' }, pid ? ['По адресу «', h('span', { class: 'mono' }, pid), '» никого не нашли. Игроки приходят из архивов ATP: если игрока нет и там, анализ матча с ним не запустим.'] : 'В адресе не указан игрок.'),
      h('div', { class: 'row', style: 'justify-content:center' },
        button('К списку игроков', { kind: 'primary', icon: 'chevronLeft', href: '#players' })))));
  }

  // ---------- регистрация ----------
  UI.register('players', { title: 'Игроки', nav: 'players', render(root) { renderList(root); } });
  UI.register('player', { title: 'Игрок', nav: 'players', crumbs: 'Игроки', render(root, param) { renderPlayer(root, param); } });
})();
