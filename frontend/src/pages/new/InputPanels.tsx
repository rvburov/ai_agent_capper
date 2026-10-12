import type { KeyboardEvent, ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Chip, Combobox, Field, Spinner } from '../../components';
import type { EditEvent } from '../../features/analysis/draft';
import type { DraftState } from '../../features/analysis/draftStore';
import type { PreviewEvent } from '../../features/analysis/types';
import { keyText } from '../../features/analysis/codes';
import { formatDate, formatMoney, formatUsd, type Currency } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { EventCard, type EventActions } from './EventCard';

// Вкладки ввода «Вставить текстом» и «Заполнить форму» (textPanel, resultSection, formPanel
// в mockup/js/screens/new-analysis.js).

export interface EventsProps {
  state: DraftState;
  previews: readonly PreviewEvent[];
  corridor: [string, string] | null;
  actions: (event: EditEvent) => EventActions;
}

function EventList({ state, previews, corridor, actions, form }: EventsProps & { form: boolean }) {
  return (
    <div className="new-list">
      {state.events.map((event, index) => (
        <EventCard
          key={event.key}
          event={event}
          index={index}
          preview={previews[index]}
          corridor={corridor}
          mode={form ? 'form' : state.editing.includes(event.key) ? 'inline' : 'review'}
          {...actions(event)}
        />
      ))}
    </div>
  );
}

interface TextPanelProps extends EventsProps {
  parsing: boolean;
  parseError: ReactNode;
  textError: string | null;
  currency: Currency;
  onText: (text: string) => void;
  onParse: () => void;
  onExample: () => void;
  onFormat: () => void;
  onAdd: () => void;
}

export function TextPanel(props: TextPanelProps) {
  const { t } = useTranslation();
  const mobile = useMediaQuery(MOBILE_QUERY);
  const { state, parsing } = props;
  const empty = !state.text.trim();
  const dirty = state.parsedText !== state.text;
  const again = !dirty && !parsing && state.parse !== null;
  let status: ReactNode;
  if (parsing) status = <Chip kind="info" icon="clock">{t('new.text.statusParsing')}</Chip>;
  else if (empty) status = <Chip kind="outline" icon="info">{t('new.text.statusEmpty')}</Chip>;
  else if (dirty)
    status = (
      <Chip kind="warn" icon="alert">
        {state.parse ? t('new.text.statusDirty') : t('new.text.statusNew')}
      </Chip>
    );
  else status = <Chip kind="good" icon="check">{t('new.text.statusParsed', { count: state.events.length })}</Chip>;

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      props.onParse();
    }
  }

  return (
    <div className="stack new-text-panel">
      <div className="stack new-text-top">
        <div className="new-tools">
          <label className="field-label" htmlFor="new-text">
            {t('new.text.label')}
          </label>
          <div className="row">
            <Button kind="ghost" size="sm" icon="book" title={t('new.text.formatTitle')} onClick={props.onFormat}>
              {t('new.text.format')}
            </Button>
            <Button kind="ghost" size="sm" icon="copy" onClick={props.onExample}>
              {t('new.text.example')}
            </Button>
            <Button kind="ghost" size="sm" icon="x" onClick={() => props.onText('')}>
              {t('new.text.clear')}
            </Button>
          </div>
        </div>
        <textarea
          id="new-text"
          className="textarea new-textarea"
          rows={12}
          spellCheck={false}
          value={state.text}
          placeholder={t('new.text.placeholder')}
          aria-describedby={props.textError ? 'new-text-error' : 'new-text-hint'}
          aria-invalid={props.textError ? true : undefined}
          onChange={(event) => props.onText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {props.textError && (
          <div className="field-error" id="new-text-error" role="alert">
            {props.textError}
          </div>
        )}
        <div className="new-ta-actions">
          <div className="new-ta-status">
            <div aria-live="polite">{status}</div>
            <span className="xsmall muted" id="new-text-hint">
              {t('new.text.hint')}
              {mobile ? '.' : (
                <>
                  {' · '}
                  <kbd className="new-kbd">Ctrl</kbd>+<kbd className="new-kbd">Enter</kbd>
                </>
              )}
            </span>
          </div>
          <Button kind={again ? 'secondary' : 'primary'} icon="spark" loading={parsing} onClick={props.onParse}>
            {parsing ? t('new.text.parsing') : again ? t('new.text.parseAgain') : t('new.text.parse')}
          </Button>
        </div>
        {props.parseError}
      </div>
      <ResultSection {...props} />
    </div>
  );
}

