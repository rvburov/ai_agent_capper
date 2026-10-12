import type { TFunction } from 'i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useParams } from 'react-router';

import { useMe } from '../../api/hooks/useMe';
import { isApiError } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, EmptyState, Skeleton, SurfaceChip, useToast } from '../../components';
import { useAiAccess, useAnalysis, useBank, useBookmakers, useCancelAnalysis, useDecision, useRunAnalysis, useStrategy } from '../../features/analysis/api';
import { apiErrorText } from '../../features/analysis/codes';
import { displayName, oddInputText, shortName } from '../../features/analysis/draft';
import { analysisKeys } from '../../features/analysis/keys';
import { marketDescription, marketLabel } from '../../features/analysis/markets';
import { analysisNumber } from '../../features/analysis/number';
import { moneyRules } from '../../features/analysis/stake';
import type { Analysis, Express, Step } from '../../features/analysis/types';
import { isActive, isParseFailed } from '../../features/analysis/types';
import { useAnalysisEvents } from '../../features/analysis/useAnalysisEvents';
import type { Bet } from '../../features/bets/api';
import { usePublicSettings } from '../../features/profile/usePublicSettings';
import { formatDateLong, formatMoney, formatOdds, type Currency } from '../../lib/format';
import { cx } from '../../lib/cx';
import { SaveBetModal, StakeModal, type BetContext, type LegView } from './BetModals';
import { ExpressCard, NoExpressCard, type ExpressState } from './ExpressCard';
import { MatchCard, type MatchNames } from './MatchCard';
import { DoneCard, ResultSkeleton, RunningCard, StopBanner, StoppedCard } from './Progress';
import { stopInfo } from './stopInfo';
import { matchNames, type StepContext } from './stepsView';
import { MetaLine, WhyCard } from './WhyCard';
import './analysis.css';

/*
 * «Анализ» (mockup/js/screens/analysis.js): ход по шагам из снимка и событий SSE, сбой с
 * перезапуском, отмена, итог — карточки матчей, экспресс с суммой, «Почему так», ставка.
 * Состояния «Только в макете» (демо-панель) сюда не переносятся: это настоящие исходы анализа.
 */

// Остановка, перезапуск после которой ждет лимита, бюджета или потолка
const LIMIT_STOPS = new Set(['ai.monthly_limit', 'ai.paused', 'ai.daily_limit', 'ai.budget_exhausted', 'ai.analysis_cap']);

