import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Button, Card, Chip, DataTable, Icon, Segmented, Skeleton, Stat } from '../../components';
import { HBars } from '../../components/charts';
import { keyMask } from '../../features/ai/keyFormat';
import { whenInline } from '../../features/admin/display';
import { formatLimitUsd } from '../../features/admin/limits';
import { useAdminLimits } from '../../features/admin/useAdminAi';
import { useAdminActivity, useAdminAiUsage } from '../../features/admin/useAdminUsage';
import { kindLabel, kindSetup } from '../../features/costs/display';
import { useAiUsage } from '../../features/dashboard/api';
import type { AdminAiUsage, PersonUsage } from '../../features/costs/types';
import { formatPercent, formatUsd } from '../../lib/format';
import { HowTo, LoadError } from './parts';
import { TotalRow, usagePeriod } from './OverviewTab';
import './overview.css';

// «Администрирование → Расход ИИ» (PANELS.usage макета admin.js): расход ключа администратора
// за месяц (дни по UTC) по людям и по задачам, общие задачи без участника и проверки (eval)
// отдельно, участники на своих ключах и активность — входы и анализы. Р14: только расход на ИИ
// и активность, без ставок, банка и содержания анализов. Суммы, доли бюджета, кэш и средняя
// цена — с сервера. Пока считаются здесь (заявка A на волну 5): доли людей в легенде «По людям»
// (доля в расходе — PersonUsageOut.spent_share); ширины полос — только рисунок.

// Цвета людей — как PERSON_COLORS макета; общие задачи — серым
const PERSON_COLORS = ['var(--s1)', 'var(--s3)', 'var(--s4)', 'var(--s7)', 'var(--s5)', 'var(--s2)'] as const;
const SHARED_COLOR = 'var(--fg-3)';
const ACTIVITY_PERIODS = ['7d', '30d', '90d'] as const;
type ShownPeriod = (typeof ACTIVITY_PERIODS)[number];

/** Люди на ключе администратора: с расходом на нем или работающие на нем сейчас; больше — выше. */
export function keyPeople(people: readonly PersonUsage[]): PersonUsage[] {
  return people
    .filter((p) => p.key_spent_usd > 0 || (p.ai_mode === 'shared' && p.status !== 'deleted'))
    .sort((a, b) => b.key_spent_usd - a.key_spent_usd || a.display_name.localeCompare(b.display_name, 'ru'));
}

/** Участники на своих ключах или с расходом на своем ключе в этом месяце. */
export function ownPeople(people: readonly PersonUsage[]): PersonUsage[] {
  return people
    .filter((p) => p.status !== 'deleted' && (p.ai_mode === 'own' || p.own_spent_usd > 0))
    .sort((a, b) => b.own_spent_usd - a.own_spent_usd || a.display_name.localeCompare(b.display_name, 'ru'));
}

function shareOf(value: number, total: number): string {
  return formatPercent(total > 0 ? value / total : 0, { digits: 0 });
}

function sharedKinds(usage: AdminAiUsage, t: TFunction): string {
  return usage.shared.kinds.map((kind) => kindLabel(kind, t)).join(', ');
}

function Tiles({ usage, t }: { usage: AdminAiUsage; t: TFunction }) {
  const period = usagePeriod(usage);
  return (
    <div className="grid">
      <Stat
        className="col-3 half-mobile"
        icon="coins"
        label={t('admin.usage.tiles.spent')}
        value={formatUsd(usage.spent_usd)}
        hint={
          usage.budget_share !== null
            ? t('admin.usage.tiles.spentHint', { pct: formatPercent(usage.budget_share, { digits: 0 }), budget: formatLimitUsd(usage.budget_usd) })
            : t('admin.usage.tiles.noBudget')
        }
      />
      <Stat
        className="col-3 half-mobile"
        icon="spark"
        label={t('admin.usage.tiles.analyses')}
        value={String(usage.analyses)}
        hint={usage.avg_analysis_usd !== null ? t('admin.usage.tiles.avg', { amount: formatUsd(usage.avg_analysis_usd) }) : t('admin.usage.tiles.noAvg')}
      />
      <Stat
        className="col-3 half-mobile"
        icon="database"
        label={t('admin.usage.tiles.cache')}
        value={usage.cache_share !== null ? formatPercent(usage.cache_share, { digits: 0 }) : '—'}
        hint={t('admin.usage.tiles.cacheHint', { period })}
      />
      <Stat
        className="col-3 half-mobile"
        icon="key"
        label={t('admin.usage.tiles.own')}
        value={formatUsd(usage.own_key_usd)}
        hint={t('admin.usage.tiles.ownHint')}
      />
    </div>
  );
}

