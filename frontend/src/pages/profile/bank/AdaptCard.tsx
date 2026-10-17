import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Button, Card, Chip, Icon } from '../../../components';
import { formatShare } from '../../../features/analysis/markets';
import { DRAWDOWN_SCALE, GROWTH, param, PROTECTION, ruleActing } from '../../../features/bank/display';
import type { Adaptation, AdaptationKey, Bank, StrategyParams } from '../../../features/bank/types';
import { currencyOf } from '../../../features/bets/display';
import { formatMoney, formatOdds, formatPercent, formatPp } from '../../../lib/format';
import { cx } from '../../../lib/cx';

// «Адаптации ставки» (adaptCard макета, Р22, В7): правила, которые меняют сумму ставки по
// просадке от пика и итогу недели; рост ставки выключен по умолчанию. Действует ли правило —
// из GET /api/me/bank (adaptations). Переключатели только показывают состояние.

function pctOf(value: number | null): string {
  return value === null ? '—' : formatShare(Math.abs(value));
}

/** «Просадка от пика −10% → ставка не больше 2,5% банка». */
export function ruleText(rule: Adaptation, params: StrategyParams | null, t: TFunction): string {
  switch (rule.key) {
    case 'dd10':
    case 'dd20': {
      const level = params?.drawdown.find((d) => Math.abs(Number(d.start) - (param(rule, 'from') ?? -1)) < 1e-9);
      const label = t('profile.bank.adapt.rules.dd.label', { from: pctOf(param(rule, 'from')) });
      const max = pctOf(param(rule, 'max_pct'));
      const effect =
        level?.max_legs != null && level.max_leg_odds != null
          ? t('profile.bank.adapt.rules.dd.effectStrict', { max, legs: level.max_legs, odds: formatOdds(level.max_leg_odds) })
          : t('profile.bank.adapt.rules.dd.effect', { max });
      return `${label} → ${effect}`;
    }
    case 'week_loss':
      return `${t('profile.bank.adapt.rules.week_loss.label', { loss: pctOf(param(rule, 'loss')) })} → ${t('profile.bank.adapt.rules.week_loss.effect', { max: pctOf(param(rule, 'max_pct')) })}`;
    case 'up15':
      return `${t('profile.bank.adapt.rules.up15.label', { up: pctOf(param(rule, 'bank_up')), winrate: pctOf(param(rule, 'min_winrate')) })} → ${t('profile.bank.adapt.rules.up15.effect', {
        max: pctOf(param(rule, 'max_pct')),
        base: params ? formatShare(params.max_pct) : '—',
      })}`;
    case 'week_win':
      return `${t('profile.bank.adapt.rules.week_win.label', { win: pctOf(param(rule, 'win')) })} → ${t('profile.bank.adapt.rules.week_win.effect', {
        add: formatPp(param(rule, 'add') ?? 0),
      })}`;
    default:
      return rule.key;
  }
}

/** Что сейчас с условием правила: «Сейчас −3,2% от пика», «За 7 дней +1,0%». */
function nowText(key: AdaptationKey, bank: Bank, t: TFunction): string {
  const signed = (value: string | null) => (value === null ? '—' : formatPercent(Number(value), { signed: true }));
  if (key === 'dd10' || key === 'dd20') return t('profile.bank.adapt.now.drawdown', { value: formatPercent(-Number(bank.drawdown), { signed: true }) });
  if (key === 'up15') return t('profile.bank.adapt.now.growth', { growth: signed(bank.growth), winrate: bank.winrate === null ? '—' : formatPercent(Number(bank.winrate)) });
  return t('profile.bank.adapt.now.week', { value: signed(bank.week_change) });
}

function RuleRow({ rule, bank, params }: { rule: Adaptation; bank: Bank; params: StrategyParams | null }) {
  const { t } = useTranslation();
  const id = `profile-rule-${rule.key}`;
  const text = ruleText(rule, params, t);
  let chip;
  if (!rule.enabled) {
    chip = (
      <Chip kind="outline" icon="pause">
        {t('profile.bank.adapt.off')}
      </Chip>
    );
  } else if (ruleActing(rule)) {
    chip = (
      <Chip kind="warn" icon="bolt">
        {t('profile.bank.adapt.active')}
      </Chip>
    );
  } else {
    chip = (
      <Chip kind="outline" icon="clock">
        {t('profile.bank.adapt.waiting')}
      </Chip>
    );
  }
  const now = nowText(rule.key, bank, t);
  const tail = rule.enabled ? '' : rule.met ? t('profile.bank.adapt.wouldAct') : t('profile.bank.adapt.wouldNot');
  return (
    <div className="profile-rule">
      <label className="profile-rule-text" htmlFor={id}>
        <span className="profile-rule-title">{text}</span>
      </label>
      <span className="switch">
        <input
          type="checkbox"
          role="switch"
          id={id}
          checked={rule.enabled}
          disabled
          readOnly
          aria-label={t('profile.bank.adapt.switchLabel', {
            rule: text,
            state: rule.enabled ? t('profile.bank.adapt.stateOn') : t('profile.bank.adapt.stateOff'),
          })}
        />
        <span />
      </span>
      <div className="profile-rule-status">
        {chip}
        <span className="xsmall muted">{`${now}${tail}`}</span>
      </div>
    </div>
  );
}

