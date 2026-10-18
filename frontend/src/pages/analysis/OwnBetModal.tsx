import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors';
import { Button, Callout, Chip, Field, IconButton, KeyValue, Modal } from '../../components';
import { parseAmount } from '../../features/analysis/amount';
import { apiErrorText } from '../../features/analysis/codes';
import { oddInputText, oddNumber, validOdd } from '../../features/analysis/draft';
import { formatProb, formatShare } from '../../features/analysis/markets';
import { slipNumbers, slipProb, type SlipItem } from '../../features/analysis/ownBet';
import { payout, roundMoney, shareOf, stakeForShare, stakeProblem, type MoneyRules } from '../../features/analysis/stake';
import { BET_CONFLICTS, newClientRef, usePlaceBet, type Bet } from '../../features/bets/api';
import { currencySign, formatAmountInput, formatMoney, formatOdds, formatPercent, type Currency } from '../../lib/format';
import { cx } from '../../lib/cx';
import { BookmakerField, HiddenBookNote, shareWarning, takenNumbers, useBookChoice } from './BetModals';

// Окно «Своя ставка» (betModal с kind own в mockup/js/screens/analysis.js, Р29): любые исходы
// анализа, один рынок на матч. Кэф при ставке у каждого события, сумма — от участника
// (рекомендованной нет: стратегия эту ставку не считает), букмекер, выплата и прибыль,
// вероятность и валуй по модели, предупреждения. Проверки суммы и исходов — на сервере.

export interface OwnBetModalProps {
  analysisId: number;
  slip: readonly SlipItem[];
  bank: number;
  currency: Currency;
  rules: MoneyRules;
  growthOn: boolean;
  bookmaker: string | null;
  bookmakers: readonly string[];
  /** Подсказка сверху: «Один рынок на матч: … заменен на …», «собрана из экспресса». */
  hint: string | null;
  onRemove: (predictionId: number) => void;
  onClose: () => void;
  onSaved: (bet: Bet) => void;
  onConflict: (message: string) => void;
}

