import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, Icon, KeyValue, Meter, Skeleton, spendTone } from '../../components';
import { spendMonth } from '../../features/admin/display';
import type { AiBudget } from '../../features/ai/types';
import { topKind, usdLimit } from '../../features/dashboard/display';
import type { AiUsage } from '../../features/dashboard/types';
import { formatNumber, formatPercent, formatShare, formatUsd } from '../../lib/format';

// «Расходы ИИ» (costsCard макета) в трех видах: администратор — бюджет ключа администратора,
// участник на своем ключе — расход с его счета, участник на ключе администратора — свой лимит.
// Лимит и расход — из GET /api/ai/budget (тот же ключ кэша, что у «Ключа Claude»); прогноз,
// доля кэша, самая дорогая задача и расход до перехода на свой ключ — из GET /api/ai/usage.

function Howto({ children }: { children: ReactNode }) {
  return (
    <div className="dashboard-howto">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}

interface ValueRowProps {
  spent: number;
  max: number;
  /** Доля spent от max — с сервера (budget_share, limit_share); null — неизвестна. */
  share: number | null | undefined;
  /** Порог уведомления о расходе, % (настройки администратора): с него — желтый, с 100% — красный. */
  alertPct: number;
  tail?: string;
  what: string;
}

/**
 * Крупная сумма «из лимита», метка доли и полоса (valueRow макета). Цвет — по порогу из настроек
 * администратора, как у шкалы лимита в «Ключе Claude» и «Администрировании» (spendTone).
 */
function ValueRow({ spent, max, share, alertPct, tail, what }: ValueRowProps) {
  const { t } = useTranslation();
  const tone = spendTone(spent, max, alertPct);
  return (
    <>
      <div className="row-between dashboard-cost-row">
        <div className="dashboard-min">
          <span className="dashboard-cost-value">{formatUsd(spent)}</span>
          <span className="muted">
            {' '}
            {t('dashboard.costs.of', { max: usdLimit(max) })}
            {tail}
          </span>
        </div>
        <Chip kind={tone ?? 'good'} icon={tone ? 'alert' : 'check'}>
          {t('dashboard.costs.share', { pct: share === null || share === undefined ? '—' : formatShare(share), what })}
        </Chip>
      </div>
      <Meter
        value={spent}
        max={max}
        kind={tone ?? undefined}
        label={t('dashboard.costs.meterLabel')}
        valueText={t('dashboard.costs.meterValue', { spent: formatUsd(spent), max: usdLimit(max) })}
      />
    </>
  );
}

/** «Из кэша»: доля входных токенов, прочитанных из кэша (формула — PLAN, раздел 8). */
function cacheText(usage: AiUsage | undefined, t: TFunction): string {
  const share = usage?.totals.cache_share;
  return share === null || share === undefined ? '—' : t('dashboard.costs.cacheValue', { pct: formatPercent(share, { digits: 0 }) });
}

/** «Прогноз на месяц»: ≈ по темпу расхода (у участника на ключе администратора — не выше лимита). */
function forecastText(usage: AiUsage | undefined, t: TFunction): string {
  return usage ? t('dashboard.costs.approx', { amount: formatUsd(usage.forecast_usd) }) : '—';
}

/** «Дороже всего»: задача и ее доля в расходе месяца. */
function topText(usage: AiUsage | undefined, t: TFunction): string {
  const top = usage ? topKind(usage) : null;
  if (!top) return '—';
  return t('dashboard.costs.topValue', {
    kind: t(`dashboard.costs.kinds.${top.kind}`, { defaultValue: top.kind }),
    pct: formatPercent(top.share, { digits: 0 }),
  });
}

/** Месяц в предложном падеже для заголовка: «в октябре» (месяц расхода — по UTC). */
function monthIn(budget: AiBudget, t: TFunction): string {
  const months: readonly string[] = t('dashboard.costs.monthsIn', { returnObjects: true });
  return months[new Date(budget.month_start).getUTCMonth()] ?? '';
}

interface CostsProps {
  budget: AiBudget | undefined;
  /** Свой расход за месяц (у администратора не запрашивается). */
  usage: AiUsage | undefined;
  /** Вид администратора: бюджет ключа администратора вместо своего лимита. */
  admin: boolean;
  failed: boolean;
}

export function Costs({ budget, usage, admin, failed }: CostsProps) {
  const { t } = useTranslation();
  const more = (
    <Button kind="ghost" size="sm" iconRight="chevronRight" to={paths.costs}>
      {t('dashboard.costs.more')}
    </Button>
  );
  if (!budget) {
    return (
      <Card className="dashboard-card" title={t('dashboard.costs.titlePlain')} actions={more}>
        {failed ? <p className="small muted">{t('dashboard.costs.failed')}</p> : <Skeleton lines={3} />}
      </Card>
    );
  }
  const title = t('dashboard.costs.title', { month: monthIn(budget, t) });

  if (admin && budget.budget) {
    // Бюджет ключа администратора: «Вы» + «Участники на вашем ключе» + «Общие фоновые задачи» =
    // все вызовы на ключе за месяц (без проверок); участники — members_usd с сервера
    const total = budget.budget;
    const members = total.members_usd ?? null;
    return (
      <Card
        className="dashboard-card"
        title={title}
        subtitle={t('dashboard.costs.adminSubtitle')}
        actions={more}
        foot={
          <Button kind="ghost" size="sm" icon="admin" iconRight="chevronRight" to={paths.admin('usage')} title={t('dashboard.costs.adminLinkTitle')}>
            {t('dashboard.costs.adminLink')}
          </Button>
        }
      >
        <ValueRow spent={total.spent_usd} max={total.budget_usd} share={total.budget_share} alertPct={total.alert_pct} what={t('dashboard.costs.ofBudget')} />
        <KeyValue
          items={[
            { key: 'me', label: t('dashboard.costs.you'), value: formatUsd(budget.spent_usd) },
            { key: 'members', label: t('dashboard.costs.members'), value: members === null ? '—' : formatUsd(members) },
            { key: 'background', label: t('dashboard.costs.background'), value: formatUsd(total.background_usd) },
            { key: 'forecast', label: t('dashboard.costs.forecast'), value: t('dashboard.costs.approx', { amount: formatUsd(total.forecast_usd) }) },
            {
              key: 'eval',
              label: t('dashboard.costs.eval'),
              value: t('dashboard.costs.evalValue', { spent: formatUsd(total.eval_spent_usd), max: usdLimit(total.eval_budget_usd) }),
            },
          ]}
        />
        <Howto>{t('dashboard.costs.adminHowto')}</Howto>
      </Card>
    );
  }

  if (budget.mode === 'own') {
    // До перехода на свой ключ в этом месяце анализы шли на ключе администратора (макет: «До перехода»)
    const before = usage && usage.admin_key_usd > 0 ? usage.admin_key_usd : null;
    return (
      <Card
        className="dashboard-card"
        title={title}
        subtitle={t('dashboard.costs.ownSubtitle')}
        actions={more}
        foot={
          <Button kind="ghost" size="sm" icon="key" iconRight="chevronRight" to={paths.profile('key')}>
            {t('dashboard.costs.ownLink')}
          </Button>
        }
      >
        <div>
          <span className="dashboard-cost-value">{formatUsd(budget.spent_usd)}</span>
          <span className="muted"> {t('dashboard.costs.ownSpent', { month: spendMonth(new Date(budget.month_start)) })}</span>
        </div>
        <KeyValue
          items={[
            before !== null
              ? { key: 'before', label: t('dashboard.costs.before'), value: formatUsd(before) }
              : { key: 'forecast', label: t('dashboard.costs.forecast'), value: forecastText(usage, t) },
            { key: 'cap', label: t('dashboard.costs.cap'), value: t('dashboard.costs.capValue', { amount: usdLimit(budget.own_cap_usd) }) },
            { key: 'cache', label: t('dashboard.costs.cache'), value: cacheText(usage, t) },
          ]}
        />
        <Howto>{before !== null ? t('dashboard.costs.ownHowtoBefore', { amount: formatUsd(before) }) : t('dashboard.costs.ownHowto')}</Howto>
      </Card>
    );
  }

  const monthly = budget.monthly_usd;
  const left = budget.left_usd;
  return (
    <Card className="dashboard-card" title={title} subtitle={t('dashboard.costs.memberSubtitle')} actions={more}>
      {monthly !== null ? (
        <ValueRow
          spent={budget.spent_usd}
          max={monthly}
          share={budget.limit_share}
          alertPct={budget.alert_pct}
          tail={left === null ? undefined : t('dashboard.costs.left', { amount: formatUsd(left) })}
          what={t('dashboard.costs.ofLimit')}
        />
      ) : (
        <div>
          <span className="dashboard-cost-value">{formatUsd(budget.spent_usd)}</span>
        </div>
      )}
      {budget.paused && (
        <Callout kind="warn" icon="pause">
          <b>{t('dashboard.costs.pausedStrong')}</b>
          {t('dashboard.costs.paused')}
        </Callout>
      )}
      <KeyValue
        items={[
          {
            key: 'today',
            label: t('dashboard.costs.today'),
            value:
              budget.daily_analyses === null
                ? formatNumber(budget.analyses_today)
                : t('dashboard.costs.todayValue', { n: budget.analyses_today, max: budget.daily_analyses }),
          },
          { key: 'forecast', label: t('dashboard.costs.forecast'), value: forecastText(usage, t) },
          { key: 'cache', label: t('dashboard.costs.cache'), value: cacheText(usage, t) },
          { key: 'top', label: t('dashboard.costs.top'), value: topText(usage, t) },
        ]}
      />
      <Howto>{t('dashboard.costs.memberHowto')}</Howto>
    </Card>
  );
}
