import { useTranslation } from 'react-i18next';

import { useBank } from '../../features/analysis/api';
import { currencyOf } from '../../features/bets/display';
import { formatMoney } from '../../lib/format';
import './BankPill.css';

/**
 * Плашка «Банк» в шапке (bank-pill макета): капитал с учетом ставок в игре, как на главной.
 * Данные — GET /api/me/bank (ключ ['bank']): расчет ставки, сторно и движение банка перечитывают
 * его сами. Пока банк не загрузился (или его еще нет — ни ставок, ни пополнений) — плашки нет.
 */
export function BankPill() {
  const { t } = useTranslation();
  const { data: bank } = useBank();
  if (!bank || bank.empty) return null;
  return (
    <span className="bank-pill" title={t('shell.bankTitle')}>
      <span className="muted hide-mobile">{t('shell.bank')}</span>
      <b>{formatMoney(bank.equity, currencyOf(bank.currency))}</b>
    </span>
  );
}
