import { useQueryClient } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../../api/errors';
import { Button, Callout, Field, Segmented, Skeleton, useToast, type IconName } from '../../../components';
import { apiErrorText } from '../../../features/analysis/codes';
import { bankKeys, useAddBankEntry, useBankEntries } from '../../../features/bank/api';
import { parseMove } from '../../../features/bank/display';
import type { Bank, BankEntry, MoveKind } from '../../../features/bank/types';
import { currencyOf } from '../../../features/bets/display';
import { currencySign, formatDateLong, formatDateTime, formatMoney } from '../../../lib/format';
import { MetaLine, ProfileItem } from '../ProfileItem';

// «Движение банка» (movesCard макета): пополнение, вывод и корректировка (POST
// /api/me/bank/entries) и журнал этих движений (GET /api/me/bank/entries?flows_only=true).
// В прибыль и ROI они не входят. Ставки пишутся в журнал сами.

const KINDS: readonly MoveKind[] = ['deposit', 'withdrawal', 'correction'];
const ICONS: Record<BankEntry['kind'], IconName> = {
  deposit: 'wallet',
  withdrawal: 'arrowDown',
  correction: 'edit',
  stake: 'ticket',
  payout: 'check',
  refund: 'refresh',
  reversal: 'refresh',
};
// Ошибки суммы — под полем; остальное (журнал изменился) — плашкой
const AMOUNT_CODES: ReadonlySet<string> = new Set([
  'bank.amount_positive',
  'bank.amount_zero',
  'bank.withdrawal_range',
  'bank.correction_range',
  'bank.amount_range',
]);

