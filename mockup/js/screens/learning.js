/* Обучение модели: честно о том, как система учится на ставках.
   Цикл «ставка → результат → разбор → урок → проверка → в анализ», уроки, версии стратегии,
   своя ML-модель (Эло + бустинг), датасет и лаборатория дообучения открытой LLM.
   Общие цифры — из window.DATA; локальные демо-данные экрана (признаки, walk-forward, эксперименты) описаны ниже. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, S = DATA.stats, TODAY = DATA.today;

  // ---------- константы и утилиты ----------
  const NEED = 20;                       // числовой урок: проверка начинается с 20 своих случаев
  const NEED_PROC = 10;                  // процессный урок: «не хуже» хотя бы на 10 случаях
  const SHRINK_K = 200;                  // усадка эффекта урока к нулю: effect × n / (n + k)
  const HOLDOUT = (D.strategyVersions[0] || { n: 220 }).n;
  const MARKET_LL = 0.588;               // лог-лосс закрывающей линии на тех же событиях (демо)
  // 95% ДИ разницы «версия − рынок» по лог-лоссу на отложенных событиях (демо)
  const MARKET_CI = { v1: [0.008, 0.040], v2: [-0.008, 0.024], v3: [-0.021, 0.011], v4: [-0.023, 0.009] };
  const MINUS = '−';
  const sgn = (n, s) => (n > 0 ? '+' : n < 0 ? MINUS : '±') + s;
  const signedDec = (n, d = 3) => sgn(Math.round(n * 1e6) / 1e6, fmt.dec(Math.abs(n), d));
  const pp = n => sgn(Math.round(n * 100) / 100, fmt.dec(Math.abs(n), 1)) + ' п.п.';
  const cases = n => fmt.int(n) + ' ' + fmt.plural(n, 'случай', 'случая', 'случаев');
  const hhmm = iso => iso.slice(11, 16);

  // ---------- локальные демо-данные ----------
  const legOf = (date, p2) => D.allLegs.find(l => l.date === date && l.market === 'h1m' && (!p2 || l.p2 === p2));
  const legLine = l => 'ставка №' + l.betId + ' от ' + fmt.date(l.date) + ': ' + D.match(l) + ', ' + l.marketLabel + ' по кэфу ' + fmt.odds(l.odds) + ' — не сыграла';
  const leg0912 = legOf('2026-09-12', 'shelton');
  const leg0927 = legOf('2026-09-27', 'draper');

  // kind: numeric — меняет вероятность (≥ 20 своих + история с ДИ, усадка), process — меняет сбор данных (не хуже на ≥ 10)
  const LESSON_INFO = {
    'L-014': {
      kind: 'numeric', hist: 296, histHow: 'по доле эйсов',
      ci: '95% ДИ +0,005…+0,031',
      bias: 'вероятность победы 2:0 завышалась на 8 п.п. (95% ДИ 3…13)', raw: 8,
      source: leg0912 ? 'Разбор: ' + legLine(leg0912) : 'Разбор проигранной ставки от 12 сен',
      check: [['Лог-лосс с уроком', '0,571'], ['Лог-лосс без урока', '0,589']],
      line: 'Фора −1.5 на фаворита против левши с подачей от 210 км/ч: снижай вероятность победы 2:0 на 4–6 п.п. — тай-брейки срезают «сухую» победу.',
      note: 'Скорости подачи в исторических архивах нет. На истории условие проверено через замену: у соперника-левши ≥ 10% эйсов и ≥ 75% очков на первой подаче. Точное условие «от 210 км/ч» проверено только на своих случаях.',
    },
    'L-017': {
      kind: 'numeric', hist: 412,
      ci: '95% ДИ +0,002…+0,010',
      bias: 'вероятность фаворита завышалась на 6 п.п. (95% ДИ 2…10)', raw: 6,
      source: 'Разборы проигранных ставок US Open: фаворит накануне провёл пятисетовый матч',
      check: [['Brier с уроком', '0,196'], ['Brier без урока', '0,202']],
      line: 'Если фаворит за последние 48 часов сыграл пять сетов, снижай его вероятность на 4 п.п. — поправка уже с усадкой, больше не добавляй.',
      note: 'Исторические случаи — пятисетовые матчи Шлемов с 2000 г., даты матчей из tennis-data.co.uk.',
    },
    'L-019': {
      kind: 'process', hist: null,
      source: 'Разборы трёх ставок 24–28 сен: «травма» из соцсетей не подтвердилась',
      check: [['Качество прогноза', 'не хуже: Brier +0,001 на 11 случаях'], ['Экономия', '2 веб-поиска на матч, ≈ $0,02']],
      line: 'Не ищи и не учитывай новости о травмах из соцсетей без подтверждения турнира или ATP.',
      note: 'Урок про сбор данных: вероятности он не меняет, а убирает лишние поиски. Такие уроки принимаются, если прогноз не хуже хотя бы на ' + NEED_PROC + ' случаях и есть выигрыш.',
    },
    'L-021': {
      kind: 'numeric', hist: 0,
      source: 'Разбор ставки от 3 окт: аутсайдер взял сет в ночной сессии в Шанхае',
      check: [['Проверка на истории', 'ещё не запускалась']],
      line: 'Ф(+1.5) на аутсайдера в ночных сессиях Азии: повышай вероятность взятого сета на 3–5 п.п.',
      note: 'В исторических архивах нет времени начала матча, поэтому случаи копятся только из своих ставок. Пока их не наберутся сотни, урок остаётся гипотезой.',
    },
    'L-012': {
      kind: 'numeric', hist: 1240,
      ci: '95% ДИ +0,002…+0,012',
      source: 'Разбор ставки от 30 авг',
      check: [['Лог-лосс с уроком', '0,604'], ['Лог-лосс без урока', '0,597']],
      line: 'Перевес в личных встречах на другом покрытии переносится на хард.',
      note: 'С уроком прогноз хуже: на истории это видно сразу, поэтому урок отклонён, не дожидаясь ' + NEED + ' своих случаев, и в анализ не попадает. Похожие формулировки Claude больше не предлагает.',
    },
  };
  const lessonN = (l, info) => l.evidence + (info.hist || 0);
  const shrunk = (l, info) => Math.round(info.raw * lessonN(l, info) / (lessonN(l, info) + SHRINK_K));

  const VERSION_INFO = {
    v1: { tokens: 52, changes: ['Инструкции перенесены из Telegram-бота (папка Tennis-Analytics) без изменений', 'Порог вероятности 65%, кэфы 1.13–1.80, до 3 событий в экспрессе'] },
    v2: { tokens: 54, changes: ['В досье игрока добавлен Эло по покрытиям', 'Вероятность своей ML-модели передаётся Claude как второе мнение'] },
    v3: { tokens: 49, changes: ['В инструкции добавлены уроки L-014 и L-017 — поправки с усадкой к нулю', 'В свою ML-модель добавлены признаки из тех же уроков: «левша против правши» и «сеты за 7 дней»'] },
    v4: { tokens: 34, goal: 'save', changes: ['Инструкции на английском, ответ — по-русски', 'Сжатое досье: 18 ключевых цифр на игрока вместо полного профиля', 'Уроки и правила те же, что в v3'] },
  };
  // Проверка кандидата v4 против v3 по правилу экономии (TOKEN_ECONOMY §2.4)
  const ECE = { v3: 2.9, v4: 3.1 };
  const FORMAT_ERR = { v3: 1, v4: 0 };
  const tokSave = () => Math.round((1 - VERSION_INFO.v4.tokens / VERSION_INFO.v3.tokens) * 100);
  const SAVE_CHECKS = () => [
    'Лог-лосс: до +0,005 ≤ +0,01',
    'Brier: до +0,002 ≤ +0,005',
    'ECE: до +1,1 п.п. ≤ +2',
    'Ошибок формата: ' + FORMAT_ERR.v4 + ' (было ' + FORMAT_ERR.v3 + ')',
    'Токенов −' + tokSave() + '% по логам',
  ];

  // Своя ML-модель: вклад признаков (gain, %) и проверка walk-forward по месяцам
  const FEATURES = [
    { label: 'Разница Эло на покрытии', value: 23 },
    { label: 'Общий Эло', value: 14 },
    { label: 'Очки на своей подаче, 52 нед.', value: 12 },
    { label: 'Очки на приёме второй подачи', value: 9 },
    { label: 'Усталость: сеты за 7 дней', value: 8, note: 'L-017' },
    { label: 'Форма: 10 последних матчей', value: 7 },
    { label: 'Левша против правши', value: 5, note: 'L-014' },
    { label: 'Личные встречи на покрытии', value: 4 },
  ];
  const FEATURES_REST = 100 - FEATURES.reduce((a, f) => a + f.value, 0);
  // Матчи основного тура ATP (≈ 2,5–3 тыс. в год, в месяц ≈ 180–260)
  const WF = [
    { m: 'апр', full: 'Апрель 2026', n: 214, model: 0.204, market: 0.193 },
    { m: 'май', full: 'Май 2026', n: 248, model: 0.199, market: 0.192 },
    { m: 'июн', full: 'Июнь 2026', n: 236, model: 0.201, market: 0.195 },
    { m: 'июл', full: 'Июль 2026', n: 252, model: 0.197, market: 0.193 },
    { m: 'авг', full: 'Август 2026', n: 241, model: 0.196, market: 0.194 },
    { m: 'сен', full: 'Сентябрь 2026', n: 187, model: 0.194, market: 0.192 },
  ];
  const wfSum = from => WF.slice(WF.findIndex(x => x.m === from)).reduce((a, r) => a + r.n, 0);

  // Датасет: исторический архив (основной тур ATP 2019 – 6 окт 2026, кэфы tennis-data.co.uk, статистика Сакманна) + свои события
  const HIST_TRAIN = 16896;              // 2019 – 2025
  const HIST_VAL = 1172;                 // янв – май 2026 (в т.ч. апрель и май из walk-forward)
  const HIST_OCT = 74;                   // 1–6 окт 2026
  const HIST_TEST = wfSum('июн') + HIST_OCT;
  const HIST = HIST_TRAIN + HIST_VAL + HIST_TEST;
  const OWN = Math.max(144, S.legs);     // своих событий (из ставок + разобранные без ставки)
  const OWN_NO_BET = OWN - S.legs;
  const SNAPSHOTS = HIST + OWN;
  // Тест для LLM — только после среза знаний Opus 5.5 (июнь 2026) плюс месяц запаса
  const LLM_FROM = '2026-08-01';
  const LLM_TEST = wfSum('авг') + HIST_OCT + D.allLegs.filter(l => l.date >= LLM_FROM).length + OWN_NO_BET;

  // Деление по времени
  const SPLIT = [
    { label: 'Обучение', period: '2019 – 31 дек 2025', n: HIST_TRAIN, color: 'var(--s1)' },
    { label: 'Валидация', period: 'янв – май 2026', n: HIST_VAL, color: 'var(--s2)' },
    { label: 'Тест', period: 'с 1 июн 2026', n: HIST_TEST + OWN, color: 'var(--s3)', note: 'в т.ч. ' + OWN + ' своих' },
  ];

  // Prompt-оптимизация: каждый вариант — smoke на 40 событиях (Δ лог-лосса к v3), лучший — полный прогон на отложенной выборке
  const SMOKE = 40, SMOKE_COST = 1.2, FULL_COST = 6.6, EXP_BUDGET = 25;
  const POPT = [
    { i: 1, change: 'Исходные инструкции v3 (точка отсчёта)', smoke: 0, full: 0.583, tok: 49, base: true },
    { i: 2, change: 'Сначала цифры, потом новости', smoke: 0.004, tok: 49 },
    { i: 3, change: 'Инструкции на английском', smoke: -0.003, tok: 41 },
    { i: 4, change: 'Сжатое досье: 18 цифр на игрока', smoke: -0.006, full: 0.581, tok: 34, best: true },
    { i: 5, change: 'Сначала шанс без кэфа рынка, потом сравнение', smoke: 0.007, tok: 35 },
    { i: 6, change: 'Три примера калибровки в инструкции', smoke: 0.002, tok: 38 },
    { i: 7, change: 'Короче блок про уроки', smoke: null, tok: 33 },
  ];
  // Потрачено в этом месяце: smoke всех посчитанных вариантов + полный прогон лучшего + половина идущей итерации
  const POPT_SPENT = POPT.filter(p => p.smoke != null).length * SMOKE_COST + FULL_COST + SMOKE_COST / 2;

  // ---------- состояние экрана ----------
  const TABS = [
    { id: 'lessons', label: 'Уроки', short: 'Уроки' },
    { id: 'versions', label: 'Версии стратегии', short: 'Версии' },
    { id: 'ml', label: 'Своя ML-модель', short: 'ML-модель' },
    { id: 'lab', label: 'Датасет и LLM · лаборатория', short: 'Лаборатория' },
  ];
  const st = {
    tab: 'lessons',
    filter: 'all',
    anon: true,
    notify: {},                 // id гипотезы → уведомить при 20 случаях
    ml: { at: '2026-10-05T04:00', brier: 0.194, prev: null, training: false, progress: 0 },
    popt: 'running',            // running | paused
  };
  try { const t = sessionStorage.getItem('capper.learning.tab'); if (t && TABS.some(x => x.id === t)) st.tab = t; } catch (e) { /* ок */ }

  let tabsSlot = null, panel = null, tilesSlot = null, mlHeadSlot = null;

  // ---------- стили ----------
  UI.css('learning', `
    .learning-head h2 { font-size: var(--fs-2xl); }

    .learning-tiles { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
    @media (max-width: 1180px) { .learning-tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    @media (max-width: 720px) { .learning-tiles { gap: 12px; } }
    .learning-tile {
      display: flex; flex-direction: column; gap: 4px; min-width: 0; text-align: left; cursor: pointer;
      padding: 16px 18px; background: var(--surface); color: var(--fg); border: 1px solid var(--line); border-radius: var(--r-lg);
      transition: border-color .15s, background .15s;
    }
    .learning-tile:hover { border-color: var(--line-strong); background: color-mix(in srgb, var(--surface) 70%, var(--surface-2)); }
    .learning-tile.is-active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .learning-tile-label { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--fg-2); min-width: 0; }
    .learning-tile-label svg { width: 16px; height: 16px; flex: none; }
    .learning-tile-label .learning-tile-go { margin-left: auto; color: var(--fg-3); }
    .learning-tile-value { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.15; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .learning-tile-value small { font-family: var(--font-body); font-size: var(--fs-sm); font-weight: 500; color: var(--fg-2); letter-spacing: 0; margin-left: 4px; }
    .learning-tile-hint { font-size: var(--fs-xs); color: var(--fg-3); }
    @media (max-width: 720px) { .learning-tile { padding: 14px; } .learning-tile-value { font-size: var(--fs-xl); } }

    /* цикл обучения */
    .learning-cycle { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 28px; }
    .learning-step { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .learning-step-mark { display: flex; align-items: center; gap: 8px; color: var(--fg-3); }
    .learning-step-num { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; flex: none; background: var(--accent-soft); color: var(--accent-ink); font-family: var(--font-display); font-weight: 700; font-size: var(--fs-sm); }
    .learning-step-mark > svg { width: 18px; height: 18px; flex: none; }
    .learning-step-body { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .learning-step h4 { font-size: var(--fs-sm); line-height: 1.3; }
    .learning-step p { font-size: var(--fs-xs); color: var(--fg-2); line-height: 1.45; }
    .learning-step .chip { align-self: flex-start; margin-top: 4px; }
    .learning-step-arrow { position: absolute; top: 4px; right: -25px; width: 20px; height: 20px; color: var(--fg-3); }
    .learning-step-arrow svg { width: 20px; height: 20px; }
    .learning-loop { position: relative; height: 24px; margin: 4px calc((100% - 140px) / 6 - 15px) 14px 13px; border: 2px dashed var(--line-strong); border-top: 0; border-radius: 0 0 14px 14px; }
    .learning-loop::before { content: ""; position: absolute; left: -8px; top: -9px; border: 7px solid transparent; border-top: 0; border-bottom: 9px solid var(--line-strong); }
    .learning-loop-label { position: absolute; left: 50%; bottom: 0; transform: translate(-50%, 50%); background: var(--surface); padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-2); white-space: nowrap; }
    .learning-loop-label svg { width: 14px; height: 14px; flex: none; }
    @media (max-width: 1180px) {
      .learning-cycle { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 20px 24px; }
      .learning-step-arrow { display: none; }
      .learning-loop { height: auto; margin: 0; border: 0; border-radius: 0; }
      .learning-loop::before { display: none; }
      .learning-loop-label { position: static; transform: none; padding: 0; white-space: normal; font-size: var(--fs-sm); }
      .learning-loop-label svg { width: 18px; height: 18px; }
    }
    @media (max-width: 720px) {
      .learning-cycle { grid-template-columns: minmax(0, 1fr); gap: 0; }
      .learning-step { display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 12px; padding-bottom: 14px; }
      .learning-step-mark > svg { display: none; }
      .learning-step-mark { align-self: stretch; flex-direction: column; }
      .learning-step:not(:last-child) .learning-step-mark::after { content: ""; flex: 1; width: 2px; background: var(--line); margin-top: 4px; }
      .learning-step .chip { margin-top: 2px; }
      .learning-loop-label { display: grid; grid-template-columns: 28px minmax(0, 1fr); column-gap: 12px; align-items: center; }
      .learning-loop-label svg { justify-self: center; }
    }
    .learning-doc { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-doc svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }

    /* вкладки */
    .learning-sections { display: flex; flex-direction: column; gap: 16px; scroll-margin-top: 76px; min-width: 0; }
    @media (max-width: 960px) {
      .tabs.learning-tabs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 0; overflow: visible; }
      .tabs.learning-tabs button { min-width: 0; padding: 10px 4px; font-size: var(--fs-sm); text-align: center; overflow: hidden; text-overflow: ellipsis; }
      .learning-card .card-body > .segmented.learning-filter { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); width: 100%; align-self: stretch; overflow: visible; }
      .segmented.learning-filter button { min-width: 0; text-align: center; overflow: hidden; text-overflow: ellipsis; }
    }
    .learning-panel { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
    .learning-two { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
    .learning-two.wide-left { grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); }
    @media (max-width: 1180px) { .learning-two, .learning-two.wide-left { grid-template-columns: minmax(0, 1fr); } }
    .learning-card > .card-head > div:first-child { flex: 1 1 320px; }
    .learning-card > .card-head > .row { flex-wrap: wrap; }
    .learning-card .card-body > .segmented, .learning-card .card-body > .btn { align-self: flex-start; }
    .learning-modal:focus, .learning-modal:focus-visible { outline: none; }
    .learning-hint { display: flex; align-items: flex-start; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-hint svg { width: 14px; height: 14px; flex: none; margin-top: 2px; }

    /* уроки */
    .learning-lessons { display: flex; flex-direction: column; gap: 10px; }
    .learning-lesson { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 12px 24px; padding: 14px 16px; border: 1px solid var(--line); border-left-width: 3px; border-radius: var(--r-md); background: var(--surface); min-width: 0; }
    .learning-lesson.is-confirmed { border-left-color: var(--good); }
    .learning-lesson.is-hypothesis { border-left-color: var(--info-ink); }
    .learning-lesson.is-rejected { border-left-color: var(--line-strong); }
    .learning-lesson.is-rejected .learning-lesson-text, .learning-lesson.is-off .learning-lesson-text { color: var(--fg-2); }
    .learning-lesson-main { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
    .learning-lesson-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
    .learning-lesson-head .learning-date { margin-left: auto; font-size: var(--fs-xs); color: var(--fg-3); white-space: nowrap; }
    .learning-lesson-text { font-size: var(--fs-md); line-height: 1.5; }
    .learning-meta { display: flex; flex-wrap: wrap; gap: 4px 18px; margin: 0; font-size: var(--fs-sm); }
    .learning-meta > div { display: flex; gap: 6px; min-width: 0; }
    .learning-meta dt { color: var(--fg-3); white-space: nowrap; }
    .learning-meta dd { margin: 0; font-weight: 500; min-width: 0; }
    .learning-lesson-side { display: flex; flex-direction: column; justify-content: center; gap: 10px; min-width: 0; padding-left: 20px; border-left: 1px solid var(--line); }
    .learning-lesson-side .btn { align-self: flex-start; }
    .learning-lesson-side .btn.ghost { margin-left: -12px; }
    .learning-progress { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }
    @media (max-width: 960px) {
      .learning-lesson { grid-template-columns: minmax(0, 1fr); padding: 12px 14px; }
      .learning-lesson-side { padding: 12px 0 0; border-left: 0; border-top: 1px solid var(--line); }
    }

    .learning-facts { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr); gap: 8px 16px; margin: 0; font-size: var(--fs-sm); }
    .learning-facts dt { color: var(--fg-3); }
    .learning-facts dd { margin: 0; font-weight: 500; min-width: 0; }
    @media (max-width: 720px) { .learning-facts { grid-template-columns: minmax(0, 1fr); gap: 2px; } .learning-facts dd { margin-bottom: 8px; } }
    .learning-quote { margin: 0; padding: 12px 14px; border-left: 3px solid var(--accent); background: var(--surface-2); border-radius: var(--r-sm); font-size: var(--fs-md); line-height: 1.5; }
    .learning-code { margin: 0; padding: 12px 14px; font-family: var(--font-mono); font-size: var(--fs-xs); line-height: 1.65; color: var(--fg-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-md); white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
    .learning-hl { border-radius: 3px; padding: 0 2px; background: var(--accent-soft); color: var(--accent-ink); }
    .learning-hl.exposed { background: var(--warn-soft); color: var(--warn-ink); }
    .learning-form-2 { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
    @media (max-width: 720px) { .learning-form-2 { grid-template-columns: minmax(0, 1fr); } }
    .learning-invalid { border-color: var(--bad) !important; }

    /* версии */
    .learning-ver-name { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
    .learning-ver-name b { font-family: var(--font-mono); font-weight: 600; }
    .learning-best { font-weight: 700; }
    .learning-vcards { display: flex; flex-direction: column; gap: 10px; }
    .learning-vcard { display: flex; flex-direction: column; gap: 10px; width: 100%; padding: 12px 14px; border: 1px solid var(--line); border-radius: var(--r-md); background: var(--surface); color: var(--fg); text-align: left; cursor: pointer; font: inherit; }
    .learning-vcard:hover { background: var(--surface-2); }
    .learning-vcard-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; min-width: 0; }
    .learning-vcard-head > div { min-width: 0; }
    .learning-vgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; margin: 0; }
    .learning-vgrid > div { min-width: 0; }
    .learning-vgrid dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-vgrid dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; font-size: var(--fs-sm); }
    .learning-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 14px; }
    .learning-rules li { display: grid; grid-template-columns: 24px minmax(0, 1fr); gap: 10px; align-items: start; font-size: var(--fs-sm); }
    .learning-rules li > span:first-child { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; background: var(--surface-2); color: var(--fg-2); font-weight: 700; font-size: var(--fs-xs); }
    .learning-rules li > div { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
    .learning-rules .chip { align-self: flex-start; }
    .learning-rules b { font-weight: 600; }
    .learning-chips { display: flex; flex-wrap: wrap; gap: 6px; min-width: 0; }
    .learning-cmp-list { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); }
    .learning-cmp-item { display: flex; flex-direction: column; gap: 4px; padding: 10px 12px; min-width: 0; }
    .learning-cmp-item + .learning-cmp-item { border-top: 1px solid var(--line); }
    .learning-cmp-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 8px; }
    .learning-cmp-top b { font-weight: 600; }
    .learning-changes { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-sm); color: var(--fg-2); }

    /* ML-модель */
    .learning-strip { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .learning-strip > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .learning-strip dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-strip dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .learning-strip dd small { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--fg-3); }
    @media (max-width: 720px) { .learning-strip { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .learning-feat .hbar { grid-template-columns: minmax(0, 14rem) minmax(0, 1fr) 4.5rem; }
    .learning-feat .hbar-label { white-space: normal; }
    .learning-feat .hbar-label .chip { height: 20px; padding: 0 7px; flex: none; }
    @media (max-width: 720px) {
      .learning-feat .hbar { grid-template-columns: minmax(0, 1fr) 4.5rem; row-gap: 4px; padding: 6px 0; }
      .learning-feat .hbar-label { grid-column: 1 / -1; }
    }
    .learning-train { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }

    /* лаборатория */
    .learning-ds-total { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
    .learning-ds-total b { font-family: var(--font-display); font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -.02em; line-height: 1.1; }
    .learning-ds-parts { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
    .learning-ds-parts > div { padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; font-size: var(--fs-sm); color: var(--fg-2); }
    .learning-ds-parts b { display: block; color: var(--fg); font-size: var(--fs-lg); font-variant-numeric: tabular-nums; }
    @media (max-width: 720px) { .learning-ds-parts { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
    .learning-split { display: flex; gap: 2px; height: 14px; border-radius: 999px; overflow: hidden; }
    .learning-split > i { display: block; height: 100%; }
    .learning-split-legend { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0; }
    .learning-split-legend > div { min-width: 0; font-size: var(--fs-sm); }
    .learning-split-legend dt { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .learning-split-legend dt i { width: 10px; height: 10px; border-radius: 2px; flex: none; }
    .learning-split-legend dd { margin: 2px 0 0 16px; color: var(--fg-2); }
    @media (max-width: 720px) { .learning-split-legend { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
    .learning-exps { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px; }
    @media (max-width: 1180px) { .learning-exps { grid-template-columns: minmax(0, 1fr); } }
    .learning-exp .card-body { flex: 1; }
    .learning-exp h3 { font-size: var(--fs-md); margin-top: 8px; }
    .learning-exp-dl { display: flex; flex-direction: column; gap: 8px; margin: 0; font-size: var(--fs-sm); }
    .learning-exp-dl dt { font-size: var(--fs-xs); color: var(--fg-3); font-weight: 600; }
    .learning-exp-dl dd { margin: 2px 0 0; }
    .learning-note { font-size: var(--fs-xs); color: var(--fg-2); padding: 8px 10px; border-radius: var(--r-sm); background: var(--surface-2); display: flex; gap: 6px; align-items: flex-start; }
    .learning-note svg { width: 14px; height: 14px; flex: none; margin-top: 1px; }
    .learning-note.warn { background: var(--warn-soft); color: var(--warn-ink); }
    .learning-reward { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 4px 12px; font-size: var(--fs-xs); margin: 0; padding: 8px 10px; border-radius: var(--r-sm); background: var(--surface-2); }
    .learning-reward dt { color: var(--fg-2); }
    .learning-reward dd { margin: 0; font-family: var(--font-mono); text-align: right; white-space: nowrap; }
  `);

  // ---------- общие кусочки ----------
  const LESSON_STATUS = { confirmed: ['Подтверждён', 'good', 'check'], hypothesis: ['Гипотеза', 'info', 'flask'], rejected: ['Отклонён', 'bad', 'x'] };
  const lessonChip = l => { const [t, k, i] = LESSON_STATUS[l.status] || [l.status, 'outline', 'info']; return chip(t, k, i); };
  const VERSION_STATUS = { active: ['Активная', 'good', 'check'], candidate: ['Кандидат', 'info', 'flask'], archived: ['Архив', 'outline', 'history'] };
  const versionChip = v => { const [t, k, i] = VERSION_STATUS[v.status] || [v.status, 'outline', 'info']; return chip(t, k, i); };
  const verShort = v => v.name.split(' · ').slice(1).join(' · ') || v.name;
  const facts = pairs => h('dl', { class: 'learning-facts' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const hint = (text) => h('p', { class: 'learning-hint' }, icon('info'), h('span', null, text));
  const signedPctEl = v => h('span', { class: v > 0 ? 'good-text' : v < 0 ? 'bad-text' : null }, fmt.signedPct(v));

  // Информационные окна: фокус на самом окне, а не на первой кнопке внизу (на телефоне иначе окно прокручивается вниз)
  function settleModal() {
    setTimeout(() => {
      const all = document.querySelectorAll('.modal');
      const m = all[all.length - 1];
      if (!m) return;
      m.setAttribute('tabindex', '-1');
      m.classList.add('learning-modal');
      m.focus({ preventScroll: true });
      m.scrollTop = 0;
    }, 60);
  }

  const basis = (l, info) => (l.status === 'hypothesis'
    ? l.evidence + ' из ' + NEED + ' своих'
    : cases(l.evidence) + (info.hist ? ' + ' + fmt.int(info.hist) + ' из истории' + (info.histHow ? ', ' + info.histHow : '') : ''));
  const lessons = () => D.lessons;
  const countLessons = s => lessons().filter(l => l.status === s).length;
  const inAnalysis = () => lessons().filter(l => l.status === 'confirmed' && l.inPrompt).length;
  const versions = () => D.strategyVersions;
  const vById = id => versions().find(v => v.id === id);
  const activeV = () => versions().find(v => v.status === 'active');
  const candV = () => versions().find(v => v.status === 'candidate');
  const runningExps = () => (st.popt === 'running' ? 1 : 0);

  // ---------- верх страницы ----------
  function headBlock() {
    return h('div', { class: 'page-head learning-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Как модель учится на ставках'),
        h('p', { class: 'lead' }, 'Что система вынесла из ' + S.settled + ' рассчитанных ставок (' + S.legs + ' ' + fmt.plural(S.legs, 'событие', 'события', 'событий') + '): уроки, версия стратегии, своя ML-модель и лаборатория дообучения.')),
      button('Предложить урок', { kind: 'secondary', icon: 'plus', onClick: proposeLesson }));
  }

  function tile(o) {
    return h('button', { type: 'button', class: ['learning-tile', st.tab === o.tab && 'is-active'], 'aria-current': st.tab === o.tab ? 'true' : null, 'aria-controls': 'learning-panel', on: { click: () => setTab(o.tab, { rebuildTabs: true, scroll: true }) } },
      h('span', { class: 'learning-tile-label' }, icon(o.icon), h('span', { style: 'min-width:0' }, UI.isMobile() ? o.short : o.label), h('span', { class: 'learning-tile-go' }, icon('chevronRight', { width: 16, height: 16 }))),
      h('span', { class: 'learning-tile-value' }, o.value, h('small', null, o.unit)),
      h('span', { class: 'learning-tile-hint' }, o.hint));
  }
  function drawTiles() {
    if (!tilesSlot) return;
    const act = activeV(), cand = candV();
    const hyp = countLessons('hypothesis'), rej = countLessons('rejected');
    UI.clear(tilesSlot);
    UI.append(tilesSlot, [
      tile({ tab: 'lessons', icon: 'book', label: 'Память уроков', short: 'Уроки', value: String(inAnalysis()), unit: 'в анализе', hint: 'из ' + lessons().length + ' · ' + hyp + ' ' + fmt.plural(hyp, 'гипотеза', 'гипотезы', 'гипотез') + ', ' + rej + ' ' + fmt.plural(rej, 'отклонён', 'отклонены', 'отклонены') }),
      tile({ tab: 'versions', icon: 'layers', label: 'Версия стратегии', short: 'Стратегия', value: act ? act.id : '—', unit: 'активна', hint: cand ? 'кандидат ' + cand.id + ' ждёт решения' : 'кандидатов нет' }),
      tile({ tab: 'ml', icon: 'chart', label: 'Своя ML-модель', short: 'ML-модель', value: fmt.dec(st.ml.brier, 3), unit: 'Brier', hint: st.ml.training ? 'идёт переобучение…' : 'обучена ' + fmt.date(st.ml.at) + ', ' + hhmm(st.ml.at) }),
      tile({ tab: 'lab', icon: 'flask', label: 'Лаборатория LLM', short: 'Лаборатория', value: fmt.int(SNAPSHOTS), unit: 'снимков', hint: runningExps() ? '1 эксперимент идёт · 2 в плане' : 'всё на паузе · 2 в плане' }),
    ]);
  }

  const STEPS = [
    { ic: 'ticket', t: 'Ставка', d: 'Экспресс с вероятностями Claude и своей ML-модели', who: 'вы + ИИ', whoIc: 'user' },
    { ic: 'trophy', t: 'Результат и закрывающий кэф', d: 'Счёт по сетам и кэф перед стартом — из него считается CLV', who: 'вы', whoIc: 'user' },
    { ic: 'search', t: 'Разбор ошибки', d: 'Claude сверяет прогноз с исходом: невезение или систематическая ошибка', who: 'Sonnet 5.5 · ≈ $0,02', whoIc: 'spark' },
    { ic: 'book', t: 'Гипотеза-урок', d: 'Короткое правило и где оно применимо', who: 'Claude', whoIc: 'spark' },
    { ic: 'flask', t: 'Проверка на истории', d: 'С ' + NEED + ' своих случаев: прогноз с уроком и без, 95% ДИ на истории и на поздних матчах', who: 'код + Batch API', whoIc: 'bolt' },
    { ic: 'brain', t: 'В промпт или в признаки', d: 'Текстовый урок — в инструкции, числовой — в ML-модель', who: 'вы подтверждаете', whoIc: 'user' },
  ];
  function cycleCard() {
    const list = h('ol', { class: 'learning-cycle', 'aria-label': 'Цикл обучения, 6 шагов' }, STEPS.map((s, i) => h('li', { class: 'learning-step' },
      h('div', { class: 'learning-step-mark' }, h('span', { class: 'learning-step-num', 'aria-hidden': 'true' }, String(i + 1)), icon(s.ic)),
      h('div', { class: 'learning-step-body' },
        h('h4', null, h('span', { class: 'sr-only' }, 'Шаг ' + (i + 1) + '. '), s.t),
        h('p', null, s.d),
        chip(s.who, 'outline', s.whoIc)),
      i < STEPS.length - 1 && h('span', { class: 'learning-step-arrow', 'aria-hidden': 'true' }, icon('arrowRight')))));
    const loop = h('div', { class: 'learning-loop' }, h('span', { class: 'learning-loop-label' }, icon('refresh'), h('span', null, h('b', null, 'Следующая ставка'), ' — цикл повторяется уже с учётом урока')));
    return card({
      class: 'learning-card',
      title: 'Как модель учится',
      subtitle: 'Один цикл на каждую рассчитанную ставку — и выигранную, и проигранную',
      body: [
        list, loop,
        UI.callout('info', 'info', h('b', null, 'Веса Claude не меняются. '), 'Учатся три вещи: память уроков, версия стратегии (инструкции и правила отбора) и наша собственная ML-модель. Дообучение открытой LLM — отдельная лаборатория, на ставки она не влияет.'),
        h('p', { class: 'learning-doc' }, icon('book'), h('span', null, 'Подробнее в документе ', h('span', { class: 'mono' }, 'LLM_LEARNING.md'), ' — там же учебный трек по обучению LLM на данных проекта.')),
      ],
    });
  }

  // ---------- вкладки ----------
  function makeTabs() {
    const m = UI.isMobile();
    // На телефоне четыре вкладки стоят сеткой без прокрутки — короткие подписи, без счётчика
    const el = UI.tabs({ items: TABS.map(t => ({ id: t.id, label: m ? t.short : t.label + (t.id === 'lessons' ? ' · ' + lessons().length : '') })), active: st.tab, onChange: id => { setTab(id); revealTab(el); } });
    el.classList.add('learning-tabs');
    el.setAttribute('aria-label', 'Разделы обучения');
    revealTab(el);
    return el;
  }
  // На телефоне вкладки прокручиваются: держим выбранную в поле зрения
  function revealTab(el) {
    requestAnimationFrame(() => {
      const b = el.querySelector('[aria-selected="true"]');
      if (b && el.scrollWidth > el.clientWidth) el.scrollLeft = Math.max(0, b.offsetLeft - (el.clientWidth - b.offsetWidth) / 2);
    });
  }
  function setTab(id, o = {}) {
    st.tab = id;
    try { sessionStorage.setItem('capper.learning.tab', id); } catch (e) { /* ок */ }
    try { history.replaceState(null, '', '#learning-' + id); } catch (e) { /* ок */ }
    if (o.rebuildTabs && tabsSlot) UI.clear(tabsSlot).appendChild(makeTabs());
    drawPanel();
    drawTiles();
    if (o.scroll && tabsSlot) tabsSlot.parentElement.scrollIntoView({ block: 'start' });
  }
  function drawPanel() {
    if (!panel) return;
    UI.hideTip();
    UI.clear(panel);
    const t = TABS.find(x => x.id === st.tab) || TABS[0];
    panel.setAttribute('aria-label', t.label);
    const build = { lessons: lessonsPanel, versions: versionsPanel, ml: mlPanel, lab: labPanel }[t.id];
    UI.append(panel, [build()]);
  }

  // ---------- 1. Уроки ----------
  function lessonsPanel() {
    const order = { confirmed: 0, hypothesis: 1, rejected: 2 };
    const list = h('div', { class: 'learning-lessons', 'aria-live': 'polite' });
    const cnt = n => ' · ' + n;
    const filters = [
      { id: 'all', label: 'Все' + cnt(lessons().length) },
      { id: 'confirmed', label: 'Подтверждены' + cnt(countLessons('confirmed')) },
      { id: 'hypothesis', label: 'Гипотезы' + cnt(countLessons('hypothesis')) },
      { id: 'rejected', label: 'Отклонены' + cnt(countLessons('rejected')) },
    ];
    function drawList() {
      UI.clear(list);
      const rows = lessons().filter(l => st.filter === 'all' || l.status === st.filter)
        .slice().sort((a, b) => (order[a.status] - order[b.status]) || b.created.localeCompare(a.created));
      if (!rows.length) { list.appendChild(UI.empty('В этой группе уроков пока нет')); return; }
      rows.forEach(l => list.appendChild(lessonItem(l)));
    }
    drawList();
    const filter = UI.segmented({ label: 'Какие уроки показать', items: filters, active: st.filter, onChange: id => { st.filter = id; drawList(); } });
    filter.classList.add('learning-filter');
    return card({
      class: 'learning-card',
      title: 'Уроки',
      subtitle: 'Выводы из разборов ставок. В анализ попадают только подтверждённые — и только те, что вы не выключили.',
      actions: [button('Предложить урок вручную', { kind: 'secondary', size: 'sm', icon: 'plus', onClick: proposeLesson })],
      body: [
        filter,
        list,
        hint('Эффект — насколько хуже прогноз без урока, с 95% ДИ. Урок, который меняет вероятность, проверяется с ' + NEED + ' своих случаев, подтверждается на истории и применяется с усадкой: чем меньше случаев, тем меньше поправка. Урок про сбор данных принимается, если прогноз не хуже хотя бы на ' + NEED_PROC + ' случаях.'),
      ],
    });
  }

  function lessonItem(l) {
    const info = LESSON_INFO[l.id] || {};
    const off = l.status === 'confirmed' && !l.inPrompt;
    const evidence = basis(l, info);
    const main = h('div', { class: 'learning-lesson-main' },
      h('div', { class: 'learning-lesson-head' },
        h('span', { class: 'chip outline mono' }, l.id), lessonChip(l),
        l.manual && chip('Добавлен вами', 'outline', 'user'),
        h('span', { class: 'learning-date' }, 'с ' + fmt.date(l.created))),
      h('p', { class: 'learning-lesson-text' }, l.text),
      h('dl', { class: 'learning-meta' },
        l.status !== 'hypothesis' && h('div', null, h('dt', null, 'Основание'), h('dd', { class: 'num' }, evidence)),
        l.status === 'confirmed' && h('div', null, h('dt', null, 'Эффект'), h('dd', null, l.effect + (info.ci ? ' (' + info.ci + ')' : ''))),
        l.status === 'confirmed' && info.raw && h('div', null, h('dt', null, 'В анализе'), h('dd', null, MINUS + shrunk(l, info) + ' п.п. с усадкой')),
        l.status === 'hypothesis' && h('div', null, h('dt', null, 'Ждёт'), h('dd', null, 'ещё ' + cases(Math.max(0, NEED - l.evidence)) + (info.hist === 0 ? ' из своих ставок' : ''))),
        h('div', null, h('dt', null, 'Где'), h('dd', null, l.scope))));

    const side = h('div', { class: 'learning-lesson-side' });
    if (l.status === 'confirmed') {
      const tg = UI.toggle({
        id: 'learning-use-' + l.id, label: 'Использовать в анализе', checked: l.inPrompt,
        hint: l.inPrompt ? 'Урок в инструкциях анализа' : 'Выключен — анализ его не видит',
        onChange: v => {
          l.inPrompt = v;
          const hEl = tg.querySelector('.field-hint');
          if (hEl) hEl.textContent = v ? 'Урок в инструкциях анализа' : 'Выключен — анализ его не видит';
          item.classList.toggle('is-off', !v);
          drawTiles();
          UI.toast(v ? 'Урок ' + l.id + ' снова в инструкциях — со следующего анализа' : 'Урок ' + l.id + ' выключен — следующий анализ пройдёт без него', v ? 'check' : 'eyeOff');
        },
      });
      side.appendChild(tg);
    } else if (l.status === 'hypothesis') {
      side.appendChild(h('div', { class: 'learning-progress' },
        h('div', { class: 'row-between' }, h('span', { class: 'soft' }, 'Набрано случаев'), h('b', { class: 'num' }, l.evidence + ' из ' + NEED)),
        UI.meter(l.evidence, NEED),
        h('span', { class: 'xsmall muted' }, 'Пока не влияет на прогнозы')));
      if (st.notify[l.id]) side.appendChild(chip('Сообщим при ' + NEED + ' случаях', 'info', 'bell'));
      else side.appendChild(button('Сообщить, когда наберётся', { kind: 'secondary', size: 'sm', icon: 'bell', onClick: () => { st.notify[l.id] = true; item.replaceWith(lessonItem(l)); UI.toast('Напомним, когда у ' + l.id + ' будет ' + NEED + ' случаев и пройдёт проверка', 'bell'); } }));
    } else {
      const n = lessonN(l, info);
      const chk = info.check && info.check.length > 1 ? ': ' + info.check[0][0].toLowerCase() + ' ' + info.check[0][1] + ', без урока ' + info.check[1][1] : '';
      side.appendChild(h('p', { class: 'small soft' }, 'Не используется — ' + l.effect + ' на ' + fmt.int(n) + ' ' + fmt.plural(n, 'случае', 'случаях', 'случаях') + chk + (info.ci ? ' (' + info.ci + ')' : '') + '.'));
    }
    side.appendChild(button('Подробнее', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => lessonModal(l) }));
    const item = h('article', { class: ['learning-lesson', 'is-' + l.status, off && 'is-off'], 'aria-label': 'Урок ' + l.id }, main, side);
    return item;
  }

  function lessonModal(l) {
    const info = LESSON_INFO[l.id] || { kind: 'numeric', source: 'Добавлен вами ' + fmt.date(l.created), check: [['Проверка на истории', 'ждёт ' + NEED + ' своих случаев']], line: l.text };
    const kind = info.kind === 'process' ? 'Про сбор данных — вероятность не меняет' : 'Меняет вероятность — нужна проверка на истории с 95% ДИ';
    UI.modal({
      title: 'Урок ' + l.id,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('div', { class: 'row' }, lessonChip(l), l.status === 'confirmed' && (l.inPrompt ? chip('В инструкциях анализа', 'accent', 'book') : chip('Выключен вами', 'outline', 'eyeOff'))),
        h('blockquote', { class: 'learning-quote' }, l.text),
        facts([['Откуда', info.source], ['Где применяется', l.scope], ['Тип урока', kind], ['Основание', basis(l, info)]].concat(info.check || [], [
          ['Эффект', l.effect + (info.ci ? ' (' + info.ci + ')' : '')],
          info.bias && ['Смещение', info.bias],
          info.raw && l.status === 'confirmed' && ['В анализе', MINUS + shrunk(l, info) + ' п.п. — с усадкой к нулю: ' + info.raw + ' × ' + fmt.int(lessonN(l, info)) + ' / (' + fmt.int(lessonN(l, info)) + ' + ' + SHRINK_K + ')'],
        ])),
        info.note && UI.callout(l.status === 'rejected' ? 'bad' : 'info', l.status === 'rejected' ? 'x' : 'info', info.note),
        info.line && h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'eyebrow' }, l.status === 'confirmed' ? 'Строка в инструкции анализа' : 'Как звучала бы строка в инструкции'),
          h('p', { class: 'learning-code' }, info.line))),
      actions: close => [button('Закрыть', { kind: 'secondary', onClick: close })],
    });
    settleModal();
  }

  function proposeLesson() {
    UI.modal({
      title: 'Предложить урок',
      body: close => {
        const err = h('div', { class: 'field-error', role: 'alert', hidden: true }, 'Опишите наблюдение хотя бы одной фразой — иначе его нечем проверить');
        const textField = UI.field({ id: 'learning-lesson-text', label: 'Что вы заметили', rows: 3, placeholder: 'Например: на быстром харде в Азии фора +1.5 у аутсайдера-левши проходит чаще, чем даёт рынок', hint: 'Одно наблюдение — одно правило: рынок, покрытие, тип игроков.' });
        textField.appendChild(err);
        const ta = textField.querySelector('textarea');
        ta.addEventListener('input', () => { if (ta.value.trim().length >= 10) { err.hidden = true; ta.classList.remove('learning-invalid'); ta.removeAttribute('aria-invalid'); } });
        const form = h('form', { id: 'learning-lesson-form', class: 'stack', style: 'gap:14px', novalidate: true },
          textField,
          h('div', { class: 'learning-form-2' },
            UI.field({ id: 'learning-lesson-market', label: 'Рынок', options: ['Любой', 'П1 / П2', 'Фора −1.5', 'Фора +1.5'] }),
            UI.field({ id: 'learning-lesson-surface', label: 'Покрытие', options: ['Все покрытия', 'Хард', 'Грунт', 'Трава', 'Крытый хард'] })),
          UI.callout('info', 'flask', 'Ваш урок проходит ту же проверку, что и уроки от Claude: сначала гипотеза, в анализ — только после ' + NEED + ' своих случаев и проверки на истории, где 95% ДИ эффекта не задевает ноль.'));
        form.addEventListener('submit', e => {
          e.preventDefault();
          const text = ta.value.trim();
          if (text.length < 10) { err.hidden = false; ta.classList.add('learning-invalid'); ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
          const market = form.querySelector('#learning-lesson-market').value, surface = form.querySelector('#learning-lesson-surface').value;
          const n = Math.max(0, ...lessons().map(x => parseInt(x.id.slice(2), 10) || 0)) + 1;
          const id = 'L-' + String(n).padStart(3, '0');
          D.lessons.push({ id, text: text.replace(/\s+/g, ' '), status: 'hypothesis', evidence: 0, effect: 'нужно ≥ ' + NEED + ' случаев', scope: market + ' · ' + surface.toLowerCase(), inPrompt: false, created: TODAY, manual: true });
          close();
          st.filter = 'all';
          setTab('lessons', { rebuildTabs: true });
          UI.toast('Урок ' + id + ' добавлен как гипотеза — система начнёт копить случаи', 'flask');
        });
        return form;
      },
      actions: close => [
        button('Отмена', { kind: 'ghost', onClick: close }),
        button('Добавить как гипотезу', { kind: 'primary', icon: 'plus', type: 'submit', attrs: { form: 'learning-lesson-form' } }),
      ],
    });
  }

  // ---------- 2. Версии стратегии ----------
  function versionsPanel() {
    const mobile = UI.isMobile();
    const V = versions();
    const best = Math.min(...V.map(v => v.logloss));
    const A = vById('v3'), B = vById('v4');

    const actions = [
      A && B && button('Сравнить ' + A.id + ' и ' + B.id, { kind: 'primary', size: 'sm', icon: 'layers', onClick: compareModal }),
      button('Оценить на истории', { kind: 'secondary', size: 'sm', icon: 'play', onClick: () => UI.toast('Запущено на ' + HOLDOUT + ' событиях · ≈ ' + fmt.usd(FULL_COST) + ' через Batch API (из бюджета экспериментов)', 'clock') }),
    ];
    let listNode;
    if (mobile) {
      listNode = h('div', { class: 'learning-vcards' }, V.slice().reverse().map(v => h('button', { type: 'button', class: 'learning-vcard', 'aria-label': 'Версия ' + v.name + ', подробнее', on: { click: () => versionModal(v) } },
        h('div', { class: 'learning-vcard-head' },
          h('div', null, h('div', { class: 'learning-ver-name' }, h('b', { class: 'mono' }, v.id), h('span', { class: 'xsmall muted' }, fmt.date(v.date))), h('div', { class: 'small soft' }, verShort(v))),
          versionChip(v)),
        h('dl', { class: 'learning-vgrid' },
          h('div', null, h('dt', null, 'Лог-лосс'), h('dd', { class: v.logloss === best ? 'learning-best' : null }, fmt.dec(v.logloss, 3))),
          h('div', null, h('dt', null, 'Brier'), h('dd', null, fmt.dec(v.brier, 3))),
          h('div', null, h('dt', null, 'ROI'), h('dd', null, signedPctEl(v.roi))),
          h('div', null, h('dt', null, 'CLV'), h('dd', null, fmt.signedPct(v.clv)))))));
    } else {
      listNode = UI.table({
        columns: [
          { label: 'Версия', render: v => h('div', { class: 'learning-ver-name' }, h('b', null, v.id), h('span', { class: 'soft' }, verShort(v))) },
          { label: 'Дата', render: v => fmt.date(v.date) },
          { label: 'Лог-лосс', align: 'r', render: v => h('span', { class: v.logloss === best ? 'learning-best' : null }, fmt.dec(v.logloss, 3)) },
          { label: 'Brier', align: 'r', render: v => fmt.dec(v.brier, 3) },
          { label: 'ROI', align: 'r', render: v => signedPctEl(v.roi) },
          { label: 'CLV', align: 'r', render: v => fmt.signedPct(v.clv) },
          { label: 'Событий', align: 'r', render: v => fmt.int(v.n) },
          { label: 'Статус', render: v => versionChip(v) },
        ],
        rows: V.slice().reverse(),
        onRowClick: versionModal,
      });
    }
    const tableCard = card({
      class: 'learning-card',
      title: 'Версии стратегии',
      subtitle: 'Стратегия — это инструкции анализа, принятые уроки и правила отбора. Все версии считаются на одной отложенной выборке: ' + HOLDOUT + ' событий, которых ни одна версия не видела при настройке.',
      actions,
      flush: !mobile,
      body: listNode,
      foot: hint('ROI и CLV — для наблюдения, решения по ним не принимаем: на ' + HOLDOUT + ' событиях 95% ДИ ROI около ±20 п.п. CLV — вторичная проверка.'),
    });
    const toMarket = v => {
      const ci = MARKET_CI[v.id];
      return h('div', null, h('div', null, signedDec(v.logloss - MARKET_LL)), ci && h('div', { class: 'xsmall muted', style: 'white-space:nowrap' }, 'ДИ ' + signedDec(ci[0]) + '…' + signedDec(ci[1])));
    };
    const vsMarket = V.filter(v => v.logloss < MARKET_LL).map(v => v.logloss - MARKET_LL).sort((a, b) => b - a);

    const chart = UI.lineChart({
      labels: V.map(v => v.id),
      series: [{ name: 'Лог-лосс стратегии', color: 'var(--s1)', values: V.map(v => v.logloss) }],
      refLines: [{ value: MARKET_LL, label: 'рынок · ' + fmt.dec(MARKET_LL, 3) }],
      yFormat: v => fmt.dec(v, 3), endLabel: true, height: mobile ? 200 : 230,
      tipTitle: (l, i) => V[i].name,
      ariaLabel: 'Лог-лосс по версиям стратегии: ' + V.map(v => v.id + ' ' + fmt.dec(v.logloss, 3)).join(', '),
    });
    const chartCard = card({
      class: 'learning-card',
      title: 'Лог-лосс по версиям',
      subtitle: 'на отложенной выборке, ' + HOLDOUT + ' событий',
      body: [
        UI.legend([{ name: 'Стратегия', color: 'var(--s1)' }, { name: 'Рынок по закрывающим кэфам', type: 'dash' }]),
        UI.withTable(chart, () => UI.table({
          columns: [
            { label: 'Версия', render: v => v.name },
            { label: 'Лог-лосс', align: 'r', render: v => fmt.dec(v.logloss, 3) },
            { label: 'К рынку, 95% ДИ', align: 'r', render: toMarket },
          ],
          rows: V,
        })),
        hint('Ниже — лучше. На ' + HOLDOUT + ' событиях разница с закрывающей линией' + (vsMarket.length ? ' (' + vsMarket.map(d => signedDec(d)).join('…') + ')' : '') + ' в пределах шума: чтобы показать перевес над рынком, нужны тысячи событий. Разница v3 и v4 тоже в пределах шума.'),
      ],
    });

    return h('div', { class: 'learning-panel' }, tableCard, h('div', { class: 'learning-two wide-left' }, chartCard, rulesCard()));
  }

  function rulesCard() {
    const A = vById('v3'), B = vById('v4');
    const pending = B && B.status === 'candidate';
    const rule = (n, title, text, status) => h('li', null, h('span', { 'aria-hidden': 'true' }, String(n)), h('div', null, title && h('b', null, title), h('span', null, text), status));
    return card({
      class: 'learning-card',
      title: 'Как принимается новая версия',
      subtitle: pending ? 'Кандидат ' + B.id + ' нужен ради экономии — его проверяют по правилу 3' : 'Правила для следующих кандидатов',
      body: [
        h('ol', { class: 'learning-rules' },
          rule(1, null, 'Кандидат и активная версия считаются на одних и тех же ' + HOLDOUT + ' событиях, без веб-поиска.', pending && chip('Выполнено', 'good', 'check')),
          rule(2, 'Если версия должна улучшить прогноз', '95% ДИ разницы лог-лосса (новая − текущая) целиком ниже нуля.', pending && chip('К ' + B.id + ' не относится', 'outline', 'info')),
          rule(3, 'Если версия нужна ради экономии', 'Качество не хуже с допуском: верхняя граница 95% ДИ разницы лог-лосса ≤ +0,01, Brier ≤ +0,005, калибровки (ECE) ≤ +2 п.п.; ошибок формата не больше; расход по логам ниже.',
            pending && h('div', { class: 'learning-chips' }, SAVE_CHECKS().map(t => chip(t, 'good', 'check')))),
          rule(4, null, 'ROI и CLV показываем для наблюдения, решения по ним не принимаем: на ' + HOLDOUT + ' событиях 95% ДИ ROI около ±20 п.п. CLV — вторичная проверка.', null),
          rule(5, null, 'Последнее слово за вами: версия включается кнопкой, откат — в один клик.', null)),
        A && B && button('Сравнить ' + A.id + ' и ' + B.id, { kind: 'secondary', size: 'sm', iconRight: 'chevronRight', onClick: compareModal }),
      ],
    });
  }

  function compareModal() {
    const A = vById('v3'), B = vById('v4');
    if (!A || !B) return;
    const tA = VERSION_INFO.v3.tokens, tB = VERSION_INFO.v4.tokens;
    const OK = t => [t, 'good', 'check'], OBS = ['для наблюдения', 'outline', 'eye'];
    const rows = [
      { k: 'Лог-лосс', a: fmt.dec(A.logloss, 3), b: fmt.dec(B.logloss, 3), d: signedDec(B.logloss - A.logloss), ci: '95% ДИ: −0,009 … +0,005', v: OK('не хуже: до +0,005 ≤ +0,01') },
      { k: 'Brier', a: fmt.dec(A.brier, 3), b: fmt.dec(B.brier, 3), d: signedDec(B.brier - A.brier), ci: '95% ДИ: −0,004 … +0,002', v: OK('не хуже: до +0,002 ≤ +0,005') },
      { k: 'Калибровка (ECE)', a: fmt.pct(ECE.v3), b: fmt.pct(ECE.v4), d: pp(ECE.v4 - ECE.v3), ci: '95% ДИ: −0,7 … +1,1 п.п.', v: OK('не хуже: до +1,1 ≤ +2') },
      { k: 'Ошибок формата', a: FORMAT_ERR.v3 + ' из ' + HOLDOUT, b: FORMAT_ERR.v4 + ' из ' + HOLDOUT, d: (FORMAT_ERR.v4 - FORMAT_ERR.v3 < 0 ? MINUS : '+') + Math.abs(FORMAT_ERR.v4 - FORMAT_ERR.v3), v: OK('не больше') },
      { k: 'Токенов на анализ', a: '≈ ' + tA + ' тыс.', b: '≈ ' + tB + ' тыс.', d: MINUS + tokSave() + '%', ci: 'по логам запусков', v: OK('дешевле') },
      { k: 'ROI', a: fmt.signedPct(A.roi), b: fmt.signedPct(B.roi), d: pp(B.roi - A.roi), ci: '95% ДИ ROI ≈ ±20 п.п.', v: OBS },
      { k: 'CLV', a: fmt.signedPct(A.clv), b: fmt.signedPct(B.clv), d: pp(B.clv - A.clv), ci: 'вторичная проверка', v: OBS },
    ];
    const verdict = r => chip(r.v[0], r.v[1], r.v[2]);
    const cmp = UI.isMobile()
      ? h('div', { class: 'learning-cmp-list' }, rows.map(r => h('div', { class: 'learning-cmp-item' },
          h('div', { class: 'learning-cmp-top' }, h('b', null, r.k), verdict(r)),
          h('div', { class: 'small num' }, A.id + ' ' + r.a + ' → ' + B.id + ' ' + r.b + ' · разница ' + r.d),
          r.ci && h('div', { class: 'xsmall muted' }, r.ci))))
      : UI.table({
          columns: [
            { label: 'Показатель', render: r => h('b', { style: 'font-weight:600' }, r.k) },
            { label: A.id + ' · ' + (VERSION_STATUS[A.status] || ['—'])[0].toLowerCase(), align: 'r', render: r => r.a },
            { label: B.id + ' · ' + (VERSION_STATUS[B.status] || ['—'])[0].toLowerCase(), align: 'r', render: r => r.b },
            { label: 'Разница', align: 'r', render: r => h('div', null, h('div', null, r.d), r.ci && h('div', { class: 'xsmall muted', style: 'white-space:nowrap' }, r.ci)) },
            { label: 'Вывод', render: verdict },
          ],
          rows,
        });
    const accepted = B.status === 'active';
    UI.modal({
      title: 'Сравнение ' + A.id + ' и ' + B.id,
      wide: true,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('p', { class: 'small soft' }, 'Обе версии посчитаны на одних и тех же ' + HOLDOUT + ' событиях отложенной выборки. ' + B.id + ' сделана ради экономии, поэтому проверяется по правилу «не хуже с допуском».'),
        cmp,
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Что изменилось в ' + B.id), h('ul', { class: 'learning-changes' }, VERSION_INFO.v4.changes.map(c => h('li', null, c)))),
        UI.callout('accent', 'shield', h('b', null, 'Правило экономии: '), 'качество не хуже с допуском (лог-лосс до +0,01, Brier до +0,005, ECE до +2 п.п.), ошибок формата не больше, а расход по логам ниже. Улучшения прогноза не требуется. ROI и CLV — для наблюдения.'),
        accepted
          ? UI.callout('good', 'check', B.id + ' включена вами. ' + A.id + ' в архиве — вернуть можно здесь же.')
          : UI.callout('good', 'check', h('b', null, 'Вывод: '), B.id + ' проходит правило экономии — качество не хуже в пределах допуска, анализ дешевле на ' + tokSave() + '%. Рекомендуем включить, решение за вами. Точнее ' + A.id + ' она не стала: ДИ разницы захватывает ноль.')),
      actions: close => accepted
        ? [button('Вернуть ' + A.id, { kind: 'secondary', icon: 'history', onClick: () => { A.status = 'active'; B.status = 'candidate'; close(); afterVersionChange(); UI.toast('Снова активна ' + A.id + ' · ' + B.id + ' вернулась в кандидаты', 'history'); } }),
           button('Закрыть', { kind: 'primary', onClick: close })]
        : [button('Оставить ' + A.id, { kind: 'secondary', onClick: () => { close(); UI.toast('Остаётся ' + A.id + '. ' + B.id + ' остаётся кандидатом — включить можно в любой момент', 'clock'); } }),
           button('Включить ' + B.id, { kind: 'primary', icon: 'check', onClick: () => { B.status = 'active'; A.status = 'archived'; close(); afterVersionChange(); UI.toast(B.id + ' работает со следующего анализа · ' + A.id + ' в архиве, откат в один клик', 'check'); } })],
    });
    settleModal();
  }
  function afterVersionChange() { if (st.tab === 'versions') drawPanel(); drawTiles(); }

  function versionModal(v) {
    const info = VERSION_INFO[v.id] || { changes: [], tokens: null };
    UI.modal({
      title: 'Версия ' + v.name,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('div', { class: 'row' }, versionChip(v), h('span', { class: 'small muted' }, 'создана ' + fmt.dateFull(v.date))),
        facts([
          ['Лог-лосс', fmt.dec(v.logloss, 3) + ' · рынок ' + fmt.dec(MARKET_LL, 3) + (MARKET_CI[v.id] ? ' · разница ' + signedDec(v.logloss - MARKET_LL) + ' (95% ДИ ' + signedDec(MARKET_CI[v.id][0]) + '…' + signedDec(MARKET_CI[v.id][1]) + ')' + (MARKET_CI[v.id][0] < 0 && MARKET_CI[v.id][1] > 0 ? ' — в пределах шума' : '') : '')],
          ['Brier', fmt.dec(v.brier, 3)],
          ['ROI', h('span', null, signedPctEl(v.roi), h('span', { class: 'muted' }, ' · для наблюдения, ДИ ≈ ±20 п.п.'))],
          ['CLV', fmt.signedPct(v.clv)],
          VERSION_INFO[v.id] && VERSION_INFO[v.id].goal === 'save' && ['Цель версии', 'Экономия: ' + MINUS + tokSave() + '% токенов на анализ при качестве не хуже с допуском'],
          ['Событий в оценке', fmt.int(v.n)],
          info.tokens && ['Токенов на анализ', '≈ ' + info.tokens + ' тыс.'],
        ]),
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Что изменилось'), h('ul', { class: 'learning-changes' }, info.changes.map(c => h('li', null, c))))),
      actions: close => [
        (v.id === 'v4' || v.id === 'v3') && button('Сравнить v3 и v4', { kind: 'secondary', icon: 'layers', onClick: () => { close(); compareModal(); } }),
        button('Закрыть', { kind: 'primary', onClick: close }),
      ].filter(Boolean),
    });
    settleModal();
  }

  // ---------- 3. Своя ML-модель ----------
  function mlHeadCard() {
    const ml = st.ml;
    const status = ml.training
      ? chip('Идёт обучение', 'info', 'clock')
      : chip('Обучена ' + fmt.date(ml.at) + ', ' + hhmm(ml.at), 'good', 'check');
    const body = [
      h('dl', { class: 'learning-strip' },
        h('div', null, h('dt', null, 'Последнее обучение'), h('dd', null, fmt.date(ml.at) + ', ' + hhmm(ml.at), h('small', null, 'по понедельникам и после турниров Шлема'))),
        h('div', null, h('dt', null, 'Матчей в обучении'), h('dd', null, fmt.int(HIST), h('small', null, 'основной тур ATP с 2019 г.; Эло считается по всей истории с 2000 г.'))),
        h('div', null, h('dt', null, 'Признаков'), h('dd', null, '14', h('small', null, 'кэфов букмекеров среди них нет'))),
        h('div', null, h('dt', null, 'Brier, сентябрь'), h('dd', null, fmt.dec(ml.brier, 3), h('small', null, 'рынок ' + fmt.dec(WF[WF.length - 1].market, 3) + ': разница в пределах шума'))),
        h('div', null, h('dt', null, 'Калибровка, ECE'), h('dd', null, fmt.pct(2.1), h('small', null, 'на валидации; 0% — идеальная калибровка'))),
        h('div', null, h('dt', null, 'Доверие к поправкам Claude, c'), h('dd', null, '≈ ' + fmt.dec(0.42, 2), h('small', null, 'предварительно: 95% ДИ 0,1…0,7 на ' + OWN + ' событиях; в расчёт — с 300')))),
      hint('c показывает, помогают ли поправки Claude к вероятности модели: c ≈ 0 — информации не несут, c ≈ 1 — берём как есть. Подбирается на валидации по своим снимкам с новостями; пока событий меньше 300, поправка Claude ограничена ±10 п.п.'),
    ];
    if (ml.training) {
      const stage = ml.progress < 35 ? 'Собираем признаки на дату каждого матча' : ml.progress < 80 ? 'Обучаем градиентный бустинг' : 'Проверяем на валидации — заменим, только если не хуже';
      body.push(h('div', { class: 'learning-train', 'aria-live': 'polite' },
        h('div', { class: 'row-between' }, h('span', { class: 'soft' }, stage), h('b', { class: 'num' }, Math.round(ml.progress) + '%')),
        UI.meter(ml.progress, 100)));
    } else if (ml.prev != null) {
      body.push(UI.callout('good', 'check', h('div', { class: 'stack', style: 'gap:8px' },
        h('span', null, 'Переобучена сегодня в ' + hhmm(ml.at) + ': Brier на валидации ' + fmt.dec(ml.brier, 3) + ' (было ' + fmt.dec(ml.prev, 3) + '). Это плановое переобучение той же модели на новых матчах — оно включается само, если на валидации не хуже с допуском (Brier до +0,005). Новые признаки и c — только с вашего подтверждения.'),
        button('Вернуть прежнюю модель', { kind: 'secondary', size: 'sm', icon: 'history', onClick: () => {
          ml.brier = ml.prev; ml.prev = null; ml.at = ml.prevAt || ml.at;
          drawMlHead(); drawTiles();
          UI.toast('Вернули модель от ' + fmt.date(ml.at) + ', ' + hhmm(ml.at) + ' · Brier ' + fmt.dec(ml.brier, 3), 'history');
        } }))));
    }
    body.push(UI.callout('info', 'info', 'Сама по себе модель чуть уступает рынку — это ожидаемо: букмекер учитывает новости и травмы, а модель видит только статистику. Её роль — независимое второе мнение: Claude видит её вероятность, а расхождение больше 8 п.п. анализ подсвечивает и объясняет.'));
    return card({
      class: 'learning-card',
      eyebrow: 'Своя ML-модель',
      title: 'Эло + градиентный бустинг',
      subtitle: 'Считается на сервере без ИИ — за миллисекунды и бесплатно',
      actions: [status, button(ml.training ? 'Обучается…' : 'Переобучить', { kind: 'secondary', size: 'sm', icon: 'refresh', disabled: ml.training, onClick: retrain })],
      body,
    });
  }
  function drawMlHead() { if (mlHeadSlot && mlHeadSlot.isConnected) UI.clear(mlHeadSlot).appendChild(mlHeadCard()); }

  function retrain() {
    if (st.ml.training) return;
    st.ml.training = true; st.ml.progress = 0;
    drawMlHead(); drawTiles();
    const timer = setInterval(() => {
      st.ml.progress = Math.min(100, st.ml.progress + 10);
      if (st.ml.progress >= 100) {
        clearInterval(timer);
        const now = new Date();
        st.ml.training = false;
        st.ml.prev = st.ml.brier;
        st.ml.prevAt = st.ml.at;
        st.ml.brier = 0.193;
        st.ml.at = TODAY + 'T' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
        UI.toast('Модель переобучена на ' + fmt.int(HIST) + ' матчах · Brier на валидации ' + fmt.dec(st.ml.brier, 3) + ' (было ' + fmt.dec(st.ml.prev, 3) + ')', 'check');
        drawTiles();
      }
      drawMlHead();
    }, 260);
  }

  function mlPanel() {
    const mobile = UI.isMobile();
    mlHeadSlot = h('div', { style: 'min-width:0' }, mlHeadCard());
    const feat = card({
      class: 'learning-card',
      title: 'Что важнее всего для модели',
      subtitle: 'Вклад признака в прогноз, %',
      body: [
        h('div', { class: 'learning-feat' }, UI.hbars({ items: FEATURES.map(f => ({ label: f.label + (f.note ? ', из урока ' + f.note : ''), value: f.value, labelNode: f.note ? [h('span', { style: 'min-width:0' }, f.label), chip('урок ' + f.note, 'outline')] : null, dot: false })), color: 'var(--s1)', valueFormat: v => v + '%', domain: [0, 25] })),
        h('p', { class: 'small soft' }, 'Ещё 6 признаков вместе — ' + FEATURES_REST + '%: возраст, перелёт и смена часового пояса, высота над уровнем моря, скорость покрытия, раунд, рейтинг ATP.'),
        hint('Кэфы букмекеров намеренно не входят в признаки — иначе модель просто повторяла бы рынок. Два признака появились из подтверждённых уроков.'),
      ],
    });
    const wfChart = UI.lineChart({
      labels: WF.map(r => r.m),
      series: [
        { name: 'Своя модель', color: 'var(--s1)', values: WF.map(r => r.model) },
        { name: 'Рынок по закрытию', color: 'var(--s2)', values: WF.map(r => r.market) },
      ],
      yFormat: v => fmt.dec(v, 3), height: mobile ? 200 : 230,
      tipTitle: (l, i) => WF[i].full + ' · ' + WF[i].n + ' матчей',
      ariaLabel: 'Brier по месяцам: своя модель против рынка',
    });
    const first = WF[0], last = WF[WF.length - 1];
    const wf = card({
      class: 'learning-card',
      title: 'Проверка walk-forward',
      subtitle: 'Brier по месяцам: модель учится только на прошлом и прогнозирует следующий месяц',
      body: [
        UI.legend([{ name: 'Своя модель', color: 'var(--s1)' }, { name: 'Рынок по закрытию', color: 'var(--s2)' }]),
        UI.withTable(wfChart, () => UI.table({
          columns: [
            { label: 'Месяц', render: r => r.full },
            { label: 'Матчей', align: 'r', render: r => fmt.int(r.n) },
            { label: 'Модель', align: 'r', render: r => fmt.dec(r.model, 3) },
            { label: 'Рынок', align: 'r', render: r => fmt.dec(r.market, 3) },
          ],
          rows: WF,
        })),
        hint('Ниже — лучше. Отставание от рынка сократилось с ' + fmt.dec(first.model - first.market, 3) + ' в апреле до ' + fmt.dec(last.model - last.market, 3) + ' в сентябре. Но при ' + Math.min(...WF.map(r => r.n)) + '–' + Math.max(...WF.map(r => r.n)) + ' матчах в месяц разница меньше ≈ 0,005 — шум: обогнать рынок модель не обещает.'),
      ],
    });
    return h('div', { class: 'learning-panel' }, mlHeadSlot, h('div', { class: 'learning-two' }, feat, wf));
  }

  // ---------- 4. Датасет и лаборатория ----------
  function jsonPreview(anon) {
    const l = leg0927 || { odds: 1.74, closing: 1.70, p: 0.641, betId: 69 };
    const hl = (a, b) => h('span', { class: ['learning-hl', !anon && 'exposed'] }, anon ? a : b);
    const pA = D.P.zverev, pB = D.P.draper;
    const qClose = Math.round(1 / (l.closing || 1.70) * 0.955 * 1000) / 1000;
    return h('pre', { class: 'learning-code', 'aria-label': 'Пример записи JSONL' },
      '{"id": "own-', String(l.betId).padStart(4, '0'), '", "date": ', hl('"2026, неделя 39"', '"2026-09-27"'), ', "event": ', hl('"ATP 500 · хард"', '"ATP 500 Пекин"'), ',\n',
      ' "a": {"name": ', hl('"Игрок A"', '"' + pA.name + '"'), ', "hand": "R", "elo_surface": ', String(pA.elo.hard), ', "sets_7d": 6},\n',
      ' "b": {"name": ', hl('"Игрок B"', '"' + pB.name + '"'), ', "hand": "L", "elo_surface": ', String(pB.elo.hard), ', "sets_7d": 3},\n',
      ' "news": "', hl('Игрок A', pA.short), ' накануне сыграл три сета в четвертьфинале",\n',
      ' "market": "Ф1(−1.5)", "odds": ', fmt.odds(l.odds), ', "odds_close": ', fmt.odds(l.closing || 1.70), ',\n',
      ' "p_base": ', String(Math.round((l.p - 0.04) * 1000) / 1000), ', "p_claude": ', String(l.p), ', "q_close_novig": ', String(qClose), ',\n',
      ' "label": {"sets": "2:1", "bet_won": false}}');
  }

  function datasetCard() {
    const total = SPLIT.reduce((a, s) => a + s.n, 0);
    const previewSlot = h('div', { style: 'min-width:0' }, jsonPreview(st.anon));
    const anonToggle = UI.toggle({
      id: 'learning-anon', label: 'Анонимизация игроков', checked: st.anon,
      hint: 'Имена, турниры и точные даты заменяются на «Игрок A / B», категорию и неделю. LLM может помнить исторические результаты из своих обучающих данных — без анонимизации она «вспомнит» исход, и оценка будет нечестно завышена.',
      onChange: v => {
        st.anon = v;
        UI.clear(previewSlot).appendChild(jsonPreview(v));
        UI.toast(v ? 'Анонимизация включена: имена, турниры и даты скрыты в экспорте' : 'Анонимизация выключена — оценка дообученной LLM может быть завышена', v ? 'shield' : 'alert');
      },
    });
    const left = h('div', { class: 'stack', style: 'gap:14px' },
      h('div', { class: 'learning-ds-total' }, h('b', null, fmt.int(SNAPSHOTS)), h('span', { class: 'soft' }, 'снимков матчей')),
      h('div', { class: 'learning-ds-parts' },
        h('div', null, h('b', null, fmt.int(HIST)), 'исторических: все матчи основного тура ATP с 2019 г. по 6 окт 2026 — кэфы tennis-data.co.uk, статистика Сакманна. Новостей и скорости подачи нет'),
        h('div', null, h('b', null, fmt.int(OWN)), 'своих событий: ' + S.legs + ' из ставок' + (OWN_NO_BET > 0 ? ' и ' + OWN_NO_BET + ' разобраны без ставки' : '') + ' — с замороженным досье, новостями и вероятностью Claude')),
      h('div', { class: 'stack', style: 'gap:8px' },
        h('div', { class: 'row-between' }, h('span', { class: 'eyebrow' }, 'Деление по времени'), h('span', { class: 'xsmall muted' }, 'train / val / test')),
        h('div', { class: 'learning-split', role: 'img', 'aria-label': SPLIT.map(s => s.label + ' ' + fmt.int(s.n)).join(', ') }, SPLIT.map(s => h('i', { style: { width: (s.n / total * 100).toFixed(2) + '%', background: s.color } }))),
        h('dl', { class: 'learning-split-legend' }, SPLIT.map(s => h('div', null,
          h('dt', null, h('i', { style: { background: s.color } }), s.label + ' · ' + fmt.int(s.n)),
          h('dd', null, s.period + (s.note ? ', ' + s.note : ''))))),
        hint('Делим по времени, а не случайно: иначе модель «подсмотрит» матчи из будущего, и проверка покажет то, чего в жизни не будет.'),
        hint('Тест «с 1 июн» — для своей ML-модели. Для LLM тест начинается с ' + fmt.date(LLM_FROM) + ' 2026: срез знаний Opus 5.5 — июнь 2026, плюс месяц запаса, иначе модель может «помнить» исход. Таких событий ' + fmt.int(LLM_TEST) + ', из них ' + HOLDOUT + ' — отложенная выборка для версий стратегии.')),
      anonToggle);
    const right = h('div', { class: 'stack', style: 'gap:8px' },
      h('div', { class: 'row-between' }, h('span', { class: 'eyebrow' }, 'Одна запись в экспорте'), h('span', { class: 'xsmall muted' }, 'подсвечено то, что меняет анонимизация')),
      previewSlot);
    return card({
      class: 'learning-card',
      title: 'Датасет снимков матчей',
      subtitle: 'Снимок — всё, что было известно до начала матча, плюс исход. Будущее в снимок не попадает.',
      actions: [button('Экспорт JSONL', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => UI.toast('Экспорт собран: train / val / test, ' + fmt.int(SNAPSHOTS) + ' строк' + (st.anon ? ', анонимизировано' : ', с именами') + '. В макете файл не скачивается', 'download') })],
      body: h('div', { class: 'learning-two' }, left, right),
    });
  }

  function expCard(o) {
    return h('section', { class: 'card learning-exp', 'aria-label': o.title },
      h('div', { class: 'card-head' }, h('div', { style: 'min-width:0' }, h('div', { class: 'row', style: 'gap:6px' }, o.status, h('span', { class: 'xsmall muted' }, o.kind)), h('h3', null, o.title))),
      h('div', { class: 'card-body' },
        h('dl', { class: 'learning-exp-dl' },
          h('div', null, h('dt', null, 'Цель'), h('dd', null, o.goal)),
          h('div', null, h('dt', null, 'Метрика успеха'), h('dd', null, o.metric)),
          h('div', null, h('dt', null, 'Бюджет'), h('dd', null, o.budget))),
        o.extra),
      h('div', { class: 'card-foot' }, o.actions));
  }

  function experiments() {
    const slot = h('div', { class: 'learning-exps' });
    function draw() {
      UI.clear(slot);
      const running = st.popt === 'running';
      const done = POPT.filter(p => p.smoke != null).length;
      slot.appendChild(expCard({
        status: running ? chip('Идёт', 'accent', 'refresh') : chip('На паузе', 'warn', 'pause'),
        kind: 'без дообучения',
        title: 'Prompt-оптимизация по eval-набору',
        goal: 'Автоматически переписывать инструкции Claude и оставлять варианты, которые снижают лог-лосс.',
        metric: 'Лог-лосс: smoke на ' + SMOKE + ' событиях отсеивает явно плохие варианты, лучший проходит полный прогон на ' + HOLDOUT + '. Плюс токены на анализ.',
        budget: fmt.usd(POPT_SPENT) + ' из ' + fmt.usd(EXP_BUDGET, 0) + ' в месяц · отдельный ключ, Batch API ночью',
        extra: h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Итерация ' + POPT.length + ' из 12'), h('span', { class: 'num', style: 'font-weight:600' }, done + ' посчитано')),
          UI.meter(POPT.length, 12),
          h('p', { class: 'learning-note' }, icon('spark'), h('span', null, 'Лучший вариант (итерация 4) стал кандидатом v4 — см. «Версии стратегии».'))),
        actions: [
          button(running ? 'Пауза' : 'Продолжить', { kind: 'secondary', size: 'sm', icon: running ? 'pause' : 'play', onClick: () => {
            st.popt = running ? 'paused' : 'running'; draw(); drawTiles();
            UI.toast(running ? 'На паузе: итерация 7 досчитается, новые не начнутся' : 'Продолжаем: следующая итерация ночью через Batch API', running ? 'pause' : 'play');
          } }),
          button('Журнал итераций', { kind: 'ghost', size: 'sm', icon: 'list', onClick: poptModal }),
        ],
      }));
      slot.appendChild(expCard({
        status: chip('Запланирован', 'info', 'calendar'),
        kind: 'дообучение · шаг 7',
        title: 'SFT + LoRA открытой модели 0,5–3B: досье → обоснование и p',
        goal: 'Освоить дообучение: модель учится выдавать вероятность своей ML-модели (учителя) в формате JSON. Цель — откалиброванная p уровня 4 или рынка без маржи.',
        metric: 'Валидный JSON ≥ 99%; лог-лосс на тесте хуже учителя не больше чем на 0,01.',
        budget: '$0 — Colab с T4, ≈ 2–4 ч: для модели 0,5–3B этого хватает',
        extra: h('div', { class: 'stack', style: 'gap:8px' },
          h('div', { class: 'row-between small' }, h('span', { class: 'soft' }, 'Обучающих примеров'), h('span', { class: 'row', style: 'gap:6px' }, h('span', { class: 'num', style: 'font-weight:600' }, fmt.int(HIST_TRAIN)), chip('хватает', 'good', 'check'))),
          h('p', { class: 'learning-note' }, icon('info'), h('span', null, 'Примеры собираются из исторических снимков без Claude: цель p — своя ML-модель, обоснование — шаблон из признаков.')),
          h('p', { class: 'learning-note warn' }, icon('alert'), h('span', null, 'Рассуждения Claude как образцы не берём: условия Anthropic ограничивают обучение других моделей на его ответах.'))),
        actions: [button('План эксперимента', { kind: 'secondary', size: 'sm', icon: 'list', onClick: sftModal })],
      }));
      slot.appendChild(expCard({
        status: chip('Идея', 'outline', 'spark'),
        kind: 'дообучение',
        title: 'RL (GRPO) с наградой = лог-скор вероятности',
        goal: 'Награждать модель за точную вероятность, а не за угаданного победителя.',
        metric: 'Лог-лосс лучше той же модели после SFT; обогнать рынок не ожидаем.',
        budget: '≈ $30–100 аренды GPU · только после SFT',
        extra: h('div', { class: 'stack', style: 'gap:8px' },
          h('dl', { class: 'learning-reward', 'aria-label': 'Пример награды' },
            h('dt', null, 'Прогноз 70%, игрок выиграл'), h('dd', null, 'ln 0,70 = −0,36'),
            h('dt', null, 'Прогноз 70%, игрок проиграл'), h('dd', null, 'ln 0,30 = −1,20')),
          h('p', { class: 'learning-note' }, icon('info'), h('span', null, 'Риск: исход одного матча во многом случаен, награда шумная — нужны тысячи матчей.'))),
        actions: [button('Подробнее', { kind: 'ghost', size: 'sm', icon: 'book', onClick: () => UI.toast('Разбор GRPO и лог-скора — в документе LLM_LEARNING.md, папка docs в репозитории', 'book') })],
      }));
    }
    draw();
    return slot;
  }

  function poptModal() {
    const mobile = UI.isMobile();
    const smokeEl = r => r.smoke == null ? h('span', { class: 'muted' }, 'считается')
      : r.base ? h('span', { class: 'muted' }, 'база')
      : h('span', { class: r.best ? 'learning-best' : null }, signedDec(r.smoke));
    const fullEl = r => r.full == null ? h('span', { class: 'muted' }, '—') : h('span', { class: r.best ? 'learning-best' : null }, fmt.dec(r.full, 3));
    const list = mobile
      ? h('div', { class: 'learning-cmp-list' }, POPT.map(r => h('div', { class: 'learning-cmp-item' },
          h('div', { class: 'learning-cmp-top' }, h('b', null, r.i + '. ' + r.change), r.best && chip('кандидат v4', 'info', 'flask')),
          h('div', { class: 'small num soft' }, 'Smoke: ', smokeEl(r), ' · полный: ', fullEl(r), ' · ≈ ' + r.tok + ' тыс. токенов'))))
      : UI.table({
          columns: [
            { label: '№', render: r => String(r.i), width: '40px' },
            { label: 'Что изменили', render: r => h('span', null, r.change, r.best && [' ', chip('кандидат v4', 'info', 'flask')]) },
            { label: 'Smoke · ' + SMOKE + ', Δ к v3', align: 'r', render: smokeEl },
            { label: 'Полный · ' + HOLDOUT, align: 'r', render: fullEl },
            { label: 'Токенов', align: 'r', render: r => '≈ ' + r.tok + ' тыс.' },
          ],
          rows: POPT,
        });
    UI.modal({
      title: 'Prompt-оптимизация: журнал',
      wide: true,
      body: h('div', { class: 'stack' },
        h('p', { class: 'small soft' }, 'Каждый вариант — smoke на ' + SMOKE + ' событиях (≈ ' + fmt.usd(SMOKE_COST) + '), лучший — полный прогон на ' + HOLDOUT + ' (≈ ' + fmt.usd(FULL_COST) + '). Всё через Batch API, из отдельного бюджета экспериментов. Ниже лог-лосс — лучше.'),
        list,
        hint('На ' + SMOKE + ' событиях разница меньше ±0,02 — шум: smoke только отсеивает явно плохие правки. Решение по варианту — по полному прогону и правилу приёма версий.')),
      actions: close => [button('Закрыть', { kind: 'primary', onClick: close })],
    });
    settleModal();
  }

  function sftModal() {
    const steps = [
      ['Собрать примеры из снимков', 'Вход — обезличенное досье, цель p — вероятность своей ML-модели (или рынка без маржи), обоснование — шаблон из признаков. Claude не нужен, $0.'],
      ['Анонимизировать и разделить по времени', 'Как в датасете выше: train / val / test без пересечений по датам, игроки — «A / B».'],
      ['Дообучить LoRA', 'r = 16 на открытой модели 0,5–3B (сверить лицензию) в Colab с T4, ≈ 2–4 часа.'],
      ['Сравнить на тесте', 'Доля валидного JSON, лог-лосс и калибровка — против учителя и той же модели без дообучения.'],
      ['Отдельным экспериментом — рассуждения Claude', 'Только после проверки актуальных условий Anthropic: они ограничивают обучение других моделей на его ответах.'],
    ];
    UI.modal({
      title: 'План: SFT + LoRA',
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('ol', { class: 'learning-rules' }, steps.map(([t, d], i) => h('li', null, h('span', { 'aria-hidden': 'true' }, String(i + 1)), h('div', null, h('b', null, t), h('span', { class: 'soft' }, d))))),
        UI.callout('info', 'info', 'Честно: такая модель повторит учителя, но не обгонит ни его, ни рынок. Цель — ваш опыт: SFT, LoRA и честная оценка. На ставки она не влияет.'),
        UI.callout('warn', 'alert', 'Ответы Claude в обучающие данные по умолчанию не попадают: условия использования Anthropic ограничивают обучение других моделей на них.')),
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
    settleModal();
  }

  function labPanel() {
    return h('div', { class: 'learning-panel' },
      UI.callout('warn', 'flask', h('b', null, 'Лаборатория — учебная зона. '), 'Результаты отсюда не влияют на ставки, пока эксперимент не обгонит активную стратегию на отложенной выборке по тем же правилам, что и версии стратегии.'),
      datasetCard(),
      h('div', { class: 'row-between' }, h('div', { style: 'min-width:0' }, h('h3', null, 'Эксперименты'), h('p', { class: 'small muted' }, 'Сначала дешёвое и без дообучения, потом — своё обучение LLM'))),
      experiments(),
      h('p', { class: 'learning-doc' }, icon('book'), h('span', null, 'Подробнее в документе ', h('span', { class: 'mono' }, 'LLM_LEARNING.md'), ': как собрать датасет, почему делить по времени, SFT → оценка → RL.')));
  }

  // ---------- регистрация ----------
  UI.register('learning', {
    title: 'Обучение модели',
    render(root, param) {
      const p = param === 'compare' ? 'versions' : param;
      if (p && TABS.some(t => t.id === p)) {
        st.tab = p;
        try { sessionStorage.setItem('capper.learning.tab', p); } catch (e) { /* ок */ }
      }
      tilesSlot = h('div', { class: 'learning-tiles', role: 'group', 'aria-label': 'Что учится сейчас' });
      tabsSlot = h('div', { style: 'min-width:0' }, makeTabs());
      panel = h('div', { class: 'learning-panel', id: 'learning-panel', role: 'tabpanel' });
      drawTiles();
      drawPanel();
      UI.append(root, [
        headBlock(),
        tilesSlot,
        cycleCard(),
        h('section', { class: 'learning-sections', 'aria-label': 'Разделы обучения' }, tabsSlot, panel),
      ]);
      if (param === 'compare') setTimeout(compareModal, 0);
    },
  });
})();