export function OwnBetModal(props: OwnBetModalProps) {
  const { t } = useTranslation();
  const { slip, bank, currency, rules } = props;
  // Кэфы при ставке — по исходу: событие убрали или заменили, поля остальных не сбиваются
  const [odds, setOdds] = useState<Record<number, string>>(() =>
    Object.fromEntries(slip.map((item) => [item.predictionId, oddInputText(item.odds)])),
  );
  const [text, setText] = useState('');
  const choice = useBookChoice(props.bookmaker, props.bookmakers);
  const [clientRef] = useState(newClientRef);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const place = usePlaceBet();

  const values = slip.map((item) => odds[item.predictionId] ?? oddInputText(item.odds));
  const numbers = takenNumbers(values);
  const nums = numbers ? slipNumbers(slip, numbers) : null;
  const typed = parseAmount(text);
  const amount = typed === null ? null : roundMoney(typed, rules);
  const problem = stakeProblem(amount, bank, rules);
  const ready = slip.length > 0 && numbers !== null && problem === null && amount !== null && choice.bookOk;
  const example = stakeForShare(bank, 0.01, rules);
  const p = slipProb(slip);

  async function save() {
    if (!choice.bookOk) {
      choice.touch();
      document.getElementById('analysis-own-bk')?.focus();
      return;
    }
    if (!ready || !numbers || amount === null || saving.current) {
      document.getElementById(numbers ? 'analysis-own-stake' : `analysis-own-odd-${slip.findIndex((_, i) => !validOdd(values[i] ?? ''))}`)?.focus();
      return;
    }
    saving.current = true;
    setError(null);
    try {
      const bet = await place.mutateAsync({
        analysis_id: props.analysisId,
        kind: 'own',
        stake: amount.toFixed(2),
        bookmaker: choice.book.trim().slice(0, 64),
        legs: slip.map((item, i) => ({ prediction_id: item.predictionId, odds_taken: String(numbers[i]) })),
        client_ref: clientRef,
        currency,
      });
      props.onSaved(bet);
    } catch (e) {
      if (isApiError(e) && BET_CONFLICTS.has(e.code)) props.onConflict(apiErrorText(e));
      else setError(apiErrorText(e));
    } finally {
      saving.current = false;
    }
  }

  const share = amount !== null && problem === null ? shareOf(amount, bank) : null;
  const win = share !== null && amount !== null && nums ? payout(amount, nums.total, rules) : null;
  const unchecked = slip.filter((x) => x.status !== 'express');
  const unsure = slip.filter((x) => x.confidence !== 'high');
  const low = unsure.some((x) => x.confidence === 'low');

  return (
    <Modal
      open
      wide
      onClose={props.onClose}
      title={t('analysis.own.title')}
      footer={
        <>
          <Button onClick={props.onClose}>{t('analysis.bet.cancel')}</Button>
          <Button kind="primary" icon="check" disabled={slip.length === 0} loading={place.isPending} onClick={() => void save()}>
            {t('analysis.bet.save')}
          </Button>
        </>
      }
    >
      {props.hint && (
        <Callout kind="info" icon="refresh">
          {props.hint}
        </Callout>
      )}
      <div className="row analysis-own-kind">
        {slip.length > 1 ? (
          <Chip kind="outline" icon="layers">
            {t('bets.kind.parlay', { n: slip.length })}
          </Chip>
        ) : (
          <Chip kind="info" icon="target">
            {t('bets.kind.single')}
          </Chip>
        )}
        <Chip kind="warn" icon="user">
          {t('bets.kindChip.own')}
        </Chip>
      </div>
      <div className="stack analysis-legodds-block">
        <span className="field-label">{t('analysis.bet.takenLabel')}</span>
        <div className="analysis-legodds">
          {slip.map((item, i) => {
            const id = `analysis-own-odd-${i}`;
            const value = values[i] ?? '';
            const bad = !validOdd(value);
            const taken = numbers?.[i];
            const changed = taken !== undefined && Math.abs(taken - item.odds) > 0.0005;
            return (
              <div key={item.predictionId} className="analysis-legodd has-rm">
                <label className="analysis-legodd-name" htmlFor={id}>
                  <b>{item.name}</b>
                  <small id={`${id}-hint`}>
                    {item.p === null
                      ? t(item.model === 'failed' ? 'analysis.own.legHintFailed' : 'analysis.own.legHintNoModel', { match: item.match })
                      : t('analysis.own.legHint', {
                          match: item.match,
                          p: formatProb(item.p),
                          value: formatPercent(item.p * item.odds + item.pPush - 1, { digits: 1, signed: true }),
                        })}
                    {changed ? ` · ${t('analysis.own.legWas', { odds: formatOdds(item.odds) })}` : ''}
                  </small>
                  {item.status !== 'express' && <small className="warn-text">{t(`analysis.own.status.${item.status}`)}</small>}
                </label>
                <input
                  id={id}
                  className={cx('input', bad && 'invalid')}
                  value={value}
                  inputMode="decimal"
                  autoComplete="off"
                  maxLength={6}
                  aria-describedby={bad ? `${id}-error` : `${id}-hint`}
                  aria-invalid={bad || undefined}
                  onChange={(event) => setOdds((o) => ({ ...o, [item.predictionId]: event.target.value }))}
                  onBlur={() => {
                    if (validOdd(value)) setOdds((o) => ({ ...o, [item.predictionId]: oddInputText(oddNumber(value)) }));
                  }}
                />
                <IconButton icon="trash" label={t('analysis.own.remove', { name: item.name })} onClick={() => props.onRemove(item.predictionId)} />
                {bad && (
                  <div className="field-error" id={`${id}-error`} role="alert">
                    {t('analysis.bet.oddsRange')}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="field-hint">{t('analysis.own.addHint')}</div>
      </div>
      {choice.hiddenBook && <HiddenBookNote name={props.bookmaker ?? ''} />}
      <div className="analysis-bm-grid">
        <Field
          id="analysis-own-stake"
          label={t('analysis.stakeModal.amount')}
          value={text}
          suffix={currencySign(currency)}
          placeholder={t('analysis.own.stakeExample', { amount: formatAmountInput(example, currency) })}
          inputMode={rules.decimals ? 'decimal' : 'numeric'}
          autoComplete="off"
          maxLength={12}
          hint={t('analysis.own.stakeHint')}
          onChange={(event) => setText(event.target.value)}
          onBlur={() => {
            if (amount !== null) setText(formatAmountInput(amount, currency));
          }}
        />
        <BookmakerField id="analysis-own-bk" choice={choice} bookmakers={props.bookmakers} hint={t('analysis.own.bookHint')} />
      </div>
      <div className="stack" aria-live="polite">
        <KeyValue
          items={[
            { key: 'total', label: t('analysis.bet.total'), value: nums ? formatOdds(nums.total) : '—' },
            {
              key: 'share',
              label: t('analysis.stakeModal.share'),
              value: share !== null && amount !== null ? t('analysis.own.shareOf', { share: formatShare(share), bank: formatMoney(bank, currency) }) : '—',
            },
            { key: 'payout', label: t('analysis.bet.payout'), value: win !== null ? formatMoney(win, currency) : '—' },
            {
              key: 'profit',
              label: t('analysis.stakeModal.profit'),
              value: win !== null && amount !== null ? formatMoney(win - amount, currency, { signed: true }) : '—',
            },
            {
              key: 'p',
              label: t('analysis.own.pModel'),
              value: p === null ? '—' : `≈ ${formatProb(p)}${slip.length > 1 ? ` (${slip.map((x) => formatProb(x.p)).join(' × ')})` : ''}`,
            },
            {
              key: 'ev',
              label: t('analysis.own.valueModel'),
              value: nums && nums.ev !== null ? <span className={cx(nums.ev < 0 && 'bad-text')}>{formatPercent(nums.ev, { digits: 1, signed: true })}</span> : '—',
            },
          ]}
        />
        {!numbers && <Callout kind="bad">{t('analysis.stakeModal.checkOdds')}</Callout>}
        {amount !== null && problem === 'aboveBank' && (
          <Callout kind="bad">{t('analysis.stakeModal.aboveBank', { bank: formatMoney(bank, currency) })}</Callout>
        )}
        {amount !== null && problem === 'belowMin' && (
          <Callout kind="bad">{t('analysis.stakeModal.belowMin', { min: formatMoney(rules.min, currency) })}</Callout>
        )}
        {nums && nums.ev !== null && nums.ev < 0 && (
          <Callout kind="bad" icon="alert">
            <b>{t('analysis.variants.noValueTitle')}</b>{' '}
            {t('analysis.own.noValueText', { value: formatPercent(nums.ev, { digits: 1, signed: true }) })}
          </Callout>
        )}
        {unchecked.length > 0 && (
          <Callout kind="warn" icon="flask">
            <b>{t('analysis.own.uncheckedTitle')}</b>{' '}
            {t('analysis.own.uncheckedText', { list: unchecked.map((x) => x.name).join('; ') })}
          </Callout>
        )}
        {unsure.length > 0 && (
          <Callout kind={low ? 'warn' : 'info'} icon="alert">
            <b>{low ? t('analysis.own.confLow') : t('analysis.own.confMedium')}</b>{' '}
            {[...new Set(unsure.map((x) => x.match))].join('; ')}.
          </Callout>
        )}
        {share !== null && shareWarning(share, props.growthOn, t)}
      </div>
      {error && (
        <Callout kind="bad" role="alert">
          {error}
        </Callout>
      )}
      <Callout icon="user">
        <b>{t('analysis.own.noteTitle')}</b> {t('analysis.own.noteText')}
      </Callout>
    </Modal>
  );
}
