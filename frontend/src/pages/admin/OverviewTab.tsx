import type { TFunction } from 'i18next';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { BudgetBar, Button, Card, Chip, Icon, Skeleton, spendTone, useToast, type IconName } from '../../components';
import { keyMask } from '../../features/ai/keyFormat';
import { auditTarget, isTerminal } from '../../features/admin/audit';
import { spendMonth, timeLeft, whenInline } from '../../features/admin/display';
import { personName } from '../../features/admin/people';
import type { AdminBudget, AuditEntry, Invite, MemberLimit, ResetCode } from '../../features/admin/types';
import { useAdminAiUsage, useAdminActivity } from '../../features/admin/useAdminUsage';
import { decisionsOf, limitLevels, useAdminAttention } from '../../features/admin/useAdminAttention';
import { useAdminBudget, useAdminKey, useAdminLimits } from '../../features/admin/useAdminAi';
import { useAdminUsers } from '../../features/admin/useAdminUsers';
import { useAudit } from '../../features/admin/useAudit';
import { useInvites, useRevokeInvite } from '../../features/admin/useInvites';
import { useActiveResetCodes, useRevokeResetCode } from '../../features/admin/useResetCodes';
import { formatLimitUsd } from '../../features/admin/limits';
import { capitalize } from '../../features/analytics/display';
import type { AdminAiUsage } from '../../features/costs/types';
import { usePublicSettings } from '../../features/profile/usePublicSettings';
import { currencySign, formatDate, formatDateRange, formatPercent, formatShare, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';
import { ApproveModal, LimitModal, RejectDialog } from './LimitDialogs';
import { ConfirmDialog, HowTo, LoadError } from './parts';
import './overview.css';

// «Администрирование → Обзор» (PANELS.overview макета admin.js): что ждет решения (просьбы
// вернуть ключ администратора, участники у порога и предела лимита), действующие коды и
// приглашения, бюджет ключа и кто его тратит, плитки аккаунтов, ключа и валюты, последние
// действия. Р14: об участниках — только расход на ИИ и активность.

function AttRow({ tone, icon, title, meta, actions }: { tone: 'info' | 'warn' | 'bad'; icon: IconName; title: ReactNode; meta: ReactNode; actions: ReactNode }) {
  return (
    <li className="adm-att">
      <span className={cx('adm-att-ic', tone)} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="adm-min0">
        <div className="adm-att-title">{title}</div>
        <div className="adm-att-meta">{meta}</div>
      </div>
      <div className="adm-att-actions">{actions}</div>
    </li>
  );
}

type Dialog =
  | { kind: 'approve'; member: MemberLimit }
  | { kind: 'reject'; member: MemberLimit }
  | { kind: 'limit'; member: MemberLimit }
  | null;

function DecisionsCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const limits = useAdminLimits();
  const attention = useAdminAttention();
  const [dialog, setDialog] = useState<Dialog>(null);
  const members = limits.data?.members ?? [];
  const ready = limits.data !== undefined && attention.data !== undefined;
  const items = ready && attention.data ? decisionsOf(attention.data, members) : [];
  const alertPct = attention.data?.alert_pct ?? 80;
  const month = spendMonth();

  let body;
  if (limits.isError || attention.isError) {
    body = <LoadError error={limits.error ?? attention.error} onRetry={() => void (limits.isError ? limits.refetch() : attention.refetch())} />;
  } else if (!ready) body = <Skeleton lines={3} height={18} />;
  else if (!items.length) body = <p className="small soft">{t('admin.overview.decisions.empty', { pct: alertPct })}</p>;
  else {
    body = (
      <ul className="adm-att-list">
        {items.map((item) => {
          const m = item.member;
          const name = personName(m);
          if (item.kind === 'return') {
            return (
              <AttRow
                key={`r${m.id}`}
                tone="info"
                icon="key"
                title={t('admin.overview.decisions.returnTitle', { name })}
                meta={t('admin.overview.decisions.returnMeta', { key: keyMask(m.own_key_last4), when: whenInline(m.return_requested_at) })}
                actions={
                  <>
                    <Button kind="primary" size="sm" icon="check" aria-label={t('admin.overview.decisions.allowLabel', { name })} onClick={() => setDialog({ kind: 'approve', member: m })}>
                      {t('admin.overview.decisions.allow')}
                    </Button>
                    <Button size="sm" aria-label={t('admin.overview.decisions.rejectLabel', { name })} onClick={() => setDialog({ kind: 'reject', member: m })}>
                      {t('admin.overview.decisions.reject')}
                    </Button>
                  </>
                }
              />
            );
          }
          const limit = m.limit;
          // уровень 100 — остатка нет даже на вызов Claude: анализы уже остановлены (решает сервер)
          const stopped = item.level === '100';
          const tail = limit?.paused ? t('admin.overview.decisions.paused') : stopped ? t('admin.overview.decisions.stopped') : t('admin.overview.decisions.willStop');
          return (
            <AttRow
              key={`l${m.id}`}
              tone={stopped ? 'bad' : 'warn'}
              icon="coins"
              title={t('admin.overview.decisions.limitTitle', { name, pct: formatPercent(item.share, { digits: 0 }) })}
              meta={`${t('admin.overview.decisions.limitMeta', {
                spent: formatUsd(m.spent_month_usd),
                limit: formatLimitUsd(limit?.monthly_usd ?? 0),
                month,
                n: m.analyses_today,
                count: limit?.daily_analyses ?? 0,
              })} ${tail}`}
              actions={
                <Button kind="primary" size="sm" icon="arrowUp" aria-label={t('admin.overview.decisions.raiseLabel', { name })} onClick={() => setDialog({ kind: 'limit', member: m })}>
                  {t('admin.overview.decisions.raise')}
                </Button>
              }
            />
          );
        })}
      </ul>
    );
  }
  return (
    <Card
      id="adm-decisions"
      className="adm-nowrap-head"
      title={t('admin.overview.decisions.title')}
      subtitle={items.length ? t('admin.overview.decisions.subtitle') : t('admin.overview.decisions.subtitleEmpty')}
      actions={
        ready ? (
          items.length ? (
            <Chip kind="warn">{items.length}</Chip>
          ) : (
            <Chip kind="good" icon="check">
              {t('admin.overview.decisions.calm')}
            </Chip>
          )
        ) : undefined
      }
    >
      {body}
      {dialog?.kind === 'approve' && <ApproveModal member={dialog.member} defaults={limits.data?.defaults} meId={me.id} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'reject' && <RejectDialog member={dialog.member} meId={me.id} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'limit' && <LimitModal member={dialog.member} members={members} meId={me.id} onClose={() => setDialog(null)} />}
    </Card>
  );
}

