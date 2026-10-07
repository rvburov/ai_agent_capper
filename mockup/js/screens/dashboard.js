/* временная проверочная заглушка */
UI.register('dashboard', { title: 'Главная', render(root) {
  const { h, fmt } = UI; const S = DATA.stats;
  root.appendChild(h('div', { class: 'grid' },
    h('div', { class: 'col-3' }, UI.stat({ label: 'Банк', value: fmt.money(S.bank), delta: fmt.signedPct(3.2), trend: 'up', hint: 'за 7 дней', spark: DATA.bankHistory.slice(-14).map(b => b.bank) })),
    h('div', { class: 'col-3' }, UI.stat({ label: 'ROI', value: fmt.signedPct(S.roi), delta: '−0,4 п.п.', trend: 'down', hint: 'к прошлому месяцу' })),
    h('div', { class: 'col-3' }, UI.stat({ label: 'Винрейт', value: fmt.pct(S.winrate) })),
    h('div', { class: 'col-3' }, UI.stat({ label: 'CLV', value: fmt.signedPct(S.clvAvg) })),
    h('div', { class: 'col-8' }, UI.card({ title: 'Банк', body: UI.lineChart({ labels: DATA.bankHistory.map(b => b.date), series: [{ name: 'Банк', color: 'var(--s1)', values: DATA.bankHistory.map(b => b.bank) }], area: true, endLabel: true, yFormat: v => fmt.compact(v), xFormat: d => fmt.date(d), tipTitle: d => fmt.dateFull(d), height: 240 }) })),
    h('div', { class: 'col-4' }, UI.card({ title: 'ROI по покрытиям', body: UI.hbars({ items: DATA.roiBySurface.map(r => ({ label: r.label, value: r.roi, color: DATA.surfaces[r.key].color, note: r.n + ' соб.' })), valueFormat: v => fmt.signedPct(v) }) })),
    h('div', { class: 'col-6' }, UI.card({ title: 'Калибровка', body: UI.calibrationChart({ bins: DATA.calibration }) })),
    h('div', { class: 'col-6' }, UI.card({ title: 'Расход по дням', body: UI.columnChart({ items: DATA.ai.runs.slice(0, 12).map(r => ({ label: r.at.slice(5, 10), value: r.cost })), valueFormat: v => fmt.usd(v) }) })),
    h('div', { class: 'col-12' }, UI.card({ title: 'Ставки', flush: true, body: UI.table({ columns: [{ key: 'date', label: 'Дата', render: b => fmt.date(b.date) }, { key: 'm', label: 'События', render: b => b.legs.map(DATA.match).join('; ') }, { key: 'total', label: 'Кэф', align: 'r', render: b => h('span', { class: 'odds' }, fmt.odds(b.total)) }, { key: 's', label: 'Статус', render: b => UI.statusChip(b.status) }], rows: DATA.bets.slice(-6).reverse() }) })),
  ));
} });