function personMeta(p: PersonUsage, period: string, t: TFunction): string {
  if (p.ai_mode === 'own') return t('admin.overview.spenders.beforeOwn');
  const parts: string[] = [];
  if (p.own_spent_usd > 0) parts.push(t('admin.usage.people.returned'));
  parts.push(t('admin.usage.people.analyses', { count: p.analyses, period }));
  if (p.limit_usd !== null) {
    parts.push(p.paused ? t('admin.usage.people.limitPaused', { amount: formatLimitUsd(p.limit_usd) }) : t('admin.overview.spenders.limit', { amount: formatLimitUsd(p.limit_usd) }));
  } else parts.push(t('admin.overview.spenders.noLimit'));
  return parts.join(' · ');
}

function PeopleCard({ usage, me, t }: { usage: AdminAiUsage; me: Me; t: TFunction }) {
  const period = usagePeriod(usage);
  const people = keyPeople(usage.people).map((p, i) => ({ p, color: PERSON_COLORS[i % PERSON_COLORS.length] ?? 'var(--s1)' }));
  const segs = [
    ...people.filter(({ p }) => p.key_spent_usd > 0).map(({ p, color }) => ({ key: `u${p.user_id}`, label: p.display_name.split(/\s+/)[0] ?? p.display_name, value: p.key_spent_usd, color })),
    ...(usage.shared.cost_usd > 0 ? [{ key: 'shared', label: t('admin.usage.people.sharedShort'), value: usage.shared.cost_usd, color: SHARED_COLOR }] : []),
  ];
  const total = segs.reduce((sum, s) => sum + s.value, 0);
  const max = Math.max(...people.map(({ p }) => p.key_spent_usd), usage.shared.cost_usd, 0) || 1;
  const ofBudget = (share: number | null) => (share !== null ? <small>{t('admin.overview.spenders.ofBudget', { pct: formatPercent(share, { digits: 1 }) })}</small> : null);
  return (
    <Card id="adm-usage-people" title={t('admin.usage.people.title')} subtitle={t('admin.usage.people.subtitle', { period, amount: formatUsd(usage.spent_usd) })}>
      {total > 0 && (
        <>
          <div className="adm-stack" role="img" aria-label={t('admin.usage.people.stackLabel', { parts: segs.map((s) => `${s.label} ${formatUsd(s.value)}`).join(', ') })}>
            {segs.map((s) => (
              <i key={s.key} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} title={`${s.label}: ${formatUsd(s.value)}`} />
            ))}
          </div>
          <div className="adm-legend">
            {segs.map((s) => (
              <span key={s.key}>
                <i style={{ background: s.color }} aria-hidden="true" />
                {s.label} {shareOf(s.value, total)}
              </span>
            ))}
          </div>
        </>
      )}
      <ul className="adm-urows" aria-label={t('admin.usage.people.listLabel')}>
        {people.map(({ p, color }) => (
          <li key={p.user_id} className="adm-urow">
            <div className="adm-urow-name">
              <i className="adm-sw" style={{ background: color }} aria-hidden="true" />
              {p.display_name}
              {p.user_id === me.id && <Chip kind="accent">{t('admin.overview.spenders.you')}</Chip>}
              {p.status === 'blocked' && <Chip kind="bad">{t('admin.usage.people.blocked')}</Chip>}
              {p.status === 'deleted' && <Chip kind="outline">{t('admin.overview.spenders.deleted')}</Chip>}
            </div>
            <div className="adm-urow-val">
              <b>{formatUsd(p.key_spent_usd)}</b>
              {ofBudget(p.budget_share)}
            </div>
            <div className="adm-urow-meta">{personMeta(p, period, t)}</div>
            <div className="adm-urow-bar" aria-hidden="true">
              <i style={{ width: `${(p.key_spent_usd / max) * 100}%`, background: color }} />
            </div>
          </li>
        ))}
        <li className="adm-urow">
          <div className="adm-urow-name">
            <i className="adm-sw" style={{ background: SHARED_COLOR }} aria-hidden="true" />
            {t('admin.overview.spenders.shared')}
          </div>
          <div className="adm-urow-val">
            <b>{formatUsd(usage.shared.cost_usd)}</b>
            {ofBudget(usage.shared.budget_share)}
          </div>
          <div className="adm-urow-meta">
            {usage.shared.runs > 0 ? t('admin.usage.people.sharedMeta', { kinds: sharedKinds(usage, t) }) : t('admin.usage.people.sharedNone')}
          </div>
          <div className="adm-urow-bar" aria-hidden="true">
            <i style={{ width: `${(usage.shared.cost_usd / max) * 100}%`, background: SHARED_COLOR }} />
          </div>
        </li>
        <TotalRow usage={usage} t={t} />
      </ul>
      <HowTo>{t('admin.usage.people.howto', { budget: formatLimitUsd(usage.budget_usd) })}</HowTo>
    </Card>
  );
}