type Pending = { kind: 'reset'; code: ResetCode } | { kind: 'invite'; invite: Invite };

const codeName = (code: ResetCode) => code.user_name.trim() || code.user_email;

function PendingCard() {
  const { t } = useTranslation();
  const toast = useToast();
  const invites = useInvites();
  const codes = useActiveResetCodes();
  const revokeInvite = useRevokeInvite();
  const revokeCode = useRevokeResetCode();
  const [revoking, setRevoking] = useState<Pending | null>(null);
  const items: Pending[] = [
    ...(codes.data ?? []).filter((code) => code.status === 'active').map((code) => ({ kind: 'reset' as const, code })),
    ...(invites.data ?? []).filter((invite) => invite.status === 'active').map((invite) => ({ kind: 'invite' as const, invite })),
  ];
  const ready = invites.data !== undefined && codes.data !== undefined;

  let body;
  if (invites.isError || codes.isError) body = <LoadError error={invites.error ?? codes.error} onRetry={() => void (invites.isError ? invites.refetch() : codes.refetch())} />;
  else if (!ready) body = <Skeleton lines={2} height={18} />;
  else if (!items.length) body = <p className="small soft">{t('admin.overview.pending.empty')}</p>;
  else {
    body = (
      <ul className="adm-att-list">
        {items.map((item) =>
          item.kind === 'reset' ? (
            <AttRow
              key={`c${item.code.id}`}
              tone="info"
              icon="lock"
              title={t('admin.overview.pending.resetTitle', { name: codeName(item.code) })}
              meta={t('admin.overview.pending.resetMeta', { when: whenInline(item.code.created_at), left: timeLeft(item.code.expires_at) })}
              actions={
                <>
                  <Button size="sm" icon="x" aria-label={t('admin.access.codes.revokeLabel', { name: codeName(item.code) })} onClick={() => setRevoking(item)}>
                    {t('admin.overview.pending.revoke')}
                  </Button>
                  <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.admin('access')}>
                    {t('admin.tabs.access')}
                  </Button>
                </>
              }
            />
          ) : (
            <AttRow
              key={`i${item.invite.id}`}
              tone="info"
              icon="userPlus"
              title={t('admin.overview.pending.inviteTitle', { email: item.invite.email })}
              meta={t('admin.overview.pending.inviteMeta', { until: whenInline(item.invite.expires_at), left: timeLeft(item.invite.expires_at) })}
              actions={
                <>
                  <Button size="sm" icon="x" aria-label={t('admin.invites.revokeLabel', { email: item.invite.email })} onClick={() => setRevoking(item)}>
                    {t('admin.overview.pending.revoke')}
                  </Button>
                  <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.admin('invites')}>
                    {t('admin.tabs.invites')}
                  </Button>
                </>
              }
            />
          ),
        )}
      </ul>
    );
  }
  return (
    <Card
      id="adm-pending"
      className="adm-nowrap-head adm-fill"
      title={t('admin.overview.pending.title')}
      subtitle={items.length ? t('admin.overview.pending.subtitle') : t('admin.overview.pending.subtitleEmpty')}
      actions={ready ? <Chip kind="outline">{items.length}</Chip> : undefined}
    >
      {body}
      {revoking?.kind === 'invite' && (
        <ConfirmDialog
          title={t('admin.invites.revokeTitle')}
          confirmLabel={t('admin.invites.revoke')}
          icon="x"
          danger
          run={() => revokeInvite.mutateAsync(revoking.invite.id)}
          onDone={() => {
            toast.show(t('admin.invites.revokeDone', { email: revoking.invite.email }), { icon: 'x' });
            setRevoking(null);
          }}
          onClose={() => setRevoking(null)}
        >
          <p className="small soft">{t('admin.invites.revokeText', { email: revoking.invite.email })}</p>
        </ConfirmDialog>
      )}
      {revoking?.kind === 'reset' && (
        <ConfirmDialog
          title={t('admin.access.codes.revokeTitle')}
          confirmLabel={t('admin.access.codes.revoke')}
          icon="x"
          danger
          run={() => revokeCode.mutateAsync(revoking.code.id)}
          onDone={() => {
            toast.show(t('admin.access.codes.revokeDone'), { icon: 'x' });
            setRevoking(null);
          }}
          onClose={() => setRevoking(null)}
        >
          <p className="small soft">{t('admin.access.codes.revokeText', { name: codeName(revoking.code) })}</p>
        </ConfirmDialog>
      )}
    </Card>
  );
}

