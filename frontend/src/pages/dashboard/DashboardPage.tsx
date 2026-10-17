import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { useMe } from '../../api/hooks/useMe';
import { Button, Callout, Card, Segmented, Skeleton } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { useBank, useStrategy } from '../../features/analysis/api';
import { useAiBudget } from '../../features/ai/useAiBudget';
import { capitalize } from '../../features/analytics/display';
import { useAiUsage, useDashboard } from '../../features/dashboard/api';
import { useViewAs } from '../../features/view/context';
import { useViewedName } from '../../features/view/people';
import { learningSnapshot } from '../../features/dashboard/learning';
import { PERIODS, readPeriod, savePeriod } from '../../features/dashboard/display';
import type { Dashboard, DashboardPeriod } from '../../features/dashboard/types';
import { formatDate, formatDayMonth, formatWeekday } from '../../lib/format';
import { cx } from '../../lib/cx';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { Attention } from './Attention';
import { BankDynamics } from './BankDynamics';
import { Costs } from './Costs';
import { HeroCard, Tiles } from './Hero';
import { LearningCard } from './LearningCard';
import { MyMatches } from './MyMatches';
import { OpenBets } from './OpenBets';
import './dashboard.css';

/*
 * Главная (mockup/js/screens/dashboard.js): банк и показатели за период с изменением к прошлому,
 * динамика банка, открытые ставки, мои матчи сегодня, «Требует внимания», расходы ИИ, «Модель
 * учится» (этап 5). Числа считает сервер: GET /api/dashboard, GET /api/me/bank, GET /api/ai/budget
 * и GET /api/ai/usage (прогноз и доля кэша в «Расходах ИИ» участника).
 */

/** «за 30 дней»; у «всего времени» — «с 1 сен» (первый день истории). */
function periodCtx(data: Dashboard, t: TFunction): string {
  return data.period === 'all' ? t('dashboard.period.since', { date: formatDate(data.series.start) }) : t(`dashboard.period.ctx.${data.period}`);
}

/** Первое слово имени для приветствия: «Роман» из «Роман Буров». */
function firstName(name: string | null | undefined): string | null {
  const first = name?.trim().split(/\s+/)[0];
  return first ? first : null;
}

