import type { TFunction } from 'i18next';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router';

import { isApiError } from '../../api/errors';
import { Button, Callout, useToast } from '../../components';
import { apiErrorText } from '../../features/analysis/codes';
import { useBank } from '../../features/analysis/api';
import { HISTORY_PAGE, OPEN_PAGE, useBet, useBetList, useBetSummary } from '../../features/bets/api';
import { localDay, MARKET_KEY } from '../../features/bets/display';
import {
  anyActive,
  EMPTY_FILTERS,
  exportHref,
  filtersFromSearch,
  filtersQuery,
  searchWithFilters,
  type BetFilters,
} from '../../features/bets/filters';
import type { BetItem } from '../../features/bets/types';
import { formatDateRange } from '../../lib/format';
import { MOBILE_QUERY, useMediaQuery } from '../../lib/useMediaQuery';
import { BetSheet } from './BetDetail';
import { DesktopFilters, MobileFilters } from './BetsFilters';
import { ClosingModal } from './ClosingModal';
import { CorrectModal } from './CorrectModal';
import { History } from './History';
import { OpenSection } from './OpenSection';
import { money } from './parts';
import { SettleBanner, type SettledInfo } from './SettleBanner';
import { SettleModal, type LegPrefill } from './SettleModal';
import { SummaryCard } from './SummaryCard';
import './bets.css';

/*
 * «Ставки» (mockup/js/screens/bets.js): фильтры в адресе, итоги по фильтрам, «В игре» с
 * «Внести результат», история по месяцам, окна результата, исправления и закрытия, CSV.
 * /bets?bet=ID открывает ставку: открытую — окном результата, рассчитанную — деталями.
 */

interface SettleTarget {
  bet: BetItem;
  prefill?: LegPrefill[];
  correctedFrom?: BetItem['status'];
}

