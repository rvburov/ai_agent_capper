import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Callout, Chip, Disclosure, Icon, OddsBox } from '../../components';
import { keyText } from '../../features/analysis/codes';
import { formatProb, formatShare } from '../../features/analysis/markets';
import { payout, totalOdds, type MoneyRules } from '../../features/analysis/stake';
import type { Analysis, Bank, Express, StakeStep } from '../../features/analysis/types';
import { cx } from '../../lib/cx';
import { formatMoney, formatNumber, formatOdds, formatPercent, type Currency } from '../../lib/format';
import type { LegView } from './BetModals';

// Карточка «Экспресс» итога (expressCard в mockup/js/screens/analysis.js): ноги, итоговый
// кэф, вероятность и перевес, сумма по стратегии с расчетом, решение участника.

type T = TFunction;

/**
 * «Проигрывает примерно N раз из M»: доля проигрышей экспресса десятыми, а реже 1 из 10 —
 * как 1 из 20, 1 из 100 (иначе при p = 0,99 вышло бы те же «1 из 10»).
 */
export function loseRate(p: number): { count: number; of: number } {
  const q = Math.min(1, Math.max(0, 1 - p));
  if (q >= 0.095) return { count: Math.min(9, Math.max(1, Math.round(q * 10))), of: 10 };
  return { count: 1, of: Math.min(100, Math.round(1 / Math.max(q, 0.01))) };
}

export interface ExpressState {
  /** Сумма, измененная вручную (null — рекомендованная). */
  stake: number | null;
  /** Кэфы при ставке по ногам (строки полей). */
  taken: string[];
}

function money(value: string | number, currency: Currency) {
  return formatMoney(value, currency);
}

/** Строки «Как посчитана сумма» по шагам расчета сервера (StakeOut.steps). */
function calcRows(express: Express, currency: Currency, t: T): Array<[string, string]> {
  const stake = express.stake;
  const rows: Array<[string, string]> = [
    [stake.bank_source === 'input' ? t('analysis.calc.bankInput') : t('analysis.calc.bankLedger'), money(stake.bank, currency)],
  ];
  const pct = (value: string | undefined) => formatShare(value ?? null);
  for (const step of stake.steps as StakeStep[]) {
    const p = step.params;
    switch (step.kind) {
      case 'band':
        rows.push([t('analysis.calc.band', { total: formatOdds(express.total_odds), low: formatOdds(p.low), high: formatOdds(p.high) }), pct(step.pct)]);
        break;
      case 'value': {
        const add = Number(p.add);
        const pp = formatNumber(Math.abs(add) * 100, 2).replace(/[.,]?0+$/, '');
        rows.push([
          t('analysis.calc.value', { avg: formatPercent(Number(p.avg_value), { digits: 1, signed: true }) }),
          add === 0 ? t('analysis.calc.noAdjust') : t('analysis.calc.adjust', { sign: add > 0 ? '+' : '\u2212', pp, pct: pct(step.pct) }),
        ]);
        break;
      }
      case 'week_win':
        rows.push([t('analysis.calc.weekWin', { change: formatPercent(Number(p.change), { signed: true }) }), pct(step.pct)]);
        break;
      case 'limit':
        rows.push([t('analysis.calc.limit'), pct(p.max_pct)]);
        break;
      case 'growth':
        rows.push([t('analysis.calc.growth', { growth: formatPercent(Number(p.growth), { signed: true }), winrate: formatPercent(Number(p.winrate), { digits: 0 }) }), pct(p.max_pct)]);
        break;
      case 'drawdown':
        rows.push([t('analysis.calc.drawdown', { drawdown: formatPercent(-Number(p.drawdown), { digits: 1 }) }), pct(p.max_pct)]);
        break;
      case 'week_loss':
        rows.push([t('analysis.calc.weekLoss', { change: formatPercent(Number(p.change), { signed: true }) }), pct(p.max_pct)]);
        break;
      case 'cap':
        rows.push([t('analysis.calc.cap'), `${pct(p.before)} → ${pct(p.max_pct)}`]);
        break;
      case 'round':
        rows.push([
          t('analysis.calc.round', { bank: money(p.bank ?? 0, currency), pct: pct(step.pct), raw: money(p.raw ?? 0, currency), step: money(p.step ?? 0, currency) }),
          money(p.amount ?? 0, currency),
        ]);
        break;
      case 'below_min':
        rows.push([t('analysis.calc.belowMin', { min: money(p.min ?? 0, currency) }), t('analysis.calc.noStake')]);
        break;
      default:
        rows.push([step.kind, pct(step.pct)]);
    }
  }
  return rows;
}

