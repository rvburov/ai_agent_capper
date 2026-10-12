import type { TFunction } from 'i18next';
import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Card, FreshnessChip, Icon, KeyValue, Meter } from '../../components';
import type { AiBudget } from '../../features/analysis/types';
import { formatEstimate, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';
import type { LaunchSummary } from './summary';

// Карточка «Перед запуском» (launchCard в mockup/js/screens/new-analysis.js): события, игроки
// и их новости, режим анализа, цена и время, лимит на ИИ, кнопка запуска.

interface Mode {
  id: 'precise' | 'balanced' | 'eco';
  on: boolean;
}

// Р23: на этапе 3 работает только «Точный»; два других — после проверки на истории
const MODES: readonly Mode[] = [
  { id: 'precise', on: true },
  { id: 'balanced', on: false },
  { id: 'eco', on: false },
];

/** Сумма в долларах: целые — без центов ($10), иначе с центами ($1,50). */
export function usdShort(value: number): string {
  return formatUsd(value, Number.isInteger(value) ? 0 : 2);
}

function approx(value: number | null): string {
  return value === null ? '—' : `≈${formatUsd(value, value > 0 && value < 0.1 ? 3 : 2)}`;
}

function monthName(t: TFunction, monthStart: string | undefined): string {
  const months = t('admin.months', { returnObjects: true }) as unknown as string[];
  const month = monthStart ? Number(monthStart.slice(5, 7)) : new Date().getMonth() + 1;
  return months[month - 1] ?? '';
}

/** Лимит на ИИ: участник на ключе администратора, администратор (общий бюджет), свой ключ. */
function LimitBlock({ access, summary }: { access: AiBudget | undefined; summary: LaunchSummary }) {
  const { t } = useTranslation();
  if (!access) return null;
  const cost = summary.costUsd ?? 0;
  if (access.mode === 'own') {
    const last4 = access.own_key?.last4;
    if (!last4) {
      return (
        <div className="new-sub new-limit">
          <div className="row-between small">
            <span className="soft">{t('new.limit.ownKey')}</span>
            <span className="warn-text">{t('new.limit.ownMissing')}</span>
          </div>
          <div className="xsmall muted">
            {t('new.limit.ownMissingText')} <Link to={paths.profile('key')}>{t('new.limit.addKey')}</Link>
          </div>
        </div>
      );
    }
    return (
      <div className="new-sub new-limit">
        <div className="row-between small">
          <span className="soft">{t('new.limit.ownKey')}</span>
          <span className="mono">{t('new.limit.mask', { last4 })}</span>
        </div>
        <div className="xsmall muted">
          {t('new.limit.ownText', { cost: formatUsd(cost), cap: usdShort(access.own_cap_usd) })}{' '}
          <Link to={paths.profile('key')}>{t('new.limit.ownTextLink')}</Link>.
        </div>
      </div>
    );
  }
  const personal = access.monthly_usd !== null;
  const cap = personal ? (access.monthly_usd ?? 0) : (access.budget?.budget_usd ?? 0);
  const spent = personal ? access.spent_usd : (access.budget?.spent_usd ?? access.spent_usd);
  const after = spent + (summary.blocked ? 0 : cost);
  const share = cap > 0 ? after / cap : 0;
  const month = monthName(t, access.month_start);
  const today =
    personal && access.daily_analyses !== null
      ? t('new.limit.today', { today: access.analyses_today, daily: access.daily_analyses, per: usdShort(access.per_analysis_usd) })
      : '';
  return (
    <div className="new-sub new-limit">
      <div className="row-between small">
        <span className="soft">{personal ? t('new.limit.personal', { month }) : t('new.limit.admin', { month })}</span>
        <span className="num">
          <b>{formatUsd(spent)}</b> {t('new.limit.of', { cap: usdShort(cap) })}
        </span>
      </div>
      <Meter
        value={after}
        max={cap || 1}
        label={personal ? t('new.limit.personal', { month }) : t('new.limit.admin', { month })}
        valueText={t('new.limit.meterText', { spent: formatUsd(after), cap: usdShort(cap) })}
        kind={share > 0.9 ? 'bad' : share > 0.7 ? 'warn' : undefined}
      />
      <div className="xsmall muted">
        {/* цены еще нет (события с ошибками) — «после запуска» не показываем */}
        {summary.blocked || summary.costUsd === null
          ? today
          : personal
            ? `${t('new.limit.after', { sum: formatUsd(after) })} · ${today}`
            : `${t('new.limit.after', { sum: formatUsd(after) })} ${t('new.limit.adminAfter')}`}
      </div>
    </div>
  );
}

interface LaunchCardProps {
  summary: LaunchSummary;
  access: AiBudget | undefined;
  launching: boolean;
  onLaunch: () => void;
  /** «Повторить» после сбоя запроса (summary.retry). */
  onRetry: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function LaunchCard({ summary, access, launching, onLaunch, onRetry, buttonRef }: LaunchCardProps) {
  const { t } = useTranslation();
  const seconds = summary.seconds;
  return (
    <Card className="new-launch-card" title={t('new.launch.title')} subtitle={t('new.launch.subtitle')}>
      <dl className="new-strip">
        <div>
          <dt>{t('new.launch.events')}</dt>
          <dd>{summary.n}</dd>
        </div>
        <div>
          <dt>{t('new.launch.players')}</dt>
          <dd>{summary.players.length}</dd>
        </div>
        <div title={t('new.launch.newsTitle')}>
          <dt>{t('new.launch.news')}</dt>
          <dd className={cx(summary.stale.length > 0 && 'warn-text')}>{summary.stale.length}</dd>
        </div>
      </dl>
      <div className="new-sub">
        <div className="eyebrow">{t('new.launch.playersNews')}</div>
        {summary.players.length ? (
          <ul className="new-plist">
            {summary.players.map((p) => (
              <li key={p.key}>
                <div className="new-plist-name">
                  <span>{p.short}</span>
                  {p.sub && <span className="new-plist-sub">{p.sub}</span>}
                </div>
                <FreshnessChip state={p.freshness} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">{t('new.launch.noPlayers')}</p>
        )}
      </div>
      <hr className="divider" />
      <fieldset className="new-modes">
        <legend className="eyebrow">{t('new.modes.legend')}</legend>
        {MODES.map((mode) => (
          <label key={mode.id} className={cx('new-mode', mode.on && 'on', !mode.on && 'off')} title={mode.on ? undefined : t('new.modes.offTitle')}>
            <input type="radio" name="new-mode" value={mode.id} checked={mode.on} disabled={!mode.on} readOnly />
            <span className="new-mode-main">
              <span className="new-mode-title">
                {t(`new.modes.${mode.id}.label`)}
                <span className="new-mode-model">{t(`new.modes.${mode.id}.model`)}</span>
              </span>
              {!mode.on && (
                <span className="new-mode-off">
                  <Icon name="flask" />
                  {t('new.modes.off')}
                </span>
              )}
              <span className="new-mode-note">{t(`new.modes.${mode.id}.note`)}</span>
            </span>
            {mode.on && (
              <span className="new-mode-cost">
                <b>{approx(summary.costUsd)}</b>
                <small>{seconds === null ? '' : formatEstimate(seconds)}</small>
              </span>
            )}
          </label>
        ))}
      </fieldset>
      <div className="new-costs">
        <KeyValue
          items={[
            { key: 'analysis', label: t('new.costs.analysis'), value: t('new.costs.events', { count: summary.n }) },
            {
              key: 'news',
              label: t('new.costs.news'),
              value: summary.stale.length
                ? t('new.costs.newsPlayers', { count: summary.stale.length })
                : t('new.costs.newsFresh'),
            },
            ...(summary.reusedMatches
              ? [{ key: 'reused', label: t('new.costs.reused'), value: t('new.costs.reusedValue', { count: summary.reusedMatches }) }]
              : []),
          ]}
        />
        <div className="new-total" aria-live="polite">
          <span>{t('new.costs.total')}</span>
          <span>
            <b>{approx(summary.costUsd)}</b>
            {seconds !== null && <span className="muted"> · {formatEstimate(seconds)}</span>}
          </span>
        </div>
      </div>
      <LimitBlock access={access} summary={summary} />
      <Button
        ref={buttonRef}
        kind="primary"
        size="lg"
        icon="spark"
        block
        disabled={Boolean(summary.reason)}
        loading={launching}
        onClick={onLaunch}
      >
        {t('new.launch.run')}
      </Button>
      {summary.reason ? (
        <>
          <p className="new-reason" role={summary.retry ? 'alert' : 'status'}>
            <Icon name="alert" />
            {summary.reason}
          </p>
          {summary.retry && (
            <Button size="sm" icon="refresh" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          )}
        </>
      ) : (
        <p className="xsmall muted">{t('new.launch.ready', { time: seconds === null ? '' : formatEstimate(seconds) })}</p>
      )}
      <Link className="new-link" to={paths.costs}>
        {t('new.launch.costsLink')}
        <Icon name="arrowRight" />
      </Link>
    </Card>
  );
}
