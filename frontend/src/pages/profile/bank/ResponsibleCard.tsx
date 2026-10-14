import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../api/errors';
import { Button, Callout, Chip, Field, Meter, Segmented, Skeleton, useToast } from '../../../components';
import { apiErrorText } from '../../../features/analysis/codes';
import {
  cancelPendingBody,
  isPauseDays,
  parseLimits,
  pauseLastDay,
  pausePreviewDay,
  pendingParts,
  sameAsCurrent,
  savedOutcome,
  usageKind,
  usePlayLimits,
  useSavePlayLimits,
  useTakePause,
  type LimitFieldError,
  type PauseDays,
} from '../../../features/bank/playLimits';
import type { PlayLimits } from '../../../features/bank/types';
import { currencyOf } from '../../../features/bets/display';
import {
  currencySign,
  formatAmountInput,
  formatDateLong,
  formatDateTime,
  formatDayMonth,
  formatMoney,
  formatNumber,
} from '../../../lib/format';
import { LoadError } from '../LoadError';

// «Ответственная игра» (responsibleCard макета, В8): лимиты числа и суммы ставок в день,
// сколько поставлено сегодня, ждущее повышение и пауза 1/7/30/90 дней. Проверяет сервер:
// GET/PUT /api/me/play-limits, POST /api/me/pause. Пустое поле лимита — без лимита.

function draftOf(limits: PlayLimits) {
  const currency = currencyOf(limits.currency);
  return {
    count: limits.bets_per_day === null ? '' : String(limits.bets_per_day),
    amount: limits.stake_per_day === null ? '' : formatAmountInput(limits.stake_per_day, currency),
  };
}

