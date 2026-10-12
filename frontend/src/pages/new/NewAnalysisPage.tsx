import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router';

import { isApiError } from '../../api/errors';
import { useMe } from '../../api/hooks/useMe';
import { paths } from '../../app/paths';
import { Button, Callout, Skeleton, StickyActionBar, Stepper, Tabs, useToast } from '../../components';
import {
  useAiAccess,
  useAnalysis,
  useBank,
  useBookmakers,
  useCreateAnalysis,
  usePreview,
  useRunAnalysis,
  useStrategy,
} from '../../features/analysis/api';
import { amountForApi, parseAmount } from '../../features/analysis/amount';
import { apiErrorText } from '../../features/analysis/codes';
import {
  blankEvent,
  eventsFromDraft,
  fromConfirmedEvent,
  toEventIn,
  type EditEvent,
} from '../../features/analysis/draft';
import { clearDraft, emptyDraft, loadDraft, saveDraft, type DraftState, type InputTab } from '../../features/analysis/draftStore';
import { isParseFailed, type Analysis } from '../../features/analysis/types';
import { useDebounced } from '../../features/players/api';
import { usePublicSettings } from '../../features/profile/usePublicSettings';
import { currencySign, formatAmountInput, formatEstimate, formatUsd, type Currency } from '../../lib/format';
import { cx } from '../../lib/cx';
import { eventTitle } from './EventCard';
import { FormatModal } from './FormatModal';
import { FormPanel, TextPanel } from './InputPanels';
import { LaunchCard } from './LaunchCard';
import { FlowCard, RecentCard, RulesCard } from './SideCards';
import { summarize } from './summary';
import './new.css';

/*
 * «Новый анализ» (mockup/js/screens/new-analysis.js): события текстом (разбор Claude Haiku на
 * сервере) или формой, проверка игроков и кэфов, «Перед запуском» по расчету сервера
 * (POST /analyses/{id}/preview), запуск — POST /analyses/{id}/run и переход на /analysis/:id.
 * Черновик живет в draftStore (уход со страницы, перезагрузка вкладки); адрес /new?draft=ID
 * указывает анализ на сервере.
 */

const PREVIEW_DELAY_MS = 400;

function focusLater(id: string) {
  window.requestAnimationFrame(() => document.getElementById(id)?.focus());
}

/** Черновик из анализа на сервере: разбор (текст), пустая форма или подтвержденные события. */
function draftFromAnalysis(analysis: Analysis): DraftState {
  const base = emptyDraft();
  const draft = analysis.draft;
  const parseFailed = isParseFailed(analysis);
  const launched = analysis.status !== 'needs_confirmation' && !parseFailed;
  const parsed = analysis.input_kind === 'text' && draft !== null && analysis.status === 'needs_confirmation';
  const events = launched ? analysis.events.map(fromConfirmedEvent) : eventsFromDraft(draft);
  const currency = (draft?.currency ?? 'RUB') as Currency;
  const bank = launched ? analysis.bank : (draft?.bank ?? null);
  return {
    ...base,
    // Сбой разбора: анализ без событий, «Разобрать» создаст новый — к нему не привязываемся
    analysisId: parseFailed ? null : analysis.id,
    launched,
    tab: analysis.input_kind === 'form' || (launched && analysis.input_kind !== 'text') ? 'form' : 'text',
    text: analysis.input_text,
    parsedText: parsed || launched ? analysis.input_text : null,
    parse:
      parsed && draft
        ? {
            bank: draft.bank,
            ledgerBank: draft.ledger_bank,
            currency: draft.currency,
            bankNoteKey: draft.bank_note_key,
            bookmaker: draft.bookmaker,
            unknown: draft.unknown_lines,
            costUsd: draft.parse_cost_usd,
            warnings: draft.warnings,
          }
        : null,
    bank: bank ? formatAmountInput(bank, currency) : '',
    bookmaker: launched ? analysis.bookmaker : (draft?.bookmaker ?? null),
    events,
  };
}

/** Начальное состояние: черновик вкладки (того же участника) или анализ по адресу. */
function initialDraft(draftParam: number | null, userId: number | null): { state: DraftState; loadId: number | null } {
  const stored = loadDraft(userId);
  if (draftParam === null) return { state: stored ?? emptyDraft(), loadId: null };
  if (stored && stored.analysisId === draftParam) return { state: stored, loadId: null };
  // Черновик по адресу, которого нет в этой вкладке, — загрузить с сервера
  return { state: { ...emptyDraft(), analysisId: draftParam }, loadId: draftParam };
}

