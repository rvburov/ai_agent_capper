/* ИИ и расходы: бюджет Claude API, токены и кэш, стоимость каждого запуска, рычаги экономии и настройки.
   Фактические цифры — из DATA.ai (запуски 1–7 окт). Прогнозы и «до/после» помечены как оценки. */
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
  // Текущий бот (bot.py): Sonnet 4.6, до 20 циклов tool use, без кэша — оценка на один анализ
  const OLD = { model: 'Sonnet 4.6', pin: 3, pout: 15, input: 420000, output: 18000, searches: 8 };
  OLD.cost = (OLD.input * OLD.pin + OLD.output * OLD.pout) / 1e6 + OLD.searches * SEARCH;

  const TYPES = [
    { id: 'analysis', label: 'Анализ матчей', short: 'Анализ', bar: 'Анализ матчей', what: 'Вероятности по событиям, валуй и экспресс', options: ['Opus 5.5', 'Sonnet 5.5'] },
    { id: 'refresh', label: 'Обновление профилей', short: 'Профили', bar: 'Профили', what: 'Ночью пакетом: статистика, форма, новости', options: ['Sonnet 5.5', 'Haiku 4.5', 'Opus 5.5'] },
    { id: 'postmortem', label: 'Разбор ставки', short: 'Разбор ставок', bar: 'Разбор ставки', what: 'После расчёта: что сработало — кандидаты в уроки', options: ['Sonnet 5.5', 'Opus 5.5', 'Haiku 4.5'] },
    { id: 'parse', label: 'Разбор текста', short: 'Разбор текста', bar: 'Разбор текста', what: 'Вставленный текст → список событий', options: ['Haiku 4.5', 'Sonnet 5.5', 'Opus 5.5'] },
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

  // ---------- агрегаты по фактическим запускам ----------
  const RUNS = A.runs.slice().sort((a, b) => b.at.localeCompare(a.at));
  const BASE = {};
  TYPES.forEach(t => {
    const rs = A.runs.filter(r => r.type === t.id);
    const n = rs.length;
    const s = { n, input: sum(rs, r => r.input), cached: sum(rs, r => r.cached), output: sum(rs, r => r.output), searches: sum(rs, r => r.searches), cost: sum(rs, r => r.cost), duration: sum(rs, r => r.duration) };
    BASE[t.id] = Object.assign(s, {
      avgIn: n ? s.input / n : 0, avgOut: n ? s.output / n : 0, avgSearch: n ? s.searches / n : 0, avgCost: n ? s.cost / n : 0,
      cacheShare: s.input ? s.cached / s.input : 0, perMonth: n * PER_MONTH, avgDuration: n ? s.duration / n : 0,
    });
  });
  const TOT = {
    input: sum(A.runs, r => r.input), cached: sum(A.runs, r => r.cached), output: sum(A.runs, r => r.output),
    searches: sum(A.runs, r => r.searches), runs: A.runs.length,
  };
  const FORECAST = A.spent / DAYS * MONTH_DAYS; // та же формула, что на главной
  const days = [];
  for (let d = 1; d <= DAYS; d++) days.push('2026-10-0' + d);
  const byDay = days.map(day => {
    const rs = A.runs.filter(r => r.at.slice(0, 10) === day);
    return { day, runs: rs, cost: sum(rs, r => r.cost), tokens: sum(rs, r => r.input + r.output) };
  });
  // Сколько сэкономил кэш за 1–7 окт: кэш-токены по цене обычного входа минус фактическая цена
  const cacheSavedWeek = sum(A.runs, r => r.cached * (PRICE[r.model].in - PRICE[r.model].cache) / 1e6 * (r.batch ? 0.5 : 1));

  // ---------- что связано с каждым запуском (для окна деталей) ----------
  const META = {};
  const activeStrategy = D.strategyVersions.find(v => v.status === 'active') || { id: 'v3', brier: 0.201, logloss: 0.583 };
  const lessonsInPrompt = D.lessons.filter(l => l.inPrompt).map(l => l.id);
  const tourName = date => { const t = D.calendar.find(c => date >= c.from && date <= c.to); return t ? t.name : 'Шанхай'; };
  (function buildMeta() {
    const an = A.runs.filter(r => r.type === 'analysis'), rf = A.runs.filter(r => r.type === 'refresh'), ps = A.runs.filter(r => r.type === 'parse'), pm = A.runs.filter(r => r.type === 'postmortem');
    an.forEach((r, i) => {
      const last = i === an.length - 1;
      const n = last ? 3 : 2 + (i % 2);
      META[r.id] = {
        ref: 'анализ #A-' + String(132 + i).padStart(4, '0'), href: '#analysis',
        what: last ? 'Синнер — Руне, Джокович — Рублёв, Зверев — Музетти' : n + ' ' + fmt.plural(n, 'событие', 'события', 'событий') + ' · ' + tourName(r.at.slice(0, 10)),
        prompt: 'analysis v3 · стратегия ' + activeStrategy.id,
        prefix: 'Инструкции, стратегия ' + activeStrategy.id + ', уроки ' + lessonsInPrompt.join(', ') + ' и досье игроков',
      };
    });
    rf.forEach((r, i) => {
      const n = r.searches + 6;
      META[r.id] = { ref: 'пакет #B-' + String(17 + i).padStart(4, '0'), href: '#players', what: 'Обновлено ' + n + ' ' + fmt.plural(n, 'профиль', 'профиля', 'профилей') + ' (ночной пакет)', prompt: 'profile-refresh v2', prefix: 'Инструкции по профилю и прошлое досье игрока' };
    });
    pm.forEach(r => {
      const bet = D.bets.filter(b => b.status !== 'open' && b.date < r.at.slice(0, 10)).pop();
      META[r.id] = { ref: 'ставка №' + (bet ? bet.id : '—'), href: '#bets', what: bet ? (bet.legs.length > 1 ? 'Экспресс из ' + bet.legs.length + ' событий' : 'Ординар') + ' · ' + (bet.status === 'win' ? 'выигрыш' : bet.status === 'loss' ? 'проигрыш' : 'возврат') : 'Разбор рассчитанной ставки', prompt: 'postmortem v2', prefix: 'Инструкции разбора и стратегия ' + activeStrategy.id };
    });
    ps.forEach((r, i) => {
      const n = 3 + (i % 3);
      META[r.id] = { ref: 'ввод #T-' + String(201 + i).padStart(4, '0'), href: '#new', what: 'Текст из ' + n + ' событий → список матчей', prompt: 'parse-events v1', prefix: null };
    });
  })();

  // ---------- настройки и оценка расходов ----------
  const DEFAULTS = {
    models: { parse: 'Haiku 4.5', analysis: 'Opus 5.5', postmortem: 'Sonnet 5.5', refresh: 'Sonnet 5.5' },
    limitMonth: A.budget, limitRun: 0.4, searchLimit: 3,
    cache: true, batch: true, newsCache: true, dossier: true, eval: true,
  };
  let saved = clone(DEFAULTS);
  let draft = clone(DEFAULTS);
  let runFilter = 'all', showAllRuns = false;
  let candidateState = null; // результат проверки «анализ на Sonnet 5.5»

  function perRun(type, set) {
    const b = BASE[type], p = PRICE[set.models[type]];
    if (!b.n) return 0;
    let inp = b.avgIn, cs = b.cacheShare, out = b.avgOut, srch = b.avgSearch;
    if (type === 'analysis' && !set.dossier) { inp = 420000; cs = 0.35; out = 18000; } // модель сама читает файлы в 15–20 итераций
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
  const withSet = (set, patch) => { const s = clone(set); Object.keys(patch).forEach(k => { if (k === 'models') Object.assign(s.models, patch.models); else s[k] = patch[k]; }); return s; };

  // Рычаги экономии: включён ли и сколько экономит (оценка на месяц при остальных настройках как сейчас)
  const LEVERS = [
    { id: 'dossier', title: 'Сжатое досье вместо 15–20 итераций', how: 'ИИ получает одно готовое досье по игрокам из базы, а не читает .md и JSON-файлы по одному, пересылая всю историю на каждом шаге.',
      isOn: s => s.dossier, set: (s, on) => withSet(s, { dossier: on }) },
    { id: 'cache', title: 'Кэширование стабильной части промпта', how: 'Инструкции, стратегия и уроки одинаковы между запусками — они читаются из кэша в 10–20 раз дешевле обычного входа.',
      isOn: s => s.cache, set: (s, on) => withSet(s, { cache: on }) },
    { id: 'search', title: 'Лимит веб-поисков и кэш новостей 12 ч', how: 'Не больше 3 поисков на анализ; новости по игроку не ищутся заново, если им меньше 12 часов. Каждый поиск — $0,01 и ≈ 4 тыс. токенов во входе.',
      isOn: s => s.searchLimit > 0 && s.newsCache, set: (s, on) => withSet(s, on ? { searchLimit: s.searchLimit || 3, newsCache: true } : { searchLimit: 0, newsCache: false }) },
    { id: 'routing', title: 'Маршрутизация моделей', how: 'Простые задачи — дешёвым моделям: разбор текста на Haiku 4.5, разбор ставок и профили на Sonnet 5.5. Opus 5.5 — только для анализа.',
      isOn: s => !(s.models.parse === 'Opus 5.5' && s.models.postmortem === 'Opus 5.5' && s.models.refresh === 'Opus 5.5'),
      set: (s, on) => on ? (LEVERS[3].isOn(s) ? clone(s) : withSet(s, { models: { parse: 'Haiku 4.5', postmortem: 'Sonnet 5.5', refresh: 'Sonnet 5.5' } })) : withSet(s, { models: { parse: 'Opus 5.5', postmortem: 'Opus 5.5', refresh: 'Opus 5.5' } }) },
    { id: 'batch', title: 'Batch API для фоновых задач', how: 'Ночное обновление профилей идёт пакетом: ответ приходит в течение суток, зато вдвое дешевле.',
      isOn: s => s.batch, set: (s, on) => withSet(s, { batch: on }) },
    { id: 'sonnet', candidate: true, title: 'Анализ матчей на Sonnet 5.5', how: 'Вдвое дешевле Opus 5.5 по входу и выходу. Включим, только если на eval-наборе Brier и лог-лосс не хуже.',
      isOn: s => s.models.analysis === 'Sonnet 5.5', set: (s, on) => withSet(s, { models: { analysis: on ? 'Sonnet 5.5' : 'Opus 5.5' } }) },
  ];
  const leverSaving = (lv, s) => estRaw(lv.set(s, false)) - estRaw(lv.set(s, true));
  const ALL_OFF = { models: { parse: 'Opus 5.5', analysis: 'Opus 5.5', postmortem: 'Opus 5.5', refresh: 'Opus 5.5' }, limitMonth: 15, limitRun: 0.4, searchLimit: 0, cache: false, batch: false, newsCache: false, dossier: false, eval: true };

  // ---------- eval-наборы (демо-результаты проверки) ----------
  const EVAL = {
    analysis: { set: '220 рассчитанных событий с июля', size: 220, perRun: 2.3 },
    parse: { set: '150 сообщений с проверенным разбором', size: 150, perRun: 1 },
    postmortem: { set: '40 ставок с подтверждёнными выводами', size: 40, perRun: 1 },
    refresh: { set: '30 досье, сверенных вручную', size: 30, perRun: 1 },
  };
  function evalCost(type, model) {
    const s = withSet(saved, { models: { [type]: model } });
    const per = perRun(type, s) - BASE[type].avgSearch * SEARCH; // проверка идёт на сохранённых данных, без поиска
    return EVAL[type].size / EVAL[type].perRun * per * 0.5;      // через Batch API
  }
  function evalResult(type, to) {
    const dec3 = v => fmt.dec(v, 3);
    if (type === 'analysis') {
      if (to === 'Sonnet 5.5') return { ok: false, rows: [['Brier', dec3(activeStrategy.brier), dec3(activeStrategy.brier + 0.004), 'worse'], ['Лог-лосс', dec3(activeStrategy.logloss), dec3(activeStrategy.logloss + 0.011), 'worse'], ['Прогноз 75% сбывается', '74%', '70%', 'worse']], why: 'Sonnet 5.5 завышает шансы фаворитов на 3–5 п.п. в матчах с тай-брейками.' };
      return { ok: true, rows: [['Brier', dec3(activeStrategy.brier), dec3(activeStrategy.brier), 'same'], ['Лог-лосс', dec3(activeStrategy.logloss), dec3(activeStrategy.logloss), 'same']], why: 'Возврат к проверенной модели.' };
    }
    if (type === 'parse') return to === 'Haiku 4.5'
      ? { ok: true, rows: [['Точность разбора событий', '98,7%', '98,7%', 'same']], why: 'Качество то же, дешевле.' }
      : { ok: true, rows: [['Точность разбора событий', '98,7%', to === 'Opus 5.5' ? '99,1%' : '98,9%', 'better']], why: 'Качество не хуже, но дороже: на коротких текстах Haiku 4.5 справляется так же.' };
    if (type === 'postmortem') return to === 'Haiku 4.5'
      ? { ok: false, rows: [['Совпадение с подтверждёнными уроками', '85%', '72%', 'worse']], why: 'Haiku 4.5 пропускает причины проигрыша, связанные с усталостью и покрытием.' }
      : { ok: true, rows: [['Совпадение с подтверждёнными уроками', '85%', to === 'Opus 5.5' ? '87%' : '85%', to === 'Opus 5.5' ? 'better' : 'same']], why: 'Качество не хуже.' };
    return to === 'Haiku 4.5'
      ? { ok: false, rows: [['Полнота досье', '96%', '88%', 'worse'], ['Ошибки в статистике подачи', '0,4%', '2,1%', 'worse']], why: 'Haiku 4.5 теряет часть статистики из длинных страниц.' }
      : { ok: true, rows: [['Полнота досье', '96%', to === 'Opus 5.5' ? '97%' : '96%', to === 'Opus 5.5' ? 'better' : 'same']], why: 'Качество не хуже.' };
  }

  // ---------- стили экрана ----------
  UI.css('costs', `
    .costs-head h2 { font-size: var(--fs-2xl); }
    .costs-head-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .costs-hero { padding: 18px; gap: 14px; height: 100%; justify-content: space-between; }
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
    .costs-main { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: 16px; align-items: start; }
    .costs-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    @media (max-width: 1180px) {
      .costs-main { display: flex; flex-direction: column; align-items: stretch; }
      .costs-col { display: contents; }
      .costs-o-1 { order: 1; } .costs-o-2 { order: 2; } .costs-o-3 { order: 3; } .costs-o-4 { order: 4; }
    }
    @media (max-width: 960px) { .costs-main, .costs-col { gap: 16px; } }
    .costs-tiles .stat-hint { line-height: 1.35; }

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
    .costs-lever-body { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .costs-lever-title { font-weight: 600; line-height: 1.3; }
    .costs-lever-text { font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-lever-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 4px; }
    .costs-lever-save { text-align: right; white-space: nowrap; font-weight: 600; font-variant-numeric: tabular-nums; }
    .costs-lever-save small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    .costs-total { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 6px 16px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); font-size: var(--fs-sm); color: var(--fg-2); }
    .costs-total b { color: var(--fg); font-variant-numeric: tabular-nums; }

    .costs-compare { display: grid; grid-template-columns: minmax(0, .85fr) minmax(0, 1fr) minmax(0, 1fr); margin: 0; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; font-size: var(--fs-sm); }
    .costs-compare > div { padding: 8px 10px; border-top: 1px solid var(--line); min-width: 0; line-height: 1.4; }
    .costs-compare > .hd { border-top: 0; background: var(--surface-2); font-size: var(--fs-xs); font-weight: 600; color: var(--fg-2); }
    .costs-compare > .hd.new { color: var(--accent-ink); background: var(--accent-soft); }
    .costs-compare > .lbl { color: var(--fg-3); }
    .costs-compare > .new { font-weight: 600; }
    .costs-compare small { display: block; font-weight: 400; color: var(--fg-3); font-size: var(--fs-xs); }
    @media (max-width: 720px) {
      .costs-compare { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
      .costs-compare > .hd.blank { display: none; }
      .costs-compare > .lbl { grid-column: 1 / -1; padding-bottom: 0; font-size: var(--fs-xs); text-transform: uppercase; letter-spacing: .05em; font-weight: 600; }
      .costs-compare > .old:not(.hd), .costs-compare > .new:not(.hd) { border-top: 0; padding-top: 2px; }
    }

    .costs-nowrap { white-space: nowrap; }
    .costs-sub { font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .costs-task { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-weight: 500; }
    .costs-table .table td { white-space: nowrap; }
    .costs-table .table td:nth-child(2) { white-space: normal; }
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
    @media (max-width: 720px) { .costs-limits { gap: 8px; } .costs-settings-foot .btn { flex: 1 1 auto; } }
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
    .costs-formula { font-family: var(--font-mono); font-size: var(--fs-xs); color: var(--fg-2); background: var(--surface-2); border-radius: var(--r-sm); padding: 10px 12px; line-height: 1.6; overflow-wrap: anywhere; }
    .costs-modal-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .costs-verdict { display: flex; align-items: center; gap: 4px; }
    .costs-progress { display: flex; flex-direction: column; gap: 6px; }
    .costs-price-model b { display: block; }
    .costs-price-model .mono { font-size: var(--fs-xs); color: var(--fg-3); }
  `);

  // ---------- мелкие элементы ----------
  const modelChip = m => chip(m, 'outline');
  const batchChip = () => chip('Batch −50%', 'accent', 'layers');
  const howto = text => h('div', { class: 'costs-howto' }, icon('info'), h('span', null, text));
  const budgetKind = share => share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : 'good';

  // ---------- окно: разбор стоимости запуска ----------
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
    const formula = '(' + fmt.int(r.cached) + ' × ' + n(p.cache) + ' + ' + fmt.int(plain) + ' × ' + n(p.in) + ' + ' + fmt.int(r.output) + ' × ' + n(p.out) + ') / 1 000 000'
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
        UI.table({
          columns: [
            { label: 'Статья', render: x => x.name },
            { label: 'Объём', align: 'r', render: x => x.tokens != null ? fmt.int(x.tokens) + ' ток.' : x.n + ' ' + fmt.plural(x.n, 'поиск', 'поиска', 'поисков') },
            { label: 'Цена', align: 'r', render: x => x.tokens != null ? usd(x.price) + ' / 1M' : '$10 / 1000' },
            { label: 'Сумма', align: 'r', render: x => h('b', null, usd(x.cost, 4)) },
          ],
          rows: parts,
        }),
        r.batch ? h('div', { class: 'small soft' }, 'Batch API: токены на 50% дешевле, ответ — в течение суток. Подходит для ночных задач.') : null,
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Формула'), h('div', { class: 'costs-formula' }, formula)),
        UI.kv([
          ['Связано', m.href ? h('a', { href: m.href, on: { click: close } }, m.ref) : (m.ref || '—')],
          ['Что сделал', m.what || t.what],
          ['Версия промпта', h('span', { class: 'mono' }, m.prompt || '—')],
          ['Из кэша читается', m.prefix || 'Не кэшируется: запрос короче минимального префикса для кэша'],
          ['ID модели', h('span', { class: 'mono' }, p.id)],
        ]),
        howto('Цены — прайс Anthropic за 1M токенов на 7 окт 2026. Запись в кэш (×1,25 к цене входа, раз в 5 минут) в макете не выделена отдельно.'),
      ],
      actions: close => [
        button('Закрыть', { kind: 'secondary', onClick: close }),
        m.href ? button(r.type === 'analysis' ? 'Открыть анализ' : r.type === 'postmortem' ? 'К ставкам' : r.type === 'refresh' ? 'К игрокам' : 'Новый анализ', { kind: 'primary', iconRight: 'arrowRight', href: m.href, attrs: { on: { click: close } } }) : null,
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
        h('p', { class: 'soft' }, 'За 1 млн токенов, прайс Anthropic на 7 октября 2026. В приложении цены берутся из настроек, а не зашиты в код.'),
        UI.table({
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
          ['Бот сейчас (Sonnet 4.6)', '$3 / $15'],
        ]),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // ---------- окно: проверка на eval-наборе ----------
  // changes: [{type, from, to}]; done(results) вызывается после «Применить»/«Оставить»
  function evalModal(changes, done) {
    const totalCost = sum(changes, c => evalCost(c.type, c.to));
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
        h('p', { class: 'soft' }, 'Перед сменой модели прогоняем её на событиях, для которых уже известен результат, и сравниваем с текущей. Промпт тот же, данные те же — меняется только модель.'),
        UI.table({
          columns: [
            { label: 'Задача', render: c => typeOf(c.type).label },
            { label: 'Смена', render: c => h('span', { class: 'costs-nowrap' }, c.from + ' → ' + c.to) },
            { label: 'Набор', render: c => h('span', { class: 'small soft' }, EVAL[c.type].set) },
          ],
          rows: changes,
        }),
        UI.kv([['Стоимость проверки', '≈ ' + usd(totalCost) + ' через Batch API'], ['Списывается', 'из месячного лимита (' + usd(saved.limitMonth, 0) + ')']]),
        UI.callout('accent', 'shield', 'Модель меняется, только если Brier и лог-лосс (для других задач — их метрика качества) не хуже, чем сейчас.'),
      ]);
      UI.clear(footEl);
      UI.append(footEl, [button('Отмена', { kind: 'secondary', onClick: () => ui.close() }), button('Запустить проверку', { kind: 'primary', icon: 'play', onClick: run })]);
    }
    function run() {
      const size = sum(changes, c => EVAL[c.type].size);
      const meterBox = h('div');
      const label = h('div', { class: 'small soft', 'aria-live': 'polite' });
      UI.clear(bodyEl);
      UI.append(bodyEl, [h('div', { class: 'costs-progress' }, h('div', { class: 'row-between' }, h('b', null, 'Идёт проверка…'), label), meterBox),
        howto('В приложении проверка через Batch API занимает до нескольких часов — придёт уведомление. В макете — пара секунд.')]);
      UI.clear(footEl);
      UI.append(footEl, [button('Проверка идёт…', { kind: 'secondary', disabled: true })]);
      let step = 0;
      const draw = () => { const done = Math.min(size, Math.round(size * step / 14)); UI.clear(meterBox).appendChild(UI.meter(done, size)); label.textContent = 'Обработано ' + done + ' из ' + size; };
      draw();
      timer = setInterval(() => { step++; draw(); if (step >= 14) { clearInterval(timer); show(); } }, 110);
    }
    function show() {
      results = changes.map(c => Object.assign({}, c, evalResult(c.type, c.to)));
      const verdict = v => v === 'worse' ? chip('Хуже', 'bad', 'arrowDown') : v === 'better' ? chip('Лучше', 'good', 'arrowUp') : chip('Не хуже', 'good', 'check');
      UI.clear(bodyEl);
      results.forEach(res => {
        const before = perRun(res.type, saved), after = perRun(res.type, withSet(saved, { models: { [res.type]: res.to } }));
        UI.append(bodyEl, h('section', { class: 'stack', style: 'gap:10px' },
          h('div', { class: 'row-between' }, h('h4', null, typeOf(res.type).label + ': ' + res.from + ' → ' + res.to),
            res.ok ? chip('Принято', 'good', 'check') : chip('Не принято', 'bad', 'x')),
          UI.table({
            columns: [
              { label: 'Метрика', render: x => x[0] },
              { label: 'Сейчас', align: 'r', render: x => x[1] },
              { label: res.to, align: 'r', render: x => h('b', null, x[2]) },
              { label: 'Итог', align: 'r', render: x => x[3] ? verdict(x[3]) : '' },
            ],
            rows: res.rows.concat([['Цена одного запуска', usd(before, 3), usd(after, 3), null]]),
          }),
          h('p', { class: 'small soft' }, res.why)));
      });
      const rejected = results.filter(r => !r.ok);
      UI.append(bodyEl, rejected.length
        ? UI.callout('warn', 'shield', 'Экономия не принята: качество на eval-наборе хуже. Оставляем ' + rejected.map(r => r.from + ' для задачи «' + typeOf(r.type).label.toLowerCase() + '»').join(', ') + '.')
        : UI.callout('good', 'check', 'Качество не хуже — смену можно применить.'));
      UI.clear(footEl);
      UI.append(footEl, rejected.length
        ? [button('Подробнее в «Обучении модели»', { kind: 'ghost', href: '#learning', attrs: { on: { click: () => ui.close() } } }), button(results.some(r => r.ok) ? 'Применить принятое' : 'Оставить ' + rejected[0].from, { kind: 'primary', onClick: () => { ui.close(); done(results); } })]
        : [button('Отмена', { kind: 'secondary', onClick: () => { results = null; ui.close(); } }), button('Применить', { kind: 'primary', icon: 'check', onClick: () => { ui.close(); done(results); } })]);
    }
    intro();
  }

  // ---------- блоки экрана ----------
  function headBlock() {
    return h('div', { class: 'page-head costs-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Расходы на Claude в октябре'),
        h('p', { class: 'lead' }, '1–7 октября · ' + TOT.runs + ' ' + fmt.plural(TOT.runs, 'запуск', 'запуска', 'запусков') + ' Claude API. Сколько стоит каждый анализ, что берётся из кэша и где ещё можно сэкономить без потери качества.')),
      h('div', { class: 'costs-head-actions' },
        button('Цены моделей', { kind: 'secondary', size: 'sm', icon: 'coins', onClick: pricesModal }),
        button('Настройки экономии', { kind: 'secondary', size: 'sm', icon: 'edit', onClick: () => scrollToSettings() })));
  }

  function heroCard() {
    const budget = saved.limitMonth, share = A.spent / budget, fShare = FORECAST / budget;
    const kind = budgetKind(Math.max(share, fShare > 1 ? 0.95 : 0));
    const daily = A.spent / DAYS, pace = (budget - A.spent) / (MONTH_DAYS - DAYS);
    return h('section', { class: 'card stat costs-hero', 'aria-label': 'Расходы за месяц' },
      h('div', { class: 'costs-hero-top' },
        h('div', { class: 'stat-label' }, icon('coins', { width: 16, height: 16 }), 'Потрачено в октябре'),
        h('div', { class: 'costs-hero-value' },
          h('span', { class: 'stat-value hero' }, usd(A.spent)),
          h('span', { class: 'of' }, 'из ' + usd(budget, 0)),
          chip(pct(share) + ' лимита', budgetKind(share), share > 0.7 ? 'alert' : 'check'))),
      h('div', { class: 'stack', style: 'gap:8px' },
        h('div', { class: ['costs-bar', kind !== 'good' && kind], role: 'meter', 'aria-label': 'Потрачено ' + usd(A.spent) + ' из ' + usd(budget, 0) + ', прогноз ' + usd(FORECAST), 'aria-valuenow': A.spent, 'aria-valuemin': 0, 'aria-valuemax': budget },
          h('i', { class: 'proj', style: { width: Math.min(100, fShare * 100) + '%' } }),
          h('i', { class: 'spent', style: { width: Math.min(100, share * 100) + '%' } })),
        h('div', { class: 'costs-bar-legend' },
          h('span', null, h('i', { class: 'spent' }), 'Потрачено за 1–7 окт'),
          h('span', null, h('i', { class: 'proj' }), 'Прогноз на 31 окт ≈ ' + usd(FORECAST) + (fShare > 1 ? ' — выше лимита' : '')))),
      h('dl', { class: 'costs-kv' },
        h('div', null, h('dt', null, 'Осталось'), h('dd', null, usd(budget - A.spent), h('small', null, 'до 31 окт'))),
        h('div', null, h('dt', null, 'В день'), h('dd', null, usd(daily), h('small', null, 'в среднем'))),
        h('div', null, h('dt', null, 'Можно в день'), h('dd', null, usd(pace), h('small', null, 'чтобы уложиться')))),
      h('div', { class: 'row' },
        button('Изменить лимит', { kind: 'ghost', size: 'sm', icon: 'edit', onClick: () => scrollToSettings('costs-limit-month') }),
        h('span', { class: 'stat-hint' }, 'При 100% новые анализы встают на паузу, ставки и история доступны.')));
  }

  function tiles() {
    const an = BASE.analysis;
    const anCosts = A.runs.filter(r => r.type === 'analysis').map(r => r.cost);
    const change = (an.avgCost / OLD.cost - 1) * 100;
    return [
      UI.stat({ class: 'col-6 half-mobile', icon: 'spark', label: 'Средняя цена анализа', value: usd(an.avgCost), delta: fmt.signedPct(change, 0) + ' к боту', trend: 'down', good: false, hint: an.n + ' анализов', spark: anCosts, sparkColor: 'var(--s1)' }),
      UI.stat({ class: 'col-6 half-mobile', icon: 'database', label: 'Вход из кэша', value: pct(A.cacheShare / 100), hint: 'сэкономил ' + usd(cacheSavedWeek) + ' за 7 дней' }),
      UI.stat({ class: 'col-6 half-mobile', icon: 'layers', label: 'Токенов за месяц', value: fmt.tokens(TOT.input + TOT.output), hint: 'вход ' + fmt.tokens(TOT.input) + ' · выход ' + fmt.tokens(TOT.output), spark: byDay.map(d => d.tokens), sparkColor: 'var(--s1)' }),
      UI.stat({ class: 'col-6 half-mobile', icon: 'globe', label: 'Веб-поисков', value: String(TOT.searches), hint: usd(TOT.searches * SEARCH) + ' · лимит ' + (saved.searchLimit || '∞') + ' на анализ' }),
    ];
  }

  function dailyCard(mobile) {
    const budgetPace = saved.limitMonth / MONTH_DAYS;
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
    const max = byDay.reduce((a, d) => d.cost > a.cost ? d : a, byDay[0]);
    const maxRuns = TYPES.map(t => ({ t, n: max.runs.filter(r => r.type === t.id).length })).filter(x => x.n);
    const chart = UI.columnChart({ items, height: mobile ? 180 : 210, valueFormat: v => usd(v), labelEvery: 1, seriesName: 'Расход за день', ariaLabel: 'Расходы Claude API по дням, 1–7 октября' });
    return card({
      class: 'costs-card costs-o-1',
      title: 'Расходы по дням',
      subtitle: '1–7 октября, в долларах',
      actions: [chip('Темп под лимит — ' + usd(budgetPace) + ' в день', 'outline')],
      body: [
        UI.withTable(chart, () => UI.table({
          columns: [
            { label: 'День', render: d => fmt.date(d.day) + ', ' + weekday(d.day) },
            { label: 'Запусков', align: 'r', render: d => d.runs.length },
            { label: 'Токенов', align: 'r', render: d => fmt.tokens(d.tokens) },
            { label: 'Расход', align: 'r', render: d => h('b', null, usd(d.cost, 3)) },
          ],
          rows: byDay,
        })),
        howto('Как читать: столбец — сумма за день по всем задачам; наведите или нажмите, чтобы увидеть состав. Дороже всего ' + fmt.date(max.day) + ' (' + usd(max.cost) + '): ' + maxRuns.map(x => x.t.label.toLowerCase() + (x.n > 1 ? ' ×' + x.n : '')).join(', ') + '. ' + (over ? 'Дней выше темпа под лимит: ' + over + '.' : 'Ни один день не превысил темп под лимит.')),
      ],
    });
  }

  function typesCard(onPick) {
    const rows = TYPES.map(t => ({ t, b: BASE[t.id] })).sort((a, b) => b.b.cost - a.b.cost);
    return card({
      class: 'costs-card costs-o-2',
      title: 'На что уходят деньги',
      subtitle: 'По типам задач, 1–7 октября',
      body: [
        UI.hbars({ items: rows.map(x => ({ label: x.t.bar, value: x.b.cost, note: pct(x.b.cost / A.spent), color: 'var(--s1)', dot: false })), valueFormat: v => usd(v) }),
        h('ul', { class: 'costs-types', 'aria-label': 'Задачи: модель, токены, цена запуска' }, rows.map(x => h('li', null,
          h('button', { class: 'costs-type', type: 'button', title: 'Показать запуски: ' + x.t.label, on: { click: () => onPick(x.t.id) } },
            h('span', { class: 'costs-type-name' }, x.t.label, modelChip(A.runs.find(r => r.type === x.t.id).model), x.t.id === 'refresh' && batchChip()),
            h('span', { class: 'costs-type-meta' }, x.b.n + ' ' + fmt.plural(x.b.n, 'запуск', 'запуска', 'запусков') + ' · в среднем ' + fmt.tokens(x.b.avgIn) + ' вход / ' + fmt.tokens(x.b.avgOut) + ' выход · ' + (x.b.cached ? 'кэш ' + pct(x.b.cacheShare) : 'без кэша')),
            h('span', { class: 'costs-type-cost' }, h('span', null, h('b', null, usd(x.b.avgCost, 3)), h('small', null, 'за запуск')), icon('chevronRight')))))),
        howto('Длина полосы — сумма за неделю, справа — доля в расходах. Нажмите на задачу, чтобы увидеть её запуски.'),
      ],
    });
  }

  function leversCard(redraw) {
    const list = LEVERS.map(lv => ({ lv, on: lv.isOn(saved), save: leverSaving(lv, saved) })).sort((a, b) => b.save - a.save);
    let rankN = 0;
    const current = forecastFor(saved), without = forecastFor(withSet(ALL_OFF, { limitMonth: saved.limitMonth }));
    return card({
      class: 'costs-card costs-o-3',
      title: 'Где экономим',
      subtitle: 'Оценка на октябрь по запускам 1–7 окт. Каждая мера посчитана при остальных включённых, поэтому суммы не складываются.',
      body: [
        h('ol', { class: 'costs-levers' }, list.map(x => {
          const lv = x.lv;
          const rank = lv.candidate ? '?' : String(++rankN);
          let status, action = null;
          if (lv.candidate) {
            if (x.on) status = chip('Включено', 'good', 'check');
            else if (candidateState === 'rejected') status = chip('Не прошло проверку', 'bad', 'x');
            else {
              status = chip('Кандидат · ждёт проверки', 'info', 'flask');
              action = button('Проверить на eval-наборе', { kind: 'secondary', size: 'sm', icon: 'flask', onClick: () => evalModal([{ type: 'analysis', from: saved.models.analysis, to: 'Sonnet 5.5' }], res => { if (!res) return; candidateState = res[0].ok ? 'accepted' : 'rejected'; if (res[0].ok) { saved.models.analysis = 'Sonnet 5.5'; draft.models.analysis = 'Sonnet 5.5'; } redraw(); UI.toast(res[0].ok ? 'Анализ переведён на Sonnet 5.5' : 'Оставили Opus 5.5: на eval-наборе Brier хуже', res[0].ok ? 'check' : 'shield'); }) });
            }
          } else if (x.on) status = chip('Включено', 'good', 'check');
          else {
            status = chip('Выключено', 'warn', 'alert');
            action = button('Включить', { kind: 'secondary', size: 'sm', onClick: () => { saved = lv.set(saved, true); draft = clone(saved); redraw(); UI.toast('«' + lv.title + '» снова включено'); } });
          }
          return h('li', { class: ['costs-lever', lv.candidate && 'candidate'] },
            h('span', { class: 'costs-rank', 'aria-hidden': 'true' }, rank),
            h('div', { class: 'costs-lever-body' },
              h('div', { class: 'costs-lever-title' }, lv.title),
              h('div', { class: 'costs-lever-text' }, lv.how),
              h('div', { class: 'costs-lever-meta' }, status, action,
                lv.candidate && candidateState === 'rejected' ? h('span', { class: 'xsmall muted' }, 'Brier хуже на 0,004 — оставили Opus 5.5') : null)),
            h('div', { class: 'costs-lever-save' }, '≈ ' + usdM(x.save), h('small', null, x.on ? 'в месяц' : lv.candidate ? 'можно сэкономить' : 'теряем в месяц')));
        })),
        h('div', { class: 'costs-total' }, h('span', null, 'Без всех мер октябрь обошёлся бы'), h('span', null, h('b', null, '≈ ' + usdM(without)), ' вместо ', h('b', null, '≈ ' + usd(current)))),
        UI.callout('accent', 'shield', h('b', null, 'Правило: '), 'любая экономия принимается, только если Brier и лог-лосс на eval-наборе не хуже текущих. Дешевле, но хуже — не берём.'),
      ],
    });
  }

  function compareCard() {
    const an = BASE.analysis;
    const rows = [
      ['Модель', OLD.model, 'Opus 5.5', 'сильнее и дешевле за токен'],
      ['Запросов к модели', 'до 20', '1', 'поиск — внутри запроса'],
      ['Входных токенов', '≈ ' + fmt.tokens(OLD.input), '≈ ' + fmt.tokens(an.avgIn), pct(an.cacheShare) + ' из кэша'],
      ['Откуда данные', 'Читает .md и JSON по одному', 'Готовое досье из базы', 'поиск — только свежих новостей'],
      ['Время', '≈ 3–5 мин', fmt.duration(Math.round(an.avgDuration)), 'в среднем за октябрь'],
      ['Цена анализа', '≈ ' + usd(OLD.cost) + ' (оценка)', usd(an.avgCost), 'факт за 1–7 окт'],
    ];
    return card({
      class: 'costs-card costs-o-4',
      title: 'До и после',
      subtitle: 'Один анализ: бот в Telegram сейчас и новая схема',
      body: [
        UI.hbars({ items: [
          { label: 'Бот сейчас', value: OLD.cost, color: 'var(--chart-muted)', note: 'оценка' },
          { label: 'Новая схема', value: an.avgCost, color: 'var(--s1)', note: 'факт' },
        ], valueFormat: v => usd(v) }),
        h('div', { class: 'costs-compare' },
          h('div', { class: 'hd blank', 'aria-hidden': 'true' }),
          h('div', { class: 'hd' }, 'Бот в Telegram'),
          h('div', { class: 'hd new' }, 'Новая схема'),
          rows.map(r => [
            h('div', { class: 'lbl' }, r[0]),
            h('div', { class: 'old' }, h('span', { class: 'sr-only' }, 'Бот: '), r[1]),
            h('div', { class: 'new' }, h('span', { class: 'sr-only' }, 'Новая схема: '), r[2], h('small', null, r[3])),
          ])),
        howto('Цифры бота — оценка по bot.py: до 20 циклов tool use (MAX_TOOL_LOOPS), каждый пересылает всю историю, кэша нет, Sonnet 4.6 по $3 / $15 за 1M. Точно замерим на 10 реальных анализах до переезда.'),
      ],
    });
  }

  function runsCard(mobile, redraw) {
    const filtered = RUNS.filter(r => runFilter === 'all' || r.type === runFilter);
    const LIMIT = mobile ? 6 : 8;
    const shown = showAllRuns ? filtered : filtered.slice(0, LIMIT);
    const filter = UI.segmented({
      label: 'Тип задачи',
      items: [{ id: 'all', label: 'Все' }].concat(TYPES.map(t => ({ id: t.id, label: t.short }))),
      active: runFilter,
      onChange: id => { runFilter = id; showAllRuns = false; redraw('costs-runs'); },
    });
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
      subtitle: 'Каждый вызов Claude API: токены, кэш, поиски и цена. Нажмите на запуск — откроется разбор стоимости.',
      actions: mobile ? null : [filter],
      flush: !mobile,
      body: mobile ? [h('div', { style: 'min-width:0' }, filter), list] : list,
      foot: [
        h('span', { class: 'small soft' }, (runFilter === 'all' ? 'Всего' : typeOf(runFilter).label) + ': ' + filtered.length + ' ' + fmt.plural(filtered.length, 'запуск', 'запуска', 'запусков') + ' · ' + usd(fCost, 2) + (shown.length < filtered.length ? ' · показаны последние ' + shown.length : '')),
        filtered.length > LIMIT ? button(showAllRuns ? 'Свернуть' : 'Показать все ' + filtered.length, { kind: 'ghost', size: 'sm', icon: showAllRuns ? 'chevronDown' : 'list', attrs: { style: 'margin-left:auto' }, onClick: () => { showAllRuns = !showAllRuns; redraw('costs-runs'); } }) : null,
      ],
    });
  }

  function settingsCard(redraw) {
    const hints = {};
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
      UI.clear(forecastChip).appendChild(lim && next > lim ? chip('Выше лимита ' + usd(lim, 0), 'bad', 'alert') : chip(pct(lim ? next / lim : 0) + ' лимита', budgetKind(lim ? next / lim : 0), 'check'));
      UI.clear(warnSlot);
      const perAn = perRun('analysis', draft);
      if (draft.limitRun > 0 && perAn > draft.limitRun) warnSlot.appendChild(UI.callout('warn', 'alert', 'Средний анализ (≈ ' + usd(perAn) + ') дороже лимита на анализ (' + usd(+draft.limitRun) + '): запуски будут останавливаться на сборе данных.'));
      if (!draft.dossier) warnSlot.appendChild(UI.callout('warn', 'alert', 'Без досье ИИ снова читает файлы в 15–20 итераций, как бот сейчас: анализ дороже в ≈ ' + Math.round(perAn / BASE.analysis.avgCost) + ' раз.'));
      if (!draft.eval) warnSlot.appendChild(UI.callout('bad', 'shield', 'Проверка на eval-наборе выключена: смена модели применится сразу, и просадку качества вы увидите только по проигранным ставкам.'));
      const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
      dirtyEl.textContent = dirty ? 'Есть несохранённые изменения' : 'Изменений нет';
      dirtyEl.classList.toggle('on', dirty);
      resetBtn.disabled = !dirty;
    }

    const modelFields = ['parse', 'analysis', 'postmortem', 'refresh'].map(id => {
      const t = typeOf(id);
      const label = id === 'refresh' ? 'Обновление профилей (ночью, через Batch)' : id === 'postmortem' ? 'Разбор ставок' : id === 'analysis' ? 'Анализ матчей' : 'Разбор текста событий';
      const f = UI.field({
        id: 'costs-model-' + id, label,
        options: t.options.map(m => ({ value: m, label: m + ' — ' + usd(PRICE[m].in, 0) + ' / ' + usd(PRICE[m].out, 0) + ' за 1M' + (m === DEFAULTS.models[id] ? ' (сейчас)' : '') })),
        value: draft.models[id], hint: ' ',
        attrs: { on: { change: e => { draft.models[id] = e.target.value; refresh(); } } },
      });
      hints[id] = f.querySelector('.field-hint');
      return f;
    });
    const num = (id, key, label, suffix, hint, dec) => UI.field({
      id, label, value: dec ? nf(dec).format(draft[key]) : String(draft[key]), suffix, hint, inputmode: dec ? 'decimal' : 'numeric', autocomplete: 'off',
      attrs: { on: { input: e => { const v = e.target.value.replace(/\s/g, '').replace(',', '.'); draft[key] = v === '' ? 0 : (isNaN(+v) ? NaN : +v); refresh(); } } },
    });
    const tog = (key, label, hint) => UI.toggle({ id: 'costs-t-' + key, label, hint, checked: draft[key], onChange: v => { draft[key] = v; refresh(); } });

    const form = h('form', { class: 'card costs-card', id: 'costs-settings', novalidate: true, 'aria-labelledby': 'costs-settings-title', on: { submit: e => { e.preventDefault(); save(); } } },
      h('div', { class: 'card-head' }, h('div', { style: 'min-width:0' }, h('h3', { id: 'costs-settings-title' }, 'Настройки экономии'), h('div', { class: 'card-sub' }, 'Модели, лимиты и приёмы, которые снижают расход. Применяются со следующего запуска.'))),
      h('div', { class: 'card-body' },
        h('div', { class: 'costs-settings-grid' },
          h('div', { class: 'costs-settings-col' },
            h('div', { class: 'eyebrow' }, 'Модель для каждой задачи'),
            modelFields,
            h('div', { class: 'eyebrow', style: 'margin-top:6px' }, 'Лимиты'),
            h('div', { class: 'costs-limits' },
              num('costs-limit-month', 'limitMonth', 'На месяц', '$', 'потрачено ' + usd(A.spent), 0),
              num('costs-limit-run', 'limitRun', 'На анализ', '$', 'макс. было ' + usd(Math.max(...A.runs.filter(r => r.type === 'analysis').map(r => r.cost))), 2),
              num('costs-limit-search', 'searchLimit', 'Поисков', 'шт', 'на анализ; 0 — без лимита', 0))),
          h('div', { class: 'costs-settings-col' },
            h('div', { class: 'eyebrow' }, 'Приёмы экономии'),
            h('div', { class: 'costs-toggles' },
              tog('cache', 'Кэширование промпта', 'Инструкции, стратегия, уроки и досье читаются из кэша — в 10–20 раз дешевле обычного входа.'),
              tog('batch', 'Ночные обновления через Batch API (−50%)', 'Профили игроков обновляются пакетом ночью: ответ до 24 ч, цена вдвое ниже.'),
              tog('newsCache', 'Кэш новостей 12 ч', 'Новости по игроку не ищутся повторно, если им меньше 12 часов.'),
              tog('dossier', 'Сжатое досье вместо чтения файлов', 'Одно досье на 2–3 тыс. токенов на игрока вместо 15–20 обращений к файлам.'),
              tog('eval', 'Проверять качество на eval-наборе перед сменой модели', 'Новая модель принимается, только если Brier и лог-лосс на 220 рассчитанных событиях не хуже.')),
            h('div', { class: 'costs-forecast' },
              h('div', { style: 'min-width:0' }, h('div', { class: 'small soft' }, 'Прогноз на октябрь с этими настройками'), forecastNum),
              forecastChip),
            warnSlot))),
      h('div', { class: 'card-foot costs-settings-foot' }, saveBtn, resetBtn, dirtyEl));

    function validate() {
      if (!(draft.limitMonth >= 1)) return 'Лимит на месяц — не меньше $1';
      if (!(draft.limitRun > 0)) return 'Лимит на анализ должен быть больше нуля';
      if (draft.searchLimit < 0 || draft.searchLimit > 10 || Math.round(draft.searchLimit) !== draft.searchLimit) return 'Поисков на анализ — целое число от 0 до 10';
      return null;
    }
    function commit(msg) {
      saved = clone(draft);
      A.budget = saved.limitMonth; // главная берёт лимит отсюда
      redraw();
      UI.toast(msg || 'Настройки экономии сохранены');
    }
    function save() {
      const err = validate();
      if (err) { UI.toast(err, 'alert'); return; }
      if (JSON.stringify(draft) === JSON.stringify(saved)) { UI.toast('Изменений нет — всё уже сохранено', 'info'); return; }
      const changes = TYPES.filter(t => draft.models[t.id] !== saved.models[t.id]).map(t => ({ type: t.id, from: saved.models[t.id], to: draft.models[t.id] }));
      if (changes.length && draft.eval) {
        evalModal(changes, res => {
          if (!res) return;
          const rejected = res.filter(r => !r.ok);
          rejected.forEach(r => { draft.models[r.type] = r.from; if (r.type === 'analysis' && r.to === 'Sonnet 5.5') candidateState = 'rejected'; });
          commit(rejected.length ? 'Сохранено. Не принято по качеству: ' + rejected.map(r => r.to + ' для «' + typeOf(r.type).label.toLowerCase() + '»').join(', ') : 'Модели сменены, качество на eval-наборе не хуже');
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
        UI.append(root, [
          headBlock(),
          h('div', { class: 'grid' },
            h('div', { class: 'col-5', style: 'min-width:0' }, heroCard()),
            h('div', { class: 'col-7 grid costs-tiles' }, tiles())),
          h('div', { class: 'costs-main' },
            h('div', { class: 'costs-col' }, dailyCard(mobile), leversCard(redraw)),
            h('div', { class: 'costs-col' }, typesCard(pickType), compareCard())),
          h('div', { class: 'grid' }, runsCard(mobile, redraw)),
          settingsCard(redraw),
        ]);
      }
      build();
    },
  });
})();
