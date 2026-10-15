import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Chip, Icon } from '../../components';
import { closingByHand, settledBy } from '../../features/bets/display';
import type { BetItem, BetLeg, Closing } from '../../features/bets/types';
import { formatDate, formatOdds } from '../../lib/format';
import { closingWhoText, StatusChip } from './parts';

// Метки «Ставок» этапа 5 (расчет по архиву tennis-data): кто рассчитал ставку, «ждет
// результата», закрытие из архива и «внесите сами» у фор, пояснение к вердикту по CLV. Отдельно
// от parts.tsx: те части берет и главная, а эти тексты нужны только экрану «Ставки».

/** Пояснение к вердикту по CLV (reviewNext макета). Вердикт считает сервер, без запроса к ИИ. */
export function reviewText(bet: Pick<BetItem, 'status' | 'verdict'>, t: TFunction): string {
  if (bet.status === 'open') return t('bets.review.open');
  return t(`bets.review.${bet.verdict ?? 'no_closing'}`);
}

/** Подсказка к закрытию из архива (Т1): момент снятия кэфа не проверен. */
export function closingNote(closing: Pick<Closing, 'source' | 'unverified'>, t: TFunction): string | undefined {
  return closing.source === 'archive' || closing.unverified ? t('bets.closing.archiveNote') : undefined;
}

/** Закрытие ноги: кэф и чей он; у форы рассчитанной ставки без закрытия — «внесите сами». */
export function ClosingCell({ bet, leg, small = false }: { bet: BetItem; leg: BetLeg; small?: boolean }) {
  const { t } = useTranslation();
  if (leg.closing) {
    const who = closingWhoText(leg.closing, bet.bookmaker, t);
    const note = closingNote(leg.closing, t);
    return (
      <>
        <span className="odds">{formatOdds(leg.closing.odds)}</span>
        {small ? (
          <small title={note}>{who}</small>
        ) : (
          <div className="xsmall muted bets-nw" title={note}>
            {who}
          </div>
        )}
      </>
    );
  }
  if (closingByHand(bet, leg)) {
    return (
      <span className="xsmall muted bets-nw" title={t('bets.closing.byHandTitle')}>
        {t('bets.closing.byHand')}
      </span>
    );
  }
  return <span className="odds">—</span>;
}

/** Кто рассчитал ставку — под датой в истории: «авто · архив 4 окт» или «внесено вами». */
export function SettledByTag({ bet }: { bet: BetItem }) {
  const { t } = useTranslation();
  const by = settledBy(bet);
  if (by === null) return null;
  if (by === 'manual') {
    return (
      <span className="bets-by" title={t('bets.by.manualTitle')}>
        <Icon name="user" />
        {t('bets.by.manual')}
      </span>
    );
  }
  const date = bet.archive_to ? formatDate(bet.archive_to) : null;
  return (
    <span className="bets-by auto" title={date ? t('bets.by.autoTitle', { date }) : t('bets.by.autoTitleNoDate')}>
      <Icon name="database" />
      {date ? t('bets.by.auto', { date }) : t('bets.by.autoNoDate')}
    </span>
  );
}

/** Метка открытой ставки: «Ждет результата», если все матчи сыграны, иначе «В игре». */
export function OpenStatusChip({ bet }: { bet: Pick<BetItem, 'status' | 'awaiting_result'> }) {
  const { t } = useTranslation();
  if (bet.status === 'open' && bet.awaiting_result) {
    return (
      <Chip kind="warn" icon="clock">
        {t('bets.awaiting.chip')}
      </Chip>
    );
  }
  return <StatusChip status={bet.status} />;
}