interface Spender {
  key: string;
  name: ReactNode;
  value: number;
  share: number | null;
  meta: string;
  tone: 'warn' | 'bad' | null;
  shared?: boolean;
}

/** «Кто тратит» ключ администратора: первые трое и «остальные», общие задачи и итог. */
export function SpendersList({ usage, me, levels, compact = false, t }: { usage: AdminAiUsage; me: Me; levels: ReadonlyMap<number, '80' | '100'>; compact?: boolean; t: TFunction }) {
  const people = usage.people.filter((p) => p.key_spent_usd > 0).sort((a, b) => b.key_spent_usd - a.key_spent_usd);
  const top = people.length > 4 ? people.slice(0, 3) : people;
  const rest = people.slice(top.length);
  const rows: Spender[] = top.map((p) => {
    // цвет полосы — по уровню лимита с сервера (дела администратора), а не по доле в браузере
    const level = p.ai_mode === 'shared' ? levels.get(p.user_id) : undefined;
    const tone = level === '100' ? 'bad' : level === '80' ? 'warn' : null;
    const note = p.ai_mode === 'own' ? t('admin.overview.spenders.beforeOwn') : p.limit_usd !== null ? t('admin.overview.spenders.limit', { amount: formatLimitUsd(p.limit_usd) }) : t('admin.overview.spenders.noLimit');
    const used = p.limit_share !== null && p.ai_mode !== 'own' ? t('admin.overview.spenders.used', { pct: formatPercent(p.limit_share, { digits: 0 }) }) : '';
    return {
      key: `u${p.user_id}`,
      name: (
        <>
          {p.display_name}
          {p.user_id === me.id && <Chip kind="accent">{t('admin.overview.spenders.you')}</Chip>}
          {p.status === 'deleted' && <Chip kind="outline">{t('admin.overview.spenders.deleted')}</Chip>}
        </>
      ),
      value: p.key_spent_usd,
      share: p.budget_share,
      meta: `${note}${used}`,
      tone,
    };
  });
  if (rest.length) {
    rows.push({
      key: 'rest',
      name: t('admin.overview.spenders.rest', { count: rest.length }),
      value: Math.round(rest.reduce((sum, p) => sum + p.key_spent_usd, 0) * 100) / 100,
      share: null,
      meta: rest.map((p) => p.display_name.split(' ')[0]).join(', '),
      tone: null,
    });
  }
  rows.push({ key: 'shared', name: t('admin.overview.spenders.shared'), value: usage.shared.cost_usd, share: usage.shared.budget_share, meta: t('admin.overview.spenders.sharedMeta'), tone: null, shared: true });
  const max = Math.max(...rows.map((row) => row.value), 0) || 1;
  return (
    <ul className={cx('adm-urows', compact && 'compact')} aria-label={t('admin.overview.spenders.label')}>
      {rows.map((row) => (
        <li key={row.key} className="adm-urow">
          <div className="adm-urow-name">{row.name}</div>
          <div className="adm-urow-val">
            <b>{formatUsd(row.value)}</b>
            {row.share !== null && <small>{t('admin.overview.spenders.ofBudget', { pct: formatShare(row.share) })}</small>}
          </div>
          <div className="adm-urow-meta">{row.meta}</div>
          <div className="adm-urow-bar" aria-hidden="true">
            <i style={{ width: `${(row.value / max) * 100}%`, background: row.shared ? 'var(--fg-3)' : row.tone === 'bad' ? 'var(--bad)' : row.tone === 'warn' ? 'var(--warn)' : 'var(--accent)' }} />
          </div>
        </li>
      ))}
      <TotalRow usage={usage} t={t} />
    </ul>
  );
}

