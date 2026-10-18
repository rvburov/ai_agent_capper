import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Callout, Chip, Disclosure, Icon, OddsBox, ReadOnlyNote, useReadOnly } from '../../components';
import { keyText } from '../../features/analysis/codes';
import { formatProb, formatShare } from '../../features/analysis/markets';
import { slipNumbers, type SlipItem } from '../../features/analysis/ownBet';
import { payout, totalOdds, type MoneyRules } from '../../features/analysis/stake';
import type { AnalysisBet, Bank, MarketRow, MatchResult, Result, Variant } from '../../features/analysis/types';
import { useMarketStatuses } from '../../features/markets/api';
import { variantNoValue, variantTitle, variantWhy } from '../../features/analysis/variants';
import { cx } from '../../lib/cx';
import { formatMoney, formatOdds, formatPercent, type Currency } from '../../lib/format';
import type { LegView } from './BetModals';
import { Adaptations, calcRows } from './ExpressCard';
import { matchTitle, outcomeName, type MatchNames } from './MatchCard';

// «Варианты ставки» итога (variantsBlock, variantCard, slipCard в mockup/js/screens/analysis.js,
// Р29): экспресс стратегии — основной, ординары «надежнее» и «лучший валуй», экспресс из лучших,
// если экспресса нет. Варианты и суммы считает сервер; здесь — показ и выбор.

export interface VariantState {
  /** Сумма, измененная вручную (null — рекомендованная). */
  stake: number | null;
  /** Кэфы при ставке по событиям (строки полей). */
  taken: string[];
}

interface VariantCardProps {
  variant: Variant;
  /** Номер варианта на экране: 1 — экспресс стратегии, если он есть. */
  n: number;
  legs: readonly LegView[];
  legMeta: readonly { match: string; desc: string }[];
  currency: Currency;
  rules: MoneyRules;
  state: VariantState;
  saved: AnalysisBet | null;
  bank: Bank | undefined;
  /** Главная кнопка «Сохранить ставку» (первый вариант, когда экспресса стратегии нет). */
  primary: boolean;
  onSave: () => void;
  onEditStake: () => void;
}