export function MovesCard({ bank }: { bank: Bank }) {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useQueryClient();
  const entries = useBankEntries();
  const add = useAddBankEntry();
  // Запись уже отправлена: второй клик до перерисовки кнопки не шлет ее еще раз
  const busy = useRef(false);
  const amountId = useId();
  const noteId = useId();
  const [kind, setKind] = useState<MoveKind>('deposit');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const currency = currencyOf(bank.currency);
  const money = (value: string | null, signed = false) => formatMoney(value, currency, { signed });
  const correction = kind === 'correction';
  const rows = entries.data?.pages.flatMap((page) => page.items) ?? [];
  const lastId = entries.data?.pages[0]?.last_id ?? null;

  const hint =
    kind === 'withdrawal'
      ? t('profile.bank.moves.hint.withdrawal', { balance: money(bank.balance) })
      : correction
        ? t('profile.bank.moves.hint.correction')
        : t('profile.bank.moves.hint.deposit');

  async function submit() {
    const parsed = parseMove(kind, amount);
    if ('error' in parsed) {
      setFieldError(t(`profile.bank.moves.errors.${parsed.error}`));
      return;
    }
    if (kind === 'withdrawal' && Number(parsed.amount) > Number(bank.balance)) {
      setFieldError(t('errors.bank.withdrawal_range', { balance: money(bank.balance) }));
      return;
    }
    if (!entries.data || busy.current) return;
    busy.current = true;
    const started = Date.now();
    try {
      const entry = await add.mutateAsync({ kind, amount: parsed.amount, note: note.trim() || null, expected_last_id: lastId });
      setAmount('');
      setNote('');
      setFieldError(null);
      // банк — перечитанный после записи (как в макете: «… записано. Банк X»); не пришел — без числа
      const fresh = client.getQueryState<Bank>(bankKeys.all);
      const equity = fresh?.data && fresh.dataUpdatedAt >= started ? fresh.data.equity : null;
      const head = t(`profile.bank.moves.saved.${kind}`, { amount: money(entry.amount, true) });
      const tail = equity !== null ? t('profile.bank.moves.saved.bank', { bank: money(equity) }) : t('profile.bank.moves.saved.noBank');
      toast.show(`${head} ${tail}`, { icon: 'wallet' });
    } catch (error) {
      if (isApiError(error) && AMOUNT_CODES.has(error.code)) setFieldError(apiErrorText(error));
    } finally {
      busy.current = false;
    }
  }

  const serverError = add.error && !(isApiError(add.error) && AMOUNT_CODES.has(add.error.code)) ? add.error : null;
  const formId = 'profile-moves-form';
  return (
    <section className="card profile-anchor" id="profile-moves" aria-labelledby="profile-moves-title">
      <div className="card-head">
        <div className="card-head-text">
          <h3 id="profile-moves-title">{t('profile.bank.moves.title')}</h3>
          <div className="card-sub">{t('profile.bank.moves.subtitle')}</div>
        </div>
      </div>
      <form
        id={formId}
        className="profile-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="card-body">
          <Segmented<MoveKind>
            label={t('profile.bank.moves.kindLabel')}
            items={KINDS.map((value) => ({ value, label: t(`profile.bank.moves.kinds.${value}`) }))}
            value={kind}
            onChange={(value) => {
              // как в макете: другая запись — пустое поле суммы
              setKind(value);
              setAmount('');
              setFieldError(null);
              add.reset();
            }}
          />
          <div className="profile-fields collapse">
            <Field
              id={amountId}
              label={correction ? t('profile.bank.moves.amountSigned') : t('profile.bank.moves.amount')}
              suffix={currencySign(currency)}
              inputMode={correction ? 'text' : 'decimal'}
              autoComplete="off"
              placeholder={correction ? t('profile.bank.moves.correctionPlaceholder') : ''}
              value={amount}
              hint={hint}
              error={fieldError ?? undefined}
              onChange={(event) => {
                setAmount(event.target.value);
                setFieldError(null);
              }}
            />
            <Field
              id={noteId}
              label={t('profile.bank.moves.note')}
              autoComplete="off"
              maxLength={200}
              placeholder={correction ? t('profile.bank.moves.notePlaceholderCorrection') : t('profile.bank.moves.notePlaceholder')}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {serverError !== null && (
            <Callout kind="bad" role="alert">
              {apiErrorText(serverError)}
            </Callout>
          )}
          <div className="stack profile-tight">
            <h4>{t('profile.bank.moves.journal')}</h4>
            {entries.isLoading ? (
              <Skeleton lines={3} />
            ) : rows.length ? (
              <div className="profile-list">
                {rows.map((entry, i) => {
                  // Первое пополнение журнала — стартовый банк (как в макете)
                  const start = entry.kind === 'deposit' && !entries.hasNextPage && i === rows.length - 1;
                  return (
                    <ProfileItem
                      key={entry.id}
                      icon={ICONS[entry.kind]}
                      iconKind={Number(entry.amount) >= 0 ? 'good' : undefined}
                      title={start ? t('profile.bank.moves.entry.start') : t(`profile.bank.moves.entry.${entry.kind}`)}
                      wrap
                      meta={
                        start ? (
                          formatDateLong(entry.at)
                        ) : (
                          <MetaLine
                            parts={[formatDateTime(entry.at), entry.note, t('profile.bank.moves.balanceAfter', { balance: money(entry.balance_after) })]}
                          />
                        )
                      }
                      side={<span className="profile-money">{money(entry.amount, true)}</span>}
                    />
                  );
                })}
              </div>
            ) : (
              <p className="small muted">{t('profile.bank.moves.journalEmpty')}</p>
            )}
            {entries.hasNextPage && (
              <div className="row">
                <Button size="sm" icon="chevronDown" loading={entries.isFetchingNextPage} onClick={() => void entries.fetchNextPage()}>
                  {t('profile.bank.moves.more')}
                </Button>
              </div>
            )}
          </div>
          <p className="xsmall muted">{t('profile.bank.moves.betsNote')}</p>
        </div>
        <div className="card-foot">
          <Button kind="primary" type="submit" icon="check" loading={add.isPending} disabled={!entries.data}>
            {t('profile.bank.moves.submit')}
          </Button>
        </div>
      </form>
    </section>
  );
}
