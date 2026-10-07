/* Анализ #A-0142: ход анализа по шагам (в макете ускорен до ~5 с), затем результат —
   карточки матчей (сравнение игроков, вероятности по рынкам, факторы), экспресс с суммой по стратегии,
   «Почему так» и строка расходов. Состояние живёт в памяти модуля: смена темы или ширины экрана
   продолжает анимацию с того же места, а повторный запуск идёт только при переходе из «Нового анализа». */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, TODAY = D.today;
  const STRAT = D.strategy;
  const STRAT_V = (D.strategyVersions.find(v => v.status === 'active') || { id: 'v3' }).id;

  // ---------- режимы — те же, что на экране «Новый анализ» ----------
  // Цены за 1 млн токенов (docs/TOKEN_ECONOMY.md): запись в кэш ×1,25 цены входа, чтение — $0,20 у Opus и Sonnet, $0,10 у Haiku.
  const MODES = {
    precise: { id: 'precise', label: 'Точный', model: 'Opus 5.5', perEvent: 0.09, news: true, sec: 47, price: { write: 5, read: 0.20, out: 20 } },
    balanced: { id: 'balanced', label: 'Сбалансированный', model: 'Sonnet 5.5', perEvent: 0.045, news: false, sec: 31, price: { write: 2.5, read: 0.20, out: 10 } },
    eco: { id: 'eco', label: 'Экономный', model: 'Haiku 4.5', perEvent: 0.02, news: false, sec: 16, price: { write: 1.25, read: 0.10, out: 5 } },
  };
  MODES.economy = MODES.eco;
  const COLLECT_COST = 0.05; // сбор досье нового игрока — как в оценке на экране «Новый анализ»

  // ---------- шаги анализа ----------
  // sec/tokens/cost — значения запуска (пример); dur — длительность шага в ускоренной анимации, мс.
  // Раскладка по docs/TOKEN_ECONOMY.md (4.6, 4.8, раздел 5): статистику считает код по архиву ATP в базе,
  // веб-поиск — только новости и только на Sonnet 5.5 (effort low), модель анализа работает без поиска.
  // Досье Руне: вход 9 000 × $2 + выход 800 × $10 + 3 поиска = $0,056.
  // Анализ: 12 500 токенов префикса пишутся в кэш, 18 000 читаются из кэша, 3 400 — выход (на Opus 5.5 это $0,134).
  const AI = { input: 30500, cached: 18000, output: 3400 };
  const CACHE_SHARE = Math.round(AI.cached / AI.input * 100);

  // ---------- матчи и оценки (пример данных) ----------
  const MX = [
    {
      id: 'm1', a: 'sinner', b: 'rune', pick: 'h1m', conf: 'mid',
      probs: { p1: [0.84, 0.87], h1m: [0.62, 0.66] }, // [ML-модель, Claude]
      // цифры совпадают с карточками игроков (#player-sinner, #player-rune)
      cmp: [
        { label: 'Эло на харде', l: fmt.int(D.P.sinner.elo.hard), r: fmt.int(D.P.rune.elo.hard), better: 'l' },
        { label: 'Форма, 10 матчей', form: true, better: 'l' },
        { label: 'Матчей за 14 дней', l: '3', ls: 'Пекин — 1 (снялся), Шанхай — 2', r: '4', rs: 'Токио — 2, Шанхай — 2', rsWarn: true, better: 'l' },
        { label: 'Очки на 1-й подаче', l: D.P.sinner.serve.firstWon + '%', r: D.P.rune.serve.firstWon + '%', better: 'l' },
        { label: 'Выиграно на приёме', l: '42%', r: '38%', better: 'l' },
        { label: 'Тай-брейки, 52 недели', l: '21–9', ls: '70%', r: '10–12', rs: '45%', better: 'l' },
        { label: 'Личные встречи', l: '3', ls: 'на харде 2–0', r: '1', better: 'l' },
      ],
      pro: [
        { t: 'Синнер свежее: за 14 дней 3 матча — после 1-го круга Пекина он снялся, чтобы восстановиться к Шанхаю. У Руне 4 матча, последний (5 окт) — три сета с Тиафо', src: 'база матчей (архив ATP) · ubitennis.com, 1 окт' },
        { t: 'За 2 сезона у Синнера 48 побед на харде, 34 из них — 2:0 (71%)', src: 'база матчей (архив ATP)' },
        { t: 'Тай-брейки за 52 недели: у Синнера 70%, у Руне 45% — сет, дошедший до тай-брейка, скорее за Синнером', src: 'база матчей (архив ATP)' },
      ],
      con: [
        { t: 'Руне взял сет в 3 из 4 личных встреч с Синнером', src: 'база матчей (архив ATP), H2H' },
        { t: 'Корты в Шанхае быстрее прошлогодних, эйсов на 18% больше: тай-брейков будет больше, а один отданный сет ломает 2:0', src: 'tennis.com, 5 окт' },
        { t: 'Руне выиграл оба тай-брейка у Мунара в 1/32 (4 окт) — на своей подаче он держится', src: 'база матчей (архив ATP)' },
      ],
    },
    {
      id: 'm2', a: 'djokovic', b: 'rublev', pick: 'p1', conf: 'high',
      confNote: 'Все данные свежие, источники согласуются',
      fresh: 'Джокович — сегодня 02:30 · Рублёв — 6 окт 21:50',
      probs: { p1: [0.78, 0.79], h1m: [0.50, 0.54] },
      // цифры совпадают с карточками игроков (#player-djokovic, #player-rublev)
      cmp: [
        { label: 'Эло на харде', l: fmt.int(D.P.djokovic.elo.hard), r: fmt.int(D.P.rublev.elo.hard), better: 'l' },
        { label: 'Форма, 10 матчей', form: true, better: 'l' },
        { label: 'Матчей за 14 дней', l: '2', ls: 'Шанхай — 2', r: '3', rs: 'Токио — 1, Шанхай — 2', better: 'l' },
        { label: 'Очки на 1-й подаче', l: D.P.djokovic.serve.firstWon + '%', r: D.P.rublev.serve.firstWon + '%', better: 'l' },
        { label: 'Выиграно на приёме', l: '43%', r: '37%', better: 'l' },
        { label: 'Тай-брейки, 52 недели', l: '13–8', ls: '62%', r: '10–13', rs: '43%', better: 'l' },
        { label: 'Личные встречи', l: '4', ls: 'на харде 2–1', r: '1', better: 'l' },
      ],
      pro: [
        { t: 'Личные встречи 4–1, на харде 2–1', src: 'база матчей (архив ATP)' },
        { t: 'Лучший приём в туре: 43% выигранных очков на приёме против 37% у Рублёва', src: 'база матчей (архив ATP)' },
        { t: 'Против топ-10 за 52 недели у Рублёва 4–11 (27%), у Джоковича 7–7', src: 'база матчей (архив ATP)' },
      ],
      con: [
        { t: 'Джоковичу 39; в 1/32 (4 окт) он провёл на корте 2 ч 38 мин в трёх сетах, а на следующий день сыграл ещё матч', src: 'база матчей (архив ATP), 4–5 окт' },
        { t: 'Рублёв выиграл оба матча в Шанхае без потери сета: у Бублика (№18) — два тай-брейка, у Корды (№31) — 6:2 6:4', src: 'база матчей (архив ATP), 4–5 окт' },
      ],
    },
  ];
  // рейтинг — из базы, чтобы совпадал с карточками игроков
  MX.forEach(m => m.cmp.unshift({ label: 'Рейтинг ATP', l: '№' + D.P[m.a].rank, r: '№' + D.P[m.b].rank, better: D.P[m.a].rank < D.P[m.b].rank ? 'l' : 'r' }));
  MX.forEach(m => { m.info = D.matchesToday.find(x => x.id === m.id); m.A = D.P[m.a]; m.B = D.P[m.b]; });

  const MK = {
    p1: { label: 'П1', desc: m => m.A.short + ' выигрывает матч', who: 'A' },
    h1m: { label: 'Ф1(−1.5)', desc: m => m.A.short + ' выигрывает 2:0', who: 'A' },
    h2p: { label: 'Ф2(+1.5)', desc: m => m.B.short + ' берёт хотя бы сет', who: 'B' },
    p2: { label: 'П2', desc: m => m.B.short + ' выигрывает матч', who: 'B' },
  };
  const PAIR = { p1: 'p2', p2: 'p1', h1m: 'h2p', h2p: 'h1m' };
  function noVig(odds, k) { const a = 1 / odds[k], b = 1 / odds[PAIR[k]]; return a / (a + b); }
  function marketRows(m) {
    return ['p1', 'h1m', 'h2p', 'p2'].map(k => {
      const base = k === 'p1' || k === 'p2' ? m.probs.p1 : m.probs.h1m;
      const inv = k === 'p2' || k === 'h2p';
      const model = inv ? 1 - base[0] : base[0], claude = inv ? 1 - base[1] : base[1];
      const odds = m.odds[k];
      const player = MK[k].who === 'A' ? m.A : m.B;
      return { k, m, name: player.short + ' ' + MK[k].label, desc: MK[k].desc(m), model, claude, market: noVig(m.odds, k), odds, value: claude * odds - 1, pick: m.pick === k, edited: m.odds[k] !== m.info.odds[k] };
    });
  }
  // почему исход не в экспрессе — считается от кэфов, которые реально пришли (в том числе исправленных вами)
  function outOfRules(r) {
    const out = [];
    if (r.odds > STRAT.oddsMax) out.push('кэф выше ' + fmt.odds(STRAT.oddsMax));
    if (r.odds < STRAT.oddsMin) out.push('кэф ниже ' + fmt.odds(STRAT.oddsMin));
    if (r.claude * 100 < STRAT.minProb) out.push('p ниже ' + STRAT.minProb + '%');
    return out;
  }
  function noteFor(r) {
    if (r.pick) return null;
    const pick = r.m.pickRow, out = outOfRules(r);
    if (r.value < 0) return 'Отрицательный валуй';
    if (out.length) return 'Вне правил стратегии: ' + out.join(', ');
    if (r.value > pick.value) return 'С этим кэфом перевес выше, чем у ' + pick.name + ' — в приложении ИИ пересмотрел бы выбор';
    if (r.value < 0.05) return 'Перевес меньше 5% — ' + pick.name + ' выгоднее';
    return 'Проходит правила, но ' + pick.name + ' выгоднее';
  }

  // ---------- запрос с экрана «Новый анализ» и всё, что от него зависит ----------
  // DATA.pendingAnalysis: события, режим, модель, кэфы, банк, букмекер, оценка цены. Без него (прямая ссылка) — пример как есть.
  let REQ, MODE, BK, BANK, FOREIGN, ODDS_EDITED, RUNE_NEW, EST, ID;
  let STEPS, TOTAL_MS, TOTAL, NO_AI, MODELS;
  let LEGS, TOTAL_ODDS, P_EXP, EV, BASE_PCT, BAND, REC_STAKE, CAL, P_CAL;
  let reqCount = 0;
  const nm = x => (D.P[x] ? D.P[x].short : String(x || '—'));
  const round10 = n => Math.round(n / 10) * 10;
  const calibBin = p => D.calibration.find(b => p >= b.lo && p < b.hi);

  // кэфы этого матча из запроса; если игроки введены в обратном порядке — разворачиваем рынки
  function userOdds(req, m) {
    if (!req || !Array.isArray(req.events)) return null;
    for (const e of req.events) {
      const o = e.odds || {};
      if (e.p1 === m.a && e.p2 === m.b) return { p1: o.p1, p2: o.p2, h1m: o.h1m, h2p: o.h2p };
      if (e.p1 === m.b && e.p2 === m.a) return { p1: o.p2, p2: o.p1, h1m: o.h2m, h2p: o.h1p };
    }
    return null;
  }

  function buildSteps() {
    const price = MODE.price;
    const aCost = ((AI.input - AI.cached) * price.write + AI.cached * price.read + AI.output * price.out) / 1e6;
    const rune = D.P.rune;
    const runeAt = !RUNE_NEW && rune.updated ? (rune.updated.slice(0, 10) === TODAY ? 'сегодня в ' + rune.updated.slice(11, 16) : fmt.datetime(rune.updated)) : '';
    const m1 = MX[0], m2 = MX[1];
    const adj = (m, k, lbl) => { const r = m.rows.find(x => x.k === k); return m.A.short + ' ' + lbl + ': ' + pr(r.model) + ' → ' + pr(r.claude); };
    return [
      { title: 'Разбор событий', model: 'Haiku 4.5', sec: 3, tokens: 2400, cost: 0.004, dur: 450,
        detail: '2 матча, 8 рынков, кэфы ' + BK + (ODDS_EDITED ? ' с вашими правками' : ' на 09:39'),
        live: ['Синнер — Руне: П1/П2 и фора ±1.5', 'Джокович — Рублёв: П1/П2 и фора ±1.5'] },
      RUNE_NEW
        ? { title: 'Проверка базы игроков', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Синнер, Джокович, Рублёв — досье свежие · Руне — есть только архив ATP, досье нет',
          live: ['Синнер, Джокович, Рублёв — досье свежие', 'Руне — только архив ATP, нужно досье'] }
        : { title: 'Проверка базы игроков', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Досье всех четырёх игроков свежие · Руне собран ' + runeAt,
          live: ['Синнер, Джокович, Рублёв — досье свежие', 'Руне — досье собрано ' + runeAt] },
      RUNE_NEW
        ? { title: 'Досье Руне: архив ATP и новости', model: 'Sonnet 5.5 + поиск', sec: 34, tokens: 9800, cost: 0.056, searches: 3, dur: 1100,
          detail: 'Матчи, подача, приём и тай-брейки за 52 недели — из архива ATP в базе, считает код · новости — 3 запроса (atptour.com, tennis.com), effort low',
          live: ['Архив ATP в базе: 64 матча за 2 сезона, статистика без ИИ', 'atptour.com — 5 окт: 1/16 финала, 4:6 6:3 6:4 с Тиафо', 'Слух о плече из соцсетей без подтверждения — по L-019 не учитываем'] }
        : { title: 'Досье Руне — из базы', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Собрано ' + runeAt + ' — повторный сбор и поиск не нужны',
          live: ['Досье Руне из базы', 'Слух о плече без подтверждения — по L-019 не учитываем'] },
      MODE.news
        ? { title: 'Новости Синнера, Джоковича, Рублёва', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Из кэша: обновлены ночью, моложе 12 ч — повторный поиск не нужен · матчи 1/16 финала (5 окт) уже в базе',
          live: ['Синнер — 04:10, Джокович — 02:30, Рублёв — 21:50', 'Новых травм и снятий нет'] }
        : { title: 'Новости: в этом режиме не ищем', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Режим «' + MODE.label + '» свежие новости не ищет — берём то, что уже есть в досье (Синнер — 04:10, Джокович — 02:30, Рублёв — 6 окт 21:50)',
          live: ['Новости из сохранённых досье', 'Свежий поиск пропущен — так дешевле, но можно пропустить снятие'] },
      { title: 'Расчёт ML-модели: Эло по покрытию, подача/приём, нагрузка', model: null, sec: 2, tokens: 0, cost: 0, dur: 350,
        detail: 'Вероятности по 8 рынкам · формула, без ИИ',
        live: ['Эло на харде и форма за 10 матчей', 'Подача/приём, нагрузка за 14 дней'] },
      { title: 'Анализ Claude: корректировка вероятностей', model: MODE.model, sec: MODE.sec, tokens: AI.input + AI.output, cost: aCost, dur: 1500,
        detail: adj(m1, 'h1m', '2:0') + ', ' + adj(m2, 'p1', 'П1') + ' · 3 вызова без веб-поиска, вызовы 2–3 берут ' + CACHE_SHARE + '% входа из кэша',
        live: ['Читает досье 4 игроков и 5 уроков', MODE.news ? 'Сверяет новости с уроками L-014 и L-019' : 'Сверяет сохранённые досье с уроками L-014 и L-019', 'Поправки: ' + m1.A.short + ' 2:0 ' + ppDelta(m1.pickRow.claude - m1.pickRow.model) + ', ' + m2.A.short + ' П1 ' + ppDelta(m2.pickRow.claude - m2.pickRow.model)] },
      { title: 'Подбор экспресса по стратегии', model: null, sec: 3, tokens: 0, cost: 0, dur: 600,
        detail: 'Стратегия ' + STRAT_V + ' · отобраны 2 события из 8 рынков · сумма по таблице банка',
        live: ['Фильтр: p ≥ ' + STRAT.minProb + '%, кэф ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax), 'Итоговый кэф и сумма от банка'] },
    ];
  }

  function setup(req) {
    REQ = req || null;
    if (REQ) reqCount++;
    ID = 'A-' + String(142 + Math.max(0, reqCount - 1)).padStart(4, '0');
    D.currentAnalysis = ID;
    MODE = MODES[REQ && REQ.mode] || MODES.precise;
    BK = (REQ && REQ.bookmaker) || 'Fonbet';
    BANK = REQ && REQ.bank > 0 ? REQ.bank : D.stats.bank;
    RUNE_NEW = D.P.rune.fresh === 'missing';
    const evs = REQ && Array.isArray(REQ.events) ? REQ.events : [];
    // кэфы и рынки
    MX.forEach(m => {
      const u = userOdds(REQ, m) || {};
      const base = m.info.odds;
      m.entered = !!userOdds(REQ, m);
      m.odds = {};
      ['p1', 'p2', 'h1m', 'h2p'].forEach(k => { m.odds[k] = u[k] > 1 ? u[k] : base[k]; });
      m.rows = marketRows(m);
      m.pickRow = m.rows.find(r => r.pick);
      m.rows.forEach(r => { r.note = noteFor(r); });
    });
    MX[0].confNote = (RUNE_NEW ? 'Досье Руне собрано только в этом анализе' : 'Досье Руне собрано сегодня') + '; слух о плече не подтверждён';
    MX[0].fresh = 'Синнер — сегодня 04:10 · Руне — ' + (RUNE_NEW ? 'собран в этом анализе' : 'собран ' + (D.P.rune.updated && D.P.rune.updated.slice(0, 10) === TODAY ? 'сегодня ' + D.P.rune.updated.slice(11, 16) : 'ранее'));
    FOREIGN = !!REQ && !(evs.length === MX.length && MX.every(m => m.entered));
    ODDS_EDITED = MX.some(m => m.entered && m.rows.some(r => r.edited));
    // шаги и итоги запуска
    STEPS = buildSteps();
    TOTAL_MS = STEPS.reduce((a, s) => a + s.dur, 0);
    TOTAL = { sec: STEPS.reduce((a, s) => a + s.sec, 0), tokens: STEPS.reduce((a, s) => a + s.tokens, 0), cost: STEPS.reduce((a, s) => a + s.cost, 0), searches: STEPS.reduce((a, s) => a + (s.searches || 0), 0) };
    NO_AI = STEPS.filter(s => !s.model).length;
    MODELS = ['Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5'].filter(x => STEPS.some(s => s.model && s.model.startsWith(x)));
    // оценка цены, которую вы видели перед запуском: для своих событий — из запроса; для чужих событий сравнивать не с чем
    EST = REQ && !FOREIGN && REQ.estimate && REQ.estimate.cost > 0 ? REQ.estimate.cost : null;
    // экспресс и сумма — по кэфам, которые реально пришли
    LEGS = MX.map(m => ({ p1: m.a, p2: m.b, market: m.pick, marketLabel: MK[m.pick].label, odds: m.pickRow.odds, p: m.pickRow.claude, surface: 'hard', tournament: 'Шанхай' }));
    TOTAL_ODDS = Math.round(LEGS.reduce((a, l) => a * l.odds, 1) * 100) / 100;
    P_EXP = LEGS.reduce((a, l) => a * l.p, 1);
    EV = P_EXP * TOTAL_ODDS - 1;
    BASE_PCT = TOTAL_ODDS <= 1.70 ? 2.75 : TOTAL_ODDS <= 2.20 ? 2.25 : TOTAL_ODDS <= STRAT.totalMax ? 1.75 : 0;
    BAND = TOTAL_ODDS <= 1.70 ? STRAT.stakeTable[0] : TOTAL_ODDS <= 2.20 ? STRAT.stakeTable[1] : TOTAL_ODDS <= STRAT.totalMax ? STRAT.stakeTable[2] : null;
    REC_STAKE = round10(BANK * BASE_PCT / 100);
    CAL = LEGS.map(l => calibBin(l.p));
    P_CAL = CAL.every(Boolean) ? CAL.reduce((a, b) => a * b.actual, 1) : null;
  }

  const settledBets = D.bets.filter(b => b.status !== 'open');
  const LAST = settledBets[settledBets.length - 1];
  const STREAK = D.stats.streak;

  // ---------- состояние ----------
  const RUN = { startedAt: null, done: false, focusResult: false, runeMarked: false };
  const ST = { stake: null, decision: null, betId: null, whyOpen: null, stepsOpen: false, calcOpen: false, exampleAck: false, tab: { m1: 'probs', m2: 'probs' } };
  // Новый запуск — когда с экрана «Новый анализ» пришёл новый запрос; возврат из «Ставок» показывает готовый результат
  function resetRun() {
    RUN.startedAt = null; RUN.done = false;
    ST.decision = null; ST.stake = null; ST.betId = null; ST.exampleAck = false;
  }
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stake = () => (ST.stake == null ? REC_STAKE : ST.stake);

  // ---------- форматтеры ----------
  const pr = p => Math.round(p * 100) + '%';
  const ppDelta = d => { const v = Math.round(d * 100); return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + ' п.п.'; };
  const usd3 = n => '$' + n.toFixed(3).replace('.', ',');
  const pctTxt = (n, d = 2) => fmt.dec(n, d === 2 ? 2 : 1).replace(/,?0+$/, '') + '%';
  function tier(v) {
    if (v >= 0.15) return { label: 'сильный', kind: 'good', ic: 'spark' };
    if (v >= 0.10) return { label: 'хороший', kind: 'good', ic: 'arrowUp' };
    if (v >= 0.05) return { label: 'небольшой', kind: 'info', ic: 'arrowUp' };
    return null;
  }
  function valueCell(v) {
    const t = tier(v);
    return h('div', { class: 'analysis-val' },
      h('span', { class: ['analysis-val-num', v >= 0.05 ? 'is-pos' : v < 0 ? 'is-neg' : null] }, fmt.signedPct(v * 100, 1)),
      t ? chip(t.label, t.kind, t.ic) : h('span', { class: 'analysis-val-none' }, v < 0 ? 'нет валуя' : 'ниже 5%'));
  }
  const CONF = { high: ['Уверенность: высокая', 'good', 'shield'], mid: ['Уверенность: средняя', 'warn', 'alert'], low: ['Уверенность: низкая', 'bad', 'alert'] };
  function confChip(m) { const [t, k, i] = CONF[m.conf]; const c = chip(t, k, i); c.title = m.confNote; return c; }
  const nw = t => h('span', { style: 'white-space:nowrap' }, t);
  const plink = p => h('a', { class: 'analysis-plink', href: '#player-' + p.id }, p.short);

  // ---------- стили ----------
  UI.css('analysis', `
    .analysis-crumb { color: inherit; }
    .analysis-head .analysis-eyebrow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
    .analysis-head h2 { min-width: 0; }
    .analysis-head > div:first-child { min-width: 0; flex: 1 1 420px; }

    /* ход анализа */
    .analysis-prog-top { display: flex; flex-direction: column; gap: 8px; }
    .analysis-prog-nums { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: var(--fs-sm); color: var(--fg-2); }
    .analysis-prog-nums b { font-family: var(--font-mono); font-weight: 500; color: var(--fg); font-variant-numeric: tabular-nums; }
    .analysis-prog-bar { height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .analysis-prog-bar > i { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 999px; transition: width .1s linear; }
    .analysis-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .analysis-step { position: relative; display: grid; grid-template-columns: 28px minmax(0, 1fr) minmax(0, auto); gap: 2px 12px; padding: 9px 0; align-items: start; }
    .analysis-step::before { content: ""; position: absolute; left: 13px; top: 41px; bottom: -7px; width: 2px; border-radius: 2px; background: var(--line); }
    .analysis-step:last-child::before { display: none; }
    .analysis-step.is-done::before { background: color-mix(in srgb, var(--accent) 45%, var(--line)); }
    .analysis-step-ic { grid-row: 1 / span 2; position: relative; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; border: 2px solid var(--line-strong); background: var(--surface); color: var(--fg-3); font-size: var(--fs-xs); font-weight: 600; font-variant-numeric: tabular-nums; }
    .analysis-step-ic svg { width: 15px; height: 15px; display: none; stroke-width: 2.4; }
    .analysis-step.is-done .analysis-step-ic { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .analysis-step.is-done .analysis-step-ic svg { display: block; }
    .analysis-step.is-done .analysis-step-n { display: none; }
    .analysis-step.is-active .analysis-step-ic { border-color: var(--accent-soft); color: var(--accent-ink); }
    .analysis-step.is-active .analysis-step-ic::after { content: ""; position: absolute; inset: -2px; border-radius: 50%; border: 2px solid transparent; border-top-color: var(--accent); border-right-color: var(--accent); animation: analysis-rot .8s linear infinite; }
    @keyframes analysis-rot { to { transform: rotate(360deg); } }
    .analysis-step-main { min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 3px; }
    .analysis-step-title { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-weight: 500; }
    .analysis-step.is-pending .analysis-step-title > span:first-child { color: var(--fg-3); }
    .analysis-step-detail { font-size: var(--fs-sm); color: var(--fg-2); }
    .analysis-step.is-pending .analysis-step-detail { display: none; }
    .analysis-step.is-active .analysis-step-detail { display: none; }
    .analysis-live { list-style: none; margin: 2px 0 0; padding: 0; display: none; flex-direction: column; gap: 3px; font-size: var(--fs-sm); color: var(--fg-2); }
    .analysis-step.is-active .analysis-live { display: flex; }
    .analysis-live li { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .analysis-live li[hidden] { display: none; }
    .analysis-live li::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--line-strong); }
    .analysis-live li.is-ok::before { background: var(--accent); }
    .analysis-step-meta { padding-top: 5px; font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; text-align: right; font-variant-numeric: tabular-nums; }
    .analysis-step.is-done .analysis-step-meta, .analysis-step.is-active .analysis-step-meta { color: var(--fg-2); }
    .analysis-model { font-weight: 600; }
    @media (max-width: 720px) {
      .analysis-running .analysis-head .lead { display: none; }
      .analysis-running .analysis-step.is-done .analysis-step-detail { display: none; }
      .analysis-step { grid-template-columns: 28px minmax(0, 1fr); }
      .analysis-step-meta { grid-column: 2; text-align: left; padding-top: 0; white-space: normal; }
    }
    .analysis-done-row { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
    .analysis-done-row .analysis-prog-nums { flex: 1 1 260px; }
    .analysis-done-row [aria-expanded] svg:last-child { transition: transform .15s; }
    .analysis-done-row [aria-expanded="true"] svg:last-child { transform: rotate(180deg); }
    .analysis-skel-card { border-style: dashed; }
    .analysis-skel { display: flex; flex-direction: column; gap: 10px; }
    .analysis-skel i { display: block; height: 12px; border-radius: 6px; background: var(--surface-2); }
    .analysis-skel i:nth-child(1) { width: 46%; height: 16px; } .analysis-skel i:nth-child(2) { width: 88%; } .analysis-skel i:nth-child(3) { width: 72%; } .analysis-skel i:nth-child(4) { width: 80%; }

    /* раскладка результата */
    .analysis-result { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 360px); gap: 16px; align-items: start; animation: analysis-in .35s ease-out; }
    @keyframes analysis-in { from { opacity: 0; transform: translateY(6px); } }
    .analysis-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1180px) { .analysis-result { grid-template-columns: minmax(0, 1fr); } .analysis-side { order: -1; } }
    /* решение остаётся на виду, пока читаете оба матча */
    /* только когда карточка целиком помещается в экран: при раскрытом расчёте суммы она выше — тогда обычная прокрутка */
    @media (min-width: 1181px) and (min-height: 880px) { .analysis-side:not(.is-calc-open) { position: sticky; top: calc(var(--topbar-h) + 16px); } }

    /* карточка матча */
    .analysis-match .card-head { flex-wrap: wrap; }
    .analysis-match .card-head > div:first-child { flex: 1 1 220px; }
    .analysis-match .card-head h3 { font-size: var(--fs-lg); }
    .analysis-pickline { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: var(--r-md); background: var(--accent-soft); color: var(--accent-ink); font-size: var(--fs-sm); }
    .analysis-pickline svg { width: 18px; height: 18px; flex: none; margin-top: 1px; }
    .analysis-pickline > span { min-width: 0; }
    .analysis-pickline b { color: var(--fg); font-weight: 600; }
    .analysis-pickline .odds { color: var(--fg); }
    .analysis-sec { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .analysis-sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: 4px 12px; flex-wrap: wrap; }
    .analysis-sec-head h4 { font-size: var(--fs-md); }
    .analysis-hint { font-size: var(--fs-xs); color: var(--fg-3); }

    /* сравнение игроков */
    .analysis-vs { display: flex; flex-direction: column; }
    .analysis-vs-head, .analysis-vs-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 10.5rem) minmax(0, 1fr); align-items: center; gap: 8px; }
    .analysis-vs-head { padding-bottom: 8px; }
    .analysis-vs-row { padding: 7px 0; border-top: 1px solid var(--line); }
    .analysis-vs-label { text-align: center; font-size: var(--fs-xs); color: var(--fg-3); }
    .analysis-vs-side { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .analysis-vs-side.r { align-items: flex-end; text-align: right; }
    .analysis-vs-side.l { align-items: flex-start; }
    .analysis-vs-name { font-family: var(--font-display); font-weight: 600; font-size: var(--fs-md); }
    .analysis-vs-vs { font-size: var(--fs-xs); color: var(--fg-3); text-align: center; text-transform: uppercase; letter-spacing: .08em; }
    .analysis-vs-num { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; margin: 0 -8px; border-radius: 999px; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .analysis-vs-num svg { width: 13px; height: 13px; flex: none; stroke-width: 2.4; }
    .analysis-vs-side.is-better .analysis-vs-num { background: var(--accent-soft); color: var(--accent-ink); font-weight: 600; }
    .analysis-vs-sub { font-size: var(--fs-xs); color: var(--fg-3); }
    .analysis-vs-sub.warn { color: var(--warn-ink); font-weight: 500; }
    .analysis-vs-form { display: inline-flex; align-items: center; gap: 8px; }
    .analysis-vs-form .analysis-vs-num { margin-left: 0; }
    .analysis-plink { color: var(--fg); text-decoration: none; }
    .analysis-plink:hover { color: var(--accent-ink); text-decoration: underline; }
    @media (max-width: 720px) {
      .analysis-vs-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "lab lab" "l r"; gap: 2px 8px; padding: 6px 0 8px; align-items: start; }
      .analysis-vs-row .analysis-vs-label { grid-area: lab; }
      .analysis-vs-row .analysis-vs-side.l { grid-area: l; }
      .analysis-vs-row .analysis-vs-side.r { grid-area: r; }
      .analysis-vs-num { margin: 0 -6px; padding: 2px 6px; }
    }

    /* вероятности: таблица (десктоп) */
    .analysis-ptable { font-size: var(--fs-sm); }
    .analysis-ptable th, .analysis-ptable td { padding: 9px 8px; }
    .analysis-ptable th:first-child, .analysis-ptable td:first-child { padding-left: 18px; }
    .analysis-ptable th:last-child, .analysis-ptable td:last-child { padding-right: 18px; }
    .analysis-ptable th { vertical-align: bottom; }
    .analysis-th-out { width: 34%; }
    .analysis-th-sub { display: block; text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px; color: var(--fg-3); white-space: nowrap; }
    .analysis-ptable td { vertical-align: top; }
    .analysis-ptable tr.is-pick td { background: color-mix(in srgb, var(--accent-soft) 70%, transparent); }
    .analysis-ptable tr.is-pick td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
    .analysis-out { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .analysis-out b { font-weight: 600; }
    .analysis-out small { font-size: var(--fs-xs); color: var(--fg-3); }
    .analysis-out .chip { align-self: flex-start; margin-top: 4px; }
    .analysis-pnum { font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; }
    .analysis-pnum small { display: block; font-size: 11px; color: var(--fg-3); font-weight: 400; }
    .analysis-val { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; }
    .analysis-val-num { font-family: var(--font-mono); font-weight: 500; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--fg-2); }
    .analysis-val-num.is-pos { color: var(--fg); font-weight: 600; }
    .analysis-val-num.is-neg { color: var(--fg-3); }
    .analysis-val-none { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }

    /* вероятности: список (телефон) */
    .analysis-plist { display: flex; flex-direction: column; gap: 8px; }
    .analysis-pitem { border: 1px solid var(--line); border-radius: var(--r-md); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .analysis-pitem.is-pick { border-color: var(--accent); background: color-mix(in srgb, var(--accent-soft) 55%, var(--surface)); }
    .analysis-pitem-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .analysis-pitem-top .analysis-out { flex: 1 1 auto; }
    .analysis-pgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 0; }
    .analysis-pgrid > div { min-width: 0; }
    .analysis-pgrid dt { font-size: 11px; color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .analysis-pgrid dd { margin: 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .analysis-pgrid dd small { font-weight: 400; color: var(--fg-3); font-size: 11px; }
    .analysis-pnote { font-size: var(--fs-xs); color: var(--fg-3); }

    /* факторы */
    .analysis-factors { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px 20px; }
    @media (max-width: 720px) { .analysis-factors { grid-template-columns: minmax(0, 1fr); } }
    .analysis-fcol { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .analysis-fcol h5 { margin: 0; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .06em; color: var(--fg-3); font-weight: 600; }
    .analysis-fl { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
    .analysis-fl li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 10px; font-size: var(--fs-sm); line-height: 1.45; }
    .analysis-sign { width: 22px; height: 22px; border-radius: 6px; display: grid; place-items: center; font-weight: 700; font-family: var(--font-mono); font-size: var(--fs-md); line-height: 1; }
    .analysis-sign.pro { background: var(--good-soft); color: var(--good-ink); }
    .analysis-sign.con { background: var(--bad-soft); color: var(--bad-ink); }
    .analysis-src { display: inline-flex; align-items: center; gap: 4px; font-size: var(--fs-xs); color: var(--fg-3); margin-top: 2px; }
    .analysis-src svg { width: 12px; height: 12px; flex: none; }

    /* экспресс */
    .analysis-exp .card-head { flex-wrap: nowrap; }
    .analysis-exp .card-head > div:first-child { flex: 1 1 auto; }
    .analysis-legs { display: flex; flex-direction: column; }
    .analysis-leg { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 2px 12px; padding: 10px 0; border-bottom: 1px solid var(--line); }
    .analysis-leg:first-child { padding-top: 0; }
    .analysis-leg-meta { font-size: var(--fs-xs); color: var(--fg-3); }
    .analysis-leg-pick { font-weight: 600; }
    .analysis-leg-right { display: flex; align-items: center; gap: 10px; }
    .analysis-leg-p { font-size: var(--fs-xs); color: var(--fg-3); text-align: right; line-height: 1.25; }
    .analysis-leg-p b { display: block; font-size: var(--fs-sm); color: var(--fg); font-variant-numeric: tabular-nums; }
    .analysis-totals { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .analysis-total { background: var(--surface-2); border-radius: var(--r-md); padding: 10px 12px; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .analysis-total span { font-size: var(--fs-xs); color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .analysis-total b { font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; letter-spacing: -.01em; line-height: 1.15; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .analysis-total small { font-size: 11px; color: var(--fg-3); font-family: var(--font-mono); white-space: nowrap; }
    .analysis-calnote { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; }
    .analysis-calnote svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .analysis-stake { display: flex; align-items: flex-end; justify-content: space-between; gap: 8px 12px; flex-wrap: wrap; }
    .analysis-stake-value { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; white-space: nowrap; }
    .analysis-calc-toggle { align-self: flex-start; }
    .analysis-calc-toggle svg:last-child { transition: transform .15s; }
    .analysis-calc-toggle[aria-expanded="true"] svg:last-child { transform: rotate(180deg); }
    .analysis-calc-box[hidden], .analysis-steps[hidden] { display: none; }
    .analysis-calc { margin: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px 12px; font-size: var(--fs-sm); padding: 12px; border-radius: var(--r-md); border: 1px solid var(--line); }
    .analysis-calc dt { color: var(--fg-2); min-width: 0; }
    .analysis-calc dd { margin: 0; text-align: right; font-weight: 500; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .analysis-calc .is-sum { padding-top: 7px; border-top: 1px dashed var(--line-strong); }
    .analysis-calc dd.is-sum { font-weight: 700; color: var(--fg); }
    .analysis-actions { display: flex; flex-wrap: wrap; gap: 8px; width: 100%; }
    .analysis-actions > .btn { flex: 1 1 auto; }
    .analysis-actions > .btn.primary { flex-basis: 100%; }
    .analysis-disclaimer { display: flex; gap: 8px; font-size: var(--fs-xs); color: var(--fg-3); align-items: flex-start; }
    .analysis-disclaimer svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }

    /* почему так */
    .analysis-why-h { font-size: inherit; font-weight: inherit; letter-spacing: 0; }
    .analysis-why-text { min-width: 0; display: flex; flex-direction: column; }
    .analysis-why-title { font-family: var(--font-display); font-size: var(--fs-md); font-weight: 600; color: var(--fg); }
    .analysis-seg { display: flex; width: 100%; }
    .analysis-seg button { flex: 1 1 0; min-width: 0; }
    .analysis-match .analysis-sec { padding-top: 14px; border-top: 1px solid var(--line); }
    .analysis-why-toggle { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 18px; background: none; border: 0; cursor: pointer; text-align: left; border-radius: var(--r-lg); }
    .analysis-why-toggle:hover { background: var(--surface-2); }
    .analysis-why-toggle svg { width: 20px; height: 20px; flex: none; color: var(--fg-3); transition: transform .15s; }
    .analysis-why-toggle[aria-expanded="true"] svg { transform: rotate(180deg); }
    .analysis-why-toggle[aria-expanded="true"] { border-radius: var(--r-lg) var(--r-lg) 0 0; }
    .analysis-why-body { padding: 0 18px 18px; display: flex; flex-direction: column; gap: 14px; }
    .analysis-why-body[hidden] { display: none; }
    .analysis-reasons { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 8px; font-size: var(--fs-sm); color: var(--fg-2); }
    .analysis-reasons li::marker { color: var(--fg-3); font-weight: 600; }
    .analysis-reasons b { color: var(--fg); font-weight: 600; }
    .analysis-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; font-size: var(--fs-sm); }
    .analysis-rules li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; align-items: start; }
    .analysis-rules svg { width: 18px; height: 18px; stroke-width: 2.2; }
    .analysis-rules .ok svg { color: var(--good-ink); }
    .analysis-rules .warn svg { color: var(--warn-ink); }
    .analysis-rules small { display: block; color: var(--fg-3); font-size: var(--fs-xs); }
    @media (max-width: 720px) { .analysis-why-toggle { padding: 14px; } .analysis-why-body { padding: 0 14px 14px; } }

    .analysis-meta { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--fg-2); text-decoration: none; padding: 12px 14px; border-radius: var(--r-md); border: 1px solid var(--line); background: var(--surface); }
    .analysis-meta:hover { border-color: var(--line-strong); color: var(--fg); }
    .analysis-meta > svg { width: 18px; height: 18px; flex: none; color: var(--fg-3); }
    .analysis-meta > span { min-width: 0; flex: 1 1 200px; }
    .analysis-meta b { font-weight: 600; color: var(--fg); }
    .analysis-modal-preview { margin: 0; }
    .analysis-foreign .analysis-foreign-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .analysis-foreign-mini { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap; font-size: var(--fs-sm); color: var(--fg-2); padding: 10px 14px; border-radius: var(--r-md); border: 1px dashed var(--line-strong); }
    .analysis-foreign-mini > svg { width: 16px; height: 16px; flex: none; margin-top: 2px; color: var(--warn-ink); }
    .analysis-foreign-mini > span { min-width: 0; flex: 1 1 220px; }
    .analysis-own { display: block; font-size: 11px; font-weight: 500; color: var(--accent-ink); white-space: nowrap; }
    .analysis-mode-acts { margin-top: 8px; }
    .analysis-mode-acts .btn { max-width: 100%; white-space: normal; height: auto; min-height: 36px; padding-block: 6px; text-align: left; }
    .analysis-modal-seg { max-width: 100%; }
  `);

  // ---------- шапка экрана ----------
  function modeChip() {
    const c = chip('Режим «' + MODE.label + '» · ' + MODE.model, MODE.id === 'precise' ? 'outline' : 'warn', MODE.id === 'precise' ? 'spark' : 'alert');
    c.title = MODE.id === 'precise' ? 'Режим для решения о ставке' : MODE.id === 'eco' ? 'Черновая оценка — не для решения о ставке' : 'Качество режима на eval-наборе ещё не проверено';
    return c;
  }
  function headBlock(done) {
    const tm = MX[0].info;
    const how = MODE.news ? 'Claude поправил их по свежим новостям' : 'Claude (' + MODE.model + ') поправил их по сохранённым досье, без поиска свежих новостей';
    return h('div', { class: 'page-head analysis-head' },
      h('div', null,
        h('div', { class: 'analysis-eyebrow' }, h('span', { class: 'eyebrow' }, fmt.dateFull(TODAY) + ' · ' + tm.tournament + ' · ' + tm.category), UI.surfaceChip('hard'), modeChip()),
        h('h2', { id: 'analysis-title', tabindex: '-1' }, done
          ? (FOREIGN ? 'Пример: экспресс' : 'Экспресс') + ' из ' + LEGS.length + ' событий · кэф ' + fmt.odds(TOTAL_ODDS)
          : (FOREIGN ? 'Пример: анализ ' + MX.length + ' ' + fmt.plural(MX.length, 'матча', 'матчей', 'матчей') : 'Анализирую ' + MX.length + ' ' + fmt.plural(MX.length, 'матч', 'матча', 'матчей'))),
        h('p', { class: 'lead' }, done
          ? 'ML-модель посчитала вероятности, ' + how + ', стратегия ' + STRAT_V + ' отобрала рынки и сумму. Решение — за вами.'
          : 'Шаги идут по порядку: сначала дешёвые проверки и формулы, дорогая модель — только там, где она нужна.')),
      button('Изменить события', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new' }));
  }

  // ---------- ход анализа ----------
  function phaseAt(t) {
    let acc = 0;
    for (let i = 0; i < STEPS.length; i++) { if (t < acc + STEPS[i].dur) return { i, f: Math.max(0, (t - acc) / STEPS[i].dur) }; acc += STEPS[i].dur; }
    return { i: STEPS.length, f: 1 };
  }
  function stepMeta(s, f) {
    const sec = Math.max(f > 0 ? 1 : 0, Math.round(s.sec * f));
    if (!s.tokens) return fmt.duration(sec) + ' · без токенов';
    const tk = Math.round(s.tokens * f / 100) * 100;
    return fmt.duration(sec) + ' · ' + fmt.int(tk) + ' ток. · ' + usd3(s.cost * f);
  }
  function modelChip(s) { return s.model ? chip(s.model, 'accent', 'spark') : chip('без ИИ', 'outline', 'database'); }

  function stepEl(s, i) {
    const live = s.live.map(t => h('li', { hidden: true }, t));
    const meta = h('div', { class: 'analysis-step-meta' }, 'ожидает');
    const sr = h('span', { class: 'sr-only' }, 'ожидает');
    const el = h('li', { class: 'analysis-step is-pending' },
      h('span', { class: 'analysis-step-ic', 'aria-hidden': 'true' }, h('span', { class: 'analysis-step-n' }, String(i + 1)), icon('check')),
      h('div', { class: 'analysis-step-main' },
        h('div', { class: 'analysis-step-title' }, h('span', null, s.title), modelChip(s), sr),
        h('div', { class: 'analysis-step-detail' }, s.detail),
        h('ul', { class: 'analysis-live' }, live)),
      meta);
    let last = '';
    return {
      el,
      set(status, f) {
        if (status !== last) {
          el.className = 'analysis-step is-' + status;
          sr.textContent = status === 'done' ? ' — готово' : status === 'active' ? ' — выполняется' : ' — ожидает';
          last = status;
        }
        if (status === 'done') meta.textContent = stepMeta(s, 1);
        else if (status === 'active') {
          meta.textContent = stepMeta(s, f);
          live.forEach((li, k) => { li.hidden = f < k / live.length; li.classList.toggle('is-ok', f >= (k + 1) / live.length); });
        } else meta.textContent = 'ожидает';
      },
    };
  }

  function totalsAt(ph) {
    let sec = 0, tokens = 0, cost = 0;
    STEPS.forEach((s, i) => { const f = i < ph.i ? 1 : i === ph.i ? ph.f : 0; sec += s.sec * f; tokens += s.tokens * f; cost += s.cost * f; });
    return { sec: Math.round(sec), tokens: Math.round(tokens / 100) * 100, cost };
  }
  function numsLine(tot, extra, withEst) {
    return h('div', { class: 'analysis-prog-nums' },
      extra,
      h('span', null, 'Время ', h('b', null, fmt.duration(tot.sec))),
      h('span', null, 'Токены ', h('b', null, fmt.int(tot.tokens))),
      h('span', null, 'Стоимость ', h('b', null, fmt.usd(tot.cost))),
      withEst && EST != null && h('span', { title: estWhy() }, 'Оценка до запуска ', h('b', null, '≈' + fmt.usd(EST))));
  }
  // почему фактическая цена разошлась с оценкой на экране «Новый анализ»
  function estWhy() {
    if (EST == null) return '';
    const d = TOTAL.cost - EST;
    if (Math.abs(d) < 0.01) return 'Совпало с оценкой';
    return d < 0 ? (MODE.news ? 'Дешевле оценки: новости Синнера, Джоковича и Рублёва взяты из кэша' : 'Дешевле оценки: вывод модели получился короче среднего') : 'Дороже оценки: досье нового игрока потребовало больше текста';
  }

  function progressRunning(root) {
    const steps = STEPS.map(stepEl);
    const bar = h('i');
    const stepLabel = h('b');
    const nums = h('div');
    const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const skip = button('Показать результат сразу', { kind: 'secondary', size: 'sm', icon: 'bolt', onClick: () => { RUN.focusResult = true; finish(root); } });
    const el = card({
      eyebrow: 'Анализ #' + ID,
      title: 'Claude разбирает ' + MX.length + ' ' + fmt.plural(MX.length, 'матч', 'матча', 'матчей') + (FOREIGN ? ' из примера' : ''),
      subtitle: 'Обычно 1–2 минуты · в макете ускорено до 5 секунд',
      actions: [skip],
      body: [
        h('div', { class: 'analysis-prog-top' },
          h('div', { class: 'analysis-prog-bar', role: 'progressbar', 'aria-label': 'Ход анализа', 'aria-valuemin': '0', 'aria-valuemax': String(STEPS.length) }, bar),
          nums),
        h('ol', { class: 'analysis-steps', 'aria-label': 'Шаги анализа' }, steps.map(s => s.el)),
        UI.callout('', 'info', NO_AI + ' из ' + STEPS.length + ' шагов идут без ИИ: проверка базы, ' + (MODE.news ? 'новости из кэша' : 'новости из досье') + (RUNE_NEW ? '' : ', досье Руне из базы') + ', формула ML-модели и правила стратегии. Статистику считает код по архиву ATP, ' + (RUNE_NEW ? 'веб-поиск — только новости. Платные токены — на разбор текста, досье нового игрока и итоговую оценку.' : 'веб-поиск не нужен. Платные токены — на разбор текста и итоговую оценку.')),
        live,
      ],
    });
    let lastI = -1;
    function tick() {
      if (!el.isConnected || RUN.done) return;
      const t = performance.now() - RUN.startedAt;
      if (t >= TOTAL_MS) { finish(root); return; }
      const ph = phaseAt(t);
      steps.forEach((s, i) => s.set(i < ph.i ? 'done' : i === ph.i ? 'active' : 'pending', i === ph.i ? ph.f : 0));
      bar.style.width = (t / TOTAL_MS * 100).toFixed(1) + '%';
      bar.parentNode.setAttribute('aria-valuenow', String(ph.i));
      if (ph.i !== lastI) {
        lastI = ph.i;
        stepLabel.textContent = String(ph.i + 1);
        live.textContent = 'Шаг ' + (ph.i + 1) + ' из ' + STEPS.length + ': ' + STEPS[ph.i].title;
      }
      UI.clear(nums).appendChild(numsLine(totalsAt(ph), h('span', null, 'Шаг ', stepLabel, ' из ' + STEPS.length)));
      setTimeout(tick, 70);
    }
    // первый кадр синхронно — чтобы не было пустого состояния
    setTimeout(tick, 0);
    const t0 = performance.now() - RUN.startedAt, ph0 = phaseAt(t0);
    steps.forEach((s, i) => s.set(i < ph0.i ? 'done' : i === ph0.i ? 'active' : 'pending', i === ph0.i ? ph0.f : 0));
    stepLabel.textContent = String(Math.min(ph0.i + 1, STEPS.length));
    nums.appendChild(numsLine(totalsAt(ph0), h('span', null, 'Шаг ', stepLabel, ' из ' + STEPS.length)));
    return el;
  }

  function progressDone(root) {
    const steps = STEPS.map(stepEl);
    steps.forEach(s => s.set('done', 1));
    const list = h('ol', { class: 'analysis-steps', id: 'analysis-steps', 'aria-label': 'Шаги анализа', hidden: !ST.stepsOpen }, steps.map(s => s.el));
    const toggle = button(ST.stepsOpen ? 'Скрыть шаги' : 'Показать шаги', { kind: 'ghost', size: 'sm', iconRight: 'chevronDown', attrs: { 'aria-expanded': String(ST.stepsOpen), 'aria-controls': 'analysis-steps' }, onClick: () => {
      ST.stepsOpen = !ST.stepsOpen; list.hidden = !ST.stepsOpen;
      toggle.setAttribute('aria-expanded', String(ST.stepsOpen));
      toggle.querySelector('span').textContent = ST.stepsOpen ? 'Скрыть шаги' : 'Показать шаги';
    } });
    const replay = !reduced() && button('Показать ход заново', { kind: 'ghost', size: 'sm', icon: 'play', onClick: () => { RUN.startedAt = performance.now(); RUN.done = false; draw(root); } });
    return h('section', { class: 'card', 'aria-label': 'Ход анализа' },
      h('div', { class: 'card-body' },
        h('div', { class: 'analysis-done-row' },
          chip('Анализ готов', 'good', 'check'),
          numsLine(TOTAL, h('span', null, 'Шагов ', h('b', null, String(STEPS.length))), true),
          h('div', { class: 'row' }, replay, toggle)),
        list));
  }

  function skeleton() {
    return h('section', { class: 'card analysis-skel-card', 'aria-busy': 'true', 'aria-label': 'Результат готовится' },
      h('div', { class: 'card-body' },
        h('div', { class: 'row', style: 'gap:8px' }, icon('clock', { width: 16, height: 16, style: 'color:var(--fg-3)' }), h('span', { class: 'muted small' }, 'Здесь появятся вероятности по рынкам, факторы и экспресс с суммой')),
        h('div', { class: 'analysis-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'))));
  }

  function finish(root) {
    if (!RUN.runeMarked && D.P.rune && D.P.rune.fresh === 'missing') {
      // профиль собран на шаге 3 — теперь он есть в базе
      D.P.rune.fresh = 'fresh'; D.P.rune.updated = TODAY + 'T09:40';
      RUN.runeMarked = true;
    }
    RUN.done = true;
    if (root.isConnected) draw(root);
  }

  // ---------- карточка матча ----------
  function vsBlock(m) {
    const sideHead = (p, cls) => h('div', { class: ['analysis-vs-side', cls] },
      h('span', { class: 'analysis-vs-name' }, plink(p)),
      h('span', { class: 'analysis-vs-sub' }, p.country + ' · №' + p.rank + ' ATP'));
    const val = (row, side) => {
      const better = row.better === side;
      const main = row.form
        ? h('span', { class: 'analysis-vs-form' }, UI.formDots((side === 'l' ? m.A : m.B).form), h('span', { class: 'analysis-vs-num' }, better && icon('check'), wl((side === 'l' ? m.A : m.B).form)))
        : h('span', { class: 'analysis-vs-num' }, better && icon('check'), side === 'l' ? row.l : row.r);
      const sub = side === 'l' ? row.ls : row.rs;
      return h('div', { class: ['analysis-vs-side', side, better && 'is-better'] },
        main, better && h('span', { class: 'sr-only' }, ' — лучше'),
        sub && h('span', { class: ['analysis-vs-sub', side === 'r' && row.rsWarn && 'warn'] }, sub));
    };
    return h('div', { class: 'analysis-vs' },
      h('div', { class: 'analysis-vs-head' }, sideHead(m.A, 'l'), h('div', { class: 'analysis-vs-vs' }, 'против'), sideHead(m.B, 'r')),
      m.cmp.map(row => h('div', { class: 'analysis-vs-row' }, val(row, 'l'), h('div', { class: 'analysis-vs-label' }, row.label), val(row, 'r'))));
  }
  function wl(form) { const w = form.filter(x => x === 'W').length; return w + '–' + (form.length - w); }

  function outcomeCell(r) {
    return h('div', { class: 'analysis-out' },
      h('b', null, r.name),
      h('small', null, r.desc),
      r.pick ? chip('В экспрессе', 'accent', 'ticket') : r.note && h('small', null, r.note));
  }

  function probsTable(m) {
    const th = (t, sub, cls) => h('th', { class: cls, scope: 'col' }, t, sub && h('span', { class: 'analysis-th-sub' }, sub));
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'table analysis-ptable' },
        h('caption', { class: 'sr-only' }, 'Вероятности и валуй по рынкам: ' + D.match({ p1: m.a, p2: m.b })),
        h('thead', null, h('tr', null,
          th('Исход', null, 'analysis-th-out'), th('ML-модель', 'Эло + признаки', 'r'), th('Claude', MODE.news ? 'с новостями' : MODE.model + ', без новостей', 'r'), th('Рынок', 'без маржи', 'r'), th('Кэф', BK, 'r'), th('Валуй', 'p·кэф−1', 'r'))),
        h('tbody', null, m.rows.map(r => h('tr', { class: r.pick ? 'is-pick' : null },
          h('td', null, outcomeCell(r)),
          h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.model))),
          h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.claude), h('small', null, ppDelta(r.claude - r.model)))),
          h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.market))),
          h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(r.odds)), r.edited && h('span', { class: 'analysis-own', title: 'В линии было ' + fmt.odds(r.m.info.odds[r.k]) }, 'ваш кэф')),
          h('td', { class: 'r' }, valueCell(r.value)))))));
  }

  function probsList(m) {
    return h('ul', { class: 'analysis-plist', role: 'list', style: 'list-style:none;margin:0;padding:0', 'aria-label': 'Вероятности по рынкам' }, m.rows.map(r => h('li', { class: ['analysis-pitem', r.pick && 'is-pick'] },
      h('div', { class: 'analysis-pitem-top' }, outcomeCell(r), valueCell(r.value)),
      h('dl', { class: 'analysis-pgrid' },
        h('div', null, h('dt', null, 'ML-модель'), h('dd', null, pr(r.model))),
        h('div', null, h('dt', null, 'Claude'), h('dd', null, pr(r.claude), ' ', h('small', null, ppDelta(r.claude - r.model).replace(' п.п.', '')))),
        h('div', null, h('dt', null, 'Рынок'), h('dd', null, pr(r.market))),
        h('div', null, h('dt', null, r.edited ? 'Ваш кэф' : 'Кэф БК'), h('dd', { class: 'odds' }, fmt.odds(r.odds)))))));
  }

  function factorsBlock(m) {
    const item = (f, kind) => h('li', null,
      h('span', { class: ['analysis-sign', kind], 'aria-label': kind === 'pro' ? 'За' : 'Против' }, kind === 'pro' ? '+' : '−'),
      h('div', { style: 'min-width:0' }, h('div', null, f.t), h('div', { class: 'analysis-src' }, icon('globe'), f.src)));
    return h('div', { class: 'analysis-factors' },
      h('div', { class: 'analysis-fcol' }, h('h5', null, 'За ставку · ' + m.pickRow.name), h('ul', { class: 'analysis-fl' }, m.pro.map(f => item(f, 'pro')))),
      h('div', { class: 'analysis-fcol' }, h('h5', null, 'Против'), h('ul', { class: 'analysis-fl' }, m.con.map(f => item(f, 'con')))));
  }

  const PROB_HINT = 'Валуй: небольшой +5–9%, хороший +10–14%, сильный от +15%. В экспресс идут рынки с p ≥ ' + STRAT.minProb + '% и кэфом ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax) + '.';
  function sec(title, hint, body) {
    return h('div', { class: 'analysis-sec' }, h('div', { class: 'analysis-sec-head' }, h('h4', null, title), hint && h('span', { class: 'analysis-hint' }, hint)), body);
  }

  const oddsHint = () => 'Кэфы ' + BK + (ODDS_EDITED ? ' — с вашими правками' : ' на 09:39');
  function matchCard(m, mobile) {
    const r = m.pickRow;
    const pickLine = h('div', { class: 'analysis-pickline' }, icon('target'),
      h('span', null, 'Выбор: ', h('b', null, r.name), ' @', h('span', { class: 'odds' }, fmt.odds(r.odds)), ' · p ', h('b', null, pr(r.claude)), ' · валуй ', h('b', null, fmt.signedPct(r.value * 100, 1))));
    const head = {
      eyebrow: m.info.time + ' · ' + m.info.round + ' · ' + m.info.court,
      title: D.match({ p1: m.a, p2: m.b }),
      subtitle: 'Данные: ' + m.fresh,
      actions: [confChip(m)],
      class: 'analysis-match',
    };
    if (!mobile) {
      return card(Object.assign(head, { body: [
        pickLine,
        sec('Сравнение игроков', 'лучший показатель в паре отмечен ✓', vsBlock(m)),
        sec('Вероятности по рынкам', oddsHint() + ' — перед ставкой сверьте линию', [h('div', { style: 'margin:0 -18px' }, probsTable(m)), h('p', { class: 'analysis-hint' }, PROB_HINT)]),
        sec('Факторы', 'с источниками и датой', factorsBlock(m)),
      ] }));
    }
    const panel = h('div', { class: 'stack', id: 'analysis-panel-' + m.id, 'aria-live': 'polite' });
    const drawPanel = () => {
      UI.clear(panel);
      const t = ST.tab[m.id];
      if (t === 'probs') UI.append(panel, [h('p', { class: 'analysis-hint' }, 'ML-модель → Claude (поправка в п.п.) → рынок без маржи. ' + oddsHint() + '.'), probsList(m), h('p', { class: 'analysis-hint' }, PROB_HINT)]);
      else if (t === 'cmp') UI.append(panel, [vsBlock(m), h('p', { class: 'analysis-hint' }, '✓ — лучший показатель в паре')]);
      else panel.appendChild(factorsBlock(m));
    };
    drawPanel();
    const seg = UI.segmented({ label: 'Раздел анализа матча', items: [{ id: 'probs', label: 'Вероятности' }, { id: 'cmp', label: 'Сравнение' }, { id: 'factors', label: 'Факторы' }], active: ST.tab[m.id], onChange: id => { ST.tab[m.id] = id; drawPanel(); } });
    seg.style.alignSelf = 'stretch';
    seg.classList.add('analysis-seg');
    return card(Object.assign(head, { body: [pickLine, seg, panel] }));
  }

  // ---------- экспресс ----------
  function stakePct(v) { return v / BANK * 100; }
  // доля банка для показа: если сумма — округлённый шаг стратегии (1 080 ₽ = 2,25%), показываем шаг, а не 2,24% после округления
  // доли банка в окне суммы: рекомендованная по таблице стратегии всегда среди вариантов
  const presets = () => [...new Set([1.5, 2, BASE_PCT || 2.25, 2.5, 3])].sort((a, b) => a - b);
  function sharePct(v) { const pre = presets().find(p => round10(BANK * p / 100) === v); return pctTxt(pre != null ? pre : Math.round(stakePct(v) * 100) / 100); }
  function expressCard(root) {
    const s = stake(), payout = Math.round(s * TOTAL_ODDS);
    const custom = ST.stake != null && ST.stake !== REC_STAKE;
    const statusChip = ST.decision === 'saved' ? chip('Ставка сохранена', 'good', 'check') : ST.decision === 'skipped' ? chip('Без ставки', 'outline', 'x') : chip('Ждёт решения', 'info', 'clock');

    const legs = h('div', { class: 'analysis-legs' }, MX.map(m => {
      const r = m.pickRow;
      return h('div', { class: 'analysis-leg' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'analysis-leg-meta' }, m.info.time + ' · ' + D.match({ p1: m.a, p2: m.b })),
          h('div', { class: 'analysis-leg-pick' }, r.name),
          h('div', { class: 'analysis-leg-meta' }, r.desc)),
        h('div', { class: 'analysis-leg-right' },
          h('div', { class: 'analysis-leg-p', 'aria-label': 'Вероятность ' + pr(r.claude) }, h('span', { 'aria-hidden': 'true' }, 'шанс'), h('b', { 'aria-hidden': 'true' }, pr(r.claude))),
          UI.oddsBox('кэф', r.odds, true)));
    }));

    const totals = h('div', { class: 'analysis-totals' },
      h('div', { class: 'analysis-total' }, h('span', null, 'Кэф'), h('b', { class: 'mono' }, fmt.odds(TOTAL_ODDS)), h('small', null, LEGS.map(l => fmt.odds(l.odds)).join(' × '))),
      h('div', { class: 'analysis-total' }, h('span', null, 'Вероятность'), h('b', null, '≈ ' + pr(P_EXP)), h('small', null, LEGS.map(l => fmt.dec(l.p)).join(' × '))),
      h('div', { class: 'analysis-total' }, h('span', { title: 'Ожидаемый результат (EV) на 1 ₽ ставки' }, 'Перевес'), h('b', null, fmt.signedPct(EV * 100, 1)), h('small', null, '≈ ' + fmt.signedMoney(s * EV))));

    const calNote = P_CAL != null && h('div', { class: 'analysis-calnote' }, icon('target'),
      h('span', null, 'По истории калибровки прогнозы ' + CAL.map(b => Math.round(b.lo * 100) + '–' + Math.round(b.hi * 100) + '%').join(' и ') + ' сбывались в ' + CAL.map(b => pr(b.actual)).join(' и ') + '. С этой поправкой p ≈ ' + pr(P_CAL) + ', перевес ≈ ' + fmt.signedPct((P_CAL * TOTAL_ODDS - 1) * 100, 1) + '.'));

    const lastTxt = LAST ? (LAST.status === 'win' ? 'выиграна' : LAST.status === 'loss' ? 'проиграна' : 'возврат') : '—';
    const adapt = UI.callout('accent', 'history',
      h('b', null, 'Адаптация: '), 'последняя ставка ' + lastTxt + ' (№' + LAST.id + ', ' + fmt.date(LAST.date) + ', ' + fmt.signedMoney(LAST.profit) + ') → без изменений. ',
      STREAK.type === 'win' ? 'Серия побед ' + STREAK.n + ' из 3 нужных для +20%.' : STREAK.type === 'loss' ? 'Поражений подряд ' + STREAK.n + ' из 3 — после трёх сумма −40%.' : '');

    const calc = h('dl', { class: 'analysis-calc' },
      h('dt', null, BANK !== D.stats.bank ? 'Банк из вашего ввода' : 'Банк сейчас'), h('dd', null, fmt.money(BANK)),
      BAND
        ? [h('dt', null, 'Кэф ' + fmt.odds(TOTAL_ODDS) + ' → ', nw('диапазон ' + BAND.range)), h('dd', null, BAND.pct + ' → ' + pctTxt(BASE_PCT))]
        : [h('dt', null, 'Кэф ' + fmt.odds(TOTAL_ODDS) + ' — ', nw('выше ' + fmt.odds(STRAT.totalMax))), h('dd', null, 'вне таблицы → 0%')],
      h('dt', null, 'Валуй ног (' + MX.map(m => fmt.signedPct(m.pickRow.value * 100, 1)).join(', ') + ')'), h('dd', null, 'без поправки'),
      h('dt', null, 'Адаптация по истории'), h('dd', null, 'без изменений'),
      h('dt', { class: 'is-sum' }, nw(fmt.money(BANK) + ' × ' + pctTxt(BASE_PCT)), ' = ', nw(fmt.money(BANK * BASE_PCT / 100)), ', ', nw('округление до 10 ₽')), h('dd', { class: 'is-sum' }, fmt.money(REC_STAKE)));
    // расчёт суммы свёрнут: карточка решения короче и целиком видна рядом с матчами
    const calcBox = h('div', { class: 'stack analysis-calc-box', id: 'analysis-calc', style: 'gap:10px', hidden: !ST.calcOpen }, calc, adapt);
    const calcToggle = button('Как посчитана сумма', { kind: 'ghost', size: 'sm', icon: 'info', iconRight: 'chevronDown', attrs: { 'aria-expanded': String(ST.calcOpen), 'aria-controls': 'analysis-calc' }, onClick: () => {
      ST.calcOpen = !ST.calcOpen; calcBox.hidden = !ST.calcOpen; calcToggle.setAttribute('aria-expanded', String(ST.calcOpen));
      const side = calcToggle.closest('.analysis-side'); if (side) side.classList.toggle('is-calc-open', ST.calcOpen);
    } });
    calcToggle.classList.add('analysis-calc-toggle');

    const stakeRow = h('div', { class: 'analysis-stake' },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'eyebrow' }, custom ? 'Сумма · изменена вручную' : 'Рекомендуемая сумма'),
        h('div', { class: 'analysis-stake-value' }, s ? fmt.money(s) : '—'),
        h('div', { class: 'small muted' }, s ? (custom ? sharePct(s) : pctTxt(BASE_PCT)) + ' банка · при выигрыше ' + fmt.money(payout) + ' (' + fmt.signedMoney(payout - s) + ')' : 'Стратегия не даёт суммы: экспресс вне её правил')),
      custom && REC_STAKE > 0 && button('Вернуть ' + fmt.money(REC_STAKE), { kind: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { ST.stake = null; draw(root); UI.toast('Сумма возвращена к рекомендованной: ' + fmt.money(REC_STAKE), 'refresh'); } }));

    let foot;
    if (ST.decision === 'saved') {
      foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' },
        UI.callout('good', 'check', 'Ставка №' + ST.betId + ' в игре: ' + fmt.money(s) + ' на экспресс @' + fmt.odds(TOTAL_ODDS) + '. Результат внесёте после матчей — модель сверит прогноз.'),
        h('div', { class: 'analysis-actions' }, button('Открыть в ставках', { kind: 'primary', icon: 'ticket', href: '#bets' })));
    } else if (ST.decision === 'skipped') {
      foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' },
        UI.callout('', 'info', 'Анализ сохранён без ставки. Модель всё равно сверит свои вероятности с итогами матчей — так растёт выборка для калибровки.'),
        h('div', { class: 'analysis-actions' },
          button('Всё-таки поставить', { kind: 'primary', icon: 'ticket', onClick: () => { ST.decision = null; logDecision(null); draw(root); } })));
    } else {
      foot = h('div', { class: 'analysis-actions' },
        button('Сохранить ставку', { kind: 'primary', icon: 'check', onClick: () => saveBet(root) }),
        button('Изменить сумму', { kind: 'secondary', icon: 'edit', onClick: () => stakeModal(root) }),
        button('Не ставить', { kind: 'ghost', icon: 'x', onClick: () => { ST.decision = 'skipped'; logDecision('skip'); draw(root); UI.toast('Анализ #' + ID + ' сохранён без ставки', 'check'); } }));
    }

    return h('section', { class: 'card analysis-exp', 'aria-labelledby': 'analysis-exp-title' },
      h('div', { class: 'card-head' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Итог анализа'), h('h3', { id: 'analysis-exp-title' }, 'Экспресс'), h('div', { class: 'card-sub' }, LEGS.length + ' события · стратегия ' + STRAT_V)),
        statusChip),
      h('div', { class: 'card-body' }, legs, totals, calNote, rulesWarn(), modeNote(root), h('hr', { class: 'divider' }), stakeRow, calcToggle, calcBox,
        h('p', { class: 'analysis-disclaimer' }, icon('info'), 'Это оценка вероятностей, а не гарантия: экспресс с p ≈ ' + pr(P_EXP) + ' проигрывает примерно каждый второй раз. Ставьте только ту сумму, потерю которой готовы принять.')),
      h('div', { class: 'card-foot' }, foot));
  }

  // честно о том, что с вашими кэфами экспресс выходит за правила стратегии
  function rulesWarn() {
    const bad = rules().filter(r => !r.ok);
    if (!bad.length) return null;
    return UI.callout('warn', 'alert', h('b', null, 'С вашими кэфами экспресс выходит за правила стратегии ' + STRAT_V + ': '),
      bad.map(r => r.t.charAt(0).toLowerCase() + r.t.slice(1) + (r.d ? ' (' + r.d + ')' : '')).join('; ') + '. ',
      'В приложении ИИ подобрал бы другие рынки или не предложил бы ставку; в макете расчёт показан как есть.');
  }
  // режим без свежих новостей — предупреждаем и даём перезапустить в точном
  function modeNote(root) {
    if (MODE.id === 'precise') return null;
    const txt = MODE.id === 'eco'
      ? 'Режим «Экономный» (Haiku 4.5) — черновая оценка по сохранённым досье, без свежих новостей. Чтобы отсеять лишнее — годится, для решения о ставке — нет.'
      : 'Режим «Сбалансированный» (Sonnet 5.5) ещё не проверен на eval-наборе и не ищет свежие новости. Для решения о ставке надёжнее «Точный».';
    return UI.callout(MODE.id === 'eco' ? 'warn' : 'info', MODE.id === 'eco' ? 'alert' : 'info',
      txt, ' В макете вероятности примера одинаковы во всех режимах.',
      h('div', { class: 'row analysis-mode-acts' }, button('Перезапустить в режиме «Точный»', { kind: 'secondary', size: 'sm', icon: 'refresh', onClick: () => rerunPrecise(root) })));
  }
  function rerunPrecise(root) {
    const r = REQ || {};
    const n = Array.isArray(r.events) && r.events.length ? r.events.length : MX.length;
    const extra = D.P.rune.fresh === 'missing' ? COLLECT_COST : 0;
    D.pendingAnalysis = Object.assign({}, r, { mode: 'precise', model: MODES.precise.model, createdAt: TODAY, events: r.events || MX.map(m => ({ p1: m.a, p2: m.b, odds: Object.assign({}, m.info.odds) })), estimate: { cost: Math.round((n * MODES.precise.perEvent + extra) * 100) / 100, secs: n * 45 } });
    setup(D.pendingAnalysis); resetRun(); setHead();
    RUN.startedAt = performance.now() - (reduced() ? TOTAL_MS : 0);
    UI.toast('Анализ #' + ID + ' запущен в режиме «Точный»', 'spark');
    if (reduced()) finish(root); else draw(root);
    window.scrollTo(0, 0);
  }

  function logDecision(decision) {
    D.analyses = D.analyses || [];
    let rec = D.analyses.find(a => a.id === ID);
    if (!rec) { rec = { id: ID, date: TODAY, legs: LEGS.length, total: TOTAL_ODDS }; D.analyses.push(rec); }
    rec.decision = decision; rec.stake = decision === 'bet' ? stake() : null; rec.note = decision === 'skip' ? 'анализ сохранён без ставки' : null;
  }

  function saveBet(root) {
    const s = stake();
    if (!s) { stakeModal(root); return; }
    const same = b => b.status === 'open' && b.legs.length === LEGS.length && LEGS.every(l => b.legs.some(x => x.p1 === l.p1 && x.p2 === l.p2 && x.market === l.market));
    let bet = D.bets.find(same);
    if (bet) { bet.stake = s; bet.analysis = ID; }
    else {
      bet = { id: Math.max(...D.bets.map(b => b.id)) + 1, date: TODAY, tournament: 'Шанхай', surface: 'hard', legs: LEGS.map(l => Object.assign({ closing: null, result: 'open' }, l)), total: TOTAL_ODDS, stake: s, status: 'open', profit: 0, bankAfter: null, clv: null, bookmaker: BK, analysis: ID };
      D.bets.push(bet);
      D.stats.open = D.bets.filter(b => b.status === 'open').length;
    }
    ST.decision = 'saved'; ST.betId = bet.id;
    logDecision('bet');
    UI.toast('Ставка №' + bet.id + ' сохранена: ' + fmt.money(s) + ' на экспресс @' + fmt.odds(TOTAL_ODDS), 'check');
    D.lastSavedBet = bet.id; // экран «Ставки» подсветит её и прокрутит к ней
    UI.go('bets');
  }

  function stakeModal(root) {
    let val = stake();
    const preview = h('div', { class: 'stack', style: 'gap:10px', 'aria-live': 'polite' });
    if (!val) val = round10(BANK * 1.5 / 100);
    const fieldEl = UI.field({ label: 'Сумма ставки', id: 'analysis-stake-input', type: 'number', value: String(val), suffix: '₽', inputmode: 'numeric', hint: REC_STAKE ? 'Рекомендовано ' + fmt.money(REC_STAKE) + ' — ' + pctTxt(BASE_PCT) + ' банка по стратегии ' + STRAT_V : 'Стратегия ' + STRAT_V + ' суммы для кэфа выше ' + fmt.odds(STRAT.totalMax) + ' не даёт — сумма на ваш риск', attrs: { min: '50', step: '10' } });
    const input = fieldEl.querySelector('input');
    const segHolder = h('div');
    function drawSeg() {
      const match = presets().find(p => round10(BANK * p / 100) === val);
      UI.clear(segHolder).appendChild(UI.segmented({ label: 'Доля банка', items: presets().map(p => ({ id: String(p), label: pctTxt(p) + (p === BASE_PCT ? ' · реком.' : '') })), active: match != null ? String(match) : 'custom', onChange: id => { val = round10(BANK * Number(id) / 100); input.value = String(val); drawPreview(); } }));
      segHolder.firstChild.classList.add('analysis-modal-seg');
    }
    function drawPreview() {
      UI.clear(preview);
      const ok = Number.isFinite(val) && val >= 50 && val <= BANK;
      if (!ok) { preview.appendChild(UI.callout('bad', 'alert', val > BANK ? 'Сумма больше банка (' + fmt.money(BANK) + ').' : 'Минимальная ставка — 50 ₽.')); return; }
      const pct = stakePct(val);
      preview.appendChild(UI.kv([
        ['Доля банка', sharePct(val)],
        ['Выплата при выигрыше (@' + fmt.odds(TOTAL_ODDS) + ')', fmt.money(val * TOTAL_ODDS)],
        ['Чистая прибыль', fmt.signedMoney(val * TOTAL_ODDS - val)],
        ['При проигрыше', fmt.signedMoney(-val)],
        ['Ожидаемый результат по оценке модели', '≈ ' + fmt.signedMoney(val * EV)],
      ]));
      if (pct > 4) preview.appendChild(UI.callout('bad', 'alert', 'Больше 4% банка — выше любого лимита стратегии. Одна неудачная серия заметно ударит по банку.'));
      else if (pct > 3) preview.appendChild(UI.callout('warn', 'alert', 'Больше 3% банка: стратегия разрешает до 4% только при росте банка на 15% и винрейте от 60% (сейчас ' + fmt.pct(D.stats.winrate) + ').'));
    }
    input.addEventListener('input', () => { val = Math.round(Number(input.value)); drawSeg(); drawPreview(); });
    drawSeg(); drawPreview();
    UI.modal({
      title: 'Изменить сумму',
      body: close => h('form', { id: 'analysis-stake-form', class: 'stack', style: 'gap:14px', novalidate: true, on: { submit: e => {
        e.preventDefault();
        if (!(Number.isFinite(val) && val >= 50 && val <= BANK)) { input.focus(); return; }
        ST.stake = val === REC_STAKE ? null : val;
        close(); draw(root);
        UI.toast('Сумма изменена: ' + fmt.money(val) + ' (' + sharePct(val) + ' банка)', 'edit');
      } } }, fieldEl, h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'field-label' }, 'Или доля банка'), segHolder), preview),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Применить', { kind: 'primary', type: 'submit', icon: 'check', attrs: { form: 'analysis-stake-form' } }),
      ],
    });
  }

  // ---------- почему так ----------
  function whyCard() {
    if (ST.whyOpen == null) ST.whyOpen = !UI.isMobile(); // на компьютере места хватает — раскрыто сразу
    const m1 = MX[0], m2 = MX[1];
    const r1 = m1.pickRow, r2 = m2.pickRow;
    const alt2 = m2.rows.find(r => r.k === 'h1m'), alt1 = m1.rows.find(r => r.k === 'p1');
    const body = h('div', { class: 'analysis-why-body', id: 'analysis-why', hidden: !ST.whyOpen },
      h('ol', { class: 'analysis-reasons' },
        h('li', null, h('b', null, m1.A.short + ' 2:0. '), 'ML-модель (Эло + признаки) даёт ' + pr(r1.model) + ', Claude поднял до ' + pr(r1.claude) + ': ' + m1.A.short + ' свежее (3 матча за 14 дней против 4 у ' + m1.B.short + ', у которого последний матч — три сета), а 71% его побед на харде — 2:0. Рынок закладывает ' + pr(r1.market) + '.'),
        h('li', null, h('b', null, 'Уроки. '), 'L-014 (фора −1.5 против подающего левши) проверен и не применён: ' + m1.B.short + ' правша, подача в среднем ' + m1.B.serve.speed + ' км/ч. По L-019 пост из соцсетей о плече ' + m1.B.short + ' без подтверждения турнира не учитывался.'),
        h('li', null, h('b', null, m2.A.short + ' П1. '), 'ML-модель даёт ' + pr(r2.model) + ', Claude — ' + pr(r2.claude) + ': плюс за приём и личные встречи почти съеден возрастом и трёхсетовиком в 1/32 (4 окт).'),
        h('li', null, h('b', null, 'Что отброшено. '), droppedText(alt2, r2) + ' ' + droppedText(alt1, r1)),
        h('li', null, h('b', null, 'Главный риск. '), 'Тай-брейк в матче ' + D.match({ p1: m1.a, p2: m1.b }) + ': один отданный сет — и нога проиграна. Если наши p завышены на 5 п.п. по каждой ноге, перевес экспресса исчезает.')),
      h('div', { class: 'stack', style: 'gap:8px' },
        h('h4', null, 'Проверка по правилам стратегии ' + STRAT_V),
        h('ul', { class: 'analysis-rules' }, rules().map(r => h('li', { class: r.ok ? 'ok' : 'warn' }, icon(r.ok ? 'check' : 'alert'), h('div', { style: 'min-width:0' }, h('span', { class: 'sr-only' }, r.ok ? 'Выполнено: ' : 'Внимание: '), r.t, r.d && h('small', null, r.d)))))));
    const toggle = h('button', { type: 'button', class: 'analysis-why-toggle', 'aria-expanded': String(ST.whyOpen), 'aria-controls': 'analysis-why', on: { click: () => {
      ST.whyOpen = !ST.whyOpen; body.hidden = !ST.whyOpen; toggle.setAttribute('aria-expanded', String(ST.whyOpen));
    } } },
      h('span', { class: 'analysis-why-text' }, h('span', { class: 'analysis-why-title' }, 'Почему так'), h('span', { class: 'card-sub' }, whySub())),
      icon('chevronDown'));
    return h('section', { class: 'card', 'aria-label': 'Почему так' }, h('h3', { class: 'analysis-why-h' }, toggle), body);
  }
  // «Что отброшено»: причина берётся из тех кэфов, что пришли в анализ
  function droppedText(alt, pick) {
    const why = [];
    if (alt.odds > STRAT.oddsMax) why.push('кэф ' + fmt.odds(alt.odds) + ' выше лимита ' + fmt.odds(STRAT.oddsMax));
    if (alt.odds < STRAT.oddsMin) why.push('кэф ' + fmt.odds(alt.odds) + ' ниже минимума ' + fmt.odds(STRAT.oddsMin));
    if (alt.claude * 100 < STRAT.minProb) why.push('p ' + pr(alt.claude) + ' ниже ' + STRAT.minProb + '%');
    const val = fmt.signedPct(alt.value * 100, 1);
    if (why.length) return alt.name + ' даёт ' + (alt.value > pick.value ? 'больший валуй' : 'валуй') + ' (' + val + '), но ' + why.join(', а ') + '.';
    if (alt.value > pick.value) return alt.name + ' @' + fmt.odds(alt.odds) + ' с этим кэфом выгоднее выбранного (' + val + ') — в приложении ИИ пересмотрел бы ногу.';
    return alt.name + ' @' + fmt.odds(alt.odds) + ' надёжнее, но перевес всего ' + val + '.';
  }
  function whySub() {
    const rs = rules(), bad = rs.filter(r => !r.ok).length;
    return '5 доводов модели и проверка по ' + rs.length + ' правилам' + (bad ? ' · не выполнено: ' + bad : '');
  }
  function rules() {
    const form5 = id => { const f = D.P[id].form.slice(0, 5); return f.filter(x => x === 'W').length; }; // form[0] — последний матч
    const who = l => (MK[l.market].who === 'A' ? l.p1 : l.p2);
    const fora = LEGS.filter(l => l.market === 'h1m');
    const list = [
      { ok: LEGS.length >= 2 && LEGS.length <= STRAT.maxLegs, t: LEGS.length + ' события — разрешено 2–' + STRAT.maxLegs },
      { ok: LEGS.every(l => l.odds >= STRAT.oddsMin && l.odds <= STRAT.oddsMax), t: 'Кэф каждой ноги ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax), d: LEGS.map(l => fmt.odds(l.odds)).join(' и ') },
      { ok: LEGS.every(l => l.p * 100 >= STRAT.minProb), t: 'Вероятность каждой ноги ≥ ' + STRAT.minProb + '%', d: LEGS.map(l => pr(l.p)).join(' и ') },
      { ok: LEGS.every(l => l.p * l.odds > 1), t: 'Перевес каждой ноги выше нуля (p × кэф > 1)', d: LEGS.map(l => fmt.signedPct((l.p * l.odds - 1) * 100, 1)).join(' и ') },
      { ok: TOTAL_ODDS <= STRAT.totalMax, t: 'Итоговый кэф ≤ ' + fmt.odds(STRAT.totalMax), d: fmt.odds(TOTAL_ODDS) },
    ];
    if (fora.length) list.push({ ok: fora.every(l => l.p >= 0.55), t: 'Для форы −1.5 вероятность 2:0 ≥ 55%', d: fora.map(l => pr(l.p)).join(' и ') });
    list.push({ ok: LEGS.every(l => form5(who(l)) >= 3), t: 'Форма за 5 матчей не хуже 3–2', d: LEGS.map(l => D.P[who(l)].short + ' ' + form5(who(l)) + '–' + (5 - form5(who(l)))).join(', ') });
    list.push({ ok: true, t: 'Нет травм и перегруза', d: D.P[LEGS[0].p1].short + ' — 3 матча за 14 дней, ' + D.P[LEGS[1].p1].short + ' — 2; подтверждённых травм нет' });
    return list;
  }

  function metaLine() {
    return h('a', { class: 'analysis-meta', href: '#costs', title: 'Подробнее о расходах на ИИ' }, icon('coins'),
      h('span', null, h('b', null, 'Анализ #' + ID), ' · режим «' + MODE.label + '» · ' + fmt.int(TOTAL.tokens) + ' токенов, вход ' + MODE.model.split(' ')[0] + ' из кэша ' + CACHE_SHARE + '% · ' + (TOTAL.searches ? TOTAL.searches + ' ' + fmt.plural(TOTAL.searches, 'поиск', 'поиска', 'поисков') : 'без веб-поиска') + ' · ' + fmt.usd(TOTAL.cost) + (EST != null ? ' (оценка была ≈' + fmt.usd(EST) + ')' : '') + ' · ' + fmt.duration(TOTAL.sec) + ' · ' + MODELS.join(' + ')),
      icon('chevronRight'));
  }

  // ---------- вы ввели не те матчи, что есть в примере ----------
  function foreignNote(root) {
    if (!FOREIGN) return null;
    const list = REQ.events.map(e => nm(e.p1) + ' — ' + nm(e.p2));
    const used = MX.filter(m => m.entered).map(m => D.match({ p1: m.a, p2: m.b }));
    const back = button('Вернуться к вводу', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new' });
    if (ST.exampleAck) {
      return h('div', { class: 'analysis-foreign-mini', role: 'note' }, icon('alert'),
        h('span', null, 'Показан пример анализа, а не ваши события: ' + list.join(', ') + '.'),
        back);
    }
    return h('div', { class: 'callout warn analysis-foreign', role: 'note' }, icon('alert'),
      h('div', { style: 'min-width:0' },
        h('b', null, 'Это пример, а не разбор ваших матчей. '),
        'В макете подробный разбор есть только для примера Синнер — Руне и Джокович — Рублёв. Вы ввели: ' + list.join(', ') + '. В приложении здесь будет разбор ваших матчей.' +
          (used.length ? ' Ваши кэфы на ' + used.join(' и ') + ' в примере учтены.' : ''),
        h('div', { class: 'analysis-foreign-acts' }, back,
          button('Смотреть пример', { kind: 'ghost', size: 'sm', icon: 'eye', onClick: () => { ST.exampleAck = true; draw(root); } }))));
  }

  // ---------- сборка экрана ----------
  function draw(root) {
    const mobile = UI.isMobile();
    UI.clear(root);
    root.classList.toggle('analysis-running', !RUN.done);
    if (!RUN.done) {
      UI.append(root, [headBlock(false), foreignNote(root), progressRunning(root), skeleton()]);
      return;
    }
    UI.append(root, [
      headBlock(true),
      foreignNote(root),
      progressDone(root),
      h('div', { class: 'analysis-result' },
        h('div', { class: 'analysis-col analysis-main' }, MX.map(m => matchCard(m, mobile)), whyCard()),
        h('div', { class: ['analysis-col', 'analysis-side', ST.calcOpen && 'is-calc-open'] }, expressCard(root))),
      metaLine(),
    ]);
    if (RUN.focusResult) { RUN.focusResult = false; const t = root.querySelector('#analysis-title'); t && t.focus(); }
  }

  // на телефоне — короткая крошка в одну строку: номер анализа и так виден на странице
  function setHead() {
    UI.setHeader({ title: 'Анализ', crumbs: UI.isMobile()
      ? h('a', { class: 'analysis-crumb', href: '#new' }, '← Новый анализ')
      : h('span', null, h('a', { class: 'analysis-crumb', href: '#new' }, 'Новый анализ'), ' → Анализ #' + ID) });
  }

  setup(D.pendingAnalysis);

  UI.register('analysis', {
    title: 'Анализ',
    nav: 'new',
    crumbs: 'Новый анализ → Анализ #' + ID,
    render(root) {
      // пришёл новый запрос с экрана «Новый анализ» — пересчитываем всё под него и запускаем заново
      if ((D.pendingAnalysis || null) !== REQ) { setup(D.pendingAnalysis); resetRun(); }
      setHead();
      // при «уменьшении движения» анализ сразу показывается завершённым
      if (RUN.startedAt == null) RUN.startedAt = performance.now() - (reduced() ? TOTAL_MS : 0);
      if (!RUN.done && performance.now() - RUN.startedAt >= TOTAL_MS) finish(root);
      else draw(root);
    },
  });
})();