function ordered(node: ReactNode, n: number): ReactNode {
  return <div className={`dashboard-o-${n} dashboard-min`}>{node}</div>;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const { data: me } = useMe();
  // Р27: администратор смотрит главную участника — как ее видит сам участник, только просмотр
  const asUser = useViewAs();
  const viewedName = useViewedName();
  const [period, setPeriod] = useState<DashboardPeriod>(readPeriod);
  const dashboard = useDashboard(period);
  const bankQuery = useBank();
  const strategy = useStrategy();
  const budget = useAiBudget();
  // Свой расход у администратора не нужен; у участника, чьи данные он смотрит, — нужен
  const usage = useAiUsage(me !== undefined && (me.role !== 'admin' || asUser !== null));

  function choose(next: DashboardPeriod) {
    savePeriod(next);
    setPeriod(next);
  }

  const data = dashboard.data;
  const pending = dashboard.isPlaceholderData;
  const segmented = (
    <Segmented<DashboardPeriod>
      label={t('dashboard.period.label')}
      items={PERIODS.map((value) => ({ value, label: t(`dashboard.period.items.${value}`) }))}
      value={period}
      onChange={choose}
    />
  );

  if (!data || !me) {
    return (
      <div className="dashboard-root stack">
        <div className="page-head dashboard-head">
          <div className="dashboard-min">
            <h2>{dashboard.isError ? t('dashboard.head.errorTitle') : t('dashboard.head.loadingTitle')}</h2>
          </div>
          {segmented}
        </div>
        {dashboard.isError ? (
          <Callout kind="bad" role="alert">
            {apiErrorText(dashboard.error)}{' '}
            <Button size="sm" kind="ghost" icon="refresh" onClick={() => void dashboard.refetch()}>
              {t('common.retry')}
            </Button>
          </Callout>
        ) : (
          <div className="dashboard-top" aria-busy="true">
            <Card>
              <Skeleton lines={4} />
            </Card>
            <Card>
              <Skeleton lines={4} />
            </Card>
          </div>
        )}
      </div>
    );
  }

  // Банк — из GET /api/me/bank (тот же, что плашка в шапке); пока он грузится — из ответа главной
  const bank = bankQuery.data ?? data.bank;
  const ctx = periodCtx(data, t);
  const prevCtx = data.period === 'all' ? null : t(`dashboard.period.prev.${data.period}`);
  const name = firstName(asUser === null ? me.display_name : viewedName);
  const greeting = name ? t(`dashboard.head.greeting.${data.greeting}`, { name }) : t(`dashboard.head.greetingAlone.${data.greeting}`);
  const counts = [
    t('dashboard.head.inPlay', { count: data.open_count }),
    ...(data.my_matches.length ? [t('dashboard.head.myMatches', { count: data.my_matches.length })] : []),
  ].join(', ');
  const lead = `${t('dashboard.head.date', { date: formatDayMonth(data.today), weekday: formatWeekday(data.today) })} · ${counts}`;

  const head = (
    <div className="page-head dashboard-head">
      <div className="dashboard-min">
        <h2 title={t('dashboard.head.greetingTitle')}>{greeting}</h2>
        <p className="lead">{lead}</p>
      </div>
      {segmented}
    </div>
  );
  // Ставок за период не рассчитано — не «малая выборка из 0», а показателей еще нет
  const note = !data.kpi.settled ? (
    <Callout kind="info" role="status">
      <b>{t('dashboard.small.none', { ctx: capitalize(ctx) })}</b> {t('dashboard.small.noneText')}
    </Callout>
  ) : data.small_sample ? (
    <Callout kind="warn" icon="info" role="status">
      <b>{t('dashboard.small.strong', { ctx: capitalize(ctx), count: data.kpi.settled })}</b> {t('dashboard.small.text')}
    </Callout>
  ) : null;
  const hero = <HeroCard data={data} bank={bank} ctx={ctx} />;
  const tiles = (
    <div className={cx('grid dashboard-tiles', pending && 'dashboard-pending')} aria-busy={pending || undefined}>
      <Tiles data={data} prevCtx={prevCtx} />
    </div>
  );
  const chart = <BankDynamics data={data} bank={bank} ctx={ctx} mobile={mobile} pending={pending} />;
  const open = <OpenBets data={data} />;
  const matches = <MyMatches data={data} />;
  const admin = me.role === 'admin' && asUser === null;
  const learningNow = learningSnapshot(data.learning);
  const awaitingBet = data.open_bets.find((bet) => bet.awaiting_result) ?? null;
  const attention = (
    <Attention
      bank={bank}
      params={strategy.data?.params ?? null}
      admin={data.admin}
      awaiting={{ count: data.awaiting_count, bet: awaitingBet }}
      learning={admin ? { candidate: learningNow.candidate, ready: learningNow.readyCodes, quickPrice: learningNow.quickPrice } : null}
    />
  );
  const learning = <LearningCard snapshot={learningNow} admin={admin} />;
  // В режиме просмотра — лимит участника; бюджет ключа администратора — только если смотрят администратора
  const adminCosts = asUser === null ? me.role === 'admin' : Boolean(budget.data?.budget);
  const costs = <Costs budget={budget.data} usage={usage.data} admin={adminCosts} failed={budget.isError} />;

  if (mobile) {
    // Телефон: одна колонка, самое важное сверху — банк, открытые ставки, мои матчи сегодня
    return (
      <div className="dashboard-root stack">
        {head}
        {note}
        {hero}
        {open}
        {matches}
        <section className="dashboard-section" aria-label={t('dashboard.tiles.label')}>
          <div className="dashboard-section-label">
            <span className="eyebrow">{t('dashboard.tiles.title', { ctx })}</span>
          </div>
          {tiles}
        </section>
        {attention}
        {chart}
        {learning}
        {costs}
      </div>
    );
  }
  return (
    <div className="dashboard-root stack">
      {head}
      {note}
      <div className="dashboard-top">
        <div className="dashboard-min">{hero}</div>
        {tiles}
      </div>
      {/* Слева — что требует действий и мои матчи сегодня, затем история; справа — открытые
          ставки, «Модель учится» и расходы. До 1180 px колонки «растворяются», и блоки встают
          по порядку важности (dashboard-o-N) */}
      <div className="dashboard-main">
        <div className="dashboard-col">
          {ordered(attention, 2)}
          {ordered(matches, 3)}
          {ordered(chart, 4)}
        </div>
        <div className="dashboard-col">
          {ordered(open, 1)}
          {ordered(learning, 5)}
          {ordered(costs, 6)}
        </div>
      </div>
    </div>
  );
}