export function AdaptCard({ bank, params, onPropose }: { bank: Bank; params: StrategyParams | null; onPropose: () => void }) {
  const { t } = useTranslation();
  const byKey = new Map(bank.adaptations.map((rule) => [rule.key, rule]));
  const protection = PROTECTION.map((key) => byKey.get(key)).filter((r): r is Adaptation => r !== undefined);
  const growth = GROWTH.map((key) => byKey.get(key)).filter((r): r is Adaptation => r !== undefined);
  const drawdown = Number(bank.drawdown);
  const marks = protection
    .filter((rule) => rule.key === 'dd10' || rule.key === 'dd20')
    .map((rule) => param(rule, 'from'))
    .filter((from): from is number => from !== null);
  const anyActive = bank.adaptations.some((rule) => rule.enabled && rule.active);
  const growthOn = growth.some((rule) => rule.enabled);
  const growthMet = growth.filter((rule) => !rule.enabled && rule.met);
  const currency = currencyOf(bank.currency);
  const fillPct = Math.min(100, (drawdown / DRAWDOWN_SCALE) * 100);
  const level = drawdown >= (marks[1] ?? 0.2) ? 'bad' : drawdown >= (marks[0] ?? 0.1) ? 'warn' : null;
  return (
    <Card
      id="profile-adapt"
      className="profile-anchor"
      title={t('profile.bank.adapt.title')}
      subtitle={t('profile.bank.adapt.subtitle')}
      actions={
        <Button kind="secondary" size="sm" icon="edit" onClick={onPropose} ro>
          {t('profile.bank.rules.propose')}
        </Button>
      }
    >
      <div className="profile-dd">
        <div className="row-between small">
          <span className="soft">{t('profile.bank.adapt.drawdownFrom', { peak: formatMoney(bank.peak, currency) })}</span>
          <b className="num">{drawdown > 0 ? formatPercent(-drawdown, { signed: true }) : formatPercent(0, { digits: 0 })}</b>
        </div>
        <div
          className="profile-dd-track"
          role="meter"
          aria-label={t('profile.bank.adapt.drawdownLabel')}
          aria-valuenow={Math.round(drawdown * 1000) / 10}
          aria-valuemin={0}
          aria-valuemax={DRAWDOWN_SCALE * 100}
          aria-valuetext={formatPercent(-drawdown, { signed: true })}
        >
          <i className={cx('profile-dd-fill', level)} style={{ width: `${fillPct}%` }} />
          {marks.map((mark) => (
            <span key={mark} className="profile-dd-mark" style={{ left: `${(mark / DRAWDOWN_SCALE) * 100}%` }} />
          ))}
        </div>
        <div className="profile-dd-scale" aria-hidden="true">
          <span style={{ left: 0 }}>{formatPercent(0, { digits: 0 })}</span>
          {marks.map((mark) => (
            <span key={mark} style={{ left: `${(mark / DRAWDOWN_SCALE) * 100}%` }}>
              {formatPercent(-mark, { digits: 0, signed: true })}
            </span>
          ))}
        </div>
        <div className="xsmall muted">
          {anyActive
            ? t('profile.bank.adapt.anyActive')
            : t('profile.bank.adapt.noneActive', {
                drawdown: drawdown > 0 ? formatPercent(-drawdown, { signed: true }) : formatPercent(0, { digits: 0 }),
                week: bank.week_change === null ? '—' : formatPercent(Number(bank.week_change), { signed: true }),
              })}
        </div>
      </div>
      <div className="profile-rule-groups">
        <div className="profile-rule-group" role="group" aria-labelledby="profile-rg-on">
          <div className="profile-rule-group-head">
            <h4 id="profile-rg-on">{t('profile.bank.adapt.protection')}</h4>
            {protection.every((rule) => rule.enabled) ? (
              <Chip kind="good" icon="check">
                {t('profile.bank.adapt.groupOn')}
              </Chip>
            ) : (
              <Chip kind="outline" icon="pause">
                {t('profile.bank.adapt.groupPartly')}
              </Chip>
            )}
          </div>
          {protection.map((rule) => (
            <RuleRow key={rule.key} rule={rule} bank={bank} params={params} />
          ))}
        </div>
        {growth.length > 0 && (
          <div className="profile-rule-group" role="group" aria-labelledby="profile-rg-off">
            <div className="profile-rule-group-head">
              <h4 id="profile-rg-off">{t('profile.bank.adapt.growth')}</h4>
              {growthOn ? (
                <Chip kind="warn" icon="bolt">
                  {t('profile.bank.adapt.groupOn')}
                </Chip>
              ) : (
                <Chip kind="outline" icon="pause">
                  {t('profile.bank.adapt.groupOffDefault')}
                </Chip>
              )}
            </div>
            {growth.map((rule) => (
              <RuleRow key={rule.key} rule={rule} bank={bank} params={params} />
            ))}
            {!growthOn && (
              <div className="callout">
                <Icon name="info" />
                <div className="callout-body">
                  {t('profile.bank.adapt.growthWhy')}{' '}
                  {growthMet.length ? t('profile.bank.adapt.growthMet') : t('profile.bank.adapt.growthNotMet')}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <p className="profile-note">
        <Icon name="history" />
        <span>{t('profile.bank.adapt.note')}</span>
      </p>
    </Card>
  );
}
