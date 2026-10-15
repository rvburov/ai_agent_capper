import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router';

import { errorMessage, isApiError } from '../../api/errors';
import type { Me } from '../../api/hooks/useMe';
import {
  BudgetBar,
  Button,
  Callout,
  Card,
  Chip,
  Dropdown,
  Field,
  FieldShell,
  Icon,
  KeyValue,
  Skeleton,
  spendTone,
  useToast,
} from '../../components';
import { amountInput, BUDGET_MAX, BUDGET_MIN, checkBudget, formatLimitUsd } from '../../features/admin/limits';
import { personName } from '../../features/admin/people';
import type { AdminBudget, AdminKey, AdminLimits, AlertPct } from '../../features/admin/types';
import { useAdminBudget, useAdminKey, useAdminLimits, useReplaceAdminKey, useUpdateBudget } from '../../features/admin/useAdminAi';
import { keyMask, keyProblem, spelled } from '../../features/ai/keyFormat';
import { formatDate, formatDateTime, formatPercent, formatShare, formatUsd } from '../../lib/format';
import { LimitsCard } from './LimitsCard';
import { ConfirmDialog, HowTo, LoadError } from './parts';

// Порог уведомления о расходе — варианты из настроек программы (app_settings.budget_alert_pct)
const ALERT_OPTIONS: readonly AlertPct[] = [50, 70, 80, 90];
// Ошибки сервера, которые относятся к самому ключу: под полем ключа, окно с кодом закрывается
const KEY_ERRORS = new Set(['ai.key_format', 'ai.key_rejected', 'ai.key_models']);
// Ошибки самого кода 2FA: окно остается, код вводится заново. Сеанс завершен — тоже в окне
const CODE_ERRORS = new Set(['admin.totp_required', 'admin.totp_invalid', 'auth.too_many_codes']);
// Лимит трат в консоли Anthropic — «вторая страховка» (совет в карточке ключа)
const CONSOLE_LIMITS_URL = 'https://platform.claude.com/settings/limits';
const CONSOLE_MARGIN_USD = 10;
// Подсветка участников у порога после перехода из уведомления (adm-flash макета, 2,8 с)
const FLASH_MS = 3000;

/**
 * Вкладка «Ключ и бюджет» (PANELS.key макета, mockup/js/screens/admin.js): ключ администратора,
 * общий бюджет на месяц, лимиты участников и что происходит на пороге и на 100% (Р9, Р13).
 * Ссылка уведомления /admin/key#adm-limits прокручивает к лимитам, когда они загрузились, и
 * подсвечивает участников, чей расход дошел до порога уведомления (как в макете).
 */