function ResultSection(props: TextPanelProps) {
  const { t } = useTranslation();
  const { state, parsing } = props;
  if (parsing) {
    return (
      <section className="new-result" aria-label={t('new.result.title')} aria-busy="true">
        <div className="row" role="status">
          <Spinner size="sm" decorative />
          <span className="soft">{t('new.result.parsing')}</span>
        </div>
        <div className="new-skel" />
        <div className="new-skel short" />
      </section>
    );
  }
  const parse = state.parse;
  const n = state.events.length;
  return (
    <section className="new-result" aria-label={t('new.result.title')}>
      {parse ? (
        <>
          <div className="new-result-head">
            <div className="new-result-title">
              <h3>{t('new.result.title')}</h3>
              <div className="row">
                <Chip kind={n ? 'accent' : 'bad'} icon={n ? 'check' : 'alert'}>
                  {t('new.result.events', { count: n })}
                </Chip>
                {parse.bank && (
                  <Chip kind={parse.bankNoteKey ? 'warn' : 'outline'} icon={parse.bankNoteKey ? 'alert' : 'wallet'}>
                    {t('new.result.bank', { bank: formatMoney(parse.bank, props.currency) })}
                  </Chip>
                )}
                {state.bookmaker && <Chip kind="outline">{state.bookmaker}</Chip>}
              </div>
            </div>
            <span className="xsmall muted new-result-cost">{t('new.result.cost', { cost: formatUsd(parse.costUsd, 4) })}</span>
          </div>
          {parse.bankNoteKey && (
            <Callout kind="warn" icon="wallet">
              {keyText(parse.bankNoteKey, {}, parse.bankNoteKey)}
            </Callout>
          )}
          {parse.unknown.length > 0 && (
            <Callout kind="bad">
              <b>{t('new.result.unknown', { count: parse.unknown.length })}</b>
              <ul className="new-unknown">
                {parse.unknown.slice(0, 4).map((line) => (
                  <li key={line.line_no}>{t('new.result.unknownLine', { n: line.line_no, text: line.text })}</li>
                ))}
              </ul>
              <div className="row new-callout-actions">
                <Button kind="ghost" size="sm" icon="book" onClick={props.onFormat}>
                  {t('new.text.formatTitle')}
                </Button>
              </div>
            </Callout>
          )}
          {parse.warnings
            .filter((w) => w.key !== 'analysis.draft.no_events')
            .map((w) => (
              <Callout key={w.key} kind="warn">
                {keyText(w.key, w.params, w.key)}
              </Callout>
            ))}
          {n === 0 ? <Callout>{t('new.result.noEvents')}</Callout> : <EventList {...props} form={false} />}
        </>
      ) : n > 0 ? (
        <EventList {...props} form={false} />
      ) : (
        <div className="empty">{t('new.result.empty')}</div>
      )}
      <div>
        <Button kind="ghost" icon="plus" onClick={props.onAdd}>
          {t('new.result.addManual')}
        </Button>
      </div>
    </section>
  );
}

interface FormPanelProps extends EventsProps {
  currency: Currency;
  currencySign: string;
  ledgerBank: string | null;
  bookmakers: readonly string[];
  onBank: (text: string) => void;
  onBankBlur: () => void;
  onBookmaker: (name: string | null) => void;
  onAdd: () => void;
}

export function FormPanel(props: FormPanelProps) {
  const { t } = useTranslation();
  const { state } = props;
  const fromText = state.events.some((event) => event.p1.raw || event.p2.raw);
  const query = (state.bookmaker ?? '').trim().toLowerCase();
  const bookmakerOptions = props.bookmakers
    .filter((name) => !query || name.toLowerCase().includes(query))
    .map((name) => ({ value: name, label: name }));
  return (
    <div className="stack new-form-panel">
      <div className="new-form-top">
        <Field
          id="new-bank"
          label={t('new.form.bank')}
          value={state.bank}
          placeholder={props.ledgerBank ?? t('new.form.bankPlaceholder')}
          suffix={props.currencySign}
          inputMode={props.currency === 'RUB' ? 'numeric' : 'decimal'}
          autoComplete="off"
          aria-label={t('new.form.bankAria', { currency: props.currencySign })}
          hint={props.ledgerBank ? t('new.form.bankHint', { date: formatDate(new Date()) }) : t('new.form.bankHintEmpty')}
          onChange={(event) => props.onBank(event.target.value)}
          onBlur={props.onBankBlur}
        />
        <div className="field">
          <label className="field-label" htmlFor="new-bk">
            {t('new.form.bookmaker')}
          </label>
          <Combobox
            id="new-bk"
            label={t('new.form.bookmaker')}
            value={state.bookmaker ?? ''}
            minChars={0}
            placeholder={t('new.form.bookmakerPlaceholder')}
            options={bookmakerOptions}
            describedBy="new-bk-hint"
            onChange={(text) => props.onBookmaker(text.slice(0, 64) || null)}
            onPick={(option) => props.onBookmaker(option.value)}
          />
          <div className="field-hint" id="new-bk-hint">
            {t('new.form.bookmakerHint')}
          </div>
        </div>
      </div>
      {fromText && <Callout kind="info">{t('new.form.fromText')}</Callout>}
      {state.events.length ? (
        <EventList {...props} form />
      ) : (
        <div className="card new-form-empty">
          <div className="empty">{t('new.form.empty')}</div>
        </div>
      )}
      <Button icon="plus" block className="new-add" onClick={props.onAdd}>
        {t('new.form.add')}
      </Button>
    </div>
  );
}
