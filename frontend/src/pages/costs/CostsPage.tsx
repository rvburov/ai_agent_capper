import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { Button, Callout, Card, Skeleton } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { capitalize } from '../../features/analytics/display';
import { useAiBudget } from '../../features/ai/useAiBudget';
import { limitLevels, useAdminAttention } from '../../features/admin/useAdminAttention';
import { useAdminAiUsage } from '../../features/admin/useAdminUsage';
import { runFilterOf, searchWithRunFilter } from '../../features/costs/display';
import type { AiUsage, RunFilter } from '../../features/costs/types';
import { useAiUsage } from '../../features/dashboard/api';
import { formatDate, formatDateRange, formatUsd } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { DailyCard, LaterCard, SettingsCard, Tiles, TypesCard, VersionsCard } from './Blocks';
import { AdminHero, AdminWho, MemberHero, MemberRules, OwnHero, type Period } from './Hero';
import { PricesModal, RunsCard } from './Runs';
import './costs.css';

/*
 * «ИИ и расходы» (mockup/js/screens/costs.js, В12, Т16–Т19): вверху — лимит участника на ключе
 * администратора, свой ключ или бюджет ключа администратора; ниже — собственные вызовы Claude:
 * цена анализа, кэш, токены, поиски, расход по дням UTC, задачи, версии инструкций, журнал
 * вызовов с разбором цены и настройки агента (только показ). Числа — с сервера.
 */

type Filter = RunFilter | 'all';

function periodOf(usage: AiUsage, t: TFunction): Period {
  const months: readonly string[] = t('costs.months', { returnObjects: true });
  const month = Number(usage.month.slice(5, 7));
  const end = `${usage.month}-${String(usage.days_in_month).padStart(2, '0')}`;
  return {
    long: formatDateRange(usage.month_start, usage.last_day, { month: 'long' }),
    short: formatDateRange(usage.month_start, usage.last_day),
    end: formatDate(end),
    month: months[month - 1] ?? usage.month,
  };
}

function scrollToSettings() {
  document.getElementById('costs-settings')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

export function CostsPage() {
  const { t } = useTranslation();
  const { data: me } = useMe();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const admin = me?.role === 'admin';
  const budget = useAiBudget();
  const usage = useAiUsage(me !== undefined);
  const adminUsage = useAdminAiUsage(admin);
  const attention = useAdminAttention(admin);
  // фильтр журнала — в адресе (/costs?runs=news): переживает перезагрузку, «Назад» и ссылку
  const [params, setParams] = useSearchParams();
  const filter: Filter = runFilterOf(params) ?? 'all';
  const setFilter = (next: Filter) => setParams((prev) => searchWithRunFilter(prev, next === 'all' ? null : next));
  const [prices, setPrices] = useState(false);

  if (!me) return null;
  const failed = budget.isError || usage.isError;
  if (!budget.data || !usage.data) {
    return (
      <div className="costs-root stack">
        <div className="page-head costs-head">
          <h2>{t('costs.head.loading')}</h2>
        </div>
        {failed ? (
          <Callout kind="bad" role="alert">
            {t('costs.head.failed')} {apiErrorText(budget.error ?? usage.error)}{' '}
            <Button
              size="sm"
              kind="ghost"
              icon="refresh"
              onClick={() => {
                if (budget.isError) void budget.refetch();
                if (usage.isError) void usage.refetch();
              }}
            >
              {t('common.retry')}
            </Button>
          </Callout>
        ) : (
          <div className="grid" aria-busy="true">
            <div className="col-7">
              <Card>
                <Skeleton lines={5} />
              </Card>
            </div>
            <div className="col-5">
              <Card>
                <Skeleton lines={5} />
              </Card>
            </div>
          </div>
        )}
      </div>
    );
  }

  const data = usage.data;
  const ai = budget.data;
  const period = periodOf(data, t);
  const monthsIn: readonly string[] = t('dashboard.costs.monthsIn', { returnObjects: true });
  const own = !admin && ai.mode === 'own';
  const lead = admin ? 'costs.head.leadAdmin' : own ? 'costs.head.leadOwn' : 'costs.head.leadMember';
  const hero = admin ? <AdminHero budget={ai} usage={data} period={period} /> : own ? <OwnHero budget={ai} usage={data} period={period} /> : <MemberHero budget={ai} usage={data} period={period} />;
  const side = admin ? (
    <AdminWho
      data={adminUsage.data}
      me={me}
      levels={limitLevels(attention.data)}
      error={adminUsage.isError ? adminUsage.error : null}
      onRetry={() => void adminUsage.refetch()}
      month={capitalize(period.month)}
    />
  ) : (
    <MemberRules budget={ai} usage={data} period={period} />
  );

  function pick(kind: string) {
    setFilter(kind as RunFilter);
    window.requestAnimationFrame(() => document.getElementById('costs-runs')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }

  return (
    <div className="costs-root stack">
      <div className="page-head costs-head">
        <div className="costs-min">
          <h2>{t('costs.head.title', { month: monthsIn[Number(data.month.slice(5, 7)) - 1] ?? '' })}</h2>
          <p className="lead">{t(lead, { period: period.long })}</p>
        </div>
        <div className="costs-head-actions">
          <Button kind="secondary" size="sm" icon="coins" onClick={() => setPrices(true)}>
            {t('costs.head.prices')}
          </Button>
          <Button kind="secondary" size="sm" icon="sliders" onClick={scrollToSettings}>
            {t('costs.head.settings')}
          </Button>
        </div>
      </div>
      <div className="grid costs-top">
        <div className="col-7 costs-min">{hero}</div>
        <div className="col-5 costs-min">{side}</div>
      </div>
      <div className="costs-section">
        <h3>{admin ? t('costs.scope.titleAdmin') : t('costs.scope.title')}</h3>
        <span className="small soft">
          {t('costs.scope.text', {
            period: period.long,
            analyses: t('costs.analyses', { count: data.analyses.length }),
            calls: t('costs.calls', { count: data.totals.runs }),
            amount: formatUsd(data.totals.cost_usd),
          })}
          {admin ? '' : t('costs.scope.memberTail')}
        </span>
      </div>
      <Tiles usage={data} />
      <div className="costs-main">
        <div className="costs-col">
          <DailyCard usage={data} budget={ai} admin={admin} period={period} mobile={mobile} />
          <VersionsCard usage={data} period={period} />
        </div>
        <div className="costs-col">
          <TypesCard usage={data} period={period} onPick={pick} />
          <LaterCard />
        </div>
      </div>
      <RunsCard usage={data} budget={ai} admin={admin} mobile={mobile} filter={filter} onFilter={setFilter} />
      <SettingsCard usage={data} budget={ai} admin={admin} />
      {prices && <PricesModal usage={data} mobile={mobile} onClose={() => setPrices(false)} />}
    </div>
  );
}
