/* ИИ и расходы: вверху — лимит участника на ключе администратора или бюджет ключа администратора (по роли),
   ниже — собственные запуски: токены и кэш, стоимость каждого запуска, рычаги экономии и настройки.
   Фактические цифры — из DATA.ai, DATA.me и DATA.admin (запуски 1–7 окт). Прогнозы и «до/после» помечены как оценки. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, A = DATA.ai;

  // ---------- цены (прайс Anthropic за 1M токенов; совпадают с формулой в data.js) ----------
  const PRICE = {
    'Opus 5.5': { in: 4, out: 20, cache: 0.2, id: 'claude-opus-5-5' },
    'Sonnet 5.5': { in: 2, out: 10, cache: 0.2, id: 'claude-sonnet-5-5' },
    'Haiku 4.5': { in: 1, out: 5, cache: 0.1, id: 'claude-haiku-4-5' },
  };
  const SEARCH = 0.01;          // $10 за 1000 веб-поисков
  const SEARCH_TOKENS = 4000;   // примерно столько входных токенов добавляют результаты одного поиска
  const DAYS = 7, MONTH_DAYS = 31, PER_MONTH = MONTH_DAYS / DAYS;
  // Старый бот (legacy/telegram-bot/bot.py, выключен): Sonnet 4.6, до 20 циклов tool use, без кэша — оценка на один анализ
  // по docs/TOKEN_ECONOMY.md §3.2 (12 итераций, ≈580 тыс. входа, ≈18 тыс. выхода; разброс $1–4,5).
  // Поиск — DuckDuckGo Instant Answer (bot.py:158–194), он бесплатный.
  const OLD = { model: 'Sonnet 4.6', pin: 3, pout: 15, input: 580000, output: 18000, searches: 0 };
  OLD.cost = (OLD.input * OLD.pin + OLD.output * OLD.pout) / 1e6 + OLD.searches * SEARCH;
  // Тот же цикл на Opus 5.5 без досье (§3.2): ≈750 тыс. входа (новый токенизатор) и ≈35 тыс. выхода;
  // с кэшем внутри цикла ≈84% входа читается из кэша — это ≈$1,3 вместо ≈$3,7.
  const NO_DOSSIER = { input: 750000, output: 35000, cacheShare: 0.84 };

  // Effort (глубина размышлений): множитель к выходным токенам относительно уровня, на котором
  // сняты фактические запуски (DEFAULTS.effort). Оценка: §4.5 — −20…50% выхода на low.
  const EFFORT_K = { low: 0.55, medium: 1, high: 1.5 };
  const EFFORT_LABEL = { low: 'Низкая', medium: 'Средняя', high: 'Высокая' };
  const EFFORT_LEVELS = { analysis: ['low', 'medium', 'high'], refresh: ['low', 'medium'], postmortem: ['low', 'medium'], parse: ['low', 'medium'] };
  const supportsEffort = model => model !== 'Haiku 4.5';

  const TYPES = [
    { id: 'analysis', label: 'Анализ матчей', short: 'Анализ', tiny: 'Анализ', bar: 'Анализ матчей', what: 'Вероятности по событиям, валуй и экспресс', options: ['Opus 5.5', 'Sonnet 5.5'] },
    { id: 'refresh', label: 'Обновление профилей', short: 'Профили', tiny: 'Профили', bar: 'Профили', what: 'Ночью пакетом: статистика, форма, новости', options: ['Sonnet 5.5', 'Haiku 4.5', 'Opus 5.5'] },
    { id: 'postmortem', label: 'Разбор ставки', short: 'Разбор ставок', tiny: 'Ставки', bar: 'Разбор ставки', what: 'После расчета: что сработало — кандидаты в уроки', options: ['Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5'] },
    { id: 'parse', label: 'Разбор текста', short: 'Разбор текста', tiny: 'Текст', bar: 'Разбор текста', what: 'Вставленный текст → список событий', options: ['Haiku 4.5', 'Sonnet 5.5', 'Opus 5.5'] },
  ];
  const typeOf = id => TYPES.find(t => t.id === id);

  // ---------- форматтеры ----------
  const nfCache = {};
  const nf = d => nfCache[d] || (nfCache[d] = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usd = (n, d = 2) => (n < 0 ? '−' : '') + '$' + nf(d).format(Math.abs(n));
  const usdM = n => usd(n, n >= 100 ? 0 : 1);
  const pct = (x, d = 0) => nf(d).format(x * 100) + '%';
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const clone = o => JSON.parse(JSON.stringify(o));
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const weekday = iso => WD[new Date(iso.slice(0, 10) + 'T12:00:00Z').getUTCDay()];

  // ---------- кто смотрит и чьи запуски считаем ----------
  // Р7, Р9, Р13: участник на ключе администратора видит свой лимит и только свои запуски. Общие фоновые
  // задачи (ночное обновление профилей) всегда идут на ключе администратора и в лимит участника не входят.
  // Администратор видит бюджет всего ключа, а ниже — свои запуски вместе с общими фоновыми задачами.
  const SHARED = ['refresh'];
  const isShared = r => SHARED.includes(r.type);
  const days = [];
  for (let d = 1; d <= DAYS; d++) days.push('2026-10-0' + d);
  // Прогноз на месяц по темпу 1–7 окт — та же формула, что на главной
  const monthPace = v => v / DAYS * MONTH_DAYS;
  // V — зритель; RUNS, BASE, TOT, SPENT, FORECAST, byDay — агрегаты по его запускам (пересчитываются при отрисовке)
  let V, SCOPE_RUNS, RUNS, BASE, TOT, SPENT, CACHE_SHARE, FORECAST, byDay, cacheSavedWeek, SCOPE_TYPES;
  function setScope() {
    const me = D.me || {};
    const admin = !!(UI.auth && UI.auth.isAdmin);
    V = { admin, me, own: !admin && me.aiMode === 'own', limit: me.limit || D.LIMIT_DEFAULT };
    SCOPE_RUNS = admin ? A.runs : A.runs.filter(r => !isShared(r));
    RUNS = SCOPE_RUNS.slice().sort((a, b) => b.at.localeCompare(a.at));
    BASE = {};
    TYPES.forEach(t => {
      const rs = SCOPE_RUNS.filter(r => r.type === t.id);
      const n = rs.length;
      const s = { n, input: sum(rs, r => r.input), cached: sum(rs, r => r.cached), output: sum(rs, r => r.output), searches: sum(rs, r => r.searches), cost: sum(rs, r => r.cost), duration: sum(rs, r => r.duration) };
      BASE[t.id] = Object.assign(s, {
        avgIn: n ? s.input / n : 0, avgOut: n ? s.output / n : 0, avgSearch: n ? s.searches / n : 0, avgCost: n ? s.cost / n : 0,
        cacheShare: s.input ? s.cached / s.input : 0, perMonth: n * PER_MONTH, avgDuration: n ? s.duration / n : 0,
      });
    });
    SCOPE_TYPES = TYPES.filter(t => BASE[t.id].n);
    TOT = {
      input: sum(SCOPE_RUNS, r => r.input), cached: sum(SCOPE_RUNS, r => r.cached), output: sum(SCOPE_RUNS, r => r.output),
      searches: sum(SCOPE_RUNS, r => r.searches), runs: SCOPE_RUNS.length,
    };
    SPENT = Math.round(sum(SCOPE_RUNS, r => r.cost) * 100) / 100;
    CACHE_SHARE = TOT.input ? TOT.cached / TOT.input : 0;
    FORECAST = monthPace(SPENT);
    byDay = days.map(day => {
      const rs = SCOPE_RUNS.filter(r => r.at.slice(0, 10) === day);
      return { day, runs: rs, cost: sum(rs, r => r.cost), tokens: sum(rs, r => r.input + r.output) };
    });
    // Сколько сэкономил кэш за 1–7 окт: кэш-токены по цене обычного входа минус фактическая цена
    cacheSavedWeek = sum(SCOPE_RUNS, r => r.cached * (PRICE[r.model].in - PRICE[r.model].cache) / 1e6 * (r.batch ? 0.5 : 1));
    if (!V.admin && SHARED.includes(runFilter)) runFilter = 'all';
  }
  // Общие фоновые задачи за 1–7 окт (их оплачивает ключ администратора)
  const SHARED_RUNS = A.runs.filter(isShared);
  const sharedSpent = () => (D.ai.sharedSpent != null ? D.ai.sharedSpent : sum(SHARED_RUNS, r => r.cost));

  // Бюджет ключа администратора: кто на нем, сколько потратил и прогноз на месяц.
  // Прогноз учитывает личные лимиты: на 100% анализы участника на ключе администратора останавливаются.
  function keyBudget() {
    const B = D.admin.budget;
    const onKey = D.users.filter(u => u.aiMode === 'admin' && u.status !== 'deleted');
    const k = MONTH_DAYS / DAYS;
    const forecast = sum(onKey, u => u.status !== 'active' ? u.spent : u.limit ? Math.min(u.limit.monthly, u.spent * k) : u.spent * k) + B.shared * k;
    const own = D.users.filter(u => u.aiMode === 'own' && u.status !== 'deleted');
    return { B, onKey, own, forecast };
  }

  // ---------- что связано с каждым запуском (для окна деталей) ----------
  const META = {};
  const activeStrategy = D.strategyVersions.find(v => v.status === 'active') || { id: 'v3', brier: 0.201, logloss: 0.583 };
  const lessonsInPrompt = D.lessons.filter(l => l.inPrompt).map(l => l.id);
  const tourName = date => { const t = D.calendar.find(c => date >= c.from && date <= c.to); return t ? t.name : 'Шанхай'; };
  (function buildMeta() {
    const an = A.runs.filter(r => r.type === 'analysis'), rf = A.runs.filter(r => r.type === 'refresh'), ps = A.runs.filter(r => r.type === 'parse'), pm = A.runs.filter(r => r.type === 'postmortem');
    // Номера анализов идут до #A-0141: #A-0142 — живой демо-анализ на экране «Анализ».
    // Последний анализ дня, после которого появилась ставка, ссылается на нее.
    an.forEach((r, i) => {
      const day = r.at.slice(0, 10);
      const sameDay = an.filter(x => x.at.slice(0, 10) === day);
      const bet = sameDay[sameDay.length - 1] === r ? D.bets.find(b => b.date === day) : null;
      const n = bet ? bet.legs.length : 2 + (i % 2);
      const ref = 'анализ #A-' + String(131 + i).padStart(4, '0');
      META[r.id] = {
        ref: bet ? ref + ' → ставка №' + bet.id : ref,
        href: bet ? (bet.status === 'open' ? '#bets' : '#bets-' + bet.id) : null,
        btn: bet ? 'К ставке №' + bet.id : null,
        what: bet
          ? bet.legs.map(D.match).join(', ') + (bet.status === 'open' ? ' · ставка в игре' : '')
          : n + ' ' + fmt.plural(n, 'событие', 'события', 'событий') + ' · ' + tourName(day) + ' · ставка не сформирована: ни одно событие не прошло порог ' + D.strategy.minProb + '%',
        prompt: 'analysis v3 · стратегия ' + activeStrategy.id,
        effort: 'medium',
        prefix: 'Итерации 2–3 читают из кэша то, что записала первая: инструкции, стратегию ' + activeStrategy.id + ', уроки ' + lessonsInPrompt.join(', ') + ' и досье игроков',
      };
    });
    rf.forEach((r, i) => {
      const n = r.searches + 6;
      META[r.id] = { ref: 'пакет #B-' + String(17 + i).padStart(4, '0'), href: '#players', btn: 'К игрокам', what: 'Обновлено ' + n + ' ' + fmt.plural(n, 'профиль', 'профиля', 'профилей') + ' (ночной пакет)', prompt: 'profile-refresh v2', effort: 'low', prefix: 'Инструкции по профилю и прошлое досье игрока' };
    });
    pm.forEach(r => {
      const bet = D.bets.filter(b => b.status !== 'open' && b.date < r.at.slice(0, 10)).pop();
      META[r.id] = { ref: 'ставка №' + (bet ? bet.id : '—'), href: bet ? '#bets-' + bet.id : '#bets', btn: bet ? 'К ставке №' + bet.id : 'К ставкам', what: bet ? (bet.legs.length > 1 ? 'Экспресс из ' + bet.legs.length + ' событий' : 'Ординар') + ' · ' + (bet.status === 'win' ? 'выигрыш' : bet.status === 'loss' ? 'проигрыш' : 'возврат') : 'Разбор рассчитанной ставки', prompt: 'postmortem v2', effort: 'low', prefix: 'Инструкции разбора и стратегия ' + activeStrategy.id };
    });
    ps.forEach((r, i) => {
      const n = 3 + (i % 3);
      META[r.id] = { ref: 'ввод #T-' + String(201 + i).padStart(4, '0'), href: '#new', btn: 'Новый анализ', what: 'Текст из ' + n + ' событий → список матчей', prompt: 'parse-events v1', effort: null, prefix: null };
    });
  })();

  // ---------- настройки и оценка расходов ----------
  // Лимиты — по docs/TOKEN_ECONOMY.md §6: анализ — мягкий порог $0,50 и жесткий $1,00 (совпадает с потолком
  // на анализ из Р13); поиски — не больше 6 на запуск (2–3 на игрока) и 15 в день.
  // limitMonth — личный ориентир администратора для его запусков: подсказка, анализы не останавливает.
  // Настоящие лимиты — бюджет ключа администратора и лимиты участников (DATA.admin, DATA.users), Р9 и Р13.
  const DEFAULTS = {
    models: { parse: 'Haiku 4.5', analysis: 'Opus 5.5', postmortem: 'Sonnet 5.5', refresh: 'Sonnet 5.5' },
    effort: { parse: 'low', analysis: 'medium', postmortem: 'low', refresh: 'low' },
    limitMonth: A.budget, limitSoft: 0.5, limitHard: 1, searchLimit: 6, searchDay: 15,
    cache: true, batch: true, newsCache: true, dossier: true, eval: true,
  };
  let saved = clone(DEFAULTS);
  let draft = clone(DEFAULTS);
  let runFilter = 'all', showAllRuns = false;
  const candidateState = {}; // результаты проверки кандидатов: { sonnet: 'accepted'|'rejected', effort: … }

  // Множитель выхода от effort: относительно уровня, на котором сняты фактические запуски
  function effortK(type, set) {
    if (!supportsEffort(set.models[type]) || !supportsEffort(DEFAULTS.models[type])) return 1;
    const e = (set.effort && set.effort[type]) || DEFAULTS.effort[type];
    return EFFORT_K[e] / EFFORT_K[DEFAULTS.effort[type]];
  }

  function perRun(type, set) {
    const b = BASE[type], p = PRICE[set.models[type]];
    if (!b.n) return 0;
    let inp = b.avgIn, cs = b.cacheShare, out = b.avgOut, srch = b.avgSearch;
    if (type === 'analysis' && !set.dossier) { inp = NO_DOSSIER.input; cs = NO_DOSSIER.cacheShare; out = NO_DOSSIER.output; } // модель сама читает файлы в 10–20 итераций
    out *= effortK(type, set);
    if (type === 'analysis') {
      const want = b.avgSearch + (set.newsCache ? 0 : 2) + (set.searchLimit > 0 ? 0 : 4);
      srch = set.searchLimit > 0 ? Math.min(want, set.searchLimit) : want;
    } else if (type === 'refresh') srch = b.avgSearch + (set.newsCache ? 0 : 5);
    if (!set.cache) cs = 0;
    const cached = inp * cs, plain = inp - cached + (srch - b.avgSearch) * SEARCH_TOKENS;
    const batch = type === 'refresh' && set.batch ? 0.5 : 1;
    return ((plain * p.in + cached * p.cache + out * p.out) / 1e6) * batch + srch * SEARCH;
  }
  const estRaw = set => TYPES.reduce((a, t) => a + perRun(t.id, set) * BASE[t.id].perMonth, 0);
  const forecastFor = set => FORECAST + estRaw(set) - estRaw(DEFAULTS);
  const withSet = (set, patch) => { const s = clone(set); Object.keys(patch).forEach(k => { if (k === 'models' || k === 'effort') Object.assign(s[k], patch[k]); else s[k] = patch[k]; }); return s; };

  // Рычаги экономии: включен ли и сколько экономит (оценка на месяц при остальных настройках как сейчас)
  const LEVERS = [
    { id: 'dossier', title: 'Сжатое досье вместо 10–20 итераций', how: 'ИИ получает одно готовое досье по игрокам из базы, а не читает .md и JSON-файлы по одному, пересылая всю историю на каждом шаге. 2–4 запроса к модели вместо 10–20.',
      isOn: s => s.dossier, set: (s, on) => withSet(s, { dossier: on }) },
    { id: 'cache', title: 'Кэширование стабильной части промпта', how: 'Внутри одного анализа итерации 2–3 читают инструкции, уроки и досье из кэша — у Opus 5.5 в 20 раз дешевле обычного входа. Между анализами кэш (5 мин) обычно не доживает.',
      isOn: s => s.cache, set: (s, on) => withSet(s, { cache: on }) },
    { id: 'search', title: 'Лимит веб-поисков и кэш новостей 12 ч', how: 'Не больше 6 поисков на анализ (2–3 на игрока) и 15 в день; новости по игроку не ищутся заново, если им меньше 12 часов. Каждый поиск — $0,01 и ≈ 4 тыс. токенов во входе.',
      isOn: s => s.searchLimit > 0 && s.newsCache, set: (s, on) => withSet(s, on ? { searchLimit: s.searchLimit || 6, newsCache: true } : { searchLimit: 0, newsCache: false }) },
    { id: 'routing', title: 'Маршрутизация моделей', how: 'Простые задачи — дешевым моделям: разбор текста на Haiku 4.5, разбор ставок и профили на Sonnet 5.5. Opus 5.5 — только для анализа.',
      isOn: s => !(s.models.parse === 'Opus 5.5' && s.models.postmortem === 'Opus 5.5' && s.models.refresh === 'Opus 5.5'),
      set: (s, on) => on ? (LEVERS[3].isOn(s) ? clone(s) : withSet(s, { models: { parse: 'Haiku 4.5', postmortem: 'Sonnet 5.5', refresh: 'Sonnet 5.5' } })) : withSet(s, { models: { parse: 'Opus 5.5', postmortem: 'Opus 5.5', refresh: 'Opus 5.5' } }) },
    { id: 'batch', title: 'Batch API для фоновых задач', how: 'Ночное обновление профилей идет пакетом: ответ приходит в течение суток, зато вдвое дешевле.',
      isOn: s => s.batch, set: (s, on) => withSet(s, { batch: on }) },
    // Рычаги без переключателя: уже встроены в схему v2, их вклад входит в фактическую цену анализа
    { id: 'prompt', fixed: true, title: 'Сжатые инструкции: 5–7 тыс. символов вместо 22 тыс.', how: 'Шесть файлов старого бота свели к сути стратегии: работа с файлами, правила экспресса и шаблон ответа ушли в код и JSON-схему. System prompt короче на 60–70%.',
      saveNote: 'входит в цену анализа' },
    { id: 'json', fixed: true, title: 'Ответ JSON по схеме вместо длинного текста', how: 'Вероятности, факторы и короткое обоснование — полями JSON; текст для экрана собирает приложение. Видимый выход короче на 40–60%, ставку не нужно угадывать по тексту.',
      saveNote: 'входит в цену анализа' },
    { id: 'effort', candidate: true, title: 'Effort анализа: medium → low', how: 'Меньше размышлений — меньше выходных токенов Opus 5.5, а это ≈ 60% цены анализа. Риск реальный: на трудных матчах может упасть качество, поэтому только через eval-набор.',
      perRunNote: true,
      check: () => ({ type: 'analysis', kind: 'effort', from: saved.effort.analysis, to: 'low' }),
      apply: () => { saved.effort.analysis = 'low'; draft.effort.analysis = 'low'; },
      rejectedNote: 'Лог-лосс вышел за допуск — оставили medium',
      isOn: s => s.effort.analysis === 'low', set: (s, on) => withSet(s, { effort: { analysis: on ? 'low' : 'medium' } }) },
    { id: 'sonnet', candidate: true, title: 'Анализ матчей на Sonnet 5.5', how: 'Вдвое дешевле Opus 5.5 по входу и выходу. Включим, только если на eval-наборе лог-лосс и Brier не хуже с допуском.',
      check: () => ({ type: 'analysis', kind: 'model', from: saved.models.analysis, to: 'Sonnet 5.5' }),
      apply: () => { saved.models.analysis = 'Sonnet 5.5'; draft.models.analysis = 'Sonnet 5.5'; },
      rejectedNote: 'Лог-лосс хуже на 0,011, ДИ выше допуска — оставили Opus 5.5',
      isOn: s => s.models.analysis === 'Sonnet 5.5', set: (s, on) => withSet(s, { models: { analysis: on ? 'Sonnet 5.5' : 'Opus 5.5' } }) },
  ];
  const leverSaving = (lv, s) => lv.fixed ? 0 : estRaw(lv.set(s, false)) - estRaw(lv.set(s, true));
  const ALL_OFF = { models: { parse: 'Opus 5.5', analysis: 'Opus 5.5', postmortem: 'Opus 5.5', refresh: 'Opus 5.5' }, effort: clone(DEFAULTS.effort), limitMonth: 15, limitSoft: 0.5, limitHard: 1, searchLimit: 0, searchDay: 0, cache: false, batch: false, newsCache: false, dossier: false, eval: true };

  // Допуск правила «не хуже» (TOKEN_ECONOMY §2.4): верхняя граница 95% ДИ разницы
  const TOL = { logloss: 0.01, brier: 0.005 };
  const RULE_TEXT = 'не хуже с допуском: верхняя граница 95% ДИ разницы лог-лосса ≤ +0,01, Brier ≤ +0,005';

  // ---------- eval-наборы (демо-результаты проверки) ----------
  const EVAL = {
    analysis: { set: '220 событий после июня 2026: свои рассчитанные и исторические, 15–20% трудных', size: 220, perRun: 2.3 },
    parse: { set: '150 сообщений с проверенным разбором', size: 150, perRun: 1 },
    postmortem: { set: '40 ставок с подтвержденными выводами', size: 40, perRun: 1 },
    refresh: { set: '30 досье, сверенных вручную', size: 30, perRun: 1 },
  };
  // Изменение для проверки: { type, kind: 'model'|'effort', from, to }
  const applyChange = (set, c) => withSet(set, c.kind === 'effort' ? { effort: { [c.type]: c.to } } : { models: { [c.type]: c.to } });
  const changeLabel = c => (c.kind === 'effort' ? 'effort ' : '') + c.from + ' → ' + c.to;
  function evalCost(c) {
    const per = perRun(c.type, applyChange(saved, c)) - BASE[c.type].avgSearch * SEARCH; // проверка идет на снимках входа, без поиска
    return EVAL[c.type].size / EVAL[c.type].perRun * per * 0.5;                          // через Batch API
  }
  // Строка результата: { name, now, next, delta, verdict } · verdict: ok | over | same | better | worse | noproof
  const d3 = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt.dec(Math.abs(v), 3);
  const ci3 = (lo, hi) => 'ДИ ' + d3(lo) + '…' + d3(hi);
  function metricRow(name, now, dv, lo, hi, tol, dec) {
    const f = v => fmt.dec(v, dec || 3);
    const verdict = hi <= 0 ? 'better' : hi <= tol ? 'ok' : 'over';
    return { name, now: f(now), next: f(now + dv), delta: d3(dv) + ' (' + ci3(lo, hi) + ')', verdict };
  }
  function eceRow(now, dv, lo, hi) {
    const f = v => fmt.dec(v, 1) + ' п.п.', s = v => (v > 0 ? '+' : v < 0 ? '−' : '') + fmt.dec(Math.abs(v), 1);
    return { name: 'Калибровка, ECE (допуск +2 п.п.)', now: f(now), next: f(now + dv), delta: s(dv) + ' (ДИ ' + s(lo) + '…' + s(hi) + ')', verdict: hi <= 2 ? 'ok' : 'over' };
  }
  const pp = v => Number.isInteger(Math.round(v * 10) / 10) ? String(Math.round(v)) : fmt.dec(v, 1);
  const pctRow = (name, now, next, verdict) => ({ name, now: pp(now) + '%', next: pp(next) + '%', delta: now === next ? '0' : (next > now ? '+' : '−') + pp(Math.abs(next - now)) + ' п.п.', verdict });
  function evalResult(c) {
    const LL = activeStrategy.logloss, BR = activeStrategy.brier;
    if (c.type === 'analysis') {
      if (c.kind === 'model') {
        if (c.to === DEFAULTS.models.analysis) return { ok: true, rows: [metricRow('Лог-лосс', LL, 0, 0, 0, TOL.logloss), metricRow('Brier', BR, 0, 0, 0, TOL.brier)].map(r => Object.assign(r, { delta: '—', verdict: 'same' })), why: 'Возврат к проверенной настройке: метрики известны.' };
        return { ok: false,
          rows: [metricRow('Лог-лосс', LL, 0.011, 0.004, 0.018, TOL.logloss), metricRow('Brier', BR, 0.004, 0.001, 0.007, TOL.brier), eceRow(3.1, 1.8, 0.3, 3.3)],
          why: 'Sonnet 5.5 завышает шансы фаворитов на 3–5 п.п. в матчах с тай-брейками. Верхняя граница интервала выше допуска — экономия не стоит потери качества.' };
      }
      // Effort: демо-метрики каждого уровня относительно medium (v3) и полуширина 95% ДИ парной разницы
      const E = { low: { ll: 0.003, br: 0.001, ece: 0.3 }, medium: { ll: 0, br: 0, ece: 0 }, high: { ll: -0.002, br: -0.001, ece: -0.2 } };
      const HW = { ll: 0.005, br: 0.002, ece: 1.2 };
      const a = E[c.from] || E.medium, b = E[c.to] || E.medium;
      const back = c.to === DEFAULTS.effort.analysis;
      const cheaper = EFFORT_K[c.to] < EFFORT_K[c.from];
      const mr = (name, now, k, tol) => {
        const dv = b[k] - a[k], r = metricRow(name, now + a[k], dv, dv - HW[k], dv + HW[k], tol);
        if (back) r.verdict = 'same'; else if (!cheaper) r.verdict = dv + HW[k] < 0 ? 'better' : 'noproof';
        return r;
      };
      const ece = eceRow(3.1 + a.ece, b.ece - a.ece, b.ece - a.ece - HW.ece, b.ece - a.ece + HW.ece);
      if (back) ece.verdict = 'same';
      const rows = [mr('Лог-лосс', LL, 'll', TOL.logloss), mr('Brier', BR, 'br', TOL.brier), ece];
      if (back) return { ok: true, rows, why: 'Возврат к проверенной настройке medium: ее метрики известны.' };
      if (cheaper) {
        const ok = rows.every(r => r.verdict !== 'over');
        return { ok, rows, why: ok ? 'Разница в пределах допуска — это «не хуже», а не «то же самое». После включения подтверждаем теневым прогоном на реальных анализах; на трудном хвосте (≈40 событий) интервал слишком широкий для отдельного вывода.' : 'Верхняя граница интервала выше допуска — экономия не стоит потери качества.' };
      }
      const proven = rows.slice(0, 2).every(r => r.verdict === 'better');
      return { ok: proven, rows, why: proven ? 'Дороже, но улучшение доказано: интервал целиком ниже нуля.' : 'Дороже, а улучшение не доказано: интервал разницы задевает ноль. Изменение «ради качества» принимается, только если интервал целиком ниже нуля.' };
    }
    const dearer = c.kind === 'effort' || (c.type === 'parse' && c.to !== 'Haiku 4.5');
    if (c.type === 'parse') return c.to === 'Haiku 4.5'
      ? { ok: true, rows: [pctRow('Точность разбора событий', 98.7, 98.7, 'same')], why: 'Качество то же, дешевле.' }
      : { ok: true, rows: [pctRow('Точность разбора событий', 98.7, c.to === 'Opus 5.5' ? 99.1 : 98.9, 'same')], why: dearer ? 'Качество не хуже, но дороже: на коротких текстах Haiku 4.5 справляется так же, разница в пределах шума на 150 сообщениях.' : 'Качество не хуже.' };
    if (c.type === 'postmortem') return c.kind === 'model' && c.to === 'Haiku 4.5'
      ? { ok: false, rows: [pctRow('Совпадение с подтвержденными уроками', 85, 72, 'worse')], why: 'Haiku 4.5 пропускает причины проигрыша, связанные с усталостью и покрытием.' }
      : { ok: true, rows: [pctRow('Совпадение с подтвержденными уроками', 85, c.to === 'Opus 5.5' || c.to === 'medium' ? 87 : 85, 'same')], why: dearer || c.to === 'Opus 5.5' ? 'Качество не хуже, но дороже: +2 п.п. на 40 ставках — в пределах шума.' : 'Качество не хуже.' };
    return c.kind === 'model' && c.to === 'Haiku 4.5'
      ? { ok: false, rows: [pctRow('Полнота по травмам и снятиям', 96, 88, 'worse'), pctRow('Ошибки в статистике подачи', 0.4, 2.1, 'worse')], why: 'Haiku 4.5 теряет часть статистики из длинных страниц и пропускает снятия — порог полноты 95%.' }
      : { ok: true, rows: [pctRow('Полнота по травмам и снятиям', 96, c.to === 'Opus 5.5' || c.to === 'medium' ? 97 : 96, 'same')], why: dearer || c.to === 'Opus 5.5' ? 'Качество не хуже, но дороже.' : 'Качество не хуже.' };
  }

  // ---------- стили экрана ----------
  UI.css('costs', `
    .costs-head h2 { font-size: var(--fs-2xl); }
    .costs-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .card.stat.costs-hero { padding: 18px; gap: 14px; height: 100%; justify-content: flex-start; }
    .costs-hero-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; padding-top: 2px; }
    .costs-hero-top { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .costs-hero-value { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; min-width: 0; }
    .costs-hero-value .stat-value { white-space: nowrap; }
    .costs-hero-value .of { color: var(--fg-3); font-size: var(--fs-lg); white-space: nowrap; }
    .costs-hero-value .chip { margin-left: auto; }
    .costs-bar { position: relative; height: 12px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
    .costs-bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 999px; }
    .costs-bar .proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 42%, transparent) 0 3px, color-mix(in srgb, var(--accent) 16%, transparent) 3px 7px); }
    .costs-bar .spent { background: var(--accent); }
    .costs-bar.warn .spent { background: var(--warn); }
    .costs-bar.bad .spent { background: var(--bad); }
    .costs-bar-legend { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 14px; font-size: var(--fs-xs); color: var(--fg-2); }
    .costs-bar-legend span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
    .costs-bar-legend i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .costs-bar-legend i.spent { background: var(--accent); }
    .costs-bar-legend i.proj { background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--accent) 50%, transparent) 0 2px, color-mix(in srgb, var(--accent) 18%, transparent) 2px 4px); }
    .costs-kv { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; padding-top: 14px; border-top: 1px solid var(--line); }
    .costs-kv > div { min-width: 0; }
    .costs-kv dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-kv dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .costs-kv dd small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); white-space: normal; }
    .costs-tiles > .card { height: 100%; }
    .costs-hero-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; }
    .costs-hero-sub { font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-hero-note { display: flex; gap: 6px; align-items: flex-start; font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.45; margin: 0; }
    .costs-hero-note svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .costs-hero-actions .costs-hero-note { font-size: var(--fs-sm); color: var(--fg-2); align-items: center; }
    .costs-bar .tick { left: 80%; width: 2px; margin-left: -1px; border-radius: 0; background: var(--fg-2); opacity: .55; }
    .costs-bar-legend i.tick { width: 2px; height: 12px; border-radius: 0; background: var(--fg-2); opacity: .55; }
    .costs-top > div > .card { height: 100%; }
    .costs-section { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 8px 0 -4px; }
    .costs-section h3 { font-size: var(--fs-lg); }
    .costs-who .t { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .costs-who li.total { border-top: 1px solid var(--line-strong); }
    .costs-who li.total .t, .costs-who li.total .v { font-weight: 700; }
    .costs-who-name { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .costs-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .costs-rules li { display: grid; grid-template-columns: 32px minmax(0, 1fr); gap: 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: start; }
    .costs-rules li:first-child { border-top: 0; padding-top: 2px; }
    .costs-rules-ic { width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); }
    .costs-rules-ic svg { width: 16px; height: 16px; }
    .costs-rules-ic.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .costs-rules-ic.bad { background: var(--bad-soft); color: var(--bad-ink); }
    .costs-rules-ic.info { background: var(--info-soft); color: var(--info-ink); }
    .costs-rules-body { min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-rules-body b { color: var(--fg); font-weight: 600; font-variant-numeric: tabular-nums; }
    .costs-main { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
    .costs-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1180px) {
      .costs-main { display: flex; flex-direction: column; align-items: stretch; }
      .costs-col { display: contents; }
      .costs-o-1 { order: 1; } .costs-o-2 { order: 2; } .costs-o-3 { order: 3; } .costs-o-4 { order: 4; } .costs-o-5 { order: 5; }
    }
    @media (max-width: 960px) { .costs-main, .costs-col { gap: 16px; } }
    .costs-tiles .stat-hint { line-height: 1.35; }
    /* Плитки KPI: спарклайн всегда справа от подписи (десктоп) и прижат к низу плитки (телефон) */
    .costs-kpi .stat { height: 100%; }
    .costs-kpi .stat-foot { margin-top: auto; }
    @media (min-width: 721px) {
      .costs-kpi .stat-foot { flex-wrap: nowrap; align-items: flex-end; }
      .costs-kpi .stat-foot > .row { flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }
      .costs-kpi .stat-foot > svg { flex: none; }
    }

    .costs-howto { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 6px; align-items: flex-start; }
    .costs-howto svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }
    .costs-card .card-head { flex-wrap: nowrap; }
    .costs-card .card-head > div:first-child { flex: 1 1 auto; }
    .costs-card .card-head > .row { flex: none; }
    @media (max-width: 720px) { .costs-card .card-head { flex-wrap: wrap; } }

    .costs-types { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
    .costs-type { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; align-items: center; width: calc(100% + 16px); padding: 10px 8px; margin: 0 -8px; border: 0; border-bottom: 1px solid var(--line); background: none; color: var(--fg); text-align: left; cursor: pointer; border-radius: 0; }
    .costs-types li:last-child .costs-type { border-bottom: 0; }
    .costs-type:hover { background: var(--surface-2); }
    .costs-type-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; min-width: 0; }
    .costs-type-meta { grid-column: 1 / 2; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .costs-type-cost { grid-row: 1 / 3; grid-column: 2; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; display: flex; align-items: center; gap: 6px; }
    .costs-type-cost b { display: block; font-weight: 600; }
    .costs-type-cost small { display: block; font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-type-cost svg { width: 16px; height: 16px; color: var(--fg-3); }

    .costs-levers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .costs-lever { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 4px 12px; padding: 14px 0; border-top: 1px solid var(--line); align-items: start; }
    .costs-lever:first-child { border-top: 0; padding-top: 2px; }
    .costs-rank { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); font-weight: 600; font-size: var(--fs-sm); color: var(--fg-2); font-variant-numeric: tabular-nums; }
    .costs-lever.candidate .costs-rank { background: var(--info-soft); color: var(--info-ink); }
    .costs-lever.fixed .costs-rank { background: var(--good-soft); color: var(--good-ink); }
    .costs-lever.fixed .costs-rank svg { width: 14px; height: 14px; }
    .costs-lever-save.soft { font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); white-space: normal; max-width: 92px; }
    @media (max-width: 720px) {
      .costs-lever { gap: 4px 10px; }
      .costs-lever-save { max-width: 84px; white-space: normal; }
      .costs-lever-save small { white-space: normal; line-height: 1.3; }
    }
    .costs-lever-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .costs-lever-title { font-weight: 600; line-height: 1.3; }
    .costs-lever-text { font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-lever-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
    .costs-lever-save { text-align: right; white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; }
    .costs-lever-save small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .costs-total { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-total b { color: var(--fg); font-variant-numeric: tabular-nums; }

    .costs-compare { display: grid; grid-template-columns: minmax(0, .75fr) minmax(0, .85fr) minmax(0, 1.4fr); margin: 0; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; font-size: var(--fs-sm); }
    .costs-compare > div { padding: 8px 10px; border-top: 1px solid var(--line); min-width: 0; line-height: 1.4; }
    .costs-compare > .hd { border-top: 0; background: var(--surface-2); font-size: var(--fs-xs); font-weight: 600; color: var(--fg-2); }
    .costs-compare > .hd.new { color: var(--accent-ink); background: var(--accent-soft); }
    .costs-compare > .lbl { color: var(--fg-3); }
    .costs-compare > .new { font-weight: 600; }
    .costs-compare small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    @media (max-width: 720px) {
      .costs-compare { grid-template-columns: minmax(0, .8fr) minmax(0, 1.2fr); }
      .costs-compare > .hd.blank { display: none; }
      .costs-compare > .lbl { grid-column: 1 / -1; padding-bottom: 0; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
      .costs-compare > .old:not(.hd), .costs-compare > .new:not(.hd) { border-top: 0; padding-top: 2px; }
    }

    .costs-nowrap { white-space: nowrap; }
    @media (max-width: 960px) {
      .segmented.costs-runs-filter { display: flex; width: 100%; }
      .segmented.costs-runs-filter button { flex: 1 1 auto; padding: 6px 6px; }
    }
    .costs-sub { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .costs-task { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 500; }
    .costs-table .table td { white-space: nowrap; }
    .costs-table .table td:nth-child(2) { white-space: normal; }
    .costs-table .table-wrap { position: relative; }
    @media (max-width: 1180px) {
      .costs-table .table th:nth-child(7), .costs-table .table td:nth-child(7),
      .costs-table .table th:nth-child(9), .costs-table .table td:nth-child(9) { display: none; }
    }
    .costs-table tbody tr:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
    .costs-runlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .costs-runlist li + li { border-top: 1px solid var(--line); }
    .costs-run { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; width: 100%; padding: 12px; margin: 0; text-align: left; background: none; border: 0; cursor: pointer; color: var(--fg); align-items: start; }
    .costs-run:hover { background: var(--surface-2); }
    .costs-run-main { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .costs-run-meta { font-size: var(--fs-xs); color: var(--fg-3); }
    .costs-run-cost { text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .costs-run-cost small { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--fg-3); }

    .costs-settings-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px 36px; }
    @media (max-width: 1080px) { .costs-settings-grid { grid-template-columns: minmax(0, 1fr); } }
    .costs-settings-col { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
    .costs-limits { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
    .costs-limits.two { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    @media (max-width: 720px) {
      .costs-limits { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 10px; }
      .costs-limits .costs-wide { grid-column: 1 / -1; }
      .costs-settings-foot .btn { flex: 1 1 auto; }
    }
    .costs-task-set { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .costs-task-set + .costs-task-set { padding-top: 14px; border-top: 1px solid var(--line); }
    .costs-task-set .field { gap: 6px; }
    .costs-effort { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; min-width: 0; }
    .costs-effort-label { font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-effort .segmented { flex: none; }
    .costs-effort-off { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--fg-3); }
    .costs-effort-off svg { width: 14px; height: 14px; flex: none; }
    @media (max-width: 720px) {
      .costs-effort { flex-direction: column; align-items: stretch; }
      .costs-effort .segmented { display: flex; width: 100%; }
      .costs-effort .segmented button { flex: 1 1 0; }
    }
    .costs-task-hint { font-size: var(--fs-xs); color: var(--fg-3); font-variant-numeric: tabular-nums; }
    .costs-ver-name { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 600; min-width: 0; }
    .costs-ver-name small { font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .costs-ver .table th, .costs-ver .table td { padding-left: 10px; padding-right: 10px; }
    .costs-ver .table th:first-child, .costs-ver .table td:first-child { padding-left: 0; }
    .costs-ver .table th:last-child, .costs-ver .table td:last-child { padding-right: 0; }
    .costs-ver .table td { white-space: nowrap; }
    .costs-ver .table td:first-child { white-space: normal; }
    .costs-tablebox { border: 1px solid var(--line); border-radius: var(--r-md); }
    .costs-tablebox .table th, .costs-tablebox .table td { padding: 9px 8px; }
    .costs-tablebox .table th:first-child, .costs-tablebox .table td:first-child { padding-left: 12px; }
    .costs-tablebox .table th:last-child, .costs-tablebox .table td:last-child { padding-right: 12px; }
    .costs-tablebox .table td { white-space: nowrap; }
    .costs-toggles { display: flex; flex-direction: column; }
    .costs-toggles > * { padding: 12px 0; border-top: 1px solid var(--line); }
    .costs-toggles > *:first-child { border-top: 0; padding-top: 0; }
    .costs-forecast { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 16px; align-items: center; padding: 14px; border-radius: var(--r-md); background: var(--surface-2); }
    .costs-forecast-num { font-family: var(--font-display); font-size: var(--fs-xl); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .costs-forecast-num .was { color: var(--fg-3); font-size: var(--fs-md); font-weight: 500; }
    .costs-forecast .chip { justify-self: end; }
    .costs-dirty { font-size: var(--fs-sm); color: var(--fg-3); margin-left: auto; }
    .costs-dirty.on { color: var(--warn-ink); font-weight: 600; }
    @media (max-width: 720px) { .costs-dirty { margin-left: 0; width: 100%; } }

    .costs-split { display: flex; height: 14px; border-radius: 4px; overflow: hidden; gap: 2px; background: var(--surface); }
    .costs-split i { display: block; min-width: 3px; }
    .costs-formula { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); background: var(--surface-2); border-radius: var(--r-sm); padding: 10px 12px; line-height: 1.6; overflow-wrap: break-word; }
    .costs-modal-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .costs-verdict { display: flex; align-items: center; gap: 4px; }
    .costs-progress { display: flex; flex-direction: column; gap: 6px; }
    .costs-price-model b { display: block; }
    .costs-mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
    .costs-mlist li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 2px 12px; padding: 10px 0; border-top: 1px solid var(--line); align-items: center; }
    .costs-mlist li:first-child { border-top: 0; padding-top: 2px; }
    .costs-mlist .t { font-weight: 500; min-width: 0; }
    .costs-mlist .s { grid-column: 1 / 2; font-size: var(--fs-xs); color: var(--fg-3); min-width: 0; }
    .costs-mlist .v { grid-row: 1 / 3; grid-column: 2; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .kv.costs-detail { grid-template-columns: 150px minmax(0, 1fr); }
    .kv.costs-detail dd { text-align: left; }
    @media (max-width: 720px) {
      .kv.costs-detail { grid-template-columns: minmax(0, 1fr); gap: 2px; }
      .kv.costs-detail dt { font-size: var(--fs-xs); color: var(--fg-3); }
      .kv.costs-detail dd { text-align: left; margin-bottom: 8px; }
    }
    .costs-price-model .mono { font-size: var(--fs-xs); color: var(--fg-3); }
  `);

  // ---------- мелкие элементы ----------
  const modelChip = m => chip(m, 'outline');
  const batchChip = () => chip('Batch −50%', 'accent', 'layers');
  const howto = text => h('div', { class: 'costs-howto' }, icon('info'), h('span', null, text));
  // Список для телефона вместо широкой таблицы: [{title, sub, value}]
  const mlist = items => h('ul', { class: 'costs-mlist' }, items.map(it => h('li', null, h('span', { class: 't' }, it.title), it.sub ? h('span', { class: 's' }, it.sub) : null, it.value != null ? h('span', { class: 'v' }, it.value) : null)));
  const budgetKind = share => share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : 'good';

  // ---------- окно: разбор стоимости запуска ----------
  function payer(r) {
    if (isShared(r)) return 'Ключ администратора — общая фоновая задача, в лимиты участников не входит';
    if (V.admin) return 'Ваш ключ (ключ администратора) — ваш запуск, входит в бюджет ключа';
    if (V.own) return 'Ваш ключ — с вашего счета Anthropic';
    return 'Ключ администратора — входит в ваш лимит (' + usd(V.limit.monthly, 0) + ' в месяц)';
  }
  function runModal(r) {
    const t = typeOf(r.type), p = PRICE[r.model], m = META[r.id] || {};
    const k = r.batch ? 0.5 : 1;
    const plain = r.input - r.cached;
    const parts = [
      { name: 'Чтение из кэша', tokens: r.cached, price: p.cache, cost: r.cached * p.cache / 1e6 * k, color: 'var(--s1)' },
      { name: 'Обычный вход', tokens: plain, price: p.in, cost: plain * p.in / 1e6 * k, color: 'var(--s2)' },
      { name: 'Выход (с размышлениями)', tokens: r.output, price: p.out, cost: r.output * p.out / 1e6 * k, color: 'var(--s3)' },
      { name: 'Веб-поиски', tokens: null, n: r.searches, cost: r.searches * SEARCH, color: 'var(--s4)' },
    ];
    const total = sum(parts, x => x.cost);
    const noCache = ((r.input * p.in + r.output * p.out) / 1e6) * k + r.searches * SEARCH;
    const shown = parts.filter(x => x.cost > 0);
    const n = v => nf(2).format(v);
    const formula = '(' + fmt.int(r.cached) + ' × ' + n(p.cache) + ' + ' + fmt.int(plain) + ' × ' + n(p.in) + ' + ' + fmt.int(r.output) + ' × ' + n(p.out) + ') / 1\u00a0000\u00a0000'
      + (r.batch ? ' × 0,5' : '') + (r.searches ? ' + ' + r.searches + ' × 0,01' : '') + ' = ' + usd(total, 3);

    UI.modal({
      title: t.label + ' · ' + fmt.datetime(r.at),
      wide: true,
      body: close => [
        h('div', { class: 'costs-modal-chips' }, modelChip(r.model), r.batch && batchChip(), chip(fmt.duration(r.duration), null, 'clock'),
          r.cached ? chip(pct(r.cached / r.input) + ' входа из кэша', 'good', 'database') : chip('Без кэша', null, 'database')),
        h('div', { class: 'row-between', style: 'align-items:flex-end' },
          h('div', { style: 'min-width:0' }, h('div', { class: 'eyebrow' }, 'Стоимость запуска'), h('div', { class: 'stat-value' }, usd(r.cost, 3))),
          r.cached ? h('div', { class: 'small soft', style: 'text-align:right' }, 'Без кэша было бы ' + usd(noCache, 3), h('br'), h('span', { class: 'good-text', style: 'font-weight:600' }, 'кэш сэкономил ' + pct(1 - total / noCache))) : null),
        h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'costs-split', role: 'img', 'aria-label': 'Из чего сложилась цена: ' + shown.map(x => x.name + ' ' + usd(x.cost, 4)).join(', ') },
            shown.map(x => h('i', { style: { width: (x.cost / total * 100) + '%', background: x.color }, title: x.name + ': ' + usd(x.cost, 4) }))),
          UI.legend(shown.map(x => ({ name: x.name + ' · ' + pct(x.cost / total), color: x.color, type: 'box' })))),
        UI.isMobile() ? mlist(parts.map(x => ({ title: x.name, sub: x.tokens != null ? fmt.int(x.tokens) + ' ток. × ' + usd(x.price) + ' за 1M' + (r.batch ? ' × 0,5' : '') : x.n + ' ' + fmt.plural(x.n, 'поиск', 'поиска', 'поисков') + ' × $0,01', value: usd(x.cost, 4) }))) : UI.table({
          columns: [
            { label: 'Статья', render: x => x.name },
            { label: 'Объем', align: 'r', render: x => x.tokens != null ? fmt.int(x.tokens) + ' ток.' : x.n + ' ' + fmt.plural(x.n, 'поиск', 'поиска', 'поисков') },
            { label: 'Цена', align: 'r', render: x => x.tokens != null ? usd(x.price) + ' / 1M' : '$10 / 1000' },
            { label: 'Сумма', align: 'r', render: x => h('b', null, usd(x.cost, 4)) },
          ],
          rows: parts,
        }),
        r.batch ? h('div', { class: 'small soft' }, 'Batch API: токены на 50% дешевле, ответ — в течение суток. Подходит для ночных задач.') : null,
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Формула'), h('div', { class: 'costs-formula' }, formula)),
        h('dl', { class: 'kv costs-detail' }, [
          ['Кто платит', payer(r)],
          ['Связано', m.href ? h('a', { href: m.href, on: { click: close } }, m.ref) : (m.ref || '—')],
          ['Что сделал', m.what || t.what],
          ['Версия промпта', h('span', { class: 'mono' }, m.prompt || '—')],
          ['Effort', m.effort ? h('span', { class: 'mono' }, m.effort) : 'не задается: Haiku 4.5 его не поддерживает'],
          ['Из кэша читается', m.prefix || 'Не кэшируется: у Haiku 4.5 минимальный префикс для кэша — 4096 токенов, а запрос короче'],
          ['ID модели', h('span', { class: 'mono' }, p.id)],
        ].map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        howto('Цены — прайс Anthropic за 1M токенов на 7 окт 2026. Запись в кэш (×1,25 к цене входа, раз в 5 минут) в макете не выделена отдельно.'),
      ],
      actions: close => [
        button('Закрыть', { kind: 'secondary', onClick: close }),
        m.href ? button(m.btn || 'Открыть', { kind: 'primary', iconRight: 'arrowRight', href: m.href, attrs: { on: { click: close } } }) : null,
      ],
    });
  }

  // ---------- окно: цены моделей ----------
  function pricesModal() {
    const used = model => TYPES.filter(t => saved.models[t.id] === model).map(t => t.short).join(', ') || '—';
    UI.modal({
      title: 'Цены моделей',
      wide: true,
      body: [
        h('p', { class: 'soft' }, 'За 1 млн токенов, прайс Anthropic на 7 октября 2026' + (UI.isMobile() ? ' (справа — вход / выход)' : '') + '. В приложении цены берутся из настроек, а не зашиты в код.'),
        UI.isMobile() ? mlist(Object.keys(PRICE).map(m => ({ title: m, sub: h('span', null, h('span', { class: 'mono' }, PRICE[m].id), h('br'), 'кэш ' + usd(PRICE[m].cache) + ' · ' + used(m)), value: usd(PRICE[m].in, 0) + ' / ' + usd(PRICE[m].out, 0) }))) : UI.table({
          columns: [
            { label: 'Модель', render: m => h('div', { class: 'costs-price-model' }, h('b', null, m), h('span', { class: 'mono' }, PRICE[m].id)) },
            { label: 'Вход', align: 'r', render: m => usd(PRICE[m].in) },
            { label: 'Кэш', align: 'r', render: m => usd(PRICE[m].cache) },
            { label: 'Выход', align: 'r', render: m => usd(PRICE[m].out) },
            { label: 'Задачи', render: m => h('span', { class: 'small soft' }, used(m)) },
          ],
          rows: Object.keys(PRICE),
        }),
        UI.kv([
          ['Веб-поиск', '$10 за 1000 поисков'],
          ['Batch API', '−50% на вход и выход'],
          ['Запись в кэш', '×1,25 к цене входа'],
          ['Старый бот (Sonnet 4.6)', '$3 / $15'],
        ]),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // ---------- окно: проверка на eval-наборе ----------
  // changes: [{type, from, to}]; done(results) вызывается после «Применить»/«Оставить»
  function evalModal(changes, done) {
    const totalCost = sum(changes, c => evalCost(c));
    const bodyEl = h('div', { class: 'stack', style: 'gap:14px' });
    const footEl = h('div', { class: 'row', style: 'justify-content:flex-end;width:100%' });
    let results = null, timer = null;
    const ui = UI.modal({
      title: 'Проверка на eval-наборе',
      wide: true,
      body: bodyEl,
      actions: footEl,
      onClose: () => { clearInterval(timer); if (!results) done(null); },
    });
    function intro() {
      UI.clear(bodyEl);
      UI.append(bodyEl, [
        h('p', { class: 'soft' }, 'Прогоняем новую настройку на событиях, для которых уже известен результат, и сравниваем с текущей на тех же событиях — парно, по каждому событию. Промпт и данные те же, меняется одна настройка.'),
        UI.isMobile() ? mlist(changes.map(c => ({ title: typeOf(c.type).label + ': ' + changeLabel(c), sub: 'Набор: ' + EVAL[c.type].set }))) : UI.table({
          columns: [
            { label: 'Задача', render: c => typeOf(c.type).label },
            { label: 'Смена', render: c => h('span', { class: 'costs-nowrap' }, changeLabel(c)) },
            { label: 'Набор', render: c => h('span', { class: 'small soft' }, EVAL[c.type].set) },
          ],
          rows: changes,
        }),
        UI.kv([['Стоимость проверки', '≈ ' + usd(totalCost) + ' через Batch API'], ['Списывается', 'из бюджета экспериментов (отдельный ключ, ≈$25 в месяц) — не из лимита на анализы']]),
        UI.callout('accent', 'shield', changes.some(c => c.type === 'analysis')
          ? 'Для анализа настройка принимается, только если она ' + RULE_TEXT + '. Для остальных задач — свой порог по их метрике.'
          : 'Настройка принимается, только если метрика качества задачи не ниже порога на своем наборе.'),
      ]);
      UI.clear(footEl);
      UI.append(footEl, [button('Отмена', { kind: 'secondary', onClick: () => ui.close() }), button('Запустить проверку', { kind: 'primary', icon: 'play', onClick: run })]);
    }
    function run() {
      const size = sum(changes, c => EVAL[c.type].size);
      const meterBox = h('div');
      const label = h('div', { class: 'small soft', 'aria-live': 'polite' });
      UI.clear(bodyEl);
      UI.append(bodyEl, [h('div', { class: 'costs-progress' }, h('div', { class: 'row-between' }, h('b', null, 'Идет проверка…'), label), meterBox),
        howto('В приложении проверка через Batch API занимает до нескольких часов — придет уведомление. В макете — пара секунд.')]);
      UI.clear(footEl);
      UI.append(footEl, [button('Проверка идет…', { kind: 'secondary', disabled: true })]);
      let step = 0;
      const draw = () => { const done = Math.min(size, Math.round(size * step / 14)); UI.clear(meterBox).appendChild(UI.meter(done, size)); label.textContent = 'Обработано ' + done + ' из ' + size; };
      draw();
      timer = setInterval(() => { step++; draw(); if (step >= 14) { clearInterval(timer); show(); } }, 110);
    }
    function show() {
      results = changes.map(c => Object.assign({}, c, evalResult(c)));
      const VERDICT = { worse: ['Хуже', 'bad', 'arrowDown'], over: ['Допуск превышен', 'bad', 'x'], better: ['Лучше', 'good', 'arrowUp'], ok: ['В допуске', 'good', 'check'], same: ['Не хуже', 'good', 'check'], noproof: ['Не доказано', 'warn', 'alert'] };
      const verdict = v => chip.apply(null, VERDICT[v] || VERDICT.same);
      UI.clear(bodyEl);
      results.forEach(res => {
        const before = perRun(res.type, saved), after = perRun(res.type, applyChange(saved, res));
        const priceRow = { name: 'Цена одного запуска', now: usd(before, 3), next: usd(after, 3), delta: (after > before ? '+' : '−') + usd(Math.abs(after - before), 3), verdict: null };
        const newLabel = res.kind === 'effort' ? 'effort ' + res.to : res.to;
        UI.append(bodyEl, [h('section', { class: 'stack', style: 'gap:10px' },
          h('div', { class: 'row-between' }, h('h4', { style: 'min-width:0' }, typeOf(res.type).label + ': ' + changeLabel(res)),
            res.ok ? chip('Принято', 'good', 'check') : chip('Не принято', 'bad', 'x')),
          UI.isMobile() ? mlist(res.rows.concat([priceRow]).map(x => ({ title: x.name, sub: x.now + ' → ' + x.next + (x.delta && x.delta !== '—' ? ' · ' + x.delta : ''), value: x.verdict ? verdict(x.verdict) : null }))) : UI.table({
            columns: [
              { label: 'Метрика', render: x => x.name },
              { label: 'Сейчас', align: 'r', render: x => x.now },
              { label: newLabel, align: 'r', render: x => h('b', null, x.next) },
              { label: 'Разница (95% ДИ)', align: 'r', render: x => h('span', { class: 'costs-nowrap' }, x.delta) },
              { label: 'Итог', align: 'r', render: x => x.verdict ? verdict(x.verdict) : '' },
            ],
            rows: res.rows.concat([priceRow]),
          }),
          h('p', { class: 'small soft' }, res.why))]);
      });
      const rejected = results.filter(r => !r.ok);
      if (results.some(r => r.type === 'analysis')) UI.append(bodyEl, howto('Разница = новая − текущая на тех же 220 событиях; для лог-лосса и Brier меньше — лучше. ДИ — 95% бутстрэп-интервал. ROI для решения не используется: на 220 событиях это шум.'));
      UI.append(bodyEl, [rejected.length
        ? UI.callout('warn', 'shield', 'Не принято по правилу «не хуже»: оставляем ' + rejected.map(r => (r.kind === 'effort' ? 'effort ' : '') + r.from + ' для задачи «' + typeOf(r.type).label.toLowerCase() + '»').join(', ') + '.')
        : UI.callout('good', 'check', 'Качество не хуже с учетом допуска — смену можно применить.')]);
      UI.clear(footEl);
      UI.append(footEl, rejected.length
        ? [button('Подробнее в «Обучении модели»', { kind: 'ghost', href: '#learning', attrs: { on: { click: () => ui.close() } } }), button(results.some(r => r.ok) ? 'Применить принятое' : 'Оставить ' + (rejected[0].kind === 'effort' ? 'effort ' : '') + rejected[0].from, { kind: 'primary', onClick: () => { ui.close(); done(results); } })]
        : [button('Отмена', { kind: 'secondary', onClick: () => { results = null; ui.close(); } }), button('Применить', { kind: 'primary', icon: 'check', onClick: () => { ui.close(); done(results); } })]);
    }
    intro();
  }

  // ---------- блоки экрана ----------
  const ALERT = (D.admin && D.admin.budget && D.admin.budget.alertAt) || 80; // % лимита, при котором приходит уведомление
  const CONSOLE_LIMITS = 'https://platform.claude.com/settings/limits';
  const kvCell = (k, v, note) => h('div', null, h('dt', null, k), h('dd', null, v, note ? h('small', null, note) : null));
  const consoleBtn = (kind) => button('Лимит в консоли Anthropic', { kind: kind || 'ghost', size: 'sm', icon: 'shield', iconRight: 'link', href: CONSOLE_LIMITS, attrs: { target: '_blank', rel: 'noopener noreferrer' } });

  function headBlock() {
    const lead = V.admin
      ? 'Ваш ключ оплачивает анализы всех, кто на нем, и общие фоновые задачи. Вверху — бюджет ключа, ниже — ваши запуски за 1–7 октября: сколько стоит анализ, что берется из кэша и где еще можно сэкономить без потери качества.'
      : V.own
        ? 'Вы на своем ключе: расход идет с вашего счета Anthropic. Ниже — ваши запуски за 1–7 октября: сколько стоит анализ и что берется из кэша.'
        : 'Анализы идут на ключе администратора: платит он, а у вас — личный лимит. Ниже — ваши запуски за 1–7 октября: сколько стоит анализ и что берется из кэша.';
    return h('div', { class: 'page-head costs-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Расходы на Claude в октябре'),
        h('p', { class: 'lead' }, lead)),
      h('div', { class: 'costs-head-actions' },
        button('Цены моделей', { kind: 'secondary', size: 'sm', icon: 'coins', onClick: pricesModal }),
        button(V.admin ? 'Настройки экономии' : 'Как настроено', { kind: 'secondary', size: 'sm', icon: V.admin ? 'edit' : 'sliders', onClick: () => scrollToSettings() })));
  }

  // Полоса расхода: потрачено, прогноз на конец месяца и отметка, на которой приходит уведомление
  function budgetBar(spent, limit, forecast, what) {
    const share = spent / limit, fShare = forecast / limit;
    const kind = budgetKind(Math.max(share, fShare > 1 ? 0.95 : 0));
    return h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: ['costs-bar', kind !== 'good' && kind], role: 'meter', 'aria-label': what + ': ' + usd(spent) + ' из ' + usd(limit, 0) + ', прогноз на месяц ' + usd(forecast), 'aria-valuenow': spent, 'aria-valuemin': 0, 'aria-valuemax': limit },
        h('i', { class: 'proj', style: { width: Math.min(100, fShare * 100) + '%' } }),
        h('i', { class: 'spent', style: { width: Math.min(100, share * 100) + '%' } }),
        h('i', { class: 'tick', style: { left: ALERT + '%' }, title: ALERT + '% — уведомление' })),
      h('div', { class: 'costs-bar-legend' },
        h('span', null, h('i', { class: 'spent' }), 'Потрачено за 1–7 окт'),
        h('span', null, h('i', { class: 'proj' }), 'Прогноз на 31 окт ≈ ' + usd(forecast) + (fShare > 1 ? ' — выше лимита' : '')),
        h('span', null, h('i', { class: 'tick' }), ALERT + '% — уведомление')));
  }

  // Администратор: бюджет ключа администратора (все, кто на ключе, плюс общие фоновые задачи)
  function adminHero() {
    const { B, forecast } = keyBudget();
    const share = B.spent / B.monthly, left = Math.max(0, B.monthly - B.spent);
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Бюджет ключа администратора' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Бюджет ключа администратора · октябрь'),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(B.spent)),
          h('span', { class: 'of' }, 'из ' + usd(B.monthly, 0)),
          chip(pct(share) + ' бюджета', budgetKind(share), share > 0.7 ? 'alert' : 'check')),
        h('div', { class: 'costs-hero-sub' }, 'Все, кто на вашем ключе, и общие фоновые задачи')),
      budgetBar(B.spent, B.monthly, forecast, 'Бюджет ключа администратора'),
      h('dl', { class: 'costs-kv' },
        kvCell('Осталось', usd(left), 'до 31 окт'),
        kvCell('В день', usd(B.spent / DAYS), 'в среднем'),
        kvCell('Можно в день', usd(left / (MONTH_DAYS - DAYS)), 'чтобы уложиться')),
      h('p', { class: 'costs-hero-note' }, 'Прогноз учитывает личные лимиты: дойдя до своего, участник остановится. На ' + ALERT + '% бюджета (' + usd(B.monthly * ALERT / 100, 0) + ') придет уведомление, на 100% анализы на ключе администратора остановятся до вашего решения.'),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          button('Бюджет и лимиты', { kind: 'secondary', size: 'sm', icon: 'sliders', href: '#admin-limits' }),
          consoleBtn()),
        h('p', { class: 'costs-hero-note' }, icon('shield'), h('span', null, 'Вторая страховка — лимит трат в консоли Anthropic: он остановит расход по ключу, даже если приложение ошибется.'))));
  }

  // Администратор: кто тратит бюджет — коротко, подробно в «Администрировании»
  function adminWhoCard() {
    const { B, onKey, own } = keyBudget();
    const people = onKey.slice().sort((a, b) => b.spent - a.spent);
    const top = people.slice(0, 3), rest = people.slice(3);
    const li = (title, sub, value, cls) => h('li', { class: cls }, h('span', { class: 't' }, title), sub ? h('span', { class: 's' }, sub) : null, h('span', { class: 'v' }, value));
    const userSub = u => {
      if (!u.limit) return 'без личного лимита';
      const s = u.spent / u.limit.monthly;
      const txt = 'лимит ' + usd(u.limit.monthly, 0) + ' · израсходовано ' + pct(s);
      return s >= ALERT / 100 ? h('span', { class: 'warn-text' }, txt) : txt;
    };
    const rows = top.map(u => li(h('span', { class: 'costs-who-name' }, u.name, u.you ? chip('вы', 'outline') : null), userSub(u), usd(u.spent)));
    if (sum(rest, u => u.spent) > 0) rows.push(li('Еще ' + rest.length + ' ' + fmt.plural(rest.length, 'человек', 'человека', 'человек'), 'на ключе администратора', usd(sum(rest, u => u.spent))));
    rows.push(li('Общие фоновые задачи', 'обновление профилей (Batch)', usd(B.shared)));
    rows.push(li('Итого', null, usd(B.spent), 'total'));
    return card({
      class: 'costs-card costs-side',
      title: 'Кто тратит бюджет',
      subtitle: 'Октябрь, в долларах. Видны только расходы на ИИ — ставки и банк участников закрыты.',
      body: [
        h('ul', { class: 'costs-mlist costs-who' }, rows),
        own.length ? howto(own.map(u => u.name).join(', ') + (own.length > 1 ? ' — на своих ключах' : ' — на своем ключе') + ': расход идет с ' + (own.length > 1 ? 'их счетов' : 'его счета') + ' и в бюджет не входит.') : null,
      ],
      foot: [button('Подробно — в Администрировании', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#admin-usage' })],
    });
  }

  // Участник на ключе администратора: личный лимит (Р7, Р13)
  function memberHero() {
    const me = V.me, L = V.limit, spent = me.spent;
    const share = spent / L.monthly, left = Math.max(0, L.monthly - spent);
    const an = BASE.analysis, enough = an.n ? Math.floor(left / an.avgCost) : null;
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Ваш лимит на ключе администратора' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Ваш лимит на ключе администратора · октябрь'),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(spent)),
          h('span', { class: 'of' }, 'из ' + usd(L.monthly, 0)),
          chip(pct(share) + ' лимита', budgetKind(share), share > 0.7 ? 'alert' : 'check')),
        h('div', { class: 'costs-hero-sub' }, 'Платит администратор, вы ничего не вводите')),
      budgetBar(spent, L.monthly, monthPace(spent), 'Ваш лимит'),
      h('dl', { class: 'costs-kv' },
        kvCell('Осталось', usd(left), 'до 31 окт'),
        kvCell('Сегодня', me.todayAnalyses + ' из ' + L.daily, fmt.plural(L.daily, 'анализ', 'анализа', 'анализов') + ' в день'),
        kvCell('На один анализ', 'до ' + usd(L.perAnalysis, 0), 'потолок')),
      enough != null ? h('p', { class: 'costs-hero-note' }, icon('info'), h('span', null, 'Остатка хватит примерно на ' + enough + ' ' + fmt.plural(enough, 'анализ', 'анализа', 'анализов') + ' по средней цене ' + usd(an.avgCost) + '. ' + (V.limit.daily ? 'Но не больше ' + V.limit.daily + ' в день.' : ''))) : null,
      h('p', { class: 'costs-hero-note' }, icon('layers'), h('span', null, 'Ночное обновление профилей (' + usd(sharedSpent()) + ' в октябре) — общая фоновая задача: ее оплачивает администратор, в ваш лимит она не входит.')),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          h('span', { class: 'costs-hero-note' }, icon('lock'), h('span', null, 'Лимит меняет администратор.')),
          button('Перейти на свой ключ', { kind: 'secondary', size: 'sm', icon: 'key', iconRight: 'arrowRight', href: '#profile-key' }))));
  }

  // Участник на своем ключе: расход с его счета, лимит ставит он сам в консоли Anthropic
  function ownHero() {
    const me = V.me, k = me.ownKey || {};
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Свой ключ Claude' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('key', { width: 16, height: 16 }), 'Свой ключ Claude · октябрь'),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(me.spent)),
          h('span', { class: 'of' }, 'с вашего счета'),
          chip('sk-ant-…' + (k.last4 || '••••'), 'outline', 'key')),
        h('div', { class: 'costs-hero-sub' }, 'Лимит администратора к вам не относится')),
      h('dl', { class: 'costs-kv' },
        kvCell('Прогноз', '≈ ' + usd(monthPace(me.spent)), 'на 31 окт'),
        kvCell('Ключ проверен', k.verified ? fmt.date(k.verified) : '—', k.verified ? k.verified.slice(11, 16) : null),
        kvCell('На один анализ', 'до ' + usd(V.limit.perAnalysis, 0), 'потолок')),
      h('div', { class: 'costs-hero-foot' },
        h('div', { class: 'costs-hero-actions' },
          consoleBtn('secondary'),
          button('Ключ в личном кабинете', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#profile-key' }))));
  }

  // Участник: что будет у лимита и что в него не входит
  function memberRulesCard() {
    const L = V.limit, me = V.me;
    const anRuns = SCOPE_RUNS.filter(r => r.type === 'analysis');
    const maxRun = anRuns.length ? Math.max(...anRuns.map(r => r.cost)) : 0;
    const shared = 'Ночное обновление профилей (' + usd(sharedSpent()) + ' в октябре) оплачивает администратор — в ваш ' + (V.own ? 'счет' : 'лимит') + ' не входит.';
    const items = V.own ? [
      { ic: 'shield', tone: 'info', t: 'Лимит на месяц — в консоли Anthropic', s: 'Ставите сами: так расход точно не выйдет за ваш предел.' },
      { ic: 'coins', tone: 'info', t: 'Не больше ' + usd(L.perAnalysis, 0) + ' за анализ', s: 'Дороже — анализ остановится без ставки.' },
      { ic: 'layers', tone: '', t: 'Общие фоновые задачи', s: shared },
      { ic: 'key', tone: '', t: 'Обратно на ключ администратора', s: 'Только с разрешения администратора: просьба уйдет ему из личного кабинета.' },
    ] : [
      { ic: 'bell', tone: 'warn', t: ALERT + '% — ' + usd(L.monthly * ALERT / 100), s: 'Уведомление вам и администратору.' },
      { ic: 'pause', tone: 'bad', t: '100% — ' + usd(L.monthly), s: 'Анализы на ключе администратора остановятся до его решения.' },
      { ic: 'calendar', tone: 'info', t: L.daily + ' ' + fmt.plural(L.daily, 'анализ', 'анализа', 'анализов') + ' в день', s: 'Сегодня ' + me.todayAnalyses + ' из ' + L.daily + '. Счетчик обнуляется в полночь по вашему времени.' },
      { ic: 'coins', tone: 'info', t: 'Не больше ' + usd(L.perAnalysis, 0) + ' за анализ', s: 'Дороже — анализ остановится без ставки. Самый дорогой у вас в октябре — ' + usd(maxRun) + '.' },
    ];
    return card({
      class: 'costs-card costs-side',
      title: V.own ? 'Как работает свой ключ' : 'Как работает лимит',
      subtitle: V.own ? 'Расход — с вашего счета Anthropic' : 'Лимит ставит и меняет администратор',
      body: h('ul', { class: 'costs-rules' }, items.map(it => h('li', null,
        h('span', { class: ['costs-rules-ic', it.tone] }, icon(it.ic)),
        h('span', { class: 'costs-rules-body' }, h('b', null, it.t), h('span', null, it.s))))),
    });
  }

  // Заголовок над блоками о собственных запусках зрителя
  function scopeHead() {
    const n = TOT.runs;
    return h('div', { class: 'costs-section' },
      h('h3', null, V.admin ? 'Ваши запуски и общие фоновые задачи' : 'Ваши запуски'),
      h('span', { class: 'small soft' }, '1–7 октября · ' + n + ' ' + fmt.plural(n, 'запуск', 'запуска', 'запусков') + ' · ' + usd(SPENT) + (V.admin ? '' : ' · общие фоновые задачи сюда не входят')));
  }

  function tiles(mobile) {
    const an = BASE.analysis;
    const nAn = an.n + ' ' + fmt.plural(an.n, 'анализ', 'анализа', 'анализов');
    const anCosts = SCOPE_RUNS.filter(r => r.type === 'analysis').map(r => r.cost);
    const change = (an.avgCost / OLD.cost - 1) * 100;
    const cls = 'col-3 half-mobile costs-kpi';
    return [
      UI.stat({ class: cls, icon: 'spark', label: 'Цена анализа', value: usd(an.avgCost), delta: fmt.signedPct(change, 0) + (mobile ? '' : ' к старому боту'), trend: 'down', good: false, hint: mobile ? 'к старому боту · ' + nAn : nAn, spark: anCosts, sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'database', label: 'Вход из кэша', value: pct(CACHE_SHARE), hint: 'сэкономил ' + usd(cacheSavedWeek) + ' за 7 дней', spark: byDay.map(d => sum(d.runs, r => r.cached) / sum(d.runs, r => r.input)), sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'layers', label: 'Токенов за месяц', value: fmt.tokens(TOT.input + TOT.output), hint: 'вход ' + fmt.tokens(TOT.input) + ' · выход ' + fmt.tokens(TOT.output), spark: byDay.map(d => d.tokens), sparkColor: 'var(--s1)' }),
      UI.stat({ class: cls, icon: 'globe', label: 'Веб-поисков', value: String(TOT.searches), hint: usd(TOT.searches * SEARCH) + ' · лимит ' + (saved.searchLimit || '∞') + ' на анализ, ' + (saved.searchDay || '∞') + ' в день', spark: byDay.map(d => sum(d.runs, r => r.searches)), sparkColor: 'var(--s1)' }),
    ];
  }

  function dailyCard(mobile) {
    // Темп: у участника — под его лимит, у администратора — под личный ориентир; на своем ключе темпа нет
    const target = V.admin ? saved.limitMonth : V.own ? null : V.limit.monthly;
    const budgetPace = target ? target / MONTH_DAYS : Infinity;
    const paceName = V.admin ? 'ориентир' : 'лимит';
    const items = byDay.map(d => {
      const groups = TYPES.map(t => ({ t, rs: d.runs.filter(r => r.type === t.id) })).filter(g => g.rs.length);
      const today = d.day === D.today;
      return {
        label: fmt.date(d.day), short: fmt.date(d.day), value: d.cost,
        tipTitle: fmt.date(d.day) + ', ' + weekday(d.day) + (today ? ' · сегодня, до ' + d.runs[d.runs.length - 1].at.slice(11, 16) : '') + ' · ' + d.runs.length + ' ' + fmt.plural(d.runs.length, 'запуск', 'запуска', 'запусков'),
        tip: [{ name: 'Всего', value: usd(d.cost, 3) }].concat(groups.map(g => ({ name: g.t.label + (g.rs.length > 1 ? ' ×' + g.rs.length : ''), value: usd(sum(g.rs, r => r.cost), 3) }))),
      };
    });
    const over = byDay.filter(d => d.cost > budgetPace).length;
    const paceText = target ? (over ? ' Дней выше темпа под ' + paceName + ': ' + over + '.' : ' Ни один день не превысил темп под ' + paceName + '.') : '';
    const max = byDay.reduce((a, d) => d.cost > a.cost ? d : a, byDay[0]);
    const maxRuns = TYPES.map(t => ({ t, n: max.runs.filter(r => r.type === t.id).length })).filter(x => x.n);
    const chart = UI.columnChart({ items, height: mobile ? 180 : 210, valueFormat: v => usd(v), labelEvery: 1, seriesName: 'Расход за день', ariaLabel: 'Расходы Claude API по дням, 1–7 октября' });
    return card({
      class: 'costs-card costs-o-1',
      title: 'Расходы по дням',
      subtitle: '1–7 октября, в долларах' + (V.admin ? '' : ' · ваши запуски'),
      actions: target ? [chip('Темп под ' + paceName + ' — ' + usd(budgetPace) + ' в день', 'outline')] : null,
      body: [
        UI.withTable(chart, () => h('div', { class: 'costs-tablebox' }, UI.table({
          columns: [
            { label: 'День', render: d => fmt.date(d.day) + ', ' + weekday(d.day) },
            { label: 'Запусков', align: 'r', render: d => d.runs.length },
            { label: 'Токенов', align: 'r', render: d => fmt.tokens(d.tokens) },
            { label: 'Расход', align: 'r', render: d => h('b', null, usd(d.cost, 3)) },
          ],
          rows: byDay,
        }))),
        howto('Как читать: столбец — сумма за день по всем задачам; наведите или нажмите, чтобы увидеть состав. Дороже всего ' + fmt.date(max.day) + ' (' + usd(max.cost) + '): ' + maxRuns.map(x => x.t.label.toLowerCase() + (x.n > 1 ? ' ×' + x.n : '')).join(', ') + '.' + paceText),
      ],
    });
  }

  function typesCard(onPick) {
    const rows = SCOPE_TYPES.map(t => ({ t, b: BASE[t.id] })).sort((a, b) => b.b.cost - a.b.cost);
    return card({
      class: 'costs-card costs-o-2',
      title: 'На что уходят деньги',
      subtitle: 'По типам задач, 1–7 октября',
      body: [
        UI.hbars({ items: rows.map(x => ({ label: x.t.bar, value: x.b.cost, note: pct(x.b.cost / SPENT), color: 'var(--s1)', dot: false })), valueFormat: v => usd(v) }),
        h('ul', { class: 'costs-types', 'aria-label': 'Задачи: модель, токены, цена запуска' }, rows.map(x => h('li', null,
          h('button', { class: 'costs-type', type: 'button', title: 'Показать запуски: ' + x.t.label, on: { click: () => onPick(x.t.id) } },
            h('span', { class: 'costs-type-name' }, x.t.label, modelChip(SCOPE_RUNS.find(r => r.type === x.t.id).model), x.t.id === 'refresh' && batchChip()),
            h('span', { class: 'costs-type-meta' }, x.b.n + ' ' + fmt.plural(x.b.n, 'запуск', 'запуска', 'запусков') + ' · в среднем ' + fmt.tokens(x.b.avgIn) + ' вход / ' + fmt.tokens(x.b.avgOut) + ' выход · ' + (x.b.cached ? 'кэш ' + pct(x.b.cacheShare) : 'без кэша')),
            h('span', { class: 'costs-type-cost' }, h('span', null, h('b', null, usd(x.b.avgCost, 3)), h('small', null, 'за запуск')), icon('chevronRight')))))),
        howto('Длина полосы — сумма за неделю, справа — доля в расходах. Нажмите на задачу, чтобы увидеть ее запуски.' + (V.admin ? '' : ' Обновления профилей здесь нет: это общая фоновая задача, ее оплачивает администратор.')),
      ],
    });
  }

  function leversCard(redraw) {
    const group = lv => lv.candidate ? 2 : lv.fixed ? 1 : 0;
    // Включает меры и запускает проверки администратор: настройки общие для всех на его ключе.
    // Участнику не показываем Batch: он касается только общих фоновых задач, которые оплачивает администратор.
    const canEdit = V.admin;
    const list = LEVERS.filter(lv => canEdit || lv.id !== 'batch').map(lv => ({ lv, on: lv.fixed || lv.isOn(saved), save: leverSaving(lv, saved) }))
      .sort((a, b) => group(a.lv) - group(b.lv) || b.save - a.save);
    let rankN = 0;
    const current = forecastFor(saved), without = forecastFor(withSet(ALL_OFF, { limitMonth: saved.limitMonth }));
    const runCheck = lv => {
      const c = lv.check();
      evalModal([c], res => {
        if (!res) return;
        const ok = res[0].ok;
        candidateState[lv.id] = ok ? 'accepted' : 'rejected';
        if (ok) lv.apply();
        redraw();
        UI.toast(ok ? '«' + lv.title + '» включено: качество в допуске' : 'Не приняли «' + lv.title + '»: ' + lv.rejectedNote.charAt(0).toLowerCase() + lv.rejectedNote.slice(1), ok ? 'check' : 'shield');
      });
    };
    return card({
      class: 'costs-card costs-o-3',
      title: 'Где экономим',
      subtitle: 'Оценка на октябрь по вашим запускам 1–7 окт. Каждая мера посчитана при остальных включенных, поэтому суммы не складываются.',
      body: [
        h('ol', { class: 'costs-levers' }, list.map(x => {
          const lv = x.lv;
          const rank = lv.candidate ? '?' : lv.fixed ? icon('check') : String(++rankN);
          let status, action = null, note = null;
          if (lv.fixed) status = chip('Встроено в схему', 'good', 'check');
          else if (lv.candidate) {
            if (x.on) status = chip('Включено', 'good', 'check');
            else if (candidateState[lv.id] === 'rejected') { status = chip('Не прошло проверку', 'bad', 'x'); note = lv.rejectedNote; }
            else {
              status = chip('Кандидат · ждет проверки', 'info', 'flask');
              if (canEdit) action = button('Проверить на eval-наборе', { kind: 'secondary', size: 'sm', icon: 'flask', onClick: () => runCheck(lv) });
            }
            if (lv.perRunNote && !note) {
              const d = perRun('analysis', lv.set(saved, false)) - perRun('analysis', lv.set(saved, true));
              note = '≈ −' + usd(d) + ' за анализ';
            }
          } else if (x.on) status = chip('Включено', 'good', 'check');
          else {
            status = chip('Выключено', 'warn', 'alert');
            if (canEdit) action = button('Включить', { kind: 'secondary', size: 'sm', onClick: () => { saved = lv.set(saved, true); draft = clone(saved); redraw(); UI.toast('«' + lv.title + '» снова включено'); } });
          }
          return h('li', { class: ['costs-lever', lv.candidate && 'candidate', lv.fixed && 'fixed'] },
            h('span', { class: 'costs-rank', 'aria-hidden': 'true' }, rank),
            h('div', { class: 'costs-lever-body' },
              h('div', { class: 'costs-lever-title' }, lv.title),
              h('div', { class: 'costs-lever-text' }, lv.how),
              h('div', { class: 'costs-lever-meta' }, status, action, note ? h('span', { class: 'xsmall muted' }, note) : null)),
            lv.fixed
              ? h('div', { class: 'costs-lever-save soft' }, lv.saveNote)
              : h('div', { class: 'costs-lever-save' }, '≈ ' + usdM(x.save), h('small', null, x.on ? 'в месяц' : lv.candidate ? 'можно сэкономить' : 'теряем в месяц')));
        })),
        h('div', { class: 'costs-total' }, h('span', null, 'Без мер 1–' + rankN + ' ваш октябрь обошелся бы'), h('span', null, h('b', null, '≈ ' + usdM(without)), ' вместо ', h('b', null, '≈ ' + usd(current)))),
        UI.callout('accent', 'shield', h('b', null, 'Правило: '), 'экономия принимается, только если на eval-наборе она ' + RULE_TEXT + '. Дешевле, но хуже — не берем.'),
        canEdit ? null : howto('Меры включает и проверяет администратор — одинаково для всех на его ключе.'),
      ],
    });
  }

  function compareCard() {
    const an = BASE.analysis;
    const rows = [
      ['Модель', OLD.model, 'Opus 5.5', 'сильнее; за токен дороже ($4/$20 против $3/$15), но токенов в ≈ ' + Math.round(OLD.input / an.avgIn) + ' раз меньше'],
      ['Запросов к модели', 'до 20', '2–4', 'лимит 4; текст (Haiku) и новости (Sonnet) — отдельными шагами'],
      ['Входных токенов', '≈ ' + fmt.tokens(OLD.input), '≈ ' + fmt.tokens(an.avgIn), pct(an.cacheShare) + ' из кэша — на итерациях 2–3'],
      ['Откуда данные', 'Читает .md и JSON по одному', 'Готовое досье из базы', 'поиск — только новости, отдельным шагом'],
      ['Время', '≈ 3–5 мин', fmt.duration(Math.round(an.avgDuration)), 'в среднем за октябрь'],
      ['Цена анализа', '≈ ' + usd(OLD.cost) + ' (оценка)', usd(an.avgCost), 'факт за 1–7 окт'],
    ];
    return card({
      class: 'costs-card costs-o-4',
      title: 'До и после',
      subtitle: 'Один анализ: старый бот и новая схема',
      body: [
        UI.hbars({ items: [
          { label: 'Старый бот', value: OLD.cost, color: 'var(--chart-muted)', note: 'оценка' },
          { label: 'Новая схема', value: an.avgCost, color: 'var(--s1)', note: 'факт' },
        ], valueFormat: v => usd(v) }),
        h('div', { class: 'costs-compare' },
          h('div', { class: 'hd blank', 'aria-hidden': 'true' }),
          h('div', { class: 'hd' }, 'Старый бот'),
          h('div', { class: 'hd new' }, 'Новая схема'),
          rows.map(r => [
            h('div', { class: 'lbl' }, r[0]),
            h('div', { class: 'old' }, h('span', { class: 'sr-only' }, 'Старый бот: '), r[1]),
            h('div', { class: 'new' }, h('span', { class: 'sr-only' }, 'Новая схема: '), r[2], h('small', null, r[3])),
          ])),
        howto('Цифры старого бота — оценка из TOKEN_ECONOMY.md §3.2 по bot.py: ≈12 циклов tool use из 20 возможных, каждый пересылает всю историю, кэша нет, Sonnet 4.6 по $3 / $15 за 1M; разброс $1–4,5; поиск DuckDuckGo бесплатный. Бот выключен, его логов расхода нет — поэтому оценка.'),
      ],
    });
  }

  // Цена анализа рядом с качеством той же версии промпта (TOKEN_ECONOMY §1.3).
  // Токены на анализ — те же, что на экране «Обучение модели» (VERSION_INFO в learning.js).
  const VERSION_TOKENS = { v1: 52, v2: 54, v3: 49, v4: 34 };
  function versionsCard(mobile) {
    const an = BASE.analysis;
    const base = VERSION_TOKENS[activeStrategy.id] || 49;
    const rows = D.strategyVersions.map(v => {
      const t = VERSION_TOKENS[v.id] || base;
      return { v, t, cost: v.id === activeStrategy.id ? an.avgCost : an.avgCost * t / base, fact: v.id === activeStrategy.id };
    }).reverse();
    const cand = rows.find(r => r.v.status === 'candidate'), act = rows.find(r => r.fact);
    const status = v => v.status === 'active' ? chip('активна', 'good', 'check') : v.status === 'candidate' ? chip('кандидат', 'info', 'flask') : null;
    const costCell = r => [h('b', null, '≈ ' + usd(r.cost)), h('div', { class: 'costs-sub' }, r.fact ? 'факт' : 'оценка')];
    const body = mobile
      ? mlist(rows.map(r => ({ title: h('span', { class: 'costs-ver-name' }, r.v.id, status(r.v)), sub: 'лог-лосс ' + fmt.dec(r.v.logloss, 3) + ' · Brier ' + fmt.dec(r.v.brier, 3) + ' · ≈ ' + r.t + ' тыс. токенов' + (r.fact ? '' : ' · оценка'), value: '≈ ' + usd(r.cost) })))
      : h('div', { class: 'costs-ver' }, UI.table({
        columns: [
          { label: 'Версия', render: r => h('span', { class: 'costs-ver-name' }, r.v.id, status(r.v)) },
          { label: 'Токенов', align: 'r', render: r => '≈ ' + r.t + ' тыс.' },
          { label: 'Цена', align: 'r', render: costCell },
          { label: 'Лог-лосс', align: 'r', render: r => fmt.dec(r.v.logloss, 3) },
        ],
        rows,
      }));
    return card({
      class: 'costs-card costs-o-5',
      title: 'Версии: цена анализа и качество',
      subtitle: 'Экономию оцениваем только вместе с качеством той же версии. Цена ' + activeStrategy.id + ' — факт за 1–7 окт, остальных — оценка по токенам. Лог-лосс — на ' + (act ? act.v.n : 220) + ' событиях отложенной выборки, меньше — лучше.',
      body: [
        body,
        cand && act ? howto(cand.v.id + ' дешевле ' + act.v.id + ' на ' + Math.round((1 - cand.cost / act.cost) * 100) + '%, а разница лог-лосса (' + d3(cand.v.logloss - act.v.logloss) + ') — в пределах шума. Как более дешевую, ' + cand.v.id + ' проверяют по правилу «не хуже с допуском»; решение — в «Обучении модели».') : null,
      ],
      foot: [button('Версии и сравнение', { kind: 'ghost', size: 'sm', iconRight: 'arrowRight', href: '#learning-versions' })],
    });
  }

  function runsCard(mobile, redraw) {
    const filtered = RUNS.filter(r => runFilter === 'all' || r.type === runFilter);
    const LIMIT = mobile ? 6 : 8;
    const shown = showAllRuns ? filtered : filtered.slice(0, LIMIT);
    const filter = UI.segmented({
      label: 'Тип задачи',
      items: [{ id: 'all', label: 'Все' }].concat(SCOPE_TYPES.map(t => ({ id: t.id, label: mobile ? t.tiny : t.short }))),
      active: runFilter,
      onChange: id => { runFilter = id; showAllRuns = false; redraw('costs-runs'); },
    });
    filter.classList.add('costs-runs-filter');
    let list;
    if (mobile) {
      list = h('ul', { class: 'costs-runlist' }, shown.map(r => h('li', null,
        h('button', { class: 'costs-run', type: 'button', on: { click: () => runModal(r) } },
          h('span', { class: 'costs-run-main' },
            h('span', { class: 'costs-task' }, typeOf(r.type).label, r.batch && batchChip()),
            h('span', { class: 'costs-run-meta' }, fmt.datetime(r.at) + ' · ' + r.model + ' · ' + fmt.duration(r.duration)),
            h('span', { class: 'costs-run-meta' }, 'Вход ' + fmt.tokens(r.input) + (r.cached ? ' (кэш ' + pct(r.cached / r.input) + ')' : '') + ' · выход ' + fmt.tokens(r.output) + (r.searches ? ' · ' + r.searches + ' ' + fmt.plural(r.searches, 'поиск', 'поиска', 'поисков') : ''))),
          h('span', { class: 'costs-run-cost' }, usd(r.cost, 3), h('small', null, 'подробнее'))))));
    } else {
      list = h('div', { class: 'costs-table' }, UI.table({
        columns: [
          { label: 'Когда', render: r => fmt.datetime(r.at) },
          { label: 'Задача', render: r => h('span', { class: 'costs-task' }, typeOf(r.type).label, r.batch && batchChip()) },
          { label: 'Модель', render: r => modelChip(r.model) },
          { label: 'Вход (кэш)', align: 'r', render: r => [h('div', null, fmt.tokens(r.input)), h('div', { class: 'costs-sub' }, r.cached ? 'из кэша ' + pct(r.cached / r.input) : 'без кэша')] },
          { label: 'Выход', align: 'r', render: r => fmt.tokens(r.output) },
          { label: 'Поиски', align: 'r', render: r => r.searches ? String(r.searches) : h('span', { class: 'muted' }, '—') },
          { label: 'Длительность', align: 'r', render: r => fmt.duration(r.duration) },
          { label: 'Стоимость', align: 'r', render: r => h('b', null, usd(r.cost, 3)) },
          { label: h('span', { class: 'sr-only' }, 'Подробнее'), render: () => icon('chevronRight', { width: 16, height: 16, style: 'color:var(--fg-3);display:block' }) },
        ],
        rows: shown,
        onRowClick: runModal,
      }));
      list.querySelectorAll('tbody tr.clickable').forEach((tr, i) => {
        tr.setAttribute('aria-label', 'Разбор стоимости: ' + typeOf(shown[i].type).label + ', ' + fmt.datetime(shown[i].at));
        tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); runModal(shown[i]); } });
      });
    }
    const fCost = sum(filtered, r => r.cost);
    return card({
      id: 'costs-runs',
      class: 'col-12 costs-card',
      title: 'Журнал запусков',
      subtitle: (V.admin ? 'Каждый вызов Claude API от вашего имени и общие фоновые задачи' : 'Каждый ваш вызов Claude API') + ': токены, кэш, поиски и цена. Нажмите на запуск — откроется разбор стоимости.',
      actions: mobile ? null : [filter],
      flush: !mobile,
      body: mobile ? [h('div', { style: 'min-width:0' }, filter), list] : list,
      foot: [
        h('span', { class: 'small soft' }, (runFilter === 'all' ? 'Всего' : typeOf(runFilter).label) + ': ' + filtered.length + ' ' + fmt.plural(filtered.length, 'запуск', 'запуска', 'запусков') + ' · ' + usd(fCost, 2) + (shown.length < filtered.length ? ' · показаны последние ' + shown.length : '')),
        filtered.length > LIMIT ? button(showAllRuns ? 'Свернуть' : 'Показать все ' + filtered.length, { kind: 'ghost', size: 'sm', icon: showAllRuns ? 'chevronDown' : 'list', attrs: { style: 'margin-left:auto' }, onClick: () => { showAllRuns = !showAllRuns; redraw('costs-runs'); } }) : null,
        !V.admin && runFilter === 'all' && SHARED_RUNS.length ? h('span', { class: 'xsmall muted', style: 'flex-basis:100%' }, 'Общие фоновые задачи (обновление профилей: ' + SHARED_RUNS.length + ' ' + fmt.plural(SHARED_RUNS.length, 'запуск', 'запуска', 'запусков') + ' · ' + usd(sharedSpent()) + ') оплачивает администратор — в журнале их нет, в ваш ' + (V.own ? 'счет' : 'лимит') + ' они не входят.') : null,
        (runFilter === 'all' || runFilter === 'analysis') && h('span', { class: 'xsmall muted', style: 'flex-basis:100%' }, 'Журнал — пример за 1–7 окт. Анализ #' + (D.currentAnalysis || 'A-0142') + ' с экрана «Анализ» — демонстрационный запуск макета; в приложении такой запуск появится здесь сразу после завершения.'),
      ],
    });
  }

  // Участник: настройки только для чтения — их задает администратор, одинаково для всех на его ключе
  function settingsReadOnly() {
    const L = V.limit;
    const TASK_LABEL = { parse: 'Разбор текста событий', analysis: 'Анализ матчей', postmortem: 'Разбор ставок', refresh: 'Обновление профилей (ночью, через Batch)' };
    const tasks = ['parse', 'analysis', 'postmortem', 'refresh'].map(id => {
      const m = saved.models[id], eff = supportsEffort(m) ? 'effort: ' + EFFORT_LABEL[saved.effort[id]].toLowerCase() : 'effort не поддерживается';
      const shared = SHARED.includes(id);
      return { title: TASK_LABEL[id], sub: m + ' · ' + eff + (shared ? ' · общая задача, платит администратор' : ''), value: shared ? null : '≈ ' + usd(perRun(id, saved), 3) };
    });
    const onOff = on => on ? chip('Включено', 'good', 'check') : chip('Выключено', 'warn', 'alert');
    const tricks = [
      { title: 'Кэширование промпта', value: onOff(saved.cache) },
      { title: 'Кэш новостей 12 ч', value: onOff(saved.newsCache) },
      { title: 'Сжатое досье вместо чтения файлов', value: onOff(saved.dossier) },
      { title: 'Проверка на eval-наборе перед сменой модели', value: onOff(saved.eval) },
    ];
    const limits = V.own ? [
      { title: 'Лимит на месяц', sub: 'ставите сами в консоли Anthropic', value: '—' },
      { title: 'Потолок на один анализ', value: usd(L.perAnalysis, 0) },
    ] : [
      { title: 'Ваш лимит на месяц', value: usd(L.monthly, 0) },
      { title: 'Анализов в день', value: String(L.daily) },
      { title: 'Потолок на один анализ', sub: 'дороже — анализ остановится без ставки', value: usd(L.perAnalysis, 0) },
    ];
    limits.push({ title: 'Предупредить о цене анализа', value: 'от ' + usd(saved.limitSoft) });
    limits.push({ title: 'Веб-поиски', sub: 'на анализ и в день', value: (saved.searchLimit || '∞') + ' / ' + (saved.searchDay || '∞') });
    return card({
      id: 'costs-settings',
      class: 'costs-card',
      title: 'Как настроено',
      subtitle: 'Модели, глубину размышлений и приемы экономии задает администратор — одинаково для всех. Цена — за один запуск при этих настройках.',
      body: [
        h('div', { class: 'costs-settings-grid' },
          h('div', { class: 'costs-settings-col' }, h('div', { class: 'eyebrow' }, 'Модель для каждой задачи'), mlist(tasks)),
          h('div', { class: 'costs-settings-col' },
            h('div', { class: 'eyebrow' }, 'Приемы экономии'), mlist(tricks),
            h('div', { class: 'eyebrow', style: 'margin-top:6px' }, V.own ? 'Ограничения' : 'Ваши лимиты'), mlist(limits))),
        UI.callout('info', 'lock', V.own
          ? 'Платите вы сами, но модели и приемы экономии общие для приложения — их меняет администратор.'
          : 'Поменять лимит или модели может только администратор. Свой ключ снимает лимит администратора: расход пойдет с вашего счета Anthropic.'),
      ],
    });
  }

  function settingsCard(redraw) {
    if (!V.admin) return settingsReadOnly();
    const hints = {}, effortSlots = {};
    const forecastNum = h('div', { class: 'costs-forecast-num', 'aria-live': 'polite' });
    const forecastChip = h('span');
    const warnSlot = h('div', { class: 'stack', style: 'gap:8px' });
    const dirtyEl = h('span', { class: 'costs-dirty', 'aria-live': 'polite' });
    const saveBtn = button('Сохранить настройки', { kind: 'primary', type: 'submit', icon: 'check' });
    const resetBtn = button('Отменить изменения', { kind: 'secondary', onClick: () => { draft = clone(saved); redraw('costs-settings'); } });

    function refresh() {
      TYPES.forEach(t => {
        const per = perRun(t.id, draft);
        if (hints[t.id]) hints[t.id].textContent = '≈ ' + usd(per, 3) + ' за запуск · ≈ ' + Math.round(BASE[t.id].perMonth) + ' в месяц · ≈ ' + usdM(per * BASE[t.id].perMonth) + '/мес';
      });
      const now = forecastFor(saved), next = forecastFor(draft), lim = +draft.limitMonth || 0;
      UI.clear(forecastNum);
      if (Math.abs(next - now) > 0.005) UI.append(forecastNum, [h('span', { class: 'was' }, '≈ ' + usd(now) + ' → '), '≈ ' + usd(next)]);
      else forecastNum.textContent = '≈ ' + usd(next);
      UI.clear(forecastChip).appendChild(lim && next > lim ? chip('Выше ориентира ' + usd(lim, 0), 'bad', 'alert') : chip(pct(lim ? next / lim : 0) + ' ориентира', budgetKind(lim ? next / lim : 0), 'check'));
      UI.clear(warnSlot);
      const perAn = perRun('analysis', draft);
      if (draft.limitHard > 0 && perAn > draft.limitHard) warnSlot.appendChild(UI.callout('warn', 'alert', 'Средний анализ (≈ ' + usd(perAn) + ') дороже жесткого порога (' + usd(+draft.limitHard) + '): запуски будут останавливаться без ставки.'));
      else if (draft.limitSoft > 0 && perAn > draft.limitSoft) warnSlot.appendChild(UI.callout('warn', 'alert', 'Средний анализ (≈ ' + usd(perAn) + ') дороже порога предупреждения (' + usd(+draft.limitSoft) + '): уведомление будет приходить почти каждый раз.'));
      if (draft.searchDay > 0 && TOT.searches / DAYS > draft.searchDay) warnSlot.appendChild(UI.callout('warn', 'alert', 'Сейчас в среднем ' + fmt.dec(TOT.searches / DAYS, 1) + ' поиска в день — больше лимита ' + draft.searchDay + '. Лишние поиски не выполнятся, новости возьмутся из кэша.'));
      if (!draft.dossier) warnSlot.appendChild(UI.callout('warn', 'alert', 'Без досье ИИ снова читает файлы в 10–20 итераций, как старый бот: анализ дороже в ≈ ' + Math.round(perAn / BASE.analysis.avgCost) + ' раз.'));
      if (draft.effort.analysis !== saved.effort.analysis && draft.models.analysis !== 'Haiku 4.5') warnSlot.appendChild(UI.callout('info', 'flask', 'Effort анализа меняет глубину размышлений, а значит и качество на трудных матчах. При сохранении настройка пройдет проверку на eval-наборе.'));
      if (!draft.eval) warnSlot.appendChild(UI.callout('bad', 'shield', 'Проверка на eval-наборе выключена: смена модели или effort применится сразу, и просадку качества вы увидите только по проигранным ставкам.'));
      const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
      dirtyEl.textContent = dirty ? 'Есть несохраненные изменения' : 'Изменений нет';
      dirtyEl.classList.toggle('on', dirty);
      resetBtn.disabled = !dirty;
    }

    // Глубина размышлений: переключатель зависит от выбранной модели (Haiku 4.5 effort не поддерживает)
    function drawEffort(id) {
      const slot = UI.clear(effortSlots[id]);
      const model = draft.models[id];
      const labelId = 'costs-effort-' + id + '-label';
      if (!supportsEffort(model)) {
        slot.appendChild(h('div', { class: 'costs-effort-off' }, icon('info'), 'Глубина размышлений (effort): не поддерживается в ' + model));
        return;
      }
      const levels = EFFORT_LEVELS[id];
      if (!levels.includes(draft.effort[id])) draft.effort[id] = levels[0];
      const seg = UI.segmented({
        label: 'Глубина размышлений (effort) — ' + typeOf(id).label.toLowerCase(),
        items: levels.map(e => ({ id: e, label: EFFORT_LABEL[e] })),
        active: draft.effort[id],
        onChange: e => { draft.effort[id] = e; refresh(); },
      });
      seg.querySelectorAll('button').forEach((b, i) => { b.title = 'effort: ' + levels[i]; });
      slot.appendChild(h('div', { class: 'costs-effort' }, h('span', { class: 'costs-effort-label', id: labelId }, 'Глубина размышлений (effort)'), seg));
    }

    const TASK_LABEL = { parse: 'Разбор текста событий', analysis: 'Анализ матчей', postmortem: 'Разбор ставок', refresh: 'Обновление профилей (ночью, через Batch)' };
    const modelFields = ['parse', 'analysis', 'postmortem', 'refresh'].map(id => {
      const t = typeOf(id);
      const f = UI.field({
        id: 'costs-model-' + id, label: TASK_LABEL[id],
        options: t.options.map(m => ({ value: m, label: m + ' — ' + usd(PRICE[m].in, 0) + ' / ' + usd(PRICE[m].out, 0) + ' за 1M' + (m === saved.models[id] ? ' (сейчас)' : '') })),
        value: draft.models[id],
        attrs: { on: { change: e => { draft.models[id] = e.target.value; drawEffort(id); refresh(); } } },
      });
      effortSlots[id] = h('div');
      hints[id] = h('div', { class: 'costs-task-hint', 'aria-live': 'polite' });
      drawEffort(id);
      return h('div', { class: 'costs-task-set' }, f, effortSlots[id], hints[id]);
    });
    const num = (id, key, label, suffix, hint, dec, cls) => UI.field({
      id, label, value: dec ? nf(dec).format(draft[key]) : String(draft[key]), suffix, hint, inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off', class: cls,
      attrs: { on: { input: e => { const v = e.target.value.replace(/\s/g, '').replace(',', '.'); draft[key] = v === '' ? 0 : (isNaN(+v) ? NaN : +v); refresh(); } } },
    });
    const tog = (key, label, hint) => UI.toggle({ id: 'costs-t-' + key, label, hint, checked: draft[key], onChange: v => { draft[key] = v; refresh(); } });
    const maxRun = Math.max(...SCOPE_RUNS.filter(r => r.type === 'analysis').map(r => r.cost));

    const form = h('form', { class: 'card costs-card', id: 'costs-settings', novalidate: true, 'aria-labelledby': 'costs-settings-title', on: { submit: e => { e.preventDefault(); save(); } } },
      h('div', { class: 'card-head' }, h('div', { style: 'min-width:0' }, h('h3', { id: 'costs-settings-title' }, 'Настройки экономии'), h('div', { class: 'card-sub' }, 'Модель и глубина размышлений для каждой задачи, лимиты и приемы, которые снижают расход. Применяются со следующего запуска.'))),
      h('div', { class: 'card-body' },
        h('div', { class: 'costs-settings-grid' },
          h('div', { class: 'costs-settings-col' },
            h('div', { class: 'eyebrow' }, 'Модель и effort для каждой задачи'),
            modelFields,
            h('div', { class: 'eyebrow', style: 'margin-top:6px' }, 'Лимиты на деньги'),
            h('div', { class: 'costs-limits' },
              num('costs-limit-month', 'limitMonth', 'Ваш ориентир на месяц', '$', 'подсказка: анализы не останавливает', 0, 'costs-wide'),
              num('costs-limit-soft', 'limitSoft', 'Предупредить при', '$', 'цена одного анализа', 2),
              num('costs-limit-hard', 'limitHard', 'Остановить анализ при', '$', 'макс. было ' + usd(maxRun) + '; ставка не формируется', 2)),
            h('div', { class: 'costs-task-hint' }, 'Пороги на анализ — для всех. Бюджет ключа администратора (' + usd(D.admin.budget.monthly, 0) + ' в месяц) и лимиты участников — в ', h('a', { href: '#admin-limits' }, 'Администрировании'), '.'),
            h('div', { class: 'eyebrow', style: 'margin-top:6px' }, 'Лимиты на веб-поиск'),
            h('div', { class: 'costs-limits two' },
              num('costs-limit-search', 'searchLimit', 'На анализ, не больше', 'шт', '2–3 на игрока; 0 — без лимита', 0),
              num('costs-limit-day', 'searchDay', 'В день, не больше', 'шт', 'сейчас ≈ ' + fmt.dec(TOT.searches / DAYS, 1) + ' в день', 0))),
          h('div', { class: 'costs-settings-col' },
            h('div', { class: 'eyebrow' }, 'Приемы экономии'),
            h('div', { class: 'costs-toggles' },
              tog('cache', 'Кэширование промпта', 'Внутри одного анализа итерации 2–3 читают инструкции, уроки и досье из кэша — у Opus 5.5 в 20 раз дешевле обычного входа. Между анализами кэш (5 мин) обычно не доживает.'),
              tog('batch', 'Ночные обновления через Batch API (−50%)', 'Профили игроков обновляются пакетом ночью: ответ до 24 ч, цена вдвое ниже.'),
              tog('newsCache', 'Кэш новостей 12 ч', 'Новости по игроку не ищутся повторно, если им меньше 12 часов. Кэш общий: найденное один раз переиспользуется.'),
              tog('dossier', 'Сжатое досье вместо чтения файлов', 'Одно досье на 2–3 тыс. токенов на игрока вместо 10–20 обращений к файлам.'),
              tog('eval', 'Проверять качество на eval-наборе перед сменой модели или effort', 'Новая настройка анализа принимается, только если на 220 событиях отложенной выборки она ' + RULE_TEXT + '.')),
            h('div', { class: 'costs-forecast' },
              h('div', { style: 'min-width:0' }, h('div', { class: 'small soft' }, 'Прогноз ваших запусков на октябрь с этими настройками'), forecastNum),
              forecastChip),
            warnSlot))),
      h('div', { class: 'card-foot costs-settings-foot' }, saveBtn, resetBtn, dirtyEl));

    function validate() {
      if (!(draft.limitMonth >= 1)) return 'Ориентир на месяц — не меньше $1';
      if (!(draft.limitSoft > 0)) return 'Порог предупреждения должен быть больше нуля';
      if (!(draft.limitHard >= draft.limitSoft)) return 'Порог остановки анализа — не меньше порога предупреждения';
      if (draft.searchLimit < 0 || draft.searchLimit > 10 || Math.round(draft.searchLimit) !== draft.searchLimit) return 'Поисков на анализ — целое число от 0 до 10';
      if (draft.searchDay < 0 || draft.searchDay > 50 || Math.round(draft.searchDay) !== draft.searchDay) return 'Поисков в день — целое число от 0 до 50';
      return null;
    }
    function commit(msg) {
      saved = clone(draft);
      A.budget = saved.limitMonth; // личный ориентир администратора; настоящие лимиты — в DATA.admin и DATA.users
      redraw();
      UI.toast(msg || 'Настройки экономии сохранены');
    }
    function save() {
      const err = validate();
      if (err) { UI.toast(err, 'alert'); return; }
      if (JSON.stringify(draft) === JSON.stringify(saved)) { UI.toast('Изменений нет — все уже сохранено', 'info'); return; }
      const changes = [];
      TYPES.forEach(t => {
        if (draft.models[t.id] !== saved.models[t.id]) changes.push({ type: t.id, kind: 'model', from: saved.models[t.id], to: draft.models[t.id] });
        else if (supportsEffort(draft.models[t.id]) && draft.effort[t.id] !== saved.effort[t.id]) changes.push({ type: t.id, kind: 'effort', from: saved.effort[t.id], to: draft.effort[t.id] });
      });
      if (changes.length && draft.eval) {
        evalModal(changes, res => {
          if (!res) return;
          const rejected = res.filter(r => !r.ok);
          rejected.forEach(r => {
            if (r.kind === 'effort') draft.effort[r.type] = r.from; else draft.models[r.type] = r.from;
            const lv = LEVERS.find(l => l.candidate && l.check && (c => c.type === r.type && c.kind === r.kind && c.to === r.to)(l.check()));
            if (lv) candidateState[lv.id] = 'rejected';
          });
          commit(rejected.length ? 'Сохранено. Не принято по качеству: ' + rejected.map(r => changeLabel(r) + ' для «' + typeOf(r.type).label.toLowerCase() + '»').join(', ') : 'Сохранено: качество на eval-наборе в пределах допуска');
        });
        return;
      }
      commit();
    }
    refresh();
    return form;
  }

  // ---------- навигация внутри экрана ----------
  function scrollToSettings(focusId) {
    const el = document.getElementById('costs-settings');
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const f = focusId && document.getElementById(focusId);
    if (f) setTimeout(() => f.focus({ preventScroll: true }), 350);
  }

  // ---------- экран ----------
  UI.register('costs', {
    title: 'ИИ и расходы',
    crumbs: 'Модель · Claude API',
    render(root) {
      const mobile = UI.isMobile();
      // Перерисовка без потери позиции прокрутки; anchor — id блока, который нужно удержать на месте
      function redraw(anchor) {
        const a = anchor && document.getElementById(anchor);
        const top = a ? a.getBoundingClientRect().top : null;
        const y = window.scrollY;
        UI.clear(root);
        build();
        const b = anchor && document.getElementById(anchor);
        if (b && top != null) window.scrollTo(0, window.scrollY + b.getBoundingClientRect().top - top);
        else window.scrollTo(0, y);
      }
      function pickType(id) {
        runFilter = id; showAllRuns = false;
        redraw();
        const el = document.getElementById('costs-runs');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      function build() {
        setScope(); // роль и данные текущего пользователя читаем при каждой отрисовке
        const hero = V.admin ? adminHero() : V.own ? ownHero() : memberHero();
        const side = V.admin ? adminWhoCard() : memberRulesCard();
        UI.append(root, [
          headBlock(),
          h('div', { class: 'grid costs-top' },
            h('div', { class: 'col-7', style: 'min-width:0' }, hero),
            h('div', { class: 'col-5', style: 'min-width:0' }, side)),
          scopeHead(),
          h('div', { class: 'grid costs-tiles' }, tiles(mobile)),
          h('div', { class: 'costs-main' },
            h('div', { class: 'costs-col' }, dailyCard(mobile), leversCard(redraw)),
            h('div', { class: 'costs-col' }, typesCard(pickType), compareCard(), versionsCard(mobile))),
          h('div', { class: 'grid' }, runsCard(mobile, redraw)),
          settingsCard(redraw),
        ]);
      }
      build();
    },
  });
})();