export function VariantCard(props: VariantCardProps) {
  const { t } = useTranslation();
  const readOnly = useReadOnly();
  const { variant, legs, currency, rules, state, saved } = props;
  const recommended = variant.stake === null ? null : Number(variant.stake);
  const amount = saved ? Number(saved.stake) : (state.stake ?? recommended);
  const custom = saved ? amount !== recommended : state.stake !== null && state.stake !== recommended;
  const taken = saved
    ? legs.map((leg) => Number(saved.legs.find((l) => l.prediction_id === leg.predictionId)?.odds_taken ?? leg.odds))
    : state.taken.map(Number);
  const total = saved ? Number(saved.total_odds) : totalOdds(taken);
  const ev = variant.p * total - 1;
  const noValue = variantNoValue(variant);
  const bank = Number(variant.stake_calc.bank);
  const single = variant.code === 'safer' || variant.code === 'value';
  const id = `analysis-var-${variant.code}`;
  const why = variantWhy(variant, t(`analysis.variants.title.${variantTitle(variant)}`));
  const warnings = variant.warnings.filter((w) => w !== 'no_value');

  let foot: ReactNode;
  if (saved) {
    foot = (
      <div className="stack analysis-foot">
        <Callout kind="good">
          {t('analysis.variants.saved', {
            id: saved.id,
            amount: formatMoney(saved.stake, saved.currency as Currency),
            total: formatOdds(saved.total_odds),
          })}
        </Callout>
        <div className="analysis-actions">
          <Button icon="ticket" to={`${paths.bets}?new=${saved.id}`}>
            {t('analysis.express.openBets')}
          </Button>
        </div>
      </div>
    );
  } else {
    const actions = (
      <div className="analysis-actions">
        <Button kind={props.primary && !noValue ? 'primary' : 'secondary'} icon="check" onClick={props.onSave} ro>
          {t('analysis.express.save')}
        </Button>
        <Button kind="ghost" icon="edit" onClick={props.onEditStake} ro>
          {t('analysis.express.editStake')}
        </Button>
      </div>
    );
    foot = readOnly ? (
      <div className="stack analysis-foot">
        {actions}
        <ReadOnlyNote>{t('analysis.variants.roNote')}</ReadOnlyNote>
      </div>
    ) : (
      actions
    );
  }

  const chip = saved ? (
    <Chip kind="good" icon="check">
      {t('analysis.variants.chipSaved')}
    </Chip>
  ) : single ? (
    <Chip kind="info" icon="target">
      {t('bets.kindChip.single')}
    </Chip>
  ) : (
    <Chip kind="warn" icon="alert">
      {t('analysis.variants.chipOutside')}
    </Chip>
  );

  return (
    <section className={cx('card', 'analysis-var', noValue && 'is-novalue')} aria-labelledby={id}>
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('analysis.variants.eyebrow', { n: props.n })}</div>
          <h3 id={id}>{t(`analysis.variants.title.${variantTitle(variant)}`)}</h3>
        </div>
        {chip}
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
                <div className="analysis-leg-p">
                  <span aria-hidden="true">{t('analysis.express.chance')}</span>
                  <b aria-hidden="true">{formatProb(variant.legs[i]?.p)}</b>
                  <span className="sr-only">{t('analysis.express.chanceAria', { p: formatProb(variant.legs[i]?.p) })}</span>
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
            <span>{t('analysis.express.total')}</span>
            <b className="mono">{formatOdds(total)}</b>
            <small>{legs.length > 1 ? taken.map((x) => formatOdds(x)).join(' × ') : t('analysis.variants.singleSmall')}</small>
          </div>
          <div className="analysis-total">
            <span>{t('analysis.express.probability')}</span>
            <b>≈ {formatProb(variant.p)}</b>
            <small>{t('analysis.variants.model')}</small>
          </div>
          <div className="analysis-total">
            <span>{t('analysis.variants.value')}</span>
            <b className={cx(ev < 0 && 'bad-text')}>{formatPercent(ev, { digits: 1, signed: true })}</b>
            <small>{t('analysis.variants.valueSub')}</small>
          </div>
        </div>
        <p className="analysis-why-line">
          <Icon name="info" />
          <span>
            <b>{t('analysis.variants.whyLabel')}</b> {why}
          </span>
        </p>
        {noValue && (
          <Callout kind="bad" icon="alert">
            <b>{t('analysis.variants.noValueTitle')}</b> {t('analysis.variants.noValueText')}
          </Callout>
        )}
        {variant.issues.length > 0 && (
          <Callout kind="warn" icon="alert">
            <b>{t('analysis.variants.issuesTitle')}</b>{' '}
            {variant.issues.map((key) => keyText(key, {}, key).toLowerCase()).join('; ')}.
          </Callout>
        )}
        {warnings.map((w) => (
          <Callout key={w} kind="warn" icon="alert">
            {keyText(`analysis.variants.warnings.${w}`, {}, w)}
          </Callout>
        ))}
        <hr className="divider" />
        <div className="analysis-stake">
          <div className="analysis-stake-text">
            <div className="eyebrow">{custom ? t('analysis.express.stakeCustom') : t('analysis.express.stakeRec')}</div>
            <div className="analysis-stake-value">{amount !== null ? formatMoney(amount, currency) : '—'}</div>
            <div className="small muted">
              {amount !== null
                ? t('analysis.express.stakeLine', {
                    share: custom || recommended === null ? formatShare(amount / (bank || 1)) : formatShare(variant.stake_calc.pct),
                    payout: formatMoney(payout(amount, total, rules), currency),
                    profit: formatMoney(payout(amount, total, rules) - amount, currency, { signed: true }),
                  })
                : noValue
                  ? t('analysis.variants.noStakeValue')
                  : t('analysis.express.noStake', {
                      reason: keyText(
                        variant.stake_calc.reason ? `analysis.stake.${variant.stake_calc.reason}` : null,
                        {},
                        t('analysis.variants.noStakeDefault'),
                      ),
                    })}
            </div>
          </div>
        </div>
        <Disclosure icon="info" summary={t('analysis.express.calc')} bodyClassName="stack analysis-calc-box">
          <dl className="analysis-calc">
            {calcRows(variant.stake_calc, variant.total_odds, currency, t).map(([label, value], i, all) => (
              <div key={`${i}-${label}`} className={i === all.length - 1 ? 'is-sum' : undefined}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="xsmall muted analysis-calc-note">{single ? t('analysis.variants.calcSingle') : t('analysis.variants.calcBest')}</p>
          <Adaptations bank={props.bank} t={t} />
        </Disclosure>
      </div>
      <div className="card-foot">{foot}</div>
    </section>
  );
}

/** «Своя ставка» собирается: события, вид и кэф, «Открыть» и «Очистить». */
export function SlipCard({ slip, onOpen, onClear }: { slip: readonly SlipItem[]; onOpen: () => void; onClear: () => void }) {
  const { t } = useTranslation();
  const nums = slipNumbers(slip);
  return (
    <section className="card analysis-slip" aria-labelledby="analysis-slip-title">
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('analysis.own.collecting')}</div>
          <h3 id="analysis-slip-title">{t('analysis.own.title')}</h3>
        </div>
        <Chip kind="warn" icon="user">
          {t('bets.kindChip.own')}
        </Chip>
      </div>
      <div className="card-body">
        <ul className="analysis-slip-list">
          {slip.map((item) => (
            <li key={item.predictionId}>
              <span>
                <b>{item.name}</b>
                <small>{item.match}</small>
              </span>
              <span className="odds">{formatOdds(item.odds)}</span>
            </li>
          ))}
        </ul>
        <div className="small muted">
          {t('analysis.own.summary', {
            kind: slip.length > 1 ? t('bets.kind.parlay', { n: slip.length }) : t('bets.kind.single'),
            total: formatOdds(nums.total),
            value: formatPercent(nums.ev, { digits: 1, signed: true }),
          })}
        </div>
      </div>
      <div className="card-foot">
        <div className="analysis-actions">
          <Button icon="edit" onClick={onOpen}>
            {t('analysis.own.open')}
          </Button>
          <Button kind="ghost" icon="x" onClick={onClear}>
            {t('analysis.own.clear')}
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * Лучший валуй среди рынков «для сравнения» (Р28) и почему он не в вариантах: модель по рынку
 * не проверена. Поставить его можно своей ставкой — «В свою ставку» в таблице матча.
 */
export function CompareNote({ result, names }: { result: Result; names: MatchNames }) {
  const { t } = useTranslation();
  const statuses = useMarketStatuses();
  let best: { row: MarketRow; match: MatchResult } | null = null;
  for (const match of result.matches) {
    for (const row of match.markets) {
      if (row.status !== 'compare' || row.value === null || row.value <= 0 || row.odds === null) continue;
      if (!best || row.value > (best.row.value ?? 0)) best = { row, match };
    }
  }
  if (!best) return null;
  const info = statuses?.get(best.row.family);
  return (
    <p className="analysis-fresh-note">
      <Icon name="flask" />
      <span>
        {t('analysis.variants.compareBest', {
          name: outcomeName(best.row, best.match, names),
          match: matchTitle(best.match, names, t),
          odds: formatOdds(best.row.odds),
          value: formatPercent(best.row.value, { digits: 1, signed: true }),
        })}{' '}
        {info ? t('analysis.variants.compareWhyN', { n: info.events, need: info.need }) : t('analysis.variants.compareWhy')}
      </span>
    </p>
  );
}