export function KeyTab({ me }: { me: Me }) {
  const { hash, key: locationKey } = useLocation();
  const key = useAdminKey();
  const budget = useAdminBudget();
  const limits = useAdminLimits();
  const ready = !key.isPending && !budget.isPending && !limits.isPending;
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    const id = decodeURIComponent(hash.replace(/^#/, ''));
    if (!id || !ready) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' });
      if (id === 'adm-limits') setFlash(true);
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, locationKey, ready]);

  useEffect(() => {
    if (!flash) return;
    const timer = window.setTimeout(() => setFlash(false), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flash]);

  return (
    <>
      <div className="grid">
        <div className="col-6 adm-col">
          {key.data ? (
            <AdminKeyCard info={key.data} budget={budget.data} />
          ) : (
            <Loading title="admin.key.card.title" query={key} />
          )}
        </div>
        <div className="col-6 adm-col">
          {budget.data ? (
            <BudgetCard budget={budget.data} limits={limits.data} />
          ) : (
            <Loading title="admin.key.budget.title" query={budget} />
          )}
        </div>
      </div>
      {limits.data ? (
        <LimitsCard me={me} limits={limits.data} alertPct={budget.data?.alert_pct ?? null} flash={flash} />
      ) : (
        <Loading title="admin.key.limits.title" query={limits} />
      )}
      {/* правила называют порог из настроек бюджета: без него карточка не показывается, а не с «—» */}
      {budget.data && <ThresholdsCard alertPct={budget.data.alert_pct} />}
    </>
  );
}

interface LoadingProps {
  title: 'admin.key.card.title' | 'admin.key.budget.title' | 'admin.key.limits.title';
  query: { isError: boolean; error: unknown; refetch: () => unknown };
}

function Loading({ title, query }: LoadingProps) {
  const { t } = useTranslation();
  return (
    <Card title={t(title)} className="adm-fill">
      {query.isError ? (
        <LoadError error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <Skeleton lines={3} height={18} />
      )}
    </Card>
  );
}

/** «Ключ администратора» (keyCard макета): последние 4 символа, проверка, замена с кодом 2FA. */
function AdminKeyCard({ info, budget }: { info: AdminKey; budget: AdminBudget | undefined }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(false);
  const status =
    info.status === 'ok' ? (
      <Chip kind="good" icon="check">
        {t('admin.key.card.works')}
      </Chip>
    ) : info.status === 'missing' ? (
      <Chip kind="bad" icon="alert">
        {t('admin.key.card.missing')}
      </Chip>
    ) : (
      <Chip kind="warn" icon="alert">
        {t('admin.key.card.unverified')}
      </Chip>
    );
  return (
    <Card
      id="adm-key"
      className="adm-anchor adm-fill adm-nowrap-head"
      title={t('admin.key.card.title')}
      subtitle={t('admin.key.card.subtitle')}
      actions={
        form ? undefined : (
          <Button size="sm" icon="refresh" onClick={() => setForm(true)}>
            {info.status === 'missing' ? t('admin.key.card.set') : t('admin.key.card.replace')}
          </Button>
        )
      }
    >
      <div className="adm-secret">
        <Icon name="key" />
        {info.last4 ? (
          <code aria-label={t('profile.key.lastSymbols', { symbols: spelled(info.last4) })}>{keyMask(info.last4)}</code>
        ) : (
          <span>{t('admin.key.card.noKey')}</span>
        )}
        {status}
      </div>
      <KeyValue
        items={[
          {
            key: 'checked',
            label: t('admin.key.card.checked'),
            value: info.verified_at
              ? t('admin.key.card.checkedValue', { when: formatDateTime(info.verified_at) })
              : t('admin.key.card.notChecked'),
          },
          { key: 'who', label: t('admin.key.card.who'), value: t('admin.key.card.whoValue', { count: info.users_on_key }) },
          { key: 'where', label: t('admin.key.card.where'), value: t('admin.key.card.whereValue') },
        ]}
      />
      {form && <KeyForm info={info} onDone={() => setForm(false)} />}
      <div className="adm-ext">
        <a className="adm-link" href={CONSOLE_LIMITS_URL} target="_blank" rel="noopener noreferrer">
          {t('admin.key.card.console')}
          <Icon name="arrowRight" />
        </a>
        <div className="xsmall muted">
          {budget
            ? t('admin.key.card.consoleHint', { amount: formatLimitUsd(budget.budget_usd + CONSOLE_MARGIN_USD) })
            : t('admin.key.card.consoleHintShort')}
        </div>
      </div>
    </Card>
  );
}

/**
 * Замена ключа (keyForm макета): формат на месте, затем окно с кодом 2FA. Сервер проверяет
 * код до запроса к Anthropic, и принятый код второй раз не подходит. Поэтому после любой
 * ошибки, кроме ошибки самого кода, окно закрывается: ошибка ключа — под полем, остальные
 * (нет связи с Anthropic, сбой сети) — плашкой; повтор — с новым кодом в новом окне.
 */
function KeyForm({ info, onDone }: { info: AdminKey; onDone: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const replace = useReplaceAdminKey();
  const fieldId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  // Итог запроса из окна с кодом: ключ сохранен (last4), ошибка ключа для поля или другая ошибка
  const outcome = useRef<{ last4: string | null } | { error: string } | { failure: string } | null>(null);

  useEffect(() => inputRef.current?.focus(), []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (keyProblem(value)) {
      setError(t('admin.key.card.format'));
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setFailure(null);
    setConfirming(true);
  }

  async function run(code: string) {
    outcome.current = null;
    try {
      const out = await replace.mutateAsync({ key: value.trim(), totpCode: code });
      outcome.current = { last4: out.last4 };
    } catch (err) {
      if (isApiError(err) && CODE_ERRORS.has(err.code)) throw err;
      outcome.current =
        isApiError(err) && KEY_ERRORS.has(err.code) ? { error: err.message } : { failure: errorMessage(err) };
    }
  }

  function finish() {
    const result = outcome.current;
    setConfirming(false);
    if (result && 'error' in result) {
      setError(result.error);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    if (result && 'failure' in result) {
      setFailure(result.failure);
      requestAnimationFrame(() => inputRef.current?.focus());
      return;
    }
    toast.show(t('admin.key.card.saved', { key: keyMask(result?.last4) }), { icon: 'key' });
    onDone();
  }

  return (
    <form className="adm-form" noValidate onSubmit={onSubmit}>
      <Field
        ref={inputRef}
        id={fieldId}
        type="password"
        label={t('admin.key.card.newKey')}
        hint={t('admin.key.card.newKeyHint')}
        error={error}
        placeholder={t('profile.key.setup.placeholder')}
        autoComplete="off"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setError(null);
        }}
      />
      {failure && (
        <Callout kind="bad" role="alert">
          {failure}
        </Callout>
      )}
      <div className="row">
        <Button type="submit" kind="primary" icon="check">
          {t('admin.key.card.save')}
        </Button>
        <Button kind="ghost" onClick={onDone}>
          {t('admin.confirm.cancel')}
        </Button>
      </div>
      {confirming && (
        <ConfirmDialog
          title={t('admin.key.card.confirmTitle')}
          confirmLabel={t('admin.key.card.save')}
          icon="key"
          otp
          run={run}
          onDone={finish}
          onClose={() => setConfirming(false)}
        >
          <p className="small soft">{t('admin.key.card.confirmText', { key: keyMask(info.last4) })}</p>
        </ConfirmDialog>
      )}
    </form>
  );
}

/** Дата по UTC: бюджет считается за календарный месяц UTC, как на сервере. */
function utcDay(monthStart: string, day: number): Date {
  const start = new Date(monthStart);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), day));
}

