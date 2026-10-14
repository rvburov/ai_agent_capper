import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { Me } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { BudgetBar, Button, Callout, Card, Chip, Icon, Skeleton, spendTone, type IconName } from '../../components';
import { aiErrorText } from '../../features/ai/reasons';
import { apiErrorText } from '../../features/analysis/codes';
import type { AiBudget } from '../../features/ai/types';
import type { AdminAiUsage, AiUsage, PersonUsage } from '../../features/costs/types';
import { usdLimit } from '../../features/dashboard/display';
import { formatDate, formatNumber, formatPercent, formatTime, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';

// Верх «ИИ и расходов» (memberHero, ownHero, adminHero и боковые карточки макета costs.js):
// лимит участника на ключе администратора, свой ключ или бюджет ключа администратора. Лимит и
// расход — GET /api/ai/budget (тот же кэш, что у «Ключа Claude» и главной), прогноз и «хватит на
// N анализов» — GET /api/ai/usage, «кто тратит» — GET /api/admin/ai/usage.

const CONSOLE_LIMITS = 'https://platform.claude.com/settings/limits';

export interface Period {
  /** «1–13 октября». */
  long: string;
  /** «1–13 окт». */
  short: string;
  /** «31 окт» — последний день месяца. */
  end: string;
  /** «октябрь». */
  month: string;
}

function Kv({ label, value, note }: { label: ReactNode; value: ReactNode; note?: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {note !== undefined && note !== null && <small>{note}</small>}
      </dd>
    </div>
  );
}

function Note({ icon, children }: { icon?: IconName; children: ReactNode }) {
  return (
    <p className="costs-hero-note">
      {icon && <Icon name={icon} />}
      <span>{children}</span>
    </p>
  );
}

function ConsoleButton({ kind = 'ghost' }: { kind?: 'ghost' | 'secondary' }) {
  const { t } = useTranslation();
  return (
    <Button kind={kind} size="sm" icon="shield" iconRight="link" href={CONSOLE_LIMITS} target="_blank" rel="noopener noreferrer">
      {t('costs.hero.console')}
    </Button>
  );
}

/**
 * Крупная сумма «из лимита» и метка доли с цветом по порогу уведомления (как на главной).
 * stopped — анализы уже остановлены (причина с сервера): метка красная, даже если до 100%
 * расхода не хватает нескольких центов.
 */
function HeroValue({ spent, max, share, alertPct, what, stopped = false }: { spent: number; max: number; share: number | null | undefined; alertPct: number; what: string; stopped?: boolean }) {
  const { t } = useTranslation();
  const tone = stopped ? 'bad' : spendTone(spent, max, alertPct);
  return (
    <div className="costs-hero-value">
      <span className="stat-value hero">{formatUsd(spent)}</span>
      <span className="of">{t('costs.hero.of', { max: usdLimit(max) })}</span>
      <Chip kind={tone ?? 'good'} icon={stopped ? 'pause' : tone ? 'alert' : 'check'}>
        {t('costs.hero.share', { pct: share === null || share === undefined ? '—' : formatPercent(share, { digits: 0 }), what })}
      </Chip>
    </div>
  );
}

function Bar({ spent, max, forecast, alertPct, what, period }: { spent: number; max: number; forecast: number; alertPct: number; what: string; period: Period }) {
  const { t } = useTranslation();
  const over = forecast > max;
  return (
    <BudgetBar
      spent={spent}
      forecast={forecast}
      budget={max}
      alertPct={alertPct}
      label={t('costs.hero.barLabel', { what, spent: formatUsd(spent), max: usdLimit(max), forecast: formatUsd(forecast) })}
      markTitle={t('costs.hero.mark', { pct: alertPct })}
      legend={[
        t('costs.hero.legendSpent', { period: period.short }),
        `${t('costs.hero.legendForecast', { end: period.end, amount: formatUsd(forecast) })}${over ? t('costs.hero.overLimit') : ''}`,
        t('costs.hero.mark', { pct: alertPct }),
      ]}
    />
  );
}

/**
 * Почему новый анализ сейчас не запустится — та же причина с сервера (reason_code в
 * /api/ai/budget), что на «Новом анализе» и в «Ключе Claude» личного кабинета: лимит месяца
 * останавливает анализы и тогда, когда остаток меньше худшего случая вызова Claude.
 */
function MemberStop({ budget }: { budget: AiBudget }) {
  const { t } = useTranslation();
  const monthly = budget.monthly_usd ?? 0;
  const left = budget.left_usd ?? Math.max(0, monthly - budget.spent_usd);
  if (budget.paused) {
    return (
      <Callout kind="warn" icon="pause">
        <b>{t('costs.hero.pausedStrong')}</b>
        {t('costs.hero.paused')}
      </Callout>
    );
  }
  if (memberStopped(budget)) {
    return (
      <Callout kind="bad" icon="pause">
        <b>{monthly > 0 && budget.spent_usd >= monthly ? t('profile.key.limit.stoppedStrong') : t('profile.key.limit.shortStrong', { left: formatUsd(left) })}</b>{' '}
        {t('profile.key.limit.stopped')}
      </Callout>
    );
  }
  if (!budget.reason_code) return null;
  const after = budget.reason_code === 'ai.daily_limit' ? t('profile.key.limit.afterMidnight') : budget.reason_code === 'ai.budget_exhausted' ? t('profile.key.limit.adminDecides') : null;
  return (
    <Callout kind="warn" icon="alert">
      <b>{t('profile.key.reason', { text: aiErrorText(budget.reason_code, budget.reason_params) })}</b>
      {after && ` ${after}`}
    </Callout>
  );
}

/** Лимит месяца исчерпан или остатка не хватает на вызов Claude: анализы остановлены. */
function memberStopped(budget: AiBudget): boolean {
  const monthly = budget.monthly_usd ?? 0;
  return !budget.paused && ((monthly > 0 && budget.spent_usd >= monthly) || budget.reason_code === 'ai.monthly_limit');
}

/** Участник на ключе администратора: личный лимит (Р7, Р13). */
export function MemberHero({ budget, usage, period }: { budget: AiBudget; usage: AiUsage | undefined; period: Period }) {
  const { t } = useTranslation();
  const monthly = budget.monthly_usd ?? 0;
  const left = budget.left_usd ?? Math.max(0, monthly - budget.spent_usd);
  const forecast = usage?.forecast_usd ?? budget.spent_usd;
  // «хватит на N анализов» — только когда анализ сейчас запустится (причины с сервера нет)
  const enough = budget.reason_code ? null : (usage?.analyses_left ?? null);
  const avg = usage?.admin_key_avg_usd ?? null;
  return (
    <section className="card stat costs-hero" aria-label={t('costs.hero.member.label')}>
      <div className="costs-hero-top">
        <div className="stat-label">
          <Icon name="key" />
          <span>{t('costs.hero.member.title', { month: period.month })}</span>
        </div>
        <HeroValue spent={budget.spent_usd} max={monthly} share={budget.limit_share} alertPct={budget.alert_pct} what={t('costs.hero.ofLimit')} stopped={memberStopped(budget)} />
        <div className="costs-hero-sub">{t('costs.hero.member.sub')}</div>
      </div>
      <MemberStop budget={budget} />
      {monthly > 0 && <Bar spent={budget.spent_usd} max={monthly} forecast={forecast} alertPct={budget.alert_pct} what={t('costs.hero.member.what')} period={period} />}
      <dl className="costs-kv">
        <Kv label={t('costs.hero.left')} value={formatUsd(left)} note={t('costs.hero.until', { end: period.end })} />
        <Kv
          label={t('costs.hero.today')}
          value={budget.daily_analyses !== null ? t('costs.hero.todayValue', { n: budget.analyses_today, max: budget.daily_analyses }) : formatNumber(budget.analyses_today)}
          note={budget.daily_analyses !== null ? t('costs.hero.perDay', { count: budget.daily_analyses }) : undefined}
        />
        <Kv label={t('costs.hero.perAnalysis')} value={t('costs.hero.upTo', { amount: usdLimit(budget.per_analysis_usd) })} note={t('costs.hero.cap')} />
      </dl>
      {enough !== null && avg !== null && !budget.paused && (
        <Note icon="info">
          {t('costs.hero.enough', { count: enough, avg: formatUsd(avg) })}
          {budget.daily_analyses !== null ? t('costs.hero.enoughDaily', { count: budget.daily_analyses }) : ''}
        </Note>
      )}
      <Note icon="globe">{t('costs.hero.member.news')}</Note>
      <div className="costs-hero-foot">
        <div className="costs-hero-actions">
          <Note icon="lock">{t('costs.hero.member.byAdmin')}</Note>
          <Button kind="secondary" size="sm" icon="key" iconRight="arrowRight" to={paths.profile('key')}>
            {t('costs.hero.member.toOwn')}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Участник на своем ключе: расход с его счета; потраченное до перехода — на ключе администратора. */
export function OwnHero({ budget, usage, period }: { budget: AiBudget; usage: AiUsage | undefined; period: Period }) {
  const { t } = useTranslation();
  const before = usage && usage.admin_key_usd > 0 ? usage.admin_key_usd : null;
  const key = budget.own_key;
  return (
    <section className="card stat costs-hero" aria-label={t('costs.hero.own.label')}>
      <div className="costs-hero-top">
        <div className="stat-label">
          <Icon name="key" />
          <span>{t('costs.hero.own.title', { month: period.month })}</span>
        </div>
        <div className="costs-hero-value">
          <span className="stat-value hero">{formatUsd(budget.spent_usd)}</span>
          <span className="of">{t('costs.hero.own.fromYou')}</span>
          <Chip kind="outline" icon="key">
            {t('costs.hero.own.mask', { last4: key?.last4 ?? '••••' })}
          </Chip>
        </div>
        <div className="costs-hero-sub">{t('costs.hero.own.sub')}</div>
      </div>
      <dl className="costs-kv">
        {before !== null ? (
          <Kv label={t('costs.hero.own.before')} value={formatUsd(before)} note={t('costs.hero.own.beforeNote')} />
        ) : (
          <Kv label={t('costs.hero.forecast')} value={t('costs.hero.approx', { amount: formatUsd(usage?.forecast_usd ?? budget.spent_usd) })} note={t('costs.hero.onEnd', { end: period.end })} />
        )}
        <Kv
          label={t('costs.hero.own.verified')}
          value={key?.verified_at ? formatDate(key.verified_at) : '—'}
          note={key?.verified_at ? formatTime(key.verified_at) : undefined}
        />
        <Kv label={t('costs.hero.perAnalysis')} value={t('costs.hero.upTo', { amount: usdLimit(budget.own_cap_usd) })} note={t('costs.hero.own.yourCap')} />
      </dl>
      {before !== null && <Note icon="info">{t('costs.hero.own.beforeText', { amount: formatUsd(before) })}</Note>}
      <Note icon="globe">{t('costs.hero.own.news')}</Note>
      <div className="costs-hero-foot">
        <div className="costs-hero-actions">
          <ConsoleButton kind="secondary" />
          <Button kind="ghost" size="sm" iconRight="arrowRight" to={paths.profile('key')}>
            {t('costs.hero.own.toProfile')}
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Администратор: бюджет ключа администратора — все, кто на нем, и общие фоновые задачи. */
export function AdminHero({ budget, usage, period }: { budget: AiBudget; usage: AiUsage | undefined; period: Period }) {
  const { t } = useTranslation();
  const total = budget.budget;
  if (!total) return null;
  const elapsed = usage?.days_elapsed ?? 0;
  return (
    <section className="card stat costs-hero" aria-label={t('costs.hero.admin.label')}>
      <div className="costs-hero-top">
        <div className="stat-label">
          <Icon name="key" />
          <span>{t('costs.hero.admin.title', { month: period.month })}</span>
        </div>
        <HeroValue spent={total.spent_usd} max={total.budget_usd} share={total.budget_share} alertPct={total.alert_pct} what={t('costs.hero.ofBudget')} stopped={budget.reason_code === 'ai.budget_exhausted'} />
        <div className="costs-hero-sub">{t('costs.hero.admin.sub')}</div>
      </div>
      <Bar spent={total.spent_usd} max={total.budget_usd} forecast={total.forecast_usd} alertPct={total.alert_pct} what={t('costs.hero.admin.what')} period={period} />
      <dl className="costs-kv">
        <Kv label={t('costs.hero.left')} value={formatUsd(total.left_usd)} note={t('costs.hero.until', { end: period.end })} />
        <Kv label={t('costs.hero.admin.perDay')} value={elapsed > 0 ? formatUsd(total.spent_usd / elapsed) : '—'} note={t('costs.hero.admin.avg')} />
        <Kv label={t('costs.hero.admin.canPerDay')} value={total.days_left > 0 ? formatUsd(total.left_usd / total.days_left) : '—'} note={t('costs.hero.admin.toFit')} />
      </dl>
      <Note>{t('costs.hero.admin.note', { pct: total.alert_pct, amount: usdLimit((total.budget_usd * total.alert_pct) / 100) })}</Note>
      <div className="costs-hero-foot">
        <div className="costs-hero-actions">
          <Button kind="secondary" size="sm" icon="sliders" to={`${paths.admin('key')}#adm-limits`}>
            {t('costs.hero.admin.limits')}
          </Button>
          <ConsoleButton />
        </div>
        <Note icon="shield">{t('costs.hero.admin.second')}</Note>
      </div>
    </section>
  );
}

function RulesCard({ title, subtitle, items }: { title: string; subtitle: string; items: { key: string; icon: IconName; tone?: 'warn' | 'bad' | 'info'; title: string; text: string }[] }) {
  return (
    <Card className="costs-card costs-side" title={title} subtitle={subtitle}>
      <ul className="costs-rules">
        {items.map((item) => (
          <li key={item.key}>
            <span className={cx('costs-rules-ic', item.tone)}>
              <Icon name={item.icon} />
            </span>
            <span className="costs-rules-body">
              <b>{item.title}</b>
              <span>{item.text}</span>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Участник: что будет у лимита и что в него не входит (memberRulesCard макета). */
export function MemberRules({ budget, usage, period }: { budget: AiBudget; usage: AiUsage | undefined; period: Period }) {
  const { t } = useTranslation();
  const own = budget.mode === 'own';
  const maxAnalysis = usage ? Math.max(0, ...usage.analyses.filter((a) => a.done && !a.acceptance).map((a) => a.cost_usd)) : 0;
  const shared = own ? t('costs.rules.sharedOwn') : t('costs.rules.shared');
  if (own) {
    return (
      <RulesCard
        title={t('costs.rules.ownTitle')}
        subtitle={t('costs.rules.ownSubtitle')}
        items={[
          { key: 'console', icon: 'shield', tone: 'info', title: t('costs.rules.consoleTitle'), text: t('costs.rules.consoleText') },
          { key: 'cap', icon: 'coins', tone: 'info', title: t('costs.rules.capTitle', { amount: usdLimit(budget.own_cap_usd) }), text: t('costs.rules.ownCapText') },
          { key: 'shared', icon: 'layers', title: t('costs.rules.notIncluded'), text: shared },
          { key: 'back', icon: 'key', title: t('costs.rules.backTitle'), text: t('costs.rules.backText') },
        ]}
      />
    );
  }
  const monthly = budget.monthly_usd ?? 0;
  const items: { key: string; icon: IconName; tone?: 'warn' | 'bad' | 'info'; title: string; text: string }[] = [];
  if (budget.paused) items.push({ key: 'paused', icon: 'pause', tone: 'bad', title: t('costs.hero.pausedStrong'), text: t('costs.rules.pausedText') });
  items.push(
    { key: 'alert', icon: 'bell', tone: 'warn', title: t('costs.rules.alertTitle', { pct: budget.alert_pct, amount: usdLimit((monthly * budget.alert_pct) / 100) }), text: t('costs.rules.alertText') },
    { key: 'stop', icon: 'pause', tone: 'bad', title: t('costs.rules.stopTitle'), text: t('costs.rules.stopText') },
  );
  if (budget.daily_analyses !== null) {
    items.push({
      key: 'daily',
      icon: 'calendar',
      tone: 'info',
      title: t('costs.rules.dailyTitle', { count: budget.daily_analyses }),
      text: t('costs.rules.dailyText', { n: budget.analyses_today, max: budget.daily_analyses }),
    });
  }
  items.push(
    {
      key: 'cap',
      icon: 'coins',
      tone: 'info',
      title: t('costs.rules.capTitle', { amount: usdLimit(budget.per_analysis_usd) }),
      text: maxAnalysis > 0 ? t('costs.rules.capTextMax', { month: period.month, amount: formatUsd(maxAnalysis) }) : t('costs.rules.capText'),
    },
    { key: 'shared', icon: 'layers', title: t('costs.rules.notIncluded'), text: shared },
  );
  return <RulesCard title={t('costs.rules.title')} subtitle={t('costs.rules.subtitle')} items={items} />;
}

interface WhoRow {
  key: string;
  name: ReactNode;
  sub?: ReactNode;
  value: string;
  className?: string;
}

function personSub(person: PersonUsage, level: '80' | '100' | undefined, t: TFunction): ReactNode {
  if (person.ai_mode === 'own') return t('costs.who.beforeOwn');
  if (person.limit_usd === null) return t('costs.who.noLimit');
  const parts = [t('costs.who.limit', { amount: usdLimit(person.limit_usd), pct: formatPercent(person.limit_share ?? 0, { digits: 0 }) })];
  if (person.status === 'blocked') parts.push(t('costs.who.blocked'));
  else if (person.paused) parts.push(t('costs.who.paused'));
  else if (level === '100') parts.push(t('costs.who.stopped'));
  const text = parts.join(' · ');
  // цвет — по уровню с сервера, а не по сравнению доли с порогом в браузере
  if (level === '100' && !person.paused) return <span className="bad-text">{text}</span>;
  return person.paused || level === '80' ? <span className="warn-text">{text}</span> : text;
}

interface AdminWhoProps {
  data: AdminAiUsage | undefined;
  me: Me;
  levels: ReadonlyMap<number, '80' | '100'>;
  error: unknown;
  onRetry: () => void;
  month: string;
}

/** Администратор: кто тратит бюджет ключа — коротко; подробно — в «Администрировании». */
export function AdminWho({ data, me, levels, error, onRetry, month }: AdminWhoProps) {
  const { t } = useTranslation();
  const foot = (
    <Button kind="ghost" size="sm" iconRight="arrowRight" to={paths.admin('usage')}>
      {t('costs.who.more')}
    </Button>
  );
  if (!data) {
    return (
      <Card className="costs-card costs-side" title={t('costs.who.title')} foot={foot}>
        {error ? (
          <Callout kind="bad" role="alert">
            {t('costs.who.failed')} {apiErrorText(error)}{' '}
            <Button size="sm" kind="ghost" icon="refresh" onClick={onRetry}>
              {t('common.retry')}
            </Button>
          </Callout>
        ) : (
          <Skeleton lines={4} height={18} />
        )}
      </Card>
    );
  }
  const spenders = data.people.filter((p) => p.key_spent_usd > 0).sort((a, b) => b.key_spent_usd - a.key_spent_usd);
  const top = spenders.length > 4 ? spenders.slice(0, 3) : spenders;
  const rest = spenders.slice(top.length);
  const rows: WhoRow[] = top.map((person) => ({
    key: `u${person.user_id}`,
    name: (
      <span className="costs-who-name">
        {person.display_name}
        {person.user_id === me.id && <Chip kind="outline">{t('costs.who.you')}</Chip>}
      </span>
    ),
    sub: personSub(person, levels.get(person.user_id), t),
    value: formatUsd(person.key_spent_usd),
  }));
  if (rest.length) {
    rows.push({
      key: 'rest',
      name: t('costs.who.rest', { count: rest.length }),
      sub: t('costs.who.restSub'),
      value: formatUsd(rest.reduce((sum, p) => sum + p.key_spent_usd, 0)),
    });
  }
  rows.push(
    { key: 'shared', name: t('costs.who.shared'), sub: t('costs.who.sharedSub'), value: formatUsd(data.shared.cost_usd) },
    { key: 'total', name: t('costs.who.total'), value: formatUsd(data.spent_usd), className: 'total' },
    {
      key: 'eval',
      name: t('costs.who.eval'),
      sub: t('costs.who.evalSub', { amount: usdLimit(data.eval.budget_usd) }),
      value: t('costs.who.evalValue', { spent: formatUsd(data.eval.spent_usd), max: usdLimit(data.eval.budget_usd) }),
      className: 'aside',
    },
  );
  const own = data.people.filter((p) => p.ai_mode === 'own');
  const back = data.people.filter((p) => p.ai_mode !== 'own' && p.own_spent_usd > 0);
  const notes: string[] = [];
  if (own.length) notes.push(t('costs.who.ownNote', { count: own.length, names: own.map((p) => p.display_name).join(', ') }));
  for (const person of back) notes.push(t('costs.who.backNote', { name: person.display_name, amount: formatUsd(person.own_spent_usd) }));
  return (
    <Card className="costs-card costs-side" title={t('costs.who.title')} subtitle={t('costs.who.subtitle', { month })} foot={foot}>
      <ul className="costs-mlist costs-who">
        {rows.map((row) => (
          <li key={row.key} className={row.className}>
            <span className="t">{row.name}</span>
            {row.sub && <span className="s">{row.sub}</span>}
            <span className="v">{row.value}</span>
          </li>
        ))}
      </ul>
      {notes.length > 0 && (
        <div className="costs-howto">
          <Icon name="info" />
          <span>{notes.join(' ')}</span>
        </div>
      )}
    </Card>
  );
}
