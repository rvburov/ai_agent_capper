import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Icon, Skeleton } from '../../components';
import { currencyOf } from '../../features/bets/display';
import type { BetsSummary } from '../../features/bets/types';
import { formatMoney, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Signed } from './parts';

// Итоги по фильтрам (summaryCard макета): числа — из GET /api/bets/summary, тут только вид.

function Cell({ label, value, sub, className, extra }: { label: ReactNode; value: ReactNode; sub: ReactNode; className?: string; extra?: ReactNode }) {
  return (
    <div className="bets-sum-cell">
      <div className="bets-sum-l">{label}</div>
      <div className={cx('bets-sum-v', className)}>{value}</div>
      {extra}
      <div className="bets-sum-s">{sub}</div>
    </div>
  );
}

const NW = 'bets-nw';

interface SummaryCardProps {
  summary: BetsSummary | undefined;
  /** Итоги не загрузились: вместо скелета — строка об ошибке. */
  failed: boolean;
  /** Подпись выборки: «за 30 дней · выигрыш · хард». */
  caption: string;
  /** Выбран хоть один фильтр: прибыль — «по выбранным ставкам», а не «банк сейчас». */
  filtered: boolean;
  /** Капитал по учету (с учетом ставок в игре) для подписи под прибылью. */
  equity: string | null;
  showReset: boolean;
  onReset: () => void;
  pending: boolean;
}

export function SummaryCard({ summary, failed, caption, filtered, equity, showReset, onReset, pending }: SummaryCardProps) {
  const { t } = useTranslation();
  return (
    <section className={cx('card bets-sum', pending && 'is-pending')} aria-label={t('bets.summary.label')} aria-busy={pending || undefined}>
      <div className="bets-sum-cap">
        <span className="eyebrow">{t('bets.summary.eyebrow')}</span>
        <span className="small muted bets-sum-caption">{caption}</span>
        {showReset && (
          <Button kind="ghost" size="sm" icon="x" className="bets-sum-reset" onClick={onReset}>
            {t('bets.filters.reset')}
          </Button>
        )}
      </div>
      {summary ? (
        <SummaryGrid summary={summary} filtered={filtered} equity={equity} />
      ) : failed ? (
        <p className="small muted bets-sum-failed">{t('bets.summary.failed')}</p>
      ) : (
        <Skeleton lines={3} className="bets-sum-skeleton" />
      )}
      <div className="bets-sum-note">
        <Icon name="info" />
        <span>{t('bets.summary.note')}</span>
      </div>
    </section>
  );
}

function SummaryGrid({ summary: s, filtered, equity }: { summary: BetsSummary; filtered: boolean; equity: string | null }) {
  const { t } = useTranslation();
  const currency = currencyOf(s.currency);
  const money = (amount: string | null, signed = false) => formatMoney(amount, currency, { signed });
  const bar =
    s.settled > 0 ? (
      <div className="bets-wlv" aria-hidden="true">
        {(['won', 'lost', 'void'] as const)
          .filter((k) => s[k] > 0)
          .map((k) => (
            <i key={k} className={k} style={{ flexGrow: s[k] }} />
          ))}
      </div>
    ) : null;
  let clvSub: ReactNode;
  if (s.clv_n > 0) {
    clvSub = (
      <>
        {t('bets.summary.clvBetter')} <span className={NW}>{t('bets.summary.clvOf', { n: s.clv_positive, total: s.clv_n })}</span>
      </>
    );
  } else if (s.settled > 0 && s.legacy_settled === s.settled) {
    clvSub = t('bets.summary.clvBot');
  } else {
    clvSub = t('bets.summary.clvNone');
  }
  return (
    <div className="bets-sum-grid">
      <Cell
        label={t('bets.summary.settled')}
        value={String(s.settled)}
        sub={
          s.open > 0 ? (
            <>
              {t('bets.summary.openMore', { n: s.open })} <span className={NW}>{money(s.open_stake)}</span>
            </>
          ) : (
            t('bets.summary.openNone')
          )
        }
      />
      <Cell
        label={
          <>
            <span className="bets-l-full">{t('bets.summary.wlv')}</span>
            <span className="bets-l-short">{t('bets.summary.wlvShort')}</span>
          </>
        }
        value={`${s.won} · ${s.lost} · ${s.void}`}
        sub={s.winrate === null ? t('bets.summary.noSettled') : t('bets.summary.winrate', { value: formatPercent(s.winrate) })}
        extra={bar}
      />
      <Cell
        label={t('bets.summary.turnover')}
        value={money(s.turnover)}
        sub={
          s.avg_stake !== null ? (
            <>
              {t('bets.summary.avgStake')} <span className={NW}>{money(s.avg_stake)}</span>
            </>
          ) : (
            '—'
          )
        }
      />
      <Cell
        label={t('bets.summary.profit')}
        value={<Signed value={s.profit} text={money(s.profit, true)} />}
        sub={
          filtered ? (
            t('bets.summary.profitFiltered')
          ) : (
            <>
              {/* капитал перечитывается после расчета — до ответа прочерк, а не прежнее число */}
              {t('bets.summary.bankNow')} <span className={NW}>{equity === null ? '—' : money(equity)}</span>
            </>
          )
        }
      />
      <Cell label={t('bets.summary.roi')} value={<Signed value={s.roi} text={formatPercent(s.roi, { signed: true })} />} sub={t('bets.summary.roiHint')} />
      <Cell label={t('bets.summary.clv')} value={<Signed value={s.clv} text={formatPercent(s.clv, { signed: true })} />} sub={clvSub} />
    </div>
  );
}
