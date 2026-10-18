import type { TFunction } from 'i18next';
import { useQueryClient } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Dropdown,
  Field,
  FieldShell,
  Icon,
  KeyValue,
  Skeleton,
  describedById,
  useToast,
} from '../../components';
import {
  CURRENCIES,
  PREVIEW_DELAY_MS,
  formatRate,
  isCurrencyStale,
  lastRateFor,
  parseRate,
  ratePair,
  refreshAfterCurrency,
  useAdminSettings,
  useChangeCurrency,
  useCurrencyPreview,
  useUpdateDefaultTz,
  type AdminSettings,
  type CurrencyPreview,
} from '../../features/admin/settings';
import { useDebounced } from '../../features/players/api';
import { timeZoneName, timeZoneOptions } from '../../features/profile/timezones';
import { currencySign, formatDateLong, formatMoney, type Currency } from '../../lib/format';
import { ConfirmDialog, HowTo, LoadError } from './parts';
import './SettingsTab.css';

// Новые рынки (Р28) — отдельным файлом: экран «Администрирование» близок к бюджету JS
const MarketsAdminCard = lazy(() => import('./MarketsAdminCard'));

/**
 * «Администрирование → Настройки» (PANELS.settings макета admin.js): валюта программы со сменой
 * по курсу (Р17, Т30), часовой пояс по умолчанию для новых участников и сведения о сервере.
 * Что станет с суммами, считает сервер; сумм участников окно не показывает (Р14).
 */
export function SettingsTab() {
  const settings = useAdminSettings();

  if (settings.isError) {
    return (
      <Card>
        <LoadError error={settings.error} onRetry={() => void settings.refetch()} />
      </Card>
    );
  }
  if (!settings.data) {
    return (
      <div className="adm-main" aria-busy="true">
        <Card>
          <Skeleton lines={4} />
        </Card>
        <Card>
          <Skeleton lines={2} />
        </Card>
      </div>
    );
  }
  return (
    <div className="adm-main adm-settings">
      <div className="adm-col">
        <CurrencyCard settings={settings.data} />
      </div>
      <div className="adm-col">
        <TzCard settings={settings.data} />
        <Suspense
          fallback={
            <Card>
              <Skeleton lines={4} />
            </Card>
          }
        >
          <MarketsAdminCard />
        </Suspense>
        <ServerCard />
      </div>
    </div>
  );
}

/** Курс для текста: «1 € = 95,12 ₽». */
function rateText(
  t: TFunction,
  rate: string,
  base: Currency,
  quote: Currency,
): string {
  return t('admin.settings.currency.rate', {
    base: currencySign(base),
    value: formatRate(rate),
    quote: currencySign(quote),
  });
}

function CurrencyCard({ settings }: { settings: AdminSettings }) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<Currency | null>(null);
  const current = settings.currency;
  const change = settings.currency_changed;
  // Запись журнала — о текущей валюте (иначе «с какой даты» неверно)
  const since = change && change.to_currency === current ? change : null;

  let sinceText: string | null = null;
  if (since) {
    const quote = since.rate_base === since.from_currency ? since.to_currency : since.from_currency;
    const params = {
      date: formatDateLong(since.at),
      actor: since.actor_name ?? '',
      rate: rateText(t, since.rate, since.rate_base, quote),
    };
    sinceText = since.actor_name
      ? t('admin.settings.currency.since', params)
      : t('admin.settings.currency.sinceNoActor', params);
  }

  return (
    <Card
      className="adm-fill"
      title={t('admin.settings.currency.title')}
      subtitle={t('admin.settings.currency.subtitle')}
    >
      <div className="stack">
        <div className="adm-cur-now">
          <span className="adm-cur-sym" aria-hidden="true">
            {currencySign(current)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="adm-cur-name">{t(`admin.settings.currency.names.${current}`)}</div>
            {sinceText && <div className="xsmall muted">{sinceText}</div>}
          </div>
        </div>
        <p className="small soft">{t('admin.settings.currency.text')}</p>
        <div className="adm-choices three" role="group" aria-label={t('admin.settings.currency.group')}>
          {CURRENCIES.map((code) => (
            <button
              key={code}
              type="button"
              className="adm-choice"
              aria-pressed={code === current}
              data-cur={code}
              onClick={() => {
                if (code !== current) setTarget(code);
              }}
            >
              <span className="adm-choice-sym" aria-hidden="true">
                {currencySign(code)}
              </span>
              <span>
                <b>{t(`admin.settings.currency.names.${code}`)}</b>
                <small>
                  {code === current ? t('admin.settings.currency.now') : t('admin.settings.currency.manual')}
                </small>
              </span>
            </button>
          ))}
        </div>
        <KeyValue
          items={[
            { label: t('admin.settings.currency.books'), value: t('admin.settings.currency.booksValue') },
            {
              label: t('admin.settings.currency.market'),
              value: (
                <span>
                  {t('admin.settings.currency.marketValue')}
                  <small className="xsmall muted adm-kv-note">{t('admin.settings.currency.marketHint')}</small>
                </span>
              ),
            },
          ]}
        />
      </div>
      {target && (
        <CurrencyDialog settings={settings} to={target} onClose={() => setTarget(null)} />
      )}
    </Card>
  );
}