function TasksCard({ usage, t }: { usage: AdminAiUsage; t: TFunction }) {
  // effort и «на матч» — из настроек агента (свой расход администратора, тот же кэш, что «ИИ и расходы»)
  const settings = useAiUsage(true).data?.settings;
  const rows = [
    ...usage.tasks.map((task) => ({ key: task.kind, label: kindLabel(task.kind, t), cost: task.cost_usd, share: task.budget_share, cache: task.cache_share, models: task.models, runs: task.runs, shared: false })),
    ...(usage.shared.runs > 0
      ? [{ key: 'shared', label: t('admin.usage.people.sharedShort'), cost: usage.shared.cost_usd, share: usage.shared.budget_share, cache: usage.shared.cache_share, models: [] as string[], runs: usage.shared.runs, shared: true }]
      : []),
  ].sort((a, b) => b.cost - a.cost);
  const evalUsage = usage.eval;
  const evalShare = evalUsage.budget_usd > 0 ? Math.min(1, evalUsage.spent_usd / evalUsage.budget_usd) : 0;
  const evalItems = evalUsage.items
    .map((item) => t('admin.usage.tasks.evalItem', { name: item.name ?? item.eval_set ?? t('admin.usage.tasks.evalShadow'), amount: formatUsd(item.cost_usd) }))
    .join('; ');
  return (
    <Card title={t('admin.usage.tasks.title')} subtitle={t('admin.usage.tasks.subtitle', { amount: formatUsd(usage.spent_usd) })}>
      {rows.length ? (
        <>
          <HBars
            ariaLabel={t('admin.usage.tasks.chartLabel')}
            valueFormat={(value) => formatUsd(value)}
            items={rows.map((row) => ({
              key: row.key,
              label: row.label,
              value: row.cost,
              note: row.share !== null ? formatPercent(row.share, { digits: 1 }) : undefined,
              color: row.shared ? SHARED_COLOR : 'var(--s1)',
              dot: false,
            }))}
          />
          <div className="adm-bleed">
            <DataTable
              mobileLayout="table"
              caption={t('admin.usage.tasks.tableLabel')}
              rows={rows}
              rowKey={(row) => row.key}
              columns={[
                {
                  key: 'task',
                  label: t('admin.usage.tasks.colTask'),
                  render: (row) => (
                    <div>
                      <div>{row.shared ? t('admin.overview.spenders.shared') : row.label}</div>
                      <div className="xsmall muted">
                        {[row.shared ? sharedKinds(usage, t) : kindSetup(row.key, row.models, settings, t), t('admin.usage.tasks.runs', { count: row.runs })].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                  ),
                },
                { key: 'cache', label: t('admin.usage.tasks.colCache'), align: 'r', render: (row) => (row.cache ? formatPercent(row.cache, { digits: 0 }) : t('admin.usage.tasks.noCache')) },
              ]}
            />
          </div>
        </>
      ) : (
        <p className="small soft">{t('admin.usage.tasks.empty')}</p>
      )}
      <div className="adm-eval">
        <div className="adm-urow-name">
          <Icon name="flask" size={16} />
          {t('admin.usage.tasks.evalTitle')}
        </div>
        <div className="adm-urow-val">
          <b>{formatUsd(evalUsage.spent_usd)}</b>
          <small>{t('admin.usage.tasks.evalOf', { budget: formatLimitUsd(evalUsage.budget_usd) })}</small>
        </div>
        <div className="adm-urow-meta">
          {evalItems ? `${evalItems}. ` : evalUsage.runs ? '' : `${t('admin.usage.tasks.evalNone')} `}
          {t('admin.usage.tasks.evalApart', { budget: formatLimitUsd(usage.budget_usd) })}
        </div>
        <div className="adm-urow-bar" aria-hidden="true">
          <i style={{ width: `${evalShare * 100}%`, background: SHARED_COLOR }} />
        </div>
      </div>
      <HowTo>{t('admin.usage.tasks.howto')}</HowTo>
    </Card>
  );
}

function OwnCard({ usage, t }: { usage: AdminAiUsage; t: TFunction }) {
  const limits = useAdminLimits();
  const people = ownPeople(usage.people);
  const last4 = (id: number) => limits.data?.members.find((m) => m.id === id)?.own_key_last4 ?? null;
  return (
    <Card title={t('admin.usage.own.title')} subtitle={t('admin.usage.own.subtitle')}>
      {people.length ? (
        <>
          <div className="adm-list">
            {people.map((p) => (
              <div key={p.user_id} className="adm-item">
                <span className="adm-item-ic info" aria-hidden="true">
                  <Icon name="key" />
                </span>
                <div className="adm-min0">
                  <div className="adm-item-title">{p.display_name}</div>
                  <div className="adm-item-meta">
                    {p.ai_mode === 'own'
                      ? [t('admin.usage.own.analyses', { count: p.own_analyses }), ...(last4(p.user_id) ? [t('admin.usage.own.key', { key: keyMask(last4(p.user_id)) })] : [])].join(' · ')
                      : t('admin.usage.own.returned')}
                  </div>
                </div>
                <div className="adm-item-side">
                  <b className="mono">{formatUsd(p.own_spent_usd)}</b>
                </div>
              </div>
            ))}
          </div>
          <HowTo>{t('admin.usage.own.howto')}</HowTo>
        </>
      ) : (
        <p className="small soft">{t('admin.usage.own.empty')}</p>
      )}
    </Card>
  );
}

/** Период активности из адреса (/admin/usage?period=7d); иначе — 30 дней. */
export function activityPeriodOf(search: URLSearchParams): ShownPeriod {
  const value = search.get('period');
  return (ACTIVITY_PERIODS as readonly string[]).includes(value ?? '') ? (value as ShownPeriod) : '30d';
}

/** Активность за 7, 30 или 90 дней: входы (и неудачные попытки) и анализы по людям. */
function ActivityCard({ t }: { t: TFunction }) {
  // период — в адресе: переживает перезагрузку, «Назад» и ссылку
  const [params, setParams] = useSearchParams();
  const period = activityPeriodOf(params);
  const setPeriod = (next: ShownPeriod) =>
    setParams((prev) => {
      const search = new URLSearchParams(prev);
      if (next === '30d') search.delete('period');
      else search.set('period', next);
      return search;
    });
  const activity = useAdminActivity(period);
  const data = activity.data;
  const people = data ? [...data.people].filter((p) => p.status !== 'deleted' || p.logins > 0 || p.analyses > 0).sort((a, b) => b.analyses - a.analyses || b.logins - a.logins || a.display_name.localeCompare(b.display_name, 'ru')) : [];
  let body;
  if (activity.isError && !data) body = <LoadError error={activity.error} onRetry={() => void activity.refetch()} />;
  else if (!data) body = <Skeleton lines={4} height={18} />;
  else {
    body = (
      <>
        <div className="adm-act-sums">
          <span>
            {t('admin.usage.activity.active')} <b>{data.active_users}</b>
          </span>
          <span>
            {t('admin.usage.activity.logins')} <b>{data.logins}</b>
          </span>
          <span>
            {t('admin.usage.activity.failed')} <b>{data.failed_logins}</b>
          </span>
          <span>
            {t('admin.usage.activity.analyses')} <b>{data.analyses}</b>
          </span>
        </div>
        {people.length ? (
          <ul className="adm-urows" aria-label={t('admin.usage.activity.listLabel')}>
            {people.map((p) => (
              <li key={p.user_id} className="adm-urow">
                <div className="adm-urow-name">
                  {p.display_name}
                  {p.status === 'blocked' && <Chip kind="bad">{t('admin.usage.people.blocked')}</Chip>}
                  {p.status === 'deleted' && <Chip kind="outline">{t('admin.overview.spenders.deleted')}</Chip>}
                </div>
                <div className="adm-urow-val">
                  <b>{t('admin.usage.activity.analysesN', { count: p.analyses })}</b>
                  <small>{t('admin.usage.activity.loginsN', { count: p.logins })}</small>
                </div>
                <div className="adm-urow-meta">
                  {[
                    p.last_login_at ? t('admin.usage.activity.lastLogin', { when: whenInline(p.last_login_at) }) : t('admin.usage.activity.noLogin'),
                    ...(p.failed_logins ? [t('admin.usage.activity.failedN', { count: p.failed_logins })] : []),
                  ].join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small soft">{t('admin.usage.activity.empty')}</p>
        )}
      </>
    );
  }
  return (
    <Card
      title={t('admin.usage.activity.title')}
      subtitle={t('admin.usage.activity.subtitle')}
      actions={
        <Segmented
          label={t('admin.usage.activity.periodLabel')}
          value={period}
          onChange={setPeriod}
          items={ACTIVITY_PERIODS.map((value) => ({ value, label: t(`admin.usage.activity.periods.${value}`) }))}
        />
      }
    >
      {body}
    </Card>
  );
}

export function UsageTab({ me }: { me: Me }) {
  const { t } = useTranslation();
  const usage = useAdminAiUsage();
  const data = usage.data;
  return (
    <>
      <div className="adm-usage-top">
        <div className="small soft">{data ? t('admin.usage.top', { period: usagePeriod(data) }) : t('admin.usage.topLoading')}</div>
        <Button kind="ghost" size="sm" icon="key" to={paths.admin('key')}>
          {t('admin.tabs.key')}
        </Button>
      </div>
      {data ? (
        <>
          <Tiles usage={data} t={t} />
          <div className="adm-main">
            <PeopleCard usage={data} me={me} t={t} />
            <div className="adm-col">
              <TasksCard usage={data} t={t} />
              <OwnCard usage={data} t={t} />
            </div>
          </div>
        </>
      ) : usage.isError ? (
        <Card>
          <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
        </Card>
      ) : (
        <div className="grid" aria-busy="true">
          <div className="col-7">
            <Card>
              <Skeleton lines={6} />
            </Card>
          </div>
          <div className="col-5">
            <Card>
              <Skeleton lines={6} />
            </Card>
          </div>
        </div>
      )}
      <ActivityCard t={t} />
    </>
  );
}