/** Текст «момента» внутри фразы: «завтра, 00:00», «16 окт, 00:00». */
function inlineMoment(value: string): string {
  const text = formatDateTime(value);
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function ResponsibleCard({ tz }: { tz: string }) {
  const { t } = useTranslation();
  const query = usePlayLimits();
  return (
    <section className="card profile-anchor profile-rg" id="profile-rg" aria-labelledby="profile-rg-title">
      <div className="card-head">
        <div className="card-head-text">
          <div className="eyebrow">{t('profile.bank.rg.eyebrow')}</div>
          <h3 id="profile-rg-title">{t('profile.bank.rg.title')}</h3>
          <div className="card-sub">{t('profile.bank.rg.subtitle')}</div>
        </div>
        {query.data && (
          <div className="row">
            <StateChip limits={query.data} />
          </div>
        )}
      </div>
      {query.data ? (
        <ResponsibleForm limits={query.data} tz={tz} />
      ) : query.error ? (
        <div className="card-body">
          <LoadError error={query.error} onRetry={() => void query.refetch()} />
        </div>
      ) : (
        <div className="card-body">
          <Skeleton lines={4} />
        </div>
      )}
    </section>
  );
}

function StateChip({ limits }: { limits: PlayLimits }) {
  const { t } = useTranslation();
  if (limits.paused_until) {
    return (
      <Chip kind="warn" icon="pause">
        {t('profile.bank.rg.chipPause')}
      </Chip>
    );
  }
  if (limits.bets_per_day !== null || limits.stake_per_day !== null) {
    return (
      <Chip kind="good" icon="shield">
        {t('profile.bank.rg.chipOn')}
      </Chip>
    );
  }
  return <Chip kind="outline">{t('profile.bank.rg.chipNone')}</Chip>;
}

function Usage({ label, value, max, text }: { label: string; value: number; max: number | null; text: string }) {
  return (
    <div>
      <div className="row-between profile-usage-row">
        <span>{label}</span>
        <b>{text}</b>
      </div>
      {max !== null && <Meter value={value} max={max} label={label} valueText={text} kind={usageKind(value, max)} />}
    </div>
  );
}

function ResponsibleForm({ limits, tz }: { limits: PlayLimits; tz: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSavePlayLimits();
  const pause = useTakePause();
  const countId = useId();
  const amountId = useId();
  const currency = currencyOf(limits.currency);
  const money = (value: string | null) => formatMoney(value, currency);
  const [draft, setDraft] = useState(() => draftOf(limits));
  const [errors, setErrors] = useState<LimitFieldError[]>([]);
  const [serverError, setServerError] = useState<unknown>(null);
  const days = limits.pause_days.filter(isPauseDays);
  const [pauseDays, setPauseDays] = useState<PauseDays>(days.includes(7) ? 7 : (days[0] ?? 7));
  const [confirm, setConfirm] = useState(false);
  const busy = useRef(false);
  const confirmRef = useRef<HTMLButtonElement>(null);

  // Лимиты на сервере изменились (другая вкладка, вступило повышение, сменилась валюта) — поля
  // показывают новые; пока человек правит поле, его ввод не трогаем
  const shownKey = `${limits.bets_per_day}|${limits.stake_per_day}|${limits.currency}`;
  const lastKey = useRef(shownKey);
  useEffect(() => {
    if (lastKey.current === shownKey) return;
    lastKey.current = shownKey;
    setDraft(draftOf(limits));
    setErrors([]);
  }, [shownKey, limits]);

  useEffect(() => {
    if (confirm) confirmRef.current?.focus({ preventScroll: true });
  }, [confirm]);

  async function submit() {
    const parsed = parseLimits(draft, limits.bets_per_day_max);
    if ('errors' in parsed) {
      setErrors(parsed.errors);
      return;
    }
    if (busy.current) return;
    setErrors([]);
    // Поля не меняли — запрос не нужен: тот же PUT отменил бы ждущее повышение
    if (sameAsCurrent(parsed.body, limits)) {
      setServerError(null);
      toast.show(t('profile.bank.rg.saved.same'), { icon: 'info' });
      return;
    }
    busy.current = true;
    setServerError(null);
    try {
      const after = await save.mutateAsync({ ...parsed.body, currency: limits.currency });
      lastKey.current = `${after.bets_per_day}|${after.stake_per_day}|${after.currency}`;
      setDraft(draftOf(after));
      const outcome = savedOutcome(limits, after);
      if (outcome === 'pending' || outcome === 'pendingAndLowered') {
        const when = after.pending ? inlineMoment(after.pending.starts_at) : '';
        toast.show(t(`profile.bank.rg.saved.${outcome}`, { when }), { icon: 'clock' });
      } else if (outcome === 'cancelled') {
        toast.show(t('profile.bank.rg.pendingCancelled'), { icon: 'x' });
      } else {
        toast.show(t(`profile.bank.rg.saved.${outcome}`), { icon: outcome === 'same' ? 'info' : 'shield' });
      }
    } catch (error) {
      setServerError(error);
    } finally {
      busy.current = false;
    }
  }

  async function cancelPending() {
    if (busy.current) return;
    busy.current = true;
    setServerError(null);
    try {
      await save.mutateAsync(cancelPendingBody(limits));
      toast.show(t('profile.bank.rg.pendingCancelled'), { icon: 'x' });
    } catch (error) {
      setServerError(error);
    } finally {
      busy.current = false;
    }
  }

  async function takePause() {
    if (busy.current) return;
    busy.current = true;
    setServerError(null);
    try {
      const after = await pause.mutateAsync(pauseDays);
      setConfirm(false);
      const until = after.paused_until ? formatDayMonth(pauseLastDay(after.paused_until)) : '';
      toast.show(t('profile.bank.rg.pauseTaken', { date: until }), { icon: 'pause' });
    } catch (error) {
      setServerError(error);
      setConfirm(false);
    } finally {
      busy.current = false;
    }
  }

  const today = limits.today;
  const countText =
    limits.bets_per_day !== null
      ? t('profile.bank.rg.usageOf', { value: formatNumber(today.bets), max: formatNumber(limits.bets_per_day) })
      : t('profile.bank.rg.usageFree', { value: formatNumber(today.bets) });
  const amountText =
    limits.stake_per_day !== null
      ? t('profile.bank.rg.usageOf', { value: money(today.stake), max: money(limits.stake_per_day) })
      : t('profile.bank.rg.usageFree', { value: money(today.stake) });
  const pending = pendingParts(limits);
  const pendingText = [
    pending.count !== undefined &&
      (pending.count === null ? t('profile.bank.rg.pendingNoCount') : t('profile.bank.rg.pendingCount', { count: pending.count })),
    pending.amount !== undefined &&
      (pending.amount === null ? t('profile.bank.rg.pendingNoAmount') : t('profile.bank.rg.pendingAmount', { amount: money(pending.amount) })),
  ].filter((part): part is string => typeof part === 'string' && part !== '');
  const blocked = limits.blocked === 'bets_limit' || limits.blocked === 'stake_limit' ? limits.blocked : null;
  const serverText = serverError ? apiErrorText(serverError) : null;
  const currencyChanged = isApiError(serverError) && serverError.code === 'common.currency_changed';

  return (
    <form
      className="profile-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="card-body">
        <div className="profile-usage">
          <Usage label={t('profile.bank.rg.usageBets')} value={today.bets} max={limits.bets_per_day} text={countText} />
          <Usage
            label={t('profile.bank.rg.usageStake')}
            value={Number(today.stake)}
            max={limits.stake_per_day === null ? null : Number(limits.stake_per_day)}
            text={amountText}
          />
        </div>
        {blocked && limits.blocked_until && (
          <Callout kind="warn" role="note">
            {t(`profile.bank.rg.blocked.${blocked}`, { until: inlineMoment(limits.blocked_until) })}
          </Callout>
        )}
        {limits.tz !== tz && (
          <p className="xsmall muted profile-rg-tz">{t('profile.bank.rg.oldTz', { tz: limits.tz, until: inlineMoment(today.ends_at) })}</p>
        )}
        <div className="profile-fields bottom">
          <Field
            id={countId}
            label={t('profile.bank.rg.count')}
            inputMode="numeric"
            autoComplete="off"
            placeholder={t('profile.bank.rg.noLimit')}
            value={draft.count}
            error={errors.includes('count') ? t('profile.bank.rg.countError', { max: limits.bets_per_day_max }) : undefined}
            onChange={(event) => {
              setDraft((d) => ({ ...d, count: event.target.value }));
              setErrors([]);
            }}
          />
          <Field
            id={amountId}
            label={t('profile.bank.rg.amount')}
            inputMode="decimal"
            autoComplete="off"
            suffix={currencySign(currency)}
            placeholder={t('profile.bank.rg.noLimit')}
            value={draft.amount}
            error={errors.includes('amount') ? t('profile.bank.rg.amountError') : undefined}
            onChange={(event) => {
              setDraft((d) => ({ ...d, amount: event.target.value }));
              setErrors([]);
            }}
          />
        </div>
        <p className="xsmall muted">{t('profile.bank.rg.rules')}</p>
        {limits.pending && pendingText.length > 0 && (
          <Callout kind="info" icon="clock">
            <div className="stack profile-tight">
              <div>
                {t('profile.bank.rg.pending', { what: pendingText.join(t('profile.bank.rg.and')), when: inlineMoment(limits.pending.starts_at) })}
              </div>
              <div className="row">
                <Button kind="ghost" size="sm" loading={save.isPending} onClick={() => void cancelPending()}>
                  {t('profile.bank.rg.cancelPending')}
                </Button>
              </div>
            </div>
          </Callout>
        )}
        {serverText && (
          <Callout kind="bad" role="alert">
            {currencyChanged ? `${serverText}. ${t('profile.bank.rg.currencyReloaded')}` : serverText}
          </Callout>
        )}
        <hr className="divider" />
        <h4>{t('profile.bank.rg.pauseTitle')}</h4>
        {limits.paused_until ? (
          <Callout kind="accent" icon="pause">
            <b>{t('profile.bank.rg.pausedUntil', { date: formatDateLong(pauseLastDay(limits.paused_until)) })}</b>{' '}
            {t('profile.bank.rg.pausedText')}
          </Callout>
        ) : (
          <div className="stack profile-tight">
            <p className="small soft">{t('profile.bank.rg.pauseText')}</p>
            <Segmented<string>
              label={t('profile.bank.rg.pauseLabel')}
              items={days.map((value) => ({ value: String(value), label: t('profile.bank.rg.days', { count: value }) }))}
              value={String(pauseDays)}
              onChange={(value) => {
                const n = Number(value);
                if (isPauseDays(n)) setPauseDays(n);
                setConfirm(false);
              }}
            />
            {confirm ? (
              <div className="profile-confirm">
                <Callout kind="warn" role="alert">
                  <b>{t('profile.bank.rg.confirmUntil', { date: formatDateLong(pausePreviewDay(pauseDays, tz)) })}</b>{' '}
                  {t('profile.bank.rg.confirmText')}
                </Callout>
                <div className="row">
                  <Button ref={confirmRef} kind="primary" icon="pause" loading={pause.isPending} onClick={() => void takePause()}>
                    {t('profile.bank.rg.confirmYes')}
                  </Button>
                  <Button kind="ghost" onClick={() => setConfirm(false)}>
                    {t('profile.form.cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="row">
                <Button icon="pause" onClick={() => setConfirm(true)}>
                  {t('profile.bank.rg.takePause', { days: t('profile.bank.rg.days', { count: pauseDays }) })}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="card-foot">
        <Button type="submit" icon="check" loading={save.isPending}>
          {t('profile.bank.rg.save')}
        </Button>
      </div>
    </form>
  );
}
