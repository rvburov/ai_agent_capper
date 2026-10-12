import type { ReactNode } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, Icon, LimitBar, Skeleton, spendTone } from '../../components';
import { spendMonth, whenInline } from '../../features/admin/display';
import { formatLimitUsd } from '../../features/admin/limits';
import { useAdminKey } from '../../features/admin/useAdminAi';
import { keyMask, spelled } from '../../features/ai/keyFormat';
import { aiErrorText } from '../../features/ai/reasons';
import type { AiBudget } from '../../features/ai/types';
import i18n from '../../i18n';
import { formatDayMonth, formatPercent, formatUsd } from '../../lib/format';

/** Месяц расхода (UTC, как на сервере): «октябрь» и начало следующего: «1 ноября». */
function monthOf(budget: AiBudget): { month: string; next: string } {
  const start = new Date(budget.month_start);
  const next = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
  return { month: spendMonth(start), next: formatDayMonth(next, { timeZone: 'UTC' }) };
}

function Fact({ label, value, sub }: { label: ReactNode; value: ReactNode; sub: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        <small>{sub}</small>
      </dd>
    </div>
  );
}

/** Шкала лимита с подписями «$0 · 80% · $8 · $10» (limitBar макета). */
function Bar({ spent, max, alertPct, label }: { spent: number; max: number; alertPct: number; label: string }) {
  const { t } = useTranslation();
  const valueText = t('profile.key.barValue', { spent: formatUsd(spent), max: formatLimitUsd(max) });
  return (
    <LimitBar
      spent={spent}
      max={max}
      alertPct={alertPct}
      label={label}
      valueText={valueText}
      scale={[
        formatUsd(0, 0),
        t('profile.key.scaleMark', {
          pct: formatPercent(alertPct / 100, { digits: 0 }),
          amount: formatLimitUsd(Math.round(max * alertPct) / 100),
        }),
        formatLimitUsd(max),
      ]}
    />
  );
}

const avgText = (budget: AiBudget) =>
  budget.avg_analysis_usd !== null ? i18n.t('profile.key.approx', { amount: formatUsd(budget.avg_analysis_usd) }) : '—';

/**
 * Участник на ключе администратора (adminKeyCard макета): лимит, расход и что будет на пороге
 * уведомления и на 100%. Причина запрета — та же, что у запуска анализа (/api/ai/budget).
 */
export function MemberLimitCard({ budget }: { budget: AiBudget }) {
  const { t } = useTranslation();
  const { month, next } = monthOf(budget);
  const monthly = budget.monthly_usd ?? 0;
  const spent = budget.spent_usd;
  const left = budget.left_usd ?? Math.max(0, monthly - spent);
  const alert = budget.alert_pct;
  const tone = spendTone(spent, monthly, alert);
  // Лимит месяца не пускает анализ и тогда, когда остаток меньше худшего случая вызова Claude:
  // «исчерпан» — только на 100%, иначе — причина с сервера
  const exhausted = tone === 'bad';
  const stopped = exhausted || budget.reason_code === 'ai.monthly_limit';
  const alertText = formatPercent(alert / 100, { digits: 0 });

  let chip: ReactNode;
  if (budget.paused) {
    chip = (
      <Chip kind="warn" icon="pause">
        {t('profile.key.limit.chipPaused')}
      </Chip>
    );
  } else if (stopped) {
    chip = (
      <Chip kind="bad" icon="pause">
        {t('profile.key.limit.chipStopped')}
      </Chip>
    );
  } else if (tone === 'warn') {
    chip = (
      <Chip kind="warn" icon="alert">
        {t('profile.key.limit.chipWarned', { pct: alertText })}
      </Chip>
    );
  } else {
    chip = (
      <Chip kind="good" icon="check">
        {t('profile.key.limit.chipOk')}
      </Chip>
    );
  }

  let why: ReactNode = null;
  if (budget.paused) {
    why = (
      <Callout kind="warn" icon="pause">
        <b>{t('profile.key.limit.pausedStrong')}</b> {t('profile.key.limit.paused', { month })}
      </Callout>
    );
  } else if (stopped) {
    why = (
      <Callout kind="bad" icon="pause">
        <b>
          {exhausted
            ? t('profile.key.limit.stoppedStrong')
            : t('profile.key.reason', { text: aiErrorText('ai.monthly_limit', budget.reason_params) })}
        </b>{' '}
        {t('profile.key.limit.stopped')}
      </Callout>
    );
  } else if (budget.reason_code) {
    const after =
      budget.reason_code === 'ai.daily_limit'
        ? t('profile.key.limit.afterMidnight')
        : budget.reason_code === 'ai.budget_exhausted'
          ? t('profile.key.limit.adminDecides')
          : null;
    why = (
      <Callout kind="warn" icon="alert">
        <b>{t('profile.key.reason', { text: aiErrorText(budget.reason_code, budget.reason_params) })}</b>
        {after && ` ${after}`}
      </Callout>
    );
  }

  return (
    <Card
      id="profile-key-admin"
      className="profile-anchor"
      title={t('profile.key.limit.title')}
      subtitle={t('profile.key.limit.subtitle', { month })}
      actions={chip}
      foot={
        <Button icon="coins" to={paths.costs}>
          {t('profile.key.limit.toCosts')}
        </Button>
      }
    >
      <p className="profile-keyline">
        <Trans
          i18nKey="profile.key.limit.line"
          values={{
            limit: formatLimitUsd(monthly),
            spent: formatUsd(spent),
            left: formatUsd(left),
          }}
          components={{ b: <b /> }}
        />
      </p>
      <Bar spent={spent} max={monthly} alertPct={alert} label={t('profile.key.limit.barLabel', { month })} />
      {why}
      <dl className="profile-kfacts">
        <Fact
          label={t('profile.key.limit.today')}
          value={t('profile.key.limit.todayValue', { today: budget.analyses_today, daily: budget.daily_analyses ?? 0 })}
          sub={t('profile.key.limit.todaySub')}
        />
        <Fact
          label={t('profile.key.limit.cap')}
          value={formatLimitUsd(budget.per_analysis_usd)}
          sub={t('profile.key.limit.capSub')}
        />
        <Fact label={t('profile.key.limit.avg')} value={avgText(budget)} sub={t('profile.key.limit.avgSub', { month })} />
      </dl>
      <div className="stack profile-thr-block">
        <h4>{t('profile.key.limit.thrTitle', { pct: alertText })}</h4>
        <ul className="profile-thr">
          <li>
            <span className="profile-thr-badge warn">{alertText}</span>
            <span>
              <b>{t('profile.key.limit.thrWarnStrong', { amount: formatLimitUsd(Math.round(monthly * alert) / 100) })}</b>{' '}
              {t('profile.key.limit.thrWarn')}
            </span>
          </li>
          <li>
            <span className="profile-thr-badge bad">{formatPercent(1, { digits: 0 })}</span>
            <span>
              <b>{t('profile.key.limit.thrStopStrong', { amount: formatLimitUsd(monthly) })}</b>{' '}
              {t('profile.key.limit.thrStop')}
            </span>
          </li>
        </ul>
      </div>
      <p className="profile-note">
        <Icon name="lock" />
        <span>{t('profile.key.limit.note', { next })}</span>
      </p>
    </Card>
  );
}

