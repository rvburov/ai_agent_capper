import type { TFunction } from 'i18next';
import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, Card, Chip, EmptyState, Icon, isSurface, Skeleton, surfaceColor } from '../../components';
import { HISTORY_PAGE, useBetSummary } from '../../features/bets/api';
import { betSurface, betTournament, currencyOf, isLegacy, legShown, monthOf, monthRange } from '../../features/bets/display';
import { filtersQuery, type BetFilters } from '../../features/bets/filters';
import type { BetItem } from '../../features/bets/types';
import { formatDate, formatMoney, formatOdds, formatPercent } from '../../lib/format';
import { cx } from '../../lib/cx';
import { DetailBlock } from './BetDetail';
import { betKind, ClvValue, legMarket, MatchName, matchText, money, ResultIcon, Signed, StatusChip } from './parts';

// История (historySection макета): рассчитанные ставки по месяцам. На компьютере — таблица,
// строка раскрывается деталями; на телефоне — карточки, детали в нижнем листе.


const MONTH_NAMES = 12;

function monthName(month: string, t: TFunction): string {
  const [year, m] = month.split('-');
  const names: readonly string[] = t('bets.months', { returnObjects: true });
  const index = Number(m) - 1;
  return `${index >= 0 && index < MONTH_NAMES ? (names[index] ?? m) : m} ${year}`;
}

/**
 * Итоги месяца — с сервера (GET /api/bets/summary с датами месяца в пределах фильтров): в
 * списке загружена только часть ставок, а итог месяца — по всем.
 */
function MonthStats({ month, filters, today }: { month: string; filters: BetFilters; today: string }) {
  const { t } = useTranslation();
  const range = monthRange(month, filters, today);
  const query = range ? { ...filtersQuery({ ...filters, period: 'all', from: range.from, to: range.to }) } : {};
  const summary = useBetSummary(query, { enabled: range !== null });
  const s = summary.data;
  if (!range || !s) return <span className="bets-month-stats" />;
  const currency = currencyOf(s.currency);
  return (
    <span className="bets-month-stats">
      {t('bets.count', { count: s.settled })} ·{' '}
      <b>
        <Signed value={s.profit} text={formatMoney(s.profit, currency, { signed: true })} />
      </b>{' '}
      · {t('bets.history.roi', { value: formatPercent(s.roi, { signed: true }) })}
    </span>
  );
}

function Dot({ surface }: { surface: string | null }) {
  return <i className="bets-dot" style={{ background: isSurface(surface) ? surfaceColor(surface) : 'var(--fg-3)' }} aria-hidden="true" />;
}

function surfaceText(surface: string | null, t: TFunction): string {
  return isSurface(surface) ? t(`bets.filters.surfaces.${surface}`).toLowerCase() : t('bets.filters.surfaces.unknown').toLowerCase();
}

interface HistoryProps {
  bets: BetItem[];
  /** Сколько всего рассчитанных ставок по фильтрам (итоги). */
  total: number | null;
  loading: boolean;
  /** Список не загрузился: пустое состояние не показываем. */
  failed: boolean;
  /** Не загрузилась следующая страница: «Показать еще» повторяет запрос. */
  moreFailed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: () => void;
  filters: BetFilters;
  today: string;
  mobile: boolean;
  expanded: ReadonlySet<number>;
  onToggle: (bet: BetItem) => void;
  onOpen: (bet: BetItem) => void;
  onClosing: (bet: BetItem) => void;
  onCorrect: (bet: BetItem) => void;
  /** Ставка, только что рассчитанная на этом экране, — подсвечена. */
  fresh: number | null;
  /** Пусто по фильтрам: описание выборки и «Сбросить фильтры». */
  caption: string;
  filtered: boolean;
  onReset: () => void;
}

function groupByMonth(bets: BetItem[]): { month: string; bets: BetItem[] }[] {
  const groups: { month: string; bets: BetItem[] }[] = [];
  for (const bet of bets) {
    const month = monthOf(bet.placed_at);
    const last = groups[groups.length - 1];
    if (last && last.month === month) last.bets.push(bet);
    else groups.push({ month, bets: [bet] });
  }
  return groups;
}