/** Секунды для живого времени шага, который идет. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function legsOf(express: Express, analysis: Analysis, names: MatchNames, t: TFunction) {
  const byMatch = new Map((analysis.result?.matches ?? []).map((m) => [m.match_id, m]));
  const legs: LegView[] = [];
  const meta: { match: string; desc: string }[] = [];
  for (const leg of express.legs) {
    const match = byMatch.get(leg.match_id);
    const player = match ? (leg.selection === 1 ? match.player1 : match.player2) : null;
    const short = player ? shortName(names.name(player.id, player.name)) : '';
    const title = match
      ? t('analysis.matchTitle', {
          p1: shortName(names.name(match.player1.id, match.player1.name)),
          p2: shortName(names.name(match.player2.id, match.player2.name)),
        })
      : '';
    legs.push({ predictionId: leg.prediction_id, name: `${short} ${marketLabel(leg.market, leg.selection)}`.trim(), match: title, odds: Number(leg.odds) });
    meta.push({ match: title, desc: marketDescription(leg.market, short, match?.best_of ?? 3) });
  }
  return { legs, meta };
}

export function AnalysisPage() {
  const { t } = useTranslation();
  const toast = useToast();
  const client = useQueryClient();
  const params = useParams();
  const id = Number(params.id);
  const valid = Number.isInteger(id) && id > 0;
  const [poll, setPoll] = useState(false);
  const query = useAnalysis(valid ? id : null, { poll });
  const analysis = query.data;
  const active = isActive(analysis?.status);
  const stream = useAnalysisEvents(valid ? id : 0, active);
  useEffect(() => setPoll(stream.poll), [stream.poll]);

  const { data: me } = useMe();
  const settings = usePublicSettings();
  const strategy = useStrategy();
  const bank = useBank();
  // Остановлен лимитом или потолком: ждем, когда администратор его поднимет (кнопка оживет сама)
  const access = useAiAccess({ poll: analysis?.status === 'failed' && LIMIT_STOPS.has(analysis.error?.code ?? '') });
  const bookmakers = useBookmakers();
  const run = useRunAnalysis();
  const cancel = useCancelAnalysis();
  const decision = useDecision();
  const now = useNow(active);
  // Двойное нажатие «Перезапустить» и «Отменить анализ» — один запрос (isPending виден
  // только после перерисовки)
  const busy = useRef(false);

  // Связь вернулась после обрыва — сказать об этом (поток уже обновил ход)
  const wasOffline = useRef(false);
  useEffect(() => {
    if (stream.stream === 'offline') wasOffline.current = true;
    else if (stream.stream === 'open' && wasOffline.current) {
      wasOffline.current = false;
      toast.show(t('analysis.run.restored'), { icon: 'refresh' });
    }
  }, [stream.stream, toast, t]);

  // Живое время шага: с момента, когда мы увидели его выполняющимся
  const runningSince = useRef(new Map<number, number>());
  const names = useMemo(() => (analysis ? matchNames(analysis, t) : new Map<number, string>()), [analysis, t]);
  const playerNames: MatchNames = useMemo(() => {
    const map = new Map<number, string>();
    for (const event of analysis?.events ?? []) {
      map.set(event.player1.id, displayName(event.player1));
      map.set(event.player2.id, displayName(event.player2));
    }
    return { name: (pid, fallback) => map.get(pid) ?? fallback };
  }, [analysis]);

  const [express, setExpress] = useState<ExpressState | null>(null);
  const [calcOpen, setCalcOpen] = useState(false);
  const [stakeOpen, setStakeOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);

  const expressData = analysis?.result?.express ?? null;
  useEffect(() => {
    if (expressData && express === null) {
      setExpress({ stake: null, taken: expressData.legs.map((leg) => oddInputText(Number(leg.odds))) });
    }
  }, [expressData, express]);

  if (!valid) return <Navigate to={paths.newAnalysis} replace />;
  if (query.isPending) {
    return (
      <Card>
        <Skeleton lines={6} />
      </Card>
    );
  }
  if (query.isError || !analysis) {
    const notFound = isApiError(query.error) && query.error.status === 404;
    return (
      <Card>
        <EmptyState
          icon="spark"
          title={notFound ? t('analysis.notFound.title') : t('analysis.loadFailed')}
          text={notFound ? t('analysis.notFound.text') : apiErrorText(query.error)}
          action={
            notFound ? (
              <Button kind="primary" icon="plus" to={paths.newAnalysis}>
                {t('analysis.notFound.action')}
              </Button>
            ) : (
              <Button icon="refresh" onClick={() => void query.refetch()}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      </Card>
    );
  }
  // Черновик еще не запускали (или не удался разбор текста): его место — «Новый анализ»
  if (analysis.status === 'needs_confirmation' || analysis.status === 'parsing' || analysis.status === 'created' || isParseFailed(analysis)) {
    return <Navigate to={`${paths.newAnalysis}?draft=${analysis.id}`} replace />;
  }

  const steps: Step[] = analysis.steps;
  for (const step of steps) {
    if (step.state === 'running' && !runningSince.current.has(step.index)) runningSince.current.set(step.index, Date.now());
  }
  const isAdmin = me?.role === 'admin';
  const info = analysis.status === 'failed' ? stopInfo(analysis, { isAdmin, access: access.data, t }) : null;
  const ctx: StepContext = {
    names,
    inputKind: analysis.input_kind,
    failText: info?.reason ?? t('analysis.stop.unknown'),
    runningMs: (step) => {
      const since = runningSince.current.get(step.index);
      return step.elapsed_ms + (since ? Math.max(0, now - since) : 0);
    },
  };
  const result = analysis.result;
  const matchesCount = analysis.events.length || result?.matches.length || steps.filter((s) => s.kind === 'claude').length;
  const currency = ((expressData?.stake.currency ?? settings.data?.currency ?? 'RUB') as Currency);
  const strategyCode = analysis.strategy_version ?? strategy.data?.code ?? 'v3';
  const tournament = analysis.events[0]?.tournament_name ?? result?.matches[0]?.tournament ?? null;
  const surface = analysis.events[0]?.surface ?? result?.matches[0]?.surface ?? null;
  const done = analysis.status === 'done';
  const stopped = analysis.status === 'failed' || analysis.status === 'cancelled';

  let title: string;
  let lead: string;
  if (done && expressData) {
    title = t('analysis.head.express', { count: expressData.legs.length, total: formatOdds(expressData.total_odds) });
    lead = t('analysis.head.leadDone', { code: strategyCode });
  } else if (done) {
    title = t('analysis.head.doneNoExpress', { count: matchesCount });
    lead = t('analysis.head.leadDone', { code: strategyCode });
  } else if (analysis.status === 'cancelled') {
    title = t('analysis.head.cancelled', { count: matchesCount });
    lead = t('analysis.head.leadCancelled');
  } else if (analysis.status === 'failed') {
    title = t('analysis.head.stopped', { count: matchesCount });
    lead = t('analysis.head.leadStopped');
  } else {
    title = t('analysis.head.running', { count: matchesCount });
    lead = t('analysis.head.leadRunning');
  }

  async function restart() {
    if (!analysis || busy.current) return;
    busy.current = true;
    const from = (steps.find((s) => s.state === 'failed' || s.state === 'pending' || s.state === 'running')?.index ?? 0) + 1;
    try {
      await run.mutateAsync({ id: analysis.id });
      runningSince.current.clear();
      toast.show(t('analysis.toast.restarted', { id: analysisNumber(analysis.id), n: from }), { icon: 'refresh' });
      window.scrollTo(0, 0);
    } catch (error) {
      toast.show(apiErrorText(error), { icon: 'alert', duration: 6000 });
      void client.invalidateQueries({ queryKey: analysisKeys.one(analysis.id) });
    } finally {
      busy.current = false;
    }
  }

  async function doCancel(): Promise<boolean> {
    if (!analysis || busy.current) return false;
    busy.current = true;
    try {
      await cancel.mutateAsync(analysis.id);
      toast.show(t('analysis.toast.cancelled', { id: analysisNumber(analysis.id) }), { icon: 'x' });
      return true;
    } catch (error) {
      toast.show(apiErrorText(error), { icon: 'alert', duration: 6000 });
      void client.invalidateQueries({ queryKey: analysisKeys.one(analysis.id) });
      return false;
    } finally {
      busy.current = false;
    }
  }

  async function decide(value: 'skip' | null) {
    if (!analysis) return;
    try {
      await decision.mutateAsync({ id: analysis.id, decision: value });
      if (value === 'skip') toast.show(t('analysis.toast.skipped', { id: analysisNumber(analysis.id) }), { icon: 'check' });
    } catch (error) {
      toast.show(apiErrorText(error), { icon: 'alert', duration: 6000 });
    }
  }

  function onSaved(bet: Bet, taken: string[]) {
    if (!analysis) return;
    setSaveOpen(false);
    setExpress((s) => (s ? { ...s, taken } : s));
    // Сохраненная ставка — сразу в анализе: экран показывает ее сумму и кэфы, как после перезагрузки
    const brief = {
      id: bet.id,
      stake: bet.stake,
      currency: bet.currency,
      total_odds: bet.total_odds,
      bookmaker: bet.bookmaker,
      legs: bet.legs.map((leg) => ({ prediction_id: leg.prediction_id, odds_taken: leg.odds_taken })),
    };
    client.setQueryData<Analysis>(analysisKeys.one(analysis.id), (old) => (old ? { ...old, bet_id: bet.id, bet: brief, decision: 'bet' } : old));
    toast.show(
      t('analysis.toast.saved', { id: bet.id, amount: formatMoney(bet.stake, currency), total: formatOdds(bet.total_odds) }),
      { icon: 'check' },
    );
  }

  let expressBlock = null;
  let betCtx: BetContext | null = null;
  if (done && result) {
    if (expressData && express) {
      const { legs, meta } = legsOf(expressData, analysis, playerNames, t);
      const rules = moneyRules(currency, strategy.data?.params);
      const recommended = expressData.stake.amount === null ? null : Number(expressData.stake.amount);
      const totalMax = Number(
        legs.length === 3 ? (strategy.data?.params.triple_total[1] ?? '4.10') : (strategy.data?.params.double_total[1] ?? '3.24'),
      );
      betCtx = {
        analysisId: analysis.id,
        legs,
        bank: Number(expressData.stake.bank),
        currency,
        rules,
        recommendedShare: recommended !== null ? Number(expressData.stake.pct) : null,
        recommended,
        pExpress: expressData.p_express,
        totalMax,
        growthOn: Boolean(bank.data?.adaptations.some((a) => a.key === 'up15' && a.enabled && a.active)),
        strategyCode,
      };
      expressBlock = (
        <ExpressCard
          analysis={analysis}
          express={expressData}
          legs={legs}
          legMeta={meta}
          currency={currency}
          rules={rules}
          state={express}
          bank={bank.data}
          strategyCode={strategyCode}
          calcOpen={calcOpen}
          onCalcToggle={setCalcOpen}
          onSave={() => (express.stake ?? recommended) === null ? setStakeOpen(true) : setSaveOpen(true)}
          onEditStake={() => setStakeOpen(true)}
          onResetStake={() => {
            setExpress({ ...express, stake: null });
            if (recommended !== null) toast.show(t('analysis.toast.stakeReset', { amount: formatMoney(recommended, currency) }), { icon: 'refresh' });
          }}
          onSkip={() => void decide('skip')}
          onUnskip={() => void decide(null)}
          deciding={decision.isPending}
        />
      );
    } else if (!expressData) {
      expressBlock = <NoExpressCard reasonKey={result.no_express_key} />;
    }
  }

  const bookmaker = analysis.bookmaker ?? analysis.events[0]?.bookmaker ?? null;
  const oddsHint = bookmaker ? t('analysis.match.oddsOf', { bookmaker }) : t('analysis.match.oddsYours');

  return (
    <div className={cx('analysis-root', active && 'analysis-running')}>
      <div className="page-head analysis-head">
        <div className="analysis-head-text">
          <div className="analysis-eyebrow">
            <span className="eyebrow">{[formatDateLong(analysis.started_at ?? analysis.created_at), tournament].filter(Boolean).join(' · ')}</span>
            {surface && <SurfaceChip surface={surface} />}
            <span title={t('analysis.head.modeTitle')}>
              <Chip kind="outline" icon="spark">
                {t('analysis.head.mode')}
              </Chip>
            </span>
          </div>
          <h2 id="analysis-title" tabIndex={-1}>
            {title}
          </h2>
          <p className="lead">{lead}</p>
        </div>
        <Button size="sm" icon="edit" to={`${paths.newAnalysis}?draft=${analysis.id}`}>
          {t('analysis.edit')}
        </Button>
      </div>

      {active && (
        <>
          <RunningCard
            analysis={analysis}
            steps={steps}
            ctx={ctx}
            offline={stream.stream === 'offline'}
            cancelling={cancel.isPending}
            onCancel={doCancel}
            matchesCount={matchesCount}
          />
          <ResultSkeleton />
        </>
      )}

      {stopped && (
        <>
          <StopBanner analysis={analysis} steps={steps} ctx={ctx} info={info} restarting={run.isPending} onRestart={() => void restart()} />
          <StoppedCard analysis={analysis} steps={steps} ctx={ctx} />
        </>
      )}

      {done && (
        <>
          <DoneCard analysis={analysis} steps={steps} ctx={ctx} currency={currency} />
          {result ? (
            <>
              <div className="analysis-result">
                <div className="analysis-col analysis-main">
                  {result.matches.map((match) => (
                    <MatchCard key={match.match_id} match={match} names={playerNames} bookmaker={bookmaker} oddsHint={oddsHint} />
                  ))}
                  <WhyCard result={result} names={playerNames} strategyCode={strategyCode} />
                </div>
                <div className={cx('analysis-col', 'analysis-side', calcOpen && 'is-calc-open')}>{expressBlock}</div>
              </div>
              <MetaLine analysis={analysis} />
            </>
          ) : query.isFetching ? (
            // Событие done пришло раньше полного анализа: итог вот-вот будет
            <ResultSkeleton />
          ) : (
            <Callout>{t('analysis.done.noResult')}</Callout>
          )}
        </>
      )}

      {betCtx && express && stakeOpen && (
        <StakeModal
          open
          ctx={betCtx}
          stake={express.stake ?? betCtx.recommended}
          taken={express.taken}
          onClose={() => setStakeOpen(false)}
          onApply={(stake, taken) => {
            setStakeOpen(false);
            setExpress({ stake: stake === betCtx?.recommended ? null : stake, taken });
            toast.show(t('analysis.toast.stakeChanged', { amount: formatMoney(stake, currency) }), { icon: 'edit' });
          }}
        />
      )}
      {betCtx && express && saveOpen && (express.stake ?? betCtx.recommended) !== null && (
        <SaveBetModal
          open
          ctx={betCtx}
          stake={(express.stake ?? betCtx.recommended) as number}
          taken={express.taken}
          bookmaker={bookmaker}
          bookmakers={bookmakers.data ?? []}
          onClose={() => setSaveOpen(false)}
          onSaved={onSaved}
          onConflict={(message) => {
            setSaveOpen(false);
            toast.show(message, { icon: 'alert', duration: 6000 });
          }}
        />
      )}
    </div>
  );
}