/** Адаптации суммы из «Банк и стратегия» (Р22): что сейчас с банком и что действует. */
function Adaptations({ bank, t }: { bank: Bank | undefined; t: T }) {
  if (!bank || bank.empty) return <Callout kind="accent" icon="history">{t('analysis.adapt.empty')}</Callout>;
  const now = [
    t('analysis.adapt.drawdown', { value: formatPercent(-Number(bank.drawdown), { signed: true }) }),
    bank.growth !== null && bank.winrate !== null
      ? t('analysis.adapt.growth', { value: formatPercent(Number(bank.growth), { signed: true }), winrate: formatPercent(Number(bank.winrate), { digits: 0 }) })
      : null,
    bank.week_change !== null ? t('analysis.adapt.week', { value: formatPercent(Number(bank.week_change), { signed: true }) }) : null,
  ].filter(Boolean);
  const active = bank.adaptations.filter((a) => a.enabled && a.active).map((a) => t(`analysis.adapt.active.${a.key}`));
  return (
    <Callout kind="accent" icon="history">
      <b>{t('analysis.adapt.title')}</b> {now.join(', ')} — {active.length ? `${active.join('; ')}. ` : t('analysis.adapt.none')}
      {t('analysis.adapt.rules')}
    </Callout>
  );
}

interface ExpressCardProps {
  analysis: Analysis;
  express: Express;
  legs: readonly LegView[];
  legMeta: readonly { match: string; desc: string }[];
  currency: Currency;
  rules: MoneyRules;
  state: ExpressState;
  bank: Bank | undefined;
  strategyCode: string;
  calcOpen: boolean;
  onCalcToggle: (open: boolean) => void;
  onSave: () => void;
  onEditStake: () => void;
  onResetStake: () => void;
  onSkip: () => void;
  onUnskip: () => void;
  deciding: boolean;
}