/** «Итого с вашего ключа» — та же сумма, что «Потрачено» в бюджете. */
export function TotalRow({ usage, t }: { usage: AdminAiUsage; t: TFunction }) {
  return (
    <li className="adm-urow adm-total">
      <div className="adm-urow-name">{t('admin.overview.spenders.total')}</div>
      <div className="adm-urow-val">
        <b>{formatUsd(usage.spent_usd)}</b>
        {usage.budget_share !== null && <small>{t('admin.overview.spenders.ofBudget', { pct: formatShare(usage.budget_share) })}</small>}
      </div>
      <div className="adm-urow-meta">{t('admin.overview.spenders.period', { period: usagePeriod(usage) })}</div>
    </li>
  );
}

/** «1–13 октября» — месяц ответа (дни по UTC): с первого числа по последний день с данными. */
export function usagePeriod(usage: Pick<AdminAiUsage, 'month_start' | 'last_day'>): string {
  return formatDateRange(usage.month_start, usage.last_day, { month: 'long' });
}

/** День месяца бюджета по UTC: бюджет считается за календарный месяц UTC, как на сервере. */
function budgetDay(monthStart: string, day: number): Date {
  const start = new Date(monthStart);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day));
}

/** Бюджет ключа только показом (budgetBody макета); подписи — как в «Ключ и бюджет». */
function BudgetBody({ budget, t }: { budget: AdminBudget; t: TFunction }) {
  const total = budget.budget_usd;
  const tone = spendTone(budget.spent_usd, total, budget.alert_pct);
  // доля прогноза в бюджете — пока в браузере (заявка A: forecast_share в AdminBudgetOut)
  const pct = (value: number) => formatPercent(total > 0 ? value / total : 0, { digits: 0 });
  const today = budget.days_in_month - budget.days_left;
  const end = formatDate(budgetDay(budget.month_start, budget.days_in_month), { timeZone: 'UTC' });
  const todayText = formatDate(budgetDay(budget.month_start, today), { timeZone: 'UTC' });
  const alertText = formatPercent(budget.alert_pct / 100, { digits: 0 });
  const over = total > 0 && budget.forecast_usd >= total;
  return (
    <>
      <div className="adm-big">
        <span className="stat-value">{formatUsd(budget.spent_usd)}</span>
        <span className="adm-of">{t('admin.key.budget.of', { budget: formatLimitUsd(total) })}</span>
        <Chip kind={tone ?? 'good'} icon={tone ? 'alert' : 'check'}>
          {t('admin.key.budget.share', { pct: budget.budget_share === null || budget.budget_share === undefined ? '—' : formatShare(budget.budget_share) })}
        </Chip>
      </div>
      <BudgetBar
        spent={budget.spent_usd}
        forecast={budget.forecast_usd}
        budget={total}
        alertPct={budget.alert_pct}
        label={t('admin.key.budget.barLabel', { spent: formatUsd(budget.spent_usd), budget: formatLimitUsd(total), forecast: formatUsd(budget.forecast_usd) })}
        markTitle={t('admin.key.budget.legendMark', { pct: alertText })}
        legend={[
          today > 1 ? t('admin.key.budget.legendSpent', { date: todayText }) : t('admin.key.budget.legendSpentDay', { date: todayText }),
          t('admin.key.budget.legendForecast', { date: end }),
          t('admin.key.budget.legendMark', { pct: alertText }),
        ]}
      />
      <dl className="adm-kv3">
        <div>
          <dt>{t('admin.key.budget.left')}</dt>
          <dd>
            {formatUsd(budget.left_usd)}
            <small>{t('admin.key.budget.until', { date: end })}</small>
          </dd>
        </div>
        <div>
          <dt>{t('admin.key.budget.daysLeft')}</dt>
          <dd>
            {t('admin.key.budget.days', { count: budget.days_left })}
            <small>{t('admin.key.budget.today', { date: todayText })}</small>
          </dd>
        </div>
        <div>
          <dt>{t('admin.key.budget.forecast')}</dt>
          <dd>
            {t('profile.key.approx', { amount: formatUsd(budget.forecast_usd) })}
            <small>{t('admin.key.budget.share', { pct: pct(budget.forecast_usd) })}</small>
          </dd>
        </div>
      </dl>
      <HowTo>{over ? t('admin.overview.budget.over') : t('admin.overview.budget.howto')}</HowTo>
    </>
  );
}