export function History(props: HistoryProps) {
  const { t } = useTranslation();
  const { bets, total, loading, hasMore, loadingMore, onMore, mobile } = props;
  if (loading && !bets.length) {
    return (
      <Card title={t('bets.history.title')}>
        <Skeleton lines={4} />
      </Card>
    );
  }
  if (props.failed) {
    return (
      <Card title={t('bets.history.title')}>
        <p className="small muted">{t('bets.history.failed')}</p>
      </Card>
    );
  }
  // «Пусто» — только когда страниц больше нет: в загруженных бывают одни открытые ставки
  if (!bets.length && !hasMore) {
    return (
      <Card title={t('bets.history.title')}>
        <div className="stack bets-center">
          <EmptyState>{props.filtered ? t('bets.history.emptyFiltered', { filters: props.caption }) : t('bets.history.empty')}</EmptyState>
          {props.filtered && (
            <Button size="sm" icon="x" onClick={props.onReset}>
              {t('bets.filters.reset')}
            </Button>
          )}
        </div>
      </Card>
    );
  }
  const subtitle = t('bets.history.subtitle', { count: total ?? bets.length });
  const count = <span className="small muted">{t('bets.history.shown', { shown: bets.length, total: total ?? bets.length })}</span>;
  const left = total !== null ? Math.min(HISTORY_PAGE, Math.max(0, total - bets.length)) : 0;
  const more = hasMore ? (
    <>
      {props.moreFailed && (
        <span className="small bets-more-err" role="alert">
          {t('bets.history.moreFailed')}
        </span>
      )}
      <Button size="sm" icon="chevronDown" loading={loadingMore} onClick={onMore}>
        {left > 0 ? t('bets.history.moreN', { n: left }) : t('bets.history.more')}
      </Button>
    </>
  ) : null;
  const groups = groupByMonth(bets);
  if (mobile) {
    return (
      <section className="stack" aria-label={t('bets.history.label')}>
        <div className="bets-sec-head">
          <h3>{t('bets.history.title')}</h3>
          <span className="small muted">{subtitle}</span>
        </div>
        <div className="bets-mlist">
          {groups.map((group) => (
            <Fragment key={group.month}>
              <div className="bets-mmonth">
                <span className="bets-month-name">{monthName(group.month, t)}</span>
                <MonthStats month={group.month} filters={props.filters} today={props.today} />
              </div>
              {group.bets.map((bet) => (
                <BetCard key={bet.id} bet={bet} fresh={props.fresh === bet.id} onOpen={props.onOpen} />
              ))}
            </Fragment>
          ))}
        </div>
        <div className="bets-more">
          {count}
          {more}
        </div>
      </section>
    );
  }
  return (
    <Card
      className="bets-hist"
      title={t('bets.history.title')}
      subtitle={subtitle}
      actions={<span className="xsmall muted">{t('bets.history.clickHint')}</span>}
      flush
      foot={
        <>
          {count}
          {more}
        </>
      }
    >
      <DesktopTable {...props} groups={groups} />
    </Card>
  );
}

const COLS = 8;

