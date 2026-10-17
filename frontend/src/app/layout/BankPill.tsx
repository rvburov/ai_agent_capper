import { useTranslation } from 'react-i18next';

import { Icon } from '../../components';
import { useBank } from '../../features/analysis/api';
import { currencyOf } from '../../features/bets/display';
import { useViewMode } from '../../features/view/context';
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
  const view = useViewMode();
  if (!bank || bank.empty) return null;
  if (view.asUser !== null) {
    // Р27: банк участника, чьи данные смотрит администратор, — желтой плашкой с глазом
    return (
      <span className="bank-pill vw-pill" title={t('view.bankTitle')}>
        <Icon name="eye" />
        <span className="muted hide-mobile">{t('shell.bank')}</span>
        <b>{formatMoney(bank.equity, currencyOf(bank.currency))}</b>
      </span>
    );
  }
  return (
    <span className="bank-pill" title={t('shell.bankTitle')}>
      <span className="muted hide-mobile">{t('shell.bank')}</span>
      <b>{formatMoney(bank.equity, currencyOf(bank.currency))}</b>
    </span>
  );
}
