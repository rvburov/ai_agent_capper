import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { errorMessage, isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import {
  Button,
  Callout,
  Card,
  Chip,
  FieldShell,
  IconButton,
  KeyValue,
  describedById,
  useToast,
} from '../../components';
import { whenInline } from '../../features/admin/display';
import { amountInput, formatLimitUsd, parseAmount } from '../../features/admin/limits';
import { keyMask, keyProblem, spelled } from '../../features/ai/keyFormat';
import { modelList } from '../../features/ai/models';
import { aiErrorText, keyErrorText } from '../../features/ai/reasons';
import type { AiBudget, OwnKey } from '../../features/ai/types';
import {
  useCancelReturnRequest,
  useCheckOwnKey,
  useDeleteOwnKey,
  useReturnRequest,
  useSaveOwnKey,
  useSetAiMode,
  useSetOwnCap,
} from '../../features/ai/useOwnKey';
import i18n from '../../i18n';
import { cx } from '../../lib/cx';
import { formatUsd } from '../../lib/format';

// Ошибки сервера, которые относятся к самому ключу: показываются под полем ключа
const KEY_FIELD_ERRORS = new Set(['ai.key_format', 'ai.key_rejected', 'ai.key_models']);
// Свой потолок одного анализа (как на сервере: OWN_CAP_MIN, OWN_CAP_MAX)
const OWN_CAP_MIN = 0.1;
const OWN_CAP_MAX = 20;

/** Раскрыть «Шаги 1–7» в инструкции и прокрутить к ней. */
function openGuide() {
  const steps = document.getElementById('profile-key-steps');
  if (steps instanceof HTMLDetailsElement) steps.open = true;
  document.getElementById('profile-key-guide')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

interface OwnSetupCardProps {
  budget: AiBudget;
  /** Замена уже сохраненного ключа. */
  replacing: boolean;
  /** Растет, когда нужно прокрутить к полю ключа и поставить в него фокус («К полю ключа»). */
  focusRequest: number;
  onCancel: () => void;
  onSaved: () => void;
}

/**
 * Ввод своего ключа (ownSetupCard макета): поле-пароль с глазом, проверка формата на месте,
 * затем проверка в Anthropic на сервере (PUT /api/me/ai-key). Прошел — режим «Свой ключ».
 */
export function OwnSetupCard({ budget, replacing, focusRequest, onCancel, onSaved }: OwnSetupCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const save = useSaveOwnKey();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const inputId = 'profile-key-input';
  const hint = t('profile.key.setup.hint');

  useEffect(() => {
    if (focusRequest === 0) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById('profile-key-own')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      inputRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest]);

  function fail(message: string) {
    setError(message);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (save.isPending) return;
    const key = value.trim();
    const problem = keyProblem(key);
    // Прошлая ошибка (под полем или плашкой) уходит: на экране только итог этой попытки
    setFailure(null);
    setError(null);
    if (problem) {
      fail(problem === 'format' ? aiErrorText('ai.key_format') : t(`profile.key.setup.errors.${problem}`));
      return;
    }
    const wasShared = budget.mode === 'shared';
    // mutateAsync, а не колбэки mutate: после сохранения вкладка показывает карточку ключа, и эта
    // форма исчезает раньше, чем закончится запрос, — сообщение о сохранении все равно нужно
    save.mutateAsync(key).then(
      () => {
        setValue('');
        setShow(false);
        setError(null);
        toast.show(wasShared ? t('profile.key.setup.savedNew') : t('profile.key.setup.savedReplace'), {
          icon: 'key',
        });
        onSaved();
      },
      (err: unknown) => {
        if (isApiError(err) && KEY_FIELD_ERRORS.has(err.code)) {
          fail(err.message);
          return;
        }
        setFailure(errorMessage(err));
        // Кнопка на время запроса выключалась, и фокус ушел со страницы: вернуть его в поле
        requestAnimationFrame(() => inputRef.current?.focus());
      },
    );
  }

  let lead;
  if (budget.mode === 'shared') {
    lead = <Callout kind="info">{t('profile.key.setup.leadShared')}</Callout>;
  } else if (replacing && budget.own_key) {
    lead = (
      <Callout icon="refresh">{t('profile.key.setup.leadReplace', { key: keyMask(budget.own_key.last4) })}</Callout>
    );
  } else {
    lead = (
      <Callout kind="bad" icon="alert">
        <b>{t('profile.key.reason', { text: aiErrorText(budget.reason_code ?? 'ai.no_own_key', budget.reason_params) })}</b>{' '}
        {t('profile.key.setup.leadNoKey')}
      </Callout>
    );
  }

  return (
    <section className="card profile-anchor" id="profile-key-own" aria-labelledby={`${formId}-title`}>
      <div className="card-head">
        <div className="card-head-text">
          <h3 id={`${formId}-title`}>{replacing ? t('profile.key.setup.titleReplace') : t('profile.key.setup.title')}</h3>
          <div className="card-sub">{t('profile.key.setup.subtitle')}</div>
        </div>
      </div>
      <form id={formId} className="profile-form" noValidate onSubmit={onSubmit}>
        <div className="card-body">
          {lead}
          <FieldShell id={inputId} label={t('profile.key.setup.label')} hint={hint} error={error}>
            <div className="profile-keyinput">
              <input
                ref={inputRef}
                id={inputId}
                className={cx('input', error && 'invalid')}
                type={show ? 'text' : 'password'}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="off"
                placeholder={t('profile.key.setup.placeholder')}
                value={value}
                aria-invalid={error ? true : undefined}
                aria-describedby={describedById(inputId, hint, error)}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
              />
              <IconButton
                icon={show ? 'eyeOff' : 'eye'}
                label={show ? t('profile.key.setup.hide') : t('profile.key.setup.show')}
                kind="secondary"
                aria-pressed={show}
                aria-controls={inputId}
                onClick={() => setShow((v) => !v)}
              />
            </div>
          </FieldShell>
          <p className="xsmall muted profile-plain">
            <Trans
              i18nKey="profile.key.setup.noKey"
              components={{
                guide: (
                  <a
                    href="#profile-key-guide"
                    onClick={(e) => {
                      e.preventDefault();
                      openGuide();
                    }}
                  />
                ),
              }}
            />
          </p>
          <Callout kind="warn" icon="lock">
            <b>{t('profile.key.neverShareStrong')}</b> {t('profile.key.setup.neverShare')}
          </Callout>
          {failure && (
            <Callout kind="bad" role="alert">
              {failure}
            </Callout>
          )}
        </div>
        <div className="card-foot">
          <Button type="submit" kind="primary" icon="key" loading={save.isPending}>
            {save.isPending ? t('profile.key.setup.checking') : t('profile.key.setup.save')}
          </Button>
          {replacing && (
            <Button kind="ghost" onClick={onCancel}>
              {t('profile.key.cancel')}
            </Button>
          )}
        </div>
      </form>
    </section>
  );
}

/** Итог «Проверить» для сообщения внизу экрана: какие модели доступны или что не так. */
function checkMessage(result: OwnKey): string {
  if (result.check === 'ok') {
    return i18n.t('profile.key.own.checkOk', {
      models: modelList(result.models.filter((m) => m.available).map((m) => m.model)),
    });
  }
  return keyErrorText(result.last_error) ?? aiErrorText('ai.key_rejected');
}

interface OwnKeyCardProps {
  budget: AiBudget;
  onReplace: () => void;
}

/**
 * Свой ключ сохранен (ownKeyCard макета): последние 4 символа, расход на своем ключе, свой
 * потолок анализа, «Проверить», «Заменить ключ», «Удалить ключ» с подтверждением в карточке.
 */
export function OwnKeyCard({ budget, onReplace }: OwnKeyCardProps) {
  const { t } = useTranslation();
  const toast = useToast();
  const check = useCheckOwnKey();
  const remove = useDeleteOwnKey();
  const [confirm, setConfirm] = useState(false);
  const confirmRef = useRef<HTMLDivElement>(null);
  const key = budget.own_key;

  useEffect(() => {
    if (confirm) confirmRef.current?.querySelector<HTMLButtonElement>('.btn.danger')?.focus();
  }, [confirm]);

  if (!key) return null;
  const problem = keyErrorText(key.last_error);
  const chip = problem ? (
    <Chip kind="bad" icon="alert">
      {t('profile.key.own.broken')}
    </Chip>
  ) : key.verified_at ? (
    <Chip kind="good" icon="check">
      {t('profile.key.own.works')}
    </Chip>
  ) : (
    <Chip kind="warn" icon="alert">
      {t('profile.key.own.unverified')}
    </Chip>
  );

  function onCheck() {
    check.mutate(undefined, {
      onSuccess: (result) =>
        toast.show(checkMessage(result), { icon: result.check === 'ok' ? 'check' : 'alert' }),
      onError: (error) => toast.show(errorMessage(error), { icon: 'alert' }),
    });
  }

  function onDelete() {
    // Без ключа вкладка покажет форму ключа, а эта карточка исчезнет: сообщение — через mutateAsync
    remove.mutateAsync().then(
      () => {
        setConfirm(false);
        toast.show(t('profile.key.own.deleted'), { icon: 'trash' });
      },
      (error: unknown) => toast.show(errorMessage(error), { icon: 'alert' }),
    );
  }

  return (
    <Card
      id="profile-key-own"
      className="profile-anchor"
      title={t('profile.key.own.title')}
      subtitle={t('profile.key.setup.subtitle')}
      actions={chip}
      foot={
        confirm ? undefined : (
          <>
            <Button icon="check" loading={check.isPending} onClick={onCheck}>
              {check.isPending ? t('profile.key.own.checking') : t('profile.key.own.check')}
            </Button>
            <Button icon="refresh" onClick={onReplace}>
              {t('profile.key.own.replace')}
            </Button>
            <Button kind="ghost" icon="trash" onClick={() => setConfirm(true)}>
              {t('profile.key.own.delete')}
            </Button>
            <Link className="small profile-foot-link" to={paths.costs}>
              {t('profile.key.own.toCosts')}
            </Link>
          </>
        )
      }
    >
      <p className="profile-keyline">
        <Trans
          i18nKey={key.verified_at ? 'profile.key.own.line' : 'profile.key.own.lineUnverified'}
          values={{
            key: keyMask(key.last4),
            when: whenInline(key.verified_at),
            spent: formatUsd(budget.spent_usd),
          }}
          components={{
            code: <code aria-label={t('profile.key.lastSymbols', { symbols: spelled(key.last4) })} />,
            b: <b />,
          }}
        />
      </p>
      {problem && (
        <Callout kind="bad" icon="alert">
          <b>{t('profile.key.reason', { text: problem })}</b> {t('profile.key.own.brokenHint')}
        </Callout>
      )}
      <KeyValue
        items={[
          { key: 'payer', label: t('profile.key.own.payer'), value: t('profile.key.own.payerValue') },
          { key: 'limit', label: t('profile.key.own.limit'), value: t('profile.key.own.limitValue') },
        ]}
      />
      <OwnCapForm budget={budget} />
      <Callout kind="warn" icon="lock">
        <b>{t('profile.key.neverShareStrong')}</b> {t('profile.key.own.neverShare')}
      </Callout>
      {confirm && (
        <div className="profile-confirm" ref={confirmRef}>
          <Callout kind="warn" icon="alert">
            {t('profile.key.own.deleteWarn')}
          </Callout>
          <div className="row">
            <Button kind="danger" icon="trash" loading={remove.isPending} onClick={onDelete}>
              {t('profile.key.own.delete')}
            </Button>
            <Button kind="ghost" onClick={() => setConfirm(false)}>
              {t('profile.key.cancel')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/** «Свой потолок на один анализ, $» — от $0,10 до $20 (PUT /api/me/ai-cap). */
function OwnCapForm({ budget }: { budget: AiBudget }) {
  const { t } = useTranslation();
  const toast = useToast();
  const setCap = useSetOwnCap();
  const [value, setValue] = useState(() => amountInput(budget.own_cap_usd));
  const [error, setError] = useState<string | null>(null);
  const id = 'profile-key-cap';
  const hint =
    budget.avg_analysis_usd !== null
      ? t('profile.key.cap.hint', { avg: formatUsd(budget.avg_analysis_usd) })
      : t('profile.key.cap.hintNoAvg');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (setCap.isPending) return;
    const amount = parseAmount(value);
    if (amount === null || amount < OWN_CAP_MIN || amount > OWN_CAP_MAX) {
      setError(t('profile.key.cap.range', { min: formatUsd(OWN_CAP_MIN), max: formatLimitUsd(OWN_CAP_MAX) }));
      return;
    }
    setCap.mutate((Math.round(amount * 100) / 100).toFixed(2), {
      onSuccess: (out) => {
        setValue(amountInput(out.per_analysis_usd));
        toast.show(t('profile.key.cap.saved', { amount: formatUsd(out.per_analysis_usd) }), { icon: 'check' });
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <form noValidate onSubmit={onSubmit}>
      <FieldShell id={id} label={t('profile.key.cap.label')} hint={hint} error={error}>
        <div className="profile-cap">
          <input
            id={id}
            className={cx('input', error && 'invalid')}
            inputMode="decimal"
            autoComplete="off"
            value={value}
            aria-invalid={error ? true : undefined}
            aria-describedby={describedById(id, hint, error)}
            onChange={(e) => {
              setValue(e.target.value);
              setError(null);
            }}
          />
          <Button type="submit" icon="check" loading={setCap.isPending}>
            {t('profile.key.cap.save')}
          </Button>
        </div>
      </FieldShell>
    </form>
  );
}

/**
 * Вернуться на ключ администратора (returnCard макета): участнику — только просьбой (Р12),
 * ответ придет уведомлением; администратор (если оказался на своем ключе) — сразу.
 */
export function ReturnCard({ budget, admin }: { budget: AiBudget; admin: boolean }) {
  const { t } = useTranslation();
  const toast = useToast();
  const request = useReturnRequest();
  const cancel = useCancelReturnRequest();
  const setMode = useSetAiMode();
  const onError = (error: unknown) => toast.show(errorMessage(error), { icon: 'alert' });

  if (admin) {
    return (
      <Card
        id="profile-key-return"
        className="profile-anchor"
        title={t('profile.key.ret.title')}
        subtitle={t('profile.key.ret.subtitleAdmin')}
        foot={
          <Button
            kind="primary"
            icon="refresh"
            loading={setMode.isPending}
            onClick={() =>
              // после переключения эта карточка исчезает: сообщение — через mutateAsync
              setMode.mutateAsync('shared').then(() => toast.show(t('profile.key.ret.adminDone'), { icon: 'check' }), onError)
            }
          >
            {t('profile.key.ret.title')}
          </Button>
        }
      >
        <p className="small soft profile-plain">{t('profile.key.ret.adminText')}</p>
      </Card>
    );
  }

  const requested = budget.return_requested_at;
  const hasKey = budget.own_key !== null;
  return (
    <Card
      id="profile-key-return"
      className="profile-anchor"
      title={t('profile.key.ret.title')}
      subtitle={t('profile.key.ret.subtitle')}
      actions={
        requested ? (
          <Chip kind="info" icon="clock">
            {t('profile.key.ret.waiting')}
          </Chip>
        ) : undefined
      }
      foot={
        requested ? (
          <Button
            kind="ghost"
            icon="x"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: () => toast.show(t('profile.key.ret.cancelled'), { icon: 'x' }),
                onError,
              })
            }
          >
            {t('profile.key.ret.cancel')}
          </Button>
        ) : (
          <Button
            kind="primary"
            icon="send"
            loading={request.isPending}
            onClick={() =>
              request.mutate(undefined, {
                onSuccess: () => toast.show(t('profile.key.ret.sent'), { icon: 'send' }),
                onError,
              })
            }
          >
            {t('profile.key.ret.ask')}
          </Button>
        )
      }
    >
      {requested ? (
        <Callout kind="info" icon="clock">
          <b>{t('profile.key.ret.sentStrong', { when: whenInline(requested) })}</b>{' '}
          {t('profile.key.ret.sentText')} {hasKey ? t('profile.key.ret.meanwhileKey') : t('profile.key.ret.meanwhileNoKey')}
        </Callout>
      ) : (
        <>
          {!hasKey && (
            <Callout kind="bad" icon="alert">
              <b>{t('profile.key.reason', { text: aiErrorText(budget.reason_code ?? 'ai.no_own_key', budget.reason_params) })}</b>{' '}
              {t('profile.key.ret.noKey')}
            </Callout>
          )}
          <p className="small soft profile-plain">{t('profile.key.ret.text')}</p>
          <p className="xsmall muted profile-plain">{t('profile.key.ret.limitAfter')}</p>
        </>
      )}
    </Card>
  );
}
