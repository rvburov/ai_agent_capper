/* Обучение модели (этап 5 «Петля обучения»): как система учится на рассчитанных ставках.
   Цикл «ставка → результат из архива → разбор ИИ → гипотеза → проверка на истории → в анализ по решению»,
   вкладки «Уроки», «Версии стратегии», «Базовая модель» (Эло по покрытиям + калибровка), «Отчеты».
   Решения владельца 15 окт 2026: уроки и инструкции общие, их ведет администратор (В5); урок попадает в анализ
   только по кнопке после быстрой проверки (В4); перекалибровка включается сама, если не хуже (В6); отчет —
   понедельник 07:00 (В8); лаборатории дообучения в приложении нет (В9). Все числа считает сервер (Т15):
   в макете они лежат готовыми в DATA.learning, экран только рисует. */
(function () {
  'use strict';
  const { h, fmt, icon, button, card, chip } = UI;
  const D = DATA, L = DATA.learning, TODAY = DATA.today;

  // ---------- константы и утилиты ----------
  const NEED = L.LESSON_MIN, NEED_PROC = L.LESSON_MIN_PROC, SHRINK_K = L.SHRINK_K, MAX_ON = L.LESSONS_MAX;
  const SET = L.evalSet;
  const MINUS = '−';
  const sgn = (n, s) => (n > 0 ? '+' : n < 0 ? MINUS : '±') + s;
  const signedDec = (n, d = 3) => sgn(Math.round(n * 1e6) / 1e6, fmt.dec(Math.abs(n), d));
  const ciDec = (ci, d = 3) => signedDec(ci[0], d) + '…' + signedDec(ci[1], d);
  const cases = n => fmt.int(n) + ' ' + fmt.plural(n, 'случай', 'случая', 'случаев');
  const dec4 = n => n.toFixed(4).replace('.', ','); // Brier версий модели различается в четвертом знаке
  const hhmm = iso => iso.slice(11, 16);
  const dayTime = iso => fmt.date(iso) + ', ' + hhmm(iso);
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const wday = iso => WD[new Date(iso.slice(0, 10) + 'T12:00:00Z').getUTCDay()];
  const tzCity = () => D.tzCity(D.user.tz);
  const isAdmin = () => UI.auth.isAdmin;
  const E = () => D.ai.eval;
  const evalLeft = () => Math.max(0, Math.round((E().monthly - E().spent) * 100) / 100);

  // ---------- состояние экрана ----------
  const TABS = [
    { id: 'lessons', label: 'Уроки', short: 'Уроки' },
    { id: 'versions', label: 'Версии стратегии', short: 'Версии' },
    { id: 'ml', label: 'Базовая модель', short: 'Модель' },
    { id: 'reports', label: 'Отчеты', short: 'Отчеты' },
  ];
  const st = { tab: 'lessons', filter: 'all', notify: {}, empty: false, recal: null };
  try { const t = sessionStorage.getItem('capper.learning.tab'); if (t && TABS.some(x => x.id === t)) st.tab = t; } catch (e) { /* ок */ }
  let tabsSlot = null, panel = null, tilesSlot = null, root = null;

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
    .learning-train { display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }
    .learning-feat-none { display: none; }
    .learning-demo { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 10px 14px; border: 1px dashed var(--line-strong); border-radius: var(--r-md); font-size: var(--fs-sm); color: var(--fg-2); }
    .learning-demo .segmented { flex: none; }
    .learning-cond { display: flex; flex-wrap: wrap; gap: 4px; min-width: 0; }
    .learning-cond .chip { height: auto; min-height: 22px; white-space: normal; text-align: left; }
    .learning-kind { font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
    .learning-steps li { display: grid; grid-template-columns: 22px minmax(0, 1fr); gap: 8px; align-items: start; font-size: var(--fs-sm); }
    .learning-steps li svg { width: 18px; height: 18px; color: var(--fg-3); margin-top: 1px; }
    .learning-steps li.done svg { color: var(--good-ink); }
    .learning-steps li.run svg { color: var(--accent-ink); }
    .learning-report { display: flex; flex-direction: column; gap: 12px; }
    .learning-rgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0; background: var(--line); border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .learning-rgrid > div { background: var(--surface); padding: 10px 12px; min-width: 0; }
    .learning-rgrid dt { font-size: var(--fs-xs); color: var(--fg-3); }
    .learning-rgrid dd { margin: 2px 0 0; font-weight: 600; font-variant-numeric: tabular-nums; }
    .learning-rgrid dd small { display: block; font-weight: 400; font-size: var(--fs-xs); color: var(--fg-3); }
    @media (max-width: 720px) { .learning-rgrid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
    .learning-rlist { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; }
    .learning-rrow { display: grid; grid-template-columns: minmax(0, 1fr) auto 16px; gap: 4px 12px; align-items: center; width: 100%; min-height: 48px; padding: 10px 14px; background: var(--surface); color: var(--fg); border: 0; border-top: 1px solid var(--line); text-align: left; font: inherit; cursor: pointer; }
    .learning-rrow:first-child { border-top: 0; }
    .learning-rrow:hover { background: var(--surface-2); }
    .learning-rrow > svg { width: 16px; height: 16px; color: var(--fg-3); }
    .learning-rrow b { font-weight: 600; }
    .learning-rrow small { display: block; font-size: var(--fs-xs); color: var(--fg-2); }
    .learning-mlrow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px 12px; align-items: center; padding: 10px 0; border-top: 1px solid var(--line); }
    .learning-mlrow:first-child { border-top: 0; padding-top: 0; }
    .learning-mlrow .mono { font-weight: 600; font-size: var(--fs-sm); overflow-wrap: anywhere; }
  `);

  // ---------- общие кусочки ----------
  const LESSON_STATUS = {
    confirmed: ['Подтвержден', 'good', 'check'], ready: ['Ждет решения', 'accent', 'clock'], hypothesis: ['Гипотеза', 'info', 'flask'],
    rejected: ['Отклонен', 'bad', 'x'], retired: ['Списан', 'outline', 'history'],
  };
  const lessonChip = l => { const [t, k, i] = LESSON_STATUS[l.status] || [l.status, 'outline', 'info']; return chip(t, k, i); };
  const VERSION_STATUS = { active: ['Активная', 'good', 'check'], candidate: ['Кандидат', 'info', 'flask'], archived: ['Архив', 'outline', 'history'], rejected: ['Не включена', 'outline', 'x'] };
  const versionChip = v => { const [t, k, i] = VERSION_STATUS[v.status] || [v.status, 'outline', 'info']; return chip(t, k, i); };
  const verShort = v => v.name.split(' · ').slice(1).join(' · ') || v.name;
  const facts = pairs => h('dl', { class: 'learning-facts' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
  const hint = text => h('p', { class: 'learning-hint' }, icon('info'), h('span', null, text));
  const signedPctEl = v => h('span', { class: v > 0 ? 'good-text' : v < 0 ? 'bad-text' : null }, fmt.signedPct(v));
  const condChips = l => h('div', { class: 'learning-cond' }, (l.cond || []).map(([k, v]) => chip(k + ': ' + v, 'outline')));
  function settleModal() {
    setTimeout(() => {
      const all = document.querySelectorAll('.modal');
      const m = all[all.length - 1];
      if (!m) return;
      m.setAttribute('tabindex', '-1'); m.classList.add('learning-modal'); m.focus({ preventScroll: true }); m.scrollTop = 0;
    }, 60);
  }

  // Данные с учетом демо-переключателя «пустое состояние» (новая установка: ставок и уроков еще нет)
  const lessons = () => (st.empty ? [] : L.lessons);
  const versions = () => (st.empty ? L.versions.filter(v => v.id === 'v3').map(v => Object.assign({}, v, { eval: null })) : L.versions);
  const byStatus = s => lessons().filter(l => l.status === s);
  const inPrompt = () => lessons().filter(l => l.status === 'confirmed' && l.inPrompt);
  const activeV = () => versions().find(v => v.status === 'active');
  const candV = () => versions().find(v => v.status === 'candidate');
  const appSettled = () => (st.empty ? [] : D.bets.filter(b => b.source === 'app' && b.status !== 'open'));
  const activeMl = () => L.mlModels.find(m => m.status === 'active');
  const shrunk = l => Math.round(l.raw * (l.own + (l.hist || 0)) / (l.own + (l.hist || 0) + SHRINK_K));

  // ---------- верх страницы ----------
  function headBlock() {
    const s = appSettled(), auto = s.filter(b => b.settledBy === 'auto').length;
    const legs = s.reduce((a, b) => a + b.legs.length, 0);
    return h('div', { class: 'page-head learning-head' },
      h('div', { style: 'min-width:0' },
        h('h2', null, 'Как модель учится на ставках'),
        h('p', { class: 'lead' }, s.length
          ? 'Рассчитано ' + s.length + ' ' + fmt.plural(s.length, 'ставка', 'ставки', 'ставок') + ' приложения (' + legs + ' ' + fmt.plural(legs, 'событие', 'события', 'событий') + '): ' + auto + ' — сами по архиву tennis-data, остальные — вами. По каждой есть разбор ИИ, из разборов — гипотезы, из проверенных гипотез — уроки.'
          : 'Рассчитанных ставок пока нет. Первые разборы появятся, когда ставки рассчитаются — по архиву tennis-data или вашим вводом.')),
      button('Предложить урок', { kind: 'secondary', icon: 'plus', onClick: proposeLesson }));
  }

  // Только в макете: показать экран новой установки, где ставок, уроков и отчетов еще нет (правка 8)
  function demoBar() {
    return h('div', { class: 'learning-demo', role: 'note' }, h('span', { class: 'demo-pill' }, 'Только в макете'), h('span', { style: 'min-width:0;flex:1 1 200px' }, 'Как экран выглядит в первые недели, пока данных нет:'),
      UI.segmented({ label: 'Состояние экрана', items: [{ id: 'data', label: 'С данными' }, { id: 'empty', label: 'Пусто' }], active: st.empty ? 'empty' : 'data', onChange: id => { st.empty = id === 'empty'; redraw(); } }));
  }

  function tile(o) {
    return h('button', { type: 'button', class: ['learning-tile', st.tab === o.tab && 'is-active'], 'aria-current': st.tab === o.tab ? 'true' : null, 'aria-controls': 'learning-panel', on: { click: () => setTab(o.tab, { rebuildTabs: true, scroll: true }) } },
      h('span', { class: 'learning-tile-label' }, icon(o.icon), h('span', { style: 'min-width:0' }, UI.isMobile() ? o.short : o.label), h('span', { class: 'learning-tile-go' }, icon('chevronRight', { width: 16, height: 16 }))),
      h('span', { class: 'learning-tile-value' }, o.value, h('small', null, o.unit)),
      h('span', { class: 'learning-tile-hint' }, o.hint));
  }
  function drawTiles() {
    if (!tilesSlot) return;
    const act = activeV(), cand = candV(), m = activeMl();
    const hyp = byStatus('hypothesis').length, ready = byStatus('ready').length;
    const rep = st.empty ? null : L.weekReport(L.reportWeeks[0]);
    UI.clear(tilesSlot);
    UI.append(tilesSlot, [
      tile({ tab: 'lessons', icon: 'book', label: 'Уроки в анализе', short: 'Уроки', value: String(inPrompt().length), unit: 'из ' + MAX_ON,
        hint: lessons().length ? (ready ? ready + ' ждет решения · ' : '') + hyp + ' ' + fmt.plural(hyp, 'гипотеза', 'гипотезы', 'гипотез') : 'гипотез пока нет' }),
      tile({ tab: 'versions', icon: 'layers', label: 'Инструкции анализа', short: 'Инструкции', value: act ? act.id : '—', unit: 'активна', hint: cand ? 'кандидат ' + cand.id + ' ждет решения' : 'кандидатов нет' }),
      tile({ tab: 'ml', icon: 'chart', label: 'Базовая модель', short: 'Модель', value: fmt.dec(m.brier, 3), unit: 'Brier', hint: (m.auto ? 'перекалибрована сама ' : 'включена ') + fmt.date(m.at) }),
      tile({ tab: 'reports', icon: 'calendar', label: 'Отчет недели', short: 'Отчеты', value: rep ? fmt.date(rep.from) + '–' + fmt.date(rep.to).split(' ')[0] : '—', unit: rep ? fmt.date(rep.to).split(' ')[1] : '',
        hint: 'следующий — ' + wday(L.nextReport) + ' ' + fmt.date(L.nextReport) + ', 07:00' }),
    ]);
  }

  const STEPS = [
    { ic: 'ticket', t: 'Ставка', d: 'Экспресс с вероятностями базовой модели и Claude, досье замораживается', who: 'вы + ИИ', whoIc: 'user' },
    { ic: 'database', t: 'Результат из архива', d: 'Файл tennis-data раз в неделю: исход, счет и закрытие П1/П2. Не ждете — вносите сами', who: 'код · до 7 дней', whoIc: 'bolt' },
    { ic: 'search', t: 'Разбор ставки', d: 'Что произошло: невезение, ошибка модели или не хватило данных. Один разбор на матч', who: 'Sonnet 5.5 · Batch · ≈ $0,01', whoIc: 'spark' },
    { ic: 'book', t: 'Гипотеза', d: 'Короткое правило и условие из словаря признаков — его проверяет код', who: 'Claude + код', whoIc: 'spark' },
    { ic: 'flask', t: 'Проверка на истории', d: 'С ' + NEED + ' своих случаев: с уроком и без на архиве, 95% ДИ, отложенная часть, усадка', who: 'код, бесплатно', whoIc: 'bolt' },
    { ic: 'brain', t: 'В инструкции анализа', d: 'Быстрая проверка на 40 матчах (≈ $0,60) и решение. Раз в месяц — перепроверка', who: 'администратор', whoIc: 'user' },
  ];
  function cycleCard() {
    const list = h('ol', { class: 'learning-cycle', 'aria-label': 'Цикл обучения, 6 шагов' }, STEPS.map((s, i) => h('li', { class: 'learning-step' },
      h('div', { class: 'learning-step-mark' }, h('span', { class: 'learning-step-num', 'aria-hidden': 'true' }, String(i + 1)), icon(s.ic)),
      h('div', { class: 'learning-step-body' }, h('h4', null, h('span', { class: 'sr-only' }, 'Шаг ' + (i + 1) + '. '), s.t), h('p', null, s.d), chip(s.who, 'outline', s.whoIc)),
      i < STEPS.length - 1 && h('span', { class: 'learning-step-arrow', 'aria-hidden': 'true' }, icon('arrowRight')))));
    const loop = h('div', { class: 'learning-loop' }, h('span', { class: 'learning-loop-label' }, icon('refresh'), h('span', null, h('b', null, 'Следующая ставка'), ' — анализ уже с учетом урока')));
    return card({
      class: 'learning-card', title: 'Как модель учится',
      subtitle: 'Один цикл на каждую рассчитанную ставку — и выигранную, и проигранную',
      body: [
        list, loop,
        UI.callout('info', 'info', h('b', null, 'Веса Claude не меняются. '), 'Учатся четыре вещи: уроки и версии инструкций анализа — общие для всех, их ведет администратор; правила суммы ставки — у каждого участника свои; базовая модель — перекалибровка по понедельникам. Поправку к вероятности числом в коде включим после ' + L.C_MIN + ' событий с исходами.'),
        h('p', { class: 'learning-doc' }, icon('clock'), h('span', null, 'Результаты приходят файлом tennis-data раз в неделю: от матча до разбора может пройти до 7 дней. Внесете результат сами — разбор будет в течение нескольких часов.')),
      ],
    });
  }

  // ---------- вкладки ----------
  function makeTabs() {
    const m = UI.isMobile();
    const el = UI.tabs({ items: TABS.map(t => ({ id: t.id, label: m ? t.short : t.label + (t.id === 'lessons' && lessons().length ? ' · ' + lessons().length : '') })), active: st.tab, onChange: id => setTab(id) });
    el.classList.add('learning-tabs');
    el.setAttribute('aria-label', 'Разделы обучения');
    return el;
  }
  function setTab(id, o = {}) {
    st.tab = id;
    try { sessionStorage.setItem('capper.learning.tab', id); } catch (e) { /* ок */ }
    try { history.replaceState(null, '', '#learning-' + id); } catch (e) { /* ок */ }
    if (o.rebuildTabs && tabsSlot) UI.clear(tabsSlot).appendChild(makeTabs());
    drawPanel(); drawTiles();
    if (o.scroll && tabsSlot) tabsSlot.parentElement.scrollIntoView({ block: 'start' });
  }
  function drawPanel() {
    if (!panel) return;
    UI.hideTip();
    UI.clear(panel);
    const t = TABS.find(x => x.id === st.tab) || TABS[0];
    panel.setAttribute('aria-label', t.label);
    UI.append(panel, [{ lessons: lessonsPanel, versions: versionsPanel, ml: mlPanel, reports: reportsPanel }[t.id]()]);
  }
  function redraw() { if (root) { const y = window.scrollY; build(); window.scrollTo(0, y); } }

  // ---------- 1. Уроки ----------
  const FILTERS = [
    { id: 'all', label: 'Все', test: () => true },
    { id: 'confirmed', label: 'Подтверждены', test: l => l.status === 'confirmed' },
    { id: 'ready', label: 'Ждут решения', test: l => l.status === 'ready' },
    { id: 'hypothesis', label: 'Гипотезы', test: l => l.status === 'hypothesis' },
    { id: 'off', label: 'Отклонены', test: l => l.status === 'rejected' || l.status === 'retired' },
  ];
  function lessonsPanel() {
    const order = { ready: 0, confirmed: 1, hypothesis: 2, rejected: 3, retired: 4 };
    const list = h('div', { class: 'learning-lessons', 'aria-live': 'polite' });
    function drawList() {
      UI.clear(list);
      const f = FILTERS.find(x => x.id === st.filter) || FILTERS[0];
      const rows = lessons().filter(f.test).slice().sort((a, b) => (order[a.status] - order[b.status]) || b.created.localeCompare(a.created));
      if (!rows.length) {
        list.appendChild(UI.empty(lessons().length ? 'В этой группе уроков нет' : 'Уроков пока нет. Гипотезы появятся из разборов рассчитанных ставок, а проверка урока начинается с ' + NEED + ' своих случаев — при 1–2 ставках в день это несколько недель.'));
        return;
      }
      rows.forEach(l => list.appendChild(lessonItem(l)));
    }
    drawList();
    const filter = UI.segmented({ label: 'Какие уроки показать', items: FILTERS.map(f => ({ id: f.id, label: f.label + ' · ' + lessons().filter(f.test).length })), active: st.filter, onChange: id => { st.filter = id; drawList(); } });
    filter.classList.add('learning-filter');
    return card({
      class: 'learning-card', title: 'Уроки',
      subtitle: 'Общие для всех участников, ведет администратор. В анализ попадают только подтвержденные — не больше ' + MAX_ON + ', сейчас ' + inPrompt().length + '.',
      actions: [isAdmin() ? null : chip('Ведет администратор', 'outline', 'admin'), button('Предложить урок', { kind: 'secondary', size: 'sm', icon: 'plus', onClick: proposeLesson })].filter(Boolean),
      body: [
        filter, list,
        hint('Эффект — насколько хуже прогноз без урока, с 95% ДИ, на архиве матчей (прогнозы базовой модели вне выборки обучения). Урок про вероятность проверяется с ' + NEED + ' своих случаев и применяется с усадкой: чем меньше случаев, тем меньше поправка. Урок про сбор данных принимается, если прогноз не хуже хотя бы на ' + NEED_PROC + ' случаях. Раз в месяц каждый урок перепроверяется на новых матчах.'),
      ],
    });
  }

  function lessonItem(l) {
    const off = l.status === 'confirmed' && !l.inPrompt;
    const numeric = l.kind === 'numeric';
    const main = h('div', { class: 'learning-lesson-main' },
      h('div', { class: 'learning-lesson-head' },
        h('span', { class: 'chip outline mono' }, l.id), lessonChip(l),
        l.manual && chip('Предложен вручную', 'outline', 'user'),
        h('span', { class: 'learning-kind' }, numeric ? 'про вероятность' : 'про сбор данных'),
        h('span', { class: 'learning-date' }, 'с ' + fmt.date(l.created))),
      h('p', { class: 'learning-lesson-text' }, l.text),
      condChips(l),
      h('dl', { class: 'learning-meta' },
        l.status !== 'hypothesis' && h('div', null, h('dt', null, 'Основание'), h('dd', { class: 'num' }, cases(l.own) + (l.hist ? ' + ' + fmt.int(l.hist) + ' из архива' : ''))),
        l.ci && h('div', null, h('dt', null, 'Эффект'), h('dd', null, l.metric + ' ' + fmt.dec(l.with, 3) + ' с уроком, ' + fmt.dec(l.without, 3) + ' без · ДИ ' + ciDec(l.ci))),
        l.saving && h('div', null, h('dt', null, 'Выигрыш'), h('dd', null, l.saving)),
        numeric && l.raw && (l.status === 'confirmed' || l.status === 'ready') && h('div', null, h('dt', null, 'Поправка'), h('dd', null, MINUS + shrunk(l) + ' п.п. с усадкой (сырая ' + l.raw + ')'))));

    const side = h('div', { class: 'learning-lesson-side' });
    if (l.status === 'confirmed') {
      if (isAdmin()) {
        const tg = UI.toggle({
          id: 'learning-use-' + l.id, label: 'Использовать в анализе', checked: l.inPrompt,
          hint: l.inPrompt ? 'В инструкциях с ' + fmt.date(l.decided) : 'Выключен — анализ его не видит',
          onChange: v => {
            if (v) { tg.querySelector('input').checked = false; enableModal(l); return; }
            l.inPrompt = false; item.replaceWith(lessonItem(l)); drawTiles();
            UI.toast('Урок ' + l.id + ' выключен — следующий анализ пройдет без него. Включить снова — с быстрой проверкой', 'eyeOff');
          },
        });
        side.appendChild(tg);
      } else side.appendChild(l.inPrompt ? chip('В инструкциях анализа', 'good', 'book') : chip('Выключен администратором', 'outline', 'eyeOff'));
    } else if (l.status === 'ready') {
      side.appendChild(h('p', { class: 'small soft', style: 'margin:0' }, 'Подтвержден на истории ' + fmt.date(l.readyAt) + '. В анализ — после быстрой проверки на 40 матчах и решения администратора.'));
      side.appendChild(isAdmin() ? button('Использовать в анализе', { kind: 'primary', size: 'sm', icon: 'check', onClick: () => enableModal(l) }) : chip('Ждет решения администратора', 'outline', 'admin'));
    } else if (l.status === 'hypothesis') {
      side.appendChild(h('div', { class: 'learning-progress' },
        h('div', { class: 'row-between' }, h('span', { class: 'soft' }, 'Своих случаев'), h('b', { class: 'num' }, l.own + ' из ' + NEED)),
        UI.meter(l.own, NEED), h('span', { class: 'xsmall muted' }, 'Пока не влияет на прогнозы')));
      if (st.notify[l.id]) side.appendChild(chip('Сообщим при ' + NEED + ' случаях', 'info', 'bell'));
      else side.appendChild(button('Сообщить, когда наберется', { kind: 'secondary', size: 'sm', icon: 'bell', onClick: () => { st.notify[l.id] = true; item.replaceWith(lessonItem(l)); UI.toast('Сообщим в центре уведомлений, когда у ' + l.id + ' будет ' + NEED + ' случаев и пройдет проверка на истории', 'bell'); } }));
    } else if (l.status === 'rejected') {
      side.appendChild(h('p', { class: 'small soft', style: 'margin:0' }, 'С уроком прогноз хуже: ' + l.metric.toLowerCase() + ' ' + fmt.dec(l.with, 3) + ' против ' + fmt.dec(l.without, 3) + '. В анализ не попадает, похожие формулировки Claude больше не предлагает.'));
    } else {
      side.appendChild(h('p', { class: 'small soft', style: 'margin:0' }, 'Списан ' + fmt.date(l.retired) + ' при ежемесячной перепроверке: на новых матчах эффект пропал (ДИ ' + ciDec(l.ci) + ' задевает ноль).'));
    }
    side.appendChild(button('Подробнее', { kind: 'ghost', size: 'sm', iconRight: 'chevronRight', onClick: () => lessonModal(l) }));
    const item = h('article', { class: ['learning-lesson', 'is-' + (l.status === 'ready' ? 'confirmed' : l.status === 'retired' ? 'rejected' : l.status), off && 'is-off'], 'aria-label': 'Урок ' + l.id }, main, side);
    return item;
  }

  function lessonModal(l) {
    const own = (l.ownBets || []).filter(id => D.bets.some(b => b.id === id));
    const numeric = l.kind === 'numeric';
    UI.modal({
      title: 'Урок ' + l.id,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('div', { class: 'row' }, lessonChip(l), l.status === 'confirmed' && (l.inPrompt ? chip('В инструкциях анализа', 'accent', 'book') : chip('Выключен', 'outline', 'eyeOff'))),
        h('blockquote', { class: 'learning-quote' }, l.text),
        facts([
          ['Откуда', 'Разборы рассчитанных ставок: Claude предложил гипотезу и условие из словаря признаков'],
          own.length && ['Ваши ставки в основании', own.map(id => '№' + id).join(', ') + ' — видны только вам'],
          ['Тип урока', numeric ? 'Про вероятность — нужна проверка на архиве с 95% ДИ' : 'Про сбор данных — вероятность не меняет'],
          ['Основание', cases(l.own) + ' своих' + (l.hist ? ' + ' + fmt.int(l.hist) + ' из архива' : '') + (l.status === 'hypothesis' ? ' · нужно ' + NEED : '')],
          l.ci && ['Проверка на архиве', l.metric + ' с уроком ' + fmt.dec(l.with, 3) + ', без урока ' + fmt.dec(l.without, 3) + ' · 95% ДИ разницы ' + ciDec(l.ci)],
          l.holdout && ['Отложенная часть', l.holdout],
          l.saving && ['Выигрыш', l.saving],
          numeric && l.raw && ['Поправка в анализе', MINUS + shrunk(l) + ' п.п. — с усадкой к нулю: ' + l.raw + ' × ' + fmt.int(l.own + (l.hist || 0)) + ' / (' + fmt.int(l.own + (l.hist || 0)) + ' + ' + SHRINK_K + ')'],
          l.rechecked && ['Перепроверка', 'раз в месяц, последняя ' + fmt.date(l.rechecked) + ' — держится'],
        ]),
        h('div', { class: 'stack', style: 'gap:6px' },
          h('div', { class: 'eyebrow' }, 'Условие из словаря — его проверяет код'),
          h('pre', { class: 'learning-code' }, (l.cond || []).map(([k, v]) => k + ': ' + v).join('\n'))),
        UI.callout('', 'shield', 'Claude не пишет SQL и не трогает базу: условие собирается из словаря признаков, запрос строит код и выполняет с правами только на чтение. Признаки — только до даты матча.')),
      actions: close => [button('Закрыть', { kind: 'secondary', onClick: close })],
    });
    settleModal();
  }

  // В4: урок попадает в инструкции только по кнопке администратора и после быстрой проверки на 40 матчах набора
  function enableModal(l) {
    if (inPrompt().length >= MAX_ON) { UI.toast('В анализе уже ' + MAX_ON + ' уроков — сначала выключите один', 'alert'); return; }
    const before = E().spent;
    UI.modal({
      title: 'Урок ' + l.id + ' в анализ',
      body: close => {
        const box = h('div', { class: 'stack', style: 'gap:14px' });
        const stepsEl = h('ol', { class: 'learning-steps' });
        const foot = h('div', { class: 'row' });
        const step = (state, text) => h('li', { class: state }, icon(state === 'done' ? 'check' : state === 'run' ? 'refresh' : 'clock'), h('span', null, text));
        function intro() {
          UI.clear(stepsEl); UI.clear(foot);
          UI.append(stepsEl, [
            step('wait', 'Быстрая проверка: 40 матчей набора ' + SET.code + ' с уроком и без, Opus 5.5 через Batch'),
            step('wait', 'Код сравнивает лог-лосс и ошибки формата: урок не должен ухудшать прогноз'),
            step('wait', 'Если не хуже — урок входит в инструкции анализа со следующего анализа, для всех участников'),
          ]);
          UI.append(foot, [
            button('Отмена', { kind: 'secondary', onClick: close }),
            button('Запустить проверку · ≈ ' + fmt.usd(E().quickCheck), { kind: 'primary', icon: 'play', onClick: run }),
          ]);
        }
        function run() {
          UI.clear(stepsEl); UI.clear(foot);
          UI.append(stepsEl, [step('run', 'Пакет отправлен: 40 запросов, ждем ответ Batch…'), step('wait', 'Сравнение с уроком и без'), step('wait', 'Решение')]);
          setTimeout(() => {
            if (!box.isConnected) return;
            E().runs.push({ at: TODAY + 'T10:12', kind: 'quick', events: 40, what: 'Быстрая проверка урока ' + l.id + ': 40 матчей набора ' + SET.code, cost: 0.61, worst: 4.4 });
            E().spent = Math.round((before + 0.61) * 100) / 100;
            UI.clear(stepsEl); UI.clear(foot);
            UI.append(stepsEl, [
              step('done', 'Проверено на 40 матчах · потрачено $0,61 из бюджета проверок'),
              step('done', 'Лог-лосс с уроком ' + signedDec(-0.004) + ' к без урока (95% ДИ ' + ciDec([-0.012, 0.005]) + '), ошибок формата 0 — не хуже'),
              step('run', 'Ждет вашего решения'),
            ]);
            UI.append(foot, [
              button('Не включать', { kind: 'secondary', onClick: () => { close(); UI.toast('Урок ' + l.id + ' остается в «Ждут решения»', 'clock'); } }),
              button('Включить в инструкции', { kind: 'primary', icon: 'check', onClick: () => {
                l.status = 'confirmed'; l.inPrompt = true; l.decided = TODAY;
                close(); drawPanel(); drawTiles();
                UI.toast('Урок ' + l.id + ' в инструкциях со следующего анализа · уроков в анализе ' + inPrompt().length + ' из ' + MAX_ON, 'check');
              } }),
            ]);
          }, 1400);
        }
        intro();
        UI.append(box, [
          h('blockquote', { class: 'learning-quote' }, l.text),
          UI.kv([['Бюджет проверок', fmt.usd(E().spent) + ' из ' + fmt.usd(E().monthly, 0) + ' · остаток ' + fmt.usd(evalLeft())], ['Худший случай', '≈ $4,40 — 40 × $0,11'], ['Уроков в анализе', inPrompt().length + ' из ' + MAX_ON]]),
          stepsEl,
          UI.callout('info', 'info', 'Урок общий: войдет в анализы всех участников, поэтому решение — за администратором. Это меняет версию инструкций (уроки — часть промпта), поэтому повтор оценки Claude для старых досье не используется.'),
          foot]);
        return box;
      },
    });
    settleModal();
  }

  // Ручная гипотеза: условие — только из словаря признаков, проверка — та же, что у гипотез из разборов
  function proposeLesson() {
    const COND = [
      { value: '', label: 'Без дополнительного условия' },
      { value: 'elo', label: 'Разница Эло на покрытии меньше…' },
      { value: 'sets48', label: 'Сетов за 48 часов не меньше…' },
      { value: 'rest', label: 'Дней с последнего матча не меньше…' },
      { value: 'dog', label: 'Кэф аутсайдера на победу не меньше…' },
    ];
    UI.modal({
      title: 'Предложить урок',
      body: close => {
        const err = h('div', { class: 'field-error', role: 'alert', hidden: true }, 'Опишите наблюдение хотя бы одной фразой — иначе его нечем проверить');
        const textField = UI.field({ id: 'learning-lesson-text', label: 'Что вы заметили', rows: 3, placeholder: 'Например: на грунте аутсайдер с кэфом 2.60+ берет сет чаще, чем дает модель', hint: 'Одно наблюдение — одно правило.' });
        textField.appendChild(err);
        const ta = textField.querySelector('textarea');
        ta.addEventListener('input', () => { if (ta.value.trim().length >= 10) { err.hidden = true; ta.classList.remove('learning-invalid'); ta.removeAttribute('aria-invalid'); } });
        const valF = UI.field({ id: 'learning-lesson-val', label: 'Значение', inputmode: 'decimal', placeholder: '120', attrs: { autocomplete: 'off', disabled: true } });
        const condF = UI.field({ id: 'learning-lesson-cond', label: 'Признак из словаря', options: COND });
        condF.querySelector('select').addEventListener('change', e => { valF.querySelector('input').disabled = !e.target.value; });
        const form = h('form', { id: 'learning-lesson-form', class: 'stack', style: 'gap:14px', novalidate: true },
          textField,
          h('div', { class: 'learning-form-2' },
            UI.field({ id: 'learning-lesson-market', label: 'Рынок', options: ['Любой', 'П1 / П2', 'Фора −1.5', 'Фора +1.5', 'Фора по сетам ±2.5', 'Тотал сетов', 'Фора по геймам', 'Тотал геймов'] }),
            UI.field({ id: 'learning-lesson-surface', label: 'Покрытие', options: ['Все покрытия', 'Хард', 'Грунт', 'Трава', 'Крытый хард'] })),
          h('div', { class: 'learning-form-2' }, condF, valF),
          UI.callout('info', 'flask', 'Условие собирается из словаря — так его можно проверить на архиве. Урок проходит ту же проверку, что и гипотезы из разборов: ' + NEED + ' своих случаев, архив с 95% ДИ, затем быстрая проверка и решение администратора.'));
        form.addEventListener('submit', e => {
          e.preventDefault();
          const text = ta.value.trim();
          if (text.length < 10) { err.hidden = false; ta.classList.add('learning-invalid'); ta.setAttribute('aria-invalid', 'true'); ta.focus(); return; }
          const market = form.querySelector('#learning-lesson-market').value, surface = form.querySelector('#learning-lesson-surface').value;
          const cv = form.querySelector('#learning-lesson-cond').value, val = form.querySelector('#learning-lesson-val').value.trim();
          const cond = [['рынок', market.toLowerCase()], ['покрытие', surface.toLowerCase()]];
          if (cv) cond.push([COND.find(c => c.value === cv).label.replace('…', '').toLowerCase(), val || '—']);
          const n = Math.max(0, ...L.lessons.map(x => parseInt(x.id.slice(2), 10) || 0)) + 1;
          const id = 'L-' + String(n).padStart(3, '0');
          L.lessons.push({ id, kind: 'numeric', status: 'hypothesis', inPrompt: false, created: TODAY, manual: true, text: text.replace(/\s+/g, ' '), scope: market + ' · ' + surface.toLowerCase(), cond, own: 0, ownBets: [] });
          close();
          st.filter = 'all'; st.empty = false;
          redraw();
          UI.toast('Урок ' + id + ' добавлен как гипотеза — код начнет копить случаи и сразу посчитает эффект на архиве', 'flask');
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
  // Инструкции анализа — общая линия (В5). Правила суммы ставки — у каждого свои (кабинет → «Банк и стратегия»)
  function versionsPanel() {
    const mobile = UI.isMobile();
    const V = versions().slice().reverse();
    const A = activeV(), B = candV();
    const ev = v => v.eval;
    const llCell = v => (ev(v) ? h('span', null, fmt.dec(ev(v).logloss, 3), h('span', { class: 'xsmall muted' }, ' · ' + ev(v).runs + ' ' + fmt.plural(ev(v).runs, 'прогон', 'прогона', 'прогонов'))) : h('span', { class: 'muted' }, st.empty ? 'не считалась' : 'до набора'));
    const mkCell = v => (ev(v) ? h('div', null, h('div', null, signedDec(ev(v).logloss - SET.marketLL)), h('div', { class: 'xsmall muted', style: 'white-space:nowrap' }, 'ДИ ' + ciDec(ev(v).toMarket))) : h('span', { class: 'muted' }, '—'));
    const actions = isAdmin()
      ? [A && B && button('Сравнить ' + A.id + ' и ' + B.id, { kind: 'primary', size: 'sm', icon: 'layers', onClick: compareModal }), button('Оценить на наборе', { kind: 'secondary', size: 'sm', icon: 'play', disabled: st.empty, onClick: evalModal })].filter(Boolean)
      : [chip('Ведет администратор', 'outline', 'admin'), A && B && button('Сравнить ' + A.id + ' и ' + B.id, { kind: 'secondary', size: 'sm', icon: 'layers', onClick: compareModal })].filter(Boolean);
    let listNode;
    if (mobile) {
      listNode = h('div', { class: 'learning-vcards' }, V.map(v => h('button', { type: 'button', class: 'learning-vcard', 'aria-label': 'Версия ' + v.name + ', подробнее', on: { click: () => versionModal(v) } },
        h('div', { class: 'learning-vcard-head' }, h('div', null, h('div', { class: 'learning-ver-name' }, h('b', { class: 'mono' }, v.id), h('span', { class: 'xsmall muted' }, fmt.date(v.date))), h('div', { class: 'small soft' }, verShort(v))), versionChip(v)),
        ev(v) && h('dl', { class: 'learning-vgrid' },
          h('div', null, h('dt', null, 'Лог-лосс'), h('dd', null, fmt.dec(ev(v).logloss, 3))),
          h('div', null, h('dt', null, 'К рынку'), h('dd', null, signedDec(ev(v).logloss - SET.marketLL))),
          h('div', null, h('dt', null, 'Brier'), h('dd', null, fmt.dec(ev(v).brier, 3))),
          h('div', null, h('dt', null, 'Токенов'), h('dd', null, '≈ ' + v.tokens + ' тыс.'))))));
    } else {
      listNode = UI.table({
        columns: [
          { label: 'Версия', render: v => h('div', { class: 'learning-ver-name' }, h('b', null, v.id), h('span', { class: 'soft' }, verShort(v))) },
          { label: 'Дата', render: v => fmt.date(v.date) },
          { label: 'Лог-лосс', align: 'r', render: llCell },
          { label: 'К рынку, 95% ДИ', align: 'r', render: mkCell },
          { label: 'Brier', align: 'r', render: v => (ev(v) ? fmt.dec(ev(v).brier, 3) : '—') },
          { label: 'Токенов на анализ', align: 'r', render: v => (v.tokens ? '≈ ' + v.tokens + ' тыс.' : '—') },
          { label: 'Статус', render: versionChip },
        ],
        rows: V, onRowClick: versionModal,
      });
    }
    const setNote = st.empty
      ? UI.callout('warn', 'database', h('b', null, 'Набор для проверки версий еще не заморожен. '), 'Нужно 200–300 сыгранных матчей после 1 августа 2026 (позже среза знаний модели) — они берутся из архива tennis-data. ' + (isAdmin() ? 'Загрузите свежий файл и заморозьте набор: список матчей и его sha256 больше не меняются.' : 'Это делает администратор.'))
      : null;
    const tableCard = card({
      class: 'learning-card', title: 'Инструкции анализа',
      subtitle: st.empty ? 'Общие для всех участников. Пока одна версия — v3' : 'Общие для всех участников. С v3 версии проверяются на замороженном наборе ' + SET.code + ': ' + SET.n + ' матчей после ' + fmt.date(SET.since) + ' (позже среза знаний модели), ' + SET.hard + ' трудных, без новостей · sha256 ' + SET.sha,
      actions, flush: !mobile && !st.empty,
      body: st.empty ? [setNote, isAdmin() ? button('Заморозить набор', { kind: 'secondary', size: 'sm', icon: 'lock', onClick: () => UI.toast('В макете: после загрузки файла набор из 250 матчей замораживается одной кнопкой', 'lock') }) : null] : listNode,
      foot: st.empty ? null : hint('Рынок — по кэфам архива tennis-data без маржи (лог-лосс ' + fmt.dec(SET.marketLL, 3) + '), момент снятия кэфов не проверен. Два прогона v3 разошлись на ' + fmt.dec(A && A.eval ? A.eval.noise : 0.003, 3) + ' — разница меньше этого порога считается шумом. ROI и CLV версии по 250 матчам не считаем: они шумные и зависят от суммы ставок.'),
    });
    return h('div', { class: 'learning-panel' }, tableCard, h('div', { class: 'learning-two wide-left' }, rulesCard(), stakeRulesCard()));
  }

  function rulesCard() {
    const B = candV();
    const pending = B && B.cmp;
    const rule = (n, title, text, status) => h('li', null, h('span', { 'aria-hidden': 'true' }, String(n)), h('div', null, title && h('b', null, title), h('span', null, text), status));
    return card({
      class: 'learning-card', title: 'Как принимается новая версия',
      subtitle: pending ? 'Кандидат ' + B.id + ' сделан ради экономии — его проверяют по правилу 3' : 'Правила для следующих кандидатов',
      body: [
        h('ol', { class: 'learning-rules' },
          rule(1, null, 'Текущую версию прогоняем на наборе дважды — так виден обычный разброс; кандидата — один раз. Пакетами до 100 событий, чтобы худший случай помещался в бюджет проверок.', pending && chip('Выполнено: v3 × 2, ' + B.id + ' × 1', 'good', 'check')),
          rule(2, 'Если версия должна улучшить прогноз', '95% ДИ разницы лог-лосса (новая − текущая) целиком ниже нуля.', pending && chip('К ' + B.id + ' не относится', 'outline', 'info')),
          rule(3, 'Если версия нужна ради экономии', 'Верхняя граница 95% ДИ разницы лог-лосса ≤ +0,01, Brier ≤ +0,005, калибровки (ECE) ≤ +2 п.п., ошибок формата не больше, токенов меньше.',
            pending && h('div', { class: 'learning-chips' }, ['Лог-лосс: до ' + signedDec(B.cmp.dLL[2]), 'Brier: до ' + signedDec(B.cmp.dBrier[2]), 'ECE: до +' + fmt.dec(B.cmp.dEce[2], 1) + ' п.п.', 'Ошибок формата: ' + B.eval.fmtErr, 'Токенов ' + fmt.signedPct(B.cmp.tokens, 0)].map(t => chip(t, 'good', 'check')))),
          rule(4, null, 'Ни одна версия не включается сама: кнопка у администратора, откат — в один клик. Кандидат после проверки остается кандидатом.', null)),
      ],
    });
  }

  // Правила суммы ставки — свои у каждого (В5): кандидат создается в кабинете и включается здесь или там
  function stakeRulesCard() {
    const R = L.ruleVersions.slice().reverse();
    return card({
      class: 'learning-card', title: 'Ваши правила суммы ставки',
      subtitle: 'У каждого участника свои. Меняются новой версией: кандидат → проверка на ваших ставках → включить',
      actions: [button('Предложить изменение', { kind: 'secondary', size: 'sm', icon: 'edit', href: '#profile-bank' })],
      body: h('div', { class: 'stack', style: 'gap:0' }, R.map(v => h('div', { class: 'learning-mlrow' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'learning-ver-name' }, h('b', { class: 'mono' }, v.id), h('span', { class: 'soft small' }, verShort(v))), h('div', { class: 'xsmall muted' }, fmt.date(v.date) + ' · ' + v.changes.join('; '))),
        h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' }, versionChip(v),
          v.status === 'candidate' && button('Включить', { kind: 'primary', size: 'sm', icon: 'check', href: '#profile-bank', title: 'Включается в «Банк и стратегия» — там видно проверку на ваших ставках' }))))),
    });
  }

  function compareModal() {
    const A = activeV(), B = candV();
    if (!A || !B || !B.cmp) return;
    const c = B.cmp;
    const OK = t => [t, 'good', 'check'];
    const rows = [
      { k: 'Лог-лосс', a: fmt.dec(A.eval.logloss, 3), b: fmt.dec(B.eval.logloss, 3), d: signedDec(c.dLL[0]), ci: '95% ДИ ' + ciDec([c.dLL[1], c.dLL[2]]), tol: 'допуск до +0,01', v: OK('не хуже') },
      { k: 'Brier', a: fmt.dec(A.eval.brier, 3), b: fmt.dec(B.eval.brier, 3), d: signedDec(c.dBrier[0]), ci: '95% ДИ ' + ciDec([c.dBrier[1], c.dBrier[2]]), tol: 'допуск до +0,005', v: OK('не хуже') },
      { k: 'Калибровка (ECE)', a: fmt.pct(A.eval.ece), b: fmt.pct(B.eval.ece), d: '+' + fmt.dec(c.dEce[0], 1) + ' п.п.', ci: '95% ДИ ' + fmt.dec(c.dEce[1], 1).replace('-', MINUS) + '…+' + fmt.dec(c.dEce[2], 1) + ' п.п.', tol: 'допуск до +2 п.п.', v: OK('не хуже') },
      { k: 'Ошибок формата', a: A.eval.fmtErr + ' из ' + SET.n, b: B.eval.fmtErr + ' из ' + SET.n, d: String(B.eval.fmtErr - A.eval.fmtErr).replace('-', MINUS), v: OK('не больше') },
      { k: 'Токенов на анализ', a: '≈ ' + A.tokens + ' тыс.', b: '≈ ' + B.tokens + ' тыс.', d: fmt.signedPct(c.tokens, 0), ci: 'по логам запусков', v: OK('дешевле') },
    ];
    const verdict = r => chip(r.v[0], r.v[1], r.v[2]);
    const cmp = UI.isMobile()
      ? h('div', { class: 'learning-cmp-list' }, rows.map(r => h('div', { class: 'learning-cmp-item' },
          h('div', { class: 'learning-cmp-top' }, h('b', null, r.k), verdict(r)),
          h('div', { class: 'small num' }, A.id + ' ' + r.a + ' → ' + B.id + ' ' + r.b + ' · разница ' + r.d),
          r.ci && h('div', { class: 'xsmall muted' }, r.ci + (r.tol ? ' · ' + r.tol : '')))))
      : UI.table({
          columns: [
            { label: 'Показатель', render: r => h('b', { style: 'font-weight:600' }, r.k) },
            { label: A.id + ' · активная', align: 'r', render: r => r.a },
            { label: B.id + ' · кандидат', align: 'r', render: r => r.b },
            { label: 'Разница', align: 'r', render: r => h('div', null, h('div', null, r.d), [r.ci, r.tol].filter(Boolean).map(t => h('div', { class: 'xsmall muted', style: 'white-space:nowrap' }, t))) },
            { label: 'Вывод', render: verdict },
          ],
          rows,
        });
    UI.modal({
      title: 'Сравнение ' + A.id + ' и ' + B.id, wide: true,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('p', { class: 'small soft' }, 'Обе версии посчитаны на одних и тех же ' + SET.n + ' матчах набора ' + SET.code + '. Разницы и ДИ — парный бутстрэп по дням (B = 10 000, seed 2026). ' + B.id + ' сделана ради экономии, поэтому правило — «не хуже с допуском».'),
        cmp,
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Что изменилось в ' + B.id), h('ul', { class: 'learning-changes' }, B.changes.map(x => h('li', null, x)))),
        UI.callout('good', 'check', h('b', null, 'Вывод кода: '), B.id + ' проходит правило экономии — качество не хуже в пределах допуска, анализ дешевле на ' + Math.abs(c.tokens) + '%. Точнее ' + A.id + ' она не стала: ДИ разницы захватывает ноль.'),
        !isAdmin() && UI.callout('', 'admin', 'Инструкции общие для всех участников — включает версию администратор.')),
      actions: close => isAdmin()
        ? [button('Оставить ' + A.id, { kind: 'secondary', onClick: () => { close(); UI.toast('Остается ' + A.id + '. ' + B.id + ' остается кандидатом — включить можно в любой момент', 'clock'); } }),
           button('Включить ' + B.id, { kind: 'primary', icon: 'check', onClick: () => { B.status = 'active'; A.status = 'archived'; A.rollbackTo = true; close(); drawPanel(); drawTiles(); UI.toast(B.id + ' работает со следующего анализа у всех участников · ' + A.id + ' в архиве, откат в один клик', 'check'); } })]
        : [button('Закрыть', { kind: 'primary', onClick: close })],
    });
    settleModal();
  }

  function versionModal(v) {
    const A = activeV();
    UI.modal({
      title: 'Версия ' + v.name,
      body: h('div', { class: 'stack', style: 'gap:14px' },
        h('div', { class: 'row' }, versionChip(v), h('span', { class: 'small muted' }, 'создана ' + fmt.dateFull(v.date))),
        v.eval ? facts([
          ['Лог-лосс', fmt.dec(v.eval.logloss, 3) + ' · рынок ' + fmt.dec(SET.marketLL, 3) + ' · разница ' + signedDec(v.eval.logloss - SET.marketLL) + ' (95% ДИ ' + ciDec(v.eval.toMarket) + ') — в пределах шума'],
          ['Brier', fmt.dec(v.eval.brier, 3)], ['Калибровка (ECE)', fmt.pct(v.eval.ece)], ['Ошибок формата', v.eval.fmtErr + ' из ' + SET.n],
          ['Прогонов на наборе', String(v.eval.runs)], v.tokens && ['Токенов на анализ', '≈ ' + v.tokens + ' тыс.'],
        ]) : h('p', { class: 'small soft' }, 'Версия старше замороженного набора — на нем не считалась.'),
        h('div', { class: 'stack', style: 'gap:6px' }, h('div', { class: 'eyebrow' }, 'Что изменилось'), h('ul', { class: 'learning-changes' }, v.changes.map(c => h('li', null, c))))),
      actions: close => [
        isAdmin() && v.status === 'archived' && v.rollbackTo && A && button('Вернуть ' + v.id, { kind: 'secondary', icon: 'history', onClick: () => { A.status = 'candidate'; v.status = 'active'; v.rollbackTo = false; close(); drawPanel(); drawTiles(); UI.toast('Снова активна ' + v.id + ' · ' + A.id + ' вернулась в кандидаты', 'history'); } }),
        v.status === 'candidate' && button('Сравнить с ' + (A ? A.id : 'активной'), { kind: 'secondary', icon: 'layers', onClick: () => { close(); compareModal(); } }),
        button('Закрыть', { kind: 'primary', onClick: close }),
      ].filter(Boolean),
    });
    settleModal();
  }

  // Прогон версии на замороженном наборе: цена по живым числам и худший случай — до запуска, подтверждение кодом 2FA (Т8)
  function evalModal() {
    const n = SET.n, batches = Math.ceil(n / E().batchSize), worst = n * E().perEventWorst, perBatch = E().batchSize * E().perEventWorst;
    UI.modal({
      title: 'Оценить версию на наборе',
      body: close => {
        const verF = UI.field({ id: 'learning-eval-ver', label: 'Что прогнать', options: versions().filter(v => v.status !== 'archived').map(v => ({ value: v.id, label: v.id + ' · ' + (v.status === 'active' ? 'активная, еще прогон для порога шума' : 'кандидат, повтор') })) });
        const otp = UI.field({ id: 'learning-eval-otp', label: 'Код 2FA', inputmode: 'numeric', placeholder: '000000', attrs: { autocomplete: 'one-time-code', maxlength: '6' } });
        return h('div', { class: 'stack', style: 'gap:14px' },
          verF,
          UI.kv([
            ['Набор', SET.code + ' · ' + n + ' матчей, без новостей'],
            ['Как идет', batches + ' ' + fmt.plural(batches, 'пакет', 'пакета', 'пакетов') + ' по ≤ ' + E().batchSize + ' через Batch, следующий — после сбора предыдущего'],
            ['Цена по прошлым прогонам', '≈ $2,50–3,60'],
            ['Худший случай', '≈ ' + fmt.usd(worst) + ' (' + n + ' × ' + fmt.usd(E().perEventWorst) + ' при 8 тыс. токенов ответа), резерв на пакет ≤ ' + fmt.usd(perBatch)],
            ['Бюджет проверок', fmt.usd(E().spent) + ' из ' + fmt.usd(E().monthly, 0) + ' · остаток ' + fmt.usd(evalLeft()) + (E().firstMonth ? ' · с ноября ' + fmt.usd(E().next, 0) + ' в месяц' : '')],
          ]),
          perBatch > evalLeft() ? UI.callout('bad', 'alert', 'Остатка не хватает даже на резерв одного пакета — прогон не стартует.') : UI.callout('info', 'info', 'Расход идет из бюджета проверок на вашем ключе: в общий бюджет и в лимиты участников не входит. Ошибка прогона тратит бюджет проверок, но не боевой.'),
          otp);
      },
      actions: close => [
        button('Отмена', { kind: 'secondary', onClick: close }),
        button('Запустить прогон', { kind: 'primary', icon: 'play', onClick: () => {
          const code = (document.getElementById('learning-eval-otp') || {}).value || '';
          if (!/^\d{6}$/.test(code)) { UI.toast('Введите шестизначный код 2FA', 'alert'); return; }
          close(); UI.toast('Прогон запущен: ' + batches + ' пакета, результат — через 1–3 часа, придет уведомлением', 'clock');
        } }),
      ],
    });
  }

  // ---------- 3. Базовая модель ----------
  function mlPanel() {
    const mobile = UI.isMobile();
    const m = activeMl(), prev = L.mlModels.find(x => x.id === m.prev);
    const ev = st.empty ? 0 : L.eventsWithOutcome();
    const head = card({
      class: 'learning-card', eyebrow: 'Базовая модель', title: 'Эло по покрытиям + калибровка',
      subtitle: 'Одна на всех участников. Считается на сервере без ИИ — за миллисекунды и бесплатно',
      actions: [chip('Активна ' + m.id, 'good', 'check'), isAdmin()
        ? button(st.recal ? 'Перекалибровка…' : 'Перекалибровать', { kind: 'secondary', size: 'sm', icon: 'refresh', disabled: !!st.recal, onClick: recalibrate })
        : chip('Ведет администратор', 'outline', 'admin')],
      body: [
        h('dl', { class: 'learning-strip' },
          h('div', null, h('dt', null, 'Активная версия'), h('dd', null, dayTime(m.at), h('small', null, m.auto ? 'перекалибрована и включена сама' : 'включена администратором'))),
          h('div', null, h('dt', null, 'Brier на проверке'), h('dd', null, dec4(m.brier), h('small', null, prev ? 'прежняя ' + dec4(prev.brier) : ''))),
          h('div', null, h('dt', null, 'Калибровка, ECE'), h('dd', null, fmt.pct(m.ece), h('small', null, '0% — идеальная калибровка'))),
          h('div', null, h('dt', null, 'Эло'), h('dd', null, 'по покрытиям', h('small', null, 'вся история основного тура с 2000 г.'))),
          h('div', null, h('dt', null, 'Перекалибровка'), h('dd', null, 'по понедельникам', h('small', null, 'после загрузки файла tennis-data'))),
          h('div', null, h('dt', null, 'Поправка Claude числом'), h('dd', null, ev + ' из ' + L.C_MIN, h('small', null, 'событий с исходами: подбор веса — с ' + L.C_MIN)))),
        st.recal && h('div', { class: 'learning-train', 'aria-live': 'polite' }, h('div', { class: 'row-between' }, h('span', { class: 'soft' }, st.recal < 60 ? 'Подбираем калибровку на новых матчах' : 'Проверяем: включим, только если не хуже'), h('b', { class: 'num' }, st.recal + '%')), UI.meter(st.recal, 100)),
        UI.callout('accent', 'shield', h('b', null, 'Включается сама, если не хуже (В6). '), 'Перекалибровка той же модели на новых матчах: Brier не хуже прежнего +0,005 и лог-лосс не хуже +0,01 — новая версия включается, приходит уведомление, вернуть прежнюю можно в один клик. Новые признаки, другой тип модели и предел поправки Claude (сейчас ±10 п.п.) — только решением администратора.'),
      ],
    });
    const list = card({
      class: 'learning-card', title: 'Версии модели', subtitle: 'Каждая перекалибровка — отдельная версия, прогнозы помнят, какой версией сделаны',
      body: h('div', { class: 'stack', style: 'gap:0' }, L.mlModels.map(x => h('div', { class: 'learning-mlrow' },
        h('div', { style: 'min-width:0' }, h('div', { class: 'mono' }, x.id), h('div', { class: 'xsmall muted' }, dayTime(x.at) + ' · Brier ' + dec4(x.brier) + ' · лог-лосс ' + fmt.dec(x.logloss, 3) + (x.why ? ' · ' + x.why : ''))),
        h('div', { class: 'row', style: 'gap:6px;justify-content:flex-end' }, versionChip(x),
          isAdmin() && x.status === 'archived' && x.id === m.prev && button('Вернуть', { kind: 'ghost', size: 'sm', icon: 'history', onClick: () => { m.status = 'archived'; x.status = 'active'; x.prev = m.id; delete m.prev; drawPanel(); drawTiles(); UI.toast('Вернули модель ' + x.id + ' · Brier ' + dec4(x.brier), 'history'); } }))))),
    });
    const WF = L.walkForward, first = WF[0], last = WF[WF.length - 1];
    const wfChart = UI.lineChart({
      labels: WF.map(r => r.m),
      series: [{ name: 'Базовая модель', color: 'var(--s1)', values: WF.map(r => r.model) }, { name: 'Рынок по архиву', color: 'var(--s2)', values: WF.map(r => r.market) }],
      yFormat: v => fmt.dec(v, 3), height: mobile ? 200 : 230, tipTitle: (l, i) => WF[i].full + ' · ' + WF[i].n + ' матчей', ariaLabel: 'Brier по месяцам: базовая модель против рынка',
    });
    const wf = card({
      class: 'learning-card', title: 'Проверка по месяцам', subtitle: 'Brier: модель учится только на прошлом и прогнозирует следующий месяц',
      body: [
        UI.legend([{ name: 'Базовая модель', color: 'var(--s1)' }, { name: 'Рынок по кэфам архива tennis-data, момент снятия не проверен', color: 'var(--s2)' }]),
        UI.withTable(wfChart, () => UI.table({ columns: [{ label: 'Месяц', render: r => r.full }, { label: 'Матчей', align: 'r', render: r => fmt.int(r.n) }, { label: 'Модель', align: 'r', render: r => fmt.dec(r.model, 3) }, { label: 'Рынок', align: 'r', render: r => fmt.dec(r.market, 3) }], rows: WF })),
        hint('Ниже — лучше. Отставание от рынка сократилось с ' + fmt.dec(first.model - first.market, 3) + ' в апреле до ' + fmt.dec(last.model - last.market, 3) + ' в сентябре; при ' + Math.min(...WF.map(r => r.n)) + '–' + Math.max(...WF.map(r => r.n)) + ' матчах в месяц разница меньше ≈ 0,005 — шум. Обогнать рынок модель не обещает: ее роль — независимое второе мнение.'),
      ],
    });
    const calib = card({
      class: 'learning-card', title: 'Калибровка модели', subtitle: 'Матчи основного тура 2026 г. после калибровки Платта',
      body: [UI.calibrationChart({ bins: L.mlCalibration, domain: [0.5, 1], height: mobile ? 240 : 250 }), hint('Если модель говорит 70%, такие матчи должны выигрываться примерно в 7 из 10 случаев. Точки ниже диагонали — переоценка фаворитов.')],
    });
    const exportCard = isAdmin() && card({
      class: 'learning-card', title: 'Набор для учебного трека',
      subtitle: 'Снимки матчей в JSONL: досье до матча, вероятности и исход. Учебный трек живет вне приложения (папка lab/) и на прогнозы не влияет',
      actions: [button('Выгрузить JSONL', { kind: 'secondary', size: 'sm', icon: 'download', onClick: () => UI.toast('В рабочей версии скачается snapshots.jsonl: архив и свои события, игроки обезличены. В макете файл не скачивается', 'download') })],
    });
    return h('div', { class: 'learning-panel' }, head, h('div', { class: 'learning-two' }, wf, calib), h('div', { class: 'learning-two' }, list, exportCard || h('div')));
  }
  function recalibrate() {
    if (st.recal) return;
    st.recal = 5; drawPanel();
    const timer = setInterval(() => {
      st.recal = Math.min(100, st.recal + 19);
      if (st.recal >= 100) {
        clearInterval(timer); st.recal = null;
        const m = activeMl();
        const nv = { id: 'elo-v1@' + TODAY, at: TODAY + 'T10:20', status: 'active', auto: false, brier: 0.1939, logloss: 0.570, ece: 2.0, matches: 74, prev: m.id };
        m.status = 'archived'; L.mlModels.unshift(nv);
        UI.toast('Перекалибрована: Brier 0,1939 (было ' + dec4(m.brier) + ') — не хуже, включена. Вернуть прежнюю — в списке версий', 'check');
        drawTiles();
      }
      if (st.tab === 'ml') drawPanel();
    }, 280);
  }

  // ---------- 4. Отчеты ----------
  // В8: неделя пн–вс по поясу участника, отчет приходит в понедельник 07:00 в центр уведомлений
  function reportBlock(r) {
    const legsTxt = r.legs ? fmt.dec(r.brier, 3) + ' против ' + fmt.dec(r.brierMarket, 3) : '—';
    const cell = (k, v, sub, cls) => h('div', null, h('dt', null, k), h('dd', { class: cls }, v, sub && h('small', null, sub)));
    return h('div', { class: 'learning-report' },
      h('dl', { class: 'learning-rgrid' },
        cell('Рассчитано ставок', String(r.n), r.auto + ' по архиву, ' + r.manual + ' вами'),
        cell('Прибыль ставок', fmt.signedMoney(r.profit), r.roi == null ? '' : 'ROI ' + fmt.signedPct(r.roi), r.profit > 0 ? 'good-text' : r.profit < 0 ? 'bad-text' : null),
        cell('Средний CLV', r.clv == null ? '—' : fmt.signedPct(r.clv), r.clvN + ' ' + fmt.plural(r.clvN, 'ставка', 'ставки', 'ставок') + ' с закрытием'),
        cell('Brier: модель / рынок', legsTxt, r.legs + ' ' + fmt.plural(r.legs, 'событие', 'события', 'событий') + ' · на неделе это шум'),
        cell('Разборы ИИ', String(r.reviews), 'по матчам, ≈ ' + fmt.usd(r.reviews * 0.01)),
        cell('Новые гипотезы', r.lessonsNew.length ? r.lessonsNew.join(', ') : 'нет', null),
        cell('Проверки (eval)', fmt.usd(r.evalSpent), 'из бюджета проверок'),
        cell('Калибровка', 'в «Аналитике»', 'по всем прогонам')),
      hint('Неделя — с понедельника по воскресенье по вашему поясу. Точность за одну неделю почти всегда в пределах шума: смотрите тренд за месяц в «Аналитике».'));
  }
  function reportsPanel() {
    if (st.empty) return card({ class: 'learning-card', title: 'Еженедельные отчеты', subtitle: 'Понедельник, 07:00 по времени ' + tzCity() + ' · в центре уведомлений', body: UI.empty('Отчетов пока нет. Первый придет в понедельник ' + fmt.date(L.nextReport) + ' в 07:00 — даже если за неделю не было ставок, в нем будет расход и состояние модели.') });
    const reps = L.reportWeeks.map(w => L.weekReport(w));
    const last = reps[0];
    const lastCard = card({
      class: 'learning-card', eyebrow: 'Последний отчет', title: 'Неделя ' + fmt.date(last.from) + ' – ' + fmt.date(last.to),
      subtitle: 'Пришел ' + wday(last.sentAt) + ' ' + dayTime(last.sentAt) + ' по времени ' + tzCity() + ' · следующий — ' + wday(L.nextReport) + ' ' + fmt.date(L.nextReport) + ', 07:00',
      actions: [button('Настроить', { kind: 'ghost', size: 'sm', icon: 'sliders', href: '#profile-notifications' })],
      body: reportBlock(last),
    });
    const older = card({
      class: 'learning-card', title: 'Прошлые недели', subtitle: 'Хранятся все отчеты, они же в экспорте данных',
      body: h('div', { class: 'learning-rlist' }, reps.slice(1).map(r => h('button', { type: 'button', class: 'learning-rrow', on: { click: () => reportModal(r) } },
        h('span', { style: 'min-width:0' }, h('b', null, fmt.date(r.from) + ' – ' + fmt.date(r.to)), h('small', null, r.n + ' ' + fmt.plural(r.n, 'ставка', 'ставки', 'ставок') + ' · ROI ' + (r.roi == null ? '—' : fmt.signedPct(r.roi)) + ' · CLV ' + (r.clv == null ? '—' : fmt.signedPct(r.clv)))),
        h('span', { class: ['small', r.profit > 0 ? 'good-text' : r.profit < 0 ? 'bad-text' : 'muted'], style: 'font-weight:600;white-space:nowrap' }, fmt.signedMoney(r.profit)),
        icon('chevronRight')))),
    });
    return h('div', { class: 'learning-panel' }, lastCard, older);
  }
  function reportModal(r) {
    UI.modal({ title: 'Отчет: ' + fmt.date(r.from) + ' – ' + fmt.date(r.to), wide: true, body: reportBlock(r), actions: close => [button('Закрыть', { kind: 'primary', onClick: close })] });
    settleModal();
  }

  // ---------- регистрация ----------
  function build() {
    UI.clear(root);
    tilesSlot = h('div', { class: 'learning-tiles', role: 'group', 'aria-label': 'Что учится сейчас' });
    tabsSlot = h('div', { style: 'min-width:0' }, makeTabs());
    panel = h('div', { class: 'learning-panel', id: 'learning-panel', role: 'tabpanel' });
    drawTiles(); drawPanel();
    UI.append(root, [headBlock(), demoBar(), tilesSlot, cycleCard(), h('section', { class: 'learning-sections', 'aria-label': 'Разделы обучения' }, tabsSlot, panel)]);
  }
  UI.register('learning', {
    title: 'Обучение модели',
    render(host, param) {
      root = host;
      const p = param === 'compare' ? 'versions' : param;
      if (param === 'empty') st.empty = true;
      if (p && TABS.some(t => t.id === p)) { st.tab = p; try { sessionStorage.setItem('capper.learning.tab', p); } catch (e) { /* ок */ } }
      build();
      if (param === 'compare') setTimeout(compareModal, 0);
    },
  });
})();