/** Администратор на ключе администратора (adminOwnerCard макета): общий бюджет и свой расход. */
export function AdminOwnerCard({ budget }: { budget: AiBudget }) {
  const { t } = useTranslation();
  const key = useAdminKey();
  const { month } = monthOf(budget);
  const total = budget.budget;

  let status: ReactNode = null;
  if (key.data) {
    status =
      key.data.status === 'ok' ? (
        <Chip kind="good" icon="check">
          {t('profile.key.owner.works')}
        </Chip>
      ) : key.data.status === 'missing' ? (
        <Chip kind="bad" icon="alert">
          {t('profile.key.owner.missing')}
        </Chip>
      ) : (
        <Chip kind="warn" icon="alert">
          {t('profile.key.owner.needsCheck')}
        </Chip>
      );
  }

  return (
    <Card
      id="profile-key-admin"
      className="profile-anchor"
      title={t('profile.key.owner.title')}
      subtitle={t('profile.key.owner.subtitle')}
      actions={status ?? undefined}
      foot={
        <Button icon="coins" to={paths.costs}>
          {t('profile.key.owner.toCosts')}
        </Button>
      }
    >
      <div className="profile-secret">
        <Icon name="key" />
        {key.data ? (
          key.data.last4 ? (
            <>
              <code aria-label={t('profile.key.lastSymbols', { symbols: spelled(key.data.last4) })}>
                {keyMask(key.data.last4)}
              </code>
              {key.data.verified_at && (
                <span className="xsmall muted">
                  {t('profile.key.verifiedAt', { when: whenInline(key.data.verified_at) })}
                </span>
              )}
            </>
          ) : (
            <span>{t('profile.key.owner.noKey')}</span>
          )
        ) : (
          <Skeleton width={160} />
        )}
      </div>
      {total && (
        <>
          <p className="profile-keyline">
            <Trans
              i18nKey="profile.key.owner.line"
              values={{
                budget: formatLimitUsd(total.budget_usd),
                spent: formatUsd(total.spent_usd),
                left: formatUsd(total.left_usd),
              }}
              components={{ b: <b /> }}
            />
          </p>
          <Bar
            spent={total.spent_usd}
            max={total.budget_usd}
            alertPct={total.alert_pct}
            label={t('profile.key.owner.barLabel', { month })}
          />
        </>
      )}
      {budget.reason_code && (
        <Callout kind="warn" icon="alert">
          <b>{t('profile.key.reason', { text: aiErrorText(budget.reason_code, budget.reason_params) })}</b>
        </Callout>
      )}
      <dl className="profile-kfacts">
        <Fact
          label={t('profile.key.owner.mine')}
          value={formatUsd(budget.spent_usd)}
          sub={t('profile.key.limit.avgSub', { month })}
        />
        <Fact
          label={t('profile.key.limit.today')}
          value={String(budget.analyses_today)}
          sub={t('profile.key.owner.todaySub')}
        />
        <Fact label={t('profile.key.limit.avg')} value={avgText(budget)} sub={t('profile.key.limit.avgSub', { month })} />
      </dl>
      {total && (
        <p className="xsmall muted profile-plain">
          {t('profile.key.owner.shared', { amount: formatUsd(total.background_usd), month })}
        </p>
      )}
    </Card>
  );
}
