/* UI-кит макета AI Capper: построитель элементов, форматтеры, компоненты, графики, роутер-реестр.
   Все экраны пользуются только этим API (window.UI) и данными window.DATA. */
(function () {
  'use strict';

  // ---------- элементы ----------
  // h('div', {class, style, on:{click}, attrs...}, ...children)
  // children: строка | число | Node | массив | null/false (пропускается)
  function h(tag, attrs, ...children) {
    const svgTags = h._svg || (h._svg = new Set(['svg', 'path', 'g', 'line', 'rect', 'circle', 'text', 'polyline', 'polygon', 'defs', 'linearGradient', 'stop', 'clipPath', 'title', 'tspan']));
    const el = svgTags.has(tag) ? document.createElementNS('http://www.w3.org/2000/svg', tag) : document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
        else if (k === 'style') {
          if (typeof v === 'string') el.setAttribute('style', v);
          else for (const [sk, sv] of Object.entries(v)) { if (sv != null) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, m => '-' + m.toLowerCase()), sv); }
        }
        else if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v; // только для доверенных строк из кода макета
        else if (k in el && typeof v !== 'string' && !(el instanceof SVGElement)) el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    append(el, children);
    return el;
  }
  function append(el, children) {
    for (const c of children) {
      if (c == null || c === false || c === true) continue;
      if (Array.isArray(c)) append(el, c);
      else if (c instanceof Node) el.appendChild(c);
      else el.appendChild(document.createTextNode(String(c)));
    }
    return el;
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

  // ---------- форматтеры (ru-RU) ----------
  const nf0 = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const MINUS = '−';
  function sign(n, s) { return (n > 0 ? '+' : n < 0 ? MINUS : '') + s; }
  const fmt = {
    int: n => nf0.format(Math.round(n)).replace('-', MINUS),
    money: n => nf0.format(Math.round(n)).replace('-', MINUS) + ' ₽',
    signedMoney: n => sign(n, nf0.format(Math.abs(Math.round(n)))) + ' ₽',
    usd: (n, d = 2) => '$' + (d === 2 ? nf2 : d === 1 ? nf1 : nf0).format(n),
    pct: (n, d = 1) => (d === 0 ? nf0 : d === 2 ? nf2 : nf1).format(n).replace('-', MINUS) + '%',
    signedPct: (n, d = 1) => sign(n, (d === 0 ? nf0 : d === 2 ? nf2 : nf1).format(Math.abs(n))) + '%',
    prob: p => nf0.format(Math.round(p * 100)) + '%',
    odds: n => Number(n).toFixed(2),
    dec: (n, d = 2) => (d === 3 ? new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 3, maximumFractionDigits: 3 }) : d === 1 ? nf1 : nf2).format(n).replace('-', MINUS),
    compact: n => n >= 1e6 ? nf1.format(n / 1e6) + ' млн' : n >= 1e3 ? nf1.format(n / 1e3) + ' тыс.' : nf0.format(n),
    tokens: n => n >= 1e6 ? nf1.format(n / 1e6) + 'M' : n >= 1e3 ? nf1.format(n / 1e3) + 'K' : nf0.format(n),
    date: iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return d + ' ' + MONTHS[m - 1]; },
    dateFull: iso => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return d + ' ' + MONTHS[m - 1] + ' ' + y; },
    datetime: iso => fmt.date(iso) + ', ' + iso.slice(11, 16),
    duration: sec => sec >= 60 ? Math.floor(sec / 60) + ' мин ' + (sec % 60) + ' с' : sec + ' с',
    plural: (n, one, few, many) => { const a = Math.abs(n) % 100, b = a % 10; return a > 10 && a < 20 ? many : b > 1 && b < 5 ? few : b === 1 ? one : many; },
  };

  // ---------- иконки (24×24, stroke) ----------
  const ICONS = {
    home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    plus: 'M12 5v14M5 12h14',
    list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
    ticket: 'M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4zM14 5v14',
    chart: 'M4 20V4M4 20h16M8 16l4-5 3 3 5-7',
    bars: 'M5 20V10M12 20V4M19 20v-7',
    users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75',
    brain: 'M9.5 3A2.5 2.5 0 0 0 7 5.5v.2A3 3 0 0 0 4.5 9a3 3 0 0 0 .5 5.3V15a3 3 0 0 0 4.5 2.6A2.5 2.5 0 0 0 12 19.5V5.5A2.5 2.5 0 0 0 9.5 3zM14.5 3A2.5 2.5 0 0 1 17 5.5v.2A3 3 0 0 1 19.5 9a3 3 0 0 1-.5 5.3V15a3 3 0 0 1-4.5 2.6A2.5 2.5 0 0 1 12 19.5',
    coins: 'M9 14c3.3 0 6-1.3 6-3s-2.7-3-6-3-6 1.3-6 3 2.7 3 6 3zM3 11v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4M15 8.5c3.3 0 6-1.3 6-3s-2.7-3-6-3-6 1.3-6 3M21 5.5v4c0 1.4-1.8 2.5-4.3 2.9M21 9.5v4c0 1.4-1.8 2.5-4.3 2.9',
    user: 'M20 21v-1.5a4.5 4.5 0 0 0-4.5-4.5h-7A4.5 4.5 0 0 0 4 19.5V21M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    logout: 'M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l-5-5 5-5M5 12h11',
    sun: 'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5z',
    lock: 'M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1zM8 11V7a4 4 0 0 1 8 0v4',
    shield: 'M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6zM9 12l2 2 4-4',
    check: 'M5 12.5 10 17 19 7',
    x: 'M6 6l12 12M18 6 6 18',
    clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2',
    search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
    filter: 'M4 5h16l-6 7.5V19l-4 1.5v-8z',
    chevronRight: 'M9 6l6 6-6 6',
    chevronLeft: 'M15 6l-6 6 6 6',
    chevronDown: 'M6 9l6 6 6-6',
    arrowUp: 'M12 19V5M6 11l6-6 6 6',
    arrowDown: 'M12 5v14M6 13l6 6 6-6',
    arrowRight: 'M5 12h14M13 6l6 6-6 6',
    spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z',
    bolt: 'M13 2 4 14h7l-1 8 9-12h-7z',
    upload: 'M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
    download: 'M12 4v12M7 11l5 5 5-5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3',
    send: 'M21 3 10 14M21 3l-7 18-4-7-7-4z',
    key: 'M15 9a3 3 0 1 0 0-.01M12.5 11.5 4 20M7 17l2 2M9 15l2 2',
    device: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
    laptop: 'M5 6a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v9H5zM3 18h18',
    refresh: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4',
    info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 8h.01',
    alert: 'M12 4 2.5 20h19zM12 10v4M12 17h.01',
    trophy: 'M8 4h8v5a4 4 0 0 1-8 0zM8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M8 21h8M9 17h6',
    calendar: 'M5 5h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM4 10h16M8 3v4M16 3v4',
    more: 'M5 12h.01M12 12h.01M19 12h.01',
    menu: 'M4 7h16M4 12h16M4 17h16',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6C3.9 8.4 2 12 2 12s3.5 7 10 7c1.7 0 3.2-.5 4.5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2',
    target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 12h.01',
    layers: 'M12 3 2 8l10 5 10-5zM2 13l10 5 10-5M2 17.5l10 5 10-5',
    database: 'M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
    globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
    edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    copy: 'M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1zM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1',
    image: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM4 16l5-5 4 4 2-2 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
    telegram: 'M21 4 3 11l6 2 2 6 3-4 5 4zM9 13l9-6',
    play: 'M7 4v16l13-8z',
    pause: 'M7 5h3v14H7zM14 5h3v14h-3z',
    flask: 'M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10',
    book: 'M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2zM4 19a2 2 0 0 1 2-2h13',
    ball: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6a9 9 0 0 1 0 12.8M18.4 5.6a9 9 0 0 0 0 12.8',
    court: 'M3 5h18v14H3zM12 5v14M3 8h18M3 16h18M7.5 8v8M16.5 8v8M7.5 12h9',
    bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4',
    wallet: 'M4 7a2 2 0 0 1 2-2h12v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2zM16 14.5h.01',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  };
  function icon(name, attrs) {
    const d = ICONS[name] || ICONS.info;
    return h('svg', Object.assign({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' }, attrs || {}), h('path', { d }));
  }

  // ---------- компоненты ----------
  function button(label, opts = {}) {
    const { kind = 'secondary', size, icon: ic, iconRight, onClick, block, type = 'button', disabled, title, href, ariaLabel, attrs } = opts;
    const cls = ['btn', kind, size, block && 'block', !label && 'icon-only'];
    const kids = [ic && icon(ic), label && h('span', null, label), iconRight && icon(iconRight)];
    if (href) return h('a', Object.assign({ class: cls, href, title, 'aria-label': ariaLabel || (label ? null : title) }, attrs || {}), kids);
    return h('button', Object.assign({ class: cls, type, title, disabled, 'aria-label': ariaLabel || (label ? null : title), on: onClick ? { click: onClick } : null }, attrs || {}), kids);
  }

  // card({title, subtitle, actions:[nodes], body: node|[nodes], foot, flush, class})
  function card(o = {}) {
    const head = (o.title || o.actions) ? h('div', { class: 'card-head' },
      h('div', { style: 'min-width:0' }, o.eyebrow && h('div', { class: 'eyebrow' }, o.eyebrow), o.title && h('h3', null, o.title), o.subtitle && h('div', { class: 'card-sub' }, o.subtitle)),
      o.actions && h('div', { class: 'row' }, o.actions)) : null;
    return h('section', { class: ['card', o.class], id: o.id, style: o.style },
      head,
      o.body != null && h('div', { class: ['card-body', o.flush && 'flush'] }, o.body),
      o.foot && h('div', { class: 'card-foot' }, o.foot));
  }

  // stat({label, value, delta:'+2,1%', trend:'up'|'down'|'flat', good:true (рост — хорошо), hint, spark:[..], hero, icon})
  function stat(o) {
    let deltaEl = null;
    if (o.delta != null) {
      const dir = o.trend || 'flat';
      const goodDir = o.good === false ? 'down' : 'up';
      const cls = dir === 'flat' ? 'flat' : dir + '-' + (dir === goodDir ? 'good' : 'bad');
      deltaEl = h('span', { class: ['delta', cls] }, dir !== 'flat' && icon(dir === 'up' ? 'arrowUp' : 'arrowDown', { width: 14, height: 14 }), o.delta);
    }
    return h('section', { class: ['card', o.class] }, h('div', { class: 'stat' },
      h('div', { class: 'stat-label' }, o.icon && icon(o.icon, { width: 16, height: 16 }), o.label),
      h('div', { class: ['stat-value', o.hero && 'hero'] }, o.value),
      h('div', { class: 'stat-foot' },
        h('div', { class: 'row', style: 'gap:8px' }, deltaEl, o.hint && h('span', { class: 'stat-hint' }, o.hint)),
        o.spark && sparkline(o.spark, { color: o.sparkColor }))
    ));
  }

  function chip(text, kind, ic) { return h('span', { class: ['chip', kind] }, ic && icon(ic), text); }
  function dotChip(text, color, kind) { return h('span', { class: ['chip', kind || 'outline', 'surface-chip'] }, h('i', { class: 'dot', style: { background: color } }), text); }
  function surfaceChip(key) { const s = (window.DATA && DATA.surfaces[key]) || { label: key, color: 'var(--fg-3)' }; return dotChip(s.label, s.color); }

  const BET_STATUS = {
    win: ['Выигрыш', 'good', 'check'], loss: ['Проигрыш', 'bad', 'x'], void: ['Возврат', 'outline', 'refresh'], open: ['В игре', 'info', 'clock'],
  };
  function statusChip(status) { const [t, k, i] = BET_STATUS[status] || [status, '']; return chip(t, k, i); }

  function freshnessChip(f) {
    if (f === 'fresh') return chip('Данные свежие', 'good', 'check');
    if (f === 'stale') return chip('Нужно обновить', 'warn', 'clock');
    return chip('Нет в базе', 'bad', 'alert');
  }

  function formDots(arr) { return h('span', { class: 'form-dots', title: 'Форма: ' + arr.join(' '), 'aria-label': 'Форма: ' + arr.map(x => x === 'W' ? 'победа' : 'поражение').join(', ') }, arr.map(r => h('i', { class: r === 'W' ? 'w' : 'l' }))); }

  // table({columns:[{key,label,align:'r'|'c',render:(row)=>node, width, hideMobile}], rows, onRowClick, empty})
  function table(o) {
    const cols = isMobile() ? o.columns.filter(c => !c.hideMobile) : o.columns;
    const thead = h('thead', null, h('tr', null, cols.map(c => h('th', { class: c.align, style: c.width ? 'width:' + c.width : null }, c.label))));
    const tbody = h('tbody', null, o.rows.length ? o.rows.map(r => h('tr', { class: o.onRowClick && 'clickable', on: o.onRowClick ? { click: () => o.onRowClick(r) } : null, tabindex: o.onRowClick ? '0' : null },
      cols.map(c => h('td', { class: c.align }, c.render ? c.render(r) : r[c.key])))) : h('tr', null, h('td', { colspan: cols.length }, h('div', { class: 'empty' }, o.empty || 'Нет данных'))));
    return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, thead, tbody));
  }

  // tabs({items:[{id,label}], active, onChange}) → элемент
  function tabs(o) {
    const el = h('div', { class: 'tabs', role: 'tablist' });
    function draw(active) {
      clear(el);
      o.items.forEach(it => el.appendChild(h('button', { role: 'tab', 'aria-selected': String(it.id === active), on: { click: () => { draw(it.id); o.onChange && o.onChange(it.id); } } }, it.label)));
    }
    draw(o.active || o.items[0].id);
    return el;
  }

  // segmented({items:[{id,label}], active, onChange})
  function segmented(o) {
    const el = h('div', { class: 'segmented', role: 'group', 'aria-label': o.label });
    function draw(active) {
      clear(el);
      o.items.forEach(it => el.appendChild(h('button', { type: 'button', 'aria-pressed': String(it.id === active), on: { click: () => { draw(it.id); o.onChange && o.onChange(it.id); } } }, it.label)));
    }
    draw(o.active || o.items[0].id);
    return el;
  }

  // field({label, id, type, value, placeholder, hint, error, options:[{value,label}]|[str], rows, suffix, autocomplete, inputmode, attrs})
  function field(o) {
    let control;
    const common = Object.assign({ id: o.id, name: o.id, placeholder: o.placeholder, autocomplete: o.autocomplete, inputmode: o.inputmode, required: o.required }, o.attrs || {});
    if (o.options) {
      control = h('select', Object.assign({ class: 'select' }, common), o.options.map(op => { const v = typeof op === 'string' ? op : op.value; const l = typeof op === 'string' ? op : op.label; return h('option', { value: v, selected: v === o.value }, l); }));
    } else if (o.rows) {
      control = h('textarea', Object.assign({ class: 'textarea', rows: o.rows }, common));
      if (o.value != null) control.value = o.value;
    } else {
      control = h('input', Object.assign({ class: ['input', o.suffix && 'has-suffix', o.error && 'invalid'], type: o.type || 'text', value: o.value }, common));
    }
    return h('div', { class: ['field', o.class], style: o.style },
      o.label && h('label', { class: 'field-label', for: o.id }, h('span', null, o.label), o.labelAside),
      o.suffix ? h('div', { class: 'input-wrap' }, control, h('span', { class: 'input-suffix' }, o.suffix)) : control,
      o.error ? h('div', { class: 'field-error', role: 'alert' }, o.error) : o.hint && h('div', { class: 'field-hint' }, o.hint));
  }

  function toggle(o) { // {id, label, hint, checked, onChange}
    return h('label', { class: 'row-between', style: 'cursor:pointer;gap:16px;flex-wrap:nowrap', for: o.id },
      h('div', { style: 'min-width:0' }, h('div', { style: 'font-weight:500' }, o.label), o.hint && h('div', { class: 'field-hint' }, o.hint)),
      h('span', { class: 'switch' }, h('input', { type: 'checkbox', id: o.id, role: 'switch', checked: !!o.checked, on: o.onChange ? { change: e => o.onChange(e.target.checked) } : null }), h('span')));
  }

  function callout(kind, ic, ...content) { return h('div', { class: ['callout', kind] }, icon(ic || 'info'), h('div', { style: 'min-width:0' }, content)); }

  function meter(value, max, kind) { const pct = Math.max(0, Math.min(100, value / max * 100)); return h('div', { class: ['meter', kind], role: 'meter', 'aria-valuenow': value, 'aria-valuemin': 0, 'aria-valuemax': max }, h('i', { style: { width: pct + '%' } })); }

  function kv(pairs) { return h('dl', { class: 'kv' }, pairs.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])); }

  function empty(text) { return h('div', { class: 'empty' }, text); }

  function oddsBox(label, value, picked) { return h('span', { class: ['odds-box', picked && 'picked'] }, h('small', null, label), h('span', { class: 'odds' }, fmt.odds(value))); }

  // ---------- оверлеи ----------
  function toast(msg, ic) {
    const host = document.getElementById('toast-host');
    const t = h('div', { class: 'toast', role: 'status' }, icon(ic || 'check'), h('span', null, msg));
    host.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }

  // modal({title, body, actions:[nodes], wide}) → {close}
  function modal(o) {
    const prevFocus = document.activeElement;
    const close = () => { back.remove(); document.removeEventListener('keydown', onKey); prevFocus && prevFocus.focus && prevFocus.focus(); o.onClose && o.onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const box = h('div', { class: ['modal', o.wide && 'wide'], role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title },
      h('div', { class: 'modal-head' }, h('h3', null, o.title), button('', { kind: 'ghost', size: 'sm', icon: 'x', title: 'Закрыть', onClick: close })),
      h('div', { class: 'modal-body' }, typeof o.body === 'function' ? o.body(close) : o.body),
      o.actions && h('div', { class: 'modal-foot' }, typeof o.actions === 'function' ? o.actions(close) : o.actions));
    const back = h('div', { class: 'modal-backdrop', on: { click: e => { if (e.target === back) close(); } } }, box);
    document.body.appendChild(back);
    document.addEventListener('keydown', onKey);
    const f = box.querySelector('input, select, textarea, button:not([title="Закрыть"])');
    (f || box).focus && setTimeout(() => (f || box).focus(), 30);
    return { close };
  }

  // ---------- графики ----------
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = h('div', { class: 'chart-tip', hidden: true, role: 'tooltip' }); document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(x, y, title, rows) {
    const t = tip(); clear(t);
    t.appendChild(h('div', { class: 'tip-title' }, title));
    rows.forEach(r => t.appendChild(h('div', { class: 'tip-row' }, h('span', { class: 'tip-key' }, r.color && h('i', { style: { background: r.color } }), r.name), h('b', null, r.value))));
    t.hidden = false;
    const w = t.offsetWidth, hh = t.offsetHeight;
    let left = x + 14, top = y - hh - 10;
    if (left + w > window.innerWidth - 8) left = x - w - 14;
    if (top < 8) top = y + 16;
    t.style.left = Math.max(8, left) + 'px'; t.style.top = top + 'px';
  }
  function hideTip() { if (tipEl) tipEl.hidden = true; }

  // Обёртка: перерисовка по ширине контейнера
  function responsive(draw, height) {
    const box = h('div', { class: 'chart', style: { height: height + 'px' } });
    let lastW = 0;
    const render = () => { const w = Math.floor(box.clientWidth); if (w > 0 && w !== lastW) { lastW = w; clear(box); draw(box, w, height); } };
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(render).observe(box);
    const tryFirst = (n) => { if (box.isConnected && box.clientWidth) render(); else if (n < 60) requestAnimationFrame(() => tryFirst(n + 1)); };
    requestAnimationFrame(() => tryFirst(0));
    return box;
  }
  function niceTicks(min, max, count = 4) {
    const span = max - min || 1;
    const step0 = span / count, mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag, step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }
  function textWidth(s) { return String(s).length * 6.4; }

  // lineChart({labels:[..], series:[{name,color,values:[..], dashed, width}], height, yFormat, xFormat(label,i), area, yMin, yMax, refLines:[{value,label}], endLabel:true})
  function lineChart(o) {
    const height = o.height || 240;
    const yf = o.yFormat || (v => fmt.int(v));
    const xf = o.xFormat || (l => l);
    const wrap = responsive((box, W, H) => {
      const all = o.series.flatMap(s => s.values.filter(v => v != null));
      (o.refLines || []).forEach(r => all.push(r.value));
      let lo = o.yMin != null ? o.yMin : Math.min(...all), hi = o.yMax != null ? o.yMax : Math.max(...all);
      if (o.yMin == null) lo -= (hi - lo) * 0.08; if (o.yMax == null) hi += (hi - lo) * 0.06;
      const ticks = niceTicks(lo, hi, H < 200 ? 3 : 4);
      lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
      const yLabelW = Math.max(...ticks.map(t => textWidth(yf(t)))) + 10;
      const endW = o.endLabel ? Math.min(80, Math.max(...o.series.map(s => textWidth(yf(s.values[s.values.length - 1])))) + 14) : 10;
      const m = { t: 10, r: endW, b: 26, l: yLabelW };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const n = o.labels.length;
      const X = i => m.l + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
      const Y = v => m.t + ih - ((v - lo) / (hi - lo)) * ih;
      const svg = h('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel || o.series.map(s => s.name).join(', ') });
      ticks.forEach(t => { if (t < lo - 1e-9 || t > hi + 1e-9) return; svg.appendChild(h('line', { class: 'grid-line', x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) })); svg.appendChild(h('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, yf(t))); });
      // x labels
      const maxLabels = Math.max(2, Math.floor(iw / 72));
      const stepL = Math.ceil(n / maxLabels);
      for (let i = 0; i < n; i += stepL) svg.appendChild(h('text', { x: X(i), y: H - 6, 'text-anchor': i === 0 ? 'start' : 'middle' }, xf(o.labels[i], i)));
      (o.refLines || []).forEach(r => {
        svg.appendChild(h('line', { x1: m.l, x2: W - m.r, y1: Y(r.value), y2: Y(r.value), stroke: 'var(--fg-3)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
        if (r.label) svg.appendChild(h('text', { x: W - m.r, y: Y(r.value) - 6, 'text-anchor': 'end' }, r.label));
      });
      o.series.forEach((s, si) => {
        const pts = s.values.map((v, i) => v == null ? null : [X(i), Y(v)]);
        const d = pts.reduce((acc, p, i) => p ? acc + (acc && pts[i - 1] ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1) : acc, '');
        if (o.area && si === 0) {
          const first = pts.findIndex(Boolean), last = pts.length - 1 - [...pts].reverse().findIndex(Boolean);
          const base = Y(Math.max(lo, Math.min(hi, o.areaBase != null ? o.areaBase : lo)));
          svg.appendChild(h('path', { d: d + `L${pts[last][0]} ${base}L${pts[first][0]} ${base}Z`, fill: s.color, opacity: '.1', stroke: 'none' }));
        }
        svg.appendChild(h('path', { d, fill: 'none', stroke: s.color, 'stroke-width': s.width || 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', 'stroke-dasharray': s.dashed ? '5 4' : null }));
        const lastI = s.values.length - 1;
        if (pts[lastI]) {
          svg.appendChild(h('circle', { cx: pts[lastI][0], cy: pts[lastI][1], r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }));
          if (o.endLabel) svg.appendChild(h('text', { x: pts[lastI][0] + 8, y: pts[lastI][1] + 4, style: 'fill:var(--fg);font-weight:600' }, yf(s.values[lastI])));
        }
      });
      // crosshair layer
      const cross = h('line', { class: 'crosshair', y1: m.t, y2: m.t + ih, visibility: 'hidden' });
      const dots = o.series.map(s => h('circle', { r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2, visibility: 'hidden' }));
      svg.appendChild(cross); dots.forEach(d => svg.appendChild(d));
      const hit = h('rect', { x: m.l, y: 0, width: iw, height: H, fill: 'transparent', tabindex: '0', style: 'outline:none' });
      let cur = -1;
      const at = (i, cx, cy) => {
        cur = Math.max(0, Math.min(n - 1, i));
        cross.setAttribute('x1', X(cur)); cross.setAttribute('x2', X(cur)); cross.setAttribute('visibility', 'visible');
        o.series.forEach((s, si) => { const v = s.values[cur]; if (v == null) { dots[si].setAttribute('visibility', 'hidden'); return; } dots[si].setAttribute('cx', X(cur)); dots[si].setAttribute('cy', Y(v)); dots[si].setAttribute('visibility', 'visible'); });
        const r = svg.getBoundingClientRect();
        showTip(cx != null ? cx : r.left + X(cur), cy != null ? cy : r.top + m.t, (o.tipTitle || xf)(o.labels[cur], cur), o.series.map(s => ({ name: s.name, color: s.color, value: s.values[cur] == null ? '—' : yf(s.values[cur]) })));
      };
      const off = () => { cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); hideTip(); };
      hit.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); const i = Math.round(((e.clientX - r.left - m.l) / iw) * (n - 1)); at(i, e.clientX, e.clientY); });
      hit.addEventListener('pointerleave', off);
      hit.addEventListener('blur', off);
      hit.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { at(cur + 1); e.preventDefault(); } if (e.key === 'ArrowLeft') { at(cur < 0 ? n - 1 : cur - 1); e.preventDefault(); } });
      svg.appendChild(hit);
      box.appendChild(svg);
    }, height);
    return wrap;
  }

  // columnChart({items:[{label, value, color, tip}], height, valueFormat, labelEvery, highlightLast})
  function columnChart(o) {
    const height = o.height || 200;
    const vf = o.valueFormat || (v => fmt.int(v));
    return responsive((box, W, H) => {
      const vals = o.items.map(i => i.value);
      const hi0 = Math.max(0, ...vals), lo0 = Math.min(0, ...vals);
      const ticks = niceTicks(lo0, hi0 || 1, 3);
      const lo = ticks[0], hi = ticks[ticks.length - 1];
      const yLabelW = Math.max(...ticks.map(t => textWidth(vf(t)))) + 10;
      const m = { t: 10, r: 6, b: 24, l: yLabelW };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const n = o.items.length, band = iw / n;
      const bw = Math.min(24, Math.max(3, band - 2));
      const Y = v => m.t + ih - ((v - lo) / (hi - lo)) * ih;
      const svg = h('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.ariaLabel || 'Столбчатая диаграмма' });
      ticks.forEach(t => { svg.appendChild(h('line', { class: t === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) })); svg.appendChild(h('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, vf(t))); });
      const every = o.labelEvery || Math.ceil(n / Math.max(2, Math.floor(iw / 56)));
      o.items.forEach((it, i) => {
        const cx = m.l + band * i + band / 2;
        const y0 = Y(0), y1 = Y(it.value), top = Math.min(y0, y1), hgt = Math.max(1, Math.abs(y1 - y0));
        const r = Math.min(4, hgt, bw / 2);
        const x = cx - bw / 2;
        const d = it.value >= 0
          ? `M${x} ${y0}V${top + r}Q${x} ${top} ${x + r} ${top}H${x + bw - r}Q${x + bw} ${top} ${x + bw} ${top + r}V${y0}Z`
          : `M${x} ${y0}V${top + hgt - r}Q${x} ${top + hgt} ${x + r} ${top + hgt}H${x + bw - r}Q${x + bw} ${top + hgt} ${x + bw} ${top + hgt - r}V${y0}Z`;
        const color = it.color || o.color || 'var(--s1)';
        const bar = h('path', { d, fill: color, opacity: o.highlightLast && i !== n - 1 ? '.55' : null, tabindex: '0', style: 'outline:none;cursor:default' });
        const hitR = h('rect', { x: m.l + band * i, y: m.t, width: band, height: ih, fill: 'transparent' });
        const show = (e) => { bar.setAttribute('opacity', '.8'); const rb = svg.getBoundingClientRect(); showTip(e && e.clientX != null ? e.clientX : rb.left + cx, e && e.clientY != null ? e.clientY : rb.top + top, it.tipTitle || it.label, it.tip || [{ name: o.seriesName || 'Значение', color, value: vf(it.value) }]); };
        const hide = () => { bar.setAttribute('opacity', o.highlightLast && i !== n - 1 ? '.55' : '1'); hideTip(); };
        [bar, hitR].forEach(el => { el.addEventListener('pointermove', show); el.addEventListener('pointerleave', hide); });
        bar.addEventListener('focus', () => show()); bar.addEventListener('blur', hide);
        svg.appendChild(hitR); svg.appendChild(bar);
        if (i % every === 0) svg.appendChild(h('text', { x: cx, y: H - 6, 'text-anchor': 'middle' }, it.short || it.label));
      });
      box.appendChild(svg);
    }, height);
  }

  // hbars({items:[{label, value, color, note, labelNode}], valueFormat, domain:[min,max]}) — горизонтальные полосы, поддерживают отрицательные значения
  function hbars(o) {
    const vf = o.valueFormat || (v => fmt.int(v));
    const vals = o.items.map(i => i.value);
    const lo = o.domain ? o.domain[0] : Math.min(0, ...vals), hi = o.domain ? o.domain[1] : Math.max(0, ...vals);
    const span = (hi - lo) || 1;
    const zero = ((0 - lo) / span) * 100;
    return h('div', { class: 'hbars', role: 'list' }, o.items.map(it => {
      const v = it.value, w = Math.abs(v) / span * 100;
      const color = it.color || o.color || 'var(--s1)';
      const fill = h('i', { class: ['hbar-fill', v >= 0 ? 'pos' : 'neg'], style: { left: (v >= 0 ? zero : zero - w) + '%', width: Math.max(w, 0.6) + '%', background: color } });
      return h('div', { class: 'hbar', role: 'listitem', title: it.label + ': ' + vf(v) },
        h('span', { class: 'hbar-label' }, it.labelNode || [it.dot !== false && h('i', { style: { width: '8px', height: '8px', borderRadius: '2px', background: color, flex: 'none' } }), it.label]),
        h('span', { class: 'hbar-track' }, lo < 0 && h('i', { class: 'hbar-zero', style: { left: zero + '%' } }), fill),
        h('span', { class: 'hbar-value' }, vf(v), it.note && h('small', null, it.note)));
    }));
  }

  // calibrationChart({bins:[{p, actual, n}], height, domain:[0.5,1]}) — прогнозная вероятность против фактической частоты
  function calibrationChart(o) {
    const height = o.height || 260;
    const [d0, d1] = o.domain || [0.5, 1];
    return responsive((box, W, H) => {
      const m = { t: 12, r: 12, b: 34, l: 44 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const X = v => m.l + (v - d0) / (d1 - d0) * iw, Y = v => m.t + ih - (v - d0) / (d1 - d0) * ih;
      const svg = h('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Калибровка: прогноз против факта' });
      const ticks = []; for (let v = d0; v <= d1 + 1e-9; v += 0.1) ticks.push(+v.toFixed(2));
      ticks.forEach(t => {
        svg.appendChild(h('line', { class: 'grid-line', x1: m.l, x2: m.l + iw, y1: Y(t), y2: Y(t) }));
        svg.appendChild(h('text', { x: m.l - 8, y: Y(t) + 4, 'text-anchor': 'end' }, Math.round(t * 100) + '%'));
        svg.appendChild(h('text', { x: X(t), y: m.t + ih + 16, 'text-anchor': 'middle' }, Math.round(t * 100) + '%'));
      });
      svg.appendChild(h('text', { x: m.l + iw, y: H - 2, 'text-anchor': 'end' }, 'прогноз модели →'));
      svg.appendChild(h('line', { x1: X(d0), y1: Y(d0), x2: X(d1), y2: Y(d1), stroke: 'var(--fg-3)', 'stroke-width': 1, 'stroke-dasharray': '4 4' }));
      if (o.diagLabel) svg.appendChild(h('text', { x: X(d1) - 6, y: Y(d0 + (d1 - d0) * 0.88) + 18, 'text-anchor': 'end' }, 'идеальная калибровка'));
      const pts = o.bins.filter(b => b.n > 0);
      const color = o.color || 'var(--s1)';
      svg.appendChild(h('path', { d: pts.map((b, i) => (i ? 'L' : 'M') + X(b.p).toFixed(1) + ' ' + Y(Math.max(d0, Math.min(d1, b.actual))).toFixed(1)).join(''), fill: 'none', stroke: color, 'stroke-width': 2 }));
      const maxN = Math.max(...pts.map(b => b.n));
      pts.forEach(b => {
        const cx = X(b.p), cy = Y(Math.max(d0, Math.min(d1, b.actual)));
        const r = 4 + 5 * Math.sqrt(b.n / maxN);
        const dot = h('circle', { cx, cy, r, fill: color, stroke: 'var(--surface)', 'stroke-width': 2, tabindex: '0', style: 'outline:none' });
        const hit = h('circle', { cx, cy, r: Math.max(12, r + 6), fill: 'transparent' });
        const show = e => { const rb = svg.getBoundingClientRect(); showTip(e && e.clientX != null ? e.clientX : rb.left + cx, e && e.clientY != null ? e.clientY : rb.top + cy, 'Прогноз ' + Math.round((b.lo || b.p - 0.025) * 100) + '–' + Math.round((b.hi || b.p + 0.025) * 100) + '%', [{ name: 'Средний прогноз', value: fmt.prob(b.p) }, { name: 'Сбылось', color, value: fmt.prob(b.actual) }, { name: 'Событий', value: String(b.n) }]); };
        [dot, hit].forEach(el => { el.addEventListener('pointermove', show); el.addEventListener('pointerleave', hideTip); });
        dot.addEventListener('focus', () => show()); dot.addEventListener('blur', hideTip);
        svg.appendChild(hit); svg.appendChild(dot);
      });
      box.appendChild(svg);
    }, height);
  }

  // sparkline(values, {color, width, height})
  function sparkline(values, o = {}) {
    const W = o.width || 96, H = o.height || 28, pad = 3;
    const lo = Math.min(...values), hi = Math.max(...values), n = values.length;
    const X = i => pad + i / (n - 1) * (W - pad * 2), Y = v => H - pad - ((v - lo) / ((hi - lo) || 1)) * (H - pad * 2);
    const d = values.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('');
    const color = o.color || 'var(--accent)';
    return h('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true', style: 'flex:none' },
      h('path', { d: d + `L${X(n - 1)} ${H}L${X(0)} ${H}Z`, fill: color, opacity: '.1' }),
      h('path', { d, fill: 'none', stroke: color, 'stroke-width': 1.5, 'stroke-linejoin': 'round' }),
      h('circle', { cx: X(n - 1), cy: Y(values[n - 1]), r: 3, fill: color }));
  }

  // legend([{name, color, type:'line'|'box'|'dash'}])
  function legend(items) { return h('div', { class: 'chart-legend' }, items.map(it => h('span', null, h('i', { class: it.type === 'box' ? 'box' : it.type === 'dash' ? 'dash' : null, style: it.type === 'dash' ? null : { background: it.color } }), it.name))); }

  // chartWithTable(chartNode, tableNode) — кнопка «Показать таблицей» под графиком
  function withTable(chartNode, tableFactory) {
    const holder = h('div', { hidden: true });
    let built = false;
    const btn = button('Показать таблицей', { kind: 'ghost', size: 'sm', icon: 'list', attrs: { class: 'btn ghost sm chart-table-toggle' }, onClick: () => {
      if (!built) { holder.appendChild(tableFactory()); built = true; }
      holder.hidden = !holder.hidden; btn.querySelector('span').textContent = holder.hidden ? 'Показать таблицей' : 'Скрыть таблицу';
    } });
    return h('div', { class: 'stack', style: 'gap:6px' }, chartNode, btn, holder);
  }

  // ---------- реестр экранов ----------
  const screens = {};
  // register(id, {title, nav:'dashboard'|..., crumbs, shell:false, render(root, param, ctx)})
  function register(id, def) { screens[id] = def; }
  function go(route) { if (location.hash === '#' + route) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = route; }

  // Инъекция CSS экрана один раз
  const injected = new Set();
  function css(id, text) { if (injected.has(id)) return; injected.add(id); document.body.appendChild(h('style', { 'data-screen': id }, text)); } // после общих стилей страницы — стили экрана выигрывают при равной специфичности

  const mq = window.matchMedia('(max-width: 960px)');
  function isMobile() { return mq.matches; }

  window.UI = { h, append, clear, fmt, icon, ICONS, button, card, stat, chip, dotChip, surfaceChip, statusChip, freshnessChip, formDots, table, tabs, segmented, field, toggle, callout, meter, kv, empty, oddsBox, toast, modal, lineChart, columnChart, hbars, calibrationChart, sparkline, legend, withTable, showTip, hideTip, register, screens, go, css, isMobile };
})();
