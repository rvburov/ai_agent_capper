/* Экран входа (без оболочки приложения): защищенный вход в личный кабинет.
   Шаги — подмаршруты #login-<шаг>: вход по паролю → код 2FA (или резервный код), демо-вход под двумя ролями,
   сброс пароля кодом от администратора (Р5, Р6), регистрация по коду приглашения (Р4; email берем из приглашения
   в DATA.admin.invites) → настройка 2FA,
   пауза после 5 неудачных попыток с одного IP. Почты и Telegram нет (Р2, Р3).
   Состояние живет в памяти модуля, поэтому смена темы или ширины экрана не сбрасывает введенное. */
(function () {
  'use strict';
  const { h, icon, button } = UI;

  const STEPS = ['login', '2fa', 'backup', 'reset', 'done', 'invite', 'setup', 'locked'];
  const TITLES = { login: 'Вход', '2fa': 'Код подтверждения', backup: 'Резервный код', reset: 'Сброс пароля', done: 'Пароль изменен', invite: 'Регистрация', setup: 'Настройка 2FA', locked: 'Вход временно закрыт' };
  const MAX_ATTEMPTS = 5;
  const SECRET = 'JK3M Q7XP L2VD 6WRA ZT4N HC5Y B7QE 2MKS';
  const BACKUP_CODES = ['4f7k-2m9q', 'x8c3-vn5d', '7hpt-k2wz', 'm6qa-93rf', 'e2yd-u7jb', 'r5ns-8gxk', 'b9wl-c4tm', 'q3jv-6pzh'];
  const LEAKED = ['password', 'qwerty', '123456', '111111', '000000', 'йцукен', 'пароль', 'iloveyou', 'admin', 'letmein', 'abc123'];
  const APPS = ['Google Authenticator', 'Microsoft Authenticator', '1Password'];
  const APPS_TEXT = 'Google Authenticator, Microsoft Authenticator или 1Password';

  const SEC = [
    { icon: 'lock', t: 'Пароль — только хеш Argon2id', d: 'Сам пароль не хранится и не попадает в логи' },
    { icon: 'shield', t: 'Двухфакторная аутентификация', d: 'TOTP-коды: ' + APPS_TEXT },
    { icon: 'key', t: 'Сессия в защищенной httpOnly-cookie', d: 'Secure и SameSite: скрипты на странице ее не прочитают' },
    { icon: 'alert', t: 'Пауза после 5 неудачных попыток', d: 'IP-адрес ждет 15 минут, с других устройств вход работает' },
    { icon: 'bell', t: 'Уведомление о новом устройстве', d: 'На сайте и push — о каждом входе с нового устройства' },
    { icon: 'history', t: 'Журнал входов', d: 'Устройство, город и время — в личном кабинете' },
  ];

  const LEVELS = [
    { label: 'Не задан', chip: 'outline', icon: 'info', meter: null },
    { label: 'Слабый', chip: 'bad', icon: 'alert', meter: 'bad' },
    { label: 'Средний', chip: 'warn', icon: 'alert', meter: 'warn' },
    { label: 'Хороший', chip: 'accent', icon: 'check', meter: null },
    { label: 'Надежный', chip: 'good', icon: 'shield', meter: 'login-good' },
  ];

  // Демо-коды, которые показывают ошибку «код не подходит»
  const BAD_RESET = 'RST-0000-0000';
  const BAD_INVITE = 'CAP-0000-0000';
  const CLI = 'docker compose exec api python -m app.admin.cli';

  function fresh() {
    return {
      step: 'login', lastStep: null,
      email: DATA.personas.admin.email, pwd: '', remember: false, attempts: MAX_ATTEMPTS, error: false, emailError: null, pwdError: null,
      otp: '', otpError: null, backup: '', backupError: null,
      rs: { email: null, code: '', pwd: '', pwd2: '' }, rsErr: {}, rsDoneEmail: null,
      reg: { invite: null, name: '', email: '', emailAuto: null, pwd: '', pwd2: '', age: false, ai: false, train: false }, regErr: {},
      setupMode: 'reg', regRole: 'member', setupOtp: '', saved: false, setupErr: {},
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
  /* зона нажатия 44 px, не меняя высоту строки */
  .login-link { position: relative; }
  .login-link::before { content: ""; position: absolute; left: -6px; right: -6px; top: 50%; height: 44px; transform: translateY(-50%); }
  .login-label-row .login-link::before { top: auto; bottom: -6px; transform: none; }
  .login-link svg { width: 16px; height: 16px; flex: none; }
  .login-pw { position: relative; min-width: 0; }
  .login-pw .input { padding-right: 50px; }
  .login-eye { position: absolute; right: 3px; top: 50%; transform: translateY(-50%); width: 40px; height: 40px; border: 0; background: none; border-radius: 8px; color: var(--fg-3); display: grid; place-items: center; cursor: pointer; }
  .login-eye:hover { background: var(--surface-2); color: var(--fg); }
  .login-eye svg { width: 19px; height: 19px; }
  .login-caps { display: flex; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--warn-ink); font-weight: 500; }
  .login-caps[hidden] { display: none; }
  .login-caps svg { width: 14px; height: 14px; }
  .login-check { font-size: var(--fs-md); }
  .login-check > span { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .login-check.invalid input { outline: 2px solid var(--bad); outline-offset: 1px; }
  .login-alt { display: flex; align-items: center; justify-content: center; gap: 6px 12px; flex-wrap: wrap; font-size: var(--fs-sm); }
  .login-alt.between { justify-content: space-between; row-gap: 24px; }
  .login-note { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-xs); color: var(--fg-3); }
  .login-note svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
  .login-demo { display: flex; gap: 8px; align-items: flex-start; padding: 10px 12px; border: 1px dashed var(--line-strong); border-radius: var(--r-md); font-size: var(--fs-xs); color: var(--fg-2); }
  .login-demo svg { width: 16px; height: 16px; flex: none; color: var(--fg-3); margin-top: 1px; }
  .login-demo b { color: var(--fg); font-weight: 600; }

  /* демо-вход под двумя ролями */
  .login-demoin { display: flex; flex-direction: column; gap: 10px; padding: 14px; border: 1px dashed var(--line-strong); border-radius: var(--r-lg); background: var(--surface-2); min-width: 0; }
  .login-demoin-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
  .login-demoin-head > svg { width: 18px; height: 18px; flex: none; color: var(--fg-3); }
  .login-demoin-head h2 { font-size: var(--fs-md); font-weight: 600; }
  .login-demoin-head .demo-pill { margin-left: auto; }
  .login-demoin-list { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
  .role-opt.login-persona { align-items: center; padding: 9px 12px; min-height: 56px; }
  .login-persona .role-opt-ic { background: var(--accent-soft); }
  .login-persona .role-opt-text b { font-weight: 600; }
  .login-persona .role-opt-text span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .login-persona > svg { width: 18px; height: 18px; flex: none; color: var(--fg-3); }
  .login-persona:hover > svg { color: var(--accent-ink); }
  .login-persona:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .login-demoin .login-note { margin: 0; }
  @media (max-width: 480px) {
    .login-demoin { padding: 12px; }
    .role-opt.login-persona { padding: 8px 10px; gap: 10px; }
    .login-persona > svg, .login-persona-mail { display: none; }
  }

  /* команда терминала для администратора */
  .login-cmd { font-size: var(--fs-xs); color: var(--fg-3); display: flex; gap: 8px; align-items: flex-start; }
  .login-cmd > svg { width: 16px; height: 16px; flex: none; margin-top: 1px; }
  .login-cmd code { font-family: var(--font-mono); font-size: .6875rem; color: var(--fg-2); background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 1px 5px; overflow-wrap: anywhere; -webkit-box-decoration-break: clone; box-decoration-break: clone; }

  /* уведомление о данных и согласия */
  .login-data { display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; border-radius: var(--r-md); background: var(--surface-2); min-width: 0; }
  .login-data-h { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: var(--fs-sm); }
  .login-data-h svg { width: 16px; height: 16px; flex: none; color: var(--accent-ink); }
  .login-data ul { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: var(--fs-xs); color: var(--fg-2); }
  .login-consents { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
  .login-req { color: var(--bad-ink); margin-left: 2px; }
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
  .login-m-foot { display: flex; flex-direction: column; align-items: center; gap: 6px; font-size: var(--fs-xs); color: var(--fg-3); text-align: center; }
  `;

  // ---------- мелкие помощники ----------
  function isDark() { return (document.documentElement.dataset.theme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark'; }
  function themeBtn() { const d = isDark(); return button('', { kind: 'ghost', size: 'sm', icon: d ? 'sun' : 'moon', title: d ? 'Светлая тема' : 'Темная тема', onClick: () => UI.toggleTheme() }); }
  function focusSel(sel) { requestAnimationFrame(() => { const el = ROOT && ROOT.querySelector(sel); if (el) el.focus(); }); }
  function setBusy(btn, label) {
    if (!btn) return;
    btn.disabled = true; btn.classList.add('login-busy'); btn.setAttribute('aria-busy', 'true');
    UI.clear(btn); btn.append(h('span', { class: 'login-spin', 'aria-hidden': 'true' }), h('span', null, label));
  }
  function later(ms, fn) { setTimeout(() => { busy = false; if (ROOT && ROOT.isConnected) fn(); }, ms); }
  // Демо-персона по email: olga@example.com — участник, любой другой адрес — администратор
  function personaFor(email) {
    const e = String(email || '').trim().toLowerCase();
    return Object.values(DATA.personas).find(p => p.email === e) || null;
  }
  function roleFor(email) { const p = personaFor(email); return p ? p.role : 'admin'; }
  function roleWord(role, form) { return role === 'member' ? (form === 'gen' ? 'участника' : 'участник') : (form === 'gen' ? 'администратора' : 'администратор'); }
  // Успешный вход: сбрасываем состояние экрана и открываем «Главную» под нужной ролью
  function enter(role, msg, ic) {
    S = fresh(); busy = false;
    UI.auth.login(role);
    const p = DATA.personas[role];
    UI.toast(msg || ('Вход выполнен: ' + p.name + ', ' + roleWord(role)), ic || 'check');
  }
  function validEmail(v) { return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim()); }
  // Маска кода вида PFX-XXXX-XXXX: заглавные буквы, дефисы ставятся сами
  function maskCode(pfx, raw) {
    let t = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!t) return '';
    if (t.startsWith(pfx)) t = t.slice(pfx.length);
    else if (pfx.startsWith(t)) return t;
    t = t.slice(0, 8);
    return t ? pfx + '-' + t.slice(0, 4) + (t.length > 4 ? '-' + t.slice(4) : '') : pfx;
  }
  function codeOk(pfx, v) { return new RegExp('^' + pfx + '-[A-Z0-9]{4}-[A-Z0-9]{4}$').test(v); }
  // Поле кода с маской: при вводе в конце строки сразу показываем код в правильном виде
  function codeField(pfx, o) {
    const f = UI.field({ id: o.id, label: o.label, value: o.value, placeholder: pfx + '-XXXX-XXXX', autocomplete: 'off', error: o.error, hint: o.hint,
      attrs: Object.assign({ spellcheck: 'false', autocapitalize: 'characters', autocorrect: 'off' }, o.attrs || {}) });
    const i = f.querySelector('input');
    i.classList.add('mono');
    i.addEventListener('input', e => {
      const atEnd = i.selectionStart === i.value.length;
      const deleting = e.inputType && e.inputType.startsWith('delete');
      if (atEnd && !deleting) { const m = maskCode(pfx, i.value); if (m !== i.value) i.value = m; }
    });
    i.addEventListener('blur', () => { const m = maskCode(pfx, i.value); if (m !== i.value) { i.value = m; o.onInput(m); } });
    onInput(f, v => o.onInput(v));
    return f;
  }
  // Строка мелким текстом с командой для сервера (Р6)
  function cliLine(lead, cmd) {
    return h('p', { class: 'login-cmd' }, icon('terminal'), h('span', { style: 'min-width:0' }, lead + ' ', h('code', null, CLI + ' ' + cmd + ' --email …')));
  }

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
  function demoHint(...text) { return h('div', { class: 'login-demo' }, icon('flask'), h('span', null, text)); }
  function nb(code) { return h('span', { style: 'white-space:nowrap' }, code); }
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
    const caps = h('div', { class: 'login-caps', hidden: true }, icon('alert'), 'Включен Caps Lock');
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

  // ---------- пароль: надежность и правила ----------
  function analyze(p, email) {
    const low = p.toLowerCase();
    const local = (email || '').split('@')[0].toLowerCase();
    const len = p.length >= 12;
    const mix = /[a-zа-яе]/i.test(p) && /\d/.test(p);
    const leaked = !!p && (LEAKED.some(w => low.includes(w)) || (local.length >= 3 && low.includes(local)));
    let score = 0;
    if (p) {
      score = 1;
      if (p.length >= 8) score = 2;
      if (len && mix) score = 3;
      if (len && mix && (p.length >= 16 || /[^a-zа-яе0-9]/i.test(p) || (/[A-ZА-ЯЕ]/.test(p) && /[a-zа-яе]/.test(p)))) score = 4;
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
  function strengthContent(p, email) {
    const r = analyze(p, email), lv = LEVELS[r.score];
    const m = UI.meter(r.score, 4, lv.meter);
    m.setAttribute('aria-label', 'Надежность пароля'); m.setAttribute('aria-valuetext', lv.label);
    return [
      h('div', { class: 'row-between' }, h('span', { class: 'small soft' }, 'Надежность пароля'), UI.chip(lv.label, lv.chip, lv.icon)),
      m,
      h('ul', { class: 'login-rules', 'aria-label': 'Требования к паролю' },
        rule(r.len ? 'ok' : 'todo', p ? '12+ символов (сейчас ' + p.length + ')' : '12+ символов'),
        rule(r.mix ? 'ok' : 'todo', 'Буквы и цифры'),
        rule(!p ? 'todo' : r.leaked ? 'bad' : 'ok', r.leaked ? 'Встречался в утечках — придумайте другой' : 'Не встречался в утечках')),
      h('div', { class: 'field-hint' }, 'Проверка по базе утечек Have I Been Pwned: отправляются только первые 5 символов хеша, сам пароль никуда не уходит.'),
    ];
  }
  function matchContent(pwd, pwd2) {
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
          S.attempts === 1 && h('div', null, 'После следующей ошибки вход с этого IP-адреса закроется на 15 минут.'))),
      email,
      pwField({ id: 'login-password', label: 'Пароль', value: S.pwd, autocomplete: 'current-password', invalid: !!(err || S.pwdError), error: S.pwdError, describedBy: err ? 'login-error' : null, autofocus: true,
        aside: h('a', { class: 'login-link', href: '#login-reset' }, 'Забыли пароль?'), onInput: v => { S.pwd = v; S.pwdError = null; } }),
      check({ id: 'login-remember', checked: S.remember, title: 'Запомнить это устройство на 30 дней', hint: 'Код 2FA здесь не спросим 30 дней. Не отмечайте на чужом компьютере.', onChange: v => { S.remember = v; } }),
      button('Войти', { kind: 'primary', size: 'lg', block: true, type: 'submit', iconRight: 'arrowRight' }),
      h('div', { class: 'login-alt' }, h('span', { class: 'muted' }, 'Нет аккаунта?'), h('a', { class: 'login-link', href: '#login-invite' }, 'Регистрация только по приглашению', icon('chevronRight'))),
      demoLogin());
    return { node: form };
  }
  // Демо-вход: сразу в макет под выбранной ролью, без пароля и 2FA
  function demoLogin() {
    const P = DATA.personas;
    const opt = (role, title) => h('button', { type: 'button', class: ['role-opt', 'login-persona'], 'data-demo-role': role, on: { click: () => enter(role, 'Демо-вход: ' + P[role].name + ', ' + roleWord(role) + '. Данные вымышлены', 'eye') } },
      h('span', { class: 'role-opt-ic', 'aria-hidden': 'true' }, icon(role === 'admin' ? 'admin' : 'user')),
      h('span', { class: 'role-opt-text' }, h('b', null, title), h('span', { class: 'small soft' }, P[role].name, h('span', { class: 'login-persona-mail' }, ' · ' + P[role].email))),
      icon('arrowRight'));
    return h('section', { class: 'login-demoin', 'aria-labelledby': 'login-demo-title' },
      h('div', { class: 'login-demoin-head' }, icon('flask'), h('h2', { id: 'login-demo-title' }, 'Демо-вход'), h('span', { class: 'demo-pill' }, 'без пароля и 2FA')),
      h('div', { class: 'login-demoin-list' },
        opt('admin', 'Войти как администратор'),
        opt('member', 'Войти как участник')),
      note('info', 'Обычный вход в макете тоже работает: ' + P.member.email + ' откроет кабинет участника, другой email — администратора. Пароль «wrong» покажет ошибку.'));
  }
  function submitLogin(e) {
    e.preventDefault();
    if (busy) return;
    S.emailError = null; S.pwdError = null;
    // пустые поля проверяем до сервера: такая ошибка не тратит попытку входа
    if (!validEmail(S.email)) { S.error = false; S.emailError = 'Введите email в формате name@example.com'; draw(); focusSel('#login-email'); return; }
    if (!S.pwd) { S.error = false; S.pwdError = 'Введите пароль'; draw(); focusSel('#login-password'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем…');
    later(450, () => {
      if (S.pwd === 'wrong') {
        S.attempts -= 1; S.pwd = '';
        if (S.attempts <= 0) { S.attempts = 0; S.error = false; UI.go('login-locked'); return; }
        S.error = true; draw(); focusSel('#login-password'); return;
      }
      S.error = false; S.pwd = '';
      UI.go('login-2fa');
    });
  }

  function acctRow() {
    const mail = (S.email || DATA.personas.admin.email).trim();
    const p = personaFor(mail);
    return h('div', { class: 'login-acct' },
      h('span', { class: 'avatar', 'aria-hidden': 'true' }, p ? p.initials : mail.charAt(0).toUpperCase()),
      h('div', { class: 'login-acct-body' }, h('div', { class: 'xsmall muted' }, 'Входите как'), h('div', { class: 'login-acct-addr', title: mail }, mail)),
      h('a', { class: 'login-link', href: '#login' }, 'Не вы?'));
  }

  function view2fa() {
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: e => { e.preventDefault(); submit2fa(); } } },
      stepper(['Пароль', 'Код 2FA'], 1),
      head('Шаг 2 из 2', 'Код из приложения', 'Откройте ' + APPS_TEXT + ' — там 6 цифр для AI Capper.'),
      acctRow(),
      h('div', { class: 'field' },
        h('label', { class: 'field-label', for: 'login-otp-1', id: 'login-otp-label' }, 'Код из приложения-аутентификатора'),
        otpInput({ id: 'login-otp-1', labelledBy: 'login-otp-label', value: S.otp, invalid: !!S.otpError, autofocus: true, onChange: v => { S.otp = v; S.otpError = null; }, onComplete: () => submit2fa() }),
        S.otpError ? h('div', { class: 'field-error', role: 'alert' }, S.otpError) : h('div', { class: 'field-hint' }, 'Код меняется каждые 30 секунд. Не успели — введите следующий.')),
      S.remember && h('div', { class: 'row' }, UI.chip('Устройство запомним на 30 дней', 'accent', 'device')),
      button('Подтвердить и войти', { kind: 'primary', size: 'lg', block: true, type: 'submit', attrs: { id: 'login-2fa-submit' } }),
      h('div', { class: 'login-alt between' },
        h('a', { class: 'login-link', href: '#login' }, icon('chevronLeft'), 'Назад'),
        h('a', { class: 'login-link', href: '#login-backup', id: 'login-no-app' }, icon('key'), 'Нет доступа к приложению-аутентификатору')),
      note('bell', 'Вход с нового устройства появится в центре уведомлений на сайте и придет push, если он включен: город, браузер и время.'),
      demoHint('В макете подойдут любые 6 цифр — вход произойдет сразу, откроется кабинет ' + roleWord(roleFor(S.email), 'gen') + ' (роль в макете определяется по email).'));
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
    later(650, () => enter(roleFor(S.email), null, 'shield'));
  }

  function viewBackup() {
    const f = UI.field({ id: 'login-backup-code', label: 'Резервный код', value: S.backup, placeholder: 'например, 4f7k-2m9q', autocomplete: 'off', error: S.backupError, hint: 'Регистр и дефис не важны.', attrs: { spellcheck: 'false', autocapitalize: 'off', 'data-autofocus': true } });
    f.querySelector('input').classList.add('mono');
    onInput(f, v => { S.backup = v; S.backupError = null; });
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitBackup } },
      stepper(['Пароль', 'Резервный код'], 1),
      head('Нет доступа к приложению', 'Вход по резервному коду', 'Подойдет любой из 8 кодов, которые вы сохранили при настройке 2FA. Каждый срабатывает один раз.'),
      acctRow(),
      f,
      button('Войти по резервному коду', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'key' }),
      UI.callout('info', 'info', 'После входа останется 7 кодов. Новый набор можно создать в «Личном кабинете → Безопасность».'),
      h('div', { class: 'login-alt between' },
        h('a', { class: 'login-link', href: '#login-2fa' }, icon('chevronLeft'), 'Код из приложения'),
        h('button', { type: 'button', class: 'login-link', id: 'login-no-codes', on: { click: recoveryModal } }, 'Нет и резервных кодов?')),
      demoHint('В макете подойдет любой код из 8 букв и цифр.'));
    return { node: form };
  }
  function submitBackup(e) {
    e.preventDefault();
    if (busy) return;
    const v = S.backup.replace(/[\s-]/g, '');
    if (!/^[a-z0-9]{8}$/i.test(v)) { S.backupError = 'Код состоит из 8 букв и цифр, например 4f7k-2m9q'; draw(); focusSel('#login-backup-code'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем код…');
    later(550, () => enter(roleFor(S.email), 'Вход по резервному коду. Осталось кодов: 7 из 8', 'key'));
  }
  // Потеря 2FA и резервных кодов (Р5): сбрасывает администратор, затем 2FA настраивается заново
  function recoveryModal() {
    UI.modal({
      title: 'Нет ни приложения, ни резервных кодов',
      body: close => [
        h('p', { class: 'soft' }, 'Попросите администратора сбросить 2FA. После сброса при входе настроите ее заново.'),
        h('ol', { class: 'login-ol' },
          h('li', null, 'Напишите администратору AI Capper так, как вы обычно с ним связываетесь.'),
          h('li', null, 'Он нажмет «Сбросить 2FA» в кабинете администратора. Ваши сеансы завершатся, старые резервные коды перестанут работать.'),
          h('li', null, 'Войдите по email и паролю — сразу откроется настройка 2FA: новый QR-код и 8 новых резервных кодов.')),
        UI.callout('info', 'info', 'Пароль при этом не меняется. Если забыли и его, попросите у администратора еще и код сброса пароля.'),
        cliLine('Вы администратор? 2FA сбрасывается командой на сервере:', 'reset-2fa'),
        h('button', { type: 'button', class: 'login-link', style: 'align-self:flex-start', on: { click: () => { close(); S.setupMode = 'reset'; UI.go('login-setup'); } } },
          icon('eye'), 'Макет: показать вход после сброса 2FA'),
      ],
      actions: close => [button('Понятно', { kind: 'primary', onClick: close })],
    });
  }

  // «Забыли пароль?» (Р5, Р6): без почты — одноразовый код сброса от администратора, 24 часа
  function viewReset() {
    const R = S.rs, E = S.rsErr;
    const mailVal = R.email != null ? R.email : S.email;
    const mail = UI.field({ id: 'login-rs-email', label: 'Email аккаунта', type: 'email', value: mailVal, autocomplete: 'username', inputmode: 'email', error: E.email, attrs: { spellcheck: 'false', autocapitalize: 'off' } });
    const code = codeField('RST', { id: 'login-rs-code', label: 'Код сброса', value: R.code, error: E.code, hint: 'Формат RST-XXXX-XXXX: буквы и цифры, дефисы появятся сами.', attrs: { 'data-autofocus': true }, onInput: v => { R.code = v; E.code = null; } });
    const strength = h('div', { class: 'login-strength' }, strengthContent(R.pwd, mailVal));
    const match = h('div', { class: 'login-match' }, matchContent(R.pwd, R.pwd2));
    const refresh = () => {
      const m = R.email != null ? R.email : S.email;
      UI.clear(strength); UI.append(strength, [strengthContent(R.pwd, m)]);
      UI.clear(match); UI.append(match, [matchContent(R.pwd, R.pwd2)]);
    };
    onInput(mail, v => { R.email = v; E.email = null; refresh(); });
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitReset } },
      head('Восстановление доступа', 'Сброс пароля', null),
      UI.callout('accent', 'key', h('div', null, h('b', null, 'Напишите администратору'), ' — он выдаст одноразовый код сброса, код действует 24 часа. Введите его ниже вместе с новым паролем.')),
      mail,
      code,
      pwField({ id: 'login-rs-pwd', label: 'Новый пароль', value: R.pwd, autocomplete: 'new-password', invalid: !!E.pwd, error: E.pwd, onInput: v => { R.pwd = v; E.pwd = null; refresh(); }, after: strength }),
      pwField({ id: 'login-rs-pwd2', label: 'Повторите новый пароль', value: R.pwd2, autocomplete: 'new-password', invalid: !!E.pwd2, error: E.pwd2, onInput: v => { R.pwd2 = v; E.pwd2 = null; refresh(); }, after: match }),
      button('Сменить пароль', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'lock' }),
      note('lock', 'После смены пароля все ваши сеансы завершатся. Код 2FA при входе по-прежнему понадобится.'),
      cliLine('Вы администратор? Пароль восстанавливается командой на сервере:', 'reset-code'),
      h('div', { class: 'login-alt' }, h('a', { class: 'login-link', href: '#login' }, icon('chevronLeft'), 'Вернуться ко входу')),
      demoHint('В макете подойдет любой код вида ', nb('RST-XXXX-XXXX'), '. Код ', nb(BAD_RESET), ' покажет ошибку «код не подходит».'));
    return { node: form };
  }
  function submitReset(e) {
    e.preventDefault();
    if (busy) return;
    const R = S.rs, E = {};
    const mail = (R.email != null ? R.email : S.email).trim();
    R.code = maskCode('RST', R.code);
    if (!validEmail(mail)) E.email = 'Введите email в формате name@example.com';
    if (!R.code) E.code = 'Введите код сброса от администратора';
    else if (!codeOk('RST', R.code)) E.code = 'Код выглядит так: RST-XXXX-XXXX — 8 букв и цифр после RST';
    if (!analyze(R.pwd, mail).ok) E.pwd = R.pwd ? 'Пароль не проходит требования ниже' : 'Придумайте новый пароль';
    if (!E.pwd && R.pwd2 !== R.pwd) E.pwd2 = 'Пароли не совпадают';
    S.rsErr = E;
    if (Object.values(E).some(Boolean)) { draw(); focusSel('.login-form .input.invalid'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем код…');
    later(550, () => {
      // Ответ одинаковый для неверного кода и чужого email: посторонний не узнает, есть ли аккаунт
      if (R.code === BAD_RESET) { S.rsErr = { code: 'Код не подходит: он неверный, уже использован, истек (24 часа) или выдан на другой email. Попросите у администратора новый.' }; draw(); focusSel('#login-rs-code'); return; }
      S.rsDoneEmail = mail;
      S.rs = { email: null, code: '', pwd: '', pwd2: '' };
      UI.go('login-done');
    });
  }

  function viewDone() {
    const mail = S.rsDoneEmail || S.email;
    const node = h('div', { class: 'login-form', role: 'region', 'aria-labelledby': 'login-title' },
      h('div', { class: 'login-bigic', 'aria-hidden': 'true' }, icon('check')),
      head(null, 'Пароль изменен', 'Все сеансы завершены, войдите заново.'),
      h('ul', { class: 'login-bul' },
        h('li', null, 'Аккаунт: ', h('b', { style: 'color:var(--fg);overflow-wrap:anywhere' }, mail), '.'),
        h('li', null, 'Код сброса больше не действует — он одноразовый.'),
        h('li', null, 'При входе понадобится код 2FA из приложения или резервный код.')),
      button('Войти с новым паролем', { kind: 'primary', size: 'lg', block: true, iconRight: 'arrowRight', attrs: { 'data-autofocus': true },
        onClick: () => { S.email = mail; S.pwd = ''; S.error = false; S.attempts = MAX_ATTEMPTS; UI.go('login'); } }));
    return { node };
  }

  // Пауза после 5 неудач с одного IP (раздел 7 PLAN.md): с других устройств вход работает,
  // экран одинаковый и для несуществующих email
  function viewLocked() {
    const node = h('div', { class: 'login-form', role: 'region', 'aria-labelledby': 'login-title' },
      h('div', { class: 'login-bigic bad', 'aria-hidden': 'true' }, icon('lock')),
      head('Защита от подбора пароля', 'Вход временно закрыт', '5 неудачных попыток с этого IP-адреса. С него войти можно будет через 15 минут, с других устройств — сразу.'),
      UI.kv([
        ['Email', h('span', { style: 'overflow-wrap:anywhere' }, S.email || DATA.personas.admin.email)],
        ['Пауза для этого IP', '15 минут'],
        ['Другие устройства', 'вход работает как обычно'],
        ['Уведомление', 'владельцу аккаунта — на сайте и push'],
      ]),
      UI.callout('warn', 'alert', h('div', null, 'Если пароль подбирали не вы — после входа смените его в «Личном кабинете → Безопасность» и завершите чужие сеансы. Забыли пароль — попросите у администратора код сброса.')),
      button('Сбросить пароль по коду', { kind: 'primary', size: 'lg', block: true, href: '#login-reset', icon: 'key', attrs: { 'data-autofocus': true } }),
      button('Снять паузу (макет)', { kind: 'ghost', block: true, icon: 'refresh', onClick: () => { S.attempts = MAX_ATTEMPTS; S.error = false; UI.go('login'); UI.toast('Счетчик попыток сброшен — только в макете', 'refresh'); } }),
      demoHint('В макете паузу можно снять кнопкой выше. В продукте она заканчивается сама через 15 минут.'));
    return { node };
  }

  // Регистрация только по коду приглашения (Р4) с согласиями и уведомлением о данных (Р15, GDPR)
  const INVITES = () => DATA.admin.invites || [];
  function activeInvite() { const a = INVITES().find(i => i.status === 'active'); return a ? a.code : ''; }
  // Приглашение по коду (DATA.admin.invites): администратор выдает его на конкретный email
  function inviteFor(code) { return INVITES().find(i => i.code === maskCode('CAP', code)) || null; }
  const MAIL_HINT = 'Это ваш логин для входа.';
  const mailHint = inv => (inv ? 'Подставлен из приглашения: код выдан на этот адрес. ' + MAIL_HINT : MAIL_HINT);
  // Email из приглашения подставляем, пока человек не ввел свой; сменился код — подставленный адрес убираем
  function fillInviteEmail(R) {
    const inv = inviteFor(R.invite), auto = R.emailAuto && R.email === R.emailAuto;
    if (inv && (!R.email.trim() || auto)) { R.email = inv.email; R.emailAuto = inv.email; }
    else if (!inv && auto) { R.email = ''; R.emailAuto = null; }
    return inv;
  }
  function viewInvite() {
    const E = S.regErr, R = S.reg;
    if (R.invite == null) R.invite = activeInvite();
    fillInviteEmail(R);
    let mail = null;
    const syncMail = () => { // код поменялся — обновляем подставленный email и подсказку без перерисовки формы
      if (!mail) return;
      const inv = fillInviteEmail(R), i = mail.querySelector('input'), hint = mail.querySelector('.field-hint');
      if (i.value !== R.email) { i.value = R.email; refresh(); }
      if (hint) hint.textContent = mailHint(inv && inv.email === R.email.trim().toLowerCase() ? inv : null);
    };
    const inv = codeField('CAP', { id: 'login-inv-code', label: 'Код приглашения', value: R.invite, error: E.invite, hint: 'Код выдает администратор, он действует 7 дней.', attrs: { 'data-autofocus': true }, onInput: v => { R.invite = v; E.invite = null; syncMail(); } });
    const name = UI.field({ id: 'login-inv-name', label: 'Имя', value: R.name, placeholder: 'Как к вам обращаться', autocomplete: 'name', error: E.name, attrs: { autocapitalize: 'words' } });
    onInput(name, v => { R.name = v; E.name = null; });
    const known = inviteFor(R.invite);
    mail = UI.field({ id: 'login-inv-email', label: 'Email', type: 'email', value: R.email, placeholder: 'you@example.com', autocomplete: 'email', inputmode: 'email', error: E.email, hint: mailHint(known && known.email === R.email.trim().toLowerCase() ? known : null), attrs: { spellcheck: 'false', autocapitalize: 'off' } });
    const strength = h('div', { class: 'login-strength' }, strengthContent(R.pwd, R.email));
    const match = h('div', { class: 'login-match' }, matchContent(R.pwd, R.pwd2));
    const refresh = () => { UI.clear(strength); UI.append(strength, [strengthContent(R.pwd, R.email)]); UI.clear(match); UI.append(match, [matchContent(R.pwd, R.pwd2)]); };
    onInput(mail, v => { R.email = v; E.email = null; refresh(); const k = inviteFor(R.invite), hint = mail.querySelector('.field-hint'); if (hint) hint.textContent = mailHint(k && k.email === v.trim().toLowerCase() ? k : null); });
    const req = () => h('span', { class: 'login-req', 'aria-hidden': 'true' }, '*');
    const form = h('form', { class: 'login-form', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitInvite } },
      stepper(['Аккаунт', 'Защита 2FA'], 0),
      head('Закрытый доступ', 'Регистрация по приглашению', 'Открытой регистрации нет: нужен одноразовый код от администратора.'),
      inv,
      name,
      mail,
      pwField({ id: 'login-inv-pwd', label: 'Пароль', value: R.pwd, autocomplete: 'new-password', invalid: !!E.pwd, error: E.pwd, onInput: v => { R.pwd = v; E.pwd = null; refresh(); }, after: strength }),
      pwField({ id: 'login-inv-pwd2', label: 'Повторите пароль', value: R.pwd2, autocomplete: 'new-password', invalid: !!E.pwd2, error: E.pwd2, onInput: v => { R.pwd2 = v; E.pwd2 = null; refresh(); }, after: match }),
      h('section', { class: 'login-data', 'aria-labelledby': 'login-data-h' },
        h('div', { class: 'login-data-h', id: 'login-data-h' }, icon('database'), 'Ваши данные'),
        h('ul', null,
          h('li', null, 'Храним имя, email, ставки, банк, стратегию и журнал входов (90 дней) — для вашей аналитики и защиты входа. Матчи для анализа отправляются модели ИИ (', nb('Claude API'), ').'),
          // Р27: участник знает, что администратор видит его данные, до регистрации
          h('li', null, h('b', null, 'Администратор видит ваши ставки, банк и анализы (только просмотр).'), ' Изменить их он не может, каждый просмотр записывается в журнал. Другие участники ваших данных не видят, пароль, коды 2FA и ключ Claude — никто.'),
          h('li', null, 'Сервер в Финляндии, действует GDPR. Выгрузить или удалить свои данные — в «Личном кабинете → Данные».'))),
      h('div', { class: 'login-consents', role: 'group', 'aria-label': 'Согласия' },
        check({ id: 'login-inv-age', checked: R.age, error: E.age, title: [h('span', null, 'Мне 18 лет (21, если так требует закон моей страны или штата)', req())], onChange: v => { R.age = v; if (v) E.age = null; } }),
        check({ id: 'login-inv-ai', checked: R.ai, error: E.ai, title: [h('span', null, 'Понимаю, что прогнозы делает ИИ, они могут быть неточными, решение о ставке принимаю сам', req())], onChange: v => { R.ai = v; if (v) E.ai = null; } }),
        check({ id: 'login-inv-train', checked: R.train, title: 'Разрешаю использовать мои прогнозы в обезличенном виде для обучения общей модели — можно отозвать в личном кабинете',
          hint: 'Необязательно. Без согласия прогнозы в общую модель не попадут, а при удалении аккаунта удалятся вместе с ним.', onChange: v => { R.train = v; } }),
        h('div', { class: 'field-hint' }, req(), ' — обязательно для регистрации')),
      button('Создать аккаунт', { kind: 'primary', size: 'lg', block: true, type: 'submit', iconRight: 'arrowRight' }),
      h('div', { class: 'login-alt' }, h('span', { class: 'muted' }, 'Уже есть аккаунт?'), h('a', { class: 'login-link', href: '#login' }, 'Войти')),
      demoHint('В макете код ', nb(activeInvite() || 'CAP-K7QM-2XPA'), ' выдан на ', nb((INVITES().find(i => i.status === 'active') || { email: 'maria@example.com' }).email), ' — с другим email будет ошибка. Любой новый код вида ', nb('CAP-XXXX-XXXX'), ' подойдет с любым email, ', nb(BAD_INVITE), ' покажет ошибку. Пароль «qwerty123456» покажет проверку утечек.'));
    return { node: form };
  }
  function submitInvite(e) {
    e.preventDefault();
    if (busy) return;
    const r = S.reg, E = {};
    r.invite = maskCode('CAP', r.invite);
    if (!r.invite) E.invite = 'Введите код приглашения от администратора';
    else if (!codeOk('CAP', r.invite)) E.invite = 'Код выглядит так: CAP-XXXX-XXXX — 8 букв и цифр после CAP';
    if (r.name.trim().length < 2) E.name = 'Напишите имя — так вас увидит администратор';
    if (!validEmail(r.email)) E.email = 'Введите email в формате name@example.com';
    if (!analyze(r.pwd, r.email).ok) E.pwd = r.pwd ? 'Пароль не проходит требования ниже' : 'Придумайте пароль';
    if (!E.pwd && r.pwd2 !== r.pwd) E.pwd2 = 'Пароли не совпадают';
    if (!r.age) E.age = 'Без подтверждения возраста регистрация невозможна';
    if (!r.ai) E.ai = 'Отметьте, чтобы продолжить';
    S.regErr = E;
    if (Object.values(E).some(Boolean)) { draw(); focusSel('.login-form .input.invalid, .login-check.invalid input'); return; }
    busy = true;
    setBusy(e.target.querySelector('[type=submit]'), 'Проверяем код…');
    later(600, () => {
      const known = inviteFor(r.invite);
      if (r.invite === BAD_INVITE || (known && known.status !== 'active')) { S.regErr = { invite: 'Код не подходит: он неверный, уже использован или истек (7 дней). Попросите у администратора новый.' }; draw(); focusSel('#login-inv-code'); return; }
      if (known && known.email.toLowerCase() !== r.email.trim().toLowerCase()) { S.regErr = { email: 'Код выдан на другой email. Укажите адрес из приглашения или попросите у администратора новый код' }; draw(); focusSel('#login-inv-email'); return; }
      // Роль задается приглашением; в демо-данных все приглашения — для участников
      S.email = r.email.trim(); S.setupMode = 'reg'; S.regRole = known ? known.role : 'member';
      UI.go('login-setup'); UI.toast('Аккаунт создан. Осталось включить 2FA', 'check');
    });
  }

  function viewSetup() {
    const E = S.setupErr;
    const keyCode = h('code', null, SECRET);
    const mobile = UI.isMobile();
    const afterReset = S.setupMode === 'reset';
    const form = h('form', { class: 'login-form wide', novalidate: true, 'aria-labelledby': 'login-title', on: { submit: submitSetup } },
      afterReset ? stepper(['Пароль', 'Новая 2FA'], 1) : stepper(['Аккаунт', 'Защита 2FA'], 1),
      afterReset
        ? head('2FA сброшена администратором', 'Настройте 2FA заново', 'Старое приложение и резервные коды больше не подходят. Добавьте AI Capper в приложение еще раз и сохраните новые коды.')
        : head('Обязательный шаг', 'Включите двухфакторную защиту', 'Даже если пароль утечет, без кода с вашего телефона в кабинет не войти.'),
      afterReset && acctRow(),
      h('div', { class: 'login-secs' },
        h('section', { class: 'login-s', 'aria-labelledby': 'login-s1' },
          h('span', { class: 'login-s-n', 'aria-hidden': 'true' }, '1'),
          h('div', { class: 'login-s-body' },
            h('h2', { id: 'login-s1' }, 'Отсканируйте QR-код в приложении'),
            h('div', { class: 'login-qrrow' },
              h('div', { class: 'login-qr' }, qrSvg(mobile ? 152 : 164)),
              h('div', { class: 'login-qr-side' },
                h('div', { class: 'small soft' }, 'Подойдет любое приложение с TOTP-кодами:'),
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
            check({ id: 'login-setup-saved', checked: S.saved, error: E.saved, title: 'Я сохранил(а) резервные коды в надежном месте', onChange: v => { S.saved = v; if (v) E.saved = null; } })))),
      button('Готово — войти в кабинет', { kind: 'primary', size: 'lg', block: true, type: 'submit', icon: 'check' }),
      demoHint(afterReset
        ? 'В макете QR-код и ключ — заглушки, в шаге 2 подойдет любой код из 6 цифр. После «Готово» откроется кабинет ' + roleWord(roleFor(S.email), 'gen') + '.'
        : 'В макете QR-код и ключ — заглушки, в шаге 2 подойдет любой код из 6 цифр. После «Готово» откроется кабинет демо-участницы ' + DATA.personas.member.name + '.'));
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
    later(600, () => {
      const role = S.setupMode === 'reset' ? roleFor(S.email) : (S.regRole || 'member');
      enter(role, S.setupMode === 'reset' ? 'Готово: 2FA настроена заново, вы в личном кабинете' : 'Готово: 2FA включена, вы в личном кабинете', 'shield');
    });
  }

  const VIEWS = { login: viewLogin, '2fa': view2fa, backup: viewBackup, reset: viewReset, done: viewDone, invite: viewInvite, setup: viewSetup, locked: viewLocked };

  // ---------- раскладки ----------
  function secList() {
    return h('ul', { class: 'login-sec-list' }, SEC.map(s => h('li', { class: 'login-sec-item' },
      h('span', { class: 'login-sec-ic', 'aria-hidden': 'true' }, icon(s.icon)),
      h('div', { style: 'min-width:0' }, h('div', { class: 'login-sec-t' }, s.t), h('div', { class: 'login-sec-d' }, s.d)))));
  }

  function desktop(v) {
    return h('div', { class: 'login-page' },
      h('aside', { class: 'login-brand', 'aria-label': 'О сервисе и защите входа' },
        court('v'),
        h('div', { class: 'login-brandrow' }, UI.brandMark(), h('div', null, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'личный теннисный аналитик'))),
        h('div', { class: 'login-hero' },
          h('div', { class: 'eyebrow' }, 'Закрытый личный кабинет'),
          h('p', { class: 'login-hero-h' }, 'Теннисная аналитика, которая учится на ваших ставках'),
          h('p', { class: 'login-hero-p' }, 'Claude собирает данные об игроках, разбирает матчи, которые вы внесли, предлагает экспресс и сверяет прогнозы с результатами.'),
          h('p', { class: 'login-hero-note' }, icon('info'), 'Аналитика и вероятности — не гарантия выигрыша.')),
        h('section', { class: 'login-sec', 'aria-labelledby': 'login-sec-title' },
          h('div', { class: 'login-sec-head' }, icon('shield'), h('h2', { id: 'login-sec-title' }, 'Как защищен вход'), UI.chip('6 мер', 'accent', 'check')),
          secList()),
        h('div', { class: 'login-brandfoot' }, h('span', null, '© 2026 AI Capper · личный сервис'), h('span', null, 'Соединение только по HTTPS (TLS 1.3)'))),
      h('main', { class: 'login-main' },
        h('div', { class: 'login-topline' }, themeBtn()),
        h('div', { class: 'login-center' }, v.node),
        h('footer', { class: 'login-foot' }, h('span', { class: 'demo-pill' }, 'Макет · демо-данные'), h('span', null, 'Аккаунты и коды в макете вымышлены'))));
  }

  function mobile(v) {
    return h('div', { class: 'login-m' },
      h('header', { class: 'login-m-hero' },
        court('h'),
        h('div', { class: 'login-m-top' },
          h('div', { class: 'login-brandrow' }, UI.brandMark(), h('div', { style: 'min-width:0' }, h('div', { class: 'brand-name' }, 'AI Capper'), h('div', { class: 'brand-sub' }, 'личный теннисный аналитик'))),
          themeBtn()),
        h('p', { class: 'login-m-lead' }, 'Claude разбирает матчи и предлагает экспресс. Система учится на ваших ставках: уроки, стратегия, своя ML-модель.')),
      h('main', { class: 'login-m-card' }, v.node),
      h('details', { class: 'login-secd' },
        h('summary', null, icon('shield'),
          h('span', { class: 'login-secd-t' }, h('b', null, 'Как защищен вход'), h('span', { class: 'xsmall muted' }, 'Argon2id, 2FA, журнал входов')),
          UI.chip('6 мер', 'accent'),
          icon('chevronDown', { class: 'chev' })),
        secList()),
      h('footer', { class: 'login-m-foot' }, h('span', { class: 'demo-pill' }, 'Макет · демо-данные'), h('span', null, 'Аккаунты и коды в макете вымышлены')));
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
        S.emailError = null; S.pwdError = null; S.otpError = null; S.backupError = null;
        S.rsErr = {}; S.regErr = {}; S.setupErr = {}; S.otp = ''; S.backup = '';
        if (step !== 'login') S.error = false;
        if (step !== 'setup') S.setupMode = 'reg';
        busy = false;
      }
      S.step = step; S.lastStep = step;
      draw(changed);
      if (changed) window.scrollTo(0, 0);
    },
  });
})();
