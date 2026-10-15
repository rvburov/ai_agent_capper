import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Icon, IconButton } from '../../components';
import type { BetItem } from '../../features/bets/types';
import { reviewText } from './marks';
import { money, VerdictChip } from './parts';

// Сообщение после расчета (banner макета): итог, банк, вердикт по CLV и «Исправить результат».
// При ручном расчете уведомления в колокольчике нет — только это сообщение (Т12). После
// расчета фокус переходит сюда: кнопка «Внести результат», с которой открыли окно, исчезает
// вместе с карточкой ставки.

export interface SettledInfo {
  bet: BetItem;
  /** Расчет был исправлен: с какого итога (у проигрыша сторно в журнале нет). */
  correctedFrom: BetItem['status'] | null;
}

export function SettleBanner({
  settled,
  equity,
  onCorrect,
  onHide,
}: {
  settled: SettledInfo;
  equity: string | null;
  onCorrect: (bet: BetItem) => void;
  onHide: () => void;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const { bet, correctedFrom } = settled;
  // Эффект идет после того, как закрытое окно вернуло фокус на кнопку: перехватываем его
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [settled]);
  const corrected = correctedFrom !== null;
  let result: string;
  if (bet.status === 'won') result = t('bets.banner.won', { profit: money(bet, bet.profit, true) });
  else if (bet.status === 'lost') result = t('bets.banner.lost', { profit: money(bet, bet.profit, true) });
  else result = t('bets.banner.void');
  return (
    <div ref={ref} className="callout accent bets-banner" role="status" tabIndex={-1}>
      <Icon name="check" />
      <div className="bets-banner-body">
        <div>
          <b>{corrected ? t('bets.banner.corrected', { id: bet.id, result }) : t('bets.banner.settled', { id: bet.id, result })}</b>{' '}
          {/* банк — только перечитанный после расчета (equity null, пока ответ не пришел) */}
          {equity !== null && t('bets.banner.bank', { bank: money(bet, equity) })}
          {corrected && ` ${correctedFrom === 'lost' ? t('bets.banner.journalLoss') : t('bets.banner.journal')}`}
        </div>
        <div className="row bets-banner-verdict">
          <span>{t('bets.detail.verdictLabel')}</span>
          <VerdictChip verdict={bet.verdict} />
          <span>{reviewText(bet, t)}</span>
        </div>
        <div className="xsmall muted">{t('bets.banner.note')}</div>
        <div className="row">
          <Button size="sm" icon="edit" onClick={() => onCorrect(bet)}>
            {t('bets.actions.correct')}
          </Button>
        </div>
      </div>
      <IconButton icon="x" size="sm" label={t('bets.banner.hide')} onClick={onHide} />
    </div>
  );
}