/** Номер ставки из параметра адреса (bet, new); мусор — null. */
function idParam(params: URLSearchParams, name: string): number | null {
  const value = Number(params.get(name));
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** Подпись выборки итогов: «за 30 дней · выигрыш · хард, грунт · «синнер»». */
function describe(filters: BetFilters, t: TFunction): string {
  const parts: string[] = [];
  if (filters.from && filters.to) parts.push(formatDateRange(filters.from, filters.to));
  // одна граница — «с 1 окт» или «по 5 окт», как метка дат в фильтрах (DatesChip)
  else if (filters.from) parts.push(t('bets.filters.since', { date: formatDateRange(filters.from, filters.from) }));
  else if (filters.to) parts.push(t('bets.filters.until', { date: formatDateRange(filters.to, filters.to) }));
  else parts.push(filters.period === 'all' ? t('bets.describe.all') : t('bets.describe.period', { period: t(`bets.filters.periods.${filters.period}`) }));
  if (filters.status) parts.push(t(`bets.filters.statuses.${filters.status}`).toLowerCase());
  if (filters.market) parts.push(t(`bets.filters.markets.${MARKET_KEY[filters.market]}`));
  if (filters.source) parts.push(t(`bets.filters.sources.${filters.source}`).toLowerCase());
  if (filters.surfaces.length) parts.push(filters.surfaces.map((s) => t(`bets.filters.surfaces.${s}`).toLowerCase()).join(', '));
  const q = filters.q.trim();
  if (q) parts.push(`«${q}»`);
  return parts.join(' · ');
}

/** Открытые ставки — по дню первого матча, как в макете (ближайшие сверху). */
function byFirstMatch(a: BetItem, b: BetItem): number {
  const day = (bet: BetItem) => bet.legs.map((leg) => leg.match.day ?? '9999-12-31').sort()[0] ?? '9999-12-31';
  const da = day(a);
  const db = day(b);
  return da < db ? -1 : da > db ? 1 : a.id - b.id;
}

function prefillOf(bet: BetItem): LegPrefill[] {
  return bet.legs.map((leg) => ({ result: leg.result, score: leg.score }));
}

export function BetsPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const filters = useMemo(() => filtersFromSearch(params), [params]);
  const query = useMemo(() => filtersQuery(filters), [filters]);
  const queryKey = JSON.stringify(query);
  const mobile = useMediaQuery(MOBILE_QUERY);
  const filtered = anyActive(filters);
  const today = localDay(new Date());

  // Когда на этом экране последний раз менялся банк (расчет, сторно): капитал из кэша до
  // ответа /api/me/bank — еще прежний, его не показываем
  const [changedAt, setChangedAt] = useState(0);
  const bank = useBank();
  const equity = bank.data && bank.dataUpdatedAt > changedAt ? bank.data.equity : null;
  const summary = useBetSummary(query);
  const showOpen = filters.status === null || filters.status === 'open';
  const showHistory = filters.status !== 'open';
  const openList = useBetList({ ...query, status: 'open' }, { limit: OPEN_PAGE, enabled: showOpen });
  const history = useBetList(query, { limit: HISTORY_PAGE, enabled: showHistory });

  const openBets = useMemo(
    () => (openList.data?.pages.flatMap((page) => page.items) ?? []).slice().sort(byFirstMatch),
    [openList.data],
  );
  // Список истории без фильтра статуса содержит и открытые ставки — их показывает «В игре»
  const settledBets = useMemo(
    () => (history.data?.pages.flatMap((page) => page.items) ?? []).filter((bet) => bet.status !== 'open'),
    [history.data],
  );

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const expandInit = useRef(false);
  const [settleFor, setSettleFor] = useState<SettleTarget | null>(null);
  const [correctFor, setCorrectFor] = useState<BetItem | null>(null);
  const [closingFor, setClosingFor] = useState<BetItem | null>(null);
  const [sheetFor, setSheetFor] = useState<BetItem | null>(null);
  const [settled, setSettled] = useState<SettledInfo | null>(null);
  // Рассчитанная ставка по ссылке /bets?bet=ID: на компьютере ищем ее строку в истории
  const [seek, setSeek] = useState<BetItem | null>(null);
  // Ставка, только что сохраненная на экране «Анализ» (/bets?new=ID), — подсвечена в «В игре»
  const [justSaved, setJustSaved] = useState<number | null>(null);

  // Адрес меняем от последнего записанного, а не от адреса этой отрисовки: setSearchParams с
  // функцией берет параметры из замыкания, и две правки подряд (убрать bet, сбросить фильтры)
  // затирали бы друг друга
  const latest = useRef(params);
  const seen = useRef(params);
  if (seen.current !== params) {
    seen.current = params;
    latest.current = params;
  }
  const writeParams = useCallback(
    (change: (prev: URLSearchParams) => URLSearchParams, replace: boolean) => {
      const next = change(new URLSearchParams(latest.current));
      latest.current = next;
      setParams(next, { replace });
    },
    [setParams],
  );
  const setFilters = useCallback(
    (next: BetFilters, replace = false) => writeParams((prev) => searchWithFilters(next, prev), replace),
    [writeParams],
  );
  const resetFilters = useCallback(() => setFilters(EMPTY_FILTERS), [setFilters]);
  const dropParam = useCallback(
    (name: string) =>
      writeParams((prev) => {
        prev.delete(name);
        return prev;
      }, true),
    [writeParams],
  );

  // История: рассчитанных показываем по страницам из HISTORY_PAGE. Сервер отдает страницы без
  // фильтра статуса, и в них бывают одни открытые ставки, — тогда дочитываем следующие сами,
  // пока не наберется страница рассчитанных или они не кончатся (их число — из итогов)
  const [want, setWant] = useState({ key: queryKey, n: HISTORY_PAGE });
  const wantN = want.key === queryKey ? want.n : HISTORY_PAGE;
  const settledTotal = summary.data && !summary.isPlaceholderData ? summary.data.settled : null;
  const historyReady = showHistory && history.data !== undefined && !history.isPlaceholderData;
  const historyLeft = historyReady && history.hasNextPage && (settledTotal === null || settledBets.length < settledTotal);
  const historyIdle = !history.isFetching && !history.isError;
  const autoMore = historyLeft && historyIdle && (settledBets.length < wantN || seek !== null);
  const fetchHistory = history.fetchNextPage;
  useEffect(() => {
    if (autoMore) void fetchHistory({ cancelRefetch: false });
  }, [autoMore, fetchHistory]);

  function moreHistory() {
    setWant({ key: queryKey, n: settledBets.length + HISTORY_PAGE });
    // после ошибки страницы автодочитка стоит — повтор по кнопке
    if (history.isError) void fetchHistory({ cancelRefetch: false });
  }

  // На компьютере самая свежая рассчитанная ставка раскрыта сразу (expandInit макета)
  useEffect(() => {
    if (expandInit.current || mobile || !settledBets.length) return;
    expandInit.current = true;
    const newest = settledBets[0];
    if (newest) setExpanded(new Set([newest.id]));
  }, [mobile, settledBets]);

  const toggle = useCallback((bet: BetItem) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(bet.id)) next.delete(bet.id);
      else next.add(bet.id);
      return next;
    });
  }, []);

  // /bets?bet=ID (handleParam макета): открытая — окно результата; рассчитанная на телефоне —
  // нижний лист, на компьютере — строка истории (страницы дочитываются, пока она не найдется).
  // Ссылка разбирается один раз: повторный запуск эффекта не открывает второй вид
  const linkedId = idParam(params, 'bet');
  const linkedBet = useBet(linkedId);
  const linkDone = useRef<number | null>(null);
  useEffect(() => {
    if (linkedId === null) {
      linkDone.current = null;
      return;
    }
    if (linkDone.current === linkedId) return;
    if (linkedBet.error) {
      linkDone.current = linkedId;
      toast.show(isApiError(linkedBet.error) && linkedBet.error.status === 404 ? t('bets.notFound', { id: linkedId }) : apiErrorText(linkedBet.error), { icon: 'alert' });
      dropParam('bet');
      return;
    }
    const bet = linkedBet.data;
    if (!bet) return;
    linkDone.current = linkedId;
    dropParam('bet');
    if (bet.status === 'open') setSettleFor({ bet });
    else if (mobile) setSheetFor(bet);
    else setSeek(bet);
  }, [linkedId, linkedBet.data, linkedBet.error, mobile, dropParam, t, toast]);

  useEffect(() => {
    if (!seek) return;
    if (mobile) {
      setSeek(null);
      setSheetFor(seek);
      return;
    }
    if (settledBets.some((bet) => bet.id === seek.id)) {
      setSeek(null);
      expandInit.current = true;
      setExpanded((prev) => new Set(prev).add(seek.id));
      window.setTimeout(() => document.querySelector(`tr[data-bet="${seek.id}"]`)?.scrollIntoView?.({ block: 'center' }), 80);
      return;
    }
    // ставки нет в выборке по фильтрам — фильтры сбрасываются, как в макете
    if (!showHistory) {
      setFilters(EMPTY_FILTERS, true);
      return;
    }
    if (history.isFetching) return;
    // история не загрузилась (страницы дальше не дочитываются) — детали листом
    if (!history.isError) {
      if (!historyReady || historyLeft) return;
      if (filtered) {
        setFilters(EMPTY_FILTERS, true);
        return;
      }
    }
    // ставки нет и в истории без фильтров — тоже листом
    setSeek(null);
    setSheetFor(seek);
  }, [seek, mobile, settledBets, showHistory, historyReady, historyLeft, history.isFetching, history.isError, filtered, setFilters]);

  // /bets?new=ID: после «Сохранить ставку» на экране анализа — к новой карточке «В игре»
  const savedParam = idParam(params, 'new');
  useEffect(() => {
    if (!params.has('new')) return;
    if (savedParam !== null) setJustSaved(savedParam);
    dropParam('new');
  }, [params, savedParam, dropParam]);
  const savedShown = justSaved !== null && openBets.some((bet) => bet.id === justSaved);
  useEffect(() => {
    if (!savedShown) return;
    const timer = window.setTimeout(() => document.querySelector(`[data-open-bet="${justSaved}"]`)?.scrollIntoView?.({ block: 'center' }), 80);
    return () => window.clearTimeout(timer);
  }, [savedShown, justSaved]);

  function onSettled(bet: BetItem, correctedFrom: BetItem['status'] | null) {
    const corrected = correctedFrom !== null;
    setChangedAt(Date.now());
    setSettleFor(null);
    setJustSaved(null);
    setSettled({ bet, correctedFrom });
    setExpanded((prev) => new Set(prev).add(bet.id));
    const result =
      bet.status === 'void' ? t('bets.toast.void') : t('bets.toast.profit', { profit: formatSigned(bet) });
    toast.show(corrected ? t('bets.toast.corrected', { id: bet.id, result }) : t('bets.toast.settled', { id: bet.id, result }), {
      icon: bet.status === 'lost' ? 'x' : 'check',
    });
  }

  function onReversed(before: BetItem, after: BetItem) {
    setChangedAt(Date.now());
    setCorrectFor(null);
    setSettled(null);
    setSettleFor({ bet: after, prefill: prefillOf(before), correctedFrom: before.status });
  }

  // Ошибку загрузки показывает плашка сверху; блоки без данных не притворяются пустыми
  const listError = summary.error ?? openList.error ?? history.error;
  const caption = describe(filters, t);
  const historyFailed = history.isError && !settledBets.length && !historyLeft;

  return (
    <div className="bets-root stack">
      <div className="page-head bets-head">
        <div className="bets-min">
          <h2>{t('bets.head.title')}</h2>
          <p className="lead">{t('bets.head.lead')}</p>
        </div>
        <Button href={exportHref(filters)} download="bets.csv" icon="download" size={mobile ? 'sm' : 'md'} title={t('bets.head.exportTitle')}>
          {t('bets.head.export')}
        </Button>
      </div>

      {settled && (
        <SettleBanner
          settled={settled}
          equity={equity}
          onCorrect={(bet) => setCorrectFor(bet)}
          onHide={() => setSettled(null)}
        />
      )}

      {mobile ? (
        <MobileFilters filters={filters} onChange={(next) => setFilters(next, next.q !== filters.q)} onReset={resetFilters} />
      ) : (
        <DesktopFilters filters={filters} onChange={(next) => setFilters(next, next.q !== filters.q)} />
      )}

      {listError !== null && (
        <Callout kind="bad" role="alert">
          {apiErrorText(listError)}{' '}
          <Button
            size="sm"
            kind="ghost"
            icon="refresh"
            onClick={() => {
              void summary.refetch();
              if (showOpen) void openList.refetch();
              if (showHistory) void history.refetch();
            }}
          >
            {t('common.retry')}
          </Button>
        </Callout>
      )}

      <SummaryCard
        summary={summary.data}
        failed={summary.isError}
        caption={caption}
        filtered={filtered}
        equity={equity}
        showReset={filtered && !mobile}
        onReset={resetFilters}
        pending={summary.isPlaceholderData}
      />

      {showOpen && openList.data && (
        <OpenSection
          bets={openBets}
          filtered={filtered && filters.status !== 'open'}
          hasMore={openList.hasNextPage}
          loadingMore={openList.isFetchingNextPage}
          onMore={() => void openList.fetchNextPage()}
          onSettle={(bet) => setSettleFor({ bet })}
          fresh={justSaved}
        />
      )}

      {showHistory && (
        <History
          bets={settledBets}
          total={settledTotal}
          loading={history.isLoading || (!settledBets.length && !history.isError && (historyLeft || history.isFetchingNextPage))}
          failed={historyFailed}
          moreFailed={history.isFetchNextPageError}
          hasMore={historyLeft}
          loadingMore={history.isFetchingNextPage}
          onMore={moreHistory}
          filters={filters}
          today={today}
          mobile={mobile}
          expanded={expanded}
          onToggle={toggle}
          onOpen={(bet) => setSheetFor(bet)}
          onClosing={(bet) => setClosingFor(bet)}
          onCorrect={(bet) => setCorrectFor(bet)}
          fresh={settled?.bet.id ?? null}
          caption={caption}
          filtered={filtered}
          onReset={resetFilters}
        />
      )}

      {sheetFor && (
        <BetSheet
          bet={sheetFor}
          onClose={() => setSheetFor(null)}
          onSettle={(bet) => {
            setSheetFor(null);
            setSettleFor({ bet });
          }}
          onCorrect={(bet) => {
            setSheetFor(null);
            setCorrectFor(bet);
          }}
          onClosing={(bet) => {
            setSheetFor(null);
            setClosingFor(bet);
          }}
        />
      )}
      {settleFor && (
        <SettleModal
          bet={settleFor.bet}
          prefill={settleFor.prefill}
          correctedFrom={settleFor.correctedFrom ?? null}
          equity={equity}
          onClose={() => setSettleFor(null)}
          onSettled={(bet) => onSettled(bet, settleFor.correctedFrom ?? null)}
        />
      )}
      {correctFor && <CorrectModal bet={correctFor} equity={equity} onClose={() => setCorrectFor(null)} onReversed={onReversed} />}
      {closingFor && <ClosingModal bet={closingFor} onClose={() => setClosingFor(null)} />}
    </div>
  );
}

function formatSigned(bet: BetItem): string {
  return money(bet, bet.profit, true);
}