function DesktopTable({ groups, expanded, onToggle, onClosing, onCorrect, fresh, filters, today }: HistoryProps & { groups: { month: string; bets: BetItem[] }[] }) {
  const { t } = useTranslation();
  return (
    <div className="table-wrap">
      <table className="table bets-table">
        <caption className="sr-only">{t('bets.history.caption')}</caption>
        <thead>
          <tr>
            <th scope="col" className="bets-col-date">{t('bets.history.cols.date')}</th>
            <th scope="col">{t('bets.history.cols.events')}</th>
            <th scope="col" className="r">{t('bets.history.cols.odds')}</th>
            <th scope="col" className="r">{t('bets.history.cols.stake')}</th>
            <th scope="col">{t('bets.history.cols.status')}</th>
            <th scope="col" className="r">{t('bets.history.cols.profit')}</th>
            <th scope="col" className="r">{t('bets.history.cols.clv')}</th>
            <th scope="col" className="r bets-col-exp">
              <span className="sr-only">{t('bets.history.cols.details')}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => (
            <Fragment key={group.month}>
              <tr className="bets-month">
                <td colSpan={COLS}>
                  <div className="bets-month-in">
                    <span className="bets-month-name">{monthName(group.month, t)}</span>
                    <MonthStats month={group.month} filters={filters} today={today} />
                  </div>
                </td>
              </tr>
              {group.bets.map((bet) => (
                <Fragment key={bet.id}>
                  <Row bet={bet} open={expanded.has(bet.id)} fresh={fresh === bet.id} onToggle={onToggle} />
                  {expanded.has(bet.id) && (
                    <tr className="bets-detail-row" id={`bet-${bet.id}-detail`}>
                      <td colSpan={COLS}>
                        <DetailBlock bet={bet} onClosing={onClosing} onCorrect={onCorrect} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LegLine({ bet, leg }: { bet: BetItem; leg: BetItem['legs'][number] }) {
  return (
    <div className="bets-legline">
      <ResultIcon shown={legShown(bet, leg)} />
      <span className="bets-min">
        <span className="bets-legline-m">
          <MatchName leg={leg} />
        </span>
        <span className="muted"> · {legMarket(leg)} @</span>
        <span className="odds muted">{formatOdds(leg.odds_taken)}</span>
      </span>
    </div>
  );
}

function Row({ bet, open, fresh, onToggle }: { bet: BetItem; open: boolean; fresh: boolean; onToggle: (bet: BetItem) => void }) {
  const { t } = useTranslation();
  const surface = betSurface(bet);
  const tournament = betTournament(bet);
  return (
    <tr className={cx('bets-row', open && 'is-expanded', fresh && 'is-new')} data-bet={bet.id} onClick={() => onToggle(bet)}>
      <td>
        <div className="bets-date">{formatDate(bet.placed_at)}</div>
        <div className="bets-sub">
          <Dot surface={surface} />
          {[tournament, surfaceText(surface, t)].filter(Boolean).join(' · ')}
        </div>
        {isLegacy(bet) && (
          <span title={t('bets.history.botTitle')}>
            <Chip kind="outline" className="bets-src">
              {t('bets.history.bot')}
            </Chip>
          </span>
        )}
      </td>
      <td>
        {bet.legs.map((leg) => (
          <LegLine key={leg.id} bet={bet} leg={leg} />
        ))}
      </td>
      <td className="r">
        <span className="odds">{formatOdds(bet.total_odds)}</span>
      </td>
      <td className="r">{money(bet, bet.stake)}</td>
      <td>
        <StatusChip status={bet.status} />
      </td>
      <td className="r">
        <Signed value={bet.profit} text={money(bet, bet.profit, true)} className="bets-profit" />
      </td>
      <td className="r">
        <ClvValue value={bet.clv} legacy={isLegacy(bet)} />
      </td>
      <td className="r">
        <button
          type="button"
          className="btn ghost sm icon-only bets-exp"
          aria-expanded={open}
          aria-controls={open ? `bet-${bet.id}-detail` : undefined}
          aria-label={t('bets.history.details', { id: bet.id })}
          onClick={(event) => {
            event.stopPropagation();
            onToggle(bet);
          }}
        >
          <Icon name="chevronDown" />
        </button>
      </td>
    </tr>
  );
}

function BetCard({ bet, fresh, onOpen }: { bet: BetItem; fresh: boolean; onOpen: (bet: BetItem) => void }) {
  const { t } = useTranslation();
  const surface = betSurface(bet);
  const tournament = betTournament(bet);
  const label = t('bets.history.cardLabel', {
    id: bet.id,
    date: formatDate(bet.placed_at),
    status: t(`bets.status.${bet.status}`),
    profit: money(bet, bet.profit, true),
  });
  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(bet);
  }
  const sub: ReactNode[] = [tournament, surfaceText(surface, t), t('bets.number', { id: bet.id }), isLegacy(bet) ? t('bets.history.bot') : null];
  return (
    <div className={cx('bets-mcard', fresh && 'is-new')} role="button" tabIndex={0} aria-label={label} onClick={() => onOpen(bet)} onKeyDown={onKey}>
      <div className="bets-mcard-top">
        <div className="bets-min">
          <div className="bets-mcard-date">{`${formatDate(bet.placed_at)} · ${betKind(bet, t)}`}</div>
          <div className="bets-sub">
            <Dot surface={surface} />
            {sub.filter(Boolean).join(' · ')}
          </div>
        </div>
        <StatusChip status={bet.status} />
      </div>
      <ul className="bets-mlegs">
        {bet.legs.map((leg) => (
          <li key={leg.id}>
            <ResultIcon shown={legShown(bet, leg)} />
            <span className="m">{matchText(leg)}</span>
            <span className="k">
              {legMarket(leg)}
              <span className="odds">{formatOdds(leg.odds_taken)}</span>
            </span>
          </li>
        ))}
      </ul>
      <dl className="bets-mcard-sum">
        <div>
          <dt>{t('bets.history.cols.odds')}</dt>
          <dd className="odds">{formatOdds(bet.total_odds)}</dd>
        </div>
        <div>
          <dt>{t('bets.history.cols.stake')}</dt>
          <dd>{money(bet, bet.stake)}</dd>
        </div>
        <div>
          <dt>{t('bets.history.cols.profit')}</dt>
          <dd>
            <Signed value={bet.profit} text={money(bet, bet.profit, true)} />
          </dd>
        </div>
      </dl>
    </div>
  );
}
