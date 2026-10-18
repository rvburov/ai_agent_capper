import type { TFunction } from 'i18next';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Callout, Combobox, Field, KeyValue, Modal, Segmented } from '../../components';
import { isApiError } from '../../api/errors';
import { parseAmount } from '../../features/analysis/amount';
import { apiErrorText } from '../../features/analysis/codes';
import { oddInputText, oddNumber, validOdd } from '../../features/analysis/draft';
import { formatShare } from '../../features/analysis/markets';
import { payout, roundMoney, shareOf, stakeForShare, stakeProblem, totalOdds, type MoneyRules } from '../../features/analysis/stake';
import type { BetKindIn } from '../../features/analysis/types';
import { BET_CONFLICTS, newClientRef, usePlaceBet, type Bet } from '../../features/bets/api';
import { useBookmakerList } from '../../features/bookmakers/api';
import { currencySign, formatAmountInput, formatMoney, formatOdds, type Currency } from '../../lib/format';

// Окна «Изменить сумму» и «Сохранить ставку» (stakeModal, saveBet, legOddsFields в
// mockup/js/screens/analysis.js): кэф при ставке у каждой ноги (по умолчанию из ввода), сумма,
// доля банка, выплата. Сумму и кэфы при сохранении проверяет сервер.

export interface LegView {
  predictionId: number;
  name: string;
  match: string;
  /** Кэф из анализа. */
  odds: number;
}

export interface BetContext {
  analysisId: number;
  legs: readonly LegView[];
  bank: number;
  currency: Currency;
  rules: MoneyRules;
  /** Рекомендованная доля банка (0..1) и сумма по стратегии; null — суммы нет. */
  recommendedShare: number | null;
  recommended: number | null;
  /** Вероятность экспресса — для ожидаемого результата. */
  pExpress: number;
  /** Потолок итогового кэфа по стратегии (3.24, у экспресса из 3 — 4.10). */
  totalMax: number;
  /** Рост банка разрешает до 4% (правило «Рост банка» действует). */
  growthOn: boolean;
  strategyCode: string;
  /** Вид ставки при сохранении (Р29): экспресс стратегии, ординар варианта или своя. */
  kind: BetKindIn;
  /** Подсказка к сумме вместо «Рекомендовано … по стратегии» (ординар, экспресс из лучших). */
  stakeHint?: string;
  /** Доли банка в «Изменить сумму» (у ординара — меньше, чем у экспресса). */
  presets?: readonly number[];
  /** Пояснение внизу окна: что это за ставка и где она учитывается. */
  kindNote?: string;
}

