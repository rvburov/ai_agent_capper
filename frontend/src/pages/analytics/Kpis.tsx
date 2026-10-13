import { useTranslation } from 'react-i18next';

import { Stat } from '../../components';
import { brierDiff, brierText, ciPct, ciPct1, noisy, signedPct, trendOf } from '../../features/analytics/display';
import type { Analytics } from '../../features/analytics/types';
import { currencyOf } from '../../features/bets/display';
import { formatMoney, formatNumber, formatPercent, formatPp } from '../../lib/format';
import { cx } from '../../lib/cx';

// Ключевые показатели (kpis макета): прибыль, ROI с ДИ, винрейт, средний CLV с ДИ, Brier модели
// к рынку при прогнозе, выборка. Изменение к прошлому периоду — только если сервер его дал.

interface KpisProps {
  data: Analytics;
  ctx: string;
  prevCtx: string | null;
  pending: boolean;
}

export function Kpis({ data, ctx, prevCtx, pending }: KpisProps) {
  const { t } = useTranslation();
  const { kpi, brier, sample } = data;
  const change = prevCtx ? data.change : null;
  const currency = currencyOf(data.currency);

  const profitChange = change?.profit ?? null;
  const roiChange = kpi.roi !== null ? (change?.roi ?? null) : null;
  const clvChange = kpi.clv !== null ? (change?.clv ?? null) : null;
  // интервала нет (меньше 2 ставок) — вместо «ДИ —» оборот, как у прибыли
  const roiHint = kpi.roi_ci ? t('analytics.kpi.ci', { range: ciPct(kpi.roi_ci) }) : t('analytics.kpi.turnover', { amount: formatMoney(kpi.turnover, currency) });
  const record = [
    t('analytics.kpi.won', { n: kpi.won }),
    t('analytics.kpi.lost', { n: kpi.lost }),
    ...(kpi.void ? [t('analytics.kpi.void', { n: kpi.void })] : []),
  ].join(' · ');
  let clvHint: string;
  if (kpi.clv_n && kpi.clv_ci) clvHint = t('analytics.kpi.clvHint', { range: ciPct1(kpi.clv_ci), x: kpi.clv_positive, n: kpi.clv_n });
  else if (kpi.clv_n) clvHint = t('analytics.kpi.clvBetter', { x: kpi.clv_positive, n: kpi.clv_n });
  else if (kpi.settled > 0 && kpi.legacy_settled === kpi.settled) clvHint = t('analytics.kpi.clvLegacy');
  else clvHint = t('analytics.kpi.clvNone');
  const parlays = sample.bets - sample.singles;

  return (
    <section className={cx('analytics-kpis', pending && 'analytics-pending')} aria-label={t('analytics.kpi.label', { ctx })} aria-busy={pending || undefined}>
      <Stat
        icon="wallet"
        label={t('analytics.kpi.profit')}
        value={formatMoney(kpi.profit, currency, { signed: true })}
        {...(profitChange !== null && prevCtx
          ? { delta: formatMoney(profitChange, currency, { signed: true }), trend: trendOf(Number(profitChange), 2), hint: prevCtx }
          : { hint: t('analytics.kpi.turnover', { amount: formatMoney(kpi.turnover, currency) }) })}
      />
      <Stat
        icon="coins"
        label={t('analytics.kpi.roi')}
        value={kpi.roi === null ? '—' : signedPct(kpi.roi)}
        {...(roiChange !== null && prevCtx
          ? { delta: formatPp(roiChange), trend: trendOf(roiChange), hint: `${roiHint} · ${prevCtx}` }
          : { hint: roiHint })}
      />
      <Stat icon="trophy" label={t('analytics.kpi.winrate')} value={kpi.winrate === null ? '—' : formatPercent(kpi.winrate)} hint={record} />
      <Stat
        icon="bolt"
        label={t('analytics.kpi.clv')}
        value={kpi.clv === null ? '—' : signedPct(kpi.clv)}
        {...(clvChange !== null ? { delta: formatPp(clvChange), trend: trendOf(clvChange) } : {})}
        hint={clvHint}
      />
      <Stat
        icon="target"
        label={t('analytics.kpi.brier')}
        value={brier.model === null ? '—' : brierText(brier.model)}
        {...(brier.model !== null && brier.diff !== null
          ? {
              delta: t('analytics.kpi.brierDelta', { diff: brierDiff(brier.diff) }),
              trend: trendOf(brier.diff),
              good: false,
              hint: `${t('analytics.kpi.brierMarket', { market: formatNumber(brier.market, 3) })}${noisy(brier.diff_ci) ? t('analytics.kpi.noiseTail') : ''}`,
            }
          : { hint: t('analytics.kpi.brierNone') })}
      />
      <Stat
        icon="ticket"
        label={t('analytics.kpi.sample')}
        value={
          <span title={t('analytics.kpi.sampleTitle', { singles: t('analytics.count.singles', { count: sample.singles }), parlays: t('analytics.count.parlays', { count: parlays }) })}>
            {formatNumber(sample.bets)}
            <small> / {formatNumber(sample.events)}</small>
          </span>
        }
        hint={t('analytics.kpi.sampleHint')}
      />
    </section>
  );
}