interface CurrencyDialogProps {
  settings: AdminSettings;
  to: Currency;
  onClose: () => void;
}

/**
 * Окно смены валюты (currencyModal макета): курс, что станет с суммами (сервер, preview),
 * предупреждение, «Понимаю» и код 2FA. Кнопка доступна, когда сервер посчитал предпросмотр
 * по введенному курсу и суммы помещаются в учет. Исходная валюта запоминается при открытии и
 * уходит на сервер: если валюту за это время сменили (другой администратор, другая вкладка),
 * окно закрывается с объяснением — курс введен для другой пары.
 */
function CurrencyDialog({ settings, to, onClose }: CurrencyDialogProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useQueryClient();
  const [from] = useState(settings.currency);
  const pair = ratePair(from, to);
  const closed = useRef(false);
  // Своя смена идет: валюта в настройках сменится до конца запроса — это не чужая смена
  const applying = useRef(false);
  const closeStale = (message: string) => {
    if (closed.current) return;
    closed.current = true;
    toast.show(t('admin.settings.dialog.stale', { message }), { icon: 'alert' });
    onClose();
  };
  const [text, setText] = useState(() => lastRateFor(settings.currency_changed, pair));
  const [touched, setTouched] = useState(false);
  const [ack, setAck] = useState(false);
  const change = useChangeCurrency();
  const rate = parseRate(text);
  const settled = useDebounced(rate, PREVIEW_DELAY_MS);
  const preview = useCurrencyPreview(from, to, settled, pair.base, settled === rate);
  const fresh = rate !== null && settled === rate && preview.isSuccess ? preview.data : null;
  const now = settings.currency;
  const previewStale = preview.isError && isCurrencyStale(preview.error) ? preview.error : null;
  useEffect(() => {
    if (previewStale) {
      void refreshAfterCurrency(client);
      closeStale(errorMessage(previewStale));
    } else if (now !== from && !applying.current) {
      closeStale(t('errors.common.currency_changed', { currency: currencySign(now) }));
    }
    // closeStale — новая функция на каждый рендер, повторный вызов отсекает closed
  }, [previewStale, now, from]);
  const ready = ack && fresh !== null && !fresh.overflow;
  const fieldId = 'adm-rate';
  const showError = touched && text.trim() !== '' && rate === null;
  const hint =
    from === 'RUB' || to === 'RUB' ? t('admin.settings.dialog.hintRub') : t('admin.settings.dialog.hintOther');

  return (
    <ConfirmDialog
      title={t('admin.settings.dialog.title')}
      confirmLabel={t('admin.settings.dialog.go')}
      icon="currency"
      otp
      ready={ready}
      run={(totpCode) => {
        if (rate === null) return Promise.reject(new Error('rate'));
        applying.current = true;
        return change.mutateAsync({ from, currency: to, rate, base: pair.base, totpCode }).catch((err: unknown) => {
          applying.current = false;
          if (isCurrencyStale(err)) closeStale(errorMessage(err));
          throw err;
        });
      }}
      onDone={() => {
        toast.show(
          t('admin.settings.dialog.done', { name: t(`admin.settings.currency.lower.${to}`) }),
          { icon: 'currency' },
        );
        onClose();
      }}
      onClose={onClose}
    >
      <div className="adm-swap">
        <span>
          {currencySign(from)} {t(`admin.settings.currency.names.${from}`)}
        </span>
        <Icon name="arrowRight" />
        <span>
          {currencySign(to)} {t(`admin.settings.currency.names.${to}`)}
        </span>
      </div>
      <Field
        id={fieldId}
        label={t('admin.settings.dialog.rateLabel', { sym: currencySign(pair.base) })}
        value={text}
        inputMode="decimal"
        autoComplete="off"
        suffix={currencySign(pair.quote)}
        hint={hint}
        error={showError ? t('admin.settings.dialog.rateError') : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={() => setTouched(true)}
      />
      <CurrencyPreviewBox
        rate={rate}
        preview={fresh}
        loading={rate !== null && fresh === null && !preview.isError}
        error={rate !== null && settled === rate && preview.isError ? preview.error : null}
      />
      <Callout kind="warn" icon="alert">
        <Trans i18nKey="admin.settings.dialog.warn" components={{ b: <b /> }} />
      </Callout>
      <Checkbox label={t('admin.settings.dialog.ack')} checked={ack} onChange={setAck} />
    </ConfirmDialog>
  );
}

interface PreviewBoxProps {
  rate: string | null;
  preview: CurrencyPreview | null;
  loading: boolean;
  error: unknown;
}

/**
 * Что станет с суммами — числа сервера: ваш банк, пример, сколько сумм пересчитается. Валюты
 * подписей — из ответа сервера (from_currency, to_currency), а не из окна.
 */
function CurrencyPreviewBox({ rate, preview, loading, error }: PreviewBoxProps) {
  const { t } = useTranslation();
  let body;
  if (rate === null) {
    body = <span>{t('admin.settings.dialog.previewEmpty')}</span>;
  } else if (error) {
    body = <span>{errorMessage(error)}</span>;
  } else if (loading || !preview) {
    body = <span>{t('admin.settings.dialog.previewLoading')}</span>;
  } else {
    const sample = preview.samples[1] ?? preview.samples[0];
    const from = preview.from_currency;
    const to = preview.to_currency;
    body = (
      <>
        {preview.own_bank && (
          <span>
            <Trans
              i18nKey="admin.settings.dialog.ownBank"
              values={{
                before: formatMoney(preview.own_bank.before, from),
                after: formatMoney(preview.own_bank.after, to),
              }}
              components={{ b: <b /> }}
            />
          </span>
        )}
        {sample && (
          <span>
            <Trans
              i18nKey="admin.settings.dialog.sample"
              values={{ before: formatMoney(sample.before, from), after: formatMoney(sample.after, to) }}
              components={{ b: <b /> }}
            />
          </span>
        )}
        <span>
          {t('admin.settings.dialog.counts', {
            bets: t('admin.settings.dialog.bets', { count: preview.bets }),
            ledger: t('admin.settings.dialog.ledger', { count: preview.ledger_entries }),
            analyses: t('admin.settings.dialog.analyses', { count: preview.analyses }),
            limits: t('admin.settings.dialog.limits', { count: preview.play_limits }),
          })}
        </span>
        {preview.members > 0 && <span>{t('admin.settings.dialog.members', { count: preview.members })}</span>}
        {preview.corrections > 0 && (
          <span>{t('admin.settings.dialog.corrections', { count: preview.corrections })}</span>
        )}
      </>
    );
  }
  return (
    <>
      <div className="adm-preview" aria-live="polite">
        {body}
      </div>
      {preview?.overflow && (
        <Callout kind="bad" role="alert">
          {t('admin.settings.dialog.overflow')}
        </Callout>
      )}
    </>
  );
}

/** Часовой пояс для новых участников (tzCard макета): Dropdown и «Сохранить». */
function TzCard({ settings }: { settings: AdminSettings }) {
  const { t } = useTranslation();
  const toast = useToast();
  const update = useUpdateDefaultTz();
  const [tz, setTz] = useState(settings.default_tz);
  const [error, setError] = useState<string | null>(null);
  const options = useMemo(
    () => timeZoneOptions(t, settings.default_tz, { browser: null }),
    [t, settings.default_tz],
  );
  const dirty = tz !== settings.default_tz;
  const hint = t('admin.settings.tz.hint');
  const fieldId = 'adm-tz';

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!dirty || update.isPending) return;
    update.mutate(tz, {
      onSuccess: (saved) =>
        toast.show(t('admin.settings.tz.done', { zone: timeZoneName(t, saved.default_tz) }), { icon: 'clock' }),
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <section className="card" aria-labelledby="adm-tz-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="adm-tz-title">{t('admin.settings.tz.title')}</h3>
          <div className="card-sub">{t('admin.settings.tz.subtitle')}</div>
        </div>
      </div>
      <form noValidate onSubmit={onSubmit}>
        <div className="card-body">
          <FieldShell id={fieldId} label={t('admin.settings.tz.label')} hint={hint} error={error}>
            <Dropdown
              id={fieldId}
              label={t('admin.settings.tz.label')}
              options={options}
              value={tz}
              invalid={Boolean(error)}
              describedBy={describedById(fieldId, hint, error)}
              onChange={(value) => {
                setTz(value);
                setError(null);
              }}
            />
          </FieldShell>
        </div>
        <div className="card-foot">
          <Button kind="primary" size="sm" type="submit" icon="check" disabled={!dirty} loading={update.isPending}>
            {t('admin.settings.tz.save')}
          </Button>
        </div>
      </form>
    </section>
  );
}

/** Сведения о сервере (serverCard макета): только для информации. */
function ServerCard() {
  const { t } = useTranslation();
  return (
    <Card title={t('admin.settings.server.title')} subtitle={t('admin.settings.server.subtitle')}>
      <div className="stack">
        <KeyValue
          items={[
            { label: t('admin.settings.server.where'), value: t('admin.settings.server.whereValue') },
            { label: t('admin.settings.server.backups'), value: t('admin.settings.server.backupsValue') },
            { label: t('admin.settings.server.time'), value: t('admin.settings.server.timeValue') },
            { label: t('admin.settings.server.language'), value: t('admin.settings.server.languageValue') },
          ]}
        />
        <HowTo>{t('admin.settings.server.note')}</HowTo>
      </div>
    </Card>
  );
}
