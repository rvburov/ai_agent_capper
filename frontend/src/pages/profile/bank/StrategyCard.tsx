import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Card, Chip, Icon, Skeleton } from '../../../components';
import { formatShare } from '../../../features/analysis/markets';
import { stakeRows, valueRows } from '../../../features/bank/display';
import type { Bank, Strategy } from '../../../features/bank/types';
import { currencyOf } from '../../../features/bets/display';
import { formatMoney, formatOdds, formatPercent } from '../../../lib/format';
import { LoadError } from '../LoadError';

// «Правила стратегии» (strategyCard макета, Т20): параметры действующей версии стратегии
// (GET /api/strategy/active) — только просмотр; менять — версиями стратегии на этапе 5.

function Rule({ title, note, value }: { title: string; note?: string; value: ReactNode }) {
  return (
    <div className="profile-srule">
      <dt>
        {title}
        {note && <small>{note}</small>}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

/** Поправка на валуй со знаком: «+0,5%», «−0,25%»; ноль — словами. */
function addText(add: number, none: string): string {
  if (add === 0) return none;
  return `${add > 0 ? '+' : '−'}${formatShare(Math.abs(add))}`;
}

interface StrategyCardProps {
  strategy: Strategy | undefined;
  error: unknown;
  onRetry: () => void;
  bank: Bank;
}

export function StrategyCard({ strategy, error, onRetry, bank }: StrategyCardProps) {
  const { t } = useTranslation();
  const head = {
    id: 'profile-strategy',
    className: 'profile-anchor',
    title: t('profile.bank.strategy.title'),
    actions: (
      <Chip kind="outline" icon="lock">
        {t('profile.bank.readOnly')}
      </Chip>
    ),
  };
  if (!strategy) {
    return <Card {...head}>{error ? <LoadError error={error} onRetry={onRetry} /> : <Skeleton lines={6} />}</Card>;
  }
  const p = strategy.params;
  const currency = currencyOf(bank.currency);
  const equity = Number(bank.equity);
  const money = (amount: number | string | null) => formatMoney(amount, currency);
  const rows = stakeRows(p, Number.isFinite(equity) ? equity : null, currency);
  const values = valueRows(p);
  const pct = (value: number) => formatPercent(value, { digits: 0 });
  const rounding = p.rounding[currency] ?? '1';
  const minStake = p.min_stake[currency] ?? '0';
  return (
    <Card {...head} subtitle={t('profile.bank.strategy.subtitle', { code: strategy.code })}>
      <div className="stack profile-tight">
        <h4>{t('profile.bank.strategy.pick')}</h4>
        <dl className="profile-srules">
          <Rule title={t('profile.bank.strategy.markets')} note={t('profile.bank.strategy.marketsNote')} value={t('profile.bank.strategy.marketsValue', { count: p.markets.length * 2 })} />
          <Rule
            title={t('profile.bank.strategy.prob')}
            note={t('profile.bank.strategy.probNote', { p: pct(p.triple_min_p) })}
            value={t('profile.bank.strategy.from', { value: pct(p.min_p) })}
          />
          <Rule
            title={t('profile.bank.strategy.legOdds')}
            note={t('profile.bank.strategy.legOddsNote', { odds: formatOdds(p.triple_max_leg_odds) })}
            value={`${formatOdds(p.leg_odds[0])}–${formatOdds(p.leg_odds[1])}`}
          />
          <Rule
            title={t('profile.bank.strategy.value')}
            note={t('profile.bank.strategy.valueNote')}
            value={p.require_value ? t('profile.bank.strategy.valueRequired') : t('profile.bank.strategy.valueOptional')}
          />
          <Rule title={t('profile.bank.strategy.cover')} note={t('profile.bank.strategy.coverNote')} value={t('profile.bank.strategy.from', { value: pct(p.cover_min_p) })} />
          <Rule
            title={t('profile.bank.strategy.form')}
            note={t('profile.bank.strategy.formNote')}
            value={t('profile.bank.strategy.formValue', { wins: p.form_min_wins_last5, losses: 5 - p.form_min_wins_last5 })}
          />
        </dl>
      </div>
      <div className="stack profile-tight">
        <h4>{t('profile.bank.strategy.parlay')}</h4>
        <dl className="profile-srules">
          <Rule title={t('profile.bank.strategy.double')} value={t('profile.bank.strategy.total', { from: formatOdds(p.double_total[0]), to: formatOdds(p.double_total[1]) })} />
          <Rule title={t('profile.bank.strategy.triple')} value={t('profile.bank.strategy.total', { from: formatOdds(p.triple_total[0]), to: formatOdds(p.triple_total[1]) })} />
        </dl>
      </div>
      <hr className="divider" />
      <div className="stack profile-tight">
        <div className="profile-section-title">
          <h4>{t('profile.bank.strategy.stakeTitle')}</h4>
          <span className="xsmall muted">{t('profile.bank.strategy.stakeOf', { bank: money(bank.equity) })}</span>
        </div>
        <div className="profile-stakes">
          {rows.map((row) => (
            <div key={`${row.low}-${row.high}`} className="profile-stake">
              <div className="profile-min">
                <div className="profile-stake-range">{`${formatOdds(row.low)}–${formatOdds(row.high)}`}</div>
                <div className="xsmall muted">
                  {row.triple ? t('profile.bank.strategy.tripleOnly') : row.stake !== null ? t('profile.bank.strategy.stakeNow', { stake: money(row.stake) }) : ''}
                </div>
              </div>
              <div className="profile-stake-pct">
                {formatShare(row.pct)}
                {row.triple && row.stake !== null && <small>{money(row.stake)}</small>}
              </div>
            </div>
          ))}
        </div>
        <div className="profile-section-title profile-gap-top">
          <h4>{t('profile.bank.strategy.valueTitle')}</h4>
          <span className="xsmall muted">{t('profile.bank.strategy.valueOf')}</span>
        </div>
        <dl className="profile-value" aria-label={t('profile.bank.strategy.valueLabel')}>
          {values.map((row) => (
            <div key={row.tier}>
              <dt>
                {t(`profile.bank.strategy.tiers.${row.tier}`)}
                <small>
                  {row.from === null
                    ? t('profile.bank.strategy.edgeBelow', { value: row.to ?? 0 })
                    : row.to === null
                      ? t('profile.bank.strategy.edgeFrom', { value: row.from })
                      : t('profile.bank.strategy.edgeRange', { from: row.from, to: row.to })}
                </small>
              </dt>
              <dd>{addText(row.add, t('profile.bank.strategy.noAdd'))}</dd>
            </div>
          ))}
        </dl>
        <p className="xsmall muted">
          {t('profile.bank.strategy.howStake', { max: formatShare(p.max_pct), step: money(rounding), min: money(minStake) })}
        </p>
      </div>
      <p className="profile-note">
        <Icon name="lock" />
        <span>{t('profile.bank.strategy.readOnlyNote')}</span>
      </p>
    </Card>
  );
}
