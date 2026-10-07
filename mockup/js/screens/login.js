/* Экран входа (без оболочки приложения): защищённый вход в личный кабинет.
   Шаги — подмаршруты #login-<шаг>: вход по паролю → код 2FA (или резервный код), восстановление пароля,
   регистрация по приглашению → настройка 2FA, блокировка после 5 ошибок. Состояние живёт в памяти модуля,
   поэтому смена темы или ширины экрана не сбрасывает введённое. */
(function () {
  'use strict';
  const { h, icon, button } = UI;

  const STEPS = ['login', '2fa', 'backup', 'reset', 'sent', 'invite', 'setup', 'locked'];
  const TITLES = { login: 'Вход', '2fa': 'Код подтверждения', backup: 'Резервный код', reset: 'Сброс пароля', sent: 'Проверьте почту', invite: 'Регистрация', setup: 'Настройка 2FA', locked: 'Вход заблокирован' };
  const MAX_ATTEMPTS = 5;
  const SECRET = 'JK3M Q7XP L2VD 6WRA ZT4N HC5Y B7QE 2MKS';
  const BACKUP_CODES = ['4f7k-2m9q', 'x8c3-vn5d', '7hpt-k2wz', 'm6qa-93rf', 'e2yd-u7jb', 'r5ns-8gxk', 'b9wl-c4tm', 'q3jv-6pzh'];
  const LEAKED = ['password', 'qwerty', '123456', '111111', '000000', 'йцукен', 'пароль', 'iloveyou', 'admin', 'letmein', 'abc123'];
  const APPS = ['Google Authenticator', 'Яндекс Ключ', '1Password'];

  const SEC = [
    { icon: 'lock', t: 'Пароль — только хеш Argon2id', d: 'Сам пароль не хранится и не попадает в логи' },
    { icon: 'shield', t: 'Двухфакторная аутентификация', d: 'TOTP-коды: Google Authenticator, Яндекс Ключ или 1Password' },
    { icon: 'key', t: 'Сессия в защищённой httpOnly-cookie', d: 'Secure и SameSite: скрипты на странице её не прочитают' },
    { icon: 'alert', t: 'Блокировка после 5 неудачных попыток', d: 'Вход закрывается на 15 минут — подбор пароля бесполезен' },
    { icon: 'telegram', t: 'Уведомление в Telegram', d: 'О каждом входе с нового устройства' },
    { icon: 'history', t: 'Журнал входов', d: 'Устройство, город и время — в личном кабинете' },
  ];

  const LEVELS = [
    { label: 'Не задан', chip: 'outline', icon: 'info', meter: null },
    { label: 'Слабый', chip: 'bad', icon: 'alert', meter: 'bad' },
    { label: 'Средний', chip: 'warn', icon: 'alert', meter: 'warn' },
    { label: 'Хороший', chip: 'accent', icon: 'check', meter: null },
    { label: 'Надёжный', chip: 'good', icon: 'shield', meter: 'login-good' },
  ];

  function fresh() {
    return {
      step: 'login', lastStep: null,
      email: DATA.user.email, pwd: '', remember: false, attempts: MAX_ATTEMPTS, error: false, emailError: null,
      otp: '', otpError: null, backup: '', backupError: null,
      resetEmail: null, resetError: null, resent: false,
      reg: { invite: 'CAP-7Q4M-2KXD', email: '', pwd: '', pwd2: '', agree: false }, regErr: {},
      setupOtp: '', saved: false, setupErr: {},
    };
  }
  let S = fresh();
  let ROOT = null;
  let busy = false;

  // ---------- стили экрана ----------
  const CSS = `
  .login-page { min-height: 100vh; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); background: var(--surface); }
  @media (min-width: 1280px) { .login-page { grid-template-columns: minmax(0, 1.06fr) minmax(0, 1fr); } }
  .login-brand {
    position: sticky; top: 16px; align-self: start; min-height: calc(100vh - 32px); margin: 16px 0 16px 16px;
    border-radius: 22px; overflow: hidden; isolation: isolate; min-width: 0;
    background: radial-gradient(120% 70% at 100% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 62%), var(--accent-soft);
    padding: 34px 40px 26px; display: flex; flex-direction: column; gap: 28px; color: var(--fg);
  }
  .login-court { position: absolute; inset: 0; width: 100%; height: 100%; z-index: -1; pointer-events: none; }
  .login-court .ln { stroke: var(--accent); stroke-opacity: .24; fill: none; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .login-court .net { stroke-opacity: .4; stroke-width: 2.5; }
  .login-court .post { fill: var(--accent); fill-opacity: .4; }
  .login-court .flight { stroke: var(--accent); stroke-opacity: .55; stroke-dasharray: 1.5 6; stroke-linecap: round; fill: none; stroke-width: 2; vector-effect: non-scaling-stroke; }
  .login-court .bounce { fill: none; stroke: var(--accent); stroke-opacity: .55; stroke-width: 1.5; vector-effect: non-scaling-stroke; }
  .login-court .ball { fill: var(--accent); fill-opacity: .7; }
  .login-brandrow { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .login-brandrow .brand-mark { width: 40px; height: 40px; }
  .login-hero { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 14px; max-width: 26rem; min-width: 0; }
  .login-hero-h { font-family: var(--font-display); font-weight: 700; font-size: clamp(1.875rem, 2.5vw, 2.5rem); line-height: 1.08; letter-spacing: -.025em; color: var(--accent-ink); text-wrap: balance; }
  .login-hero-p { font-size: var(--fs-lg); color: var(--fg-2); max-width: 44ch; }
  .login-hero-note { display: flex; align-items: center; gap: 6px; font-size: var(--fs-sm); color: var(--fg-3); }
  .login-hero-note svg { width: 16px; height: 16px; flex: none; }
  .login-sec {
    background: color-mix(in srgb, var(--surface) 90%, transparent); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
    border: 1px solid color-mix(in srgb, var(--accent) 16%, var(--line)); border-radius: var(--r-lg);
    padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; min-width: 0;
  }
  .login-sec-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .login-sec-head h2 { font-size: var(--fs-md); flex: 1; min-width: 0; }
  .login-sec-head > svg { width: 20px; height: 20px; color: var(--accent-ink); flex: none; }
  .login-sec-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px 22px; }
  @media (min-width: 1240px) { .login-brand .login-sec-list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  .login-sec-item { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
  .login-sec-ic { width: 30px; height: 30px; border-radius: 8px; background: var(--accent-soft); color: var(--accent-ink); display: grid; place-items: center; flex: none; }
  .login-sec-ic svg { width: 16px; height: 16px; }
  .login-sec-t { font-weight: 600; font-size: var(--fs-sm); line-height: 1.3; }
  .login-sec-d { font-size: var(--fs-xs); color: var(--fg-3); line-height: 1.4; margin-top: 2px; }
  .login-brandfoot { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--fg-3); }

  .login-main { display: flex; flex-direction: column; min-width: 0; min-height: 100vh; padding: 18px 40px 20px; }
  .login-topline { display: flex; justify-content: flex-end; align-items: center; gap: 6px; flex-wrap: wrap; }
  .login-center { flex: 1; display: flex; align-items: center; justify-content: center; padding: 28px 0 36px; min-width: 0; }
  .login-form { width: 100%; max-width: 408px; display: flex; flex-direction: column; gap: 20px; min-width: 0; }
  .login-form.wide { max-width: 548px; }
  .login-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; font-size: var(--fs-xs); color: var(--fg-3); }

  .login-head { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
  .login-title { font-size: var(--fs-2xl); font-weight: 700; letter-spacing: -.02em; }
  .login-sub { color: var(--fg-2); }
  .login-form .input { height: 46px; font-size: 1rem; }
  .login-form .callout { font-size: var(--fs-sm); }

  .login-steps { list-style: none; margin: 0; padding: 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: var(--fs-sm); }
  .login-step { display: flex; align-items: center; gap: 8px; color: var(--fg-3); font-weight: 500; min-width: 0; }
  .login-step + .login-step::before { content: ""; width: 28px; height: 1px; background: var(--line-strong); flex: none; }
  .login-step-n { width: 24px; height: 24px; border-radius: 50%; display: grid; place-items: center; font-size: var(--fs-xs); font-weight: 700; border: 1.5px solid var(--line-strong); color: var(--fg-3); flex: none; }
  .login-step-n svg { width: 14px; height: 14px; }
  .login-step.current { color: var(--fg); font-weight: 600; }
  .login-step.current .login-step-n { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  .login-step.done { color: var(--fg-2); }
  .login-step.done .login-step-n { background: var(--accent-soft); border-color: transparent; color: var(--accent-ink); }

  .login-label-row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
  .login-link { background: none; border: 0; padding: 0; font: inherit; font-size: var(--fs-sm); font-weight: 600; color: var(--accent-ink); text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; border-radius: 4px; }
  .login-link:hover { text-decoration: underline; }
  .login-link svg { width: 16px; height: 16px; flex: none; }
  .login-pw { position: relative; min-width: 0; }
  .login-pw .input { padding-right: 50px; }
  .login-eye { position: absolute; right: 5px; top: 50%; transform: translateY(-50%); width: 36px; height: 36px; border: 0; background: none; border-radius: 8px; color: var(--fg-3); display: grid; place-items: center; cursor: pointer; }
  .login-eye:hover { background: var(--surface-2); color: var(--fg); }
  .login-eye svg { width: 19px; height: 19px; }
  .login-caps { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--warn-ink); font-weight: 500; }
  .login-caps[hidden] { display: none; }
  .login-caps svg { width: 14px; height: 14px; }
  .login-check { font-size: var(--fs-md); }
  .login-check > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .login-check.invalid input { outline: 2px solid var(--bad); outline-offset: 1px; }
  .login-alt { display: flex; align-items: center; justify-content: center; gap: 6px 12px; flex-wrap: wrap; font-size: var(--fs-sm); }
  .login-alt.between { justify-content: space-between; }
  .login-note { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-xs); color: var(--fg-3); }
  .login-note svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
  .login-demo { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border: 1px dashed var(--line-strong); border-radius: var(--r-md); font-size: var(--fs-xs); color: var(--fg-2); }
  .login-demo svg { width: 16px; height: 16px; flex: none; color: var(--fg-3); margin-top: 1px; }
  .btn.login-busy[disabled] { opacity: .85; cursor: progress; }
  .login-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: login-spin .7s linear infinite; flex: none; }
  @keyframes login-spin { to { transform: rotate(360deg); } }

  .login-acct { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; }
  .login-acct .avatar { width: 34px; height: 34px; font-size: var(--fs-sm); cursor: default; }
  .login-acct-body { flex: 1; min-width: 0; }
  .login-acct-addr { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .login-otp { display: flex; gap: 8px; align-items: center; min-width: 0; }
  .login-otp-box {
    flex: 1 1 0; min-width: 0; max-width: 56px; height: 58px; padding: 0; border-radius: var(--r-md);
    border: 1px solid var(--line-strong); background: var(--surface); color: var(--fg);
    text-align: center; font-family: var(--font-mono); font-size: 1.5rem; font-weight: 500; caret-color: var(--accent);
  }
  .login-otp-box.filled { border-color: var(--fg-3); }
  .login-otp-box:focus { outline: none; border-color: var(--focus); box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus) 22%, transparent); }
  .login-otp.invalid .login-otp-box { border-color: var(--bad); }
  .login-otp-box[readonly] { background: var(--surface-2); }
  .login-otp-sep { width: 10px; height: 2px; border-radius: 1px; background: var(--line-strong); flex: none; }

  .login-bigic { width: 56px; height: 56px; border-radius: 16px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent-ink); }
  .login-bigic svg { width: 28px; height: 28px; }
  .login-bigic.bad { background: var(--bad-soft); color: var(--bad-ink); }
  .login-bul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); color: var(--fg-2); }
  .login-ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); color: var(--fg-2); }

  .login-strength { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; }
  .login-strength .meter { background: var(--surface-3); }
  .meter.login-good > i { background: var(--good); }
  .login-rules { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; font-size: var(--fs-sm); }
  .login-rule { display: flex; align-items: center; gap: 8px; color: var(--fg-3); min-width: 0; }
  .login-rule svg { width: 16px; height: 16px; flex: none; }
  .login-rule.ok { color: var(--good-ink); }
  .login-rule.bad { color: var(--bad-ink); }
  .login-rule .pend { width: 16px; height: 16px; display: grid; place-items: center; flex: none; }
  .login-rule .pend::after { content: ""; width: 7px; height: 7px; border-radius: 50%; border: 1.5px solid var(--fg-3); }
  .login-match:empty { display: none; }

  .login-secs { display: flex; flex-direction: column; gap: 22px; min-width: 0; }
  .login-s { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 12px; min-width: 0; }
  .login-s-n { width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; display: grid; place-items: center; font-size: var(--fs-sm); }
  .login-s-body { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .login-s-body h2 { font-size: var(--fs-md); margin-top: 3px; }
  .login-qrrow { display: flex; gap: 16px; align-items: flex-start; flex-wrap: wrap; min-width: 0; }
  .login-qr { --qr-bg: var(--surface); --qr-fg: var(--fg); background: var(--qr-bg); padding: 4px; border-radius: 12px; border: 1px solid var(--line-strong); line-height: 0; flex: none; }
  @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .login-qr { --qr-bg: var(--fg); --qr-fg: var(--bg); } }
  :root[data-theme="dark"] .login-qr { --qr-bg: var(--fg); --qr-fg: var(--bg); }
  .login-qr svg { display: block; }
  .login-qr-side { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
  .login-key { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 8px 8px 8px 12px; border-radius: var(--r-md); background: var(--surface-2); border: 1px solid var(--line); min-width: 0; }
  .login-key code { flex: 1 1 170px; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-sm); letter-spacing: .03em; overflow-wrap: anywhere; color: var(--fg); }
  .login-codes { list-style: none; margin: 0; padding: 12px 14px; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 16px; border: 1px dashed var(--line-strong); border-radius: var(--r-md); counter-reset: bc; font-family: var(--font-mono); font-size: var(--fs-md); }
  .login-codes li { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .login-codes li::before { counter-increment: bc; content: counter(bc) "."; color: var(--fg-3); font-size: var(--fs-xs); min-width: 1.3em; text-align: right; }

  /* телефон */
  .login-m { min-height: 100vh; background: var(--bg); padding: 16px 16px 28px; display: flex; flex-direction: column; gap: 16px; max-width: 560px; margin: 0 auto; }
  .login-m-hero {
    position: relative; isolation: isolate; overflow: hidden; border-radius: 18px; padding: 14px 14px 16px;
    background: radial-gradient(120% 90% at 100% 0%, color-mix(in srgb, var(--accent) 16%, transparent), transparent 65%), var(--accent-soft);
    display: flex; flex-direction: column; gap: 10px;
  }
  .login-m-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-width: 0; }
  .login-m-lead { font-size: var(--fs-sm); color: var(--fg-2); max-width: 62%; }
  .login-court-m { inset: 0 0 0 auto; width: 46%; -webkit-mask-image: linear-gradient(to right, transparent, var(--fg) 55%); mask-image: linear-gradient(to right, transparent, var(--fg) 55%); }
  .login-m-top .btn { position: relative; background: color-mix(in srgb, var(--accent-soft) 80%, transparent); }
  .login-m-card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 20px 18px; min-width: 0; }
  .login-m-card .login-form, .login-m-card .login-form.wide { max-width: none; gap: 18px; }
  .login-m .login-title { font-size: var(--fs-xl); }
  .login-secd { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r-lg); min-width: 0; }
  .login-secd summary { list-style: none; display: flex; align-items: center; gap: 10px; padding: 14px 16px; cursor: pointer; border-radius: var(--r-lg); }
  .login-secd summary::-webkit-details-marker { display: none; }
  .login-secd summary > svg { width: 20px; height: 20px; flex: none; color: var(--accent-ink); }
  .login-secd summary .chev { width: 18px; height: 18px; color: var(--fg-3); transition: transform .15s; }
  .login-secd[open] summary .chev { transform: rotate(180deg); }
  .login-secd-t { flex: 1; min-width: 0; }
  .login-secd-t b { display: block; font-weight: 600; }
  .login-secd .login-sec-list { padding: 2px 16px 16px; }
  .btn.login-demo-btn { border: 1px dashed var(--line-strong); }
  .login-m-foot { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); text-align: center; }
  `;

  // ---------- мелкие помощники ----------
  function isDark() { return (document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'; }
  function themeBtn() { const d = isDark(); return button('', { kind: 'ghost', size: 'sm', icon: d ? 'sun' : 'moon', title: d ? 'Светлая тема' : 'Тёмная тема', onClick: () => UI.toggleTheme() }); }
  function focusSel(sel) { requestAnimationFrame(() => { const el = ROOT && ROOT.querySelector(sel); if (el) el.focus(); }); }
  function setBusy(btn, label) {
    if (!btn) return;
    btn.disabled = true; btn.classList.add('login-busy'); btn.setAttribute('aria-busy', 'true');
    UI.clear(btn); btn.append(h('span', { class: 'login-spin', 'aria-hidden': 'true' }), h('span', null, label));
  }
  function later(ms, fn) { setTimeout(() => { busy = false; if (ROOT && ROOT.isConnected) fn(); }, ms); }
  // Успешный вход: сбрасываем состояние экрана и открываем кабинет
  function enter(msg, ic) { S = fresh(); busy = false; UI.auth.login(); UI.toast(msg, ic || 'check'); }
  function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()); }

  function head(eyebrow, title, sub) {
    return h('div', { class: 'login-head' },
      eyebrow && h('div', { class: 'eyebrow' }, eyebrow),
      h('h1', { class: 'login-title', id: 'login-title' }, title),
      sub && h('p', { class: 'login-sub' }, sub));
  }
  function stepper(items, current) {
    return h('ol', { class: 'login-steps', 'aria-label': 'Шаги входа' }, items.map((label, i) =>
      h('li', { class: ['login-step', i < current && 'done', i === current && 'current'], 'aria-current': i === current ? 'step' : null },
        h('span', { class: 'login-step-n', 'aria-hidden': 'true' }, i < current ? icon('check') : String(i + 1)),
        h('span', null, label, i < current && h('span', { class: 'sr-only' }, ' — пройден')))));
  }
  function demoHint(text) { return h('div', { class: 'login-demo' }, icon('flask'), h('span', null, text)); }
  function note(ic, text) { return h('p', { class: 'login-note' }, icon(ic), h('span', null, text)); }
  function markInvalid(fieldEl) { const i = fieldEl.querySelector('input'); if (i) { i.classList.add('invalid'); i.setAttribute('aria-invalid', 'true'); } return fieldEl; }
  // Ввод в поле снимает его ошибку сразу, не дожидаясь повторной отправки
  function dropError(fieldEl) { const err = fieldEl.querySelector('.field-error'); if (err) err.remove(); }
  function onInput(fieldEl, fn) { const i = fieldEl.querySelector('input'); i.addEventListener('input', () => { i.classList.remove('invalid'); i.removeAttribute('aria-invalid'); dropError(fieldEl); fn(i.value); }); return fieldEl; }
  function check(o) { // {id, checked, title, hint, error, onChange}
    const wrap = h('div', { class: 'field' });
    const onChange = e => { if (e.target.checked) { dropError(wrap); wrap.querySelector('.login-check').classList.remove('invalid'); e.target.removeAttribute('aria-invalid'); } o.onChange(e.target.checked); };
    return UI.append(wrap, [
      h('label', { class: ['check', 'login-check', o.error && 'invalid'], for: o.id },
        h('input', { type: 'checkbox', id: o.id, checked: !!o.checked, 'aria-invalid': o.error ? 'true' : null, on: { change: onChange } }),
        h('span', null, h('span', null, o.title), o.hint && h('span', { class: 'field-hint' }, o.hint))),
      o.error && h('div', { class: 'field-error', role: 'alert' }, o.error)]);
  }

  function copyText(text, okMsg, selectNode) {
    const fallback = () => {
      if (selectNode) { try { const r = document.createRange(); r.selectNodeContents(selectNode); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) { /* без выделения */ } }
      UI.toast('Не удалось скопировать автоматически — текст выделен, скопируйте вручную', 'info');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(() => UI.toast(okMsg, 'copy'), fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  // Поле пароля с кнопкой «показать», подсказкой о Caps Lock и местом под ошибку
  function pwField(o) {
    const errId = o.id + '-err';
    const input = h('input', {
      class: ['input', o.invalid && 'invalid'], type: 'password', id: o.id, name: o.id, autocomplete: o.autocomplete,
      spellcheck: 'false', autocapitalize: 'off', 'aria-invalid': o.invalid ? 'true' : null,
      'aria-describedby': o.error ? errId : (o.describedBy || null), 'data-autofocus': o.autofocus || null,
    });
    input.value = o.value || '';
    const caps = h('div', { class: 'login-caps', hidden: true }, icon('alert'), 'Включён Caps Lock');
    const capsCheck = e => { if (e.getModifierState) caps.hidden = !e.getModifierState('CapsLock'); };
    input.addEventListener('keydown', capsCheck);
    input.addEventListener('keyup', capsCheck);
    input.addEventListener('input', () => { input.classList.remove('invalid'); input.removeAttribute('aria-invalid'); const err = document.getElementById(errId); if (err) err.remove(); o.onInput && o.onInput(input.value); });
    const eye = h('button', { type: 'button', class: 'login-eye', 'aria-label': 'Показать пароль', 'aria-pressed': 'false', 'aria-controls': o.id, title: 'Показать пароль' }, icon('eye'));
    eye.addEventListener('click', () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      const label = show ? 'Скрыть пароль' : 'Показать пароль';
      eye.setAttribute('aria-pressed', String(show)); eye.setAttribute('aria-label', label); eye.title = label;
      UI.clear(eye).appendChild(icon(show ? 'eyeOff' : 'eye'));
      input.focus();
    });
    return h('div', { class: 'field' },
      h('div', { class: 'login-label-row' }, h('label', { class: 'field-label', for: o.id }, o.label), o.aside),
      h('div', { class: 'login-pw' }, input, eye),
      caps,
      o.error ? h('div', { class: 'field-error', id: errId, role: 'alert' }, o.error) : (o.hint && h('div', { class: 'field-hint' }, o.hint)),
      o.after);
  }

  // Шесть клеток для кода: автопереход, Backspace назад, стрелки, вставка всего кода
  function otpInput(o) {
    const N = 6, boxes = [];
    const group = h('div', { class: ['login-otp', o.invalid && 'invalid'], role: 'group', 'aria-labelledby': o.labelledBy });
    const value = () => boxes.map(b => b.value).join('');
    const emit = () => {
      boxes.forEach(b => { b.classList.toggle('filled', !!b.value); b.dataset.v = b.value; });
      group.classList.remove('invalid');
      const err = group.parentElement && group.parentElement.querySelector('.field-error');
      if (err) err.remove();
      const v = value();
      o.onChange && o.onChange(v);
      if (/^\d{6}$/.test(v) && o.onComplete) o.onComplete(v);
    };
    const fill = (start, digits) => {
      let i = start;
      for (const d of digits) { if (i >= N) break; boxes[i].value = d; i++; }
      const next = boxes[Math.min(i, N - 1)];
      next.focus(); next.select();
      emit();
    };
    for (let i = 0; i < N; i++) {
      const b = h('input', {
        class: 'login-otp-box', type: 'text', inputmode: 'numeric', pattern: '[0-9]*', id: i === 0 ? o.id : null,
        autocomplete: i === 0 ? 'one-time-code' : 'off', 'aria-label': 'Цифра ' + (i + 1) + ' из 6', 'data-autofocus': i === 0 && o.autofocus ? true : null,
      });
      b.value = (o.value || '')[i] || '';
      b.dataset.v = b.value;
      if (b.value) b.classList.add('filled');
      b.addEventListener('input', () => {
        let digits = b.value.replace(/\D/g, '');
        const prev = b.dataset.v;
        if (!digits) { b.value = ''; emit(); return; }
        if (digits.length === 2 && prev && digits.includes(prev)) digits = digits[0] === prev ? digits[1] : digits[0];
        if (digits.length > 1) { fill(i, digits.split('')); return; }
        b.value = digits;
        if (i < N - 1) { boxes[i + 1].focus(); boxes[i + 1].select(); }
        emit();
      });
      b.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !b.value && i > 0) { e.preventDefault(); boxes[i - 1].value = ''; boxes[i - 1].focus(); emit(); }
        else if (e.key === 'ArrowLeft' && i > 0) { e.preventDefault(); boxes[i - 1].focus(); }
        else if (e.key === 'ArrowRight' && i < N - 1) { e.preventDefault(); boxes[i + 1].focus(); }
      });
      b.addEventListener('paste', e => {
        const t = ((e.clipboardData || window.clipboardData) && (e.clipboardData || window.clipboardData).getData('text')) || '';
        const d = t.replace(/\D/g, '');
        if (!d) return;
        e.preventDefault();
        fill(d.length >= N ? 0 : i, d.split(''));
      });
      b.addEventListener('focus', () => b.select());
      boxes.push(b);
    }
    group.append(...boxes.slice(0, 3), h('span', { class: 'login-otp-sep', 'aria-hidden': 'true' }), ...boxes.slice(3));
    return group;
  }

  // ---------- графика: корт и QR ----------
  function court(dir) {
    const horiz = dir === 'h';
    const P = (x, y) => horiz ? y + ' ' + x : x + ' ' + y;
    const L = (x1, y1, x2, y2, cls) => h('path', { class: cls || 'ln', d: 'M' + P(x1, y1) + 'L' + P(x2, y2) });
    const C = (x, y, r, cls) => { const [cx, cy] = horiz ? [y, x] : [x, y]; return h('circle', { class: cls, cx, cy, r }); };
    // Десктоп: корт прижат к правому краю панели и не заходит под текст; телефон: половина корта справа, слева растворяется маской
    return h('svg', { class: ['login-court', horiz && 'login-court-m'], viewBox: horiz ? '120 20 330 360' : '-382 0 651 800', preserveAspectRatio: horiz ? 'xMidYMid slice' : 'xMinYMid slice', 'aria-hidden': 'true', focusable: 'false' },
      // парный корт 10,97 × 23,77 м, одиночные линии, линии подачи, центральная линия, сетка
      L(60, 97, 340, 97), L(340, 97, 340, 703), L(340, 703, 60, 703), L(60, 703, 60, 97),
      L(95, 97, 95, 703), L(305, 97, 305, 703),
      L(95, 237, 305, 237), L(95, 563, 305, 563),
      L(200, 237, 200, 563),
      L(200, 97, 200, 110), L(200, 690, 200, 703),
      L(50, 400, 350, 400, 'ln net'), C(50, 400, 4, 'post'), C(350, 400, 4, 'post'),
      // траектория мяча «как в Hawk-Eye»: подача → отскок в квадрате → мяч
      h('path', { class: 'flight', d: 'M' + P(262, 650) + 'Q' + P(372, 430) + ' ' + P(150, 300) }),
      C(150, 300, 9, 'bounce'),
      !horiz && h('path', { class: 'flight', d: 'M' + P(150, 300) + 'Q' + P(138, 250) + ' ' + P(128, 214) }),
      !horiz && C(128, 214, 7, 'ball'));
  }

  function qrSvg(px) {
    const N = 25, Q = 2, T = N + Q * 2;
    let seed = 20261007;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const g = [], res = [];
    for (let r = 0; r < N; r++) { g.push(new Array(N).fill(0)); res.push(new Array(N).fill(false)); }
    const finder = (r0, c0) => {
      for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) {
        const rr = r0 + r, cc = c0 + c;
        if (rr < 0 || cc < 0 || rr >= N || cc >= N) continue;
        res[rr][cc] = true;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        g[rr][cc] = inside && (r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4)) ? 1 : 0;
      }
    };
    finder(0, 0); finder(0, N - 7); finder(N - 7, 0);
    for (let i = 8; i < N - 8; i++) { g[6][i] = g[i][6] = i % 2 === 0 ? 1 : 0; res[6][i] = res[i][6] = true; }
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) { g[18 + r][18 + c] = Math.max(Math.abs(r), Math.abs(c)) === 1 ? 0 : 1; res[18 + r][18 + c] = true; }
    for (let r = 9; r <= 15; r++) for (let c = 9; c <= 15; c++) { res[r][c] = true; g[r][c] = 0; }
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!res[r][c]) g[r][c] = rnd() < 0.47 ? 1 : 0;
    let d = '';
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (g[r][c]) d += 'M' + (c + Q) + ' ' + (r + Q) + 'h1v1h-1z';
    const logo = h('g', { transform: 'translate(' + (9 + Q + 0.5) + ' ' + (9 + Q + 0.5) + ') scale(' + (6 / 36) + ')' },
      h('rect', { x: 1, y: 1, width: 34, height: 34, rx: 9, fill: 'var(--accent)' }),
      h('path', { d: 'M9 7v22M27 7v22M9 13h18M9 23h18M18 13v10', stroke: 'var(--accent-fg)', 'stroke-width': 2.2, fill: 'none' }));
    return h('svg', { width: px, height: px, viewBox: '0 0 ' + T + ' ' + T, role: 'img', 'aria-label': 'QR-код для приложения-аутентификатора (в макете — заглушка)' },
      h('rect', { width: T, height: T, fill: 'var(--qr-bg)' }),
      h('path', { d, fill: 'var(--qr-fg)', 'shape-rendering': 'crispEdges' }),
      logo);
  }

  // ---------- пароль: надёжность и правила ----------
  function analyze(p, email) {
    const low = p.toLowerCase();
    const local = (email || '').split('@')[0].toLowerCase();
    const len = p.length >= 12;
    const mix = /[a-zа-яё]/i.test(p) && /\d/.test(p);
    const leaked = !!p && (LEAKED.some(w => low.includes(w)) || (local.length >= 3 && low.includes(local)));
    let score = 0;
    if (p) {
      score = 1;
      if (p.length >= 8) score = 2;
      if (len && mix) score = 3;
      if (len && mix && (p.length >= 16 || /[^a-zа-яё0-9]/i.test(p) || (/[A-ZА-ЯЁ]/.test(p) && /[a-zа-яё]/.test(p)))) score = 4;
    }
    if (leaked) score = Math.min(score, 1);
    return { len, mix, leaked, score, ok: !!p && len && mix && !leaked };
  }
  function rule(state, text) {
    return h('li', { class: ['login-rule', state] },
      state === 'ok' ? icon('check') : state === 'bad' ? icon('alert') : h('span', { class: 'pend', 'aria-hidden': 'true' }),
      h('span', null, text),
      h('span', { class: 'sr-only' }, state === 'ok' ? ' — выполнено' : ' — не выполнено'));
  }
  function strengthContent() {
    const p = S.reg.pwd, r = analyze(p, S.reg.email), lv = LEVELS[r.score];
    const m = UI.meter(r.score, 4, lv.meter);
    m.setAttribute('aria-label', 'Надёжность пароля'); m.setAttribute('aria-valuetext', lv.label);
    return [
      h('div', { class: 'row-between' }, h('span', { class: 'small soft' }, 'Надёжность пароля'), UI.chip(lv.label, lv.chip, lv.icon)),
      m,
      h('ul', { class: 'login-rules', 'aria-label': 'Требования к паролю' },
        rule(r.len ? 'ok' : 'todo', p ? '12+ символов (сейчас ' + p.length + ')' : '12+ символов'),
        rule(r.mix ? 'ok' : 'todo', 'Буквы и цифры'),
        rule(!p ? 'todo' : r.leaked ? 'bad' : 'ok', r.leaked ? 'Встречался в утечках — придумайте другой' : 'Не встречался в утечках')),
      h('div', { class: 'field-hint' }, 'Проверка по базе утечек Have I Been Pwned: отправляются только первые 5 символов хеша, сам пароль никуда не уходит.'),
    ];
  }
  function matchContent() {
    const { pwd, pwd2 } = S.reg;
    if (!pwd2) return null;
    return h('ul', { class: 'login-rules' }, pwd2 === pwd ? rule('ok', 'Пароли совпадают') : rule('todo', 'Пока не совпадают'));
  }

  // ---------- шаги ----------
  function viewLogin() {
    const err = S.error;
    const email = UI.field({ id: 'login-email', label: 'Email', type: 'email', value: S.email, autocomplete: 'username', inputmode: 'email', error: S.emailError, attrs: { spellcheck: 'false', autocapitalize: 'off' } });
    onInput(email, v => { S.email = v; S.emailError = null; });
    if (err) markInvalid(email);
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitLogin } },
      stepper(['Пароль', 'Код 2FA'], 0),
      head('Личный кабинет', 'Вход в AI Capper', 'Email и пароль, затем 6-значный код из приложения-аутентификатора.'),
      err && h('div', { class: 'callout bad', role: 'alert', id: 'login-error' }, icon('alert'),
        h('div', { style: 'min-width:0' },
          h('div', null, h('b', null, 'Неверный email или пароль.'), ' Осталось попыток: ' + S.attempts),
          S.attempts === 1 && h('div', null, 'После следующей ошибки вход закроется на 15 минут, а в Telegram придёт уведомление.'))),
      email,
      pwField({ id: 'login-password', label: 'Пароль', value: S.pwd, autocomplete: 'current-password', invalid: !!err, describedBy: err ? 'login-error' : null, autofocus: true,
        aside: h('a', { class: 'login-link', href: '#login-reset' }, 'Забыли пароль?'), onInput: v => { S.pwd = v; } }),
      check({ id: 'login-remember', checked: S.remember, title: 'Запомнить это устройство на 30 дней', hint: 'Код 2FA здесь не спросим 30 дней. Не отмечайте на чужом компьютере.', onChange: v => { S.remember = v; } }),
      button('Войти', { kind: 'primary', size: 'lg', block: true, type: 'submit', iconRight: 'arrowRight' }),
      h('div', { class: 'login-alt' }, h('span', { class: 'muted' }, 'Нет аккаунта?'), h('a', { class: 'login-link', href: '#login-invite' }, 'Регистрация только по приглашению', icon('chevronRight'))),
      demoHint('В макете пароль «wrong» или пустое поле покажут ошибку, любой другой пароль ведёт к шагу с кодом.'));
    return { node: form };
  }
  function submitLogin(e) {
    e.preventDefault();
    if (busy) return;
    S.emailError = null;
    if (!validEmail(S.email)) { S.error = false; S.emailError = 'Введите email в формате name@example.com'; draw(); focusSel('#login-email'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем…');
    later(450, () => {
      if (!S.pwd || S.pwd === 'wrong') {
        S.attempts -= 1; S.pwd = '';
        if (S.attempts <= 0) { S.attempts = 0; S.error = false; UI.go('login-locked'); return; }
        S.error = true; draw(); focusSel('#login-password'); return;
      }
      S.error = false; S.pwd = '';
      UI.go('login-2fa');
    });
  }

  function acctRow() {
    const mail = S.email || DATA.user.email;
    return h('div', { class: 'login-acct' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, DATA.user.initials),
      h('div', { class: 'login-acct-body' }, h('div', { class: 'xsmall muted' }, 'Входите как'), h('div', { class: 'login-acct-addr', title: mail }, mail)),
      h('a', { class: 'login-link', href: '#login' }, 'Не вы?'));
  }

  function view2fa() {
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: e => { e.preventDefault(); submit2fa(); } } },
      stepper(['Пароль', 'Код 2FA'], 1),
      head('Шаг 2 из 2', 'Код из приложения', 'Откройте Google Authenticator, Яндекс Ключ или 1Password — там 6 цифр для AI Capper.'),
      acctRow(),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'login-otp-1', id: 'login-otp-label' }, 'Код из приложения-аутентификатора'),
        otpInput({ id: 'login-otp-1', labelledBy: 'login-otp-label', value: S.otp, invalid: !!S.otpError, autofocus: true, onChange: v => { S.otp = v; S.otpError = null; }, onComplete: () => submit2fa() }),
        S.otpError ? h('div', { class: 'field-error', role: 'alert' }, S.otpError) : h('div', { class: 'field-hint' }, 'Код меняется каждые 30 секунд. Не успели — введите следующий.')),
      S.remember && h('div', { class: 'row' }, UI.chip('Устройство запомним на 30 дней', 'accent', 'device')),
      button('Подтвердить и войти', { kind: 'primary', size: 'lg', block: true, type: 'submit', attrs: { id: 'login-2fa-submit' } }),
      h('div', { class: 'login-alt between' },
        h('a', { class: 'login-link', href: '#login' }, icon('chevronLeft'), 'Назад'),
        h('a', { class: 'login-link', href: '#login-backup' }, icon('key'), 'Использовать резервный код')),
      note('telegram', 'Если устройство новое, после входа придёт уведомление в Telegram: город, браузер и время.'),
      demoHint('В макете подойдёт любой код: введите или вставьте 6 любых цифр — вход произойдёт сразу.'));
    return { node: form };
  }
  function submit2fa() {
    if (busy) return;
    if (!/^\d{6}$/.test(S.otp)) {
      S.otpError = 'Введите все 6 цифр кода';
      draw();
      focusSel('.login-otp-box:not(.filled)');
      return;
    }
    busy = true;
    setBusy(document.getElementById('login-2fa-submit'), 'Проверяем код…');
    ROOT.querySelectorAll('.login-otp-box').forEach(b => { b.readOnly = true; });
    later(650, () => enter('Вход выполнен. Уведомление о входе — в Telegram', 'shield'));
  }

  function viewBackup() {
    const f = UI.field({ id: 'login-backup-code', label: 'Резервный код', value: S.backup, placeholder: 'например, 4f7k-2m9q', autocomplete: 'off', error: S.backupError, hint: 'Регистр и дефис не важны.', attrs: { spellcheck: 'false', autocapitalize: 'off', 'data-autofocus': true } });
    f.querySelector('input').classList.add('mono');
    onInput(f, v => { S.backup = v; S.backupError = null; });
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitBackup } },
      stepper(['Пароль', 'Резервный код'], 1),
      head('Шаг 2 из 2', 'Вход по резервному коду', 'Подойдёт любой из 8 кодов, которые вы сохранили при настройке 2FA. Каждый срабатывает один раз.'),
      acctRow(),
      f,
      button('Войти по резервному коду', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'key' }),
      UI.callout('info', 'info', 'После входа останется 7 кодов. Новый набор можно создать в личном кабинете, раздел «Безопасность».'),
      h('div', { class: 'login-alt between' },
        h('a', { class: 'login-link', href: '#login-2fa' }, icon('chevronLeft'), 'Код из приложения'),
        h('button', { type: 'button', class: 'login-link', on: { click: recoveryModal } }, 'Нет ни телефона, ни кодов?')),
      demoHint('В макете подойдёт любой код из 8 букв и цифр.'));
    return { node: form };
  }
  function submitBackup(e) {
    e.preventDefault();
    if (busy) return;
    const v = S.backup.replace(/[\s-]/g, '');
    if (!/^[a-z0-9]{8}$/i.test(v)) { S.backupError = 'Код состоит из 8 букв и цифр, например 4f7k-2m9q'; draw(); focusSel('#login-backup-code'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем код…');
    later(550, () => enter('Вход по резервному коду. Осталось кодов: 7 из 8', 'key'));
  }
  function recoveryModal() {
    UI.modal({
      title: 'Нет ни телефона, ни резервных кодов',
      body: [
        h('p', { class: 'soft' }, 'AI Capper — личный сервис без службы поддержки, которая могла бы «поверить на слово». Поэтому восстановление без второго фактора намеренно сделано неудобным:'),
        h('ol', { class: 'login-ol' },
          h('li', null, 'Владелец сервера запускает команду сброса 2FA в консоли бэкенда.'),
          h('li', null, 'Все сессии завершаются, старые резервные коды перестают работать.'),
          h('li', null, 'При следующем входе вы заново настраиваете 2FA и получаете новые коды.')),
        UI.callout('warn', 'alert', 'Сохраните резервные коды при регистрации — например, в менеджере паролей. Это самый простой способ не оказаться в такой ситуации.'),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  function viewReset() {
    const f = UI.field({ id: 'login-reset-email', label: 'Email аккаунта', type: 'email', value: S.resetEmail != null ? S.resetEmail : S.email, autocomplete: 'username', inputmode: 'email', error: S.resetError, attrs: { spellcheck: 'false', autocapitalize: 'off', 'data-autofocus': true } });
    onInput(f, v => { S.resetEmail = v; S.resetError = null; });
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitReset } },
      head('Восстановление доступа', 'Сброс пароля', 'Пришлём ссылку для нового пароля на email аккаунта. Двухфакторная защита после сброса останется включённой.'),
      f,
      button('Отправить ссылку', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'send' }),
      note('lock', 'Мы не сообщаем, зарегистрирован ли такой email, — так посторонний не сможет проверять адреса.'),
      h('div', { class: 'login-alt' }, h('a', { class: 'login-link', href: '#login' }, icon('chevronLeft'), 'Вернуться ко входу')),
      demoHint('В макете письмо не отправляется — экран показывает, как будет выглядеть шаг.'));
    return { node: form };
  }
  function submitReset(e) {
    e.preventDefault();
    if (busy) return;
    const v = S.resetEmail != null ? S.resetEmail : S.email;
    if (!validEmail(v)) { S.resetError = 'Введите email в формате name@example.com'; draw(); focusSel('#login-reset-email'); return; }
    S.resetEmail = v.trim();
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Отправляем…');
    later(500, () => UI.go('login-sent'));
  }

  function viewSent() {
    const mail = S.resetEmail || S.email || DATA.user.email;
    const node = h('div', { class: 'login-form', role: 'region', 'aria-labelledby': 'login-title' },
      h('div', { class: 'login-bigic', 'aria-hidden': 'true' }, icon('send')),
      head(null, 'Проверьте почту', null),
      h('p', { class: 'soft' }, 'Мы отправили ссылку для сброса пароля на ', h('b', { style: 'color:var(--fg);overflow-wrap:anywhere' }, mail), ', она действует 30 минут.'),
      h('ul', { class: 'login-bul' },
        h('li', null, 'Письмо от AI Capper могло попасть в «Спам» или «Промоакции».'),
        h('li', null, 'Ссылка одноразовая. После смены пароля сессии на других устройствах завершатся.'),
        h('li', null, 'При входе с новым паролем код 2FA всё равно понадобится.')),
      button('Вернуться ко входу', { kind: 'primary', size: 'lg', block: true, href: '#login', attrs: { 'data-autofocus': true } }),
      h('div', { class: 'login-alt between' },
        button(S.resent ? 'Отправлено повторно' : 'Отправить ещё раз', { kind: 'ghost', size: 'sm', icon: S.resent ? 'check' : 'refresh', disabled: S.resent, onClick: () => { S.resent = true; draw(); UI.toast('Ссылка отправлена ещё раз. Следующий повтор — через 60 секунд', 'send'); } }),
        h('a', { class: 'login-link', href: '#login-reset' }, 'Изменить email')),
      demoHint('В макете письмо не отправляется.'));
    return { node };
  }

  function viewLocked() {
    const node = h('div', { class: 'login-form', role: 'region', 'aria-labelledby': 'login-title' },
      h('div', { class: 'login-bigic bad', 'aria-hidden': 'true' }, icon('lock')),
      head('Защита от подбора пароля', 'Вход временно закрыт', '5 неверных паролей подряд. Повторить вход можно через 15 минут.'),
      UI.kv([
        ['Аккаунт', h('span', { style: 'overflow-wrap:anywhere' }, S.email || DATA.user.email)],
        ['Осталось попыток', '0 из ' + MAX_ATTEMPTS],
        ['Повторный вход', 'через 15 минут'],
        ['Уведомление', UI.chip('Отправлено в Telegram', 'good', 'telegram')],
      ]),
      UI.callout('warn', 'alert', 'Если пароль вводили не вы — смените его: ссылка придёт на почту, а сессии на других устройствах завершатся.'),
      button('Сбросить пароль', { kind: 'primary', size: 'lg', block: true, href: '#login-reset', icon: 'key', attrs: { 'data-autofocus': true } }),
      button('Снять блокировку (макет)', { kind: 'ghost', block: true, icon: 'refresh', onClick: () => { S.attempts = MAX_ATTEMPTS; S.error = false; UI.go('login'); UI.toast('Счётчик попыток сброшен — только в макете', 'refresh'); } }),
      demoHint('В макете блокировку можно снять кнопкой выше. В продукте она снимается только по таймеру или после сброса пароля.'));
    return { node };
  }

  function viewInvite() {
    const E = S.regErr;
    const inv = UI.field({ id: 'login-inv-code', label: 'Код приглашения', value: S.reg.invite, placeholder: 'CAP-XXXX-XXXX', autocomplete: 'off', error: E.invite, hint: 'Пример для макета. Настоящий код приходит в письме-приглашении.', attrs: { spellcheck: 'false', autocapitalize: 'characters', 'data-autofocus': true } });
    const invInput = inv.querySelector('input');
    invInput.classList.add('mono'); invInput.style.textTransform = 'uppercase';
    onInput(inv, v => { S.reg.invite = v; E.invite = null; });
    const mail = UI.field({ id: 'login-inv-email', label: 'Email', type: 'email', value: S.reg.email, placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email', error: E.email, hint: 'На него придут ссылки для сброса пароля.', attrs: { spellcheck: 'false', autocapitalize: 'off' } });
    const strength = h('div', { class: 'login-strength' }, strengthContent());
    const match = h('div', { class: 'login-match' }, matchContent());
    const refresh = () => { UI.clear(strength); UI.append(strength, [strengthContent()]); UI.clear(match); UI.append(match, [matchContent()]); };
    onInput(mail, v => { S.reg.email = v; E.email = null; refresh(); });
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitInvite } },
      stepper(['Аккаунт', 'Защита 2FA'], 0),
      head('Закрытый доступ', 'Регистрация по приглашению', 'AI Capper — личный сервис. Код приглашения одноразовый и действует 7 дней.'),
      inv,
      mail,
      pwField({ id: 'login-inv-pwd', label: 'Пароль', value: S.reg.pwd, autocomplete: 'new-password', invalid: !!E.pwd, error: E.pwd, onInput: v => { S.reg.pwd = v; E.pwd = null; refresh(); }, after: strength }),
      pwField({ id: 'login-inv-pwd2', label: 'Повторите пароль', value: S.reg.pwd2, autocomplete: 'new-password', invalid: !!E.pwd2, error: E.pwd2, onInput: v => { S.reg.pwd2 = v; E.pwd2 = null; refresh(); }, after: match }),
      check({ id: 'login-inv-agree', checked: S.reg.agree, error: E.agree, title: 'Понимаю: AI Capper даёт аналитику и вероятности, а не гарантию выигрыша', hint: 'Решение о ставке и риск остаются за мной.', onChange: v => { S.reg.agree = v; if (v) E.agree = null; } }),
      button('Создать аккаунт', { kind: 'primary', size: 'lg', block: true, type: 'submit', iconRight: 'arrowRight' }),
      h('div', { class: 'login-alt' }, h('span', { class: 'muted' }, 'Уже есть аккаунт?'), h('a', { class: 'login-link', href: '#login' }, 'Войти')),
      demoHint('В макете подойдёт любой код вида CAP-XXXX-XXXX. Попробуйте пароль «qwerty123456» — увидите проверку утечек.'));
    return { node: form };
  }
  function submitInvite(e) {
    e.preventDefault();
    if (busy) return;
    const r = S.reg, E = {};
    if (!/^CAP-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(r.invite.trim())) E.invite = 'Код выглядит так: CAP-XXXX-XXXX — скопируйте его из письма';
    if (!validEmail(r.email)) E.email = 'Введите email в формате name@example.com';
    if (!analyze(r.pwd, r.email).ok) E.pwd = 'Пароль не проходит требования ниже';
    if (!E.pwd && r.pwd2 !== r.pwd) E.pwd2 = 'Пароли не совпадают';
    else if (E.pwd && !r.pwd2) E.pwd2 = null;
    if (!r.agree) E.agree = 'Отметьте, чтобы продолжить';
    S.regErr = E;
    if (Object.values(E).some(Boolean)) { draw(); focusSel('.input.invalid, .login-check.invalid input'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Создаём аккаунт…');
    later(600, () => { S.email = r.email.trim(); UI.go('login-setup'); UI.toast('Аккаунт создан. Осталось включить 2FA', 'check'); });
  }

  function viewSetup() {
    const E = S.setupErr;
    const keyCode = h('code', null, SECRET);
    const mobile = UI.isMobile();
    const form = h('form', { class: 'login-form wide', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitSetup } },
      stepper(['Аккаунт', 'Защита 2FA'], 1),
      head('Обязательный шаг', 'Включите двухфакторную защиту', 'Даже если пароль утечёт, без кода с вашего телефона в кабинет не войти.'),
      h('div', { class: 'login-secs' },
        h('section', { class: 'login-s', 'aria-labelledby': 'login-s1' },
          h('span', { class: 'login-s-n', 'aria-hidden': 'true' }, '1'),
          h('div', { class: 'login-s-body' },
            h('h2', { id: 'login-s1' }, 'Отсканируйте QR-код в приложении'),
            h('div', { class: 'login-qrrow' },
              h('div', { class: 'login-qr' }, qrSvg(mobile ? 152 : 164)),
              h('div', { class: 'login-qr-side' },
                h('div', { class: 'small soft' }, 'Подойдёт любое приложение с TOTP-кодами:'),
                h('div', { class: 'row', style: 'gap:6px' }, APPS.map(a => UI.chip(a, 'outline', 'device'))),
                h('div', { class: 'small soft' }, 'Не сканируется? Введите ключ вручную:'),
                h('div', { class: 'login-key' }, keyCode,
                  button('Копировать', { kind: 'secondary', size: 'sm', icon: 'copy', onClick: () => copyText(SECRET.replace(/\s/g, ''), 'Ключ скопирован', keyCode) })),
                h('div', { class: 'xsmall muted' }, 'Тип TOTP · 6 цифр · обновление каждые 30 секунд'))))),
        h('section', { class: 'login-s', 'aria-labelledby': 'login-s2' },
          h('span', { class: 'login-s-n', 'aria-hidden': 'true' }, '2'),
          h('div', { class: 'login-s-body' },
            h('h2', { id: 'login-s2' }, h('label', { for: 'login-setup-otp', id: 'login-setup-otp-label' }, 'Введите код из приложения')),
            otpInput({ id: 'login-setup-otp', labelledBy: 'login-setup-otp-label', value: S.setupOtp, invalid: !!E.otp, onChange: v => { S.setupOtp = v; E.otp = null; } }),
            E.otp ? h('div', { class: 'field-error', role: 'alert' }, E.otp) : h('div', { class: 'field-hint' }, 'Так мы убедимся, что приложение настроено правильно.'))),
        h('section', { class: 'login-s', 'aria-labelledby': 'login-s3' },
          h('span', { class: 'login-s-n', 'aria-hidden': 'true' }, '3'),
          h('div', { class: 'login-s-body' },
            h('h2', { id: 'login-s3' }, 'Сохраните 8 резервных кодов'),
            h('p', { class: 'small soft' }, 'Пригодятся, если потеряете телефон. Каждый код срабатывает один раз. Храните их отдельно от пароля — например, в менеджере паролей.'),
            h('ol', { class: 'login-codes', 'aria-label': 'Резервные коды' }, BACKUP_CODES.map(c => h('li', null, c))),
            h('div', { class: 'row' },
              button('Скопировать коды', { kind: 'secondary', size: 'sm', icon: 'copy', onClick: e => copyText(BACKUP_CODES.join('\n'), 'Резервные коды скопированы', e.currentTarget.closest('.login-s-body').querySelector('.login-codes')) })),
            check({ id: 'login-setup-saved', checked: S.saved, error: E.saved, title: 'Я сохранил(а) резервные коды в надёжном месте', onChange: v => { S.saved = v; if (v) E.saved = null; } })))),
      button('Готово — войти в кабинет', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'check' }),
      demoHint('В макете QR-код и ключ — заглушки, а в шаге 2 подойдёт любой код из 6 цифр.'));
    return { node: form, wide: true };
  }
  function submitSetup(e) {
    e.preventDefault();
    if (busy) return;
    const E = {};
    if (!/^\d{6}$/.test(S.setupOtp)) E.otp = 'Введите 6 цифр из приложения — так мы убедимся, что 2FA настроена';
    if (!S.saved) E.saved = 'Отметьте, что сохранили коды: без них потеря телефона закроет доступ';
    S.setupErr = E;
    if (E.otp || E.saved) { draw(); focusSel(E.otp ? '.login-otp-box:not(.filled)' : '#login-setup-saved'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Включаем 2FA…');
    later(600, () => enter('Готово: 2FA включена, вы в личном кабинете', 'shield'));
  }

  const VIEWS = { login: viewLogin, '2fa': view2fa, backup: viewBackup, reset: viewReset, sent: viewSent, invite: viewInvite, setup: viewSetup, locked: viewLocked };

  // ---------- раскладки ----------
  function secList() {
    return h('ul', { class: 'login-sec-list' }, SEC.map(s => h('li', { class: 'login-sec-item' },
      h('span', { class: 'login-sec-ic', 'aria-hidden': 'true' }, icon(s.icon)),
      h('div', { style: 'min-width:0' }, h('div', { class: 'login-sec-t' }, s.t), h('div', { class: 'login-sec-d' }, s.d)))));
  }
  function demoBtn(mobile) {
    return button('Открыть демо без входа', { kind: 'ghost', size: mobile ? null : 'sm', block: mobile, icon: 'eye', attrs: mobile ? { class: 'btn ghost block login-demo-btn' } : null,
      onClick: () => enter('Демо без входа: все данные вымышлены', 'eye') });
  }

  function desktop(v) {
    return h('div', { class: 'login-page' },
      h('aside', { class: 'login-brand', 'aria-label': 'О сервисе и защите входа' },
        court('v'),
        h('div', { class: 'login-brandrow' }, UI.brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'личный теннисный аналитик'))),
        h('div', { class: 'login-hero' },
          h('div', { class: 'eyebrow' }, 'Закрытый личный кабинет'),
          h('p', { class: 'login-hero-h' }, 'Теннисная аналитика, которая учится на своих ставках'),
          h('p', { class: 'login-hero-p' }, 'Claude собирает данные об игроках, разбирает матчи, которые вы внесли, предлагает экспресс и сверяет прогнозы с результатами.'),
          h('p', { class: 'login-hero-note' }, icon('info'), 'Аналитика и вероятности — не гарантия выигрыша.')),
        h('section', { class: 'login-sec', 'aria-labelledby': 'login-sec-title' },
          h('div', { class: 'login-sec-head' }, icon('shield'), h('h2', { id: 'login-sec-title' }, 'Как защищён вход'), UI.chip('6 мер', 'accent', 'check')),
          secList()),
        h('div', { class: 'login-brandfoot' }, h('span', null, '© 2026 AI Capper · личный сервис'), h('span', null, 'Соединение только по HTTPS (TLS 1.3)'))),
      h('main', { class: 'login-main' },
        h('div', { class: 'login-topline' }, demoBtn(false), themeBtn()),
        h('div', { class: 'login-center' }, v.node),
        h('footer', { class: 'login-foot' }, h('span', { class: 'demo-pill' }, 'Макет · демо-данные'), h('span', null, 'Аккаунты, коды и письма в макете вымышлены'))));
  }

  function mobile(v) {
    return h('div', { class: 'login-m' },
      h('header', { class: 'login-m-hero' },
        court('h'),
        h('div', { class: 'login-m-top' },
          h('div', { class: 'login-brandrow' }, UI.brandMark(), h('div', { style: 'min-width:0' }, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'личный теннисный аналитик'))),
          themeBtn()),
        h('p', { class: 'login-m-lead' }, 'Разбор матчей и экспресс от Claude, который учится на своих ставках.')),
      h('main', { class: 'login-m-card' }, v.node),
      h('details', { class: 'login-secd' },
        h('summary', null, icon('shield'),
          h('span', { class: 'login-secd-t' }, h('b', null, 'Как защищён вход'), h('span', { class: 'xsmall muted' }, 'Argon2id, 2FA, журнал входов')),
          UI.chip('6 мер', 'accent'),
          icon('chevronDown', { class: 'chev' })),
        secList()),
      demoBtn(true),
      h('footer', { class: 'login-m-foot' }, h('span', { class: 'demo-pill' }, 'Макет · демо-данные'), h('span', null, 'Аккаунты, коды и письма в макете вымышлены')));
  }

  function draw(focusFirst) {
    if (!ROOT) return;
    UI.css('login', CSS);
    UI.clear(ROOT);
    const v = VIEWS[S.step]();
    ROOT.appendChild(UI.isMobile() ? mobile(v) : desktop(v));
    document.title = TITLES[S.step] + ' · AI Capper';
    if (focusFirst) focusSel('[data-autofocus]');
  }

  UI.register('login', {
    title: 'Вход',
    shell: false,
    render(root, param) {
      ROOT = root;
      const step = STEPS.includes(param) ? param : 'login';
      const changed = S.lastStep !== null && S.lastStep !== step;
      if (changed) {
        // уходя с шага, сбрасываем его ошибки и одноразовые поля
        S.emailError = null; S.otpError = null; S.backupError = null; S.resetError = null;
        S.regErr = {}; S.setupErr = {}; S.otp = ''; S.backup = '';
        if (step !== 'login') S.error = false;
        if (step !== 'sent') S.resent = false;
        busy = false;
      }
      S.step = step; S.lastStep = step;
      draw(changed);
      if (changed) window.scrollTo(0, 0);
    },
  });
})();