function BudgetCard({ me }: { me: Me }) {
  const { t } = useTranslation();
  const budget = useAdminBudget();
  const usage = useAdminAiUsage();
  const attention = useAdminAttention();
  const month = spendMonth();
  return (
    <Card
      className="adm-fill"
      title={t('admin.overview.budget.title')}
      subtitle={t('admin.overview.budget.subtitle', { month: capitalize(month) })}
      foot={
        <>
          <Button kind="ghost" size="sm" icon="coins" to={paths.admin('usage')}>
            {t('admin.tabs.usage')}
          </Button>
          <Button kind="ghost" size="sm" icon="key" to={paths.admin('key')}>
            {t('admin.tabs.key')}
          </Button>
        </>
      }
    >
      {budget.data ? <BudgetBody budget={budget.data} t={t} /> : budget.isError ? <LoadError error={budget.error} onRetry={() => void budget.refetch()} /> : <Skeleton lines={4} height={18} />}
      <div className="eyebrow adm-eyebrow-gap">{t('admin.overview.spenders.title')}</div>
      {usage.data ? (
        <SpendersList usage={usage.data} me={me} levels={limitLevels(attention.data)} compact t={t} />
      ) : usage.isError ? (
        <LoadError error={usage.error} onRetry={() => void usage.refetch()} />
      ) : (
        <Skeleton lines={3} height={18} />
      )}
    </Card>
  );
}

