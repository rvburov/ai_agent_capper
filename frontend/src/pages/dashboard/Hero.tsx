import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Icon, Stat } from '../../components';
import { Sparkline } from '../../components/charts';
import { brierDiff, brierText, periodStart, signedPct, trendOf } from '../../features/analytics/display';
import type { Bank } from '../../features/bank/types';
import { currencyOf } from '../../features/bets/display';
import type { Dashboard } from '../../features/dashboard/types';
import { formatDate, formatMoney, formatNumber, formatPercent, formatPp } from '../../lib/format';
import { cx } from '../../lib/cx';

// Банк и плитки показателей главной (heroCard и tiles макета).

interface HeroProps {
  data: Dashboard;
  bank: Bank;
  /** «за 30 дней», «с 1 сен». */
  ctx: string;
}

/**
 * Банк (капитал «с учетом ставок в игре») со спарклайном, стартом периода, «в игре» и «от пика».
 * Изменение за период — прибыль периода с сервера (kpi.profit, та же, что у «Динамики банка»):
 * пополнения, выводы и стартовый банк в него не входят (движение банка в прибыль не входит), а
 * процент — от банка на начало периода (periodStart: если банк появился внутри периода или
 * выбрано «все время» — от стартового банка, рост с сервера).
 */
export function HeroCard({ data, bank, ctx }: HeroProps) {
  const { t } = useTranslation();
  if (bank.empty) {
    // Нового участника банка еще нет: ни ставок, ни пополнений
    return (
      <section className="card stat dashboard-hero" aria-label={t('dashboard.hero.label')}>
        <div className="dashboard-hero-top">
          <div className="stat-label">
            <Icon name="wallet" />
            {t('dashboard.hero.title')}
          </div>
          <div className="stat-value hero">—</div>
          <p className="small soft">{t('dashboard.hero.empty')}</p>
        </div>
        <Button kind="ghost" size="sm" iconRight="chevronRight" className="dashboard-more" to={paths.profile('bank')}>
          {t('dashboard.hero.emptyLink')}
        </Button>
      </section>
    );
  }
  const currency = currencyOf(data.currency);
  const start = periodStart(data.series, data.kpi.profit, data.period === 'all', bank);
  const delta = data.kpi.profit;
  const pct = start.share;
  const trend = trendOf(Number(delta), 2);
  const drawdown = Number(bank.drawdown);
  const values = start.points.map((point) => Number(point.value));
  return (
    <section className="card stat dashboard-hero" aria-label={t('dashboard.hero.label')}>
      <div className="dashboard-hero-top">
        <div className="stat-label">
          <Icon name="wallet" />
          {t('dashboard.hero.title')}
          <span className="dashboard-hero-note">{t('dashboard.hero.note')}</span>
        </div>
        <div className="stat-value hero">{formatMoney(bank.equity, currency)}</div>
        <div className="row">
          <span className={cx('delta', trend === 'flat' ? 'flat' : trend === 'up' ? 'up-good' : 'down-bad')}>
            {trend !== 'flat' && <Icon name={trend === 'up' ? 'arrowUp' : 'arrowDown'} />}
            {pct === null
              ? formatMoney(delta, currency, { signed: true })
              : t('dashboard.hero.delta', { money: formatMoney(delta, currency, { signed: true }), pct: formatPercent(pct, { signed: true }) })}
          </span>
          <span className="stat-hint">{ctx}</span>
        </div>
      </div>
      {values.length > 1 && (
        <div className="dashboard-hero-spark" title={t('dashboard.hero.sparkTitle', { ctx })}>
          <Sparkline values={values} width={320} height={52} color="var(--s1)" />
        </div>
      )}
      <dl className="dashboard-hero-kv">
        <div>
          <dt>{t('dashboard.hero.start')}</dt>
          <dd>
            {formatMoney(start.amount, currency)}
            <small>{formatDate(start.day)}</small>
          </dd>
        </div>
        <div>
          <dt>{t('dashboard.hero.inPlay')}</dt>
          <dd>
            {formatMoney(data.open_stake, currency)}
            <small>{t('dashboard.count.bets', { count: data.open_count })}</small>
          </dd>
        </div>
        <div title={t('dashboard.hero.peakTitle', { peak: formatMoney(bank.peak, currency) })}>
          <dt>{t('dashboard.hero.fromPeak')}</dt>
          <dd>
            {drawdown > 0 ? formatPercent(-drawdown, { signed: true }) : formatPercent(0)}
            <small>{t('dashboard.hero.peak', { peak: formatMoney(bank.peak, currency) })}</small>
          </dd>
        </div>
      </dl>
    </section>
  );
}

interface TilesProps {
  data: Dashboard;
  /** «к пред. 30 дням»; у «всего времени» — null. */
  prevCtx: string | null;
}

/** ROI, винрейт, средний CLV и Brier модели к рынку (tiles макета) и пояснение под ними. */
export function Tiles({ data, prevCtx }: TilesProps) {
  const { t } = useTranslation();
  const { kpi, brier, change } = data;
  const currency = currencyOf(data.currency);
  const roiChange = change?.roi ?? null;
  const roiDelta = kpi.roi !== null && roiChange !== null && prevCtx !== null;
  const record = [
    t('dashboard.tiles.won', { n: kpi.won }),
    t('dashboard.tiles.lost', { n: kpi.lost }),
    ...(kpi.void ? [t('dashboard.tiles.void', { n: kpi.void })] : []),
  ].join(' · ');
  return (
    <>
      <div className="col-6 half-mobile">
        <Stat
          icon="coins"
          label={t('dashboard.tiles.roi')}
          value={kpi.roi === null ? '—' : signedPct(kpi.roi)}
          {...(roiDelta ? { delta: formatPp(roiChange), trend: trendOf(roiChange) } : {})}
          hint={roiDelta ? prevCtx : t('dashboard.tiles.turnover', { amount: formatMoney(kpi.turnover, currency) })}
        />
      </div>
      <div className="col-6 half-mobile">
        <Stat icon="trophy" label={t('dashboard.tiles.winrate')} value={kpi.winrate === null ? '—' : formatPercent(kpi.winrate)} hint={record} />
      </div>
      <div className="col-6 half-mobile">
        <Stat
          icon="bolt"
          label={t('dashboard.tiles.clv')}
          value={kpi.clv === null ? '—' : signedPct(kpi.clv)}
          hint={kpi.clv_n ? t('dashboard.tiles.clvBetter', { x: kpi.clv_positive, n: kpi.clv_n }) : t('dashboard.tiles.clvNone')}
        />
      </div>
      <div className="col-6 half-mobile">
        <Stat
          icon="target"
          label={t('dashboard.tiles.brier')}
          value={brier.model === null ? '—' : brierText(brier.model)}
          {...(brier.model !== null && brier.diff !== null
            ? { delta: t('dashboard.tiles.brierDelta', { diff: brierDiff(brier.diff) }), trend: trendOf(brier.diff), good: false }
            : {})}
          hint={
            brier.model !== null && brier.market !== null
              ? t('dashboard.tiles.brierHint', { market: formatNumber(brier.market, 3) })
              : t('dashboard.tiles.brierNone')
          }
        />
      </div>
      <div className="col-12">
        <div className="dashboard-howto">
          <Icon name="info" />
          <span>{t('dashboard.tiles.howto')}</span>
        </div>
      </div>
    </>
  );
}