export function ExpressCard(props: ExpressCardProps) {
  const { t } = useTranslation();
  const { analysis, express, legs, currency, rules, state } = props;
  // Ставка сохранена — показываем ее сумму и кэфы (с сервера), а не рекомендацию анализа
  const saved = analysis.bet;
  const recommended = express.stake.amount === null ? null : Number(express.stake.amount);
  const amount = saved ? Number(saved.stake) : (state.stake ?? recommended);
  const custom = saved ? amount !== recommended : state.stake !== null && state.stake !== recommended;
  const taken = saved
    ? legs.map((leg) => Number(saved.legs.find((l) => l.prediction_id === leg.predictionId)?.odds_taken ?? leg.odds))
    : state.taken.map(Number);
  const changed = taken.some((x, i) => Math.abs(x - (legs[i]?.odds ?? x)) > 0.0005);
  const total = saved ? Number(saved.total_odds) : totalOdds(taken);
  const ev = express.p_express * total - 1;
  const decision = analysis.bet_id !== null ? 'bet' : analysis.decision;
  const failedRules = express.rules.filter((r) => !r.ok);
  const bank = Number(express.stake.bank);
  const lose = loseRate(express.p_express);

  let foot;
  if (decision === 'bet') {
    foot = (
      <div className="stack analysis-foot">
        <Callout kind="good">
          {saved
            ? t('analysis.express.saved', {
                id: saved.id,
                amount: formatMoney(saved.stake, saved.currency as Currency),
                total: formatOdds(saved.total_odds),
              })
            : t('analysis.express.savedShort', { id: analysis.bet_id ?? '' })}
        </Callout>
        <div className="analysis-actions">
          <Button kind="primary" icon="ticket" to={paths.bets}>
            {t('analysis.express.openBets')}
          </Button>
        </div>
      </div>
    );
  } else if (decision === 'skip') {
    foot = (
      <div className="stack analysis-foot">
        <Callout>{t('analysis.express.skipped')}</Callout>
        <div className="analysis-actions">
          <Button kind="primary" icon="ticket" loading={props.deciding} onClick={props.onUnskip}>
            {t('analysis.express.unskip')}
          </Button>
        </div>
      </div>
    );
  } else {
    foot = (
      <div className="analysis-actions">
        <Button kind="primary" icon="check" onClick={props.onSave}>
          {t('analysis.express.save')}
        </Button>
        <Button icon="edit" onClick={props.onEditStake}>
          {t('analysis.express.editStake')}
        </Button>
        <Button kind="ghost" icon="x" loading={props.deciding} onClick={props.onSkip}>
          {t('analysis.express.skip')}
        </Button>
      </div>
    );
  }

  const status =
    decision === 'bet' ? (
      <Chip kind="good" icon="check">
        {t('analysis.express.chipSaved')}
      </Chip>
    ) : decision === 'skip' ? (
      <Chip kind="outline" icon="x">
        {t('analysis.express.chipSkipped')}
      </Chip>
    ) : (
      <Chip kind="info" icon="clock">
        {t('analysis.express.chipWaiting')}
      </Chip>
    );

  return (
    <section className="card analysis-exp" aria-labelledby="analysis-exp-title">
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('analysis.express.eyebrow')}</div>
          <h3 id="analysis-exp-title">{t('analysis.express.title')}</h3>
          <div className="card-sub">{t('analysis.express.sub', { count: legs.length, code: props.strategyCode })}</div>
        </div>
        {status}
      </div>
      <div className="card-body">
        <div className="analysis-legs">
          {legs.map((leg, i) => (
            <div key={leg.predictionId} className="analysis-leg">
              <div className="analysis-leg-text">
                <div className="analysis-leg-meta">{props.legMeta[i]?.match}</div>
                <div className="analysis-leg-pick">{leg.name}</div>
                <div className="analysis-leg-meta">{props.legMeta[i]?.desc}</div>
              </div>
              <div className="analysis-leg-right">
                <div className="analysis-leg-p" aria-label={t('analysis.express.chanceAria', { p: formatProb(express.legs[i]?.p) })}>
                  <span aria-hidden="true">{t('analysis.express.chance')}</span>
                  <b aria-hidden="true">{formatProb(express.legs[i]?.p)}</b>
                </div>
                <OddsBox
                  label={Math.abs((taken[i] ?? 0) - leg.odds) > 0.0005 ? t('analysis.express.atBet') : t('analysis.express.odds')}
                  value={taken[i] ?? leg.odds}
                  picked
                />
              </div>
            </div>
          ))}
        </div>
        <div className="analysis-totals">
          <div className="analysis-total">
            <span>{changed ? t('analysis.express.totalTaken') : t('analysis.express.total')}</span>
            <b className="mono">{formatOdds(total)}</b>
            <small>{taken.map((x) => formatOdds(x)).join(' × ')}</small>
          </div>
          <div className="analysis-total">
            <span>{t('analysis.express.probability')}</span>
            <b>≈ {formatProb(express.p_express)}</b>
            <small>{express.legs.map((l) => formatNumber(l.p, 2)).join(' × ')}</small>
          </div>
          <div className="analysis-total">
            <span title={t('analysis.express.edgeTitle')}>{t('analysis.express.edge')}</span>
            <b className={cx(Math.abs(ev) >= 1 && 'long')}>{formatPercent(ev, { signed: true })}</b>
            <small>{amount !== null ? `≈ ${formatMoney(amount * ev, currency, { signed: true })}` : ''}</small>
          </div>
        </div>
        {failedRules.length > 0 && (
          <Callout kind="warn">
            <b>{t('analysis.express.rulesWarn', { code: props.strategyCode })}</b>{' '}
            {failedRules.map((r) => keyText(r.key, r.params, r.key).toLowerCase()).join('; ')}.
          </Callout>
        )}
        <hr className="divider" />
        <div className="analysis-stake">
          <div className="analysis-stake-text">
            <div className="eyebrow">{custom ? t('analysis.express.stakeCustom') : t('analysis.express.stakeRec')}</div>
            <div className="analysis-stake-value">{amount !== null ? formatMoney(amount, currency) : '—'}</div>
            <div className="small muted">
              {amount !== null
                ? t('analysis.express.stakeLine', {
                    share: custom ? formatShare(amount / (bank || 1)) : formatShare(express.stake.pct),
                    payout: formatMoney(payout(amount, total, rules), currency),
                    profit: formatMoney(payout(amount, total, rules) - amount, currency, { signed: true }),
                  })
                : t('analysis.express.noStake', { reason: keyText(express.stake.reason ? `analysis.stake.${express.stake.reason}` : null, {}, t('analysis.express.noStakeDefault')) })}
            </div>
          </div>
          {custom && recommended !== null && decision !== 'bet' && (
            <Button kind="ghost" size="sm" icon="refresh" onClick={props.onResetStake}>
              {t('analysis.express.reset', { amount: formatMoney(recommended, currency) })}
            </Button>
          )}
        </div>
        <Disclosure icon="info" summary={t('analysis.express.calc')} open={props.calcOpen} onToggle={props.onCalcToggle} bodyClassName="stack analysis-calc-box">
          <dl className="analysis-calc">
            {calcRows(express, currency, t).map(([label, value], i, all) => (
              <div key={`${i}-${label}`} className={i === all.length - 1 ? 'is-sum' : undefined}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <Adaptations bank={props.bank} t={t} />
        </Disclosure>
        <p className="analysis-disclaimer">
          <Icon name="info" />
          {t('analysis.express.disclaimer', { p: formatProb(express.p_express), count: lose.count, of: lose.of })}
        </p>
      </div>
      <div className="card-foot">{foot}</div>
    </section>
  );
}

/** Экспресса нет: почему и что дальше. */
export function NoExpressCard({ reasonKey }: { reasonKey: string | null }) {
  const { t } = useTranslation();
  return (
    <section className="card analysis-exp" aria-labelledby="analysis-exp-title">
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('analysis.express.eyebrow')}</div>
          <h3 id="analysis-exp-title">{t('analysis.express.noneTitle')}</h3>
        </div>
        <Chip kind="outline" icon="x">
          {t('analysis.express.chipNone')}
        </Chip>
      </div>
      <div className="card-body">
        <Callout kind="info">{keyText(reasonKey, {}, t('analysis.express.noneDefault'))}</Callout>
        <p className="small soft">{t('analysis.express.noneText')}</p>
      </div>
    </section>
  );
}