function Tile({ icon, label, value, sub, foot }: { icon: IconName; label: string; value: ReactNode; sub?: ReactNode; foot: ReactNode }) {
  return (
    <section className="card adm-tile" aria-label={label}>
      <div className="stat-label">
        <Icon name={icon} size={16} />
        {label}
      </div>
      <div className="adm-tile-value">{value}</div>
      {sub !== undefined && <div className="adm-tile-sub">{sub}</div>}
      <div className="adm-tile-foot">{foot}</div>
    </section>
  );
}

function Tiles() {
  const { t } = useTranslation();
  const users = useAdminUsers();
  const activity = useAdminActivity('30d');
  const key = useAdminKey();
  const settings = usePublicSettings();
  const people = (users.data ?? []).filter((u) => u.status !== 'deleted');
  const active = people.filter((u) => u.status === 'active');
  const blocked = people.length - active.length;
  const onKey = active.filter((u) => u.ai_mode === 'shared').length;
  const own = active.filter((u) => u.ai_mode === 'own').length;
  const currency = settings.data?.currency ?? null;
  const k = key.data;
  return (
    <div className="grid">
      <div className="adm-third">
        <Tile
          icon="users"
          label={t('admin.overview.tiles.people')}
          value={
            users.data ? (
              <>
                <span>{active.length}</span>
                <span className="adm-of">{t('admin.overview.tiles.of', { n: people.length })}</span>
              </>
            ) : (
              <Skeleton width={80} height={28} />
            )
          }
          sub={users.data ? [t('admin.overview.tiles.onKey', { count: onKey }), t('admin.overview.tiles.own', { count: own }), ...(blocked ? [t('admin.overview.tiles.blocked', { count: blocked })] : [])].join(' · ') : undefined}
          foot={
            <>
              <span className="stat-hint">{activity.data ? t('admin.overview.tiles.today', { n: activity.data.today_users }) : ''}</span>
              <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.admin('users')}>
                {t('admin.tabs.users')}
              </Button>
            </>
          }
        />
      </div>
      <div className="adm-third">
        <Tile
          icon="key"
          label={t('admin.overview.tiles.key')}
          value={
            !k ? (
              <Skeleton width={120} height={28} />
            ) : k.status === 'missing' ? (
              <>
                <span>{t('admin.overview.tiles.keyMissing')}</span>
                <Chip kind="bad" icon="alert">
                  {t('admin.key.card.missing')}
                </Chip>
              </>
            ) : (
              <>
                <code>{keyMask(k.last4)}</code>
                {k.status === 'ok' ? (
                  <Chip kind="good" icon="check">
                    {t('admin.key.card.works')}
                  </Chip>
                ) : (
                  <Chip kind="warn" icon="alert">
                    {t('admin.key.card.unverified')}
                  </Chip>
                )}
              </>
            )
          }
          sub={k ? (k.status === 'missing' ? t('admin.overview.tiles.keyMissingSub') : k.verified_at ? t('admin.overview.tiles.keySub', { when: whenInline(k.verified_at) }) : t('admin.overview.tiles.keyUnverifiedSub')) : undefined}
          foot={
            <>
              <span className="stat-hint">{t('admin.overview.tiles.keyStored')}</span>
              <Button kind="ghost" size="sm" iconRight="chevronRight" to={`${paths.admin('key')}#adm-key`}>
                {k?.status === 'missing' ? t('admin.overview.tiles.keySet') : t('admin.overview.tiles.keyReplace')}
              </Button>
            </>
          }
        />
      </div>
      <div className="adm-third">
        <Tile
          icon="currency"
          label={t('admin.overview.tiles.currency')}
          value={
            currency ? (
              <>
                <span>{currencySign(currency)}</span>
                <span className="adm-of">{t(`admin.overview.tiles.currencies.${currency}`)}</span>
              </>
            ) : (
              <Skeleton width={80} height={28} />
            )
          }
          sub={t('admin.overview.tiles.currencySub')}
          foot={
            <>
              <span className="stat-hint">{t('admin.overview.tiles.currencyOne')}</span>
              <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.admin('settings')}>
                {t('admin.overview.tiles.change')}
              </Button>
            </>
          }
        />
      </div>
    </div>
  );
}