/** Порог из настроек как значение выпадающего списка (вне вариантов — 80%, как по умолчанию). */
function alertOption(pct: number): AlertPct {
  return ALERT_OPTIONS.includes(pct as AlertPct) ? (pct as AlertPct) : 80;
}

interface BudgetForm {
  monthly: string;
  alert: AlertPct;
}

function formOf(budget: { budget_usd: number; alert_pct: number }): BudgetForm {
  return { monthly: amountInput(budget.budget_usd), alert: alertOption(budget.alert_pct) };
}

/**
 * «Общий бюджет на месяц» (budgetEditCard макета): полоса, прогноз, бюджет и порог уведомления.
 * Поля начинаются со значений сервера (base). Пока их не правили, новые значения с сервера
 * (другая вкладка, другой администратор) переносятся в поля; если правили — предупреждение,
 * а не молчаливая замена чужого изменения при «Сохранить».
 */
function BudgetCard({ budget, limits }: { budget: AdminBudget; limits: AdminLimits | undefined }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateBudget();
  const server = formOf(budget);
  const [base, setBase] = useState<BudgetForm>(server);
  const [monthly, setMonthly] = useState(server.monthly);
  const [alert, setAlert] = useState<AlertPct>(server.alert);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const fieldId = useId();
  const alertId = useId();

  const total = budget.budget_usd;
  // Цвет — по порогу уведомления; доли расхода и прогноза в бюджете — с сервера
  const tone = spendTone(budget.spent_usd, total, budget.alert_pct) ?? 'good';
  const today = budget.days_in_month - budget.days_left;
  const end = formatDate(utcDay(budget.month_start, budget.days_in_month), { timeZone: 'UTC' });
  const todayText = formatDate(utcDay(budget.month_start, today), { timeZone: 'UTC' });
  const alertText = formatPercent(budget.alert_pct / 100, { digits: 0 });
  const changed = monthly.trim() !== base.monthly || alert !== base.alert;
  const moved = server.monthly !== base.monthly || server.alert !== base.alert;
  if (moved && !changed) {
    // поля не правили: сразу новые значения сервера (подстройка состояния при новых данных)
    setBase(server);
    setMonthly(server.monthly);
    setAlert(server.alert);
  }

  function takeServer() {
    setBase(server);
    setMonthly(server.monthly);
    setAlert(server.alert);
    setFieldError(null);
  }

  const limited = (limits?.members ?? []).filter(
    (m) => m.role === 'member' && m.status === 'active' && m.ai_mode === 'shared' && m.limit,
  );
  const people = limited
    .map((m) => t('admin.key.budget.person', { name: personName(m).split(/\s+/)[0], limit: formatLimitUsd(m.limit?.monthly_usd ?? 0) }))
    .join(', ');

  function onSave() {
    const checked = checkBudget(monthly, { spent: budget.spent_usd, current: budget.budget_usd });
    if (!checked.value) {
      setFieldError(
        checked.problem === 'belowSpent'
          ? t('admin.key.budget.belowSpent', { spent: formatUsd(budget.spent_usd) })
          : t('admin.key.budget.range', { min: formatLimitUsd(BUDGET_MIN), max: formatLimitUsd(BUDGET_MAX) }),
      );
      document.getElementById(fieldId)?.focus();
      return;
    }
    setError(null);
    update.mutate(
      { monthlyUsd: checked.value, alertPct: alert },
      {
        onSuccess: (out) => {
          // Поля и точка отсчета «изменено» — по сохраненному
          const saved = formOf(out);
          setBase(saved);
          setMonthly(saved.monthly);
          setAlert(saved.alert);
          toast.show(
            t('admin.key.budget.saved', {
              budget: formatLimitUsd(out.budget_usd),
              pct: formatPercent(out.alert_pct / 100, { digits: 0 }),
            }),
            { icon: 'coins' },
          );
        },
        onError: (err) => {
          if (isApiError(err) && err.code === 'ai.budget_below_spent') setFieldError(err.message);
          else setError(err);
        },
      },
    );
  }

  return (
    <Card
      id="adm-budget"
      className="adm-anchor adm-fill"
      title={t('admin.key.budget.title')}
      subtitle={t('admin.key.budget.subtitle')}
      foot={
        <Button kind="primary" icon="check" disabled={!changed} loading={update.isPending} onClick={onSave}>
          {t('admin.key.save')}
        </Button>
      }
    >
      <div className="adm-big">
        <span className="stat-value">{formatUsd(budget.spent_usd)}</span>
        <span className="adm-of">{t('admin.key.budget.of', { budget: formatLimitUsd(total) })}</span>
        <Chip kind={tone} icon={tone === 'good' ? 'check' : 'alert'}>
          {t('admin.key.budget.share', { pct: formatShare(budget.budget_share) })}
        </Chip>
      </div>
      <BudgetBar
        spent={budget.spent_usd}
        forecast={budget.forecast_usd}
        budget={total}
        alertPct={budget.alert_pct}
        label={t('admin.key.budget.barLabel', {
          spent: formatUsd(budget.spent_usd),
          budget: formatLimitUsd(total),
          forecast: formatUsd(budget.forecast_usd),
        })}
        markTitle={t('admin.key.budget.legendMark', { pct: alertText })}
        legend={[
          today > 1
            ? t('admin.key.budget.legendSpent', { date: todayText })
            : t('admin.key.budget.legendSpentDay', { date: todayText }),
          t('admin.key.budget.legendForecast', { date: end }),
          t('admin.key.budget.legendMark', { pct: alertText }),
        ]}
      />
      <dl className="adm-kv3">
        <div>
          <dt>{t('admin.key.budget.left')}</dt>
          <dd>
            {formatUsd(budget.left_usd)}
            <small>{t('admin.key.budget.until', { date: end })}</small>
          </dd>
        </div>
        <div>
          <dt>{t('admin.key.budget.daysLeft')}</dt>
          <dd>
            {t('admin.key.budget.days', { count: budget.days_left })}
            <small>{t('admin.key.budget.today', { date: todayText })}</small>
          </dd>
        </div>
        <div>
          <dt>{t('admin.key.budget.forecast')}</dt>
          <dd>
            {t('profile.key.approx', { amount: formatUsd(budget.forecast_usd) })}
            <small>{t('admin.key.budget.share', { pct: formatShare(budget.forecast_share) })}</small>
          </dd>
        </div>
      </dl>
      <div className="adm-fields two">
        <Field
          id={fieldId}
          label={t('admin.key.budget.monthly')}
          error={fieldError}
          inputMode="decimal"
          autoComplete="off"
          value={monthly}
          onChange={(e) => {
            setMonthly(e.target.value);
            setFieldError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && changed) {
              e.preventDefault();
              onSave();
            }
          }}
        />
        <FieldShell id={alertId} label={t('admin.key.budget.alert')}>
          <Dropdown
            id={alertId}
            label={t('admin.key.budget.alert')}
            options={ALERT_OPTIONS.map((value) => ({
              value: String(value),
              label: formatPercent(value / 100, { digits: 0 }),
            }))}
            value={String(alert)}
            onChange={(value) => setAlert(Number(value) as AlertPct)}
          />
        </FieldShell>
      </div>
      {moved && changed && (
        <Callout kind="warn" icon="alert">
          <b>{t('admin.key.budget.changedStrong')}</b>{' '}
          {t('admin.key.budget.changed', {
            budget: formatLimitUsd(budget.budget_usd),
            pct: formatPercent(budget.alert_pct / 100, { digits: 0 }),
          })}
          <div className="adm-callout-act">
            <Button size="sm" icon="refresh" onClick={takeServer}>
              {t('admin.key.budget.takeNew')}
            </Button>
          </div>
        </Callout>
      )}
      <HowTo>
        {limited.length
          ? t('admin.key.budget.limitsSum', { sum: formatLimitUsd(budget.members_limits_usd), people })
          : t('admin.key.budget.noLimits')}
      </HowTo>
      <HowTo>
        {t('admin.key.budget.eval', {
          spent: formatUsd(budget.eval_spent_usd),
          budget: formatLimitUsd(budget.eval_budget_usd),
        })}
      </HowTo>
      {error !== null && (
        <Callout kind="bad" role="alert">
          {errorMessage(error)}
        </Callout>
      )}
    </Card>
  );
}

