import { useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { isApiError } from '../../api/errors';
import { Button, Callout, KeyValue, Modal } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { freshest, useBet, useReverseBet } from '../../features/bets/api';
import { subMoney } from '../../features/bets/money';
import type { BetItem } from '../../features/bets/types';
import { money, Signed, StatusChip } from './parts';

// «Исправить результат» (correctModal макета): расчет отменяется сторно (POST …/reverse), ставка
// снова открыта, затем сразу открывается окно результата с прежними значениями. Банк после
// отмены — капитал минус прибыль ставки (у проигрыша сумма ставки снова «в игре»).

interface CorrectModalProps {
  bet: BetItem;
  /** Капитал по учету (баланс + ставки в игре). */
  equity: string | null;
  onClose: () => void;
  /** Сторно прошло: before — ставка до отмены (ее исходы и счет — в окно результата), after — открытая. */
  onReversed: (before: BetItem, after: BetItem) => void;
}

export function CorrectModal({ bet: initial, equity, onClose, onReversed }: CorrectModalProps) {
  const { t } = useTranslation();
  // Свежая версия ставки (после закрытия или расчета в другом окне): сторно идет с ней
  const bet = freshest(useBet(initial.id, initial).data, initial);
  const reverse = useReverseBet();
  // Сторно уже отправлено: второй клик до перерисовки кнопки не шлет его еще раз
  const busy = useRef(false);
  const loss = bet.status === 'lost';
  const profit = bet.profit ?? '0.00';
  const after = equity !== null ? subMoney(equity, profit) : null;
  let what: string;
  if (loss) {
    what = t('bets.correct.loss', { stake: money(bet, bet.stake), bank: after !== null ? money(bet, after) : '—' });
  } else if (bet.status === 'won') {
    what = t('bets.correct.won', { amount: money(bet, bet.payout) });
  } else {
    what = t('bets.correct.void', { amount: money(bet, bet.stake) });
  }

  async function confirm() {
    if (busy.current) return;
    busy.current = true;
    try {
      const reopened = await reverse.mutateAsync(bet);
      onReversed(bet, reopened);
    } catch {
      // текст ошибки — в окне (reverse.error)
    } finally {
      busy.current = false;
    }
  }
  const error = reverse.error;

  return (
    <Modal
      open
      onClose={onClose}
      title={t('bets.correct.title', { id: bet.id })}
      footer={
        <>
          <Button onClick={onClose}>{t('bets.settle.cancel')}</Button>
          <Button kind="primary" icon="edit" loading={reverse.isPending} onClick={() => void confirm()}>
            {t('bets.correct.confirm')}
          </Button>
        </>
      }
    >
      <p className="small soft">
        {what} {t('bets.correct.then')}
      </p>
      <KeyValue
        items={[
          { key: 'now', label: t('bets.correct.now'), value: <StatusChip status={bet.status} /> },
          { key: 'profit', label: t('bets.detail.profit'), value: <Signed value={profit} text={money(bet, profit, true)} /> },
          { key: 'bank', label: t('bets.correct.bankNow'), value: equity !== null ? money(bet, equity) : '—' },
          { key: 'after', label: loss ? t('bets.correct.bankAfterCancel') : t('bets.correct.bankAfterReversal'), value: after !== null ? money(bet, after) : '—' },
        ]}
      />
      <Callout kind="warn">
        {t('bets.correct.warn')}
        {loss ? '' : ` ${t('bets.correct.warnJournal')}`}
      </Callout>
      {error && (
        <Callout kind="bad" role="alert">
          {/* при гонке окно уже получило свежую версию ставки — подтвердить можно еще раз */}
          {isApiError(error) && error.code === 'bet.changed' ? t('bets.correct.changed') : apiErrorText(error)}
        </Callout>
      )}
    </Modal>
  );
}
