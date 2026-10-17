/* Анализ #A-0142: ход анализа по шагам (в макете ускорен до ~5 с), затем результат —
   карточки матчей (сравнение игроков, вероятности по рынкам, факторы), экспресс с суммой по стратегии,
   «Почему так» и строка расходов. Состояние живет в памяти модуля: смена темы или ширины экрана
   продолжает анимацию с того же места, а повторный запуск идет только при переходе из «Нового анализа».
   Этап 3: шаги идут по матчам (новости и оценка Claude — на каждый матч), есть отмена, сбой шага с
   перезапуском, остановка по лимиту и потолку, неработающий ключ, потеря связи. Состояния для
   согласования переключаются демо-панелью «Только в макете» или адресом #analysis-<состояние>. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, TODAY = D.today;
  const STRAT = D.strategy;
  const STRAT_V = (D.strategyVersions.find(v => v.status === 'active') || { id: 'v3' }).id;

  // ---------- режимы — те же, что на экране «Новый анализ» ----------
  // Цены за 1 млн токенов (docs/TOKEN_ECONOMY.md): вход, запись в кэш (×1,25 цены входа), чтение кэша, выход.
  // На этапе 3 работает только «Точный»; два других режима вернутся после проверки на истории.
  const MODES = {
    precise: { id: 'precise', label: 'Точный', model: 'Opus 5.5', perEvent: 0.09, news: true, sec: 47, price: { in: 4, write: 5, read: 0.20, out: 20 } },
    balanced: { id: 'balanced', label: 'Сбалансированный', model: 'Sonnet 5.5', perEvent: 0.045, news: false, sec: 31, price: { in: 2, write: 2.5, read: 0.10, out: 10 } },
    eco: { id: 'eco', label: 'Экономный', model: 'Haiku 5.5', perEvent: 0.02, news: false, sec: 16, price: { in: 0.1, write: 0.125, read: 0.01, out: 0.5 } },
  };
  MODES.economy = MODES.eco;

  // ---------- шаги анализа ----------
  // sec/tokens/cost — значения запуска (пример); dur — длительность шага в ускоренной анимации, мс.
  // Раскладка по docs/TOKEN_ECONOMY.md: досье и базовую вероятность считает код по архиву ATP в базе (0 токенов),
  // веб-поиск — только новости и только на Sonnet 5.5 (effort low), Opus 5.5 оценивает каждый матч одним вызовом без поиска.
  // Новости Синнер — Руне: вход 9 000 × $2 + выход 800 × $10 + 2 поиска = $0,046 (новости Синнера моложе 12 ч, ищем только Руне).
  // Claude, матч 1: 6 000 токенов инструкций и стратегии пишутся в кэш, 4 000 — досье матча, 1 700 — выход ($0,080).
  // Claude, матч 2: те же 6 000 читаются из кэша, 4 000 — досье, 1 600 — выход ($0,049).
  const AI = { prefix: 6000, dossier: 4000, out1: 1700, out2: 1600 };
  const CACHE_SHARE = Math.round(AI.prefix / (2 * (AI.prefix + AI.dossier)) * 100); // доля входа Opus из кэша за оба вызова
  const PARSE = { tokens: 2400, cost: 0.001 }; // Haiku 5.5: 2 000 входа × $0,10 + 400 выхода × $0,50 — меньше $0,001

  // ---------- матчи и оценки (пример данных) ----------
  const MX = [
    {
      id: 'm1', a: 'sinner', b: 'rune', conf: 'mid',
      probs: { p1: [0.84, 0.87], h1m: [0.62, 0.66] }, // [ML-модель, Claude]
      // Р28: другие рынки из ввода — кэфы обеих сторон и вероятность первой стороны [ML-модель, после поправки Claude].
      // У фор первая сторона — игрок 1 с линией line, у тоталов — больше; push — «ровно» на целой линии (возврат)
      extra: [
        { market: 'gtot', line: 22.5, odds: [1.90, 1.90], p: [0.43, 0.41] },
        { market: 'ghcp', line: -4.5, odds: [1.85, 1.95], p: [0.55, 0.57] },
      ],
      // цифры совпадают с карточками игроков (#player-sinner, #player-rune)
      cmp: [
        { label: 'Эло на харде', l: fmt.int(D.P.sinner.elo.hard), r: fmt.int(D.P.rune.elo.hard), better: 'l' },
        { label: 'Форма, 10 матчей', form: true, better: 'l' },
        { label: 'Матчей за 14 дней', m14: true }, // по матчам в базе (DATA.playerBase), см. baseRows()
        { label: 'Очки на 1-й подаче', l: D.P.sinner.serve.firstWon + '%', r: D.P.rune.serve.firstWon + '%', better: 'l' },
        { label: 'Выиграно на приеме', l: '42%', r: '38%', better: 'l' },
        { label: 'Тай-брейки, 52 недели', l: '21–9', ls: '70%', r: '10–12', rs: '45%', better: 'l' },
        { label: 'Личные встречи', l: '3', ls: 'на харде 2–0', r: '1', better: 'l' },
      ],
      pro: [
        { t: 'Синнер свежее: за 14 дней 3 матча — после 1-го круга Пекина он снялся, чтобы восстановиться к Шанхаю. У Руне 4 матча, последний (5 окт) — три сета с Тиафо', src: 'база матчей (по 2 окт) · новости: atptour.com, 5 окт; tennismajors.com, 1 окт' },
        { t: 'За 2 сезона у Синнера 48 побед на харде, 34 из них — 2:0 (71%)', src: 'база матчей (архив ATP)' },
        { t: 'Тай-брейки за 52 недели: у Синнера 70%, у Руне 45% — сет, дошедший до тай-брейка, скорее за Синнером', src: 'база матчей (архив ATP)' },
      ],
      con: [
        { t: 'Руне взял сет в 3 из 4 личных встреч с Синнером', src: 'база матчей (архив ATP), H2H' },
        { t: 'Корты в Шанхае быстрее прошлогодних, эйсов на 18% больше: тай-брейков будет больше, а один отданный сет ломает 2:0', src: 'tennis.com, 5 окт' },
        { t: 'Руне выиграл оба тай-брейка у Мунара в 1/32 (4 окт) — на своей подаче он держится', src: 'новости: atptour.com, 4 окт' },
      ],
    },
    {
      id: 'm2', a: 'djokovic', b: 'rublev', conf: 'high',
      extra: [
        { market: 'stot', line: 2.5, odds: [2.30, 1.60], p: [0.40, 0.37] },
        { market: 'gtot', line: 22, odds: [1.75, 2.05], p: [0.47, 0.46], push: 0.07 },
      ],
      confNote: 'Новости свежие, источники согласуются',
      news: 'новости Джоковича 02:30, Рублева 6 окт 21:50',
      probs: { p1: [0.78, 0.79], h1m: [0.50, 0.54] },
      // цифры совпадают с карточками игроков (#player-djokovic, #player-rublev)
      cmp: [
        { label: 'Эло на харде', l: fmt.int(D.P.djokovic.elo.hard), r: fmt.int(D.P.rublev.elo.hard), better: 'l' },
        { label: 'Форма, 10 матчей', form: true, better: 'l' },
        { label: 'Матчей за 14 дней', m14: true },
        { label: 'Очки на 1-й подаче', l: D.P.djokovic.serve.firstWon + '%', r: D.P.rublev.serve.firstWon + '%', better: 'l' },
        { label: 'Выиграно на приеме', l: '43%', r: '37%', better: 'l' },
        { label: 'Тай-брейки, 52 недели', l: '13–8', ls: '62%', r: '10–13', rs: '43%', better: 'l' },
        { label: 'Личные встречи', l: '4', ls: 'на харде 2–1', r: '1', better: 'l' },
      ],
      pro: [
        { t: 'Личные встречи 4–1, на харде 2–1', src: 'база матчей (архив ATP)' },
        { t: 'Лучший прием в туре: 43% выигранных очков на приеме против 37% у Рублева', src: 'база матчей (архив ATP)' },
        { t: 'Против топ-10 за 52 недели у Рублева 4–11 (27%), у Джоковича 7–7', src: 'база матчей (архив ATP)' },
      ],
      con: [
        { t: 'Джоковичу 39; в 1/32 (4 окт) он провел на корте 2 ч 38 мин в трех сетах, а на следующий день сыграл еще матч', src: 'новости: atptour.com, 4–5 окт' },
        { t: 'Рублев выиграл оба матча в Шанхае без потери сета: у Бублика (№18) — два тай-брейка, у Корды (№31) — 6:2 6:4', src: 'новости: atptour.com, 4–5 окт' },
      ],
    },
  ];
  // Рейтинга ATP в базе нет: место по Эло среди игроков с матчами за 52 недели считает код
  MX.forEach(m => m.cmp.unshift({ label: 'Место по Эло', l: '№' + D.P[m.a].eloPlace, r: '№' + D.P[m.b].eloPlace, better: D.P[m.a].eloPlace < D.P[m.b].eloPlace ? 'l' : 'r' }));
  MX.forEach(m => { m.info = D.matchesToday.find(x => x.id === m.id); m.A = D.P[m.a]; m.B = D.P[m.b]; });

  // ---------- рынки матча (Р28) ----------
  // Победа и фора ±1.5 — прежние коды; новые рынки — семейство, сторона и линия (DATA.fresh). У каждого рынка статус:
  // в экспрессе (П1/П2), на проверке (фора ±1.5 — модель сетов может завышать третий сет), для сравнения (новые рынки,
  // пока не наберется 150–200 событий и CLV не покажет перевес). Экспресс и варианты ставки берут только разрешенные рынки
  const F = D.fresh;
  const MK = {
    p1: { label: 'П1', line: '—', desc: m => m.A.short + ' выигрывает матч', who: 'A' },
    p2: { label: 'П2', line: '—', desc: m => m.B.short + ' выигрывает матч', who: 'B' },
    h1m: { label: 'Ф1(−1.5)', line: '−1.5', desc: m => m.A.short + ' выигрывает 2:0', who: 'A' },
    h2p: { label: 'Ф2(+1.5)', line: '+1.5', desc: m => m.B.short + ' берет хотя бы сет', who: 'B' },
  };
  const PAIR = { p1: 'p2', p2: 'p1', h1m: 'h2p', h2p: 'h1m' };
  function noVig(odds, k) { const a = 1 / odds[k], b = 1 / odds[PAIR[k]]; return a / (a + b); }
  const gamesW = n => n + ' ' + fmt.plural(n, 'гейм', 'гейма', 'геймов');
  function freshDesc(m, leg) {
    const L = leg.line, abs = Math.abs(L), whole = Number.isInteger(L);
    const who = (leg.sel === 2 ? m.B : m.A).short;
    if (leg.market === 'gtot') {
      if (leg.sel === 1) return whole ? 'больше ' + gamesW(abs) + ', ровно ' + abs + ' — возврат' : gamesW(Math.ceil(abs)) + ' и больше';
      return whole ? 'меньше ' + gamesW(abs) + ', ровно ' + abs + ' — возврат' : gamesW(Math.floor(abs)) + ' и меньше';
    }
    if (leg.market === 'stot') return leg.sel === 1 ? (abs === 2.5 ? 'три сета' : 'сетов ' + Math.ceil(abs) + ' и больше') : (abs === 2.5 ? 'два сета: 2:0 или 0:2' : 'сетов ' + Math.floor(abs) + ' и меньше');
    if (leg.market === 'shcp') return L < 0 ? who + ' выигрывает 3:0' : who + ' берет хотя бы сет';
    if (L < 0) return who + ' выигрывает с разницей ' + (whole ? 'больше ' + gamesW(abs) + ', ровно ' + abs + ' — возврат' : 'от ' + gamesW(Math.ceil(abs)));
    return whole ? who + ' выигрывает или уступает меньше ' + gamesW(abs) + ', ровно ' + abs + ' — возврат' : who + ' выигрывает или уступает не больше ' + gamesW(Math.floor(abs));
  }
  function marketRows(m) {
    const base = ['p1', 'p2', 'h1m', 'h2p'].map(k => {
      const pp = k === 'p1' || k === 'p2' ? m.probs.p1 : m.probs.h1m;
      const inv = k === 'p2' || k === 'h2p';
      const model = inv ? 1 - pp[0] : pp[0], claude = inv ? 1 - pp[1] : pp[1];
      const odds = m.odds[k];
      const player = MK[k].who === 'A' ? m.A : m.B;
      const leg = { p1: m.a, p2: m.b, market: k };
      return { k, m, leg, group: k === 'p1' || k === 'p2' ? 'ml' : 'h15', status: F.statusOf(leg), name: player.short + ' ' + MK[k].label, line: MK[k].line, desc: MK[k].desc(m), model, claude, market: noVig(m.odds, k), odds, push: 0, value: claude * odds - 1, edited: odds !== m.info.odds[k], baseOdds: m.info.odds[k] };
    });
    const extra = m.extra.flatMap((x, i) => {
      const f = F.FAMILY[x.market], push = x.push || 0, cur = m.xodds[i];
      const a = 1 / cur[0], b = 1 / cur[1];
      return [1, 2].map(sel => {
        const pp = sel === 1 ? x.p : [1 - x.p[0] - push, 1 - x.p[1] - push];
        const leg = { p1: m.a, p2: m.b, market: x.market, sel, line: f.hcp && sel === 2 ? -x.line : x.line };
        const odds = cur[sel - 1];
        return { k: x.market + '_' + x.line + '_' + sel, m, leg, group: x.market + '_' + x.line, x, status: F.statusOf(leg), name: F.legLabel(leg), line: F.lineText(leg.line, f.hcp), desc: freshDesc(m, leg), model: pp[0], claude: pp[1], market: (sel === 1 ? a : b) / (a + b) * (1 - push), odds, push, value: pp[1] * odds + push - 1, edited: odds !== x.odds[sel - 1], baseOdds: x.odds[sel - 1] };
      });
    });
    return base.concat(extra);
  }
  const allowed = r => r.status.status === 'express';
  // почему исход не в экспрессе — считается от кэфов, которые реально пришли (в том числе исправленных вами)
  function outOfRules(r) {
    const out = [];
    if (r.odds > STRAT.oddsMax) out.push('кэф выше ' + fmt.odds(STRAT.oddsMax));
    if (r.odds < STRAT.oddsMin) out.push('кэф ниже ' + fmt.odds(STRAT.oddsMin));
    if (r.claude * 100 < STRAT.minProb) out.push('p ниже ' + STRAT.minProb + '%');
    return out;
  }
  const inExpress = r => LEGS.some(l => l.row === r);
  function noteFor(r) {
    if (inExpress(r)) return null;
    if (r.status.status !== 'express') return null; // статус рынка — на заголовке группы
    if (r.value < 0) return 'Отрицательный валуй';
    const out = outOfRules(r);
    if (out.length) return 'Вне правил стратегии: ' + out.join(', ');
    const pick = r.m.pickRow;
    if (!pick || !LEGS.length) return 'Проходит правила, но экспресс не собран';
    if (r.value > pick.value) return 'С этим кэфом перевес выше, чем у ' + pick.name + ' — в приложении ИИ пересмотрел бы выбор';
    if (r.value < 0.05) return 'Перевес меньше 5% — ' + pick.name + ' выгоднее';
    return 'Проходит правила, но ' + pick.name + ' выгоднее';
  }
  // статус рынка — на заголовке группы строк
  function statusChip(st) {
    if (st.status === 'express') return chip('идет в экспресс', 'outline', 'ticket');
    if (st.status === 'paused') { const c = chip('на проверке · временно не в экспрессе', 'warn', 'flask'); c.title = st.why; return c; }
    const c = chip('для сравнения · ' + st.n + ' из ' + F.NEED, 'info', 'flask');
    c.title = 'Модель по рынку не проверена: в архиве нет его кэфов. В экспресс рынок пойдет, когда наберется ' + F.NEED + '–' + F.NEED_MAX + ' событий и CLV покажет перевес';
    return c;
  }
  function groupTitle(r) {
    if (!r.x) return r.status.label;
    const f = F.FAMILY[r.x.market];
    return f.label + (f.hcp ? ': ' + r.m.A.short + ' ' + F.lineText(r.x.line, true) : ' ' + r.x.line);
  }

  // ---------- запрос с экрана «Новый анализ» и все, что от него зависит ----------
  // DATA.pendingAnalysis: события, режим, модель, кэфы, банк, букмекер, оценка цены. Без него (прямая ссылка) — пример как есть.
  let REQ, MODE, BK, BANK, FOREIGN, ODDS_EDITED, EST, ID;
  let STEPS, TOTAL_MS, TOTAL, NO_AI, MODELS;
  let LEGS, TOTAL_ODDS, P_EXP, EV, BASE_PCT, BAND, CAL, P_CAL;
  let VARIANTS = [], VST = {};  // Р29: варианты ставки (экспресс и ординары) и их состояние (сумма, кэфы при ставке, решение)
  const SLIP = [];              // Р29: своя ставка — { row } по одному рынку на матч
  let reqCount = 0;
  const nm = x => (D.P[x] ? D.P[x].short : String(x || '—'));
  // ---------- валюта программы (Р17) ----------
  // BANK, суммы ставок и DATA — в рублях демо-данных, на экране — валюта программы. Сумму считаем в валюте программы
  // с ее шагом (10 рублей или 1 цент), поэтому доля банка и выплата сходятся в любой валюте.
  const curDec = () => (UI.currency.list[UI.currency.code] || { dec: 0 }).dec;
  const STEP = () => (curDec() ? 0.01 : 10);                          // шаг суммы ставки в валюте программы
  const MIN_CUR = () => (curDec() ? 0.5 : 50);                        // минимальная ставка в валюте программы
  const roundCur = x => { const k = 10 ** curDec(); return Math.round(x * k) / k; };
  const toStep = x => roundCur(Math.round(x / STEP()) * STEP());
  const inCur = rub => fmt.moneyNum(rub);                             // рубли демо-данных → сумма как на экране
  const sameMoney = (a, b) => inCur(a) === inCur(b);
  const curName = () => UI.currency.label.charAt(0).toLowerCase() + UI.currency.label.slice(1); // «евро», «доллары США»
  const stakeAt = pct => fmt.fromMoney(toStep(inCur(BANK) * pct / 100)); // сумма для доли банка, в рублях демо-данных
  // «Кэф при ставке» по ногам: по умолчанию кэф из ввода; участник правит его в окнах суммы и сохранения ставки
  const takenOdds = () => ST.taken || LEGS.map(l => l.odds);
  const totalOf = arr => Math.round(arr.reduce((a, x) => a * x, 1) * 100) / 100;
  const curTotal = () => totalOf(takenOdds());
  const payoutOf = (rub, total) => fmt.fromMoney(roundCur(inCur(rub) * (total || curTotal()))); // выплата = сумма × итоговый кэф при ставке
  const REC = () => (BASE_PCT ? stakeAt(BASE_PCT) : 0);               // рекомендованная сумма по таблице стратегии
  const calibBin = p => D.calibration.find(b => p >= b.lo && p < b.hi);

  // кэфы этого матча из запроса; если игроки введены в обратном порядке — разворачиваем рынки
  function userOdds(req, m) {
    if (!req || !Array.isArray(req.events)) return null;
    for (const e of req.events) {
      const o = e.odds || {};
      // Р28: другие рынки — список { market, line, o1, o2 }; у фор линия со стороны игрока 1
      const ex = e.extra || [];
      if (e.p1 === m.a && e.p2 === m.b) return { p1: o.p1, p2: o.p2, h1m: o.h1m, h2p: o.h2p, extra: ex };
      if (e.p1 === m.b && e.p2 === m.a) return { p1: o.p2, p2: o.p1, h1m: o.h2m, h2p: o.h1p, extra: ex.map(x => F.FAMILY[x.market].hcp ? Object.assign({}, x, { line: -x.line, o1: x.o2, o2: x.o1 }) : x) };
    }
    return null;
  }

  // Время последнего прогона новостей и оценки, которые можно взять повторно (состояние «Оценка из прошлого анализа»)
  const REUSED_FROM = { id: 'A-0141', at: '09:12' };
  // Досье считает код по матчам в базе — те же форма, последний матч и нагрузка, что в карточке игрока
  // (DATA.playerBase из players.js). Архив в демо не обновлялся с 3 окт: Шанхая в базе нет, о нем Claude знает из новостей.
  const formOf = id => (D.playerBase ? D.playerBase.form(id) : D.P[id].form);
  // результаты в базе — по день до последней загрузки архива (как в players.js)
  const ARCH_AT = () => (D.archive ? D.archive.lastLoad : D.today + 'T04:10');
  const ARCHIVE_TO = () => new Date(Date.parse(ARCH_AT().slice(0, 10) + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  function baseRows() {
    const PB = D.playerBase;
    MX.forEach(m => {
      if (!PB) { m.fresh = m.news; return; }
      const last = id => { const x = PB.last(id); return D.P[id].short + ' — ' + (x ? fmt.date(x.date) + ', ' + x.event : 'нет'); };
      m.fresh = 'матчи в базе по ' + fmt.date(PB.archiveTo) + ' (последний: ' + last(m.a) + '; ' + last(m.b) + ') · ' + m.news;
      const row = m.cmp.find(r => r.m14);
      if (!row) return;
      const l = PB.m14(m.a), r = PB.m14(m.b);
      Object.assign(row, { l: String(l), r: String(r), ls: 'в базе', rs: 'в базе', better: l <= r ? 'l' : 'r' });
    });
    const row = MX[0].cmp.find(r => r.m14);
    if (row) { row.ls = 'в базе; Шанхай — по новостям'; row.rs = row.ls; }
  }
  function buildSteps() {
    const price = MODE.price;
    const c1 = (AI.prefix * price.write + AI.dossier * price.in + AI.out1 * price.out) / 1e6;
    const c2 = (AI.prefix * price.read + AI.dossier * price.in + AI.out2 * price.out) / 1e6;
    const m1 = MX[0], m2 = MX[1];
    const adj = (m, k, lbl) => { const r = m.rows.find(x => x.k === k); return m.A.short + ' ' + lbl + ': ' + pr(r.model) + ' → ' + pr(r.claude); };
    const reused = SCEN.id === 'reused';
    const newsFail = SCEN.id === 'news';
    const steps = [
      { kind: 'parse', title: 'Разбор событий', model: 'Haiku 5.5', sec: 3, tokens: PARSE.tokens, cost: PARSE.cost, dur: 400,
        detail: '2 матча, 8 рынков (16 исходов), кэфы ' + BK + (ODDS_EDITED ? ' с вашими правками' : ' на 09:39') + ' · выполнен до запуска',
        live: ['Синнер — Руне: П1/П2, фора ±1.5 по сетам, тотал геймов 22.5, фора по геймам −4.5', 'Джокович — Рублев: П1/П2, фора ±1.5 по сетам, тотал сетов 2.5, тотал геймов 22'] },
      { kind: 'players', title: 'Проверка базы игроков', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
        detail: 'Все четыре игрока есть в базе · результаты в базе по ' + fmt.date(ARCHIVE_TO()) + ' (архив не обновлялся с ' + fmt.date(ARCH_AT().slice(0, 10)) + ')',
        live: ['Синнер, Руне, Джокович, Рублев — найдены', 'Архив матчей загружен ' + fmt.date(ARCH_AT().slice(0, 10)) + ': свежие матчи — из новостей'] },
      reused
        ? { kind: 'news', match: 0, title: 'Новости: Синнер — Руне', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
          detail: 'Из кэша: найдены в анализе #' + REUSED_FROM.id + ' в ' + REUSED_FROM.at + ', моложе 12 ч',
          live: ['Синнер — 04:10, Руне — ' + REUSED_FROM.at, 'Новых травм и снятий нет'] }
        : newsFail
          ? { kind: 'news', match: 0, title: 'Новости: Синнер — Руне', model: 'Sonnet 5.5 + поиск', sec: 21, tokens: 6200, cost: 0.019, searches: 1, dur: 900, warn: 'Новости не получены: поиск не ответил. Анализ идет без свежих новостей Руне',
            detail: 'Новости Синнера — из кэша (04:10) · Руне: поиск не ответил, повтор не помог',
            live: ['Синнер — из кэша, 04:10', 'Руне: поиск не ответил', 'Идем дальше без свежих новостей Руне'] }
          : { kind: 'news', match: 0, title: 'Новости: Синнер — Руне', model: 'Sonnet 5.5 + поиск', sec: 24, tokens: 9800, cost: 0.046, searches: 2, dur: 900,
            detail: 'Синнер — из кэша (04:10) · Руне — 2 запроса (atptour.com, tennis.com), effort low · найдено: 1/16 финала с Тиафо, слух о плече без подтверждения',
            live: ['Синнер — из кэша, моложе 12 ч', 'Руне: atptour.com — 5 окт, 1/16 финала, 4:6 6:3 6:4 с Тиафо', 'Слух о плече из соцсетей без подтверждения — по L-019 не учитываем'] },
      { kind: 'news', match: 1, title: 'Новости: Джокович — Рублев', model: null, sec: 1, tokens: 0, cost: 0, dur: 250,
        detail: 'Из кэша: найдены в анализах других участников, моложе 12 ч — повторный поиск не нужен',
        live: ['Джокович — 02:30, Рублев — 6 окт 21:50', 'Новых травм и снятий нет'] },
      { kind: 'dossier', title: 'Досье матчей', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
        detail: 'Эло на харде, форма, подача и прием за 52 недели, личные встречи, нагрузка за 14 дней, новости — из базы, считает код',
        live: ['Синнер — Руне: 64 и 71 матч за 2 сезона', 'Джокович — Рублев: 41 и 77 матчей'] },
      { kind: 'model', title: 'Расчет ML-модели: Эло и калибровка', model: null, sec: 1, tokens: 0, cost: 0, dur: 300,
        detail: 'Вероятности победы, форы −1.5, тоталов и фор по сетам и геймам по 2 матчам · формула, без ИИ',
        live: ['Эло на харде с калибровкой Платта', 'Вероятность 2:0 — по модели сетов', 'Геймы — цепь «очко → гейм → сет → матч» с привязкой к Эло'] },
      reused
        ? { kind: 'claude', match: 0, title: 'Claude: Синнер — Руне', model: null, sec: 0, tokens: 0, cost: 0, dur: 300, reused: true,
          detail: 'Досье матча не изменилось — валуй пересчитан по вашим кэфам',
          live: ['Досье то же, что в анализе #' + REUSED_FROM.id, 'Валуй пересчитан по вашим кэфам'] }
        : { kind: 'claude', match: 0, title: 'Claude: Синнер — Руне', model: MODE.model, sec: 26, tokens: AI.prefix + AI.dossier + AI.out1, cost: c1, dur: 900,
          detail: adj(m1, 'h1m', '2:0') + ' · один вызов без веб-поиска, инструкции записаны в кэш',
          live: ['Читает досье матча и 3 урока', 'Сверяет новости Руне с уроком L-019', 'Поправка: ' + m1.A.short + ' 2:0 ' + ppDelta(m1.rows[2].claude - m1.rows[2].model)] },
      reused
        ? { kind: 'claude', match: 1, title: 'Claude: Джокович — Рублев', model: null, sec: 0, tokens: 0, cost: 0, dur: 300, reused: true,
          detail: 'Досье матча не изменилось — валуй пересчитан по вашим кэфам',
          live: ['Досье то же, что в анализе #' + REUSED_FROM.id, 'Валуй пересчитан по вашим кэфам'] }
        : { kind: 'claude', match: 1, title: 'Claude: Джокович — Рублев', model: MODE.model, sec: 21, tokens: AI.prefix + AI.dossier + AI.out2, cost: c2, dur: 800,
          detail: adj(m2, 'p1', 'П1') + ' · инструкции прочитаны из кэша — вход на 85% дешевле',
          live: ['Читает досье матча', 'Возраст и нагрузка Джоковича против приема', 'Поправка: ' + m2.A.short + ' П1 ' + ppDelta(m2.rows[0].claude - m2.rows[0].model)] },
      { kind: 'compose', title: 'Экспресс и сумма по стратегии', model: null, sec: 1, tokens: 0, cost: 0, dur: 450,
        detail: 'Стратегия ' + STRAT_V + ' · ' + (LEGS.length ? 'отобраны ' + LEGS.length + ' события' : 'экспресс не собран') + ' по П1/П2 — фора ±1.5 на проверке, новые рынки для сравнения · ординары и сумма по таблице банка',
        live: ['Фильтр: p ≥ ' + STRAT.minProb + '%, кэф ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax) + ', один рынок на матч', 'Варианты ставки: экспресс и ординары'] },
    ];
    // Разбор выполнен еще при создании анализа: в ходе анализа он сразу показан выполненным
    steps[0].pre = true;
    return steps;
  }

  // ---------- состояния для согласования (в приложении их нет — это реальные исходы анализа) ----------
  // stop — шаг, на котором анализ останавливается: индекс шага, код ошибки (errors.* на сервере), текст и что можно сделать.
  const SCENARIOS = [
    { id: 'ok', label: 'Обычный ход' },
    { id: 'news', label: 'Новости не получены — анализ продолжается' },
    { id: 'reused', label: 'Оценка Claude из прошлого анализа' },
    // Р29: экспресс не собран — вместо «Экспресса нет» варианты ставки; кэфы победы подменены
    { id: 'noexp', label: 'Экспресса стратегии нет: правила прошло одно событие', odds: { m2: { p1: 1.22, p2: 4.70 } } },
    { id: 'novalue', label: 'Валуя нет ни на одном рынке', odds: { m1: { p1: 1.12, p2: 7.00 }, m2: { p1: 1.22, p2: 4.70 } } },
    { id: 'offline', label: 'Связь прервалась и восстановилась' },
    { id: 'fail', label: 'Сбой шага и перезапуск', stop: { at: 7, code: 'ai.overloaded', reason: 'Claude сейчас перегружен (ответ 529). Перезапустите анализ через несколько минут', restart: true } },
    // Тексты лимита и потолка зависят от того, кто смотрит (stopInfo): администратор, участник на ключе
    // администратора или на своем ключе
    { id: 'limit', label: 'Лимита месяца не хватает на следующий вызов Claude', stop: { at: 7, code: 'ai.monthly_limit', restart: false } },
    { id: 'cap', label: 'Потолок анализа', stop: { at: 7, code: 'ai.analysis_cap', restart: false } },
    { id: 'keyown', label: 'Свой ключ перестал работать (вид участника на своем ключе)', stop: { at: 2, code: 'ai.key_rejected', reason: 'Anthropic не принял ваш ключ: он отозван или неверный. Анализы на вашем ключе остановлены', restart: true, link: ['Ключ Claude в личном кабинете', '#profile-key'] } },
    { id: 'keyadmin', label: 'Ключ администратора перестал работать', stop: { at: 2, code: 'ai.key_rejected', reason: 'Ключ Claude администратора перестал работать. Мы сообщили администратору — перезапустите анализ, когда он заменит ключ', restart: true } },
    { id: 'cancel', label: 'Анализ отменен', stop: { at: 4 } },
  ];
  let SCEN = SCENARIOS[0];
  // анализ из «Последних анализов», у которого в макете нет своего разбора: показываем демо-пример с пометкой
  let OPENED = null;

  function setup(req) {
    REQ = req || null;
    if (REQ) reqCount++;
    ID = 'A-' + String(142 + Math.max(0, reqCount - 1)).padStart(4, '0');
    D.currentAnalysis = ID;
    MODE = MODES[REQ && REQ.mode] || MODES.precise;
    BK = (REQ && REQ.bookmaker) || (D.user.bookmakers || [])[0] || 'bet365';
    BANK = REQ && REQ.bank > 0 ? REQ.bank : D.stats.bank;
    const evs = REQ && Array.isArray(REQ.events) ? REQ.events : [];
    // кэфы и рынки
    MX.forEach(m => {
      const u = userOdds(REQ, m) || {};
      // демо-состояния «Экспресса нет» и «Валуя нет» подменяют кэфы победы (в приложении это просто другие кэфы)
      const base = m.base = Object.assign({}, m.info.odds, SCEN.odds && SCEN.odds[m.id]);
      m.entered = !!userOdds(REQ, m);
      m.odds = {};
      ['p1', 'p2', 'h1m', 'h2p'].forEach(k => { m.odds[k] = !(SCEN.odds && SCEN.odds[m.id]) && u[k] > 1 ? u[k] : base[k]; });
      m.xodds = m.extra.map(x => { const e = (u.extra || []).find(y => y.market === x.market && y.line === x.line); return [e && e.o1 > 1 ? e.o1 : x.odds[0], e && e.o2 > 1 ? e.o2 : x.odds[1]]; });
      m.rows = marketRows(m);
      // выбор стратегии: разрешенный рынок, который проходит правила, с наибольшим валуем
      const cands = m.rows.filter(r => allowed(r) && !outOfRules(r).length && r.value > 0).sort((a, b) => b.value - a.value);
      m.pickRow = cands[0] || null;
      const byVal = (a, b) => b.value - a.value;
      m.bestRow = m.pickRow || m.rows.filter(r => allowed(r) && r.claude >= 0.5).sort(byVal)[0] || m.rows.filter(allowed).sort(byVal)[0];
    });
    // экспресс стратегии — из 2+ матчей, по одному рынку на матч; прошло меньше двух — экспресса нет (Р29: есть варианты)
    const picked = MX.filter(m => m.pickRow);
    LEGS = (picked.length >= 2 ? picked : []).map(m => ({ p1: m.a, p2: m.b, market: m.pickRow.k, marketLabel: MK[m.pickRow.k].label, odds: m.pickRow.odds, p: m.pickRow.claude, surface: 'hard', tournament: 'Шанхай', row: m.pickRow, m }));
    MX.forEach(m => m.rows.forEach(r => { r.note = noteFor(r); r.pick = inExpress(r); }));
    VARIANTS = buildVariants();
    SLIP.length = 0; VST = {};
    const reused = SCEN.id === 'reused', newsFail = SCEN.id === 'news';
    MX[0].confNote = newsFail ? 'Свежих новостей Руне нет: поиск не ответил' : 'Слух о плече Руне не подтвержден';
    MX[0].news = 'новости Синнера 04:10, Руне — ' + (newsFail ? 'не получены' : reused ? REUSED_FROM.at : 'найдены в этом анализе');
    baseRows();
    MX.forEach(m => { m.reused = reused; });
    FOREIGN = !!REQ && !(evs.length === MX.length && MX.every(m => m.entered));
    ODDS_EDITED = MX.some(m => m.entered && m.rows.some(r => r.edited));
    // шаги и итоги запуска
    STEPS = buildSteps();
    TOTAL_MS = STEPS.reduce((a, s) => a + s.dur, 0);
    TOTAL = { sec: STEPS.reduce((a, s) => a + s.sec, 0), tokens: STEPS.reduce((a, s) => a + s.tokens, 0), cost: STEPS.reduce((a, s) => a + s.cost, 0), searches: STEPS.reduce((a, s) => a + (s.searches || 0), 0) };
    NO_AI = STEPS.filter(s => !s.model).length;
    MODELS = ['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5'].filter(x => STEPS.some(s => s.model && s.model.startsWith(x)));
    // оценка цены, которую вы видели перед запуском: для своих событий — из запроса; для чужих событий сравнивать не с чем
    EST = REQ && !FOREIGN && REQ.estimate && REQ.estimate.cost > 0 ? REQ.estimate.cost : null;
    // экспресс и сумма — по кэфам, которые реально пришли
    TOTAL_ODDS = Math.round(LEGS.reduce((a, l) => a * l.odds, 1) * 100) / 100;
    P_EXP = LEGS.reduce((a, l) => a * l.p, 1);
    EV = P_EXP * TOTAL_ODDS - 1;
    BASE_PCT = LEGS.length ? bandPct(TOTAL_ODDS) : 0;
    BAND = !LEGS.length ? null : TOTAL_ODDS <= 1.70 ? STRAT.stakeTable[0] : TOTAL_ODDS <= 2.20 ? STRAT.stakeTable[1] : TOTAL_ODDS <= STRAT.totalMax ? STRAT.stakeTable[2] : null;
    CAL = LEGS.map(l => calibBin(l.p));
    P_CAL = CAL.every(Boolean) ? CAL.reduce((a, b) => a * b.actual, 1) : null;
  }
  // доля банка по итоговому кэфу — середина диапазона из таблицы стратегии
  function bandPct(total) { return total <= 1.70 ? 2.75 : total <= 2.20 ? 2.25 : total <= STRAT.totalMax ? 1.75 : 0; }

  // ---------- адаптации суммы (Р22: правил серий нет) — те же, что в «Личном кабинете → Банк и стратегия» ----------
  const S0 = D.stats;
  const DD = Math.min(0, (S0.bank - S0.peak) / S0.peak * 100);           // просадка от пика, %
  const GROWTH = (S0.bank - S0.start) / S0.start * 100;                 // рост банка к стартовому, %
  const WEEK_BASE = D.bankHistory.filter(x => x.date <= addDaysIso(TODAY, -7)).pop() || D.bankHistory[0];
  const WEEK = (S0.bank - WEEK_BASE.bank) / WEEK_BASE.bank * 100;       // итог недели, %
  // В7: правила включены или выключены — как в DATA.strategy.adapt («рост банка» и «прибыльная неделя» по умолчанию выключены)
  const RULE_ON = key => { const r = (STRAT.adapt || []).find(x => x.key === key); return !r || r.on; };
  const GROWTH_ON = RULE_ON('up15') && GROWTH >= 15 && S0.winrate >= 60; // потолок доли 4% вместо 3%
  function addDaysIso(iso, n) { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  // now — сейчас, active — что правило делает с суммой (null — не действует); выключенные правила в расчет не входят
  function adaptRows() {
    return [
      { now: 'просадка от пика ' + fmt.signedPct(DD), active: RULE_ON('dd20') && DD <= -20 ? 'защитный режим: 1,5% банка, 2 события до 1.50' : RULE_ON('dd10') && DD <= -10 ? 'не больше 2,5% банка' : null },
      { now: 'банк ' + fmt.signedPct(GROWTH) + ' к старту при винрейте ' + fmt.pct(S0.winrate) + (RULE_ON('up15') ? '' : ' (правило роста выключено)'), active: GROWTH_ON ? 'потолок 4% вместо 3%' : null },
      { now: 'за 7 дней ' + fmt.signedPct(WEEK), active: RULE_ON('week_loss') && WEEK <= -5 ? 'не больше 2% банка' : RULE_ON('week_win') && WEEK >= 10 ? '+0,5 п.п. к доле' : null },
    ];
  }

  // ---------- состояние ----------
  // stopped — анализ остановлен: { kind: 'error' | 'cancel', at: индекс шага, ... }; attempt — номер запуска
  // (перезапуск после сбоя продолжает с упавшего шага); offlineFrom/offlineUntil — демо потери связи.
  const RUN = { startedAt: null, done: false, focusResult: false, stopped: null, attempt: 1, offlineFrom: null, offlineUntil: null, offlineDone: false };
  // Завершенный анализ записывается в расход один раз (DATA.ai.recordRun): тогда «анализов сегодня», расход и бюджет
  // обновятся на других экранах. Пример по прямой ссылке (без запроса) уже учтен в данных — его не записываем.
  // Повторный показ хода и перерисовки запись не повторяют.
  const recorded = new WeakSet();
  function record(req, user, cost) {
    if (!req || recorded.has(req) || !user) return;
    recorded.add(req);
    D.ai.recordRun(user, Math.round(cost * 1000) / 1000);
  }
  // анализ идет на сервере и без открытого экрана: запись по таймеру, даже если вы ушли на другую страницу
  function scheduleRecord() {
    RUN.by = D.me; // кто запустил: запись идет ему, даже если демо-роль сменили во время анализа
    if (!REQ || recorded.has(REQ)) return;
    const req = REQ, user = RUN.by, cost = TOTAL.cost;
    // остановленный или отмененный анализ в макете в расход не записываем
    setTimeout(() => { if (!RUN.stopped) record(req, user, cost); }, Math.max(0, TOTAL_MS - (performance.now() - RUN.startedAt)));
  }
  // taken — «кэф при ставке» по ногам (по умолчанию кэф из ввода; участник может поправить перед сохранением)
  const ST = { stake: null, taken: null, decision: null, betId: null, whyOpen: null, stepsOpen: false, calcOpen: false, exampleAck: false, tab: { m1: 'probs', m2: 'probs' } };
  // Новый запуск — когда с экрана «Новый анализ» пришел новый запрос; возврат из «Ставок» показывает готовый результат
  function resetRun() {
    RUN.startedAt = null; RUN.done = false; RUN.stopped = null; RUN.attempt = 1;
    RUN.offlineFrom = null; RUN.offlineUntil = null; RUN.offlineDone = false;
    ST.decision = null; ST.stake = null; ST.taken = null; ST.betId = null; ST.exampleAck = false;
  }
  // Начало хода: разбор уже выполнен при создании анализа — анимация начинается со второго шага
  function startRun() {
    RUN.startedAt = performance.now() - (reduced() ? TOTAL_MS : STEPS[0].dur);
  }
  const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stake = () => (ST.stake == null ? REC() : ST.stake);

  // ---------- форматтеры ----------
  const pr = p => Math.round(p * 100) + '%';
  const ppDelta = d => { const v = Math.round(d * 100); return (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v) + ' п.п.'; };
  const usd3 = n => '$' + n.toFixed(3).replace('.', ',');
  const usdS = n => (n > 0 && n < 0.01 ? usd3(n) : fmt.usd(n)); // меньше цента — с тремя знаками ($0,001)
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
    /* решение остается на виду, пока читаете оба матча */
    /* только когда карточка целиком помещается в экран: при раскрытом расчете суммы она выше — тогда обычная прокрутка */
    /* Р29: вариантов ставки несколько — колонка длиннее экрана, поэтому без «прилипания» */

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
    .analysis-ptable th, .analysis-ptable td { padding: 9px 5px; }
    .analysis-ptable .analysis-val .chip { padding: 0 6px; font-size: 11px; }
    .analysis-ptable th:first-child, .analysis-ptable td:first-child { padding-left: 18px; }
    .analysis-ptable th:last-child, .analysis-ptable td:last-child { padding-right: 18px; }
    .analysis-ptable th { vertical-align: bottom; }
    .analysis-th-out { width: 32%; }
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

    /* этап 3: сбой шага, предупреждение, повтор оценки, отмена, потеря связи, демо-панель */
    .analysis-step .analysis-step-ic svg.ic-bad, .analysis-step .analysis-step-ic svg.ic-warn { display: none; }
    .analysis-step.is-failed .analysis-step-ic { background: var(--bad); border-color: var(--bad); color: var(--accent-fg); }
    .analysis-step.is-failed .analysis-step-ic svg.ic-bad { display: block; }
    .analysis-step.is-failed .analysis-step-n, .analysis-step.is-warn .analysis-step-n { display: none; }
    .analysis-step.is-warn .analysis-step-ic { background: var(--warn-soft); border-color: var(--warn); color: var(--warn-ink); }
    .analysis-step.is-warn .analysis-step-ic svg.ic-warn { display: block; }
    .analysis-step.is-warn::before { background: color-mix(in srgb, var(--accent) 45%, var(--line)); }
    .analysis-step.is-skipped .analysis-step-title > span:first-child { color: var(--fg-3); }
    .analysis-step.is-skipped .analysis-step-detail { display: none; }
    .analysis-step-fail { font-size: var(--fs-sm); color: var(--bad-ink); font-weight: 500; }
    .analysis-step.is-failed .analysis-step-detail { display: none; }
    .analysis-step-warn { font-size: var(--fs-sm); color: var(--warn-ink); font-weight: 500; }
    .analysis-step-note { font-size: var(--fs-xs); color: var(--accent-ink); font-weight: 500; }
    .analysis-step.is-pending .analysis-step-note { display: none; }
    .analysis-stop .analysis-stop-acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .analysis-stop .analysis-stop-acts .btn { max-width: 100%; }
    .analysis-stop-note { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-xs); margin-top: 8px; }
    .analysis-stop-note svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .analysis-offline { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--r-md); background: var(--warn-soft); color: var(--warn-ink); font-size: var(--fs-sm); font-weight: 500; }
    .analysis-offline .analysis-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid color-mix(in srgb, var(--warn-ink) 30%, transparent); border-top-color: var(--warn-ink); animation: analysis-rot .8s linear infinite; flex: none; }
    .analysis-demo { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 10px 12px; border: 1px dashed var(--warn); border-radius: var(--r-md); background: color-mix(in srgb, var(--warn-soft) 45%, var(--surface)); }
    .analysis-demo .field { flex: 1 1 260px; min-width: 0; margin: 0; }
    .analysis-demo .field-label { font-size: var(--fs-xs); }
    .analysis-demo-acts { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; max-width: 100%; }
    .analysis-demo-acts .btn { max-width: 100%; white-space: normal; height: auto; min-height: 40px; }
    @media (max-width: 720px) { .analysis-demo { flex-direction: column; align-items: stretch; } .analysis-demo .field { flex: none; } .analysis-demo .demo-pill { align-self: flex-start; } }
    .analysis-reused { align-self: flex-start; max-width: 100%; }
    .analysis-reused .chip { white-space: normal; height: auto; min-height: 24px; padding: 3px 9px; border-radius: var(--r-md); line-height: 1.35; max-width: 100%; }
    .analysis-reused .chip svg { flex: none; }
    .analysis-legodds { display: flex; flex-direction: column; gap: 8px; }
    .analysis-legodd { display: grid; grid-template-columns: minmax(0, 1fr) 112px; gap: 4px 12px; align-items: center; }
    .analysis-legodd .input { text-align: center; font-family: var(--font-mono); height: 40px; }
    .analysis-legodd-name { min-width: 0; font-size: var(--fs-sm); }
    .analysis-legodd-name b { display: block; font-weight: 600; }
    .analysis-legodd-name small { display: block; font-size: var(--fs-xs); color: var(--fg-3); }
    .analysis-legodd .field-error { grid-column: 1 / -1; }
    @media (max-width: 720px) { .analysis-legodd { grid-template-columns: minmax(0, 1fr) 96px; } .analysis-legodd .input { font-size: 16px; height: 44px; } }

    /* Р28: рынки по группам, линия, статус рынка */
    .analysis-ptable tr.analysis-grow th { padding: 12px 8px 6px 18px; text-align: left; background: var(--surface-2); border-top: 1px solid var(--line); text-transform: none; letter-spacing: 0; font-size: var(--fs-sm); }
    .analysis-ptable tr.analysis-grow th { display: table-cell; }
    .analysis-grow th > * { vertical-align: middle; }
    .analysis-gtitle { font-weight: 600; color: var(--fg); margin-right: 8px; }
    .analysis-line { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; color: var(--fg-2); }
    .analysis-ptable td.c, .analysis-ptable th.c { text-align: center; }
    .analysis-lghead { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; padding: 6px 0; }
    .analysis-lgroup .chip, .analysis-grow .chip { white-space: normal; height: auto; min-height: 22px; line-height: 1.3; }
    .analysis-note { color: var(--fg-3); }
    .analysis-slip-btn { align-self: flex-start; margin-top: 4px; min-height: 40px; padding-inline: 8px; margin-left: -8px; }
    .analysis-slip-btn.is-in { color: var(--accent-ink); }
    .analysis-pickline.is-off { background: var(--surface-2); color: var(--fg-2); }
    /* Р29: варианты ставки */
    .analysis-vars { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
    .analysis-vars-head h3 { font-size: var(--fs-xl); }
    .analysis-vars-head p { margin: 4px 0 0; }
    .analysis-exp.is-main { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .analysis-var .card-head { flex-wrap: nowrap; }
    .analysis-var .card-head > div:first-child { flex: 1 1 auto; }
    .analysis-var.is-novalue { border-style: dashed; }
    .analysis-why-line { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .analysis-why-line svg { width: 15px; height: 15px; flex: none; margin-top: 2px; color: var(--fg-3); }
    .analysis-why-line b { color: var(--fg); font-weight: 600; }
    .analysis-fresh-note { display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 12px; border: 1px dashed var(--line-strong); border-radius: var(--r-md); font-size: var(--fs-xs); color: var(--fg-2); }
    .analysis-fresh-note svg { width: 15px; height: 15px; flex: none; margin-top: 1px; color: var(--info-ink, var(--fg-3)); }
    .analysis-fresh-note b { color: var(--fg); }
    .analysis-slip { border-color: var(--warn); }
    .analysis-slip-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .analysis-slip-list li { display: flex; justify-content: space-between; gap: 10px; font-size: var(--fs-sm); }
    .analysis-slip-list li > span:first-child { min-width: 0; display: flex; flex-direction: column; }
    .analysis-slip-list small { color: var(--fg-3); font-size: var(--fs-xs); }
    .analysis-bm-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 720px) { .analysis-bm-grid { grid-template-columns: minmax(0, 1fr); } }
    .analysis-legodd.has-rm { grid-template-columns: minmax(0, 1fr) 112px 40px; }
    .analysis-legodd.has-rm .btn { width: 40px; height: 40px; padding: 0; }
    @media (max-width: 720px) { .analysis-legodd.has-rm { grid-template-columns: minmax(0, 1fr) 88px 40px; } }
    .analysis-legodd-name .warn-text { display: block; font-size: var(--fs-xs); }
  `);

  // ---------- шапка экрана ----------
  function modeChip() {
    const c = chip('Режим «' + MODE.label + '» · ' + MODE.model, MODE.id === 'precise' ? 'outline' : 'warn', MODE.id === 'precise' ? 'spark' : 'alert');
    c.title = MODE.id === 'precise' ? 'Режим для решения о ставке' : MODE.id === 'eco' ? 'Черновая оценка — не для решения о ставке' : 'Качество режима на eval-наборе еще не проверено';
    return c;
  }
  // state: 'running' | 'done' | 'stopped' | 'cancelled'
  function headBlock(state) {
    const tm = MX[0].info, done = state === 'done';
    const how = MODE.news ? 'Claude поправил их по свежим новостям' : 'Claude (' + MODE.model + ') поправил их по сохраненным досье, без поиска свежих новостей';
    const n = MX.length + ' ' + fmt.plural(MX.length, 'матча', 'матчей', 'матчей');
    const nv = VARIANTS.length;
    const title = done
      ? LEGS.length ? (FOREIGN ? 'Пример: экспресс' : 'Экспресс') + ' из ' + LEGS.length + ' событий · кэф ' + fmt.odds(TOTAL_ODDS)
        : (FOREIGN ? 'Пример: экспресса' : 'Экспресса') + ' стратегии нет · ' + nv + ' ' + fmt.plural(nv, 'вариант', 'варианта', 'вариантов') + ' ставки'
      : state === 'stopped' ? 'Анализ ' + n + ' остановлен'
        : state === 'cancelled' ? 'Анализ ' + n + ' отменен'
          : (FOREIGN ? 'Пример: анализ ' + n : 'Анализирую ' + MX.length + ' ' + fmt.plural(MX.length, 'матч', 'матча', 'матчей'));
    const lead = done
      ? 'ML-модель посчитала вероятности, ' + how + ', стратегия ' + STRAT_V + ' отобрала рынки и сумму. Варианты ставки — рядом, решение за вами.'
      : state === 'stopped' ? 'Результата пока нет. Что случилось и что можно сделать — ниже.'
        : state === 'cancelled' ? 'Вы отменили анализ. Результата нет.'
          : 'Шаги идут по порядку: сначала дешевые проверки и формулы, дорогая модель — только там, где она нужна.';
    return h('div', { class: 'page-head analysis-head' },
      h('div', null,
        h('div', { class: 'analysis-eyebrow' }, h('span', { class: 'eyebrow' }, fmt.dateFull(TODAY) + ' · ' + tm.tournament + ' · ' + tm.category), UI.surfaceChip('hard'), modeChip()),
        h('h2', { id: 'analysis-title', tabindex: '-1' }, title),
        h('p', { class: 'lead' }, lead)),
      button('Изменить события', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new', ro: true }));
  }

  // ---------- ход анализа ----------
  const stepStart = i => STEPS.slice(0, i).reduce((a, s) => a + s.dur, 0);
  // момент остановки текущего состояния (ошибка — на 35% шага, отмена — в начале шага)
  function stopTime() {
    const st = SCEN.stop;
    if (!st || RUN.attempt > 1) return null;
    return stepStart(st.at) + (SCEN.id === 'cancel' ? 0 : Math.round(STEPS[st.at].dur * 0.35));
  }
  function phaseAt(t) {
    let acc = 0;
    for (let i = 0; i < STEPS.length; i++) { if (t < acc + STEPS[i].dur) return { i, f: Math.max(0, (t - acc) / STEPS[i].dur) }; acc += STEPS[i].dur; }
    return { i: STEPS.length, f: 1 };
  }
  function stepMeta(s, f) {
    if (s.reused) return 'без новых затрат';
    const sec = Math.max(f > 0 ? 1 : 0, Math.round(s.sec * f));
    if (!s.tokens) return fmt.duration(sec) + ' · без токенов';
    const tk = Math.round(s.tokens * f / 100) * 100;
    return fmt.duration(sec) + ' · ' + fmt.int(tk) + ' ток. · ' + usd3(s.cost * f) + (s.searches && f >= 1 ? ' · ' + s.searches + ' ' + fmt.plural(s.searches, 'поиск', 'поиска', 'поисков') : '');
  }
  function modelChip(s) {
    if (s.reused) return chip('повтор оценки', 'info', 'history');
    return s.model ? chip(s.model, 'accent', 'spark') : chip('без ИИ', 'outline', 'database');
  }

  function stepEl(s, i) {
    const live = s.live.map(t => h('li', { hidden: true }, t));
    const meta = h('div', { class: 'analysis-step-meta' }, 'ожидает');
    const sr = h('span', { class: 'sr-only' }, 'ожидает');
    const extra = h('div');
    const el = h('li', { class: 'analysis-step is-pending' },
      h('span', { class: 'analysis-step-ic', 'aria-hidden': 'true' }, h('span', { class: 'analysis-step-n' }, String(i + 1)), icon('check'), icon('x', { class: 'ic-bad' }), icon('alert', { class: 'ic-warn' })),
      h('div', { class: 'analysis-step-main' },
        h('div', { class: 'analysis-step-title' }, h('span', null, s.title), modelChip(s), sr),
        h('div', { class: 'analysis-step-detail' }, s.detail),
        s.reused && h('div', { class: 'analysis-step-note' }, 'Оценка Claude из анализа #' + REUSED_FROM.id + ' в ' + REUSED_FROM.at + ', без новых затрат'),
        extra,
        h('ul', { class: 'analysis-live' }, live)),
      meta);
    let last = '';
    const SR = { done: ' — готово', active: ' — выполняется', failed: ' — не выполнен', warn: ' — выполнен с предупреждением', skipped: ' — не выполнялся', pending: ' — ожидает' };
    return {
      el,
      // status: pending | active | done | failed | skipped; warn у шага новостей превращает done в «выполнен с предупреждением»
      set(status, f, reason) {
        const shown = status === 'done' && s.warn ? 'warn' : status;
        if (shown !== last) {
          el.className = 'analysis-step is-' + shown;
          sr.textContent = SR[shown];
          UI.clear(extra);
          if (shown === 'failed') extra.appendChild(h('div', { class: 'analysis-step-fail' }, 'Не выполнен: ' + reason));
          if (shown === 'warn') extra.appendChild(h('div', { class: 'analysis-step-warn' }, s.warn));
          last = shown;
        }
        if (status === 'done') meta.textContent = stepMeta(s, 1);
        else if (status === 'active') {
          meta.textContent = stepMeta(s, f);
          live.forEach((li, k) => { li.hidden = f < k / live.length; li.classList.toggle('is-ok', f >= (k + 1) / live.length); });
        } else if (status === 'failed') meta.textContent = 'без токенов';
        else if (status === 'skipped') meta.textContent = 'не выполнялся';
        else meta.textContent = 'ожидает';
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
      h('span', null, 'Стоимость ', h('b', null, usdS(tot.cost))),
      withEst && EST != null && h('span', { title: estWhy() }, 'Оценка до запуска ', h('b', null, '≈' + fmt.usd(EST))));
  }
  // почему фактическая цена разошлась с оценкой на экране «Новый анализ»
  function estWhy() {
    if (EST == null) return '';
    const d = TOTAL.cost - EST;
    if (Math.abs(d) < 0.01) return 'Совпало с оценкой';
    if (SCEN.id === 'reused') return 'Дешевле оценки: оценки Claude взяты из анализа #' + REUSED_FROM.id + ', новые вызовы не понадобились';
    return d < 0 ? 'Дешевле оценки: новости Синнера, Джоковича и Рублева взяты из кэша, а оценка второго матча прочитала инструкции из кэша' : 'Дороже оценки: поиск новостей вернул длинные страницы';
  }

  // Отмена: сервер проверяет ее между шагами — шаг, который идет сейчас, доработает и будет оплачен, следующие
  // не запустятся. Остановка — на следующем шаге, с него и «Продолжить».
  const afterCurrent = ph => ({ i: Math.min(ph.i + 1, STEPS.length - 1), f: 0 });
  function cancelAnalysis(root, ph) {
    UI.modal({
      title: 'Отменить анализ?',
      body: h('div', { class: 'stack' },
        h('p', { class: 'small soft', style: 'margin:0' }, 'Шаг, который идет сейчас, доработает, следующие не запустятся. Вместе с ним будет потрачено ' + usdS(totalsAt(afterCurrent(ph)).cost) + ' — эти деньги не вернутся. Результата не будет.'),
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'События останутся в «Новом анализе» — их можно поправить и запустить снова.')),
      actions: close => [
        button('Продолжить анализ', { kind: 'secondary', onClick: close }),
        button('Отменить анализ', { kind: 'danger', icon: 'x', onClick: () => {
          close();
          const next = afterCurrent(phaseAt(performance.now() - RUN.startedAt)), tot = totalsAt(next);
          RUN.stopped = { kind: 'cancel', at: next.i, f: 0, cost: tot.cost, sec: tot.sec, tokens: tot.tokens };
          UI.toast('Анализ #' + ID + ' отменен', 'x');
          if (root.isConnected) draw(root);
        } }),
      ],
    });
  }

  function progressRunning(root) {
    const steps = STEPS.map(stepEl);
    const bar = h('i');
    const stepLabel = h('b');
    const nums = h('div');
    const offline = h('div', { 'aria-live': 'polite' });
    const live = h('p', { class: 'sr-only', 'aria-live': 'polite' });
    const cancel = button('Отменить анализ', { kind: 'ghost', size: 'sm', icon: 'x', onClick: () => cancelAnalysis(root, phaseAt(performance.now() - RUN.startedAt)), ro: true });
    const el = card({
      eyebrow: 'Анализ #' + ID + (RUN.attempt > 1 ? ' · попытка ' + RUN.attempt : ''),
      title: 'Claude разбирает ' + MX.length + ' ' + fmt.plural(MX.length, 'матч', 'матча', 'матчей') + (FOREIGN ? ' из примера' : ''),
      subtitle: RUN.attempt > 1 ? 'Продолжаем с упавшего шага — выполненные шаги повторно не оплачиваются' : 'Обычно 1–2 минуты · в макете ускорено до 5 секунд',
      actions: [cancel],
      body: [
        h('div', { class: 'analysis-prog-top' },
          h('div', { class: 'analysis-prog-bar', role: 'progressbar', 'aria-label': 'Ход анализа', 'aria-valuemin': '0', 'aria-valuemax': String(STEPS.length) }, bar),
          nums),
        offline,
        h('ol', { class: 'analysis-steps', 'aria-label': 'Шаги анализа' }, steps.map(s => s.el)),
        UI.callout('', 'info', NO_AI + ' из ' + STEPS.length + ' шагов идут без ИИ: проверка базы, новости из кэша, досье, базовая модель и правила стратегии. Статистику считает код по архиву ATP, веб-поиск — только новости. Платные токены — на разбор текста, поиск новостей и оценку каждого матча.'),
        live,
      ],
    });
    let lastI = -1, wasOffline = false;
    const stopT = stopTime();
    function paint(t) {
      const ph = phaseAt(t);
      steps.forEach((s, i) => s.set(i < ph.i ? 'done' : i === ph.i ? 'active' : 'pending', i === ph.i ? ph.f : 0));
      bar.style.width = (t / TOTAL_MS * 100).toFixed(1) + '%';
      bar.parentNode.setAttribute('aria-valuenow', String(ph.i));
      if (ph.i !== lastI) {
        lastI = ph.i;
        stepLabel.textContent = String(Math.min(ph.i + 1, STEPS.length));
        live.textContent = 'Шаг ' + (ph.i + 1) + ' из ' + STEPS.length + ': ' + (STEPS[ph.i] || STEPS[STEPS.length - 1]).title;
      }
      UI.clear(nums).appendChild(numsLine(totalsAt(ph), h('span', null, 'Шаг ', stepLabel, ' из ' + STEPS.length)));
    }
    function tick() {
      if (!el.isConnected || RUN.done || RUN.stopped) return;
      const now = performance.now();
      let t = now - RUN.startedAt;
      // демо «Связь прервалась»: поток событий молчит ~2,5 с, экран показывает, что переподключается
      if (SCEN.id === 'offline' && !RUN.offlineDone && RUN.offlineUntil == null && t >= TOTAL_MS * 0.45) { RUN.offlineFrom = t; RUN.offlineUntil = now + 2500; }
      if (RUN.offlineUntil != null) {
        if (now < RUN.offlineUntil) {
          t = RUN.offlineFrom;
          if (!wasOffline) {
            wasOffline = true;
            UI.clear(offline).appendChild(h('div', { class: 'analysis-offline', role: 'status' }, h('span', { class: 'analysis-spin', 'aria-hidden': 'true' }), 'Связь прервалась — обновляем… Анализ идет на сервере, ход подтянется сам'));
          }
          paint(t); setTimeout(tick, 120); return;
        }
        RUN.startedAt += 2500; RUN.offlineUntil = null; RUN.offlineDone = true; wasOffline = false;
        UI.clear(offline);
        UI.toast('Связь восстановлена: ход анализа обновлен', 'refresh');
        t = now - RUN.startedAt;
      }
      if (stopT != null && t >= stopT) { stopAt(root); return; }
      if (t >= TOTAL_MS) { finish(root); return; }
      paint(t);
      setTimeout(tick, 70);
    }
    // первый кадр синхронно — чтобы не было пустого состояния
    paint(Math.min(performance.now() - RUN.startedAt, stopT != null ? stopT : TOTAL_MS));
    setTimeout(tick, 0);
    return el;
  }

  // Лимит и потолок — по тому, кто смотрит (как DATA.ai.access): у администратора личного лимита нет, его анализы
  // ограничены общим бюджетом и жестким потолком программы ($1); участник на ключе администратора — своими лимитами,
  // которые поднимает администратор; на своем ключе — своим потолком и счетом в консоли Anthropic
  const usdL = n => fmt.usd(n, Number.isInteger(n) ? 0 : 2);
  function stopInfo(st) {
    const me = D.me, own = me.aiMode === 'own', admin = me.role === 'admin' && !own, L = D.ai.limitOf(me);
    if (SCEN.id === 'limit') {
      if (admin) return { code: 'ai.budget_exhausted', reason: 'Общего бюджета ключа администратора на месяц не хватает на следующий вызов Claude. Поднимите его в «Администрирование → Ключ и бюджет»', link: ['Ключ и бюджет', '#admin-key'], wait: 'Перезапуск станет доступен, когда бюджет позволит' };
      if (own) return { code: 'ai.billing', reason: 'На счете вашего ключа Claude закончились деньги или достигнут лимит трат. Пополните счет в консоли Anthropic', restart: true, link: ['Ключ Claude в личном кабинете', '#profile-key'] };
      return { reason: 'Лимита на ИИ в этом месяце (' + usdL(L ? L.monthly : D.admin.defaults.monthly) + ') не хватает на следующий вызов Claude. Попросите администратора поднять лимит или подключите свой ключ', link: ['Ключ Claude в личном кабинете', '#profile-key'], wait: 'Перезапуск станет доступен, когда лимит позволит' };
    }
    if (SCEN.id === 'cap') {
      const cap = own ? (me.ownCap != null ? me.ownCap : D.admin.defaults.perAnalysis) : admin ? 1 : (L ? L.perAnalysis : D.admin.defaults.perAnalysis);
      const spent = totalsAt({ i: st.at, f: 0 }).cost, next = Math.ceil((cap - spent) * 100 + 4) / 100;
      const head = 'Следующий вызов Claude может стоить до ' + usdS(next) + ', а вместе с уже потраченными ' + usdS(spent) + ' это больше ';
      if (own) return { code: 'ai.own_cap', reason: head + 'вашего потолка ' + usdL(cap) + ' на один анализ. Поднимите потолок в «Ключ Claude» или уберите часть событий', restart: true, link: ['Поднять свой потолок', '#profile-key'] };
      if (admin) return { reason: head + 'жесткого потолка программы ' + usdL(cap) + ' на один анализ. Уберите часть событий и запустите снова', wait: 'Перезапуск с тем же составом событий упрется в тот же потолок' };
      return { reason: head + 'потолка ' + usdL(cap) + ' на один анализ. Попросите администратора поднять потолок или уберите часть событий', wait: 'Перезапуск станет доступен, когда администратор поднимет потолок' };
    }
    return {};
  }

  // Анализ остановился на шаге SCEN.stop.at (сбой, лимит, потолок, ключ) или отменен в демо-состоянии «Анализ отменен»
  function stopAt(root) {
    const st = Object.assign({}, SCEN.stop, stopInfo(SCEN.stop)), ph = { i: st.at, f: 0 }, tot = totalsAt(ph);
    RUN.stopped = SCEN.id === 'cancel'
      ? { kind: 'cancel', at: st.at, f: 0, cost: tot.cost, sec: tot.sec, tokens: tot.tokens }
      : { kind: 'error', at: st.at, f: 0.35, cost: tot.cost, sec: tot.sec, tokens: tot.tokens, code: st.code, reason: st.reason, restart: st.restart, link: st.link, wait: st.wait };
    if (root.isConnected) draw(root);
  }

  function restartFromStep(root) {
    const at = RUN.stopped.at;
    RUN.stopped = null; RUN.attempt += 1; RUN.done = false;
    RUN.startedAt = performance.now() - stepStart(at);
    UI.toast('Анализ #' + ID + ' перезапущен с шага ' + (at + 1) + ': выполненные шаги не повторяются', 'refresh');
    draw(root);
    window.scrollTo(0, 0);
  }

  function stopBanner(root) {
    const r = RUN.stopped, s = STEPS[r.at];
    if (r.kind === 'cancel') {
      return h('div', { class: 'callout analysis-stop', role: 'alert' }, icon('x'),
        h('div', { style: 'min-width:0' },
          h('b', null, 'Анализ отменен на шаге ' + (r.at + 1) + ' из ' + STEPS.length + '. '),
          'Потрачено ' + usdS(r.cost) + ' — за шаги, которые успели выполниться; остальные не запускались. События сохранены в «Новом анализе».',
          h('div', { class: 'analysis-stop-acts' },
            button('Продолжить с шага ' + (r.at + 1), { kind: 'primary', size: 'sm', icon: 'refresh', onClick: () => restartFromStep(root), ro: true }),
            button('Изменить события', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new', ro: true })),
          h('div', { class: 'analysis-stop-note' }, icon('check'), h('span', null, 'Выполненные шаги повторно не оплачиваются.'))));
    }
    const done = STEPS.slice(0, r.at).filter(x => x.cost > 0).map(x => x.title.replace('Claude: ', 'оценка ').replace('Новости: ', 'новости ').replace('Разбор событий', 'разбор текста'));
    const reason = !r.restart && r.code === 'ai.monthly_limit' ? D.ai.access(D.me, 0) : null;
    const restart = button('Перезапустить с этого шага', { kind: 'primary', size: 'sm', icon: 'refresh', disabled: !r.restart, onClick: () => restartFromStep(root), ro: true });
    return h('div', { class: 'callout bad analysis-stop', role: 'alert' }, icon('alert'),
      h('div', { style: 'min-width:0' },
        h('b', null, 'Анализ остановлен на шаге ' + (r.at + 1) + ' из ' + STEPS.length + ' «' + s.title + '». '),
        r.reason + '.',
        h('div', { class: 'analysis-stop-acts' },
          restart,
          r.link && button(r.link[0], { kind: 'secondary', size: 'sm', icon: 'key', href: r.link[1], ro: true }),
          button('Изменить события', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new', ro: true })),
        !r.restart && h('div', { class: 'analysis-stop-note' }, icon('info'), h('span', null, (r.wait || 'Перезапуск станет доступен, когда лимит позволит') + (reason ? ' (сейчас: ' + reason.charAt(0).toLowerCase() + reason.slice(1) + ')' : '') + '.')),
        h('div', { class: 'analysis-stop-note' }, icon('check'), h('span', null, 'Уже выполненные шаги повторно не оплачиваются' + (done.length ? ' (' + done.join(', ') + ') — их результат сохранен' : '') + '. Потрачено ' + usdS(r.cost) + '.'))));
  }

  function progressStopped(root) {
    const r = RUN.stopped;
    const steps = STEPS.map(stepEl);
    steps.forEach((s, i) => s.set(i < r.at ? 'done' : i === r.at ? (r.kind === 'cancel' ? 'skipped' : 'failed') : 'skipped', i === r.at ? r.f : 0, r.reason));
    return card({
      eyebrow: 'Анализ #' + ID + (RUN.attempt > 1 ? ' · попытка ' + RUN.attempt : ''),
      title: r.kind === 'cancel' ? 'Анализ отменен' : 'Шаг ' + (r.at + 1) + ' не выполнен',
      subtitle: r.kind === 'cancel' ? 'Остальные шаги не запускались' : 'Ход анализа до остановки',
      actions: [chip(r.kind === 'cancel' ? 'Отменен' : 'Остановлен', r.kind === 'cancel' ? 'outline' : 'bad', r.kind === 'cancel' ? 'x' : 'alert')],
      body: [
        numsLine({ sec: r.sec, tokens: r.tokens, cost: r.cost }, h('span', null, 'Выполнено шагов ', h('b', null, r.at + ' из ' + STEPS.length))),
        h('ol', { class: 'analysis-steps', 'aria-label': 'Шаги анализа' }, steps.map(s => s.el)),
      ],
    });
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
    const warn = STEPS.find(s => s.warn);
    return h('section', { class: 'card', 'aria-label': 'Ход анализа' },
      h('div', { class: 'card-body' },
        h('div', { class: 'analysis-done-row' },
          chip('Анализ готов', 'good', 'check'),
          numsLine(TOTAL, h('span', null, 'Шагов ', h('b', null, String(STEPS.length))), true),
          h('div', { class: 'row' }, toggle)),
        warn && UI.callout('warn', 'alert', h('b', null, 'Готов с предупреждением. '), warn.warn + '. Перед ставкой проверьте новости игрока сами.'),
        list));
  }

  // Демо-панель: состояния хода анализа для согласования (в приложении ее нет)
  function demoPanel(root) {
    if (UI.view.active) return null; // в режиме просмотра данных участника (Р27) анализ не перезапускается
    const f = UI.field({ id: 'analysis-demo-state', label: 'Состояние анализа', value: SCEN.id, options: SCENARIOS.map(x => ({ value: x.id, label: x.label })) });
    f.querySelector('select').addEventListener('change', e => setScenario(root, e.target.value));
    return h('div', { class: 'analysis-demo', role: 'region', 'aria-label': 'Только в макете' },
      h('span', { class: 'demo-pill' }, 'Только в макете'),
      f,
      h('div', { class: 'analysis-demo-acts' },
        button('Показать результат сразу', { kind: 'ghost', size: 'sm', icon: 'bolt', disabled: RUN.done || !!RUN.stopped, onClick: () => { RUN.focusResult = true; finish(root); } }),
        !reduced() && button('Показать ход заново', { kind: 'ghost', size: 'sm', icon: 'play', onClick: () => setScenario(root, SCEN.id) })));
  }
  function setScenario(root, id) {
    SCEN = SCENARIOS.find(x => x.id === id) || SCENARIOS[0];
    OPENED = null;
    setup(REQ); resetRun();
    startRun();
    const stopT = stopTime();
    if (stopT != null && performance.now() - RUN.startedAt >= stopT) stopAt(root);
    else if (performance.now() - RUN.startedAt >= TOTAL_MS) finish(root);
    else draw(root);
  }

  function skeleton() {
    return h('section', { class: 'card analysis-skel-card', 'aria-busy': 'true', 'aria-label': 'Результат готовится' },
      h('div', { class: 'card-body' },
        h('div', { class: 'row', style: 'gap:8px' }, icon('clock', { width: 16, height: 16, style: 'color:var(--fg-3)' }), h('span', { class: 'muted small' }, 'Здесь появятся вероятности по рынкам, факторы и экспресс с суммой')),
        h('div', { class: 'analysis-skel', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'))));
  }

  function finish(root) {
    RUN.done = true;
    RUN.stopped = null;
    record(REQ, RUN.by || D.me, TOTAL.cost);
    if (root.isConnected) draw(root);
  }

  // ---------- карточка матча ----------
  function vsBlock(m) {
    const sideHead = (p, cls) => h('div', { class: ['analysis-vs-side', cls] },
      h('span', { class: 'analysis-vs-name' }, plink(p)),
      h('span', { class: 'analysis-vs-sub' }, p.country + ' · №' + p.eloPlace + ' по Эло'));
    const val = (row, side) => {
      const better = row.better === side;
      const main = row.form
        ? h('span', { class: 'analysis-vs-form' }, UI.formDots(formOf(side === 'l' ? m.a : m.b)), h('span', { class: 'analysis-vs-num' }, better && icon('check'), wl(formOf(side === 'l' ? m.a : m.b))))
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

  // Р29: любой рынок можно взять в свою ставку — по одному рынку на матч
  function slipBtn(r) {
    const inSlip = SLIP.some(x => x.row === r);
    const b = button(inSlip ? 'В своей ставке' : 'В свою ставку', { kind: 'ghost', size: 'sm', icon: inSlip ? 'check' : 'plus', onClick: () => addToSlip(r), ro: true, attrs: { class: 'btn ghost sm analysis-slip-btn' + (inSlip ? ' is-in' : ''), 'aria-label': (inSlip ? 'В своей ставке: ' : 'В свою ставку: ') + r.name + ', ' + D.match({ p1: r.m.a, p2: r.m.b }) } });
    return b;
  }
  function outcomeCell(r) {
    return h('div', { class: 'analysis-out' },
      h('b', null, r.name),
      h('small', null, r.desc),
      r.pick ? chip('В экспрессе', 'accent', 'ticket') : r.note && h('small', { class: 'analysis-note' }, r.note),
      slipBtn(r));
  }
  const pushNote = r => r.push ? h('small', null, 'возврат ' + pr(r.push)) : null;
  // строки по рынкам: заголовок группы — рынок, линия и статус
  function groupsOf(m) {
    const g = [];
    m.rows.forEach(r => { let x = g.find(y => y.key === r.group); if (!x) g.push(x = { key: r.group, title: groupTitle(r), status: r.status, rows: [] }); x.rows.push(r); });
    return g;
  }
  function probsTable(m) {
    const th = (t, sub, cls) => h('th', { class: cls, scope: 'col' }, t, sub && h('span', { class: 'analysis-th-sub' }, sub));
    return h('div', { class: 'table-wrap' },
      h('table', { class: 'table analysis-ptable' },
        h('caption', { class: 'sr-only' }, 'Вероятности и валуй по рынкам: ' + D.match({ p1: m.a, p2: m.b })),
        h('thead', null, h('tr', null,
          th('Исход', null, 'analysis-th-out'), th('Линия', null, 'c'), th('ML-модель', 'Эло + признаки', 'r'), th('Claude', MODE.news ? 'с новостями' : MODE.model + ', без новостей', 'r'), th('Рынок', 'без маржи', 'r'), th('Кэф', BK, 'r'), th('Валуй', 'p·кэф−1', 'r'))),
        groupsOf(m).map(g => h('tbody', { class: 'analysis-pgroup' },
          h('tr', { class: 'analysis-grow' }, h('th', { colspan: 7, scope: 'rowgroup' }, h('span', { class: 'analysis-gtitle' }, g.title), statusChip(g.status))),
          g.rows.map(r => h('tr', { class: r.pick ? 'is-pick' : null },
            h('td', null, outcomeCell(r)),
            h('td', { class: 'c' }, h('span', { class: 'analysis-line' }, r.line)),
            h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.model))),
            h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.claude), h('small', null, ppDelta(r.claude - r.model)), pushNote(r))),
            h('td', { class: 'r' }, h('span', { class: 'analysis-pnum' }, pr(r.market))),
            h('td', { class: 'r' }, h('span', { class: 'odds' }, fmt.odds(r.odds)), r.edited && h('span', { class: 'analysis-own', title: 'В линии было ' + fmt.odds(r.baseOdds) }, 'ваш кэф')),
            h('td', { class: 'r' }, valueCell(r.value))))))));
  }

  function probsList(m) {
    return h('div', { class: 'stack', style: 'gap:12px' }, groupsOf(m).map(g => h('section', { class: 'analysis-lgroup', 'aria-label': g.title },
      h('div', { class: 'analysis-lghead' }, h('span', { class: 'analysis-gtitle' }, g.title), statusChip(g.status)),
      h('ul', { class: 'analysis-plist', role: 'list', style: 'list-style:none;margin:0;padding:0' }, g.rows.map(r => h('li', { class: ['analysis-pitem', r.pick && 'is-pick'] },
        h('div', { class: 'analysis-pitem-top' }, outcomeCell(r), valueCell(r.value)),
        h('dl', { class: 'analysis-pgrid' },
          h('div', null, h('dt', null, 'ML-модель'), h('dd', null, pr(r.model))),
          h('div', null, h('dt', null, 'Claude'), h('dd', null, pr(r.claude), ' ', h('small', null, ppDelta(r.claude - r.model).replace(' п.п.', '')))),
          h('div', null, h('dt', null, 'Рынок'), h('dd', null, pr(r.market))),
          h('div', null, h('dt', null, r.edited ? 'Ваш кэф' : 'Кэф БК'), h('dd', { class: 'odds' }, fmt.odds(r.odds)))),
        r.push ? h('div', { class: 'analysis-pnote' }, 'Целая линия: ровно ' + Math.abs(r.leg.line) + ' — возврат, вероятность ' + pr(r.push) + '. Валуй = p·кэф + возврат − 1') : null))))));
  }

  function factorsBlock(m) {
    const item = (f, kind) => h('li', null,
      h('span', { class: ['analysis-sign', kind], 'aria-label': kind === 'pro' ? 'За' : 'Против' }, kind === 'pro' ? '+' : '−'),
      h('div', { style: 'min-width:0' }, h('div', null, f.t), h('div', { class: 'analysis-src' }, icon('globe'), f.src)));
    return h('div', { class: 'analysis-factors' },
      h('div', { class: 'analysis-fcol' }, h('h5', null, 'За · ' + m.bestRow.name), h('ul', { class: 'analysis-fl' }, m.pro.map(f => item(f, 'pro')))),
      h('div', { class: 'analysis-fcol' }, h('h5', null, 'Против'), h('ul', { class: 'analysis-fl' }, m.con.map(f => item(f, 'con')))));
  }

  const PROB_HINT = 'Валуй: небольшой +5–9%, хороший +10–14%, сильный от +15%. В экспресс идут П1 и П2 с p ≥ ' + STRAT.minProb + '% и кэфом ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax) + ', один рынок на матч. Фора ±1.5 на проверке, новые рынки — для сравнения: оценку видно, поставить их можно своей ставкой. Для тоталов и фор по геймам поправку Claude к победе переносит код.';
  function sec(title, hint, body) {
    return h('div', { class: 'analysis-sec' }, h('div', { class: 'analysis-sec-head' }, h('h4', null, title), hint && h('span', { class: 'analysis-hint' }, hint)), body);
  }

  const oddsHint = () => 'Кэфы ' + BK + (ODDS_EDITED ? ' — с вашими правками' : ' на 09:39');
  function matchCard(m, mobile) {
    const r = m.pickRow || m.bestRow;
    const what = r.pick ? 'В экспрессе: ' : m.pickRow ? 'Проходит правила, но экспресс не собран: ' : 'Правила не прошел ни один рынок. Лучший разрешенный: ';
    const pickLine = h('div', { class: ['analysis-pickline', !r.pick && 'is-off'] }, icon(r.pick ? 'target' : 'info'),
      h('span', null, what, h('b', null, r.name), ' @', h('span', { class: 'odds' }, fmt.odds(r.odds)), ' · p ', h('b', null, pr(r.claude)), ' · валуй ', h('b', null, fmt.signedPct(r.value * 100, 1)), r.pick ? null : ' — варианты ставки рядом'));
    const head = {
      eyebrow: m.info.time + ' · ' + m.info.round + ' · ' + m.info.court,
      title: D.match({ p1: m.a, p2: m.b }),
      subtitle: 'Данные: ' + m.fresh,
      actions: [confChip(m)],
      class: 'analysis-match',
    };
    // повтор оценки и новости, которые не удалось получить, видны прямо в карточке матча
    const notes = [
      m.reused && h('div', { class: 'analysis-reused' }, chip('Оценка Claude из анализа #' + REUSED_FROM.id + ' в ' + REUSED_FROM.at + ', без новых затрат', 'info', 'history')),
      SCEN.id === 'news' && m === MX[0] && UI.callout('warn', 'alert', h('b', null, 'Новости Руне не получены: '), 'поиск не ответил, оценка Claude — без свежих новостей о нем. Перед ставкой проверьте новости сами.'),
    ];
    if (!mobile) {
      return card(Object.assign(head, { body: [
        notes,
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
      if (t === 'probs') UI.append(panel, [h('p', { class: 'analysis-hint' }, 'ML-модель → Claude (поправка в п.п., не больше ±10) → рынок без маржи. ' + oddsHint() + '.'), probsList(m), h('p', { class: 'analysis-hint' }, PROB_HINT)]);
      else if (t === 'cmp') UI.append(panel, [vsBlock(m), h('p', { class: 'analysis-hint' }, '✓ — лучший показатель в паре')]);
      else panel.appendChild(factorsBlock(m));
    };
    drawPanel();
    const seg = UI.segmented({ label: 'Раздел анализа матча', items: [{ id: 'probs', label: 'Вероятности' }, { id: 'cmp', label: 'Сравнение' }, { id: 'factors', label: 'Факторы' }], active: ST.tab[m.id], onChange: id => { ST.tab[m.id] = id; drawPanel(); } });
    seg.style.alignSelf = 'stretch';
    seg.classList.add('analysis-seg');
    return card(Object.assign(head, { body: [notes, pickLine, seg, panel] }));
  }

  // ---------- экспресс ----------
  function stakePct(v) { return inCur(v) / inCur(BANK) * 100; }
  // доля банка для показа: если сумма — округленный шаг стратегии (1 080 при банке 48 000 — это 2,25%), показываем шаг, а не 2,24% после округления
  // доли банка в окне суммы: рекомендованная по таблице стратегии всегда среди вариантов
  const presets = () => [...new Set([1.5, 2, BASE_PCT || 2.25, 2.5, 3])].sort((a, b) => a - b);
  function sharePct(v) { const pre = presets().find(p => sameMoney(stakeAt(p), v)); return pctTxt(pre != null ? pre : Math.round(stakePct(v) * 100) / 100); }
  function expressCard(root) {
    const s = stake(), payout = payoutOf(s), rec = REC();
    const custom = ST.stake != null && !sameMoney(ST.stake, rec);
    const statusChip = ST.decision === 'saved' ? chip('Ставка сохранена', 'good', 'check') : ST.decision === 'skipped' ? chip('Без ставки', 'outline', 'x') : chip('Ждет решения', 'info', 'clock');

    const legs = h('div', { class: 'analysis-legs' }, LEGS.map(l => {
      const m = l.m, r = l.row;
      return h('div', { class: 'analysis-leg' },
        h('div', { style: 'min-width:0' },
          h('div', { class: 'analysis-leg-meta' }, m.info.time + ' · ' + D.match({ p1: m.a, p2: m.b })),
          h('div', { class: 'analysis-leg-pick' }, r.name),
          h('div', { class: 'analysis-leg-meta' }, r.desc)),
        h('div', { class: 'analysis-leg-right' },
          h('div', { class: 'analysis-leg-p' }, h('span', { 'aria-hidden': 'true' }, 'шанс'), h('b', { 'aria-hidden': 'true' }, pr(r.claude)), h('span', { class: 'sr-only' }, 'Вероятность ' + pr(r.claude))),
          UI.oddsBox(takenOdds()[LEGS.indexOf(l)] !== r.odds ? 'при ставке' : 'кэф', takenOdds()[LEGS.indexOf(l)], true)));
    }));

    const totals = h('div', { class: 'analysis-totals' },
      h('div', { class: 'analysis-total' }, h('span', null, curTotal() !== TOTAL_ODDS ? 'Кэф при ставке' : 'Кэф'), h('b', { class: 'mono' }, fmt.odds(curTotal())), h('small', null, takenOdds().map(x => fmt.odds(x)).join(' × '))),
      h('div', { class: 'analysis-total' }, h('span', null, 'Вероятность'), h('b', null, '≈ ' + pr(P_EXP)), h('small', null, LEGS.map(l => fmt.dec(l.p)).join(' × '))),
      h('div', { class: 'analysis-total' }, h('span', { title: 'Ожидаемый результат (EV) на ' + fmt.money(fmt.fromMoney(1)) + ' ставки' }, 'Перевес'), h('b', null, fmt.signedPct(EV * 100, 1)), h('small', null, '≈ ' + fmt.signedMoney(s * EV))));

    const calNote = P_CAL != null && h('div', { class: 'analysis-calnote' }, icon('target'),
      h('span', null, 'По истории калибровки прогнозы ' + CAL.map(b => Math.round(b.lo * 100) + '–' + Math.round(b.hi * 100) + '%').join(' и ') + ' сбывались в ' + CAL.map(b => pr(b.actual)).join(' и ') + '. С этой поправкой p ≈ ' + pr(P_CAL) + ', перевес ≈ ' + fmt.signedPct((P_CAL * TOTAL_ODDS - 1) * 100, 1) + '.'));

    // Адаптации суммы (Р22): просадка от пика, рост банка, итог недели. Правил серий нет
    const rowsA = adaptRows(), active = rowsA.filter(r => r.active);
    const adapt = UI.callout('accent', 'history',
      h('b', null, 'Адаптации: '), rowsA.map(r => r.now).join(', ') + ' — ' + (active.length ? active.map(r => r.active).join('; ') + '. ' : 'сейчас не действуют, сумма по таблице. '),
      'Правила те же, что в «Личном кабинете → Банк и стратегия»: −10% от пика → не больше 2,5%, −20% → 1,5% и 2 события до 1.50; неделя −5% → не больше 2%'
        + (RULE_ON('up15') ? '; банк +15% и винрейт от 60% → потолок 4%' : '') + (RULE_ON('week_win') ? '; неделя +10% → +0,5 п.п.' : '') + '. '
        + (RULE_ON('up15') && RULE_ON('week_win') ? '' : 'Рост банка и прибыльная неделя по умолчанию выключены — в расчет не входят. ') + 'Правил серий нет.');

    const calc = h('dl', { class: 'analysis-calc' },
      h('dt', null, !sameMoney(BANK, D.stats.bank) ? 'Банк из вашего ввода' : 'Банк сейчас'), h('dd', null, fmt.money(BANK)),
      BAND
        ? [h('dt', null, 'Кэф ' + fmt.odds(TOTAL_ODDS) + ' → ', nw('диапазон ' + BAND.range)), h('dd', null, BAND.pct + ' → ' + pctTxt(BASE_PCT))]
        : [h('dt', null, 'Кэф ' + fmt.odds(TOTAL_ODDS) + ' — ', nw('выше ' + fmt.odds(STRAT.totalMax))), h('dd', null, 'вне таблицы → 0%')],
      h('dt', null, 'Валуй ног (' + LEGS.map(l => fmt.signedPct(l.row.value * 100, 1)).join(', ') + ')'), h('dd', null, 'без поправки'),
      h('dt', null, 'Адаптации'), h('dd', null, active.length ? active.length + ' ' + fmt.plural(active.length, 'правило', 'правила', 'правил') : 'не действуют'),
      h('dt', null, 'Потолок доли банка'), h('dd', null, GROWTH_ON ? '4%' : '3%'),
      h('dt', { class: 'is-sum' }, nw(fmt.money(BANK) + ' × ' + pctTxt(BASE_PCT)), ' = ', nw(fmt.money(fmt.fromMoney(inCur(BANK) * BASE_PCT / 100))),
        STEP() > 0.01 ? [', ', nw('округление до ' + fmt.money(fmt.fromMoney(STEP())))] : null), h('dd', { class: 'is-sum' }, fmt.money(rec)));
    // расчет суммы свернут: карточка решения короче и целиком видна рядом с матчами
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
        h('div', { class: 'small muted' }, s ? (custom ? sharePct(s) : pctTxt(BASE_PCT)) + ' банка · при выигрыше ' + fmt.money(payout) + ' (' + fmt.signedMoney(payout - s) + ')' : 'Стратегия не дает суммы: экспресс вне ее правил')),
      custom && rec > 0 && button('Вернуть ' + fmt.money(rec), { kind: 'ghost', size: 'sm', icon: 'refresh', ro: true, onClick: () => { ST.stake = null; draw(root); UI.toast('Сумма возвращена к рекомендованной: ' + fmt.money(REC()), 'refresh'); } }));

    let foot;
    if (UI.view.active) {
      // Р27: администратор видит анализ участника и его решение, но сохранить ставку или изменить сумму не может
      const rec = (D.recentAnalyses || []).find(a => a.id === ID);
      foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' },
        UI.callout('', 'eye', h('b', null, 'Решение участника: '), rec && rec.decision === 'bet' ? 'ставка сохранена — она есть на «Ставках».' : rec && rec.decision === 'skip' ? 'без ставки.' : 'ставку не сохранял.'),
        UI.view.note('Только просмотр: сохранить ставку, изменить сумму или перезапустить анализ может только участник.'));
    } else if (ST.decision === 'saved') {
      foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' },
        UI.callout('good', 'check', 'Ставка №' + ST.betId + ' в игре: ' + fmt.money(s) + ' на экспресс @' + fmt.odds(curTotal()) + '. Результат внесете после матчей — модель сверит прогноз.'),
        h('div', { class: 'analysis-actions' }, button('Открыть в ставках', { kind: 'primary', icon: 'ticket', href: '#bets' })));
    } else if (ST.decision === 'skipped') {
      foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' },
        UI.callout('', 'info', 'Анализ сохранен без ставки. Модель все равно сверит свои вероятности с итогами матчей — так растет выборка для калибровки.'),
        h('div', { class: 'analysis-actions' },
          button('Все-таки поставить', { kind: 'primary', icon: 'ticket', onClick: () => { ST.decision = null; logDecision(null); draw(root); } })));
    } else {
      foot = h('div', { class: 'analysis-actions' },
        button('Сохранить ставку', { kind: 'primary', icon: 'check', onClick: () => saveBet(root) }),
        button('Изменить сумму', { kind: 'secondary', icon: 'edit', onClick: () => stakeModal(root) }),
        // Р29: события экспресса — в свою ставку, там их можно убрать или добавить другие рынки
        button('Собрать свою', { kind: 'secondary', icon: 'layers', onClick: () => { SLIP.length = 0; LEGS.forEach(l => SLIP.push({ row: l.row })); slipModal(root, 'Своя ставка собрана из экспресса: уберите или добавьте события — «В свою ставку» у любого рынка'); } }),
        button('Не ставить', { kind: 'ghost', icon: 'x', onClick: () => { ST.decision = 'skipped'; logDecision('skip'); draw(root); UI.toast('Анализ #' + ID + ' сохранен без ставки', 'check'); } }));
    }

    return h('section', { class: 'card analysis-exp is-main', 'aria-labelledby': 'analysis-exp-title' },
      h('div', { class: 'card-head' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Вариант 1 · основной'), h('h3', { id: 'analysis-exp-title' }, 'Экспресс стратегии'), h('div', { class: 'card-sub' }, LEGS.length + ' события · стратегия ' + STRAT_V + ' · сумма по таблице экспрессов')),
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
      'В приложении ИИ подобрал бы другие рынки или не предложил бы ставку; в макете расчет показан как есть.');
  }
  // цена перезапуска в точном режиме — так же, как оценка на экране «Новый анализ»
  function rerunCost() {
    const r = REQ || {};
    const n = Array.isArray(r.events) && r.events.length ? r.events.length : MX.length;
    return Math.round(n * MODES.precise.perEvent * 100) / 100;
  }
  // режим без свежих новостей — предупреждаем и даем перезапустить в точном
  function modeNote(root) {
    if (MODE.id === 'precise') return null;
    const reason = D.ai.access(D.me, rerunCost()); // пауза, нет ключа, лимиты и бюджет — общий расчет
    const txt = MODE.id === 'eco'
      ? 'Режим «Экономный» (Haiku 5.5) — черновая оценка по сохраненным досье, без свежих новостей. Чтобы отсеять лишнее — годится, для решения о ставке — нет.'
      : 'Режим «Сбалансированный» (Sonnet 5.5) еще не проверен на eval-наборе и не ищет свежие новости. Для решения о ставке надежнее «Точный».';
    return UI.callout(MODE.id === 'eco' ? 'warn' : 'info', MODE.id === 'eco' ? 'alert' : 'info',
      txt, ' В макете вероятности примера одинаковы во всех режимах.',
      h('div', { class: 'row analysis-mode-acts' }, button('Перезапустить в режиме «Точный»', { kind: 'secondary', size: 'sm', icon: 'refresh', disabled: !!reason, onClick: () => rerunPrecise(root), ro: true }),
        reason && h('span', { class: 'xsmall', role: 'status' }, 'Сейчас нельзя: ' + reason.charAt(0).toLowerCase() + reason.slice(1))));
  }
  function rerunPrecise(root) {
    const r = REQ || {};
    const n = Array.isArray(r.events) && r.events.length ? r.events.length : MX.length;
    const cost = rerunCost(), reason = D.ai.access(D.me, cost);
    if (reason) { UI.toast(reason, 'alert'); return; }
    D.pendingAnalysis = Object.assign({}, r, { mode: 'precise', model: MODES.precise.model, createdAt: TODAY, events: r.events || MX.map(m => ({ p1: m.a, p2: m.b, odds: Object.assign({}, m.info.odds) })), estimate: { cost, secs: n * 45 } });
    setup(D.pendingAnalysis); resetRun(); setHead();
    startRun();
    scheduleRecord();
    UI.toast('Анализ #' + ID + ' запущен в режиме «Точный»', 'spark');
    if (reduced()) finish(root); else draw(root);
    window.scrollTo(0, 0);
  }

  function logDecision(decision) {
    D.analyses = D.analyses || [];
    let rec = D.analyses.find(a => a.id === ID);
    if (!rec) { rec = { id: ID, date: TODAY, legs: LEGS.length, total: TOTAL_ODDS }; D.analyses.push(rec); }
    rec.decision = decision; rec.stake = decision === 'bet' ? stake() : null; rec.note = decision === 'skip' ? 'анализ сохранен без ставки' : null;
  }

  // Поля «Кэф при ставке» у каждой ноги: по умолчанию кэф из ввода. onChange(массив кэфов | null, если есть ошибка)
  function legOddsFields(prefix, values, onChange) {
    const cur = values.slice(), bad = new Set();
    const rows = LEGS.map((l, i) => {
      const m = l.m, r = l.row;
      const id = prefix + '-odd-' + i;
      const inp = h('input', { class: 'input', id, value: fmt.odds(cur[i]), inputmode: 'decimal', autocomplete: 'off', maxlength: '6', 'aria-describedby': id + '-hint' });
      const err = h('div', { class: 'field-error', role: 'alert', hidden: true });
      const row = h('div', { class: 'analysis-legodd' },
        h('label', { class: 'analysis-legodd-name', for: id }, h('b', null, r.name), h('small', { id: id + '-hint' }, D.match({ p1: m.a, p2: m.b }) + ' · в анализе ' + fmt.odds(l.odds))),
        inp, err);
      inp.addEventListener('input', () => {
        const x = parseFloat(String(inp.value).replace(',', '.'));
        const ok = x >= 1.01 && x <= 50;
        err.hidden = ok; err.textContent = ok ? '' : 'Кэф от 1.01 до 50';
        inp.classList.toggle('invalid', !ok); inp.setAttribute('aria-invalid', String(!ok));
        if (ok) { cur[i] = Math.round(x * 100) / 100; bad.delete(i); } else bad.add(i);
        onChange(bad.size ? null : cur.slice());
      });
      inp.addEventListener('blur', () => { const x = parseFloat(String(inp.value).replace(',', '.')); if (x >= 1.01 && x <= 50) inp.value = fmt.odds(x); });
      return row;
    });
    return h('div', { class: 'stack', style: 'gap:6px' },
      h('span', { class: 'field-label' }, 'Кэф при ставке'),
      h('div', { class: 'analysis-legodds' }, rows),
      h('div', { class: 'field-hint' }, 'По умолчанию — кэфы из ввода. Если букмекер дал другой, поправьте: от него считаются выплата, результат и CLV.'));
  }
  // Предупреждение о доле банка — по правилу роста банка из личного кабинета (потолок 4% только при росте +15% и винрейте от 60%);
  // правило выключено (по умолчанию, В7) — потолок всегда 3%
  function shareWarn(pct) {
    if (pct > 4) return UI.callout('bad', 'alert', 'Больше 4% банка — выше любого лимита стратегии. Неудачная неделя заметно ударит по банку.');
    if (pct > 3 && !RULE_ON('up15')) return UI.callout('warn', 'alert', 'Больше 3% банка — выше потолка стратегии. Правило «Рост банка» (до 4% при росте банка на 15% и винрейте от 60%) по умолчанию выключено.');
    if (pct > 3 && !GROWTH_ON) return UI.callout('warn', 'alert', 'Больше 3% банка: до 4% стратегия разрешает только при росте банка на 15% к стартовому и винрейте от 60% (сейчас ' + fmt.signedPct(GROWTH) + ' и ' + fmt.pct(D.stats.winrate) + ') — правило «Рост банка» в личном кабинете.');
    if (pct > 3) return UI.callout('info', 'info', 'Больше 3% банка: правило роста банка действует (банк ' + fmt.signedPct(GROWTH) + ', винрейт ' + fmt.pct(D.stats.winrate) + '), потолок — 4%.');
    return null;
  }

  function doSaveBet(taken) {
    const s = stake();
    ST.taken = taken;
    const total = totalOf(taken);
    const same = b => b.status === 'open' && b.legs.length === LEGS.length && LEGS.every(l => b.legs.some(x => x.p1 === l.p1 && x.p2 === l.p2 && x.market === l.market));
    let bet = D.bets.find(same);
    const legs = LEGS.map((l, i) => Object.assign({ closing: null, result: 'open' }, l, { odds: taken[i] }));
    if (bet) { bet.stake = s; bet.analysis = ID; bet.legs = legs; bet.total = total; }
    else {
      bet = { id: Math.max(...D.bets.map(b => b.id)) + 1, date: TODAY, tournament: 'Шанхай', surface: 'hard', legs, total, stake: s, status: 'open', profit: 0, bankAfter: null, clv: null, bookmaker: BK, analysis: ID };
      D.bets.push(bet);
      D.stats.open = D.bets.filter(b => b.status === 'open').length;
    }
    ST.decision = 'saved'; ST.betId = bet.id;
    logDecision('bet');
    UI.toast('Ставка №' + bet.id + ' сохранена: ' + fmt.money(s) + ' на экспресс @' + fmt.odds(total), 'check');
    D.lastSavedBet = bet.id; // экран «Ставки» подсветит ее и прокрутит к ней
    UI.go('bets');
  }

  // «Сохранить ставку»: сумма, кэф при ставке у каждой ноги, итоговый кэф и выплата
  function saveBet(root) {
    const s = stake();
    if (!s) { stakeModal(root); return; }
    let taken = takenOdds().slice();
    const sum = h('div', { 'aria-live': 'polite' });
    let go = null;
    function drawSum() {
      UI.clear(sum);
      if (!taken) { go.disabled = true; return; }
      go.disabled = false;
      const total = totalOf(taken), pay = payoutOf(s, total);
      sum.appendChild(UI.kv([
        ['Сумма', fmt.money(s) + ' · ' + sharePct(s) + ' банка'],
        ['Итоговый кэф', fmt.odds(total) + (total !== TOTAL_ODDS ? ' (в анализе ' + fmt.odds(TOTAL_ODDS) + ')' : '')],
        ['Выплата при выигрыше', fmt.money(pay) + ' (' + fmt.signedMoney(pay - s) + ')'],
        ['Букмекер', BK],
      ]));
      if (total > STRAT.totalMax) sum.appendChild(UI.callout('warn', 'alert', 'Итоговый кэф выше ' + fmt.odds(STRAT.totalMax) + ' — экспресс выходит за правила стратегии ' + STRAT_V + '.'));
    }
    UI.modal({
      title: 'Сохранить ставку',
      body: h('div', { class: 'stack', style: 'gap:14px' },
        legOddsFields('analysis-bet', taken, v => { taken = v; drawSum(); }),
        sum,
        h('p', { class: 'xsmall muted', style: 'margin:0' }, 'Ставку делаете вы у букмекера — здесь она записывается в учет: сумма спишется с банка, результат внесете после матчей.')),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        go = button('Сохранить ставку', { kind: 'primary', icon: 'check', onClick: () => { if (!taken) return; close(); doSaveBet(taken); } }),
      ],
    });
    drawSum();
  }

  // Окно суммы работает в валюте программы: поле, шаг и доли банка — в ней, в DATA сумма уходит в рублях демо-данных
  function stakeModal(root) {
    const bankCur = inCur(BANK), recCur = inCur(REC()), minCur = MIN_CUR(), dec = curDec();
    let v = inCur(stake());
    let taken = takenOdds().slice();
    const preview = h('div', { class: 'stack', style: 'gap:10px', 'aria-live': 'polite' });
    if (!v) v = toStep(bankCur * 1.5 / 100);
    const rub = () => fmt.fromMoney(v);
    const okVal = () => Number.isFinite(v) && v >= minCur && v <= bankCur;
    // поле текстовое: число пишется так же, как на экране (1 080 или 10,77), точку и запятую понимаем обе
    const asText = x => (dec ? fmt.dec(x, 2) : fmt.int(x));
    const fieldEl = UI.field({ label: 'Сумма ставки', id: 'analysis-stake-input', value: asText(v), suffix: fmt.cur(), inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off', hint: recCur ? 'Рекомендовано ' + fmt.money(REC()) + ' — ' + pctTxt(BASE_PCT) + ' банка по стратегии ' + STRAT_V : 'Стратегия ' + STRAT_V + ' суммы для кэфа выше ' + fmt.odds(STRAT.totalMax) + ' не дает — сумма на ваш риск', attrs: { maxlength: '12', 'aria-label': 'Сумма ставки, ' + curName() } });
    const input = fieldEl.querySelector('input');
    const segHolder = h('div');
    function drawSeg() {
      const match = presets().find(p => toStep(bankCur * p / 100) === v);
      UI.clear(segHolder).appendChild(UI.segmented({ label: 'Доля банка', items: presets().map(p => ({ id: String(p), label: pctTxt(p) + (p === BASE_PCT ? ' · реком.' : '') })), active: match != null ? String(match) : 'custom', onChange: id => { v = toStep(bankCur * Number(id) / 100); input.value = asText(v); drawPreview(); } }));
      segHolder.firstChild.classList.add('analysis-modal-seg');
    }
    function drawPreview() {
      UI.clear(preview);
      if (!taken) { preview.appendChild(UI.callout('bad', 'alert', 'Проверьте кэфы при ставке: допустимо от 1.01 до 50.')); return; }
      if (!okVal()) { preview.appendChild(UI.callout('bad', 'alert', v > bankCur ? 'Сумма больше банка (' + fmt.money(BANK) + ').' : 'Минимальная ставка — ' + fmt.money(fmt.fromMoney(minCur)) + '.')); return; }
      const pct = v / bankCur * 100, r = rub(), total = totalOf(taken), pay = payoutOf(r, total);
      const ev = P_EXP * total - 1;
      preview.appendChild(UI.kv([
        ['Доля банка', sharePct(r)],
        ['Выплата при выигрыше (@' + fmt.odds(total) + ')', fmt.money(pay)],
        ['Чистая прибыль', fmt.signedMoney(pay - r)],
        ['При проигрыше', fmt.signedMoney(-r)],
        ['Ожидаемый результат по оценке модели', '≈ ' + fmt.signedMoney(r * ev)],
      ]));
      if (bandPct(total) !== BASE_PCT) preview.appendChild(UI.callout('info', 'info', 'С кэфами при ставке итоговый кэф ' + fmt.odds(total) + ' — по таблице стратегии ' + (bandPct(total) ? pctTxt(bandPct(total)) + ' банка' : 'суммы нет') + ' вместо ' + pctTxt(BASE_PCT) + '.'));
      const w = shareWarn(pct);
      if (w) preview.appendChild(w);
    }
    input.addEventListener('input', () => { v = roundCur(parseFloat(String(input.value).replace(/\s/g, '').replace(',', '.'))); drawSeg(); drawPreview(); });
    input.addEventListener('blur', () => { if (Number.isFinite(v)) input.value = asText(v); });
    drawSeg(); drawPreview();
    UI.modal({
      title: 'Изменить сумму',
      body: close => h('form', { id: 'analysis-stake-form', class: 'stack', style: 'gap:14px', novalidate: true, on: { submit: e => {
        e.preventDefault();
        if (!okVal() || !taken) { input.focus(); return; }
        ST.stake = v === recCur ? null : rub();
        ST.taken = taken.every((x, i) => x === LEGS[i].odds) ? null : taken;
        close(); draw(root);
        UI.toast('Сумма изменена: ' + fmt.money(rub()) + ' (' + sharePct(rub()) + ' банка), кэф ' + fmt.odds(totalOf(taken)), 'edit');
      } } }, fieldEl, h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'field-label' }, 'Или доля банка'), segHolder),
        legOddsFields('analysis-stake', taken, x => { taken = x; drawPreview(); }), preview),
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Применить', { kind: 'primary', type: 'submit', icon: 'check', attrs: { form: 'analysis-stake-form' } }),
      ],
    });
  }

  // ---------- варианты ставки (Р29) ----------
  // Кандидаты — только рынки, которые можно брать в экспресс (сейчас П1 и П2): фора ±1.5 на проверке, новые рынки —
  // для сравнения. «Надежнее» — наибольшая p среди кэфов от 1.30 с валуем от нуля (таких нет — среди валуя от нуля
  // с любым кэфом, нет и их — наибольшая p без валуя). «Лучший валуй» — наибольший валуй при p от 50%. Совпали — одна
  // карточка. «Экспресс из лучших» — только когда экспресса стратегии нет, а матчей 2+: лучший рынок каждого матча.
  const SINGLE_MIN_ODDS = 1.30;
  // Сумма ординара — своя таблица, меньше экспресса: кэф до 1.60 — 1,5% банка, 1.61–2.20 — 1,25%, выше — 1%.
  // Адаптации те же: −10% от пика — не больше 2,5%, неделя −5% — не больше 2%, −20% от пика — ординар не больше 1%.
  // «Экспресс из лучших» вне правил стратегии — по таблице экспрессов, но не больше 1,5%. Валуя нет — суммы нет
  const SINGLE_TABLE = [{ max: 1.60, range: 'до 1.60', pct: 1.5 }, { max: 2.20, range: '1.61–2.20', pct: 1.25 }, { max: Infinity, range: 'от 2.21', pct: 1 }];
  const BEST_CAP = 1.5;
  const variantOf = (id, kind, title, rows, why) => ({ id, kind, title, rows, why });
  function buildVariants() {
    const cands = MX.flatMap(m => m.rows.filter(allowed));
    const out = [];
    if (LEGS.length) out.push(variantOf('express', 'express', 'Экспресс стратегии', LEGS.map(l => l.row)));
    const byP = (a, b) => b.claude - a.claude;
    const pos = cands.filter(r => r.value >= 0);
    const safe = pos.filter(r => r.odds >= SINGLE_MIN_ODDS).sort(byP)[0] || pos.slice().sort(byP)[0] || cands.filter(r => r.claude >= 0.5).sort(byP)[0];
    const val = cands.filter(r => r.claude >= 0.5).sort((a, b) => b.value - a.value)[0];
    const safeWhy = r => (r.value < 0 ? 'Самый вероятный исход, но валуя нет: кэф ниже честного'
      : r.odds < SINGLE_MIN_ODDS ? 'Кэф ' + fmt.odds(r.odds) + ' ниже ' + fmt.odds(SINGLE_MIN_ODDS) + ', но среди рынков с валуем этот самый вероятный — выигрыш небольшой'
        : 'Самая высокая вероятность среди рынков с кэфом от ' + fmt.odds(SINGLE_MIN_ODDS) + ' и валуем от нуля');
    if (safe && safe === val) out.push(variantOf('safe', 'single', 'Ординар · надежнее и лучший валуй', [safe], safeWhy(safe) + (safe.value < 0 ? '. Среди исходов с p от 50% у него и самый маленький минус' : '. Он же дает наибольший перевес при p от 50%')));
    else {
      if (safe) out.push(variantOf('safe', 'single', 'Ординар · надежнее', [safe], safeWhy(safe)));
      if (val) out.push(variantOf('value', 'single', 'Ординар · лучший валуй', [val], val.value < 0 ? 'Наименьший минус среди исходов с p от 50% — валуя нет' : 'Наибольший перевес среди исходов с вероятностью от 50%'));
    }
    if (!LEGS.length && MX.length >= 2) {
      const legs = MX.map(m => m.rows.filter(r => allowed(r) && r.claude >= 0.5).sort((a, b) => b.value - a.value)[0]).filter(Boolean);
      const bad = legs.filter(r => r.value < 0 || outOfRules(r).length);
      if (legs.length >= 2) out.push(variantOf('best', 'best', 'Экспресс из лучших', legs, 'Лучший по валую рынок каждого матча. В правила стратегии не проходит: ' + (bad.length ? bad.map(r => r.name + ' — ' + (r.value < 0 ? 'валуй ' + fmt.signedPct(r.value * 100, 1) : outOfRules(r).join(', '))).join('; ') : 'экспресс не собран')));
    }
    return out;
  }
  const evOf = (rows, taken) => rows.reduce((a, r, i) => a * (r.claude * taken[i] + (r.push || 0)), 1) - 1;
  const pOf = rows => rows.reduce((a, r) => a * r.claude, 1);
  // Сумма варианта и ее расчет для «Как посчитана сумма»
  function variantStake(v, total, ev) {
    const caps = [];
    if (RULE_ON('dd20') && DD <= -20) caps.push(['защитный режим −20% от пика', v.kind === 'single' ? 1 : 1.5]);
    else if (RULE_ON('dd10') && DD <= -10) caps.push(['просадка −10% от пика', 2.5]);
    if (RULE_ON('week_loss') && WEEK <= -5) caps.push(['неделя −5%', 2]);
    let base, band;
    if (v.kind === 'single') { band = SINGLE_TABLE.find(t => total <= t.max); base = band.pct; }
    else { base = Math.min(bandPct(total) || 1.75, BEST_CAP); band = { range: 'экспресс вне правил, до ' + pctTxt(BEST_CAP) }; }
    const pct = ev < 0 ? 0 : caps.reduce((a, c) => Math.min(a, c[1]), base);
    return { pct, base, band, caps, rec: pct ? stakeAt(pct) : 0 };
  }

  function variantCard(root, v, n) {
    const st = VST[v.id] || (VST[v.id] = { stake: null, taken: null, decision: null, betId: null, calc: false });
    const taken = st.taken || v.rows.map(r => r.odds);
    const total = totalOf(taken), p = pOf(v.rows), ev = evOf(v.rows, taken);
    const sk = variantStake(v, total, ev);
    const s = st.stake != null ? st.stake : sk.rec;
    const pay = s ? payoutOf(s, total) : 0;
    const legs = h('div', { class: 'analysis-legs' }, v.rows.map((r, i) => h('div', { class: 'analysis-leg' },
      h('div', { style: 'min-width:0' },
        h('div', { class: 'analysis-leg-meta' }, r.m.info.time + ' · ' + D.match({ p1: r.m.a, p2: r.m.b })),
        h('div', { class: 'analysis-leg-pick' }, r.name),
        h('div', { class: 'analysis-leg-meta' }, r.desc)),
      h('div', { class: 'analysis-leg-right' },
        h('div', { class: 'analysis-leg-p' }, h('span', { 'aria-hidden': 'true' }, 'шанс'), h('b', { 'aria-hidden': 'true' }, pr(r.claude)), h('span', { class: 'sr-only' }, 'Вероятность ' + pr(r.claude))),
        UI.oddsBox(taken[i] !== r.odds ? 'при ставке' : 'кэф', taken[i], true)))));
    const totals = h('div', { class: 'analysis-totals' },
      h('div', { class: 'analysis-total' }, h('span', null, 'Кэф'), h('b', { class: 'mono' }, fmt.odds(total)), v.rows.length > 1 ? h('small', null, taken.map(x => fmt.odds(x)).join(' × ')) : h('small', null, 'ординар')),
      h('div', { class: 'analysis-total' }, h('span', null, 'Вероятность'), h('b', null, '≈ ' + pr(p)), h('small', null, 'модель')),
      h('div', { class: 'analysis-total' }, h('span', null, 'Валуй'), h('b', { class: ev < 0 ? 'bad-text' : null }, fmt.signedPct(ev * 100, 1)), h('small', null, 'p·кэф − 1')));
    const calc = h('dl', { class: 'analysis-calc' },
      h('dt', null, !sameMoney(BANK, D.stats.bank) ? 'Банк из вашего ввода' : 'Банк сейчас'), h('dd', null, fmt.money(BANK)),
      v.kind === 'single'
        ? [h('dt', null, 'Ординар, кэф ' + fmt.odds(total) + ' → ', nw('диапазон ' + sk.band.range)), h('dd', null, pctTxt(sk.base))]
        : [h('dt', null, 'Кэф ' + fmt.odds(total) + ' · ' + sk.band.range), h('dd', null, pctTxt(sk.base))],
      h('dt', null, 'Адаптации'), h('dd', null, sk.caps.length ? sk.caps.map(c => c[0] + ' → до ' + pctTxt(c[1])).join('; ') : 'не действуют'),
      h('dt', null, 'Валуй ' + fmt.signedPct(ev * 100, 1)), h('dd', null, ev < 0 ? 'ниже нуля → суммы нет' : 'от нуля → сумма есть'),
      h('dt', { class: 'is-sum' }, sk.pct ? [nw(fmt.money(BANK) + ' × ' + pctTxt(sk.pct)), STEP() > 0.01 ? [', ', nw('округление до ' + fmt.money(fmt.fromMoney(STEP())))] : null] : 'Рекомендованной суммы нет'), h('dd', { class: 'is-sum' }, sk.rec ? fmt.money(sk.rec) : '—'));
    const calcId = 'analysis-vcalc-' + v.id;
    const calcBox = h('div', { class: 'stack analysis-calc-box', id: calcId, style: 'gap:8px', hidden: !st.calc }, calc,
      h('p', { class: 'xsmall muted', style: 'margin:0' }, v.kind === 'single'
        ? 'Ординар — своя таблица, меньше экспресса: кэф до 1.60 — 1,5% банка, 1.61–2.20 — 1,25%, выше — 1%. Адаптации те же, что у экспресса; в защитном режиме (−20% от пика) — не больше 1%.'
        : 'Экспресс вне правил стратегии: доля по таблице экспрессов, но не больше ' + pctTxt(BEST_CAP) + ' банка. Адаптации те же.'));
    const calcToggle = button('Как посчитана сумма', { kind: 'ghost', size: 'sm', icon: 'info', iconRight: 'chevronDown', attrs: { 'aria-expanded': String(st.calc), 'aria-controls': calcId }, onClick: () => { st.calc = !st.calc; calcBox.hidden = !st.calc; calcToggle.setAttribute('aria-expanded', String(st.calc)); } });
    calcToggle.classList.add('analysis-calc-toggle');
    const kindChip = v.kind === 'single' ? chip('Ординар', 'info', 'target') : chip('Вне стратегии', 'warn', 'alert');
    const custom = st.stake != null && !sameMoney(st.stake, sk.rec);
    let foot;
    if (UI.view.active) foot = UI.view.note('Только просмотр: сохранить ставку может только участник.');
    else if (st.decision === 'saved') foot = h('div', { class: 'stack', style: 'width:100%;gap:10px' }, UI.callout('good', 'check', 'Ставка №' + st.betId + ' в игре: ' + fmt.money(s) + ' @' + fmt.odds(total) + '.'), h('div', { class: 'analysis-actions' }, button('Открыть в ставках', { kind: 'secondary', icon: 'ticket', href: '#bets' })));
    else foot = h('div', { class: 'analysis-actions' },
      button('Сохранить ставку', { kind: !LEGS.length && n === 1 && ev >= 0 ? 'primary' : 'secondary', icon: 'check', onClick: () => betModal(root, { mode: 'save', kind: v.kind === 'single' ? 'single' : 'own', variant: v, rows: v.rows, taken, stake: s || null, rec: sk.rec }) }),
      button('Изменить сумму', { kind: 'ghost', icon: 'edit', onClick: () => betModal(root, { mode: 'stake', kind: v.kind === 'single' ? 'single' : 'own', variant: v, rows: v.rows, taken, stake: s || null, rec: sk.rec }) }));
    return h('section', { class: ['card', 'analysis-var', ev < 0 && 'is-novalue'], 'aria-labelledby': 'analysis-var-' + v.id },
      h('div', { class: 'card-head' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Вариант ' + n), h('h3', { id: 'analysis-var-' + v.id }, v.title)),
        st.decision === 'saved' ? chip('Сохранена', 'good', 'check') : kindChip),
      h('div', { class: 'card-body' }, legs, totals,
        h('p', { class: 'analysis-why-line' }, icon('info'), h('span', null, h('b', null, 'Почему: '), v.why)),
        ev < 0 && UI.callout('bad', 'alert', h('b', null, 'Валуя нет — модель не советует ставить. '), 'Суммы по таблице нет; сохранить можно, сумму введете сами.'),
        h('hr', { class: 'divider' }),
        h('div', { class: 'analysis-stake' }, h('div', { style: 'min-width:0' },
          h('div', { class: 'eyebrow' }, custom ? 'Сумма · изменена вручную' : 'Рекомендуемая сумма'),
          h('div', { class: 'analysis-stake-value' }, s ? fmt.money(s) : '—'),
          h('div', { class: 'small muted' }, s ? sharePct(s) + ' банка · при выигрыше ' + fmt.money(pay) + ' (' + fmt.signedMoney(pay - s) + ')' : 'Суммы нет: валуй ниже нуля'))),
        calcToggle, calcBox),
      h('div', { class: 'card-foot' }, foot));
  }

  // Экспресса стратегии нет: почему, по каждому матчу
  function noExpressNote() {
    return UI.callout('warn', 'alert', h('b', null, 'Экспресса стратегии нет. '),
      MX.map(m => D.match({ p1: m.a, p2: m.b }) + ': ' + (m.pickRow ? 'правила прошел ' + m.pickRow.name + ' @' + fmt.odds(m.pickRow.odds) : 'правила не прошел ни один рынок (лучший — ' + m.bestRow.name + ' @' + fmt.odds(m.bestRow.odds) + ', валуй ' + fmt.signedPct(m.bestRow.value * 100, 1) + ')')).join('; ') + '. ',
      'Экспресс собирается из 2–' + STRAT.maxLegs + ' событий. Ниже — варианты ставки: ординары и экспресс из лучших рынков.');
  }
  // лучший валуй среди рынков «для сравнения» — честно показываем, но в варианты не берем
  function freshNote() {
    const r = MX.flatMap(m => m.rows).filter(x => x.status.status === 'compare' && x.claude >= 0.5 && x.value > 0).sort((a, b) => b.value - a.value)[0];
    if (!r) return null;
    return h('p', { class: 'analysis-fresh-note' }, icon('flask'), h('span', null, 'Лучший валуй среди рынков для сравнения — ', h('b', null, r.name), ' (' + D.match({ p1: r.m.a, p2: r.m.b }) + ') @' + fmt.odds(r.odds) + ', валуй ' + fmt.signedPct(r.value * 100, 1) + '. Модель по рынку не проверена (' + r.status.n + ' из ' + F.NEED + ' событий), поэтому в варианты он не попал. Поставить можно своей ставкой — «В свою ставку» в таблице матча.'));
  }

  function variantsBlock(root) {
    const vs = VARIANTS.filter(v => v.kind !== 'express');
    const noValue = !MX.some(m => m.rows.some(r => allowed(r) && r.value >= 0));
    let n = LEGS.length ? 1 : 0;
    return h('section', { class: 'analysis-vars', 'aria-labelledby': 'analysis-vars-title' },
      h('div', { class: 'analysis-vars-head' },
        h('div', { class: 'eyebrow' }, 'Итог анализа'),
        h('h3', { id: 'analysis-vars-title' }, 'Варианты ставки'),
        h('p', { class: 'small muted' }, (LEGS.length ? 'Экспресс стратегии — основной. ' : '') + 'Ординары — настоящие ставки со своей, меньшей суммой. Любой другой рынок — «В свою ставку» в таблице матча.')),
      noValue && UI.callout('bad', 'alert', h('b', null, 'Валуя нет ни на одном рынке — модель не советует ставить. '), 'Варианты показаны, чтобы было видно, сколько не хватает до честного кэфа.'),
      !LEGS.length && noExpressNote(),
      LEGS.length ? expressCard(root) : null,
      vs.map(v => variantCard(root, v, ++n)),
      freshNote(),
      slipCard(root));
  }

  // ---------- своя ставка (Р29) ----------
  // Любой рынок из таблицы матча, по одному на матч: второй рынок того же матча заменяет первый. Стратегия ее не
  // предлагала и сумму не считает; ставка меняет банк, как любая, и считается в калибровке и CLV модели
  function addToSlip(r) {
    if (UI.view.active) return;
    const i = SLIP.findIndex(x => x.row.m === r.m);
    let hint = null;
    if (i >= 0 && SLIP[i].row !== r) { hint = 'Один рынок на матч: «' + SLIP[i].row.name + '» заменен на «' + r.name + '».'; SLIP[i] = { row: r }; }
    else if (i < 0) SLIP.push({ row: r });
    slipModal(ROOT, hint);
  }
  function slipModal(root, hint) {
    if (!SLIP.length) { UI.toast('Своя ставка пуста — нажмите «В свою ставку» у рынка в таблице матча', 'info'); return; }
    betModal(root, { mode: 'save', kind: 'own', rows: SLIP.map(x => x.row), slip: true, hint, stake: null, rec: 0 });
  }
  function slipCard(root) {
    if (!SLIP.length || UI.view.active) return null;
    const rows = SLIP.map(x => x.row), total = totalOf(rows.map(r => r.odds));
    return h('section', { class: 'card analysis-slip', 'aria-label': 'Своя ставка' },
      h('div', { class: 'card-head' }, h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Собирается'), h('h3', null, 'Своя ставка')), chip('Своя', 'warn', 'user')),
      h('div', { class: 'card-body' },
        h('ul', { class: 'analysis-slip-list' }, rows.map(r => h('li', null, h('span', null, h('b', null, r.name), h('small', null, D.match({ p1: r.m.a, p2: r.m.b }))), h('span', { class: 'odds' }, fmt.odds(r.odds))))),
        h('div', { class: 'small muted' }, (rows.length > 1 ? 'Экспресс × ' + rows.length : 'Ординар') + ' · кэф ' + fmt.odds(total) + ' · валуй ' + fmt.signedPct(evOf(rows, rows.map(r => r.odds)) * 100, 1))),
      h('div', { class: 'card-foot' }, h('div', { class: 'analysis-actions' },
        button('Открыть', { kind: 'secondary', icon: 'edit', onClick: () => slipModal(root) }),
        button('Очистить', { kind: 'ghost', icon: 'x', onClick: () => { SLIP.length = 0; draw(root); } }))));
  }

  // Окно ставки для вариантов и своей ставки: кэф при ставке у каждого события, сумма с долей банка, букмекер,
  // выплата, вероятность и валуй по модели, предупреждения. mode: save — сохранить ставку, stake — изменить сумму
  function betModal(root, o) {
    const own = o.kind === 'own' && !o.variant;
    let rows = o.rows.slice();
    let taken = (o.taken || rows.map(r => r.odds)).slice();
    const bankCur = inCur(BANK), minCur = MIN_CUR(), dec = curDec();
    let v = o.stake ? inCur(o.stake) : null;
    let bk = BK;
    const asText = x => (dec ? fmt.dec(x, 2) : fmt.int(x));
    const legsHost = h('div', { class: 'analysis-legodds' });
    const sumHost = h('div', { class: 'stack', style: 'gap:10px', 'aria-live': 'polite' });
    let goBtn = null;
    const typeChip = () => (rows.length > 1 ? chip('Экспресс × ' + rows.length, 'outline', 'layers') : chip('Ординар', 'info', 'target'));
    const typeHost = h('div', { class: 'row', style: 'gap:6px' });
    const okOdds = () => taken.every(x => x >= 1.01 && x <= 50);
    const okStake = () => Number.isFinite(v) && v >= minCur && v <= bankCur;
    function drawLegs() {
      UI.clear(legsHost);
      UI.append(UI.clear(typeHost), [typeChip(), own || o.kind === 'own' ? chip('Своя', 'warn', 'user') : null]);
      rows.forEach((r, i) => {
        const id = 'analysis-bm-odd-' + i;
        const inp = h('input', { class: 'input', id, value: fmt.odds(taken[i]), inputmode: 'decimal', autocomplete: 'off', maxlength: '6', 'aria-describedby': id + '-hint' });
        const err = h('div', { class: 'field-error', role: 'alert', hidden: true });
        inp.addEventListener('input', () => {
          const x = parseFloat(String(inp.value).replace(',', '.'));
          const ok = x >= 1.01 && x <= 50;
          err.hidden = ok; err.textContent = ok ? '' : 'Кэф от 1.01 до 50';
          inp.classList.toggle('invalid', !ok); inp.setAttribute('aria-invalid', String(!ok));
          taken[i] = ok ? Math.round(x * 100) / 100 : NaN;
          drawSum();
        });
        inp.addEventListener('blur', () => { if (taken[i] >= 1.01) inp.value = fmt.odds(taken[i]); });
        const rm = own ? button('', { kind: 'ghost', size: 'sm', icon: 'trash', title: 'Убрать «' + r.name + '»', onClick: () => { rows.splice(i, 1); taken.splice(i, 1); const k = SLIP.findIndex(x => x.row === r); if (k >= 0) SLIP.splice(k, 1); if (!rows.length) { close(); draw(root); UI.toast('Своя ставка пуста', 'x'); return; } drawLegs(); drawSum(); } }) : null;
        legsHost.appendChild(h('div', { class: ['analysis-legodd', own && 'has-rm'] },
          h('label', { class: 'analysis-legodd-name', for: id }, h('b', null, r.name),
            h('small', { id: id + '-hint' }, D.match({ p1: r.m.a, p2: r.m.b }) + ' · модель ' + pr(r.claude) + ' · валуй ' + fmt.signedPct(r.value * 100, 1) + (r.odds !== taken[i] ? ' · в анализе ' + fmt.odds(r.odds) : '')),
            r.status.status !== 'express' ? h('small', { class: 'warn-text' }, r.status.status === 'paused' ? 'рынок на проверке' : 'для сравнения · ' + r.status.n + ' из ' + F.NEED) : null),
          inp, rm, err));
      });
    }
    const stakeF = UI.field({ label: 'Сумма ставки', id: 'analysis-bm-stake', value: v ? asText(v) : '', placeholder: own ? 'Например, ' + asText(toStep(bankCur * 0.01)) : '', suffix: fmt.cur(), inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off',
      hint: own ? 'Рекомендованной суммы нет: стратегия эту ставку не считает' : o.rec ? 'Рекомендовано ' + fmt.money(o.rec) + ' — ' + sharePct(o.rec) + ' банка по таблице ' + (o.kind === 'single' ? 'ординаров' : 'экспрессов, до ' + pctTxt(BEST_CAP)) : 'Валуя нет — суммы по таблице нет, сумма на ваш риск', attrs: { maxlength: '12', 'aria-label': 'Сумма ставки, ' + curName() } });
    const stakeIn = stakeF.querySelector('input');
    stakeIn.addEventListener('input', () => { v = roundCur(parseFloat(String(stakeIn.value).replace(/\s/g, '').replace(',', '.'))); drawSum(); });
    stakeIn.addEventListener('blur', () => { if (Number.isFinite(v)) stakeIn.value = asText(v); });
    const bks = [...new Set([BK].concat(D.user.bookmakers || []))];
    const bkF = UI.field({ label: 'Букмекер', id: 'analysis-bm-bk', value: bk, options: bks, hint: 'Где вы сделали ставку — от его кэфа считаются выплата и CLV' });
    bkF.querySelector('select').addEventListener('change', e => { bk = e.target.value; drawSum(); });
    function drawSum() {
      UI.clear(sumHost);
      const ready = rows.length && okOdds();
      const total = ready ? totalOf(taken) : null, p = pOf(rows), ev = ready ? evOf(rows, taken) : null;
      const r = okStake() ? fmt.fromMoney(v) : null;
      const pay = r && total ? payoutOf(r, total) : null;
      sumHost.appendChild(UI.kv([
        ['Итоговый кэф', total ? fmt.odds(total) : '—'],
        ['Доля банка', r ? sharePct(r) + ' из ' + fmt.money(BANK) : '—'],
        ['Выплата при выигрыше', pay ? fmt.money(pay) : '—'],
        ['Чистая прибыль', pay ? fmt.signedMoney(pay - r) : '—'],
        ['Вероятность по модели', '≈ ' + pr(p) + (rows.length > 1 ? ' (' + rows.map(x => pr(x.claude)).join(' × ') + ')' : '')],
        ['Валуй по модели', ev == null ? '—' : h('span', { class: ev < 0 ? 'bad-text' : null }, fmt.signedPct(ev * 100, 1))],
      ]));
      if (!okOdds()) sumHost.appendChild(UI.callout('bad', 'alert', 'Проверьте кэфы при ставке: допустимо от 1.01 до 50.'));
      if (v != null && Number.isFinite(v) && !okStake()) sumHost.appendChild(UI.callout('bad', 'alert', v > bankCur ? 'Сумма больше банка (' + fmt.money(BANK) + ').' : 'Минимальная ставка — ' + fmt.money(fmt.fromMoney(minCur)) + '.'));
      if (ev != null && ev < 0) sumHost.appendChild(UI.callout('bad', 'alert', h('b', null, 'Валуя нет — модель не советует ставить. '), 'По оценке модели ставка в минусе: ' + fmt.signedPct(ev * 100, 1) + '.'));
      const weak = rows.filter(x => x.status.status !== 'express');
      if (weak.length) sumHost.appendChild(UI.callout('warn', 'flask', h('b', null, 'Модель по рынку не проверена: '), weak.map(x => x.name + (x.status.status === 'paused' ? ' — рынок на проверке' : ' — для сравнения, ' + x.status.n + ' из ' + F.NEED + ' событий')).join('; ') + '. Вероятность — ориентир, а не проверенная оценка.'));
      const low = rows.filter(x => x.m.conf !== 'high');
      if (low.length) sumHost.appendChild(UI.callout(low.some(x => x.m.conf === 'low') ? 'warn' : 'info', 'alert', h('b', null, 'Уверенность анализа ' + (low.some(x => x.m.conf === 'low') ? 'низкая' : 'средняя') + ': '), low.map(x => D.match({ p1: x.m.a, p2: x.m.b }) + ' — ' + x.m.confNote).join('; ') + '.'));
      if (r) { const w = shareWarn(v / bankCur * 100); if (w) sumHost.appendChild(w); }
      if (goBtn) goBtn.disabled = !(rows.length && okOdds() && okStake() && bk);
    }
    let close = () => {};
    const note = own
      ? UI.callout('', 'user', h('b', null, 'Своя ставка. '), 'Стратегия ее не предлагала и сумму не считает. Она меняет банк, как любая ставка: от банка считаются просадка и итог недели для адаптаций, она входит в лимиты ответственной игры, калибровку и CLV модели. В «Аналитике» — отдельно, фильтр «Свои».')
      : o.kind === 'single'
        ? UI.callout('', 'target', h('b', null, 'Ординар — настоящая ставка. '), 'Меняет банк, рассчитывается как экспресс (по архиву или «Внести результат»), входит в калибровку и CLV. В «Аналитике» — фильтр «Ординары».')
        : UI.callout('', 'user', h('b', null, 'Экспресс вне правил стратегии — запишется как своя ставка. '), 'В «Аналитике» — фильтр «Свои»; версии стратегии сравниваются только по ее экспрессам.');
    drawLegs();
    const m = UI.modal({
      title: o.mode === 'stake' ? 'Изменить сумму' : own ? 'Своя ставка' : 'Сохранить ставку',
      wide: true,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        o.hint && UI.callout('info', 'refresh', o.hint),
        typeHost,
        h('div', { class: 'stack', style: 'gap:6px' }, h('span', { class: 'field-label' }, 'Кэф при ставке'), legsHost,
          own ? h('div', { class: 'field-hint' }, 'Добавить событие — закройте окно и нажмите «В свою ставку» у рынка другого матча. Один рынок на матч.') : h('div', { class: 'field-hint' }, 'По умолчанию — кэф из ввода. Букмекер дал другой — поправьте: от него считаются выплата, результат и CLV.')),
        h('div', { class: 'analysis-bm-grid' }, stakeF, bkF),
        sumHost, note),
      actions: c => [
        button('Отмена', { kind: 'secondary', onClick: c }),
        goBtn = button(o.mode === 'stake' ? 'Применить' : 'Сохранить ставку', { kind: 'primary', icon: 'check', onClick: () => {
          if (!(rows.length && okOdds() && okStake() && bk)) { stakeIn.focus(); return; }
          if (o.mode === 'stake') {
            const st = VST[o.variant.id];
            st.stake = sameMoney(fmt.fromMoney(v), o.rec) ? null : fmt.fromMoney(v);
            st.taken = taken.every((x, i) => x === rows[i].odds) ? null : taken.slice();
            c(); draw(root); UI.toast('Сумма изменена: ' + fmt.money(fmt.fromMoney(v)), 'edit'); return;
          }
          c(); saveOwnBet(o, rows, taken, fmt.fromMoney(v), bk);
        } }),
      ],
      onClose: () => { if (own && ROOT && ROOT.isConnected) draw(ROOT); },
    });
    close = m.close;
    drawSum();
  }
  // Р29: ординар варианта — single, своя ставка и экспресс вне правил — own; в «Ставках» у них метка
  function saveOwnBet(o, rows, taken, stakeRub, bk) {
    const kind = o.kind === 'single' ? 'single' : 'own';
    const legs = rows.map((r, i) => Object.assign({ closing: null, result: 'open', surface: 'hard', tournament: 'Шанхай', bestOf: 3 }, r.leg,
      { marketLabel: MK[r.k] ? MK[r.k].label : r.name, odds: taken[i], p: r.claude, fresh: !!F.FAMILY[r.leg.market] }, r.push ? { pPush: r.push } : null));
    const total = totalOf(taken);
    const bet = { id: Math.max(...D.bets.map(b => b.id)) + 1, date: TODAY, tournament: 'Шанхай', surface: 'hard', legs, total, stake: stakeRub, status: 'open', profit: 0, bankAfter: null, clv: null, bookmaker: bk, analysis: ID, source: 'app', own: kind === 'own', single: kind === 'single' };
    D.bets.push(bet);
    D.stats.open = D.bets.filter(b => b.status === 'open').length;
    if (o.variant) Object.assign(VST[o.variant.id], { decision: 'saved', betId: bet.id, stake: stakeRub });
    if (o.slip) SLIP.length = 0;
    UI.toast('Ставка №' + bet.id + ' сохранена · ' + (kind === 'single' ? 'ординар' : 'своя') + ': ' + fmt.money(stakeRub) + ' @' + fmt.odds(total), 'check');
    D.lastSavedBet = bet.id;
    UI.go('bets');
  }

  // ---------- почему так ----------
  function whyCard() {
    if (ST.whyOpen == null) ST.whyOpen = !UI.isMobile(); // на компьютере места хватает — раскрыто сразу
    const m1 = MX[0], m2 = MX[1];
    const r1 = m1.rows[0], r2 = m2.rows[0], f1 = m1.rows[2];
    const fr = MX.flatMap(m => m.rows).filter(x => x.status.status === 'compare' && x.value > 0).sort((a, b) => b.value - a.value)[0];
    const reasons = [
      h('li', null, h('b', null, m1.A.short + ' П1. '), 'ML-модель (Эло + признаки) дает ' + pr(r1.model) + ', Claude поднял до ' + pr(r1.claude) + ': ' + m1.A.short + ' свежее (3 матча за 14 дней против 4 у ' + m1.B.short + ', у которого последний матч — три сета). Рынок закладывает ' + pr(r1.market) + ', валуй ' + fmt.signedPct(r1.value * 100, 1) + '.'),
      h('li', null, h('b', null, 'Фора −1.5 на проверке. '), 'Claude поднял ' + m1.A.short + ' 2:0 с ' + pr(f1.model) + ' до ' + pr(f1.claude) + ', валуй ' + fmt.signedPct(f1.value * 100, 1) + '. Но модель сетов, похоже, завышает вероятность третьего сета — пока это проверяют, фора ±1.5 не идет ни в экспресс, ни в варианты.'),
      h('li', null, h('b', null, 'Уроки. '), 'L-014 (фора −1.5 против подающего левши) проверен и не применен: ' + m1.B.short + ' правша, подача в среднем ' + m1.B.serve.speed + ' км/ч. По L-019 пост из соцсетей о плече ' + m1.B.short + ' без подтверждения турнира не учитывался.'),
      h('li', null, h('b', null, m2.A.short + ' П1. '), 'ML-модель дает ' + pr(r2.model) + ', Claude — ' + pr(r2.claude) + ': плюс за прием и личные встречи почти съеден возрастом и трехсетовиком в 1/32 (4 окт). С кэфом ' + fmt.odds(r2.odds) + ' валуй ' + fmt.signedPct(r2.value * 100, 1) + '.'),
      fr && h('li', null, h('b', null, 'Новые рынки. '), fr.name + ' дает ' + fmt.signedPct(fr.value * 100, 1) + ', но это рынок для сравнения (' + fr.status.n + ' из ' + F.NEED + ' событий): в архиве нет его кэфов, проверить модель против рынка нечем. Поставить можно своей ставкой.'),
      h('li', null, h('b', null, 'Главный риск. '), 'Тай-брейк в матче ' + D.match({ p1: m1.a, p2: m1.b }) + ' и возраст Джоковича: если наши p завышены на 5 п.п. по каждой ноге, перевес экспресса исчезает.'),
    ].filter(Boolean);
    const body = h('div', { class: 'analysis-why-body', id: 'analysis-why', hidden: !ST.whyOpen },
      h('ol', { class: 'analysis-reasons' }, reasons),
      h('div', { class: 'stack', style: 'gap:8px' },
        h('h4', null, 'Проверка по правилам стратегии ' + STRAT_V),
        h('ul', { class: 'analysis-rules' }, rules().map(r => h('li', { class: r.ok ? 'ok' : 'warn' }, icon(r.ok ? 'check' : 'alert'), h('div', { style: 'min-width:0' }, h('span', { class: 'sr-only' }, r.ok ? 'Выполнено: ' : 'Внимание: '), r.t, r.d && h('small', null, r.d)))))));
    const toggle = h('button', { type: 'button', class: 'analysis-why-toggle', 'aria-expanded': String(ST.whyOpen), 'aria-controls': 'analysis-why', on: { click: () => {
      ST.whyOpen = !ST.whyOpen; body.hidden = !ST.whyOpen; toggle.setAttribute('aria-expanded', String(ST.whyOpen));
    } } },
      h('span', { class: 'analysis-why-text' }, h('span', { class: 'analysis-why-title' }, 'Почему так'), h('span', { class: 'card-sub' }, whySub(reasons.length))),
      icon('chevronDown'));
    return h('section', { class: 'card', 'aria-label': 'Почему так' }, h('h3', { class: 'analysis-why-h' }, toggle), body);
  }
  function whySub(n) {
    const rs = rules(), bad = rs.filter(r => !r.ok).length;
    return n + ' доводов модели и проверка по ' + rs.length + ' ' + fmt.plural(rs.length, 'правилу', 'правилам', 'правилам') + (bad ? ' · не выполнено: ' + bad : '');
  }
  function rules() {
    const form5 = id => { const f = formOf(id).slice(0, 5); return f.filter(x => x === 'W').length; }; // form[0] — последний матч в базе
    const who = l => (MK[l.market].who === 'A' ? l.p1 : l.p2);
    const fora = LEGS.filter(l => l.market === 'h1m');
    if (!LEGS.length) {
      const n = MX.filter(m => m.pickRow).length;
      return [
        { ok: false, t: 'Экспресс из 2–' + STRAT.maxLegs + ' событий', d: 'правила прошло ' + n + ' ' + fmt.plural(n, 'событие', 'события', 'событий') + ' из ' + MX.length },
        { ok: true, t: 'Один рынок на матч, только П1 и П2', d: 'фора ±1.5 на проверке, новые рынки — для сравнения' },
      ];
    }
    const list = [
      { ok: new Set(LEGS.map(l => l.m)).size === LEGS.length && LEGS.every(l => allowed(l.row)), t: 'Один рынок на матч, только П1 и П2', d: 'фора ±1.5 на проверке, новые рынки — для сравнения' },
      { ok: LEGS.length >= 2 && LEGS.length <= STRAT.maxLegs, t: LEGS.length + ' события — разрешено 2–' + STRAT.maxLegs },
      { ok: LEGS.every(l => l.odds >= STRAT.oddsMin && l.odds <= STRAT.oddsMax), t: 'Кэф каждой ноги ' + fmt.odds(STRAT.oddsMin) + '–' + fmt.odds(STRAT.oddsMax), d: LEGS.map(l => fmt.odds(l.odds)).join(' и ') },
      { ok: LEGS.every(l => l.p * 100 >= STRAT.minProb), t: 'Вероятность каждой ноги ≥ ' + STRAT.minProb + '%', d: LEGS.map(l => pr(l.p)).join(' и ') },
      { ok: LEGS.every(l => l.p * l.odds > 1), t: 'Перевес каждой ноги выше нуля (p × кэф > 1)', d: LEGS.map(l => fmt.signedPct((l.p * l.odds - 1) * 100, 1)).join(' и ') },
      { ok: TOTAL_ODDS <= STRAT.totalMax, t: 'Итоговый кэф ≤ ' + fmt.odds(STRAT.totalMax), d: fmt.odds(TOTAL_ODDS) },
    ];
    if (fora.length) list.push({ ok: fora.every(l => l.p >= 0.55), t: 'Для форы −1.5 вероятность 2:0 ≥ 55%', d: fora.map(l => pr(l.p)).join(' и ') });
    list.push({ ok: LEGS.every(l => form5(who(l)) >= 3), t: 'Форма за 5 матчей не хуже 3–2', d: LEGS.map(l => D.P[who(l)].short + ' ' + form5(who(l)) + '–' + (5 - form5(who(l)))).join(', ') });
    list.push({ ok: true, t: 'Нет травм и перегруза', d: D.P[LEGS[0].p1].short + ' — 3 матча за 14 дней, ' + D.P[LEGS[1].p1].short + ' — 2; подтвержденных травм нет' });
    return list;
  }

  function metaLine() {
    return h('a', { class: 'analysis-meta', href: '#costs', title: 'Подробнее о расходах на ИИ' }, icon('coins'),
      h('span', null, h('b', null, 'Анализ #' + ID), ' · режим «' + MODE.label + '» · ' + fmt.int(TOTAL.tokens) + ' токенов, вход ' + MODE.model.split(' ')[0] + ' из кэша ' + CACHE_SHARE + '% · ' + (TOTAL.searches ? TOTAL.searches + ' ' + fmt.plural(TOTAL.searches, 'поиск', 'поиска', 'поисков') : 'без веб-поиска') + ' · ' + fmt.usd(TOTAL.cost) + (EST != null ? ' (оценка была ≈' + fmt.usd(EST) + ')' : '') + ' · ' + fmt.duration(TOTAL.sec) + ' · ' + MODELS.join(' + ')),
      icon('chevronRight'));
  }

  // ---------- вы ввели не те матчи, что есть в примере ----------
  function foreignNote(root) {
    if (OPENED) {
      return h('div', { class: 'analysis-foreign-mini', role: 'note' }, icon('info'),
        h('span', null, 'Макет: анализ #' + OPENED.id + ' (' + OPENED.matches.map(D.match).join(', ') + ') показан на демо-примере Синнер — Руне и Джокович — Рублев. В приложении откроется он сам.'));
    }
    if (!FOREIGN) return null;
    const list = REQ.events.map(e => nm(e.p1) + ' — ' + nm(e.p2));
    const used = MX.filter(m => m.entered).map(m => D.match({ p1: m.a, p2: m.b }));
    const back = button('Вернуться к вводу', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#new', ro: true });
    if (ST.exampleAck) {
      return h('div', { class: 'analysis-foreign-mini', role: 'note' }, icon('alert'),
        h('span', null, 'Показан пример анализа, а не ваши события: ' + list.join(', ') + '.'),
        back);
    }
    return h('div', { class: 'callout warn analysis-foreign', role: 'note' }, icon('alert'),
      h('div', { style: 'min-width:0' },
        h('b', null, 'Это пример, а не разбор ваших матчей. '),
        'В макете подробный разбор есть только для примера Синнер — Руне и Джокович — Рублев. Вы ввели: ' + list.join(', ') + '. В приложении здесь будет разбор ваших матчей.' +
          (used.length ? ' Ваши кэфы на ' + used.join(' и ') + ' в примере учтены.' : ''),
        h('div', { class: 'analysis-foreign-acts' }, back,
          button('Смотреть пример', { kind: 'ghost', size: 'sm', icon: 'eye', onClick: () => { ST.exampleAck = true; draw(root); } }))));
  }

  // ---------- сборка экрана ----------
  let ROOT = null;
  function draw(root) {
    ROOT = root;
    const mobile = UI.isMobile();
    UI.clear(root);
    root.classList.toggle('analysis-running', !RUN.done && !RUN.stopped);
    if (RUN.stopped) {
      UI.append(root, [headBlock(RUN.stopped.kind === 'cancel' ? 'cancelled' : 'stopped'), demoPanel(root), foreignNote(root), stopBanner(root), progressStopped(root)]);
      return;
    }
    if (!RUN.done) {
      UI.append(root, [headBlock('running'), demoPanel(root), foreignNote(root), progressRunning(root), skeleton()]);
      return;
    }
    UI.append(root, [
      headBlock('done'),
      demoPanel(root),
      foreignNote(root),
      progressDone(root),
      h('div', { class: 'analysis-result' },
        h('div', { class: 'analysis-col analysis-main' }, MX.map(m => matchCard(m, mobile)), whyCard()),
        h('div', { class: ['analysis-col', 'analysis-side', ST.calcOpen && 'is-calc-open'] }, variantsBlock(root))),
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

  // #analysis-<состояние> — состояние для согласования (fail, limit, cap, keyown, keyadmin, cancel, offline, news, reused);
  // #analysis-A-0140 — анализ из списка «Последние анализы» на экране «Новый анализ». Возвращает статус открытого анализа.
  function applyParam(param) {
    // адрес без параметра: перерисовка (тема, ширина экрана) не запускает состояние заново
    try { history.replaceState(history.state, '', location.href.split('#')[0] + '#analysis'); } catch (e) { /* в песочнице адрес может быть недоступен */ }
    const recent = (D.recentAnalyses || []).find(a => a.id === param);
    const id = recent ? (recent.status === 'failed' ? 'fail' : recent.status === 'cancelled' ? 'cancel' : 'ok') : param;
    const scen = SCENARIOS.find(x => x.id === id);
    if (!scen) return null;
    SCEN = scen;
    setup(REQ); resetRun();
    if (recent) { ID = recent.id; D.currentAnalysis = ID; OPENED = recent.demo ? null : recent; }
    startRun();
    return recent ? recent.status : 'scenario';
  }

  setup(D.pendingAnalysis);

  UI.register('analysis', {
    title: 'Анализ',
    nav: 'new',
    crumbs: 'Новый анализ → Анализ #' + ID,
    render(root, param) {
      // пришел новый запрос с экрана «Новый анализ» — пересчитываем все под него и запускаем заново обычным ходом:
      // демо-состояние прошлого анализа (сбой, отмена) к новому не переносится
      if ((D.pendingAnalysis || null) !== REQ) { SCEN = SCENARIOS[0]; OPENED = null; setup(D.pendingAnalysis); resetRun(); }
      const opened = param ? applyParam(param) : null;
      baseRows(); // players.js загружается после этого файла: досье по базе собираем при показе
      setHead();
      // при «уменьшении движения» анализ сразу показывается завершенным
      if (RUN.startedAt == null) { startRun(); scheduleRecord(); }
      if (opened === 'done') RUN.startedAt = performance.now() - TOTAL_MS;
      if (opened === 'failed' || opened === 'cancelled') RUN.startedAt = performance.now() - stopTime();
      const t = performance.now() - RUN.startedAt, stopT = stopTime();
      if (!RUN.done && !RUN.stopped && stopT != null && t >= stopT) stopAt(root);
      else if (!RUN.done && !RUN.stopped && t >= TOTAL_MS) finish(root);
      else draw(root);
    },
  });
})();