/** «Что происходит на 80% и 100%» (thresholdsCard макета): порог — из настроек бюджета. */
function ThresholdsCard({ alertPct }: { alertPct: number }) {
  const { t } = useTranslation();
  const pct = formatPercent(alertPct / 100, { digits: 0 });
  const rules: { id: string; tone: 'warn' | 'bad' | null; title: string; text: ReactNode }[] = [
    { id: 'member80', tone: 'warn', title: t('admin.key.rules.member80', { pct }), text: t('admin.key.rules.member80Text') },
    { id: 'member100', tone: 'bad', title: t('admin.key.rules.member100'), text: t('admin.key.rules.member100Text') },
    { id: 'budget80', tone: 'warn', title: t('admin.key.rules.budget80', { pct }), text: t('admin.key.rules.budget80Text') },
    { id: 'budget100', tone: 'bad', title: t('admin.key.rules.budget100'), text: t('admin.key.rules.budget100Text') },
    { id: 'cap', tone: null, title: t('admin.key.rules.cap'), text: t('admin.key.rules.capText') },
  ];
  return (
    <Card title={t('admin.key.rules.title', { pct })} subtitle={t('admin.key.rules.subtitle')}>
      <ul className="adm-rules cols">
        {rules.map((rule) => (
          <li key={rule.id} className="adm-rule">
            <div className="adm-rule-k">
              <i className={rule.tone ?? undefined} aria-hidden="true" />
              {rule.title}
            </div>
            <div>{rule.text}</div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