function LegOddsFields({ prefix, legs, values, onChange }: { prefix: string; legs: readonly LegView[]; values: string[]; onChange: (next: string[]) => void }) {
  const { t } = useTranslation();
  return (
    <div className="stack analysis-legodds-block">
      <span className="field-label">{t('analysis.bet.takenLabel')}</span>
      <div className="analysis-legodds">
        {legs.map((leg, i) => {
          const id = `${prefix}-odd-${i}`;
          const value = values[i] ?? '';
          const bad = !validOdd(value);
          return (
            <div key={leg.predictionId} className="analysis-legodd">
              <label className="analysis-legodd-name" htmlFor={id}>
                <b>{leg.name}</b>
                <small id={`${id}-hint`}>{t('analysis.bet.takenHint', { match: leg.match, odds: formatOdds(leg.odds) })}</small>
              </label>
              <input
                id={id}
                className={bad ? 'input invalid' : 'input'}
                value={value}
                inputMode="decimal"
                autoComplete="off"
                maxLength={6}
                aria-describedby={bad ? `${id}-error` : `${id}-hint`}
                aria-invalid={bad || undefined}
                onChange={(event) => onChange(values.map((v, k) => (k === i ? event.target.value : v)))}
                onBlur={() => {
                  // До 3 знаков, как в базе: 1.833 не превращается в 1.83 (от кэфа считается CLV)
                  if (validOdd(value)) onChange(values.map((v, k) => (k === i ? oddInputText(oddNumber(v)) : v)));
                }}
              />
              {bad && (
                <div className="field-error" id={`${id}-error`} role="alert">
                  {t('analysis.bet.oddsRange')}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="field-hint">{t('analysis.bet.takenNote')}</div>
    </div>
  );
}

/** Кэфы из полей; хоть один неверный — null. */
export function takenNumbers(values: readonly string[]): number[] | null {
  if (!values.every((v) => validOdd(v))) return null;
  return values.map((v) => Math.round(oddNumber(v) * 1000) / 1000);
}

export function shareWarning(share: number, growthOn: boolean, t: TFunction) {
  if (share > 0.04) return <Callout kind="bad">{t('analysis.stakeModal.over4')}</Callout>;
  if (share > 0.03 && !growthOn) return <Callout kind="warn">{t('analysis.stakeModal.over3')}</Callout>;
  if (share > 0.03) return <Callout kind="info">{t('analysis.stakeModal.over3Growth')}</Callout>;
  return null;
}

const PRESETS = [0.015, 0.02, 0.025, 0.03];
/** Доли банка ординара (таблица Р29: 1%, 1,25%, 1,5%). */
export const SINGLE_PRESETS = [0.01, 0.0125, 0.015];

/** «Изменить сумму»: сумма или доля банка, кэфы при ставке, что будет при выигрыше и проигрыше. */
export function StakeModal({
  open,
  ctx,
  stake,
  taken,
  onClose,
  onApply,
}: {
  open: boolean;
  ctx: BetContext;
  stake: number | null;
  taken: string[];
  onClose: () => void;
  onApply: (stake: number, taken: string[]) => void;
}) {
  const { t } = useTranslation();
  const initial = stake ?? (ctx.recommended ?? stakeForShare(ctx.bank, 0.015, ctx.rules));
  const [text, setText] = useState(() => formatAmountInput(initial, ctx.currency));
  const [odds, setOdds] = useState<string[]>(() => [...taken]);
  const value = parseAmount(text);
  const amount = value === null ? null : roundMoney(value, ctx.rules);
  const numbers = takenNumbers(odds);
  const problem = stakeProblem(amount, ctx.bank, ctx.rules);
  const presets = useMemo(() => {
    const list = new Set(ctx.presets ?? PRESETS);
    if (ctx.recommendedShare) list.add(ctx.recommendedShare);
    return [...list].sort((a, b) => a - b);
  }, [ctx.recommendedShare, ctx.presets]);
  const active = presets.find((p) => amount !== null && stakeForShare(ctx.bank, p, ctx.rules) === amount);
  const sign = currencySign(ctx.currency);

  function submit() {
    if (problem || !numbers || amount === null) return;
    onApply(amount, odds);
  }

  let preview;
  if (!numbers) preview = <Callout kind="bad">{t('analysis.stakeModal.checkOdds')}</Callout>;
  else if (problem === 'aboveBank') preview = <Callout kind="bad">{t('analysis.stakeModal.aboveBank', { bank: formatMoney(ctx.bank, ctx.currency) })}</Callout>;
  else if (problem === 'belowMin' || problem === 'empty') preview = <Callout kind="bad">{t('analysis.stakeModal.belowMin', { min: formatMoney(ctx.rules.min, ctx.currency) })}</Callout>;
  else if (amount !== null) {
    const total = totalOdds(numbers);
    const win = payout(amount, total, ctx.rules);
    const share = shareOf(amount, ctx.bank);
    preview = (
      <>
        <KeyValue
          items={[
            { key: 'share', label: t('analysis.stakeModal.share'), value: formatShare(share) },
            { key: 'win', label: t('analysis.stakeModal.payout', { total: formatOdds(total) }), value: formatMoney(win, ctx.currency) },
            { key: 'profit', label: t('analysis.stakeModal.profit'), value: formatMoney(win - amount, ctx.currency, { signed: true }) },
            { key: 'loss', label: t('analysis.stakeModal.loss'), value: formatMoney(-amount, ctx.currency, { signed: true }) },
            {
              key: 'ev',
              label: t('analysis.stakeModal.expected'),
              value: `≈ ${formatMoney(amount * (ctx.pExpress * total - 1), ctx.currency, { signed: true })}`,
            },
          ]}
        />
        {shareWarning(share, ctx.growthOn, t)}
      </>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('analysis.stakeModal.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('analysis.bet.cancel')}</Button>
          <Button kind="primary" icon="check" type="submit" form="analysis-stake-form">
            {t('analysis.stakeModal.apply')}
          </Button>
        </>
      }
    >
      <form
        id="analysis-stake-form"
        className="stack analysis-modal-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          id="analysis-stake-input"
          label={t('analysis.stakeModal.amount')}
          value={text}
          suffix={sign}
          inputMode={ctx.rules.decimals ? 'decimal' : 'numeric'}
          autoComplete="off"
          maxLength={12}
          hint={
            ctx.stakeHint ??
            (ctx.recommended !== null && ctx.recommendedShare !== null
              ? t('analysis.stakeModal.hint', {
                  amount: formatMoney(ctx.recommended, ctx.currency),
                  share: formatShare(ctx.recommendedShare),
                  code: ctx.strategyCode,
                })
              : t('analysis.stakeModal.hintNone', { code: ctx.strategyCode }))
          }
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (amount !== null) setText(formatAmountInput(amount, ctx.currency));
          }}
        />
        <div className="stack analysis-share">
          <span className="field-label">{t('analysis.stakeModal.orShare')}</span>
          <Segmented
            label={t('analysis.stakeModal.share')}
            className="analysis-modal-seg"
            value={active !== undefined ? String(active) : 'custom'}
            onChange={(share) => setText(formatAmountInput(stakeForShare(ctx.bank, Number(share), ctx.rules), ctx.currency))}
            items={presets.map((p) => ({
              value: String(p),
              label: p === ctx.recommendedShare ? t('analysis.stakeModal.presetRec', { share: formatShare(p) }) : formatShare(p),
            }))}
          />
        </div>
        <LegOddsFields prefix="analysis-stake" legs={ctx.legs} values={odds} onChange={setOdds} />
        <div className="stack analysis-modal-preview" aria-live="polite">
          {preview}
        </div>
      </form>
    </Modal>
  );
}

// Названия букмекеров сравниваются без учета регистра (как на сервере)
function sameBookName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase('ru') === b.trim().toLocaleLowerCase('ru');
}

export interface BookChoice {
  book: string;
  setBook: (value: string) => void;
  /** Букмекер анализа скрыт в «Моих букмекерах». */
  hiddenBook: boolean;
  bookOk: boolean;
  /** Показать ошибку «Укажите букмекера». */
  bookError: boolean;
  touch: () => void;
}

/**
 * Букмекер ставки. Букмекер анализа скрыт в «Моих букмекерах» после запуска: молча ставить на
 * скрытого нельзя (у скрытого не бывает ставок в игре) — показываем выбор из действующих, пустой.
 */
export function useBookChoice(bookmaker: string | null, bookmakers: readonly string[]): BookChoice {
  const list = useBookmakerList();
  const hiddenBook =
    bookmaker !== null &&
    (list.data?.items ?? []).some((item) => item.archived_at !== null && sameBookName(item.name, bookmaker));
  const [book, setBook] = useState(bookmaker ?? bookmakers[0] ?? '');
  useEffect(() => {
    if (hiddenBook) setBook((value) => (bookmaker !== null && sameBookName(value, bookmaker) ? '' : value));
  }, [hiddenBook, bookmaker]);
  // Ошибка «Укажите букмекера» — после правки поля или попытки сохранить, а не сразу
  const [touched, setTouched] = useState(false);
  const bookOk = book.trim().length > 0;
  return {
    book,
    setBook: (value) => {
      setBook(value);
      setTouched(true);
    },
    hiddenBook,
    bookOk,
    bookError: !bookOk && touched,
    touch: () => setTouched(true),
  };
}

export function HiddenBookNote({ name }: { name: string }) {
  const { t } = useTranslation();
  return (
    <Callout kind="warn" icon="eyeOff">
      {t('analysis.bet.bookmakerHidden', { name })}
    </Callout>
  );
}

/** Поле «Букмекер»: общий выпадающий список с вводом (Combobox). */
export function BookmakerField({ id, choice, bookmakers, hint }: { id: string; choice: BookChoice; bookmakers: readonly string[]; hint?: string }) {
  const { t } = useTranslation();
  const query = choice.book.trim().toLowerCase();
  const describedBy = choice.bookError ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {t('analysis.bet.bookmaker')}
      </label>
      <Combobox
        id={id}
        label={t('analysis.bet.bookmaker')}
        value={choice.book}
        minChars={0}
        invalid={choice.bookError}
        describedBy={describedBy}
        options={bookmakers.filter((b) => !query || b.toLowerCase().includes(query)).map((b) => ({ value: b, label: b }))}
        onChange={choice.setBook}
        onPick={(option) => choice.setBook(option.value)}
      />
      {choice.bookError ? (
        <div className="field-error" id={`${id}-error`} role="alert">
          {t('analysis.bet.bookmakerRequired')}
        </div>
      ) : (
        hint && (
          <div className="field-hint" id={`${id}-hint`}>
            {hint}
          </div>
        )
      )}
    </div>
  );
}

/** «Сохранить ставку»: кэф при ставке у каждой ноги, итоговый кэф и выплата; POST /api/bets. */
export function SaveBetModal({
  open,
  ctx,
  stake,
  taken,
  bookmaker,
  bookmakers,
  onClose,
  onSaved,
  onConflict,
}: {
  open: boolean;
  ctx: BetContext;
  stake: number;
  taken: string[];
  bookmaker: string | null;
  bookmakers: readonly string[];
  onClose: () => void;
  onSaved: (bet: Bet, taken: string[]) => void;
  /** Ставку по анализу сохранить нельзя (уже сохранена, анализ не готов): окно закрывается. */
  onConflict: (message: string) => void;
}) {
  const { t } = useTranslation();
  const choice = useBookChoice(bookmaker, bookmakers);
  const { book, hiddenBook, bookOk } = choice;
  const fixedBook = hiddenBook ? null : bookmaker;
  const [odds, setOdds] = useState<string[]>(() => [...taken]);
  const [clientRef] = useState(newClientRef);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const place = usePlaceBet();
  const numbers = takenNumbers(odds);
  const analysisTotal = totalOdds(ctx.legs.map((l) => l.odds));
  const total = numbers ? totalOdds(numbers) : null;

  async function save() {
    if (!bookOk) {
      choice.touch();
      document.getElementById('analysis-bet-bk')?.focus();
      return;
    }
    if (!numbers || saving.current) return;
    saving.current = true;
    setError(null);
    try {
      const bet = await place.mutateAsync({
        analysis_id: ctx.analysisId,
        kind: ctx.kind,
        stake: stake.toFixed(2),
        bookmaker: book.trim().slice(0, 64),
        legs: ctx.legs.map((leg, i) => ({ prediction_id: leg.predictionId, odds_taken: String(numbers[i]) })),
        client_ref: clientRef,
        // валюта суммы в окне: сменилась на сервере — 409 common.currency_changed
        currency: ctx.currency,
      });
      onSaved(bet, odds);
    } catch (e) {
      // Ставка уже есть (ответ на первый запрос потерялся, окно открыли снова) или анализ
      // не в том состоянии: анализ и банк перечитаны (usePlaceBet), окно больше не нужно
      if (isApiError(e) && BET_CONFLICTS.has(e.code)) onConflict(apiErrorText(e));
      else setError(apiErrorText(e));
    } finally {
      saving.current = false;
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('analysis.bet.title')}
      footer={
        <>
          <Button onClick={onClose}>{t('analysis.bet.cancel')}</Button>
          <Button kind="primary" icon="check" disabled={!numbers} loading={place.isPending} onClick={() => void save()}>
            {t('analysis.bet.save')}
          </Button>
        </>
      }
    >
      <LegOddsFields prefix="analysis-bet" legs={ctx.legs} values={odds} onChange={setOdds} />
      {hiddenBook && <HiddenBookNote name={bookmaker ?? ''} />}
      {!fixedBook && <BookmakerField id="analysis-bet-bk" choice={choice} bookmakers={bookmakers} />}
      <div aria-live="polite" className="stack">
        {total !== null && (
          <>
            <KeyValue
              items={[
                {
                  key: 'stake',
                  label: t('analysis.bet.stake'),
                  value: t('analysis.bet.stakeValue', {
                    amount: formatMoney(stake, ctx.currency),
                    share: formatShare(shareOf(stake, ctx.bank)),
                  }),
                },
                {
                  key: 'total',
                  label: t('analysis.bet.total'),
                  value:
                    Math.abs(total - analysisTotal) > 0.0005
                      ? t('analysis.bet.totalChanged', { total: formatOdds(total), was: formatOdds(analysisTotal) })
                      : formatOdds(total),
                },
                {
                  key: 'payout',
                  label: t('analysis.bet.payout'),
                  value: t('analysis.bet.payoutValue', {
                    payout: formatMoney(payout(stake, total, ctx.rules), ctx.currency),
                    profit: formatMoney(payout(stake, total, ctx.rules) - stake, ctx.currency, { signed: true }),
                  }),
                },
                ...(fixedBook ? [{ key: 'bk', label: t('analysis.bet.bookmaker'), value: fixedBook }] : []),
              ]}
            />
            {total > ctx.totalMax && <Callout kind="warn">{t('analysis.bet.overTotal', { max: formatOdds(ctx.totalMax), code: ctx.strategyCode })}</Callout>}
          </>
        )}
      </div>
      {error && (
        <Callout kind="bad" role="alert">
          {error}
        </Callout>
      )}
      {ctx.kindNote && (
        <Callout icon={ctx.kind === 'single' ? 'target' : 'user'}>{ctx.kindNote}</Callout>
      )}
      <p className="xsmall muted">{t('analysis.bet.note')}</p>
    </Modal>
  );
}