// Иконки действий журнала — как в макете (ACTIONS в admin.js)
const ACTION_ICON: Partial<Record<AuditEntry['action'], IconName>> = {
  invite: 'userPlus',
  invite_revoke: 'x',
  reset_code: 'lock',
  reset_code_revoke: 'x',
  reset_2fa: 'shield',
  sessions_revoke: 'logout',
  block: 'ban',
  unblock: 'check',
  delete: 'trash',
  role_change: 'admin',
  create_admin: 'admin',
  limit_change: 'sliders',
  budget_change: 'coins',
  key_change: 'key',
  ai_mode_change: 'key',
  currency_change: 'currency',
  message: 'megaphone',
  confirm_failed: 'shield',
  player_merge: 'users',
  player_edit: 'user',
  import: 'upload',
  agent_config_change: 'sliders',
};

/** Последние действия из журнала (recentCard макета). */
function RecentCard() {
  const { t } = useTranslation();
  const audit = useAudit('all');
  const entries = (audit.data?.pages.flat() ?? []).slice(0, 5);
  let body;
  if (audit.isError) body = <LoadError error={audit.error} onRetry={() => void audit.refetch()} />;
  else if (audit.isPending) body = <Skeleton lines={4} height={18} />;
  else if (!entries.length) body = <p className="small soft">{t('admin.audit.empty')}</p>;
  else {
    body = (
      <ul className="adm-recent">
        {entries.map((entry) => {
          const target = auditTarget(entry);
          return (
            <li key={entry.id}>
              <span className="adm-recent-ic" aria-hidden="true">
                <Icon name={ACTION_ICON[entry.action] ?? 'info'} />
              </span>
              <div className="adm-recent-text">
                <div>
                  <b>{t(`admin.audit.actions.${entry.action}`)}</b>
                  {target ? `: ${target}` : ''}
                </div>
                <div className="muted">
                  {whenInline(entry.at)} · {isTerminal(entry) ? t('admin.overview.recent.terminal') : entry.actor_name}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <Card
      className="adm-nowrap-head"
      title={t('admin.overview.recent.title')}
      subtitle={t('admin.overview.recent.subtitle')}
      actions={
        <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.admin('audit')}>
          {t('admin.overview.recent.all')}
        </Button>
      }
    >
      {body}
    </Card>
  );
}

export function OverviewTab({ me }: { me: Me }) {
  return (
    <>
      <div className="grid">
        <div className="col-7 adm-col">
          <DecisionsCard me={me} />
          <PendingCard />
        </div>
        <div className="col-5 adm-col">
          <BudgetCard me={me} />
        </div>
      </div>
      <Tiles />
      <RecentCard />
    </>
  );
}