export function NewAnalysisPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const userId = useMe().data?.id ?? null;
  const draftParam = Number(params.get('draft')) || null;

  const [initial] = useState(() => initialDraft(draftParam, userId));
  const [state, setState] = useState<DraftState>(initial.state);
  const [loadId, setLoadId] = useState<number | null>(initial.loadId);
  const loaded = useAnalysis(loadId);
  useEffect(() => {
    if (loadId !== null && loaded.data && loaded.data.id === loadId) {
      setState(draftFromAnalysis(loaded.data));
      setLoadId(null);
    }
  }, [loadId, loaded.data]);

  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [textError, setTextError] = useState<string | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const launchRef = useRef<HTMLButtonElement>(null);
  const creatingForm = useRef(false);
  // Запуск ушел на экран анализа: черновик стерт, адрес и хранилище больше не трогаем
  const leaving = useRef(false);

  const settings = usePublicSettings();
  const currency = (settings.data?.currency ?? 'RUB') as Currency;
  const bank = useBank();
  const bookmakers = useBookmakers();
  const strategy = useStrategy();
  const access = useAiAccess();
  const create = useCreateAnalysis();
  const run = useRunAnalysis();

  // Адрес /new?draft=ID следует за анализом черновика. handled — последний адрес, который
  // экран уже учел: его смена снаружи (ссылка, «Назад») — повод загрузить другой черновик
  const handled = useRef<number | null>(draftParam);
  const syncUrl = useCallback(
    (id: number | null) => {
      if (leaving.current) return;
      handled.current = id;
      setParams(id === null ? {} : { draft: String(id) }, { replace: true });
    },
    [setParams],
  );

  // Черновик — в хранилище вкладки (за этим участником), анализ — в адресе
  useEffect(() => {
    if (loadId !== null || leaving.current) return;
    saveDraft(state, userId);
  }, [state, loadId, userId]);
  useEffect(() => {
    if (loadId !== null || state.analysisId === handled.current) return;
    syncUrl(state.analysisId);
  }, [state.analysisId, loadId, syncUrl]);
  useEffect(() => {
    if (draftParam === handled.current || leaving.current) return;
    handled.current = draftParam;
    if (draftParam !== null) {
      if (draftParam !== state.analysisId) {
        setState({ ...emptyDraft(), analysisId: draftParam });
        setLoadId(draftParam);
      }
      return;
    }
    // Адрес без черновика («Новый анализ» в меню): загрузка, которая не удалась, брошена;
    // открытый черновик остается (он переживает уход со страницы) — вернуть его в адрес
    if (loadId !== null) {
      setLoadId(null);
      setState(emptyDraft());
    } else if (state.analysisId !== null) {
      syncUrl(state.analysisId);
    }
  }, [draftParam, state.analysisId, loadId, syncUrl]);

  /** Черновик не открылся: начать с чистого листа. */
  function startOver() {
    clearDraft();
    setLoadId(null);
    setState(emptyDraft());
    syncUrl(null);
  }

  /**
   * События без анализа на сервере (форма, «Добавить вручную») — пустой черновик формы. Один
   * запрос за раз; сбой — причина у кнопки запуска и «Повторить», сами не повторяем.
   */
  const ensureServerDraft = useCallback(async () => {
    if (creatingForm.current) return;
    creatingForm.current = true;
    setDraftError(null);
    try {
      const analysis = await create.mutateAsync({ input_kind: 'form' });
      setState((s) => (s.analysisId === null ? { ...s, analysisId: analysis.id, launched: false } : s));
    } catch (error) {
      setDraftError(apiErrorText(error));
    } finally {
      creatingForm.current = false;
    }
  }, [create]);
  // Черновик вкладки с событиями, но без анализа (прошлая попытка не удалась) — один раз при входе
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initial.loadId === null && initial.state.analysisId === null && initial.state.events.length) void ensureServerDraft();
  }, [initial, ensureServerDraft]);

  const update = (fn: (s: DraftState) => DraftState) => setState(fn);

  // «Перед запуском»: расчет сервера по событиям, с задержкой при правке
  const previewBody = useMemo(() => {
    if (state.analysisId === null) return null;
    return JSON.stringify({
      events: state.events.slice(0, 20).map((event) => toEventIn(event)),
      bank: amountForApi(state.bank),
      bookmaker: state.bookmaker?.trim() || null,
    });
  }, [state.analysisId, state.events, state.bank, state.bookmaker]);
  const debouncedBody = useDebounced(previewBody, PREVIEW_DELAY_MS);
  const preview = usePreview(state.analysisId, debouncedBody);
  const previewData = preview.isError ? undefined : preview.data;
  // Анализа черновика больше нет (404): события остаются, черновик на сервере — новый (один раз)
  const previewGone = isApiError(preview.error) && preview.error.status === 404;
  const rebound = useRef(false);
  useEffect(() => {
    if (!previewGone || rebound.current || state.analysisId === null) return;
    rebound.current = true;
    const hasEvents = state.events.length > 0;
    setState((s) => ({ ...s, analysisId: null, launched: false }));
    if (hasEvents) void ensureServerDraft();
  }, [previewGone, state.analysisId, state.events.length, ensureServerDraft]);

  const summary = summarize(state, previewData, access.data, {
    parsing,
    t,
    previewError: preview.isError && state.analysisId !== null ? apiErrorText(preview.error) : null,
    draftError,
  });
  const corridor = strategy.data ? (strategy.data.params.leg_odds as [string, string]) : null;
  const ledgerBank = bank.data && !bank.data.empty ? formatAmountInput(bank.data.balance, currency) : null;
  const sign = currencySign(currency);

  // ---------- действия ----------

  function setText(text: string) {
    setTextError(null);
    update((s) => ({ ...s, text }));
  }

  function exampleText(): string {
    const lines = [t('new.text.exampleBank', { bank: `${ledgerBank ?? formatAmountInput(10000, currency)} ${sign}` })];
    const bk = bookmakers.data?.[0];
    if (bk) lines.push(t('new.text.exampleBookmaker', { name: bk }));
    lines.push('', t('new.text.exampleEvents'), ...(t('new.text.exampleLines', { returnObjects: true }) as unknown as string[]));
    return lines.join('\n');
  }

  function templateText(): string {
    return (t('new.text.templateLines', { returnObjects: true }) as unknown as string[]).join('\n');
  }

  async function parse() {
    if (parsing) return;
    if (!state.text.trim()) {
      toast.show(t('new.toast.needText'), { icon: 'info' });
      focusLater('new-text');
      return;
    }
    setParsing(true);
    setParseError(null);
    setTextError(null);
    const text = state.text;
    try {
      const analysis = await create.mutateAsync({ input_kind: 'text', text });
      const next = draftFromAnalysis(analysis);
      update((s) => ({ ...next, tab: s.tab, text: s.text, parsedText: text }));
      const n = next.events.length;
      const unknown = next.parse?.unknown.length ?? 0;
      toast.show(
        n
          ? unknown
            ? t('new.toast.parsedUnknown', { events: t('new.result.events', { count: n }), count: unknown })
            : t('new.toast.parsed', { events: t('new.result.events', { count: n }) })
          : t('new.toast.noEvents'),
        { icon: n ? 'check' : 'alert' },
      );
    } catch (error) {
      const message = apiErrorText(error);
      if (isApiError(error) && (error.code === 'analysis.text_empty' || error.code === 'analysis.text_too_long')) {
        setTextError(message);
      } else {
        setParseError(message);
      }
    } finally {
      setParsing(false);
    }
  }

  function changeEvent(key: string, next: EditEvent) {
    update((s) => ({ ...s, events: s.events.map((e) => (e.key === key ? next : e)) }));
  }

  function removeEvent(event: EditEvent) {
    const title = eventTitle(event, t);
    update((s) => ({
      ...s,
      events: s.events.filter((e) => e.key !== event.key),
      editing: s.editing.filter((k) => k !== event.key),
    }));
    toast.show(t('new.toast.removed', { title }), { icon: 'trash' });
  }

  function startEdit(event: EditEvent, player?: 1 | 2) {
    update((s) => ({
      ...s,
      editing: s.editing.includes(event.key) ? s.editing : [...s.editing, event.key],
      snapshots: { ...s.snapshots, [event.key]: event },
    }));
    focusLater(`${event.key}-n${player === 2 ? 2 : 1}`);
  }

  function cancelEdit(event: EditEvent) {
    update((s) => {
      const snapshot = s.snapshots[event.key];
      const { [event.key]: _dropped, ...snapshots } = s.snapshots;
      const events =
        !snapshot || snapshot.blank ? s.events.filter((e) => e.key !== event.key) : s.events.map((e) => (e.key === event.key ? snapshot : e));
      return { ...s, events, snapshots, editing: s.editing.filter((k) => k !== event.key) };
    });
    toast.show(t('new.toast.editCancelled'), { icon: 'refresh' });
  }

  function finishEdit(event: EditEvent) {
    update((s) => {
      const { [event.key]: _dropped, ...snapshots } = s.snapshots;
      return {
        ...s,
        snapshots,
        editing: s.editing.filter((k) => k !== event.key),
        events: s.events.map((e) => (e.key === event.key ? { ...e, blank: false } : e)),
      };
    });
  }

  function addBlank() {
    const event = blankEvent();
    update((s) => ({
      ...s,
      events: [...s.events, event],
      editing: s.tab === 'text' ? [...s.editing, event.key] : s.editing,
      snapshots: s.tab === 'text' ? { ...s.snapshots, [event.key]: event } : s.snapshots,
    }));
    if (state.analysisId === null) void ensureServerDraft();
    focusLater(`${event.key}-n1`);
  }

  function setTab(tab: InputTab) {
    update((s) => ({ ...s, tab }));
  }

  async function launch() {
    if (summary.reason) {
      toast.show(summary.reason, { icon: 'alert' });
      return;
    }
    setLaunching(true);
    try {
      let id = state.analysisId;
      // События запущенного анализа не меняются: другие события — новый анализ
      if (id === null || state.launched) id = (await create.mutateAsync({ input_kind: 'form' })).id;
      const body = {
        events: state.events.map((event) => toEventIn(event, { forRun: true })),
        bank: amountForApi(state.bank),
        bookmaker: state.bookmaker?.trim() || null,
      };
      const analysis = await run.mutateAsync({ id, body });
      // Запущенный анализ живет на своем экране: «Новый анализ» откроется пустым, а вернуться к
      // этим событиям можно явно — «Изменить события»
      leaving.current = true;
      clearDraft();
      toast.show(t('new.toast.launched', { events: t('new.result.events', { count: state.events.length }) }), { icon: 'spark' });
      navigate(paths.analysis(analysis.id));
    } catch (error) {
      toast.show(apiErrorText(error), { icon: 'alert', duration: 6000 });
    } finally {
      setLaunching(false);
    }
  }

  const actions = (event: EditEvent) => ({
    onChange: (next: EditEvent) => changeEvent(event.key, next),
    onRemove: () => removeEvent(event),
    onEdit: (player?: 1 | 2) => startEdit(event, player),
    onDone: () => finishEdit(event),
    onCancel: () => cancelEdit(event),
  });

  const inputDone = state.events.length > 0 && !(state.tab === 'text' && (parsing || (state.parse !== null && state.parsedText !== state.text)));
  const previews = previewData?.events ?? [];
  const loading = loadId !== null && !loaded.isError;
  const loadFailed = loadId !== null && loaded.isError;
  const loadGone = isApiError(loaded.error) && loaded.error.status === 404;

  return (
    <div className="new-root">
      <div className="page-head new-head">
        <div className="new-head-text">
          <h2>{t('new.head.title')}</h2>
          <p className="lead">{t('new.head.lead')}</p>
        </div>
        <Stepper
          variant="pills"
          label={t('new.steps.label')}
          doneLabel={t('new.steps.done')}
          current={inputDone ? 1 : 0}
          items={[
            { label: t('new.steps.input'), short: t('new.steps.inputShort') },
            { label: t('new.steps.check'), short: t('new.steps.check') },
            { label: t('new.steps.analysis'), short: t('new.steps.analysis') },
          ]}
        />
      </div>
      <div className="new-layout">
        <div className="new-main">
          <section className="card new-input-card" aria-label={t('new.input.label')}>
            <Tabs
              label={t('new.input.tabs')}
              className="new-tabs"
              panelId="new-panel"
              active={state.tab}
              onChange={setTab}
              items={[
                { id: 'text', icon: 'list', label: t('new.input.text') },
                { id: 'form', icon: 'edit', label: t('new.input.form') },
              ]}
            />
            <div className="new-panel" role="tabpanel" id="new-panel" aria-label={state.tab === 'text' ? t('new.input.text') : t('new.input.form')}>
              {loading ? (
                <Skeleton lines={6} />
              ) : loadFailed ? (
                <div className="stack">
                  <Callout kind="bad" role="alert">
                    <b>{t('new.draftLoad.title')}</b> {loadGone ? t('new.draftLoad.gone') : apiErrorText(loaded.error)}
                  </Callout>
                  <div className="row">
                    <Button kind="primary" icon="plus" onClick={startOver}>
                      {t('new.draftLoad.reset')}
                    </Button>
                    {!loadGone && (
                      <Button icon="refresh" onClick={() => void loaded.refetch()}>
                        {t('common.retry')}
                      </Button>
                    )}
                  </div>
                </div>
              ) : state.tab === 'text' ? (
                <TextPanel
                  state={state}
                  previews={previews}
                  corridor={corridor}
                  actions={actions}
                  parsing={parsing}
                  parseError={
                    parseError && (
                      <Callout kind="bad" role="alert">
                        {parseError}
                      </Callout>
                    )
                  }
                  textError={textError}
                  currency={currency}
                  onText={setText}
                  onParse={() => void parse()}
                  onExample={() => {
                    setText(exampleText());
                    toast.show(t('new.toast.example'), { icon: 'copy' });
                    focusLater('new-text');
                  }}
                  onFormat={() => setFormatOpen(true)}
                  onAdd={addBlank}
                />
              ) : (
                <FormPanel
                  state={state}
                  previews={previews}
                  corridor={corridor}
                  actions={actions}
                  currency={currency}
                  currencySign={sign}
                  ledgerBank={ledgerBank}
                  bookmakers={bookmakers.data ?? []}
                  onBank={(text) => update((s) => ({ ...s, bank: text }))}
                  onBankBlur={() => {
                    const value = parseAmount(state.bank);
                    if (value !== null) update((s) => ({ ...s, bank: formatAmountInput(value, currency) }));
                  }}
                  onBookmaker={(name) => update((s) => ({ ...s, bookmaker: name }))}
                  onAdd={addBlank}
                />
              )}
              {draftError && state.analysisId === null && !loading && !loadFailed && (
                <Callout kind="bad" role="alert">
                  <div>{t('new.reason.draftFailed', { reason: draftError })}</div>
                  <div className="row new-callout-actions">
                    <Button size="sm" icon="refresh" onClick={() => void ensureServerDraft()}>
                      {t('common.retry')}
                    </Button>
                  </div>
                </Callout>
              )}
            </div>
          </section>
        </div>
        <aside className="new-side" aria-label={t('new.launch.title')}>
          <LaunchCard
            summary={summary}
            access={access.data}
            launching={launching}
            onLaunch={() => void launch()}
            onRetry={() => (summary.retry === 'draft' ? void ensureServerDraft() : void preview.refetch())}
            buttonRef={launchRef}
          />
          <FlowCard
            summary={summary}
            bank={amountForApi(state.bank) ?? (bank.data && !bank.data.empty ? bank.data.balance : null)}
            currency={currency}
            params={strategy.data?.params}
          />
          <RulesCard n={summary.n} />
          <RecentCard />
        </aside>
      </div>
      <StickyActionBar label={t('new.bar.label')} watch={launchRef}>
        <div className="sticky-bar-text">
          <b>{t('new.bar.title', { events: t('new.result.events', { count: summary.n }), mode: t('new.modes.precise.label') })}</b>
          <span className={cx('sticky-bar-sub', summary.reason && 'warn')}>
            {summary.reason ??
              `${summary.costUsd === null ? '' : `≈${formatUsd(summary.costUsd)}`}${summary.seconds === null ? '' : ` · ${formatEstimate(summary.seconds)}`}`}
          </span>
        </div>
        <Button kind="primary" icon="spark" disabled={Boolean(summary.reason)} loading={launching} onClick={() => void launch()}>
          {t('new.bar.run')}
        </Button>
      </StickyActionBar>
      <FormatModal
        open={formatOpen}
        template={templateText()}
        onClose={() => setFormatOpen(false)}
        onInsert={() => {
          setFormatOpen(false);
          update((s) => ({ ...s, tab: 'text', text: templateText() }));
          focusLater('new-text');
        }}
      />
    </div>
  );
}
